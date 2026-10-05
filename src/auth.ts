import type { Env, SessionUser } from "./types";

const COOKIE = "ta_session";
const MAX_AGE = 60 * 60 * 24 * 60; // 60 天：旅程前後都不用重新登入

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

function secret(env: Env): string {
  const s = (env.SESSION_SECRET ?? "").trim();
  if (s.length < 16) throw new Error("尚未設定 SESSION_SECRET（至少 16 字）");
  return s;
}

export async function sign(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---------------- 登入 cookie ----------------

/**
 * 一支手機可以同時登入好幾個空間（家庭旅遊、個人助理）：cookie 存每個空間的登入，cur＝最近用的那個。
 * 前端每個請求都會帶上自己是哪個空間（x-room 標頭或 room 參數），沒帶的（例如 <img>）才用 cur
 */
export interface SessionSet {
  cur: string;
  rooms: Record<string, { name: string; admin: boolean; ver: number }>;
}

const MAX_ROOMS = 8;

export async function sessionCookie(env: Env, set: SessionSet | null): Promise<string> {
  if (!set || !Object.keys(set.rooms).length) return clearSessionCookie();
  const payload = b64url(enc.encode(JSON.stringify({ ...set, exp: Date.now() + MAX_AGE * 1000 })));
  const token = `${payload}.${await sign(env, payload)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

/** 登入一個空間：加進這支手機已登入的清單（最多 8 個，太舊的擠掉），並設成目前的空間 */
export function createSessionCookie(env: Env, user: SessionUser, prev: SessionSet | null = null): Promise<string> {
  const rooms = { ...(prev?.rooms ?? {}) };
  delete rooms[user.room];
  rooms[user.room] = { name: user.name, admin: user.admin, ver: user.ver };
  const ids = Object.keys(rooms);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ROOMS))) delete rooms[id];
  return sessionCookie(env, { cur: user.room, rooms });
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readSessions(req: Request, env: Env): Promise<SessionSet | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, sig] = match[1].split(".");
  if (!payload || !sig || !safeEqual(sig, await sign(env, payload))) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    // 舊格式：一個 cookie 只記一個旅程
    if (typeof data.room === "string") {
      return { cur: data.room, rooms: { [data.room]: { name: String(data.name), admin: !!data.admin, ver: Number(data.ver) || 0 } } };
    }
    if (typeof data.cur !== "string" || !data.rooms || typeof data.rooms !== "object") return null;
    const rooms: SessionSet["rooms"] = {};
    for (const [id, u] of Object.entries(data.rooms as Record<string, any>)) {
      if (u && typeof u.name === "string") rooms[id] = { name: u.name, admin: !!u.admin, ver: Number(u.ver) || 0 };
    }
    return { cur: data.cur, rooms };
  } catch {
    return null;
  }
}

/** 這次請求用哪個空間的登入：有指定就用指定的（沒登入過那個空間＝null），沒指定用最近用的 */
export function pickSession(set: SessionSet | null, room?: string | null): SessionUser | null {
  if (!set) return null;
  const id = room || set.cur;
  const u = set.rooms[id];
  return u ? { room: id, ...u } : null;
}

export async function readSession(req: Request, env: Env, room?: string | null): Promise<SessionUser | null> {
  return pickSession(await readSessions(req, env), room);
}

// ---------------- 旅程密碼：只存雜湊 ----------------

// Workers 的 PBKDF2 最多 10 萬次
const PBKDF2_ITER = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iter, salt, hash] = stored.split("$");
  if (kind !== "pbkdf2" || !salt || !hash) return false;
  const bits = await pbkdf2(password, fromB64url(salt), Number(iter));
  return safeEqual(b64url(bits), hash);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.trim()), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

// ---------------- 朋友的 API 金鑰：加密保存，不回傳給手機 ----------------

async function aesKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret(env)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("trip-agent-keys"), info: enc.encode("api-keys-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptText(env: Env, text: string): Promise<string> {
  if (!text) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(text)));
  return `${b64url(iv)}.${b64url(data)}`;
}

export async function decryptText(env: Env, stored: string): Promise<string> {
  if (!stored) return "";
  const [iv, data] = stored.split(".");
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await aesKey(env), fromB64url(data)));
  } catch {
    return ""; // SESSION_SECRET 換過就解不開，當成沒填
  }
}

/** 顯示用：tvly-…abcd */
export function maskKey(key: string): string {
  if (!key) return "";
  return key.length <= 10 ? "••••" : `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/** 旅程代碼：10 碼、不含易混淆字元 */
export function newRoomId(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
