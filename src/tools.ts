import { sign } from "./auth";
import { localToUtc, zoned, type TripProfile } from "./profile";
import type { Env, ToolDecl } from "./types";

/** 工具可以用到的聊天室功能（由 TripRoom 實作） */
export interface RoomApi {
  members(): string[];
  memberLocation(name?: string): { name: string; lat: number; lon: number; accuracy: number | null; ts: number; area: string | null }[];
  addMemory(content: string, category: string, author: string): number;
  /** remember 工具用：個人助理會擋敏感資料、記憶暫停時不記 */
  remember(content: string, category: string, author: string, expires?: string): unknown;
  /** 影片交給會看影片的 AI（Gemini）做摘要；沒有就回 null */
  describeVideo(mime: string, base64: string, hint: string): Promise<string | null>;
  /** 個人助理知識庫 */
  noteSave(n: { title: string; summary: string; content?: string; url?: string; tags?: string[]; thumb?: string }, author: string): unknown;
  noteSearch(keyword: string): unknown;
  /** 健康管家（只在健康對話裡給 Cloudflare 的模型用） */
  healthLog(args: Record<string, unknown>): unknown;
  healthStatus(): unknown;
  healthMeds(args: Record<string, unknown>): unknown;
  healthProfile(args: Record<string, unknown>): unknown;
  /** 證件到期（只記種類、持有人、到期日、末四碼） */
  idDocAdd(d: { kind?: unknown; holder?: unknown; expires?: unknown; last4?: unknown }, author: string): unknown;
  idDocList(): unknown;
  /** 行事曆 */
  eventList(from: string, to: string): unknown[];
  eventGet(id: number): (EventInput & { id: number }) | null;
  eventFind(keyword: string): (EventInput & { id: number })[];
  /** 個人帳本：某個月的花費、分類、預算 */
  ledger(month?: string): unknown;
  deleteMemory(id: number): boolean;
  searchHistory(keyword: string, limit: number): { ts: number; author: string; text: string }[];
  updateItinerary(date: string, fields: { title?: string; detail?: string; status?: string }, author: string): unknown;
  addExpense(e: ExpenseInput): unknown;
  deleteExpense(id: number): boolean;
  expenseSummary(): unknown;
  checklistAdd(list: string, items: string[], forWhom: string, author: string): unknown;
  checklistUpdate(match: { id?: number; keyword?: string; list?: string }, patch: { done?: boolean; remove?: boolean }, by: string): unknown;
  checklistGet(list?: string): unknown;
  reminderAdd(due: number, message: string, author: string): unknown;
  reminderList(): unknown;
  reminderDelete(id: number): boolean;
  reminderGet(id: number): { id: number; time: string; message: string } | null;
  itineraryDay(date: string): { title: string; detail: string; status: string } | null;
  expenseGet(id: number): ExpenseBrief | null;
  /** 品項關鍵字找帳（空字串＝最近的幾筆） */
  expenseFind(keyword: string): ExpenseBrief[];
  documentSave(title: string, note: string, photoId: string, author: string, folder?: number | null): unknown;
  documentFind(keyword?: string): { id: number; title: string; note: string; photo_id: string; author: string; ts: number; folder: string }[];
  /** 翻聊天室裡大家傳過的照片 */
  chatPhotos(q: { date?: unknown; dateTo?: unknown; sender?: unknown; keyword?: unknown; ids?: string[]; count?: unknown }): Promise<{
    total: number;
    shown: { id: string; when: string; by: string; kind: string; note: string }[];
    catalog: { id: string; when: string; by: string; kind: string; note: string }[];
  }>;
  /** 只根據路線圖回答怎麼搭（Gemini 看圖；不能用就回 null） */
  readRouteMap(image: { bytes: ArrayBuffer; mime: string }, origin: string, destination: string, city: string, proposal?: string): Promise<ReturnType<typeof cleanRouteMap> | null>;
  documentFolder(name: string, author: string): number | null;
  cacheGet(key: string, maxAgeMs: number): string | null;
  cacheSet(key: string, value: string): void;
}

export interface ExpenseBrief {
  id: number;
  date: string;
  description: string;
  amount: number;
  currency: string;
  payer: string;
}

export interface ExpenseInput {
  description: string;
  amount: number;
  currency: string;
  amountLocal: number;
  amountTwd: number;
  payer: string;
  splitAmong: string[];
  category: string;
  date: string;
  author: string;
}

export interface AttachedImage {
  src: string; // 經過本站轉送的網址
  caption: string;
  label?: string; // 這張圖是哪個地點（搜尋關鍵字）
  source: string; // 圖片所在網站
  page?: string; // 來源網頁
  /** 短片卡片（find_short_videos）：page 是影片網址，src 是縮圖 */
  video?: { platform: "Instagram" | "YouTube"; author: string; verified: boolean };
}

export interface ToolContext {
  env: Env;
  room: RoomApi;
  profile: TripProfile;
  /** 這個旅程自己的 Tavily 金鑰 */
  tavilyKey: string;
  author: string;
  /** 發問者這則訊息的文字（找附近要分辨地點是成員自己講的、還是 AI 自己填的） */
  question?: string;
  /** 發問者這則訊息附的照片（存票券、讀收據用） */
  photoId?: string | null;
  /** 工具找到的圖片，會附在這次 AI 回答下方 */
  attachImage?: (img: AttachedImage) => void;
  /** AI 發起的寫入（記帳、改行程、刪除）先做成確認卡片，成員按確認才寫入；畫面上手動操作沒有這個，直接寫 */
  propose?: (d: DraftInput) => unknown;
}

/** 要成員按確認才會執行的動作 */
export type DraftKind = "add_expense" | "update_itinerary" | "delete_expense" | "delete_reminder" | "add_event" | "update_event" | "delete_event";
export const DRAFT_TOOLS = new Set<string>(["add_expense", "update_itinerary", "delete_expense", "delete_reminder", "add_event", "update_event", "delete_event"]);

/** 行事曆的一個行程（時間都是空間時區的當地時間；沒有 start＝整天） */
export interface EventInput {
  title: string;
  date: string;
  start?: string | null;
  end?: string | null;
  location?: string | null;
  note?: string | null;
  remindMin?: number | null;
}

export interface DraftInput {
  kind: DraftKind;
  /** 確認後原封不動拿去寫入的資料 */
  payload: unknown;
  /** 卡片內容：rows 是 [欄位, 新值, 原本的值?]；summary 給系統提示用 */
  preview: { title: string; confirm: string; summary: string; rows: [string, string, string?][] };
  /** 取代還沒確認的舊卡片 */
  replaces?: number;
  /** 要 AI 特別提醒成員的地方 */
  warning?: string;
}

const REPLACES_PARAM = { type: "integer", description: "修正還沒確認的卡片時，填那張卡片的編號（見系統提示「最近的確認卡片」）" };

/** 住宿：模型寫「住宿」「民宿」或住宿名稱時，換成正確的目的地（有座標用座標，否則用地址） */
function homeOr(place: string, p: TripProfile): string {
  const a = p.accommodation;
  const dest = a.lat != null && a.lon != null ? `${a.lat},${a.lon}` : a.address;
  if (!dest) return place;
  const t = place.trim();
  const named = [a.name, a.address].some((s) => s && s.trim().length >= 3 && t.includes(s.trim()));
  return named || /^(我們的?|回)?(民宿|住宿|住的地方|飯店|酒店|旅館|airbnb)$/i.test(t) ? dest : place;
}

function money(amount: number, currency: string, p?: TripProfile): string {
  const n = Number(amount).toLocaleString("en-US", { maximumFractionDigits: Math.abs(amount) >= 100 ? 0 : 2 });
  if (currency === "TWD") return `NT$${n}`;
  if (p && currency === p.currency && p.currencySymbol) return `${p.currencySymbol}${n}`;
  return `${n} ${currency}`;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400_000).toISOString().slice(0, 10);
}

type Executor = (args: any, ctx: ToolContext) => Promise<unknown>;

interface Tool {
  decl: ToolDecl | ((p: TripProfile) => ToolDecl);
  label: string;
  /** 只在某些國家提供（例如日本的電車運行資訊） */
  only?: (p: TripProfile) => boolean;
  run: Executor;
}

const UA = "TripAgent/1.0 (family travel assistant)";

async function getJSON(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": UA, accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`);
  return res.json();
}

function localDate(p: TripProfile, offsetDays = 0): string {
  return zoned(Date.now() + offsetDays * 86400_000, p.timezone).date;
}

export function normalizeDate(input: string, p: TripProfile): string | null {
  const s = String(input ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (m) return `${p.startDate.slice(0, 4)}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (s.includes("今天")) return localDate(p);
  if (s.includes("明天")) return localDate(p, 1);
  if (s.includes("後天")) return localDate(p, 2);
  return null;
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toRad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function mapsLink(q: string | { lat: number; lon: number }): string {
  const query = typeof q === "string" ? q : `${q.lat},${q.lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** 住宿座標，沒有就用城市中心 */
export function homeOf(p: TripProfile): { name: string; lat: number; lon: number } | null {
  const a = p.accommodation;
  if (a.lat != null && a.lon != null) return { name: `住宿（${a.name || a.address}）`, lat: a.lat, lon: a.lon };
  if (p.center) return { name: `${p.city || p.country}市中心`, lat: p.center.lat, lon: p.center.lon };
  return null;
}

const langShort = (p: TripProfile) => p.langCode.slice(0, 2).toLowerCase() || "en";

// ---------------- 匯率 ----------------

export async function fxRate(ctx: ToolContext, from: string, to: string): Promise<{ rate: number; updated: string; estimated?: boolean }> {
  const f = from.toUpperCase(), t = to.toUpperCase();
  if (f === t) return { rate: 1, updated: "" };
  const key = `fx:${f}`;
  let data: any;
  const cached = ctx.room.cacheGet(key, 3600_000);
  if (cached) data = JSON.parse(cached);
  else {
    try {
      data = await getJSON(`https://open.er-api.com/v6/latest/${f}`);
      if (data.result !== "success") throw new Error("匯率服務暫時無法使用");
      ctx.room.cacheSet(key, JSON.stringify({ rates: data.rates, time_last_update_utc: data.time_last_update_utc }));
    } catch (e) {
      // 用最後一次成功的匯率（最多 14 天）
      const stale = ctx.room.cacheGet(key, 14 * 86400_000);
      if (stale) data = { ...JSON.parse(stale), stale: true };
      else throw e;
    }
  }
  const rate = data.rates?.[t];
  if (!rate) throw new Error(`不支援的幣別 ${t}`);
  return { rate, updated: data.time_last_update_utc ?? "", estimated: !!data.stale };
}

// ---------------- 天氣代碼 ----------------

export const WEATHER: Record<number, string> = {
  0: "晴天 ☀️", 1: "大致晴朗 🌤", 2: "晴時多雲 ⛅", 3: "陰天 ☁️", 45: "有霧 🌫", 48: "霧淞 🌫",
  51: "毛毛雨 🌦", 53: "毛毛雨 🌦", 55: "較強毛毛雨 🌧", 61: "小雨 🌧", 63: "中雨 🌧", 65: "大雨 🌧",
  66: "凍雨", 67: "凍雨", 71: "小雪 🌨", 73: "中雪 🌨", 75: "大雪 ❄️", 80: "陣雨 🌦", 81: "較強陣雨 🌧",
  82: "豪大陣雨 ⛈", 95: "雷雨 ⛈", 96: "雷雨伴冰雹 ⛈", 99: "強雷雨伴冰雹 ⛈",
};

const COORD_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
// 繁體字地名換成日文漢字，日本地圖資料才查得到（例如 龜有→亀有、舞濱→舞浜）
const JA_KANJI: Record<string, string> = { 龜: "亀", 濱: "浜", 澤: "沢", 櫻: "桜", 驛: "駅", 樂: "楽", 國: "国", 廣: "広", 淺: "浅", 邊: "辺", 黑: "黒", 圓: "円", 學: "学", 內: "内", 藏: "蔵", 總: "総", 鐵: "鉄", 藝: "芸", 橫: "横", 關: "関", 鹽: "塩", 戶: "戸" };

/** 地名或座標 → 位置。先查 OpenStreetMap（限定在旅遊國家），再退回 Open-Meteo */
export async function locate(place: string, p: TripProfile): Promise<{ name: string; lat: number; lon: number } | null> {
  const m = place.match(COORD_RE);
  if (m) return { name: `${m[1]},${m[2]}`, lat: Number(m[1]), lon: Number(m[2]) };
  const variants = [place];
  if (p.countryCode === "JP") variants.unshift([...place].map((c) => JA_KANJI[c] ?? c).join(""));
  const cc = p.countryCode.toLowerCase();
  for (const q of [...new Set(variants)]) {
    try {
      const r = (await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=${cc}&accept-language=${langShort(p)},zh-TW,en&q=${encodeURIComponent(q)}`))[0];
      if (r) return { name: r.name || q, lat: Number(r.lat), lon: Number(r.lon) };
    } catch {}
  }
  try {
    const d = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variants[0])}&count=1&countryCode=${p.countryCode}`);
    const r = d.results?.[0];
    return r ? { name: r.name, lat: r.latitude, lon: r.longitude } : null;
  } catch {
    return null;
  }
}

/** 地名搜尋（引導設置找住宿、初始化找城市用），回傳前幾個候選 */
export async function searchPlaces(q: string, countryCode?: string, limit = 5): Promise<{ name: string; address: string; lat: number; lon: number }[]> {
  const cc = countryCode && /^[a-z]{2}$/i.test(countryCode) ? `&countrycodes=${countryCode.toLowerCase()}` : "";
  const list = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}${cc}&accept-language=zh-TW,en&q=${encodeURIComponent(q)}`, undefined, 10_000);
  return (list as any[]).map((r) => ({ name: r.name || String(r.display_name).split(",")[0], address: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }));
}

/** 座標 → 人看得懂的地名，給 AI 用，避免它自己猜 */
export async function reverseArea(lat: number, lon: number, lang = "en"): Promise<string> {
  const g = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=zh-TW,${lang},en&zoom=17`, undefined, 8_000);
  const a = g.address ?? {};
  const parts = [a.state, a.city || a.county, a.town || a.city_district || a.suburb, a.quarter || a.neighbourhood, a.road].filter(Boolean);
  return [...new Set(parts)].join(" ") || g.display_name || "";
}

const IMG_UA = "Mozilla/5.0 (compatible; TripAgent/1.0)";
const IMG_MAX_BYTES = 1_500_000;

/** 圖片能不能顯示：200、真的是圖片、不要太大（手機流量） */
async function imageUsable(url: string): Promise<boolean> {
  try {
    if (!/^https?:\/\//.test(url)) return false;
    const res = await fetch(url, { headers: { "user-agent": IMG_UA, accept: "image/*" }, signal: AbortSignal.timeout(4_000) });
    const type = res.headers.get("content-type") ?? "";
    const size = Number(res.headers.get("content-length") || 0);
    await res.body?.cancel();
    return res.ok && type.startsWith("image/") && (!size || size <= IMG_MAX_BYTES);
  } catch {
    return false;
  }
}

// ---------------- 查證路線圖：官方優先，找不到才用維基共享資源、其他網站 ----------------

/** /api/img 轉送的上限：超過就顯示不出來 */
const ROUTE_MAP_MAX = 5_000_000;
/** 短片網址整理成固定格式（IG Reels、YouTube Shorts）；個人頁、標籤頁這類不是單支影片的回 null */
function videoOf(u: string): { platform: "Instagram" | "YouTube"; url: string; id: string; short: boolean } | null {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^(www|m)\./, "");
    if (host === "instagram.com") {
      const m = x.pathname.match(/^\/(?:[\w.]+\/)?(reels?|p)\/([\w-]{5,})/);
      return m ? { platform: "Instagram", url: `https://www.instagram.com/${m[1] === "p" ? "p" : "reel"}/${m[2]}/`, id: m[2], short: m[1] !== "p" } : null;
    }
    if (host === "youtube.com" || host === "youtu.be") {
      const m = x.pathname.match(/\/shorts\/([\w-]{11})/) ?? x.pathname.match(/\/source\/([\w-]{11})\/shorts/);
      if (m) return { platform: "YouTube", url: `https://www.youtube.com/shorts/${m[1]}`, id: m[1], short: true };
      // 一般影片也收（Shorts 排前面）：介紹店家的常是一般長度的影片
      const id = host === "youtu.be" ? x.pathname.slice(1, 12) : x.pathname === "/watch" ? (x.searchParams.get("v") ?? "") : "";
      return /^[\w-]{11}$/.test(id) ? { platform: "YouTube", url: `https://www.youtube.com/watch?v=${id}`, id, short: false } : null;
    }
  } catch {}
  return null;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/**
 * 確認影片真的存在，順便拿標題、作者、縮圖：YouTube 用官方 oEmbed；IG 用網頁版的 oEmbed（沒有公開文件，隨時可能失效）。
 * 404／400＝已刪除或不存在；其他錯誤＝沒辦法確認（不要當成失效）
 */
async function checkVideo(v: { platform: string; url: string; id: string }): Promise<{ ok: boolean | null; title?: string; author?: string; thumb?: string; vertical?: boolean }> {
  const api =
    v.platform === "YouTube"
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(v.url)}`
      : `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(v.url)}`;
  try {
    const r = await fetch(api, { headers: { "user-agent": BROWSER_UA, accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
    if (r.status === 404 || r.status === 400) return { ok: false };
    if (!r.ok) return { ok: null };
    const j: any = await r.json();
    return {
      ok: true, title: String(j.title ?? ""), author: String(j.author_name ?? ""),
      thumb: v.platform === "YouTube" ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : typeof j.thumbnail_url === "string" ? j.thumbnail_url : undefined,
      vertical: Number(j.thumbnail_height) > Number(j.thumbnail_width),
    };
  } catch {
    return { ok: null };
  }
}

/** 文字比對用：繁體／日文漢字、全半形、大小寫、撇號和點（T's／T’s）都算一樣 */
const textKey = (s: unknown) => [...String(s ?? "").normalize("NFKC")].map((c) => KANJI[c] ?? c).join("").toLowerCase().replace(/[\s'’‘`´・·.\-_]+/g, "");

