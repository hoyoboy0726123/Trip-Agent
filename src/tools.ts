import { sign } from "./auth";
import { localToUtc, zoned, type TripProfile } from "./profile";
import type { Env, ToolDecl } from "./types";

/** 工具可以用到的聊天室功能（由 TripRoom 實作） */
export interface RoomApi {
  members(): string[];
  memberLocation(name?: string): { name: string; lat: number; lon: number; accuracy: number | null; ts: number; area: string | null }[];
  addMemory(content: string, category: string, author: string): number;
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
  documentSave(title: string, note: string, photoId: string, author: string): unknown;
  documentFind(keyword?: string): { id: number; title: string; note: string; photo_id: string; author: string; ts: number }[];
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
}

export interface ToolContext {
  env: Env;
  room: RoomApi;
  profile: TripProfile;
  /** 這個旅程自己的 Tavily 金鑰 */
  tavilyKey: string;
  author: string;
  /** 發問者這則訊息附的照片（存票券、讀收據用） */
  photoId?: string | null;
  /** 工具找到的圖片，會附在這次 AI 回答下方 */
  attachImage?: (img: AttachedImage) => void;
  /** AI 發起的寫入（記帳、改行程、刪除）先做成確認卡片，成員按確認才寫入；畫面上手動操作沒有這個，直接寫 */
  propose?: (d: DraftInput) => unknown;
}

/** 要成員按確認才會執行的動作 */
export type DraftKind = "add_expense" | "update_itinerary" | "delete_expense" | "delete_reminder";
export const DRAFT_TOOLS = new Set<string>(["add_expense", "update_itinerary", "delete_expense", "delete_reminder"]);

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
    label: "📄 閱讀網頁",
    decl: {
      name: "read_webpage",
      description: "讀取指定網址的網頁全文（例如搜尋結果中的官方網站），用來確認細節。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(args, { tavilyKey }) {
      if (!tavilyKey) return { error: "這個旅程還沒設定 Tavily 金鑰" };
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tavilyKey}` },
        body: JSON.stringify({ urls: [args.url] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) return { error: `讀取失敗 ${res.status}` };
      const d: any = await res.json();
      const r = d.results?.[0];
      return r ? { url: r.url, content: String(r.raw_content ?? "").slice(0, 8000) } : { error: "無法讀取這個網頁" };
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
    async run(args, { room, author, profile }) {
      const mine = recentLocation(room, author);
      let center: { lat: number; lon: number; label: string } | null = null;
      let note = "";
      // AI 常把發問者自己的地名填進 near，這時直接用 GPS 比較準
      const near = String(args.near ?? "").trim();
      const isMyArea = !!near && !!mine?.area && (mine.area.includes(near) || near.includes(mine.area));
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
      const cuisine = CUISINE.find(([re]) => re.test(kw))?.[1];
      let places = kw
        ? all.filter((p: any) => `${p.name} ${p.name_local ?? ""} ${p.name_en ?? ""}`.toLowerCase().includes(kw.toLowerCase()) || (cuisine && cuisine.test(p.cuisine ?? "")))
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
          origin: { type: "string" },
          destination: { type: "string" },
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
    decl: (p) => ({
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
    decl: {
      name: "expense_summary",
      description: "旅費統計：總花費、每人付了多少、每人應付多少、誰該給誰多少錢（結算）、分類與每日花費。",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, { room }) {
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
            rows: [["日期", ex.date], ["項目", ex.description], ["金額", amount], ["付款人", ex.payer]],
          },
        });
      }
      return { deleted: room.deleteExpense(id) };
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
          content: { type: "string", description: "要記住的內容，寫成完整一句話" },
          category: { type: "string", enum: ["偏好", "決定", "預訂", "資訊", "待辦"] },
        },
        required: ["content"],
      },
    },
    async run(args, { room, author }) {
      return { saved_id: room.addMemory(args.content, args.category || "資訊", author) };
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
        },
        required: ["title"],
      },
    },
    async run(args, { room, author, photoId }) {
      if (!photoId) return { error: "這則訊息沒有附照片，請附上票券照片再說要存起來" };
      return room.documentSave(String(args.title).slice(0, 80), String(args.note ?? "").slice(0, 300), photoId, author);
    },
  },
  {
    label: "🎫 票券",
    decl: {
      name: "find_documents",
      description: "從票券保管箱找出票券或憑證，照片會顯示在回答下方。例如「給我看博物館的票」。",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "關鍵字，留空=全部" } } },
    },
    async run(args, { room, attachImage }) {
      const docs = room.documentFind(args.keyword);
      for (const d of docs.slice(0, 6)) attachImage?.({ src: `/api/photo/${d.photo_id}`, caption: d.note, label: d.title, source: `${d.author} 存的` });
      if (!docs.length) return { found: 0, note: "保管箱裡沒有符合的票券；可以在 下方「工具箱」→ 票券保管箱 上傳，或傳照片並說「存成票券」" };
      return { found: docs.length, documents: docs.map((d) => ({ id: d.id, title: d.title, note: d.note, by: d.author })), note: "票券照片已顯示在回答下方" };
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

/** 這個旅程可以用的工具（有些只在特定國家提供） */
export function toolDecls(p: TripProfile): ToolDecl[] {
  return TOOLS.filter((t) => !t.only || t.only(p)).map((t) => declOf(t, p));
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
