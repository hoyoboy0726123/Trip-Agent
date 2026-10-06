// 健康管家（個人助理）：總覽、記錄、趨勢、用藥、預防保健、健康檔案。
// 數字和判讀都來自伺服器的規則（state.health），這裡只負責顯示和輸入。

ICONS.heart = '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.2 12h4.3l1.5-3 3 6 1.5-3h7.3"/>';
S.healthTab = "home";
let healthResult = null;

const H_TABS = [["home", "總覽"], ["log", "記錄"], ["trend", "趨勢"], ["meds", "用藥"], ["prev", "預防保健"], ["profile", "健康檔案"]];
const GLU_CTX = { fasting: "空腹", pre: "餐前", post: "餐後 2 小時", bed: "睡前", random: "隨機" };
const BP_CTX = { morning: "早上", evening: "晚上", other: "其他時間" };
const fmtBp = (x) => (x ? `${x[0]}/${x[1]}` : "—");
const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function renderHealthPanel(st, b) {
  els.panelTitle.textContent = "🩺 健康管家";
  const h = st.health;
  if (!h) {
    b.innerHTML = `${backToHub()}<div class="card small muted">健康管家還在準備中，請稍後再打開。</div>`;
    return bindBack(b);
  }
  const body = { home: hHome, log: hLog, trend: hTrend, meds: hMeds, prev: hPrev, profile: hProfile }[S.healthTab] || hHome;
  b.innerHTML = `
    ${backToHub()}
    <div class="seg-tabs h-tabs">${H_TABS.map(([k, t]) => `<button type="button" data-htab="${k}" class="${S.healthTab === k ? "on" : ""}">${t}</button>`).join("")}</div>
    <div id="h-body">${body(h)}</div>
    <p class="small muted h-disclaimer">健康管家是健康紀錄整理與衛教參考，不是醫療器材，不提供診斷或治療；用藥或治療請先問醫師或藥師，緊急狀況請撥 119。</p>`;
  bindBack(b);
  b.querySelectorAll("[data-htab]").forEach((x) =>
    x.addEventListener("click", () => {
      S.healthTab = x.dataset.htab;
      healthResult = null;
      renderPanel();
    }),
  );
  b.querySelectorAll("[data-hgo]").forEach((x) =>
    x.addEventListener("click", () => {
      S.healthTab = x.dataset.hgo;
      renderPanel();
    }),
  );
  ({ home: bindHome, log: bindLog, meds: bindMeds, prev: bindPrev, profile: bindProfile }[S.healthTab] || (() => {}))(b, h);
}

// ---------- 總覽 ----------

