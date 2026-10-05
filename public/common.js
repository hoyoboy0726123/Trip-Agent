// 旅伴 AI 共用：狀態、HTML 跳脫、Markdown、當地時間、金額格式、API
const $ = (s, root = document) => root.querySelector(s);

// 網址 /t/<旅程代碼>
const ROOM = (location.pathname.match(/^\/t\/([a-z0-9]{6,20})\/?$/) || [])[1] || null;

const S = {
  room: ROOM, me: null, aiName: "旅伴 AI", settings: {}, state: null, trip: null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  status: null, ws: null, retry: 0, oldest: null, pending: { photo: null, photoUrl: null, location: null },
  live: new Map(), panel: null, lastDay: null, offline: false,
};

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// 模型偶爾會寫 $\rightarrow$ 這類 LaTeX；聊天室不載數學排版，換成對應符號就好
const LATEX = { rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", times: "×", div: "÷", approx: "≈", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", cdot: "·", sim: "～" };
function unLatex(text) {
  return String(text ?? "")
    .replace(/\$\s*\\([a-zA-Z]+)\s*\$/g, (m, k) => LATEX[k] ?? m)
    .replace(/\\(rightarrow|leftarrow|Rightarrow|times|approx|cdot)\b/g, (_, k) => LATEX[k]);
}

function md(text) {
  text = unLatex(text);
  if (window.marked && window.DOMPurify) {
    const html = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
    return html.replace(/<a /g, '<a target="_blank" rel="noopener" ');
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

// ---------- 當地時間（依旅程時區） ----------

const fmtCache = new Map();
function zoned(ts, tz = S.tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    }
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] ?? 0;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, m: Number(p.month), d: Number(p.day), wd };
}
const WEEK = "日一二三四五六";
const timeText = (ts) => zoned(ts).time;
const dayText = (ts) => { const z = zoned(ts); return `${z.m}/${z.d}（${WEEK[z.wd]}）`; };
const todayLocal = () => zoned(Date.now()).date;
const dateLabel = (date) => { const d = new Date(date + "T00:00:00Z"); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`; };

// ---------- 金額 ----------

function money(n, symbol = S.trip?.currencySymbol ?? "") {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 1000 || Number.isInteger(v) ? 0 : 2 });
  return `${v < 0 ? "-" : ""}${symbol}${s}`;
}

// ---------- API ----------

// 一支手機可以同時登入好幾個空間（家庭旅遊、個人助理）：每個 API 請求都帶上這一頁是哪個空間，
// 伺服器才知道要用哪一個登入。沒辦法帶標頭的（<img>、日記網頁連結）由伺服器用最近打開的空間
if (ROOM) {
  const rawFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    if (typeof input === "string" && input.startsWith("/api/")) {
      const headers = new Headers(init.headers || {});
      if (!headers.has("x-room")) headers.set("x-room", ROOM);
      init = { ...init, headers };
    }
    return rawFetch(input, init);
  };
}

const isPersonal = () => S.trip?.kind === "personal";

async function api(path, body, opts = {}) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `伺服器回應 ${res.status}` }));
  if (!res.ok && data.ok !== false) data.ok = false;
  data.status = res.status;
  return data;
}

// ---------- 本機記住的東西（離線用、最近的旅程） ----------

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

function rememberTrip(t) {
  const list = (store("ta-trips") || []).filter((x) => x.id !== t.id);
  list.unshift(t);
  store("ta-trips", list.slice(0, 8));
}

function forgetTrip(id) {
  store("ta-trips", (store("ta-trips") || []).filter((x) => x.id !== id));
}

function flagOf(cc) {
  const s = String(cc || "").toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? String.fromCodePoint(...[...s].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "🌏";
}
