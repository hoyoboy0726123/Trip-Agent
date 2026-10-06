// 健康管家（個人助理）：總覽、記錄、趨勢、用藥、預防保健、健康檔案。
// 數字和判讀都來自伺服器的規則（state.health），這裡只負責顯示和輸入。

ICONS.heart = '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.2 12h4.3l1.5-3 3 6 1.5-3h7.3"/>';
S.healthTab = "home";
let healthResult = null;

const H_TABS = [["home", "總覽"], ["log", "記錄"], ["trend", "趨勢"], ["labs", "檢驗"], ["meds", "用藥"], ["prev", "預防保健"], ["profile", "健康檔案"]];
const GLU_CTX = { fasting: "空腹", pre: "餐前", post: "餐後 2 小時", bed: "睡前", random: "隨機" };
const BP_CTX = { morning: "早上", evening: "晚上", other: "其他時間", clinic: "健檢／門診" };
const fmtBp = (x) => (x ? `${x[0]}/${x[1]}` : "—");
const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function renderHealthPanel(st, b) {
  els.panelTitle.textContent = "🩺 健康管家";
  const h = st.health;
  if (!h) {
    b.innerHTML = `${backToHub()}<div class="card small muted">健康管家還在準備中，請稍後再打開。</div>`;
    return bindBack(b);
  }
  const body = { home: hHome, log: hLog, trend: hTrend, labs: hLabs, meds: hMeds, prev: hPrev, profile: hProfile }[S.healthTab] || hHome;
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
  ({ home: bindHome, log: bindLog, labs: bindLabs, meds: bindMeds, prev: bindPrev, profile: bindProfile }[S.healthTab] || (() => {}))(b, h);
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
  const waiting = (h.scans || []).filter((s) => s.status === "review");
  return `
    ${waiting.length ? `<div class="card h-setup"><b>有 ${waiting.length} 張照片讀好了，等你確認</b><div class="small muted">對照原圖確認數字後才會存進健康管家。</div><button type="button" class="btn small primary-sm" data-hgo="${waiting[0].kind === "med" ? "meds" : "labs"}">去確認</button></div>` : ""}
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
  const st = opt.step || 10;
  const lo = Math.floor((Math.min(...vals) - st / 2) / st) * st, hi = Math.ceil((Math.max(...vals) + st / 2) / st) * st;
  const x = (d) => L + ((Date.parse(d + "T00:00:00Z") + 43200e3 - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  // 目標線的數字放在左邊刻度的位置，才不會壓到資料點
  const ticks = [lo, hi].filter((t) => !(opt.refs || []).some((r) => Math.abs(y(r.y) - y(t)) < 12));
  const series = (opt.series || [{ idx: 0, cls: "c1" }]).map((s) => {
    const pts = points.map((p) => [x(p.date), y(p.ys[s.idx])]);
    return `<polyline class="h-line ${s.cls}" points="${pts.map((q) => q.join(",")).join(" ")}" />${pts.map((q, i) => `<circle class="h-dot ${s.cls}${points[i].alt ? " alt" : ""}" cx="${q[0]}" cy="${q[1]}" r="3" />`).join("")}`;
  });
  return `<svg class="h-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(opt.label)}">
    ${ticks.map((t) => `<line class="h-grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" /><text class="h-axis" x="${L - 4}" y="${y(t) + 4}" text-anchor="end">${+t.toFixed(2)}</text>`).join("")}
    ${(opt.refs || []).map((r) => `<line class="h-ref" x1="${L}" x2="${W - R}" y1="${y(r.y)}" y2="${y(r.y)}" /><text class="h-ref-t" x="${L - 4}" y="${y(r.y) + 4}" text-anchor="end">${escapeHtml(r.label)}</text>`).join("")}
    ${series.join("")}
    <text class="h-axis" x="${L}" y="${H - 6}">${shortDate(opt.from)}</text><text class="h-axis" x="${W - R}" y="${H - 6}" text-anchor="end">${shortDate(opt.to)}</text>
  </svg>`;
}

function hTrend(h) {
  const from = (n) => new Date(Date.parse(h.today + "T00:00:00Z") - (n - 1) * 86400e3).toISOString().slice(0, 10);
  const vs = h.vitals || [];
  const bp = vs.filter((v) => v.kind === "bp" && v.context !== "clinic" && v.date >= from(30)).map((v) => ({ date: v.date, ys: [v.v1, v.v2], alt: v.context === "evening" }));
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
    ${scanUploading === "med" ? `<div class="card h-scan"><b>照片上傳中…</b></div>` : ""}
    ${(h.scans || []).filter((s) => s.kind === "med").map((s) => scanCard(s, h)).join("")}
    <div class="row h-actions"><button type="button" class="btn primary-sm" data-hscan="med">📷 拍藥袋</button></div>
    ${meds.map((m) => (S.medEdit === m.id ? form(m) : `<div class="card h-med">
      <div class="row between" style="align-items:flex-start;gap:8px"><b>${escapeHtml(m.name)}</b>${m.refill_in != null ? `<span class="tag${m.refill_in <= 3 ? " warn" : ""}">${m.refill_in < 0 ? "已過可領藥日" : m.refill_in === 0 ? "今天可領藥" : `${m.refill_in} 天後可領藥`}</span>` : ""}</div>
      <div class="small">${[m.dose, m.freq].filter(Boolean).map(escapeHtml).join("・") || "<span class='muted'>沒有填劑量和用法</span>"}</div>
      ${m.purpose ? `<div class="small muted">用途：${escapeHtml(m.purpose)}</div>` : ""}
      ${m.note ? `<div class="small muted">${escapeHtml(m.note)}</div>` : ""}
      ${m.refill_next ? `<div class="small muted">慢箋下次可領藥 ${escapeHtml(m.refill_next)}${m.refill_left != null ? `，還剩 ${m.refill_left} 次` : ""}</div>` : ""}
      <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn small" data-med-edit="${m.id}">改</button><button type="button" class="btn small" data-med-stop="${m.id}">停用</button><button type="button" class="btn small danger" data-med-del="${m.id}">刪除</button></div>
    </div>`)).join("")}
    ${meds.length ? "" : `<div class="card small muted">還沒有用藥紀錄。也可以在聊天說「我每天早上吃脈優錠 5mg」。</div>`}
    ${S.medEdit ? "" : form()}
    <p class="small muted">健康管家只記錄，不建議劑量或要不要吃；有疑問請問醫師或藥師。新增藥物時檢查交互作用，會在之後的階段加入。</p>`;
}