function hHome(h) {
  const p = h.profile || {};
  const missing = !p.birth || !p.sex || !p.height;
  const bp = h.latest.bp, glu = h.latest.glucose, wt = h.latest.weight;
  const soon = (h.meds || []).filter((m) => m.refill_in != null && m.refill_in >= 0 && m.refill_in <= 7);
  const due = (h.screenings || []).filter((s) => s.status === "due");
  const task = h.task;
  const days = task ? Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.parse(task.start + "T00:00:00Z") + i * 86400e3).toISOString().slice(0, 10);
    const has = (ctx) => (h.vitals || []).some((v) => v.kind === "bp" && v.date === d && v.context === ctx);
    return { d, am: has("morning"), pm: has("evening"), today: d === h.today, first: i === 0 };
  }) : [];
  return `
    ${(h.alerts || []).map((a) => `<div class="card h-alert ${a.level}"><div class="small msg-text">${md(a.text)}</div><button type="button" class="btn small" data-seen="${a.id}">知道了</button></div>`).join("")}
    ${missing ? `<div class="card h-setup"><b>先填健康檔案</b><div class="small muted">性別、生日、身高填好後，才能算 BMI、判斷該做哪些健檢和疫苗。</div><button type="button" class="btn small primary-sm" data-hgo="profile">去填寫</button></div>` : ""}
    <div class="h-grid">
      <button type="button" class="card h-tile" data-hgo="log"><span class="small muted">血壓（最近一次）</span><b class="h-num">${bp ? `${bp.v1}/${bp.v2}` : "—"}</b>
        <span class="small">${bp ? `${escapeHtml(bp.grade)}・${shortDate(bp.date)} ${bp.time}` : "還沒有紀錄"}</span></button>
      <button type="button" class="card h-tile" data-hgo="trend"><span class="small muted">血壓 7 天平均</span><b class="h-num">${fmtBp(h.bp7.all)}</b>
        <span class="small">${h.bp7.count ? `早上 ${fmtBp(h.bp7.morning)}・晚上 ${fmtBp(h.bp7.evening)}・${h.bp7.count} 筆` : "這 7 天沒有紀錄"}</span></button>
      <button type="button" class="card h-tile" data-hgo="log"><span class="small muted">血糖（最近一次）</span><b class="h-num">${glu ? glu.v1 : "—"}</b>
        <span class="small">${glu ? `${escapeHtml(glu.contextLabel || "")}・${escapeHtml(glu.grade)}` : "還沒有紀錄"}</span></button>
      <button type="button" class="card h-tile" data-hgo="log"><span class="small muted">體重</span><b class="h-num">${wt ? wt.v1 : "—"}</b>
        <span class="small">${h.bmi ? `BMI ${h.bmi.value}（${escapeHtml(h.bmi.label)}）` : wt ? "填身高後可以算 BMI" : "還沒有紀錄"}${h.waist ? `・腰圍${escapeHtml(h.waist.label)}` : ""}</span></button>
    </div>
    <div class="card h-722">
      <div class="row between"><h3>722 居家血壓</h3>${task ? `<button type="button" class="btn small" id="h-task-cancel">取消這輪</button>` : ""}</div>
      ${task ? `
        <div class="small muted">連續 7 天、早上（起床 1 小時內、早餐和吃藥前）和睡前各量 2 次。第 1 天不算進平均。</div>
        <div class="h-days">${days.map((d, i) => `<div class="h-day${d.today ? " today" : ""}"><span>${i + 1}</span><i class="${d.am ? "on" : ""}" title="早上"></i><i class="${d.pm ? "on" : ""}" title="晚上"></i></div>`).join("")}</div>
        <div class="small">第 ${Math.min(task.day, 7)} 天・有效 ${task.partial.validDays} 天${task.partial.overall ? `・目前平均 ${fmtBp(task.partial.overall)}` : ""}</div>`
      : h.last722 ? `
        <div class="small">上一輪 ${shortDate(h.last722.start)}–${shortDate(h.last722.end)}：整體平均 <b>${fmtBp(h.last722.overall)}</b>（早上 ${fmtBp(h.last722.morning)}、晚上 ${fmtBp(h.last722.evening)}）${h.last722.valid ? `，${escapeHtml(h.last722.grade?.label || "")}，${h.last722.meetsTarget ? "已達標（<130/80）" : "還沒達標（目標 <130/80）"}` : "，有效天數不足"}</div>
        <div class="small muted">下一輪建議在 ${escapeHtml(h.last722.next)} 左右</div>
        <button type="button" class="btn small primary-sm" id="h-task-start">開始新的一輪</button>`
      : `
        <div class="small muted">台灣高血壓指引以居家「722」平均判斷血壓：連續 7 天、早晚各量 2 次。開始後每天早晚會提醒你。</div>
        <button type="button" class="btn small primary-sm" id="h-task-start">開始 722</button>`}
    </div>
    ${soon.length || due.length ? `<div class="card"><h3>近期要做的事</h3><div class="list">
      ${soon.map((m) => `<button type="button" class="item small link-row" data-hgo="meds">💊 ${escapeHtml(m.name)}：${m.refill_in === 0 ? "今天可以領藥" : `${m.refill_in} 天後可以領藥`}</button>`).join("")}
      ${due.map((s) => `<button type="button" class="item small link-row" data-hgo="prev">📋 ${escapeHtml(s.name)}：該做了（上次 ${escapeHtml(s.last)}）</button>`).join("")}
    </div></div>` : ""}
    <p class="small muted">也可以直接在聊天說「血壓 135/85」「早上空腹血糖 110」「我開始吃降血壓的藥」，健康管家會記下來。</p>`;
}

