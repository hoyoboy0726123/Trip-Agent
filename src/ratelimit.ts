// Gemini 免費層有 RPM / TPM / RPD 限制（以整個 Google 專案計算）。
// 在送出前先自我節流，超過就冷卻並改用下一個模型，而不是一直打到被拒絕。

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

export interface Limits {
  rpm: number;
  tpm: number;
  rpd: number;
}

export interface DayStore {
  load(): { day: string; count: number };
  save(v: { day: string; count: number }): void;
}

const WINDOW = 60_000;
const SAFETY = 0.9; // 只用到上限的 90%，留緩衝給估算誤差

/** Google 的每日額度以美西午夜重置 */
function pacificDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

export function limitsFrom(env: { GEMINI_RPM?: string; GEMINI_TPM?: string; GEMINI_RPD?: string }): Limits {
  return { rpm: Number(env.GEMINI_RPM) || 15, tpm: Number(env.GEMINI_TPM) || 250_000, rpd: Number(env.GEMINI_RPD) || 500 };
}

export class GeminiLimiter {
  private events: { ts: number; tokens: number }[] = [];
  private cooldownUntil = 0;

  constructor(private limits: Limits, private store: DayStore) {}

  private prune(now: number) {
    this.events = this.events.filter((e) => now - e.ts < WINDOW);
  }

  private dayCount(now: number): number {
    const d = this.store.load();
    return d.day === pacificDay(now) ? d.count : 0;
  }

  usage(now = Date.now()) {
    this.prune(now);
    return {
      rpm: this.events.length,
      rpmLimit: this.limits.rpm,
      tpm: this.events.reduce((s, e) => s + e.tokens, 0),
      tpmLimit: this.limits.tpm,
      rpd: this.dayCount(now),
      rpdLimit: this.limits.rpd,
      cooldownSec: Math.max(0, Math.ceil((this.cooldownUntil - now) / 1000)),
    };
  }

  /**
   * 試著取得一次送出許可：0 = 已取得（已記一次用量）；> 0 = 要再等幾毫秒；null = 這次不要用 Gemini。
   * share < 1 給背景工作用，只吃部分額度。
   */
  tryAcquire(estimate: number, share: number): number | null {
    const now = Date.now();
    this.prune(now);
    if (now < this.cooldownUntil) return null;
    const rpm = Math.max(1, Math.floor(this.limits.rpm * SAFETY * share));
    const tpm = this.limits.tpm * SAFETY * share;
    if (this.dayCount(now) >= Math.floor(this.limits.rpd * 0.95 * share)) return null;
    if (estimate > tpm) return null;

    let wait = 0;
    const ev = this.events;
    const excess = ev.length + 1 - rpm;
    if (excess > 0) wait = Math.max(wait, ev[excess - 1].ts + WINDOW - now);
    let total = ev.reduce((s, e) => s + e.tokens, 0) + estimate;
    for (let i = 0; total > tpm && i < ev.length; i++) {
      total -= ev[i].tokens;
      wait = Math.max(wait, ev[i].ts + WINDOW - now);
    }
    if (wait > 0) return wait;
    this.events.push({ ts: now, tokens: estimate });
    this.store.save({ day: pacificDay(now), count: this.dayCount(now) + 1 });
    return 0;
  }

  /** 被 Google 拒絕時進入冷卻：429 依 retryDelay，503 / 500 冷卻一分鐘 */
  penalize(status: number, body: string) {
    let ms = 0;
    if (status === 429) {
      ms = 60_000;
      const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
      if (m) ms = Math.max(5_000, Math.ceil(Number(m[1]) * 1000));
      // 每日額度用完（RPD）：冷卻到美西午夜太複雜，先冷卻一小時
      if (/per.?day|PerDay/i.test(body)) ms = Math.max(ms, 3600_000);
    } else if (status === 503 || status === 500) {
      ms = 60_000;
    }
    if (ms) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
  }
}

/** 反覆嘗試取得許可，等太久就放棄（交給下一個模型） */
export async function acquireWith(
  tryOnce: () => Promise<number | null> | number | null,
  maxWait: number,
  onWait?: (ms: number) => void,
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const wait = await tryOnce();
    if (wait === 0) return;
    if (wait === null) throw new RateLimitedError("Gemini 冷卻中或已接近免費額度上限");
    if (wait > maxWait) throw new RateLimitedError(`Gemini 每分鐘額度已滿，需等 ${Math.ceil(wait / 1000)} 秒`);
    onWait?.(wait);
    await new Promise((r) => setTimeout(r, wait + 200));
  }
  throw new RateLimitedError("Gemini 忙碌中");
}