function bindMeds(b) {
  bindScans(b);
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

// ---------- 拍照讀取：Gemini 只照抄文字，本人對照原圖確認後才存 ----------

const H_SCAN_INPUT = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", hidden: true });
document.body.append(H_SCAN_INPUT);
let scanUploading = null;
const scanDraft = {};

H_SCAN_INPUT.addEventListener("change", async () => {
  const file = H_SCAN_INPUT.files?.[0];
  H_SCAN_INPUT.value = "";
  if (!file) return;
  const kind = H_SCAN_INPUT.dataset.kind || "lab";
  scanUploading = kind;
  renderPanel();
  try {
    // 報告上的字很小，解析度要比聊天照片高
    let blob = await resizeImage(file, 2200, 0.85);
    if (blob.size > 1_700_000) blob = await resizeImage(file, 1700, 0.8);
    const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": blob.type }, body: blob });
    if (!res.ok) throw new Error(res.status === 507 ? "照片空間已滿" : `照片上傳失敗（${res.status}）`);
    action({ action: "health_scan", kind, photoId: (await res.json()).id });
  } catch (err) {
    alert(err.message || "無法讀取這張照片");
  } finally {
    scanUploading = null;
    if (S.panel === "health") renderPanel();
  }
});

function scanCard(s, h) {
  const src = `/api/photo/${encodeURIComponent(s.photo_id)}`;
  const img = `<a class="h-scan-img" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="原圖" /><span class="small">看原圖</span></a>`;
  const what = s.kind === "med" ? "藥袋" : "報告";
  if (s.status === "reading") return `<div class="card h-scan">${img}<div><b>正在讀取${what}…</b><div class="small muted">大約 10–30 秒。讀完請對照原圖確認，確認後才會存。</div></div></div>`;
  if (s.status === "failed") {
    return `<div class="card h-scan">${img}<div><b>${what}讀取失敗</b><div class="small">${escapeHtml(s.error || "")}</div>
      <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn small" data-scan-retry="${s.id}">重試</button><button type="button" class="btn small" data-scan-discard="${s.id}">放棄</button></div></div></div>`;
  }
  const d = s.data || {};
  const dr = scanDraft[s.id];
  const v = (k, def) => escapeHtml(dr && k in dr ? dr[k] : def ?? "");
  const foot = `<div class="row" style="gap:6px"><button class="btn primary-sm">存進健康管家</button><button type="button" class="btn" data-scan-discard="${s.id}">放棄</button></div>
    <div class="small muted">照片只交給 Gemini 照抄文字，不做判讀；存好後照片會刪掉。</div>`;
  if (s.kind === "lab") {
    const items = d.items || [];
    const unread = items.filter((x) => x.unreadable).length;
    return `<form class="card form h-scan-form" data-scan="${s.id}">
      <div class="h-scan">${img}<div><h3>確認檢驗報告</h3><div class="small muted">對照原圖檢查，有錯直接改；不要的項目取消勾選。</div></div></div>
      ${d.count && d.count !== items.length ? `<div class="small h-flag">原圖有 ${d.count} 項、讀到 ${items.length} 項，請對照有沒有漏掉。</div>` : ""}
      ${unread ? `<div class="small h-flag">有 ${unread} 項看不清楚（黃底），請對照原圖修正或取消勾選。</div>` : ""}
      <label class="small">報告日期${d.dateRaw && !d.date ? `（照片上寫：${escapeHtml(d.dateRaw)}）` : ""}<input type="date" name="date" value="${v("date", d.date)}" max="${h.today}" required /></label>
      <div class="h-scan-items">
        <div class="h-scan-row head small muted"><span></span><span>項目</span><span>結果</span><span>單位</span></div>
        ${items.map((it, i) => `<div class="h-scan-row${it.unreadable ? " warn" : ""}">
          <input type="checkbox" name="use" value="${i}" ${(dr ? dr.use.includes(String(i)) : !!it.value) ? "checked" : ""} aria-label="存這一項" />
          <input name="name${i}" value="${v(`name${i}`, it.name)}" aria-label="項目" />
          <input name="value${i}" value="${v(`value${i}`, it.value)}" aria-label="結果" />
          <input name="unit${i}" value="${v(`unit${i}`, it.unit)}" aria-label="單位" />
          ${it.ref || it.flag || it.prev ? `<span class="small muted h-scan-ref">${[it.ref && `參考值 ${escapeHtml(it.ref)}`, it.flag && `標示 ${escapeHtml(it.flag)}`, it.prev && `上次 ${escapeHtml(it.prev)}`].filter(Boolean).join("・")}</span>` : ""}
        </div>`).join("")}
      </div>
      ${d.note ? `<div class="small muted">報告上的醫師建議：${escapeHtml(d.note)}</div>` : ""}
      ${foot}
    </form>`;
  }
  const brand = (x) => String(x || "").toLowerCase().match(/^[\u4e00-\u9fff]{2,}/)?.[0] || "";
  const same = (h.meds || []).find((m) => brand(m.name) && brand(m.name) === brand(d.name));
  const note = [d.ingredient && `成分：${d.ingredient}`, d.appearance && `外觀：${d.appearance}`, d.side_effects && `副作用：${d.side_effects}`, d.warnings && `注意：${d.warnings}`].filter(Boolean).join("；");
  return `<form class="card form h-scan-form" data-scan="${s.id}">
    <div class="h-scan">${img}<div><h3>確認藥袋</h3><div class="small muted">對照原圖檢查，有錯直接改。</div></div></div>
    <input name="name" value="${v("name", d.name)}" placeholder="藥名" aria-label="藥名" required />
    <div class="row" style="gap:6px"><input name="dose" value="${v("dose", d.strength)}" placeholder="含量" aria-label="含量" /><input name="purpose" value="${v("purpose", d.indication)}" placeholder="用途" aria-label="用途" /></div>
    <input name="freq" value="${v("freq", d.usage)}" placeholder="用法" aria-label="用法" />
    <div class="row" style="gap:6px"><label class="small" style="flex:1">慢箋下次可領藥<input type="date" name="refill_next" value="${v("refill_next", d.refill_next)}" /></label><label class="small" style="width:7em">還剩幾次<input name="refill_left" inputmode="numeric" value="${v("refill_left", d.refill_left)}" /></label></div>
    ${d.refill ? `<div class="small muted">藥袋上的慢箋資訊：${escapeHtml(d.refill)}</div>` : ""}
    ${same ? `<div class="small h-flag">用藥清單裡已經有「${escapeHtml(same.name)}」，存檔會更新那一筆，不會重複。</div>` : ""}
    <textarea name="note" rows="3" placeholder="備註" aria-label="備註">${v("note", note)}</textarea>
    ${foot}
  </form>`;
}

function bindScans(b) {
  b.querySelectorAll("[data-hscan]").forEach((x) =>
    x.addEventListener("click", () => {
      H_SCAN_INPUT.dataset.kind = x.dataset.hscan;
      H_SCAN_INPUT.click();
    }),
  );
  b.querySelectorAll("[data-scan-retry]").forEach((x) => x.addEventListener("click", () => action({ action: "scan_retry", id: Number(x.dataset.scanRetry) })));
  b.querySelectorAll("[data-scan-discard]").forEach((x) => x.addEventListener("click", () => confirm("放棄這張照片的讀取結果？照片會一起刪掉。") && action({ action: "scan_discard", id: Number(x.dataset.scanDiscard) })));
  b.querySelectorAll(".h-scan-form").forEach((f) => {
    // 改到一半收到新狀態會重畫，先把改過的內容記著
    const keep = () => {
      const d = new FormData(f);
      scanDraft[f.dataset.scan] = { ...Object.fromEntries(d), use: d.getAll("use") };
    };
    f.addEventListener("input", keep);
    f.addEventListener("change", keep);
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = Number(f.dataset.scan);
      const d = new FormData(f);
      if (f.querySelector('[name="use"]')) {
        const src = (S.state.health?.scans || []).find((s) => s.id === id)?.data?.items || [];
        const items = d.getAll("use").map((i) => ({ name: d.get(`name${i}`), value: d.get(`value${i}`), unit: d.get(`unit${i}`), ref: src[i]?.ref || "", flag: src[i]?.flag || "" }))
          .filter((x) => String(x.name).trim() && String(x.value).trim());
        if (!items.length) return alert("沒有勾選要存的項目");
        action({ action: "scan_save", id, date: d.get("date"), items });
      } else action({ action: "scan_save", id, med: Object.fromEntries(d) });
      delete scanDraft[id];
    });
  });
}

