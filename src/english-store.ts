/**
 * 英語家教的資料：對話練習、複習卡、今日一課、每天有沒有練（連續天數）、朗讀音檔快取。
 * 跟聊天紀錄、長期記憶分開放。
 */
import { levelOf, nextReview, SRS_STEPS, type EnLevel, type Grade, type Turn } from "./english";
import { shiftDate } from "./health";
import { zoned } from "./profile";

const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** 每天推播的時間（晚上 8 點） */
export const EN_REMIND_HOUR = 20;
/** 補簽卡最多存幾張（Speak 的做法：最多 2 張，自動抵用） */
const MAX_FREEZES = 2;
/** 朗讀音檔最多留幾句（一句約 100–250KB） */
const MAX_AUDIO = 300;

export interface EnCard {
  id: number;
  en: string;
  zh: string;
  note: string;
  source: string;
  step: number;
  due: string;
  reps: number;
}

export class EnglishStore {
  constructor(private sql: SqlStorage, private tz: () => string) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS en_kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS en_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, scenario TEXT, level TEXT, status TEXT DEFAULT 'active', goals_done TEXT DEFAULT '[]', report TEXT);
      CREATE TABLE IF NOT EXISTS en_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, ts INTEGER, role TEXT, text TEXT, feedback TEXT);
      CREATE INDEX IF NOT EXISTS en_turns_s ON en_turns(session_id);
      CREATE TABLE IF NOT EXISTS en_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, en TEXT UNIQUE, zh TEXT, note TEXT, source TEXT, step INTEGER DEFAULT 0, due TEXT, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS en_lessons (date TEXT PRIMARY KEY, ts INTEGER, topic TEXT, level TEXT, data TEXT, done INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS en_days (date TEXT PRIMARY KEY, practice INTEGER DEFAULT 0, frozen INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS en_audio (key TEXT PRIMARY KEY, ts INTEGER, data BLOB);
    `);
  }

  get(key: string, fallback = ""): string {
    return String(this.sql.exec("SELECT value FROM en_kv WHERE key = ?", key).toArray()[0]?.value ?? fallback);
  }

  put(key: string, value: string) {
    this.sql.exec("INSERT INTO en_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  today(): string {
    return zoned(Date.now(), this.tz()).date;
  }

  // ---------- 設定 ----------

  settings(): { level: EnLevel; remind: boolean; weekGoal: number } {
    return { level: levelOf(this.get("level")), remind: this.get("remind", "1") === "1", weekGoal: Number(this.get("week_goal", "5")) || 5 };
  }

  saveSettings(s: { level?: unknown; remind?: unknown; weekGoal?: unknown }) {
    if (s.level !== undefined) this.put("level", levelOf(s.level));
    if (typeof s.remind === "boolean") this.put("remind", s.remind ? "1" : "0");
    const g = Number(s.weekGoal);
    if (Number.isInteger(g) && g >= 1 && g <= 7) this.put("week_goal", String(g));
  }

  // ---------- 對話練習 ----------

  startSession(scenario: string, level: EnLevel, opener: string): number {
    const id = this.sql.exec("INSERT INTO en_sessions (ts, scenario, level) VALUES (?, ?, ?) RETURNING id", Date.now(), scenario, level).one().id as number;
    this.addTurn(id, "tutor", opener);
    return id;
  }

  addTurn(sessionId: number, role: Turn["role"], text: string, feedback?: unknown): number {
    return this.sql.exec("INSERT INTO en_turns (session_id, ts, role, text, feedback) VALUES (?, ?, ?, ?, ?) RETURNING id", sessionId, Date.now(), role, str(text, 1000), feedback ? JSON.stringify(feedback) : null).one().id as number;
  }

  session(id: number) {
    const s = this.sql.exec("SELECT * FROM en_sessions WHERE id = ?", id).toArray()[0];
    if (!s) return null;
    const turns = this.sql
      .exec("SELECT id, role, text, feedback FROM en_turns WHERE session_id = ? ORDER BY id", id)
      .toArray()
      .map((t) => ({ id: t.id as number, role: t.role as Turn["role"], text: String(t.text), feedback: t.feedback ? JSON.parse(String(t.feedback)) : null }));
    return {
      id, scenario: String(s.scenario), level: levelOf(s.level), status: String(s.status), ts: Number(s.ts),
      goals_done: JSON.parse(String(s.goals_done || "[]")) as number[],
      report: s.report ? JSON.parse(String(s.report)) : null,
      turns,
    };
  }

  setGoals(id: number, done: number[]) {
    this.sql.exec("UPDATE en_sessions SET goals_done = ? WHERE id = ?", JSON.stringify([...new Set(done)].sort()), id);
  }

  finish(id: number, report: unknown) {
    this.sql.exec("UPDATE en_sessions SET status = 'done', report = ? WHERE id = ?", JSON.stringify(report), id);
  }

  recentSessions(limit = 8) {
    return this.sql
      .exec("SELECT id, ts, scenario, status, goals_done, (SELECT COUNT(*) FROM en_turns t WHERE t.session_id = s.id AND t.role = 'user') AS said FROM en_sessions s ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => ({ id: Number(r.id), ts: Number(r.ts), scenario: String(r.scenario), status: String(r.status), goals_done: JSON.parse(String(r.goals_done || "[]")), said: Number(r.said) }));
  }

  // ---------- 複習卡 ----------

  /** 新卡片明天開始複習；同一句英文已經有就不重複加（回 null） */
  addCard(c: { en: unknown; zh: unknown; note?: unknown; source?: unknown }): number | null {
    const en = str(c.en, 300);
    if (en.length < 2) return null;
    const row = this.sql
      .exec("INSERT INTO en_cards (ts, en, zh, note, source, step, due) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(en) DO NOTHING RETURNING id", Date.now(), en, str(c.zh, 300), str(c.note, 300), str(c.source, 40), shiftDate(this.today(), 1))
      .toArray()[0];
    return row ? Number(row.id) : null;
  }

  private card(r: Record<string, SqlStorageValue>): EnCard {
    return { id: Number(r.id), en: String(r.en), zh: String(r.zh ?? ""), note: String(r.note ?? ""), source: String(r.source ?? ""), step: Number(r.step), due: String(r.due), reps: Number(r.reps) };
  }

  dueCards(limit = 50): EnCard[] {
    return this.sql.exec("SELECT * FROM en_cards WHERE due <= ? ORDER BY due, id LIMIT ?", this.today(), limit).toArray().map((r) => this.card(r));
  }

  allCards(limit = 300): EnCard[] {
    return this.sql.exec("SELECT * FROM en_cards ORDER BY id DESC LIMIT ?", limit).toArray().map((r) => this.card(r));
  }

  review(id: number, grade: Grade): EnCard | null {
    const r = this.sql.exec("SELECT * FROM en_cards WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    const n = nextReview(Number(r.step), grade);
    this.sql.exec(
      "UPDATE en_cards SET step = ?, due = ?, reps = reps + 1, lapses = lapses + ? WHERE id = ?",
      n.step, shiftDate(this.today(), n.days), grade === "again" ? 1 : 0, id,
    );
    this.touch();
    return this.card(this.sql.exec("SELECT * FROM en_cards WHERE id = ?", id).one());
  }

  deleteCard(id: number): boolean {
    return this.sql.exec("DELETE FROM en_cards WHERE id = ?", id).rowsWritten > 0;
  }

  // ---------- 今日一課 ----------

  lesson(date: string) {
    const r = this.sql.exec("SELECT * FROM en_lessons WHERE date = ?", date).toArray()[0];
    return r ? { date, topic: String(r.topic), level: levelOf(r.level), done: !!r.done, ...JSON.parse(String(r.data)) } : null;
  }

  saveLesson(date: string, topic: string, level: EnLevel, data: unknown) {
    this.sql.exec(
      "INSERT INTO en_lessons (date, ts, topic, level, data, done) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(date) DO UPDATE SET ts = excluded.ts, topic = excluded.topic, level = excluded.level, data = excluded.data, done = 0",
      date, Date.now(), topic, level, JSON.stringify(data),
    );
  }

  lessonDone(date: string) {
    this.sql.exec("UPDATE en_lessons SET done = 1 WHERE date = ?", date);
    this.touch();
  }

  /** 最近學過的句子（產生新課時避免重複） */
  recentSentences(days = 14): string[] {
    return this.sql
      .exec("SELECT data FROM en_lessons WHERE date >= ? ORDER BY date DESC", shiftDate(this.today(), -days))
      .toArray()
      .flatMap((r) => {
        try {
          return (JSON.parse(String(r.data)).items ?? []).map((x: any) => String(x.en));
        } catch {
          return [];
        }
      });
  }

  // ---------- 連續天數 ----------

  /** 今天有練（任何一種練習都算）；連續滿 7 天送一張補簽卡（最多存 2 張） */
  touch() {
    const today = this.today();
    this.sql.exec("INSERT INTO en_days (date, practice) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET practice = practice + 1", today);
    const streak = this.streak();
    if (streak > 0 && streak % 7 === 0 && this.get("freeze_mark") !== today) {
      this.put("freezes", String(Math.min(MAX_FREEZES, this.freezes() + 1)));
      this.put("freeze_mark", today);
    }
  }

  freezes(): number {
    return Number(this.get("freezes", "0")) || 0;
  }

  private activeDays(): Set<string> {
    return new Set(this.sql.exec("SELECT date FROM en_days WHERE practice > 0 OR frozen = 1").toArray().map((r) => String(r.date)));
  }

  /** 連續天數：今天還沒練不算斷，從昨天往回數 */
  streak(): number {
    const days = this.activeDays();
    let d = days.has(this.today()) ? this.today() : shiftDate(this.today(), -1);
    let n = 0;
    while (days.has(d)) {
      n++;
      d = shiftDate(d, -1);
    }
    return n;
  }

  /** 每天檢查一次：昨天沒練、前天還連著，就自動用一張補簽卡補上昨天 */
  maintain() {
    const today = this.today();
    if (this.get("maintained") === today) return;
    this.put("maintained", today);
    const days = this.activeDays();
    const y = shiftDate(today, -1);
    if (!days.has(y) && days.has(shiftDate(today, -2)) && this.freezes() > 0) {
      this.sql.exec("INSERT INTO en_days (date, practice, frozen) VALUES (?, 0, 1) ON CONFLICT(date) DO UPDATE SET frozen = 1", y);
      this.put("freezes", String(this.freezes() - 1));
      this.put("freeze_used", y);
    }
  }

  progress() {
    this.maintain();
    const today = this.today();
    const days = this.activeDays();
    // 這週（週一到週日）
    const wd = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = shiftDate(today, -wd);
    const week = Array.from({ length: 7 }, (_, i) => {
      const date = shiftDate(monday, i);
      const row = this.sql.exec("SELECT practice, frozen FROM en_days WHERE date = ?", date).toArray()[0];
      return { date, done: Number(row?.practice ?? 0) > 0, frozen: !!row?.frozen };
    });
    const count = (q: string, ...a: unknown[]) => Number(this.sql.exec(q, ...a).one().n);
    return {
      today,
      today_done: days.has(today) && count("SELECT practice AS n FROM en_days WHERE date = ?", today) > 0,
      streak: this.streak(),
      freezes: this.freezes(),
      freeze_used: this.get("freeze_used") === shiftDate(today, -1) ? shiftDate(today, -1) : "",
      week,
      week_done: week.filter((d) => d.done).length,
      cards_due: count("SELECT COUNT(*) AS n FROM en_cards WHERE due <= ?", today),
      cards_total: count("SELECT COUNT(*) AS n FROM en_cards"),
      cards_learned: count("SELECT COUNT(*) AS n FROM en_cards WHERE step >= ?", SRS_STEPS.length - 2),
      sessions: count("SELECT COUNT(*) AS n FROM en_sessions WHERE status = 'done'"),
      practice_days: count("SELECT COUNT(*) AS n FROM en_days WHERE practice > 0"),
    };
  }

  // ---------- 朗讀音檔快取 ----------

  audioGet(key: string): ArrayBuffer | null {
    const r = this.sql.exec("SELECT data FROM en_audio WHERE key = ?", key).toArray()[0];
    return r ? (r.data as ArrayBuffer) : null;
  }

  audioPut(key: string, data: ArrayBuffer) {
    this.sql.exec("INSERT INTO en_audio (key, ts, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, data = excluded.data", key, Date.now(), data);
    this.sql.exec("DELETE FROM en_audio WHERE key NOT IN (SELECT key FROM en_audio ORDER BY ts DESC LIMIT ?)", MAX_AUDIO);
  }

  /** 清除所有英語練習紀錄（設定保留） */
  reset() {
    for (const t of ["en_sessions", "en_turns", "en_cards", "en_lessons", "en_days", "en_audio"]) this.sql.exec(`DELETE FROM ${t}`);
    for (const k of ["freezes", "freeze_mark", "freeze_used", "maintained", "reminded"]) this.sql.exec("DELETE FROM en_kv WHERE key = ?", k);
  }
}
