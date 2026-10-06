/**
 * 健康管家的資料：健康檔案、血壓血糖體重、用藥（含慢箋）、預防保健紀錄、722 量測任務、警示。
 * 跟一般聊天記憶分開放；所有判斷都交給 health.ts 的規則。
 */
import {
  bmiInfo, bp722, bpClass, bpFlags, bpSummary, daysBetween, glucoseClass, glucoseFlags, next722Days, screeningPlan, screeningStatus, shiftDate, waistInfo,
  ageOn, GLU_CONTEXT, type Flag, type HealthProfile, type Vital, type VitalKind,
} from "./health";
import { localToUtc, zoned } from "./profile";

export interface HealthReminder {
  key: string;
  text: string;
  push?: { title: string; body: string };
}

const CONDITIONS = ["高血壓", "糖尿病", "高血脂", "慢性腎病", "心臟病", "中風", "痛風", "氣喘", "甲狀腺疾病"];
const RANGES: Record<VitalKind, [number, number][]> = {
  bp: [[60, 260], [30, 160], [30, 220]],
  glucose: [[20, 600]],
  weight: [[20, 300], [40, 200]],
};

export class HealthStore {
  constructor(private sql: SqlStorage, private tz: () => string) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS health_kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS vitals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, v1 REAL, v2 REAL, v3 REAL, context TEXT, source TEXT);
      CREATE INDEX IF NOT EXISTS vitals_ts ON vitals(ts);
      CREATE TABLE IF NOT EXISTS meds (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, name TEXT, dose TEXT, freq TEXT, purpose TEXT, status TEXT DEFAULT 'active', refill_next TEXT, refill_left INTEGER, note TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS screenings (code TEXT PRIMARY KEY, last TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS health_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, start TEXT, status TEXT, result TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS health_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, text TEXT, seen INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS health_sent (key TEXT PRIMARY KEY, ts INTEGER);
    `);
  }

  private get(key: string): string {
    return String(this.sql.exec("SELECT value FROM health_kv WHERE key = ?", key).toArray()[0]?.value ?? "");
  }

  private put(key: string, value: string) {
    this.sql.exec("INSERT INTO health_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private today(): string {
    return zoned(Date.now(), this.tz()).date;
  }

  /** 有沒有任何健康資料（沒有就不用跑提醒） */
  hasData(): boolean {
    return !!this.get("profile") || this.sql.exec("SELECT 1 FROM vitals LIMIT 1").toArray().length > 0 || this.sql.exec("SELECT 1 FROM meds LIMIT 1").toArray().length > 0;
  }

  profile(): HealthProfile {
    try {
      return JSON.parse(this.get("profile") || "{}");
    } catch {
      return {};
    }
  }

  /** 只收認得的欄位，數字檢查範圍 */
  saveProfile(patch: Record<string, unknown>): HealthProfile {
    const p = this.profile();
    const num = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined);
    if (patch.sex === "M" || patch.sex === "F") p.sex = patch.sex;
    if (typeof patch.birth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.birth) && patch.birth > "1900-01-01" && patch.birth <= this.today()) p.birth = patch.birth;
    if (patch.height != null) p.height = num(patch.height, 50, 250) ?? p.height;
    if (Array.isArray(patch.conditions)) p.conditions = [...new Set(patch.conditions.map((c) => String(c).trim().slice(0, 20)).filter(Boolean))].slice(0, 15);
    if (typeof patch.allergies === "string") p.allergies = patch.allergies.trim().slice(0, 200);
    for (const k of ["familyCrc", "familyLung", "betel", "pregnant"] as const) if (typeof patch[k] === "boolean") p[k] = patch[k] as boolean;
    if (patch.smoking === "never" || patch.smoking === "former" || patch.smoking === "current") p.smoking = patch.smoking;
    if (patch.packYears != null) p.packYears = num(patch.packYears, 0, 200);
    if (patch.quitYear != null) p.quitYear = num(patch.quitYear, 1940, 2100);
    for (const k of ["amTime", "pmTime"] as const) if (typeof patch[k] === "string" && /^\d{2}:\d{2}$/.test(patch[k] as string)) p[k] = patch[k] as string;
    this.put("profile", JSON.stringify(p));
    return p;
  }

  private diabetic(): boolean {
    return (this.profile().conditions ?? []).includes("糖尿病");
  }

  private hypertensive(): boolean {
    const p = this.profile();
    return (p.conditions ?? []).includes("高血壓") || this.meds().some((m) => /血壓|高血壓/.test(String(m.purpose ?? "")));
  }

  private row(r: Record<string, SqlStorageValue>): Vital {
    const z = zoned(Number(r.ts), this.tz());
    return { id: Number(r.id), ts: Number(r.ts), date: z.date, time: z.time, kind: r.kind as VitalKind, v1: Number(r.v1), v2: r.v2 == null ? null : Number(r.v2), v3: r.v3 == null ? null : Number(r.v3), context: String(r.context ?? "") };
  }

  vitals(days = 120): Vital[] {
    return this.sql.exec("SELECT * FROM vitals WHERE ts > ? ORDER BY ts", Date.now() - days * 86400_000).toArray().map((r) => this.row(r));
  }

  /** 記一筆量測：檢查範圍、判讀、固定警示（警示存起來給總覽顯示） */
  addVital(input: { kind?: unknown; v1?: unknown; v2?: unknown; v3?: unknown; context?: unknown; date?: unknown; time?: unknown }, source: string):
    { error: string } | { vital: Vital; grade: string; flags: Flag[] } {
    const kind = input.kind as VitalKind;
    if (!RANGES[kind]) return { error: "量測種類不正確" };
    const vals = [input.v1, input.v2, input.v3].map((v) => (v == null || v === "" ? null : Number(v)));
    const need = kind === "bp" ? 2 : 1;
    for (let i = 0; i < RANGES[kind].length; i++) {
      const v = vals[i];
      if (v == null) {
        if (i < need) return { error: "數值不完整" };
        continue;
      }
      const [lo, hi] = RANGES[kind][i];
      if (!Number.isFinite(v) || v < lo || v > hi) return { error: `數值看起來不對（${v}）` };
    }
    let ts = Date.now();
    if (typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      const t = typeof input.time === "string" && /^\d{2}:\d{2}$/.test(input.time) ? input.time : "12:00";
      const at = localToUtc(input.date, t, this.tz());
      if (at && at <= Date.now() + 5 * 60_000 && at > Date.now() - 400 * 86400_000) ts = at;
    }
    const hour = zoned(ts, this.tz()).hour;
    let context = String(input.context ?? "");
    if (kind === "bp" && !["morning", "evening", "other"].includes(context)) context = hour < 11 ? "morning" : hour >= 18 ? "evening" : "other";
    if (kind === "glucose" && !GLU_CONTEXT[context]) context = "random";
    if (kind === "weight") context = "";
    const id = this.sql
      .exec("INSERT INTO vitals (ts, kind, v1, v2, v3, context, source) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", ts, kind, vals[0], vals[1], vals[2], context, source)
      .one().id as number;
    const vital = this.row(this.sql.exec("SELECT * FROM vitals WHERE id = ?", id).one());
    let grade = "";
    let flags: Flag[] = [];
    if (kind === "bp") {
      grade = `${bpClass(vital.v1, vital.v2!).label}（單次量測只當參考，以 722 平均為準）`;
      flags = bpFlags(vital.v1, vital.v2!);
    } else if (kind === "glucose") {
      grade = glucoseClass(vital.v1, context, this.diabetic()).label;
      const prevHigh = this.sql.exec("SELECT 1 FROM vitals WHERE kind = 'glucose' AND v1 >= 300 AND id != ? AND ts > ?", id, ts - 24 * 3600_000).toArray().length > 0;
      flags = glucoseFlags(vital.v1, prevHigh);
    } else {
      const p = this.profile();
      grade = [p.height ? `BMI ${bmiInfo(p.height, vital.v1).value}（${bmiInfo(p.height, vital.v1).label}）` : "填身高後可以算 BMI", vital.v2 ? `腰圍 ${waistInfo(p.sex, vital.v2).label}` : ""].filter(Boolean).join("、");
    }
    for (const f of flags) this.sql.exec("INSERT INTO health_alerts (ts, level, text) VALUES (?, ?, ?)", Date.now(), f.level, f.text);
    return { vital, grade, flags };
  }

  deleteVital(id: number) {
    this.sql.exec("DELETE FROM vitals WHERE id = ?", id);
  }

  meds() {
    return this.sql.exec("SELECT * FROM meds WHERE status = 'active' ORDER BY id").toArray();
  }

  medSave(input: Record<string, unknown>): { error: string } | { id: number } {
    const name = String(input.name ?? "").trim().slice(0, 60);
    if (!name) return { error: "請填藥名" };
    const s = (k: string, n: number) => (input[k] == null ? null : String(input[k]).trim().slice(0, n) || null);
    const refillNext = typeof input.refill_next === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.refill_next) ? input.refill_next : null;
    const refillLeft = Number.isInteger(Number(input.refill_left)) && Number(input.refill_left) >= 0 && Number(input.refill_left) <= 12 && input.refill_left !== "" && input.refill_left != null ? Number(input.refill_left) : null;
    const id = Number(input.id);
    if (id) {
      this.sql.exec(
        "UPDATE meds SET name = ?, dose = ?, freq = ?, purpose = ?, refill_next = ?, refill_left = ?, note = ?, updated = ? WHERE id = ?",
        name, s("dose", 40), s("freq", 60), s("purpose", 60), refillNext, refillLeft, s("note", 200), Date.now(), id,
      );
      return { id };
    }
    return {
      id: this.sql
        .exec(
          "INSERT INTO meds (ts, name, dose, freq, purpose, refill_next, refill_left, note, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          Date.now(), name, s("dose", 40), s("freq", 60), s("purpose", 60), refillNext, refillLeft, s("note", 200), Date.now(),
        )
        .one().id as number,
    };
  }

  medStop(id: number) {
    this.sql.exec("UPDATE meds SET status = 'stopped', updated = ? WHERE id = ?", Date.now(), id);
  }

  medDelete(id: number) {
    this.sql.exec("DELETE FROM meds WHERE id = ?", id);
  }

  /** 找藥名（聊天說「停了 xxx」用） */
  medFind(name: string) {
    const n = name.trim().toLowerCase();
    return this.meds().find((m) => String(m.name).toLowerCase().includes(n) || n.includes(String(m.name).toLowerCase()));
  }

  markScreening(code: string, last: string | null) {
    if (last && !/^\d{4}-\d{2}-\d{2}$/.test(last)) return;
    if (!last) this.sql.exec("DELETE FROM screenings WHERE code = ?", code);
    else this.sql.exec("INSERT INTO screenings (code, last, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET last = excluded.last, updated = excluded.updated", code, last, Date.now());
  }

  private activeTask() {
    return this.sql.exec("SELECT * FROM health_tasks WHERE kind = '722' AND status = 'active' ORDER BY id DESC LIMIT 1").toArray()[0];
  }

  startTask(start?: string): { error: string } | { start: string } {
    if (this.activeTask()) return { error: "已經有一輪 722 量測在進行中" };
    const s = start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : this.today();
    this.sql.exec("INSERT INTO health_tasks (kind, start, status, ts) VALUES ('722', ?, 'active', ?)", s, Date.now());
    return { start: s };
  }

  cancelTask() {
    this.sql.exec("UPDATE health_tasks SET status = 'cancelled' WHERE kind = '722' AND status = 'active'");
  }

  /** 進行中的 722 過了第 7 天：算結果、結束任務，回傳結果 */
  private finishTask(today: string) {
    const t = this.activeTask();
    if (!t || today <= shiftDate(String(t.start), 6)) return null;
    const r = bp722(this.vitals(30), String(t.start));
    this.sql.exec("UPDATE health_tasks SET status = 'done', result = ? WHERE id = ?", JSON.stringify(r), t.id);
    return r;
  }

  private last722() {
    const t = this.sql.exec("SELECT * FROM health_tasks WHERE kind = '722' AND status = 'done' ORDER BY id DESC LIMIT 1").toArray()[0];
    if (!t) return null;
    const r = JSON.parse(String(t.result || "null")) as ReturnType<typeof bp722> | null;
    if (!r) return null;
    const next = shiftDate(r.end, next722Days(r.grade?.code ?? null, this.hypertensive(), r.meetsTarget));
    return { ...r, next };
  }

  /** 健康管家頁、AI 工具共用的整理（數字全部是程式算的） */
  summary() {
    const today = this.today();
    const p = this.profile();
    const vitals = this.vitals(120);
    const last = (k: VitalKind) => [...vitals].reverse().find((v) => v.kind === k) ?? null;
    const bp = last("bp"), glu = last("glucose"), wt = last("weight");
    const task = this.activeTask();
    const plan = screeningPlan(p, today);
    const done = new Map(this.sql.exec("SELECT code, last FROM screenings").toArray().map((r) => [String(r.code), String(r.last)]));
    const meds = this.meds().map((m) => ({ ...m, refill_in: m.refill_next ? daysBetween(today, String(m.refill_next)) : null }));
    return {
      today,
      profile: p,
      conditionChoices: CONDITIONS,
      age: p.birth ? ageOn(p.birth, today) : null,
      bmi: p.height && wt ? bmiInfo(p.height, wt.v1) : null,
      waist: wt?.v2 ? waistInfo(p.sex, wt.v2) : null,
      latest: {
        bp: bp ? { ...bp, grade: bpClass(bp.v1, bp.v2!).label } : null,
        glucose: glu ? { ...glu, grade: glucoseClass(glu.v1, glu.context, this.diabetic()).label, contextLabel: GLU_CONTEXT[glu.context] } : null,
        weight: wt,
      },
      bp7: bpSummary(vitals, shiftDate(today, -6), today),
      bp30: bpSummary(vitals, shiftDate(today, -29), today),
      task: task ? { start: String(task.start), day: daysBetween(String(task.start), today) + 1, partial: bp722(vitals, String(task.start)) } : null,
      last722: this.last722(),
      meds,
      screenings: plan.map((it) => ({ ...it, last: done.get(it.code) ?? null, ...screeningStatus(it, done.get(it.code) ?? null, today) })),
      alerts: this.sql.exec("SELECT id, ts, level, text FROM health_alerts WHERE seen = 0 AND ts > ? ORDER BY id DESC LIMIT 5", Date.now() - 7 * 86400_000).toArray(),
      vitals,
      diabetic: this.diabetic(),
      hypertensive: this.hypertensive(),
    };
  }

  seeAlert(id: number) {
    this.sql.exec("UPDATE health_alerts SET seen = 1 WHERE id = ?", id);
  }

  private sent(key: string): boolean {
    if (this.sql.exec("SELECT 1 FROM health_sent WHERE key = ?", key).toArray().length) return true;
    this.sql.exec("INSERT INTO health_sent (key, ts) VALUES (?, ?)", key, Date.now());
    return false;
  }

  /** 排程（每次 alarm 都會呼叫）：722 早晚量測、722 結果、慢箋領藥、該量血壓了、健檢到期。每則提醒只發一次 */
  tick(now = Date.now()): HealthReminder[] {
    if (!this.hasData()) return [];
    const z = zoned(now, this.tz());
    const today = z.date;
    const hm = z.time;
    const p = this.profile();
    const out: HealthReminder[] = [];
    const daytime = z.hour >= 8 && z.hour < 21;
    const inWindow = (at: string) => {
      const [h, m] = at.split(":").map(Number);
      const mins = z.hour * 60 + z.mi - (h * 60 + m);
      return mins >= 0 && mins < 120;
    };
    // 722 量測
    const done = this.finishTask(today);
    if (done) {
      const fmt = (x: [number, number] | null) => (x ? `${x[0]}/${x[1]}` : "沒有資料");
      const next = shiftDate(done.end, next722Days(done.grade?.code ?? null, this.hypertensive(), done.meetsTarget));
      out.push({
        key: `722done-${done.start}`,
        text: done.valid
          ? `🩺 **722 居家血壓結果**（${done.start.slice(5)}–${done.end.slice(5)}，有效 ${done.validDays} 天）\n- 早上平均：${fmt(done.morning)}\n- 晚上平均：${fmt(done.evening)}\n- 整體平均：${fmt(done.overall)}，${done.grade?.label}；目標 <130/80${done.meetsTarget ? "，已達標" : "，還沒達標"}\n\n下一輪建議在 ${next} 左右做。${done.meetsTarget ? "" : "可以把這個結果帶去看診，請醫師評估。"}\n（依台灣高血壓指引 2022 的 722 量法計算；本功能為健康紀錄整理，不提供診斷）`
          : `🩺 這輪 722 只有 ${done.validDays} 天有量（要排除第 1 天後至少 4 天），結果不夠準。可以在健康管家重新開始一輪。`,
        push: { title: "🩺 722 血壓結果出來了", body: done.valid ? `整體平均 ${fmt(done.overall)}` : "這輪資料不夠，可以再量一輪" },
      });
    }
    const task = this.activeTask();
    if (task) {
      const day = daysBetween(String(task.start), today) + 1;
      const measured = (ctx: string) => this.vitals(2).some((v) => v.kind === "bp" && v.date === today && v.context === ctx);
      const am = p.amTime || "07:30", pm = p.pmTime || "21:30";
      if (inWindow(am) && !measured("morning") && !this.sent(`722am-${today}`)) {
        out.push({ key: `722am-${today}`, text: `🩺 722 第 ${day} 天｜早上量血壓：起床 1 小時內、上完廁所、吃早餐和吃藥前，坐著休息 5 分鐘再量，量 2 次間隔 1 分鐘。`, push: { title: `🩺 722 第 ${day} 天：早上量血壓`, body: "起床 1 小時內、早餐和吃藥前，量 2 次" } });
      }
      if (inWindow(pm) && !measured("evening") && !this.sent(`722pm-${today}`)) {
        out.push({ key: `722pm-${today}`, text: `🩺 722 第 ${day} 天｜睡前量血壓：睡前 1 小時內，坐著休息 5 分鐘再量，量 2 次間隔 1 分鐘。`, push: { title: `🩺 722 第 ${day} 天：睡前量血壓`, body: "睡前 1 小時內，量 2 次" } });
      }
    } else if (daytime) {
      // 該做下一輪 722 了（一週最多提醒一次）
      const last = this.last722();
      const due = last ? last.next : this.hypertensive() ? today : null;
      if (due && due <= today && !this.sent(`722due-${today.slice(0, 4)}-w${Math.floor(daysBetween(`${today.slice(0, 4)}-01-01`, today) / 7)}`)) {
        out.push({ key: "722due", text: `🩺 該做一輪 722 居家血壓了：連續 7 天、早上和睡前各量 2 次。到「工具箱 → 健康管家」按「開始 722」，我會每天早晚提醒你。`, push: { title: "🩺 該量一輪血壓了", body: "連續 7 天早晚各量 2 次" } });
      }
    }
    if (daytime) {
      // 慢箋領藥：前 3 天、當天各提醒一次
      for (const m of this.meds()) {
        if (!m.refill_next) continue;
        const d = daysBetween(today, String(m.refill_next));
        if ((d === 3 || d === 0) && !this.sent(`refill-${m.id}-${m.refill_next}-${d}`)) {
          out.push({
            key: `refill-${m.id}`,
            text: `💊 **${d === 0 ? "今天" : "3 天後"}可以領藥**：${m.name}（慢箋${m.refill_left != null ? `，還剩 ${m.refill_left} 次` : ""}）。記得帶健保卡和處方箋；領完到健康管家更新下次領藥日。`,
            push: { title: `💊 ${d === 0 ? "今天" : "3 天後"}可以領藥`, body: String(m.name) },
          });
        }
      }
      // 健檢、篩檢、疫苗：每月整理一次到期的項目
      const plan = screeningPlan(p, today);
      const lastDone = new Map(this.sql.exec("SELECT code, last FROM screenings").toArray().map((r) => [String(r.code), String(r.last)]));
      const due = plan.filter((it) => screeningStatus(it, lastDone.get(it.code) ?? null, today).status === "due");
      if (due.length && !this.sent(`screen-${today.slice(0, 7)}`)) {
        out.push({
          key: "screen",
          text: `📋 **這個月該安排的健檢與疫苗**\n${due.map((it) => `- ${it.name}：上次 ${lastDone.get(it.code)}｜${it.rule}`).join("\n")}\n\n做完到「健康管家 → 預防保健」填上日期，就會自動算下一次。`,
          push: { title: "📋 有健檢或疫苗該安排了", body: due.map((it) => it.name).join("、") },
        });
      }
    }
    return out;
  }

  exportData() {
    return {
      profile: this.profile(),
      vitals: this.sql.exec("SELECT ts, kind, v1, v2, v3, context FROM vitals ORDER BY ts").toArray(),
      meds: this.sql.exec("SELECT name, dose, freq, purpose, status, refill_next, refill_left, note FROM meds ORDER BY id").toArray(),
      screenings: this.sql.exec("SELECT code, last FROM screenings").toArray(),
      bp722: this.sql.exec("SELECT start, status, result FROM health_tasks ORDER BY id").toArray(),
    };
  }

  clear() {
    for (const t of ["health_kv", "vitals", "meds", "screenings", "health_tasks", "health_alerts", "health_sent"]) this.sql.exec(`DELETE FROM ${t}`);
  }
}
