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

export async function createSessionCookie(env: Env, user: SessionUser): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...user, exp: Date.now() + MAX_AGE * 1000 })));
  const token = `${payload}.${await sign(env, payload)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readSession(req: Request, env: Env): Promise<SessionUser | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, sig] = match[1].split(".");
  if (!payload || !sig || !safeEqual(sig, await sign(env, payload))) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(payload))) as SessionUser & { exp: number };
    if (!data.exp || data.exp < Date.now() || typeof data.room !== "string") return null;
    return { room: data.room, name: data.name, admin: !!data.admin, ver: Number(data.ver) || 0 };
  } catch {
    return null;
  }
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