// ---------- 檢驗 ----------

const labOpen = new Set();
const longDate = (d) => `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function labRow(g) {
  const [a, b] = g.points;
  const diff = a.num != null && b?.num != null ? Math.round((a.num - b.num) * 100) / 100 : 0;
  const nums = g.points.filter((p) => p.num != null).slice().reverse();
  const max = nums.length ? Math.max(...nums.map((p) => p.num)) : 0;
  return `<details class="h-lab${g.warn ? " warn" : ""}" data-lab="${escapeHtml(g.key)}" ${labOpen.has(g.key) ? "open" : ""}>
    <summary>
      <span class="h-lab-name">${escapeHtml(g.name)}</span>
      <span class="h-lab-val"><b>${escapeHtml(a.value)}</b> <span class="small muted">${escapeHtml(a.unit || "")}</span></span>
      <span class="small muted">${longDate(a.date)}${diff ? `・比上次${diff > 0 ? "高" : "低"} ${Math.abs(diff)}` : ""}${g.points.length > 1 ? `・共 ${g.points.length} 次` : ""}</span>
      ${g.note ? `<span class="small h-lab-note">${escapeHtml(g.note)}</span>` : a.ref || a.flag ? `<span class="small muted h-lab-note">${[a.ref && `參考值 ${escapeHtml(a.ref)}`, a.flag && `報告標示 ${escapeHtml(a.flag)}`].filter(Boolean).join("・")}</span>` : ""}
    </summary>
    ${nums.length >= 3 ? hChart(nums.map((p) => ({ date: p.date, ys: [p.num] })), { from: nums[0].date, to: nums[nums.length - 1].date, label: g.name, step: max >= 50 ? 10 : max >= 5 ? 1 : 0.1 }) : ""}
    <div class="list">${g.points.map((p) => `<div class="item small"><span>${longDate(p.date)}　<b>${escapeHtml(p.value)}</b> ${escapeHtml(p.unit || "")}${p.flag ? ` <span class="muted">${escapeHtml(p.flag)}</span>` : ""}${g.code && p.name !== g.name ? ` <span class="muted">（${escapeHtml(p.name)}）</span>` : ""}</span><button type="button" class="icon-x" data-lab-del="${p.id}" aria-label="刪除">✕</button></div>`).join("")}</div>
  </details>`;
}

function hLabs(h) {
  const labs = h.labs || [];
  const known = labs.filter((g) => g.code), other = labs.filter((g) => !g.code);
  const reps = h.reports || [];
  return `
    ${scanUploading === "lab" ? `<div class="card h-scan"><b>照片上傳中…</b></div>` : ""}
    ${(h.scans || []).filter((s) => s.kind === "lab").map((s) => scanCard(s, h)).join("")}
    <div class="row h-actions"><button type="button" class="btn primary-sm" data-hscan="lab">📷 拍檢驗報告</button><button type="button" class="btn" id="h-imp-open">📥 匯入健康存摺</button></div>
    ${importCard()}
    ${labs.length ? "" : `<div class="card small muted">還沒有檢驗紀錄。拍健檢或抽血報告，或匯入健保「健康存摺」，就會整理出歷次數值和判讀。</div>`}
    ${known.length ? `<div class="card"><h3>常見項目</h3>${known.map(labRow).join("")}</div>` : ""}
    ${other.length ? `<div class="card"><h3>其他項目</h3>${other.map(labRow).join("")}</div>` : ""}
    ${reps.length ? `<div class="card"><h3>報告與疫苗</h3>${reps.map((r) => r.kind === "vaccine"
      ? `<div class="h-lab small">💉 ${escapeHtml(r.name)}<span class="muted">・${longDate(r.date)}</span></div>`
      : `<details class="h-lab"><summary><span class="h-lab-name">${escapeHtml(r.name)}</span><span class="small muted">${longDate(r.date)}</span></summary><div class="small msg-text">${escapeHtml(r.value)}</div></details>`).join("")}</div>` : ""}
    <p class="small muted">判讀依台灣血脂指引 2022、國健署、ADA 2026 與 KDIGO 腎臟病分期；沒有判讀的項目請對照報告上的參考值，或請醫師說明。</p>`;
}

function bindLabs(b) {
  bindScans(b);
  b.querySelectorAll("details.h-lab[data-lab]").forEach((x) => x.addEventListener("toggle", () => (x.open ? labOpen.add(x.dataset.lab) : labOpen.delete(x.dataset.lab))));
  b.querySelectorAll("[data-lab-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這筆檢驗數值？") && action({ action: "lab_delete", id: Number(x.dataset.labDel) })));
  $("#h-imp-open", b)?.addEventListener("click", () => {
    hImp = { stage: "pick" };
    renderPanel();
  });
  b.querySelectorAll("[data-imp-pick]").forEach((x) => x.addEventListener("click", () => H_IMPORT_INPUT.click()));
  b.querySelectorAll("[data-imp-close]").forEach((x) =>
    x.addEventListener("click", () => {
      hImp = null;
      renderPanel();
    }),
  );
  $("#h-imp-pw", b)?.addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = String(new FormData(e.target).get("pw") || "");
    const { bytes, name } = hImp;
    hImp = { stage: "busy", text: "解壓縮中…" };
    renderPanel();
    openBankFile(bytes, name, pw);
  });
  $("#h-imp-go", b)?.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = hImp.data;
    const meds = new FormData(e.target).getAll("med").map((i) => d.meds[Number(i)]);
    const parts = importParts({ ...d, meds });
    hImp = { stage: "busy", text: "匯入中…", parts: parts.length, got: [] };
    renderPanel();
    parts.forEach((data) => action({ action: "health_import", data }));
  });
}

// ---------- 健康存摺匯入：檔案在手機上解析，只送需要的欄位 ----------

let hImp = null;
const H_IMPORT_INPUT = Object.assign(document.createElement("input"), { type: "file", accept: ".json,.zip,application/json,application/zip", hidden: true });
document.body.append(H_IMPORT_INPUT);

H_IMPORT_INPUT.addEventListener("change", async () => {
  const file = H_IMPORT_INPUT.files?.[0];
  H_IMPORT_INPUT.value = "";
  if (!file) return;
  if (file.size > 30e6) {
    hImp = { stage: "error", error: "檔案太大（超過 30MB）" };
    return renderPanel();
  }
  hImp = { stage: "busy", text: "讀取檔案中…" };
  renderPanel();
  openBankFile(new Uint8Array(await file.arrayBuffer()), file.name, "");
});

async function openBankFile(bytes, name, password) {
  try {
    const text = bytes[0] === 0x50 && bytes[1] === 0x4b ? await unzipJson(bytes, password) : new TextDecoder().decode(bytes);
    hImp = { stage: "preview", data: parseHealthBank(text, S.state.health.today), name };
  } catch (e) {
    hImp = e.code === "password" ? { stage: "password", bytes, name, error: password ? "密碼不對，請再試一次" : "" } : { stage: "error", error: e.message || "讀不出這個檔案" };
  }
  if (S.panel === "health") renderPanel();
}

function importDone(result) {
  if (!hImp || hImp.stage !== "busy" || !hImp.got) return;
  hImp.got.push(result);
  if (hImp.got.length < hImp.parts) return;
  const sum = {};
  for (const r of hImp.got) for (const [k, v] of Object.entries(r)) sum[k] = typeof v === "number" ? (sum[k] || 0) + v : sum[k] || v;
  hImp = { stage: "done", result: sum };
  if (S.panel === "health") renderPanel();
}

/** WebSocket 一則訊息不能太大：檢驗和報告分批送 */
function importParts(data) {
  const parts = [{ ...data, labs: [], reports: [] }];
  let size = JSON.stringify(parts[0]).length;
  for (const key of ["labs", "reports"]) {
    for (const it of data[key]) {
      const n = JSON.stringify(it).length + 1;
      if (size + n > 250_000) {
        parts.push({ labs: [], reports: [] });
        size = 30;
      }
      parts[parts.length - 1][key].push(it);
      size += n;
    }
  }
  return parts;
}

function importCard() {
  if (!hImp) return "";
  const close = `<button type="button" class="btn small" data-imp-close>關閉</button>`;
  if (hImp.stage === "pick") {
    return `<div class="card h-import"><h3>匯入健康存摺</h3>
      <ol class="small"><li>在「健保快易通」APP 或健保署網站的「健康存摺」下載資料，格式選 <b>JSON</b>。</li><li>在這裡選擇下載的檔案（.json 或 .zip）；有設密碼的壓縮檔會再問你密碼。</li></ol>
      <div class="small muted">檔案在你的手機上解析，只把檢驗、用藥、疫苗、篩檢、過敏和健檢數值存進你的個人助理；身分證字號、就醫費用等其他欄位不會上傳。</div>
      <div class="row" style="gap:6px;margin-top:8px"><button type="button" class="btn primary-sm" data-imp-pick>選擇檔案</button>${close}</div></div>`;
  }
  if (hImp.stage === "busy") return `<div class="card h-import"><b>${escapeHtml(hImp.text || "處理中…")}</b></div>`;
  if (hImp.stage === "password") {
    return `<form class="card form h-import" id="h-imp-pw"><h3>輸入壓縮檔密碼</h3><div class="small muted">${escapeHtml(hImp.name)} 有加密，請輸入下載時設定的密碼。</div>
      ${hImp.error ? `<div class="small h-flag">${escapeHtml(hImp.error)}</div>` : ""}
      <input type="password" name="pw" autocomplete="off" aria-label="壓縮檔密碼" required /><div class="row" style="gap:6px"><button class="btn primary-sm">解開</button>${close}</div></form>`;
  }
  if (hImp.stage === "error") return `<div class="card h-import"><div class="small h-flag">${escapeHtml(hImp.error)}</div><div class="row" style="gap:6px;margin-top:8px"><button type="button" class="btn small" data-imp-pick>重新選擇</button>${close}</div></div>`;
  if (hImp.stage === "done") {
    const r = hImp.result;
    const parts = [[r.labs, "檢驗數值", "筆"], [r.reports, "報告", "份"], [r.vaccines, "疫苗", "筆"], [r.vitals, "健檢量測", "筆"], [r.screens, "篩檢與健檢日期", "項"], [r.meds, "用藥", "種"], [r.allergies, "過敏", "項"]].filter(([n]) => n).map(([n, t, u]) => `${t} ${n} ${u}`);
    return `<div class="card h-import"><h3>匯入完成 ✅</h3><div class="small">${parts.length ? `新增：${parts.join("、")}` : "沒有新的資料"}${r.skipped ? `；${r.skipped} 筆已經有了，略過` : ""}${r.height ? "；已補上身高" : ""}。</div><div style="margin-top:8px">${close}</div></div>`;
  }
  const d = hImp.data;
  const dates = d.labs.map((x) => x.date).sort();
  return `<form class="card form h-import" id="h-imp-go"><h3>要匯入的資料</h3>
    <div class="small muted">${escapeHtml(hImp.name)}${d.downloaded ? `・${longDate(d.downloaded)} 下載` : ""}</div>
    <ul class="small h-imp-list">
      <li>檢驗數值 ${d.labs.length} 筆${dates.length ? `（${longDate(dates[0])}–${longDate(dates[dates.length - 1])}）` : ""}</li>
      <li>影像、病理、癌症篩檢報告 ${d.reports.length} 份</li>
      <li>疫苗 ${d.vaccines.length} 筆；篩檢與健檢日期 ${d.screens.length} 筆</li>
      <li>健檢量的血壓、體重 ${d.vitals.length} 筆（標成「健檢／門診」，不算進居家血壓平均）</li>
      <li>過敏紀錄 ${d.allergies.length} 筆</li>
    </ul>
    ${d.meds.length ? `<h3>最近 60 天的處方藥</h3><div class="small muted">勾選現在還在吃的，會加到用藥清單（之後可以再改）。</div>
      <div class="h-imp-meds">${d.meds.map((m, i) => `<label class="small"><input type="checkbox" name="med" value="${i}" ${m.current ? "checked" : ""} /> <span><b>${escapeHtml(m.name)}</b><span class="muted">　${longDate(m.date)}・${m.days} 天${m.inst ? `・${escapeHtml(m.inst)}` : ""}</span></span></label>`).join("")}</div>` : `<div class="small muted">最近 60 天沒有處方藥紀錄。</div>`}
    <div class="row" style="gap:6px"><button class="btn primary-sm">匯入</button>${close}</div>
  </form>`;
}

/** 讀 zip 裡的 .json：支援沒加密和傳統 ZIP 密碼；AES 加密請使用者先自己解壓縮 */
async function unzipJson(u8, password) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("壓縮檔壞掉了，請重新下載");
  const entries = [];
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0 && dv.getUint32(p, true) === 0x02014b50; n--) {
    const nameLen = dv.getUint16(p + 28, true);
    entries.push({
      flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true), time: dv.getUint16(p + 12, true), crc: dv.getUint32(p + 16, true),
      size: dv.getUint32(p + 20, true), offset: dv.getUint32(p + 42, true), name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const e = entries.find((x) => /\.json$/i.test(x.name)) || entries.find((x) => !x.name.endsWith("/"));
  if (!e) throw new Error("壓縮檔裡找不到 .json 檔");
  if (e.method === 99) throw new Error("這個壓縮檔用 AES 加密，瀏覽器解不開；請先在手機或電腦解壓縮，再選裡面的 .json 檔");
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  let data = u8.subarray(start, start + e.size);
  if (e.flags & 1) {
    if (!password) throw Object.assign(new Error("需要密碼"), { code: "password" });
    data = zipDecrypt(data, password, e.flags & 8 ? (e.time >>> 8) & 0xff : e.crc >>> 24);
  }
  if (e.method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  else if (e.method !== 0) throw new Error("不支援這種壓縮方式，請先解壓縮再選 .json 檔");
  return new TextDecoder().decode(data);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 傳統 ZIP 密碼（ZipCrypto）：前 12 bytes 是加密標頭，最後一個 byte 用來檢查密碼 */
function zipDecrypt(data, password, check) {
  let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  const crc = (c, b) => (CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  const update = (b) => {
    k0 = crc(k0, b);
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k2 = crc(k2, k1 >>> 24);
  };
  for (const b of new TextEncoder().encode(password)) update(b);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const t = (k2 | 2) & 0xffff;
    out[i] = data[i] ^ (((t * (t ^ 1)) >>> 8) & 0xff);
    update(out[i]);
  }
  if (out[11] !== check) throw Object.assign(new Error("密碼不對"), { code: "password" });
  return out.subarray(12);
}

/** 健康存摺「醫療類」JSON（健保署 IHK_JSON 格式）→ 要存的欄位 */
function parseHealthBank(text, today) {
  text = text.replace(/^﻿/, "");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    try {
      // 有些下載檔的字串裡夾著 TAB 等控制字元
      obj = JSON.parse(text.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      throw new Error("這不是有效的 JSON 檔");
    }
  }
  const b = obj?.myhealthbank?.bdata;
  if (!b) throw new Error("這不是健康存摺的醫療資料（找不到 myhealthbank）");
  const sec = {};
  for (const [k, v] of Object.entries(b)) sec[k.toLowerCase()] = Array.isArray(v) ? v.filter((r) => r && typeof r === "object" && !(Object.keys(r).length === 1 && Object.values(r)[0] === "無資料")) : v;
  const s = (v) => String(v ?? "").trim();
  const d8 = (v) => (/^\d{8}$/.test(s(v)) ? `${s(v).slice(0, 4)}-${s(v).slice(4, 6)}-${s(v).slice(6, 8)}` : null);
  const pos = (v) => (s(v) && Number.isFinite(Number(s(v))) && Number(s(v)) > 0 ? Number(s(v)) : null);
  const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
  const out = { downloaded: d8(b["b1.2"]), labs: [], reports: [], vaccines: [], vitals: [], screens: [], allergies: [], meds: [], height: null };
  const nums = (date, rec, list) => list.forEach(([k, name, unit]) => pos(rec[k]) != null && out.labs.push({ date, name, value: String(pos(rec[k])), unit, ref: "" }));
  const bp = (date, rec, ks, ksd) => pos(rec[ks]) && pos(rec[ksd]) && out.vitals.push({ kind: "bp", date, v1: pos(rec[ks]), v2: pos(rec[ksd]) });
  // r7 檢驗、r8 影像與病理報告
  for (const r of sec.r7 || []) {
    const date = d8(r["r7.6"]) || d8(r["r7.5"]), name = s(r["r7.10"]) || s(r["r7.9"]), value = s(r["r7.11"]);
    if (date && name && value) out.labs.push({ date, name, value, unit: "", ref: s(r["r7.12"]) });
  }
  for (const r of sec.r8 || []) {
    const date = d8(r["r8.6"]) || d8(r["r8.5"]), name = s(r["r8.9"]), value = s(r["r8.10"]).replace(/\s+/g, " ").slice(0, 2000);
    if (date && name && value) out.reports.push({ date, name, value });
  }
  // r10 成人預防保健
  let heightDate = "";
  for (const r of sec.r10 || []) {
    const date = d8(r["r10.5"]);
    if (!date) continue;
    out.screens.push({ code: "adult", date });
    nums(date, r, [["r10.14", "總膽固醇", "mg/dL"], ["r10.15", "三酸甘油酯", "mg/dL"], ["r10.16", "HDL 高密度膽固醇", "mg/dL"], ["r10.17", "LDL 低密度膽固醇", "mg/dL"], ["r10.20", "空腹血糖", "mg/dL"],
      ["r10.23", "尿素氮 BUN", "mg/dL"], ["r10.24", "肌酸酐", "mg/dL"], ["r10.25", "eGFR", "mL/min/1.73m²"], ["r10.31", "AST(GOT)", "U/L"], ["r10.32", "ALT(GPT)", "U/L"]]);
    bp(date, r, "r10.10", "r10.11");
    // 腰圍欄位可能是吋
    let waist = pos(r["r10.9"]);
    if (waist && waist < 60) waist = Math.round(waist * 25.4) / 10;
    if (pos(r["r10.7"])) out.vitals.push({ kind: "weight", date, v1: pos(r["r10.7"]), v2: waist });
    if (pos(r["r10.6"]) && date > heightDate) {
      out.height = pos(r["r10.6"]);
      heightDate = date;
    }
    if (["1", "2"].includes(s(r["r10.35"])) || ["1", "2"].includes(s(r["r10.39"]))) out.screens.push({ code: "hbc", date });
  }
  // R12 糖尿病、R13 初期慢性腎病追蹤
  for (const r of sec.r12 || []) {
    for (const x of r.r12_1 || r.R12_1 || []) {
      const date = d8(x["r12_1.3"]) || d8(x["r12_1.2"]);
      if (!date) continue;
      nums(date, x, [["r12_1.7", "糖化血色素 HbA1c", "%"], ["r12_1.8", "LDL 低密度膽固醇", "mg/dL"], ["r12_1.9", "空腹血糖", "mg/dL"], ["r12_1.10", "肌酸酐", "mg/dL"], ["r12_1.11", "eGFR", "mL/min/1.73m²"], ["r12_1.12", "三酸甘油酯", "mg/dL"], ["r12_1.13", "尿液微量白蛋白", ""]]);
      bp(d8(x["r12_1.2"]) || date, x, "r12_1.5", "r12_1.6");
    }
  }
  for (const r of sec.r13 || []) {
    for (const x of r.r13_1 || r.R13_1 || []) {
      const date = d8(x["r13_1.2"]);
      if (!date) continue;
      nums(date, x, [["r13_1.5", "eGFR", "mL/min/1.73m²"], ["r13_1.6", "尿蛋白／肌酸酐比 UPCR", ""], ["r13_1.7", "肌酸酐", "mg/dL"], ["r13_1.8", "LDL 低密度膽固醇", "mg/dL"], ["r13_1.9", "糖化血色素 HbA1c", "%"], ["r13_1.10", "尿液微量白蛋白", ""]]);
      bp(date, x, "r13_1.3", "r13_1.4");
    }
  }
  // r11 癌症篩檢：結果存成報告，日期更新到預防保健
  const SCREEN = [[/大腸/, "fit"], [/乳/, "mammo"], [/子宮頸/, "pap"], [/口腔/, "oral"], [/肺/, "ldct"], [/胃|幽門/, "hp"]];
  for (const r of sec.r11 || []) {
    const cat = s(r["r11.1"]), item = s(r["r11.2"]);
    let code = SCREEN.find(([re]) => re.test(cat + item))?.[1];
    if (code === "pap" && /HPV/i.test(item)) code = "hpv";
    for (const x of r.r11_1 || []) {
      const date = d8(x["r11_1.1"]);
      if (!date) continue;
      if (code) out.screens.push({ code, date });
      const value = (s(x["r11_1.4"]) || s(x["r11_1.3"])).replace(/\s+/g, " ");
      if (value) out.reports.push({ date, name: item ? `${cat}（${item}）` : cat, value });
    }
  }
  // r6 疫苗
  const VACCINE = [[/流感/, "flu"], [/新冠|COVID|SARS-CoV/i, "covid"], [/肺炎|PCV|PPV/i, "pneumo"], [/帶狀皰疹|欣克疹|Shingrix/i, "zoster"], [/破傷風|白喉|百日咳|Tdap/i, "tdap"]];
  for (const r of sec.r6 || []) {
    const date = d8(r["r6.1"]), name = s(r["r6.3"]);
    if (!date || !name) continue;
    out.vaccines.push({ date, name });
    const code = VACCINE.find(([re]) => re.test(name))?.[1];
    if (code) out.screens.push({ code, date });
  }
  // r4 過敏
  for (const r of sec.r4 || []) {
    const drug = s(r["r4.2"]), sym = s(r["r4.10"]);
    if (drug) out.allergies.push(sym ? `${drug}（${sym.slice(0, 30)}）` : drug);
  }
  // r1 西醫門診的藥（健保藥品代碼 10 碼；檢查、處置不算）：同一種藥只留最近一次
  const meds = new Map();
  for (const r of sec.r1 || []) {
    const date = d8(r["r1.5"]) || d8(r["r1.6"]);
    if (!date) continue;
    for (const x of r.r1_1 || []) {
      const code = s(x["r1_1.1"]).toUpperCase(), name = s(x["r1_1.2"]);
      if (!/^[A-Z]{1,2}\d{8,9}$/.test(code) || code.length !== 10 || !name) continue;
      if ((meds.get(code)?.date || "") >= date) continue;
      meds.set(code, { code, name, date, days: Number(s(x["r1_1.4"])) || 0, inst: s(r["r1.4"]), diag: s(r["r1.9"]) });
    }
  }
  out.meds = [...meds.values()]
    .map((m) => ({ ...m, end: addDays(m.date, Math.max(m.days, 1)) }))
    .filter((m) => m.end >= addDays(today, -60))
    .map((m) => ({ ...m, current: m.end >= addDays(today, -7) }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40);
  return out;
}
