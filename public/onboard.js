// 首頁、建立旅程的引導設置、登入、初始化進度、旅程資料確認頁（也用在設定頁修改旅程）
const screenEl = $("#screen");

function showScreen(html) {
  $("#app").hidden = true;
  screenEl.hidden = false;
  screenEl.innerHTML = `<div class="screen-inner">${html}</div>`;
  screenEl.scrollTop = 0;
  return screenEl;
}

// ================= 首頁 =================

function renderLanding() {
  document.title = "旅伴 AI";
  const trips = store("ta-trips") || [];
  const root = showScreen(`
    <div class="hero">
      <div class="hero-logo">🧳</div>
      <h1>旅伴 AI</h1>
      <p class="muted">家族旅行的 AI 群組助理，也可以當你的個人助理</p>
    </div>
    <ul class="hero-list card">
      <li>💬 全家一起聊天，AI 即時回答</li>
      <li>🗺 找附近美食、景點照片、規劃路線</li>
      <li>💰 記帳分帳，收據拍照就能記</li>
      <li>🌏 中文 ↔ 當地語言翻譯，還能念給對方聽</li>
      <li>⏰ 提醒、每日早報、災害警報、旅遊日記</li>
    </ul>
    <div class="stack">
      <button class="primary on-blue" id="go-new">🧳 建立家庭旅遊</button>
      <button class="btn big-btn" id="go-personal">🙋 建立個人助理<span class="small muted" style="display:block;font-weight:400">只有你看得到，會記得你說過的事</span></button>
      <button class="btn big-btn" id="go-join">🔗 我有旅程連結</button>
      <a class="intro-link" href="/intro">第一次用？看完整介紹與使用方式 →</a>
    </div>
    ${trips.length ? `<h3 class="section-title">最近使用</h3><div class="stack">${trips.map((t) => `
      <a class="trip-link card" href="/t/${escapeHtml(t.id)}"><span class="trip-flag">${escapeHtml(t.flag || "🌏")}</span>
        <span><b>${escapeHtml(t.title)}</b><span class="small muted">${escapeHtml(t.dates || "")}</span></span></a>`).join("")}</div>` : ""}
    <p class="small muted center">建立旅程或個人助理需要邀請碼，請向提供這個網站的人索取。</p>`);
  $("#go-new", root).addEventListener("click", () => {
    W.step = W.invite ? Math.max(W.step, 1) : 0;
    renderWizard();
  });
  $("#go-personal", root).addEventListener("click", renderPersonalSetup);
  $("#go-join", root).addEventListener("click", () => {
    const v = prompt("貼上家人傳給你的旅程網址（或旅程代碼）");
    const code = String(v || "").trim().match(/(?:\/t\/)?([a-z0-9]{6,20})\/?$/)?.[1];
    if (code) location.href = `/t/${code}`;
    else if (v) alert("看不懂這個網址，請確認是完整的旅程網址");
  });
}

// ================= 建立個人助理（只有一頁） =================

