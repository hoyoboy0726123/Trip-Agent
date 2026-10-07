import type { Env, GenerateResult, Provider, ProviderId, ToolDecl, Turn } from "./types";

// ---------------- Gemini（Google AI Studio） ----------------

/** 送出前取得額度許可、被拒絕時回報：擁有者金鑰由 Registry 統一控管，朋友的金鑰由各旅程自己控管 */
export interface GeminiGate {
  acquire(estimate: number): Promise<void>;
  failed(status: number, body: string): void;
}

/** Workers AI 當天的免費額度用完（整個帳號共用） */
export class WorkersAiQuotaError extends Error {
  constructor() {
    super("Workers AI 今天的免費額度已用完");
    this.name = "WorkersAiQuotaError";
  }
}

/** 粗估這次請求的 token 數（中文約 1–2 字一個 token，取保守值；圖片約 1,100） */
function estimateTokens(system: string, turns: Turn[], tools?: ToolDecl[]): number {
  let chars = system.length + (tools?.length ? JSON.stringify(tools).length : 0);
  let images = 0;
  for (const t of turns) {
    for (const p of t.parts) {
      if ("text" in p) chars += p.text.length;
      else if ("image" in p) images++;
      // 音檔一秒約 32 個 token；不知道長度就用大小粗估（32kbps 約每秒 4KB）
      else if ("media" in p) chars += Math.round((p.media.seconds ?? (p.media.data ? (p.media.data.length * 0.75) / 4000 : 600)) * 32 * 1.8);
      else chars += JSON.stringify("call" in p ? p.call.args : p.result.response).length + 40;
    }
  }
  return Math.ceil(chars / 1.8) + images * 1100 + 800;
}

