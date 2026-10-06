/**
 * 知識庫上傳文件：Cloudflare 轉出來的 Markdown 整理、切段（語意搜尋找細節用）、PPT 備援解析。
 * 都是純函式，不碰 Workers 的 API。
 */

/** 單檔上限、每個空間原檔總量（免費方案整個帳號只有 5GB） */
export const FILE_MAX_BYTES = 20_000_000;
export const FILE_KEEP_BYTES = 300_000_000;

/** 交給 Cloudflare 轉文字的格式（.pptx 官方清單沒列、目前實測可以；不行時用下面的 pptxText） */
export const DOC_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  html: "text/html",
  htm: "text/html",
};

/** 純文字：前端已經轉成 UTF-8（舊的 Big5 檔也是），直接讀 */
export const TEXT_EXT = new Set(["md", "markdown", "txt"]);

export function extOf(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

const CJK = /[⺀-鿿　-〿＀-￯]/;

/**
 * Cloudflare 轉出來的 Markdown 整理：拿掉檔名標題和 PDF 中繼資料、頁碼換成【第 N 頁】、
 * PDF 每行的硬換行接回來（中文直接接，英文補空白）、試算表的日期序號換回日期
 */
export function cleanMarkdown(md: string, ext: string): { text: string; pages: number } {
  let pages = 0;
  let t = md.replace(/\r/g, "").replace(/^# .*\n/, "");
  t = t.replace(/## Metadata\n[\s\S]*?\n## Contents\n/, "");
  t = t.replace(/^### Page (\d+)\s*$/gm, (_, n: string) => {
    pages = Math.max(pages, Number(n));
    return `\n\n【第 ${n} 頁】\n\n`;
  });
  t = t.replace(/^<!-- Slide number: (\d+) -->\s*$/gm, (_, n: string) => {
    pages = Math.max(pages, Number(n));
    return `\n\n【第 ${n} 張投影片】\n\n`;
  });
  if (ext === "pdf") t = t.replace(/([^\n])\n(?!\n|#|[-*+] |\d+[.)] |\||【)(?=([^\n]))/g, (_, a: string, b: string) => a + (CJK.test(a) || CJK.test(b) ? "" : " "));
  if (["xlsx", "xls", "ods"].includes(ext)) t = fixSheetDates(t);
  return { text: t.replace(/\n{3,}/g, "\n\n").trim(), pages };
}

/** 試算表的日期會變成序號（46296）：表頭有「日期／時間／date」的欄位換回 YYYY/MM/DD */
export function fixSheetDates(md: string): string {
  let cols: number[] | null = null;
  return md
    .split("\n")
    .map((line) => {
      if (!line.trim().startsWith("|")) {
        cols = null;
        return line;
      }
      const cells = line.split("|");
      if (cols === null) {
        cols = cells.flatMap((c, i) => (/日期|時間|date|day/i.test(c) ? [i] : []));
        return line;
      }
      let changed = false;
      for (const i of cols) {
        const v = Number(cells[i]);
        if (/^\s*\d{5}(\.\d+)?\s*$/.test(cells[i] ?? "") && v > 20000 && v < 80000) {
          cells[i] = ` ${new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400_000).toISOString().slice(0, 10).replaceAll("-", "/")} `;
          changed = true;
        }
      }
      return changed ? cells.join("|") : line;
    })
    .join("\n");
}

/** 抽出來的字太少（掃描檔，或 Cloudflare 漏掉內文）：要改請 Gemini 看 PDF */
export function looksScanned(text: string, pages: number): boolean {
  const body = text.replace(/【第 \d+ (?:頁|張投影片)】/g, "").replace(/\s/g, "");
  return body.length < Math.max(40, pages * 60);
}

/** 長文切成約 700–900 字的段落，每段開頭帶頁碼：語意搜尋才找得到細節，回答也能說在第幾頁 */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  let page = "", start = "", cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) out.push(start ? `${start} ${t}` : t);
    cur = "";
  };
  const pieces = text.split(/\n\s*\n/).flatMap((p) => (p.length > 1000 ? p.match(/[^。！？!?\n]{1,700}[。！？!?]?\n?/g) ?? [p] : [p]));
  for (const raw of pieces) {
    const p = raw.trim();
    if (!p) continue;
    if (/^【第 \d+ (?:頁|張投影片)】$/.test(p)) {
      // 換頁就切段：段落的頁碼才不會標錯
      flush();
      page = p;
      continue;
    }
    if (!cur) start = page;
    cur += (cur ? "\n" : "") + p;
    if (cur.length >= 700) flush();
  }
  flush();
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (XML_ENTITIES[e] ?? m),
  );
}

/** 讀 zip 裡想要的檔案（只支援 PPT 會用到的「不壓縮」和 deflate） */
async function unzip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 PPT 檔");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const from = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.slice(from, from + size);
    const raw = method === 0 ? data : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    out.set(name, dec.decode(raw));
  }
  return out;
}

/** PPT 備援：每張投影片的文字（一個 <a:p> 一行） */
export async function pptxText(bytes: Uint8Array): Promise<string> {
  const slides = await unzip(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const no = (name: string) => Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  return [...slides]
    .sort((a, b) => no(a[0]) - no(b[0]))
    .map(([, xml], i) => {
      const lines = xml
        .split("</a:p>")
        .map((para) => [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("").trim())
        .filter(Boolean);
      return `【第 ${i + 1} 張投影片】\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