function renderPersonalSetup() {
  document.title = "建立個人助理｜旅伴 AI";
  const P = { home: null };
  const root = showScreen(`
    <form id="ps-form" class="card form" novalidate>
      <div class="center"><div class="hero-logo">🙋</div><h2>建立個人助理</h2>
        <p class="small muted">只有你一個人用：會記得你說過的事、幫你設提醒、管待辦和購物清單、收好照片與文件。</p></div>
      ${W.invite ? "" : `<label class="field">邀請碼<input id="ps-invite" autocomplete="off" required /></label>`}
      <label class="field">你的稱呼<input id="ps-name" maxlength="16" placeholder="例如：爸爸、小美" autocomplete="nickname" required /></label>
      <label class="field">你住的地方（選填，天氣和「附近」會用到）
        <div class="row" style="gap:6px"><input id="ps-place" placeholder="例如：台北市大安區" style="flex:1" /><button type="button" class="btn" id="ps-search">搜尋</button></div>
      </label>
      <div id="ps-picks" class="small"></div>
      <label class="field">密碼（至少 6 個字，只有你知道）<input id="ps-pw" type="password" autocomplete="new-password" required /></label>
      <label class="field">再輸入一次密碼<input id="ps-pw2" type="password" autocomplete="new-password" required /></label>
      <details class="small"><summary>網路搜尋金鑰（選填，之後也可以在設定填）</summary>
        <p class="muted">到 <a href="https://app.tavily.com" target="_blank" rel="noopener">app.tavily.com</a> 免費申請，AI 才能上網查資料。</p>
        <input id="ps-tavily" placeholder="tvly-…" autocomplete="off" />
      </details>
      <p id="ps-error" class="error" hidden></p>
      <button type="submit" class="primary" id="ps-go">建立</button>
      <a class="small muted center" href="/">← 回首頁</a>
    </form>`);
  $("#ps-name", root).value = store("ta-name") || "";
  const err = (t) => {
    const el = $("#ps-error", root);
    el.textContent = t;
    el.hidden = !t;
  };
  $("#ps-search", root).addEventListener("click", async () => {
    const q = $("#ps-place", root).value.trim();
    const invite = W.invite || $("#ps-invite", root)?.value.trim();
    if (!q) return;
    if (!invite) return err("請先填邀請碼");
    const picks = $("#ps-picks", root);
    picks.textContent = "搜尋中…";
    const r = await api("/api/places", { q, invite, countryCode: "" });
    if (!r.ok) {
      picks.textContent = r.error || "找不到這個地方";
      return;
    }
    picks.innerHTML = r.places.length
      ? r.places.map((x, i) => `<button type="button" class="btn small" data-i="${i}" style="display:block;margin:4px 0;text-align:left">${escapeHtml(x.address)}</button>`).join("")
      : "找不到，換個寫法試試（例如：大安區）";
    picks.querySelectorAll("[data-i]").forEach((b) =>
      b.addEventListener("click", () => {
        const x = r.places[Number(b.dataset.i)];
        P.home = { city: x.name, address: x.address, lat: x.lat, lon: x.lon };
        picks.innerHTML = `✅ ${escapeHtml(x.address)}`;
      }),
    );
  });
  $("#ps-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    err("");
    const invite = W.invite || $("#ps-invite", root)?.value.trim();
    const name = $("#ps-name", root).value.trim();
    const pw = $("#ps-pw", root).value, pw2 = $("#ps-pw2", root).value;
    if (!invite) return err("請填邀請碼");
    if (!name) return err("請填你的稱呼");
    if (pw.trim().length < 6) return err("密碼至少 6 個字");
    if (pw !== pw2) return err("兩次輸入的密碼不一樣");
    const btn = $("#ps-go", root);
    btn.disabled = true;
    btn.textContent = "建立中…";
    const place = $("#ps-place", root).value.trim();
    const r = await api("/api/personal", {
      invite, name, password: pw, tavilyKey: $("#ps-tavily", root).value.trim(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      home: P.home ?? { city: place, address: "", lat: null, lon: null },
    });
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = "建立";
      return err(r.error || "建立失敗");
    }
    W.invite = invite;
    saveWizard();
    store("ta-name", name);
    location.href = `/t/${r.room}`;
  });
}

// ================= 引導設置 =================

const W = Object.assign(
  { step: 0, invite: "", country: "", city: "", startDate: "", endDate: "", accName: "", accAddress: "", accLat: null, accLon: null, accLabel: "", flights: "", travelers: [{ name: "", kind: "大人" }], me: 0, title: "", roomPassword: "", adminPassword: "", tavilyKey: "", geminiKey: "", tavilyOk: false, geminiOk: false },
  (() => {
    try {
      return JSON.parse(sessionStorage.getItem("ta-wizard") || "{}");
    } catch {
      return {};
    }
  })(),
);

/** 密碼與金鑰不存進瀏覽器，重新整理後要重填 */
function saveWizard() {
  const { roomPassword, adminPassword, tavilyKey, geminiKey, tavilyOk, geminiOk, ...rest } = W;
  try {
    sessionStorage.setItem("ta-wizard", JSON.stringify(rest));
  } catch {}
}

const COUNTRIES = ["日本", "韓國", "泰國", "越南", "新加坡", "馬來西亞", "印尼", "菲律賓", "香港", "澳門", "中國", "美國", "加拿大", "英國", "法國", "德國", "義大利", "西班牙", "瑞士", "奧地利", "捷克", "荷蘭", "土耳其", "澳洲", "紐西蘭", "阿拉伯聯合大公國"];

const STEPS = [
  { title: "邀請碼", icon: "🔑" },
  { title: "目的地", icon: "🌏" },
  { title: "日期", icon: "📅" },
  { title: "住宿", icon: "🏨" },
  { title: "旅伴", icon: "👨‍👩‍👧‍👦" },
  { title: "密碼", icon: "🔒" },
  { title: "API 金鑰", icon: "🔍" },
  { title: "確認", icon: "✅" },
];

function travelersEditor(list, meIndex) {
  return `<div class="trav-list">${list.map((t, i) => `
    <div class="trav-row" data-i="${i}">
      <input class="trav-name" value="${escapeHtml(t.name)}" maxlength="16" placeholder="${["爸爸", "媽媽", "哥哥", "妹妹", "阿公", "阿嬤"][i] || "稱呼"}" />
      <select class="trav-kind"><option ${t.kind === "大人" ? "selected" : ""}>大人</option><option ${t.kind === "小孩" ? "selected" : ""}>小孩</option></select>
      ${meIndex !== undefined ? `<label class="trav-me"><input type="radio" name="me" value="${i}" ${i === meIndex ? "checked" : ""} />我</label>` : ""}
      <button type="button" class="btn small danger trav-del" ${list.length <= 1 ? "disabled" : ""}>✕</button>
    </div>`).join("")}</div>
    <button type="button" class="btn small trav-add">＋ 新增旅伴</button>`;
}

