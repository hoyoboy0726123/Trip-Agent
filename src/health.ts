/**
 * 健康管家的規則引擎：分級、統計、722 居家血壓、篩檢與疫苗時程、紅旗與健康話題判斷。
 * 門檻都照指引寫死（出處寫在每條規則旁），AI 不自己判斷，只負責把結果說成白話。
 * 純函式，不碰 Workers 的 API。
 */

export interface HealthProfile {
  sex?: "M" | "F";
  /** YYYY-MM-DD */
  birth?: string;
  /** 公分 */
  height?: number;
  /** 慢性病：高血壓、糖尿病、高血脂、慢性腎病、心臟病、中風、痛風… */
  conditions?: string[];
  allergies?: string;
  /** 一等親有大腸癌 */
  familyCrc?: boolean;
  /** 父母、子女、兄弟姊妹有肺癌 */
  familyLung?: boolean;
  smoking?: "never" | "former" | "current";
  packYears?: number;
  quitYear?: number;
  betel?: boolean;
  pregnant?: boolean;
  /** 722 早上、晚上的提醒時間 HH:mm */
  amTime?: string;
  pmTime?: string;
}

export type VitalKind = "bp" | "glucose" | "weight";

export interface Vital {
  id: number;
  ts: number;
  /** 當地日期、時間 */
  date: string;
  time: string;
  kind: VitalKind;
  /** 血壓：收縮壓／舒張壓／脈搏；血糖：mg/dL；體重：公斤／腰圍 */
  v1: number;
  v2: number | null;
  v3: number | null;
  context: string;
}

export interface Flag {
  level: "red" | "yellow";
  text: string;
}

export interface Grade {
  code: string;
  label: string;
}

/** 血壓目標：台灣高血壓指引 2022，所有人通用 <130/80 */
export const BP_TARGET: [number, number] = [130, 80];

/** 台灣高血壓指引 2022（Table 5）分級；以 722 居家平均為準，單次量測只當參考 */
export function bpClass(s: number, d: number): Grade {
  if (s >= 140 || d >= 90) return { code: "stage2", label: "高血壓第 2 級範圍" };
  if (s >= 130 || d >= 80) return { code: "stage1", label: "高血壓第 1 級範圍" };
  if (s >= 120) return { code: "elevated", label: "血壓偏高" };
  return { code: "normal", label: "正常" };
}

/** 血壓的固定警示文字（ESC ≥180/110 與 AHA >180/120 取保守值；低血壓 NHLBI <90/60） */
export function bpFlags(s: number, d: number): Flag[] {
  if (s >= 180 || d >= 110) {
    return [{
      level: "red",
      text: "血壓很高（≥180/110）。先坐著休息 5 分鐘再量一次。**如果同時有胸痛、喘、單側手腳無力或麻、說話困難、視力改變、劇烈頭痛，請立刻撥 119。** 沒有這些症狀、但重量後還是這麼高，請當天聯絡醫師。",
    }];
  }
  if (s < 90 || d < 60) {
    return [{
      level: "yellow",
      text: "血壓偏低（<90/60）。如果頭暈、快昏倒，請先坐下或躺下並就醫；出現皮膚濕冷、呼吸急促、意識不清，請撥 119。",
    }];
  }
  return [];
}

export const GLU_CONTEXT: Record<string, string> = { fasting: "空腹", pre: "餐前", post: "餐後 2 小時", bed: "睡前", random: "隨機" };

/**
 * 血糖單次讀數的判讀。沒有糖尿病：國健署診斷切點（空腹 100／126、餐後或隨機 140／200）；
 * 有糖尿病：ADA 2026 目標（餐前 80–130、餐後 <180；台灣糖尿病學會餐後建議 ≤160）
 */
