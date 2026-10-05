import { DurableObject } from "cloudflare:workers";
import { decryptText, encryptText, hashPassword, maskKey, safeEqual, verifyPassword } from "./auth";
import { INIT_STEPS, researchTrip } from "./init";
import {
  BASE_CHECKLIST, EMPTY_GUIDE, diffFromTaiwan, flagEmoji, localDateTime, localToUtc, travelersText, tripDays, tripLine, validTimezone, zoned,
  type Traveler, type TripProfile,
} from "./profile";
import { geminiProvider, parseArgs, providerFor, WorkersAiQuotaError, type GeminiGate } from "./providers";
import { acquireWith, GeminiLimiter, limitsFrom, RateLimitedError } from "./ratelimit";
import { disasterAlerts, DRAFT_TOOLS, reverseArea, runTool, toolDecls, toolLabel, type AttachedImage, type DraftInput, type ExpenseInput, type RoomApi, type ToolContext } from "./tools";
import { fixMapLinks, type MapFixOptions } from "./maplinks";
import { renderDiaryPage } from "./diary-page";
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
const MEMORY_EVERY = 4; // 每 4 則新的成員訊息自動整理一次長期記憶
const RECALL_LIMIT = 8; // 從較舊的聊天中自動找回的相關訊息數
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
  // 「路線圖」「傳圖給我」也算要看圖；自己附了照片時是要 AI 看那張照片，不是上網找圖
  { tool: "find_images", test: (t, p) => !p && /照片|圖片|相片|看圖|附圖|長什麼樣|路線圖|地鐵圖|捷運圖|平面圖|示意圖|菜單圖|(傳|給|找|看).{0,6}圖(?!書)|photo|picture|image/i.test(t) && !/存|票券|地圖/.test(t) },
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
];

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

