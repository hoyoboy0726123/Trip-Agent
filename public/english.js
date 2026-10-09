// AI 英語家教（個人助理，只給大人用）：情境對話、今日一課、說一句、複習卡、進度。
// 跟聊天室分開：練習的對話只在這個面板裡，不會出現在聊天，也不會進長期記憶。
// 資料與 AI 都走 /api/english/*（伺服器 room.ts 的 englishApi）。

ICONS.english = '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>';

const EN = {
  tab: "talk", state: null, loading: false, loadedAt: 0, session: null, busy: false, rec: null, hint: null,
  results: {}, reveal: false, cards: null, draft: "", taskDraft: "", target: "", audio: null, cache: new Map(),
  autoPlay: store("en-autoplay") !== 0,
};
const EN_TABS = [["talk", "情境對話"], ["lesson", "今日一課"], ["speak", "說一句"], ["review", "複習卡"], ["me", "進度"]];
const EN_LEVELS = [["beginner", "初級"], ["intermediate", "中級"], ["advanced", "進階"]];
const enAttr = (o) => escapeHtml(JSON.stringify(o));
const enPlayBtn = (text, label = "🔊") => `<button type="button" class="en-play" data-enplay="${escapeHtml(text)}" aria-label="朗讀">${label}</button>`;
const enWhen = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function enLoad(render = true) {
  EN.loading = true;
  const r = await api("/api/english/state");
  EN.loading = false;
  EN.loadedAt = Date.now();
  if (!r.ok) {
    EN.error = r.error || "載入失敗";
  } else {
    EN.error = "";
    EN.state = r;
    if (r.active && (!EN.session || EN.session.id !== r.active)) {
      const s = await api(`/api/english/session?id=${r.active}`);
      if (s.ok) EN.session = s.session;
    }
  }
  // 錄音或等 AI 回覆時不要重畫（會打斷）
  if (render && S.panel === "english" && !EN.rec && !EN.busy) renderPanel();
}

function renderEnglishPanel(st, b) {
  els.panelTitle.textContent = "🗣️ 英語家教";
  if (!EN.state) {
    b.innerHTML = `${backToHub()}<div class="card small ${EN.error ? "" : "muted"}">${EN.error ? `⚠️ ${escapeHtml(EN.error)}` : "載入中…"}</div>`;
    bindBack(b);
    if (!EN.loading) enLoad();
    return;
  }
  if (Date.now() - EN.loadedAt > 60_000 && !EN.loading) enLoad();
  const body = { talk: enTalk, lesson: enLesson, speak: enSpeak, review: enReview, me: enMe }[EN.tab] || enTalk;
  const due = EN.state.progress.cards_due;
  b.innerHTML = `
    ${backToHub()}
    <div class="seg-tabs en-tabs">${EN_TABS.map(([k, t]) => `<button type="button" data-entab="${k}" class="${EN.tab === k ? "on" : ""}">${t}${k === "review" && due ? `<span class="en-badge">${due}</span>` : ""}</button>`).join("")}</div>
    ${EN.state.hasGemini ? "" : `<div class="card small notice">還沒填 Gemini 金鑰：先到「設定 → API 金鑰」填自己的金鑰，英語家教才能聽錄音、給回饋。</div>`}
    <div id="en-body">${body()}</div>`;
  bindBack(b);
  const input = $("#en-input", b);
  if (input) input.value = EN.draft;
  const task = $("#en-task", b);
  if (task) task.value = EN.taskDraft;
  enBind(b);
  enScroll();
}

// ---------- 情境對話 ----------

function enScene(id) {
  return EN.state.scenarios.find((x) => x.id === id) || { icon: "💬", title: "練習", you: "", tutor: "", goals: [] };
}

