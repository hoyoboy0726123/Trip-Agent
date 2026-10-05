import { DurableObject } from "cloudflare:workers";
import { safeEqual } from "./auth";
import { GeminiLimiter, limitsFrom } from "./ratelimit";
import { generateVapidKeys, type VapidKeys } from "./push";
import type { Env } from "./types";

// 全站只有一個 Registry：邀請碼檢查、旅程清單（擁有者後台用）、所有旅程共用的額度狀態

export interface RoomMeta {
  id: string;
  /** trip＝家庭旅遊，personal＝個人助理；舊資料沒有這欄＝trip */
  kind?: "trip" | "personal";
  title: string;
  country: string;
  flag: string;
  city: string;
  startDate: string;
  endDate: string;
  creator: string;
  status: string;
  created: number;
  lastActive: number;
}

export class Registry extends DurableObject<Env> {
  private sql: SqlStorage;
  private ownerLimiter: GeminiLimiter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created INTEGER, title TEXT, country TEXT, flag TEXT, city TEXT, start_date TEXT, end_date TEXT, creator TEXT, status TEXT, last_active INTEGER);
      CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER, ts INTEGER);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    `);
    if (!this.sql.exec("PRAGMA table_info(rooms)").toArray().some((c) => c.name === "kind")) this.sql.exec("ALTER TABLE rooms ADD COLUMN kind TEXT");
    this.ownerLimiter = new GeminiLimiter(limitsFrom(env), {
      load: () => JSON.parse(this.get("owner_gemini_day") || '{"day":"","count":0}'),
      save: (v) => this.set("owner_gemini_day", JSON.stringify(v)),
    });
  }

  private get(key: string): string {
    return (this.sql.exec("SELECT value FROM kv WHERE key = ?", key).toArray()[0]?.value as string) ?? "";
  }

  private set(key: string, value: string) {
    this.sql.exec("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ---------------- 手機推播 ----------------

  /** 推播用的 VAPID 金鑰：第一次用到時產生並保存，所有空間共用一組 */
  async vapidKeys(): Promise<VapidKeys> {
    const saved = this.get("vapid");
    if (saved) return JSON.parse(saved);
    const keys = await generateVapidKeys();
    // 產生金鑰時有 await，另一個請求可能已經先存了：以先存的為準
    const again = this.get("vapid");
    if (again) return JSON.parse(again);
    this.set("vapid", JSON.stringify(keys));
    return keys;
  }

  // ---------------- 邀請碼 ----------------

  /** 猜錯太多次就暫時鎖住這個 IP（15 分鐘 10 次）；kind＝要建立的是旅程還是個人助理（兩種邀請碼不同） */
  checkInvite(ip: string, code: string, kind: "trip" | "personal" | "any" = "trip"): { ok: boolean; error?: string } {
    const row = this.sql.exec("SELECT count, ts FROM attempts WHERE ip = ?", ip).toArray()[0];
    const recent = row && Date.now() - (row.ts as number) < 15 * 60_000 ? (row.count as number) : 0;
    if (recent >= 10) return { ok: false, error: "嘗試太多次，請 15 分鐘後再試" };
    const invite = (this.env.INVITE_CODE ?? "").trim();
    const personal = (this.env.PERSONAL_INVITE_CODE ?? "").trim() || invite;
    const accepted = kind === "trip" ? [invite] : kind === "personal" ? [personal] : [invite, personal];
    if (accepted.some((c) => c && safeEqual(String(code ?? "").trim(), c))) return { ok: true };
    this.sql.exec("INSERT INTO attempts VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = ?, ts = ?", ip, recent + 1, Date.now(), recent + 1, Date.now());
    return { ok: false, error: invite ? "邀請碼不正確" : "網站尚未設定邀請碼" };
  }

  /** 同一個 IP 一天最多建立 5 個旅程，邀請碼外流時也不會被灌爆 */
  allowCreate(ip: string): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const key = `create:${ip}`;
    const v = JSON.parse(this.get(key) || "{}");
    const count = v.day === day ? Number(v.count) || 0 : 0;
    if (count >= 5) return false;
    this.set(key, JSON.stringify({ day, count: count + 1 }));
    return true;
  }

  // ---------------- 旅程清單 ----------------

  registerRoom(m: RoomMeta) {
    this.sql.exec(
      "INSERT INTO rooms (id, created, title, country, flag, city, start_date, end_date, creator, status, last_active, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.id, m.created, m.title, m.country, m.flag, m.city, m.startDate, m.endDate, m.creator, m.status, m.lastActive, m.kind ?? "trip",
    );
  }

  updateRoom(id: string, p: Partial<Pick<RoomMeta, "title" | "country" | "flag" | "city" | "startDate" | "endDate" | "status">>) {
    const cols: Record<string, string> = { title: "title", country: "country", flag: "flag", city: "city", startDate: "start_date", endDate: "end_date", status: "status" };
    for (const [k, v] of Object.entries(p)) {
      if (cols[k] && typeof v === "string") this.sql.exec(`UPDATE rooms SET ${cols[k]} = ? WHERE id = ?`, v, id);
    }
  }

  touchRoom(id: string) {
    this.sql.exec("UPDATE rooms SET last_active = ? WHERE id = ? AND last_active < ?", Date.now(), id, Date.now() - 10 * 60_000);
  }

  listRooms(): RoomMeta[] {
    return this.sql.exec("SELECT * FROM rooms ORDER BY created DESC").toArray().map((r) => ({
      id: r.id as string, title: r.title as string, country: r.country as string, flag: r.flag as string, city: r.city as string,
      startDate: r.start_date as string, endDate: r.end_date as string, creator: r.creator as string, status: r.status as string,
      created: r.created as number, lastActive: r.last_active as number, kind: r.kind === "personal" ? "personal" : "trip",
    }));
  }

  removeRoom(id: string) {
    this.sql.exec("DELETE FROM rooms WHERE id = ?", id);
  }

  // ---------------- 擁有者的 Gemini 額度（所有旅程共用） ----------------

  ownerGeminiTry(estimate: number, share: number): number | null {
    return this.ownerLimiter.tryAcquire(estimate, share);
  }

  ownerGeminiFailed(status: number, body: string) {
    this.ownerLimiter.penalize(status, body);
  }

  ownerGeminiUsage() {
    return this.ownerLimiter.usage();
  }

  // ---------------- Workers AI 每日額度（整個帳號共用） ----------------

  workersAiBlockedUntil(): number {
    return Number(this.get("workers_ai_blocked_until")) || 0;
  }

  /** 額度用完：封鎖到下一個 UTC 午夜（Cloudflare 重置時間） */
  blockWorkersAi() {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    this.set("workers_ai_blocked_until", String(next.getTime()));
  }
}