function readTravelers(root) {
  return [...root.querySelectorAll(".trav-row")].map((r) => ({ name: $(".trav-name", r).value.trim(), kind: $(".trav-kind", r).value }));
}

/** 旅伴編輯器：新增、刪除後重畫；onChange 拿到最新名單 */
function bindTravelers(root, list, meIndex, onChange) {
  const wrap = root.querySelector(".trav-wrap");
  const draw = () => {
    wrap.innerHTML = travelersEditor(list, meIndex);
    wrap.querySelector(".trav-add").addEventListener("click", () => {
      list.splice(0, list.length, ...readTravelers(wrap), { name: "", kind: "大人" });
      draw();
    });
    wrap.querySelectorAll(".trav-del").forEach((b) =>
      b.addEventListener("click", () => {
        const i = Number(b.closest(".trav-row").dataset.i);
        const cur = readTravelers(wrap);
        cur.splice(i, 1);
        list.splice(0, list.length, ...cur);
        if (meIndex !== undefined && meIndex >= list.length) meIndex = 0;
        draw();
      }),
    );
    wrap.querySelectorAll("input[name=me]").forEach((r) => r.addEventListener("change", () => (meIndex = Number(r.value))));
    wrap.addEventListener("input", () => onChange?.(readTravelers(wrap), meIndex));
    wrap.addEventListener("change", () => onChange?.(readTravelers(wrap), meIndex));
  };
  draw();
  return () => ({ list: readTravelers(wrap), me: meIndex });
}