function enTalk() {
  const s = EN.session;
  if (s?.status === "active") return enChat(s);
  if (s?.report) return enReport(s);
  const st = EN.state;
  return `
    <p class="small muted">選一個情境開始：AI 扮演對方，你完成卡片上的任務。說得不自然的地方會給更好的說法，自動加進複習卡。可以打字，也可以按 🎙 用說的。</p>
    <div class="en-scenes">${st.scenarios
      .map((x) => `<button type="button" class="en-scene" data-enstart="${x.id}"><span class="en-scene-icon">${x.icon}</span><b>${escapeHtml(x.title)}</b><span class="small muted">你是${escapeHtml(x.you)}，對方是${escapeHtml(x.tutor)}</span></button>`)
      .join("")}</div>
    ${st.recent.length ? `<h3 class="en-h">最近的練習</h3><div class="list card">${st.recent
      .map((r) => {
        const sc = enScene(r.scenario);
        return `<button type="button" class="item small en-past" data-ensession="${r.id}"><span>${sc.icon} ${escapeHtml(sc.title)}</span><span class="muted">${enWhen(r.ts)}・說了 ${r.said} 句・任務 ${r.goals_done.length}/${sc.goals.length}</span></button>`;
      })
      .join("")}</div>` : ""}`;
}

function enTurn(t) {
  if (t.role === "tutor") return `<div class="en-msg tutor"><div class="en-bubble">${escapeHtml(t.text)} ${enPlayBtn(t.text)}</div></div>`;
  const f = t.feedback || {};
  return `<div class="en-msg user"><div class="en-bubble">${f.voice ? "🎙 " : ""}${escapeHtml(t.text)}</div>
    ${f.correction ? `<div class="en-fix"><div>✏️ 更自然：<b>${escapeHtml(f.correction.better)}</b> ${enPlayBtn(f.correction.better)}</div><div class="small muted">${escapeHtml(f.correction.why)}${f.correction.zh ? `（${escapeHtml(f.correction.zh)}）` : ""}・已加入複習卡</div></div>` : ""}
    ${(f.pronunciation || []).length ? `<div class="en-fix">🗣️ ${f.pronunciation.map((p) => `<b>${escapeHtml(p.word)}</b>：${escapeHtml(p.tip)}`).join("<br>")}</div>` : ""}
    ${f.hint_zh ? `<div class="en-fix small">💡 ${escapeHtml(f.hint_zh)}</div>` : ""}
    ${f.no_pron ? `<div class="small muted en-note">（這句改用備援模型聽，沒有發音提示）</div>` : ""}
  </div>`;
}

function enMicBtn(mode, key, extra = "", idle = "🎙") {
  const on = EN.rec?.key === key;
  return `<button type="button" class="btn en-mic${on ? " on" : ""}" data-enmic="${mode}" data-enkey="${key}" ${extra} ${EN.busy && !on ? "disabled" : ""}>${on ? `⏹ ${EN.rec.sec}s` : idle}</button>`;
}

function enChat(s) {
  const sc = enScene(s.scenario);
  return `
    <div class="card en-head">
      <div class="row between"><b>${sc.icon} ${escapeHtml(sc.title)}</b><button type="button" class="btn small" data-enend ${EN.busy ? "disabled" : ""}>結束，看回饋</button></div>
      <ul class="en-goals">${sc.goals.map((g, i) => `<li class="${s.goals_done.includes(i) ? "done" : ""}">${s.goals_done.includes(i) ? "✅" : "⬜"} ${escapeHtml(g)}</li>`).join("")}</ul>
    </div>
    <div class="en-chat" id="en-chat">${s.turns.map(enTurn).join("")}${EN.busy ? `<div class="en-msg tutor"><div class="en-bubble muted">${EN.busyText || "…"}</div></div>` : ""}</div>
    ${EN.hint ? `<div class="card small en-hint">💡 ${escapeHtml(EN.hint.hint_zh)}${EN.hint.examples.map((x) => `<div class="en-ex">${enPlayBtn(x)} ${escapeHtml(x)}</div>`).join("")}</div>` : ""}
    <div class="en-input">
      ${enMicBtn("say", "say")}
      <textarea id="en-input" rows="1" placeholder="用英文回答…（也可以按 🎙 說）" ${EN.busy ? "disabled" : ""}></textarea>
      <button type="button" class="btn primary-sm" data-ensend ${EN.busy ? "disabled" : ""}>送出</button>
    </div>
    <div class="row en-tools">
      <button type="button" class="btn small" data-enhint ${EN.busy ? "disabled" : ""}>💡 不知道怎麼說</button>
      <label class="small"><input type="checkbox" data-enauto ${EN.autoPlay ? "checked" : ""} /> 自動朗讀對方的話</label>
    </div>`;
}