async function tavilyVideos(key: string, query: string, domains: string[]) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
      body: JSON.stringify({ query, max_results: 10, search_depth: "basic", include_domains: domains }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const d: any = await res.json();
    return (d.results ?? []).map((r: any) => ({ url: String(r.url ?? ""), title: String(r.title ?? ""), content: String(r.content ?? ""), score: Number(r.score) || 0 }));
  } catch {
    return [];
  }
}

/** 中文說明（繁體、簡體都算）：中文常用字比平假名多（日本人寫的說明平假名很多；店名的片假名不算） */
export const zhCaption = (t: string) => (t.match(/[的是我們们這这很超吃喝好推薦荐必在了嗎吗吧呢也都就還还真]/g) ?? []).length > (t.match(/[\u3041-\u309f]/g) ?? []).length;

/** 只是料理或類別、不是店名（「池袋串燒」的「串燒」） */
const GENERIC_FOOD = /^(串燒|串焼き?|焼き?鳥|燒鳥|やきとり|居酒屋|美食|グルメ|拉麵|拉面|ラーメン|燒肉|烤肉|焼肉|壽司|寿司|すし|咖啡|カフェ|甜點|スイーツ|餐廳|レストラン|맛집|小吃|夜景|景點|觀光|購物|逛街|美食街|食べ歩き)$/;

/** 別的國家、地區（中文創作者常拍台灣、香港分店；港幣、台幣「460元」、.hk 帳號也算；日圓寫「円」「日圓」不會中） */
const ELSEWHERE = /全台|台灣|臺灣|台北|臺北|新北|台中|臺中|台南|臺南|高雄|新竹|桃園|香港|澳門|\.hk\b|hk\$|nt\$|\d+\s*元|紐約|ニューヨーク|\bnyc?\b|アメリカ|美國|新加坡|馬來西亞|吉隆坡|上海|北京|深圳|廣州|曼谷/i;
/** 同一個國家的其他大城市（連鎖店別的分店） */
const OTHER_CITIES: [RegExp, RegExp][] = [
  [/日本/, /大阪|梅田|難波|京都|名古屋|福岡|博多|札幌|仙台|神戸|神戶|横浜|橫濱|千葉|柏市|埼玉|大宮|沖縄|沖繩|那覇|広島|廣島|金沢|金澤/],
  [/韓/, /釜山|부산|대구|大邱|濟州|済州|제주|인천|仁川|광주|光州/],
];

type ShortPlace = { name_local: string; name_zh: string; area: string; category: string; keywords: string[] };

/** 一個地點的短片：IG、YouTube 同時查；過濾掉不是單支影片、跟地點無關、已刪除的；IG 最多 3 支、YouTube 最多 2 支，合計 4 支 */
async function placeVideos(key: string, country: string, city: string, p: ShortPlace, lang: "local" | "chinese") {
  const zh = lang === "chinese";
  const reel = /韓/.test(country) ? "릴스" : /日本/.test(country) ? "リール" : "reels";
  const withArea = (name: string) => [name, p.area && !name.includes(p.area) ? p.area : ""].filter(Boolean).join(" ");
  // 店名或景點名本身要出現在影片說明裡：用 AI 給的 keywords；沒有就從名稱去掉地區和分店（「池袋店」「駅前店」）
  const branch = /(店|駅|站|역|점|口|前)$/;
  const tokens = [p.name_local, p.name_zh].flatMap((n) => n.split(/[\s　]+/)).filter((t) => t && !(p.area && t.includes(p.area)) && !branch.test(t));
  const names = (p.keywords.length ? p.keywords : tokens).map((k) => (p.area ? k.split(p.area).join("").trim() : k) || k);
  const cores = names.map(textKey).filter((n) => n.length >= 2);
  const inArea = (t: string) => !!p.area && textKey(t).includes(textKey(p.area));
  // 「池袋串燒」這種泛稱（只有料理或類別、沒有店名）：影片也要提到地區，不然會找到別的城市，甚至「金曲串燒」這種歌
  const generic = names.length > 0 && names.every((n) => GENERIC_FOOD.test(n.replace(/\s+/g, "")));
  const relevant = (t: string) => cores.some((c) => textKey(t).includes(c)) && (!generic || !p.area || inArea(t));
  const seen = new Set<string>();
  // IG 只限 /reel 路徑才不會混進圖文貼文；YouTube 只限網域（限定 /shorts 反而不準）
  const collect = async (igQuery: string, ytQuery: string) => {
    const [ig, yt] = await Promise.all([
      tavilyVideos(key, igQuery.replace(/\s+/g, " "), ["instagram.com/reel"]),
      tavilyVideos(key, ytQuery, ["youtube.com"]),
    ]);
    const hits = [...ig, ...yt].flatMap((r) => {
      const v = videoOf(r.url);
      if (!v || seen.has(v.id)) return [];
      seen.add(v.id);
      // Tavily 有時只抓到 IG 的登入頁，看不出內容，要等 oEmbed 拿到說明再比對
      const login = /^instagram$/i.test(r.title.trim()) || /^(log ?in|sign ?up|ログイン|로그인)/i.test(r.content.trim());
      // YouTube 有些影片在這裡播不了（oEmbed 還是會回成功）
      if (/content isn.t available|この動画は再生できません/i.test(r.content)) return [];
      return [{ ...v, text: `${r.title} ${r.content}`, head: r.title, login, score: r.score }];
    }).filter((h) => h.login || relevant(h.text));
    const pick = [...hits.filter((h) => h.platform === "Instagram").slice(0, 5), ...hits.filter((h) => h.platform === "YouTube").slice(0, 3)];
    const checked = await Promise.all(pick.map(async (h) => ({ ...h, ...(await checkVideo(h)) })));
    // Tavily 的說明常混進別頁的內容：確認存在的只看平台回傳的影片說明；沒辦法確認的只看 Tavily 的標題
    return checked
      .map((h) => ({ ...h, own: h.ok === true ? `${h.title ?? ""} ${h.login ? "" : h.head}` : h.head }))
      .filter((h) => (h.ok === true || (h.ok === null && !h.login)) && relevant(h.own))
      // 連鎖店別處分店的影片（香港、台灣、紐約、其他城市）：提到別處的，要明確提到這次的地區才留（「東京發祥、NY 上陸」只提到城市不算）
      .filter((h) => !elsewhere(`${h.own} ${h.author ?? ""}`) || inArea(h.own));
  };
  // 影片有提到這次的地區或城市；或講的是別的國家、同國其他城市（連鎖店別的分店）
  const inPlace = (t: string) => inArea(t) || (!!city && textKey(t).includes(textKey(city)));
  const here = `${country}${city}${p.area}`;
  const others = OTHER_CITIES.find(([c]) => c.test(country))?.[1];
  const elsewhere = (t: string) => (ELSEWHERE.test(t) && !ELSEWHERE.test(here)) || (!!others && others.test(t) && !others.test(here));
  // 第一次：當地人拍的用當地語言＋地區＋類別找 IG、中文＋shorts 找 YouTube；
  // 中文影片用中文名＋國家名找（加國家名才不會找到台灣分店），YouTube 不限 Shorts（中文創作者常拍一般長度的 vlog）
  const zhName = withArea(p.name_zh || p.name_local);
  let ok = zh
    ? await collect(`${zhName} ${country}`, `${zhName} ${country}`)
    : await collect(`${withArea(p.name_local)} ${p.category} ${reel}`, `${withArea(p.name_zh || p.name_local)} shorts`);
  // 找不太到：分店名、類別常讓搜尋跑偏（例如不存在的「池袋東口店」），改用店名本身＋地區再找一次，YouTube 這次不限 Shorts
  if (ok.length < 2 || (zh && ok.filter((h) => zhCaption(h.own)).length < 2)) {
    // 中文再找一次：優先用跟 name_zh 不同的中文俗稱（官方譯名「鱈魚岬烹飪坊」幾乎沒人用，台灣人叫「達菲餐廳」）
    const isZhName = (k: string) => /[\u4e00-\u9fff]/.test(k) && !/[\u3040-\u30ff\uac00-\ud7af]/.test(k);
    const name =
      (zh && (p.keywords.find((k) => isZhName(k) && !p.name_zh.includes(k)) || p.keywords.find(isZhName))) || p.keywords[0] || tokens[0] || p.name_local;
    ok = [...ok, ...(await (zh ? collect(`${withArea(name)} ${country}`, `${withArea(name)} ${country} vlog`) : collect(`${withArea(name)} ${reel}`, withArea(name))))];
  }
  ok.sort(
    (a, b) =>
      (zh ? Number(zhCaption(b.own)) - Number(zhCaption(a.own)) : 0) ||
      Number(b.ok === true) - Number(a.ok === true) || Number(inArea(b.own)) - Number(inArea(a.own)) || Number(inPlace(b.own)) - Number(inPlace(a.own)) ||
      Number(b.short) - Number(a.short) || Number(!!b.vertical) - Number(!!a.vertical) || b.score - a.score,
  );
  // 要中文的：只留中文說明的；一支都沒有就是沒有，不拿其他語言的充數（先挑中文，不然沒提到地名的中文影片會被下一步刷掉）
  if (zh) ok = ok.filter((h) => zhCaption(h.own));
  // 有 2 支以上確定講這裡（提到地區或城市）的，就只留這些
  if (ok.filter((h) => inPlace(h.own)).length >= 2) ok = ok.filter((h) => inPlace(h.own));
  return [...ok.filter((h) => h.platform === "Instagram").slice(0, 3), ...ok.filter((h) => h.platform === "YouTube").slice(0, 2)].slice(0, 4);
}

/** find_short_videos：每個地點找 IG Reels、YouTube Shorts，影片卡片附在回答下方（網址不經過模型，不會是編的） */
async function findShortVideos(args: any, key: string, country: string, city: string, env: Env, attachImage?: (img: AttachedImage) => void) {
  if (!key) return { error: "沒有設定 Tavily 搜尋金鑰，沒辦法找短片" };
  const s = (v: unknown, n = 40) => String(v ?? "").trim().slice(0, n);
  const places: ShortPlace[] = (Array.isArray(args.places) ? args.places : [])
    .slice(0, 2)
    .map((p: any) => ({
      name_local: s(p?.name_local) || s(p?.name_zh), name_zh: s(p?.name_zh), area: s(p?.area, 20), category: s(p?.category, 20),
      keywords: (Array.isArray(p?.keywords) ? p.keywords : []).map((k: unknown) => s(k, 30)).filter(Boolean).slice(0, 4),
    }))
    .filter((p: ShortPlace) => p.name_local);
  if (!places.length) return { error: "請提供要找短片的地點或店家名稱" };
  const language = args.language === "chinese" ? "chinese" : "local";
  const found = await Promise.all(places.map((p) => placeVideos(key, country, city, p, language)));
  // 每個地點各找到幾支：模型常把沒找的地點也寫進回答，要它照這個講
  const summary = places.map((p, i) => `${p.name_zh || p.name_local}：${found[i].length} 支`);
  const videos: { place: string; platform: string; title: string; author: string; verified: boolean }[] = [];
  for (const [i, list] of found.entries()) {
    const place = places[i].name_zh || places[i].name_local;
    for (const v of list) {
      const title = (v.title || v.head).replace(/\s*[|｜-]\s*(Instagram|YouTube)\s*$/i, "").replace(/\s+/g, " ").trim().slice(0, 80);
      const thumb = v.thumb ? `/api/img?u=${encodeURIComponent(v.thumb)}&s=${await sign(env, "img:" + v.thumb)}` : "";
      attachImage?.({ src: thumb, caption: title, label: place, source: v.platform, page: v.url, video: { platform: v.platform, author: v.author ?? "", verified: v.ok === true } });
      videos.push({ place, platform: v.platform, title, author: v.author ?? "", verified: v.ok === true });
    }
  }
  if (!videos.length) {
    const what = language === "chinese" ? "中文介紹的影片" : "確定跟這些地點有關的短片";
    return { found: 0, summary, note: `沒有找到${what}：直接照實說沒有，不要說找到了；可以建議成員自己在 IG 或 YouTube 搜尋「${places.map((p) => (language === "chinese" ? p.name_zh || p.name_local : p.name_local)).join("」「")}」。不要自己寫影片網址。` };
  }
  return {
    found: videos.length, summary, videos,
    language,
    note:
      "影片卡片（縮圖、標題、連結）已經自動顯示在回答下方。只講 summary 裡這次實際找的地點（0 支的照實說沒找到），不要提這次沒有找的地點；用一兩句話說大概在介紹什麼；絕對不要自己寫影片網址。IG 沒登入可能只能看幾支。" +
      (language === "chinese" ? "這些是中文介紹的影片；summary 裡 0 支的地點要照實說沒有中文影片。" : "成員想看中文介紹的，可以用 language=chinese 再找一次。") +
      (videos.some((v) => !v.verified) ? "標「未確認」的是沒辦法確認還在不在的影片。" : ""),
  };
}

/** 官方來源：營運公司、政府、交通局的網域 */
const OFFICIAL_HOST = /metro|subway|mrt|transit|railway|rail|kotsu|tetsudo|\.go\.|\.gov|\.or\.jp|jreast|jrwest|toei|bts|mtr|krta|korail|smrt|lta\.|tfl\./i;
/** 維基共享資源要求說明是誰在用 */
const WIKI_UA = "TripAgent/1.0 (family travel assistant)";