export function glucoseClass(v: number, context: string, diabetic: boolean): Grade {
  if (v < 54) return { code: "low2", label: "低血糖（第 2 級，<54）" };
  if (v < 70) return { code: "low1", label: "低血糖（第 1 級，54–69）" };
  if (diabetic) {
    if (context === "fasting" || context === "pre") return v <= 130 ? { code: "ok", label: "達標（目標 80–130）" } : { code: "high", label: "高於目標（目標 80–130）" };
    return v < 180 ? { code: "ok", label: "達標（目標 <180；台灣糖尿病學會餐後建議 ≤160）" } : { code: "high", label: "高於目標（目標 <180）" };
  }
  if (context === "fasting") {
    if (v < 100) return { code: "normal", label: "正常（<100）" };
    if (v < 126) return { code: "pre", label: "偏高，落在糖尿病前期範圍（100–125）" };
    return { code: "dm", label: "偏高，落在糖尿病範圍（≥126，要由醫師抽血確認）" };
  }
  if (context === "post" || context === "random") {
    if (v < 140) return { code: "normal", label: "正常（<140）" };
    if (v < 200) return { code: "high", label: "偏高（≥140）" };
    return { code: "dm", label: "偏高，落在糖尿病範圍（≥200，要由醫師確認）" };
  }
  return v < 100 ? { code: "normal", label: "正常（<100）" } : { code: "high", label: "偏高（≥100）" };
}

/** 血糖的固定警示文字（ADA 2026 低血糖分級與 15/15 法則；≥300 是產品自訂門檻，指引沒有單一數字） */
export function glucoseFlags(v: number, prevHigh: boolean): Flag[] {
  if (v < 54) {
    return [{ level: "red", text: "血糖很低（<54）。請立刻吃或喝 15 公克的糖（例如半杯果汁、3–4 顆方糖），並告訴家人；15 分鐘後再測。**如果意識不清、叫不醒，請撥 119。**" }];
  }
  if (v < 70) return [{ level: "yellow", text: "血糖偏低（<70）。請吃或喝 15 公克的糖（例如半杯果汁），15 分鐘後再測一次。" }];
  if (v >= 300 && prevHigh) return [{ level: "yellow", text: "血糖連續兩次 ≥300。請聯絡醫師；如果意識改變、一直嘔吐或很喘，請送急診。" }];
  if (v >= 300) return [{ level: "yellow", text: "血糖 ≥300。請多喝水，過一兩個小時再測一次；持續這麼高請聯絡醫師。" }];
  return [];
}

/** 國健署成人 BMI 分級 */
export function bmiInfo(height: number, weight: number): { value: number; label: string } {
  const value = Math.round((weight / (height / 100) ** 2) * 10) / 10;
  const label = value < 18.5 ? "過輕" : value < 24 ? "正常" : value < 27 ? "過重" : "肥胖";
  return { value, label };
}

/** 國健署腹部肥胖：男 ≥90、女 ≥80 公分 */
export function waistInfo(sex: string | undefined, waist: number): { value: number; label: string } {
  const limit = sex === "F" ? 80 : sex === "M" ? 90 : null;
  return { value: waist, label: limit == null ? "（填性別後才能判斷）" : waist >= limit ? `腹部肥胖（≥${limit}）` : `正常（<${limit}）` };
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** 一段期間的血壓統計：整體、早上、晚上平均，以及單筆 <130/80 的比例 */
export function bpSummary(vitals: Vital[], from: string, to: string) {
  const bp = vitals.filter((v) => v.kind === "bp" && v.date >= from && v.date <= to);
  const mean = (list: Vital[]) => (list.length ? [avg(list.map((v) => v.v1))!, avg(list.map((v) => v.v2 ?? 0))!] as [number, number] : null);
  const below = bp.filter((v) => v.v1 < BP_TARGET[0] && (v.v2 ?? 0) < BP_TARGET[1]).length;
  return {
    from, to,
    count: bp.length,
    all: mean(bp),
    morning: mean(bp.filter((v) => v.context === "morning")),
    evening: mean(bp.filter((v) => v.context === "evening")),
    belowTarget: bp.length ? Math.round((below / bp.length) * 100) : null,
  };
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400_000);
}