export function geminiProvider(env: Env, id: ProviderId, apiKey: string, gate?: GeminiGate, model?: string): Provider {
  const m = model || env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  return {
    id,
    model: m,
    async generate({ system, turns, tools, onDelta, json, timeoutMs, firstChunkMs }) {
      if (!apiKey) throw new Error("沒有可用的 Gemini 金鑰");
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({
          role: t.role,
          parts: t.parts.map((p) => {
            if ("text" in p) return { text: p.text };
            if ("image" in p) return { inlineData: { mimeType: p.image.mime, data: p.image.data } };
            if ("media" in p) return p.media.uri ? { fileData: { mimeType: p.media.mime, fileUri: p.media.uri } } : { inlineData: { mimeType: p.media.mime, data: p.media.data } };
            if ("call" in p) {
              const part: Record<string, unknown> = { functionCall: { id: p.call.id, name: p.call.name, args: p.call.args } };
              if (p.call.sig) part.thoughtSignature = p.call.sig;
              return part;
            }
            return { functionResponse: { id: p.result.id, name: p.result.name, response: { result: p.result.response } } };
          }),
        })),
        generationConfig: json ? { responseMimeType: "application/json", temperature: 0.2 } : { temperature: 0.6 },
      };
      if (tools?.length) body.tools = [{ functionDeclarations: tools }];

      // 不自動重試：重試只會更快把 RPM/TPM 用光。失敗就冷卻，由上層改用備援模型
      if (gate) await gate.acquire(estimateTokens(system, turns, tools));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`;
      // 塞車時 Gemini 常常很久才開始回（平常 1–3 秒）：firstChunkMs 內沒開始回就放棄、冷卻一分鐘，改用備援
      const slow = new AbortController();
      const slowTimer = firstChunkMs ? setTimeout(() => slow.abort(), firstChunkMs) : null;
      const slowError = (e: unknown) => {
        if (!slow.signal.aborted) return e;
        gate?.failed(503, "slow first chunk");
        return new Error(`Gemini ${(firstChunkMs ?? 0) / 1000} 秒沒有開始回應（塞車）`);
      };
      const res = await fetch(url, {
        method: "POST",
        // 串流卡住時整段放棄，改用下一個模型，避免聊天室一直顯示「思考中」
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs ?? 45_000), slow.signal]),
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey.trim() },
        body: JSON.stringify(body),
      }).catch((e) => {
        throw slowError(e);
      });
      if (!res.ok || !res.body) {
        clearTimeout(slowTimer);
        const errText = await res.text();
        gate?.failed(res.status, errText);
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
      }

      const result: GenerateResult = { text: "", calls: [] };
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read().catch((e) => {
          throw slowError(e);
        });
        clearTimeout(slowTimer);
        if (done) break;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          let chunk: any;
          try {
            chunk = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (chunk.error) {
            gate?.failed(chunk.error.code ?? 0, JSON.stringify(chunk.error));
            throw new Error(`Gemini：${chunk.error.message}`);
          }
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.functionCall) {
              result.calls.push({
                id: part.functionCall.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
                sig: part.thoughtSignature,
              });
            } else if (typeof part.text === "string" && !part.thought) {
              result.text += part.text;
              onDelta?.(part.text);
            }
          }
        }
      }
      return result;
    },
  };
}

// ---------------- Cloudflare Workers AI ----------------

export function workersAIProvider(env: Env, model?: string): Provider {
  const m = model || env.WORKERS_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  return {
    id: "workers-ai",
    model: m,
    async generate({ system, turns, tools, onDelta, json, maxTokens }) {
      const messages: any[] = [{ role: "system", content: system + (json ? "\n只輸出 JSON，不要任何其他文字。" : "") }];
      for (const t of turns) {
        const texts: string[] = [];
        const images: string[] = [];
        const calls: any[] = [];
        for (const p of t.parts) {
          if ("text" in p) texts.push(p.text);
          else if ("image" in p) images.push(`data:${p.image.mime};base64,${p.image.data}`);
          else if ("media" in p) continue; // Gemma 聽不到音檔（錄音改用 Whisper 轉文字）
          else if ("call" in p) calls.push({ id: p.call.id, type: "function", function: { name: p.call.name, arguments: JSON.stringify(p.call.args) } });
          else messages.push({ role: "tool", tool_call_id: p.result.id, name: p.result.name, content: JSON.stringify(p.result.response) });
        }
        if (t.role === "model") {
          if (calls.length || texts.length) messages.push({ role: "assistant", content: texts.join("\n"), ...(calls.length ? { tool_calls: calls } : {}) });
        } else if (images.length) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: texts.join("\n") }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))],
          });
        } else if (texts.length) {
          messages.push({ role: "user", content: texts.join("\n") });
        }
      }

      // Gemma 4 預設會先長篇「思考」：一句話要 20–30 秒、額度多用 16 倍，還會把輸出空間用完。關掉後約 1 秒
      const input: Record<string, unknown> = {
        messages,
        max_tokens: maxTokens ?? 2048,
        temperature: json ? 0.2 : 0.6,
        chat_template_kwargs: { enable_thinking: false },
      };
      if (tools?.length) input.tools = tools.map((t) => ({ type: "function", function: t }));

      // 聊天回答用串流，讓文字一個一個出現；整理記憶（json）不需要
      if (onDelta && !json) {
        try {
          return await streamWorkersAI(env, m, input, onDelta);
        } catch (e) {
          if (isQuotaError(e)) throw new WorkersAiQuotaError();
          console.error("workers-ai stream failed, retry without stream", e);
        }
      }
      let out: any;
      try {
        out = await runAi(env, m, input);
      } catch (e) {
        if (isQuotaError(e)) throw new WorkersAiQuotaError();
        throw e;
      }

      const text: string = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
      const rawCalls: any[] = out?.tool_calls ?? out?.choices?.[0]?.message?.tool_calls ?? [];
      const calls = rawCalls.map((c) => {
        const fn = c.function ?? c;
        let args = fn.arguments ?? {};
        if (typeof args === "string") args = parseArgs(args);
        return { id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: fn.name, args };
      });
      if (text && !calls.length) onDelta?.(text);
      return { text: typeof text === "string" ? cleanModelText(text) : JSON.stringify(text), calls };
    },
  };
}

const CHANNEL_TAG = /<\|?\/?channel\|?>/g;

/**
 * 大的錄音檔（超過一次請求 20MB 的上限）先傳到 Gemini Files API，回傳檔案網址（Google 48 小時後自動刪除）。
 * 用 resumable 上傳：先要一個上傳網址，再一次把整個檔案送上去
 */
export async function uploadGeminiFile(apiKey: string, bytes: Uint8Array, mime: string): Promise<string> {
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(`${base}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey.trim(),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mime,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "memo" } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Gemini ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
    signal: AbortSignal.timeout(180_000),
  });
  const j = (await res.json().catch(() => ({}))) as { file?: { name: string; uri: string; state: string } };
  if (!res.ok || !j.file?.uri) throw new Error(`Gemini ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  // 音檔通常幾秒就處理好；還在處理就等一下
  let file = j.file;
  for (let i = 0; i < 40 && file.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    file = (await (await fetch(`${base}/v1beta/${file.name}`, { headers: { "x-goog-api-key": apiKey.trim() } })).json()) as typeof file;
  }
  if (file.state !== "ACTIVE") throw new Error(`Gemini 檔案處理失敗（${file.state}）`);
  return file.uri;
}

export function isQuotaError(e: unknown): boolean {
  return /4006|daily free allocation|neurons/i.test(String((e as any)?.message ?? e));
}

/**
 * Workers AI 偶爾暫時塞車（4002 could not route、3040 capacity），等一下再試一次通常就好。
 * 塞車時也可能一直不回應，所以每次最多等 timeoutMs，逾時就交給下一個模型（初始化不會卡住）
 */
export async function runAi(env: Env, model: string, input: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  for (let i = 0; ; i++) {
    let timer: any;
    try {
      return await Promise.race([
        env.AI.run(model as any, input as any),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Workers AI ${timeoutMs / 1000} 秒沒有回應`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (i === 0 && /4002|3040|could not route|capacity/i.test(String((e as any)?.message ?? e))) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 工具參數 JSON：串流偶爾重送變成 {…}{…}，取第一個完整的物件 */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {}
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(raw.slice(raw.indexOf("{"), i + 1));
      } catch {
        return {};
      }
    }
  }
  return {};
}