/** 請 AI 只根據路線圖回答怎麼搭：坐哪條線、往哪個方向、在哪轉乘 */
export function routeMapPrompt(city: string, origin: string, destination: string, proposal = ""): string {
  const check = proposal
    ? `有人建議這樣搭：
${proposal}
請先在圖上逐段核對這個建議：每一段的上下車站是不是都在那條線上（看車站編號）、轉乘站是不是兩條線都有停。建議可行，routes 第一條就照建議的走法寫（填上圖上的車站編號），proposal_ok 填 true；有錯，proposal_ok 填 false，在 uncertain 說明哪裡錯，routes 改寫你在圖上找到的正確走法。
`
    : "";
  return `這是${city}的鐵路／地鐵路線圖。請只根據這張圖上看得到的內容，回答怎麼從「${origin}」到「${destination}」。
${check}只輸出 JSON：
{"is_route_map": 這張是不是${city}現在的鐵路／地鐵路線圖（true／false）, "proposal_ok": 建議的走法在圖上核對可行嗎（true／false；沒有建議就 null）,
 "origin_found": 圖上找得到出發站嗎（或旁邊相連、可以走過去的站）, "origin_on_map": "圖上的站名", "destination_found": 圖上找得到目的地站嗎, "destination_on_map": "圖上的站名",
 "routes": [{"summary": "一句話說明", "legs": [{"line": "路線名稱（照圖上寫的）", "line_code": "路線代號（例如 G；圖上沒有就空字串）", "from": "上車站", "from_no": "上車站在這條線的車站編號（例如 \"Y18\"；圖上沒有就空字串）", "to": "下車站（轉乘站或目的地）", "to_no": "下車站在這條線的車站編號", "loop": 這條線是不是繞一圈的環狀線（true／false）, "direction": "往哪個終點方向（看得出來才寫）"}], "transfers": ["轉乘站"], "walk": "需要步行的地方（例如出發站不在地鐵上、走地下通道到相連的站），沒有就空字串"}],
 "uncertain": "看不清楚或不確定的地方（字太小、線重疊、看不出是否直通）"}
請比較所有可行的走法，優先選轉乘次數最少、總站數最少的；出發站或目的地附近有用地下通道相連的車站，可以步行過去轉乘（寫在 walk）。最多 2 條路線，最好的排前面，每條路線的最後一段一定要到目的地站。站名和車站編號照圖上寫的（編號要是那一段路線的編號，例如銀座線的銀座是 G09），看不清楚就寫在 uncertain，不要用記憶補；找不到出發站或目的地站，就把 routes 設成空陣列。`;
}