function stepBody(i) {
  const year = (W.startDate || new Date().toISOString()).slice(0, 4);
  switch (i) {
    case 0:
      return `<p>建立旅程需要邀請碼，請向提供這個網站的人索取。</p>
        <label class="field">邀請碼<input id="w-invite" value="${escapeHtml(W.invite)}" autocomplete="off" required /></label>`;
    case 1:
      return `<p>要去哪裡玩？AI 會依照目的地查好時區、貨幣、語言、入境規定和常用語。</p>
        <label class="field">國家<input id="w-country" list="w-countries" value="${escapeHtml(W.country)}" placeholder="例如：韓國" required /></label>
        <datalist id="w-countries">${COUNTRIES.map((c) => `<option value="${c}">`).join("")}</datalist>
        <label class="field">主要城市<input id="w-city" value="${escapeHtml(W.city)}" placeholder="例如：首爾（跑好幾個城市就填住最久的）" /></label>`;
    case 2: {
      const days = W.startDate && W.endDate ? Math.round((Date.parse(W.endDate) - Date.parse(W.startDate)) / 86400e3) + 1 : 0;
      return `<p>出發和回程日期（當地日期）。旅程期間 AI 會每天早上發早報、晚上寫旅遊日記。</p>
        <div class="row2"><label class="field">出發<input id="w-start" type="date" value="${escapeHtml(W.startDate)}" required /></label>
        <label class="field">回程<input id="w-end" type="date" value="${escapeHtml(W.endDate)}" required /></label></div>
        <p class="small muted" id="w-days">${days > 0 ? `共 ${days} 天` : ""}</p>`;
    }
    case 3:
      return `<p>住在哪裡？有住宿位置，AI 才能查天氣、找附近、估計程車、教你怎麼回住宿。<b>可以之後再填。</b></p>
        <label class="field">住宿名稱<input id="w-acc-name" value="${escapeHtml(W.accName)}" placeholder="例如：明洞 XX 飯店、Airbnb" /></label>
        <label class="field">地址（當地語言或英文最準）<input id="w-acc-addr" value="${escapeHtml(W.accAddress)}" placeholder="從訂房確認信複製過來" /></label>
        <button type="button" class="btn" id="w-acc-find">📍 在地圖上確認位置</button>
        <div id="w-acc-result" class="small">${W.accLat != null ? `✅ 已定位：${escapeHtml(W.accLabel)}` : ""}</div>
        <label class="field">航班（選填）<textarea id="w-flights" rows="2" placeholder="例如：10/3 BR160 桃園 08:00 → 仁川 11:30">${escapeHtml(W.flights)}</textarea></label>`;
    case 4:
      return `<p>一起去的人有誰？記帳分攤、AI 回答（例如有小孩要考慮體力）都會用到。<b>勾選「我」</b>代表你自己。</p>
        <div class="trav-wrap"></div>`;
    case 5:
      return `<p>設定兩組密碼：</p>
        <label class="field">👨‍👩‍👧 旅伴密碼（至少 4 個字）<input id="w-pw-room" type="text" value="${escapeHtml(W.roomPassword)}" autocomplete="off" />
          <span class="small muted">給家人登入用，和網址一起傳給他們。</span></label>
        <label class="field">🛡 管理員密碼（至少 6 個字）<input id="w-pw-admin" type="text" value="${escapeHtml(W.adminPassword)}" autocomplete="off" />
          <span class="small muted">只有你知道。用這組登入可以修改旅程設定、清除資料。</span></label>`;
    case 6:
      return `<div class="card key-card">
          <h3>🔍 Tavily 搜尋金鑰（必填）</h3>
          <p class="small">AI 查景點、營業時間、票價、找圖片都要靠它。免費方案每月 1,000 次，一趟旅行通常用不完。</p>
          <ol class="small steps">
            <li>打開 <a href="https://app.tavily.com" target="_blank" rel="noopener">app.tavily.com</a>，用 Google 帳號登入（免費，不用信用卡）</li>
            <li>登入後首頁就有 <b>API Key</b>（tvly- 開頭），按旁邊的複製</li>
            <li>貼到下面，按「檢查」</li>
          </ol>
          <div class="row"><input id="w-tavily" value="${escapeHtml(W.tavilyKey)}" placeholder="tvly-…" autocomplete="off" /><button type="button" class="btn" id="w-tavily-check">檢查</button></div>
          <div class="small" id="w-tavily-msg">${W.tavilyOk ? "✅ 可以使用" : ""}</div>
        </div>
        <div class="card key-card">
          <h3>🤖 Gemini 金鑰（選填）</h3>
          <p class="small">平常會先用這個網站提供的免費 AI 額度；<b>額度用完時才改用你的金鑰</b>，旅途中比較不會「AI 暫時無法回答」。</p>
          <ol class="small steps">
            <li>打開 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>，用 Google 帳號登入</li>
            <li>按 <b>Create API key</b>（建立 API 金鑰），複製</li>
            <li>貼到下面，按「檢查」</li>
          </ol>
          <div class="row"><input id="w-gemini" value="${escapeHtml(W.geminiKey)}" placeholder="AIza…（可以留空）" autocomplete="off" /><button type="button" class="btn" id="w-gemini-check">檢查</button></div>
          <div class="small" id="w-gemini-msg">${W.geminiOk ? "✅ 可以使用" : ""}</div>
        </div>
        <p class="small muted">🔐 金鑰會加密保存在這個旅程裡，其他旅伴看不到，之後可以在 ⚙️ 設定更換。</p>`;
    case 7: {
      const t = W.travelers.filter((x) => x.name);
      return `<p>確認一下，按「建立旅程」後 AI 會花 1–2 分鐘查好當地資料，查完你可以再修改。</p>
        <label class="field">旅程名稱<input id="w-title" maxlength="40" value="${escapeHtml(W.title || `${W.city || W.country}旅行 ${year}`)}" /></label>
        <div class="card summary small">
          <div>🌏 ${escapeHtml(W.country)}${W.city ? `・${escapeHtml(W.city)}` : ""}</div>
          <div>📅 ${escapeHtml(W.startDate)} → ${escapeHtml(W.endDate)}</div>
          <div>🏨 ${escapeHtml(W.accName || W.accAddress || "之後再填")}${W.accLat != null ? "（已定位）" : ""}</div>
          <div>👨‍👩‍👧‍👦 ${t.map((x, i) => `${escapeHtml(x.name)}${x.kind === "小孩" ? "（小孩）" : ""}${i === W.me ? "（我）" : ""}`).join("、")}</div>
          <div>🔍 Tavily ✅　🤖 Gemini ${W.geminiKey ? "✅" : "未填（用網站提供的額度）"}</div>
        </div>
        <p class="error" id="w-error" hidden></p>`;
    }
  }
  return "";
}

