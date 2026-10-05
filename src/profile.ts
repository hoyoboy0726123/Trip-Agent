// 旅程設定：引導設置填的資料 + AI 初始化查到的當地資訊。每個旅程房間各存一份。

export type TripStatus = "initializing" | "review" | "active";

export interface Traveler {
  name: string;
  kind: "大人" | "小孩";
}

export interface GuideSource {
  title: string;
  url: string;
}

export interface TripProfile {
  /** trip＝家庭旅遊；personal＝個人助理（只有本人、不用 Gemini、沒有旅程日期）。舊資料沒有這欄＝trip */
  kind?: "trip" | "personal";
  status: TripStatus;
  title: string;
  country: string; // 中文國名
  countryCode: string; // ISO 3166-1 alpha-2，例如 KR
  countryIso3: string; // 災害警報比對用，例如 KOR
  city: string;
  center: { lat: number; lon: number } | null; // 城市中心（沒有住宿座標時的預設位置）
  startDate: string;
  endDate: string;
  timezone: string; // IANA，例如 Asia/Seoul
  currency: string; // ISO 4217，例如 KRW
  currencySymbol: string; // ₩
  language: string; // 中文語言名稱，例如 韓文
  langCode: string; // BCP 47，朗讀與語音輸入用，例如 ko-KR
  readingName: string; // 發音提示的名稱，例如 羅馬拼音；不需要就空字串
  travelers: Traveler[];
  accommodation: { name: string; address: string; lat: number | null; lon: number | null; note: string };
  flights: string;
  emergency: string;
  taxi: { base: number; baseKm: number; perKm: number; nightMultiplier: number; nightFrom: number; nightTo: number; note: string } | null;
  guide: {
    entry: string;
    money: string;
    power: string;
    transport: string;
    taxRefund: string;
    connectivity: string;
    etiquette: string;
    weather: string;
    sources: GuideSource[];
  };
  initNotes: string[]; // 初始化時查不到、需要手動確認的項目
}

export const EMPTY_GUIDE: TripProfile["guide"] = {
  entry: "", money: "", power: "", transport: "", taxRefund: "", connectivity: "", etiquette: "", weather: "", sources: [],
};

// ---------------- 時區 ----------------

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 某個時間點在旅遊地的日期、時間、星期 */
export function zoned(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    hour: Number(p.hour),
    weekday: "日一二三四五六"[WD[p.weekday] ?? 0],
    y: Number(p.year), m: Number(p.month), d: Number(p.day), mi: Number(p.minute), s: Number(p.second),
  };
}

function offsetMs(ts: number, tz: string): number {
  const z = zoned(ts, tz);
  const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.hour, z.mi, z.s);
  return Math.round((asUtc - ts) / 60_000) * 60_000;
}

/** 旅遊地的「YYYY-MM-DD HH:mm」→ UTC 毫秒（處理日光節約時間） */
export function localToUtc(date: string, time: string, tz: string): number | null {
  const d = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !t) return null;
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  let ts = guess - offsetMs(guess, tz);
  const again = guess - offsetMs(ts, tz);
  if (again !== ts) ts = again;
  return ts;
}

export function localDateTime(ts: number, tz: string): string {
  const z = zoned(ts, tz);
  return `${z.date} ${z.time}`;
}

/** 旅遊地和台灣的時差說明，例如「比台灣快 1 小時」 */
export function diffFromTaiwan(tz: string): string {
  const now = Date.now();
  const h = (offsetMs(now, tz) - offsetMs(now, "Asia/Taipei")) / 3600_000;
  if (h === 0) return "和台灣同一個時間";
  return `比台灣${h > 0 ? "快" : "慢"} ${Math.abs(h)} 小時`;
}

// ---------------- 其他 ----------------

export function flagEmoji(cc: string): string {
  const s = String(cc ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return "🌏";
  return String.fromCodePoint(...[...s].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function tripDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z") && out.length < 62; t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function travelersText(t: Traveler[]): string {
  const adults = t.filter((x) => x.kind === "大人").length;
  const kids = t.length - adults;
  return kids ? `${adults} 大 ${kids} 小` : `${adults} 位大人`;
}

/** 每個旅程都有的基本清單；各國專屬的項目由 AI 初始化時補上 */
export const BASE_CHECKLIST: { list: string; item: string }[] = [
  { list: "行李", item: "護照（效期 6 個月以上）" },
  { list: "行李", item: "機票電子票證" },
  { list: "行李", item: "住宿訂房確認" },
  { list: "行李", item: "信用卡（至少 2 張不同發卡組織）" },
  { list: "行李", item: "網卡／eSIM" },
  { list: "行李", item: "手機充電器、行動電源（放隨身行李）" },
  { list: "行李", item: "常備藥" },
  { list: "待辦", item: "投保旅遊平安險／不便險" },
  { list: "待辦", item: "確認入境規定（簽證、入境登記）" },
];

/** 系統提示與畫面共用的一句話摘要 */
export function tripLine(p: TripProfile): string {
  return `${p.country}${p.city ? `・${p.city}` : ""}，${p.startDate} – ${p.endDate}，${travelersText(p.travelers)}`;
}
