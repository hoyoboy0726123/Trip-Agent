import type { TripProfile } from "./profile";
import { runAi } from "./providers";
import type { Env } from "./types";

/** zh = 中文 → 當地語言；local = 當地語言 → 中文 */
export type Lang = "zh" | "local";

export interface TranslationResult {
  translation: string;
  reading?: string; // 當地語言結果的發音提示（日文平假名、韓文羅馬拼音…）
  engine: string;
}

/** 用 JSON 模式請模型回答（由 TripRoom 依額度挑模型） */
export type JsonAsk = (system: string, prompt: string) => Promise<string>;

// m2m100 的語言名稱
const M2M: Record<string, string> = {
  ja: "japanese", ko: "korean", th: "thai", vi: "vietnamese", en: "english", fr: "french", de: "german", es: "spanish",
  it: "italian", pt: "portuguese", ru: "russian", id: "indonesian", ms: "malay", tr: "turkish", nl: "dutch", ar: "arabic",
  cs: "czech", pl: "polish", el: "greek", hi: "hindi", tl: "tagalog", sv: "swedish", da: "danish", fi: "finnish", hu: "hungarian",
};

function prompts(p: TripProfile): Record<Lang, string> {
  const reading = p.readingName
    ? `,"reading":"整句${p.language}的${p.readingName}（給不會念的台灣人照著念）"`
    : "";
  return {
    zh: `你是專業的中翻${p.language}口譯，幫台灣旅客在${p.country}跟司機、店員、路人溝通。
把使用者的中文翻成自然、禮貌、簡短好念的${p.language}。
只輸出 JSON：{"translation":"${p.language}"${reading}}，不要任何解釋。`,
    local: `你是專業的${p.language}翻中口譯，幫台灣旅客聽懂當地人說的話。
把使用者說的話翻成自然的繁體中文（台灣用語）。
只輸出 JSON：{"translation":"繁體中文"}，不要任何解釋。`,
  };
}

/** 中文 ↔ 當地語言：先用 AI（語氣自然），失敗再用 Workers AI 的翻譯專用模型 m2m100 */
export async function translate(env: Env, ask: JsonAsk, p: TripProfile, text: string, from: Lang): Promise<TranslationResult> {
  const input = text.trim().slice(0, 1000);
  if (!input) throw new Error("沒有要翻譯的內容");
  try {
    const raw = await ask(prompts(p)[from], input);
    const json = JSON.parse(raw.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
    if (typeof json.translation === "string" && json.translation.trim()) {
      return {
        translation: json.translation.trim(),
        reading: from === "zh" && typeof json.reading === "string" && json.reading.trim() ? json.reading.trim() : undefined,
        engine: "ai",
      };
    }
  } catch (e) {
    console.error("ai translate failed", e);
  }
  const local = M2M[p.langCode.slice(0, 2).toLowerCase()] ?? "english";
  const out: any = await runAi(env, "@cf/meta/m2m100-1.2b", {
    text: input,
    source_lang: from === "zh" ? "chinese" : local,
    target_lang: from === "zh" ? local : "chinese",
  }, 30_000);
  if (!out?.translated_text) throw new Error("翻譯服務暫時無法使用");
  return { translation: String(out.translated_text).trim(), engine: "m2m100" };
}

/**
 * 使用者選了「中文 →」卻打當地語言（或反過來）時自動修正方向。
 * 日文看假名、韓文看諺文、泰文看泰文字母；拼音文字（英法德…）看有沒有中文字。
 */
export function detectFrom(text: string, chosen: Lang, langCode: string): Lang {
  const lang = langCode.slice(0, 2).toLowerCase();
  const has = (re: RegExp) => re.test(text);
  const han = has(/[一-鿿]/);
  if (lang === "ja") return has(/[぀-ヿ]/) ? "local" : han ? "zh" : chosen;
  if (lang === "ko") return has(/[가-힯]/) ? "local" : han ? "zh" : chosen;
  if (lang === "th") return has(/[฀-๿]/) ? "local" : han ? "zh" : chosen;
  if (lang === "zh") return chosen;
  return han ? "zh" : has(/[a-zA-ZÀ-ɏЀ-ӿ]/) ? "local" : chosen;
}
