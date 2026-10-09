import { DurableObject } from "cloudflare:workers";
import { decryptText, encryptText, hashPassword, maskKey, safeEqual, verifyPassword } from "./auth";
import { INIT_STEPS, researchTrip } from "./init";
import {
  BASE_CHECKLIST, EMPTY_GUIDE, diffFromTaiwan, flagEmoji, localDateTime, localToUtc, travelersText, tripDays, tripLine, validTimezone, zoned,
  type Traveler, type TripProfile,
} from "./profile";
import { geminiProvider, isQuotaError, parseArgs, providerFor, uploadGeminiFile, WorkersAiQuotaError, type GeminiGate } from "./providers";
import { acquireWith, GeminiLimiter, limitsFrom, RateLimitedError } from "./ratelimit";
import { cleanRouteMap, routeMapPrompt, zhCaption, disasterAlerts, DRAFT_TOOLS, healthToolDecls, homeOf, reverseArea, type EventInput, runTool, toolDecls, toolLabel, type AttachedImage, type DraftInput, type ExpenseInput, type RoomApi, type ToolContext } from "./tools";
import { fixMapLinks, type MapFixOptions } from "./maplinks";
import { sendPush, type PushPayload, type VapidKeys } from "./push";
import { renderDiaryPage } from "./diary-page";
import { findDate, isHealthTopic, labCode, normDate, redFlagText, type Flag } from "./health";
import { HealthStore } from "./health-store";
import { chunkText, cleanMarkdown, DOC_MIME, extOf, FILE_KEEP_BYTES, FILE_MAX_BYTES, looksScanned, pptxText, TEXT_EXT } from "./docs";
import { detectFrom, translate, type Lang } from "./translate";
import type { Env, Part, Provider, ProviderId, SessionUser, Turn } from "./types";

const HISTORY_WINDOW = 24; // 每次帶給模型的最近訊息數（更早的靠自動回想找回，省額度）
const HISTORY_CHARS = 600; // 每則歷史訊息最多帶多少字
const PIN_LIMIT = 20; // 置頂訊息上限（每次狀態更新都會帶完整內容，不宜太多）

/** AI 看過照片後的說明（存起來，重寫日記不用再看一次） */
interface PhotoNote { kind: string; score: number; note: string }
/** 日記裡的照片：放在第幾段後面、照片說明 */
interface DiaryPhoto { id: string; para: number; caption: string }
const PHOTO_KINDS = ["景點", "風景", "美食", "人物", "購物", "交通", "住宿", "收據", "截圖", "文件", "旅途外", "其他"];
/** 不放進日記的照片（日記會分享給親友；收據截圖沒有閱讀價值；家裡的寵物、舊照片不是這趟旅行） */
const NOT_DIARY_PHOTO = new Set(["收據", "截圖", "文件", "旅途外"]);
/** 照片說明的評分標準版本：標準改了就加 1，舊的說明會重看一次 */
const PHOTO_NOTE_V = 2;

/** 語音備忘：Gemini 一次請求最多 20MB（base64 會大 1/3），超過就先傳 Files API；Whisper 只收比較小的檔 */
const GEMINI_INLINE_MAX = 14_000_000;
const WHISPER_MAX = 9_000_000;
/** 錄音檔轉完文字後留 30 天可以回放；每個空間最多 400MB，超過先刪最舊的音檔（逐字稿一直留著）。免費方案整個帳號只有 5GB */
const MEMO_KEEP_DAYS = 30;
const MEMO_KEEP_BYTES = 400_000_000;
const AUDIO_MIME = /^(audio\/[\w.+-]+|video\/(mp4|webm|quicktime))$/;
const TRANSCRIBE_PROMPT =
  "逐字轉錄這段錄音：繁體中文（台灣用語），標點用全形（，。？！）。每次換人說話都要另起一行，行首寫「說話者A：」「說話者B：」，同一行只能有一個說話者（只有一個人說話就不用標）。" +
  "聽不清楚的地方寫（聽不清楚），不要猜、不要摘要、不要加任何說明。完全沒有人說話就只輸出「（沒有聲音）」。";
/** 證件到期前幾天提醒；護照出國通常要 6 個月以上效期 */
const ID_STEPS = [90, 30, 7, 0];
const PASSPORT_STEPS = [180, 90, 30, 7, 0];
/** 語意相似度（bge-m3 的 cosine）超過這個值才加分：實測相關的約 0.42–0.75，不相關的 0.2–0.39；只靠語意要 0.45 以上才找得到 */
const SEM_MIN = 0.4;
const SEM_W = 10;

function parseJsonArray(text: string): any[] | null {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 日記原文：第一行標題，之後每行一段；照片標記 [P3｜說明] 跟在它描述的那段後面 */
function parseDiary(raw: string): { title: string; paragraphs: string[]; marks: { tag: string; para: number; caption: string }[] } {
  const MARK = /\[\s*(P\d+)\s*(?:[｜|:：]\s*([^\]\n]*))?\]/gi;
  const paragraphs: string[] = [];
  const marks: { tag: string; para: number; caption: string }[] = [];
  let title = "";
  for (const line of raw.replace(/```\w*/g, "").split("\n")) {
    const found = [...line.matchAll(MARK)];
    const rest = line.replace(MARK, "").replace(/^#+\s*|\*\*/g, "").trim();
    const named = rest.match(/^標題[:：]\s*(.+)$/);
    if (named || (!title && !paragraphs.length && rest && !found.length && rest.length <= 24)) {
      title = (named ? named[1] : rest).replace(/[「」『』"“”]/g, "").trim();
      continue;
    }
    if (rest) paragraphs.push(rest);
    for (const f of found) marks.push({ tag: f[1].toUpperCase(), para: Math.max(0, paragraphs.length - 1), caption: (f[2] ?? "").trim().slice(0, 40) });
  }
  return { title, paragraphs, marks };
}
const MAX_STEPS = 8; // 單次回答最多工具回合（含系統提醒／代為執行）
const FOREGROUND_MAX_WAIT = 10_000; // 回答問題時，Gemini 額度滿最多等幾毫秒，超過就改用下一個模型
/** 中文雙字詞：不用向量資料庫，也能粗略比對兩段文字講的是不是同一件事 */
function bigrams(s: string): Set<string> {
  const clean = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

/** 兩句話是不是在講同一件事：雙字詞重疊比例（以短的那句為準） */
function sameFact(a: string, b: string): boolean {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return a.trim() === b.trim();
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return hit / Math.min(x.size, y.size) >= 0.75;
}

/** 系統自己發的訊息（歡迎、提醒、早報、預算、日記、警報）：整理記憶時不算對話 */
function systemMade(m: { meta: string | null }): boolean {
  if (!m.meta) return false;
  try {
    const j = JSON.parse(m.meta);
    return !!j.kind || !!j.health;
  } catch {
    return false;
  }
}

/** 健康管家的對話與提醒：跟一般聊天分開，不給 Gemini 看、不進記憶 */
function healthMessage(m: { meta: string | null }): boolean {
  if (!m.meta) return false;
  try {
    const j = JSON.parse(m.meta);
    return !!j.health || String(j.kind ?? "").startsWith("health");
  } catch {
    return false;
  }
}

/** 語意相似度換成搜尋分數 */
function semanticBoost(sim: number | undefined): number {
  return sim != null && sim > SEM_MIN ? (sim - SEM_MIN) * SEM_W : 0;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** 文字指紋（FNV-1a）：內容沒變就不用重算向量 */
function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** 手機錄音 App、瀏覽器給的檔案類型 → Gemini 認得的寫法 */
function geminiMime(mime: string): string {
  if (/m4a|x-m4a/.test(mime)) return "audio/mp4";
  if (/mpeg|mp3/.test(mime)) return "audio/mp3";
  if (/wav/.test(mime)) return "audio/wav";
  if (mime === "video/quicktime") return "video/mov";
  return mime;
}

/**
 * 逐字稿排版：模型常常把「說話者A：…說話者B：…」擠在同一行，一律在每個說話者前換行；
 * 中文旁邊的半形逗號、問號、驚嘆號換成全形
 */
export function formatTranscript(text: string): string {
  return text
    .replace(/\s*說話者\s*([A-Za-z0-9甲乙丙丁一二三四五六])\s*[:：]\s*/g, (_, k: string) => `\n說話者${k.toUpperCase()}：`)
    .replace(/([\u3400-\u9fff])\s*,\s*/g, "$1，")
    .replace(/,\s*([\u3400-\u9fff])/g, "，$1")
    .replace(/([\u3400-\u9fff])\s*\?/g, "$1？")
    .replace(/([\u3400-\u9fff])\s*!/g, "$1！")
    .replace(/】\s*\n+/g, "】\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 秒數 → 1:02:03／12:34 */
function fmtDuration(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

/** YYYY-MM-DD → 10/5 */
function mdText(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** 證件到期日：2028-03-05、2028/3/5、2028年3月5日；只有年月就算那個月最後一天 */
function normalizeExpiry(text: string): string | null {
  const m = text.trim().match(/^(\d{4})\D{1,2}(\d{1,2})(?:\D{1,2}(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = m[3] ? Number(m[3]) : last;
  if (d < 1 || d > last) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysUntil(today: string, date: string): number {
  return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400_000);
}

/** 分享選單給的標題、文字、網址常常重複（文字裡已經有網址）：去掉重複的再接起來 */
function joinShared(fields: unknown[]): string {
  const out: string[] = [];
  for (const f of fields) {
    const t = typeof f === "string" ? f.trim() : f == null ? "" : String(f).trim();
    if (t && !out.some((o) => o.includes(t))) out.push(t);
  }
  return out.join("\n");
}

/** YYYY-MM-DD 加減天數 */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400_000).toISOString().slice(0, 10);
}

/** 畫面上直接新增的行程（不經過 AI）：檢查格式 */
function cleanEventInput(m: any): EventInput | { error: string } {
  const title = String(m.title ?? "").trim().slice(0, 80);
  const date = String(m.date ?? "").trim();
  const t = (v: unknown) => (/^\d{2}:\d{2}$/.test(String(v ?? "")) ? String(v) : null);
  if (!title) return { error: "行程要有標題" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "日期不正確" };
  const start = t(m.start), end = start ? t(m.end) : null;
  const remind = m.remind === "" || m.remind == null ? null : Number(m.remind);
  return {
    title, date, start, end: end && end > (start ?? "") ? end : null,
    location: String(m.location ?? "").trim().slice(0, 120) || null, note: null,
    remindMin: Number.isFinite(remind) ? Math.max(0, Math.min(Number(remind), 20160)) : null,
  };
}

/** 推播只能是純文字：拿掉 Markdown 符號，截成一兩行 */
function pushText(md: string, max = 120): string {
  const t = md.replace(/\*\*|__|`|#+\s*|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)\//;

const MEMORY_EVERY = 4; // 每 4 則新的成員訊息自動整理一次長期記憶
const RECALL_LIMIT = 8; // 從較舊的聊天中自動找回的相關訊息數
/** 藥袋上的「第 1 次／共 3 次」→ 還剩 2 次 */
function refillLeft(text: string): string {
  const m = text.match(/第\s*(\d+)\s*次.{0,6}?共\s*(\d+)\s*次/) ?? text.match(/(\d+)\s*\/\s*(\d+)\s*次/);
  return m && Number(m[2]) >= Number(m[1]) ? String(Number(m[2]) - Number(m[1])) : "";
}

/** 健康管家拍照：Gemini 只照抄成 JSON（不判讀、不抄個資），存檔前本人確認 */
const LAB_SCAN_PROMPT = `只把這張檢驗／健檢報告上的文字照抄成 JSON，不要解讀、不要判斷好壞：
{"date": "報告或採檢日期（照原文）", "items": [{"name": "項目原文", "value": "結果原文", "unit": "單位", "ref": "報告上的參考值原文", "flag": "報告上的 H/L/* 標記（沒有就空字串）", "prev": "上次結果（報告上有才填）", "unreadable": false}], "vitals": "血壓、身高、體重等原文", "doctor_note": "醫師建議原文", "item_count_on_page": 這頁的檢驗項目總數}
姓名、身分證字號、病歷號、地址不要抄。看不清楚的欄位 unreadable 填 true，不要猜。`;
const MED_SCAN_PROMPT = `只把這個藥袋（或藥單）上的文字照抄成 JSON，不要解讀：
{"date": "調劑或看診日期原文", "drug_name": "藥名原文（商品名＋學名）", "ingredient": "成分（有寫才填）", "strength": "含量", "quantity": "數量", "usage": "用法用量原文", "indication": "適應症或用途原文", "side_effects": "副作用原文", "warnings": "注意事項原文", "appearance": "外觀", "refill": "慢箋資訊原文（第幾次、下次可領藥日期）"}
如果有好幾種藥，只抄最上面第一種。姓名、身分證字號、病歷號、地址不要抄。看不清楚的欄位填空字串，不要猜。`;
const PHOTO_BYTES_LIMIT = 700_000_000; // 每個旅程的照片總量上限（免費方案整個帳號只有 5 GB）
const AI_NAME = "旅伴 AI";

/** 票券保管箱的一張票券（folder＝所在資料夾的完整路徑，最外層是空字串） */
type DocRow = { id: number; title: string; note: string; photo_id: string; author: string; ts: number; folder_id: number | null; folder: string };

type MessageRow = {
  id: string;
  ts: number;
  author: string;
  role: "user" | "assistant" | "system";
  text: string;
  photo_id: string | null;
  lat: number | null;
  lon: number | null;
  meta: string | null;
};

interface Attachment {
  name: string;
  admin: boolean;
  joined: number;
}

export interface SetupInput {
  roomId: string;
  title: string;
  country: string;
  city: string;
  startDate: string;
  endDate: string;
  accommodation: { name: string; address: string; lat: number | null; lon: number | null };
  flights: string;
  travelers: Traveler[];
  roomPassword: string;
  adminPassword: string;
  tavilyKey: string;
  geminiKey: string;
}

/** 建立個人助理（由 /api/personal 呼叫） */
export interface PersonalSetupInput {
  roomId: string;
  name: string;
  password: string;
  timezone: string;
  city: string;
  home: { address: string; lat: number | null; lon: number | null };
  tavilyKey: string;
  geminiKey: string;
}

function newId(): string {
  return Date.now().toString(36) + crypto.randomUUID().slice(0, 6);
}

/**
 * 這些話一定要用工具處理。模型（尤其 Gemma）偶爾會「嘴上說已完成」卻沒呼叫工具，
 * 靠關鍵字抓出來：先提醒一次，再不做就由系統代為執行。順序有意義（打勾要先於加入清單）。
 */
const INTENTS: { tool: string; test: (text: string, hasPhoto: boolean) => boolean; alt?: string[] }[] = [
  { tool: "save_document", test: (t, p) => p && /存成票券|存起來|存進票券|收進票券|保存這張|存下來/.test(t) },
  { tool: "find_documents", test: (t) => /(給我看|找出|叫出|拿出).{0,12}(票|門票|票券|訂位|確認信|QR|登機證)/.test(t) },
  // 問幾站、要查證確認路線：找路線圖（官方優先）照圖回答
  { tool: "check_route_map", test: (t, p) => !p && ROUTE_VERIFY.test(t) && !/延誤|停駛|誤點|運行|計程車|taxi|uber|走路|步行/i.test(t) },
  // 要看 IG／YouTube 短片介紹
  { tool: "find_short_videos", test: (t, p) => !p && /短片|短影音|reels?\b|shorts|(找|看|有沒有|推薦).{0,20}(影片|視頻)|youtube|\big\b.{0,6}(影片|介紹|推薦)/i.test(t) },
  // 「路線圖」「傳圖給我」也算要看圖；自己附了照片時是要 AI 看那張照片，不是上網找圖
  { tool: "find_chat_photos", test: (t, p) => !p && OWN_PHOTO.test(t) && !/長什麼樣|網路|網上|存成|票券/.test(t), alt: ["find_images", "find_documents"] },
  { tool: "find_images", test: (t, p) => !p && /照片|圖片|相片|看圖|附圖|長什麼樣|路線圖|地鐵圖|捷運圖|平面圖|示意圖|菜單圖|(傳|給|找|看).{0,6}圖(?!書)|photo|picture|image/i.test(t) && !/存|票券|地圖/.test(t) && !OWN_PHOTO.test(t), alt: ["find_chat_photos", "check_route_map"] },
  // 問買過什麼、花了多少：查帳目明細（說「幫我記」的是要新增帳目，不算）
  { tool: "find_expenses", test: (t, p) => !p && /買了(什麼|哪些|啥)|買過(什麼|哪些)|花了多少|花多少|總共花|付了(哪些|多少)|消費(紀錄|明細)|帳目(明細|清單)|查.{0,4}帳/.test(t) && !/幫我記|記一筆|記一下|記帳/.test(t) },
  {
    tool: "add_expense",
    test: (t, p) => (p && /收據|發票|記帳/.test(t)) || /(我付了|付了|花了|請客|記帳).{0,20}\d/.test(t) || /\d.{0,12}(元|圓|円|幣|銖|盾|塊|€|\$|₩|฿|£).{0,12}(我付|付的|記帳)/.test(t),
  },
  { tool: "create_reminder", test: (t) => /提醒(我|大家|全家|我們)/.test(t) && /\d/.test(t) },
  { tool: "update_checklist_item", test: (t) => /買到了|買好了|帶了|帶好了|打勾|已經買|辦好了|已經填|已經訂/.test(t) },
  // 只在明確說要加進清單時才算；「想買…幫我推薦」這類只是詢問，不能自動加
  { tool: "add_checklist_items", test: (t) => /(加入|加到|加進|放進|放到|列入|記到|記進|寫進|存進).{0,8}(清單|待辦)|清單.{0,4}(加|新增|放)/.test(t) },
  { tool: "taxi_fare", test: (t) => /(計程車|taxi|叫車|的士).{0,20}(多少|費用|車資|多久|錢|價)/i.test(t) || /車資/.test(t) },
  { tool: "disaster_alerts", test: (t) => /地震|颱風|海嘯|警報|豪雨|火山|洪水/.test(t) },
  { tool: "train_status", test: (t) => /延誤|停駛|誤點|停開|運行狀況|電車.{0,6}(正常|狀況)/.test(t) },
  { tool: "find_nearby", test: (t) => /附近|周邊|周圍|旁邊有什麼/.test(t), alt: ["web_search"] },
  // 貼了連結：先讀內容（FB／IG 影片也看得到）
  { tool: "read_webpage", test: (t) => /https?:\/\/\S+/.test(t) },
  // 個人助理：說要存進知識庫，或整則訊息只有一個連結（就是要存）
  { tool: "save_note", test: (t) => /(存|收|放|加)(到|進|入)?(我的)?知識庫/.test(t) || /^\s*https?:\/\/\S+\s*$/.test(t) },
  // 健康管家（只在健康對話裡有這些工具）：報數字要記、說用藥要存、問狀況要先查，模型常常嘴上說好了卻沒呼叫
  { tool: "health_log", test: (t) => /血壓.{0,10}\d{2,3}\s*[\/／]\s*\d{2,3}|\d{2,3}\s*[\/／]\s*\d{2,3}.{0,6}血壓|血糖.{0,10}\d{2,3}|體重.{0,6}\d{2,3}/.test(t) },
  { tool: "health_meds", test: (t) => /開始(吃|服用|使用)|改吃|(停|不吃)(了|掉)?.{0,8}藥|藥.{0,6}(不吃了|停了)|慢箋|領藥/.test(t) },
  { tool: "health_status", test: (t) => /(最近|這週|這個月|上次|目前).{0,10}(血壓|血糖|體重|健康).{0,10}(怎麼樣|如何|狀況|正常嗎|好嗎|趨勢)|該做.{0,6}(健檢|篩檢|檢查|疫苗)|(檢驗|報告|膽固醇|LDL|HDL|三酸甘油|糖化|A1c|腎功能|肝功能|eGFR|尿酸).{0,12}(怎麼樣|如何|正常嗎|好嗎|多少|看一下|解釋|說明|意思)/i.test(t) },
];

/** 一則訊息附的所有照片：多張時存在 meta.photos（第一張同時放在 photo_id，收據、票券等舊功能照用） */
function photosOf(m: { photo_id: string | null; meta: string | null }): string[] {
  try {
    const list = m.meta ? JSON.parse(m.meta).photos : null;
    if (Array.isArray(list) && list.length) return list.map(String);
  } catch {}
  return m.photo_id ? [m.photo_id] : [];
}

/** 附了好幾張照片的訊息拆成一張一張（日記、找照片用）；同一張照片出現在好幾則訊息只留第一次 */
function photoRows<T extends { photo_id: string | null; meta: string | null }>(msgs: T[]): T[] {
  const seen = new Set<string>();
  return msgs.flatMap((m) => photosOf(m).filter((x) => !seen.has(x) && !!seen.add(x)).map((photo_id) => ({ ...m, photo_id })));
}

/** 一則訊息最多幾張照片（菜單好幾頁一起翻譯；再多 AI 的回答會太長、容易漏） */
const MAX_PHOTOS = 6;

/** 自己拍、傳到聊天室的照片（「第一天的照片」「我們在晴空塔的合照」「小佑傳的照片」）要翻聊天室，不是上網找 */
const OWN_PHOTO = /(我們|我的|我傳|我拍|大家|全家|家人|自己|第\s*[一二三四五六七八九十\d]+\s*天|今天|昨天|前天|那天|這幾天|\d{1,2}\s*[\/／月]\s*\d{1,2}|傳過|傳的|傳了|拍的|拍過|拍了|上傳).{0,12}(照片|相片|合照)|(照片|相片|合照).{0,8}(我們|大家|傳過|拍的|傳的)/;

const PHOTO_SYNONYMS: [RegExp, string][] = [
  [/合照|合影|全家|一家人|大家/, "合照 合影 全家 家人 一起"],
  [/風景|景色|景觀/, "風景 景色 景觀 景點"],
  [/夜景/, "夜景 夜晚 燈光"],
  [/吃|美食|食物|料理|大餐/, "美食 料理 餐點 食物"],
  [/小孩|孩子|兒子|女兒|寶寶/, "小孩 孩子 兒童"],
];

/** 照片說明和關鍵字有多像：整個詞出現 3 分；沒有就看中文兩字一組重疊多少（同義說法也算） */
function photoMatch(keyword: string, text: string): number {
  const grams = (s: string) => {
    const c = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const g = new Set<string>(c.length === 1 ? [c] : []);
    for (let i = 0; i < c.length - 1; i++) g.add(c.slice(i, i + 2));
    return g;
  };
  const words = [keyword, ...PHOTO_SYNONYMS.filter(([re]) => re.test(keyword)).map(([, w]) => w)].join(" ").split(/[\s、,，]+/).filter(Boolean);
  const hay = text.toLowerCase();
  const tg = grams(text);
  let score = 0;
  for (const w of words) {
    if (hay.includes(w.toLowerCase())) score += 3;
    else {
      const g = [...grams(w)];
      const hit = g.filter((x) => tg.has(x)).length / Math.max(g.length, 1);
      if (hit >= 0.6) score += hit;
    }
  }
  return score;
}


/** 這個問題一定要用到、但模型還沒呼叫的工具（沒有就回 null） */
function requiredTool(text: string, used: string[], hasPhoto: boolean, available: Set<string>): string | null {
  for (const i of INTENTS) {
    if (!available.has(i.tool)) continue;
    if (i.test(text, hasPhoto) && !used.includes(i.tool) && !(i.alt ?? []).some((a) => used.includes(a))) return i.tool;
  }
  return null;
}

function expenseBrief(r: Record<string, SqlStorageValue>) {
  return { id: r.id as number, date: r.date as string, description: r.description as string, amount: r.amount as number, currency: r.currency as string, payer: r.payer as string };
}

/** 挑記憶用的文字：這則訊息加上它回覆的那則（「那第一天呢？」要靠被回覆的內容才知道在問什麼） */
function memoryText(m: { text: string; meta: string | null }): string {
  let quoted = "";
  try {
    quoted = m.meta ? String(JSON.parse(m.meta).reply?.text ?? "") : "";
  } catch {}
  return `${m.text} ${quoted.slice(0, 300)}`.trim();
}

/** 問幾站、或要查證確認路線：才去找路線圖照圖回答（平常問路照記憶回答，不寫站數） */
const ROUTE_WORD = "(路線|線|站|搭|坐|轉乘|換車|地鐵|電車|捷運|怎麼去)";
const CHECK_WORD = "(查證|確認|核對|確定|對不對|對嗎|正確嗎|沒錯嗎|官方|路線圖)";
const ROUTE_VERIFY = new RegExp(`幾站|站數|${CHECK_WORD}.{0,20}${ROUTE_WORD}|${ROUTE_WORD}.{0,20}${CHECK_WORD}`);

/** 問交通路線（要真的在問怎麼搭、怎麼去；只提到「地鐵站出來」這類不算）：查證按鈕、備援模型加註用 */
const ROUTE_ASK = /(怎麼|如何).{0,8}(去|到|搭|坐|走)|交通(?![卡費])|路線|轉乘|換車|換線|幾站|(搭|坐).{0,6}(線|車)|(地鐵|捷運|電車|JR|新幹線|巴士|公車).{0,6}(怎麼|如何|哪|幾|要搭|要坐|轉)|從.{1,15}(到|去)/;
/** 回答裡有搭車步驟（搭哪條線、往哪個方向、在哪站下車）：不管問法，都要附 Google 導航連結和查證按鈕 */
const ROUTE_STEP = /(搭乘?|坐|轉乘|換乘|轉車).{0,15}(線|號|列車|地鐵|電車|捷運|巴士|公車|新幹線|單軌|輕軌|鐵道)|往.{1,12}方向|(在|於|到).{1,15}(下車|轉乘|換車)|下車|(搭乘?|坐|轉乘|換乘).{0,20}(到|至).{1,12}站/g;
function routeAnswer(text: string): boolean {
  return (text.match(ROUTE_STEP) ?? []).length >= 2;
}
/** 要放查證按鈕的路線回答：有搭車步驟，或已經附了 Google 大眾運輸導航連結 */
function routeReply(text: string): boolean {
  return routeAnswer(text) || /google\.com\/maps\/dir\/[^)\s]*travelmode=transit/.test(text);
}
/**
 * 回答裡有要查證的事實（推薦的店家景點、營業時間、展覽活動、票價、樓層）：這一輪要先上網查過才能講。
 * AI 的記憶常過時（店收了、展覽結束了、雕像拆了），旅遊時照舊資訊跑一趟就白費了
 */
const FACT_HINT = /\[📍[^\]\n]*\]\((?!https:\/\/www\.google\.com\/maps\/dir)|營業|開放時間|展覽|展出|活動期間|期間限定|門票|票價|休館|公休|開幕|閉館|拆除|樓層|\d+\s*樓/;
const GROUNDING_TOOLS = new Set(["web_search", "read_webpage", "find_nearby", "check_route_map"]);
function needsVerification(text: string, toolsUsed: string[]): boolean {
  return FACT_HINT.test(text) && !toolsUsed.some((t) => GROUNDING_TOOLS.has(t));
}
const VERIFY_NUDGE =
  "（系統提醒：你剛才的回答有店家、景點、展覽活動或營業資訊，但這一輪還沒上網查證。請先用 web_search 查證最新狀況（店還在不在、營業時間、展覽或活動是否還在進行），再根據查到的結果回答，並註明資料來源；查不到的就說查不到，不要憑記憶。成員沒看到你剛才那段回答，不用道歉，也不要提到這個提醒。）";

const BACKUP_ROUTE_NOTE = "⚠️ 這次由備援模型回答，路線的方向和轉乘可能不準，出發前請以 Google 地圖為準。";

/** 憑記憶回答的路線：回答下方放查證按鈕，按了才去找路線圖（送出的問題帶著原本的問題，放久了再按也查得對） */
function routeCheckButton(question: string) {
  const q = question.replace(/@(ai|AI|旅伴|助理|小幫手)\s*/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { hint: "路線是 AI 憑記憶回答的，可能有錯", buttons: [{ label: "🗺️ 上網找路線圖查證", text: `幫我上網找官方地鐵路線圖，查證「${q}」的路線對不對` }] };
}

/** 問景點、美食、餐廳：回答下方放「找相關短片」按鈕（關鍵字沒中、AI 自己判斷要查時，find_short_videos 照樣能用） */
const PLACE_ASK = /好吃|美食|餐廳|吃|喝|拉麵|燒肉|串燒|燒鳥|居酒屋|燒烤|火鍋|壽司|丼|定食|早餐|午餐|晚餐|宵夜|咖啡|甜點|小吃|酒吧|景點|好玩|推薦|必去|必逛|逛街|購物|百貨|伴手禮|夜市|市場|商圈|神社|寺|公園|博物館|美術館|樂園|展望台|值得去/;
/** 回答說找了影片、或叫成員自己去搜影片，卻沒呼叫 find_short_videos：提醒它真的去找（不管成員怎麼問） */
const VIDEO_CLAIM = /(找|搜尋|搜|查|看|整理|附上|提供).{0,15}(影片|短片|shorts|reels)|(影片|短片|shorts|reels).{0,10}(如下|在下方|附在|供您|給您|參考)/i;
/** 回答裡推薦了地點（地圖連結）：2 個以上就算在介紹地方，也放「找相關短片」按鈕 */
const PLACE_LINK = /\[📍[^\]\n]+\]\((?:map\b|https:\/\/www\.google\.com\/maps\/search)/g;
function videoButton(question: string) {
  const q = question.replace(/@(ai|AI|旅伴|助理|小幫手)\s*/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { buttons: [{ label: "🎬 找相關短片", text: `幫我找剛才介紹的地點的 IG、YouTube 短片（原本的問題：「${q}」）` }] };
}

/** 成員有要看圖（照片、長怎樣、路線圖…）：沒有的話 AI 自己呼叫 find_images 就跳過 */
const IMAGE_ASK = /照片|圖片|相片|看圖|附圖|長什麼樣|長怎樣|樣子|外觀|看看|路線圖|地鐵圖|捷運圖|平面圖|示意圖|菜單|(傳|給|找|看).{0,6}圖(?!書)|photo|picture|image/i;

/** 成員要中文的影片（台灣人拍的、聽得懂的）：find_short_videos 一定用 language=chinese */
const CHINESE_ASK = /中文|華語|國語|台灣|臺灣|聽得懂/;
function chineseButton(places: string[]) {
  const names = [...new Set(places.filter(Boolean))].slice(0, 2);
  return {
    buttons: [{ label: "🗣️ 改找中文介紹的", text: names.length ? `幫我改找「${names.join("」「")}」的中文介紹影片` : "幫我改找中文介紹的影片（剛才那些地點）" }],
  };
}

/** 地圖連結的座標不是工具查到的（模型自己編的座標會指到錯的地方）：改成用連結文字的店名搜尋 */
function dropFakeCoords(text: string, known: string): string {
  return text.replace(/\[([^\]\n]*)\]\((https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=(-?\d{1,3}\.\d{3,})(?:%2C|,)(-?\d{1,3}\.\d{3,}))\)/gi, (all, label: string, _url: string, lat: string, lon: string) =>
    known.includes(lat) && known.includes(lon) ? all : `[${label}](map)`,
  );
}

/** 模型自己寫的 IG／YouTube／TikTok 網址常是編的：不是工具找到的就拿掉（連結文字留著） */
const SOCIAL_HOST = /^https?:\/\/(?:[\w-]+\.)?(?:instagram\.com|youtube\.com|youtu\.be|tiktok\.com)\//i;
function dropFakeVideoLinks(text: string, known: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (all, label: string, url: string) => (SOCIAL_HOST.test(url) && !known.includes(url) ? label : all))
    .replace(/https?:\/\/(?:[\w-]+\.)?(?:instagram\.com|youtube\.com|youtu\.be|tiktok\.com)\/[^\s)）\]]+/gi, (url, offset: number, all: string) =>
      all[offset - 1] === "(" || known.includes(url) ? url : "",
    );
}

/** 沒附任何圖時，拿掉「依據…路線圖」「已附在下方」這類說法（模型會學前面查證過的回答） */
const MAP_CLAIM = /路線圖.{0,20}(已附|附在下方|附圖)|依據[:：]?.{0,20}路線圖/;
function dropMapClaims(text: string): string {
  return text
    .split("\n")
    .map((l) => (MAP_CLAIM.test(l) ? l.replace(/[（(][^（()）\n]*路線圖[^（()）\n]*[)）]/g, "") : l))
    .filter((l) => !MAP_CLAIM.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 模型偶爾學對話紀錄的格式，回答開頭多一個「［爸爸］」，存檔前拿掉 */
function stripSpeakerTag(text: string): string {
  // 也拿掉結尾假的工具呼叫文字（模型偶爾把 find_images{queries:[...]} 寫進回答）
  return text.replace(/^\s*［[^］\n]{1,16}］\s*/, "").replace(/(\s*\b[a-z]+(?:_[a-z]+)+\s*[{(][^\n]*[})])+\s*$/, "");
}

/** 對話紀錄裡標出「這則是在回覆誰的哪句話」 */
function replyNote(meta: string | null, max: number): string {
  const r = meta ? JSON.parse(meta).reply : null;
  return r ? `（回覆 ${r.author}：「${String(r.text).replace(/\s+/g, " ").slice(0, max)}」）` : "";
}

/** 分享連結用的隨機碼（24 個網址安全字元，猜不到） */
function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 回答裡說下方有確認卡片（用來抓「沒呼叫工具卻說有卡片」） */
function claimsCard(text: string): boolean {
  return /(下方|下面)的?.{0,8}(卡片|內容)|按\s*\**\s*「\s*確認|［卡片|確認卡片/.test(text);
}

/** 回答結尾在問成員問題（而且沒有謊稱已經寫入） */
function isAskingBack(text: string): boolean {
  const t = text.trim();
  return /[？?]/.test(t.slice(-80)) && !/已(經)?(幫你|幫您)?(記好|記下|記帳|記入|寫入|更新|修改|刪除)/.test(t);
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const PROVIDER_LABEL: Record<ProviderId, string> = { gemini: "Gemini", "gemini-own": "Gemini（旅程金鑰）", "workers-ai": "Workers AI" };

export class TripRoom extends DurableObject<Env> implements RoomApi {
  private sql: SqlStorage;
  private queue: Promise<unknown> = Promise.resolve();
  /** 旅程自己填的 Gemini 金鑰：額度只有這個旅程在用，在這裡控管 */
  private ownLimiter: GeminiLimiter;
  private cachedProfile: TripProfile | null | undefined;
  private cachedKeys: { tavily: string; gemini: string } | null = null;
  private workersBlocked = { until: 0, checked: 0 };
  private consolidating = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initTables();
    this.ownLimiter = new GeminiLimiter(limitsFrom(env), {
      load: () => JSON.parse(this.setting("own_gemini_day", '{"day":"","count":0}')),
      save: (v) => this.setSetting("own_gemini_day", JSON.stringify(v)),
    });
    // 排程（初始化、提醒、每日早報、旅遊日記、災害警報）靠 alarm，最多每 5 分鐘醒來一次
    ctx.blockConcurrencyWhile(async () => {
      if (this.profile() && !(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 30_000);
    });
  }

  private initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ts INTEGER, author TEXT, role TEXT, text TEXT, photo_id TEXT, lat REAL, lon REAL, meta TEXT);
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, ts INTEGER, author TEXT, mime TEXT, data BLOB);
      CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, category TEXT, content TEXT, author TEXT);
      CREATE TABLE IF NOT EXISTS itinerary (date TEXT PRIMARY KEY, title TEXT, detail TEXT, status TEXT, updated_at INTEGER, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, date TEXT, description TEXT, amount REAL, currency TEXT, amount_local REAL, amount_twd INTEGER, payer TEXT, split_among TEXT, category TEXT, author TEXT);
      CREATE TABLE IF NOT EXISTS locations (name TEXT PRIMARY KEY, lat REAL, lon REAL, accuracy REAL, ts INTEGER, area TEXT);
      CREATE TABLE IF NOT EXISTS members (name TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER, ts INTEGER);
      CREATE TABLE IF NOT EXISTS phrases (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, zh TEXT, local TEXT, reading TEXT, author TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS translations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, from_lang TEXT, source TEXT, result TEXT, reading TEXT);
      CREATE TABLE IF NOT EXISTS checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, list TEXT, item TEXT, for_whom TEXT, author TEXT, done INTEGER DEFAULT 0, done_by TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, due INTEGER, message TEXT, author TEXT, created INTEGER, sent INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, title TEXT, note TEXT, photo_id TEXT);
      CREATE TABLE IF NOT EXISTS diaries (date TEXT PRIMARY KEY, ts INTEGER, text TEXT, photo_ids TEXT);
    `);
    // AI 要寫入的資料（記帳、改行程、刪除）先做成確認卡片，成員按確認才寫入
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, payload TEXT, preview TEXT, author TEXT, message_id TEXT, status TEXT DEFAULT 'pending', resolved_by TEXT, resolved_at INTEGER);
    `);
    // 日記加上每天的標題
    if (!this.sql.exec("PRAGMA table_info(diaries)").toArray().some((c) => c.name === "title")) this.sql.exec("ALTER TABLE diaries ADD COLUMN title TEXT");
    // 置頂訊息（全家共用，等一下還要再看的資訊不會被洗掉）
    this.sql.exec("CREATE TABLE IF NOT EXISTS pins (message_id TEXT PRIMARY KEY, ts INTEGER, by TEXT)");
    // 票券保管箱的資料夾（可以一層層放）；票券的 folder_id 是 NULL＝放在最外層
    this.sql.exec("CREATE TABLE IF NOT EXISTS doc_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER, ts INTEGER, author TEXT)");
    if (!this.sql.exec("PRAGMA table_info(documents)").toArray().some((c) => c.name === "folder_id")) this.sql.exec("ALTER TABLE documents ADD COLUMN folder_id INTEGER");
    // 個人助理：手機推播訂閱；記憶 v2（狀態、來源、到期日、被哪一條取代）
    this.sql.exec("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, ts INTEGER, ua TEXT)");
    // 個人助理知識庫：貼連結（文章、FB／IG 影片）或筆記，AI 整理成標題＋重點＋標籤
    this.sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, title TEXT, summary TEXT, content TEXT, url TEXT, tags TEXT, thumb TEXT)");
    if (!this.sql.exec("PRAGMA table_info(notes)").toArray().some((c) => c.name === "inbox")) this.sql.exec("ALTER TABLE notes ADD COLUMN inbox INTEGER DEFAULT 0");
    // 上傳的文件：知識庫那筆連到原檔
    if (!this.sql.exec("PRAGMA table_info(notes)").toArray().some((c) => c.name === "file_id")) this.sql.exec("ALTER TABLE notes ADD COLUMN file_id INTEGER");
    // 第三階段：行事曆、做夢的確認卡、每天的回顧、做夢紀錄（可復原）
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, title TEXT, date TEXT, start TEXT, end_time TEXT, location TEXT, note TEXT, remind_min INTEGER, reminded INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, title TEXT, body TEXT, payload TEXT, status TEXT DEFAULT 'pending', resolved_at INTEGER);
      CREATE TABLE IF NOT EXISTS episodes (date TEXT PRIMARY KEY, ts INTEGER, summary TEXT, weekly INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS dream_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, op TEXT, target INTEGER, before TEXT, after TEXT, reason TEXT, undone INTEGER DEFAULT 0);
    `);
    for (const col of ["status TEXT DEFAULT 'active'", "source TEXT", "expires TEXT", "superseded_by INTEGER", "updated INTEGER"]) {
      if (!this.sql.exec("PRAGMA table_info(memories)").toArray().some((c) => c.name === col.split(" ")[0])) this.sql.exec(`ALTER TABLE memories ADD COLUMN ${col}`);
    }
    // 日記挑照片用：AI 看過每張照片的說明
    this.sql.exec("CREATE TABLE IF NOT EXISTS photo_notes (photo_id TEXT PRIMARY KEY, kind TEXT, score INTEGER, note TEXT, ts INTEGER, v INTEGER)");
    if (!this.sql.exec("PRAGMA table_info(photo_notes)").toArray().some((c) => c.name === "v")) this.sql.exec("ALTER TABLE photo_notes ADD COLUMN v INTEGER");
    // 換國家繼續玩：上一趟收成「過去的旅程」，日記標上屬於哪一趟（NULL＝現在這趟）
    this.sql.exec("CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, title TEXT, country TEXT, city TEXT, flag TEXT, start_date TEXT, end_date TEXT, travelers TEXT, summary TEXT)");
    if (!this.sql.exec("PRAGMA table_info(diaries)").toArray().some((c) => c.name === "trip_id")) this.sql.exec("ALTER TABLE diaries ADD COLUMN trip_id INTEGER");
    // 第四階段：語音備忘（錄音分段上傳，轉完文字就刪音檔）、語意搜尋的向量、證件到期
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memos (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, title TEXT, status TEXT, mime TEXT, source TEXT, segs INTEGER DEFAULT 0, done_segs INTEGER DEFAULT 0, ended INTEGER DEFAULT 0, seconds INTEGER DEFAULT 0, engine TEXT, transcript TEXT, summary TEXT, actions TEXT, note_id INTEGER, error TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS memo_segs (memo_id INTEGER, seq INTEGER, bytes INTEGER, seconds REAL, status TEXT DEFAULT 'pending', text TEXT, engine TEXT, tries INTEGER DEFAULT 0, PRIMARY KEY (memo_id, seq));
      CREATE TABLE IF NOT EXISTS memo_audio (memo_id INTEGER, seq INTEGER, part INTEGER, data BLOB, PRIMARY KEY (memo_id, seq, part));
      CREATE TABLE IF NOT EXISTS embeddings (kind TEXT, ref INTEGER, hash TEXT, vec BLOB, PRIMARY KEY (kind, ref));
      CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, name TEXT, mime TEXT, bytes INTEGER, status TEXT, note_id INTEGER, method TEXT, pages INTEGER, chars INTEGER, error TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS file_data (file_id INTEGER, part INTEGER, data BLOB, PRIMARY KEY (file_id, part));
      CREATE TABLE IF NOT EXISTS note_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, seq INTEGER, text TEXT, embedded INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS note_chunks_note ON note_chunks(note_id);
      CREATE TABLE IF NOT EXISTS id_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, holder TEXT, last4 TEXT, expires TEXT, author TEXT, notified INTEGER DEFAULT 100000);
    `);
    // 家人修改日記：記下最後是誰改的；個人日記的週記 span＝7（一篇涵蓋幾天）
    for (const col of ["edited_by TEXT", "edited_at INTEGER", "layout TEXT", "span INTEGER"]) {
      if (!this.sql.exec("PRAGMA table_info(diaries)").toArray().some((c) => c.name === col.split(" ")[0])) this.sql.exec(`ALTER TABLE diaries ADD COLUMN ${col}`);
    }
  }

  // ================= 設定與旅程資料 =================

  private setting(key: string, fallback = ""): string {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = ?", key).toArray()[0];
    return (row?.value as string) ?? fallback;
  }

  private setSetting(key: string, value: string) {
    this.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private profile(): TripProfile | null {
    if (this.cachedProfile === undefined) {
      const raw = this.setting("profile");
      this.cachedProfile = raw ? (JSON.parse(raw) as TripProfile) : null;
    }
    return this.cachedProfile;
  }

  /** 已經建立好的旅程才會呼叫；沒有設定時直接丟錯 */
  private p(): TripProfile {
    const p = this.profile();
    if (!p) throw new Error("旅程不存在");
    return p;
  }

  private saveProfile(p: TripProfile) {
    this.cachedProfile = p;
    this.setSetting("profile", JSON.stringify(p));
  }

  private roomId(): string {
    return this.setting("room_id");
  }

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("main"));
  }

  private async keys(): Promise<{ tavily: string; gemini: string }> {
    if (!this.cachedKeys) {
      this.cachedKeys = {
        tavily: await decryptText(this.env, this.setting("key_tavily")),
        gemini: await decryptText(this.env, this.setting("key_gemini")),
      };
    }
    return this.cachedKeys;
  }

  private settings() {
    return {
      replyMode: this.setting("reply_mode", "all"), // all | mention
      autoBrief: this.setting("auto_brief", "1") === "1",
      autoDiary: this.setting("auto_diary", "1") === "1",
      autoAlerts: this.setting("auto_alerts", "1") === "1",
      share: this.setting("share_token") ? `/share/${this.roomId()}/${this.setting("share_token")}` : null, // 日記分享連結
      tavily: this.setting("key_tavily_mask"),
      gemini: this.setting("key_gemini_mask"),
      ownerGemini: !!this.env.GEMINI_API_KEY,
      workersModel: this.env.WORKERS_AI_MODEL,
      geminiModel: this.env.GEMINI_MODEL,
      briefHour: Number(this.setting("brief_hour", "7")), // 個人助理早報幾點發
      memoryPaused: this.setting("memory_paused") === "1",
      budget: Number(this.setting("budget_month", "0")) || 0,
      pushDevices: this.sql.exec("SELECT COUNT(*) AS n FROM push_subs").one().n as number,
      ics: this.setting("ics_token") ? `/ics/${this.roomId()}/${this.setting("ics_token")}.ics` : null, // 行事曆訂閱連結
      lastDream: this.setting("dream_last") ? JSON.parse(this.setting("dream_last")) : null,
      voiceEngine: this.setting("voice_engine", "gemini"), // gemini＝自己的 Gemini 優先；private＝只用 Cloudflare（不經過 Google）
      diaryMode: this.setting("diary_mode", "weekly"), // 個人日記：weekly｜daily｜off
      inbox: this.setting("inbox_token") ? `/in/${this.roomId()}/${this.setting("inbox_token")}` : null, // iPhone 捷徑的收件網址
    };
  }

  // ================= 建立旅程（由 /api/rooms 呼叫） =================

  async setup(input: SetupInput): Promise<{ ok: boolean; error?: string }> {
    if (this.profile()) return { ok: false, error: "這個旅程已經建立過了" };
    const year = input.startDate.slice(0, 4);
    const p: TripProfile = {
      status: "initializing",
      title: input.title || `${input.city || input.country}旅行 ${year}`,
      country: input.country, countryCode: "", countryIso3: "", city: input.city, center: null,
      startDate: input.startDate, endDate: input.endDate,
      timezone: "UTC", currency: "USD", currencySymbol: "$", language: "英文", langCode: "en-US", readingName: "",
      travelers: input.travelers,
      accommodation: { ...input.accommodation, note: "" },
      flights: input.flights,
      emergency: "", taxi: null, guide: { ...EMPTY_GUIDE }, initNotes: [],
    };
    this.setSetting("room_id", input.roomId);
    this.setSetting("pw_room", await hashPassword(input.roomPassword));
    this.setSetting("pw_admin", await hashPassword(input.adminPassword));
    this.setSetting("auth_version", "1");
    await this.storeKeys(input.tavilyKey, input.geminiKey);
    this.saveProfile(p);
    for (const t of input.travelers) this.touchMember(t.name);
    for (const c of BASE_CHECKLIST) this.sql.exec("INSERT INTO checklist (list, item, for_whom, author, ts) VALUES (?, ?, '', '預設', ?)", c.list, c.item, Date.now());
    this.resetItinerary(p);
    this.setSetting("init_progress", JSON.stringify({ step: 0, label: "準備中" }));
    await this.ctx.storage.setAlarm(Date.now() + 200);
    return { ok: true };
  }

  /** 個人助理：只有本人，建好就能用（沒有 AI 研究目的地的初始化） */
  async setupPersonal(input: PersonalSetupInput): Promise<{ ok: boolean; error?: string; title?: string }> {
    if (this.profile()) return { ok: false, error: "這個空間已經建立過了" };
    const tz = validTimezone(input.timezone) ? input.timezone : "Asia/Taipei";
    const today = zoned(Date.now(), tz).date;
    const home = input.home.lat != null && input.home.lon != null ? { lat: input.home.lat, lon: input.home.lon } : null;
    const p: TripProfile = {
      kind: "personal",
      status: "active",
      title: `${input.name}的助理`,
      country: "台灣", countryCode: "TW", countryIso3: "TWN", city: input.city, center: home,
      startDate: today, endDate: today,
      timezone: tz, currency: "TWD", currencySymbol: "NT$", language: "中文", langCode: "zh-TW", readingName: "",
      travelers: [{ name: input.name, kind: "大人" }],
      accommodation: { name: "家", address: input.home.address, lat: home?.lat ?? null, lon: home?.lon ?? null, note: "" },
      flights: "", emergency: "報案 110、救護車／消防 119", taxi: null, guide: { ...EMPTY_GUIDE }, initNotes: [],
    };
    this.setSetting("room_id", input.roomId);
    // 只有本人能進來：旅伴密碼設成沒人知道的亂數，只能用自己的密碼（管理員）登入
    this.setSetting("pw_room", await hashPassword(crypto.randomUUID()));
    this.setSetting("pw_admin", await hashPassword(input.password));
    this.setSetting("auth_version", "1");
    await this.storeKeys(input.tavilyKey, input.geminiKey);
    this.saveProfile(p);
    this.touchMember(input.name);
    this.postAiMessage(
      `👋 嗨 ${input.name}，我是你的個人助理，這裡的對話只有你看得到。\n\n` +
        `- **記住事情**：說「記住我不吃香菜」，之後問我都找得到\n` +
        `- **提醒**：「明天早上 8 點提醒我繳信用卡費」\n` +
        `- **清單**：「把牛奶加到購物清單」「待辦有哪些？」\n` +
        `- **查資料**：天氣、附近美食、怎麼去、上網搜尋${input.tavilyKey ? "" : "（要先到 設定 → API 金鑰 填 Tavily）"}\n` +
        `- **保管箱**：照片、票券、文件傳給我說「存起來」\n\n` +
        `🔒 這裡的對話只有你看得到。`,
      { kind: "welcome" },
    );
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return { ok: true, title: p.title };
  }

  private isPersonal(): boolean {
    return this.profile()?.kind === "personal";
  }

  private async storeKeys(tavily?: string, gemini?: string) {
    if (typeof tavily === "string") {
      this.setSetting("key_tavily", await encryptText(this.env, tavily.trim()));
      this.setSetting("key_tavily_mask", maskKey(tavily.trim()));
    }
    if (typeof gemini === "string") {
      this.setSetting("key_gemini", await encryptText(this.env, gemini.trim()));
      this.setSetting("key_gemini_mask", maskKey(gemini.trim()));
    }
    this.cachedKeys = null;
  }

  private resetItinerary(p: TripProfile) {
    this.sql.exec("DELETE FROM itinerary");
    const days = tripDays(p.startDate, p.endDate);
    days.forEach((d, i) => {
      const title = i === 0 ? "出發・抵達" : i === days.length - 1 ? "返程" : "";
      this.sql.exec("INSERT INTO itinerary VALUES (?, ?, ?, '', ?, '初始行程')", d, title, "", Date.now());
    });
  }

  /** 旅程日期改了：補上新增的日子、刪掉沒有內容又超出範圍的日子 */
  private syncItineraryDays(p: TripProfile) {
    const days = new Set(tripDays(p.startDate, p.endDate));
    for (const d of days) this.sql.exec("INSERT OR IGNORE INTO itinerary VALUES (?, '', '', '', ?, '初始行程')", d, Date.now());
    for (const r of this.itinerary()) {
      if (!days.has(r.date as string) && !r.title && !r.detail) this.sql.exec("DELETE FROM itinerary WHERE date = ?", r.date);
    }
  }

  // ---------------- 開始下一趟旅程（換國家、換城市都可以） ----------------

  /**
   * 上一趟收成「過去的旅程」：日記（和日記用到的照片）留著，長期記憶由 AI 分類；
   * 聊天、其他照片、票券、記帳、行程、清單、提醒、常用語清掉，再照新的目的地重新查資料（回到確認頁）
   */
  private async nextTrip(x: any): Promise<string | null> {
    if (this.isPersonal()) return "個人助理沒有這個功能";
    const p = this.p();
    if (!String(x.country ?? "").trim()) return "請填寫要去的國家";
    // 先檢查新的資料，有錯就什麼都不動
    const next: TripProfile = structuredClone(p);
    const a = x.accommodation ?? {};
    const err = this.applyProfilePatch(next, {
      country: x.country, city: String(x.city ?? ""), startDate: x.startDate, endDate: x.endDate, flights: String(x.flights ?? ""), travelers: x.travelers,
      accommodation: { name: String(a.name ?? ""), address: String(a.address ?? ""), lat: a.lat ?? null, lon: a.lon ?? null, note: "" },
    });
    if (err) return err;
    const old = {
      title: p.title, country: p.country, city: p.city, flag: flagEmoji(p.countryCode), start: p.startDate, end: p.endDate,
      travelers: p.travelers.map((t) => t.name).join("、"),
    };
    // 1. 長期記憶：上一趟才有效的改成回憶（家人的口味、過敏、習慣照常用）
    await this.archiveTripMemories(old, `${next.country}${next.city ? `（${next.city}）` : ""}`);
    // 2. 上一趟收起來：日記標上屬於哪一趟
    const tripId = Number(
      this.sql
        .exec(
          "INSERT INTO trips (ts, title, country, city, flag, start_date, end_date, travelers, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          Date.now(), old.title, old.country, old.city, old.flag, old.start, old.end, old.travelers, this.setting("summary"),
        )
        .one().id,
    );
    this.sql.exec("UPDATE diaries SET trip_id = ? WHERE trip_id IS NULL", tripId);
    // 3. 照片只留日記用到的（免費帳號整個只有 5GB）
    const keep = new Set<string>();
    for (const d of this.sql.exec("SELECT photo_ids FROM diaries").toArray()) {
      for (const id of JSON.parse(String(d.photo_ids || "[]")) as string[]) keep.add(id);
    }
    for (const r of this.sql.exec("SELECT id FROM photos").toArray()) if (!keep.has(String(r.id))) this.sql.exec("DELETE FROM photos WHERE id = ?", r.id);
    for (const r of this.sql.exec("SELECT photo_id FROM photo_notes").toArray()) if (!keep.has(String(r.photo_id))) this.sql.exec("DELETE FROM photo_notes WHERE photo_id = ?", r.photo_id);
    // 4. 其他都是上一趟的：清掉
    for (const t of ["messages", "pins", "drafts", "expenses", "itinerary", "checklist", "reminders", "phrases", "translations", "documents", "doc_folders", "locations", "cache", "embeddings"]) {
      this.sql.exec(`DELETE FROM ${t}`);
    }
    this.setSetting("summary", "");
    this.setSetting("memory_cursor", String(Date.now()));
    this.setSetting("diary_sent", "");
    this.setSetting("next_from", old.title);
    // 5. 新的目的地：照新的查一次當地資料，查完回到確認頁
    next.title = String(x.title ?? "").trim().slice(0, 40);
    next.guide = { ...EMPTY_GUIDE };
    next.taxi = null;
    next.emergency = "";
    next.initNotes = [];
    next.status = "initializing";
    this.saveProfile(next);
    this.syncItineraryDays(next);
    this.setSetting("init_progress", JSON.stringify({ step: 0, label: "準備中", total: INIT_STEPS.length }));
    await this.ctx.storage.setAlarm(Date.now() + 200);
    this.ctx.waitUntil(this.registry().updateRoom(this.roomId(), { title: next.title || old.title, country: next.country, flag: "🌏", city: next.city, startDate: next.startDate, endDate: next.endDate, status: "initializing" }));
    this.helloAll();
    return null;
  }

  /** 換國家時：只跟上一趟有關的記憶（訂位、待辦、當地行程、去過的店）改成「【旅程名稱】…」的回憶 */
  private async archiveTripMemories(old: { title: string; country: string; city: string; start: string; end: string }, nextWhere: string) {
    const mems = this.memories();
    const label = `【${old.title}】`;
    let past: Set<number> | null = null;
    if (mems.length) {
      const prompt = `這個家庭旅遊群組的旅程「${old.title}」（${old.start}～${old.end}，${old.country}${old.city}）結束了，接下來要去${nextWhere}。
下面是群組的長期記憶。請挑出「只跟上一趟旅程有關、到下一趟就不成立」的記憶 id，例如：訂位、門票、航班、住宿、待辦、當地的行程安排、想去或去過的當地景點和店家、當地交通、當地天氣。
家人的口味、過敏、健康狀況、習慣、個性、年齡、喜歡的活動、旅行偏好（例如不想走太多路、要有午睡時間）要留著，不要挑。
只輸出 JSON：{"past_ids":[數字]}

${mems.map((m) => `#${m.id}［${m.category}］${m.content}`).join("\n")}`;
      try {
        const raw = await this.generateText("你負責整理家庭旅遊群組的長期記憶，只輸出 JSON。", prompt, true, 1);
        const j = parseArgs(raw.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as { past_ids?: unknown[] };
        if (Array.isArray(j.past_ids)) past = new Set(j.past_ids.map(Number).filter(Number.isInteger));
      } catch (e) {
        console.error("archiveTripMemories failed", String((e as Error)?.message ?? e).slice(0, 200));
      }
    }
    // AI 不能用：訂位、待辦、決定一律當成上一趟的事
    if (!past) past = new Set(mems.filter((m) => ["預訂", "待辦", "決定"].includes(String(m.category))).map((m) => Number(m.id)));
    for (const m of mems) {
      if (!past.has(Number(m.id)) || String(m.content).startsWith("【")) continue;
      this.sql.exec("UPDATE memories SET content = ?, category = '回憶', updated = ? WHERE id = ?", `${label}${m.content}`.slice(0, 500), Date.now(), m.id);
    }
    // 上一趟的對話摘要也記成一條回憶：AI 才知道這家人去過哪裡、發生過什麼
    const summary = this.setting("summary");
    if (summary) this.insertMemory(`${label}回顧（${old.start}～${old.end}）：${summary.replace(/\s+/g, " ").slice(0, 400)}`, "回憶", "AI 自動整理", "auto", null);
  }

  // ---------------- AI 初始化 ----------------

  private async runInit() {
    const p = this.p();
    const keys = await this.keys();
    const progress = (step: number, label: string) => {
      const v = { step, label, total: INIT_STEPS.length };
      this.setSetting("init_progress", JSON.stringify(v));
      this.broadcast({ type: "init_progress", ...v });
    };
    const { profile, phrases, checklist } = await researchTrip({ ...p, initNotes: [] }, {
      ask: (system, prompt) => this.generateText(system, prompt, true, 0.5),
      tavilyKey: keys.tavily,
      progress,
    });
    // 初始化期間管理員可能按了「重新查詢」以外的修改，以最新狀態為準
    if (this.profile()?.status !== "initializing") return;
    const extra = this.setting("init_note");
    if (extra) {
      profile.initNotes.unshift(extra);
      this.setSetting("init_note", "");
    }
    profile.status = "review";
    this.saveProfile(profile);
    if (phrases.length) {
      this.sql.exec("DELETE FROM phrases WHERE author = '預設'");
      for (const x of phrases) this.sql.exec("INSERT INTO phrases (category, zh, local, reading, author, ts) VALUES (?, ?, ?, ?, '預設', ?)", x.category, x.zh, x.local, x.reading, Date.now());
    }
    // 重新查詢會整批換掉 AI 產生的清單：同名的項目保留打勾
    const ticked = new Map(this.sql.exec("SELECT item, done_by FROM checklist WHERE author = 'AI 初始化' AND done = 1").toArray().map((r) => [String(r.item), r.done_by]));
    this.sql.exec("DELETE FROM checklist WHERE author = 'AI 初始化'");
    for (const c of checklist) {
      const by = ticked.get(c.item);
      this.sql.exec("INSERT INTO checklist (list, item, for_whom, author, done, done_by, ts) VALUES (?, ?, '', 'AI 初始化', ?, ?, ?)", c.list, c.item, by === undefined ? 0 : 1, by ?? null, Date.now());
    }
    this.setSetting("init_progress", JSON.stringify({ step: INIT_STEPS.length, label: "完成", total: INIT_STEPS.length }));
    this.ctx.waitUntil(this.registry().updateRoom(this.roomId(), { title: profile.title, country: profile.country, flag: flagEmoji(profile.countryCode), status: "review" }));
    this.helloAll();
  }

  // ================= HTTP（登入、照片、相簿） =================

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = this.profile();
    if (url.pathname === "/info") {
      if (!p) return Response.json({ exists: false });
      if (p.kind === "personal") return Response.json({ exists: true, kind: "personal", title: p.title, flag: "🙋", status: p.status });
      return Response.json({ exists: true, kind: "trip", title: p.title, flag: flagEmoji(p.countryCode), country: p.country, city: p.city, startDate: p.startDate, endDate: p.endDate, status: p.status });
    }
    if (!p) return Response.json({ ok: false, error: "找不到這個旅程（可能已被刪除）" }, { status: 404 });

    const user = {
      name: decodeURIComponent(req.headers.get("x-user-name") ?? ""),
      admin: req.headers.get("x-user-admin") === "1",
      ver: Number(req.headers.get("x-user-ver") ?? 0),
    };
    if (url.pathname === "/login") return this.login(req);
    const ics = url.pathname.match(/^\/ics\/([\w-]+)\.ics$/);
    if (ics) {
      const token = this.setting("ics_token");
      if (!token || !safeEqual(ics[1], token)) return new Response("Not found", { status: 404 });
      return new Response(this.icsFeed(), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
    }
    // iPhone 捷徑「分享 → 存到助理」：不用登入，收不收由網址裡的密語決定
    const inbox = url.pathname.match(/^\/inbox\/([\w-]+)$/);
    if (inbox && req.method === "POST") return this.inboxCapture(inbox[1], req);
    // 日記分享連結：不用登入，要在登入檢查之前處理
    const shared = url.pathname.match(/^\/share\/([\w-]+)(?:\/photo\/([\w-]+))?$/);
    if (shared) return this.shared(shared[1], shared[2], req, url);
    // 管理員改過密碼：舊的登入一律失效
    if (user.ver !== Number(this.setting("auth_version", "1"))) return Response.json({ ok: false, error: "請重新登入" }, { status: 401 });
    if (url.pathname === "/me") return Response.json({ ok: true });
    if (url.pathname === "/album") return this.album("member", req, url);
    if (url.pathname === "/push/key") return Response.json({ ok: true, key: (await this.vapidKeys()).publicKey });
    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as any;
      const endpoint = String(b?.subscription?.endpoint ?? "");
      const p256dh = String(b?.subscription?.keys?.p256dh ?? ""), auth = String(b?.subscription?.keys?.auth ?? "");
      // 只接受正牌推播服務的網址，伺服器才不會被拿來對任意網址發請求
      if (!PUSH_HOSTS.test(endpoint) || !/^[\w-]{40,120}$/.test(p256dh) || !/^[\w-]{10,40}$/.test(auth)) return Response.json({ ok: false, error: "通知訂閱資料不正確" }, { status: 400 });
      this.sql.exec(
        "INSERT INTO push_subs VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ts = excluded.ts",
        endpoint, p256dh, auth, Date.now(), String(req.headers.get("user-agent") ?? "").slice(0, 200),
      );
      // 每個空間最多 10 台裝置，太舊的拿掉
      this.sql.exec("DELETE FROM push_subs WHERE endpoint NOT IN (SELECT endpoint FROM push_subs ORDER BY ts DESC LIMIT 10)");
      const origin = req.headers.get("x-origin");
      if (origin && /^https:\/\//.test(origin)) this.setSetting("push_subject", origin);
      this.broadcast({ type: "settings", settings: this.settings() });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as any;
      this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", String(b?.endpoint ?? ""));
      this.broadcast({ type: "settings", settings: this.settings() });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/export") {
      if (!user.admin) return Response.json({ ok: false, error: "只有管理員可以匯出" }, { status: 403 });
      const date = this.today().replaceAll("-", "");
      return new Response(JSON.stringify(this.exportData(), null, 1), {
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="trip-agent-${date}.json"`, "cache-control": "no-store" },
      });
    }

    // 語音備忘：開始一段錄音、上傳每一段（錄音每 5 分鐘一段；大的檔案切成好幾塊上傳）
    // 知識庫上傳文件：開始、分塊上傳、下載原檔
    const file = url.pathname.match(/^\/file\/(?:start|(\d+)(\/part)?)$/);
    if (file) {
      if (!this.isPersonal()) return Response.json({ ok: false, error: "上傳文件只有個人助理可以用" }, { status: 403 });
      if (req.method === "POST" && !file[1]) return this.fileStart(req, user.name);
      if (req.method === "POST" && file[2]) return this.filePart(Number(file[1]), url, req);
      if (req.method === "GET" && file[1] && !file[2]) return this.fileDownload(Number(file[1]));
    }
    const audio = url.pathname.match(/^\/memo\/(\d+)\/audio$/);
    if (audio && req.method === "GET") return this.memoAudio(Number(audio[1]), Number(url.searchParams.get("seq") ?? 0), req);
    const memo = url.pathname.match(/^\/memo\/(?:start|(\d+)\/seg)$/);
    if (memo && req.method === "POST") {
      if (!this.isPersonal()) return Response.json({ ok: false, error: "語音備忘只有個人助理可以用" }, { status: 403 });
      return memo[1] ? this.memoSegment(Number(memo[1]), url, req) : this.memoStart(req, user.name);
    }

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ name: user.name, admin: user.admin, joined: Date.now() } satisfies Attachment);
      this.touchMember(user.name);
      this.sendHello(pair[1], user);
      this.broadcastPresence();
      this.ctx.waitUntil(this.registry().touchRoom(this.roomId()));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/photos" && req.method === "GET") return this.photoList();
    if (url.pathname === "/expenses.csv" && req.method === "GET") return this.expensesCsv();

    if (url.pathname === "/photo" && req.method === "POST") {
      const mime = req.headers.get("content-type") ?? "image/jpeg";
      if (!mime.startsWith("image/")) return new Response("只接受圖片", { status: 400 });
      const data = await req.arrayBuffer();
      if (data.byteLength > 1_800_000) return new Response("圖片太大", { status: 413 });
      const used = this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM photos").one().n as number;
      if (used + data.byteLength > PHOTO_BYTES_LIMIT) return new Response("這個旅程的照片空間已滿", { status: 507 });
      const id = newId();
      this.sql.exec("INSERT INTO photos VALUES (?, ?, ?, ?, ?)", id, Date.now(), user.name, mime, data);
      return Response.json({ id });
    }

    const photo = url.pathname.match(/^\/photo\/([\w-]+)$/);
    if (photo) {
      const row = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", photo[1]).toArray()[0];
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.data as ArrayBuffer, { headers: { "content-type": row.mime as string, "cache-control": "private, max-age=31536000, immutable" } });
    }

    return new Response("Not found", { status: 404 });
  }

  private async login(req: Request): Promise<Response> {
    const ip = req.headers.get("x-ip") ?? "?";
    const { password = "", name = "" } = (await req.json().catch(() => ({}))) as { password?: string; name?: string };
    const row = this.sql.exec("SELECT count, ts FROM login_attempts WHERE ip = ?", ip).toArray()[0];
    const recent = row && Date.now() - (row.ts as number) < 15 * 60_000 ? (row.count as number) : 0;
    if (recent >= 8) return Response.json({ ok: false, error: "嘗試太多次，請 15 分鐘後再試" }, { status: 429 });

    const cleanName = name.trim().slice(0, 16);
    if (!cleanName) return Response.json({ ok: false, error: "請輸入暱稱" }, { status: 400 });
    if (cleanName === AI_NAME) return Response.json({ ok: false, error: "這個名字保留給 AI" }, { status: 400 });

    const pw = password.trim();
    const admin = !!pw && (await verifyPassword(pw, this.setting("pw_admin")));
    const member = admin || (!!pw && (await verifyPassword(pw, this.setting("pw_room"))));
    if (!member) {
      this.sql.exec("INSERT INTO login_attempts VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = ?, ts = ?", ip, recent + 1, Date.now(), recent + 1, Date.now());
      return Response.json({ ok: false, error: "密碼不正確" }, { status: 401 });
    }
    this.sql.exec("DELETE FROM login_attempts WHERE ip = ?", ip);
    this.touchMember(cleanName);
    const user: SessionUser = { room: this.roomId(), name: cleanName, admin, ver: Number(this.setting("auth_version", "1")) };
    return Response.json({ ok: true, user });
  }

  private touchMember(name: string) {
    if (!name) return;
    this.sql.exec("INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen", name, Date.now(), Date.now());
  }

  // ================= WebSocket =================

  private sockets(): { ws: WebSocket; user: Attachment }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, user: ws.deserializeAttachment() as Attachment }));
  }

  private send(ws: WebSocket, data: unknown) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }

  private broadcast(data: unknown) {
    const s = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {}
    }
  }

  private broadcastPresence() {
    const online = [...new Set(this.sockets().map((s) => s.user.name))];
    this.broadcast({ type: "presence", online });
  }

  private sendHello(ws: WebSocket, user: { name: string; admin: boolean }) {
    const p = this.p();
    const active = p.status === "active";
    this.send(ws, {
      type: "hello",
      version: this.env.CF_VERSION?.id ?? "",
      me: { name: user.name, admin: user.admin },
      aiName: AI_NAME,
      roomId: this.roomId(),
      settings: this.settings(),
      status: p.status,
      initProgress: JSON.parse(this.setting("init_progress", "{}")),
      messages: active ? this.recentMessages(60).map((m) => this.publicMessage(m)) : [],
      locateReq: this.locateRequest(),
      state: this.state(),
    });
  }

  /** 旅程狀態改變（初始化完成、啟用、改設定）時讓每個人重新載入畫面 */
  private helloAll() {
    for (const { ws, user } of this.sockets()) this.sendHello(ws, user);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const user = ws.deserializeAttachment() as Attachment;
    const p = this.profile();
    if (!p) return;
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping":
        return this.send(ws, { type: "pong" });

      case "send": {
        if (p.status !== "active") return;
        const text = String(msg.text ?? "").slice(0, 4000).trim();
        // 一次最多 6 張（菜單好幾頁一起翻譯）；只收這個聊天室真的有的照片
        const asked = [...new Set<string>((Array.isArray(msg.photoIds) ? msg.photoIds : typeof msg.photoId === "string" ? [msg.photoId] : []).map(String))].slice(0, MAX_PHOTOS);
        const found = new Set(asked.length ? this.sql.exec(`SELECT id FROM photos WHERE id IN (${asked.map(() => "?").join(",")})`, ...asked).toArray().map((r) => r.id as string) : []);
        const photoIds = asked.filter((x) => found.has(x));
        const photoId = photoIds[0] ?? null;
        const loc = msg.location && Number.isFinite(msg.location.lat) ? msg.location : null;
        if (!text && !photoId && !loc) return;
        if (loc) this.saveLocation(user.name, loc);
        // 回覆某一則訊息：記下被回覆的是誰說的、說了什麼（畫面上顯示引用，AI 追問時也看得到）
        const quoted = typeof msg.replyTo === "string" ? this.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", msg.replyTo).toArray()[0] : undefined;
        const reply = quoted ? { id: quoted.id, author: quoted.author, text: String(quoted.text ?? "").slice(0, 300) || (quoted.photo_id ? "（照片）" : "") } : null;
        const row = this.insertMessage({
          author: user.name, role: "user", text, photo_id: photoId, lat: loc?.lat ?? null, lon: loc?.lon ?? null,
          meta: reply || photoIds.length > 1 ? JSON.stringify({ ...(reply ? { reply } : {}), ...(photoIds.length > 1 ? { photos: photoIds } : {}) }) : null,
        });
        this.broadcast({ type: "message", message: this.publicMessage(row) });
        if (this.shouldReply(text, !!photoId, quoted?.role === "assistant")) {
          const job = this.queue.then(() => this.runAgent(row, user));
          this.queue = job.catch(() => {});
          await job;
        } else {
          this.ctx.waitUntil(this.maybeConsolidateMemory());
        }
        return;
      }

      case "location":
        if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) this.saveLocation(user.name, msg);
        return;

      // 有人打開「家人位置」：請每支開著 App 的手機回報一次；沒開的人 30 分鐘內打開 App 也會補報
      case "locate_all": {
        const prev = this.locateRequest();
        if (prev && Date.now() - prev.ts < 60_000) return;
        const req = { by: user.name, ts: Date.now() };
        this.setSetting("locate_req", JSON.stringify(req));
        this.broadcast({ type: "locate_request", ...req });
        return;
      }

      case "load_more": {
        const before = Number(msg.before) || Date.now();
        const after = Number(msg.after) || 0;
        // after＝回到上次讀到的地方：一次補到未讀起點前兩則（最多 200 則）；平常往上捲每次 50 則
        const floor = after
          ? (this.sql.exec<{ ts: number }>("SELECT ts FROM messages WHERE ts <= ? ORDER BY ts DESC LIMIT 1 OFFSET 2", after).toArray()[0]?.ts ?? 0)
          : 0;
        const rows = this.sql
          .exec<MessageRow>(`SELECT * FROM messages WHERE ts < ? AND ts >= ? ORDER BY ts DESC LIMIT ${after ? 200 : 50}`, before, floor)
          .toArray()
          .reverse();
        const hasMore = rows.length > 0 && this.sql.exec("SELECT 1 FROM messages WHERE ts < ? LIMIT 1", rows[0].ts).toArray().length > 0;
        return this.send(ws, { type: "older", messages: rows.map((m) => this.publicMessage(m)), hasMore });
      }

      case "get_state":
        return this.send(ws, { type: "state", state: this.state() });

      case "action":
        return this.handleAction(ws, user, msg);
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {}
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }

  private shouldReply(text: string, hasPhoto: boolean, toAi = false): boolean {
    if (!text && !hasPhoto) return false; // 單純分享位置不打擾 AI
    if (toAi) return true; // 回覆 AI 的訊息＝在問 AI，「只回 @AI」模式也要回答
    if (this.isPersonal()) return true; // 個人助理只有本人，每則都回
    if (this.settings().replyMode === "all") return true;
    return /@(ai|AI|旅伴|助理|小幫手)/.test(text) || text.startsWith("/ai") || (hasPhoto && /@/.test(text));
  }

  // ================= 使用者在畫面上的操作 =================

  private async handleAction(ws: WebSocket, user: Attachment, msg: any) {
    const reply = (ok: boolean, error?: string) => this.send(ws, { type: "action_result", ok, error, action: msg.action });
    const p = this.p();
    const adminOnly = ["activate", "update_profile", "rerun_init", "next_trip", "update_keys", "update_passwords", "delete_trip", "settings", "reset", "brief_now", "diary_now", "diary_rewrite", "share_on", "share_off"];
    if (adminOnly.includes(msg.action) && !user.admin) return reply(false, "只有管理員可以使用");
    // 還沒啟用的旅程只能做確認與設定
    if (p.status !== "active" && !["activate", "update_profile", "rerun_init", "update_keys", "delete_trip"].includes(msg.action)) return reply(false, "旅程還在準備中");

    switch (msg.action) {
      // ---- 旅程設定（管理員） ----
      case "update_profile":
      case "activate": {
        const err = this.applyProfilePatch(p, msg.profile ?? {});
        if (err) return reply(false, err);
        const first = msg.action === "activate" && p.status !== "active";
        if (msg.action === "activate") p.status = "active";
        this.saveProfile(p);
        this.syncItineraryDays(p);
        this.ctx.waitUntil(this.registry().updateRoom(this.roomId(), {
          title: p.title, country: p.country, flag: flagEmoji(p.countryCode), city: p.city, startDate: p.startDate, endDate: p.endDate, status: p.status,
        }));
        if (first) {
          // 換國家繼續玩：讓大家知道上一趟的事 AI 都還記得
          const from = this.setting("next_from");
          if (from) this.setSetting("next_from", "");
          this.postAiMessage(
            `🎉 **${p.title}** 準備好了！\n\n${from ? `上一趟「${from}」的回憶我都記得（大家的口味、過敏、習慣），這次不用重新介紹 😊\n\n` : ""}我是${AI_NAME}，可以幫大家查景點美食和照片、找附近、估計程車、記帳分帳、翻譯${p.language}、設提醒…有問題直接在這裡問我就好。\n\n` +
              `👉 先按下方「工具箱」→ 使用說明，看看每個功能怎麼用\n👉 ${p.country}的入境、插座、交通、退稅整理在 「工具箱」→ 旅遊指南\n👉 管理員可以到 下方「設定」→ 邀請家人，把網址傳給大家`,
            { kind: "welcome" },
          );
          await this.ctx.storage.setAlarm(Date.now() + 60_000);
        }
        this.helloAll();
        break;
      }
      case "next_trip": {
        const err = await this.nextTrip(msg.trip ?? {});
        if (err) return reply(false, err);
        break;
      }
      case "rerun_init": {
        // 先套用表單上還沒按「儲存」的修改（換了國家、城市、日期、住宿），AI 才會照新的查
        if (msg.profile && typeof msg.profile === "object") {
          const before = { country: p.country, city: p.city, title: p.title, acc: `${p.accommodation.name}|${p.accommodation.address}` };
          const err = this.applyProfilePatch(p, msg.profile);
          if (err) return reply(false, err);
          this.syncItineraryDays(p);
          if (p.country !== before.country || p.city !== before.city) {
            // 名稱是自動取的（「首爾旅行 2026」）就跟著換；自己取的名稱不動
            const year = p.startDate.slice(0, 4);
            if (before.title === `${before.city || before.country}旅行 ${year}`) p.title = "";
            // 換了國家、住宿卻沒換：舊住宿的位置不能用，查完在確認頁提醒
            if (p.country !== before.country && `${p.accommodation.name}|${p.accommodation.address}` === before.acc) {
              this.setSetting("init_note", `國家從「${before.country}」換成「${p.country}」，但住宿還是「${p.accommodation.name || p.accommodation.address || "未填"}」，請更新住宿並按「📍 重新定位」；每天的行程也記得改`);
            }
          }
        }
        p.status = "initializing";
        this.saveProfile(p);
        this.setSetting("init_progress", JSON.stringify({ step: 0, label: "準備中", total: INIT_STEPS.length }));
        await this.ctx.storage.setAlarm(Date.now() + 200);
        this.helloAll();
        break;
      }
      case "update_keys": {
        if (typeof msg.tavily === "string" && msg.tavily.trim()) {
          const err = await validateTavily(msg.tavily.trim());
          if (err) return reply(false, err);
          await this.storeKeys(msg.tavily.trim(), undefined);
        }
        if (typeof msg.gemini === "string") {
          if (msg.gemini.trim()) {
            const err = await validateGemini(msg.gemini.trim());
            if (err) return reply(false, err);
          }
          await this.storeKeys(undefined, msg.gemini.trim());
        }
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      }
      case "update_passwords": {
        const room = String(msg.roomPassword ?? "").trim();
        const admin = String(msg.adminPassword ?? "").trim();
        if (!room && !admin) return reply(false, "請輸入新密碼");
        if (room && room.length < 4) return reply(false, "旅伴密碼至少 4 個字");
        if (admin && admin.length < 6) return reply(false, "管理員密碼至少 6 個字");
        if (room) this.setSetting("pw_room", await hashPassword(room));
        if (admin) this.setSetting("pw_admin", await hashPassword(admin));
        this.setSetting("auth_version", String(Number(this.setting("auth_version", "1")) + 1));
        reply(true);
        // 所有人（包含自己）都要用新密碼重新登入
        for (const { ws: s } of this.sockets()) {
          try {
            s.close(4001, "password changed");
          } catch {}
        }
        return;
      }
      case "delete_trip": {
        if (String(msg.confirm ?? "").trim() !== p.title) return reply(false, "輸入的旅程名稱不符，沒有刪除");
        await this.destroy();
        return;
      }
      case "settings":
        if (msg.replyMode === "all" || msg.replyMode === "mention") this.setSetting("reply_mode", msg.replyMode);
        for (const [k, key] of [["autoBrief", "auto_brief"], ["autoDiary", "auto_diary"], ["autoAlerts", "auto_alerts"], ["memoryPaused", "memory_paused"]] as const) {
          if (typeof msg[k] === "boolean") this.setSetting(key, msg[k] ? "1" : "0");
        }
        if (Number.isInteger(msg.briefHour) && msg.briefHour >= 5 && msg.briefHour <= 11) this.setSetting("brief_hour", String(msg.briefHour));
        if (msg.voiceEngine === "gemini" || msg.voiceEngine === "private") this.setSetting("voice_engine", msg.voiceEngine);
        if (["weekly", "daily", "off"].includes(msg.diaryMode)) this.setSetting("diary_mode", msg.diaryMode);
        this.broadcast({ type: "settings", settings: this.settings() });
        break;

      // ---- 一般功能 ----
      case "add_memory":
        if (String(msg.content ?? "").trim()) this.addMemory(String(msg.content).trim(), msg.category || "資訊", user.name);
        break;
      case "delete_memory":
        this.deleteMemory(Number(msg.id));
        break;
      // ---- 個人助理：記憶頁、預算、推播 ----
      case "edit_memory": {
        const content = String(msg.content ?? "").trim().slice(0, 500);
        if (!content) return reply(false, "內容不能是空的");
        const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(msg.expires ?? "")) ? String(msg.expires) : null;
        this.sql.exec("UPDATE memories SET content = ?, expires = ?, source = 'user', updated = ? WHERE id = ?", content, expires, Date.now(), Number(msg.id));
        this.broadcastState();
        break;
      }
      case "restore_memory":
        this.sql.exec("UPDATE memories SET status = 'active', superseded_by = NULL, expires = NULL, updated = ? WHERE id = ?", Date.now(), Number(msg.id));
        this.broadcastState();
        break;
      // ---- 行事曆 ----
      case "event_add": {
        const e = cleanEventInput(msg);
        if ("error" in e) return reply(false, e.error);
        this.eventAdd(e, user.name);
        break;
      }
      case "event_delete":
        this.eventDelete(Number(msg.id));
        break;
      case "ics_on":
      case "ics_reset":
        // 重設＝換一組密語，舊的訂閱連結立刻失效
        this.setSetting("ics_token", randomToken());
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "ics_off":
        this.setSetting("ics_token", "");
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      // ---- 做夢：確認卡、復原、現在整理一次 ----
      case "card_answer": {
        const err = this.cardAnswer(Number(msg.id), String(msg.answer ?? ""), String(msg.text ?? ""), user.name);
        if (err) return reply(false, err);
        break;
      }
      case "dream_undo": {
        const err = this.dreamUndo(Number(msg.id));
        if (err) return reply(false, err);
        break;
      }
      case "dream_now":
        if (!this.isPersonal()) return reply(false, "只有個人助理有這個功能");
        await this.dream(this.today(), true);
        break;
      // ---- 知識庫 ----
      case "note_add": {
        const title = String(msg.title ?? "").trim().slice(0, 80);
        const content = String(msg.content ?? "").trim().slice(0, 6000);
        if (!title || !content) return reply(false, "標題和內容都要填");
        const tags = String(msg.tags ?? "").split(/[,，、#\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
        this.noteSave({ title, summary: content, tags }, user.name, false);
        break;
      }
      case "note_edit": {
        const title = String(msg.title ?? "").trim().slice(0, 80);
        const summary = String(msg.summary ?? "").trim().slice(0, 3000);
        if (!title || !summary) return reply(false, "標題和重點不能是空的");
        const tags = String(msg.tags ?? "").split(/[,，、#\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
        this.sql.exec("UPDATE notes SET title = ?, summary = ?, tags = ?, inbox = 0 WHERE id = ?", title, summary, JSON.stringify(tags), Number(msg.id));
        this.broadcastState();
        break;
      }
      case "note_file":
        this.sql.exec("UPDATE notes SET inbox = 0 WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      case "note_delete": {
        // 連同切好的段落、上傳的原檔一起刪
        const id = Number(msg.id);
        this.dropNoteChunks(id);
        for (const f of this.sql.exec("SELECT id FROM files WHERE note_id = ?", id).toArray()) this.deleteFile(Number(f.id));
        this.sql.exec("DELETE FROM notes WHERE id = ?", id);
        this.broadcastState();
        break;
      }
      case "note_text": {
        const row = this.sql.exec("SELECT content FROM notes WHERE id = ?", Number(msg.id)).toArray()[0];
        if (!row) return reply(false, "找不到這筆");
        this.send(ws, { type: "note_text", id: Number(msg.id), text: String(row.content ?? "") });
        break;
      }
      case "file_retry":
        this.sql.exec("UPDATE files SET status = 'processing', error = NULL, updated = ? WHERE id = ? AND status = 'error' AND EXISTS (SELECT 1 FROM file_data d WHERE d.file_id = files.id)", Date.now(), Number(msg.id));
        this.broadcastState();
        this.kickFiles();
        break;
      case "file_delete":
        this.deleteFile(Number(msg.id));
        this.broadcastState();
        break;
      case "core_save":
        this.setSetting("core_profile", String(msg.text ?? "").trim().slice(0, 800));
        this.broadcastState();
        break;
      case "budget_set": {
        const amount = Math.max(0, Math.round(Number(msg.amount) || 0));
        this.setSetting("budget_month", String(amount));
        // 改了預算：這個月的超支提醒重新算
        this.setSetting(`budget_alert_${this.today().slice(0, 7)}`, "0");
        this.broadcast({ type: "settings", settings: this.settings() });
        this.broadcastState();
        break;
      }
      case "push_test":
        if (!(this.sql.exec("SELECT COUNT(*) AS n FROM push_subs").one().n as number)) return reply(false, "這個空間還沒有開啟通知的裝置");
        await this.pushAll({ title: "🔔 測試通知", body: "手機通知設定成功！提醒、早報和預算提醒都會送到這裡。", tag: "test" });
        break;
      case "update_itinerary":
        this.updateItinerary(String(msg.date), { title: msg.title, detail: msg.detail, status: msg.status }, user.name);
        break;
      case "delete_expense":
        this.deleteExpense(Number(msg.id));
        break;
      case "add_expense": {
        const r: any = await runTool("add_expense", msg.expense ?? {}, await this.toolCtx(user.name));
        if (r?.error) return reply(false, r.error);
        break;
      }
      case "draft_confirm":
      case "draft_cancel": {
        const err = this.draftResolve(Number(msg.id), user.name, msg.action === "draft_confirm");
        if (err) return reply(false, err);
        break;
      }
      case "checklist_add": {
        const items = String(msg.item ?? "").split(/\n/).map((s) => s.trim()).filter(Boolean);
        if (!items.length) return reply(false, "請輸入項目");
        this.checklistAdd(String(msg.list || "購物"), items, String(msg.forWhom ?? ""), user.name);
        break;
      }
      case "checklist_toggle":
        this.checklistUpdate({ id: Number(msg.id) }, { done: !!msg.done }, user.name);
        break;
      case "checklist_delete":
        this.checklistUpdate({ id: Number(msg.id) }, { remove: true }, user.name);
        break;
      case "reminder_add": {
        const m = String(msg.local ?? "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
        const due = m ? localToUtc(m[1], m[2], p.timezone) : null;
        if (!due || due < Date.now() - 60_000) return reply(false, "提醒時間不正確或已經過了");
        this.reminderAdd(due, String(msg.message ?? "").slice(0, 300), user.name);
        break;
      }
      case "reminder_delete":
        this.reminderDelete(Number(msg.id));
        break;
      case "document_save":
        if (typeof msg.photoId !== "string") return reply(false, "請先選擇照片");
        this.documentSave(String(msg.title || "票券").slice(0, 80), String(msg.note ?? "").slice(0, 300), msg.photoId, user.name, this.folderId(msg.folder));
        break;
      case "document_delete":
        this.sql.exec("DELETE FROM documents WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      // ---- 票券資料夾：全家共用，誰都可以整理 ----
      case "document_move": {
        const folder = this.folderId(msg.folder);
        if (msg.folder != null && folder == null) return reply(false, "找不到這個資料夾，可能剛被刪掉了");
        this.sql.exec("UPDATE documents SET folder_id = ? WHERE id = ?", folder, Number(msg.id));
        this.broadcastState();
        break;
      }
      case "folder_create": {
        const name = String(msg.name ?? "").trim().slice(0, 40);
        if (!name) return reply(false, "請輸入資料夾名稱");
        const parent = this.folderId(msg.parent);
        if (this.sql.exec("SELECT 1 FROM doc_folders WHERE name = ? AND parent_id IS ?", name, parent).toArray().length) return reply(false, "這裡已經有同名的資料夾");
        this.sql.exec("INSERT INTO doc_folders (name, parent_id, ts, author) VALUES (?, ?, ?, ?)", name, parent, Date.now(), user.name);
        this.broadcastState();
        break;
      }
      case "folder_rename": {
        const id = this.folderId(msg.id);
        const name = String(msg.name ?? "").trim().slice(0, 40);
        if (id == null || !name) return reply(false, "找不到資料夾或名稱是空的");
        this.sql.exec("UPDATE doc_folders SET name = ? WHERE id = ?", name, id);
        this.broadcastState();
        break;
      }
      case "folder_move": {
        const id = this.folderId(msg.id);
        const parent = this.folderId(msg.parent);
        if (id == null) return reply(false, "找不到這個資料夾");
        if (parent != null && this.folderLineage(parent).includes(id)) return reply(false, "不能把資料夾搬進它自己裡面");
        this.sql.exec("UPDATE doc_folders SET parent_id = ? WHERE id = ?", parent, id);
        this.broadcastState();
        break;
      }
      // 刪資料夾不刪票券：裡面的票券和子資料夾都移到上一層
      case "folder_delete": {
        const id = this.folderId(msg.id);
        if (id == null) return reply(false, "找不到這個資料夾");
        const up = this.sql.exec("SELECT parent_id FROM doc_folders WHERE id = ?", id).one().parent_id ?? null;
        this.sql.exec("UPDATE documents SET folder_id = ? WHERE folder_id = ?", up, id);
        this.sql.exec("UPDATE doc_folders SET parent_id = ? WHERE parent_id = ?", up, id);
        this.sql.exec("DELETE FROM doc_folders WHERE id = ?", id);
        this.broadcastState();
        break;
      }
      case "brief_now":
        if (this.isPersonal()) await this.postPersonalBrief(this.today());
        else await this.postMorningBrief(this.today());
        break;
      case "diary_now": {
        if (!this.isPersonal()) {
          await this.writeDiary(this.today());
          break;
        }
        // 個人日記：週記模式寫最近 7 天，日記模式寫今天
        const err = await this.writePersonalDiary(this.today(), this.setting("diary_mode", "weekly") === "daily" ? 1 : 7);
        if (err) return reply(false, err);
        break;
      }
      // 家人修改日記：標題、內文、照片（只能用已上傳的照片）；有人同時在改就擋下，免得互相蓋掉
      case "diary_edit": {
        const date = String(msg.date ?? "");
        const row = this.sql.exec("SELECT ts, layout FROM diaries WHERE date = ?", date).toArray()[0];
        if (!row) return reply(false, "找不到這天的日記");
        if (Number(msg.base) !== Number(row.ts)) return reply(false, "剛剛有人修改過這篇日記，請回上一頁重新打開再改");
        const title = String(msg.title ?? "").trim().slice(0, 40);
        const text = String(msg.text ?? "").trim().slice(0, 6000);
        const ids = (Array.isArray(msg.photos) ? msg.photos : []).map(String).filter((id: string) => /^[\w-]+$/.test(id)).slice(0, 30);
        const known = new Set(
          ids.length ? this.sql.exec(`SELECT id FROM photos WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map((r) => r.id as string) : [],
        );
        const photos: string[] = [...new Set<string>(ids.filter((id: string) => known.has(id)))];
        if (!title && !text && !photos.length) return reply(false, "日記不能全部清空");
        // 照片穿插在文章裡的位置（第幾段後面）不變，依新順序換成放哪一張；新加的照片放文末，說明跟著照片走
        const prev: DiaryPhoto[] = JSON.parse((row.layout as string) || "[]");
        let layout: DiaryPhoto[] | null = null;
        if (prev.length) {
          const byId = new Map(prev.map((l) => [l.id, l]));
          const slots = photos.map((id) => byId.get(id)?.para ?? 999).sort((a, b) => a - b);
          layout = photos.map((id, i) => ({ id, para: slots[i], caption: byId.get(id)?.caption ?? "" }));
        }
        const now = Date.now();
        this.sql.exec(
          "UPDATE diaries SET title = ?, text = ?, photo_ids = ?, layout = ?, ts = ?, edited_by = ?, edited_at = ? WHERE date = ?",
          title, text, JSON.stringify(photos), layout ? JSON.stringify(layout) : null, now, user.name, now, date,
        );
        this.broadcastState();
        break;
      }
      case "pin": {
        const id = String(msg.id ?? "");
        if (!this.sql.exec("SELECT 1 FROM messages WHERE id = ?", id).toArray().length) return reply(false, "找不到這則訊息");
        if ((this.sql.exec("SELECT COUNT(*) AS n FROM pins").one().n as number) >= PIN_LIMIT) return reply(false, `置頂最多 ${PIN_LIMIT} 則，請先取消不需要的`);
        this.sql.exec("INSERT OR IGNORE INTO pins VALUES (?, ?, ?)", id, Date.now(), user.name);
        this.broadcastState();
        break;
      }
      case "unpin":
        this.sql.exec("DELETE FROM pins WHERE message_id = ?", String(msg.id ?? ""));
        this.broadcastState();
        break;
      case "diary_rewrite": {
        const date = String(msg.date ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !this.sql.exec("SELECT 1 FROM diaries WHERE date = ?", date).toArray().length) return reply(false, "找不到這天的日記");
        if (this.isPersonal()) {
          const span = Number(this.sql.exec("SELECT span FROM diaries WHERE date = ?", date).one().span) || 1;
          const err = await this.writePersonalDiary(date, span, false);
          if (err) return reply(false, err);
        } else await this.writeDiary(date, false);
        break;
      }
      // 日記分享連結：開啟後拿到連結的人不用登入就能看日記與照片，關閉後舊連結立刻失效
      case "share_on":
      case "share_off":
        this.setSetting("share_token", msg.action === "share_on" ? this.setting("share_token") || randomToken() : "");
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "translate": {
        const text = String(msg.text ?? "").trim().slice(0, 1000);
        if (!text) return reply(false, "請輸入要翻譯的內容");
        const from = detectFrom(text, msg.from === "local" ? "local" : "zh", p.langCode);
        try {
          const r = await translate(this.env, (s, t) => this.generateText(s, t, true), p, text, from);
          const id = this.sql
            .exec("INSERT INTO translations (ts, author, from_lang, source, result, reading) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", Date.now(), user.name, from, text, r.translation, r.reading ?? null)
            .one().id as number;
          const item = this.sql.exec("SELECT * FROM translations WHERE id = ?", id).one();
          // 全家共用紀錄：發問者用 reqId 對應自己的結果，其他人更新紀錄清單
          this.broadcast({ type: "translation", reqId: msg.reqId ?? null, author: user.name, item, engine: r.engine });
        } catch (e: any) {
          return reply(false, `翻譯失敗：${e?.message ?? e}`);
        }
        break;
      }
      case "get_translations":
        this.send(ws, { type: "translations", items: this.sql.exec("SELECT * FROM translations ORDER BY ts DESC LIMIT 60").toArray() });
        return;
      case "add_phrase": {
        const zh = String(msg.zh ?? "").trim().slice(0, 200);
        const category = String(msg.category ?? "⭐ 我的常用句").slice(0, 20);
        if (!zh) return reply(false, "請輸入中文");
        try {
          const r = await translate(this.env, (s, t) => this.generateText(s, t, true), p, zh, "zh");
          this.sql.exec("INSERT INTO phrases (category, zh, local, reading, author, ts) VALUES (?, ?, ?, ?, ?, ?)", category, zh, r.translation, r.reading ?? "", user.name, Date.now());
        } catch (e: any) {
          return reply(false, `翻譯失敗：${e?.message ?? e}`);
        }
        this.broadcastState();
        break;
      }
      case "delete_phrase":
        this.sql.exec("DELETE FROM phrases WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      // ---- 第四階段：分享收件網址、語音備忘、證件到期 ----
      case "inbox_on":
      case "inbox_reset":
        // 重設＝換一組密語，舊的捷徑立刻失效
        this.setSetting("inbox_token", randomToken());
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "inbox_off":
        this.setSetting("inbox_token", "");
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "memo_todo": {
        const err = this.memoTodo(Number(msg.id), msg.idx == null ? null : Number(msg.idx), user.name);
        if (err) return reply(false, err);
        break;
      }
      case "memo_transcript": {
        const row = this.sql.exec("SELECT transcript, note_id FROM memos WHERE id = ?", Number(msg.id)).toArray()[0];
        if (!row) return reply(false, "找不到這段錄音");
        // 排版規則更新前存的逐字稿：打開時重排一次，知識庫那筆也一起更新
        const text = formatTranscript(String(row.transcript ?? ""));
        if (text !== row.transcript) {
          this.sql.exec("UPDATE memos SET transcript = ? WHERE id = ?", text, Number(msg.id));
          if (row.note_id) this.sql.exec("UPDATE notes SET content = ? WHERE id = ?", text.slice(0, 300_000), row.note_id);
        }
        this.send(ws, { type: "memo_transcript", id: Number(msg.id), text });
        break;
      }
      case "memo_retry":
        // 失敗的段落音檔還在才能重試
        this.sql.exec(
          "UPDATE memo_segs SET status = 'pending', tries = 0 WHERE memo_id = ? AND status = 'failed' AND EXISTS (SELECT 1 FROM memo_audio a WHERE a.memo_id = memo_segs.memo_id AND a.seq = memo_segs.seq)",
          Number(msg.id),
        );
        this.sql.exec(
          "UPDATE memos SET status = 'processing', ended = 1, error = NULL, updated = ?, done_segs = (SELECT COUNT(*) FROM memo_segs s WHERE s.memo_id = memos.id AND s.status != 'pending') WHERE id = ? AND (status IN ('error', 'processing') OR EXISTS (SELECT 1 FROM memo_segs s WHERE s.memo_id = memos.id AND s.status = 'pending'))",
          Date.now(), Number(msg.id),
        );
        this.setSetting("memo_retry_at", "0");
        this.broadcastState();
        this.kickMemos();
        break;
      case "memo_delete":
        for (const t of ["memo_audio", "memo_segs"]) this.sql.exec(`DELETE FROM ${t} WHERE memo_id = ?`, Number(msg.id));
        this.sql.exec("DELETE FROM memos WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      // ---- 健康管家 ----
      case "health_profile":
        this.health().saveProfile(msg.profile ?? {});
        this.broadcastState();
        break;
      case "health_log": {
        const r = this.health().addVital({ kind: msg.kind, v1: msg.v1, v2: msg.v2, v3: msg.v3, context: msg.context, date: msg.date, time: msg.time }, "app");
        if ("error" in r) return reply(false, r.error);
        this.send(ws, { type: "health_result", grade: r.grade, flags: r.flags });
        await this.afterVital(r.flags);
        break;
      }
      case "health_delete":
        this.health().deleteVital(Number(msg.id));
        this.broadcastState();
        break;
      case "med_save": {
        const r = this.health().medSave(msg.med ?? {});
        if ("error" in r) return reply(false, r.error);
        this.broadcastState();
        break;
      }
      case "med_stop":
        this.health().medStop(Number(msg.id));
        this.broadcastState();
        break;
      case "med_delete":
        this.health().medDelete(Number(msg.id));
        this.broadcastState();
        break;
      case "screen_mark":
        this.health().markScreening(String(msg.code ?? ""), msg.last ? String(msg.last) : null);
        this.broadcastState();
        break;
      case "task_start": {
        const r = this.health().startTask(msg.start ? String(msg.start) : undefined);
        if ("error" in r) return reply(false, r.error);
        this.broadcastState();
        break;
      }
      case "task_cancel":
        this.health().cancelTask();
        this.broadcastState();
        break;
      case "alert_seen":
        this.health().seeAlert(Number(msg.id));
        this.broadcastState();
        break;
      case "health_scan": {
        if (!this.isPersonal()) return reply(false, "只有個人助理有這個功能");
        const photoId = String(msg.photoId ?? "");
        if (!this.sql.exec("SELECT 1 FROM photos WHERE id = ?", photoId).toArray().length) return reply(false, "找不到照片，請重新上傳");
        const err = await this.scanBlocked();
        if (err) {
          this.sql.exec("DELETE FROM photos WHERE id = ?", photoId);
          return reply(false, err);
        }
        const id = this.health().scanAdd(msg.kind === "med" ? "med" : "lab", photoId);
        this.broadcastState();
        this.ctx.waitUntil(this.runScan(id));
        break;
      }
      case "scan_retry": {
        const s = this.health().scan(Number(msg.id));
        if (!s) return reply(false, "找不到這筆");
        const err = await this.scanBlocked();
        if (err) return reply(false, err);
        this.health().scanSet(Number(s.id), "reading");
        this.broadcastState();
        this.ctx.waitUntil(this.runScan(Number(s.id)));
        break;
      }
      case "scan_save": {
        const r = this.saveScan(Number(msg.id), msg);
        if ("error" in r) return reply(false, r.error);
        break;
      }
      case "scan_discard": {
        const s = this.health().scan(Number(msg.id));
        if (s) {
          this.health().scanSet(Number(s.id), "discarded");
          this.sql.exec("DELETE FROM photos WHERE id = ?", s.photo_id);
        }
        this.broadcastState();
        break;
      }
      case "lab_delete":
        this.health().deleteLab(Number(msg.id));
        this.broadcastState();
        break;
      case "health_import": {
        if (!this.isPersonal()) return reply(false, "只有個人助理有這個功能");
        const r = this.health().importBank(msg.data && typeof msg.data === "object" ? msg.data : {});
        this.send(ws, { type: "health_import_result", result: r });
        this.broadcastState();
        break;
      }
      case "iddoc_add": {
        const r = this.idDocAdd({ kind: msg.kind, holder: msg.holder, expires: msg.expires, last4: msg.last4 }, user.name);
        if ("error" in r) return reply(false, String(r.error));
        break;
      }
      case "iddoc_delete":
        this.sql.exec("DELETE FROM id_docs WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      case "reset": {
        // 管理員清除資料：測試結束正式使用前使用。只清勾選的項目
        const cleared: string[] = [];
        if (msg.chat) {
          this.sql.exec("DELETE FROM messages");
          this.sql.exec("DELETE FROM drafts");
          this.sql.exec("DELETE FROM pins");
          this.sql.exec("DELETE FROM photos");
          this.sql.exec("DELETE FROM photo_notes");
          this.sql.exec("DELETE FROM locations");
          this.sql.exec("DELETE FROM translations");
          this.setSetting("memory_cursor", "0");
          this.broadcast({ type: "cleared" });
          cleared.push("聊天紀錄");
        }
        if (msg.memory) {
          this.sql.exec("DELETE FROM memories");
          this.setSetting("summary", "");
          if (!msg.chat) this.setSetting("memory_cursor", String(Date.now()));
          cleared.push("長期記憶");
        }
        if (msg.expenses) {
          this.sql.exec("DELETE FROM expenses");
          cleared.push("帳目");
        }
        if (msg.itinerary) {
          this.resetItinerary(p);
          cleared.push("行程");
        }
        if (msg.health && this.isPersonal()) {
          this.health().clear();
          cleared.push("健康紀錄");
        }
        if (msg.tools) {
          this.sql.exec("DELETE FROM checklist WHERE author NOT IN ('預設', 'AI 初始化')");
          this.sql.exec("UPDATE checklist SET done = 0, done_by = NULL");
          this.sql.exec("DELETE FROM reminders");
          this.sql.exec("DELETE FROM documents");
          this.sql.exec("DELETE FROM doc_folders");
          this.sql.exec("DELETE FROM diaries");
          for (const t of ["memos", "memo_segs", "memo_audio", "id_docs"]) this.sql.exec(`DELETE FROM ${t}`);
          cleared.push("清單、提醒、票券、日記");
        }
        if (!cleared.length) return reply(false, "請至少勾選一項");
        console.log(`reset by ${user.name}: ${cleared.join("、")}`);
        this.broadcastState();
        break;
      }
      default:
        return reply(false, "未知的操作");
    }
    reply(true);
  }

  /** 刪除整個旅程（管理員在設定頁，或擁有者後台）：聊天、照片、金鑰全部清掉，無法復原 */
  async destroy(): Promise<void> {
    const id = this.roomId();
    if (id) await this.registry().removeRoom(id);
    for (const { ws: s } of this.sockets()) {
      try {
        s.send(JSON.stringify({ type: "deleted" }));
        s.close(4004, "deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.initTables(); // 同一個執行個體之後還可能收到請求，空表格才能回「找不到旅程」
    this.cachedProfile = null;
    this.cachedKeys = null;
  }

  /** 管理員在確認頁／設定頁修改旅程資料；回傳錯誤訊息或 null */
  private applyProfilePatch(p: TripProfile, x: any): string | null {
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
    const set = <K extends keyof TripProfile>(k: K, v: TripProfile[K] | undefined) => {
      if (v !== undefined) p[k] = v;
    };
    set("title", s(x.title, 40) || undefined);
    set("country", s(x.country, 30) || undefined);
    set("city", s(x.city, 40));
    set("flights", s(x.flights, 600));
    set("emergency", s(x.emergency, 300));
    set("language", s(x.language, 20) || undefined);
    set("readingName", s(x.readingName, 20));
    set("currencySymbol", s(x.currencySymbol, 6) || undefined);
    if (x.startDate !== undefined || x.endDate !== undefined) {
      const start = s(x.startDate, 10) ?? p.startDate, end = s(x.endDate, 10) ?? p.endDate;
      const err = checkDates(start, end);
      if (err) return err;
      p.startDate = start;
      p.endDate = end;
    }
    if (x.timezone !== undefined) {
      if (!validTimezone(String(x.timezone))) return "時區格式不正確（例如 Asia/Seoul）";
      p.timezone = String(x.timezone);
    }
    if (x.currency !== undefined) {
      if (!/^[A-Z]{3}$/i.test(String(x.currency))) return "貨幣代碼要是 3 個英文字母（例如 KRW）";
      p.currency = String(x.currency).toUpperCase();
    }
    if (x.langCode !== undefined) {
      if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(x.langCode))) return "語言代碼格式不正確（例如 ko-KR）";
      p.langCode = String(x.langCode);
    }
    if (x.countryCode !== undefined && /^[A-Z]{2}$/i.test(String(x.countryCode))) p.countryCode = String(x.countryCode).toUpperCase();
    if (x.accommodation && typeof x.accommodation === "object") {
      const a = x.accommodation;
      const lat = a.lat === null || a.lat === "" ? null : Number(a.lat), lon = a.lon === null || a.lon === "" ? null : Number(a.lon);
      const moved = (s(a.address, 300) ?? p.accommodation.address) !== p.accommodation.address;
      p.accommodation = {
        name: s(a.name, 100) ?? p.accommodation.name,
        address: s(a.address, 300) ?? p.accommodation.address,
        lat: Number.isFinite(lat) ? lat : moved ? null : p.accommodation.lat,
        lon: Number.isFinite(lon) ? lon : moved ? null : p.accommodation.lon,
        note: s(a.note, 300) ?? p.accommodation.note,
      };
    }
    if (Array.isArray(x.travelers)) {
      const t = cleanTravelers(x.travelers);
      if (!t.length) return "至少要有一位旅伴";
      p.travelers = t;
      for (const m of t) this.touchMember(m.name);
    }
    if (x.guide && typeof x.guide === "object") {
      for (const k of ["entry", "money", "power", "transport", "taxRefund", "connectivity", "etiquette", "weather"] as const) {
        const v = s(x.guide[k], 1200);
        if (v !== undefined) p.guide[k] = v;
      }
    }
    if (x.taxi !== undefined) {
      const t = x.taxi;
      p.taxi = t && Number(t.base) > 0 && Number(t.perKm) > 0
        ? { base: Number(t.base), baseKm: Number(t.baseKm) || 0, perKm: Number(t.perKm), nightMultiplier: Math.max(1, Number(t.nightMultiplier) || 1), nightFrom: Number(t.nightFrom) || 22, nightTo: Number(t.nightTo) || 5, note: s(t.note, 200) ?? "" }
        : null;
    }
    return null;
  }

  // ================= 訊息 =================

  private insertMessage(m: Omit<MessageRow, "id" | "ts"> & { id?: string }): MessageRow {
    const row: MessageRow = { id: m.id ?? newId(), ts: Date.now(), ...m } as MessageRow;
    this.sql.exec("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", row.id, row.ts, row.author, row.role, row.text, row.photo_id, row.lat, row.lon, row.meta);
    return row;
  }

  private recentMessages(limit: number): MessageRow[] {
    return this.sql.exec<MessageRow>("SELECT * FROM messages ORDER BY ts DESC LIMIT ?", limit).toArray().reverse();
  }

  private publicMessage(m: MessageRow) {
    const meta = m.meta ? JSON.parse(m.meta) : null;
    return {
      id: m.id,
      ts: m.ts,
      author: m.author,
      role: m.role,
      text: m.text,
      photo: m.photo_id ? `/api/photo/${m.photo_id}` : null,
      ...(photosOf(m).length > 1 ? { photos: photosOf(m).map((x) => `/api/photo/${x}`) } : {}),
      location: m.lat != null && m.lon != null ? { lat: m.lat, lon: m.lon } : null,
      meta,
      ...(meta?.drafts?.length ? { drafts: this.draftsPublic(meta.drafts) } : {}),
    };
  }

  // ================= 確認卡片（AI 要寫入的資料，成員按確認才寫） =================

  /** AI 呼叫會寫入的工具時：存成卡片，回給模型的說明要它請成員核對 */
  private propose(d: DraftInput, author: string, messageId: string, drafts: number[]) {
    if (d.replaces) this.draftSettle(d.replaces, "superseded", author);
    const id = this.sql
      .exec(
        "INSERT INTO drafts (ts, kind, payload, preview, author, message_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        Date.now(), d.kind, JSON.stringify(d.payload), JSON.stringify(d.preview), author, messageId,
      )
      .one().id as number;
    drafts.push(id);
    return {
      draft_id: id,
      status: "等待成員按確認，還沒寫入",
      preview: d.preview.rows,
      ...(d.warning ? { warning: d.warning } : {}),
      note: `已產生確認卡片 #${id}，會顯示在你的回答下方。請用一兩句話說明你從照片或訊息看到什麼、準備寫入什麼，請成員核對卡片後按「${d.preview.confirm}」，有錯直接跟你說要改哪裡。${d.warning ? `一定要提醒成員：${d.warning}。` : ""}卡片上已經有換算好的金額，說明裡不要自己換算。這段說明要寫在你這次的回覆裡（之前寫的字成員看不到）。成員按確認前不可以說「已記好／已更新／已刪除」。`,
    };
  }

  private draftsPublic(ids: number[]) {
    const list = ids.map(Number).filter(Number.isInteger).slice(0, 20);
    if (!list.length) return [];
    const rows = this.sql.exec(`SELECT * FROM drafts WHERE id IN (${list.map(() => "?").join(",")})`, ...list).toArray();
    return rows.map((r) => ({
      id: r.id as number,
      kind: r.kind as string,
      status: r.status as string,
      preview: JSON.parse(r.preview as string),
      author: r.author as string,
      resolved_by: (r.resolved_by as string | null) ?? null,
    }));
  }

  /** 還在等確認的卡片才改狀態，並通知大家更新畫面 */
  private draftSettle(id: number, status: "done" | "cancelled" | "superseded" | "failed", by: string) {
    const n = this.sql.exec("UPDATE drafts SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", status, by, Date.now(), id).rowsWritten;
    if (n) this.broadcast({ type: "draft", draft: this.draftsPublic([id])[0] });
    return n > 0;
  }

  /** 成員按了確認或取消；回傳錯誤訊息（成功是 null） */
  private draftResolve(id: number, by: string, confirm: boolean): string | null {
    const r = this.sql.exec("SELECT * FROM drafts WHERE id = ?", id).toArray()[0];
    if (!r) return "找不到這張卡片";
    if (r.status !== "pending") return "這張卡片已經處理過了";
    if (!confirm) {
      this.draftSettle(id, "cancelled", by);
      return null;
    }
    const p = JSON.parse(r.payload as string);
    let ok = true;
    switch (r.kind) {
      case "add_expense":
        this.addExpense(p as ExpenseInput);
        break;
      case "update_itinerary":
        this.updateItinerary(p.date, p.fields, p.author);
        break;
      case "delete_expense":
        ok = this.deleteExpense(Number(p.id));
        break;
      case "delete_reminder":
        ok = this.reminderDelete(Number(p.id));
        break;
      case "add_event":
        this.eventAdd(p as EventInput, String(r.author));
        break;
      case "update_event":
        ok = this.eventUpdate(Number(p.id), p.event as EventInput);
        break;
      case "delete_event":
        ok = this.eventDelete(Number(p.id));
        break;
      default:
        ok = false;
    }
    this.draftSettle(id, ok ? "done" : "failed", by);
    return ok ? null : "要刪除的資料已經不在了（可能有人先刪了，或提醒已經通知過）";
  }

  /** 給系統提示用：最近幾天的卡片與狀態（不放進對話紀錄，免得模型模仿格式、自己寫假卡片） */
  private draftBrief(): string {
    const status: Record<string, string> = { pending: "等待成員確認（還沒寫入）", done: "已確認並寫入", cancelled: "成員取消了", superseded: "已被新卡片取代", failed: "失效" };
    return this.sql
      .exec("SELECT id, preview, author, status, resolved_by FROM drafts WHERE ts > ? ORDER BY id DESC LIMIT 10", Date.now() - 3 * 86400_000)
      .toArray()
      .reverse()
      .map((r) => {
        const p = JSON.parse(r.preview as string);
        return `- 卡片編號 ${r.id}｜${p.title}：${p.summary}｜${r.author} 提出｜${status[r.status as string] ?? r.status}${r.status === "done" ? `（${r.resolved_by}）` : ""}`;
      })
      .join("\n");
  }

  private saveLocation(name: string, loc: { lat: number; lon: number; accuracy?: number }) {
    // 移動不到 200 公尺就沿用上次查到的地名，省得每次都反查
    const prev = this.memberLocation(name)[0];
    const keepArea = prev?.area && distanceMeters(prev.lat, prev.lon, loc.lat, loc.lon) < 200 ? prev.area : null;
    this.sql.exec(
      `INSERT INTO locations (name, lat, lon, accuracy, ts, area) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, accuracy = excluded.accuracy, ts = excluded.ts, area = excluded.area`,
      name, loc.lat, loc.lon, loc.accuracy ?? null, Date.now(), keepArea,
    );
    // 地圖開著的人馬上看到新位置；地名查好再更新一次
    this.broadcast({ type: "locations", locations: this.memberLocation() });
    if (!keepArea) this.ctx.waitUntil(this.ensureArea(name).then(() => this.broadcast({ type: "locations", locations: this.memberLocation() })));
  }

  /** 最近 30 分鐘內有人在找家人（之後才打開 App 的人也要補報位置） */
  private locateRequest(): { by: string; ts: number } | null {
    try {
      const r = JSON.parse(this.setting("locate_req") || "null");
      return r && Date.now() - r.ts < 30 * 60_000 ? r : null;
    } catch {
      return null;
    }
  }

  /** 反查成員目前位置的地名並存起來（最多等 8 秒，失敗就算了，下次再查） */
  private async ensureArea(name: string): Promise<string | null> {
    const l = this.memberLocation(name)[0];
    if (!l) return null;
    if (l.area) return l.area;
    try {
      const area = await reverseArea(l.lat, l.lon, this.p().langCode.slice(0, 2));
      if (area) this.sql.exec("UPDATE locations SET area = ? WHERE name = ? AND ts = ?", area, name, l.ts);
      return area || null;
    } catch {
      return null;
    }
  }

  private today(): string {
    return zoned(Date.now(), this.p().timezone).date;
  }

  private localTime(ts: number): string {
    return localDateTime(ts, this.p().timezone);
  }

  // ================= RoomApi（給工具用） =================

  /** 旅伴名單：引導設置填的優先，否則用登入過的人 */
  members(): string[] {
    const t = this.profile()?.travelers ?? [];
    if (t.length) return t.map((x) => x.name);
    return this.sql.exec("SELECT name FROM members ORDER BY first_seen").toArray().map((r) => r.name as string);
  }

  memberLocation(name?: string) {
    const rows = name ? this.sql.exec("SELECT * FROM locations WHERE name = ?", name).toArray() : this.sql.exec("SELECT * FROM locations ORDER BY ts DESC").toArray();
    return rows.map((r) => ({
      name: r.name as string, lat: r.lat as number, lon: r.lon as number,
      accuracy: r.accuracy as number | null, ts: r.ts as number, area: (r.area as string | null) ?? null,
    }));
  }

  addMemory(content: string, category: string, author: string): number {
    return this.insertMemory(content, category, author, author === "AI 自動整理" ? "auto" : "user", null);
  }

  private insertMemory(content: string, category: string, author: string, source: "user" | "auto", expires: string | null): number {
    const id = this.sql
      .exec(
        "INSERT INTO memories (ts, category, content, author, status, source, expires, updated) VALUES (?, ?, ?, ?, 'active', ?, ?, ?) RETURNING id",
        Date.now(), category, content.slice(0, 500), author, source, expires, Date.now(),
      )
      .one().id as number;
    this.broadcastState();
    if (this.isPersonal()) this.ctx.waitUntil(this.syncEmbeddings());
    return id;
  }

  /** remember 工具：個人助理不記敏感資料，記憶暫停時也不記 */
  remember(content: string, category: string, author: string, expires?: string) {
    if (this.isPersonal()) {
      if (this.setting("memory_paused") === "1") return { error: "記憶目前暫停中（工具箱 → 記憶 可以恢復），這次沒有記下來" };
      const bad = this.memoryGuard(content);
      if (bad) return { error: bad };
    }
    const exp = expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : null;
    return { saved_id: this.insertMemory(content, category, author, "user", exp), ...(exp ? { expires: exp } : {}) };
  }

  /** 個人助理不記身分證字號、信用卡號、密碼 */
  private memoryGuard(content: string): string | null {
    if (/[A-Z][12]\d{8}/.test(content)) return "內容看起來有身分證字號，為了安全不記下來";
    if (/(?:\d[ -]?){13,19}/.test(content) && /卡|card/i.test(content)) return "內容看起來有信用卡號，為了安全不記下來";
    if (/密碼|password|\bPIN\b/i.test(content)) return "密碼類的資料不要記在這裡，為了安全不記下來";
    return null;
  }

  deleteMemory(id: number): boolean {
    const n = this.sql.exec("DELETE FROM memories WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  searchHistory(keyword: string, limit: number) {
    const words = String(keyword).split(/\s+/).filter(Boolean).slice(0, 4);
    if (!words.length) return [];
    const where = words.map(() => "text LIKE ?").join(" AND ");
    const likes = words.map((w) => `%${w}%`);
    // 翻譯紀錄也一起搜（原文或譯文有關鍵字就算）
    const tWhere = words.map(() => "(source LIKE ? OR result LIKE ?)").join(" AND ");
    const tLikes = likes.flatMap((l) => [l, l]);
    const rows = [
      ...this.sql.exec(`SELECT ts, author, text FROM messages WHERE ${where} AND COALESCE(meta, '') NOT LIKE '%"health%' ORDER BY ts DESC LIMIT ?`, ...likes, limit).toArray(),
      ...this.sql.exec(`SELECT ts, author, '［翻譯］' || source || ' → ' || result AS text FROM translations WHERE ${tWhere} ORDER BY ts DESC LIMIT ?`, ...tLikes, limit).toArray(),
    ];
    return rows
      .sort((a, b) => (b.ts as number) - (a.ts as number))
      .slice(0, limit)
      .map((r) => ({ time: this.localTime(r.ts as number), author: r.author as string, text: String(r.text).slice(0, 400), ts: r.ts as number }));
  }

  updateItinerary(date: string, fields: { title?: string; detail?: string; status?: string }, author: string) {
    const cur = this.sql.exec("SELECT * FROM itinerary WHERE date = ?", date).toArray()[0];
    const next = {
      title: fields.title ?? (cur?.title as string) ?? "",
      detail: fields.detail ?? (cur?.detail as string) ?? "",
      status: fields.status ?? (cur?.status as string) ?? "",
    };
    this.sql.exec(
      "INSERT INTO itinerary VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title, detail = excluded.detail, status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      date, next.title, next.detail, next.status, Date.now(), author,
    );
    this.broadcastState();
    return { date, ...next, updated_by: author };
  }

  addExpense(e: ExpenseInput) {
    const id = this.sql
      .exec(
        "INSERT INTO expenses (ts, date, description, amount, currency, amount_local, amount_twd, payer, split_among, category, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        Date.now(), e.date, e.description, e.amount, e.currency, e.amountLocal, e.amountTwd, e.payer, JSON.stringify(e.splitAmong), e.category, e.author,
      )
      .one().id as number;
    this.broadcastState();
    if (this.isPersonal()) this.ctx.waitUntil(this.checkBudget());
    return { id, ...e };
  }

  deleteExpense(id: number): boolean {
    const n = this.sql.exec("DELETE FROM expenses WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  expenseGet(id: number) {
    const r = this.sql.exec("SELECT * FROM expenses WHERE id = ?", id).toArray()[0];
    return r ? expenseBrief(r) : null;
  }

  expenseFind(keyword: string) {
    return this.sql.exec("SELECT * FROM expenses WHERE description LIKE ? ORDER BY id DESC LIMIT 8", `%${keyword}%`).toArray().map(expenseBrief);
  }

  itineraryDay(date: string) {
    const r = this.sql.exec("SELECT * FROM itinerary WHERE date = ?", date).toArray()[0];
    return r ? { title: (r.title as string) ?? "", detail: (r.detail as string) ?? "", status: (r.status as string) ?? "" } : null;
  }

  /** 查帳目明細：依日期（區間）、品項／店名／分類關鍵字、付款人篩選（AI 回答「前幾天買了什麼、多少錢」用） */
  findExpenses(q: { from?: string; to?: string; keyword?: string; payer?: string }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.from) (where.push("date >= ?"), args.push(q.from));
    if (q.to) (where.push("date <= ?"), args.push(q.to));
    if (q.payer) (where.push("payer LIKE ?"), args.push(`%${q.payer}%`));
    if (q.keyword) (where.push("(description LIKE ? OR category LIKE ?)"), args.push(`%${q.keyword}%`, `%${q.keyword}%`));
    const rows = this.sql.exec(`SELECT * FROM expenses${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY date, ts`, ...args).toArray();
    const sum = (k: string) => Math.round(rows.reduce((n, r) => n + Number(r[k] ?? 0), 0));
    return {
      count: rows.length, total_local: sum("amount_local"), total_twd: sum("amount_twd"),
      items: rows.slice(0, 80).map((r) => ({
        id: r.id, date: r.date, description: r.description, amount: r.amount, currency: r.currency, local: r.amount_local, twd: r.amount_twd,
        payer: r.payer, split_among: JSON.parse((r.split_among as string) || "[]"), category: r.category,
      })),
      ...(rows.length > 80 ? { note: `共 ${rows.length} 筆，只列前 80 筆；請縮小日期或關鍵字` } : {}),
      ...(rows.length ? {} : { note: "沒有符合的帳目：照實說，可以換個關鍵字（記帳時可能用別的寫法）或放寬日期再查" }),
    };
  }

  expenseSummary() {
    const rows = this.sql.exec("SELECT * FROM expenses ORDER BY ts").toArray();
    const paid: Record<string, number> = {};
    const owe: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let total = 0, totalTwd = 0;
    for (const r of rows) {
      const v = r.amount_local as number;
      total += v;
      totalTwd += r.amount_twd as number;
      paid[r.payer as string] = (paid[r.payer as string] ?? 0) + v;
      const split = JSON.parse((r.split_among as string) || "[]") as string[];
      const share = split.length ? v / split.length : 0;
      for (const x of split) owe[x] = (owe[x] ?? 0) + share;
      byCategory[r.category as string] = (byCategory[r.category as string] ?? 0) + v;
      byDay[r.date as string] = (byDay[r.date as string] ?? 0) + v;
    }
    const people = [...new Set([...Object.keys(paid), ...Object.keys(owe)])];
    const round = (n: number) => Math.round(n * 100) / 100;
    const balance = people.map((x) => ({ name: x, paid: round(paid[x] ?? 0), share: round(owe[x] ?? 0), net: round((paid[x] ?? 0) - (owe[x] ?? 0)) }));
    // 最少轉帳次數的結算建議
    const creditors = balance.filter((b) => b.net > 0).map((b) => ({ ...b })).sort((a, b) => b.net - a.net);
    const debtors = balance.filter((b) => b.net < 0).map((b) => ({ ...b, net: -b.net })).sort((a, b) => b.net - a.net);
    const transfers: { from: string; to: string; amount: number }[] = [];
    for (const d of debtors) {
      for (const c of creditors) {
        if (d.net <= 0) break;
        if (c.net <= 0) continue;
        const x = Math.min(d.net, c.net);
        if (x >= 0.01) transfers.push({ from: d.name, to: c.name, amount: round(x) });
        d.net -= x;
        c.net -= x;
      }
    }
    return {
      currency: this.profile()?.currency ?? "",
      total: round(total),
      total_twd: Math.round(totalTwd),
      count: rows.length,
      balance,
      transfers,
      by_category: byCategory,
      by_day: byDay,
      items: rows.slice(-40).map((r) => ({
        id: r.id, date: r.date, description: r.description, amount: r.amount, currency: r.currency,
        local: r.amount_local, twd: r.amount_twd, payer: r.payer, split_among: JSON.parse((r.split_among as string) || "[]"), category: r.category,
      })),
    };
  }

  cacheGet(key: string, maxAgeMs: number): string | null {
    const row = this.sql.exec("SELECT value, ts FROM cache WHERE key = ?", key).toArray()[0];
    return row && Date.now() - (row.ts as number) < maxAgeMs ? (row.value as string) : null;
  }

  cacheSet(key: string, value: string) {
    this.sql.exec("INSERT INTO cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts", key, value, Date.now());
  }

  // ---- 清單 ----

  checklistAdd(list: string, items: string[], forWhom: string, author: string) {
    const added = items.map((item) =>
      this.sql.exec("INSERT INTO checklist (list, item, for_whom, author, ts) VALUES (?, ?, ?, ?, ?) RETURNING id, list, item, for_whom", list, item.slice(0, 200), forWhom.slice(0, 20), author, Date.now()).one(),
    );
    this.broadcastState();
    return { added };
  }

  checklistUpdate(match: { id?: number; keyword?: string; list?: string }, patch: { done?: boolean; remove?: boolean }, by: string) {
    let rows: Record<string, SqlStorageValue>[] = [];
    if (match.id) rows = this.sql.exec("SELECT * FROM checklist WHERE id = ?", match.id).toArray();
    else if (match.keyword) {
      rows = match.list
        ? this.sql.exec("SELECT * FROM checklist WHERE list = ? AND item LIKE ?", match.list, `%${match.keyword}%`).toArray()
        : this.sql.exec("SELECT * FROM checklist WHERE item LIKE ?", `%${match.keyword}%`).toArray();
    }
    if (!rows.length) return { error: "清單裡找不到這個項目" };
    if (rows.length > 3 && !match.id) return { error: "符合的項目太多，請說得更具體", matches: rows.map((r) => ({ id: r.id, item: r.item })) };
    for (const r of rows) {
      if (patch.remove) this.sql.exec("DELETE FROM checklist WHERE id = ?", r.id);
      else if (typeof patch.done === "boolean") this.sql.exec("UPDATE checklist SET done = ?, done_by = ? WHERE id = ?", patch.done ? 1 : 0, patch.done ? by : null, r.id);
    }
    this.broadcastState();
    return { updated: rows.map((r) => ({ id: r.id, item: r.item, list: r.list })), action: patch.remove ? "刪除" : patch.done ? "打勾" : "取消勾選" };
  }

  checklistGet(list?: string) {
    const rows = list
      ? this.sql.exec("SELECT * FROM checklist WHERE list = ? ORDER BY done, id", list).toArray()
      : this.sql.exec("SELECT * FROM checklist ORDER BY list, done, id").toArray();
    return rows.map((r) => ({ id: r.id, list: r.list, item: r.item, for: r.for_whom || undefined, done: !!r.done, done_by: r.done_by || undefined }));
  }

  // ---- 提醒 ----

  reminderAdd(due: number, message: string, author: string) {
    const row = this.sql.exec("INSERT INTO reminders (due, message, author, created) VALUES (?, ?, ?, ?) RETURNING id, due, message", due, message, author, Date.now()).one();
    this.broadcastState();
    this.ctx.waitUntil(this.scheduleNext());
    return { ...row, time: `${this.localTime(due)}（當地時間）` };
  }

  reminderList() {
    return this.sql
      .exec("SELECT * FROM reminders WHERE sent = 0 ORDER BY due")
      .toArray()
      .map((r) => ({ id: r.id, time: this.localTime(r.due as number), message: r.message, by: r.author }));
  }

  reminderDelete(id: number): boolean {
    const n = this.sql.exec("DELETE FROM reminders WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  reminderGet(id: number) {
    const r = this.sql.exec("SELECT * FROM reminders WHERE id = ? AND sent = 0", id).toArray()[0];
    return r ? { id, time: this.localTime(r.due as number), message: r.message as string } : null;
  }

  // ---- 票券保管箱 ----

  documentSave(title: string, note: string, photoId: string, author: string, folder: number | null = null) {
    const row = this.sql
      .exec("INSERT INTO documents (ts, author, title, note, photo_id, folder_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, title", Date.now(), author, title, note, photoId, folder)
      .one();
    this.broadcastState();
    const where = folder == null ? "" : `的「${this.folderPaths().get(folder) ?? ""}」資料夾`;
    return { saved: row, note: `已存進 下方「工具箱」→ 票券保管箱${where}，打開過一次之後沒網路也看得到` };
  }

  /** 關鍵字比對票券名稱、備註和所在資料夾（例如「機票」可以找出機票資料夾裡的全部） */
  documentFind(keyword?: string) {
    const words = String(keyword ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);
    const paths = this.folderPaths();
    const rows = (this.sql.exec("SELECT * FROM documents ORDER BY ts DESC").toArray() as unknown as Omit<DocRow, "folder">[]).map((d) => ({
      ...d,
      folder: d.folder_id == null ? "" : paths.get(Number(d.folder_id)) ?? "",
    }));
    return words.length ? rows.filter((d) => words.every((w) => `${d.title} ${d.note} ${d.folder}`.toLowerCase().includes(w))) : rows;
  }

  /** AI 存票券時指定的資料夾：用名稱找（哪一層都可以），找不到就在最外層建一個 */
  documentFolder(name: string, author: string): number | null {
    const n = name.trim().slice(0, 40);
    if (!n) return null;
    const hit = this.sql.exec("SELECT id FROM doc_folders WHERE name = ? ORDER BY parent_id IS NOT NULL, id LIMIT 1", n).toArray()[0];
    if (hit) return Number(hit.id);
    const id = Number(this.sql.exec("INSERT INTO doc_folders (name, parent_id, ts, author) VALUES (?, NULL, ?, ?) RETURNING id", n, Date.now(), author).one().id);
    this.broadcastState();
    return id;
  }

  /** 前端傳來的資料夾：沒指定或不存在＝最外層（null） */
  private folderId(v: unknown): number | null {
    const id = Number(v);
    if (v == null || v === "" || !Number.isInteger(id)) return null;
    return this.sql.exec("SELECT 1 FROM doc_folders WHERE id = ?", id).toArray().length ? id : null;
  }

  /** 從這個資料夾一路往上到最外層（含自己），用來擋「把資料夾搬進自己裡面」 */
  private folderLineage(id: number): number[] {
    const out: number[] = [];
    let cur: number | null = id;
    while (cur != null && !out.includes(cur)) {
      out.push(cur);
      const up: unknown = this.sql.exec("SELECT parent_id FROM doc_folders WHERE id = ?", cur).toArray()[0]?.parent_id;
      cur = up == null ? null : Number(up);
    }
    return out;
  }

  /** 每個資料夾的完整路徑，例如「機票／回程」 */
  private folderPaths(): Map<number, string> {
    const rows = this.sql.exec("SELECT id, name, parent_id FROM doc_folders").toArray();
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const path = (id: number, seen: Set<number>): string => {
      const r = byId.get(id);
      if (!r || seen.has(id)) return "";
      seen.add(id);
      const up = r.parent_id == null ? "" : path(Number(r.parent_id), seen);
      return up ? `${up}／${r.name}` : String(r.name);
    };
    return new Map(rows.map((r) => [Number(r.id), path(Number(r.id), new Set())]));
  }

  // ================= 排程：初始化、提醒、每日早報、旅遊日記、災害警報 =================

  /** 下一次醒來：最近的提醒時間，最晚 5 分鐘後（檢查早報、日記、警報） */
  private async scheduleNext() {
    if (!this.profile()) return;
    const remind = this.sql.exec("SELECT MIN(due) AS due FROM reminders WHERE sent = 0").one().due as number | null;
    const next = Math.min(remind ?? Infinity, this.isPersonal() ? Math.min(this.nextEventReminder() ?? Infinity, this.nextMemoWork() ?? Infinity, this.nextFileWork() ?? Infinity) : Infinity);
    const at = Math.max(Date.now() + 5_000, Math.min(next, Date.now() + 5 * 60_000));
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const p = this.profile();
    if (!p) return;
    try {
      if (p.status === "initializing") {
        await this.runInit();
        return;
      }
      if (p.status !== "active") return;
      await this.deliverReminders();
      // 個人助理：每天整理一次記憶（過期的失效）、依設定的時間發早報；旅遊日記、災害警報是旅遊專用
      if (p.kind === "personal") {
        const now = zoned(Date.now(), p.timezone);
        this.dailyMaintenance(now.date);
        await this.deliverEventReminders();
        await this.maybeDream(now);
        await this.processMemos();
        await this.processFiles();
        await this.healthTick();
        await this.checkIdExpiry(now.date);
        await this.maybePersonalDiary(now);
        await this.syncEmbeddings();
        const hour = Number(this.setting("brief_hour", "7"));
        if (this.settings().autoBrief && now.hour >= hour && now.hour < hour + 3 && this.setting("brief_sent") !== now.date) await this.postPersonalBrief(now.date);
        return;
      }
      const now = zoned(Date.now(), p.timezone);
      const inTrip = now.date >= p.startDate && now.date <= p.endDate;
      const s = this.settings();
      if (inTrip && s.autoBrief && now.hour >= 7 && now.hour < 11 && this.setting("brief_sent") !== now.date) await this.postMorningBrief(now.date);
      if (inTrip && s.autoDiary && now.hour >= 22 && this.setting("diary_sent") !== now.date) await this.writeDiary(now.date);
      // 警報從出發前一天開始
      const alertStart = new Date(Date.parse(p.startDate + "T00:00:00Z") - 86400_000).toISOString().slice(0, 10);
      if (s.autoAlerts && now.date >= alertStart && now.date <= p.endDate) await this.pollAlerts(now.date);
    } catch (e) {
      console.error("alarm failed", e);
      // 初始化中途出錯：直接進確認頁，讓管理員手動補資料
      const cur = this.profile();
      if (cur?.status === "initializing") {
        cur.status = "review";
        cur.initNotes.push("自動初始化中途出錯，請檢查下面的資料，或按「重新查詢」");
        this.saveProfile(cur);
        this.helloAll();
      }
    } finally {
      await this.scheduleNext();
    }
  }

  /** 以 AI 身分在群組發一則訊息（提醒、早報、日記、警報共用） */
  private postAiMessage(text: string, meta: Record<string, unknown>) {
    const row = this.insertMessage({ author: AI_NAME, role: "assistant", text: fixMapLinks(text, this.mapFix()), photo_id: null, lat: null, lon: null, meta: JSON.stringify(meta) });
    this.broadcast({ type: "message", message: this.publicMessage(row) });
    return row;
  }

  private async deliverReminders() {
    const due = this.sql.exec("SELECT * FROM reminders WHERE sent = 0 AND due <= ? ORDER BY due", Date.now() + 30_000).toArray();
    for (const r of due) {
      this.sql.exec("UPDATE reminders SET sent = 1 WHERE id = ?", r.id);
      this.postAiMessage(`⏰ **提醒**：${r.message}\n\n（${r.author} 設定的提醒）`, { kind: "reminder" });
      if (this.isPersonal()) this.ctx.waitUntil(this.pushAll({ title: "⏰ 提醒", body: String(r.message), tag: `reminder-${r.id}` }));
    }
    if (due.length) this.broadcastState();
  }

  async postMorningBrief(date: string) {
    const p = this.p();
    this.setSetting("brief_sent", date);
    const today = this.itinerary().find((d) => d.date === date);
    const ctx = await this.toolCtx(AI_NAME);
    // 今天行程的景點有沒有休館、展覽結束、活動：先上網查，早報才不會照記憶推薦已經沒有的東西
    const newsQuery = today ? `${today.title} ${today.detail} 最新消息 營業 休館 展覽 活動`.slice(0, 200) : "";
    const [weather, alerts, news] = await Promise.all([
      runTool("get_weather", { days: 2 }, ctx),
      disasterAlerts(p).catch(() => ({})),
      newsQuery ? runTool("web_search", { query: newsQuery, max_results: 5 }, ctx) : Promise.resolve(null),
    ]);
    const reminders = this.reminderList().filter((r) => String(r.time).startsWith(date));
    const todos = this.checklistGet("待辦").filter((c) => !c.done);
    const prompt = `請幫家庭旅遊群組寫今天（${date}）的「☀️ 早安早報」內文（標題系統會加，你不要再寫標題），繁體中文、親切、適合手機閱讀、300 字內，條列重點：
1. 今天的行程與建議出門時間（考慮 ${travelersText(p.travelers)}）
2. 天氣與穿著、要不要帶傘
3. 今天的提醒與待辦
4. 如果有地震、颱風或強風豪雨，放在最前面提醒
5. 「網路查到的最新消息」如果顯示行程裡的店家、景點、展覽已經結束、休館或改期，放在行程前面提醒並建議替代；網路沒查到的不要自己補，也不要推薦行程以外沒查證過的店
資料：
- 今天行程：${today ? `${today.title}｜${today.detail}｜${today.status}` : "沒有排行程"}
- 天氣：${JSON.stringify(weather).slice(0, 1500)}
- 警報：${JSON.stringify(alerts).slice(0, 1500)}
- 今天的提醒：${JSON.stringify(reminders)}
- 未完成待辦：${JSON.stringify(todos.slice(0, 8))}
- 網路查到的最新消息：${news ? JSON.stringify(news).slice(0, 2500) : "（今天沒有行程，沒查）"}
- 住宿：${p.accommodation.name || p.accommodation.address}${p.accommodation.note ? `，${p.accommodation.note}` : ""}`;
    const text = await this.generateText(this.systemPrompt(), prompt, false, 1);
    this.postAiMessage(`☀️ **早安！${date.slice(5).replace("-", "/")} 早報**\n\n${text}`, { kind: "brief" });
  }

  /** 工具請 AI 判斷一件事（例如影片是不是在講這個地點）：JSON 模式，照模型順序試，都不能用回 null */
  async aiJson(prompt: string): Promise<any | null> {
    for (const id of await this.chain(false)) {
      try {
        const r = await (await this.provider(id, 1, 10_000)).generate({
          system: "你只輸出 JSON。",
          turns: [{ role: "user", parts: [{ text: prompt }] }],
          json: true,
          timeoutMs: 20_000,
        });
        return parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
      } catch (e) {
        if (!(e instanceof RateLimitedError)) console.error(`aiJson via ${id} failed`, e);
      }
    }
    return null;
  }

  /** 只根據路線圖回答怎麼搭（check_route_map 用）；密密麻麻的路線圖只有 Gemini 看得清楚，不能用就回 null */
  async readRouteMap(image: { bytes: ArrayBuffer; mime: string }, origin: string, destination: string, city: string, proposal = "") {
    for (const id of (await this.chain(true)).filter((x) => x !== "workers-ai")) {
      try {
        const r = await (await this.provider(id, 1, 20_000)).generate({
          system: "你只根據使用者給的路線圖回答，看不到的不要用記憶補，只輸出 JSON。",
          turns: [{ role: "user", parts: [{ image: { mime: image.mime, data: toBase64(image.bytes) } }, { text: routeMapPrompt(city, origin, destination, proposal) }] }],
          json: true,
          timeoutMs: 60_000,
        });
        return cleanRouteMap(parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()), origin, destination);
      } catch (e) {
        if (!(e instanceof RateLimitedError)) console.error(`readRouteMap via ${id} failed`, e);
      }
    }
    return null;
  }

  /**
   * 翻大家傳到聊天室的照片（存成票券、證件的不算）：照日期、誰傳的、內容找。
   * 內容靠日記用的照片說明（photo_notes）；還沒看過的先請 AI 看，一次最多 30 張
   */
  async chatPhotos(q: { date?: unknown; dateTo?: unknown; sender?: unknown; keyword?: unknown; ids?: string[]; count?: unknown }) {
    const day = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
    const from = day(q.date), to = day(q.dateTo) ?? from;
    const where = ["photo_id IS NOT NULL", "role = 'user'"];
    const args: number[] = [];
    if (from) {
      where.push("ts >= ?");
      args.push((localToUtc(from, "00:00", this.p().timezone) ?? Date.parse(from + "T00:00:00Z")));
    }
    if (to) {
      where.push("ts < ?");
      args.push((localToUtc(to, "00:00", this.p().timezone) ?? Date.parse(to + "T00:00:00Z")) + 86400_000);
    }
    const docs = new Set(this.sql.exec("SELECT photo_id FROM documents WHERE photo_id IS NOT NULL").toArray().map((r) => r.photo_id as string));
    let rows = photoRows(this.sql.exec<MessageRow>(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY ts`, ...args).toArray()).filter((m) => !docs.has(m.photo_id as string));
    const sender = String(q.sender ?? "").trim();
    if (sender) rows = rows.filter((m) => m.author.includes(sender) || sender.includes(m.author));
    // 說明一次全部讀出來（IN 清單有參數個數上限），沒看過的再請 AI 看
    const notes = new Map<string, PhotoNote>(
      this.sql.exec("SELECT * FROM photo_notes WHERE v = ?", PHOTO_NOTE_V).toArray().map((r) => [String(r.photo_id), { kind: String(r.kind), score: Number(r.score), note: String(r.note) }]),
    );
    const missing = rows.filter((m) => !notes.has(m.photo_id as string)).slice(-30);
    if (missing.length) for (const [k, v] of await this.describePhotos(missing, this.isPersonal())) notes.set(k, v);
    const item = (m: MessageRow) => {
      const n = notes.get(m.photo_id as string);
      return { id: m.photo_id as string, when: `${Number(zoned(m.ts, this.p().timezone).date.slice(5, 7))}/${Number(zoned(m.ts, this.p().timezone).date.slice(8, 10))} ${zoned(m.ts, this.p().timezone).time}`, by: m.author, kind: n?.kind ?? "", note: n?.note ?? (m.text ? `附言：${m.text.slice(0, 60)}` : "（還沒看過）"), score: n?.score ?? 3, ts: m.ts };
    };
    const keyword = String(q.keyword ?? "").trim();
    // 收據、截圖、文件預設不列（問「收據的照片」「菜單」才列）
    const info = /收據|發票|截圖|文件|菜單|票/.test(keyword);
    const all = rows.map(item);
    const items = all.filter((x) => info || !NOT_DIARY_PHOTO.has(x.kind));
    const count = Math.min(8, Math.max(1, Number(q.count) || 6));
    let picked: typeof items;
    if (q.ids?.length) picked = all.filter((x) => q.ids!.includes(x.id)).slice(0, 8);
    else if (keyword) {
      picked = items
        .map((x) => ({ x, s: photoMatch(keyword, `${x.kind} ${x.note}`) }))
        .filter((h) => h.s > 0)
        .sort((a, b) => b.s - a.s || b.x.score - a.x.score)
        .slice(0, count)
        .map((h) => h.x);
    } else picked = [...items].sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, count);
    picked.sort((a, b) => a.ts - b.ts);
    // 給模型挑的清單：照片太多就留精彩度高的 30 張
    const catalog = (items.length > 30 ? [...items].sort((a, b) => b.score - a.score).slice(0, 30).sort((a, b) => a.ts - b.ts) : items)
      .filter((x) => !picked.includes(x))
      .map(({ id, when, by, kind, note }) => ({ id, when, by, kind, note }));
    return { total: rows.length, shown: picked.map(({ id, when, by, kind, note }) => ({ id, when, by, kind, note })), catalog };
  }

  /**
   * 日記挑照片前先看過每張照片：拍了什麼、適不適合放進日記（收據、截圖、證件不放）。
   * 看過的存進 photo_notes，重寫日記不用再看；一次送 5 張，照片多也不會太慢
   */
  private async describePhotos(rows: MessageRow[], personal = false): Promise<Map<string, PhotoNote>> {
    const notes = new Map<string, PhotoNote>();
    const ids = rows.map((m) => m.photo_id as string);
    if (!ids.length) return notes;
    for (const r of this.sql.exec(`SELECT * FROM photo_notes WHERE v = ? AND photo_id IN (${ids.map(() => "?").join(",")})`, PHOTO_NOTE_V, ...ids).toArray()) {
      notes.set(r.photo_id as string, { kind: String(r.kind), score: Number(r.score), note: String(r.note) });
    }
    const todo = rows.filter((m) => !notes.has(m.photo_id as string));
    const order = await this.chain(true);
    for (let i = 0; i < todo.length; i += 5) {
      const batch = todo.slice(i, i + 5).flatMap((m) => {
        const p = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", m.photo_id).toArray()[0];
        return p ? [{ m, image: { mime: p.mime as string, data: toBase64(p.data as ArrayBuffer) } }] : [];
      });
      if (!batch.length) continue;
      const parts: Part[] = [
        {
          text: `${personal ? "以下是個人助理收到的" : "以下是家庭旅遊群組今天的"} ${batch.length} 張照片，依序編號。請逐張判斷，只輸出 JSON 陣列：[{"n":1,"kind":"…","score":3,"note":"…"}]
kind 只能是：${(personal ? PHOTO_KINDS.filter((k) => k !== "旅途外") : PHOTO_KINDS).join("、")}（收據＝收據、發票、帳單；截圖＝手機或網頁畫面截圖；文件＝票券、證件、表單等文字資料${personal ? "" : "；旅途外＝不是這趟旅行拍的，例如家裡的寵物、家裡、舊照片"}）
note：繁體中文 20–60 字，具體寫出看到什麼：地點或招牌、食物或商品名稱、人（大人或小孩）在做什麼、表情動作；看不出來的照實寫，不要猜人名
score：當${personal ? "生活" : "旅遊"}日記插圖的價值，大部分照片是 2–4 分：
5＝一看就有故事（家人生動的表情或互動、壯觀的景色、招牌美食上桌）
4＝${personal ? "好看的生活紀錄（出遊、街景、店面、美食、家人朋友合照）" : "好看的旅途紀錄（景點、街景、店面、美食、家人合照）"}
3＝普通的紀錄
2＝資訊類照片（菜單、時刻表、告示牌、販賣機、垃圾桶、商品包裝特寫），或沒有重點的日常照（低頭滑手機、排隊等待、只拍到背影）
1＝沒意義（模糊、隨手亂拍、看不出內容）`,
        },
      ];
      batch.forEach(({ m, image }, k) => {
        parts.push({ text: `照片 ${k + 1}（${this.hhmm(m.ts)} ${m.author} 傳${m.text ? `，附言：「${m.text.slice(0, 80)}」` : ""}）` });
        parts.push({ image });
      });
      let parsed: any[] | null = null;
      for (const pid of order) {
        try {
          const r = await (await this.provider(pid, 1, 20_000)).generate({
            system: personal ? "你是幫生活日記挑照片的編輯，只輸出 JSON。" : "你是幫家庭旅遊日記挑照片的編輯，只輸出 JSON。",
            turns: [{ role: "user", parts }],
            json: true,
          });
          parsed = parseJsonArray(r.text);
          if (parsed) break;
        } catch (e) {
          this.noteQuota(e);
          if (!(e instanceof RateLimitedError)) console.error(`describePhotos via ${pid} failed`, e);
        }
      }
      for (const x of parsed ?? []) {
        const hit = batch[Number(x?.n) - 1];
        if (!hit) continue;
        const note: PhotoNote = {
          kind: PHOTO_KINDS.includes(x.kind) ? x.kind : "其他",
          score: Math.min(5, Math.max(1, Math.round(Number(x.score) || 3))),
          note: String(x.note ?? "").slice(0, 120),
        };
        notes.set(hit.m.photo_id as string, note);
        this.sql.exec(
          "INSERT OR REPLACE INTO photo_notes (photo_id, kind, score, note, ts, v) VALUES (?, ?, ?, ?, ?, ?)",
          hit.m.photo_id, note.kind, note.score, note.note, Date.now(), PHOTO_NOTE_V,
        );
      }
    }
    return notes;
  }

  /** 日記：長文又要照格式，先用比較會寫的模型（一天一篇，額度跟聊天分開；擁有者金鑰→旅程自己的金鑰），不行再用一般的模型鏈 */
  private async generateLong(system: string, prompt: string): Promise<string> {
    const writer = this.env.GEMINI_WRITER_MODEL;
    const own = (await this.keys()).gemini ?? "";
    // 個人助理只用自己的金鑰（index 1 = gemini-own）
    const keys = this.isPersonal() ? ["", own] : [this.env.GEMINI_API_KEY ?? "", own];
    for (const [i, key] of keys.entries()) {
      if (!key) continue;
      if (!writer) break;
      try {
        const r = await geminiProvider(this.env, i ? "gemini-own" : "gemini", key, undefined, writer).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }], timeoutMs: 150_000 });
        if (r.text.trim()) return r.text.trim();
      } catch (e) {
        console.error(`diary via ${writer} failed`, e);
      }
    }
    return this.generateText(system, prompt, false, 1, 4096);
  }

  /** 旅遊地時間 HH:mm（日記素材用） */
  private hhmm(ts: number): string {
    return zoned(ts, this.p().timezone).time;
  }

  /** announce＝在群組貼出來（每晚自動寫）；管理員重寫舊日記時不貼 */
  async writeDiary(date: string, announce = true) {
    const p = this.p();
    if (announce) this.setSetting("diary_sent", date);
    const start = localToUtc(date, "00:00", p.timezone) ?? Date.parse(date + "T00:00:00Z");
    const msgs = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY ts", start, start + 86400_000).toArray();
    // 證件、票券照片絕對不能進日記（日記可以分享給親友）
    const docs = new Set(this.sql.exec("SELECT photo_id FROM documents WHERE photo_id IS NOT NULL").toArray().map((r) => r.photo_id as string));
    const photoMsgs = photoRows(msgs.filter((m) => m.photo_id && m.role === "user")).filter((m) => !docs.has(m.photo_id as string)).slice(-40);
    const notes = await this.describePhotos(photoMsgs);
    const score = (m: MessageRow) => notes.get(m.photo_id as string)?.score ?? 3;
    // 可以放進日記的照片依時間編號 P1、P2…；太多就留精彩度高的
    let pool = photoMsgs.filter((m) => {
      const n = notes.get(m.photo_id as string);
      return !n || (!NOT_DIARY_PHOTO.has(n.kind) && n.score >= 3);
    });
    if (pool.length > 30) {
      const keep = new Set([...pool].sort((a, b) => score(b) - score(a)).slice(0, 30));
      pool = pool.filter((m) => keep.has(m));
    }
    const tag = new Map(pool.map((m, i) => [m.photo_id as string, `P${i + 1}`]));
    const catalog = pool
      .map((m) => {
        const n = notes.get(m.photo_id as string);
        return `[${tag.get(m.photo_id as string)}] ${this.hhmm(m.ts)} ${m.author} 傳｜${n ? `${n.kind}｜精彩度 ${n.score}｜${n.note}` : "（沒有說明）"}${m.text ? `｜附言：「${m.text.slice(0, 60)}」` : ""}`;
      })
      .join("\n");
    // 出發前預付的機票、住宿、門票（台幣大額）也可能記在出發日，不能當成當天花費；只拿當天買的東西當寫作素材
    const bought = this.sql
      .exec("SELECT ts, description, category FROM expenses WHERE date = ? AND currency != 'TWD' AND amount_twd < 6000 ORDER BY ts", date)
      .toArray()
      .slice(0, 30)
      .map((r) => `${this.hhmm(Number(r.ts))} ${r.description}${r.category ? `（${r.category}）` : ""}`);
    const today = this.itinerary().find((d) => d.date === date);
    // 整天的對話都要看到（不是只看最後一段）；太長先拿掉 AI 的回答，再不夠才截頭尾
    const lines = (withAi: boolean) =>
      msgs
        .filter((m) => m.role === "user" || (withAi && m.role === "assistant" && !(m.meta && JSON.parse(m.meta).kind)))
        .map((m) => {
          if (m.role === "assistant") {
            const t = m.text.replace(/\s+/g, " ");
            return `${this.hhmm(m.ts)} ${AI_NAME}：${t.slice(0, 120)}${t.length > 120 ? "…" : ""}`;
          }
          const tags = photosOf(m).filter((x) => tag.has(x)).map((x) => tag.get(x));
          const pic = m.photo_id ? (tags.length ? `（傳了照片 ${tags.join("、")}）` : "（傳了照片）") : "";
          return `${this.hhmm(m.ts)} ${m.author}：${m.text.slice(0, 300)}${pic}`;
        })
        .join("\n");
    let transcript = lines(true);
    if (transcript.length > 14000) transcript = lines(false);
    if (transcript.length > 14000) transcript = `${transcript.slice(0, 7000)}\n…（中間省略）…\n${transcript.slice(-7000)}`;
    const plan = today?.title ? `${today.title}${today.detail ? `（${String(today.detail).slice(0, 300)}）` : ""}` : "自由活動";
    const prompt = `請根據下面的資料，幫這個台灣家庭（${travelersText(p.travelers)}，在${p.country}${p.city}旅行）寫 ${date} 的旅遊日記，繁體中文，像家人一起回憶這一天，溫馨、生動、有畫面。

【寫法】
- 第一行寫「標題：」加上標題（8–16 字，生動有畫面，不加引號），空一行後寫內文。
- 先從對話、記帳和照片整理出今天的時間軸（幾點在哪裡、做了什麼），再依時間順序寫成完整的一天：出門、交通、去了哪些地方、吃了什麼、買了什麼、路上發生的事、晚上回到住處。每段寫一個時段或場景，段落之間空一行。
- 挑出當天最精彩有趣的片段多寫一點：小朋友的趣事、家人說的有趣的話（可以直接引用原話）、意外的小插曲、驚喜或感動的時刻。寫出具體的店名、景點、食物和商品名稱，不要寫「吃了美食」「逛了街」這種空泛的句子；每個場景寫出當時的氣氛、心情和小朋友的反應。
- 寫成當下發生的事，不要寫「傳了照片」「在群組問」「拍下了」這類描述，也不要描述照片的構圖或表情細節（例如「直視鏡頭」）。照片只是插圖，不要為了用照片硬寫內容。
- 最後一段做個溫暖的小結，可以帶到對明天的期待。
- 長短跟著資料走：對話和照片多的日子寫 6–9 段、每段 150–220 字、全文 900–1500 字；資料少就寫短一點，不要用想像的畫面或情節湊字數。絕對不要編造資料裡沒有的地點、事件或對話。
- 旅伴（AI）的回答只是建議或解答，不代表家人真的去了，要以家人說的話、照片和記帳為準。不要寫花了多少錢，不要提到 AI、手機或群組。
- 家人的稱呼照對話裡的用法，不要自己取名字。照片清單不會寫照片裡是誰：傳照片的人通常是拍照的人，不一定在照片裡。內文和照片說明提到照片裡的人，只有附言或對話說清楚是誰才寫名字，不然寫「孩子們」「小傢伙」「大家」，不要猜。

【照片】
- 從照片清單挑 5–10 張最精彩、而且跟內文對得上的照片（照片少就挑好的就好），優先用精彩度 4–5 分的。放在寫到那個場景的段落後面，另起一行寫成 [P編號｜照片說明]，例如：
[P3｜終於買到心心念念的鋼彈！]
- 照片說明 6–18 字，像相簿裡溫馨或俏皮的小標，不要照抄照片清單的描述，但內容要跟照片相符。
- 每段最多放 2 張；每張照片最多用一次；很像的照片只挑最好的一張；跟段落內容對不上的不要放。

日期：${date}
原本的行程：${plan}（只是計畫，實際去了哪裡以對話和照片為準）
今天記帳的品項（記帳時間）：${bought.join("、") || "（沒有記帳）"}
照片清單：
${catalog || "（今天沒有照片）"}
群組對話：
${transcript || "（今天群組沒什麼對話）"}`;
    const raw = await this.generateLong("你是幫家庭寫旅遊日記的溫暖作家，文筆生動細膩，只根據提供的資料寫。", prompt);
    // 模型沒寫標題（第一行就是內文）：標題用當天行程
    const { title, text, photos, layout } = this.diaryLayout(raw, pool, tag, notes, today?.title ? String(today.title) : "旅途中的一天");
    this.sql.exec(
      "INSERT INTO diaries (date, ts, title, text, photo_ids, layout) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET ts = excluded.ts, title = excluded.title, text = excluded.text, photo_ids = excluded.photo_ids, layout = excluded.layout, edited_by = NULL, edited_at = NULL",
      date, Date.now(), title, text, JSON.stringify(photos), layout.length ? JSON.stringify(layout) : null,
    );
    if (announce) {
      const caption = new Map(layout.map((l) => [l.id, l.caption]));
      const images: AttachedImage[] = photos.slice(0, 8).map((id) => ({ src: `/api/photo/${id}`, caption: caption.get(id) ?? "", source: "今天的照片" }));
      this.postAiMessage(
        `📔 **${date.slice(5).replace("-", "/")} 旅遊日記｜${title}**\n\n${text}\n\n（下方「工具箱」→ 旅遊日記：看圖文版、下載 PDF 或分享給親友）`,
        { kind: "diary", images },
      );
    }
    this.broadcastState();
  }

  /** 日記照片排版：照 AI 標的 [P編號｜說明] 放照片，每段最多 2 張、整篇最多 10 張；沒標就挑精彩度高的穿插 */
  private diaryLayout(raw: string, pool: MessageRow[], tag: Map<string, string>, notes: Map<string, PhotoNote>, fallbackTitle: string) {
    const score = (m: MessageRow) => notes.get(m.photo_id as string)?.score ?? 3;
    const { paragraphs, marks, ...parsed } = parseDiary(raw);
    const title = parsed.title && parsed.title.length <= 30 ? parsed.title : fallbackTitle;
    const text = paragraphs.join("\n\n");
    const byTag = new Map(pool.map((m) => [tag.get(m.photo_id as string)!, m.photo_id as string]));
    const used = new Set<string>();
    const picked: DiaryPhoto[] = marks.flatMap((k) => {
      const id = byTag.get(k.tag);
      if (!id || used.has(id)) return [];
      used.add(id);
      return [{ id, para: k.para, caption: k.caption }];
    });
    // 模型常常一段塞好多張：每段最多 2 張、整篇最多 10 張，超過的留精彩度高的
    const noteScore = (id: string) => notes.get(id)?.score ?? 3;
    const keep = new Set<string>();
    const perPara = new Map<number, number>();
    for (const l of [...picked].sort((a, b) => noteScore(b.id) - noteScore(a.id))) {
      if (keep.size >= 10 || (perPara.get(l.para) ?? 0) >= 2) continue;
      keep.add(l.id);
      perPara.set(l.para, (perPara.get(l.para) ?? 0) + 1);
    }
    const layout = picked.filter((l) => keep.has(l.id));
    // 模型沒放照片標記：挑精彩度高的照片，照舊版排法穿插
    const photos = layout.length
      ? layout.map((l) => l.id)
      : [...pool].sort((a, b) => score(b) - score(a)).slice(0, 8).sort((a, b) => a.ts - b.ts).map((m) => m.photo_id as string);
    return { title, text, photos, layout };
  }

  /** 附近的大地震、影響這個國家的颱風／洪水／火山、隔天強風豪雨：有新狀況才在群組發通知 */
  private async pollAlerts(date: string) {
    const p = this.p();
    const a: any = await disasterAlerts(p);
    const seen: string[] = JSON.parse(this.setting("alerts_seen", "[]"));
    const first = !this.setting("alerts_initialized");
    const notes: string[] = [];
    for (const q of Array.isArray(a.earthquakes) ? a.earthquakes : []) {
      const key = `eq:${q.id}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      const big = (q.magnitude >= 5 && q.distance_km <= 300) || (q.magnitude >= 6 && q.distance_km <= 800) || (q.tsunami_flag && q.distance_km <= 1000);
      if (!first && big) notes.push(`🌏 **地震**：${q.place}，規模 ${q.magnitude}，距離住宿約 ${q.distance_km} 公里${q.tsunami_flag ? "，⚠️ 可能有海嘯，請遠離海岸" : ""}`);
    }
    for (const d of Array.isArray(a.disasters) ? a.disasters : []) {
      const key = `gd:${d.id}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      const serious = (d.affects_country && (d.alert === "Orange" || d.alert === "Red")) || (d.type === "TC" && d.current && d.distance_km != null && d.distance_km < 1000);
      const kind: Record<string, string> = { TC: "🌀 颱風／熱帶氣旋", FL: "🌊 洪水", VO: "🌋 火山", WF: "🔥 野火", DR: "🏜 乾旱" };
      if (!first && serious) notes.push(`${kind[d.type] ?? "⚠️ 災害"}：${d.name}（警戒等級 ${d.alert}${d.distance_km != null ? `，距離約 ${d.distance_km} 公里` : ""}），可以問我「會不會影響行程」。`);
    }
    for (const d of (Array.isArray(a.forecast) ? a.forecast : []).filter((x: any) => x.severe && x.date >= date).slice(0, 2)) {
      const key = `wx:${d.date}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      notes.push(`🌧 **${d.date.slice(5).replace("-", "/")} 天氣警示**：${d.weather}，雨量約 ${d.rain_mm} mm、陣風 ${d.max_gust_kmh} km/h，戶外行程請準備雨具或考慮室內備案。`);
    }
    this.setSetting("alerts_seen", JSON.stringify(seen.slice(-300)));
    this.setSetting("alerts_initialized", "1");
    if (notes.length) this.postAiMessage(`⚠️ **警報通知**\n\n${notes.join("\n\n")}${p.emergency ? `\n\n緊急電話：${p.emergency}` : ""}`, { kind: "alert" });
  }

  /** 旅遊日記網頁（成員版／分享版）：封面＋每天一章，可以列印成 PDF */
  private album(mode: "member" | "share", req: Request, url: URL): Response {
    const p = this.p();
    const origin = req.headers.get("x-origin") ?? "";
    const token = this.setting("share_token");
    const sharePath = `/share/${this.roomId()}/${token}`;
    const photoBase = mode === "share" ? `${sharePath}/photo/` : "/api/photo/";
    // 過去的旅程（?trip=）只給登入的家人看；分享連結只看現在這趟
    const pastId = mode === "member" ? Number(url.searchParams.get("trip")) || 0 : 0;
    const past = pastId ? this.sql.exec("SELECT * FROM trips WHERE id = ?", pastId).toArray()[0] : undefined;
    const trip = past
      ? { title: String(past.title), startDate: String(past.start_date), endDate: String(past.end_date), travelers: String(past.travelers ?? "") }
      : { title: p.title, startDate: p.startDate, endDate: p.endDate, travelers: p.travelers.map((t) => t.name).join("、") };
    const plan = new Map(past ? [] : this.itinerary().map((d) => [String(d.date), String(d.title ?? "")]));
    const start = Date.parse(trip.startDate + "T00:00:00Z");
    const personal = this.isPersonal();
    const days = this.sql
      .exec(`SELECT * FROM diaries WHERE ${past ? "trip_id = ?" : "trip_id IS NULL"} ORDER BY date${personal ? " DESC" : ""}`, ...(past ? [pastId] : []))
      .toArray()
      .map((d) => {
        const date = String(d.date);
        const layout = new Map((JSON.parse((d.layout as string) || "[]") as DiaryPhoto[]).map((l) => [l.id, l]));
        return {
          date,
          dayNo: Math.floor((Date.parse(date + "T00:00:00Z") - start) / 86400_000) + 1,
          title: String(d.title || plan.get(date) || (personal ? "日記" : "旅途中的一天")),
          plan: personal ? "" : plan.get(date) ?? "",
          ...(personal
            ? { label: Number(d.span) > 1 ? "週記" : "日記", when: Number(d.span) > 1 ? `${mdText(shiftDays(date, 1 - Number(d.span)))}–${mdText(date)}` : undefined }
            : {}),
          text: String(d.text ?? ""),
          photos: (JSON.parse((d.photo_ids as string) || "[]") as string[]).map((id) => {
            const l = layout.get(id);
            return { src: photoBase + id, para: l?.para, caption: l?.caption };
          }),
        };
      });
    const html = renderDiaryPage({
      tripTitle: personal ? `${p.travelers[0]?.name || "我"}的日記` : trip.title,
      dates: personal
        ? days.length ? `${days[days.length - 1].date.replaceAll("-", "/")} – ${days[0].date.replaceAll("-", "/")}` : ""
        : `${trip.startDate.replaceAll("-", "/")} – ${trip.endDate.slice(5).replace("-", "/")}`,
      travelers: personal ? "" : trip.travelers,
      ...(personal ? { kicker: "LIFE DIARY ・ 生活日記", footer: "由個人助理根據你的對話、照片和行事曆整理", unit: "篇", suffix: "", noShare: true } : {}),
      accent: "#1d4ed8",
      days,
      mode,
      shareUrl: token && !past ? origin + sharePath : null,
      origin,
      autoPrint: url.searchParams.get("print") === "1",
      homeUrl: `/t/${this.roomId()}`,
    });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  /** 分享連結：分享碼對了才給看；照片只給日記裡用到的那幾張 */
  private shared(token: string, photoId: string | undefined, req: Request, url: URL): Response {
    const saved = this.setting("share_token");
    if (!saved || !safeEqual(token, saved)) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>連結已失效</title><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#555">這個日記分享連結已經關閉或不存在 🙏</body>`,
        { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } },
      );
    }
    if (!photoId) return this.album("share", req, url);
    const inDiary = this.sql
      .exec("SELECT photo_ids FROM diaries")
      .toArray()
      .some((d) => (JSON.parse((d.photo_ids as string) || "[]") as string[]).includes(photoId));
    const row = inDiary ? this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", photoId).toArray()[0] : undefined;
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(row.data as ArrayBuffer, { headers: { "content-type": row.mime as string, "cache-control": "public, max-age=86400", "x-robots-tag": "noindex" } });
  }

  // ================= 畫面上的狀態 =================

  private itinerary() {
    return this.sql.exec("SELECT * FROM itinerary ORDER BY date").toArray();
  }

  /** 有效的記憶（已被取代、過期的不算） */
  private memories() {
    return this.sql.exec("SELECT * FROM memories WHERE COALESCE(status, 'active') = 'active' ORDER BY ts").toArray();
  }

  /** 記憶多了以後（個人助理、旅遊群組都一樣），只挑跟這次問題相關的：雙字詞比對＋語意＋最近記的＋待辦與預訂 */
  /** 整理記憶時給 AI 看的舊記憶：不多就全部；多了只給跟新對話有關的 50 條＋最近記的 20 條（它才抓得到重複和過時的） */
  private memoriesFor(transcript: string): { list: Record<string, SqlStorageValue>[]; total: number } {
    const all = this.memories();
    if (all.length <= 70) return { list: all, total: all.length };
    const t = bigrams(transcript);
    const keep = new Set(
      all
        .map((m) => {
          const g = bigrams(String(m.content));
          let hit = 0;
          for (const x of g) if (t.has(x)) hit++;
          return { id: m.id, s: g.size ? hit / g.size : 0 };
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((x) => x.id),
    );
    for (const m of all.slice(-20)) keep.add(m.id);
    return { list: all.filter((m) => keep.has(m.id)), total: all.length };
  }

  private relevantMemories(text: string): { list: Record<string, SqlStorageValue>[]; total: number } {
    const all = this.memories();
    if (all.length <= 40) return { list: all, total: all.length };
    const q = bigrams(text);
    const sims = this.memQuery?.text === text ? this.memQuery.sims : null;
    const scored = all.map((m, i) => {
      const g = bigrams(String(m.content));
      let hit = 0;
      for (const x of q) if (g.has(x)) hit++;
      const recent = i >= all.length - 8 ? 0.5 : 0;
      const urgent = m.category === "待辦" || m.category === "預訂" ? 0.3 : 0;
      return { m, score: (q.size ? hit / Math.sqrt(q.size) : 0) + recent + urgent + semanticBoost(sims?.get(`memory:${m.id}`)) };
    });
    const list = scored.sort((a, b) => b.score - a.score).slice(0, 25).map((x) => x.m).sort((a, b) => Number(a.ts) - Number(b.ts));
    return { list, total: all.length };
  }

  private state() {
    const p = this.p();
    return {
      trip: { ...p, flag: p.kind === "personal" ? "🙋" : flagEmoji(p.countryCode), diff: diffFromTaiwan(p.timezone) },
      itinerary: this.itinerary(),
      memories: this.memories(),
      expenses: this.expenseSummary(),
      members: this.members(),
      summary: this.setting("summary"),
      phrases: this.sql.exec("SELECT id, category, zh, local, reading, author FROM phrases ORDER BY id").toArray(),
      checklist: this.checklistGet(),
      reminders: this.reminderList(),
      documents: this.documentFind().map((d) => ({ id: d.id, title: d.title, note: d.note, author: d.author, ts: d.ts, photo: `/api/photo/${d.photo_id}`, folder: d.folder_id ?? null })),
      docFolders: this.sql.exec("SELECT id, name, parent_id AS parent FROM doc_folders ORDER BY id").toArray(),
      diaries: this.sql.exec("SELECT date, ts, title, text, photo_ids, edited_by, edited_at, span FROM diaries WHERE trip_id IS NULL ORDER BY date DESC").toArray(),
      pastTrips: this.sql.exec("SELECT t.id, t.title, t.country, t.city, t.flag, t.start_date, t.end_date, (SELECT COUNT(*) FROM diaries d WHERE d.trip_id = t.id) AS days FROM trips t ORDER BY t.id DESC").toArray(),
      // 置頂訊息附完整內容：訊息再舊、畫面上沒載入也看得到
      pins: this.sql
        .exec<MessageRow & { pin_ts: number; pin_by: string }>("SELECT m.*, p.ts AS pin_ts, p.by AS pin_by FROM pins p JOIN messages m ON m.id = p.message_id ORDER BY p.ts DESC")
        .toArray()
        .map((r) => ({ ts: r.pin_ts, by: r.pin_by, message: this.publicMessage(r) })),
      locations: this.memberLocation(),
      gemini: this.ownLimiter.usage(),
      ...(p.kind === "personal"
        ? {
            ledger: this.ledger(),
            core: this.setting("core_profile"),
            memoryArchive: this.sql.exec("SELECT * FROM memories WHERE COALESCE(status, 'active') NOT IN ('active', 'hypothesis') ORDER BY COALESCE(updated, ts) DESC LIMIT 60").toArray(),
            brief: this.latestBrief(),
            notes: this.sql.exec("SELECT id, ts, title, summary, url, tags, thumb, inbox, file_id, (SELECT mime FROM files WHERE files.id = notes.file_id) AS file_mime, LENGTH(COALESCE(content, '')) AS clen FROM notes ORDER BY ts DESC LIMIT 300").toArray(),
            files: this.sql.exec("SELECT id, ts, name, bytes, status, error, note_id FROM files WHERE status != 'done' ORDER BY id DESC LIMIT 20").toArray(),
            health: this.health().summary(),
            events: this.eventList(shiftDays(this.today(), -7), shiftDays(this.today(), 90)),
            cards: this.sql.exec("SELECT id, ts, kind, title, body FROM cards WHERE status = 'pending' ORDER BY ts DESC LIMIT 10").toArray(),
            dreamOps: this.sql.exec("SELECT id, ts, op, before, after, reason, undone FROM dream_ops ORDER BY id DESC LIMIT 20").toArray(),
            episodes: this.sql.exec("SELECT date, summary, weekly FROM episodes ORDER BY date DESC LIMIT 10").toArray(),
            memos: this.sql
              .exec(
                "SELECT id, ts, updated, title, status, source, segs, done_segs, ended, seconds, engine, summary, actions, note_id, error, (SELECT COALESCE(SUM(LENGTH(a.data)), 0) FROM memo_audio a WHERE a.memo_id = memos.id) AS audio_bytes FROM memos ORDER BY id DESC LIMIT 20",
              )
              .toArray()
              .map((m) => ({ ...m, parts: this.sql.exec("SELECT seq, seconds, status FROM memo_segs WHERE memo_id = ? ORDER BY seq", m.id).toArray() })),
            idDocs: this.idDocList(),
          }
        : {}),
    };
  }

  private broadcastState() {
    if (!this.profile()) return;
    this.broadcast({ type: "state", state: this.state() });
  }

  // ================= AI 模型：先用擁有者的免費額度，用完才用旅程自己的金鑰 =================

  private async workersAiBlocked(): Promise<boolean> {
    const now = Date.now();
    if (now - this.workersBlocked.checked > 60_000) {
      this.workersBlocked = { until: await this.registry().workersAiBlockedUntil(), checked: now };
    }
    return now < this.workersBlocked.until;
  }

  /** vision：有照片要辨識時，旅程自己的 Gemini 也排到 Workers AI 前面（看圖比 Gemma 準很多），額度滿了才退回 Gemma */
  private async chain(vision = false): Promise<ProviderId[]> {
    // 個人助理不用網站的 Gemini：自己的金鑰優先，額度用完才改用 Workers AI
    if (this.isPersonal()) {
      const order: ProviderId[] = (await this.keys()).gemini ? ["gemini-own"] : [];
      if (!(await this.workersAiBlocked())) order.push("workers-ai");
      return order;
    }
    const order: ProviderId[] = [];
    const own = !!(await this.keys()).gemini;
    if (this.env.GEMINI_API_KEY) order.push("gemini");
    if (vision && own) order.push("gemini-own");
    if (!(await this.workersAiBlocked())) order.push("workers-ai");
    if (!vision && own) order.push("gemini-own");
    return order;
  }

  /** share：可用的 Gemini 額度比例；maxWait：額度滿時最多等幾毫秒 */
  private async provider(id: ProviderId, share = 1, maxWait = FOREGROUND_MAX_WAIT, onWait?: (ms: number) => void): Promise<Provider> {
    let gate: GeminiGate | undefined;
    if (id === "gemini") {
      const reg = this.registry();
      gate = { acquire: (est) => acquireWith(() => reg.ownerGeminiTry(est, share), maxWait, onWait), failed: (s, b) => this.ctx.waitUntil(reg.ownerGeminiFailed(s, b)) };
    } else if (id === "gemini-own") {
      gate = { acquire: (est) => acquireWith(() => this.ownLimiter.tryAcquire(est, share), maxWait, onWait), failed: (s, b) => this.ownLimiter.penalize(s, b) };
    }
    return providerFor(this.env, id, gate, (await this.keys()).gemini);
  }

  private noteQuota(e: unknown) {
    if (e instanceof WorkersAiQuotaError) {
      this.workersBlocked = { until: Date.now() + 3600_000, checked: Date.now() };
      this.ctx.waitUntil(this.registry().blockWorkersAi());
    }
  }

  /** 不用工具、只產生文字（初始化、早報、日記、翻譯、整理記憶） */
  private async generateText(system: string, prompt: string, json: boolean, share = 1, maxTokens?: number): Promise<string> {
    let last = "";
    for (const id of await this.chain()) {
      try {
        const r = await (await this.provider(id, share, 5_000)).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }], json, maxTokens });
        if (r.text.trim()) return r.text.trim();
      } catch (e: any) {
        this.noteQuota(e);
        last = String(e?.message ?? e);
        if (!(e instanceof RateLimitedError)) console.error(`generate via ${id} failed`, last);
      }
    }
    throw new Error(last || "目前沒有可用的 AI 額度");
  }

  private async toolCtx(author: string, extra: Partial<ToolContext> = {}): Promise<ToolContext> {
    return { env: this.env, room: this, profile: this.p(), tavilyKey: (await this.keys()).tavily, author, ...extra };
  }

  // ================= Agent =================

  /**
   * 自動回想：從「最近訊息視窗之外」的舊聊天裡，找出跟這次問題字詞重疊最多的訊息。
   * 用中文雙字詞比對，不需要向量資料庫；旅程期間訊息量不大，全掃也很快。
   */
  private recallOlder(trigger: MessageRow, windowStartTs: number): string {
    const grams = (s: string) => {
      const clean = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
      const set = new Set<string>();
      for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
      return set;
    };
    const q = grams(trigger.text);
    if (q.size < 2) return "";
    const older = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts < ? AND text != '' ORDER BY ts DESC LIMIT 3000", windowStartTs).toArray().filter((m) => !healthMessage(m));
    return older
      .map((m) => {
        const g = grams(m.text);
        let hit = 0;
        for (const x of q) if (g.has(x)) hit++;
        return { m, score: hit / Math.sqrt(q.size) };
      })
      .filter((x) => x.score >= 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, RECALL_LIMIT)
      .sort((a, b) => a.m.ts - b.m.ts)
      .map(({ m }) => `- ${this.localTime(m.ts).slice(5)} ${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 300).replace(/\n+/g, " ")}`)
      .join("\n");
  }

  // ================= 個人助理：行事曆 =================

  private eventRow(r: Record<string, SqlStorageValue>) {
    return {
      id: Number(r.id), title: String(r.title), date: String(r.date), start: (r.start as string | null) ?? null, end: (r.end_time as string | null) ?? null,
      location: (r.location as string | null) ?? null, note: (r.note as string | null) ?? null, remindMin: r.remind_min == null ? null : Number(r.remind_min),
    };
  }

  eventList(from: string, to: string) {
    return this.sql.exec("SELECT * FROM events WHERE date >= ? AND date <= ? ORDER BY date, COALESCE(start, '')", from, to).toArray().map((r) => {
      const e = this.eventRow(r);
      return { ...e, weekday: "日一二三四五六"[new Date(e.date + "T00:00:00Z").getUTCDay()] };
    });
  }

  eventGet(id: number) {
    const r = this.sql.exec("SELECT * FROM events WHERE id = ?", id).toArray()[0];
    return r ? this.eventRow(r) : null;
  }

  eventFind(keyword: string) {
    return this.sql.exec("SELECT * FROM events WHERE title LIKE ? AND date >= ? ORDER BY date LIMIT 8", `%${keyword}%`, shiftDays(this.today(), -30)).toArray().map((r) => this.eventRow(r));
  }

  eventAdd(e: EventInput, author: string) {
    const id = Number(
      this.sql.exec(
        "INSERT INTO events (ts, author, title, date, start, end_time, location, note, remind_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        Date.now(), author, e.title, e.date, e.start ?? null, e.end ?? null, e.location ?? null, e.note ?? null, e.remindMin ?? null,
      ).one().id,
    );
    this.broadcastState();
    this.ctx.waitUntil(this.scheduleNext());
    return id;
  }

  eventUpdate(id: number, e: EventInput): boolean {
    const n = this.sql.exec(
      "UPDATE events SET title = ?, date = ?, start = ?, end_time = ?, location = ?, note = ?, remind_min = ?, reminded = 0 WHERE id = ?",
      e.title, e.date, e.start ?? null, e.end ?? null, e.location ?? null, e.note ?? null, e.remindMin ?? null, id,
    ).rowsWritten;
    this.broadcastState();
    this.ctx.waitUntil(this.scheduleNext());
    return n > 0;
  }

  eventDelete(id: number): boolean {
    const n = this.sql.exec("DELETE FROM events WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  /** 行程開始時間（UTC 毫秒）；整天的行程用當天早上 9 點算提醒 */
  private eventStartMs(e: { date: string; start: string | null }): number | null {
    return localToUtc(e.date, e.start ?? "09:00", this.p().timezone);
  }

  private nextEventReminder(): number | null {
    let best: number | null = null;
    for (const r of this.sql.exec("SELECT * FROM events WHERE reminded = 0 AND remind_min IS NOT NULL AND date >= ?", shiftDays(this.today(), -1)).toArray()) {
      const at = this.eventStartMs({ date: String(r.date), start: (r.start as string | null) ?? null });
      if (at == null) continue;
      const due = at - Number(r.remind_min) * 60_000;
      if (best == null || due < best) best = due;
    }
    return best;
  }

  /** 行程提醒：時間到在聊天提醒＋推播到手機 */
  private async deliverEventReminders() {
    const rows = this.sql.exec("SELECT * FROM events WHERE reminded = 0 AND remind_min IS NOT NULL AND date >= ?", shiftDays(this.today(), -1)).toArray();
    for (const r of rows) {
      const e = this.eventRow(r);
      const at = this.eventStartMs(e);
      if (at == null || at - (e.remindMin ?? 0) * 60_000 > Date.now() + 30_000) continue;
      this.sql.exec("UPDATE events SET reminded = 1 WHERE id = ?", e.id);
      if (at < Date.now() - 3600_000) continue; // 早就過了（例如剛改時間）就不補提醒
      const when = `${e.date.slice(5).replace("-", "/")}${e.start ? ` ${e.start}` : "（整天）"}`;
      const text = `📅 **行程提醒**：${when} ${e.title}${e.location ? `\n📍 ${e.location}` : ""}${e.note ? `\n${e.note}` : ""}`;
      this.postAiMessage(text, { kind: "reminder" });
      await this.pushAll({ title: `📅 ${e.title}`, body: `${when}${e.location ? `・${e.location}` : ""}`, tag: `event-${e.id}` });
    }
  }

  /** ICS 訂閱：Google 日曆、iPhone 行事曆用網址訂閱就看得到（它們每幾小時會來拿一次） */
  private icsFeed(): string {
    const p = this.p();
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const day = (d: string) => d.replaceAll("-", "");
    // 每行最多 75 bytes，超過要折行（中文一個字 3 bytes，不能從字的中間切）
    const fold = (line: string) => {
      const out: string[] = [];
      let cur = "", bytes = 0;
      for (const ch of line) {
        const b = new TextEncoder().encode(ch).length;
        if (bytes + b > (out.length ? 74 : 75)) {
          out.push(cur);
          cur = "";
          bytes = 0;
        }
        cur += ch;
        bytes += b;
      }
      out.push(cur);
      return out.join("\r\n ");
    };
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trip Agent//Personal Assistant//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(p.title)}`, `X-WR-TIMEZONE:${p.timezone}`];
    for (const r of this.sql.exec("SELECT * FROM events WHERE date >= ? ORDER BY date", shiftDays(this.today(), -180)).toArray()) {
      const e = this.eventRow(r);
      lines.push("BEGIN:VEVENT", `UID:event-${e.id}@${this.roomId()}.trip-agent`, `DTSTAMP:${utc(Number(r.ts))}`);
      if (e.start) {
        const start = localToUtc(e.date, e.start, p.timezone) ?? 0;
        const end = e.end ? localToUtc(e.date, e.end, p.timezone) ?? start + 3600_000 : start + 3600_000;
        lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${day(e.date)}`, `DTEND;VALUE=DATE:${day(shiftDays(e.date, 1))}`);
      }
      lines.push(`SUMMARY:${esc(e.title)}`);
      if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
      if (e.note) lines.push(`DESCRIPTION:${esc(e.note)}`);
      if (e.remindMin != null) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.remindMin}M`, "END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  // ================= 個人助理：做夢（每晚整理記憶）＋早上的確認卡 =================

  /** 每晚凌晨 3 點到 5 點之間做一次；每個空間依代碼錯開幾分鐘，不會同時擠爆額度 */
  private async maybeDream(now: ReturnType<typeof zoned>) {
    if (this.setting("dream_date") === now.date || now.hour < 3 || now.hour >= 5) return;
    let h = 0;
    for (const c of this.roomId()) h = (h * 31 + c.charCodeAt(0)) % 997;
    if ((now.hour - 3) * 60 + now.mi < h % 90) return;
    this.setSetting("dream_date", now.date);
    await this.dream(now.date);
  }

  private dreamLog(op: string, target: number, before: unknown, after: unknown, reason: string) {
    this.sql.exec("INSERT INTO dream_ops (ts, op, target, before, after, reason) VALUES (?, ?, ?, ?, ?, ?)", Date.now(), op, target, JSON.stringify(before ?? null), JSON.stringify(after ?? null), reason.slice(0, 200));
  }

  private addCard(kind: string, title: string, body: string, payload: unknown) {
    this.sql.exec("INSERT INTO cards (ts, kind, title, body, payload) VALUES (?, ?, ?, ?, ?)", Date.now(), kind, title.slice(0, 80), body.slice(0, 400), JSON.stringify(payload));
  }

  /**
   * 做夢：把這段時間的對話整理成
   * 1) 一段當天回顧（之後週回顧、找舊事用）2) 合併重複的記憶 3) 跟舊記憶矛盾的地方（問使用者）
   * 4) 觀察到的習慣（先當「假設」，使用者確認才算數）5) 說要做但還沒下文的事（早上追問）6) 更新「關於我」
   * 會改到使用者親口說的記憶的，一律出確認卡；AI 自己整理的才自動套用，而且都有紀錄可以復原
   */
  async dream(date: string, force = false) {
    const p = this.p();
    const owner = p.travelers[0]?.name || "使用者";
    const cursor = Number(this.setting("dream_cursor", "0"));
    const msgs = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts > ? AND role != 'system' ORDER BY ts", cursor).toArray().filter((m) => !systemMade(m));
    const userCount = msgs.filter((m) => m.role === "user").length;
    const weekly = new Date(date + "T00:00:00Z").getUTCDay() === 0 && this.setting("dream_week") !== date;
    const run: Record<string, unknown> = { date, at: Date.now(), messages: userCount };
    // 過期沒回的卡收掉
    this.sql.exec("UPDATE cards SET status = 'expired' WHERE status = 'pending' AND ts < ?", Date.now() - 7 * 86400_000);
    if (userCount < 3 && !force && !weekly) {
      this.setSetting("dream_last", JSON.stringify({ ...run, skipped: "新的對話太少，今晚不用整理" }));
      return;
    }
    if (userCount) {
      const transcript = msgs.slice(-150).map((m) => `[${this.localTime(m.ts).slice(5, 16)}] ${m.role === "assistant" ? AI_NAME : m.author}：${m.text.replace(/\s+/g, " ").slice(0, m.role === "assistant" ? 160 : 400)}`).join("\n");
      const mems = this.memories().map((m) => `#${m.id}［${m.category}｜${(m.source ?? (m.author === "AI 自動整理" ? "auto" : "user")) === "user" ? "使用者說的" : "AI 整理"}］${m.content}${m.expires ? `（到 ${m.expires}）` : ""}`).join("\n") || "（無）";
      const open = [
        ...this.checklistGet("待辦").filter((c) => !c.done).map((c) => `待辦：${c.item}`),
        ...this.reminderList().map((r) => `提醒：${r.time} ${r.message}`),
        ...(this.eventList(this.today(), shiftDays(this.today(), 60)) as any[]).map((e) => `行程：${e.date} ${e.title}`),
      ].join("\n") || "（無）";
      const episodes = this.sql.exec("SELECT date, summary FROM episodes WHERE weekly = 0 ORDER BY date DESC LIMIT 7").toArray().map((e) => `${e.date}：${e.summary}`).join("\n") || "（無）";
      const prompt = `你是${owner}的個人助理，現在是夜間整理時間（今天 ${date}）。根據下面的資料輸出 JSON，只根據資料，不要編造。
1. episode：這段對話的回顧，2–4 句，寫${owner}做了什麼、決定了什麼、在意什麼（沒有重要的事就寫空字串）。
2. about_me：更新「關於${owner}」（300 字內）：只放長期穩定的事；保留現有內容中仍然正確的部分；沒有變化就原樣輸出。
3. duplicates：現有記憶裡講同一件事的，合併成一句：[{"keep": 保留的 id, "remove": [要併掉的 id], "content": "合併後的一句話"}]。不是同一件事不要合併。
4. conflicts：新的對話和某條現有記憶矛盾、但對話裡沒有明確更新的：[{"old_id": id, "question": "問${owner}的一句話", "new_fact": "如果舊的不對，新的應該是什麼（可空）"}]，最多 2 個。
5. insights：從對話看出的習慣或偏好，要有 3 個以上證據、跨 2 天以上才寫：[{"content": "一句話", "evidence": ["MM-DD 原話", ...]}]，最多 2 個；證據不夠就回空陣列。
6. followups：${owner}說要做、但對話裡沒說做完、也不在下面「已安排的事」裡的事（例如訂機票、繳費、預約）：[{"question": "早上要問的一句話", "about": "那件事的簡短名稱"}]，最多 2 個。

現在的「關於${owner}」：
${this.setting("core_profile") || "（無）"}

現有記憶：
${mems}

已安排的事：
${open}

最近幾天的回顧：
${episodes}

對話：
${transcript}

輸出 JSON：{"episode": "", "about_me": "", "duplicates": [], "conflicts": [], "insights": [], "followups": []}`;
      let j: any = null;
      try {
        j = parseArgs((await this.generateText("你是負責夜間整理記憶的助理，只輸出 JSON。", prompt, true, 0.5)).replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
      } catch (e) {
        if (!(e instanceof RateLimitedError)) console.error("dream failed", e);
        this.setSetting("dream_last", JSON.stringify({ ...run, error: "AI 暫時不能用，明晚再整理" }));
        return;
      }
      const stats = { merged: 0, cards: 0, insights: 0 };
      const lastDate = zoned(msgs[msgs.length - 1].ts, p.timezone).date;
      if (typeof j.episode === "string" && j.episode.trim()) {
        this.sql.exec("INSERT INTO episodes (date, ts, summary, weekly) VALUES (?, ?, ?, 0) ON CONFLICT(date) DO UPDATE SET summary = excluded.summary, ts = excluded.ts", lastDate, Date.now(), j.episode.trim().slice(0, 600));
      }
      if (typeof j.about_me === "string" && j.about_me.trim() && j.about_me.trim() !== this.setting("core_profile")) {
        this.dreamLog("about_me", 0, this.setting("core_profile"), j.about_me.trim().slice(0, 800), "夜間整理更新「關於我」");
        this.setSetting("core_profile", j.about_me.trim().slice(0, 800));
      }
      const active = new Map(this.memories().map((m) => [Number(m.id), m]));
      const isUser = (m: Record<string, SqlStorageValue>) => (m.source ?? (m.author === "AI 自動整理" ? "auto" : "user")) === "user";
      let newCards = 0;
      for (const d of (Array.isArray(j.duplicates) ? j.duplicates : []).slice(0, 5)) {
        const keep = active.get(Number(d?.keep));
        const remove = (Array.isArray(d?.remove) ? d.remove : []).map(Number).filter((x: number) => x !== Number(d?.keep) && active.has(x));
        const content = String(d?.content ?? "").trim().slice(0, 500);
        if (!keep || !remove.length || !content) continue;
        // 會動到使用者親口說的記憶：問過再合併
        if (isUser(keep) || remove.some((x: number) => isUser(active.get(x)!))) {
          if (newCards >= 3) continue;
          this.addCard("merge", "這幾條是同一件事嗎？", `${[keep, ...remove.map((x: number) => active.get(x)!)].map((m) => `・${m.content}`).join("\n")}\n→ 合併成：${content}`, { keep: Number(keep.id), remove, content });
          newCards++;
          continue;
        }
        this.dreamLog("merge", Number(keep.id), { content: keep.content, remove }, { content }, "合併重複的記憶");
        this.sql.exec("UPDATE memories SET content = ?, updated = ? WHERE id = ?", content, Date.now(), keep.id);
        for (const x of remove) this.sql.exec("UPDATE memories SET status = 'superseded', superseded_by = ?, updated = ? WHERE id = ?", keep.id, Date.now(), x);
        stats.merged++;
      }
      for (const c of (Array.isArray(j.conflicts) ? j.conflicts : []).slice(0, 2)) {
        const old = active.get(Number(c?.old_id));
        if (!old || !c?.question || newCards >= 3) continue;
        this.addCard("conflict", "這件事還是對的嗎？", `${old.content}\n${String(c.question).slice(0, 200)}`, { old_id: Number(old.id), new_fact: String(c.new_fact ?? "").slice(0, 300) });
        newCards++;
      }
      for (const ins of (Array.isArray(j.insights) ? j.insights : []).slice(0, 2)) {
        const content = String(ins?.content ?? "").trim().slice(0, 300);
        const evidence = (Array.isArray(ins?.evidence) ? ins.evidence : []).map(String).slice(0, 5);
        if (!content || evidence.length < 3 || newCards >= 3 || this.memoryGuard(content)) continue;
        if (this.memories().some((m) => sameFact(String(m.content), content))) continue;
        const id = Number(this.sql.exec("INSERT INTO memories (ts, category, content, author, status, source, updated) VALUES (?, '偏好', ?, 'AI 夜間整理', 'hypothesis', 'auto', ?) RETURNING id", Date.now(), content, Date.now()).one().id);
        this.addCard("insight", "我注意到…對嗎？", `${content}\n（根據：${evidence.join("；")}）`, { memory_id: id });
        newCards++;
        stats.insights++;
      }
      for (const f of (Array.isArray(j.followups) ? j.followups : []).slice(0, 2)) {
        if (!f?.question || newCards >= 3) continue;
        this.addCard("followup", String(f.question).slice(0, 80), "", { about: String(f.about ?? f.question).slice(0, 80) });
        newCards++;
      }
      stats.cards = newCards;
      Object.assign(run, stats);
      this.setSetting("dream_cursor", String(msgs[msgs.length - 1].ts));
    }
    // 每週日：用比較會寫的模型把這週的回顧整理成週回顧
    if (weekly) {
      this.setSetting("dream_week", date);
      const week = this.sql.exec("SELECT date, summary FROM episodes WHERE weekly = 0 AND date > ? ORDER BY date", shiftDays(date, -7)).toArray();
      if (week.length >= 2) {
        try {
          const text = await this.generateLong(
            `你是${owner}的個人助理，語氣溫暖，只根據資料寫。`,
            `請根據這週每天的回顧，寫${owner}這週的回顧（150–250 字，繁體中文）：這週做了哪些事、有什麼進展、下週可以注意什麼。\n${week.map((e) => `${e.date}：${e.summary}`).join("\n")}`,
          );
          this.sql.exec("INSERT INTO episodes (date, ts, summary, weekly) VALUES (?, ?, ?, 1) ON CONFLICT(date) DO UPDATE SET summary = excluded.summary, weekly = 1", `${date}W`, Date.now(), text.slice(0, 1200));
          this.addCard("weekly", "這週的回顧", text.slice(0, 400), {});
          run.weekly = true;
        } catch (e) {
          console.error("weekly dream failed", e);
        }
      }
    }
    this.setSetting("dream_last", JSON.stringify(run));
    this.broadcastState();
    this.broadcast({ type: "settings", settings: this.settings() });
  }

  /** 早上的確認卡：使用者按了「對／不對／改／做好了／還沒」 */
  private cardAnswer(id: number, answer: string, text: string, by: string): string | null {
    const c = this.sql.exec("SELECT * FROM cards WHERE id = ?", id).toArray()[0];
    if (!c) return "找不到這張卡";
    if (c.status !== "pending") return "這張卡已經處理過了";
    const p = JSON.parse(String(c.payload || "{}"));
    const now = Date.now();
    switch (c.kind) {
      case "insight":
        if (answer === "yes") this.sql.exec("UPDATE memories SET status = 'active', updated = ? WHERE id = ?", now, p.memory_id);
        else if (answer === "edit" && text.trim()) this.sql.exec("UPDATE memories SET content = ?, status = 'active', source = 'user', updated = ? WHERE id = ?", text.trim().slice(0, 500), now, p.memory_id);
        else this.sql.exec("DELETE FROM memories WHERE id = ? AND status = 'hypothesis'", p.memory_id);
        break;
      case "conflict":
        // no＝舊的已經不對了：標成已取代，有新的事實就記下來
        if (answer === "no") {
          const fact = (text.trim() || String(p.new_fact ?? "")).slice(0, 500);
          const nid = fact ? this.insertMemory(fact, "資訊", by, "user", null) : null;
          this.sql.exec("UPDATE memories SET status = 'superseded', superseded_by = ?, updated = ? WHERE id = ?", nid, now, p.old_id);
        }
        break;
      case "merge":
        if (answer === "yes") {
          const keep = this.sql.exec("SELECT content FROM memories WHERE id = ?", p.keep).toArray()[0];
          this.dreamLog("merge", p.keep, { content: keep?.content, remove: p.remove }, { content: p.content }, "確認後合併重複的記憶");
          this.sql.exec("UPDATE memories SET content = ?, updated = ? WHERE id = ?", p.content, now, p.keep);
          for (const x of p.remove ?? []) this.sql.exec("UPDATE memories SET status = 'superseded', superseded_by = ?, updated = ? WHERE id = ?", p.keep, now, x);
        }
        break;
      case "followup":
        if (answer === "done") this.insertMemory(`${p.about}：已完成（${this.today()}）`, "決定", by, "user", null);
        else if (answer === "later") this.checklistAdd("待辦", [String(p.about)], "", by);
        break;
    }
    this.sql.exec("UPDATE cards SET status = ?, resolved_at = ? WHERE id = ?", answer || "dismissed", now, id);
    this.broadcastState();
    return null;
  }

  /** 復原一筆夜間整理自動做的變更 */
  private dreamUndo(id: number): string | null {
    const op = this.sql.exec("SELECT * FROM dream_ops WHERE id = ?", id).toArray()[0];
    if (!op) return "找不到這筆紀錄";
    if (op.undone) return "已經復原過了";
    const before = JSON.parse(String(op.before ?? "null"));
    if (op.op === "about_me") this.setSetting("core_profile", String(before ?? ""));
    else if (op.op === "merge") {
      this.sql.exec("UPDATE memories SET content = ?, updated = ? WHERE id = ?", before?.content ?? "", Date.now(), op.target);
      for (const x of before?.remove ?? []) this.sql.exec("UPDATE memories SET status = 'active', superseded_by = NULL, updated = ? WHERE id = ?", Date.now(), x);
    }
    this.sql.exec("UPDATE dream_ops SET undone = 1 WHERE id = ?", id);
    this.broadcastState();
    return null;
  }
  // ================= 個人助理：帳本、預算、推播、早報、每日整理、匯出 =================

  /** 個人帳本：某個月（預設這個月）的總花費（台幣）、分類、預算、最近幾筆，以及最近幾個月的總額 */
  ledger(month?: string) {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : this.today().slice(0, 7);
    const rows = this.sql.exec("SELECT * FROM expenses WHERE substr(date, 1, 7) = ? ORDER BY date DESC, id DESC", m).toArray();
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const v = Number(r.amount_twd) || 0;
      total += v;
      byCategory[r.category as string] = (byCategory[r.category as string] ?? 0) + v;
    }
    const budget = Number(this.setting("budget_month", "0")) || 0;
    return {
      month: m,
      total: Math.round(total),
      budget,
      remaining: budget ? Math.round(budget - total) : null,
      count: rows.length,
      by_category: byCategory,
      items: rows.slice(0, 100).map((r) => ({ id: r.id, date: r.date, description: r.description, amount: r.amount, currency: r.currency, twd: r.amount_twd, category: r.category })),
      months: this.sql
        .exec("SELECT substr(date, 1, 7) AS m, SUM(amount_twd) AS t, COUNT(*) AS n FROM expenses GROUP BY m ORDER BY m DESC LIMIT 6")
        .toArray()
        .map((r) => ({ month: r.m as string, total: Math.round(Number(r.t) || 0), count: Number(r.n) })),
    };
  }

  /** FB／IG 影片交給 Gemini 看畫面＋聽聲音做摘要（Workers AI 看不了影片，沒有 Gemini 就回 null） */
  async describeVideo(mime: string, base64: string, hint: string): Promise<string | null> {
    const prompt = `這是一支社群短影片${hint ? `，貼文文字開頭是：「${hint}」` : ""}。請用繁體中文整理：
1. 一句話主旨
2. 重點條列：講者說了什麼、畫面上出現什麼（步驟、操作、畫面上的文字）
3. 提到的工具、網站、店名、地點、價格、數字
只根據影片內容，聽不清楚、看不清楚的就略過，不要編造。`;
    for (const id of (await this.chain(true)).filter((x) => x !== "workers-ai")) {
      try {
        const r = await (await this.provider(id, 1, 15_000)).generate({
          system: "你是幫使用者整理影片內容的助理，只根據影片內容，不要編造。",
          turns: [{ role: "user", parts: [{ image: { mime, data: base64 } }, { text: prompt }] }],
          timeoutMs: 90_000,
        });
        if (r.text.trim()) return r.text.trim();
      } catch (e) {
        this.noteQuota(e);
        if (!(e instanceof RateLimitedError)) console.error(`describeVideo via ${id} failed`, e);
      }
    }
    return null;
  }

  /** 知識庫：同一個網址再存就更新原本那筆 */
  noteSave(n: { title: string; summary: string; content?: string; url?: string; tags?: string[]; thumb?: string }, author: string, inbox = true) {
    if (!n.title.trim() || !n.summary.trim()) return { error: "標題和摘要不能是空的" };
    const tags = JSON.stringify(n.tags ?? []);
    const old = n.url ? this.sql.exec("SELECT id FROM notes WHERE url = ?", n.url).toArray()[0] : undefined;
    let id: number;
    if (old) {
      id = Number(old.id);
      this.sql.exec("UPDATE notes SET ts = ?, title = ?, summary = ?, content = COALESCE(?, content), tags = ? WHERE id = ?", Date.now(), n.title, n.summary, n.content ?? null, tags, id);
    } else {
      id = Number(this.sql.exec("INSERT INTO notes (ts, author, title, summary, content, url, tags, thumb, inbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", Date.now(), author, n.title, n.summary, n.content ?? null, n.url ?? null, tags, n.thumb ?? null, inbox ? 1 : 0).one().id);
    }
    this.broadcastState();
    if (this.isPersonal()) this.ctx.waitUntil(this.syncEmbeddings());
    return { saved_id: id, updated: !!old, note: "已存進 工具箱 → 知識庫" };
  }

  /** 知識庫搜尋：關鍵字（標題、摘要、原文、標籤）＋雙字詞相似度＋語意（用詞不同、意思相近也找得到） */
  async noteSearch(keyword: string) {
    const rows = [
      ...this.sql.exec("SELECT 'note' AS kind, id, ts, title, summary, content, url, tags FROM notes ORDER BY ts DESC").toArray(),
      ...this.sql.exec("SELECT 'doc' AS kind, d.id, d.ts, d.title, d.note AS summary, f.name AS content, NULL AS url, '[]' AS tags FROM documents d LEFT JOIN doc_folders f ON f.id = d.folder_id ORDER BY d.ts DESC").toArray(),
    ];
    const fmt = (r: Record<string, SqlStorageValue>) =>
      r.kind === "doc"
        ? { type: "保管箱照片文件", ref: `#doc-${r.id}`, date: this.localTime(Number(r.ts)).slice(0, 10), title: r.title, summary: String(r.summary ?? ""), folder: r.content }
        : { type: "知識庫", ref: `#note-${r.id}`, date: this.localTime(Number(r.ts)).slice(0, 10), title: r.title, summary: String(r.summary).slice(0, 600), url: r.url, tags: JSON.parse(String(r.tags || "[]")) };
    const k = keyword.trim().toLowerCase();
    if (!k) return { found: rows.length, notes: rows.filter((r) => r.kind === "note").slice(0, 8).map(fmt) };
    const words = k.split(/\s+/).filter(Boolean);
    const q = bigrams(k);
    const sims = this.isPersonal() ? await this.similarity(k, ["note", "doc", "chunk"]) : null;
    const scored = rows
      .map((r) => {
        const text = `${r.title} ${r.summary} ${r.content ?? ""} ${r.tags}`.toLowerCase();
        const exact = words.every((w) => text.includes(w)) ? 2 : 0;
        const g = bigrams(text);
        let hit = 0;
        for (const x of q) if (g.has(x)) hit++;
        return { r, score: exact + (q.size ? hit / q.size : 0) + semanticBoost(sims?.get(`${r.kind}:${r.id}`)) };
      })
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    // 文件、錄音逐字稿裡最相關的原文段落：問細節要靠這個（摘要不會寫到每個條款）
    const passages = this.isPersonal() ? this.searchPassages(words, sims) : [];
    if (!scored.length && !passages.length) return { found: 0, note: "知識庫裡找不到相關的內容" };
    return { found: scored.length, notes: scored.map((x) => fmt(x.r)), ...(passages.length ? { passages } : {}) };
  }

  // ================= 相片、帳目下載 =================

  /** 相片：大家在聊天傳的照片和票券照片，依日期分組 */
  private photoList(): Response {
    const size = new Map(this.sql.exec("SELECT id, ts, author, LENGTH(data) AS n FROM photos").toArray().map((r) => [String(r.id), { ts: Number(r.ts), n: Number(r.n) }]));
    const items = new Map<string, { id: string; ts: number; by: string; bytes: number; ticket?: string }>();
    for (const m of photoRows(this.sql.exec<MessageRow>("SELECT * FROM messages WHERE photo_id IS NOT NULL AND role = 'user' ORDER BY ts").toArray())) {
      const s = size.get(m.photo_id as string);
      if (s && !items.has(m.photo_id as string)) items.set(m.photo_id as string, { id: m.photo_id as string, ts: m.ts, by: m.author, bytes: s.n });
    }
    for (const d of this.sql.exec("SELECT photo_id, title, author FROM documents WHERE photo_id IS NOT NULL").toArray()) {
      const id = String(d.photo_id), s = size.get(id);
      if (!s) continue;
      const cur = items.get(id);
      if (cur) cur.ticket = String(d.title);
      else items.set(id, { id, ts: s.ts, by: String(d.author), bytes: s.n, ticket: String(d.title) });
    }
    const days = new Map<string, { date: string; bytes: number; photos: { id: string; time: string; by: string; ticket?: string }[] }>();
    for (const x of [...items.values()].sort((a, b) => a.ts - b.ts)) {
      const date = zoned(x.ts, this.p().timezone).date;
      const day = days.get(date) ?? { date, bytes: 0, photos: [] };
      day.photos.push({ id: x.id, time: zoned(x.ts, this.p().timezone).time, by: x.by, ...(x.ticket ? { ticket: x.ticket } : {}) });
      day.bytes += x.bytes;
      days.set(date, day);
    }
    const total = Number(this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM photos").one().n);
    return Response.json({ ok: true, count: items.size, bytes: total, limit: PHOTO_BYTES_LIMIT, days: [...days.values()].reverse() });
  }

  /** 帳目下載成 CSV：Excel、Google 試算表都能開（開頭加 BOM 中文才不會亂碼） */
  private expensesCsv(): Response {
    // 文字欄位開頭是 = + - @ 會被 Excel 當成公式，前面補一個 '
    const cell = (v: unknown) => {
      let s = String(v ?? "");
      if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const line = (xs: unknown[]) => xs.map(cell).join(",");
    const out = [line(["日期", "項目", "分類", "金額", "幣別", "換算當地幣別", "約合台幣", "付款人", "分攤", "記錄的人"])];
    for (const r of this.sql.exec("SELECT * FROM expenses ORDER BY date, ts").toArray()) {
      let split = "";
      try {
        split = (JSON.parse(String(r.split_among || "[]")) as string[]).join("、");
      } catch {}
      out.push(line([r.date, r.description, r.category, r.amount, r.currency, r.amount_local, r.amount_twd, r.payer, split, r.author]));
    }
    const s = this.expenseSummary();
    if (s.balance.length) {
      out.push("", line(["結算", "已付", "應分攤", "差額（正數＝要收回）"]));
      for (const b of s.balance) out.push(line([b.name, b.paid, b.share, b.net]));
      for (const t of s.transfers) out.push(line([`${t.from} 給 ${t.to}`, t.amount]));
    }
    const name = `${this.p().title}-帳目.csv`.replace(/[\\/:*?"<>|]/g, "");
    return new Response("\uFEFF" + out.join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="expenses.csv"; filename*=UTF-8''${encodeURIComponent(name)}`, "cache-control": "no-store" },
    });
  }

  // ================= 語意搜尋：知識庫、保管箱、記憶的向量（Workers AI bge-m3，存在這個空間自己的資料庫） =================

  private async embedTexts(texts: string[]): Promise<Float32Array[] | null> {
    if (!texts.length) return [];
    if (await this.workersAiBlocked()) return null;
    try {
      const r = (await this.env.AI.run("@cf/baai/bge-m3" as any, { text: texts })) as { data?: number[][] };
      const data = r?.data ?? [];
      return data.length === texts.length ? data.map((v) => Float32Array.from(v)) : null;
    } catch (e) {
      if (isQuotaError(e)) this.noteQuota(new WorkersAiQuotaError());
      else console.error("embedding failed", e);
      return null;
    }
  }

  /** 要算向量的東西：知識庫（標題＋標籤＋摘要）、保管箱的照片文件、有效的記憶 */
  private embedSources(): { key: string; kind: string; ref: number; text: string }[] {
    const out: { key: string; kind: string; ref: number; text: string }[] = [];
    for (const n of this.sql.exec("SELECT id, title, summary, tags FROM notes").toArray()) {
      let tags = "";
      try {
        tags = (JSON.parse(String(n.tags || "[]")) as string[]).join("、");
      } catch {}
      out.push({ key: `note:${n.id}`, kind: "note", ref: Number(n.id), text: `${n.title}\n${tags}\n${n.summary}`.slice(0, 1500) });
    }
    for (const d of this.sql.exec("SELECT id, title, note FROM documents").toArray()) {
      out.push({ key: `doc:${d.id}`, kind: "doc", ref: Number(d.id), text: `${d.title}\n${d.note ?? ""}`.slice(0, 800) });
    }
    for (const m of this.memories()) out.push({ key: `memory:${m.id}`, kind: "memory", ref: Number(m.id), text: String(m.content).slice(0, 500) });
    return out;
  }

  private embedBusy = false;
  /** 新增、改過的才重算，刪掉的順便清掉；一次最多 max 筆（Workers AI 額度用完就等下次） */
  private async syncEmbeddings(max = 60) {
    if (this.embedBusy) return;
    this.embedBusy = true;
    try {
      const have = new Map(this.sql.exec("SELECT kind, ref, hash FROM embeddings WHERE kind != 'chunk'").toArray().map((r) => [`${r.kind}:${r.ref}`, String(r.hash)]));
      const src = this.embedSources().map((x) => ({ ...x, hash: textHash(x.text) }));
      const live = new Set(src.map((x) => x.key));
      for (const k of have.keys()) {
        if (live.has(k)) continue;
        const [kind, ref] = k.split(":");
        this.sql.exec("DELETE FROM embeddings WHERE kind = ? AND ref = ?", kind, Number(ref));
      }
      const todo = src.filter((x) => have.get(x.key) !== x.hash).slice(0, max);
      for (let i = 0; i < todo.length; i += 20) {
        const batch = todo.slice(i, i + 20);
        const vecs = await this.embedTexts(batch.map((b) => b.text));
        if (!vecs) break;
        batch.forEach((b, k) => this.sql.exec("INSERT OR REPLACE INTO embeddings (kind, ref, hash, vec) VALUES (?, ?, ?, ?)", b.kind, b.ref, b.hash, vecs[k].buffer));
      }
    } catch (e) {
      console.error("syncEmbeddings failed", e);
    } finally {
      this.embedBusy = false;
    }
  }

  /** 問句跟每一筆的語意相似度（0–1）；Workers AI 不能用時回 null，搜尋就只看關鍵字 */
  private async similarity(text: string, kinds: string[]): Promise<Map<string, number> | null> {
    const list = kinds.map(() => "?").join(", ");
    if (!this.sql.exec(`SELECT 1 FROM embeddings WHERE kind IN (${list}) LIMIT 1`, ...kinds).toArray().length) return null;
    const q = (await this.embedTexts([text.slice(0, 500)]))?.[0];
    if (!q) return null;
    const out = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT kind, ref, vec FROM embeddings WHERE kind IN (${list})`, ...kinds).toArray()) out.set(`${r.kind}:${r.ref}`, cosine(q, new Float32Array(r.vec as ArrayBuffer)));
    return out;
  }

  /** 記憶很多時，挑跟這次對話最相關的放進提示詞：先把問句的語意算好 */
  private memQuery: { text: string; sims: Map<string, number> } | null = null;
  private async prepareMemoryQuery(text: string) {
    this.memQuery = null;
    if (!text.trim() || this.memories().length <= 40) return;
    // 還沒算向量的記憶在背景補（第一次超過 40 條、或剛整理完一批）
    this.ctx.waitUntil(this.syncEmbeddings(500));
    const sims = await this.similarity(text, ["memory"]);
    if (sims) this.memQuery = { text, sims };
  }

  // ================= 語音備忘：錄音分段上傳 → 逐段轉文字（Gemini 優先，Whisper 備援）→ 整理重點、待辦，存進知識庫 =================

  private async memoStart(req: Request, author: string): Promise<Response> {
    const b = (await req.json().catch(() => ({}))) as { mime?: string; title?: string; source?: string };
    const mime = String(b.mime ?? "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_MIME.test(mime)) return Response.json({ ok: false, error: "不支援這種檔案，請選錄音檔" }, { status: 400 });
    const open = this.sql.exec("SELECT COUNT(*) AS n FROM memos WHERE status = 'recording'").one().n as number;
    if (open >= 3) return Response.json({ ok: false, error: "還有好幾段錄音沒結束，請先停止再開始新的" }, { status: 429 });
    const id = this.sql
      .exec(
        "INSERT INTO memos (ts, author, title, status, mime, source, updated) VALUES (?, ?, ?, 'recording', ?, ?, ?) RETURNING id",
        Date.now(), author, String(b.title ?? "").trim().slice(0, 60), mime, b.source === "file" ? "file" : "rec", Date.now(),
      )
      .one().id as number;
    this.broadcastState();
    return Response.json({ ok: true, id });
  }

  private async memoSegment(id: number, url: URL, req: Request): Promise<Response> {
    const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
    const m = this.sql.exec("SELECT status FROM memos WHERE id = ?", id).toArray()[0];
    if (!m) return fail("找不到這段錄音", 404);
    if (m.status !== "recording") return fail("這段錄音已經結束", 409);
    const n = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
    const seq = n("seq", 0), part = n("part", 0), parts = n("parts", 1);
    if (![seq, part, parts].every(Number.isInteger) || seq < 0 || seq > 300 || parts < 1 || parts > 20 || part < 0 || part >= parts) return fail("上傳參數不正確");
    const data = new Uint8Array(await req.arrayBuffer());
    if (data.byteLength > 10_000_000) return fail("這一塊太大", 413);
    const last = url.searchParams.get("last") === "1" && part === parts - 1;
    if (data.byteLength) {
      this.trimMemoAudio(data.byteLength);
      const used = this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM memo_audio").one().n as number;
      if (used + data.byteLength > MEMO_KEEP_BYTES) return fail("還有太多錄音在排隊轉文字，請稍後再傳", 507);
      // Durable Object 的資料庫一格最多 2MB：切成 1.5MB 一塊存（編號＝第幾塊上傳×100＋第幾小塊）
      for (let off = 0, k = 0; off < data.byteLength; off += 1_500_000, k++) {
        this.sql.exec("INSERT OR REPLACE INTO memo_audio (memo_id, seq, part, data) VALUES (?, ?, ?, ?)", id, seq, part * 100 + k, data.slice(off, off + 1_500_000).buffer);
      }
      if (part === parts - 1) {
        const bytes = this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM memo_audio WHERE memo_id = ? AND seq = ?", id, seq).one().n as number;
        const seconds = Math.max(0, Math.min(6 * 3600, n("seconds", 0) || 0));
        this.sql.exec(
          "INSERT INTO memo_segs (memo_id, seq, bytes, seconds, status, tries) VALUES (?, ?, ?, ?, 'pending', 0) ON CONFLICT(memo_id, seq) DO UPDATE SET bytes = excluded.bytes, seconds = excluded.seconds, status = 'pending', tries = 0",
          id, seq, bytes, seconds,
        );
      }
    } else if (!last) return fail("沒有收到音檔");
    const segs = this.sql.exec("SELECT COUNT(*) AS n FROM memo_segs WHERE memo_id = ?", id).one().n as number;
    this.sql.exec("UPDATE memos SET segs = ?, updated = ?, ended = ?, status = ? WHERE id = ?", segs, Date.now(), last ? 1 : 0, last ? "processing" : "recording", id);
    this.broadcastState();
    this.kickMemos();
    return Response.json({ ok: true });
  }

  // ================= 知識庫上傳文件：Cloudflare 轉文字（免費）→ AI 整理重點 → 切段做語意搜尋 =================

  private async fileStart(req: Request, author: string): Promise<Response> {
    const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
    const b = (await req.json().catch(() => ({}))) as { name?: string; size?: number };
    const name = String(b.name ?? "").trim().replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 120);
    const ext = extOf(name);
    if (!DOC_MIME[ext] && !TEXT_EXT.has(ext)) {
      return fail(ext === "doc" || ext === "ppt" ? "舊版的 .doc／.ppt 讀不了，請先另存成 .docx／.pptx 或 PDF" : "這種檔案還不能讀：支援 PDF、Word、PPT、Excel、CSV、MD、TXT");
    }
    const size = Number(b.size) || 0;
    if (size <= 0 || size > FILE_MAX_BYTES) return fail("檔案太大，單檔上限 20MB", 413);
    const used = this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM file_data").one().n as number;
    if (used + size > FILE_KEEP_BYTES) return fail("文件空間滿了（每人 300MB），請先刪掉一些不需要的文件", 507);
    const id = this.sql
      .exec("INSERT INTO files (ts, author, name, mime, bytes, status, updated) VALUES (?, ?, ?, ?, ?, 'uploading', ?) RETURNING id", Date.now(), author, name, DOC_MIME[ext] ?? "text/plain; charset=utf-8", size, Date.now())
      .one().id as number;
    this.broadcastState();
    return Response.json({ ok: true, id });
  }

  private async filePart(id: number, url: URL, req: Request): Promise<Response> {
    const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
    const f = this.sql.exec("SELECT status FROM files WHERE id = ?", id).toArray()[0];
    if (!f) return fail("找不到這個檔案", 404);
    if (f.status !== "uploading") return fail("這個檔案已經傳完了", 409);
    const part = Number(url.searchParams.get("part") ?? 0), parts = Number(url.searchParams.get("parts") ?? 1);
    if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 10 || part < 0 || part >= parts) return fail("上傳參數不正確");
    const data = new Uint8Array(await req.arrayBuffer());
    if (!data.byteLength || data.byteLength > 10_000_000) return fail("這一塊太大或是空的", 413);
    // 資料庫一格最多 2MB：切成 1.5MB 一塊存（編號＝第幾塊上傳×100＋第幾小塊）
    for (let off = 0, k = 0; off < data.byteLength; off += 1_500_000, k++) {
      this.sql.exec("INSERT OR REPLACE INTO file_data (file_id, part, data) VALUES (?, ?, ?)", id, part * 100 + k, data.slice(off, off + 1_500_000).buffer);
    }
    const got = this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM file_data WHERE file_id = ?", id).one().n as number;
    if (got > FILE_MAX_BYTES + 1_000_000) {
      this.deleteFile(id);
      this.broadcastState();
      return fail("檔案太大，單檔上限 20MB", 413);
    }
    if (part === parts - 1) {
      this.sql.exec("UPDATE files SET status = 'processing', bytes = ?, updated = ? WHERE id = ?", got, Date.now(), id);
      this.broadcastState();
      this.kickFiles();
    }
    return Response.json({ ok: true });
  }

  /** 下載原檔：一塊一塊串流出去 */
  private fileDownload(id: number): Response {
    const f = this.sql.exec("SELECT name, mime FROM files WHERE id = ?", id).toArray()[0];
    const parts = this.sql.exec("SELECT part, LENGTH(data) AS n FROM file_data WHERE file_id = ? ORDER BY part", id).toArray().map((r) => Number(r.part));
    if (!f || !parts.length) return new Response("檔案已經刪除", { status: 404 });
    const total = this.sql.exec("SELECT SUM(LENGTH(data)) AS n FROM file_data WHERE file_id = ?", id).one().n as number;
    const sql = this.sql;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= parts.length) return controller.close();
        controller.enqueue(new Uint8Array(sql.exec("SELECT data FROM file_data WHERE file_id = ? AND part = ?", id, parts[i++]).one().data as ArrayBuffer));
      },
    });
    const mime = String(f.mime || "application/octet-stream");
    // PDF、圖片、純文字在網頁裡直接開；Office 檔（PPTX、DOCX、XLSX…）手機網頁開不了（一片空白），
    // HTML 在網頁裡開會在 App 的網址下執行程式，一律改成下載
    const inline = /^(application\/pdf|image\/|text\/plain)/.test(mime);
    const ext = (String(f.name).match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? "").toLowerCase();
    return new Response(body, {
      headers: {
        "content-type": mime,
        "content-length": String(total),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="file${ext}"; filename*=UTF-8''${encodeURIComponent(String(f.name))}`,
        // 上傳的檔案不准在 App 的網址下執行程式（PDF 例外：Chrome 的 PDF 檢視器遇到 sandbox 會整頁擋掉）
        ...(mime === "application/pdf" ? {} : { "content-security-policy": "sandbox" }),
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
      },
    });
  }

  private deleteFile(id: number) {
    this.sql.exec("DELETE FROM file_data WHERE file_id = ?", id);
    this.sql.exec("DELETE FROM files WHERE id = ?", id);
  }

  private fileBusy = false;
  private kickFiles() {
    this.ctx.waitUntil(this.processFiles());
  }

  private nextFileWork(): number | null {
    return this.sql.exec("SELECT 1 FROM files WHERE status = 'processing' LIMIT 1").toArray().length ? Date.now() + 15_000 : null;
  }

  private async processFiles() {
    if (this.fileBusy || !this.isPersonal()) return;
    this.fileBusy = true;
    try {
      // 上傳到一半就斷掉（沒傳完）超過一天的：刪掉
      for (const f of this.sql.exec("SELECT id FROM files WHERE status = 'uploading' AND updated < ?", Date.now() - 86400_000).toArray()) this.deleteFile(Number(f.id));
      for (let i = 0; i < 5; i++) {
        const f = this.sql.exec("SELECT * FROM files WHERE status = 'processing' ORDER BY id LIMIT 1").toArray()[0];
        if (!f) break;
        await this.readFile(f);
      }
      await this.embedChunks();
    } catch (e) {
      console.error("processFiles failed", e);
    } finally {
      this.fileBusy = false;
    }
  }

  /** 讀一個上傳的檔案：轉文字 → 整理標題、重點、標籤 → 存進知識庫（全文＋原檔）→ 切段算向量 */
  private async readFile(f: Record<string, SqlStorageValue>) {
    const id = Number(f.id);
    const name = String(f.name);
    const ext = extOf(name);
    try {
      const bytes = concatBytes(this.sql.exec("SELECT data FROM file_data WHERE file_id = ? ORDER BY part", id).toArray().map((r) => new Uint8Array(r.data as ArrayBuffer)));
      let text = "", pages = 0, method = "cloudflare";
      if (TEXT_EXT.has(ext)) {
        text = new TextDecoder().decode(bytes);
        method = "text";
      } else {
        let md = "";
        try {
          const r = (await this.env.AI.toMarkdown([{ name, blob: new Blob([bytes], { type: DOC_MIME[ext] }) }])) as { format: string; data?: string; error?: string }[];
          if (r[0]?.format === "error") throw new Error(r[0].error || "轉換失敗");
          md = String(r[0]?.data ?? "");
        } catch (e) {
          // PPT 官方沒列在支援清單：轉不出來就自己解
          if (ext !== "pptx") throw new Error(`這個檔案讀不出來（${String((e as Error)?.message ?? e).slice(0, 80)}）`);
        }
        if (md) ({ text, pages } = cleanMarkdown(md, ext));
        if (ext === "pptx" && !text.trim()) {
          text = await pptxText(bytes);
          pages = (text.match(/【第 \d+ 張投影片】/g) || []).length;
          method = "pptx";
        }
      }
      // 掃描版 PDF（整頁是圖）或 Cloudflare 漏掉內文：改請 Gemini 看 PDF
      if (ext === "pdf" && looksScanned(text, pages)) {
        const scanned = await this.readPdfWithGemini(bytes);
        if (scanned) {
          text = scanned;
          method = "gemini";
        } else if (!text.replace(/【第 \d+ 頁】/g, "").trim()) {
          throw new Error(
            this.setting("voice_engine", "gemini") === "private"
              ? "這份 PDF 是掃描檔（只有圖片），隱私模式不能請 Gemini 讀，請改成一般模式或傳文字版"
              : "這份 PDF 是掃描檔（只有圖片），要有 Gemini 金鑰才能讀；額度用完的話晚點按重試",
          );
        }
      }
      if (!text.trim()) throw new Error("檔案裡沒有文字");
      const owner = this.p().travelers[0]?.name || "使用者";
      const priv = this.setting("voice_engine", "gemini") === "private";
      const cap = priv ? 20_000 : 60_000;
      const prompt = `下面是${owner}上傳的文件「${name}」的內容${pages ? `（${pages} ${ext === "pptx" ? "張投影片" : "頁"}）` : ""}。請整理成 JSON：
{"title": "20 字內的標題，說清楚是什麼文件", "summary": "重點摘要，Markdown 條列 3–8 點，寫具體的數字、日期、金額、人名、條款", "tags": ["2–5 個標籤"]}
只根據內容，不要編造。

內容：
${text.length > cap ? `${text.slice(0, cap)}\n…（後面省略）` : text}`;
      let j: Record<string, any> = {};
      try {
        const system = "你是幫忙整理文件的助理，只根據內容，只輸出 JSON。";
        const raw = priv
          ? (await (await this.provider("workers-ai")).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }], json: true, maxTokens: 2048 })).text
          : await this.generateText(system, prompt, true, 1, 2048);
        j = parseArgs(raw.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as Record<string, any>;
      } catch (e) {
        console.error("file summary failed", e);
      }
      const title = (String(j.title ?? "").trim() || name.replace(/\.[^.]+$/, "")).slice(0, 60);
      const summary = String(j.summary ?? "").trim().slice(0, 3000) || "（AI 暫時不能整理重點，全文已經存好，可以直接問內容）";
      const tags = (Array.isArray(j.tags) ? j.tags : []).map((t: unknown) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 5);
      const noteId = (this.noteSave({ title: `📄 ${title}`, summary, content: text.slice(0, 400_000), tags: [...new Set([...tags, "文件"])] }, String(f.author), false) as { saved_id?: number }).saved_id ?? 0;
      this.sql.exec("UPDATE notes SET file_id = ? WHERE id = ?", id, noteId);
      this.indexNoteChunks(noteId, text);
      this.sql.exec("UPDATE files SET status = 'done', note_id = ?, method = ?, pages = ?, chars = ?, error = NULL, updated = ? WHERE id = ?", noteId, method, pages, text.length, Date.now(), id);
      this.postAiMessage(
        `📄 **文件整理好了｜${title}**\n\n${summary}\n\n全文和原檔已存進[知識庫](#note-${noteId})，可以直接問我裡面的內容。`,
        { kind: "file" },
      );
      this.broadcastState();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      console.error(`readFile ${name} failed`, msg);
      this.sql.exec("UPDATE files SET status = 'error', error = ?, updated = ? WHERE id = ?", msg, Date.now(), id);
      this.broadcastState();
    }
  }

  /** 掃描版 PDF：請 Gemini 看整份 PDF 轉成文字（隱私模式、沒有金鑰、額度用完都回 null） */
  private async readPdfWithGemini(bytes: Uint8Array): Promise<string | null> {
    if (this.setting("voice_engine", "gemini") === "private") return null;
    const key = (await this.keys()).gemini;
    if (!key) return null;
    try {
      const media = bytes.byteLength <= GEMINI_INLINE_MAX
        ? { mime: "application/pdf", data: toBase64(bytes.buffer as ArrayBuffer) }
        : { mime: "application/pdf", uri: await uploadGeminiFile(key, bytes, "application/pdf") };
      const r = await (await this.provider("gemini-own", 1, 30_000)).generate({
        system: "你是把文件轉成文字的助手，只輸出文件內容。",
        turns: [{ role: "user", parts: [{ media }, { text: "把這份 PDF 的內容完整轉成 Markdown：保留標題、條列和表格，每一頁開頭單獨一行寫【第 N 頁】。照片或圖表用一句話描述。不要摘要、不要加任何說明。" }] }],
        timeoutMs: 300_000,
      });
      return r.text.replace(/^\s*```(?:markdown)?|```\s*$/g, "").replace(/^\s*【第 (\d+) 頁】\s*$/gm, "\n【第 $1 頁】\n").trim() || null;
    } catch (e) {
      console.error("readPdfWithGemini failed", String((e as Error)?.message ?? e).slice(0, 200));
      return null;
    }
  }

  /** 長文切段存起來（文件、錄音逐字稿），語意搜尋才找得到細節 */
  private indexNoteChunks(noteId: number, text: string) {
    this.dropNoteChunks(noteId);
    chunkText(text).slice(0, 3000).forEach((t, i) => this.sql.exec("INSERT INTO note_chunks (note_id, seq, text) VALUES (?, ?, ?)", noteId, i, t));
    this.ctx.waitUntil(this.embedChunks());
  }

  private dropNoteChunks(noteId: number) {
    this.sql.exec("DELETE FROM embeddings WHERE kind = 'chunk' AND ref IN (SELECT id FROM note_chunks WHERE note_id = ?)", noteId);
    this.sql.exec("DELETE FROM note_chunks WHERE note_id = ?", noteId);
  }

  private chunkBusy = false;
  /** 還沒算向量的段落：一次 20 段，額度用完就等下次 */
  private async embedChunks(max = 600) {
    if (this.chunkBusy) return;
    this.chunkBusy = true;
    try {
      for (let done = 0; done < max; ) {
        const rows = this.sql.exec("SELECT id, text FROM note_chunks WHERE embedded = 0 ORDER BY id LIMIT 20").toArray();
        if (!rows.length) break;
        const vecs = await this.embedTexts(rows.map((r) => String(r.text).slice(0, 1500)));
        if (!vecs) break;
        rows.forEach((r, k) => {
          this.sql.exec("INSERT OR REPLACE INTO embeddings (kind, ref, hash, vec) VALUES ('chunk', ?, '', ?)", r.id, vecs[k].buffer);
          this.sql.exec("UPDATE note_chunks SET embedded = 1 WHERE id = ?", r.id);
        });
        done += rows.length;
      }
    } catch (e) {
      console.error("embedChunks failed", e);
    } finally {
      this.chunkBusy = false;
    }
  }

  /** 找原文段落：語意相近，或包含關鍵字 */
  private searchPassages(words: string[], sims: Map<string, number> | null) {
    const score = new Map<number, number>();
    for (const [key, sim] of sims ?? []) {
      if (!key.startsWith("chunk:")) continue;
      const b = semanticBoost(sim);
      if (b > 0) score.set(Number(key.slice(6)), b);
    }
    for (const w of words.filter((x) => x.length >= 2).slice(0, 4)) {
      for (const r of this.sql.exec("SELECT id FROM note_chunks WHERE text LIKE ? LIMIT 30", `%${w}%`).toArray()) score.set(Number(r.id), (score.get(Number(r.id)) ?? 0) + 1);
    }
    return [...score]
      .filter(([, s]) => s >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .flatMap(([id]) => this.sql.exec("SELECT c.note_id, c.text, n.title FROM note_chunks c JOIN notes n ON n.id = c.note_id WHERE c.id = ?", id).toArray())
      .map((r) => ({ ref: `#note-${r.note_id}`, from: String(r.title), page: String(r.text).match(/^【第 (\d+) (?:頁|張投影片)】/)?.[1] ?? null, text: String(r.text).slice(0, 900) }));
  }

  /** 錄音超過上限：從最舊的（已經整理好的）開始刪音檔，逐字稿留著；還在排隊轉文字的不刪 */
  private trimMemoAudio(extra = 0) {
    const used = () => this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM memo_audio").one().n as number;
    while (used() + extra > MEMO_KEEP_BYTES) {
      const old = this.sql.exec("SELECT id FROM memos WHERE status IN ('done', 'error') AND id IN (SELECT memo_id FROM memo_audio) ORDER BY updated LIMIT 1").toArray()[0];
      if (!old) return;
      this.sql.exec("DELETE FROM memo_audio WHERE memo_id = ?", old.id);
    }
  }

  /** 回放錄音的某一段：支援 Range（iPhone 的播放器一定要），一塊一塊從資料庫串流出去，不整個讀進記憶體 */
  private memoAudio(id: number, seq: number, req: Request): Response {
    const m = this.sql.exec("SELECT mime FROM memos WHERE id = ?", id).toArray()[0];
    const parts = this.sql.exec("SELECT part, LENGTH(data) AS n FROM memo_audio WHERE memo_id = ? AND seq = ? ORDER BY part", id, seq).toArray().map((r) => ({ part: Number(r.part), n: Number(r.n) }));
    if (!m || !parts.length) return new Response("錄音檔已經刪除", { status: 404 });
    const total = parts.reduce((a, p) => a + p.n, 0);
    let start = 0, end = total - 1;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
    if (range) {
      if (range[1] === "") start = Math.max(0, total - Number(range[2] || 0));
      else {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), total - 1);
      }
      if (start > end || start >= total) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
    const sql = this.sql;
    let i = 0, offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        while (i < parts.length) {
          const p = parts[i++];
          const from = offset;
          offset += p.n;
          if (offset <= start) continue;
          if (from > end) break;
          const data = new Uint8Array(sql.exec("SELECT data FROM memo_audio WHERE memo_id = ? AND seq = ? AND part = ?", id, seq, p.part).one().data as ArrayBuffer);
          controller.enqueue(data.subarray(Math.max(0, start - from), Math.min(p.n, end - from + 1)));
          return;
        }
        controller.close();
      },
    });
    const headers: Record<string, string> = {
      "content-type": String(m.mime || "audio/webm"),
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${total}`;
    return new Response(body, { status: range ? 206 : 200, headers });
  }

  private memoBusy = false;
  private kickMemos() {
    this.ctx.waitUntil(this.processMemos());
  }

  /** 下一次要處理錄音的時間（排程用）：有段落在排隊就 15 秒後；額度用完在等就等到重試時間 */
  private nextMemoWork(): number | null {
    const waiting =
      this.sql.exec("SELECT 1 FROM memo_segs s JOIN memos m ON m.id = s.memo_id WHERE s.status = 'pending' AND m.status IN ('recording', 'processing') LIMIT 1").toArray().length ||
      this.sql.exec("SELECT 1 FROM memos WHERE status = 'processing' AND ended = 1 LIMIT 1").toArray().length;
    if (!waiting) return null;
    return Math.max(Date.now() + 15_000, Number(this.setting("memo_retry_at", "0")));
  }

  private async processMemos() {
    if (this.memoBusy || !this.isPersonal()) return;
    if (Date.now() < Number(this.setting("memo_retry_at", "0"))) return;
    this.memoBusy = true;
    try {
      // 錄到一半斷線（手機沒電、關掉 App）：6 小時沒有新的段落就當作錄完，用已經收到的整理
      this.sql.exec("UPDATE memos SET ended = 1, status = 'processing' WHERE status = 'recording' AND updated < ?", Date.now() - 6 * 3600_000);
      for (let i = 0; i < 40; i++) {
        const seg = this.sql
          .exec("SELECT s.memo_id, s.seq, s.tries, m.mime FROM memo_segs s JOIN memos m ON m.id = s.memo_id WHERE s.status = 'pending' AND m.status IN ('recording', 'processing') ORDER BY s.memo_id, s.seq LIMIT 1")
          .toArray()[0];
        if (!seg) break;
        if ((await this.transcribeSegment(Number(seg.memo_id), Number(seg.seq), String(seg.mime), Number(seg.tries))) === "later") return;
      }
      for (const m of this.sql.exec("SELECT id FROM memos WHERE status = 'processing' AND ended = 1").toArray()) {
        const left = this.sql.exec("SELECT COUNT(*) AS n FROM memo_segs WHERE memo_id = ? AND status = 'pending'", m.id).one().n as number;
        if (!left) await this.finishMemo(Number(m.id));
      }
    } catch (e) {
      console.error("processMemos failed", e);
    } finally {
      this.memoBusy = false;
    }
  }

  /** 轉一段錄音：done＝轉好了；later＝AI 額度暫時用完（音檔留著，晚點自動再試）；failed＝這次失敗（最多試 3 次） */
  private async transcribeSegment(memoId: number, seq: number, mime: string, tries: number): Promise<"done" | "later" | "failed"> {
    const audio = concatBytes(this.sql.exec("SELECT data FROM memo_audio WHERE memo_id = ? AND seq = ? ORDER BY part", memoId, seq).toArray().map((r) => new Uint8Array(r.data as ArrayBuffer)));
    const seconds = Number(this.sql.exec("SELECT seconds FROM memo_segs WHERE memo_id = ? AND seq = ?", memoId, seq).toArray()[0]?.seconds) || 0;
    const priv = this.setting("voice_engine", "gemini") === "private";
    const engines: ("gemini" | "whisper")[] = [];
    if (!priv && (await this.keys()).gemini) engines.push("gemini");
    if (audio.byteLength <= WHISPER_MAX) engines.push("whisper");
    let lastError = !audio.byteLength
      ? "音檔不見了"
      : engines.length ? "" : priv ? "隱私模式只能轉 9MB 以內的檔案（在 App 裡直接錄音沒有限制）" : "檔案太大，要有 Gemini 金鑰才能轉";
    let limited = 0;
    for (const engine of audio.byteLength ? engines : []) {
      try {
        const text = formatTranscript(engine === "gemini" ? await this.transcribeGemini(audio, mime, seconds) : await this.transcribeWhisper(audio));
        this.sql.exec("UPDATE memo_segs SET status = 'done', text = ?, engine = ? WHERE memo_id = ? AND seq = ?", text, engine, memoId, seq);
        this.sql.exec("UPDATE memos SET done_segs = done_segs + 1, error = NULL, updated = ? WHERE id = ?", Date.now(), memoId);
        this.broadcastState();
        return "done";
      } catch (e: any) {
        lastError = String(e?.message ?? e).slice(0, 300);
        if (e instanceof RateLimitedError || e instanceof WorkersAiQuotaError || /Gemini (429|503)/.test(lastError)) limited++;
        else console.error(`transcribe via ${engine} failed`, lastError);
      }
    }
    if (engines.length && limited === engines.length) {
      // 每個引擎都是額度用完：5 分鐘後自動再試，不算失敗次數
      this.setSetting("memo_retry_at", String(Date.now() + 5 * 60_000));
      this.sql.exec("UPDATE memos SET error = ? WHERE id = ?", "AI 額度暫時用完，稍後會自動再試", memoId);
      this.broadcastState();
      return "later";
    }
    const giveUp = tries + 1 >= 3 || !engines.length || !audio.byteLength;
    this.sql.exec("UPDATE memo_segs SET tries = tries + 1, status = ?, text = ? WHERE memo_id = ? AND seq = ?", giveUp ? "failed" : "pending", giveUp ? lastError : null, memoId, seq);
    if (giveUp) this.sql.exec("UPDATE memos SET done_segs = done_segs + 1, error = ?, updated = ? WHERE id = ?", lastError, Date.now(), memoId);
    this.broadcastState();
    return "failed";
  }

  private async transcribeGemini(audio: Uint8Array, mime: string, seconds: number): Promise<string> {
    const key = (await this.keys()).gemini;
    const type = geminiMime(mime);
    const media =
      audio.byteLength <= GEMINI_INLINE_MAX
        ? { mime: type, data: toBase64(audio.buffer as ArrayBuffer), seconds: seconds || undefined }
        : { mime: type, uri: await uploadGeminiFile(key, audio, type), seconds: seconds || undefined };
    const r = await (await this.provider("gemini-own", 1, 30_000)).generate({
      system: "你是專業的逐字稿聽打員，只輸出逐字稿。",
      turns: [{ role: "user", parts: [{ media }, { text: TRANSCRIBE_PROMPT }] }],
      timeoutMs: 300_000,
    });
    return r.text.trim() || "（沒有聲音）";
  }

  private async transcribeWhisper(audio: Uint8Array): Promise<string> {
    if (await this.workersAiBlocked()) throw new WorkersAiQuotaError();
    try {
      const r = (await this.env.AI.run("@cf/openai/whisper-large-v3-turbo" as any, {
        audio: toBase64(audio.buffer as ArrayBuffer),
        language: "zh",
        // 開頭給一句繁體中文，輸出才會是繁體
        initial_prompt: "以下是繁體中文的錄音逐字稿。",
        vad_filter: true,
      })) as { text?: string };
      return String(r?.text ?? "").trim() || "（沒有聲音）";
    } catch (e) {
      if (isQuotaError(e)) {
        const q = new WorkersAiQuotaError();
        this.noteQuota(q);
        throw q;
      }
      throw e;
    }
  }

  /** 每一段都轉好了：接成逐字稿，請 AI 整理重點、決定、待辦，存進知識庫並在聊天通知 */
  private async finishMemo(id: number) {
    const m = this.sql.exec("SELECT * FROM memos WHERE id = ?", id).toArray()[0];
    if (!m) return;
    const segs = this.sql.exec("SELECT seq, status, text, seconds, engine FROM memo_segs WHERE memo_id = ? ORDER BY seq", id).toArray();
    let offset = 0;
    const pieces: string[] = [];
    for (const g of segs) {
      const head = segs.length > 1 ? `【${fmtDuration(offset)}】\n` : "";
      pieces.push(head + (g.status === "done" ? String(g.text ?? "") : "（這段轉錄失敗）"));
      offset += Number(g.seconds) || 0;
    }
    const transcript = pieces.join("\n\n").trim();
    const seconds = Math.round(offset);
    const engine = [...new Set(segs.map((g) => String(g.engine ?? "")).filter(Boolean))].join("+");
    const heard = segs.some((g) => g.status === "done" && String(g.text ?? "").trim() && String(g.text).trim() !== "（沒有聲音）");
    if (!heard) {
      // 一個字都沒轉出來：音檔先留著，可以按「重試」
      const failed = segs.find((g) => g.status === "failed");
      this.sql.exec(
        "UPDATE memos SET status = 'error', error = ?, seconds = ?, engine = ?, updated = ? WHERE id = ?",
        failed ? `轉文字失敗：${String(failed.text || "").slice(0, 120)}` : "沒有聽到說話的聲音", seconds, engine, Date.now(), id,
      );
      this.broadcastState();
      return;
    }
    const owner = this.p().travelers[0]?.name || "使用者";
    const today = this.today();
    const priv = this.setting("voice_engine", "gemini") === "private";
    const cap = priv ? 24_000 : 100_000;
    const body = transcript.length > cap ? `${transcript.slice(0, cap / 2)}\n…（中間省略）…\n${transcript.slice(-cap / 2)}` : transcript;
    const prompt = `下面是${owner}${m.source === "file" ? "上傳" : "錄"}的一段錄音逐字稿（今天是 ${today}${seconds ? `，長度約 ${fmtDuration(seconds)}` : ""}），可能是會議、上課、訪談或自己的口述備忘。請整理成 JSON：
{"title": "15 字內的標題，說清楚是什麼", "summary": "重點摘要，Markdown 條列 3–8 點，寫具體的數字、日期、人名、地點", "decisions": ["做出的決定"], "actions": [{"item": "要做的事（動詞開頭）", "who": "負責的人（沒說就空字串）", "due": "期限 YYYY-MM-DD（沒說就空字串）"}], "tags": ["2–5 個標籤"]}
只根據逐字稿，不要編造；聽不清楚的地方略過。「下週三」這類日期用今天 ${today} 換算成實際日期。沒有決定或待辦就給空陣列。

逐字稿：
${body}`;
    let j: Record<string, any> = {};
    try {
      const system = "你是幫忙整理會議記錄的助理，只根據逐字稿，只輸出 JSON。";
      // 隱私模式：摘要也只用 Cloudflare 的模型
      const raw = priv
        ? (await (await this.provider("workers-ai")).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }], json: true, maxTokens: 4096 })).text
        : await this.generateText(system, prompt, true, 1, 4096);
      j = parseArgs(raw.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as Record<string, any>;
    } catch (e) {
      console.error("memo summary failed", e);
    }
    const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
    const title = (String(j.title ?? "").trim() || String(m.title ?? "").trim() || `${mdText(today)} 的錄音`).slice(0, 40);
    const summary = String(j.summary ?? "").trim().slice(0, 3000) || "（AI 暫時不能整理重點，逐字稿已經存好）";
    const decisions = arr(j.decisions).map((d) => String(d).trim()).filter(Boolean).slice(0, 10);
    const actions = arr(j.actions)
      .map((a) => ({
        item: String(typeof a === "string" ? a : a?.item ?? "").trim().slice(0, 120),
        who: String(a?.who ?? "").trim().slice(0, 20),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(a?.due ?? "")) ? String(a.due) : "",
        added: false,
      }))
      .filter((a) => a.item)
      .slice(0, 15);
    const tags = arr(j.tags).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 5);
    const actionLines = actions.map((a) => `- ${a.item}${a.who ? `（${a.who}）` : ""}${a.due ? `｜${a.due}` : ""}`).join("\n");
    // 語音備忘頁的待辦另外列（可以一鍵加進清單），那邊的摘要只放重點和決定；知識庫那筆三樣都放
    const brief = [summary, decisions.length ? `**決定**\n${decisions.map((d) => `- ${d}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    const full = [brief, actions.length ? `**待辦**\n${actionLines}` : ""].filter(Boolean).join("\n\n");
    const note = { title: `🎙️ ${title}`, summary: full, content: transcript.slice(0, 300_000), tags: [...new Set([...tags, "錄音"])] };
    const again = !!m.note_id && this.sql.exec("SELECT 1 FROM notes WHERE id = ?", m.note_id).toArray().length > 0;
    let noteId = Number(m.note_id) || 0;
    if (again) {
      // 重轉失敗的段落：更新原本那筆知識庫，不要多一筆
      this.sql.exec("UPDATE notes SET ts = ?, title = ?, summary = ?, content = ?, tags = ? WHERE id = ?", Date.now(), note.title, note.summary, note.content, JSON.stringify(note.tags), noteId);
      this.ctx.waitUntil(this.syncEmbeddings());
    } else noteId = (this.noteSave(note, String(m.author), false) as { saved_id?: number }).saved_id ?? 0;
    if (noteId) this.indexNoteChunks(noteId, transcript);
    this.sql.exec(
      "UPDATE memos SET status = 'done', title = ?, summary = ?, actions = ?, transcript = ?, seconds = ?, engine = ?, note_id = ?, error = NULL, updated = ? WHERE id = ?",
      title, brief, JSON.stringify(actions), transcript, seconds, engine, noteId || null, Date.now(), id,
    );
    this.trimMemoAudio();
    this.postAiMessage(
      `🎙️ **錄音${again ? "重新" : ""}整理好了｜${title}**${seconds ? `（${fmtDuration(seconds)}）` : ""}\n\n${summary}${actions.length ? `\n\n**待辦建議**\n${actionLines}` : ""}\n\n逐字稿和重點已存進[知識庫](#note-${noteId})；到「工具箱 → 語音備忘」可以把待辦一鍵加進清單、回放錄音（保留 ${MEMO_KEEP_DAYS} 天）。`,
      { kind: "memo" },
    );
    this.broadcastState();
    await this.pushAll({ title: "🎙️ 錄音整理好了", body: title, tag: `memo-${id}` });
  }

  /** 把錄音整理出的待辦加進清單（idx＝第幾項；沒給就全部） */
  private memoTodo(id: number, idx: number | null, by: string): string | null {
    const m = this.sql.exec("SELECT actions FROM memos WHERE id = ?", id).toArray()[0];
    if (!m) return "找不到這段錄音";
    const acts = JSON.parse(String(m.actions || "[]")) as { item: string; who: string; due: string; added: boolean }[];
    const pick = acts.filter((a, i) => !a.added && (idx == null || i === idx));
    if (!pick.length) return "這些待辦已經加過了";
    this.checklistAdd("待辦", pick.map((a) => `${a.item}${a.due ? `（${mdText(a.due)} 前）` : ""}`), "", by);
    for (const a of pick) a.added = true;
    this.sql.exec("UPDATE memos SET actions = ? WHERE id = ?", JSON.stringify(acts), id);
    this.broadcastState();
    return null;
  }

  // ================= 從手機分享進來（iPhone 捷徑打收件網址；Android 的分享選單會打開 App 頁面） =================

  private async inboxCapture(token: string, req: Request): Promise<Response> {
    const say = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
    const saved = this.setting("inbox_token");
    if (!this.isPersonal() || !saved || !safeEqual(token, saved)) return say("這個收件網址已經失效，請到個人助理的設定重新產生", 404);
    // 一小時最多 30 則：網址外流也不會被灌爆
    const hour = Math.floor(Date.now() / 3600_000);
    const [h, n] = this.setting("inbox_rate", "0:0").split(":").map(Number);
    const count = h === hour ? n + 1 : 1;
    if (count > 30) return say("這一小時收太多了，請稍後再試", 429);
    this.setSetting("inbox_rate", `${hour}:${count}`);
    const raw = (await req.text()).slice(0, 20_000);
    let fields: unknown[] = [raw];
    if (/^\s*[{[]/.test(raw)) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === "object" && !Array.isArray(j)) fields = [j.title, j.text, j.url, j.input];
      } catch {}
    } else if (/form-urlencoded/.test(req.headers.get("content-type") ?? "")) {
      const f = new URLSearchParams(raw);
      fields = [f.get("title"), f.get("text"), f.get("url")];
    }
    const content = joinShared(fields).slice(0, 4000);
    if (!content) return say("沒有收到內容", 400);
    this.captureMessage(content, "share");
    return say("✅ 已送到個人助理，整理好會存進知識庫");
  }

  /** 分享進來的東西：當成本人在聊天說「存到知識庫：…」，照一般流程讀連結、整理、存進知識庫 */
  private captureMessage(content: string, via: string) {
    const owner = this.p().travelers[0]?.name || "我";
    const row = this.insertMessage({ author: owner, role: "user", text: `存到知識庫：${content}`, photo_id: null, lat: null, lon: null, meta: JSON.stringify({ via }) });
    this.broadcast({ type: "message", message: this.publicMessage(row) });
    const job = this.queue.then(() => this.runAgent(row, { name: owner, admin: true, joined: Date.now() }));
    this.queue = job.catch(() => {});
    this.ctx.waitUntil(job);
  }

  // ================= 健康管家：資料在 health-store.ts，規則在 health.ts；這裡接聊天、推播、排程 =================

  private healthStore: HealthStore | null = null;
  private health(): HealthStore {
    return (this.healthStore ??= new HealthStore(this.sql, () => this.p().timezone));
  }

  /** 把這則訊息標成健康對話（不給 Gemini 看、不進記憶） */
  private markHealth(id: string) {
    const row = this.sql.exec("SELECT meta FROM messages WHERE id = ?", id).toArray()[0];
    if (!row) return;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(String(row.meta || "{}"));
    } catch {}
    this.sql.exec("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, health: true }), id);
  }

  /** 記了一筆量測：紅色警示在聊天裡發固定文字並推播到手機 */
  private async afterVital(flags: Flag[]) {
    this.broadcastState();
    for (const f of flags.filter((x) => x.level === "red")) {
      this.postAiMessage(`🚨 ${f.text}`, { kind: "health_alert", health: true });
      await this.pushAll({ title: "🚨 健康警示", body: pushText(f.text), tag: "health-alert" });
    }
  }

  private async healthTick() {
    if (!this.isPersonal()) return;
    const list = this.health().tick();
    for (const r of list) {
      this.postAiMessage(r.text, { kind: "health" });
      if (r.push) await this.pushAll({ ...r.push, tag: `health-${r.key}` });
    }
    if (list.length) this.broadcastState();
  }

  healthLog(args: Record<string, unknown>) {
    const kind = String(args.kind ?? "");
    const input =
      kind === "bp" ? { kind, v1: args.systolic, v2: args.diastolic, v3: args.pulse, context: args.context, date: args.date, time: args.time }
      : kind === "glucose" ? { kind, v1: args.glucose, context: args.context, date: args.date, time: args.time }
      : { kind, v1: args.weight, v2: args.waist, date: args.date, time: args.time };
    const r = this.health().addVital(input, "chat");
    if ("error" in r) return r;
    this.ctx.waitUntil(this.afterVital(r.flags));
    const v = r.vital;
    const what = v.kind === "bp" ? `血壓 ${v.v1}/${v.v2}${v.v3 ? `、脈搏 ${v.v3}` : ""}` : v.kind === "glucose" ? `血糖 ${v.v1} mg/dL` : `體重 ${v.v1} 公斤${v.v2 ? `、腰圍 ${v.v2} 公分` : ""}`;
    return { saved: `${v.date} ${v.time} ${what}`, grade: r.grade, alerts: r.flags.map((f) => f.text), note: "已記錄到健康管家" };
  }

  healthStatus() {
    const { vitals: _vitals, conditionChoices: _c, ...s } = this.health().summary();
    return {
      ...s,
      screenings: s.screenings.filter((x) => x.status === "due" || x.status === "none").map((x) => ({ name: x.name, status: x.status === "due" ? "該做了" : "沒有紀錄", last: x.last, rule: x.rule })),
      labs: s.labs.slice(0, 40).map((g) => ({
        item: g.name,
        latest: `${g.points[0].value}${g.points[0].unit ? ` ${g.points[0].unit}` : ""}（${g.points[0].date}）`,
        judge: g.note ?? (g.points[0].ref ? `參考值 ${g.points[0].ref}${g.points[0].flag ? `，報告標示 ${g.points[0].flag}` : ""}` : null),
        previous: g.points.slice(1, 4).map((x) => `${x.value}（${x.date}）`),
      })),
      reports: s.reports.slice(0, 8).map((r) => ({ date: r.date, name: r.name, text: String(r.value).slice(0, 300) })),
      scans: undefined,
      note: "數字與判讀都是程式依指引算的；說明時照這些判讀，不要自己改",
    };
  }

  healthMeds(args: Record<string, unknown>) {
    const action = String(args.action ?? "list");
    const store = this.health();
    if (action === "add") {
      const r = store.medSave(args);
      this.broadcastState();
      return "error" in r ? r : { added: args.name, note: "已加到用藥清單；劑量和用法以醫師、藥袋為準" };
    }
    if (action === "stop") {
      const m = store.medFind(String(args.name ?? ""));
      if (!m) return { error: `用藥清單裡找不到「${args.name}」`, meds: store.meds().map((x) => x.name) };
      store.medStop(Number(m.id));
      this.broadcastState();
      return { stopped: m.name };
    }
    return { meds: store.meds().map((m) => ({ name: m.name, dose: m.dose, freq: m.freq, purpose: m.purpose, refill_next: m.refill_next, refill_left: m.refill_left })) };
  }

  healthProfile(args: Record<string, unknown>) {
    const store = this.health();
    const patch: Record<string, unknown> = { ...args };
    if (typeof args.add_condition === "string" && args.add_condition.trim()) patch.conditions = [...(store.profile().conditions ?? []), args.add_condition.trim()];
    const p = store.saveProfile(patch);
    this.broadcastState();
    return { saved: p };
  }

  /** 拍照讀取前的檢查：隱私模式不傳給 Google；需要自己的 Gemini 金鑰 */
  private async scanBlocked(): Promise<string | null> {
    if (this.setting("voice_engine", "gemini") === "private") return "隱私模式不會把照片傳給 Google，請手動輸入（或到設定把語音與文件改回 Gemini）";
    if (!(await this.keys()).gemini) return "拍照讀取需要你自己的 Gemini 金鑰（設定 → API 金鑰）；也可以手動輸入";
    return null;
  }

  /** Gemini 只把照片上的字照抄成 JSON（不判讀），等本人確認後才存 */
  private async runScan(id: number) {
    const store = this.health();
    const s = store.scan(id);
    if (!s) return;
    const ph = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", s.photo_id).toArray()[0];
    try {
      if (!ph) throw new Error("照片不見了");
      const r = await (await this.provider("gemini-own", 1, 30_000)).generate({
        system: "你是把醫療文件照片照抄成 JSON 的助手：只抄寫看得到的文字，不解讀、不判斷好壞、不補充、不猜。",
        turns: [{ role: "user", parts: [{ image: { mime: String(ph.mime), data: toBase64(ph.data as ArrayBuffer) } }, { text: s.kind === "med" ? MED_SCAN_PROMPT : LAB_SCAN_PROMPT }] }],
        json: true,
        timeoutMs: 120_000,
      });
      const j = parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as Record<string, any>;
      const t = (v: unknown, n = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      let data: Record<string, unknown>;
      if (s.kind === "lab") {
        const items = (Array.isArray(j.items) ? j.items : []).slice(0, 80).map((it: any) => ({
          name: t(it?.name, 80), value: t(it?.value, 60), unit: t(it?.unit, 20), ref: t(it?.ref, 60), flag: t(it?.flag, 10), prev: t(it?.prev, 40), unreadable: !!it?.unreadable, known: !!labCode(t(it?.name, 80)),
        })).filter((it: { name: string; value: string }) => it.name && (it.value || it.name));
        if (!items.length) throw new Error("讀不到檢驗項目");
        data = { date: normDate(t(j.date, 30)) ?? "", dateRaw: t(j.date, 30), items, count: Number(j.item_count_on_page) || null, note: t(j.doctor_note, 500), vitals: t(j.vitals, 200) };
      } else {
        const name = t(j.drug_name, 80);
        if (!name) throw new Error("讀不到藥名");
        data = {
          date: normDate(t(j.date, 30)) ?? "", name, ingredient: t(j.ingredient, 120), strength: t(j.strength, 40), quantity: t(j.quantity, 40), usage: t(j.usage, 120), indication: t(j.indication, 120),
          side_effects: t(j.side_effects, 300), warnings: t(j.warnings, 300), appearance: t(j.appearance, 120), refill: t(j.refill, 120), refill_next: findDate(t(j.refill, 120)) ?? "", refill_left: refillLeft(t(j.refill, 120)),
        };
      }
      store.scanSet(id, "review", data);
    } catch (e) {
      console.error("runScan failed", String((e as Error)?.message ?? e).slice(0, 200));
      store.scanSet(id, "failed", null, isQuotaError(e) ? "Gemini 額度暫時用完，稍後再按重試" : "讀不出來，請重拍：光線充足、拍正、整張入鏡、不要反光");
    }
    this.broadcastState();
  }

  /** 本人確認（可修改）後存進健康管家；檢驗存完請 Cloudflare 的模型用白話說明 */
  private saveScan(id: number, msg: any): { error: string } | { ok: true } {
    const store = this.health();
    const s = store.scan(id);
    if (!s || s.status !== "review") return { error: "這筆已經處理過了" };
    if (s.kind === "lab") {
      const date = String(msg.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > this.today()) return { error: "請填報告日期" };
      const items = (Array.isArray(msg.items) ? msg.items : []).slice(0, 80).map((it: any) => ({ date, name: it?.name, value: it?.value, unit: it?.unit, ref: it?.ref, flag: it?.flag }));
      if (!items.length) return { error: "沒有勾選要存的項目" };
      store.addLabs(items, "photo");
      store.scanSet(id, "saved", JSON.parse(String(s.data ?? "null")));
      // 確認完就刪照片，只留數字
      this.sql.exec("DELETE FROM photos WHERE id = ?", s.photo_id);
      this.broadcastState();
      this.ctx.waitUntil(this.explainLabs(date));
      return { ok: true };
    }
    const med = msg.med ?? {};
    const same = store.medFind(String(med.name ?? ""));
    const r = store.medSave(same ? { ...same, ...med, id: same.id } : med);
    if ("error" in r) return r;
    store.scanSet(id, "saved", JSON.parse(String(s.data ?? "null")));
    this.sql.exec("DELETE FROM photos WHERE id = ?", s.photo_id);
    this.broadcastState();
    return { ok: true };
  }

  /** 檢驗存好後：程式整理判讀，Cloudflare 的模型（不是 Gemini）用白話說明 */
  private async explainLabs(date: string) {
    const facts = this.health().labFacts(date);
    if (!facts) return;
    let text = `🧪 **${date} 的檢驗已存進健康管家**\n${facts}`;
    try {
      if (await this.workersAiBlocked()) throw new WorkersAiQuotaError();
      const r = await (await this.provider("workers-ai")).generate({
        system: this.healthPrompt(),
        turns: [{ role: "user", parts: [{ text: `下面是 ${date} 的檢驗結果，判讀是程式依指引算好的：\n${facts}\n\n請用白話說明（300 字內、條列）：\n1. 標示「高於目標、偏高、偏低、範圍」或報告標示 H/L 的項目，各代表什麼、可能和哪些生活習慣有關；跟上次比變好還是變差。\n2. 正常的項目合成一句帶過。\n3. 最後列 2–3 個看診時可以問醫師的問題。\n不要改寫判讀、不要診斷、不要提任何藥物或劑量調整。這次不需要呼叫工具。` }] }],
        timeoutMs: 60_000,
      });
      if (r.text.trim()) text += `\n\n${stripSpeakerTag(r.text.trim())}`;
    } catch (e) {
      this.noteQuota(e);
      text += "\n\n（今天的 AI 說明額度用完了，之後可以在聊天問「@健康管家 幫我看這次的檢驗」）";
    }
    this.postAiMessage(text, { kind: "health_labs", health: true });
  }

  /** 健康對話的系統提示詞（Cloudflare 的模型） */
  private healthPrompt(): string {
    const p = this.p();
    const owner = p.travelers[0]?.name || "使用者";
    const now = zoned(Date.now(), p.timezone);
    return `你是「健康管家」，幫${owner}整理自己的健康紀錄、準備看診。你不是醫師：不做診斷、不說「你得了／確診」，不建議開始、停止或調整任何藥物或劑量（這些一律請他問醫師或藥師）。

# 現在
${now.date}（${now.weekday}）${now.time}

# 規則
- 數字、分級、是否達標、該做哪些檢查：一律用 health_status 或 health_log 回傳的程式判讀，不要自己計算或改寫。查不到就說資料不足。
- ${owner}報數字（例如「血壓 135/85」「早上空腹血糖 110」「體重 72.5」）→ 用 health_log 記下來，回覆程式判讀；有 alerts 就照原文完整轉述。
- 說開始吃、停了某個藥，或拿到慢箋、下次領藥日 → health_meds。身高、生日、慢性病、過敏、家族史、吸菸 → health_profile。
- 問最近的血壓、血糖、體重，或該做哪些健檢、疫苗 → 先用 health_status，再用白話說明，寫出依據的數字和日期。
- 解釋時用「可能和…有關，建議請醫師評估」；可以給生活習慣層面的建議（飲食、運動、睡眠、正確量血壓的方法）。
- 問檢驗數值（膽固醇、糖化血色素、腎功能等）→ 先用 health_status 看 labs 的最新值、判讀和以前的數值；沒有判讀的項目請他對照報告的參考值或問醫師。
- 要提醒吃藥、量血壓 → create_reminder；回診 → add_event；問以前存在知識庫的文件 → search_notes。
- 一律繁體中文、台灣用語，精簡條列。提到症狀或異常數值時，最後加一句：「健康管家是紀錄整理與衛教參考，不能取代醫師診斷；用藥請問醫師或藥師。」`;
  }

  // ================= 證件到期：只記種類、持有人、到期日、末四碼，到期前提醒 =================

  private idSteps(kind: string): number[] {
    return /護照|passport/i.test(kind) ? PASSPORT_STEPS : ID_STEPS;
  }

  idDocAdd(d: { kind?: unknown; holder?: unknown; expires?: unknown; last4?: unknown }, author: string): { error: string } | Record<string, unknown> {
    const kind = String(d.kind ?? "").trim().slice(0, 12) || "證件";
    const holder = String(d.holder ?? "").trim().slice(0, 16) || this.p().travelers[0]?.name || "我";
    const expires = normalizeExpiry(String(d.expires ?? ""));
    if (!expires) return { error: "到期日看不懂，請寫成 YYYY-MM-DD" };
    // 只留末四碼：就算傳來完整號碼也不存
    const last4 = String(d.last4 ?? "").replace(/[^0-9A-Za-z]/g, "").slice(-4);
    const days = daysUntil(this.today(), expires);
    const steps = this.idSteps(kind);
    // 已經過了的提醒點不補發（剛記下來的人自己知道）
    const notified = steps.filter((t) => days <= t).reduce((a, b) => Math.min(a, b), 100_000);
    const id = this.sql
      .exec("INSERT INTO id_docs (ts, kind, holder, last4, expires, author, notified) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", Date.now(), kind, holder, last4, expires, author, notified)
      .one().id as number;
    this.broadcastState();
    const ahead = steps.filter((t) => t > 0 && t < days).map((t) => (t >= 30 ? `${Math.round(t / 30)} 個月` : `${t} 天`));
    return { saved_id: id, kind, holder, expires, days_left: days, note: ahead.length ? `到期前 ${ahead.join("、")} 會提醒` : "到期當天會提醒" };
  }

  idDocList() {
    const today = this.today();
    return this.sql
      .exec("SELECT id, kind, holder, last4, expires FROM id_docs ORDER BY expires")
      .toArray()
      .map((r) => ({ ...r, days: daysUntil(today, String(r.expires)) }));
  }

  /** 每天檢查一次：跨過提醒點（護照 6 個月、3 個月、1 個月、1 週、當天）就在聊天和手機通知 */
  private async checkIdExpiry(today: string) {
    if (this.setting("id_check") === today) return;
    this.setSetting("id_check", today);
    for (const d of this.sql.exec("SELECT * FROM id_docs").toArray()) {
      const days = daysUntil(today, String(d.expires));
      const hit = this.idSteps(String(d.kind)).filter((t) => days <= t && t < Number(d.notified));
      if (!hit.length) continue;
      this.sql.exec("UPDATE id_docs SET notified = ? WHERE id = ?", Math.min(...hit), d.id);
      const who = `${d.holder}的${d.kind}${d.last4 ? `（末四碼 ${d.last4}）` : ""}`;
      const tip = /護照/.test(String(d.kind)) ? "出國時護照效期通常要 6 個月以上，記得提早換發。" : "記得提早辦理換發。";
      const text =
        days < 0 ? `🪪 **證件已過期**：${who}在 ${d.expires} 到期了。${tip}`
        : days === 0 ? `🪪 **證件今天到期**：${who}。${tip}`
        : `🪪 **證件快到期**：${who}在 ${d.expires} 到期，還有 ${days} 天。${tip}`;
      this.postAiMessage(text, { kind: "id_expiry" });
      await this.pushAll({ title: days < 0 ? "🪪 證件已過期" : "🪪 證件快到期", body: pushText(text), tag: `id-${d.id}` });
    }
    this.broadcastState();
  }

  // ================= 個人日記：預設每週一篇（週一早上寫上一週），也可以改成每天一篇（隔天早上寫前一天） =================

  private async maybePersonalDiary(now: ReturnType<typeof zoned>) {
    const mode = this.setting("diary_mode", "weekly");
    if (mode === "off" || now.hour < 5) return;
    const yesterday = shiftDays(now.date, -1);
    if (this.setting("pdiary_sent") === yesterday) return;
    if (mode === "weekly" && new Date(now.date + "T00:00:00Z").getUTCDay() !== 1) return;
    this.setSetting("pdiary_sent", yesterday);
    await this.writePersonalDiary(yesterday, mode === "daily" ? 1 : 7);
  }

  /** 寫 endDate 為止 span 天的日記（span＝7 是週記）；資料太少回傳原因，不寫 */
  private async writePersonalDiary(endDate: string, span: number, announce = true): Promise<string | null> {
    const p = this.p();
    const owner = p.travelers[0]?.name || "我";
    const startDate = shiftDays(endDate, 1 - span);
    const start = localToUtc(startDate, "00:00", p.timezone) ?? Date.parse(startDate + "T00:00:00Z");
    const end = localToUtc(shiftDays(endDate, 1), "00:00", p.timezone) ?? start + span * 86400_000;
    const msgs = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY ts", start, end).toArray().filter((m) => !systemMade(m));
    // 證件、票券照片不能進日記
    const docs = new Set(this.sql.exec("SELECT photo_id FROM documents WHERE photo_id IS NOT NULL").toArray().map((r) => r.photo_id as string));
    const photoMsgs = photoRows(msgs.filter((m) => m.photo_id && m.role === "user")).filter((m) => !docs.has(m.photo_id as string)).slice(-40);
    const said = msgs.filter((m) => m.role === "user" && m.text.trim());
    const events = this.eventList(startDate, endDate);
    if (said.length < 2 && !photoMsgs.length && !events.length) return "這段時間沒什麼對話、照片或行程，寫不出日記";
    const notes = await this.describePhotos(photoMsgs, true);
    const score = (m: MessageRow) => notes.get(m.photo_id as string)?.score ?? 3;
    let pool = photoMsgs.filter((m) => {
      const n = notes.get(m.photo_id as string);
      return !n || (!["收據", "截圖", "文件"].includes(n.kind) && n.score >= 3);
    });
    if (pool.length > 30) {
      const keep = new Set([...pool].sort((a, b) => score(b) - score(a)).slice(0, 30));
      pool = pool.filter((m) => keep.has(m));
    }
    const tag = new Map(pool.map((m, i) => [m.photo_id as string, `P${i + 1}`]));
    const when = (ts: number) => (span > 1 ? `${this.localTime(ts).slice(5, 10).replace("-", "/")} ` : "") + this.hhmm(ts);
    const catalog = pool
      .map((m) => {
        const n = notes.get(m.photo_id as string);
        return `[${tag.get(m.photo_id as string)}] ${when(m.ts)}｜${n ? `${n.kind}｜精彩度 ${n.score}｜${n.note}` : "（沒有說明）"}${m.text ? `｜附言：「${m.text.slice(0, 60)}」` : ""}`;
      })
      .join("\n");
    const lines = (withAi: boolean) =>
      msgs
        .filter((m) => m.role === "user" || (withAi && m.role === "assistant"))
        .map((m) => {
          if (m.role === "assistant") {
            const t = m.text.replace(/\s+/g, " ");
            return `${when(m.ts)} 助理：${t.slice(0, 120)}${t.length > 120 ? "…" : ""}`;
          }
          const tags = photosOf(m).filter((x) => tag.has(x)).map((x) => tag.get(x));
          const pic = m.photo_id ? (tags.length ? `（傳了照片 ${tags.join("、")}）` : "（傳了照片）") : "";
          return `${when(m.ts)} ${owner}：${m.text.slice(0, 300)}${pic}`;
        })
        .join("\n");
    let transcript = lines(true);
    if (transcript.length > 16000) transcript = lines(false);
    if (transcript.length > 16000) transcript = `${transcript.slice(0, 8000)}\n…（中間省略）…\n${transcript.slice(-8000)}`;
    const prefix = (date: string) => (span > 1 ? `${mdText(date)} ` : "");
    const bought = this.sql
      .exec("SELECT date, description, category FROM expenses WHERE date >= ? AND date <= ? ORDER BY ts", startDate, endDate)
      .toArray()
      .slice(0, 40)
      .map((r) => `${prefix(String(r.date))}${r.description}${r.category ? `（${r.category}）` : ""}`);
    const kept = this.sql.exec("SELECT title FROM notes WHERE ts >= ? AND ts < ? ORDER BY ts", start, end).toArray().slice(0, 20).map((r) => String(r.title));
    const cal = events.map((e) => `${prefix(e.date)}${e.start || "整天"} ${e.title}${e.location ? `（${e.location}）` : ""}`);
    const weekly = span > 1;
    const prompt = `請根據下面的資料，用第一人稱「我」幫${owner}寫${weekly ? `${startDate} 到 ${endDate} 這一週的週記` : `${endDate} 的日記`}，繁體中文，像${owner}自己寫的生活日記：真誠、自然、有溫度。

【寫法】
- 第一行寫「標題：」加上標題（8–16 字，不加引號），空一行後寫內文。
- ${weekly ? "依時間順序挑出這週 3–6 件最值得記下的事（工作、家人、朋友、生活小事、學到的東西、心情），每件事寫一段；最後一段寫這週的感想和下週想做的事。" : "依時間順序寫這一天做了什麼、遇到什麼、心情如何，最有意思的事多寫一點；最後一段寫一點感想。"}
- 寫出具體的人、地點、事情，可以引用${owner}說過的話；不要寫空泛的句子。
- 長短跟著資料走：資料多就寫 ${weekly ? "5–8 段、全文 700–1200 字" : "4–6 段、全文 400–800 字"}，資料少就寫短一點。絕對不要編造資料裡沒有的事情、地點或心情。
- 助理的回答只是建議或解答，不代表${owner}真的做了；以${owner}自己說的話、照片、行事曆和記帳為準。不要提到 AI、助理、App、聊天或手機，不要寫花了多少錢，不要寫證件號碼、卡號、密碼。

【照片】
- 從照片清單挑最精彩、而且跟內文對得上的照片（最多 8 張，照片少就挑好的就好），放在寫到那件事的段落後面，另起一行寫成 [P編號｜照片說明]，例如：
[P3｜週末的鬆餅早午餐]
- 照片說明 6–18 字，內容要跟照片相符；每段最多 2 張、每張最多用一次；對不上的不要放。

期間：${weekly ? `${startDate} – ${endDate}` : endDate}
行事曆：${cal.join("、") || "（沒有）"}
記帳的品項：${bought.join("、") || "（沒有）"}
存進知識庫的東西：${kept.join("、") || "（沒有）"}
照片清單：
${catalog || "（沒有照片）"}
對話（${owner}和助理）：
${transcript || "（沒什麼對話）"}`;
    const raw = await this.generateLong(`你是幫${owner}寫生活日記的作家，文筆真誠自然，只根據提供的資料寫。`, prompt);
    const { title, text, photos, layout } = this.diaryLayout(raw, pool, tag, notes, weekly ? "這一週" : "平凡的一天");
    this.sql.exec(
      "INSERT INTO diaries (date, ts, title, text, photo_ids, layout, span) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET ts = excluded.ts, title = excluded.title, text = excluded.text, photo_ids = excluded.photo_ids, layout = excluded.layout, span = excluded.span, edited_by = NULL, edited_at = NULL",
      endDate, Date.now(), title, text, JSON.stringify(photos), layout.length ? JSON.stringify(layout) : null, span,
    );
    if (announce) {
      const caption = new Map(layout.map((l) => [l.id, l.caption]));
      const images: AttachedImage[] = photos.slice(0, 8).map((id) => ({ src: `/api/photo/${id}`, caption: caption.get(id) ?? "", source: weekly ? "這週的照片" : "這天的照片" }));
      const label = weekly ? `${mdText(startDate)}–${mdText(endDate)} 週記` : `${mdText(endDate)} 日記`;
      this.postAiMessage(`📔 **${label}｜${title}**\n\n${text}\n\n（工具箱 → 日記：看圖文版、下載 PDF）`, { kind: "diary", images });
    }
    this.broadcastState();
    return null;
  }

  /** 記帳後檢查預算：到八成、超支各提醒一次（聊天＋手機推播） */
  private async checkBudget() {
    const budget = Number(this.setting("budget_month", "0"));
    if (!budget) return;
    const l = this.ledger();
    const level = l.total >= budget ? 2 : l.total >= budget * 0.8 ? 1 : 0;
    const key = `budget_alert_${l.month}`;
    if (level <= Number(this.setting(key, "0"))) return;
    this.setSetting(key, String(level));
    const nt = (n: number) => `NT$${Math.round(n).toLocaleString("en-US")}`;
    const text = level === 2
      ? `💸 **這個月已經超出預算**：花了 ${nt(l.total)}，預算 ${nt(budget)}，超出 ${nt(l.total - budget)}。`
      : `⚠️ **這個月的花費到預算的 ${Math.round((l.total / budget) * 100)}% 了**：花了 ${nt(l.total)}，還剩 ${nt(budget - l.total)}。`;
    this.postAiMessage(text, { kind: "budget" });
    await this.pushAll({ title: level === 2 ? "💸 超出預算" : "⚠️ 預算快用完了", body: pushText(text), tag: "budget" });
  }

  private vapidCache: VapidKeys | null = null;
  private async vapidKeys(): Promise<VapidKeys> {
    this.vapidCache ??= await this.registry().vapidKeys();
    return this.vapidCache;
  }

  /** 推播到這個空間所有開啟通知的裝置（目前只有個人助理用）；失效的訂閱順便刪掉 */
  private async pushAll(payload: Omit<PushPayload, "url"> & { url?: string }) {
    if (!this.isPersonal()) return;
    const subs = this.sql.exec("SELECT * FROM push_subs").toArray();
    if (!subs.length) return;
    const keys = await this.vapidKeys();
    const subject = this.setting("push_subject") || "https://trip-agent.app";
    let changed = false;
    for (const sub of subs) {
      try {
        const r = await sendPush(
          { endpoint: sub.endpoint as string, p256dh: sub.p256dh as string, auth: sub.auth as string },
          { url: `/t/${this.roomId()}`, ...payload },
          keys,
          subject,
        );
        if (r.gone) {
          this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", sub.endpoint);
          changed = true;
        } else if (!r.ok) console.error("push failed", r.status);
      } catch (e) {
        console.error("push error", e);
      }
    }
    if (changed) this.broadcast({ type: "settings", settings: this.settings() });
  }

  /** 今天的早報（今天頁顯示用） */
  private latestBrief(): { ts: number; text: string } | null {
    const r = this.sql.exec("SELECT ts, text FROM messages WHERE role = 'assistant' AND meta LIKE '%\"kind\":\"brief\"%' ORDER BY ts DESC LIMIT 1").toArray()[0];
    if (!r || zoned(Number(r.ts), this.p().timezone).date !== this.today()) return null;
    return { ts: Number(r.ts), text: String(r.text) };
  }

  /** 個人助理的早報：天氣、今天的提醒與待辦、購物清單、本月花費；AI 只負責寫成好讀的幾行，失敗就用規則組 */
  private async postPersonalBrief(date: string) {
    const p = this.p();
    this.setSetting("brief_sent", date);
    const owner = p.travelers[0]?.name || "你";
    const ctx = await this.toolCtx(AI_NAME);
    const weather = homeOf(p) ? await runTool("get_weather", { days: 1 }, ctx).catch(() => null) : null;
    const reminders = this.reminderList().filter((r) => String(r.time).startsWith(date));
    const todos = this.checklistGet("待辦").filter((c) => !c.done);
    const shopping = this.checklistGet("購物").filter((c) => !c.done);
    const l = this.ledger();
    const soon = this.memories().filter((m) => m.expires && String(m.expires) >= date).map((m) => `${m.content}（到 ${m.expires}）`).slice(0, 5);
    const nt = (n: number) => `NT$${Math.round(n).toLocaleString("en-US")}`;
    const facts = {
      日期: `${date}（${"日一二三四五六"[new Date(date + "T00:00:00Z").getUTCDay()]}）`,
      天氣: weather ?? "（沒有設定住的地方，查不到）",
      今天的提醒: reminders.map((r) => `${String(r.time).slice(11, 16)} ${r.message}`),
      待辦: todos.slice(0, 8).map((c) => c.item),
      購物清單: shopping.slice(0, 8).map((c) => c.item),
      今天的行程: (this.eventList(date, date) as any[]).map((e) => `${e.start ?? "整天"} ${e.title}${e.location ? `（${e.location}）` : ""}`),
      本月花費: l.budget ? `${nt(l.total)}／預算 ${nt(l.budget)}（剩 ${nt(l.budget - l.total)}）` : nt(l.total),
      昨晚整理後要你確認的事: (this.sql.exec("SELECT COUNT(*) AS n FROM cards WHERE status = 'pending'").one().n as number) || 0,
      最近要注意的事: soon,
    };
    let text: string;
    try {
      text = await this.generateText(
        `你是${owner}的個人助理，語氣溫暖，只根據提供的資料寫，不要編造。`,
        `請寫今天的早安簡報內文（標題系統會加，你不要寫標題），繁體中文、適合手機閱讀、200 字內、條列：
1. 天氣與穿著、要不要帶傘（沒有天氣資料就略過）
2. 今天的行程與提醒（附時間）
3. 待辦（最多 5 項）；購物清單還有幾項
4. 本月花費（有預算就寫還剩多少）
5. 最近要注意的事（沒有就略過）
6. 昨晚整理後有幾件事要確認，就提醒到「今天」頁看一下（沒有就略過）
資料：${JSON.stringify(facts).slice(0, 4000)}`,
        false,
        0.5,
      );
    } catch {
      text = [
        reminders.length ? `⏰ 今天的提醒：${reminders.map((r) => `${String(r.time).slice(11, 16)} ${r.message}`).join("、")}` : "",
        todos.length ? `✅ 待辦：${todos.slice(0, 5).map((c) => c.item).join("、")}` : "",
        shopping.length ? `🛒 購物清單還有 ${shopping.length} 項` : "",
        `💰 本月花費 ${facts.本月花費}`,
      ].filter(Boolean).join("\n");
    }
    this.postAiMessage(`☀️ **早安！${date.slice(5).replace("-", "/")} 早報**\n\n${text}`, { kind: "brief" });
    this.broadcastState();
    await this.pushAll({ title: `☀️ 早安，${owner}`, body: pushText(text), tag: "brief" });
  }

  /** 每天一次：過期的記憶失效 */
  private dailyMaintenance(today: string) {
    if (this.setting("maint_date") === today) return;
    this.setSetting("maint_date", today);
    this.sql.exec("UPDATE memories SET status = 'expired', updated = ? WHERE COALESCE(status, 'active') = 'active' AND expires IS NOT NULL AND expires < ?", Date.now(), today);
    // 錄音檔留 30 天可以回放，之後刪掉音檔（逐字稿一直留著）
    this.sql.exec("DELETE FROM memo_audio WHERE memo_id IN (SELECT id FROM memos WHERE status IN ('done', 'error') AND updated < ?)", Date.now() - MEMO_KEEP_DAYS * 86400_000);
  }

  /** 匯出：聊天文字、記憶、清單、提醒、帳本、保管箱的清單（照片太大不放） */
  private exportData() {
    const p = this.p();
    const rows = (q: string) => this.sql.exec(q).toArray();
    return {
      exported_at: new Date().toISOString(),
      space: { title: p.title, kind: p.kind ?? "trip", city: p.city, timezone: p.timezone },
      about_me: this.setting("core_profile"),
      summary: this.setting("summary"),
      memories: rows("SELECT id, ts, category, content, author, status, source, expires, superseded_by FROM memories ORDER BY ts"),
      messages: rows("SELECT ts, author, role, text, photo_id FROM messages ORDER BY ts"),
      checklist: rows("SELECT list, item, done, ts FROM checklist ORDER BY list, id"),
      reminders: rows("SELECT due, message, author, sent FROM reminders ORDER BY due"),
      expenses: rows("SELECT date, description, amount, currency, amount_twd, category FROM expenses ORDER BY date"),
      documents: rows("SELECT d.ts, d.title, d.note, f.name AS folder FROM documents d LEFT JOIN doc_folders f ON f.id = d.folder_id ORDER BY d.ts"),
      notes: rows("SELECT ts, title, summary, content, url, tags FROM notes ORDER BY ts"),
      events: rows("SELECT date, start, end_time, title, location, note, remind_min FROM events ORDER BY date, start"),
      episodes: rows("SELECT date, summary, weekly FROM episodes ORDER BY date"),
      memos: rows("SELECT ts, title, seconds, summary, actions, transcript FROM memos WHERE status = 'done' ORDER BY ts"),
      id_docs: rows("SELECT kind, holder, last4, expires FROM id_docs ORDER BY expires"),
      files: rows("SELECT ts, name, bytes, status, pages, chars FROM files ORDER BY ts"),
      ...(p.kind === "personal" ? { health: this.health().exportData() } : {}),
    };
  }

  /** 個人助理的系統提示詞：只有本人，沒有旅程、住宿、分帳 */
  private personalPrompt(trigger?: MessageRow, windowStartTs?: number): string {
    const p = this.p();
    const owner = p.travelers[0]?.name || "使用者";
    const recall = trigger && windowStartTs ? this.recallOlder(trigger, windowStartTs) : "";
    const now = zoned(Date.now(), p.timezone);
    const a = p.accommodation;
    const picked = this.relevantMemories(trigger ? memoryText(trigger) : "");
    const mems =
      picked.list.map((m) => `- #${m.id}［${m.category}］${m.content}${m.expires ? `（到 ${m.expires} 為止）` : ""}`).join("\n") || "（目前沒有）";
    const core = this.setting("core_profile");
    const summary = this.setting("summary");
    const loc = this.memberLocation()
      .map((l) => `${l.area ? `${l.area}附近` : "地名查詢中"}（${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`)
      .join("");
    return `你是「${AI_NAME}」，${owner}的個人 AI 助理。這個空間只有${owner}一個人，對話內容其他人看不到。

# 現在
${now.date}（${now.weekday}）${now.time}，時區 ${p.timezone}。
住的地方：${p.city || "（未設定）"}${a.address ? `（${a.address}）` : ""}${loc ? `\n${owner}最近的位置：${loc}` : ""}

${core ? `# 關於${owner}\n${core}\n\n` : ""}# 長期記憶（關於${owner}的偏好、決定、重要資訊；#編號可用 forget 刪除）${picked.list.length < picked.total ? `\n（共 ${picked.total} 條，這裡只列出跟這次對話最相關的；找不到就用 search_history）` : ""}
${mems}
${summary ? `\n# 更早的對話摘要\n${summary}\n` : ""}${recall ? `\n# 以前聊過、和這次問題相關的內容（依時間排序）\n${recall}\n` : ""}
# 回答規則
- 一律使用繁體中文與台灣用語，語氣自然親切，適合手機閱讀：精簡、條列、重點加粗。不要用 LaTeX 或 $…$ 數學式。
- 營業時間、價格、新聞、天氣、交通等「會變動的資訊」一定要用工具查，並附上來源連結；查不到就說不確定，絕不編造。
- 工具回傳 error 代表失敗：要如實說沒有完成，不可以說已完成。
- ${owner}說「記住…」、說了偏好、做了決定、提到重要的個人資訊 → 用 remember 記下來；只有 remember 成功後才能說「已記住」。要忘掉某件事 → forget。
- 問以前說過的事：先看「長期記憶」和「以前聊過」，不夠再用 search_history。
- 「幾點提醒我…」→ create_reminder（時間用 ${p.timezone} 的 YYYY-MM-DD HH:mm）；問有哪些提醒 → list_reminders。
- 待辦、購物：明確說「加到待辦／購物清單」才用 add_checklist_items（list 填「待辦」或「購物」）；做完、買了 → update_checklist_item；問清單 → get_checklist。只是隨口提到要做的事，就在回答最後問一句要不要加進待辦。
- 天氣 → get_weather；附近有什麼 → find_nearby（near 留空會用${owner}的位置，沒有位置就用住的地方）；怎麼去 → plan_route（照你知道的說坐哪條線、在哪轉乘，不寫站數）；問幾站或要查證路線才用 check_route_map（官方路線圖優先，照圖回答、附圖）；匯率 → convert_currency。提供店家、景點、活動、營業時間這類資訊前，一定先用 web_search 查證最新狀況，不要憑記憶，並註明來源。
- 地圖連結：工具回傳的連結可以直接用；其他地點一律寫成 [📍地點名稱](map)，系統會自動換成 Google 地圖搜尋連結。不要自己寫 Google 地圖網址或短網址，也不要用自己記得的地址或座標當連結。
- 要看自己傳過的照片（上週拍的、某天的照片、拉麵的照片）→ find_chat_photos（日期換算好，內容寫進 keyword），照片會顯示在回答下方；沒找到就照實說，不要拿網路圖片代替。
- 要看網路上的照片、圖片時用 find_images（圖片會顯示在回答下方），並說明是網路圖片、僅供參考；沒有要求就不要找圖片。
- 成員想看任何地點、店家、美食、景點的影片或實際畫面時，不管怎麼說（短片、影片、Reels、YouTube、有人拍嗎、想看看長怎樣、好啊找找看…），都用 find_short_videos 去找（places 填當地語言名稱、中文名稱、地區、類別、keywords），影片卡片會自動顯示在回答下方；不要沒查就叫成員自己去 IG 或 YouTube 搜尋，也絕對不要自己寫 IG、YouTube、TikTok 的影片網址；成員沒要看影片就不要主動找（回答下方會有找短片的按鈕）；成員說「另外」「其他」「剩下的」，就找還沒找過的地點。預設找當地語言的；成員想看中文介紹的（台灣人拍的、聽得懂的），language 填 chinese 再找一次。
- 收到照片：辨識內容並說明；說要「存起來」→ save_document（說了資料夾就填 folder）；要找存過的文件、票券 → find_documents。
- 一次收到好幾張照片（例如菜單好幾頁、好幾張文件）：當成同一份資料一起整理，不要一張一張分開回答。
- 記帳：${owner}說花了多少錢、只講「項目＋金額」（例如「午餐 120」「加油 1500」是加汽油的錢），或傳收據照片 → add_expense 產生記帳卡片（收據要讀出店名、日期、總金額；民國年加 1911），等${owner}按確認才寫入，不要說「已記好」。問花了多少、預算還剩多少 → expense_summary。花費不要用 remember 記。
- 問「今天要做什麼」→ 用 list_reminders 和 get_checklist（待辦）整理給${owner}。
- ${owner}貼了連結（只貼連結，或說「存起來／存到知識庫」）：先用 read_webpage 讀內容（Facebook、Instagram 的 Reels 也看得到影片內容），整理成標題＋3–6 點具體重點＋2–5 個標籤，用 save_note 存進知識庫（url 填原始連結，content 放貼文文字），再回覆重點並說已存進「知識庫」。${owner}只是問連結在講什麼，就回答後問要不要存進知識庫。讀不到內容就照實說，請${owner}貼文字或截圖。
- 問以前存過的文章、影片、資料、保管箱裡的照片文件 → search_notes；回答用到的內容在句尾加上來源連結，例如 [1](#note-12)（網址用結果裡的 ref）。
- 行事曆：約會、會議、看診、上課、出遊、繳費截止這類「某天的事」→ add_event（產生確認卡片，按確認才寫入；說了提前提醒就填 remind_minutes）；問這週、某天有什麼事、有沒有空 → list_events；改時間、取消 → update_event／delete_event。只是「幾點提醒我做某件事」用 create_reminder。日期一律換成實際日期再填。
- 血壓、血糖、用藥、症狀、檢查數值這類健康問題由「健康管家」處理（會自動切換）：你不要回答醫療細節，請${owner}直接說「健康管家，…」或到「工具箱 → 健康管家」。
- 證件到期（護照、身分證、駕照、健保卡…）→ id_expiry（action add）：只記種類、持有人、到期日和號碼末四碼，絕對不要記完整號碼；問哪些證件快到期 → id_expiry（action list）。
- 錄音（語音備忘）整理好的會議記錄、逐字稿，以及上傳的文件（PDF、Word、PPT、Excel…）都存在知識庫：問開會說了什麼、文件裡寫什麼 → search_notes。結果裡的 passages 是原文段落，回答細節要根據 passages，並附上來源連結；段落開頭有【第 N 頁】就說在第幾頁。
- remember 只用來記之後還會用到的事。只有「過了某天就不再成立」的事（考試、約會、這週的安排）才填 expires；人名、家人、年齡、喜好、習慣、住址都不要填。
- 身分證字號、信用卡號、密碼這類敏感資料不要用 remember 記，也提醒${owner}不要在聊天裡傳。`;
  }

  private systemPrompt(trigger?: MessageRow, windowStartTs?: number): string {
    if (this.isPersonal()) return this.personalPrompt(trigger, windowStartTs);
    const p = this.p();
    const recall = trigger && windowStartTs ? this.recallOlder(trigger, windowStartTs) : "";
    const now = zoned(Date.now(), p.timezone);
    const dayNo = Math.floor((Date.parse(now.date + "T00:00:00Z") - Date.parse(p.startDate + "T00:00:00Z")) / 86400_000) + 1;
    const total = tripDays(p.startDate, p.endDate).length;
    const dayText = dayNo < 1 ? `出發前 ${1 - dayNo} 天` : dayNo > total ? "旅程已結束" : `旅程第 ${dayNo} 天`;
    const online = [...new Set(this.sockets().map((s) => s.user.name))];
    const a = p.accommodation;
    const kids = p.travelers.some((t) => t.kind === "小孩");
    const itin = this.itinerary()
      .map((d) => {
        const date = String(d.date);
        const wd = "日一二三四五六"[new Date(date + "T00:00:00Z").getUTCDay()];
        return `- ${date.slice(5).replace("-", "/")}（${wd}）${d.title || "（未安排）"}${d.detail ? `｜${d.detail}` : ""}${d.status ? `｜${d.status}` : ""}`;
      })
      .join("\n");
    const picked = this.relevantMemories(trigger ? memoryText(trigger) : "");
    const mems = picked.list.map((m) => `- #${m.id}［${m.category}］${m.content}（${m.author}）`).join("\n") || "（目前沒有）";
    const locs = this.memberLocation()
      .map((l) => `- ${l.name}：${l.area ? `${l.area}附近` : "地名查詢中"}（${l.lat.toFixed(5)},${l.lon.toFixed(5)}，${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`)
      .join("\n");
    const summary = this.setting("summary");
    const translations = this.sql
      .exec("SELECT * FROM translations ORDER BY ts DESC LIMIT 8")
      .toArray()
      .reverse()
      .map((r) => `- ${this.localTime(r.ts as number).slice(5)} ${r.author}（${r.from_lang === "zh" ? `中→${p.language}` : `${p.language}→中`}）：「${String(r.source).slice(0, 120)}」→「${String(r.result).slice(0, 120)}」`)
      .join("\n");
    const g = p.guide;
    const guide = [
      ["入境", g.entry], ["付款與小費", g.money], ["插座電壓", g.power], ["交通", g.transport], ["退稅", g.taxRefund], ["網路", g.connectivity], ["禮儀", g.etiquette], ["天氣", g.weather],
    ].filter(([, v]) => v).map(([k, v]) => `- ${k}：${String(v).replace(/\n+/g, " ")}`).join("\n");
    const hasTool = (n: string) => toolDecls(p).some((d) => d.name === n);
    const cards = this.draftBrief();

    return `你是「${AI_NAME}」，一個台灣家庭到${p.country}自由行的群組裡的 AI 旅遊助理。群組裡的每位成員都看得到你的回答。

# 現在
當地時間 ${now.date}（${now.weekday}）${now.time}（${diffFromTaiwan(p.timezone)}），${dayText}。
旅伴名單（記帳分攤預設對象）：${this.members().join("、") || "（尚無）"}；目前在線：${online.join("、") || "無"}

# 旅程
${tripLine(p)}（${p.travelers.map((t) => `${t.name}${t.kind === "小孩" ? "（小孩）" : ""}`).join("、")}）。${kids ? "回答要考慮小朋友（體力、推車、兒童票、廁所、休息）。" : ""}

# 住宿
${a.name || "（未提供名稱）"}${a.address ? `\n地址：${a.address}` : ""}${a.note ? `\n${a.note}` : ""}

# 航班與交通
${p.flights || "（未提供）"}

# 當地資訊（建立旅程時查的；規定會變動，重要事項仍要用工具確認）
- 貨幣：${p.currency}（${p.currencySymbol}）；語言：${p.language}
- 緊急電話：${p.emergency || "（未知，需要時用 web_search 查）"}
${guide}

# 最新行程（以這裡為準）
${itin}

# 長期記憶（成員偏好、決定、預訂…；開頭標【旅程名稱】的是以前旅程的回憶，可以拿來聊、了解家人，但不是這次的訂位或待辦；#編號可用 forget 刪除）${picked.list.length < picked.total ? `\n（共 ${picked.total} 條，這裡只列出跟這次對話最相關的；找不到就用 search_history）` : ""}
${mems}
${summary ? `\n# 更早的對話摘要\n${summary}\n` : ""}${recall ? `\n# 以前聊過、和這次問題相關的內容（依時間排序）\n${recall}\n` : ""}${locs ? `\n# 成員最近位置\n${locs}\n` : ""}${translations ? `\n# 最近在翻譯頁翻過的句子（成員問「剛剛跟店員說了什麼」時參考）\n${translations}\n` : ""}${cards ? `\n# 最近的確認卡片（等待確認的還沒寫入；要修改就重新呼叫同一個工具，replaces 填編號）\n${cards}\n` : ""}
# 回答規則
- 一律使用繁體中文與台灣用語，語氣親切，適合手機閱讀：精簡、條列、重點加粗，不要長篇大論。
- 不要用 LaTeX 或 $…$ 數學式，箭頭、乘號等直接寫 →、×、≈。
- 訊息開頭的［名字］代表是誰說的，回答時可以稱呼對方；但你的回答本身不要用［名字］開頭。
- 營業時間、票價、活動、交通、天氣、排隊等「會變動的資訊」一定要用工具查，並附上來源連結；查不到就說不確定，絕不編造。
- 工具回傳 error 代表失敗：要如實告訴成員沒有完成，不可以說已完成。記帳前確認分攤對象是否符合成員說的人數。
- 記帳（add_expense）、修改行程（update_itinerary）、刪除帳目或提醒：工具只會在你的回答下方產生確認卡片，要等成員按「確認」才會寫入。呼叫後用一兩句話說明你看到的內容（照片上的店名、日期、金額…）和準備寫入的內容，請成員核對卡片；絕對不要說「已記好／已更新／已刪除」。資料有疑問（日期不在旅遊期間、金額或幣別看不清楚、不確定誰付的）就先直接問成員，等成員回答再呼叫工具。成員要修改還沒確認的卡片，就重新呼叫同一個工具並在 replaces 填舊卡片編號。卡片只能靠呼叫工具產生，不要在回答裡自己寫卡片內容。還沒確認的卡片不用刪，請成員直接按卡片上的「取消」。
- 提到 ${p.currency} 價格時附上約合台幣（用 convert_currency）。
- 問路、問地鐵電車怎麼搭：照你知道的回答坐哪條線、往哪個方向、在哪轉乘（不要寫站數），最後用 plan_route 附 Google 地圖連結，提醒即時班次和月台以 Google 地圖為準；必要時用 web_search 補充轉乘與票價。成員問坐幾站、或要你查證／確認路線時，才用 check_route_map（官方路線圖優先），照它回傳的 routes 回答、寫出依據的路線圖（圖會附在回答下方）；呼叫時把你認為的搭法填在 legs 讓它核對；它沒找到可靠的圖，就說沒查到可以查證的路線圖，請大家看 Google 地圖。沒有用 check_route_map 時，不要說「依據路線圖」或「路線圖附在下方」。成員自己傳路線圖、時刻表或車站照片來問時，照照片上清楚看得到的內容回答。
- 提供店家、景點、展覽、活動、營業時間、票價、規定這類資訊（包括規劃行程時推薦的地點）之前，一定先用 web_search 查證最新狀況（店還在不在、有沒有營業、展覽或活動是否還在進行），不要憑記憶；優先採用官方網站（營運公司、政府、景點官網），找不到官方的才用其他網站，並註明來源；查不到就說查不到。
- 住宿的位置寫成 [📍住宿](map)（系統會換成正確位置）；要帶路回住宿就用 plan_route，destination 填「住宿」。不要自己用住宿名稱或地址搜尋，常會跑到別的地方。
- 地圖連結：工具回傳的連結可以直接用（find_nearby 給的是那家店的座標，照抄，不要改成店名搜尋，連鎖店用店名會跑到別家分店）；其他地點一律寫成 [📍地點名稱](map)，系統會自動換成 Google 地圖搜尋連結（地點名稱用日文或英文的正式名稱，連鎖店要加分店名，例如 [📍ドン・キホーテ 池袋駅西口店](map)）。不要自己寫 Google 地圖網址，絕對不要編 maps.app.goo.gl 短網址，也不要用自己記得的地址或座標當連結（記錯一個字就會指到別的地方）。
- 成員在哪裡，一律以「成員最近位置」或訊息裡附的地名為準，絕對不要自己猜地名；以前聊天裡說過的位置可能已經過時，不要沿用。
- 每次有人問「附近」都要重新呼叫工具查詢，不可以沿用之前的回答。
- 要看「大家自己拍、傳到聊天室的照片」（第一天的照片、我們在某地的合照、某人傳的照片、昨天吃的拉麵）→ find_chat_photos（「第一天」「昨天」換算成日期，內容寫進 keyword），照片會顯示在回答下方，不是網路圖片；沒找到就照實說，不要拿網路圖片代替。
- 你可以用 find_images 把網路上的圖片直接顯示給成員（照片、捷運／地鐵路線圖、平面圖、菜單…），絕對不要說「無法傳送圖片」。
- 成員要求看網路上的照片／圖片／路線圖時，一定要用 find_images（店名或景點名稱加地名；好幾個地方就放進 queries 一次查完）；圖片會自動顯示在回答下方。絕對不要自己產生圖片網址或圖片搜尋連結，並提醒是網路圖片、僅供參考。沒有要求就不要找圖片。
- 成員想看任何地點、店家、美食、景點的影片或實際畫面時，不管怎麼說（短片、影片、Reels、YouTube、有人拍嗎、想看看長怎樣、好啊找找看…），都用 find_short_videos 去找（places 填當地語言名稱、中文名稱、地區、類別、keywords），影片卡片會自動顯示在回答下方；不要沒查就叫成員自己去 IG 或 YouTube 搜尋，也絕對不要自己寫 IG、YouTube、TikTok 的影片網址；成員沒要看影片就不要主動找（回答下方會有找短片的按鈕）；成員說「另外」「其他」「剩下的」，就找還沒找過的地點。預設找當地語言的；成員想看中文介紹的（台灣人拍的、聽得懂的），language 填 chinese 再找一次。
- 問「我附近有什麼」：直接用 find_nearby，near 留空（系統會自動用發問者的 GPS），回答時列出實際店名、距離、步行分鐘與地圖連結；需要評價再用 web_search 補充。問「我在哪」用 get_member_locations，說出區域與最近的車站。
- 問計程車多少錢、要多久 → taxi_fare；問地震、颱風、天氣會不會影響行程 → disaster_alerts；問樂園排隊 → theme_park_wait_times。${hasTool("train_status") ? "問電車有沒有延誤、停駛 → train_status。" : ""}
- 收到收據照片（或說「記帳這張收據」）：讀出店名、日期、總金額、幣別與主要品項，用 add_expense 產生記帳卡片（description 寫「店名：品項」），付款人預設是發問者。幣別要看清楚：當地收據是 ${p.currency}，台灣收據是 TWD（NT$、民國年、統一發票）；民國年要加 1911（113 年＝2024 年）。若可能達退稅門檻，順便提醒。
- 只有成員明確說「加入／加到清單」時才用 add_checklist_items。只是說想買、要帶、問推薦，都不可以自動加入清單；只有成員提到想買或要帶東西時，才在回答最後問一句要不要加進清單，其他話題（例如記帳、問路）不要問。買到了、帶了、辦好了 → update_checklist_item；問清單 → get_checklist。
- 要求「幾點提醒」→ create_reminder（時間用當地時間 YYYY-MM-DD HH:mm）。
- 一次收到好幾張照片（例如菜單好幾頁）：當成同一份資料一起整理，不要一張一張分開回答。菜單：依類別分組，每道寫中文翻譯（原文）和價格（當地幣別附約合台幣，例如「900 円（約 NT$190）」），標出推薦、辣、生食、含酒精、適合小孩的；看不清楚的照實說。
- 傳照片說要「存起來／存成票券」→ save_document（說要放哪個資料夾，例如「存到機票」，就填 folder）；問「給我看○○的票／訂位」→ find_documents（關鍵字也可以是資料夾名稱）。
- 有人傳「🆘」走散求助：先安撫，用 get_member_locations 看大家在哪，建議就近約在明顯地標或車站出口集合，提醒可找工作人員幫忙${p.emergency ? `、緊急電話 ${p.emergency}` : ""}。
- 有人說「我付了／花了…」→ 用 add_expense 產生記帳卡片；問「花多少、怎麼分」→ expense_summary。只有成員說付了、花了、要記帳，或傳收據時才記帳；問「怎麼儲值、怎麼買票、要多少錢」是在問做法或價格，直接回答，不要問金額、不要產生記帳卡片。
- 成員做了決定、說了偏好、訂了東西 → 主動用 remember 記下來；行程要改就用 update_itinerary 產生修改卡片。只有 remember 成功後才能說「已記住」。
- 收到照片：辨識菜單、商品、看板、車票並翻譯說明；商品可以查價比價。
- 安全第一：遇到緊急狀況提供當地緊急電話${p.emergency ? `（${p.emergency}）` : ""}與最近的醫院資訊（find_nearby 的 hospital）。`;
  }

  /** 地圖連結修正：提到住宿的連結一律換成正確位置（模型用住宿名稱搜尋常跑到別處、地址會抄錯字） */
  private mapFix(): MapFixOptions {
    const a = this.p().accommodation;
    const coords = a.lat != null && a.lon != null ? `${a.lat},${a.lon}` : "";
    const dest = coords || a.address || a.name;
    if (!dest) return {};
    const names = [a.name, a.address].map((s) => (s || "").trim()).filter((s) => s.length >= 3).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return {
      home: {
        names: names.length ? new RegExp(names.join("|"), "i") : null,
        search: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest)}`,
        dest,
      },
    };
  }

  /** 這次的問題是在回覆哪一則訊息：給模型完整原文（可能早就超出最近的對話紀錄） */
  private replyContext(trigger: MessageRow): string {
    const reply = trigger.meta ? JSON.parse(trigger.meta).reply : null;
    if (!reply) return "";
    const full = this.sql.exec<MessageRow>("SELECT author, text FROM messages WHERE id = ?", reply.id).toArray()[0];
    const text = String(full?.text ?? reply.text ?? "").slice(0, 2000);
    return `（我在回覆 ${full?.author ?? reply.author} 的這則訊息，請針對它回答：「${text}」）\n`;
  }

  private buildTurns(history: MessageRow[], trigger: MessageRow, images: Part[]): Turn[] {
    const turns: Turn[] = [];
    const push = (role: Turn["role"], text: string) => {
      const last = turns[turns.length - 1];
      if (last && last.role === role) (last.parts as Part[]).push({ text });
      else turns.push({ role, parts: [{ text }] });
    };
    for (const m of history) {
      if (m.id === trigger.id) continue;
      if (m.role === "assistant") push("model", m.text.slice(0, HISTORY_CHARS) || "（略）");
      else if (m.role === "user") {
        let t = `［${m.author}］${replyNote(m.meta, 150)}${m.text.slice(0, HISTORY_CHARS)}`;
        if (m.photo_id) t += photosOf(m).length > 1 ? `（附了 ${photosOf(m).length} 張照片）` : "（附了一張照片）";
        if (m.lat != null) t += `（分享位置 ${m.lat?.toFixed(5)},${m.lon?.toFixed(5)}）`;
        push("user", t);
      }
    }
    let t = `［${trigger.author}］${this.replyContext(trigger)}${trigger.text || (trigger.photo_id ? (photosOf(trigger).length > 1 ? "請看這幾張照片" : "請看這張照片") : "")}`;
    if (trigger.lat != null) {
      const area = this.memberLocation(trigger.author)[0]?.area;
      t += `（我目前的位置：${area ? `${area}附近，` : ""}座標 ${trigger.lat?.toFixed(5)},${trigger.lon?.toFixed(5)}。位置可能變了，需要地點資訊請用工具重新查詢，不要沿用之前的回答）`;
    }
    const parts: Part[] = [{ text: t }, ...images];
    const last = turns[turns.length - 1];
    if (last && last.role === "user") last.parts.push(...parts);
    else turns.push({ role: "user", parts });
    // Gemini 要求第一個是 user
    while (turns.length && turns[0].role !== "user") turns.shift();
    return turns;
  }

  private async runAgent(trigger: MessageRow, user: Attachment) {
    const id = newId();
    const p = this.p();
    let order = await this.chain(!!trigger.photo_id);
    let decls = toolDecls(p);
    // 健康話題：整輪改由 Cloudflare 的模型回答（Gemini 條款禁止用來提供醫療建議），對話標記成健康、不進一般記憶。
    // 紅旗症狀直接給固定的就醫提示，不交給 AI 分析
    let health = false;
    if (this.isPersonal() && !trigger.photo_id) {
      const flag = redFlagText(trigger.text);
      if (flag) {
        this.markHealth(trigger.id);
        const row = this.insertMessage({ id, author: AI_NAME, role: "assistant", text: flag, photo_id: null, lat: null, lon: null, meta: JSON.stringify({ kind: "health_alert", health: true }) });
        this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
        return;
      }
      if (isHealthTopic(trigger.text)) {
        health = true;
        this.markHealth(trigger.id);
        order = (await this.workersAiBlocked()) ? [] : ["workers-ai"];
        decls = healthToolDecls(p);
      }
    }
    const available = new Set(decls.map((d) => d.name));

    if (!order.length) {
      const row = this.insertMessage({
        id, author: AI_NAME, role: "assistant", photo_id: null, lat: null, lon: null, meta: JSON.stringify({ error: true, ...(health ? { health: true } : {}) }),
        text: health
          ? "健康管家今天的 AI 額度用完了（Cloudflare 免費額度，台灣時間早上 8 點恢復）🙇\n\n血壓、血糖、體重還是可以到「工具箱 → 健康管家」直接記錄。"
          : "抱歉，今天的免費 AI 額度用完了 🙇\n\n管理員可以到 下方「設定」→ API 金鑰，填入自己的 Gemini 金鑰（免費申請）就能繼續使用；或等台灣時間早上 8 點額度重置。",
      });
      this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
      return;
    }

    const photoParts: Part[] = photosOf(trigger).flatMap((pid) => {
      const ph = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", pid).toArray()[0];
      return ph ? [{ image: { mime: ph.mime as string, data: toBase64(ph.data as ArrayBuffer) } }] : [];
    });
    const image: Part | null = photoParts[0] ?? null;
    // 附了位置就先把地名查好，AI 才不會自己猜在哪裡
    if (trigger.lat != null) await this.ensureArea(trigger.author);
    // 一般對話看不到健康對話（不會傳給 Gemini）；健康對話可以看一般對話
    const history = this.recentMessages(HISTORY_WINDOW).filter((m) => health || !healthMessage(m));
    if (!health) await this.prepareMemoryQuery(memoryText(trigger));
    const system = health ? this.healthPrompt() : this.systemPrompt(trigger, history[0]?.ts ?? trigger.ts);
    const images: AttachedImage[] = [];
    // 這次工具回傳的內容：檢查回答裡的影片網址是不是工具找到的
    let toolJson = "";
    // 這次找短片的地點（「改找中文介紹的」按鈕要寫上店名）
    const videoPlaces: string[] = [];
    const toolsUsed: string[] = [];
    const lastResults: Record<string, unknown> = {};
    const drafts: number[] = [];
    const ctx = await this.toolCtx(user.name, {
      photoId: trigger.photo_id,
      question: trigger.text,
      attachImage: (img) => images.length < 8 && images.push(img),
      propose: (d) => this.propose(d, user.name, id, drafts),
    });
    // 成員像是在修改剛才還沒確認的卡片（「打錯了，是 3500」）
    const fixing = /改成|改為|改一下|打錯|寫錯|記錯|不對|應該是|更正|修正/.test(trigger.text)
      ? this.sql.exec("SELECT id, kind, preview FROM drafts WHERE status = 'pending' AND ts > ? ORDER BY id DESC LIMIT 1", Date.now() - 30 * 60_000).toArray()[0]
      : undefined;
    let lastError = "";
    // 跨模型共用：前一個模型中途被限流時，下一個模型接著已完成的工具結果繼續，不會重複記帳或重複查詢
    let turns = this.buildTurns(history, trigger, photoParts);
    const onWait = (ms: number) => this.broadcast({ type: "ai_note", id, text: `Gemini 額度冷卻中，等待 ${Math.ceil(ms / 1000)} 秒…` });

    for (const pid of order) {
      const provider = await this.provider(pid, 1, FOREGROUND_MAX_WAIT, onWait);
      this.broadcast({ type: "ai_start", id, provider: provider.id, label: PROVIDER_LABEL[provider.id], model: provider.model, ...(health ? { health: true } : {}) });
      let finalText = "";
      const nudged = new Set<string>();
      const forced = new Set<string>();
      let emptyRetried = false;
      let cardNudged = false;
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const res = await provider.generate({
            system, turns, tools: decls, onDelta: (delta) => this.broadcast({ type: "ai_delta", id, delta }),
            // 好幾張照片（菜單好幾頁）回答會很長，45 秒不夠
            ...(photoParts.length > 1 ? { timeoutMs: 120_000 } : {}),
            // Gemini 塞車時不要乾等：後面還有備援就只等它開始回應 15 秒（附照片 30 秒）
            ...(pid !== order[order.length - 1] ? { firstChunkMs: photoParts.length ? 30_000 : 15_000 } : {}),
          });
          if (!res.calls.length) {
            // 模型偶爾偷懶：嘴上說「已加入清單」「圖片在下方」卻沒呼叫工具。提醒一次，重新回答
            let need = requiredTool(trigger.text, toolsUsed, !!trigger.photo_id, available);
            // 嘴上說找了影片（或叫成員自己去搜影片）卻沒呼叫工具：關鍵字沒中也要它真的去找
            if (!need && available.has("find_short_videos") && !toolsUsed.includes("find_short_videos") && VIDEO_CLAIM.test(res.text)) need = "find_short_videos";
            // 回答裡有搭車步驟卻沒用 plan_route：要它用工具產生 Google 導航連結（模型自己手寫的網址常把站名編碼錯，例如「新木巴駅」）
            if (!need && available.has("plan_route") && routeAnswer(res.text) && !toolsUsed.includes("plan_route") && !toolsUsed.includes("check_route_map")) need = "plan_route";
            // 回答裡有店家景點、營業、展覽活動資訊，這一輪卻沒上網查：先查證再講（看照片回答的、健康管家不算）
            if (!need && !health && available.has("web_search") && !trigger.photo_id && needsVerification(res.text, toolsUsed)) need = "web_search";
            // 要寫入資料的工具：AI 正在反問成員（日期不在旅遊期間、金額看不清…）就讓它問，不要蓋掉硬寫
            if (need && DRAFT_TOOLS.has(need) && isAskingBack(res.text)) need = null;
            if (need && !nudged.has(need) && step < MAX_STEPS - 1) {
              nudged.add(need);
              this.broadcast({ type: "ai_reset", id });
              turns = [
                ...turns,
                { role: "model", parts: [{ text: res.text || "（略）" }] },
                { role: "user", parts: [{ text: need === "web_search" ? VERIFY_NUDGE : `（系統提醒：你還沒有呼叫 ${need}，這件事一定要呼叫 ${need} 才算完成，沒有呼叫就不能說已完成。請現在呼叫，再根據結果完整回答。成員沒看到你剛才那段回答，不用道歉，也不要提到這個提醒。）` }] },
              ];
              continue;
            }
            // 提醒過還是不呼叫：系統自己執行工具，再請模型根據結果回答
            if (need && !forced.has(need) && step < MAX_STEPS - 1) {
              forced.add(need);
              const note = await this.forceTool(need, provider, history, trigger, user, id, ctx, toolsUsed, image, lastResults, res.text);
              if (note) {
                this.broadcast({ type: "ai_reset", id });
                turns = [...turns, { role: "model", parts: [{ text: res.text || "（略）" }] }, { role: "user", parts: [{ text: note }] }];
                continue;
              }
            }
            // 嘴上說「請核對下方的卡片」卻沒呼叫工具（或成員在改還沒確認的卡片）：提醒它真的去呼叫
            if (!drafts.length && !cardNudged && (claimsCard(res.text) || fixing) && step < MAX_STEPS - 1) {
              cardNudged = true;
              this.broadcast({ type: "ai_reset", id });
              const hint = fixing
                ? `成員可能是要修改還沒確認的卡片 #${fixing.id}（${JSON.parse(fixing.preview as string).summary}）：是的話，請重新呼叫 ${fixing.kind}，所有欄位填修改後的完整內容，replaces 填 ${fixing.id}；不是的話就照原本的意思回答。`
                : "你說下方有確認卡片，但你沒有呼叫任何工具，成員看不到卡片。記帳 → add_expense；改行程 → update_itinerary；刪帳 → delete_expense；刪提醒 → delete_reminder；修改還沒確認的卡片要填 replaces。請現在呼叫，再簡短說明。";
              turns = [
                ...turns,
                { role: "model", parts: [{ text: res.text || "（略）" }] },
                { role: "user", parts: [{ text: `（系統提醒：${hint}成員沒看到你剛才那段回答，不用道歉，也不要提到這個提醒。）` }] },
              ];
              continue;
            }
            // 查完工具後偶爾一個字都不回（以為剛才那段被收回的回答已經講過了），再請它回一次
            if (!res.text.trim() && !emptyRetried && toolsUsed.length && step < MAX_STEPS - 1) {
              emptyRetried = true;
              turns = [
                ...turns,
                { role: "model", parts: [{ text: "（略）" }] },
                { role: "user", parts: [{ text: "（系統提醒：你剛才沒有輸出任何文字，成員什麼都沒看到。請根據上面的工具結果，直接完整回覆成員，不用道歉。）" }] },
              ];
              continue;
            }
            finalText = res.text;
            break;
          }
          const modelParts: Part[] = [];
          if (res.text) modelParts.push({ text: res.text });
          for (const c of res.calls) modelParts.push({ call: c });
          const resultParts: Part[] = [];
          for (const c of res.calls) {
            // 成員沒要求看圖：AI 自己找圖片只會拖慢、用掉額度，跳過
            if (c.name === "find_images" && !IMAGE_ASK.test(trigger.text)) {
              resultParts.push({ result: { id: c.id, name: c.name, response: { skipped: true, note: "成員沒有要求看圖片，這次不找圖片，直接用文字回答" } } });
              continue;
            }
            toolsUsed.push(c.name);
            this.broadcast({ type: "ai_tool", id, name: c.name, label: toolLabel(c.name), args: c.args });
            if (c.name === "find_short_videos") {
              if (CHINESE_ASK.test(trigger.text)) c.args = { ...c.args, language: "chinese" };
              for (const p of Array.isArray(c.args.places) ? (c.args.places as any[]) : []) videoPlaces.push(String(p?.name_zh || p?.name_local || "").slice(0, 30));
            }
            const result = await runTool(c.name, c.args, ctx);
            lastResults[c.name] = result;
            toolJson += JSON.stringify(result ?? "");
            resultParts.push({ result: { id: c.id, name: c.name, response: result } });
          }
          turns = [...turns, { role: "model", parts: modelParts }, { role: "user", parts: resultParts }];
          if (step === MAX_STEPS - 1) finalText = res.text || "（查了很多資料，但還沒整理完，請再問一次更具體的問題 🙏）";
        }
        if (!images.length) finalText = dropMapClaims(finalText);
        // 說找到影片，卻一張影片卡片都沒有（模型沒照工具結果講）：改成照實說沒有
        if (toolsUsed.includes("find_short_videos") && !images.some((im) => im.video) && /找到|附上|下方|卡片/.test(finalText) && !/沒(有)?找到|找不到|沒有.{0,8}(影片|短片)/.test(finalText)) {
          const names = [...new Set(videoPlaces.filter(Boolean))];
          finalText = `這次沒有找到${CHINESE_ASK.test(trigger.text) ? "中文介紹的" : "相關的"}影片 🙇${names.length ? `可以直接在 IG 或 YouTube 搜尋「${names.join("」「")}」看看。` : ""}`;
        }
        if (provider.id === "workers-ai" && !toolsUsed.includes("check_route_map") && (ROUTE_ASK.test(trigger.text) || routeAnswer(finalText)) && /線|轉乘|方向|站/.test(finalText)) finalText = `${finalText.trim()}\n\n${BACKUP_ROUTE_NOTE}`;
        // 憑記憶回答的路線：下方放查證按鈕（已經查證過、問延誤的、健康管家不用）
        const quick =
          !health && decls.some((d) => d.name === "check_route_map") && !toolsUsed.includes("check_route_map") && !trigger.photo_id &&
          (ROUTE_ASK.test(trigger.text) || routeReply(finalText)) && !/延誤|停駛|誤點|運行/.test(trigger.text) && /線|轉乘|方向|站/.test(finalText)
            ? routeCheckButton(trigger.text)
            : !health && available.has("find_short_videos") && !toolsUsed.includes("find_short_videos") && !trigger.photo_id && finalText.length > 80 && (PLACE_ASK.test(trigger.text) || (finalText.match(PLACE_LINK) ?? []).length >= 2)
              ? videoButton(trigger.text)
              : toolsUsed.includes("find_short_videos") && !CHINESE_ASK.test(trigger.text) &&
                  // 找到的影片已經全是中文就不用再找；一支都沒找到時照樣可以改找中文
                  (!images.some((im) => im.video) || images.some((im) => im.video && !zhCaption(im.caption)))
                ? chineseButton(videoPlaces)
                : null;
        finalText = dropFakeVideoLinks(finalText, toolJson + images.map((im) => im.page ?? "").join(" "));
        finalText = dropFakeCoords(finalText, toolJson);
        if (!finalText.trim()) finalText = images.length ? "幫你找到這些圖片 👇（網路圖片，僅供參考）" : "嗯…我沒有想到好的回答，可以換個方式問我嗎？";
        const row = this.insertMessage({
          id, author: AI_NAME, role: "assistant", text: fixMapLinks(stripSpeakerTag(finalText), this.mapFix()), photo_id: null, lat: null, lon: null,
          meta: JSON.stringify({
            // 回答的是誰（「只看我和 AI 的對話」用）
            for: { id: trigger.id, author: trigger.author },
            provider: provider.id, providerLabel: PROVIDER_LABEL[provider.id], model: provider.model, tools: [...new Set(toolsUsed)].map(toolLabel),
            ...(images.length ? { images } : {}),
            ...(drafts.length ? { drafts } : {}),
            ...(quick ? { quick } : {}),
            ...(health ? { health: true } : {}),
          }),
        });
        this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
        this.ctx.waitUntil(this.maybeConsolidateMemory());
        this.ctx.waitUntil(this.registry().touchRoom(this.roomId()));
        return;
      } catch (e: any) {
        this.noteQuota(e);
        lastError = String(e?.message ?? e);
        const rateLimited = e instanceof RateLimitedError || e instanceof WorkersAiQuotaError || /Gemini (429|503)/.test(lastError);
        if (!rateLimited) console.error(`provider ${pid} failed`, lastError);
        this.broadcast({ type: "ai_retry", id, error: lastError, rateLimited });
      }
    }

    const noOwn = !(await this.keys()).gemini;
    const row = this.insertMessage({
      // 中途產生的確認卡片還是附上，成員照樣可以確認
      id, author: AI_NAME, role: "assistant", photo_id: null, lat: null, lon: null, meta: JSON.stringify({ error: true, ...(drafts.length ? { drafts } : {}), ...(health ? { health: true } : {}) }),
      text: `抱歉，AI 暫時無法回答 🙇${noOwn ? "\n\n如果常常遇到，管理員可以到 下方「設定」→ API 金鑰填入自己的 Gemini 金鑰。" : ""}\n\n\`${lastError.slice(0, 200)}\``,
    });
    this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
  }

  /**
   * 模型提醒過仍不呼叫工具時，由系統代為執行，回傳要交給模型的結果說明。
   * find_images：先請模型（JSON 模式，很穩定）從對話整理出要找圖的地點，再一次查完。
   */
  private async forceTool(
    need: string, provider: Provider, history: MessageRow[], trigger: MessageRow, user: Attachment,
    id: string, ctx: ToolContext, toolsUsed: string[], image: Part | null, lastResults: Record<string, unknown> = {}, draft = "",
  ): Promise<string | null> {
    const p = this.p();
    let args: Record<string, unknown>;
    if (need === "find_images") {
      const lastAi = [...history].reverse().find((m) => m.role === "assistant" && m.id !== id)?.text ?? "";
      const area = this.memberLocation(user.name)[0]?.area ?? p.city;
      let queries: string[] = [];
      try {
        const r = await provider.generate({
          system: "你只輸出 JSON。",
          turns: [{ role: "user", parts: [{ text: `成員說：「${trigger.text}」\n上一則 AI 回答：\n${lastAi.slice(0, 1500)}\n成員所在地區：${area || "未知"}\n\n成員想看哪些地點、店家或東西的照片？列出搜尋關鍵字（名稱加地名），最多 4 個。只輸出 JSON：{"queries":["..."]}` }] }],
          json: true,
        });
        const j = parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as any;
        queries = (j.queries ?? []).map((q: unknown) => String(q).trim()).filter(Boolean).slice(0, 4);
      } catch {}
      if (!queries.length) queries = [trigger.text.replace(/給我看|提供|請|幫我找|的?(照片|圖片|相片)|你推薦的/g, "").trim() || trigger.text];
      args = { queries, count: Math.min(queries.length * 2, 6) };
    } else if (need === "save_note") {
      // 只貼了連結卻沒存：用剛才讀到的內容（沒讀過就先讀）請模型整理成一筆
      const url = trigger.text.match(/https?:\/\/[^\s<>"）)]+/)?.[0];
      let read = lastResults.read_webpage as any;
      if (!read && url) read = await runTool("read_webpage", { url }, ctx);
      if (!read || read.error) return null;
      try {
        const r = await provider.generate({
          system: "你只輸出 JSON。",
          turns: [{ role: "user", parts: [{ text: `把下面讀到的內容整理成知識庫的一筆：title（20 字內，說清楚是什麼）、summary（3–6 點具體重點，Markdown 條列，寫出工具、做法、數字、網址）、tags（2–5 個）。只輸出 JSON：{"title":"...","summary":"...","tags":["..."]}\n內容：${JSON.stringify(read).slice(0, 6000)}` }] }],
          json: true,
        });
        const j = parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as any;
        args = { title: j.title, summary: j.summary, tags: j.tags, url: read.url || url, content: String(read.caption ?? read.content ?? "").slice(0, 3000) };
      } catch {
        return null;
      }
      if (!args.title || !args.summary) return null;
    } else if (need === "read_webpage") {
      const url = trigger.text.match(/https?:\/\/[^\s<>"）)]+/)?.[0];
      if (!url) return null;
      args = { url };
    } else if (need === "find_nearby") {
      const t = trigger.text;
      const category =
        /便利商店|超商/.test(t) ? "convenience" : /藥妝|藥局|藥/.test(t) ? "drugstore" : /廁所|洗手間/.test(t) ? "toilet"
        : /咖啡|cafe/i.test(t) ? "cafe" : /超市/.test(t) ? "supermarket" : /ATM|提款|換匯|換錢/i.test(t) ? "atm" : /置物櫃|寄物/.test(t) ? "locker"
        : /車站|捷運|地鐵|電車/.test(t) ? "station" : /公園|遊樂場/.test(t) ? "park" : /醫院|診所|看醫生/.test(t) ? "hospital" : /購物|百貨|商場|逛街/.test(t) ? "shopping" : "food";
      args = { category };
    } else {
      // 其他工具：請模型用 JSON 模式（很穩定）照工具規格產生參數，收據照片也一起給它看
      const decl = toolDecls(p).find((d) => d.name === need);
      if (!decl) return null;
      const now = zoned(Date.now(), p.timezone);
      try {
        const parts: Part[] = [{
          text: `成員（${user.name}）說：「${trigger.text}」${need === "find_short_videos" || need === "plan_route" ? `\n上一則 AI 回答：\n${([...history].reverse().find((m) => m.role === "assistant" && m.id !== id)?.text ?? "").slice(0, 1500)}` : ""}${need === "web_search" && draft ? `\n你剛才準備回答的內容（要查證裡面的店家、景點、活動是否還在、資訊是否正確，產生查證用的搜尋關鍵字）：\n${draft.slice(0, 1200)}` : ""}
現在是當地時間 ${now.date}（${now.weekday}）${now.time}。${p.kind === "personal" ? "" : `旅程 ${p.startDate} 到 ${p.endDate}（第一天＝${p.startDate}）。`}旅伴名單：${this.members().join("、") || user.name}。當地貨幣 ${p.currency}。
請產生呼叫工具「${need}」要用的參數。
工具說明：${decl.description}
參數格式（JSON Schema）：${JSON.stringify(decl.parameters)}
只輸出參數的 JSON 物件，不要任何其他文字。`,
        }];
        if (image && need === "add_expense") parts.push(image);
        const r = await provider.generate({ system: "你只輸出 JSON。", turns: [{ role: "user", parts }], json: true });
        args = parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
      } catch {
        return null;
      }
      if (!Object.keys(args).length) return null;
    }
    toolsUsed.push(need);
    this.broadcast({ type: "ai_tool", id, name: need, label: toolLabel(need), args });
    const result = await runTool(need, args, ctx);
    return `（系統已經幫你執行 ${need}，結果如下。請根據結果完整回答成員，不用道歉；不要自己產生任何圖片或搜尋連結，圖片會自動顯示在回答下方。）\n${JSON.stringify(result).slice(0, 6000)}`;
  }

  /**
   * 長期記憶（越用越懂你）：每累積幾則新訊息就自動
   * 1) 更新整段旅程的對話摘要 2) 萃取新的偏好／決定／預訂／待辦 3) 刪掉過時或被推翻的記憶。
   * 只有成功才推進游標，失敗的那批下次會再整理，不會漏掉。
   */
  private async maybeConsolidateMemory() {
    if (this.consolidating) return;
    const cursor = Number(this.setting("memory_cursor", "0"));
    const fresh = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts > ? ORDER BY ts", cursor).toArray();
    if (fresh.filter((m) => m.role === "user").length < MEMORY_EVERY) return;
    this.consolidating = true;

    // 系統自己發的訊息（歡迎、提醒、早報、預算、日記）不算對話：歡迎訊息裡的範例會被當成使用者說的事
    const transcript = fresh.filter((m) => !systemMade(m)).slice(-80).map((m) => `${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 500)}`).join("\n");
    const shown = this.memoriesFor(transcript);
    const existing = shown.list.map((m) => `#${m.id}［${m.category}］${m.content}`).join("\n") || "（無）";
    const personal = this.isPersonal();
    // 記憶暫停中：這段期間的對話不整理（游標照樣往前，之後也不會補記）
    if (personal && this.setting("memory_paused") === "1") {
      this.setSetting("memory_cursor", String(fresh[fresh.length - 1].ts));
      this.consolidating = false;
      return;
    }
    const today = this.today();
    const prompt = personal
      ? `以下是個人助理和使用者最新的對話（今天是 ${today}），請整理長期記憶：
1. summary：把「舊摘要」與新對話合併成新的「長期對話摘要」（400 字內；保留進行中的事情、做過的決定、重要資訊）。
2. about_me：更新「關於我」（300 字內）：只放長期穩定的事（家人與朋友、住哪、工作與作息、飲食、興趣、重要偏好）。保留現有內容中仍然正確的部分（包含使用者自己寫的），有新的穩定事實才修改；沒有變化就原樣輸出。
3. memories：萃取新對話中「之後還會用到」且「不在現有記憶裡」的事實，每條一句話。
   - 提到的日期一律寫成實際日期（不要寫「明天」「下週」）。
   - 是在更新某條現有記憶（例如搬家、換工作、時間改了），replaces 填那條記憶的 id；不是就填 0。
   - 只在短期內有效的事（考試、這週的安排、某天的約），expires 填失效日期 YYYY-MM-DD；長期有效就填空字串。
   - 對話中已經用 remember 記下、或意思跟現有記憶一樣的，不要再新增，也不要換句話說去取代。
   - 只有「過了某天就不再成立」的事（考試、約會、這週的安排）才填 expires；人名、家人、年齡、喜好、習慣、住址一律填空字串。
   - 不要收錄身分證字號、信用卡號、密碼、病歷細節這類敏感資料，也不要收錄閒聊、花費明細（記帳另外記）或 AI 自己的建議。沒有就回空陣列。
4. remove_ids：現有記憶中已經過時或被推翻的 id（會標成「已取代」保留歷史，不會真的刪掉）。沒有就回空陣列。

舊摘要：
${this.setting("summary") || "（無）"}

現在的「關於我」：
${this.setting("core_profile") || "（無）"}

現有記憶${shown.list.length < shown.total ? `（共 ${shown.total} 條，這裡只列出跟新對話有關的 ${shown.list.length} 條；remove_ids 只能從這些裡面挑）` : ""}：
${existing}

新對話：
${transcript}

輸出 JSON：{"summary": "...", "about_me": "...", "memories": [{"content": "...", "category": "偏好|決定|預訂|資訊|待辦", "expires": "", "replaces": 0}], "remove_ids": [數字]}`
      : `以下是家庭旅遊群組最新的對話，請整理群組的長期記憶：
1. summary：把「舊摘要」與新對話合併成新的「整趟旅程對話摘要」（400 字內；保留每個人的偏好、做過的決定、討論過的店家與地點、待辦、重要資訊）。
2. memories：萃取新對話中「之後還會用到」且「不在現有記憶裡」的事實，每條一句話、寫清楚是誰。
   例如：誰喜歡／不吃什麼、想買什麼、想去哪、決定了什麼、訂了什麼、待辦事項、聊到的店名與地址。
   不要收錄住宿地址、航班這些系統已知的資料，也不要收錄閒聊或 AI 自己的建議。沒有就回空陣列。
3. remove_ids：現有記憶中已經過時、被新對話推翻、或重複的記憶 id。沒有就回空陣列。

舊摘要：
${this.setting("summary") || "（無）"}

現有記憶${shown.list.length < shown.total ? `（共 ${shown.total} 條，這裡只列出跟新對話有關的 ${shown.list.length} 條；remove_ids 只能從這些裡面挑）` : ""}：
${existing}

新對話：
${transcript}

輸出 JSON：{"summary": "...", "memories": [{"content": "...", "category": "偏好|決定|預訂|資訊|待辦"}], "remove_ids": [數字]}`;
    try {
      // 背景整理只用 Gemini 一半的額度、不等待，把額度留給回答問題
      const json = parseArgs((await this.generateText(personal ? "你是負責整理個人助理長期記憶的助理，只輸出 JSON。" : "你是負責整理旅遊群組長期記憶的助理，只輸出 JSON。", prompt, true, 0.5)).replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as any;
      if (typeof json.summary === "string" && json.summary.trim()) this.setSetting("summary", json.summary.trim().slice(0, 2000));
      if (personal) {
        if (typeof json.about_me === "string" && json.about_me.trim()) this.setSetting("core_profile", json.about_me.trim().slice(0, 800));
        // 使用者親口說的記憶，整理時不能當成「重複」移掉，只能被內容真的不同的新事實取代
        for (const rid of (json.remove_ids ?? []).slice(0, 20)) {
          if (Number.isInteger(Number(rid))) this.sql.exec("UPDATE memories SET status = 'superseded', updated = ? WHERE id = ? AND COALESCE(status, 'active') = 'active' AND COALESCE(source, 'auto') != 'user'", Date.now(), Number(rid));
        }
        const active = this.memories();
        for (const m of (json.memories ?? []).slice(0, 20)) {
          const content = String(m?.content ?? "").trim();
          if (!content || this.memoryGuard(content)) continue;
          const old = active.find((x) => Number(x.id) === Number(m.replaces));
          // 跟現有的某條講的是同一件事：不新增、不取代（模型常常把剛記的換句話說再記一次）
          if (active.some((x) => sameFact(String(x.content), content))) continue;
          const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(m.expires ?? "")) ? String(m.expires) : null;
          const id = this.insertMemory(content, String(m.category || "資訊"), "AI 自動整理", "auto", expires);
          if (old) this.sql.exec("UPDATE memories SET status = 'superseded', superseded_by = ?, updated = ? WHERE id = ?", id, Date.now(), old.id);
        }
      } else {
        for (const rid of (json.remove_ids ?? []).slice(0, 20)) {
          if (Number.isInteger(Number(rid))) this.sql.exec("DELETE FROM memories WHERE id = ?", Number(rid));
        }
        // 跟現有的某條講同一件事就不再記（模型常把記過的換句話說再記一次，記憶才會一直變多）
        const known = this.memories().map((x) => String(x.content));
        for (const m of (json.memories ?? []).slice(0, 20)) {
          const content = String(m?.content ?? "").trim();
          if (!content || known.some((x) => sameFact(x, content))) continue;
          this.addMemory(content, String(m.category || "資訊"), "AI 自動整理");
          known.push(content);
        }
      }
      this.setSetting("memory_cursor", String(fresh[fresh.length - 1].ts));
      this.broadcastState();
    } catch (e) {
      if (!(e instanceof RateLimitedError)) console.error("memory consolidation failed", e);
    } finally {
      this.consolidating = false;
    }
  }
}

// ---------------- 共用檢查（index.ts 建立旅程時也會用） ----------------

export function checkDates(start: string, end: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return "日期格式不正確";
  const days = (Date.parse(end) - Date.parse(start)) / 86400_000;
  if (!(days >= 0)) return "回程日期不能早於出發日期";
  if (days > 60) return "旅程最長 60 天";
  return null;
}

export function cleanTravelers(list: any[]): Traveler[] {
  const seen = new Set<string>();
  const out: Traveler[] = [];
  for (const t of list.slice(0, 20)) {
    const name = String(t?.name ?? "").trim().slice(0, 16);
    if (!name || name === AI_NAME || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, kind: t?.kind === "小孩" ? "小孩" : "大人" });
  }
  return out;
}

/** Tavily 金鑰檢查：用 /usage，不會扣額度 */
export async function validateTavily(key: string): Promise<string | null> {
  if (!/^tvly-[\w-]{10,}$/.test(key)) return "Tavily 金鑰格式不對（應該是 tvly- 開頭）";
  try {
    const res = await fetch("https://api.tavily.com/usage", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return "Tavily 金鑰無效，請重新複製";
    if (!res.ok) return null; // 服務暫時有問題時不要擋住使用者
    const d: any = await res.json().catch(() => ({}));
    const k = d.key ?? {};
    if (k.limit && k.usage >= k.limit) return "這組 Tavily 金鑰本月額度已經用完了";
    return null;
  } catch {
    return null;
  }
}

/** Gemini 金鑰檢查：列出模型，不會扣額度 */
export async function validateGemini(key: string): Promise<string | null> {
  if (key.length < 20) return "Gemini 金鑰太短，請重新複製";
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 400 || res.status === 401 || res.status === 403) return "Gemini 金鑰無效，請重新複製";
    return null;
  } catch {
    return null;
  }
}