/** 站名比對：繁體、日文漢字、「站」「駅」的寫法都算同一站 */
const KANJI: Record<string, string> = { 淺: "浅", 樂: "楽", 澀: "渋", 藏: "蔵", 驛: "駅", 國: "国", 廣: "広", 濱: "浜", 澤: "沢", 邊: "辺", 當: "当", 圓: "円", 會: "会", 學: "学", 總: "総", 實: "実", 鐵: "鉄", 戶: "戸", 櫻: "桜", 惠: "恵", 兩: "両", 縣: "県", 區: "区", 發: "発", 轉: "転", 門: "門", 晝: "昼", 舊: "旧", 檜: "桧", 麥: "麦", 齋: "斎", 黑: "黒", 龜: "亀", 條: "条", 濟: "済", 劍: "剣", 驗: "験", 壽: "寿", 竜: "竜", 龍: "竜", 島: "島", 嶋: "島", 惣: "惣", 塚: "塚", 豐: "豊", 灣: "湾", 臺: "台", 萬: "万", 與: "与", 雜: "雑", 稻: "稲", 葉: "葉" };
function stationKey(s: string): string {
  return [...String(s ?? "").normalize("NFKC")].map((c) => KANJI[c] ?? c).join("").replace(/\s|（.*?）|\(.*?\)|駅|站|station|stn\.?/gi, "").toLowerCase();
}
function sameStation(a: string, b: string): boolean {
  const x = stationKey(a), y = stationKey(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** 車站編號拆成路線代號和號碼（G09、JY01、BL12）；最後一欄是能不能拿來算站數 */
function stationNo(no: string): [string, number, boolean] | null {
  const t = no.normalize("NFKC").trim().toUpperCase();
  const m = t.match(/^([A-Z]{1,3})\s*-?\s*(\d{1,3})$/);
  if (m) return [m[1], Number(m[2]), true];
  // 首爾、釜山的三位數編號：第一碼是路線（424 是 4 號線）。只拿來核對路線，不算站數（2 號線是環狀，相減會錯）
  const n = t.match(/^(\d)(\d{2})$/);
  return n ? [n[1], Number(n[2]), false] : null;
}
function lineLetters(no: string): string | null {
  return stationNo(no)?.[0] ?? null;
}
/** 同一條線兩站的編號相減就是站數（G09→G19 是 10 站）；圖上沒有編號、或是環狀線（山手線編號繞一圈會接回來）就不算 */
function stopsBetween(a: string, b: string, loop: boolean): number | null {
  const x = stationNo(a), y = stationNo(b);
  return !loop && x && y && x[2] && y[2] && x[0] === y[0] && x[1] !== y[1] ? Math.abs(x[1] - y[1]) : null;
}
function sameLine(l: { line_code: string; from_no: string; to_no: string }): boolean {
  const a = lineLetters(l.from_no), b = lineLetters(l.to_no);
  if (!a || !b) return true;
  const code = l.line_code.normalize("NFKC").trim().toUpperCase();
  return a === b && (!/^[A-Z]{1,3}$/.test(code) || code === a);
}

/** 兩次讀圖都讀出同一條走法（同樣的路線、同樣的轉乘站）才算確認；站數也要兩次一樣才留。沒有就 null */
export function agreeRoutes(a: ReturnType<typeof cleanRouteMap>, b: ReturnType<typeof cleanRouteMap>) {
  const sig = (r: any) => r.legs.map((l: any) => `${lineLetters(l.from_no) ?? ""}:${stationKey(l.to)}`).join("|");
  for (const ra of a.routes as any[]) {
    const rb = (b.routes as any[]).find((x) => sig(x) === sig(ra));
    if (rb) return { ...ra, legs: ra.legs.map((l: any, i: number) => (l.stops === rb.legs[i].stops ? l : { ...l, stops: null })) };
  }
  return null;
}

/** Google 地圖用的車站名稱 */
function stationQuery(name: string): string {
  return /[站駅역]$|station$/i.test(name) ? name : `${name} station`;
}

/** 整理 AI 讀圖的結果並核對：每一段的上車站要接上前一段的下車站（或寫了要步行），最後一段要到目的地；站數由程式照車站編號算（AI 自己數常數錯） */
export function cleanRouteMap(j: any, origin: string, destination: string) {
  const s = (v: unknown, n = 60) => String(v ?? "").trim().slice(0, n);
  const routes = (Array.isArray(j?.routes) ? j.routes : [])
    .map((r: any) => ({
      summary: s(r?.summary, 120),
      legs: (Array.isArray(r?.legs) ? r.legs : []).slice(0, 5).map((l: any) => ({
        line: s(l?.line), line_code: s(l?.line_code, 6), from: s(l?.from, 30), from_no: s(l?.from_no, 8), to: s(l?.to, 30), to_no: s(l?.to_no, 8), direction: s(l?.direction, 30),
        stops: stopsBetween(s(l?.from_no, 8), s(l?.to_no, 8), l?.loop === true),
      })),
      transfers: (Array.isArray(r?.transfers) ? r.transfers : []).map((x: unknown) => s(x, 30)).filter(Boolean).slice(0, 4),
      walk: s(r?.walk, 80),
    }))
    .filter((r: any) => {
      if (!r.legs.length || r.legs.some((l: any) => !l.line || !l.from || !l.to)) return false;
      // 上下車站的編號要是同一條線的（例如淺草線是 A，寫成從押上 A20 到大手町 T09 就是這條線沒經過大手町）
      if (r.legs.some((l: any) => !sameLine(l))) return false;
      if (!sameStation(r.legs[r.legs.length - 1].to, destination)) return false;
      for (let i = 1; i < r.legs.length; i++) if (!sameStation(r.legs[i].from, r.legs[i - 1].to) && !r.walk) return false;
      return sameStation(r.legs[0].from, origin) || !!r.walk;
    });
  // 轉乘少的排前面；同樣轉乘次數照 AI 排的順序（它比較過總站數）
  // 核對過的建議走法放第一條，照原順序；沒有建議時轉乘少的排前面
  const proposalOk = j?.proposal_ok === true ? true : j?.proposal_ok === false ? false : null;
  if (!proposalOk) routes.sort((a: any, b: any) => a.legs.length - b.legs.length);
  return {
    is_route_map: j?.is_route_map !== false, proposal_ok: proposalOk, origin_on_map: s(j?.origin_on_map, 30), destination_on_map: s(j?.destination_on_map, 30),
    routes: routes.slice(0, 2), uncertain: s(j?.uncertain, 200),
  };
}

type RouteMap = { url: string; page?: string; bytes: ArrayBuffer; mime: string; source: string };

async function loadMap(url: string, source: string, page?: string): Promise<RouteMap | null> {
  try {
    if (!/^https?:\/\//.test(url)) return null;
    const res = await fetch(url, { headers: { "user-agent": url.includes("wikimedia.org") ? WIKI_UA : IMG_UA, accept: "image/*" }, signal: AbortSignal.timeout(8_000) });
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok || !/^image\/(png|jpe?g|webp|gif)$/.test(mime) || Number(res.headers.get("content-length") || 0) > ROUTE_MAP_MAX) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await res.arrayBuffer();
    return bytes.byteLength > 30_000 && bytes.byteLength <= ROUTE_MAP_MAX ? { url, page, bytes, mime, source } : null;
  } catch {
    return null;
  }
}

/** 上網找路線圖的候選：官方網域排前面，其他網站排後面 */
async function webMapCandidates(key: string, city: string, cityEn: string) {
  if (!key) return { official: [] as { url: string; page?: string }[], other: [] as { url: string; page?: string }[] };
  const seen = new Set<string>();
  const all: { url: string; page?: string; description: string }[] = [];
  await Promise.all(
    [`${city} 地鐵 路線圖 官方`, `${cityEn || city} metro subway official route map`].map(async (query) => {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
          body: JSON.stringify({ query, max_results: 6, include_images: true, include_image_descriptions: true, search_depth: "basic" }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return;
        const d: any = await res.json();
        const add = (img: any, page?: string) => {
          const url = typeof img === "string" ? img : img?.url;
          if (!url || seen.has(url)) return;
          seen.add(url);
          all.push({ url, page, description: typeof img === "string" ? "" : String(img.description ?? "") });
        };
        for (const r of d.results ?? []) for (const img of r.images ?? []) add(img, r.url);
        for (const img of d.images ?? []) add(img);
      } catch {}
    }),
  );
  const host = (u?: string) => {
    try {
      return new URL(u ?? "").host;
    } catch {
      return "";
    }
  };
  const mapLike = (c: { url: string; description: string }) => /map|route|路線|路线|地鐵|地下鉄|metro|subway|railway|network/i.test(`${c.description} ${c.url}`);
  const official = all.filter((c) => mapLike(c) && (OFFICIAL_HOST.test(host(c.url)) || OFFICIAL_HOST.test(host(c.page))));
  const other = all.filter((c) => mapLike(c) && !official.includes(c));
  return { official, other };
}

/** 維基共享資源的路線圖：現在的全線圖（不要歷史、規劃中的），大的優先 */
async function wikiMapCandidates(city: string, cityEn: string): Promise<{ url: string; page: string }[]> {
  const out: { url: string; page: string; score: number }[] = [];
  for (const q of [...new Set([cityEn && `${cityEn} subway map`, cityEn && `${cityEn} metro map`, `${city} 路線図`].filter(Boolean))]) {
    try {
      const u = new URL("https://commons.wikimedia.org/w/api.php");
      for (const [k, v] of Object.entries({ action: "query", generator: "search", gsrsearch: String(q), gsrnamespace: "6", gsrlimit: "12", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "3840", format: "json" })) u.searchParams.set(k, v);
      const d: any = await (await fetch(u, { headers: { "user-agent": WIKI_UA }, signal: AbortSignal.timeout(15_000) })).json();
      for (const p of Object.values<any>(d?.query?.pages ?? {})) {
        const ii = p?.imageinfo?.[0];
        const title = String(p?.title ?? "");
        if (!ii || /propos|plan|histor|future|19\d\d|200\d|201[0-5]|black|old|draft/i.test(title)) continue;
        if (!/svg|png|jpeg/.test(String(ii.mime))) continue;
        const score = (/system|network|subway map|metro map|linemap|路線/i.test(title) ? 2 : 0) + (/ja|jp|zh|en/i.test(title) ? 1 : 0) + Math.min(Number(ii.width) || 0, 8000) / 4000;
        if (!out.some((x) => x.page === ii.descriptionurl)) out.push({ url: ii.thumburl || ii.url, page: ii.descriptionurl, score });
      }
    } catch {}
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

/** 發問者 3 小時內分享過的位置（沒有就用其他成員的） */
function recentLocation(room: RoomApi, author: string) {
  const fresh = (l?: { ts: number }) => !!l && Date.now() - l.ts < 3 * 3600_000;
  const mine = room.memberLocation(author)[0];
  if (fresh(mine)) return mine;
  const other = room.memberLocation()[0];
  return fresh(other) ? other : null;
}

/**
 * Overpass 同時問兩台，用先回來的（主站常 504）。quick = 附加資訊用（例如最近車站），等比較短
 */
async function overpass(query: string, quick = false): Promise<any> {
  const body = "data=" + encodeURIComponent(query);
  const timeout = quick ? 10_000 : 15_000;
  const servers = ["https://overpass.openstreetmap.fr/api/interpreter", "https://overpass-api.de/api/interpreter"];
  try {
    return await Promise.any(
      servers.map(async (url) => {
        const d = await getJSON(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, timeout);
        if (!Array.isArray(d?.elements)) throw new Error("回應格式不對");
        return d;
      }),
    );
  } catch {
    throw new Error("地圖資料服務忙碌中");
  }
}

/** 最近的車站（給成員位置、住宿定位用） */
export async function nearestStation(lat: number, lon: number): Promise<{ name: string; distance_m: number; walk_min: number } | null> {
  try {
    const d = await overpass(`[out:json][timeout:10];node(around:1500,${lat},${lon})["railway"~"^(station|halt)$"];out 20;`, true);
    const s = (d.elements ?? [])
      .map((e: any) => ({ name: e.tags?.["name:zh"] || e.tags?.name, distance_m: distanceM(lat, lon, e.lat, e.lon) }))
      .filter((x: any) => x.name)
      .sort((a: any, b: any) => a.distance_m - b.distance_m)[0];
    return s ? { ...s, walk_min: Math.max(1, Math.round(s.distance_m / 80)) } : null;
  } catch {
    return null;
  }
}

// Overpass 都失敗時改用 Photon（另一個 OpenStreetMap 搜尋服務）找附近地點
const PHOTON: Record<string, { q: string; tags: string[] }> = {
  food: { q: "restaurant", tags: ["amenity:restaurant", "amenity:fast_food"] },
  cafe: { q: "cafe", tags: ["amenity:cafe"] },
  convenience: { q: "convenience", tags: ["shop:convenience"] },
  drugstore: { q: "pharmacy", tags: ["shop:chemist", "amenity:pharmacy"] },
  supermarket: { q: "supermarket", tags: ["shop:supermarket"] },
  toilet: { q: "toilets", tags: ["amenity:toilets"] },
  atm: { q: "atm", tags: ["amenity:atm"] },
  locker: { q: "locker", tags: ["amenity:locker"] },
  station: { q: "station", tags: ["railway:station"] },
  shopping: { q: "shop", tags: ["shop:department_store", "shop:mall", "shop:variety_store"] },
  park: { q: "park", tags: ["leisure:park", "leisure:playground"] },
  hospital: { q: "hospital", tags: ["amenity:hospital", "amenity:clinic"] },
};

async function photonNearby(category: string, lat: number, lon: number, radius: number, keyword: string): Promise<any[]> {
  const p = PHOTON[category] ?? PHOTON.food;
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", keyword || p.q);
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("lon", String(lon));
  u.searchParams.set("limit", "40");
  for (const t of p.tags) u.searchParams.append("osm_tag", t);
  const d = await getJSON(u.toString(), undefined, 10_000);
  return (d.features ?? [])
    .map((f: any) => ({ lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], tags: { name: f.properties?.name } }))
    .filter((e: any) => Number.isFinite(e.lat) && distanceM(lat, lon, e.lat, e.lon) <= Math.max(radius * 2, 1000));
}

// 料理關鍵字 → OpenStreetMap 的 cuisine 標籤（店名沒寫料理名稱也找得到）
const CUISINE: [RegExp, RegExp][] = [
  [/ラーメン|拉麵|拉面|ramen/i, /ramen/],
  [/寿司|壽司|すし|sushi/i, /sushi/],
  [/焼肉|燒肉|烤肉|bbq|barbecue|yakiniku/i, /yakiniku|barbecue|bbq/],
  [/韓式|韓國料理|korean/i, /korean/],
  [/泰式|泰國菜|thai/i, /thai/],
  [/越南|河粉|pho|vietnamese/i, /vietnamese/],
  [/義大利|義式|italian|pasta/i, /italian|pasta/],
  [/pizza|披薩|ピザ/i, /pizza/],
  [/漢堡|burger/i, /burger/],
  [/咖哩|カレー|curry|indian/i, /curry|indian/],
  [/海鮮|seafood/i, /seafood|fish/],
  [/咖啡|カフェ|cafe|coffee/i, /coffee|cafe/],
  [/中式|中菜|中華|chinese/i, /chinese/],
  [/牛排|steak/i, /steak/],
  [/串カツ|串炸|炸串|kushikatsu/i, /kushikatsu|kushiage/],
  [/串燒|串焼|焼き?鳥|燒鳥|烤雞肉串|やきとり|yakitori|kushiyaki|skewer/i, /yakitori|kushiyaki|skewer/],
  [/居酒屋|酒場|izakaya/i, /izakaya/],
  [/お好み焼き|大阪燒|okonomiyaki/i, /okonomiyaki/],
  [/たこ焼き|章魚燒|章魚小丸子|takoyaki/i, /takoyaki/],
  [/餃子|煎餃|gyoza|dumpling/i, /gyoza|dumpling/],
  [/炸雞|치킨|fried chicken/i, /chicken/],
  [/甜點|スイーツ|ケーキ|蛋糕|dessert|cake/i, /cake|dessert|confectionery/],
];

// ---------------- 附近地點（OpenStreetMap Overpass） ----------------

const NEARBY: Record<string, string> = {
  food: `nw(around:{r},{lat},{lon})["amenity"~"^(restaurant|fast_food|food_court)$"];`,
  cafe: `nw(around:{r},{lat},{lon})["amenity"="cafe"];`,
  convenience: `nw(around:{r},{lat},{lon})["shop"="convenience"];`,
  drugstore: `nw(around:{r},{lat},{lon})["shop"~"^(chemist|pharmacy)$"];nw(around:{r},{lat},{lon})["amenity"="pharmacy"];`,
  supermarket: `nw(around:{r},{lat},{lon})["shop"="supermarket"];`,
  toilet: `nw(around:{r},{lat},{lon})["amenity"="toilets"];`,
  atm: `nw(around:{r},{lat},{lon})["amenity"~"^(atm|bank|bureau_de_change)$"];`,
  locker: `nw(around:{r},{lat},{lon})["amenity"="locker"];`,
  station: `nw(around:{r},{lat},{lon})["railway"~"^(station|halt)$"];nw(around:{r},{lat},{lon})["station"="subway"];`,
  shopping: `nw(around:{r},{lat},{lon})["shop"~"^(department_store|mall|variety_store|toys|electronics|clothes)$"];`,
  park: `nw(around:{r},{lat},{lon})["leisure"~"^(park|playground)$"];`,
  hospital: `nw(around:{r},{lat},{lon})["amenity"~"^(hospital|clinic)$"];`,
};

// Yahoo!路線 運行情報的地區（只有日本）
const YAHOO_AREA: [RegExp, number][] = [
  [/北海道|札幌|函館|小樽|旭川/, 2],
  [/東北|仙台|青森|秋田|盛岡|山形|福島/, 3],
  [/名古屋|中部|靜岡|静岡|金澤|金沢|富山|長野|岐阜|新潟/, 5],
  [/大阪|京都|神戶|神戸|奈良|關西|関西|近畿|和歌山|滋賀/, 6],
  [/福岡|九州|博多|熊本|長崎|鹿兒島|鹿児島|大分|宮崎|佐賀|沖繩|沖縄/, 7],
  [/廣島|広島|岡山|山口|鳥取|島根/, 8],
  [/四國|四国|高松|松山|高知|德島|徳島/, 9],
];

// ---------------- 工具清單 ----------------

export const TOOLS: Tool[] = [
  {
    label: "🔍 搜尋網路",
    decl: (p) => ({
      name: "web_search",
      description: "搜尋網路上的最新資訊：景點介紹、營業時間、票價、活動、美食評價、商品價格、交通方式等。回傳摘要與來源網址。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: `搜尋關鍵字，當地資訊建議加${p.language}或英文關鍵字` },
          max_results: { type: "integer", description: "結果數量，預設 5，最多 8" },
        },
        required: ["query"],
      },
    }),
    async run(args, { tavilyKey }) {
      if (!tavilyKey) return { error: "這個旅程還沒設定 Tavily 金鑰，無法搜尋網路（管理員可在 「設定」補上）" };
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tavilyKey}` },
        body: JSON.stringify({ query: args.query, max_results: Math.min(Number(args.max_results) || 5, 8), include_answer: "basic", search_depth: "basic" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 432 || res.status === 433) return { error: "Tavily 本月的免費搜尋額度用完了，請管理員到 「設定」換一組金鑰" };
      if (!res.ok) return { error: `搜尋失敗 ${res.status}` };
      const d: any = await res.json();
      return {
        answer: d.answer,
        results: (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, content: String(r.content ?? "").slice(0, 600) })),
      };
    },
  },
  {
    label: "📄 閱讀連結",
    decl: {
      name: "read_webpage",
      description:
        "讀取網址的內容：一般網頁讀全文；Facebook、Instagram、Threads 的貼文與 Reels 影片會拿到貼文文字，並看影片、聽內容做摘要（video_summary）。" +
        "成員貼連結、或要確認網頁細節時使用。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(args, { tavilyKey, room }) {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return { error: "網址不正確" };
      if (SOCIAL_HOST.test(url)) return readSocial(url, room);
      if (!tavilyKey) return readPlain(url);
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tavilyKey}` },
        body: JSON.stringify({ urls: [url] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) return readPlain(url);
      const d: any = await res.json();
      const r = d.results?.[0];
      return r ? { url: r.url, content: String(r.raw_content ?? "").slice(0, 8000) } : readPlain(url);
    },
  },
  {
    label: "🖼 找圖片",
    decl: (p) => ({
      name: "find_images",
      description:
        "上網找圖片（餐廳外觀、料理、景點、商品、捷運／地鐵路線圖、平面圖、菜單），找到的圖片會自動顯示在你的回答下方。只有成員明確要求看照片／圖片時才使用。" +
        "要看好幾個地方（例如剛才推薦的幾家店）就把每個地方放進 queries 一次查完。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: `單一搜尋關鍵字：店名或景點名稱加地名（${p.city || p.country}）` },
          queries: { type: "array", items: { type: "string" }, description: "要看好幾個地方時用，每個地方一個關鍵字，最多 4 個" },
          count: { type: "integer", description: "總共要幾張，預設 4，最多 6" },
        },
      },
    }),
    async run(args, { env, tavilyKey, attachImage }) {
      if (!tavilyKey) return { error: "這個旅程還沒設定 Tavily 金鑰，無法找圖片" };
      const list: string[] = (Array.isArray(args.queries) && args.queries.length ? args.queries : [args.query])
        .map((q: unknown) => String(q ?? "").trim())
        .filter(Boolean)
        .slice(0, 4);
      if (!list.length) return { error: "請提供要找圖片的地點或關鍵字" };
      const total = Math.min(Math.max(Number(args.count) || 4, list.length), 6);
      const perQuery = Math.max(1, Math.ceil(total / list.length));

      // 每個關鍵字各自搜尋、各自檢查圖片能不能顯示（約三成會擋外連、不是圖片或太大）
      const groups = await Promise.all(
        list.map(async (query) => {
          try {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${tavilyKey}` },
              body: JSON.stringify({ query, max_results: 5, include_images: true, include_image_descriptions: true, search_depth: "basic" }),
              signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) return { query, picked: [] as { url: string; description: string; page?: string }[] };
            const d: any = await res.json();
            const seen = new Set<string>();
            const candidates: { url: string; description: string; page?: string }[] = [];
            const add = (img: any, page?: string) => {
              const url = typeof img === "string" ? img : img?.url;
              if (!url || seen.has(url)) return;
              seen.add(url);
              candidates.push({ url, description: typeof img === "string" ? "" : String(img.description ?? ""), page });
            };
            for (const img of d.images ?? []) add(img);
            for (const r of d.results ?? []) for (const img of r.images ?? []) add(img, r.url);
            const checked = await Promise.all(candidates.slice(0, 8).map(async (c) => ((await imageUsable(c.url)) ? c : null)));
            return { query, picked: checked.filter((c): c is NonNullable<typeof c> => !!c).slice(0, perQuery) };
          } catch {
            return { query, picked: [] as { url: string; description: string; page?: string }[] };
          }
        }),
      );

      const results: { query: string; found: number; descriptions: string[] }[] = [];
      for (const g of groups) {
        for (const p of g.picked) {
          attachImage?.({
            src: `/api/img?u=${encodeURIComponent(p.url)}&s=${await sign(env, "img:" + p.url)}`,
            caption: p.description.slice(0, 120),
            label: g.query,
            source: new URL(p.url).host,
            page: p.page,
          });
        }
        results.push({ query: g.query, found: g.picked.length, descriptions: g.picked.map((p) => p.description.slice(0, 100)) });
      }
      const found = results.reduce((s, r) => s + r.found, 0);
      if (!found) return { found: 0, note: "找不到可以顯示的圖片，可以換個關鍵字（當地語言或英文）再試" };
      return {
        found,
        results,
        note: "圖片已自動顯示在回答下方（每張都標了地點名稱）。文字裡不要貼圖片網址或任何搜尋連結；簡單說明找到哪些地方的圖，並提醒是網路圖片、不一定是同一家分店，僅供參考",
      };
    },
  },
  {
    label: "💱 匯率換算",
    decl: (p) => ({
      name: "convert_currency",
      description: `即時匯率換算，例如 ${p.currency} 換台幣 TWD。`,
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          from: { type: "string", description: `來源幣別代碼，當地貨幣是 ${p.currency}` },
          to: { type: "string", description: "目標幣別代碼，例如 TWD" },
        },
        required: ["amount", "from", "to"],
      },
    }),
    async run(args, ctx) {
      const { rate, updated } = await fxRate(ctx, args.from, args.to);
      const amount = Number(args.amount);
      return { amount, from: args.from, to: args.to, rate, result: Math.round(amount * rate * 100) / 100, updated, source: "ExchangeRate-API (open.er-api.com)" };
    },
  },
  {
    label: "🌤 查天氣",
    decl: {
      name: "get_weather",
      description: "查詢天氣預報（未來最多 14 天）與目前天氣。沒給地點就查住宿附近。",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "地名，可留空" },
          days: { type: "integer", description: "預報天數，預設 7" },
        },
      },
    },
    async run(args, { profile }) {
      let loc = homeOf(profile);
      if (args.place) {
        const g = await locate(String(args.place), profile);
        if (g) loc = g;
      }
      if (!loc) return { error: "還不知道住宿或城市位置，請告訴我要查哪裡的天氣" };
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 14);
      const d = await getJSON(
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=${encodeURIComponent(profile.timezone)}&forecast_days=${days}` +
          `&current=temperature_2m,apparent_temperature,weather_code,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max`,
      );
      return {
        place: loc.name,
        now: d.current && { temp: d.current.temperature_2m, feels: d.current.apparent_temperature, weather: WEATHER[d.current.weather_code] ?? d.current.weather_code },
        daily: (d.daily?.time ?? []).map((date: string, i: number) => ({
          date,
          weather: WEATHER[d.daily.weather_code[i]] ?? d.daily.weather_code[i],
          max: d.daily.temperature_2m_max[i],
          min: d.daily.temperature_2m_min[i],
          rain_chance: d.daily.precipitation_probability_max[i],
          uv: d.daily.uv_index_max[i],
        })),
        source: "Open-Meteo",
      };
    },
  },
  {
    label: "🎢 樂園排隊",
    decl: {
      name: "theme_park_wait_times",
      description: "查主題樂園（迪士尼、環球影城、樂天世界、愛寶樂園、樂高樂園等）各設施的即時等待時間與是否營運。park 留空 = 列出旅遊地附近有排隊資料的樂園。",
      parameters: {
        type: "object",
        properties: { park: { type: "string", description: "樂園名稱（英文最準），例如 Tokyo DisneySea、Universal Studios Japan、Lotte World、Everland" } },
      },
    },
    async run(args, ctx) {
      let parks: any[];
      const cached = ctx.room.cacheGet("queue_parks", 7 * 86400_000);
      if (cached) parks = JSON.parse(cached);
      else {
        const groups = await getJSON("https://queue-times.com/parks.json");
        parks = (groups as any[]).flatMap((g) => (g.parks ?? []).map((p: any) => ({ id: p.id, name: p.name, country: p.country, lat: Number(p.latitude), lon: Number(p.longitude), tz: p.timezone })));
        ctx.room.cacheSet("queue_parks", JSON.stringify(parks));
      }
      const home = homeOf(ctx.profile);
      const near = home ? parks.map((p) => ({ ...p, km: Math.round(distanceM(home.lat, home.lon, p.lat, p.lon) / 1000) })).sort((a, b) => a.km - b.km) : parks;
      const want = String(args.park ?? "").trim().toLowerCase();
      const words = want.split(/\s+/).filter(Boolean);
      const pick = want ? near.find((p) => words.every((w) => p.name.toLowerCase().includes(w))) ?? near.find((p) => words.some((w) => w.length > 3 && p.name.toLowerCase().includes(w))) : null;
      if (!pick) {
        return {
          note: want ? `找不到「${args.park}」的排隊資料，以下是附近有資料的樂園` : "旅遊地附近有排隊資料的樂園",
          parks: near.filter((p) => !home || p.km < 300).slice(0, 10).map((p) => ({ name: p.name, country: p.country, distance_km: p.km })),
          source: "Powered by Queue-Times.com",
        };
      }
      const d = await getJSON(`https://queue-times.com/parks/${pick.id}/queue_times.json`);
      const rides = [...(d.lands ?? []).flatMap((l: any) => l.rides.map((r: any) => ({ ...r, area: l.name }))), ...(d.rides ?? [])];
      const open = rides.filter((r) => r.is_open).sort((a, b) => b.wait_time - a.wait_time);
      return {
        park: pick.name,
        open_count: open.length,
        closed: rides.filter((r) => !r.is_open).map((r) => r.name).slice(0, 30),
        rides: open.map((r) => ({ name: r.name, area: r.area, wait_min: r.wait_time })),
        updated: rides[0]?.last_updated,
        note: open.length ? undefined : "目前沒有設施在營運（可能還沒開園或已經閉園）",
        source: "Powered by Queue-Times.com",
      };
    },
  },
  {
    label: "📍 成員位置",
    decl: {
      name: "get_member_locations",
      description: "取得成員最近分享的 GPS 位置：所在區域、地址、最近的車站與距離。回答「我在哪」或要知道某位成員在哪時使用。",
      parameters: { type: "object", properties: { name: { type: "string", description: "成員名稱，留空=全部" } } },
    },
    async run(args, { room, profile }) {
      const locs = room.memberLocation(args.name);
      if (!locs.length) return { error: "還沒有人分享位置。請按輸入框旁的 📍 分享位置。" };
      const out = [];
      for (const l of locs.slice(0, 4)) {
        let area = l.area ?? "";
        if (!area) {
          try {
            area = await reverseArea(l.lat, l.lon, langShort(profile));
          } catch {}
        }
        out.push({
          name: l.name, lat: l.lat, lon: l.lon, accuracy_m: l.accuracy,
          minutes_ago: Math.round((Date.now() - l.ts) / 60000),
          area, nearest_station: await nearestStation(l.lat, l.lon), map: mapsLink(l),
        });
      }
      return out;
    },
  },
  {
    label: "🗺 找附近",
    decl: (p) => ({
      name: "find_nearby",
      description: "找實際距離最近的地點（餐廳、咖啡、便利商店、藥妝、超市、廁所、ATM／換匯、置物櫃、車站、購物、公園、醫院），依距離排序並附步行分鐘。問「我附近」時 near 一定留空，系統會自動用發問者的 GPS 位置。",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: Object.keys(NEARBY) },
          keyword: { type: "string", description: `店名或料理類型（${p.language}、英文或中文）` },
          near: { type: "string", description: `只有要查「別的地方」附近才填，用${p.language}或英文地名。問「我附近」請留空` },
          radius_m: { type: "integer", description: "搜尋半徑公尺，預設 600，最大 2000" },
        },
        required: ["category"],
      },
    }),
    async run(args, { room, author, profile, question }) {
      const mine = recentLocation(room, author);
      let center: { lat: number; lon: number; label: string } | null = null;
      let note = "";
      // AI 常把發問者自己的地名填進 near，這時直接用 GPS 比較準；但成員自己講出來的地點（「池袋地鐵站附近」）就照那個地點查
      const near = String(args.near ?? "").trim();
      const nk = (s: string) => [...s.normalize("NFKC")].map((c) => KANJI[c] ?? c).join("").replace(/\s+/g, "");
      const named = !!near && nk(question ?? "").includes(nk(near.replace(/(駅前|駅|站|周辺|附近)$/, "")));
      const isMyArea = !!near && !named && !!mine?.area && (mine.area.includes(near) || near.includes(mine.area));
      if (near && !isMyArea) {
        const g = await locate(near, profile);
        if (g) center = { lat: g.lat, lon: g.lon, label: COORD_RE.test(near) ? "指定座標" : g.name };
        else note = `找不到「${near}」這個地點，改用${mine ? "發問者目前位置" : "住宿"}為中心`;
      }
      if (!center && mine) {
        const where = mine.area ? `：${mine.area}` : "";
        center = { lat: mine.lat, lon: mine.lon, label: `${mine.name} 的 GPS 位置${where}（${Math.round((Date.now() - mine.ts) / 60000)} 分鐘前）` };
      }
      if (!center) {
        const home = homeOf(profile);
        if (!home) return { error: "不知道要以哪裡為中心：請先按 📍 分享位置，或告訴我地名" };
        center = { lat: home.lat, lon: home.lon, label: home.name };
        note ||= "沒有成員分享位置，先以住宿為中心；要找自己附近請先按 📍 分享位置";
      }
      const r = Math.min(Math.max(Number(args.radius_m) || 600, 100), 2000);
      const q = (NEARBY[args.category] ?? NEARBY.food).replaceAll("{r}", String(r)).replaceAll("{lat}", String(center.lat)).replaceAll("{lon}", String(center.lon));
      const kw = String(args.keyword ?? "").trim();
      let elements: any[];
      let source = "© OpenStreetMap contributors";
      try {
        elements = (await overpass(`[out:json][timeout:15];(${q});out center 150;`)).elements ?? [];
      } catch {
        elements = await photonNearby(args.category, center.lat, center.lon, r, kw);
        source += "（Photon）";
      }
      const all = elements
        .map((e: any) => {
          const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
          const t = e.tags ?? {};
          const distance = distanceM(center.lat, center.lon, lat, lon);
          return {
            name: t["name:zh"] || t["name:zh-Hant"] || t.name || t["name:en"] || "(無名稱)",
            name_local: t.name,
            name_en: t["name:en"],
            cuisine: t.cuisine,
            opening_hours: t.opening_hours,
            distance_m: distance,
            walk_min: Math.max(1, Math.round(distance / 80)),
            // 只給座標：店名一起放進搜尋字，模型抄網址時最常把日文編碼抄壞；座標也不會跑到連鎖店的別家分店
            map: mapsLink({ lat, lon }),
          };
        })
        .sort((a: any, b: any) => a.distance_m - b.distance_m);
      // 料理名稱有好幾種寫法（串燒＝焼き鳥＝やきとり），店名和 OSM 的料理類型都用同一組比對
      const dish = CUISINE.find(([re]) => re.test(kw));
      let places = kw
        ? all.filter((p: any) => {
            const name = `${p.name} ${p.name_local ?? ""} ${p.name_en ?? ""}`;
            return name.toLowerCase().includes(kw.toLowerCase()) || (!!dish && (dish[1].test(p.cuisine ?? "") || dish[0].test(name)));
          })
        : all;
      if (kw && !places.length) {
        note = [note, `半徑 ${r} 公尺內沒有符合「${kw}」的店家資料，以下是附近所有結果；可加大 radius_m 再找，或用 web_search 補充`].filter(Boolean).join("；");
        places = all;
      }
      return {
        center: center.label,
        center_coords: `${center.lat.toFixed(5)},${center.lon.toFixed(5)}`,
        radius_m: r,
        note: note || undefined,
        places: places.slice(0, 12),
        source,
        tip: "結果依實際距離排序；評價與排隊狀況可再用 web_search 查 Google 評論",
      };
    },
  },
  {
    label: "🚃 規劃路線",
    decl: {
      name: "plan_route",
      description: "產生 Google Maps 導航連結（大眾運輸/步行/開車）。詳細轉乘與票價請搭配 web_search 查詢。起點留空=發問者目前位置或住宿。要回住宿 destination 填「住宿」（系統會換成正確位置）。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "照成員訊息裡的寫法直接複製（例如「新宿站」），不要自己翻成日文" },
          destination: { type: "string", description: "照成員訊息裡的寫法直接複製（例如「池袋站」），不要自己翻成日文" },
          mode: { type: "string", enum: ["transit", "walking", "driving"] },
        },
        required: ["destination"],
      },
    },
    async run(args, { room, author, profile }) {
      let origin = args.origin as string | undefined;
      if (!origin) {
        const mine = room.memberLocation(author)[0];
        const home = homeOf(profile);
        origin = mine && Date.now() - mine.ts < 3 * 3600_000 ? `${mine.lat},${mine.lon}` : profile.accommodation.address || (home ? `${home.lat},${home.lon}` : profile.city);
      }
      origin = homeOr(origin, profile);
      const mode = args.mode || "transit";
      const u = new URL("https://www.google.com/maps/dir/");
      u.searchParams.set("api", "1");
      u.searchParams.set("origin", origin);
      const destination = homeOr(String(args.destination), profile);
      u.searchParams.set("destination", destination);
      u.searchParams.set("travelmode", mode);
      return { origin, destination, mode, google_maps: u.toString() };
    },
  },
  {
    label: "💰 記帳",
    decl: (p) => p.kind === "personal" ? {
      name: "add_expense",
      description: "記一筆個人花費（例如「午餐 120」「加油 1500」或收據照片）。會在回答下方產生確認卡片，使用者按確認才寫入帳本。",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "項目，例如「全聯：牛奶、雞蛋」" },
          amount: { type: "number" },
          currency: { type: "string", description: "幣別代碼，預設 TWD" },
          category: { type: "string", enum: PERSONAL_CATEGORIES },
          date: { type: "string", description: "日期 YYYY-MM-DD，預設今天。收據上的民國年要加 1911（民國 113 年＝2024 年）" },
          replaces: REPLACES_PARAM,
        },
        required: ["description", "amount"],
      },
    } : ({
      name: "add_expense",
      description: `記一筆旅費並分帳。例如「晚餐 3 萬 ${p.currency} 我付的」。payer 預設為發問者，split_among 預設為全部旅伴（見系統提示的旅伴名單），只有特定人分攤時才填，成員說誰就照填誰（名單裡沒有也照填，不可以換成別人）。`,
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", description: `幣別代碼，預設當地貨幣 ${p.currency}；台幣是 TWD（台灣的收據：NT$、民國年、統一發票）` },
          payer: { type: "string" },
          split_among: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: ["餐飲", "交通", "門票", "購物", "住宿", "其他"] },
          date: { type: "string", description: "日期 YYYY-MM-DD，預設今天（當地時間）。收據上的民國年要加 1911（民國 113 年＝2024 年）" },
          replaces: REPLACES_PARAM,
        },
        required: ["description", "amount"],
      },
    }),
    async run(args, ctx) {
      if (ctx.profile.kind === "personal") return personalExpense(args, ctx);
      const local = ctx.profile.currency;
      const currency = String(args.currency || local).toUpperCase();
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { error: "金額不正確" };
      let toLocal: { rate: number; estimated?: boolean }, toTwd: { rate: number; estimated?: boolean };
      try {
        toLocal = await fxRate(ctx, currency, local);
        toTwd = await fxRate(ctx, local, "TWD");
      } catch (e: any) {
        return { error: `查不到匯率，暫時無法記帳（${e?.message ?? e}）` };
      }
      const amountLocal = Math.round(amount * toLocal.rate * 100) / 100;
      const twd = Math.round(amountLocal * toTwd.rate);
      const members = ctx.room.members();
      const split = Array.isArray(args.split_among) && args.split_among.length ? args.split_among : members.length ? members : [ctx.author];
      const e: ExpenseInput = {
        description: args.description,
        amount,
        currency,
        amountLocal,
        amountTwd: twd,
        payer: args.payer || ctx.author,
        splitAmong: split,
        category: args.category || "其他",
        date: normalizeDate(args.date, ctx.profile) ?? localDate(ctx.profile),
        author: ctx.author,
      };
      const rateEstimated = !!(toLocal.estimated || toTwd.estimated);
      if (ctx.propose) {
        const p = ctx.profile;
        // 日期離旅程太遠（例如兩年前在台灣的收據）特別標出來，幣別也最容易在這種時候看錯；出發前幾個月先買票是正常的
        const outside = e.date < shiftDate(p.startDate, -90) || e.date > shiftDate(p.endDate, 14);
        const warn = outside ? `日期離旅遊期間（${p.startDate}～${p.endDate.slice(5)}）很遠，請確認日期與幣別` : "";
        const parts = [currency !== local ? `≈ ${money(amountLocal, local, p)}` : "", currency !== "TWD" ? `≈ NT$${twd.toLocaleString("en-US")}` : ""].filter(Boolean);
        return ctx.propose({
          kind: "add_expense",
          payload: e,
          replaces: Number(args.replaces) || undefined,
          warning: warn || undefined,
          preview: {
            title: "記帳確認",
            confirm: "確認記帳",
            summary: `${e.date} ${e.description} ${money(amount, currency, p)}（${e.payer} 付，${split.length} 人分）`,
            rows: [
              ["日期", e.date],
              ["項目", String(e.description)],
              ["金額", `${money(amount, currency, p)}${parts.length || rateEstimated ? `（${parts.join("｜")}${rateEstimated ? "，匯率為估計值" : ""}）` : ""}`],
              ["付款人", String(e.payer)],
              ["分攤", `${split.join("、")}（每人約 NT$${Math.round(twd / split.length).toLocaleString("en-US")}）`],
              ["分類", e.category],
              ...(warn ? [["⚠️ 注意", warn] as [string, string]] : []),
            ],
          },
        });
      }
      return { saved: ctx.room.addExpense(e), rate_estimated: rateEstimated };
    },
  },
  {
    label: "📊 帳目統計",
    decl: (p) => p.kind === "personal" ? {
      name: "expense_summary",
      description: "個人花費統計：某個月（預設這個月）的總花費、各分類、預算還剩多少、最近幾筆，以及最近幾個月的總額。",
      parameters: { type: "object", properties: { month: { type: "string", description: "月份 YYYY-MM，預設這個月" } } },
    } : {
      name: "expense_summary",
      description: "旅費統計：總花費、每人付了多少、每人應付多少、誰該給誰多少錢（結算）、分類與每日花費。",
      parameters: { type: "object", properties: {} },
    },
    async run(args, { room, profile }) {
      if (profile.kind === "personal") return room.ledger(args.month ? String(args.month) : undefined);
      return room.expenseSummary();
    },
  },
  {
    label: "🗑 刪除帳目",
    decl: {
      name: "delete_expense",
      description: "刪除已經記進帳本的一筆帳。可以用品項關鍵字（例如「烤肉」）找，或用 expense_summary 裡的帳目 id（不是確認卡片的編號）。",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", description: "品項或店名關鍵字" }, id: { type: "integer", description: "帳目 id" } },
      },
    },
    async run(args, { room, propose, profile }) {
      let ex = args.id ? room.expenseGet(Number(args.id)) : null;
      if (!ex && args.keyword) {
        const found = room.expenseFind(String(args.keyword));
        if (found.length > 1) return { matches: found, note: "有好幾筆符合，請問成員要刪哪一筆，再用 id 呼叫" };
        ex = found[0] ?? null;
      }
      if (!ex) return { error: "帳本裡找不到這筆帳（還沒確認的卡片不在帳本裡，請成員直接按卡片上的「取消」）", recent: room.expenseFind("").slice(0, 8) };
      const id = ex.id;
      if (propose) {
        const amount = money(ex.amount, ex.currency, profile);
        return propose({
          kind: "delete_expense",
          payload: { id },
          preview: {
            title: "刪除帳目確認",
            confirm: "確認刪除",
            summary: `刪除 #${id} ${ex.date} ${ex.description} ${amount}`,
            rows: [["日期", ex.date], ["項目", ex.description], ["金額", amount], ...(profile.kind === "personal" ? [] : [["付款人", ex.payer] as [string, string]])],
          },
        });
      }
      return { deleted: room.deleteExpense(id) };
    },
  },
  {
    label: "📅 新增行程",
    decl: (p) => ({
      name: "add_event",
      description: `在行事曆新增一個有日期的事（約會、會議、看診、上課、出遊、繳費截止日）。會在回答下方產生確認卡片，使用者按確認才寫入。時間一律用 ${p.timezone} 的當地時間。`,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "標題，例如「看牙醫」「小美家長會」" },
          date: { type: "string", description: "日期 YYYY-MM-DD（「下週三」要換成實際日期）" },
          start: { type: "string", description: "開始時間 HH:mm；沒有時間（整天）就不要填" },
          end: { type: "string", description: "結束時間 HH:mm，可留空" },
          location: { type: "string", description: "地點，可留空" },
          note: { type: "string", description: "備註，可留空" },
          remind_minutes: { type: "integer", description: "提前幾分鐘提醒（例如 30、60、1440＝前一天）；使用者沒說就不要填" },
          replaces: REPLACES_PARAM,
        },
        required: ["title", "date"],
      },
    }),
    async run(args, { propose }) {
      const e = cleanEvent(args);
      if ("error" in e) return e;
      if (!propose) return { error: "需要確認卡片" };
      return propose({
        kind: "add_event",
        payload: e,
        replaces: Number(args.replaces) || undefined,
        preview: { title: "新增行程確認", confirm: "加到行事曆", summary: `${eventWhen(e)} ${e.title}`, rows: eventRows(e) },
      });
    },
  },
  {
    label: "📅 查行程",
    decl: {
      name: "list_events",
      description: "查行事曆：某天或某段期間有哪些行程（例如「這週有什麼事」「下週三有空嗎」）。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "開始日期 YYYY-MM-DD，預設今天" },
          days: { type: "integer", description: "查幾天，預設 14，最多 90" },
        },
      },
    },
    async run(args, { room, profile }) {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(args.from ?? "")) ? String(args.from) : localDate(profile);
      const days = Math.min(Math.max(Number(args.days) || 14, 1), 90);
      const list = room.eventList(from, shiftDate(from, days - 1));
      return { from, to: shiftDate(from, days - 1), count: list.length, events: list };
    },
  },
  {
    label: "📅 修改行程",
    decl: {
      name: "update_event",
      description: "修改行事曆裡已經有的行程（改時間、地點、標題、提醒）。用 id（list_events 會給）或標題關鍵字找。會產生確認卡片。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          keyword: { type: "string", description: "標題關鍵字" },
          title: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          start: { type: "string", description: "HH:mm；要改成整天就填空字串" },
          end: { type: "string" },
          location: { type: "string" },
          note: { type: "string" },
          remind_minutes: { type: "integer" },
          replaces: REPLACES_PARAM,
        },
      },
    },
    async run(args, { room, propose }) {
      const old = pickEvent(args, room);
      if ("error" in old || "matches" in old) return old;
      const merged = cleanEvent({
        title: args.title ?? old.title,
        date: args.date ?? old.date,
        start: args.start !== undefined ? args.start : old.start,
        end: args.end !== undefined ? args.end : old.end,
        location: args.location ?? old.location,
        note: args.note ?? old.note,
        remind_minutes: args.remind_minutes ?? old.remindMin,
      });
      if ("error" in merged) return merged;
      if (!propose) return { error: "需要確認卡片" };
      const before = eventRows(old), after = eventRows(merged);
      return propose({
        kind: "update_event",
        payload: { id: old.id, event: merged },
        replaces: Number(args.replaces) || undefined,
        preview: {
          title: "修改行程確認",
          confirm: "確認修改",
          summary: `#${old.id} ${old.title} → ${eventWhen(merged)} ${merged.title}`,
          rows: after.map(([k, v], i) => (before[i] && before[i][1] !== v ? [k, v, before[i][1]] : [k, v]) as [string, string, string?]),
        },
      });
    },
  },
  {
    label: "📅 刪除行程",
    decl: {
      name: "delete_event",
      description: "刪除行事曆裡的行程。用 id（list_events 會給）或標題關鍵字找。會產生確認卡片。",
      parameters: { type: "object", properties: { id: { type: "integer" }, keyword: { type: "string" } } },
    },
    async run(args, { room, propose }) {
      const old = pickEvent(args, room);
      if ("error" in old || "matches" in old) return old;
      if (!propose) return { error: "需要確認卡片" };
      return propose({
        kind: "delete_event",
        payload: { id: old.id },
        preview: { title: "刪除行程確認", confirm: "確認刪除", summary: `刪除 #${old.id} ${eventWhen(old)} ${old.title}`, rows: eventRows(old) },
      });
    },
  },
  {
    label: "📚 存進知識庫",
    decl: {
      name: "save_note",
      description:
        "把整理好的內容存進知識庫（文章、影片、Reels 的重點、筆記），之後可以用 search_notes 找出來。" +
        "使用者貼連結或說「存到知識庫」時：先用 read_webpage 讀內容，再用這個存。同一個網址再存會更新原本那筆。回答時說已存進「知識庫」。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "標題，20 字內，說清楚是什麼" },
          summary: { type: "string", description: "重點摘要，3–6 點條列（Markdown），寫具體的工具、做法、數字、網址" },
          url: { type: "string", description: "原始連結" },
          tags: { type: "array", items: { type: "string" }, description: "2–5 個標籤，例如「前端」「Three.js」「開源」" },
          content: { type: "string", description: "原文或貼文文字（可留空）" },
        },
        required: ["title", "summary"],
      },
    },
    async run(args, { room, author }) {
      return room.noteSave(
        {
          title: String(args.title ?? "").slice(0, 80),
          summary: String(args.summary ?? "").slice(0, 3000),
          content: args.content ? String(args.content).slice(0, 6000) : undefined,
          url: args.url ? String(args.url).slice(0, 500) : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map((t: unknown) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 6) : [],
        },
        author,
      );
    },
  },
  {
    label: "📚 查知識庫",
    decl: {
      name: "search_notes",
      description:
        "從知識庫找以前存過的文章、影片、筆記、上傳的文件（PDF、Word、PPT、Excel…）、錄音逐字稿，以及保管箱裡的照片文件（例如「之前存的那個 3D 開源專案叫什麼」「租屋合約的違約金怎麼算」）。" +
        "結果裡的 passages 是文件和逐字稿中最相關的原文段落，問細節要根據 passages 回答；段落開頭有【第 N 頁】就說在第幾頁。" +
        "回答用到這些內容時，句尾加上來源連結，例如 [1](#note-12)、[2](#doc-3)（網址用結果裡的 ref）。",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "關鍵字，留空＝最近存的" } } },
    },
    async run(args, { room }) {
      return room.noteSearch(String(args.keyword ?? ""));
    },
  },
  {
    label: "🩺 記錄量測",
    decl: {
      name: "health_log",
      description: "記錄血壓、血糖、體重（使用者報數字時用）。回傳程式判讀 grade 和固定提醒 alerts，照原文回覆，不要自己改判讀。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["bp", "glucose", "weight"], description: "bp 血壓、glucose 血糖、weight 體重" },
          systolic: { type: "number", description: "收縮壓" },
          diastolic: { type: "number", description: "舒張壓" },
          pulse: { type: "number", description: "脈搏（可留空）" },
          glucose: { type: "number", description: "血糖 mg/dL" },
          context: { type: "string", enum: ["fasting", "pre", "post", "bed", "random", "morning", "evening", "other"], description: "血糖：空腹 fasting、餐前 pre、餐後 2 小時 post、睡前 bed、其他 random；血壓：早上 morning、晚上 evening、其他 other（沒說就留空）" },
          weight: { type: "number", description: "體重公斤" },
          waist: { type: "number", description: "腰圍公分（可留空）" },
          date: { type: "string", description: "量測日期 YYYY-MM-DD（今天就留空）" },
          time: { type: "string", description: "量測時間 HH:mm（可留空）" },
        },
        required: ["kind"],
      },
    },
    async run(args, { room }) {
      return room.healthLog(args);
    },
  },
  {
    label: "🩺 健康整理",
    decl: {
      name: "health_status",
      description: "取得健康管家整理好的資料：基本資料、BMI、最近的血壓血糖體重與程式判讀、7 天與 30 天血壓平均、722 結果、目前用藥、該做的健檢篩檢疫苗。回答健康問題前先查。",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, { room }) {
      return room.healthStatus();
    },
  },
  {
    label: "💊 用藥清單",
    decl: {
      name: "health_meds",
      description: "用藥清單：list 列出；add 新增（說開始吃某個藥、拿到慢箋）；stop 停用（說不吃了）。只記錄，不要建議劑量或要不要吃。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "stop"] },
          name: { type: "string", description: "藥名（照使用者說的或藥袋上的）" },
          dose: { type: "string", description: "劑量，例如 5mg" },
          freq: { type: "string", description: "用法，例如 每天早餐後 1 顆" },
          purpose: { type: "string", description: "用途，例如 高血壓" },
          refill_next: { type: "string", description: "慢箋下次可以領藥的日期 YYYY-MM-DD" },
          refill_left: { type: "number", description: "慢箋還剩幾次" },
        },
        required: ["action"],
      },
    },
    async run(args, { room }) {
      return room.healthMeds(args);
    },
  },
  {
    label: "🩺 健康檔案",
    decl: {
      name: "health_profile",
      description: "更新健康檔案：性別、生日、身高、慢性病、過敏、家族史、吸菸、嚼檳榔。使用者提到這些時用。",
      parameters: {
        type: "object",
        properties: {
          sex: { type: "string", enum: ["M", "F"] },
          birth: { type: "string", description: "生日 YYYY-MM-DD" },
          height: { type: "number", description: "身高公分" },
          add_condition: { type: "string", description: "新增一項慢性病，例如 高血壓、糖尿病" },
          allergies: { type: "string", description: "過敏（藥物、食物）" },
          familyCrc: { type: "boolean", description: "一等親有大腸癌" },
          familyLung: { type: "boolean", description: "父母、子女、兄弟姊妹有肺癌" },
          smoking: { type: "string", enum: ["never", "former", "current"] },
          packYears: { type: "number", description: "吸菸包年（每天幾包 × 抽幾年）" },
          betel: { type: "boolean", description: "嚼檳榔（含已戒）" },
        },
      },
    },
    async run(args, { room }) {
      return room.healthProfile(args);
    },
  },
  {
    label: "🪪 證件到期",
    decl: {
      name: "id_expiry",
      description:
        "記錄證件（護照、身分證、駕照、健保卡、居留證…）的到期日，到期前會在聊天和手機通知提醒（護照提前 6 個月，其他提前 3 個月）。" +
        "只記種類、持有人、到期日和號碼末四碼，絕對不要記完整證件號碼。action=list 列出已記錄的證件和剩幾天。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "list"] },
          kind: { type: "string", description: "證件種類，例如 護照、身分證、駕照" },
          holder: { type: "string", description: "持有人（照對話裡的稱呼，例如 我、小美）" },
          expires: { type: "string", description: "到期日 YYYY-MM-DD；只知道年月就填 YYYY-MM" },
          last4: { type: "string", description: "號碼末四碼（可留空，不要填完整號碼）" },
        },
        required: ["action"],
      },
    },
    async run(args, { room, author }) {
      if (args.action !== "add") return room.idDocList();
      return room.idDocAdd({ kind: args.kind, holder: args.holder, expires: args.expires, last4: args.last4 }, author);
    },
  },
  {
    label: "🧠 記住",
    decl: {
      name: "remember",
      description: "把重要資訊存入長期記憶：成員偏好（不吃辣、想買什麼）、決定、訂位與票券、密碼、集合地點、待辦等。成員說「記住…」或做出決定時使用。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要記住的內容，寫成完整一句話；日期寫實際日期（不要寫「明天」）" },
          category: { type: "string", enum: ["偏好", "決定", "預訂", "資訊", "待辦"] },
          expires: { type: "string", description: "只有「過了某天就不再成立」的事才填失效日期 YYYY-MM-DD（例如考試、約會、這週的安排）。人名、家人、年齡、喜好、習慣、住址一律不要填" },
        },
        required: ["content"],
      },
    },
    async run(args, { room, author }) {
      return room.remember(String(args.content), args.category || "資訊", author, args.expires ? String(args.expires) : undefined);
    },
  },
  {
    label: "🧠 刪除記憶",
    decl: {
      name: "forget",
      description: "刪除一條過時或錯誤的長期記憶（id 見系統提示中的記憶清單）。",
      parameters: { type: "object", properties: { memory_id: { type: "integer" } }, required: ["memory_id"] },
    },
    async run(args, { room }) {
      return { deleted: room.deleteMemory(Number(args.memory_id)) };
    },
  },
  {
    label: "🔎 翻聊天紀錄",
    decl: {
      name: "search_history",
      description: "搜尋以前的聊天紀錄（例如「上次說的那家餐廳叫什麼」）。",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string" }, limit: { type: "integer" } },
        required: ["keyword"],
      },
    },
    async run(args, { room }) {
      return room.searchHistory(args.keyword, Math.min(Number(args.limit) || 10, 30));
    },
  },
  {
    label: "📅 修改行程",
    decl: {
      name: "update_itinerary",
      description: "修改某一天的行程（標題、細節、狀態）。成員決定改行程、買好票、預約完成時使用。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "日期，例如 2026-10-09 或 10/9" },
          title: { type: "string" },
          detail: { type: "string" },
          status: { type: "string", description: "例如 ✅ 已購票、⚠️ 尚未購票、彈性" },
          replaces: REPLACES_PARAM,
        },
        required: ["date"],
      },
    },
    async run(args, { room, author, profile, propose }) {
      const date = normalizeDate(args.date, profile);
      if (!date) return { error: "看不懂日期，請用 10/9 或 2026-10-09" };
      const fields = { title: args.title, detail: args.detail, status: args.status };
      if (propose) {
        const cur = room.itineraryDay(date);
        const rows: [string, string, string?][] = [["日期", date]];
        for (const [k, label] of [["title", "標題"], ["detail", "細節"], ["status", "狀態"]] as const) {
          const v = fields[k];
          if (v == null || String(v) === (cur?.[k] ?? "")) continue;
          rows.push([label, String(v), cur?.[k] || undefined]);
        }
        if (rows.length === 1) return { unchanged: true, note: "內容和目前的行程一樣，不需要修改" };
        return propose({
          kind: "update_itinerary",
          payload: { date, fields, author },
          replaces: Number(args.replaces) || undefined,
          preview: { title: "修改行程確認", confirm: "確認修改", summary: `${date} ${fields.title ?? cur?.title ?? ""}`.trim(), rows },
        });
      }
      return room.updateItinerary(date, fields, author);
    },
  },
  {
    label: "🚆 電車狀況",
    only: (p) => p.countryCode === "JP",
    decl: {
      name: "train_status",
      description: "查日本電車（JR、地鐵、私鉄）現在的運行狀況：延誤、停駛、運轉計畫。可以指定路線，例如 山手線、御堂筋線。",
      parameters: { type: "object", properties: { line: { type: "string", description: "路線名稱（日文漢字最準），留空=列出目前所有異常路線" } } },
    },
    async run(args, { profile }) {
      const where = `${profile.city} ${profile.accommodation.address}`;
      const area = YAHOO_AREA.find(([re]) => re.test(where))?.[1] ?? 4;
      const res = await fetch(`https://transit.yahoo.co.jp/diainfo/area/${area}`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; TripAgent/1.0)" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return { error: `運行情報暫時查不到（${res.status}）` };
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) return { error: "運行情報格式改了，暫時無法解析" };
      const page = JSON.parse(m[1])?.props?.pageProps ?? {};
      const flat = (x: any): any[] => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" && !x.routeInfo ? Object.values(x).flatMap(flat) : x ? [x] : []);
      const lines = flat(page.diainfoTrainFeatures ?? [])
        .map((x: any) => x?.routeInfo?.property)
        .filter((p: any) => p?.displayName)
        .map((p: any) => ({
          line: p.displayName as string,
          company: p.companyName as string,
          issues: (p.diainfo ?? []).map((d: any) => ({ status: d.status, message: d.message, updated: d.updateDate })),
        }));
      const want = String(args.line ?? "").trim();
      if (want) {
        const ja = [...want.replace("丸之內", "丸ノ内")].map((c) => JA_KANJI[c] ?? c).join("").replace(/線$/, "");
        const hits = lines.filter((l: any) => l.line.includes(ja) || ja.includes(l.line.replace(/線$/, "")));
        if (!hits.length) return { line: want, note: "沒有找到這條路線，可能名稱不同；目前異常路線如下", troubles: lines.filter((l: any) => l.issues.length).slice(0, 15) };
        return { results: hits.map((h: any) => ({ ...h, status: h.issues.length ? h.issues.map((i: any) => i.status).join("、") : "平常運轉" })), source: "Yahoo!路線情報" };
      }
      const troubles = lines.filter((l: any) => l.issues.length);
      return { troubles: troubles.slice(0, 20), normal_count: lines.length - troubles.length, source: "Yahoo!路線情報" };
    },
  },
  {
    label: "🚕 計程車估價",
    decl: {
      name: "taxi_fare",
      description: "估算計程車車資與車程（依實際行車距離與當地費率）。起點留空=發問者目前位置或住宿。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "起點（當地地名或座標），留空=目前位置或住宿" },
          to: { type: "string", description: "目的地（當地語言或英文地名最準）" },
          night: { type: "boolean", description: "是否深夜時段，留空=依現在時間判斷" },
        },
        required: ["to"],
      },
    },
    async run(args, { room, author, profile }) {
      let from: { name: string; lat: number; lon: number } | null = null;
      if (args.from) from = await locate(String(args.from), profile);
      if (!from) {
        const mine = recentLocation(room, author);
        from = mine ? { name: mine.area || "目前位置", lat: mine.lat, lon: mine.lon } : homeOf(profile);
      }
      if (!from) return { error: "不知道起點在哪，請告訴我從哪裡出發" };
      const to = await locate(String(args.to), profile);
      if (!to) return { error: `找不到「${args.to}」，請用當地語言或英文地名再試` };
      const d = await getJSON(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`, undefined, 12_000);
      const route = d.routes?.[0];
      if (!route) return { error: "算不出行車路線" };
      const km = route.distance / 1000;
      const minutes = Math.round(route.duration / 60);
      const out: Record<string, unknown> = {
        from: from.name,
        to: to.name,
        distance_km: Math.round(km * 10) / 10,
        drive_minutes: `${minutes}–${Math.round(minutes * 1.5)} 分鐘（視路況）`,
      };
      const t = profile.taxi;
      if (!t || !t.base) {
        return { ...out, fare: "不知道當地計程車費率", notes: "請用 web_search 查當地計程車起跳價與每公里費率再估算", source: "路線：OSRM（OpenStreetMap）" };
      }
      const hour = zoned(Date.now(), profile.timezone).hour;
      const inNight = t.nightFrom > t.nightTo ? hour >= t.nightFrom || hour < t.nightTo : hour >= t.nightFrom && hour < t.nightTo;
      const night = typeof args.night === "boolean" ? args.night : t.nightMultiplier > 1 && inNight;
      const fare = (t.base + Math.max(0, km - t.baseKm) * t.perKm) * (night ? t.nightMultiplier : 1);
      const round = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n));
      return {
        ...out,
        fare: `約 ${profile.currencySymbol}${round(fare).toLocaleString()}–${profile.currencySymbol}${round(fare * 1.25).toLocaleString()}（${profile.currency}）`,
        night_surcharge: night,
        notes: `估算值（塞車會更貴），不含過路費與叫車費。${t.note}`,
        source: "路線：OSRM（OpenStreetMap）；費率：旅程初始化時查到的當地費率",
      };
    },
  },
  {
    label: "🆘 災害警報",
    decl: {
      name: "disaster_alerts",
      description: "查旅遊地附近的地震、颱風／熱帶氣旋、洪水、火山等災害，以及未來幾天的強風豪雨。問「有地震嗎」「颱風會不會影響行程」時使用。",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, { profile }) {
      return disasterAlerts(profile);
    },
  },
  {
    label: "✅ 清單",
    decl: {
      name: "add_checklist_items",
      description: "把東西加進全家共用清單：購物、行李、待辦。只有成員明確要求加入清單時才能使用，例如「把紀念品加入購物清單」；只是說想買或問推薦時不要使用。",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["購物", "行李", "待辦"] },
          items: { type: "array", items: { type: "string" }, description: "要加入的項目，每項一句" },
          for_whom: { type: "string", description: "是誰要的（購物用），可留空" },
        },
        required: ["list", "items"],
      },
    },
    async run(args, { room, author }) {
      const items = (Array.isArray(args.items) ? args.items : [args.items]).map((s: unknown) => String(s ?? "").trim()).filter(Boolean).slice(0, 20);
      if (!items.length) return { error: "沒有要加入的項目" };
      return room.checklistAdd(String(args.list || "購物"), items, String(args.for_whom ?? ""), author);
    },
  },
  {
    label: "✅ 清單",
    decl: {
      name: "update_checklist_item",
      description: "清單項目打勾（買到了、帶了、辦好了）、取消勾選或刪除。用關鍵字或 id 指定。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "項目關鍵字" },
          id: { type: "integer" },
          list: { type: "string", enum: ["購物", "行李", "待辦"] },
          done: { type: "boolean", description: "true=打勾，false=取消勾選" },
          remove: { type: "boolean", description: "true=刪除" },
        },
      },
    },
    async run(args, { room, author }) {
      return room.checklistUpdate(
        { id: args.id ? Number(args.id) : undefined, keyword: args.keyword, list: args.list },
        { done: typeof args.done === "boolean" ? args.done : args.remove ? undefined : true, remove: !!args.remove },
        author,
      );
    },
  },
  {
    label: "✅ 清單",
    decl: {
      name: "get_checklist",
      description: "查看全家共用清單（購物、行李、待辦），包含哪些已完成、哪些還沒。",
      parameters: { type: "object", properties: { list: { type: "string", enum: ["購物", "行李", "待辦"] } } },
    },
    async run(args, { room }) {
      return room.checklistGet(args.list);
    },
  },
  {
    label: "⏰ 提醒",
    decl: {
      name: "create_reminder",
      description: "設定提醒，時間到了會在群組發訊息通知全家。例如「10/4 早上 9:30 提醒大家出門」。",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: "當地時間，格式 YYYY-MM-DD HH:mm" },
          message: { type: "string", description: "提醒內容" },
        },
        required: ["time", "message"],
      },
    },
    async run(args, { room, author, profile }) {
      const m = String(args.time ?? "").match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
      if (!m) return { error: "時間格式看不懂，請用 2026-10-04 09:30（當地時間）" };
      const due = localToUtc(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, `${m[4]}:${m[5]}`, profile.timezone);
      if (!due) return { error: "時間格式看不懂" };
      if (due < Date.now() - 60_000) return { error: "這個時間已經過了" };
      return room.reminderAdd(due, String(args.message).slice(0, 300), author);
    },
  },
  {
    label: "⏰ 提醒",
    decl: {
      name: "list_reminders",
      description: "列出還沒到的提醒。",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, { room }) {
      return room.reminderList();
    },
  },
  {
    label: "⏰ 提醒",
    decl: {
      name: "delete_reminder",
      description: "刪除一個提醒（用 list_reminders 的 id）。",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    },
    async run(args, { room, propose }) {
      const id = Number(args.id);
      const r = room.reminderGet(id);
      if (!r) return { error: `找不到 #${id} 這個提醒（可能已經通知過），請先用 list_reminders 確認 id` };
      if (propose) {
        return propose({
          kind: "delete_reminder",
          payload: { id },
          preview: { title: "刪除提醒確認", confirm: "確認刪除", summary: `刪除提醒 #${id} ${r.time} ${r.message}`, rows: [["時間", r.time], ["內容", r.message]] },
        });
      }
      return { deleted: room.reminderDelete(id) };
    },
  },
  {
    label: "🎫 票券",
    decl: {
      name: "save_document",
      description: "把成員這則訊息附的照片存進票券保管箱（門票、訂位確認、QR Code、登機證、保險單等），之後可以快速叫出來，沒網路也看得到。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "名稱，例如「博物館門票 10/4 11:00」" },
          note: { type: "string", description: "補充說明，可留空" },
          folder: { type: "string", description: "放進哪個資料夾（例如「機票」「門票」），成員沒指定就不要填（放最外層）；沒有這個資料夾會自動建立" },
        },
        required: ["title"],
      },
    },
    async run(args, { room, author, photoId }) {
      if (!photoId) return { error: "這則訊息沒有附照片，請附上票券照片再說要存起來" };
      const folder = args.folder ? room.documentFolder(String(args.folder), author) : null;
      return room.documentSave(String(args.title).slice(0, 80), String(args.note ?? "").slice(0, 300), photoId, author, folder);
    },
  },
  {
    label: "🎬 找短片",
    decl: {
      name: "find_short_videos",
      description:
        "找地點、店家、美食、景點的 IG Reels、YouTube 短片或介紹影片：成員想看影片或實際畫面時就用，不管怎麼說（「有沒有短片」「有人拍嗎」「想看看長怎樣」「好啊找找看」都算），不要叫成員自己去搜尋。" +
        "會確認影片真的存在、跟地點有關，影片卡片（縮圖、標題、連結）會自動顯示在回答下方；不要自己寫影片網址。一次最多 2 個地點。",
      parameters: {
        type: "object",
        properties: {
          places: {
            type: "array",
            description: "要找短片的地點或店家，最多 2 個",
            items: {
              type: "object",
              properties: {
                name_local: { type: "string", description: "當地語言的名稱（例如「一蘭 池袋」「浅草寺」「명동교자」）" },
                name_zh: { type: "string", description: "台灣人常用的中文名稱（例如「一蘭拉麵」「淺草寺」「明洞餃子」；官方譯名少人用時寫俗稱，例如「達菲餐廳」）" },
                area: { type: "string", description: "地區（例如 池袋、明洞）；景點本身就是地名可以留空" },
                category: { type: "string", description: "類別，用當地語言（例如 ラーメン、寺、맛집）" },
                keywords: {
                  type: "array", items: { type: "string" },
                  description: "相關影片的說明裡一定會出現的名稱：店名或景點名本身的各種寫法，含台灣人常用的中文俗稱，不含地區和分店（例如 [\"一蘭\",\"Ichiran\"]、[\"仲見世\"]、[\"명동교자\",\"明洞餃子\"]、[\"Cape Cod Cook-Off\",\"鱈魚岬\",\"達菲餐廳\"]）",
                },
              },
              required: ["name_local", "keywords"],
            },
          },
          language: {
            type: "string",
            enum: ["local", "chinese"],
            description: "local＝當地語言的影片（預設）；chinese＝中文介紹的影片（成員說要中文的、台灣人拍的、聽得懂的時候用）",
          },
        },
        required: ["places"],
      },
    },
    async run(args, { env, attachImage, tavilyKey, profile }) {
      return findShortVideos(args, tavilyKey, profile.country, profile.city ?? "", env, attachImage);
    },
  },
  {
    label: "🗺️ 查證路線",
    decl: {
      name: "check_route_map",
      description:
        "成員問坐幾站、或要求查證／確認地鐵電車捷運路線時才用：找這個城市的路線圖（官方優先，找不到才用維基共享資源或其他網站的圖），照圖確認路線、轉乘站和站數，路線圖會附在回答下方。" +
        "呼叫時把你認為的搭法填在 legs，工具會在圖上逐段核對、改正，並照車站編號算站數。回答照回傳的 routes 寫，最後附上回傳的 google_maps 連結。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "出發的車站名稱（當地寫法，例如「押上」「有楽町」）；成員說了車站就照填，不要換成別站（要走到別站搭車就寫在 legs）；在住處或目前位置就填最近的車站" },
          destination: { type: "string", description: "要去的車站名稱（當地寫法，例如「浅草」）" },
          city: { type: "string", description: "城市（當地或中文名稱，例如 東京、大阪、首爾）；留空用旅程的城市" },
          city_en: { type: "string", description: "城市的英文名稱（例如 Tokyo、Seoul），用來找維基共享資源的路線圖" },
          legs: {
            type: "array",
            description: "你認為的搭法（照你知道的，每一段一筆），工具會在路線圖上逐段核對",
            items: { type: "object", properties: { line: { type: "string", description: "路線名稱" }, from: { type: "string", description: "上車站" }, to: { type: "string", description: "下車站" } } },
          },
        },
        required: ["origin", "destination"],
      },
    },
    async run(args, { env, room, attachImage, tavilyKey, profile }) {
      const origin = String(args.origin ?? "").trim(), destination = String(args.destination ?? "").trim();
      if (!origin || !destination) return { error: "請提供出發和要去的車站" };
      const city = String(args.city ?? "").trim() || profile.city || profile.country;
      const cityEn = String(args.city_en ?? "").trim() || "";
      const key = tavilyKey;
      const miss = "跟大家說沒查到可以查證的路線圖，不要寫站數，附上 google_maps 連結請大家直接看 Google 地圖的路線";
      // AI 照記憶提出的走法，拿去圖上核對（記憶的路線通常對，讀圖自己規劃反而容易繞路）
      const proposal = (Array.isArray(args.legs) ? args.legs : [])
        .slice(0, 5)
        .map((l: any, i: number) => `${i + 1}. ${String(l?.line ?? "").slice(0, 30)}：從「${String(l?.from ?? "").slice(0, 30)}」到「${String(l?.to ?? "").slice(0, 30)}」`)
        .join("\n");
      const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(stationQuery(origin))}&destination=${encodeURIComponent(stationQuery(destination))}&travelmode=transit`;
      // 試的順序：上次查證成功的 → 官方 → 維基共享資源 → 其他網站；每張都讓 AI 照圖回答，程式檢查通過才採用
      const tried = new Set<string>();
      let attempts = 0, aiDown = false;
      // 同一張圖讀兩次（同時跑），兩次讀出同樣的走法才算確認；只有一次讀得出來也照樣回答，但提醒對照附圖
      const tryMap = async (m: RouteMap | null) => {
        if (!m || attempts >= 3 || aiDown) return null;
        attempts++;
        const reads = await Promise.all([0, 1].map(() => room.readRouteMap({ bytes: m.bytes, mime: m.mime }, origin, destination, city, proposal)));
        if (reads.every((x) => !x)) {
          aiDown = true;
          return null;
        }
        const [a, b] = reads.filter((x): x is NonNullable<typeof x> => !!x && x.is_route_map && x.routes.length > 0);
        if (!a) {
          if (!seenMap && reads.some((x) => x?.is_route_map)) seenMap = m;
          return null;
        }
        const agreed = b ? agreeRoutes(a, b) : null;
        // 沒有交叉確認的路線不給站數（只讀一次的編號常讀錯）
        const single = { ...a.routes[0], legs: a.routes[0].legs.map((l: any) => ({ ...l, stops: null })) };
        return { m, r: { ...a, routes: [agreed ?? single] }, confirmed: !!agreed };
      };
      let hit: Awaited<ReturnType<typeof tryMap>> = null;
      // 是這個城市的路線圖、但圖上核對不出這段路線：還是附給大家對照
      let seenMap = null as RouteMap | null;
      const cached = room.cacheGet(`routemap3:${city}`, 7 * 86400_000);
      if (cached) {
        try {
          const c = JSON.parse(cached);
          tried.add(c.url);
          hit = await tryMap(await loadMap(c.url, c.source, c.page));
        } catch {}
      }
      if (!hit) {
        const [web, wiki] = await Promise.all([webMapCandidates(key, city, cityEn), wikiMapCandidates(city, cityEn)]);
        // 每一組候選一起下載（官方網站常常擋程式下載，不用一張一張等）
        const load = (list: { url: string; page?: string }[], source: string, n: number) =>
          Promise.all(list.filter((c) => !tried.has(c.url)).slice(0, n).map((c) => (tried.add(c.url), loadMap(c.url, source, c.page))));
        const [official, commons, other] = await Promise.all([load(web.official, "官方", 3), load(wiki, "維基共享資源", 2), load(web.other, "網路", 2)]);
        for (const m of [...official, ...commons, ...other]) if (!hit && m) hit = await tryMap(m);
      }
      const attach = async (m: RouteMap, label: string) => {
        room.cacheSet(`routemap3:${city}`, JSON.stringify({ url: m.url, source: m.source, page: m.page }));
        attachImage?.({
          src: `/api/img?u=${encodeURIComponent(m.url)}&s=${await sign(env, "img:" + m.url)}`,
          caption: `${city}路線圖`, label: `🗺️ ${m.source === "官方" ? "官方" : m.source === "維基共享資源" ? "維基共享資源的" : "網路上的"}路線圖（${label}）`, source: new URL(m.url).host, page: m.page,
        });
        return `${m.source}（${new URL(m.url).host}）`;
      };
      if (!hit && seenMap) {
        return {
          found_map: true, verified: false, source: await attach(seenMap, "請對照"), google_maps: gmaps, routes: [],
          note: "找到這個城市的路線圖，但在圖上沒能核對出這段路線：照你知道的說坐哪條線、在哪轉乘，但要清楚說明這次沒能用路線圖確認，請大家對照附圖和 Google 地圖；不要寫站數。最後附上 google_maps 連結。",
        };
      }
      if (!hit) return { found_map: false, google_maps: gmaps, note: aiDown ? `AI 暫時不能看圖（額度或連線問題）：${miss}` : `找不到能確認這段路線的路線圖：${miss}` };
      const { m, r, confirmed } = hit;
      const host = new URL(m.url).host;
      await attach(m, "回答的依據");
      return {
        found_map: true, source: `${m.source}（${host}）`, ...r,
        routes: r.routes.map((x: any) => ({ ...x, legs: x.legs.map(({ from_no, to_no, ...l }: any) => l) })),
        google_maps: gmaps,
        total_stops: r.routes[0].legs.every((l: any) => l.stops != null) ? r.routes[0].legs.reduce((n: number, l: any) => n + l.stops, 0) : null,
        ...(confirmed ? {} : { caution: "這條路線只讀到一次、還沒有交叉確認：照樣回答，但要提醒大家對照附圖確認轉乘站" }),
        rule: "只寫 routes 裡的路線（不要自己補其他路線或其他鐵路公司的路線）：每一段寫路線名稱、方向、上下車站和 stops 站數（stops 是照圖上的車站編號算的，兩次讀圖一致才有；是 null 就說站數請對照附圖數）；總站數只能寫 total_stops，是 null 就不要寫總站數，不要自己加或用車站編號算，轉乘和步行照 walk、transfers 寫；uncertain 裡的提醒大家注意；proposal_ok 是 false，先說原本以為的走法哪裡不對（照 uncertain），再照 routes 寫正確的。" +
          "開頭或結尾寫一句「依據：" + m.source + "路線圖（已附在下方，可以對照）」。最後附上 google_maps 連結（不用再呼叫 plan_route），提醒即時班次和月台以 Google 地圖為準。",
      };
    },
  },
  {
    label: "🖼 翻照片",
    decl: {
      name: "find_chat_photos",
      description:
        "找大家自己拍、傳到這個聊天室的照片，照片會直接顯示在回答下方。例如「第一天的照片」「昨天吃拉麵的照片」「小佑傳的照片」「我們在晴空塔的合照」。" +
        "要看沒去過的地方、店家、料理長什麼樣（網路圖片）才用 find_images。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "哪一天（YYYY-MM-DD）；「今天」「昨天」「第一天」都要換算成日期。沒提到日期才留空（全部）" },
          date_to: { type: "string", description: "找一段期間時的最後一天（YYYY-MM-DD）" },
          sender: { type: "string", description: "誰傳的（成員名字），沒指定就留空" },
          keyword: { type: "string", description: "照片內容，例如 拉麵、合照、晴空塔、夜景；沒指定就留空（會挑最精彩的）" },
          ids: { type: "array", items: { type: "string" }, description: "要顯示的照片 id（前一次結果 catalog 裡的），要指定特定幾張時才填" },
          count: { type: "number", description: "要幾張，預設 6，最多 8" },
        },
      },
    },
    async run(args, { room, attachImage }) {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
      const r = await room.chatPhotos({ date: args.date, dateTo: args.date_to, sender: args.sender, keyword: args.keyword, ids, count: args.count });
      for (const p of r.shown) attachImage?.({ src: `/api/photo/${p.id}`, caption: p.note, label: p.when, source: `${p.by} 傳的` });
      if (!r.total) return { found: 0, note: "這段期間聊天室裡沒有照片（存成票券的不算）。如果其實是想看網路上的圖片，可以改用 find_images" };
      if (!r.shown.length) return { found: 0, total: r.total, catalog: r.catalog, note: "照片說明裡找不到符合的；看 catalog 有沒有要的，有就用 ids 再呼叫一次，沒有就照實說" };
      return {
        shown: r.shown.length, total: r.total, photos: r.shown, ...(r.catalog.length ? { catalog: r.catalog } : {}),
        note: "photos 是符合條件、已經顯示在回答下方的照片（大家自己傳的，不是網路圖片，不用加「僅供參考」）。回答要跟這些照片一致，用說明簡短介紹，不要說找不到；如果明顯不是要的，可以從 catalog 挑 ids 再呼叫一次",
      };
    },
  },
  {
    label: "🎫 票券",
    decl: {
      name: "find_documents",
      description: "從票券保管箱找出票券或憑證，照片會顯示在回答下方。例如「給我看博物館的票」。",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "關鍵字（票券名稱、備註或資料夾名稱），留空=全部" } } },
    },
    async run(args, { room, attachImage }) {
      const docs = room.documentFind(args.keyword);
      for (const d of docs.slice(0, 6)) attachImage?.({ src: `/api/photo/${d.photo_id}`, caption: d.note, label: d.title, source: `${d.author} 存的` });
      if (!docs.length) return { found: 0, note: "保管箱裡沒有符合的票券；可以在 下方「工具箱」→ 票券保管箱 上傳，或傳照片並說「存成票券」" };
      return { found: docs.length, documents: docs.map((d) => ({ id: d.id, title: d.title, note: d.note, by: d.author, folder: d.folder || "最外層" })), note: "票券照片已顯示在回答下方" };
    },
  },
];

// ---------------- 災害警報（全球：USGS 地震、GDACS 災害、Open-Meteo 強風豪雨） ----------------

export async function disasterAlerts(p: TripProfile) {
  const home = homeOf(p);
  const out: Record<string, unknown> = {};
  const since = Date.now() - 48 * 3600_000;
  await Promise.all([
    (async () => {
      if (!home) return;
      try {
        const d = await getJSON(
          `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${new Date(since).toISOString().slice(0, 19)}` +
            `&latitude=${home.lat}&longitude=${home.lon}&maxradiuskm=600&minmagnitude=4`,
          undefined,
          12_000,
        );
        out.earthquakes = (d.features ?? []).slice(0, 10).map((f: any) => ({
          id: f.id,
          time: new Date(f.properties.time).toISOString(),
          place: f.properties.place,
          magnitude: f.properties.mag,
          distance_km: Math.round(distanceM(home.lat, home.lon, f.geometry.coordinates[1], f.geometry.coordinates[0]) / 1000),
          tsunami_flag: !!f.properties.tsunami,
          url: f.properties.url,
        }));
      } catch {
        out.earthquakes = "暫時查不到";
      }
    })(),
    (async () => {
      try {
        const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
        const to = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
        const d = await getJSON(
          `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;FL;VO;WF;DR&fromDate=${from}&toDate=${to}&alertlevel=Green;Orange;Red`,
          undefined,
          15_000,
        );
        out.disasters = (d.features ?? [])
          .map((f: any) => {
            const q = f.properties ?? {};
            const [lon, lat] = f.geometry?.coordinates ?? [];
            const km = home && Number.isFinite(lat) ? Math.round(distanceM(home.lat, home.lon, lat, lon) / 1000) : null;
            const affected = [q.iso3, ...(q.affectedcountries ?? []).map((c: any) => c.iso3)].filter(Boolean);
            return { id: `${q.eventtype}:${q.eventid}`, type: q.eventtype, name: q.name, alert: q.alertlevel, current: q.iscurrent === "true" || q.iscurrent === true, affects_country: affected.includes(p.countryIso3), distance_km: km, from: q.fromdate, to: q.todate, url: q.url?.report };
          })
          .filter((x: any) => x.affects_country || (x.distance_km != null && x.distance_km < (x.type === "TC" ? 1500 : 500)))
          .slice(0, 8);
      } catch {
        out.disasters = "暫時查不到";
      }
    })(),
    (async () => {
      if (!home) return;
      try {
        const f = await getJSON(
          `https://api.open-meteo.com/v1/forecast?latitude=${home.lat}&longitude=${home.lon}&timezone=${encodeURIComponent(p.timezone)}&forecast_days=3&daily=precipitation_sum,wind_gusts_10m_max,weather_code`,
          undefined,
          10_000,
        );
        out.forecast = (f.daily?.time ?? []).map((date: string, i: number) => ({
          date,
          rain_mm: f.daily.precipitation_sum[i],
          max_gust_kmh: f.daily.wind_gusts_10m_max[i],
          weather: WEATHER[f.daily.weather_code[i]] ?? f.daily.weather_code[i],
          severe: f.daily.wind_gusts_10m_max[i] >= 60 || f.daily.precipitation_sum[i] >= 30 || f.daily.weather_code[i] >= 95,
        }));
      } catch {}
    })(),
  ]);
  out.emergency = p.emergency;
  out.source = "USGS 地震資料、GDACS 全球災害警報、Open-Meteo";
  return out;
}

