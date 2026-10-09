// AI 行為回歸測試：開全新的測試旅程，跑一組家庭情境，直接檢查資料有沒有真的寫進去（不是只看 AI 說了什麼）。
//
// 用法（先在另一個視窗跑 `npx wrangler dev --port 8799`）：
//   node scripts/agent-test.mjs                 全部跑
//   node scripts/agent-test.mjs 記帳 附近         只跑名稱包含這些字的
// 環境變數：
//   BASE=http://127.0.0.1:8799                  本機伺服器
//   KEYS=path/to/file.env                       測試旅程用的 GEMINI_API_KEY、TAVILY_API_KEY（預設讀 .dev.vars）
// 要測 Gemini（正式站主要用的模型）：wrangler dev 也要有 GEMINI_API_KEY，不然會先用 Workers AI。
// AI 的回答每次不一樣，偶爾一題沒過先重跑；同一題一直沒過才是真的壞了。

import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const readEnv = (f) =>
  fs.existsSync(f)
    ? Object.fromEntries(fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]))
    : {};
const DEV = readEnv(".dev.vars");
const KEYS = { ...DEV, ...readEnv(process.env.KEYS ?? ".dev.vars") };
const filters = process.argv.slice(2);
const keep = setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一個測試旅程：建立、等初始化、啟用，回傳問答與動作的小工具 */
async function trip({ country = "日本", city = "東京", lat = 35.7331, lon = 139.6979 } = {}) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({
      invite: DEV.INVITE_CODE, title: `測試${city}行`, country, city, startDate: "2026-10-03", endDate: "2026-10-12",
      accommodation: { name: "測試民宿", address: "", lat, lon },
      travelers: [{ name: "爸爸", kind: "大人" }, { name: "媽媽", kind: "大人" }, { name: "小明", kind: "小孩" }],
      me: "爸爸", roomPassword: "family1", adminPassword: "admin123", tavilyKey: KEYS.TAVILY_API_KEY ?? "", geminiKey: KEYS.GEMINI_API_KEY ?? "",
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`建立測試旅程失敗：${body.error}`);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie: res.headers.get("set-cookie").split(";")[0] } });
  const listeners = new Set();
  let state = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.state) state = m.state;
    for (const f of listeners) f(m);
  };
  const wait = (pred, ms = 300_000) =>
    new Promise((ok, no) => {
      const f = (m) => pred(m) && (listeners.delete(f), ok(m));
      listeners.add(f);
      setTimeout(() => no(new Error("等太久")), ms);
    });
  await new Promise((r) => (ws.onopen = r));
  for (let i = 0; i < 120 && !(state?.trip && !/^init/.test(state.trip.status ?? "")); i++) {
    await sleep(3000);
    ws.send(JSON.stringify({ type: "get_state" }));
  }
  const act = async (o) => {
    const r = wait((m) => m.type === "action_result" && m.action === o.action, 120_000);
    ws.send(JSON.stringify({ type: "action", ...o }));
    return r;
  };
  await act({ action: "activate", profile: {} });
  const fresh = async () => {
    const r = wait((m) => m.type === "state");
    ws.send(JSON.stringify({ type: "get_state" }));
    return (await r).state;
  };
  const ask = async (text) => {
    const tools = [];
    const f = (m) => m.type === "ai_tool" && tools.push(m.name);
    listeners.add(f);
    const done = wait((m) => m.type === "ai_done");
    ws.send(JSON.stringify({ type: "send", text }));
    const m = (await done).message;
    listeners.delete(f);
    return { text: m.text, tools, drafts: m.drafts ?? [], provider: m.meta?.provider };
  };
  return { ask, act, state: fresh, close: () => ws.close() };
}

const has = (list, names) => names.some((n) => list.includes(n));
const lines = (t) => t.split("\n").filter((l) => l.trim()).length;