function bindHome(b) {
  b.querySelectorAll("[data-seen]").forEach((x) => x.addEventListener("click", () => action({ action: "alert_seen", id: Number(x.dataset.seen) })));
  $("#h-task-start", b)?.addEventListener("click", () => action({ action: "task_start" }));
  $("#h-task-cancel", b)?.addEventListener("click", () => confirm("取消這輪 722 量測？已經量的紀錄會留著。") && action({ action: "task_cancel" }));
}

// ---------- 記錄 ----------

function hLog(h) {
  const recent = [...(h.vitals || [])].reverse().slice(0, 25);
  const show = (v) =>
    v.kind === "bp" ? `血壓 <b>${v.v1}/${v.v2}</b>${v.v3 ? `・脈搏 ${v.v3}` : ""}<span class="muted">（${BP_CTX[v.context] || ""}）</span>`
    : v.kind === "glucose" ? `血糖 <b>${v.v1}</b> mg/dL<span class="muted">（${GLU_CTX[v.context] || ""}）</span>`
    : `體重 <b>${v.v1}</b> 公斤${v.v2 ? `・腰圍 ${v.v2} 公分` : ""}`;
  const when = `<details class="h-when"><summary class="small muted">補記之前量的</summary><div class="row" style="gap:6px"><input type="date" name="date" max="${h.today}" /><input type="time" name="time" /></div></details>`;
  return `
    ${healthResult ? `<div class="card h-result"><div class="small"><b>已記錄</b>：${escapeHtml(healthResult.grade || "")}</div>${(healthResult.flags || []).map((f) => `<div class="small msg-text h-flag ${f.level}">${md(f.text)}</div>`).join("")}</div>` : ""}
    <form class="card form h-form" data-kind="bp">
      <h3>血壓</h3>
      <div class="row" style="gap:6px"><input name="v1" inputmode="numeric" placeholder="收縮壓" aria-label="收縮壓（上面的數字）" required /><input name="v2" inputmode="numeric" placeholder="舒張壓" aria-label="舒張壓（下面的數字）" required /><input name="v3" inputmode="numeric" placeholder="脈搏" aria-label="脈搏（選填）" /></div>
      <select name="context"><option value="">時段：依現在時間自動判斷</option><option value="morning">早上（起床 1 小時內、早餐和吃藥前）</option><option value="evening">晚上（睡前 1 小時內）</option><option value="other">其他時間</option></select>
      ${when}
      <button class="btn primary-sm">記錄</button>
      <div class="small muted">量之前坐著休息 5 分鐘、不說話，手臂和心臟同高；每次量 2 次，兩筆都記。</div>
    </form>
    <form class="card form h-form" data-kind="glucose">
      <h3>血糖</h3>
      <div class="row" style="gap:6px"><input name="v1" inputmode="numeric" placeholder="mg/dL" required /><select name="context">${Object.entries(GLU_CTX).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select></div>
      ${when}
      <button class="btn primary-sm">記錄</button>
    </form>
    <form class="card form h-form" data-kind="weight">
      <h3>體重</h3>
      <div class="row" style="gap:6px"><input name="v1" inputmode="decimal" placeholder="公斤" required /><input name="v2" inputmode="decimal" placeholder="腰圍公分（選填）" /></div>
      ${when}
      <button class="btn primary-sm">記錄</button>
    </form>
    <div class="card"><h3>最近的紀錄</h3>
      ${recent.length ? `<div class="list">${recent.map((v) => `<div class="item small"><span>${shortDate(v.date)} ${v.time}　${show(v)}</span><button type="button" class="icon-x" data-hdel="${v.id}" aria-label="刪除">✕</button></div>`).join("")}</div>` : `<div class="small muted">還沒有紀錄。</div>`}
    </div>`;
}