/** 模型偶爾學對話紀錄的格式，回答開頭多一個「［爸爸］」，存檔前拿掉 */
function stripSpeakerTag(text: string): string {
  return text.replace(/^\s*［[^］\n]{1,16}］\s*/, "");
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
    // 日記挑照片用：AI 看過每張照片的說明
    this.sql.exec("CREATE TABLE IF NOT EXISTS photo_notes (photo_id TEXT PRIMARY KEY, kind TEXT, score INTEGER, note TEXT, ts INTEGER, v INTEGER)");
    if (!this.sql.exec("PRAGMA table_info(photo_notes)").toArray().some((c) => c.name === "v")) this.sql.exec("ALTER TABLE photo_notes ADD COLUMN v INTEGER");
    // 家人修改日記：記下最後是誰改的
    for (const col of ["edited_by TEXT", "edited_at INTEGER", "layout TEXT"]) {
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
    profile.status = "review";
    this.saveProfile(profile);
    if (phrases.length) {
      this.sql.exec("DELETE FROM phrases WHERE author = '預設'");
      for (const x of phrases) this.sql.exec("INSERT INTO phrases (category, zh, local, reading, author, ts) VALUES (?, ?, ?, ?, '預設', ?)", x.category, x.zh, x.local, x.reading, Date.now());
    }
    this.sql.exec("DELETE FROM checklist WHERE author = 'AI 初始化'");
    for (const c of checklist) this.sql.exec("INSERT INTO checklist (list, item, for_whom, author, ts) VALUES (?, ?, '', 'AI 初始化', ?)", c.list, c.item, Date.now());
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
    // 日記分享連結：不用登入，要在登入檢查之前處理
    const shared = url.pathname.match(/^\/share\/([\w-]+)(?:\/photo\/([\w-]+))?$/);
    if (shared) return this.shared(shared[1], shared[2], req, url);
    // 管理員改過密碼：舊的登入一律失效
    if (user.ver !== Number(this.setting("auth_version", "1"))) return Response.json({ ok: false, error: "請重新登入" }, { status: 401 });
    if (url.pathname === "/me") return Response.json({ ok: true });
    if (url.pathname === "/album") return this.album("member", req, url);

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
        const photoId = typeof msg.photoId === "string" ? msg.photoId : null;
        const loc = msg.location && Number.isFinite(msg.location.lat) ? msg.location : null;
        if (!text && !photoId && !loc) return;
        if (loc) this.saveLocation(user.name, loc);
        // 回覆某一則訊息：記下被回覆的是誰說的、說了什麼（畫面上顯示引用，AI 追問時也看得到）
        const quoted = typeof msg.replyTo === "string" ? this.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", msg.replyTo).toArray()[0] : undefined;
        const reply = quoted ? { id: quoted.id, author: quoted.author, text: String(quoted.text ?? "").slice(0, 300) || (quoted.photo_id ? "（照片）" : "") } : null;
        const row = this.insertMessage({
          author: user.name, role: "user", text, photo_id: photoId, lat: loc?.lat ?? null, lon: loc?.lon ?? null, meta: reply ? JSON.stringify({ reply }) : null,
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
    const adminOnly = ["activate", "update_profile", "rerun_init", "update_keys", "update_passwords", "delete_trip", "settings", "reset", "brief_now", "diary_now", "diary_rewrite", "share_on", "share_off"];
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
          this.postAiMessage(
            `🎉 **${p.title}** 準備好了！\n\n我是${AI_NAME}，可以幫大家查景點美食和照片、找附近、估計程車、記帳分帳、翻譯${p.language}、設提醒…有問題直接在這裡問我就好。\n\n` +
              `👉 先按下方「工具箱」→ 使用說明，看看每個功能怎麼用\n👉 ${p.country}的入境、插座、交通、退稅整理在 「工具箱」→ 旅遊指南\n👉 管理員可以到 下方「設定」→ 邀請家人，把網址傳給大家`,
            { kind: "welcome" },
          );
          await this.ctx.storage.setAlarm(Date.now() + 60_000);
        }
        this.helloAll();
        break;
      }
      case "rerun_init": {
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
        for (const [k, key] of [["autoBrief", "auto_brief"], ["autoDiary", "auto_diary"], ["autoAlerts", "auto_alerts"]] as const) {
          if (typeof msg[k] === "boolean") this.setSetting(key, msg[k] ? "1" : "0");
        }
        this.broadcast({ type: "settings", settings: this.settings() });
        break;

      // ---- 一般功能 ----
      case "add_memory":
        if (String(msg.content ?? "").trim()) this.addMemory(String(msg.content).trim(), msg.category || "資訊", user.name);
        break;
      case "delete_memory":
        this.deleteMemory(Number(msg.id));
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
        await this.postMorningBrief(this.today());
        break;
      case "diary_now":
        await this.writeDiary(this.today());
        break;
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
        await this.writeDiary(date, false);
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
        if (msg.tools) {
          this.sql.exec("DELETE FROM checklist WHERE author NOT IN ('預設', 'AI 初始化')");
          this.sql.exec("UPDATE checklist SET done = 0, done_by = NULL");
          this.sql.exec("DELETE FROM reminders");
          this.sql.exec("DELETE FROM documents");
          this.sql.exec("DELETE FROM doc_folders");
          this.sql.exec("DELETE FROM diaries");
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
    if (!keepArea) this.ctx.waitUntil(this.ensureArea(name));
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
    const id = this.sql.exec("INSERT INTO memories (ts, category, content, author) VALUES (?, ?, ?, ?) RETURNING id", Date.now(), category, content.slice(0, 500), author).one().id as number;
    this.broadcastState();
    return id;
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
      ...this.sql.exec(`SELECT ts, author, text FROM messages WHERE ${where} ORDER BY ts DESC LIMIT ?`, ...likes, limit).toArray(),
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
    const next = this.sql.exec("SELECT MIN(due) AS due FROM reminders WHERE sent = 0").one().due as number | null;
    const at = Math.max(Date.now() + 5_000, Math.min(next ?? Infinity, Date.now() + 5 * 60_000));
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
      // 個人助理：早報、做夢之後的階段再加；旅遊日記、災害警報是旅遊專用
      if (p.kind === "personal") return;
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
    }
    if (due.length) this.broadcastState();
  }

  async postMorningBrief(date: string) {
    const p = this.p();
    this.setSetting("brief_sent", date);
    const today = this.itinerary().find((d) => d.date === date);
    const ctx = await this.toolCtx(AI_NAME);
    const [weather, alerts] = await Promise.all([runTool("get_weather", { days: 2 }, ctx), disasterAlerts(p).catch(() => ({}))]);
    const reminders = this.reminderList().filter((r) => String(r.time).startsWith(date));
    const todos = this.checklistGet("待辦").filter((c) => !c.done);
    const prompt = `請幫家庭旅遊群組寫今天（${date}）的「☀️ 早安早報」內文（標題系統會加，你不要再寫標題），繁體中文、親切、適合手機閱讀、300 字內，條列重點：
1. 今天的行程與建議出門時間（考慮 ${travelersText(p.travelers)}）
2. 天氣與穿著、要不要帶傘
3. 今天的提醒與待辦
4. 如果有地震、颱風或強風豪雨，放在最前面提醒
資料：
- 今天行程：${today ? `${today.title}｜${today.detail}｜${today.status}` : "沒有排行程"}
- 天氣：${JSON.stringify(weather).slice(0, 1500)}
- 警報：${JSON.stringify(alerts).slice(0, 1500)}
- 今天的提醒：${JSON.stringify(reminders)}
- 未完成待辦：${JSON.stringify(todos.slice(0, 8))}
- 住宿：${p.accommodation.name || p.accommodation.address}${p.accommodation.note ? `，${p.accommodation.note}` : ""}`;
    const text = await this.generateText(this.systemPrompt(), prompt, false, 1);
    this.postAiMessage(`☀️ **早安！${date.slice(5).replace("-", "/")} 早報**\n\n${text}`, { kind: "brief" });
  }

  /**
   * 日記挑照片前先看過每張照片：拍了什麼、適不適合放進日記（收據、截圖、證件不放）。
   * 看過的存進 photo_notes，重寫日記不用再看；一次送 5 張，照片多也不會太慢
   */
  private async describePhotos(rows: MessageRow[]): Promise<Map<string, PhotoNote>> {
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
          text: `以下是家庭旅遊群組今天的 ${batch.length} 張照片，依序編號。請逐張判斷，只輸出 JSON 陣列：[{"n":1,"kind":"…","score":3,"note":"…"}]
kind 只能是：${PHOTO_KINDS.join("、")}（收據＝收據、發票、帳單；截圖＝手機或網頁畫面截圖；文件＝票券、證件、表單等文字資料；旅途外＝不是這趟旅行拍的，例如家裡的寵物、家裡、舊照片）
note：繁體中文 20–60 字，具體寫出看到什麼：地點或招牌、食物或商品名稱、人（大人或小孩）在做什麼、表情動作；看不出來的照實寫，不要猜人名
score：當旅遊日記插圖的價值，大部分照片是 2–4 分：
5＝一看就有故事（家人生動的表情或互動、壯觀的景色、招牌美食上桌）
4＝好看的旅途紀錄（景點、街景、店面、美食、家人合照）
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
            system: "你是幫家庭旅遊日記挑照片的編輯，只輸出 JSON。",
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
    const photoMsgs = msgs.filter((m) => m.photo_id && m.role === "user" && !docs.has(m.photo_id)).slice(-40);
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
          const pic = m.photo_id ? (tag.has(m.photo_id) ? `（傳了照片 ${tag.get(m.photo_id)}）` : "（傳了照片）") : "";
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
    const { paragraphs, marks, ...parsed } = parseDiary(raw);
    // 模型沒寫標題（第一行就是內文）：標題用當天行程
    const title = parsed.title && parsed.title.length <= 30 ? parsed.title : today?.title ? String(today.title) : "旅途中的一天";
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
    const plan = new Map(this.itinerary().map((d) => [String(d.date), String(d.title ?? "")]));
    const start = Date.parse(p.startDate + "T00:00:00Z");
    const days = this.sql
      .exec("SELECT * FROM diaries ORDER BY date")
      .toArray()
      .map((d) => {
        const date = String(d.date);
        const layout = new Map((JSON.parse((d.layout as string) || "[]") as DiaryPhoto[]).map((l) => [l.id, l]));
        return {
          date,
          dayNo: Math.floor((Date.parse(date + "T00:00:00Z") - start) / 86400_000) + 1,
          title: String(d.title || plan.get(date) || "旅途中的一天"),
          plan: plan.get(date) ?? "",
          text: String(d.text ?? ""),
          photos: (JSON.parse((d.photo_ids as string) || "[]") as string[]).map((id) => {
            const l = layout.get(id);
            return { src: photoBase + id, para: l?.para, caption: l?.caption };
          }),
        };
      });
    const html = renderDiaryPage({
      tripTitle: p.title,
      dates: `${p.startDate.replaceAll("-", "/")} – ${p.endDate.slice(5).replace("-", "/")}`,
      travelers: p.travelers.map((t) => t.name).join("、"),
      accent: "#1d4ed8",
      days,
      mode,
      shareUrl: token ? origin + sharePath : null,
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

  private memories() {
    return this.sql.exec("SELECT * FROM memories ORDER BY ts").toArray();
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
      diaries: this.sql.exec("SELECT date, ts, title, text, photo_ids, edited_by, edited_at FROM diaries ORDER BY date DESC").toArray(),
      // 置頂訊息附完整內容：訊息再舊、畫面上沒載入也看得到
      pins: this.sql
        .exec<MessageRow & { pin_ts: number; pin_by: string }>("SELECT m.*, p.ts AS pin_ts, p.by AS pin_by FROM pins p JOIN messages m ON m.id = p.message_id ORDER BY p.ts DESC")
        .toArray()
        .map((r) => ({ ts: r.pin_ts, by: r.pin_by, message: this.publicMessage(r) })),
      locations: this.memberLocation(),
      gemini: this.ownLimiter.usage(),
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
    const older = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts < ? AND text != '' ORDER BY ts DESC LIMIT 3000", windowStartTs).toArray();
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

  /** 個人助理的系統提示詞：只有本人，沒有旅程、住宿、分帳 */
  private personalPrompt(trigger?: MessageRow, windowStartTs?: number): string {
    const p = this.p();
    const owner = p.travelers[0]?.name || "使用者";
    const recall = trigger && windowStartTs ? this.recallOlder(trigger, windowStartTs) : "";
    const now = zoned(Date.now(), p.timezone);
    const a = p.accommodation;
    const mems = this.memories().map((m) => `- #${m.id}［${m.category}］${m.content}`).join("\n") || "（目前沒有）";
    const summary = this.setting("summary");
    const loc = this.memberLocation()
      .map((l) => `${l.area ? `${l.area}附近` : "地名查詢中"}（${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`)
      .join("");
    return `你是「${AI_NAME}」，${owner}的個人 AI 助理。這個空間只有${owner}一個人，對話內容其他人看不到。

# 現在
${now.date}（${now.weekday}）${now.time}，時區 ${p.timezone}。
住的地方：${p.city || "（未設定）"}${a.address ? `（${a.address}）` : ""}${loc ? `\n${owner}最近的位置：${loc}` : ""}

# 長期記憶（關於${owner}的偏好、決定、重要資訊；#編號可用 forget 刪除）
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
- 天氣 → get_weather；附近有什麼 → find_nearby（near 留空會用${owner}的位置，沒有位置就用住的地方）；怎麼去 → plan_route；匯率 → convert_currency。
- 地圖連結：工具回傳的連結可以直接用；其他地點一律寫成 [📍地點名稱](map)，系統會自動換成 Google 地圖搜尋連結。不要自己寫 Google 地圖網址或短網址，也不要用自己記得的地址或座標當連結。
- 要看照片、圖片時用 find_images（圖片會顯示在回答下方），並說明是網路圖片、僅供參考；沒有要求就不要找圖片。
- 收到照片：辨識內容並說明；說要「存起來」→ save_document（說了資料夾就填 folder）；要找存過的文件、票券 → find_documents。
- 目前還沒有記帳功能：${owner}說花了多少錢，不要說要幫忙記帳；需要的話可以問要不要加進待辦提醒自己。
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
    const mems = this.memories().map((m) => `- #${m.id}［${m.category}］${m.content}（${m.author}）`).join("\n") || "（目前沒有）";
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

# 長期記憶（成員偏好、決定、預訂…，#編號可用 forget 刪除）
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
- 問路：用 plan_route 給 Google Maps 連結，必要時用 web_search 補充轉乘與票價。
- 住宿的位置寫成 [📍住宿](map)（系統會換成正確位置）；要帶路回住宿就用 plan_route，destination 填「住宿」。不要自己用住宿名稱或地址搜尋，常會跑到別的地方。
- 地圖連結：工具回傳的連結可以直接用（find_nearby 給的是那家店的座標，照抄，不要改成店名搜尋，連鎖店用店名會跑到別家分店）；其他地點一律寫成 [📍地點名稱](map)，系統會自動換成 Google 地圖搜尋連結（地點名稱用日文或英文的正式名稱，連鎖店要加分店名，例如 [📍ドン・キホーテ 池袋駅西口店](map)）。不要自己寫 Google 地圖網址，絕對不要編 maps.app.goo.gl 短網址，也不要用自己記得的地址或座標當連結（記錯一個字就會指到別的地方）。
- 成員在哪裡，一律以「成員最近位置」或訊息裡附的地名為準，絕對不要自己猜地名；以前聊天裡說過的位置可能已經過時，不要沿用。
- 每次有人問「附近」都要重新呼叫工具查詢，不可以沿用之前的回答。
- 你可以用 find_images 把網路上的圖片直接顯示給成員（照片、捷運／地鐵路線圖、平面圖、菜單…），絕對不要說「無法傳送圖片」。
- 成員要求看照片／圖片／路線圖時，一定要用 find_images（店名或景點名稱加地名；好幾個地方就放進 queries 一次查完）；圖片會自動顯示在回答下方。絕對不要自己產生圖片網址或圖片搜尋連結，並提醒是網路圖片、僅供參考。沒有要求就不要找圖片。
- 問「我附近有什麼」：直接用 find_nearby，near 留空（系統會自動用發問者的 GPS），回答時列出實際店名、距離、步行分鐘與地圖連結；需要評價再用 web_search 補充。問「我在哪」用 get_member_locations，說出區域與最近的車站。
- 問計程車多少錢、要多久 → taxi_fare；問地震、颱風、天氣會不會影響行程 → disaster_alerts；問樂園排隊 → theme_park_wait_times。${hasTool("train_status") ? "問電車有沒有延誤、停駛 → train_status。" : ""}
- 收到收據照片（或說「記帳這張收據」）：讀出店名、日期、總金額、幣別與主要品項，用 add_expense 產生記帳卡片（description 寫「店名：品項」），付款人預設是發問者。幣別要看清楚：當地收據是 ${p.currency}，台灣收據是 TWD（NT$、民國年、統一發票）；民國年要加 1911（113 年＝2024 年）。若可能達退稅門檻，順便提醒。
- 只有成員明確說「加入／加到清單」時才用 add_checklist_items。只是說想買、要帶、問推薦，都不可以自動加入清單；只有成員提到想買或要帶東西時，才在回答最後問一句要不要加進清單，其他話題（例如記帳、問路）不要問。買到了、帶了、辦好了 → update_checklist_item；問清單 → get_checklist。
- 要求「幾點提醒」→ create_reminder（時間用當地時間 YYYY-MM-DD HH:mm）。
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

  private buildTurns(history: MessageRow[], trigger: MessageRow, image: Part | null): Turn[] {
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
        if (m.photo_id) t += "（附了一張照片）";
        if (m.lat != null) t += `（分享位置 ${m.lat?.toFixed(5)},${m.lon?.toFixed(5)}）`;
        push("user", t);
      }
    }
    let t = `［${trigger.author}］${this.replyContext(trigger)}${trigger.text || (trigger.photo_id ? "請看這張照片" : "")}`;
    if (trigger.lat != null) {
      const area = this.memberLocation(trigger.author)[0]?.area;
      t += `（我目前的位置：${area ? `${area}附近，` : ""}座標 ${trigger.lat?.toFixed(5)},${trigger.lon?.toFixed(5)}。位置可能變了，需要地點資訊請用工具重新查詢，不要沿用之前的回答）`;
    }
    const parts: Part[] = [{ text: t }];
    if (image) parts.push(image);
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
    const order = await this.chain(!!trigger.photo_id);
    const decls = toolDecls(p);
    const available = new Set(decls.map((d) => d.name));

    if (!order.length) {
      const row = this.insertMessage({
        id, author: AI_NAME, role: "assistant", photo_id: null, lat: null, lon: null, meta: JSON.stringify({ error: true }),
        text: "抱歉，今天的免費 AI 額度用完了 🙇\n\n管理員可以到 下方「設定」→ API 金鑰，填入自己的 Gemini 金鑰（免費申請）就能繼續使用；或等台灣時間早上 8 點額度重置。",
      });
      this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
      return;
    }

    let image: Part | null = null;
    if (trigger.photo_id) {
      const ph = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", trigger.photo_id).toArray()[0];
      if (ph) image = { image: { mime: ph.mime as string, data: toBase64(ph.data as ArrayBuffer) } };
    }
    // 附了位置就先把地名查好，AI 才不會自己猜在哪裡
    if (trigger.lat != null) await this.ensureArea(trigger.author);
    const history = this.recentMessages(HISTORY_WINDOW);
    const system = this.systemPrompt(trigger, history[0]?.ts ?? trigger.ts);
    const images: AttachedImage[] = [];
    const toolsUsed: string[] = [];
    const drafts: number[] = [];
    const ctx = await this.toolCtx(user.name, {
      photoId: trigger.photo_id,
      attachImage: (img) => images.length < 8 && images.push(img),
      propose: (d) => this.propose(d, user.name, id, drafts),
    });
    // 成員像是在修改剛才還沒確認的卡片（「打錯了，是 3500」）
    const fixing = /改成|改為|改一下|打錯|寫錯|記錯|不對|應該是|更正|修正/.test(trigger.text)
      ? this.sql.exec("SELECT id, kind, preview FROM drafts WHERE status = 'pending' AND ts > ? ORDER BY id DESC LIMIT 1", Date.now() - 30 * 60_000).toArray()[0]
      : undefined;
    let lastError = "";
    // 跨模型共用：前一個模型中途被限流時，下一個模型接著已完成的工具結果繼續，不會重複記帳或重複查詢
    let turns = this.buildTurns(history, trigger, image);
    const onWait = (ms: number) => this.broadcast({ type: "ai_note", id, text: `Gemini 額度冷卻中，等待 ${Math.ceil(ms / 1000)} 秒…` });

    for (const pid of order) {
      const provider = await this.provider(pid, 1, FOREGROUND_MAX_WAIT, onWait);
      this.broadcast({ type: "ai_start", id, provider: provider.id, label: PROVIDER_LABEL[provider.id], model: provider.model });
      let finalText = "";
      const nudged = new Set<string>();
      const forced = new Set<string>();
      let emptyRetried = false;
      let cardNudged = false;
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const res = await provider.generate({ system, turns, tools: decls, onDelta: (delta) => this.broadcast({ type: "ai_delta", id, delta }) });
          if (!res.calls.length) {
            // 模型偶爾偷懶：嘴上說「已加入清單」「圖片在下方」卻沒呼叫工具。提醒一次，重新回答
            let need = requiredTool(trigger.text, toolsUsed, !!trigger.photo_id, available);
            // 要寫入資料的工具：AI 正在反問成員（日期不在旅遊期間、金額看不清…）就讓它問，不要蓋掉硬寫
            if (need && DRAFT_TOOLS.has(need) && isAskingBack(res.text)) need = null;
            if (need && !nudged.has(need) && step < MAX_STEPS - 1) {
              nudged.add(need);
              this.broadcast({ type: "ai_reset", id });
              turns = [
                ...turns,
                { role: "model", parts: [{ text: res.text || "（略）" }] },
                { role: "user", parts: [{ text: `（系統提醒：你還沒有呼叫 ${need}，這件事一定要呼叫 ${need} 才算完成，沒有呼叫就不能說已完成。請現在呼叫，再根據結果完整回答。成員沒看到你剛才那段回答，不用道歉，也不要提到這個提醒。）` }] },
              ];
              continue;
            }
            // 提醒過還是不呼叫：系統自己執行工具，再請模型根據結果回答
            if (need && !forced.has(need) && step < MAX_STEPS - 1) {
              forced.add(need);
              const note = await this.forceTool(need, provider, history, trigger, user, id, ctx, toolsUsed, image);
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
            toolsUsed.push(c.name);
            this.broadcast({ type: "ai_tool", id, name: c.name, label: toolLabel(c.name), args: c.args });
            const result = await runTool(c.name, c.args, ctx);
            resultParts.push({ result: { id: c.id, name: c.name, response: result } });
          }
          turns = [...turns, { role: "model", parts: modelParts }, { role: "user", parts: resultParts }];
          if (step === MAX_STEPS - 1) finalText = res.text || "（查了很多資料，但還沒整理完，請再問一次更具體的問題 🙏）";
        }
        if (!finalText.trim()) finalText = images.length ? "幫你找到這些圖片 👇（網路圖片，僅供參考）" : "嗯…我沒有想到好的回答，可以換個方式問我嗎？";
        const row = this.insertMessage({
          id, author: AI_NAME, role: "assistant", text: fixMapLinks(stripSpeakerTag(finalText), this.mapFix()), photo_id: null, lat: null, lon: null,
          meta: JSON.stringify({
            provider: provider.id, providerLabel: PROVIDER_LABEL[provider.id], model: provider.model, tools: [...new Set(toolsUsed)].map(toolLabel),
            ...(images.length ? { images } : {}),
            ...(drafts.length ? { drafts } : {}),
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
      id, author: AI_NAME, role: "assistant", photo_id: null, lat: null, lon: null, meta: JSON.stringify({ error: true, ...(drafts.length ? { drafts } : {}) }),
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
    id: string, ctx: ToolContext, toolsUsed: string[], image: Part | null,
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
          text: `成員（${user.name}）說：「${trigger.text}」
現在是當地時間 ${now.date}（${now.weekday}）${now.time}。旅伴名單：${this.members().join("、") || user.name}。當地貨幣 ${p.currency}。
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

    const transcript = fresh.slice(-80).map((m) => `${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 500)}`).join("\n");
    const existing = this.memories().map((m) => `#${m.id}［${m.category}］${m.content}`).join("\n") || "（無）";
    const personal = this.isPersonal();
    const intro = personal
      ? `以下是個人助理和使用者最新的對話，請整理長期記憶：
1. summary：把「舊摘要」與新對話合併成新的「長期對話摘要」（400 字內；保留使用者的偏好、習慣、做過的決定、進行中的事情、重要資訊）。
2. memories：萃取新對話中「之後還會用到」且「不在現有記憶裡」的事實，每條一句話。
   例如：喜歡／不吃什麼、家人與朋友、工作與作息、做了什麼決定、訂了什麼、要做的事；提到的日期一律寫成實際日期（不要寫「明天」「下週」）。
   不要收錄身分證字號、信用卡號、密碼、病歷細節這類敏感資料，也不要收錄閒聊或 AI 自己的建議。沒有就回空陣列。`
      : `以下是家庭旅遊群組最新的對話，請整理群組的長期記憶：
1. summary：把「舊摘要」與新對話合併成新的「整趟旅程對話摘要」（400 字內；保留每個人的偏好、做過的決定、討論過的店家與地點、待辦、重要資訊）。
2. memories：萃取新對話中「之後還會用到」且「不在現有記憶裡」的事實，每條一句話、寫清楚是誰。
   例如：誰喜歡／不吃什麼、想買什麼、想去哪、決定了什麼、訂了什麼、待辦事項、聊到的店名與地址。
   不要收錄住宿地址、航班這些系統已知的資料，也不要收錄閒聊或 AI 自己的建議。沒有就回空陣列。`;
    const prompt = `${intro}
3. remove_ids：現有記憶中已經過時、被新對話推翻、或重複的記憶 id。沒有就回空陣列。

舊摘要：
${this.setting("summary") || "（無）"}

現有記憶：
${existing}

新對話：
${transcript}

輸出 JSON：{"summary": "...", "memories": [{"content": "...", "category": "偏好|決定|預訂|資訊|待辦"}], "remove_ids": [數字]}`;
    try {
      // 背景整理只用 Gemini 一半的額度、不等待，把額度留給回答問題
      const json = parseArgs((await this.generateText(personal ? "你是負責整理個人助理長期記憶的助理，只輸出 JSON。" : "你是負責整理旅遊群組長期記憶的助理，只輸出 JSON。", prompt, true, 0.5)).replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as any;
      if (typeof json.summary === "string" && json.summary.trim()) this.setSetting("summary", json.summary.trim().slice(0, 2000));
      for (const rid of (json.remove_ids ?? []).slice(0, 20)) {
        if (Number.isInteger(Number(rid))) this.sql.exec("DELETE FROM memories WHERE id = ?", Number(rid));
      }
      for (const m of (json.memories ?? []).slice(0, 20)) {
        if (m?.content) this.addMemory(String(m.content), String(m.category || "資訊"), "AI 自動整理");
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