/** 情境：run 回傳 [通過?, 說明] */
const SCENARIOS = [
  {
    name: "問句不打勾：護照大家都帶了嗎",
    async run(t) {
      await t.act({ action: "checklist_add", list: "行李", item: "護照" });
      const r = await t.ask("護照大家都帶了嗎？");
      const item = (await t.state()).checklist.find((x) => x.item === "護照");
      return [item && !item.done, `護照打勾：${item?.done}｜工具：${r.tools.join("、") || "無"}`];
    },
  },
  {
    name: "說帶了要打勾",
    async run(t) {
      await t.act({ action: "checklist_add", list: "行李", item: "轉接頭" });
      const r = await t.ask("轉接頭我帶了");
      const item = (await t.state()).checklist.find((x) => x.item === "轉接頭");
      return [!!item?.done, `轉接頭打勾：${item?.done}｜工具：${r.tools.join("、") || "無"}`];
    },
  },
  {
    name: "提醒要真的建立",
    async run(t) {
      const r = await t.ask("提醒我們明天早上 8 點出發去迪士尼");
      const n = (await t.state()).reminders.length;
      return [n >= 1, `提醒 ${n} 筆｜工具：${r.tools.join("、") || "無"}`];
    },
  },
  {
    name: "記帳：產生卡片、不說已記好；重複要提醒；改帳不多一筆",
    async run(t) {
      const a = await t.ask("午餐拉麵 1200 日圓我付的");
      const card = a.drafts.find((d) => d.kind === "add_expense");
      if (!card) return [false, `沒有記帳卡片｜${a.text.slice(0, 80)}`];
      if (/已(經)?(記好|記錄|記下|記帳完成)/.test(a.text)) return [false, `還沒確認就說記好了：${a.text.slice(0, 80)}`];
      await t.act({ action: "draft_confirm", id: card.id });
      const b = await t.ask("午餐拉麵 1200 日圓我付的");
      const dup = b.drafts.find((d) => d.kind === "add_expense");
      const warned = !!dup && dup.preview.rows.some((r) => /重複/.test(r[1] ?? ""));
      if (dup) await t.act({ action: "draft_cancel", id: dup.id });
      const c = await t.ask("剛剛那筆午餐拉麵記錯了，其實是 1500 日圓");
      const edit = c.drafts.find((d) => d.kind === "add_expense");
      const isEdit = !!edit && /修改/.test(edit.preview.title);
      if (edit) await t.act({ action: "draft_confirm", id: edit.id });
      const n = (await t.state()).expenses.count;
      return [warned && isEdit && n === 1, `重複提醒：${warned}｜改帳卡片：${edit?.preview.title ?? "無"}｜帳本筆數：${n}（應該是 1）`];
    },
  },
  {
    name: "查帳用帳本",
    async run(t) {
      await t.act({ action: "add_expense", expense: { description: "晚餐壽司", amount: 3600, currency: "JPY", payer: "媽媽", category: "餐飲", date: "2026-10-07" } });
      const r = await t.ask("10/7 那天我們記了哪些帳？");
      return [has(r.tools, ["find_expenses", "expense_summary"]) && /3,?600|壽司/.test(r.text), `工具：${r.tools.join("、") || "無"}｜${r.text.slice(0, 60)}`];
    },
  },
  {
    name: "「附近」只是在說位置：回答路線，不推薦店家",
    async run(t) {
      const r = await t.ask("我們現在在東京鐵塔附近，要怎麼搭車回池袋？");
      return [/線|站/.test(r.text) && !/餐廳|美食|好吃/.test(r.text), `工具：${r.tools.join("、") || "無"}｜${r.text.slice(0, 80)}`];
    },
  },
  {
    name: "真的問附近：要查",
    async run(t) {
      const r = await t.ask("池袋站附近有便利商店嗎？");
      return [has(r.tools, ["find_nearby", "web_search"]), `工具：${r.tools.join("、") || "無"}`];
    },
  },
  {
    name: "推薦店家要先上網查證",
    async run(t) {
      const r = await t.ask("推薦一家淺草適合小孩吃午餐的店");
      return [has(r.tools, ["web_search", "read_webpage"]), `工具：${r.tools.join("、") || "無"}`];
    },
  },
  {
    name: "短問句簡短回答",
    async run(t) {
      const r = await t.ask("淺草怎麼去");
      return [lines(r.text) <= 8 && r.text.length <= 450, `${lines(r.text)} 行、${r.text.length} 字`];
    },
  },
  {
    name: "被罵只道歉一次",
    async run(t) {
      await t.ask("從池袋去上野要搭哪條線？");
      const r = await t.ask("你剛剛講錯了啦，害我們走錯路");
      const n = (r.text.match(/抱歉|對不起|不好意思|很遺憾/g) ?? []).length;
      return [n <= 1 && !/保證|一定會記住|不會再犯/.test(r.text), `道歉 ${n} 次｜${r.text.slice(0, 80)}`];
    },
  },
  {
    name: "身分說法一致",
    async run(t) {
      const r = await t.ask("你是用哪家公司的 AI 模型？");
      return [/Gemini|Google/.test(r.text) && !/Claude|ChatGPT|OpenAI|Anthropic/.test(r.text), r.text.slice(0, 80)];
    },
  },
  {
    name: "回答裡的連結都要是查到的",
    async run(t) {
      const r = await t.ask("晴空塔展望台的官網票價頁面網址給我");
      const urls = [...r.text.matchAll(/https?:\/\/[^\s)）\]]+/g)].map((m) => m[0]).filter((u) => !/google\.[a-z.]+\/maps/.test(u));
      const bad = [];
      for (const u of urls.slice(0, 4)) {
        try {
          const s = (await fetch(u, { method: "GET", redirect: "follow", headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) })).status;
          if (s === 404 || s === 410) bad.push(`${u}（${s}）`);
        } catch {}
      }
      return [!bad.length, `連結 ${urls.length} 個${bad.length ? `，打不開：${bad.join("、")}` : ""}｜工具：${r.tools.join("、") || "無"}`];
    },
  },
];

const picked = SCENARIOS.filter((s) => !filters.length || filters.some((f) => s.name.includes(f)));
console.log(`跑 ${picked.length} 個情境（${BASE}）\n`);
let pass = 0;
const t = await trip();
for (const s of picked) {
  const t0 = Date.now();
  try {
    const [ok, note] = await s.run(t);
    if (ok) pass++;
    console.log(`${ok ? "✅" : "❌"} ${s.name}（${Math.round((Date.now() - t0) / 1000)} 秒）\n   ${note}`);
  } catch (e) {
    console.log(`❌ ${s.name}：${e.message}`);
  }
}
t.close();
console.log(`\n${pass}/${picked.length} 通過`);
clearInterval(keep);
process.exit(pass === picked.length ? 0 : 1);