function renderWizard() {
  document.title = "建立旅程｜旅伴 AI";
  const i = W.step;
  const root = showScreen(`
    <div class="wiz-head">
      <button class="icon" id="w-home" title="回首頁">←</button>
      <div class="wiz-progress">${STEPS.map((s, k) => `<span class="${k < i ? "done" : k === i ? "now" : ""}"></span>`).join("")}</div>
      <span class="small muted">${i + 1}/${STEPS.length}</span>
    </div>
    <h2 class="wiz-title">${STEPS[i].icon} ${STEPS[i].title}</h2>
    <form id="w-form" class="wiz-body" novalidate>${stepBody(i)}
      <p class="error" id="w-step-error" hidden></p>
      <div class="wiz-nav">
        ${i > 0 ? `<button type="button" class="btn big-btn" id="w-back">上一步</button>` : ""}
        <button class="primary" id="w-next">${i === STEPS.length - 1 ? "🚀 建立旅程" : "下一步"}</button>
      </div>
    </form>`);
  $("#w-home", root).addEventListener("click", () => {
    saveWizard();
    renderLanding();
  });
  $("#w-back", root)?.addEventListener("click", () => {
    if (getTrav) Object.assign(W, (({ list, me }) => ({ travelers: list, me }))(getTrav()));
    collectStep(i);
    W.step--;
    saveWizard();
    renderWizard();
  });
  let getTrav = null;
  if (i === 4) {
    getTrav = bindTravelers(root, W.travelers, W.me);
  }
  if (i === 2) {
    const upd = () => {
      const s = $("#w-start", root).value, e = $("#w-end", root).value;
      if (s && !$("#w-end", root).value) $("#w-end", root).value = s;
      const n = s && e ? Math.round((Date.parse(e) - Date.parse(s)) / 86400e3) + 1 : 0;
      $("#w-days", root).textContent = n > 0 ? `共 ${n} 天` : n < 1 && s && e ? "回程不能早於出發" : "";
    };
    $("#w-start", root).addEventListener("change", upd);
    $("#w-end", root).addEventListener("change", upd);
  }
  if (i === 3) {
    $("#w-acc-find", root).addEventListener("click", async () => {
      const q = $("#w-acc-addr", root).value.trim() || $("#w-acc-name", root).value.trim();
      const out = $("#w-acc-result", root);
      if (!q) return (out.textContent = "請先填住宿名稱或地址");
      out.textContent = "搜尋中…";
      const r = await api("/api/places", { invite: W.invite, q });
      if (!r.ok) return (out.textContent = r.error || "搜尋失敗");
      if (!r.places.length) return (out.innerHTML = "地圖上找不到，可以改填英文地址，或直接下一步（之後再補）");
      out.innerHTML = `<div class="muted">選一個正確的位置：</div>${r.places.map((p, k) => `<button type="button" class="place-pick" data-k="${k}">📍 ${escapeHtml(p.address)}</button>`).join("")}`;
      out.querySelectorAll(".place-pick").forEach((b) =>
        b.addEventListener("click", () => {
          const p = r.places[Number(b.dataset.k)];
          Object.assign(W, { accLat: p.lat, accLon: p.lon, accLabel: p.address });
          out.innerHTML = `✅ 已定位：${escapeHtml(p.address)}`;
          saveWizard();
        }),
      );
    });
    // 地址改了，之前的定位就不算數
    $("#w-acc-addr", root).addEventListener("input", () => Object.assign(W, { accLat: null, accLon: null, accLabel: "" }));
  }
  if (i === 6) {
    const check = async (type) => {
      const input = $(`#w-${type}`, root), msg = $(`#w-${type}-msg`, root);
      const key = input.value.trim();
      if (!key) return (msg.textContent = type === "gemini" ? "（留空也可以）" : "請貼上金鑰");
      msg.textContent = "檢查中…";
      const r = await api("/api/check-key", { invite: W.invite, type, key });
      W[`${type}Key`] = key;
      W[`${type}Ok`] = !!r.ok;
      msg.textContent = r.ok ? "✅ 可以使用" : `❌ ${r.error}`;
    };
    $("#w-tavily-check", root).addEventListener("click", () => check("tavily"));
    $("#w-gemini-check", root).addEventListener("click", () => check("gemini"));
    $("#w-tavily", root).addEventListener("input", () => (W.tavilyOk = false));
    $("#w-gemini", root).addEventListener("input", () => (W.geminiOk = false));
  }
  $("#w-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#w-step-error", root);
    err.hidden = true;
    const btn = $("#w-next", root);
    btn.disabled = true;
    try {
      if (getTrav) Object.assign(W, (({ list, me }) => ({ travelers: list, me }))(getTrav()));
      collectStep(i);
      const problem = await validateStep(i);
      if (problem) throw new Error(problem);
      if (i === STEPS.length - 1) return await createTrip();
      W.step++;
      saveWizard();
      renderWizard();
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  root.querySelector("input, textarea")?.focus();
}

function collectStep(i) {
  const v = (id) => $(id)?.value.trim() ?? "";
  if (i === 0) W.invite = v("#w-invite");
  if (i === 1) Object.assign(W, { country: v("#w-country"), city: v("#w-city") });
  if (i === 2) Object.assign(W, { startDate: v("#w-start"), endDate: v("#w-end") });
  if (i === 3) Object.assign(W, { accName: v("#w-acc-name"), accAddress: v("#w-acc-addr"), flights: v("#w-flights") });
  if (i === 5) Object.assign(W, { roomPassword: v("#w-pw-room"), adminPassword: v("#w-pw-admin") });
  if (i === 6) {
    if (v("#w-tavily") !== W.tavilyKey) W.tavilyOk = false;
    if (v("#w-gemini") !== W.geminiKey) W.geminiOk = false;
    Object.assign(W, { tavilyKey: v("#w-tavily"), geminiKey: v("#w-gemini") });
  }
  if (i === 7) W.title = v("#w-title");
}

async function validateStep(i) {
  if (i === 0) {
    if (!W.invite) return "請輸入邀請碼";
    const r = await api("/api/invite", { code: W.invite });
    return r.ok ? null : r.error;
  }
  if (i === 1 && !W.country) return "請填寫國家";
  if (i === 2) {
    if (!W.startDate || !W.endDate) return "請選擇出發和回程日期";
    const days = (Date.parse(W.endDate) - Date.parse(W.startDate)) / 86400e3;
    if (days < 0) return "回程不能早於出發";
    if (days > 60) return "旅程最長 60 天";
  }
  if (i === 4) {
    const names = W.travelers.map((t) => t.name).filter(Boolean);
    if (!names.length) return "至少填一位旅伴";
    if (new Set(names).size !== names.length) return "旅伴的稱呼不能重複";
    const meName = W.travelers[W.me]?.name;
    if (!meName) return "請勾選哪一位是你，並填上稱呼";
    W.travelers = W.travelers.filter((t) => t.name);
    W.me = W.travelers.findIndex((t) => t.name === meName);
  }
  if (i === 5) {
    if (W.roomPassword.length < 4) return "旅伴密碼至少 4 個字";
    if (W.adminPassword.length < 6) return "管理員密碼至少 6 個字";
    if (W.roomPassword === W.adminPassword) return "兩組密碼不能一樣";
  }
  if (i === 6) {
    if (!W.tavilyKey) return "請填 Tavily 金鑰（照上面的步驟申請，免費）";
    for (const type of ["tavily", "gemini"]) {
      const key = W[`${type}Key`];
      if (!key || W[`${type}Ok`]) continue;
      const r = await api("/api/check-key", { invite: W.invite, type, key });
      if (!r.ok) return `${type === "tavily" ? "Tavily" : "Gemini"} 金鑰：${r.error}`;
      W[`${type}Ok`] = true;
    }
  }
  return null;
}

async function createTrip() {
  const me = W.travelers[W.me]?.name;
  const r = await api("/api/rooms", {
    invite: W.invite, title: W.title, country: W.country, city: W.city, startDate: W.startDate, endDate: W.endDate,
    accommodation: { name: W.accName, address: W.accAddress, lat: W.accLat, lon: W.accLon },
    flights: W.flights, travelers: W.travelers, me, roomPassword: W.roomPassword, adminPassword: W.adminPassword,
    tavilyKey: W.tavilyKey, geminiKey: W.geminiKey,
  });
  if (!r.ok) throw new Error(r.error || "建立失敗");
  store("ta-name", me);
  try {
    sessionStorage.removeItem("ta-wizard");
  } catch {}
  location.href = `/t/${r.room}`;
}

// ================= 登入（家人打開旅程網址） =================

async function renderLogin(otherRoom) {
  const info = await fetch(`/api/room/${ROOM}`).then((r) => r.json()).catch(() => null);
  if (!info) {
    showScreen(`<div class="card center"><p>📴 連不上網路，請稍後再試</p></div>`);
    return;
  }
  if (!info.exists) {
    forgetTrip(ROOM);
    showScreen(`<div class="card center"><div class="hero-logo">🤔</div><h2>找不到這個旅程</h2><p class="muted">網址可能打錯了，或旅程已經被刪除。</p><a class="btn" href="/">回首頁</a></div>`);
    return;
  }
  document.title = `${info.title}｜旅伴 AI`;
  const personal = info.kind === "personal";
  const root = showScreen(`
    <form id="login-form" class="login-card card">
      <div class="login-logo">${escapeHtml(info.flag)}</div>
      <h1>${escapeHtml(info.title)}</h1>
      <p class="muted">${personal ? "個人助理・只有本人能進入" : `${escapeHtml(info.startDate)} – ${escapeHtml(info.endDate)}　${escapeHtml(info.country)}${info.city ? `・${escapeHtml(info.city)}` : ""}`}</p>
      ${otherRoom ? `<p class="small notice">這支手機也登入了其他旅程或助理，登入這裡之後兩邊都會保留，可以從首頁切換。</p>` : ""}
      <label class="field">你的稱呼<input id="login-name" maxlength="16" placeholder="${personal ? "建立時填的稱呼" : "例如：爸爸、媽媽、哥哥"}" autocomplete="nickname" required /></label>
      <label class="field">密碼<input id="login-password" type="password" autocomplete="current-password" required /></label>
      <p id="login-error" class="error" hidden></p>
      <button type="submit" class="primary">${personal ? "進入" : "進入群聊"}</button>
      <a class="small muted center" href="/">← 回首頁</a>
    </form>`);
  $("#login-name", root).value = store("ta-name") || "";
  $("#login-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#login-error", root);
    err.hidden = true;
    const btn = $("button[type=submit]", root);
    btn.disabled = true;
    const r = await api("/api/login", { room: ROOM, name: $("#login-name", root).value.trim(), password: $("#login-password", root).value });
    btn.disabled = false;
    if (!r.ok) {
      err.textContent = r.error || "登入失敗";
      err.hidden = false;
      return;
    }
    store("ta-name", r.user.name);
    S.me = r.user;
    startApp();
  });
}