/**
 * 722 居家血壓（台灣 2022 §3.6、Table 6）：連續 7 天、早上和睡前各量、每次 2 筆。
 * 排除第 1 天，至少 4 天有資料才算有效；早晚平均分開算；同一次量超過 3 筆，取收縮壓最低的 2 筆
 */
export function bp722(vitals: Vital[], start: string) {
  const end = shiftDate(start, 6);
  const sessions = new Map<string, Vital[]>();
  for (const v of vitals) {
    if (v.kind !== "bp" || v.date <= start || v.date > end || (v.context !== "morning" && v.context !== "evening")) continue;
    const key = `${v.date}|${v.context}`;
    sessions.set(key, [...(sessions.get(key) ?? []), v]);
  }
  const sessionAvg = new Map<string, [number, number]>();
  for (const [key, list] of sessions) {
    const use = list.length > 3 ? [...list].sort((a, b) => a.v1 - b.v1).slice(0, 2) : list;
    sessionAvg.set(key, [avg(use.map((v) => v.v1))!, avg(use.map((v) => v.v2 ?? 0))!]);
  }
  const pick = (ctx: string) => [...sessionAvg].filter(([k]) => k.endsWith(ctx)).map(([, v]) => v);
  const mean = (list: [number, number][]) => (list.length ? [avg(list.map((x) => x[0]))!, avg(list.map((x) => x[1]))!] as [number, number] : null);
  const validDays = new Set([...sessionAvg.keys()].map((k) => k.split("|")[0])).size;
  const overall = mean([...sessionAvg.values()]);
  return {
    start, end,
    validDays,
    sessions: sessionAvg.size,
    valid: validDays >= 4,
    morning: mean(pick("morning")),
    evening: mean(pick("evening")),
    overall,
    grade: overall ? bpClass(overall[0], overall[1]) : null,
    meetsTarget: overall ? overall[0] < BP_TARGET[0] && overall[1] < BP_TARGET[1] : null,
  };
}

/** 多久該做下一輪 722（台灣 2022 Table 7） */
export function next722Days(grade: string | null, hypertensive: boolean, meetsTarget: boolean | null): number {
  if (hypertensive) return meetsTarget ? 91 : 30;
  if (grade === "normal") return 365;
  if (grade === "elevated") return 182;
  return 30;
}

