import { parseArgs } from "./providers";
import { EMPTY_GUIDE, travelersText, validTimezone, type GuideSource, type TripProfile } from "./profile";
import { nearestStation, searchPlaces } from "./tools";

// 建立旅程後的 AI 初始化：查當地基本資料、入境與實用資訊、住宿定位、常用語、行李清單。
// 每一步失敗都不會中斷，查不到的項目記在 initNotes，讓管理員在確認頁手動補。

export interface Phrase {
  category: string;
  zh: string;
  local: string;
  reading: string;
}

export interface InitDeps {
  /** 用 JSON 模式問 AI（由 TripRoom 依額度挑模型） */
  ask: (system: string, prompt: string) => Promise<string>;
  tavilyKey: string;
  progress: (step: number, label: string) => void;
}

export const INIT_STEPS = ["當地基本資料", "入境與實用資訊", "住宿定位", "常用語", "專屬行李清單"];

function json(raw: string): any {
  return parseArgs(raw.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
}

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function tavily(key: string, query: string): Promise<{ title: string; url: string; content: string }[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 4, search_depth: "basic" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`搜尋失敗 ${res.status}`);
  const d: any = await res.json();
  return (d.results ?? []).map((r: any) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), content: String(r.content ?? "").slice(0, 700) }));
}