// ================= 初始化進度、等待確認 =================

const INIT_STEPS = ["當地基本資料", "入境與實用資訊", "住宿定位", "常用語", "專屬行李清單"];

function renderInit(progress) {
  const step = Number(progress?.step ?? 0);
  showScreen(`
    <div class="card center">
      <div class="hero-logo spin">🧭</div>
      <h2>${escapeHtml(S.trip?.title || "旅程")} 準備中</h2>
      <p class="muted">AI 正在查當地資料，大約 1–2 分鐘。<br>可以先關掉，完成後再打開這個網址。</p>
    </div>
    <div class="card"><ul class="init-steps">${INIT_STEPS.map((s, k) => `<li class="${k < step ? "done" : k === step ? "now" : ""}">${k < step ? "✅" : k === step ? "⏳" : "⬜"} ${s}</li>`).join("")}</ul></div>`);
}

function renderWaitReview() {
  showScreen(`
    <div class="card center">
      <div class="hero-logo">📝</div>
      <h2>${escapeHtml(S.trip?.title || "旅程")}</h2>
      <p class="muted">管理員正在確認旅程資料，完成後這個畫面會自動進入聊天室。</p>
    </div>`);
}

// ================= 旅程資料表單（確認頁、設定頁共用） =================

const GUIDE_FIELDS = [
  ["entry", "🛂 入境規定"], ["money", "💴 貨幣、付款、小費"], ["power", "🔌 插座電壓"], ["transport", "🚇 交通"],
  ["taxRefund", "🧾 退稅"], ["connectivity", "📶 網路"], ["etiquette", "🙇 禮儀與注意事項"], ["weather", "🌤 天氣與穿著"],
];