export function ageOn(birth: string, date: string): number {
  const [by, bm, bd] = birth.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export interface ScreenItem {
  code: string;
  group: "健檢" | "癌症篩檢" | "疫苗";
  name: string;
  /** 對象與頻率（顯示用，附出處） */
  rule: string;
  /** 幾個月一次；0＝一生一次 */
  every: number;
}

/**
 * 依年齡、性別、家族史、生活習慣算出「現在符合資格」的健檢、癌症篩檢與疫苗（2026 年 10 月現行規定）。
 * 健檢用「滿幾歲、未滿幾歲」；疫苗依疾管署用「接種年 − 出生年」
 */
export function screeningPlan(p: HealthProfile, today: string): ScreenItem[] {
  if (!p.birth) return [];
  const age = ageOn(p.birth, today);
  const yearAge = Number(today.slice(0, 4)) - Number(p.birth.slice(0, 4));
  const thisYear = Number(today.slice(0, 4));
  const out: ScreenItem[] = [];
  const add = (cond: boolean, item: ScreenItem) => cond && out.push(item);
  add(age >= 30, {
    code: "adult", group: "健檢", name: "成人預防保健",
    rule: "30–39 歲每 5 年、40–64 歲每 3 年、65 歲以上每年（國健署，2025 起）",
    every: age >= 65 ? 12 : age >= 40 ? 36 : 60,
  });
  add(Number(p.birth.slice(0, 4)) <= 1986 && age <= 79, { code: "hbc", group: "健檢", name: "B、C 肝炎篩檢", rule: "民國 75 年（含）以前出生到 79 歲，一生一次（國健署）", every: 0 });
  add(p.sex === "F" && age >= 25, { code: "pap", group: "癌症篩檢", name: "子宮頸抹片", rule: "25–29 歲每 3 年；30 歲以上建議至少每 3 年（國健署）", every: 36 });
  add(p.sex === "F" && [35, 45, 65].includes(age), { code: "hpv", group: "癌症篩檢", name: "HPV 檢測", rule: "35、45、65 歲各一次（國健署，2025 起）", every: 0 });
  add(p.sex === "F" && age >= 40 && age <= 74, { code: "mammo", group: "癌症篩檢", name: "乳房攝影", rule: "40–74 歲每 2 年（國健署，2025 起）", every: 24 });
  add((age >= 45 && age <= 74) || (!!p.familyCrc && age >= 40 && age <= 44), {
    code: "fit", group: "癌症篩檢", name: "大腸癌糞便潛血檢查", rule: "45–74 歲每 2 年；一等親有大腸癌者 40–44 歲也可以（國健署，2025 起）", every: 24,
  });
  add(age >= 30 && (!!p.betel || (p.smoking ?? "never") !== "never"), { code: "oral", group: "癌症篩檢", name: "口腔黏膜檢查", rule: "30 歲以上嚼檳榔或吸菸（含已戒）者每 2 年（國健署）", every: 24 });
  const familyLung = !!p.familyLung && ((p.sex === "M" && age >= 45 && age <= 74) || (p.sex === "F" && age >= 40 && age <= 74));
  const heavySmoker = age >= 50 && age <= 74 && (p.packYears ?? 0) >= 20 && (p.smoking === "current" || (p.smoking === "former" && !!p.quitYear && thisYear - p.quitYear <= 15));
  add(familyLung || heavySmoker, { code: "ldct", group: "癌症篩檢", name: "肺癌低劑量電腦斷層", rule: "有肺癌家族史（男 45–74、女 40–74 歲）或重度吸菸（50–74 歲、20 包年以上）每 2 年（國健署）", every: 24 });
  add(age >= 45 && age <= 74, { code: "hp", group: "癌症篩檢", name: "胃幽門螺旋桿菌檢測", rule: "45–74 歲一生一次（國健署，2026 起）", every: 0 });
  add(true, { code: "flu", group: "疫苗", name: "流感疫苗", rule: "每年一劑，每年 10 月開打（疾管署；50 歲以上、慢性病等有公費）", every: 12 });
  add(true, { code: "tdap", group: "疫苗", name: "破傷風（Tdap／Td）", rule: "每 10 年追加一劑（疾管署）", every: 120 });
  add(yearAge >= 65, { code: "pneumo", group: "疫苗", name: "肺炎鏈球菌疫苗", rule: "65 歲以上公費：PCV20 一劑，或 PCV13＋PPV23（疾管署 115 年 9 月版）", every: 0 });
  add(yearAge >= 50, { code: "zoster", group: "疫苗", name: "帶狀疱疹疫苗", rule: "50 歲以上自費兩劑，間隔 2–6 個月（疾管署）", every: 0 });
  add(yearAge >= 65, { code: "covid", group: "疫苗", name: "新冠疫苗", rule: "65 歲以上間隔 6 個月可再打一劑，依當年政策（疾管署）", every: 6 });
  return out;
}

/** 下一次該做的日期：一生一次做過就不用；流感以每年 10 月 1 日為新的一季 */
export function screeningStatus(item: ScreenItem, last: string | null, today: string): { status: "due" | "ok" | "none" | "done"; next: string | null } {
  if (!last) return { status: "none", next: null };
  if (item.every === 0) return { status: "done", next: null };
  if (item.code === "flu") {
    const y = Number(today.slice(0, 4));
    const season = Number(today.slice(5, 7)) >= 10 ? `${y}-10-01` : `${y - 1}-10-01`;
    return last >= season ? { status: "ok", next: `${Number(season.slice(0, 4)) + 1}-10-01` } : { status: "due", next: season };
  }
  const d = new Date(last + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + item.every);
  const next = d.toISOString().slice(0, 10);
  return { status: next <= today ? "due" : "ok", next };
}

const EMERGENCY =
  "⚠️ **如果你現在就有這個狀況，請立刻撥 119**（或請旁邊的人幫忙）：\n" +
  "- 胸痛、胸悶、喘不過氣、昏倒、吐血或解黑便、喉嚨或嘴唇腫起來\n" +
  "- 中風徵兆：臉歪一邊、單側手腳無力、說話不清楚、突然看不清楚或站不穩（記下發作的時間）\n\n" +
  "健康管家不能判斷緊急狀況，這是固定的安全提醒。不是現在發生的事，可以換個方式問我，例如「胸悶要看哪一科」。";
const CRISIS =
  "💛 **聽起來你現在很辛苦。** 如果有傷害自己的念頭，請馬上找人陪你，或撥 **1925 安心專線**（24 小時、免費）；" +
  "也可以撥生命線 **1995**、張老師 **1980**。有立即危險請撥 **119**。\n\n你願意的話，也可以跟我說說發生了什麼事。";

const RED_FLAGS: [RegExp, string][] = [
  [/想死|不想活|自殺|自殘|輕生|結束(我的)?生命|活不下去/, CRISIS],
  [/胸(口)?(很|好|一直|突然)?(痛|悶|緊|壓)/, EMERGENCY],
  [/喘不過氣|呼吸困難|吸不到氣|不能呼吸/, EMERGENCY],
  [/(臉|嘴|嘴角)(歪|斜)|單側.{0,4}(無力|麻)|半邊.{0,4}(無力|麻)|說話(不清|含糊|困難)|口齒不清|手(腳)?舉不起來/, EMERGENCY],
  [/(突然|突發).{0,6}(劇烈|爆炸|最痛).{0,4}頭痛/, EMERGENCY],
  [/昏倒|暈倒|昏迷|失去意識|叫不醒/, EMERGENCY],
  [/吐血|咳血|解黑便|黑便|大量出血|血流不止/, EMERGENCY],
  [/(喉嚨|嘴唇|舌頭|眼皮).{0,4}腫.{0,10}(喘|呼吸)|全身.{0,4}(蕁麻疹|起疹子).{0,8}(喘|呼吸)/, EMERGENCY],
];

/** 紅旗症狀：命中就顯示固定內容、不交給 AI 分析（K Health 研究：AI 判斷緊急程度只有 81%，醫師 97%） */
export function redFlagText(text: string): string | null {
  for (const [re, msg] of RED_FLAGS) if (re.test(text)) return msg;
  return null;
}

const HEALTH_RE =
  /血壓|血糖|心跳|脈搏|體重|BMI|腰圍|膽固醇|三酸甘油|血脂|尿酸|肝指數|肝功能|腎功能|eGFR|糖化|A1c|健檢|健康檢查|檢查報告|檢驗|抽血|驗血|用藥|吃藥|服藥|藥物|藥袋|副作用|處方|慢箋|領藥|回診|門診|看醫生|看醫師|症狀|頭痛|頭暈|胸痛|胸悶|心悸|發燒|咳嗽|喉嚨痛|拉肚子|腹瀉|便秘|失眠|過敏|疫苗|篩檢|健康管家|722|高血壓|低血壓|糖尿病|痛風|骨質疏鬆|懷孕|生理期|月經/i;

/** 健康話題：整輪改由 Cloudflare 的模型回答（Gemini 條款禁止提供醫療建議） */
export function isHealthTopic(text: string): boolean {
  return HEALTH_RE.test(text);
}