// ---------------- 對外介面 ----------------

function declOf(t: Tool, p: TripProfile): ToolDecl {
  return typeof t.decl === "function" ? t.decl(p) : t.decl;
}

// ---------------- 讀連結：Facebook／Instagram 的 Reels、影片 ----------------

/** 社群影片連結：用手機瀏覽器的身分打開，拿貼文文字與影片檔 */
const SOCIAL_HOST = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.watch|fb\.com|instagram\.com|threads\.(?:net|com))\//i;
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
/** Gemini 直接收影片一次最多約 20MB（base64 會變大），超過就只用貼文文字 */
const VIDEO_MAX_BYTES = 12_000_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function bytesToBase64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readSocial(url: string, room: RoomApi) {
  let html: string, finalUrl: string;
  try {
    const res = await fetch(url, { headers: { "user-agent": MOBILE_UA, "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    html = (await res.text()).slice(0, 600_000);
    finalUrl = res.url;
  } catch (e: any) {
    return { error: `打不開這個連結（${e?.message ?? e}）` };
  }
  const og = (k: string) => decodeEntities(html.match(new RegExp(`<meta[^>]+property="og:${k}"[^>]+content="([^"]*)"`))?.[1] ?? "");
  // 標題常是「觀看次數 · 心情數 | 貼文開頭 | 作者 | Facebook」：拿掉統計數字與網站名
  const caption = (og("description") || og("title")).trim();
  const title = og("title").replace(/^[\d.,\s\u00a0萬千次觀看·個心情則留言分享]+\|\s*/, "").replace(/\s*\|\s*(Facebook|Instagram|Threads)\s*$/i, "").trim();
  if (!caption && !title) return { error: "這則貼文看不到內容（可能需要登入、是私人或限定對象的貼文）。可以把貼文文字複製貼給我，或截圖傳給我。" };
  const out: Record<string, unknown> = {
    source: /instagram/i.test(finalUrl) ? "Instagram" : /threads/i.test(finalUrl) ? "Threads" : "Facebook",
    url: og("url") || finalUrl,
    title: title.split("\n")[0].slice(0, 120),
    caption: caption.slice(0, 3000),
    thumbnail: og("image") || undefined,
  };
  const video = og("video") || og("video:url") || og("video:secure_url");
  if (video && /^https:\/\/[a-z0-9.-]+\.(?:fbcdn\.net|cdninstagram\.com)\//i.test(video)) {
    try {
      const v = await fetch(video, { headers: { "user-agent": MOBILE_UA }, signal: AbortSignal.timeout(30_000) });
      const len = Number(v.headers.get("content-length") || 0);
      if (!v.ok || len > VIDEO_MAX_BYTES) {
        await v.body?.cancel();
        out.video_note = len > VIDEO_MAX_BYTES ? "影片太長，只根據貼文文字整理" : "影片下載失敗，只根據貼文文字整理";
      } else {
        const buf = new Uint8Array(await v.arrayBuffer());
        if (buf.length > VIDEO_MAX_BYTES) out.video_note = "影片太長，只根據貼文文字整理";
        else {
          const summary = await room.describeVideo(v.headers.get("content-type") || "video/mp4", bytesToBase64(buf), caption.slice(0, 500));
          if (summary) out.video_summary = summary;
          else out.video_note = "目前沒有可以看影片的 AI（需要 Gemini），只根據貼文文字整理";
        }
      }
    } catch (e: any) {
      out.video_note = `影片讀不到（${e?.message ?? e}），只根據貼文文字整理`;
    }
  } else out.video_note = "這則貼文沒有可以下載的影片，只根據貼文文字整理";
  return out;
}

/** 沒有 Tavily 金鑰時的一般網頁讀法：直接抓 HTML、拿掉標籤 */
async function readPlain(url: string) {
  try {
    const res = await fetch(url, { headers: { "user-agent": MOBILE_UA, "accept-language": "zh-TW,zh;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `讀取失敗 ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (!/html|text/.test(type)) return { error: "這不是網頁（可能是檔案或圖片）" };
    const html = (await res.text()).slice(0, 800_000);
    const title = decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
    const text = decodeEntities(
      html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " "),
    ).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    return text ? { url: res.url, title, content: text.slice(0, 8000) } : { error: "這個網頁讀不到文字內容" };
  } catch (e: any) {
    return { error: `打不開這個網頁（${e?.message ?? e}）` };
  }
}

// ---------------- 行事曆小工具 ----------------

const WD = "日一二三四五六";
const dateWithDay = (d: string) => `${d}（${WD[new Date(d + "T00:00:00Z").getUTCDay()]}）`;
const hhmm = (v: unknown) => {
  const m = String(v ?? "").trim().match(/^(\d{1,2})[:：](\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

function cleanEvent(a: Record<string, any>): EventInput | { error: string } {
  const title = String(a.title ?? "").trim().slice(0, 80);
  const date = String(a.date ?? "").trim();
  if (!title) return { error: "行程要有標題" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: "日期格式要是 YYYY-MM-DD" };
  const start = hhmm(a.start), end = start ? hhmm(a.end) : null;
  const remind = a.remind_minutes == null || a.remind_minutes === "" ? null : Math.max(0, Math.min(Math.round(Number(a.remind_minutes)), 20160));
  return {
    title, date, start, end: end && end > (start ?? "") ? end : null,
    location: String(a.location ?? "").trim().slice(0, 120) || null,
    note: String(a.note ?? "").trim().slice(0, 300) || null,
    remindMin: Number.isFinite(remind) ? remind : null,
  };
}

function eventWhen(e: EventInput): string {
  return `${dateWithDay(e.date)}${e.start ? ` ${e.start}${e.end ? `–${e.end}` : ""}` : " 整天"}`;
}

function remindText(m: number | null | undefined): string {
  if (m == null) return "不提醒";
  if (m === 0) return "準時提醒";
  if (m % 1440 === 0) return `前 ${m / 1440} 天`;
  if (m % 60 === 0) return `前 ${m / 60} 小時`;
  return `前 ${m} 分鐘`;
}

function eventRows(e: EventInput): [string, string, string?][] {
  return [
    ["標題", e.title],
    ["日期", dateWithDay(e.date)],
    ["時間", e.start ? `${e.start}${e.end ? `–${e.end}` : ""}` : "整天"],
    ["地點", e.location || "—"],
    ["提醒", remindText(e.remindMin)],
    ...(e.note ? [["備註", e.note] as [string, string]] : []),
  ];
}

function pickEvent(args: Record<string, any>, room: RoomApi): (EventInput & { id: number }) | { error: string; recent?: unknown } | { matches: unknown; note: string } {
  if (args.id) {
    const e = room.eventGet(Number(args.id));
    if (e) return e;
  }
  if (args.keyword) {
    const found = room.eventFind(String(args.keyword));
    if (found.length === 1) return found[0];
    if (found.length > 1) return { matches: found.map((e) => ({ id: e.id, when: eventWhen(e), title: e.title })), note: "有好幾個符合，請問是哪一個，再用 id 呼叫" };
  }
  return { error: "行事曆裡找不到這個行程", recent: room.eventList(localDateFrom(), "9999-12-31").slice(0, 8) };
}

/** pickEvent 找不到時列近期行程用：從今天（UTC）開始就好 */
const localDateFrom = () => new Date().toISOString().slice(0, 10);

/** 個人帳本的分類 */
const PERSONAL_CATEGORIES = ["餐飲", "交通", "購物", "日用品", "娛樂", "醫療", "帳單", "其他"];

/** 個人助理記帳：沒有分帳，外幣換成台幣 */
async function personalExpense(args: Record<string, any>, ctx: ToolContext) {
  const currency = String(args.currency || "TWD").toUpperCase();
  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "金額不正確" };
  let rate: { rate: number; estimated?: boolean };
  try {
    rate = await fxRate(ctx, currency, "TWD");
  } catch (e: any) {
    return { error: `查不到匯率，暫時無法記帳（${e?.message ?? e}）` };
  }
  const twd = Math.round(amount * rate.rate);
  const p = ctx.profile;
  const e: ExpenseInput = {
    description: args.description,
    amount,
    currency,
    amountLocal: twd,
    amountTwd: twd,
    payer: ctx.author,
    splitAmong: [ctx.author],
    category: PERSONAL_CATEGORIES.includes(args.category) ? args.category : "其他",
    date: normalizeDate(args.date, p) ?? localDate(p),
    author: ctx.author,
  };
  if (!ctx.propose) return { saved: ctx.room.addExpense(e) };
  return ctx.propose({
    kind: "add_expense",
    payload: e,
    replaces: Number(args.replaces) || undefined,
    preview: {
      title: "記帳確認",
      confirm: "確認記帳",
      summary: `${e.date} ${e.description} ${money(amount, currency, p)}`,
      rows: [
        ["日期", e.date],
        ["項目", String(e.description)],
        ["金額", `${money(amount, currency, p)}${currency !== "TWD" ? `（≈ NT$${twd.toLocaleString("en-US")}${rate.estimated ? "，匯率為估計值" : ""}）` : ""}`],
        ["分類", e.category],
      ],
    },
  });
}

/** 個人助理用不到的旅遊工具 */
const TRAVEL_ONLY = new Set([
  "theme_park_wait_times", "taxi_fare", "train_status", "update_itinerary", "get_member_locations", "disaster_alerts",
]);

/** 只有個人助理才有的工具 */
const PERSONAL_ONLY = new Set(["save_note", "search_notes", "add_event", "list_events", "update_event", "delete_event", "id_expiry"]);

/** 健康管家專用：只在健康對話（Cloudflare 的模型）裡提供，一般聊天的 Gemini 拿不到健康資料 */
const HEALTH_ONLY = new Set(["health_log", "health_status", "health_meds", "health_profile"]);
const HEALTH_EXTRA = new Set(["create_reminder", "list_reminders", "add_event", "list_events", "search_notes"]);

/** 這個空間可以用的工具（有些只在特定國家提供，個人助理不給旅遊專用的） */
export function toolDecls(p: TripProfile): ToolDecl[] {
  const personal = p.kind === "personal";
  return TOOLS.filter((t) => (!t.only || t.only(p)) && !HEALTH_ONLY.has(nameOf(t)) && !(personal ? TRAVEL_ONLY : PERSONAL_ONLY).has(nameOf(t))).map((t) => declOf(t, p));
}

/** 健康對話的工具：健康管家四個＋提醒、行事曆、知識庫 */
export function healthToolDecls(p: TripProfile): ToolDecl[] {
  return TOOLS.filter((t) => HEALTH_ONLY.has(nameOf(t)) || HEALTH_EXTRA.has(nameOf(t))).map((t) => declOf(t, p));
}

export function toolLabel(name: string): string {
  return TOOLS.find((t) => nameOf(t) === name)?.label ?? name;
}

function nameOf(t: Tool): string {
  // decl 是函式時名稱不會因國家改變，用空設定取一次名稱
  return typeof t.decl === "function" ? t.decl(DUMMY).name : t.decl.name;
}

const DUMMY = { language: "", city: "", country: "", currency: "" } as unknown as TripProfile;

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<unknown> {
  const tool = TOOLS.find((t) => nameOf(t) === name && (!t.only || t.only(ctx.profile)));
  if (!tool) return { error: `沒有這個工具：${name}` };
  const t0 = Date.now();
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (e: any) {
    console.error(`tool ${name} failed`, JSON.stringify(args), e?.message ?? e);
    return { error: String(e?.message ?? e) };
  } finally {
    const ms = Date.now() - t0;
    if (ms > 5_000) console.log(`tool ${name} slow ${ms}ms`);
  }
}