function tripForm(t) {
  const a = t.accommodation || {};
  const x = t.taxi || {};
  const f = (name, label, value, attrs = "") => `<label class="field">${label}<input name="${name}" value="${escapeHtml(value ?? "")}" ${attrs} /></label>`;
  return `<form id="trip-form" class="form trip-form" novalidate>
    ${t.initNotes?.length ? `<div class="card notice small">⚠️ 需要你確認：<ul>${t.initNotes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>` : ""}
    <details class="card" open><summary><b>📌 基本資料</b></summary>
      ${f("title", "旅程名稱", t.title, 'maxlength="40"')}
      <div class="row2">${f("country", "國家", t.country)}${f("city", "城市", t.city)}</div>
      <div class="row2">${f("startDate", "出發", t.startDate, 'type="date"')}${f("endDate", "回程", t.endDate, 'type="date"')}</div>
    </details>
    <details class="card" open><summary><b>🌏 當地設定</b></summary>
      <div class="row2">${f("timezone", "時區", t.timezone, 'placeholder="Asia/Seoul"')}${f("countryCode", "國家代碼", t.countryCode, 'maxlength="2" placeholder="KR"')}</div>
      <div class="row2">${f("currency", "貨幣代碼", t.currency, 'maxlength="3" placeholder="KRW"')}${f("currencySymbol", "貨幣符號", t.currencySymbol, 'maxlength="6"')}</div>
      <div class="row2">${f("language", "當地語言", t.language)}${f("langCode", "語言代碼（朗讀用）", t.langCode, 'placeholder="ko-KR"')}</div>
      ${f("readingName", "發音提示名稱（例如 羅馬拼音，不需要就留空）", t.readingName)}
      ${f("emergency", "緊急電話", t.emergency)}
    </details>
    <details class="card" open><summary><b>🏨 住宿</b></summary>
      ${f("accName", "名稱", a.name)}
      ${f("accAddress", "地址", a.address)}
      <input type="hidden" name="accLat" value="${a.lat ?? ""}" /><input type="hidden" name="accLon" value="${a.lon ?? ""}" />
      <div class="row"><span class="small" id="acc-state">${a.lat != null ? "✅ 已定位" : "⚠️ 還沒定位（天氣、附近會先用市中心）"}</span><button type="button" class="btn small" id="acc-find">📍 重新定位</button></div>
      <div id="acc-picks" class="small"></div>
      ${f("accNote", "備註（最近車站、入住時間、門鎖密碼請不要寫這裡）", a.note)}
      <label class="field">航班與交通<textarea name="flights" rows="2">${escapeHtml(t.flights || "")}</textarea></label>
    </details>
    <details class="card"><summary><b>👨‍👩‍👧‍👦 旅伴</b></summary><div class="trav-wrap"></div></details>
    <details class="card"><summary><b>📘 旅遊指南</b>（AI 查的，可修改）</summary>
      ${GUIDE_FIELDS.map(([k, label]) => `<label class="field">${label}<textarea name="g_${k}" rows="3">${escapeHtml(t.guide?.[k] || "")}</textarea></label>`).join("")}
      ${t.guide?.sources?.length ? `<div class="small muted">資料來源：${t.guide.sources.map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a>`).join("、")}</div>` : ""}
    </details>
    <details class="card"><summary><b>🚕 計程車費率</b>（估車資用）</summary>
      <label class="row small"><input type="checkbox" name="taxiOff" ${t.taxi ? "" : "checked"} /> 不知道費率（問車資時 AI 改用網路搜尋）</label>
      <div class="row2">${f("taxiBase", `起跳價（${t.currency || ""}）`, x.base, 'type="number" step="any"')}${f("taxiBaseKm", "起跳公里", x.baseKm, 'type="number" step="any"')}</div>
      <div class="row2">${f("taxiPerKm", "之後每公里", x.perKm, 'type="number" step="any"')}${f("taxiNight", "深夜加成倍數", x.nightMultiplier ?? 1, 'type="number" step="0.05"')}</div>
      <div class="row2">${f("taxiFrom", "深夜開始（時）", x.nightFrom ?? 22, 'type="number" min="0" max="23"')}${f("taxiTo", "深夜結束（時）", x.nightTo ?? 5, 'type="number" min="0" max="23"')}</div>
      ${f("taxiNote", "補充", x.note)}
    </details>
    <p class="error" id="trip-error" hidden></p>
  </form>`;
}

/** 綁定表單互動，回傳讀取修改內容的函式 */
function bindTripForm(root, t) {
  const form = $("#trip-form", root);
  const trav = (t.travelers || []).map((x) => ({ ...x }));
  const getTrav = bindTravelers(form, trav.length ? trav : [{ name: "", kind: "大人" }]);
  $("#acc-find", form).addEventListener("click", async () => {
    const q = form.accAddress.value.trim() || form.accName.value.trim();
    const out = $("#acc-picks", form);
    if (!q) return (out.textContent = "請先填名稱或地址");
    out.textContent = "搜尋中…";
    const r = await api("/api/places", { q, countryCode: form.countryCode.value.trim() });
    if (!r.ok) return (out.textContent = r.error || "搜尋失敗");
    if (!r.places.length) return (out.textContent = "地圖上找不到，可以改用英文地址再試");
    out.innerHTML = r.places.map((p, k) => `<button type="button" class="place-pick" data-k="${k}">📍 ${escapeHtml(p.address)}</button>`).join("");
    out.querySelectorAll(".place-pick").forEach((b) =>
      b.addEventListener("click", () => {
        const p = r.places[Number(b.dataset.k)];
        form.accLat.value = p.lat;
        form.accLon.value = p.lon;
        $("#acc-state", form).textContent = `✅ 已定位：${p.address}`;
        out.innerHTML = "";
      }),
    );
  });
  form.accAddress.addEventListener("input", () => {
    form.accLat.value = "";
    form.accLon.value = "";
    $("#acc-state", form).textContent = "⚠️ 地址改了，請重新定位";
  });
  return () => {
    const v = (n) => form[n].value.trim();
    const num = (n) => (form[n].value === "" ? null : Number(form[n].value));
    const list = getTrav().list.filter((x) => x.name);
    return {
      title: v("title"), country: v("country"), city: v("city"), startDate: v("startDate"), endDate: v("endDate"),
      timezone: v("timezone"), countryCode: v("countryCode"), currency: v("currency"), currencySymbol: v("currencySymbol"),
      language: v("language"), langCode: v("langCode"), readingName: v("readingName"), emergency: v("emergency"), flights: v("flights"),
      accommodation: { name: v("accName"), address: v("accAddress"), lat: num("accLat"), lon: num("accLon"), note: v("accNote") },
      travelers: list,
      guide: Object.fromEntries(GUIDE_FIELDS.map(([k]) => [k, v(`g_${k}`)])),
      taxi: form.taxiOff.checked ? null : {
        base: num("taxiBase"), baseKm: num("taxiBaseKm"), perKm: num("taxiPerKm"), nightMultiplier: num("taxiNight"),
        nightFrom: num("taxiFrom"), nightTo: num("taxiTo"), note: v("taxiNote"),
      },
    };
  };
}

// ================= 確認頁（管理員） =================

function renderReview() {
  const t = S.trip;
  const root = showScreen(`
    <div class="card center">
      <div class="hero-logo">${escapeHtml(t.flag || "🌏")}</div>
      <h2>確認旅程資料</h2>
      <p class="muted small">AI 查好了！請檢查一下，有錯直接修改。確認後家人就能開始用。</p>
    </div>
    ${tripForm(t)}
    <div class="wiz-nav sticky-nav">
      <button class="btn big-btn" id="rv-rerun">🔄 重新查詢</button>
      <button class="primary" id="rv-ok">✅ 確認，開始使用</button>
    </div>`);
  const read = bindTripForm(root, t);
  $("#rv-rerun", root).addEventListener("click", () => {
    if (confirm("重新讓 AI 查一次當地資料？你剛才的修改會被覆蓋。")) action({ action: "rerun_init" });
  });
  $("#rv-ok", root).addEventListener("click", (e) => {
    e.target.disabled = true;
    setTimeout(() => (e.target.disabled = false), 4000);
    action({ action: "activate", profile: read() });
  });
}