/** Gemma 偶爾把對話樣板的標記（開頭的 thought、<channel|>）混進回答，清掉 */
function cleanModelText(s: string): string {
  // 整段思考過程漏出來（thought … <channel|> 正式回答）：只留正式回答；沒有正式回答就當作沒回，讓上層請它重答
  if (/^[\s:<|>/a-z]{0,16}thought/i.test(s.slice(0, 24)) && /Thinking Process|思考過程|\*\*Analyze/i.test(s.slice(0, 400))) {
    const close = s.lastIndexOf("<channel|>");
    s = close >= 0 ? s.slice(close + "<channel|>".length) : "";
  }
  return s.replace(CHANNEL_TAG, "").replace(/^\s*:?thought\s*\n/, "").replace(/^\s+/, "");
}

/** Workers AI 串流（SSE）：同時支援 OpenAI 格式（choices[].delta）與舊格式（response） */
async function streamWorkersAI(env: Env, model: string, input: Record<string, unknown>, onDelta: (t: string) => void): Promise<GenerateResult> {
  const stream = (await runAi(env, model, { ...input, stream: true }, 30_000)) as ReadableStream<Uint8Array>;
  if (!stream || typeof (stream as any).getReader !== "function") throw new Error("沒有收到串流");
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  let sentAny = false;
  const pending: string[] = [];
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  const legacyCalls: any[] = [];

  // 模型有時先講一段話再決定呼叫工具；先暫存開頭，確定不是工具呼叫再送出
  const flush = (force = false) => {
    if (calls.size || legacyCalls.length) return;
    // 開頭先多收一點，才能清掉 Gemma 偶爾夾帶的「thought <channel|>」標記
    if (!sentAny) {
      if (!force && text.length < 24) return;
      const head = cleanModelText(pending.splice(0).join(""));
      if (head) onDelta(head);
      sentAny = true;
      return;
    }
    while (pending.length) {
      const piece = pending.shift()!.replace(CHANNEL_TAG, "");
      if (piece) onDelta(piece);
    }
  };

  for (;;) {
    // 30 秒沒有新內容就放棄，讓上層改用備援模型
    let timer: any;
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Workers AI 30 秒沒有回應")), 30_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      const piece: string = typeof delta.content === "string" ? delta.content : typeof chunk.response === "string" ? chunk.response : "";
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.size;
        const cur = calls.get(i) ?? { id: undefined, name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        // Gemma 串流有時會把工具名稱重送一次（變成 train_statustrain_status）
        if (tc.function?.name && cur.name !== tc.function.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        calls.set(i, cur);
      }
      if (Array.isArray(chunk.tool_calls)) legacyCalls.push(...chunk.tool_calls);
      if (piece) {
        text += piece;
        pending.push(piece);
        flush();
      }
    }
  }
  flush(true);

  const parsed = [
    ...[...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
    ...legacyCalls.map((c) => ({ id: c.id, name: c.function?.name ?? c.name, arguments: c.function?.arguments ?? c.arguments })),
  ]
    .filter((c) => c.name)
    .map((c) => {
      let args: any = c.arguments ?? {};
      if (typeof args === "string") args = parseArgs(args);
      return { id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`, name: c.name, args };
    });
  return { text: cleanModelText(text), calls: parsed };
}

/** gemini = 擁有者的金鑰；gemini-own = 旅程自己填的金鑰；workers-ai = Cloudflare 內建 */
export function providerFor(env: Env, id: ProviderId, gate?: GeminiGate, ownKey = ""): Provider {
  if (id === "workers-ai") return workersAIProvider(env);
  if (id === "gemini-own") return geminiProvider(env, id, ownKey, gate);
  return geminiProvider(env, id, env.GEMINI_API_KEY ?? "", gate);
}