export async function researchTrip(input: TripProfile, deps: InitDeps): Promise<{ profile: TripProfile; phrases: Phrase[]; checklist: { list: string; item: string }[] }> {
  const p: TripProfile = structuredClone(input);
  const where = `${p.country}${p.city ? `（${p.city}）` : ""}`;
  const year = p.startDate.slice(0, 4);
  const month = Number(p.startDate.slice(5, 7));
  let phrases: Phrase[] = [];
  let checklist: { list: string; item: string }[] = [];

  // 1. 當地基本資料：模型本身就知道，不用搜尋
  deps.progress(0, INIT_STEPS[0]);
  try {
    const j = json(await deps.ask(
      "你是旅遊資料助理，只輸出 JSON。",
      `台灣旅客要去 ${where} 旅行。請提供當地基本資料，只輸出 JSON：
{"countryCode":"ISO 3166-1 兩碼，例如 KR","countryIso3":"三碼，例如 KOR","country":"國家的繁體中文名稱","timezone":"主要城市的 IANA 時區，例如 Asia/Seoul","currency":"ISO 4217 貨幣代碼","currencySymbol":"貨幣符號","language":"旅客最常需要的當地語言（繁體中文名稱，例如 韓文）","langCode":"BCP 47，例如 ko-KR","readingName":"這個語言給台灣人照著念的發音提示叫什麼，例如 日文=平假名、韓文=羅馬拼音、泰文=羅馬拼音；英文等拼音文字不需要就給空字串","emergency":"這個國家的警察、救護車、消防電話，一句話，格式：警察 ○○○、救護車 ○○○、消防 ○○○（號碼相同就合併寫）"}`,
    ));
    if (/^[A-Z]{2}$/i.test(str(j.countryCode))) p.countryCode = str(j.countryCode).toUpperCase();
    if (/^[A-Z]{3}$/i.test(str(j.countryIso3))) p.countryIso3 = str(j.countryIso3).toUpperCase();
    if (str(j.country)) p.country = str(j.country, 30);
    if (validTimezone(str(j.timezone))) p.timezone = str(j.timezone);
    else p.initNotes.push("時區查不到，請在確認頁填寫");
    if (/^[A-Z]{3}$/i.test(str(j.currency))) p.currency = str(j.currency).toUpperCase();
    p.currencySymbol = str(j.currencySymbol, 6) || p.currency;
    p.language = str(j.language, 20) || "英文";
    p.langCode = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(str(j.langCode)) ? str(j.langCode) : "en-US";
    p.readingName = str(j.readingName, 20);
    p.emergency = str(j.emergency, 300);
  } catch (e) {
    console.error("init basics failed", e);
    p.initNotes.push("當地基本資料（時區、貨幣、語言）查詢失敗，請在確認頁填寫");
  }
  try {
    const c = (await searchPlaces(p.city || p.country, p.countryCode || undefined, 1))[0];
    if (c) p.center = { lat: c.lat, lon: c.lon };
  } catch {}

  // 2. 入境與實用資訊：會變動的規定先搜尋，再請 AI 整理，附來源
  deps.progress(1, INIT_STEPS[1]);
  try {
    const queries = [
      `台灣護照 ${p.country} 入境 簽證 入境登記 ${year}`,
      `${p.country} 觀光客 退稅 規定 門檻 ${year}`,
      `${p.country} 旅客 觀光諮詢熱線 中文 服務 電話`,
      `${p.city || p.country} taxi fare flag fall per km ${year}`,
      `${p.city || p.country} 交通卡 地鐵 叫車 App 旅客 ${year}`,
    ];
    const found = (await Promise.all(queries.map((q) => tavily(deps.tavilyKey, q).catch(() => [])))).flat();
    const sources: GuideSource[] = [];
    for (const r of found) if (r.url && !sources.some((s) => s.url === r.url) && sources.length < 8) sources.push({ title: r.title.slice(0, 80), url: r.url });
    const j = json(await deps.ask(
      "你是嚴謹的旅遊資料助理，只根據提供的搜尋結果與可靠常識回答，不確定就寫「請出發前再確認」，只輸出 JSON。",
      `台灣家庭（${travelersText(p.travelers)}）要在 ${p.startDate} 到 ${p.endDate} 去 ${where}。
請整理成給手機閱讀的旅遊指南，每一項 2–4 句、條列可以用「・」，繁體中文台灣用語：
{"entry":"台灣護照入境規定：免簽天數或簽證、入境登記／電子旅行許可、效期要求","money":"貨幣、現金與刷卡習慣、換匯建議、小費習慣","power":"電壓與插座型式，要不要帶轉接頭","transport":"市區交通卡、地鐵、常用叫車 App","taxRefund":"觀光客退稅規定與門檻，沒有退稅就說明","connectivity":"網卡、eSIM、Wi-Fi 建議","etiquette":"需要注意的禮儀或禁忌（有小孩的話也提醒）","weather":"${month} 月的天氣與穿著建議","hotline":"搜尋結果裡寫到的觀光客諮詢熱線：號碼＋有沒有中文服務；搜尋結果沒寫到就給空字串，不要憑記憶寫",
"taxi":{"base":起跳價（當地貨幣，數字）,"baseKm":起跳里程公里（數字）,"perKm":之後每公里約多少（數字）,"nightMultiplier":深夜加成倍數（沒有就 1）,"nightFrom":深夜開始小時（0-23）,"nightTo":深夜結束小時,"note":"一句話補充，例如叫車 App 名稱或機場固定費率"}}
查不到計程車費率就把 taxi 設成 null。
搜尋結果：
${found.map((r, i) => `[${i + 1}] ${r.title}（${r.url}）\n${r.content}`).join("\n\n").slice(0, 9000) || "（沒有搜尋結果，請依可靠常識回答並提醒出發前確認）"}`,
    ));
    // 觀光熱線只用搜尋結果裡有的（AI 憑記憶常把別國的號碼寫進來）
    const hotline = str(j.hotline, 100).replace(/^[・•\-\s]+/, "").replace(/\s+/g, " ");
    if (hotline && /\d{3,}/.test(hotline) && !p.emergency.includes("觀光")) p.emergency = `${p.emergency}${p.emergency ? "；" : ""}觀光諮詢 ${hotline}`.slice(0, 300);
    p.guide = {
      entry: str(j.entry), money: str(j.money), power: str(j.power), transport: str(j.transport), taxRefund: str(j.taxRefund),
      connectivity: str(j.connectivity), etiquette: str(j.etiquette), weather: str(j.weather), sources,
    };
    const t = j.taxi;
    if (t && num(t.base) > 0 && num(t.perKm) > 0) {
      p.taxi = {
        base: num(t.base), baseKm: num(t.baseKm), perKm: num(t.perKm),
        nightMultiplier: num(t.nightMultiplier) >= 1 ? num(t.nightMultiplier) : 1,
        nightFrom: Math.min(23, Math.max(0, num(t.nightFrom) || 22)), nightTo: Math.min(23, Math.max(0, num(t.nightTo) || 5)),
        note: str(t.note, 200),
      };
    } else p.initNotes.push("計程車費率查不到，問計程車費用時 AI 會改用網路搜尋");
    if (!found.length) p.initNotes.push("入境與實用資訊沒有搜尋結果，是 AI 依常識整理的，請出發前再確認");
  } catch (e) {
    console.error("init guide failed", e);
    p.guide = { ...EMPTY_GUIDE };
    p.initNotes.push("入境與實用資訊查詢失敗，可以之後直接問 AI");
  }

  // 3. 住宿定位：有座標才能查天氣、找附近、估計程車
  deps.progress(2, INIT_STEPS[2]);
  const a = p.accommodation;
  if (a.lat == null && (a.address || a.name)) {
    try {
      const hit = (await searchPlaces(a.address || a.name, p.countryCode, 1))[0] ?? (a.address && a.name ? (await searchPlaces(a.name, p.countryCode, 1))[0] : undefined);
      if (hit) {
        a.lat = hit.lat;
        a.lon = hit.lon;
      } else p.initNotes.push("住宿地址在地圖上找不到，天氣和「附近」會先用市中心");
    } catch {
      p.initNotes.push("住宿定位失敗，天氣和「附近」會先用市中心");
    }
  }
  if (a.lat != null && a.lon != null && !a.note) {
    const s = await nearestStation(a.lat, a.lon);
    if (s) a.note = `最近車站：${s.name}，步行約 ${s.walk_min} 分鐘`;
  }

  // 4. 常用語：計程車、餐廳、購物、住宿、緊急
  deps.progress(3, INIT_STEPS[3]);
  const isChinese = /^zh/i.test(p.langCode);
  if (!isChinese) {
    try {
      const kids = p.travelers.filter((t) => t.kind === "小孩").length;
      const j = json(await deps.ask(
        `你是${p.language}口譯，只輸出 JSON。`,
        `幫要去 ${where} 的台灣家庭（${travelersText(p.travelers)}）準備 28 句最實用的${p.language}常用句，分類：🚕 計程車、🍜 餐廳、🛍 購物、🏨 住宿、🆘 緊急／常用。
要包含：請載我們到住宿（地址照抄：${a.address || a.name || "（未提供）"}）、我們有 ${p.travelers.length} 個人${kids ? "和小孩" : ""}、有兒童餐或兒童座椅嗎、不要辣、結帳、可以刷卡嗎、可以退稅嗎、廁所在哪、小孩走失了請幫忙、請叫救護車、我聽不懂${p.language}。
${p.readingName ? `reading 填${p.readingName}，讓台灣人照著念。` : "reading 給空字串。"}語氣禮貌、簡短好念。
只輸出 JSON：{"phrases":[{"category":"🚕 計程車","zh":"繁體中文","local":"${p.language}","reading":"..."}]}`,
      ));
      phrases = (Array.isArray(j.phrases) ? j.phrases : [])
        .map((x: any) => ({ category: str(x.category, 20) || "⭐ 常用", zh: str(x.zh, 200), local: str(x.local, 400), reading: str(x.reading, 400) }))
        .filter((x: Phrase) => x.zh && x.local)
        .slice(0, 40);
      if (!phrases.length) throw new Error("沒有產生常用句");
    } catch (e) {
      console.error("init phrases failed", e);
      p.initNotes.push("常用語產生失敗，可以之後在翻譯頁自己新增");
    }
  }

  // 5. 專屬行李清單（基本清單已經有了，這裡只補當地特有的）
  deps.progress(4, INIT_STEPS[4]);
  try {
    const j = json(await deps.ask(
      "你是旅遊準備助理，只輸出 JSON。",
      `台灣家庭（${travelersText(p.travelers)}）${p.startDate} 要去 ${where}。以下基本項目已經在清單裡，不要重複：護照、機票、訂房確認、信用卡、網卡、充電器、常備藥、旅平險、確認入境規定。
請補充這個目的地「特有」的準備項目最多 8 項（例如特定型式的轉接頭、入境登記、當地交通卡、當季衣物、必裝 App），每項一句。
參考資料：${p.guide.power} ${p.guide.entry} ${p.guide.transport} ${p.guide.weather}
只輸出 JSON：{"items":[{"list":"行李 或 待辦","item":"..."}]}`,
    ));
    checklist = (Array.isArray(j.items) ? j.items : [])
      .map((x: any) => ({ list: str(x.list) === "待辦" ? "待辦" : "行李", item: str(x.item, 120) }))
      .filter((x: { item: string }) => x.item)
      .slice(0, 8);
  } catch (e) {
    console.error("init checklist failed", e);
  }

  p.title ||= `${p.city || p.country}旅行 ${year}`;
  return { profile: p, phrases, checklist };
}