function enReport(s) {
  const sc = enScene(s.scenario);
  const r = s.report || {};
  return `
    <div class="card">
      <h3>${sc.icon} ${escapeHtml(sc.title)}・練習回饋</h3>
      <p>${escapeHtml(r.summary_zh || "")}</p>
      <div class="small">${sc.goals.map((g, i) => `${s.goals_done.includes(i) ? "✅" : "⬜"} ${escapeHtml(g)}`).join("<br>")}</div>
      ${r.did_well?.length ? `<h4>👍 做得好</h4><ul class="en-list">${r.did_well.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
      ${r.better?.length ? `<h4>✏️ 可以說得更自然（已加入複習卡）</h4>${r.better
        .map((x) => `<div class="en-fix"><div class="small muted">你說：${escapeHtml(x.you)}</div><div><b>${escapeHtml(x.better)}</b> ${enPlayBtn(x.better)}</div><div class="small muted">${escapeHtml(x.why)}</div></div>`)
        .join("")}` : ""}
      ${r.phrases?.length ? `<h4>📌 這個情境的實用片語</h4>${r.phrases
        .map((p) => `<div class="en-fix"><b>${escapeHtml(p.en)}</b> ${enPlayBtn(p.en)} <button type="button" class="btn small" data-encard="${enAttr({ en: p.en, zh: p.zh, source: "情境片語" })}">⭐ 收藏</button><div class="small muted">${escapeHtml(p.zh)}</div></div>`)
        .join("")}` : ""}
    </div>
    <div class="row" style="gap:8px"><button type="button" class="btn" data-enstart="${s.scenario}">🔁 再練一次</button><button type="button" class="btn" data-enback>選其他情境</button></div>
    <details class="card small en-log"><summary>看完整對話</summary>${s.turns.map(enTurn).join("")}</details>`;
}

// ---------- 今日一課 ----------

function enCheckHtml(r) {
  if (!r) return "";
  if (r.loading) return `<div class="en-result small muted">AI 正在聽…</div>`;
  if (r.error) return `<div class="en-result small">⚠️ ${escapeHtml(r.error)}</div>`;
  if (r.audio_ok === false) return `<div class="en-result small">沒聽清楚：聲音太小、周圍太吵，或沒有說英文。請再錄一次。</div>`;
  if (r.ok !== undefined)
    return `<div class="en-result">${r.ok ? "✅ 很好！" : "✏️ 可以這樣說："} <b>${escapeHtml(r.better)}</b> ${enPlayBtn(r.better)}<div class="small muted">${escapeHtml(r.why)}</div>${r.praise_zh ? `<div class="small">🌟 ${escapeHtml(r.praise_zh)}</div>` : ""}</div>`;
  const icon = { 很接近: "🎯", 大致正確: "👍", 要再練: "🔁" }[r.match] || "";
  return `<div class="en-result">
    ${r.heard ? `<div class="small muted">AI 聽到：${escapeHtml(r.heard)}</div>` : ""}
    ${r.match ? `<div>${icon} ${escapeHtml(r.match)}${r.missing?.length ? `：注意 ${r.missing.map(escapeHtml).join("、")}` : ""}</div>` : ""}
    ${(r.pronunciation || []).map((p) => `<div>🗣️ <b>${escapeHtml(p.word)}</b>：${escapeHtml(p.tip)}</div>`).join("")}
    ${(r.grammar || []).map((g) => `<div>✏️ <b>${escapeHtml(g.better)}</b> ${enPlayBtn(g.better)}<div class="small muted">${escapeHtml(g.why)}</div></div>`).join("")}
    ${r.better && !(r.grammar || []).length && r.better !== r.heard ? `<div>✏️ 更自然：<b>${escapeHtml(r.better)}</b> ${enPlayBtn(r.better)}</div>` : ""}
    ${r.praise_zh ? `<div class="small">🌟 ${escapeHtml(r.praise_zh)}</div>` : ""}
    ${r.no_pron ? `<div class="small muted">（這次改用備援模型聽，沒有發音提示）</div>` : ""}
  </div>`;
}

function enLesson() {
  const l = EN.state.lesson;
  if (!l)
    return `<div class="card small muted">${EN.busy ? "正在準備今天的課（約 10 秒）…" : "每天一課：6 句真的用得到的英文，先聽、再跟著唸，最後自己造一句。"}</div>${EN.busy ? "" : `<button type="button" class="btn primary-sm" data-enlesson>開始今天的課</button>`}`;
  const level = (EN_LEVELS.find(([v]) => v === l.level) || [])[1] || "";
  return `
    <div class="card"><div class="row between"><b>📖 ${escapeHtml(l.title_zh || l.topic)}</b><span class="small muted">${escapeHtml(l.topic)}・${level}</span></div>
      <p class="small muted">每句先按 🔊 聽，再按 🎙 跟著唸（AI 會說哪裡可以更好）。覺得有用就 ⭐ 收藏到複習卡。</p></div>
    ${l.items
      .map(
        (x, i) => `<div class="card en-item">
      <div class="en-en">${escapeHtml(x.en)}</div><div>${escapeHtml(x.zh)}</div>
      ${x.note ? `<div class="small muted">💡 ${escapeHtml(x.note)}</div>` : ""}${x.pattern ? `<div class="small muted">句型：${escapeHtml(x.pattern)}</div>` : ""}
      <div class="row en-actions">${enPlayBtn(x.en, "🔊 聽")}<button type="button" class="en-play" data-enslow="${escapeHtml(x.en)}">🐢 慢速</button>${enMicBtn("shadow", `l${i}`, `data-entarget="${escapeHtml(x.en)}"`, "🎙 跟讀")}<button type="button" class="btn small" data-encard="${enAttr({ en: x.en, zh: x.zh, note: x.note, source: "今日一課" })}">⭐ 收藏</button></div>
      ${enCheckHtml(EN.results[`l${i}`])}
    </div>`,
      )
      .join("")}
    ${l.task_zh ? `<div class="card"><b>✍️ 造句練習</b><p>${escapeHtml(l.task_zh)}</p>
      <div class="en-input">${enMicBtn("task", "task", `data-entask="${escapeHtml(l.task_zh)}"`)}<textarea id="en-task" rows="1" placeholder="用英文寫一句（也可以按 🎙 說）"></textarea><button type="button" class="btn primary-sm" data-entasksend>送出</button></div>
      ${enCheckHtml(EN.results.task)}</div>` : ""}
    <div class="row en-tools">
      ${l.done ? `<span class="small">✅ 今天的課完成了</span>` : `<button type="button" class="btn primary-sm" data-enlessondone>完成今天的課</button>`}
      <select id="en-topic" aria-label="主題">${EN.state.topics.map((t) => `<option ${t === l.topic ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>
      <button type="button" class="btn small" data-enlessonnew ${EN.busy ? "disabled" : ""}>換這個主題</button>
    </div>`;
}

// ---------- 說一句 ----------

function enSpeak() {
  return `
    <div class="card"><b>🎙 說一句，AI 給你回饋</b>
      <p class="small muted">自由說一段英文（30 秒內）；或先在下面打一句要練的英文，再按錄音跟著唸。AI 會照實寫出它聽到的（包含錯誤），再給文法和發音提示。</p>
      <input id="en-target" placeholder="（選填）要跟讀的英文句子" value="${escapeHtml(EN.target)}" />
      <div class="en-bigmic">${enMicBtn("free", "free", "", "🎙 開始錄音")}</div>
      ${enCheckHtml(EN.results.free)}
    </div>
    <p class="small muted">發音提示是 AI 聽完給的建議，不是精準的發音分數。錄音會送到 Google Gemini 分析（免費方案送出的內容可能被用來改進服務，請不要說個人資料）。</p>`;
}

// ---------- 複習卡 ----------

function enCardList() {
  if (!EN.cards.length) return `<div class="card small muted">還沒有卡片。</div>`;
  return `<div class="list card">${EN.cards
    .map((c) => `<div class="item small"><span>${enPlayBtn(c.en)} <b>${escapeHtml(c.en)}</b><br><span class="muted">${escapeHtml(c.zh)}・${escapeHtml(c.source)}・下次 ${escapeHtml(c.due.slice(5))}</span></span><button type="button" class="btn small" data-endel="${c.id}">刪除</button></div>`)
    .join("")}</div>`;
}

function enReview() {
  const c = EN.state.due[0];
  if (!c)
    return `<div class="card">🎉 今天的卡片都複習完了！<div class="small muted">共 ${EN.state.progress.cards_total} 張卡片。對話裡說得不自然的句子、你收藏的句子會自動變成卡片，隔 1、3、7、14…天各複習一次。</div></div>
      <button type="button" class="btn small" data-encards>${EN.cards ? "重新整理" : "看全部卡片"}</button>${EN.cards ? enCardList() : ""}`;
  return `
    <div class="small muted">今天還有 ${EN.state.due.length} 張</div>
    <div class="card en-flash">
      <div class="small muted">用英文怎麼說？</div>
      <div class="en-zh">${escapeHtml(c.zh || "（先聽英文，想想是什麼意思）")}</div>
      ${EN.reveal
        ? `<div class="en-en">${escapeHtml(c.en)} ${enPlayBtn(c.en)}</div>${c.note ? `<div class="small muted">💡 ${escapeHtml(c.note)}</div>` : ""}
          <div class="row en-grades"><button type="button" class="btn" data-engrade="again">😵 忘了</button><button type="button" class="btn" data-engrade="hard">🤔 模糊</button><button type="button" class="btn primary-sm" data-engrade="good">😄 記得</button></div>`
        : `<div class="row en-grades">${c.zh ? "" : enPlayBtn(c.en, "🔊 聽英文")}<button type="button" class="btn primary-sm" data-enreveal>想好了，看答案</button></div>`}
    </div>`;
}

// ---------- 進度與設定 ----------

function enMe() {
  const p = EN.state.progress;
  const s = EN.state.settings;
  const days = "一二三四五六日";
  return `
    <div class="card en-streak"><div class="en-fire">🔥 ${p.streak}</div>
      <div>連續練習天數${p.today_done ? "（今天已經練了 ✅）" : "（今天還沒練）"}</div>
      <div class="small muted">❄️ 補簽卡 ${p.freezes} 張：連續 7 天送一張（最多存 2 張），哪天忘了練會自動補上${p.freeze_used ? "；昨天已經自動用了一張" : ""}</div></div>
    <div class="card"><b>這週</b>　<span class="small muted">目標 ${s.weekGoal} 天，已練 ${p.week_done} 天</span>
      <div class="en-week">${p.week.map((d, i) => `<span class="${d.done ? "on" : d.frozen ? "frozen" : ""}${d.date === p.today ? " today" : ""}">${days[i]}<br>${d.done ? "✅" : d.frozen ? "❄️" : "・"}</span>`).join("")}</div></div>
    <div class="card small">練了 ${p.practice_days} 天・完成 ${p.sessions} 場情境對話・複習卡 ${p.cards_total} 張（熟記 ${p.cards_learned} 張）</div>
    <div class="card"><h3>設定</h3>
      <label class="row between small"><span>程度</span><select id="en-level">${EN_LEVELS.map(([v, t]) => `<option value="${v}" ${s.level === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="row between small"><span>每週目標（天）</span><select id="en-goal">${[3, 4, 5, 6, 7].map((n) => `<option ${s.weekGoal === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="row between small"><span>晚上 8 點還沒練就通知我</span><input type="checkbox" id="en-remind" ${s.remind ? "checked" : ""} /></label>
      <p class="small muted">要收到通知，先到「設定 → 手機通知」開啟。</p>
      <button type="button" class="btn small danger" data-enreset>清除英語練習紀錄</button>
    </div>
    <p class="small muted">英語家教用你自己的 Gemini 金鑰。對話和錄音會送到 Google Gemini（免費方案送出的內容可能被用來改進服務，請不要說個人資料）。Gemini 的使用條款要求使用者滿 18 歲，這個功能只給大人用。</p>`;
}

// ---------- 動作 ----------

function enScroll() {
  const c = document.querySelector("#en-chat");
  if (c) c.scrollTop = c.scrollHeight;
}

/** iPhone 只有在手指點的當下才能開始播放：先在點擊時解鎖同一個播放器，AI 回覆後才能自動朗讀 */
function enUnlockAudio() {
  EN.audio ??= new Audio();
  if (EN.unlocked) return;
  EN.unlocked = true;
  EN.audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
  EN.audio.play().catch(() => {});
}

function enSpeakLocal(text, rate = 0.95) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = rate;
  const list = typeof voices !== "undefined" && voices.length ? voices : speechSynthesis.getVoices();
  const v = list.find((x) => /^en[-_]US/i.test(x.lang)) || list.find((x) => /^en/i.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

/** 示範發音：先用 Gemini 唸好存起來的音檔（自然的真人聲），不能用時改用手機內建語音 */
async function enPlay(text, rate = 1) {
  EN.audio ??= new Audio();
  let url = EN.cache.get(text);
  if (!url) {
    try {
      const res = await fetch(`/api/english/tts?text=${encodeURIComponent(text)}`);
      if (!res.ok) throw new Error(String(res.status));
      url = URL.createObjectURL(await res.blob());
      EN.cache.set(text, url);
    } catch {
      return enSpeakLocal(text, rate < 1 ? 0.7 : 0.95);
    }
  }
  EN.audio.src = url;
  EN.audio.playbackRate = rate;
  EN.audio.play().catch(() => enSpeakLocal(text, rate < 1 ? 0.7 : 0.95));
}

function enAfterPractice() {
  if (EN.state) EN.state.progress.today_done = true;
  enLoad(false);
}

async function enStart(id) {
  if (EN.busy) return;
  enUnlockAudio();
  EN.busy = true;
  EN.busyText = "準備中…";
  renderPanel();
  const r = await api("/api/english/start", { scenario: id });
  EN.busy = false;
  if (!r.ok) {
    alert(r.error || "開始失敗");
    return renderPanel();
  }
  EN.session = r.session;
  EN.hint = null;
  EN.tab = "talk";
  renderPanel();
  if (EN.autoPlay) enPlay(r.session.turns[0]?.text || "");
}

async function enSay(payload) {
  if (!EN.session || EN.busy) return;
  EN.busy = true;
  EN.busyText = payload.audio ? "AI 正在聽…" : "…";
  EN.hint = null;
  renderPanel();
  const r = await api("/api/english/say", { session: EN.session.id, ...payload });
  EN.busy = false;
  if (!r.ok) {
    alert(r.error || "AI 暫時不能用");
    return renderPanel();
  }
  if (!payload.audio) EN.draft = "";
  EN.session = r.session;
  enAfterPractice();
  renderPanel();
  const last = r.session.turns[r.session.turns.length - 1];
  if (EN.autoPlay && last?.role === "tutor") enPlay(last.text);
}

function blobToBase64(blob) {
  return new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(",")[1] || "");
    fr.onerror = no;
    fr.readAsDataURL(blob);
  });
}

async function enSendAudio(ctx, blob, mime, seconds) {
  const audio = await blobToBase64(blob);
  if (ctx.mode === "say") return enSay({ audio, mime, seconds });
  EN.results[ctx.key] = { loading: true };
  renderPanel();
  const r = await api("/api/english/check", { audio, mime, seconds, target: ctx.target, task: ctx.task });
  EN.results[ctx.key] = r.ok ? r.result : { error: r.error || "AI 暫時不能用" };
  if (r.ok) enAfterPractice();
  renderPanel();
}

async function enMic(el) {
  if (EN.rec) return enRecStop();
  if (EN.busy) return;
  if (!store("en-audio-ok")) {
    if (!confirm("錄音會送到 Google Gemini 分析發音和文法（免費方案送出的內容可能被用來改進服務）。要繼續嗎？")) return;
    store("en-audio-ok", 1);
  }
  const mime = pickAudioMime();
  if (!mime || !navigator.mediaDevices?.getUserMedia) return alert("這個瀏覽器不能錄音，請改用打字");
  enUnlockAudio();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    return alert("沒有麥克風權限：請到手機的設定允許這個 App 使用麥克風");
  }
  const mode = el.dataset.enmic;
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  } catch {
    rec = new MediaRecorder(stream);
  }
  const ctx = {
    mode, key: el.dataset.enkey || mode, rec, stream, t0: Date.now(), sec: 0, cancel: false,
    target: el.dataset.entarget || (mode === "free" ? (document.querySelector("#en-target")?.value || "").trim() : ""),
    task: el.dataset.entask || "",
  };
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(ctx.timer);
    EN.rec = null;
    const seconds = Math.round((Date.now() - ctx.t0) / 1000);
    const blob = new Blob(chunks, { type: rec.mimeType || mime });
    if (ctx.cancel || seconds < 1 || blob.size < 1000) return renderPanel();
    await enSendAudio(ctx, blob, (rec.mimeType || mime).split(";")[0], seconds);
  };
  // 最多錄 30 秒；按鈕上顯示秒數（只改按鈕，不重畫整頁）
  ctx.timer = setInterval(() => {
    ctx.sec = Math.round((Date.now() - ctx.t0) / 1000);
    if (ctx.sec >= 30) return enRecStop();
    document.querySelectorAll(".en-mic.on").forEach((b) => (b.textContent = `⏹ ${ctx.sec}s`));
  }, 500);
  EN.rec = ctx;
  rec.start();
  renderPanel();
}

function enRecStop(cancel = false) {
  if (!EN.rec) return;
  EN.rec.cancel = cancel;
  if (EN.rec.rec.state !== "inactive") EN.rec.rec.stop();
}
// 關掉面板時正在錄的不送出
els.panel.addEventListener("close", () => enRecStop(true));

async function enLessonLoad(body = {}) {
  if (EN.busy) return;
  EN.busy = true;
  renderPanel();
  const r = await api("/api/english/lesson", body);
  EN.busy = false;
  if (!r.ok) alert(r.error || "產生課程失敗");
  else {
    EN.state.lesson = r.lesson;
    EN.results = {};
  }
  renderPanel();
}

async function enSettings(patch) {
  const r = await api("/api/english/settings", patch);
  if (r.ok) EN.state = r;
  renderPanel();
}

function enBind(b) {
  const on = (sel, fn) => b.querySelectorAll(sel).forEach((x) => x.addEventListener("click", (e) => fn(x, e)));
  on("[data-entab]", (x) => {
    EN.tab = x.dataset.entab;
    EN.reveal = false;
    renderPanel();
  });
  on("[data-enplay]", (x) => enPlay(x.dataset.enplay));
  on("[data-enslow]", (x) => enPlay(x.dataset.enslow, 0.75));
  on("[data-enmic]", (x) => enMic(x));
  on("[data-enstart]", (x) => enStart(x.dataset.enstart));
  on("[data-enback]", () => {
    EN.session = null;
    renderPanel();
  });
  on("[data-ensession]", async (x) => {
    const r = await api(`/api/english/session?id=${x.dataset.ensession}`);
    if (!r.ok) return alert(r.error || "讀取失敗");
    EN.session = r.session;
    renderPanel();
  });
  on("[data-ensend]", () => {
    const text = ($("#en-input", b)?.value || "").trim();
    if (!text) return;
    enUnlockAudio();
    EN.draft = text;
    enSay({ text });
  });
  const input = $("#en-input", b);
  input?.addEventListener("input", () => (EN.draft = input.value));
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      b.querySelector("[data-ensend]")?.click();
    }
  });
  on("[data-enhint]", async () => {
    if (!EN.session || EN.busy) return;
    EN.busy = true;
    EN.busyText = "想想看可以怎麼說…";
    renderPanel();
    const r = await api("/api/english/hint", { session: EN.session.id });
    EN.busy = false;
    EN.hint = r.ok ? r : null;
    if (!r.ok) alert(r.error || "AI 暫時不能用");
    renderPanel();
  });
  on("[data-enend]", async () => {
    if (!EN.session || EN.busy) return;
    EN.busy = true;
    EN.busyText = "整理這場的回饋…";
    renderPanel();
    const r = await api("/api/english/end", { session: EN.session.id });
    EN.busy = false;
    if (!r.ok) alert(r.error || "AI 暫時不能用");
    else EN.session = r.session;
    enAfterPractice();
    renderPanel();
  });
  b.querySelector("[data-enauto]")?.addEventListener("change", (e) => {
    EN.autoPlay = e.target.checked;
    store("en-autoplay", EN.autoPlay ? 1 : 0);
  });
  on("[data-encard]", async (x) => {
    const r = await api("/api/english/card_add", JSON.parse(x.dataset.encard));
    x.textContent = r.ok ? (r.added ? "✅ 已收藏" : "已經有了") : "收藏失敗";
    x.disabled = true;
  });
  // 今日一課
  on("[data-enlesson]", () => enLessonLoad());
  on("[data-enlessonnew]", () => enLessonLoad({ topic: $("#en-topic", b)?.value, refresh: true }));
  on("[data-enlessondone]", async () => {
    const r = await api("/api/english/lesson_done", {});
    if (r.ok) {
      EN.state.lesson.done = true;
      EN.state.progress = r.progress;
    }
    renderPanel();
  });
  const task = $("#en-task", b);
  task?.addEventListener("input", () => (EN.taskDraft = task.value));
  on("[data-entasksend]", async () => {
    const text = (task?.value || "").trim();
    if (!text) return;
    EN.results.task = { loading: true };
    renderPanel();
    const r = await api("/api/english/check_text", { text, task: EN.state.lesson?.task_zh || "" });
    EN.results.task = r.ok ? r.result : { error: r.error || "AI 暫時不能用" };
    if (r.ok) enAfterPractice();
    renderPanel();
  });
  // 說一句
  const target = $("#en-target", b);
  target?.addEventListener("input", () => (EN.target = target.value));
  // 複習卡
  on("[data-enreveal]", () => {
    EN.reveal = true;
    renderPanel();
  });
  on("[data-engrade]", async (x) => {
    const c = EN.state.due[0];
    if (!c) return;
    const r = await api("/api/english/review", { id: c.id, grade: x.dataset.engrade });
    EN.state.due.shift();
    if (r.ok) EN.state.progress = r.progress;
    EN.reveal = false;
    renderPanel();
  });
  on("[data-encards]", async () => {
    const r = await api("/api/english/cards");
    EN.cards = r.ok ? r.cards : [];
    renderPanel();
  });
  on("[data-endel]", async (x) => {
    if (!confirm("刪除這張卡片？")) return;
    await api("/api/english/card_delete", { id: Number(x.dataset.endel) });
    EN.cards = EN.cards.filter((c) => c.id !== Number(x.dataset.endel));
    renderPanel();
  });
  // 設定
  $("#en-level", b)?.addEventListener("change", (e) => enSettings({ level: e.target.value }));
  $("#en-goal", b)?.addEventListener("change", (e) => enSettings({ weekGoal: Number(e.target.value) }));
  $("#en-remind", b)?.addEventListener("change", (e) => enSettings({ remind: e.target.checked }));
  on("[data-enreset]", async () => {
    if (!confirm("清除所有英語練習紀錄（對話、複習卡、連續天數）？清除後無法復原。")) return;
    const r = await api("/api/english/reset", {});
    if (r.ok) {
      EN.state = r;
      EN.session = null;
      EN.cards = null;
      EN.results = {};
    }
    renderPanel();
  });
}