function bindLog(b) {
  b.querySelectorAll(".h-form").forEach((f) =>
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = new FormData(f);
      action({ action: "health_log", kind: f.dataset.kind, v1: d.get("v1"), v2: d.get("v2"), v3: d.get("v3"), context: d.get("context") || "", date: d.get("date") || "", time: d.get("time") || "" });
      f.reset();
      document.activeElement?.blur?.();
    }),
  );
  b.querySelectorAll("[data-hdel]").forEach((x) => x.addEventListener("click", () => confirm("刪除這筆紀錄？") && action({ action: "health_delete", id: Number(x.dataset.hdel) })));
}

// ---------- 趨勢（圖都是程式畫的，不經過 AI） ----------

function hChart(points, opt) {
  const W = 340, H = 170, L = 34, R = 8, T = 10, B = 22;
  if (!points.length) return `<div class="small muted">這段期間沒有紀錄。</div>`;
  const t0 = Date.parse(opt.from + "T00:00:00Z"), t1 = Date.parse(opt.to + "T00:00:00Z") + 86400e3;
  const vals = points.flatMap((p) => p.ys).concat((opt.refs || []).map((r) => r.y));
  const lo = Math.floor((Math.min(...vals) - 5) / 10) * 10, hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
  const x = (d) => L + ((Date.parse(d + "T00:00:00Z") + 43200e3 - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  // 目標線的數字放在左邊刻度的位置，才不會壓到資料點
  const ticks = [lo, hi].filter((t) => !(opt.refs || []).some((r) => Math.abs(y(r.y) - y(t)) < 12));
  const series = (opt.series || [{ idx: 0, cls: "c1" }]).map((s) => {
    const pts = points.map((p) => [x(p.date), y(p.ys[s.idx])]);
    return `<polyline class="h-line ${s.cls}" points="${pts.map((q) => q.join(",")).join(" ")}" />${pts.map((q, i) => `<circle class="h-dot ${s.cls}${points[i].alt ? " alt" : ""}" cx="${q[0]}" cy="${q[1]}" r="3" />`).join("")}`;
  });
  return `<svg class="h-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(opt.label)}">
    ${ticks.map((t) => `<line class="h-grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" /><text class="h-axis" x="${L - 4}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
    ${(opt.refs || []).map((r) => `<line class="h-ref" x1="${L}" x2="${W - R}" y1="${y(r.y)}" y2="${y(r.y)}" /><text class="h-ref-t" x="${L - 4}" y="${y(r.y) + 4}" text-anchor="end">${escapeHtml(r.label)}</text>`).join("")}
    ${series.join("")}
    <text class="h-axis" x="${L}" y="${H - 6}">${shortDate(opt.from)}</text><text class="h-axis" x="${W - R}" y="${H - 6}" text-anchor="end">${shortDate(opt.to)}</text>
  </svg>`;
}

function hTrend(h) {
  const from = (n) => new Date(Date.parse(h.today + "T00:00:00Z") - (n - 1) * 86400e3).toISOString().slice(0, 10);
  const vs = h.vitals || [];
  const bp = vs.filter((v) => v.kind === "bp" && v.date >= from(30)).map((v) => ({ date: v.date, ys: [v.v1, v.v2], alt: v.context === "evening" }));
  const glu = vs.filter((v) => v.kind === "glucose" && v.date >= from(30)).map((v) => ({ date: v.date, ys: [v.v1], alt: v.context !== "fasting" && v.context !== "pre" }));
  const wt = vs.filter((v) => v.kind === "weight" && v.date >= from(120)).map((v) => ({ date: v.date, ys: [v.v1] }));
  return `
    <div class="card"><h3>血壓（30 天）</h3>
      ${hChart(bp, { from: from(30), to: h.today, label: "血壓 30 天", series: [{ idx: 0, cls: "c1" }, { idx: 1, cls: "c2" }], refs: [{ y: 130, label: "130" }, { y: 80, label: "80" }] })}
      <div class="small muted"><span class="h-key c1"></span>收縮壓　<span class="h-key c2"></span>舒張壓　空心點是晚上量的；虛線是目標 130/80（台灣高血壓指引 2022）</div>
      <div class="small">30 天平均 ${fmtBp(h.bp30.all)}（早上 ${fmtBp(h.bp30.morning)}、晚上 ${fmtBp(h.bp30.evening)}）・${h.bp30.count} 筆${h.bp30.belowTarget != null ? `・${h.bp30.belowTarget}% 低於 130/80` : ""}</div>
    </div>
    <div class="card"><h3>血糖（30 天）</h3>
      ${hChart(glu, { from: from(30), to: h.today, label: "血糖 30 天", refs: h.diabetic ? [{ y: 130, label: "130" }, { y: 180, label: "180" }] : [{ y: 100, label: "100" }] })}
      <div class="small muted">實心點是空腹或餐前，空心點是餐後、睡前或隨機。${h.diabetic ? "虛線是目標：餐前 130、餐後 180（ADA 2026）" : "虛線是空腹 100（國健署：100–125 為糖尿病前期範圍）"}</div>
    </div>
    <div class="card"><h3>體重（120 天）</h3>
      ${hChart(wt, { from: from(120), to: h.today, label: "體重 120 天" })}
      ${h.bmi ? `<div class="small">目前 BMI ${h.bmi.value}（${escapeHtml(h.bmi.label)}；國健署：18.5–24 正常、24–27 過重、≥27 肥胖）</div>` : ""}
    </div>`;
}

// ---------- 用藥 ----------

function hMeds(h) {
  const meds = h.meds || [];
  const form = (m = {}) => `
    <form class="card form h-med-form" data-id="${m.id || ""}">
      <h3>${m.id ? "修改" : "新增藥物"}</h3>
      <input name="name" placeholder="藥名（照藥袋寫，例如 脈優錠 Norvasc 5mg）" value="${escapeHtml(m.name || "")}" required />
      <div class="row" style="gap:6px"><input name="dose" placeholder="劑量（例如 5mg）" value="${escapeHtml(m.dose || "")}" /><input name="purpose" placeholder="用途（例如 高血壓）" value="${escapeHtml(m.purpose || "")}" /></div>
      <input name="freq" placeholder="用法（例如 每天早餐後 1 顆）" value="${escapeHtml(m.freq || "")}" />
      <div class="row" style="gap:6px"><label class="small" style="flex:1">慢箋下次可領藥<input type="date" name="refill_next" value="${escapeHtml(m.refill_next || "")}" /></label><label class="small" style="width:7em">還剩幾次<input name="refill_left" inputmode="numeric" value="${m.refill_left ?? ""}" /></label></div>
      <div class="row" style="gap:6px"><button class="btn primary-sm">儲存</button>${m.id ? `<button type="button" class="btn" data-med-cancel>取消</button>` : ""}</div>
    </form>`;
  return `
    ${meds.map((m) => (S.medEdit === m.id ? form(m) : `<div class="card h-med">
      <div class="row between" style="align-items:flex-start;gap:8px"><b>${escapeHtml(m.name)}</b>${m.refill_in != null ? `<span class="tag${m.refill_in <= 3 ? " warn" : ""}">${m.refill_in < 0 ? "已過可領藥日" : m.refill_in === 0 ? "今天可領藥" : `${m.refill_in} 天後可領藥`}</span>` : ""}</div>
      <div class="small">${[m.dose, m.freq].filter(Boolean).map(escapeHtml).join("・") || "<span class='muted'>沒有填劑量和用法</span>"}</div>
      ${m.purpose ? `<div class="small muted">用途：${escapeHtml(m.purpose)}</div>` : ""}
      ${m.refill_next ? `<div class="small muted">慢箋下次可領藥 ${escapeHtml(m.refill_next)}${m.refill_left != null ? `，還剩 ${m.refill_left} 次` : ""}</div>` : ""}
      <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn small" data-med-edit="${m.id}">改</button><button type="button" class="btn small" data-med-stop="${m.id}">停用</button><button type="button" class="btn small danger" data-med-del="${m.id}">刪除</button></div>
    </div>`)).join("")}
    ${meds.length ? "" : `<div class="card small muted">還沒有用藥紀錄。也可以在聊天說「我每天早上吃脈優錠 5mg」。</div>`}
    ${S.medEdit ? "" : form()}
    <p class="small muted">健康管家只記錄，不建議劑量或要不要吃；有疑問請問醫師或藥師。拍藥袋自動讀取、新增藥物時檢查交互作用，會在之後的階段加入。</p>`;
}

function bindMeds(b) {
  b.querySelectorAll(".h-med-form").forEach((f) => {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      action({ action: "med_save", med: { ...d, id: f.dataset.id ? Number(f.dataset.id) : undefined } });
      S.medEdit = null;
      f.reset();
    });
    f.querySelector("[data-med-cancel]")?.addEventListener("click", () => {
      S.medEdit = null;
      renderPanel();
    });
  });
  b.querySelectorAll("[data-med-edit]").forEach((x) => x.addEventListener("click", () => { S.medEdit = Number(x.dataset.medEdit); renderPanel(); }));
  b.querySelectorAll("[data-med-stop]").forEach((x) => x.addEventListener("click", () => confirm("把這個藥標成「停用」？（醫師說停才停）") && action({ action: "med_stop", id: Number(x.dataset.medStop) })));
  b.querySelectorAll("[data-med-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這筆用藥紀錄？") && action({ action: "med_delete", id: Number(x.dataset.medDel) })));
}

// ---------- 預防保健 ----------

function hPrev(h) {
  const list = h.screenings || [];
  if (!h.profile?.birth) return `<div class="card small">先到「健康檔案」填生日和性別，才能算出你該做哪些健檢、癌症篩檢和疫苗。<div style="margin-top:8px"><button type="button" class="btn small primary-sm" data-hgo="profile">去填寫</button></div></div>`;
  const chip = (s) =>
    s.status === "due" ? `<span class="tag warn">該做了</span>`
    : s.status === "ok" ? `<span class="tag ok">下次 ${escapeHtml(s.next)}</span>`
    : s.status === "done" ? `<span class="tag ok">已完成</span>`
    : `<span class="tag">沒有紀錄</span>`;
  const groups = ["健檢", "癌症篩檢", "疫苗"];
  return `
    <p class="small muted">依你的年齡、性別、家族史和生活習慣，列出現在符合資格的項目（國健署、疾管署 2026 年 10 月的規定）。做完填上日期，就會算下一次並提醒你。</p>
    ${groups.map((g) => {
      const items = list.filter((s) => s.group === g);
      return items.length ? `<div class="card"><h3>${g}</h3>${items.map((s) => `
        <div class="h-screen">
          <div class="row between" style="gap:8px;align-items:flex-start"><b class="small">${escapeHtml(s.name)}</b>${chip(s)}</div>
          <div class="small muted">${escapeHtml(s.rule)}</div>
          <label class="small row" style="gap:6px;align-items:center">上次做的日期<input type="date" data-screen="${s.code}" value="${escapeHtml(s.last || "")}" max="${h.today}" /></label>
        </div>`).join("")}</div>` : "";
    }).join("")}`;
}

function bindPrev(b) {
  b.querySelectorAll("[data-screen]").forEach((x) => x.addEventListener("change", () => action({ action: "screen_mark", code: x.dataset.screen, last: x.value || null })));
}

// ---------- 健康檔案 ----------

function hProfile(h) {
  const p = h.profile || {};
  const conds = p.conditions || [];
  const other = conds.filter((c) => !(h.conditionChoices || []).includes(c)).join("、");
  return `
    <form class="card form" id="h-profile">
      <h3>基本資料</h3>
      <div class="row" style="gap:6px">
        <label class="small" style="width:6em">性別<select name="sex"><option value="">—</option><option value="M" ${p.sex === "M" ? "selected" : ""}>男</option><option value="F" ${p.sex === "F" ? "selected" : ""}>女</option></select></label>
        <label class="small" style="flex:1">生日<input type="date" name="birth" value="${escapeHtml(p.birth || "")}" max="${h.today}" /></label>
        <label class="small" style="width:6.5em">身高 cm<input name="height" inputmode="decimal" value="${p.height ?? ""}" /></label>
      </div>
      <h3>慢性病</h3>
      <div class="checks">${(h.conditionChoices || []).map((c) => `<label><input type="checkbox" name="cond" value="${escapeHtml(c)}" ${conds.includes(c) ? "checked" : ""} /> ${escapeHtml(c)}</label>`).join("")}</div>
      <input name="condOther" placeholder="其他（用頓號隔開）" value="${escapeHtml(other)}" />
      <label class="small">過敏（藥物、食物）<input name="allergies" value="${escapeHtml(p.allergies || "")}" placeholder="例如 盤尼西林、花生" /></label>
      <h3>家族史與生活習慣</h3>
      <div class="checks">
        <label><input type="checkbox" name="familyCrc" ${p.familyCrc ? "checked" : ""} /> 一等親有大腸癌</label>
        <label><input type="checkbox" name="familyLung" ${p.familyLung ? "checked" : ""} /> 父母、子女、兄弟姊妹有肺癌</label>
        <label><input type="checkbox" name="betel" ${p.betel ? "checked" : ""} /> 嚼檳榔（含已戒）</label>
        ${p.sex === "F" ? `<label><input type="checkbox" name="pregnant" ${p.pregnant ? "checked" : ""} /> 懷孕中</label>` : ""}
      </div>
      <div class="row" style="gap:6px">
        <label class="small" style="flex:1">吸菸<select name="smoking"><option value="never" ${(p.smoking || "never") === "never" ? "selected" : ""}>從不</option><option value="former" ${p.smoking === "former" ? "selected" : ""}>已戒</option><option value="current" ${p.smoking === "current" ? "selected" : ""}>現在有抽</option></select></label>
        <label class="small" style="width:6em">包年<input name="packYears" inputmode="numeric" value="${p.packYears ?? ""}" /></label>
        <label class="small" style="width:6.5em">戒菸年<input name="quitYear" inputmode="numeric" value="${p.quitYear ?? ""}" placeholder="西元" /></label>
      </div>
      <h3>722 提醒時間</h3>
      <div class="row" style="gap:6px"><label class="small" style="flex:1">早上<input type="time" name="amTime" value="${escapeHtml(p.amTime || "07:30")}" /></label><label class="small" style="flex:1">睡前<input type="time" name="pmTime" value="${escapeHtml(p.pmTime || "21:30")}" /></label></div>
      <button class="btn primary-sm">儲存</button>
      <span class="small muted">包年＝每天抽幾包 × 抽了幾年。這些資料只存在你自己的個人助理裡。</span>
    </form>`;
}

function bindProfile(b) {
  $("#h-profile", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const d = new FormData(f);
    const conditions = [...d.getAll("cond"), ...String(d.get("condOther") || "").split(/[、,，\s]+/).filter(Boolean)];
    action({
      action: "health_profile",
      profile: {
        sex: d.get("sex") || undefined, birth: d.get("birth") || undefined, height: d.get("height") || undefined, conditions, allergies: d.get("allergies") || "",
        familyCrc: !!d.get("familyCrc"), familyLung: !!d.get("familyLung"), betel: !!d.get("betel"), pregnant: !!d.get("pregnant"),
        smoking: d.get("smoking"), packYears: d.get("packYears") || undefined, quitYear: d.get("quitYear") || undefined, amTime: d.get("amTime"), pmTime: d.get("pmTime"),
      },
    });
    document.activeElement?.blur?.();
    S.healthTab = "home";
  });
}
