// 旅伴 AI 聊天室：即時群聊（WebSocket）、照片、定位、行程／記帳／記憶面板、工具箱、翻譯
const els = {
  app: $("#app"), messages: $("#messages"), loadMore: $("#load-more"), toLatest: $("#to-latest"), toLatestN: $("#to-latest-n"), conn: $("#conn"),
  dayBadge: $("#day-badge"), todayTitle: $("#today-title"), online: $("#online"), avatars: $("#avatars"), chips: $("#chips"),
  nextCard: $("#next-card"), ncToggle: $("#nc-toggle"), chipsToggle: $("#chips-toggle"), tabbar: $("#tabbar"), more: $("#more"), moreActions: $("#more-actions"), moreAsks: $("#more-asks"),
  input: $("#input"), sendForm: $("#send-form"), sendBtn: $("#send-btn"), photoInput: $("#photo-input"),
  attach: $("#attach"), attachImg: $("#attach-img"), attachLoc: $("#attach-loc"), attachClear: $("#attach-clear"),
  panel: $("#panel"), panelTitle: $("#panel-title"), panelBody: $("#panel-body"), panelClose: $("#panel-close"),
  viewer: $("#viewer"), viewerImg: $("#viewer-img"), viewerDl: $("#viewer-dl"),
  translator: $("#translator"), trBody: $("#tr-body"), trTabs: $("#tr-tabs"),
  showcase: $("#showcase"),
};

const COLORS = ["#e4572e", "#2e86ab", "#7b2cbf", "#f29e4c", "#17a398", "#d81159", "#3a86ff", "#8338ec"];
const colorFor = (name) => COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const lang = () => S.trip?.language || "當地語言";
const hasTranslator = () => !!S.trip && !/^zh/i.test(S.trip.langCode || "");

// 方案 A 的線條圖示（路徑取自 Lucide）
const ICONS = {
  luggage: '<path d="M6 20a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2"/><path d="M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 8h8M8 12h8"/>',
  lang: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  exchange: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  train: '<rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16M12 3v8M8 19l-2 3M18 22l-2-3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  list: '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
};
const svg = (name, cls = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ""}>${ICONS[name] ?? ""}</svg>`;

// ================= 進入旅程 =================

async function checkSession() {
  let res;
  try {
    res = await fetch(`/api/me?room=${ROOM}`);
  } catch {
    // 沒網路：用上次的資料進入離線模式（常用句、票券還能用）
    const trip = store(`ta-trip-${ROOM}`);
    if (trip) {
      S.me = { name: store("ta-name") || "我", admin: false };
      S.offline = true;
      applyTrip(trip);
      showApp();
      els.conn.hidden = false;
      els.conn.textContent = "📴 離線中：翻譯常用句與票券仍可使用";
      setTimeout(connect, 5000);
      return;
    }
    showScreen(`<div class="card center"><p>📴 連不上網路，請稍後再試</p></div>`);
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
    S.me = data.user;
    startApp();
  } else {
    renderLogin(data.other);
  }
}

function startApp() {
  showScreen(`<div class="card center"><div class="hero-logo spin">🧭</div><p class="muted">連線中…</p></div>`);
  connect();
  if (store("ta-autoloc") === 1) startAutoLocation();
}

function showApp() {
  screenEl.hidden = true;
  els.app.hidden = false;
  renderChips();
}

function applyTrip(trip) {
  S.trip = trip;
  S.tz = trip.timezone || S.tz;
  document.title = `${trip.title}｜旅伴 AI`;
}

// ================= WebSocket =================

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  if (!els.app.hidden) {
    els.conn.hidden = false;
    els.conn.textContent = "連線中…";
  }
  ws.onopen = () => {
    S.retry = 0;
    S.offline = false;
    els.conn.hidden = true;
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    if (e.code === 4004) return tripDeleted();
    if (e.code === 1008 || e.code === 4001) return location.reload();
    els.conn.hidden = false;
    els.conn.textContent = "連線中斷，重新連線中…";
    const delay = Math.min(1000 * 2 ** S.retry++, 15000);
    setTimeout(async () => {
      try {
        const me = await fetch(`/api/me?room=${ROOM}`);
        if (me.status === 401) return location.reload();
      } catch {}
      connect();
    }, delay);
  };
}

setInterval(() => S.ws?.readyState === 1 && S.ws.send(JSON.stringify({ type: "ping" })), 25000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.ws && S.ws.readyState > 1) connect();
});

function wsSend(obj) {
  if (S.ws?.readyState !== 1) {
    alert("目前沒有連線，請稍後再試");
    return false;
  }
  S.ws.send(JSON.stringify(obj));
  return true;
}

function action(payload) {
  return wsSend({ type: "action", ...payload });
}

function tripDeleted() {
  forgetTrip(ROOM);
  alert("這個旅程已經被刪除了");
  location.href = "/";
}

function handle(m) {
  switch (m.type) {
    case "hello": {
      S.me = m.me;
      S.aiName = m.aiName;
      S.settings = m.settings;
      S.status = m.status;
      setState(m.state);
      const t = S.trip;
      rememberTrip({ id: ROOM, title: t.title, flag: t.flag, dates: `${t.startDate} – ${t.endDate}` });
      if (m.status === "initializing") return renderInit(m.initProgress);
      if (m.status === "review") return S.me.admin ? renderReview() : renderWaitReview();
      if (els.panel.open && S.panel === "tripedit") els.panel.close();
      showApp();
      els.messages.querySelectorAll(".msg, .day-sep, .unread-sep").forEach((n) => n.remove());
      S.lastDay = null;
      S.live.clear();
      m.messages.forEach((msg) => appendMessage(msg));
      S.oldest = m.messages[0]?.ts ?? null;
      els.loadMore.hidden = m.messages.length < 60;
      restoreReadPosition();
      break;
    }
    case "init_progress":
      if (S.status === "initializing") renderInit(m);
      break;
    case "deleted":
      return tripDeleted();
    case "message":
      newMessage(m.message);
      if (m.message.role === "user" && m.message.text.startsWith("🆘") && m.message.author !== S.me.name) showSos(m.message);
      break;
    case "older":
      prependMessages(m.messages, m.hasMore);
      S.loadingOlder = false;
      if (S.jumpAfterLoad) {
        S.jumpAfterLoad = false;
        jumpToUnread();
      }
      break;
    case "presence":
      renderPresence(m.online);
      break;
    case "settings":
      S.settings = m.settings;
      if (S.panel === "settings" || S.panel === "keys") renderPanel();
      break;
    case "state":
      setState(m.state);
      break;
    case "cleared":
      els.messages.querySelectorAll(".msg, .day-sep, .unread-sep").forEach((n) => n.remove());
      S.lastDay = null;
      break;
    case "ai_start":
      aiStart(m);
      break;
    case "ai_tool":
      aiTool(m);
      break;
    case "ai_delta":
      aiDelta(m);
      break;
    case "ai_retry":
      aiRetry(m);
      break;
    case "ai_reset": {
      const live = S.live.get(m.id);
      if (live) {
        live.text = "";
        live.node.querySelector(".ai-body").innerHTML = TYPING;
      }
      break;
    }
    case "ai_note": {
      const live = S.live.get(m.id);
      if (live) live.node.querySelector(".ai-time").textContent = m.text;
      break;
    }
    case "ai_done":
      aiDone(m);
      break;
    case "translation":
      onTranslation(m);
      break;
    case "translations":
      TR.history = m.items;
      if (els.translator.open && TR.tab === "history") renderTranslator();
      break;
    case "draft":
      document.querySelectorAll(`[data-draft="${m.draft.id}"]`).forEach((el) => (el.outerHTML = draftHtml(m.draft)));
      break;
    case "action_result": {
      if (m.action === "translate" || m.action === "add_phrase") trActionDone(m);
      // 卡片按了但失敗（例如別人已經處理過）：把按鈕恢復，畫面會跟著伺服器的狀態更新
      if (!m.ok && (m.action === "draft_confirm" || m.action === "draft_cancel")) document.querySelectorAll(".draft-actions button:disabled").forEach((x) => (x.disabled = false));
      const formErr = $("#trip-error");
      if (!m.ok && m.error && formErr && ["activate", "update_profile"].includes(m.action)) {
        formErr.textContent = m.error;
        formErr.hidden = false;
        formErr.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
      if (!m.ok && m.error) alert(m.error);
      else if (m.ok && m.action === "reset") alert("已清除 ✅");
      else if (m.ok && m.action === "update_profile") alert("已儲存 ✅");
      else if (m.ok && m.action === "update_keys") alert("金鑰已更新 ✅");
      else if (m.ok && m.action === "update_passwords") alert("密碼已更改，請用新密碼重新登入");
      break;
    }
  }
}

// ================= 訊息渲染 =================

function providerName(meta) {
  if (!meta?.provider) return "";
  return meta.providerLabel || (meta.provider === "workers-ai" ? "Workers AI" : "Gemini");
}

const TYPING = `<span class="typing"><span></span><span></span><span></span></span>`;

/** 工具標籤原本帶 emoji（🌤 查天氣），方案 A 只留文字 */
const toolBadge = (label) => `<span class="tool-chip">${escapeHtml(String(label).replace(/^[^\p{L}\p{N}]+/u, ""))}</span>`;

function renderPresence(online) {
  els.online.textContent = online.length ? `${online.join("、")}在線` : "";
  els.avatars.innerHTML = online.slice(0, 3).map((n) => `<span style="background:${colorFor(n)}">${escapeHtml([...n][0])}</span>`).join("");
}

function messageNode(msg) {
  const isAI = msg.role === "assistant";
  const isMe = !isAI && msg.author === S.me?.name;
  const node = document.createElement("div");
  node.className = `msg ${isAI ? "ai" : isMe ? "me" : "other"}`;
  node.dataset.id = msg.id;
  node.dataset.ts = msg.ts;
  let body = "";
  if (msg.photo) body += `<img class="photo" src="${msg.photo}" loading="lazy" alt="照片" />`;
  if (msg.location) {
    const url = `https://www.google.com/maps/search/?api=1&query=${msg.location.lat},${msg.location.lon}`;
    body += `<div class="loc-card">📍 <a href="${url}" target="_blank" rel="noopener">分享了目前位置</a></div>`;
  }
  if (msg.text) body += isAI ? md(msg.text) : escapeHtml(msg.text).replace(/\n/g, "<br>");
  const images = (msg.meta?.images ?? []).filter((im) => typeof im.src === "string" && (im.src.startsWith("/api/img?") || im.src.startsWith("/api/photo/")));
  const webImages = images.some((im) => im.src.startsWith("/api/img?"));
  if (images.length) {
    body += `<div class="gallery">${images
      .map((im) => {
        const link = /^https?:\/\//.test(im.page ?? "") ? im.page : null;
        return `<figure>
          <img class="photo web" src="${escapeHtml(im.src)}" loading="lazy" alt="${escapeHtml(im.caption)}" onerror="this.closest('figure').remove()" />
          <figcaption>${im.label ? `<b>${escapeHtml(im.label)}</b><br>` : ""}${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(im.source)}</a>` : escapeHtml(im.source)}</figcaption>
        </figure>`;
      })
      .join("")}</div>${webImages ? `<div class="small muted">🖼 網路圖片，僅供參考</div>` : ""}`;
  }
  if (isAI) {
    const provider = providerName(msg.meta);
    node.innerHTML = `<div class="ai-card">
      <div class="ai-head"><span class="ai-avatar">${svg("luggage")}</span><span class="ai-name">${escapeHtml(msg.author)}</span>
        <span class="ai-tools">${(msg.meta?.tools ?? []).map(toolBadge).join("")}</span>
        <span class="ai-time">${timeText(msg.ts)}${provider ? ` · ${escapeHtml(provider)}` : ""}</span></div>
      <div class="ai-body rich">${body}</div>
      ${(msg.drafts ?? []).map(draftHtml).join("")}
    </div>`;
  } else if (isMe) {
    node.innerHTML = `<div class="bubble-wrap"><div class="bubble rich">${body}</div><div class="meta">${timeText(msg.ts)}</div></div>`;
  } else {
    node.innerHTML = `<div class="avatar" style="background:${colorFor(msg.author)}">${escapeHtml([...msg.author][0])}</div>
      <div class="bubble-wrap"><div class="name">${escapeHtml(msg.author)}・${timeText(msg.ts)}</div><div class="bubble rich">${body}</div></div>`;
  }
  node.querySelectorAll("img.photo").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
  return node;
}

// ---------- 確認卡片：AI 要記帳、改行程、刪除時，先列出內容，成員按確認才寫入 ----------

const DRAFT_STATE = { done: (d) => `✅ ${d.resolved_by} 已確認`, cancelled: (d) => `已取消（${d.resolved_by}）`, superseded: () => "已改用新的卡片", failed: () => "資料已經不在，沒有執行" };

function draftHtml(d) {
  const p = d.preview || {};
  const rows = (p.rows || [])
    .map(([k, v, old]) => `<dt>${escapeHtml(k)}</dt><dd${k.startsWith("⚠️") ? ' class="warn"' : ""}>${escapeHtml(v)}${old ? `<small>原本：${escapeHtml(old)}</small>` : ""}</dd>`)
    .join("");
  const foot = d.status === "pending"
    ? `<div class="draft-actions"><button type="button" class="ok" data-draft-act="confirm">${escapeHtml(p.confirm || "確認")}</button><button type="button" data-draft-act="cancel">取消</button></div>`
    : `<div class="draft-state">${escapeHtml((DRAFT_STATE[d.status] ?? (() => d.status))(d))}</div>`;
  return `<div class="draft${d.status === "pending" ? "" : " settled"}" data-draft="${d.id}">
    <div class="draft-head"><b>${escapeHtml(p.title || "請確認")}</b><span class="draft-no">#${d.id}・${d.status === "pending" ? "還沒寫入" : "已處理"}</span></div>
    <dl>${rows}</dl>${foot}</div>`;
}

els.messages.addEventListener("click", (e) => {
  const b = e.target.closest("[data-draft-act]");
  if (!b) return;
  const id = Number(b.closest("[data-draft]").dataset.draft);
  const confirmIt = b.dataset.draftAct === "confirm";
  b.closest(".draft-actions").querySelectorAll("button").forEach((x) => (x.disabled = true));
  if (!wsSend({ type: "action", action: confirmIt ? "draft_confirm" : "draft_cancel", id })) {
    b.closest(".draft-actions").querySelectorAll("button").forEach((x) => (x.disabled = false));
  }
});

function daySeparator(ts) {
  const d = dayText(ts);
  if (d === S.lastDay) return null;
  S.lastDay = d;
  const sep = document.createElement("div");
  sep.className = "day-sep";
  sep.textContent = d;
  return sep;
}

function appendMessage(msg) {
  if (els.messages.querySelector(`[data-id="${msg.id}"]`)) return;
  const sep = daySeparator(msg.ts);
  if (sep) els.messages.appendChild(sep);
  return els.messages.appendChild(messageNode(msg));
}

function prependMessages(list, hasMore) {
  if (!list.length) {
    els.loadMore.hidden = true;
    return;
  }
  // 以目前最上面那則訊息當錨點，插入舊訊息後把它留在原本的位置（不論使用者停在哪）
  const anchor = els.messages.querySelector(".msg");
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const frag = document.createDocumentFragment();
  let last = null;
  for (const msg of list) {
    const d = dayText(msg.ts);
    if (d !== last) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = d;
      frag.appendChild(sep);
      last = d;
    }
    frag.appendChild(messageNode(msg));
  }
  const firstSep = els.messages.querySelector(".day-sep");
  if (firstSep && firstSep.textContent === last) firstSep.remove();
  els.loadMore.after(frag);
  S.oldest = list[0].ts;
  els.loadMore.hidden = !hasMore;
  if (anchor) els.messages.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
}

// ---------- 已讀位置：像通訊軟體一樣，回來時停在上次讀到的地方（記在這支手機） ----------

let readMarkCache = null;
const readMark = () => (readMarkCache ??= Number(store(`ta-read-${ROOM}`)) || 0);
function writeMark(ts) {
  readMarkCache = ts;
  store(`ta-read-${ROOM}`, ts);
}

/** 聊天畫面現在真的看得到：不在背景、沒有被分頁或翻譯蓋住 */
const chatVisible = () => !document.hidden && !els.app.hidden && !els.panel.open && !els.translator.open;
/** 正在看最底下：新訊息來了就跟著捲 */
const following = () => nearBottom() && chatVisible();

function loadOlder() {
  if (S.loadingOlder || !S.oldest || S.ws?.readyState !== 1) return;
  S.loadingOlder = true;
  S.ws.send(JSON.stringify({ type: "load_more", before: S.oldest }));
}
els.loadMore.addEventListener("click", loadOlder);
// 捲到接近頂端就自動載入更早的訊息，按鈕留著當備用
new IntersectionObserver((entries) => entries[0].isIntersecting && !els.loadMore.hidden && loadOlder(), {
  root: els.messages,
  rootMargin: "300px 0px 0px 0px",
}).observe(els.loadMore);

function unreadSep() {
  const sep = document.createElement("div");
  sep.className = "unread-sep";
  sep.textContent = "以下是未讀訊息";
  return sep;
}

/** 連線（或重新連線）後：未讀起點比已載入的還早，就先補抓到那裡再跳過去 */
function restoreReadPosition() {
  S.loadingOlder = S.jumpAfterLoad = false;
  const mark = readMark();
  if (mark && S.oldest && mark < S.oldest && !els.loadMore.hidden) {
    els.messages.scrollTop = els.messages.scrollHeight;
    S.loadingOlder = S.jumpAfterLoad = true;
    S.ws.send(JSON.stringify({ type: "load_more", before: S.oldest, after: mark }));
  } else {
    jumpToUnread();
  }
}

/** 跳到第一則未讀並標出分隔線；沒有未讀（或第一次來）就到最底 */
function jumpToUnread() {
  els.messages.querySelector(".unread-sep")?.remove();
  const mark = readMark();
  const first = mark ? [...els.messages.querySelectorAll(".msg:not(.me)[data-ts]")].find((n) => Number(n.dataset.ts) > mark) : null;
  if (first) {
    const sep = unreadSep();
    first.before(sep);
    els.messages.scrollTop += sep.getBoundingClientRect().top - els.messages.getBoundingClientRect().top - 8;
  } else {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  requestAnimationFrame(updateReadMark);
}

/** 別人的新訊息：正在看最底下就跟著捲；沒在看（背景、開著其他分頁、往上翻舊訊息）就標出未讀起點 */
function arrived(node, stick) {
  if (!node) return;
  if (stick) {
    scrollToBottom(true);
  } else {
    const old = els.messages.querySelector(".unread-sep");
    // 舊分隔線後面還有沒讀的就沿用（像通訊軟體一樣停在最早的未讀），都讀過了才移到這則前面
    let stillUnread = false;
    for (let n = old?.nextElementSibling; n && n !== node && !stillUnread; n = n.nextElementSibling) {
      stillUnread = n.matches(".msg:not(.me)") && !!(n.dataset.live || Number(n.dataset.ts) > readMark());
    }
    if (!stillUnread) {
      old?.remove();
      node.before(unreadSep());
    }
  }
  requestAnimationFrame(updateReadMark);
}

function newMessage(msg) {
  const stick = following();
  const node = appendMessage(msg);
  if (msg.author === S.me?.name) scrollToBottom(true);
  else arrived(node, stick);
}

/** 回到聊天（切回 App、關掉分頁或翻譯）時，未讀起點還在畫面下方就捲過去 */
function revealUnread() {
  if (!chatVisible()) return;
  const sep = els.messages.querySelector(".unread-sep");
  const box = els.messages.getBoundingClientRect();
  if (sep && unreadCount() && sep.getBoundingClientRect().top > box.bottom - 60) {
    els.messages.scrollTop += sep.getBoundingClientRect().top - box.top - 8;
  }
  requestAnimationFrame(updateReadMark);
}

/** 畫面上看得到的最後一則訊息就是「讀到這裡」 */
function updateReadMark() {
  // 正在補抓未讀起點之前的訊息時，畫面只是暫時停在最底，不算讀過
  if (chatVisible() && !S.jumpAfterLoad) {
    const bottom = els.messages.getBoundingClientRect().bottom;
    const nodes = els.messages.querySelectorAll(".msg[data-ts]:not([data-live])");
    for (let i = nodes.length - 1; i >= 0; i--) {
      const r = nodes[i].getBoundingClientRect();
      if (r.top + Math.min(r.height, 80) <= bottom) {
        const ts = Number(nodes[i].dataset.ts);
        if (ts > readMark()) writeMark(ts);
        break;
      }
    }
  }
  renderLatestBtn();
}

function unreadCount() {
  const mark = readMark();
  let n = 0;
  els.messages.querySelectorAll(".msg:not(.me)[data-ts]").forEach((x) => (x.dataset.live || Number(x.dataset.ts) > mark) && n++);
  return n;
}

/** 往上翻時右下角出現「最新」按鈕，數字是還沒讀的則數 */
function renderLatestBtn() {
  const away = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight > 300;
  const n = away ? unreadCount() : 0;
  els.toLatest.hidden = !away;
  els.toLatestN.hidden = !n;
  els.toLatestN.textContent = n > 99 ? "99+" : String(n);
}

let markRaf = 0;
els.messages.addEventListener(
  "scroll",
  () => {
    if (!markRaf) markRaf = requestAnimationFrame(() => ((markRaf = 0), updateReadMark()));
  },
  { passive: true },
);
els.toLatest.addEventListener("click", () => els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" }));
els.panel.addEventListener("close", revealUnread);
els.translator.addEventListener("close", revealUnread);
document.addEventListener("visibilitychange", revealUnread);

function nearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 160;
}

function scrollToBottom(force) {
  if (force || following()) requestAnimationFrame(() => (els.messages.scrollTop = els.messages.scrollHeight));
}

// ---------- AI 即時生成 ----------

function aiStart(m) {
  let live = S.live.get(m.id);
  if (!live) {
    const stick = following();
    const node = messageNode({ id: m.id, ts: Date.now(), author: S.aiName, role: "assistant", text: "", meta: null });
    node.querySelector(".ai-body").innerHTML = TYPING;
    node.dataset.live = "1";
    const sep = daySeparator(Date.now());
    if (sep) els.messages.appendChild(sep);
    els.messages.appendChild(node);
    live = { node, text: "", raf: 0 };
    S.live.set(m.id, live);
    arrived(node, stick);
  }
  live.node.querySelector(".ai-time").textContent = `${m.label || "AI"} 思考中…`;
}

function aiTool(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.node.querySelector(".ai-tools").insertAdjacentHTML("beforeend", toolBadge(m.label));
  scrollToBottom(false);
}

function aiDelta(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.text += m.delta;
  if (live.raf) return;
  live.raf = requestAnimationFrame(() => {
    live.raf = 0;
    const stick = following();
    live.node.querySelector(".ai-body").innerHTML = md(live.text);
    scrollToBottom(stick);
  });
}

function aiRetry(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.text = "";
  live.node.querySelector(".ai-body").innerHTML = m.rateLimited
    ? `<span class="muted small">這個模型的額度用完或冷卻中，改用下一個模型回答…</span>`
    : `<span class="muted small">模型出錯，改用下一個模型…</span>`;
}

function aiDone(m) {
  const live = S.live.get(m.id);
  const stick = following();
  const node = messageNode(m.message);
  if (live) {
    cancelAnimationFrame(live.raf);
    live.node.replaceWith(node);
    S.live.delete(m.id);
  } else {
    arrived(appendMessage(m.message), stick);
  }
  scrollToBottom(stick);
}

// ================= 送出訊息 =================

els.input.addEventListener("input", autoGrow);
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
}

els.input.addEventListener("keydown", (e) => {
  // 電腦上 Enter 送出、Shift+Enter 換行；手機用送出鍵
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    els.sendForm.requestSubmit();
  }
});

els.sendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  const { photo, location: loc } = S.pending;
  if (!text && !photo && !loc) return;
  els.sendBtn.disabled = true;
  try {
    let photoId = null;
    if (photo) {
      const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": photo.type }, body: photo });
      if (!res.ok) throw new Error(res.status === 507 ? "這個旅程的照片空間已滿" : `照片上傳失敗（${res.status}）`);
      photoId = (await res.json()).id;
    }
    if (wsSend({ type: "send", text, photoId, location: loc })) {
      els.input.value = "";
      autoGrow();
      clearAttachment();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    els.sendBtn.disabled = false;
  }
});

/** 送出一句問題；問「附近／回住宿」要先附上位置 */
function ask(q, withLocation = false) {
  els.input.value = q;
  if (withLocation) attachLocation(true);
  else els.sendForm.requestSubmit();
}

/** 收據記帳：先選照片，文字幫忙填好，確認後按送出 */
function receiptFlow() {
  els.input.value = "幫我把這張收據記帳（我付的）";
  els.photoInput.click();
}

/** 輸入框上方的快捷列（左右滑動）：分隔線前是直接問 AI 的常用問題，後面是打開各個工具頁 */
function renderChips() {
  const t = S.trip || {};
  const cur = t.currency || "";
  const chips = [
    ["sun", "今天", () => ask("今天的行程和天氣？")],
    ["utensils", "附近美食", () => ask("我附近有什麼好吃的？", true)],
    ["receipt", "收據記帳", receiptFlow],
    ...(t.countryCode === "JP" ? [["train", "電車狀況", () => ask("我們附近的電車現在有延誤或停駛嗎？")]] : []),
    ...(cur && cur !== "TWD" ? [["exchange", "匯率", () => ask(`現在 ${cur} 匯率多少？1000 ${cur} 等於多少台幣？`)]] : []),
    ["clock", "樂園排隊", () => ask("附近樂園現在哪些設施排隊最少？")],
    ["wallet", "帳目", () => ask("目前花了多少錢？大家要怎麼分？")],
    ["home", "回住宿", () => ask("我要怎麼回住宿？", true)],
    ["pin", "附上位置", () => attachLocation(false)],
    null,
    ["calendar", "行程", () => openPanel("itinerary")],
    ["compass", "旅遊指南", () => openPanel("travel")],
    ["ticket", "票券", () => openPanel("tickets")],
    ["users", "家人位置", () => openPanel("map")],
    ["list", "清單", () => openPanel("checklist")],
    ["bell", "提醒", () => openPanel("reminders")],
    ["book", "旅遊日記", () => openPanel("diary")],
    ["bookmark", "長期記憶", () => openPanel("memories")],
    ["help", "使用說明", () => openPanel("guide")],
    ["plus", "更多", openMore],
  ];
  els.chips.innerHTML = chips
    .map((c, i) => (c ? `<button type="button" data-i="${i}">${svg(c[0])}${c[1]}</button>` : `<span class="chip-sep" aria-hidden="true"></span>`))
    .join("");
  els.chips.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => chips[Number(b.dataset.i)][2]()));
}

// 快捷列預設收起，讓聊天區多一點空間；按「＋」展開，展開與否記在這支手機
function showChips(show) {
  els.chips.hidden = !show;
  els.chipsToggle.setAttribute("aria-expanded", String(show));
  els.chipsToggle.setAttribute("aria-label", show ? "收起快捷功能" : "展開快捷功能");
}
showChips(store("ta-show-chips") === true);
els.chipsToggle.addEventListener("click", () => {
  const show = els.chips.hidden;
  const stick = nearBottom();
  store("ta-show-chips", show);
  showChips(show);
  scrollToBottom(stick);
});

// ---------- 「更多」：傳給 AI 的動作與常用問法 ----------

const MORE_ASKS = ["明天的行程和天氣？", "目前花了多少錢？大家要怎麼分？", "最近有地震或颱風嗎？會影響行程嗎？"];

function moreActions() {
  const t = S.trip || {};
  const cur = t.currency || "";
  return [
    ["camera", "拍照問", () => els.photoInput.click()],
    ["pin", "附上位置", () => attachLocation(false)],
    ["receipt", "收據記帳", receiptFlow],
    ...(hasTranslator() ? [["lang", "翻譯", openTranslator]] : []),
    ["sun", "今天", () => ask("今天的行程和天氣？")],
    ["utensils", "附近美食", () => ask("我附近有什麼好吃的？", true)],
    ...(cur && cur !== "TWD" ? [["exchange", "匯率", () => ask(`現在 ${cur} 匯率多少？1000 ${cur} 等於多少台幣？`)]] : []),
    ["home", "回住宿", () => ask("我要怎麼回住宿？", true)],
    ...(t.countryCode === "JP" ? [["train", "電車狀況", () => ask("我們附近的電車現在有延誤或停駛嗎？")]] : []),
    ["clock", "樂園排隊", () => ask("附近樂園現在哪些設施排隊最少？")],
  ];
}

function openMore() {
  const actions = moreActions();
  els.moreActions.innerHTML = actions.map(([icon, label], i) => `<button type="button" data-i="${i}"><span class="ag-icon">${svg(icon)}</span>${label}</button>`).join("");
  els.moreAsks.innerHTML = MORE_ASKS.map((q, i) => `<button type="button" data-q="${i}">${svg("msg")}${escapeHtml(q)}</button>`).join("");
  els.moreActions.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      els.more.close();
      actions[Number(b.dataset.i)][2]();
    }),
  );
  els.moreAsks.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      els.more.close();
      ask(MORE_ASKS[Number(b.dataset.q)]);
    }),
  );
  if (!els.more.open) els.more.showModal();
}
$("#more-close").addEventListener("click", () => els.more.close());
els.more.addEventListener("click", (e) => e.target === els.more && els.more.close());

// ---------- 照片 ----------

els.photoInput.addEventListener("change", async () => {
  const file = els.photoInput.files?.[0];
  els.photoInput.value = "";
  if (!file) return;
  try {
    const blob = await resizeImage(file, 1280, 0.82);
    S.pending.photo = blob;
    if (S.pending.photoUrl) URL.revokeObjectURL(S.pending.photoUrl);
    S.pending.photoUrl = URL.createObjectURL(blob);
    els.attachImg.src = S.pending.photoUrl;
    els.attach.hidden = false;
    els.input.placeholder = "要問什麼？例如：這是什麼、幫我翻譯、比價";
    els.input.focus();
  } catch {
    alert("無法讀取這張照片");
  }
});

async function resizeImage(file, max, quality) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/jpeg", quality));
}

// ---------- 定位 ----------

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("這個瀏覽器不支援定位"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1 ? "請允許瀏覽器使用定位" : "無法取得位置")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

async function attachLocation(thenSend) {
  els.attachLoc.textContent = "📍 定位中…";
  els.attach.hidden = false;
  try {
    S.pending.location = await getPosition();
    els.attachLoc.textContent = `📍 已附上位置（±${S.pending.location.accuracy}m）`;
    if (thenSend) els.sendForm.requestSubmit();
  } catch (err) {
    els.attachLoc.textContent = "";
    if (!S.pending.photo) els.attach.hidden = true;
    alert(err.message);
    if (thenSend && els.input.value) els.sendForm.requestSubmit();
  }
}

function clearLocation() {
  S.pending.location = null;
  els.attachLoc.textContent = "";
  if (!S.pending.photo) els.attach.hidden = true;
}

function clearAttachment() {
  S.pending.photo = null;
  if (S.pending.photoUrl) URL.revokeObjectURL(S.pending.photoUrl);
  S.pending.photoUrl = null;
  els.attachImg.removeAttribute("src");
  els.input.placeholder = "問旅伴 AI 任何事…";
  clearLocation();
  els.attach.hidden = true;
}
els.attachClear.addEventListener("click", clearAttachment);

let autoLocTimer = null;
function startAutoLocation() {
  const tick = async () => {
    try {
      const p = await getPosition();
      S.ws?.readyState === 1 && S.ws.send(JSON.stringify({ type: "location", ...p }));
    } catch {}
  };
  tick();
  clearInterval(autoLocTimer);
  autoLocTimer = setInterval(tick, 5 * 60 * 1000);
}
function stopAutoLocation() {
  clearInterval(autoLocTimer);
  autoLocTimer = null;
}

// ================= 狀態（頂部、面板） =================

function setState(state) {
  S.state = state;
  applyTrip(state.trip);
  // 票券、常用句、旅程資料存一份在手機，沒網路也能打開
  store(`ta-trip-${ROOM}`, state.trip);
  if (state.documents) store(`ta-docs-${ROOM}`, state.documents);
  if (state.phrases) {
    store(`ta-phrases-${ROOM}`, state.phrases);
    if (els.translator.open && TR.tab === "phrases") renderPhraseList();
  }
  const t = state.trip;
  const now = todayLocal();
  const day = Math.floor((Date.parse(now + "T00:00:00Z") - Date.parse(t.startDate + "T00:00:00Z")) / 86400e3) + 1;
  els.todayTitle.textContent = t.title;
  els.dayBadge.textContent = day < 1 ? `倒數 ${1 - day} 天` : now <= t.endDate ? `Day ${day}` : "旅程結束";
  renderNextCard(state, now);
  els.tabbar.querySelector('[data-tab="translator"]').hidden = !hasTranslator();
  els.tabbar.querySelector('[data-tab="itinerary"]').hidden = hasTranslator();
  if (S.panel && !["settings", "tripedit", "keys"].includes(S.panel)) renderPanel();
  const usage = $("#gemini-usage");
  if (usage) usage.textContent = geminiUsageText(state.gemini);
}

/** 「下一站」票券卡：出發前顯示出發日與航班，旅途中顯示今天的行程，回國後隱藏 */
function renderNextCard(state, now) {
  const t = state.trip;
  const it = state.itinerary || [];
  let label, title, sub;
  if (now < t.startDate) {
    const first = it.find((d) => d.date === t.startDate);
    label = "下一站";
    title = `${dateLabel(t.startDate)} 出發`;
    sub = String(t.flights || "").split("\n")[0] || [first?.title, first?.detail].filter(Boolean).join("｜") || t.accommodation?.name || "";
  } else if (now <= t.endDate) {
    const today = it.find((d) => d.date === now);
    label = `今天・${dateLabel(now)}`;
    title = today?.title || "自由活動";
    sub = today?.detail || today?.status || "";
  } else {
    els.nextCard.hidden = els.ncToggle.hidden = true;
    return;
  }
  els.nextCard.innerHTML = `<span class="nc-main"><span class="nc-label">${escapeHtml(label)}</span><span class="nc-title">${escapeHtml(title)}</span>${sub ? `<span class="nc-sub">${escapeHtml(sub)}</span>` : ""}</span><span class="nc-side">${svg("calendar")}行程</span>`;
  els.ncToggle.hidden = false;
  showNextCard(store("ta-show-next") === true);
}

// 「下一站」卡片預設收起，按標題列的「下一站」才顯示，再按一次收起
function showNextCard(show) {
  els.nextCard.hidden = !show;
  els.ncToggle.setAttribute("aria-pressed", String(show));
}
els.ncToggle.addEventListener("click", () => {
  const show = els.nextCard.hidden;
  store("ta-show-next", show);
  showNextCard(show);
});
els.nextCard.addEventListener("click", () => openPanel("itinerary"));

function geminiUsageText(g) {
  if (!g) return "";
  let s = `本分鐘 ${g.rpm}/${g.rpmLimit} 次｜今日 ${g.rpd}/${g.rpdLimit} 次`;
  if (g.cooldownSec) s += `｜冷卻中 ${g.cooldownSec} 秒`;
  return s;
}

// ---------- 底部分頁列：聊天以外的分頁是蓋在聊天上方的整頁面板 ----------

const TAB_OF = { itinerary: "itinerary", expenses: "expenses", settings: "settings", tripedit: "settings", keys: "settings" };

function setTab(tab) {
  const buttons = [...els.tabbar.querySelectorAll("button")];
  // 分頁列上沒有的頁面（例如行程）算在工具箱底下
  if (!buttons.some((b) => b.dataset.tab === tab && !b.hidden)) tab = "hub";
  buttons.forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

els.tabbar.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.tab === "chat") {
      if (els.panel.open) els.panel.close();
      else scrollToBottom(true);
      return;
    }
    if (b.dataset.tab === "translator") return openTranslator();
    openPanel(b.dataset.tab);
  }),
);
els.panelClose.addEventListener("click", () => els.panel.close());
els.panel.addEventListener("close", () => {
  S.panel = null;
  setTab("chat");
});

function openPanel(name) {
  S.panel = name;
  renderPanel();
  setTab(TAB_OF[name] ?? "hub");
  if (name === "settings" && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type: "get_state" }));
  if (!els.panel.open) els.panel.show();
  els.panel.scrollTop = 0;
}

// 打開時就先抓好圖檔：iOS 的分享面板必須在點擊當下叫出，等下載完才叫會被擋
let viewerBlob = null;
function openViewer(src) {
  els.viewerImg.src = src;
  els.viewerDl.lastElementChild.textContent = "下載";
  viewerBlob = fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
  viewerBlob.catch(() => {});
  els.viewer.showModal();
}
els.viewer.addEventListener("click", () => els.viewer.close());
els.viewerDl.addEventListener("click", async (e) => {
  e.stopPropagation();
  const label = els.viewerDl.lastElementChild;
  let blob;
  try {
    blob = await viewerBlob;
  } catch {
    label.textContent = "下載失敗";
    return;
  }
  const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/\+.*/, "");
  const file = new File([blob], `旅伴AI-${Date.now()}.${ext}`, { type: blob.type });
  // 手機走分享面板，才能選「儲存影像」存進相簿；電腦直接下載檔案
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

const OFFLINE_OK = ["hub", "tickets", "guide", "travel"];

/** 分頁標題用霞鶩文楷，不帶 emoji（各頁面原本的標題有 emoji，在這裡統一拿掉） */
function renderPanel() {
  renderPanelInner();
  els.panelTitle.textContent = els.panelTitle.textContent.replace(/^[^\p{L}\p{N}]+/u, "");
}

function renderPanelInner() {
  const st = S.state;
  const b = els.panelBody;
  if (!st || S.offline) {
    if (OFFLINE_OK.includes(S.panel)) return renderToolPanel(null, b);
    els.panelTitle.textContent = "📴 離線中";
    b.innerHTML = `<div class="card small muted">目前沒有網路，這個功能暫時不能用。翻譯常用句、票券、旅遊指南離線也能看。</div>`;
    return;
  }
  if (["hub", "guide", "travel", "map", "checklist", "tickets", "reminders", "diary"].includes(S.panel)) return renderToolPanel(st, b);
  switch (S.panel) {
    case "itinerary": {
      els.panelTitle.textContent = "📅 行程";
      const now = todayLocal();
      b.innerHTML = st.itinerary
        .map((d) => `<div class="card ${d.date === now ? "today" : ""}" data-date="${d.date}">
            <div class="row between"><strong>${dateLabel(d.date)}</strong>
            <button class="btn small" data-edit="${d.date}">✏️ 修改</button></div>
            <h3 style="margin-top:6px">${d.title ? escapeHtml(d.title) : '<span class="muted">（還沒安排）</span>'}</h3>
            ${d.detail ? `<div class="small muted">${escapeHtml(d.detail)}</div>` : ""}
            ${d.status ? `<div style="margin-top:6px"><span class="tag">${escapeHtml(d.status)}</span></div>` : ""}
            ${d.updated_by && d.updated_by !== "初始行程" ? `<div class="small muted" style="margin-top:6px">最後修改：${escapeHtml(d.updated_by)}</div>` : ""}
          </div>`)
        .join("") + `<p class="small muted">也可以直接在聊天中說「第二天改成去逛市場」，AI 會幫你更新並記住。</p>`;
      b.querySelectorAll("[data-edit]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const d = st.itinerary.find((x) => x.date === btn.dataset.edit);
          const card = btn.closest(".card");
          card.innerHTML = `<form class="form">
            <strong>${dateLabel(d.date)}</strong>
            <input name="title" value="${escapeHtml(d.title)}" placeholder="標題，例如：市區觀光" />
            <textarea name="detail" rows="3" placeholder="細節">${escapeHtml(d.detail)}</textarea>
            <input name="status" value="${escapeHtml(d.status)}" placeholder="狀態，例如 ✅ 已購票" />
            <div class="row"><button class="btn primary-sm">儲存</button><button type="button" class="btn" data-cancel>取消</button></div>
          </form>`;
          card.querySelector("[data-cancel]").addEventListener("click", renderPanel);
          card.querySelector("form").addEventListener("submit", (e) => {
            e.preventDefault();
            const f = new FormData(e.target);
            action({ action: "update_itinerary", date: d.date, title: f.get("title"), detail: f.get("detail"), status: f.get("status") });
          });
        }),
      );
      break;
    }
    case "expenses": {
      els.panelTitle.textContent = "💰 記帳分帳";
      const ex = st.expenses;
      const t = S.trip;
      const members = st.members.length ? st.members : [S.me.name];
      const currencies = [...new Set([t.currency, "TWD", "USD"].filter(Boolean))];
      b.innerHTML = `
        <div class="card"><div class="small muted">總花費（${ex.count} 筆）</div>
          <div class="big">${money(ex.total)}</div><div class="muted">約 NT$${ex.total_twd.toLocaleString()}</div></div>
        <div class="card"><h3>每人</h3>
          ${ex.balance.map((p) => `<div class="item small"><span>${escapeHtml(p.name)}</span><span>付 ${money(p.paid)}｜應付 ${money(p.share)}｜<b style="color:${p.net >= 0 ? "#17a398" : "var(--danger)"}">${p.net >= 0 ? "+" : ""}${money(p.net)}</b></span></div>`).join("") || `<div class="small muted">還沒有帳目</div>`}
          ${ex.transfers.length ? `<h3 style="margin-top:10px">結算建議</h3>${ex.transfers.map((x) => `<div class="small">👉 ${escapeHtml(x.from)} 給 ${escapeHtml(x.to)} <b>${money(x.amount)}</b></div>`).join("")}` : ""}
        </div>
        <div class="card"><h3>新增一筆</h3>
          <form class="form" id="exp-form">
            <input name="description" placeholder="項目，例如 晚餐" required />
            <div class="row"><input name="amount" type="number" inputmode="decimal" step="any" placeholder="金額" required />
              <select name="currency" style="max-width:100px">${currencies.map((c) => `<option>${c}</option>`).join("")}</select></div>
            <div class="row"><span class="small" style="white-space:nowrap">誰付的</span><select name="payer">${members.map((m) => `<option ${m === S.me.name ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}</select></div>
            <select name="category">${["餐飲", "交通", "門票", "購物", "住宿", "其他"].map((c) => `<option>${c}</option>`).join("")}</select>
            <div class="small muted">分給誰</div>
            <div class="checks">${members.map((m) => `<label><input type="checkbox" name="split" value="${escapeHtml(m)}" checked /> ${escapeHtml(m)}</label>`).join("")}</div>
            <button class="btn primary-sm">記下來</button>
          </form>
          <p class="small muted">也可以直接在聊天說「晚餐 ${t.currencySymbol || ""}3000 我付的」，或按輸入框左邊的「＋」→「收據」拍收據。</p>
        </div>
        <div class="card"><h3>明細</h3><div class="list">
          ${ex.items.slice().reverse().map((it) => `<div class="item small"><div><b>${escapeHtml(it.description)}</b><div class="muted">${String(it.date).slice(5)}｜${escapeHtml(it.category)}｜${escapeHtml(it.payer)} 付｜分給 ${it.split_among.map(escapeHtml).join("、")}</div></div>
            <div style="text-align:right">${money(it.local)}${it.currency !== t.currency ? `<div class="muted">${escapeHtml(it.currency)} ${Number(it.amount).toLocaleString()}</div>` : ""}<div class="muted">NT$${Number(it.twd).toLocaleString()}</div><button class="btn danger small" data-del-exp="${it.id}">刪除</button></div></div>`).join("") || `<div class="small muted">還沒有帳目</div>`}
        </div></div>`;
      b.querySelector("#exp-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        action({
          action: "add_expense",
          expense: { description: f.get("description"), amount: Number(f.get("amount")), currency: f.get("currency"), payer: f.get("payer"), category: f.get("category"), split_among: f.getAll("split") },
        });
      });
      b.querySelectorAll("[data-del-exp]").forEach((btn) =>
        btn.addEventListener("click", () => confirm("確定刪除這筆？") && action({ action: "delete_expense", id: Number(btn.dataset.delExp) })),
      );
      break;
    }
    case "memories": {
      els.panelTitle.textContent = "🧠 長期記憶";
      b.innerHTML = `
        <p class="small muted">不用手動輸入：大家聊天時，AI 每隔幾則訊息就會自動記下偏好、決定、預訂與待辦，過時的會自動刪掉。這裡也可以手動補充或刪除。</p>
        ${st.summary ? `<div class="card"><h3>📖 AI 對這趟旅程的理解</h3><div class="small" style="white-space:pre-wrap">${escapeHtml(st.summary)}</div></div>` : ""}
        <div class="card"><form class="form" id="mem-form">
          <textarea name="content" rows="2" placeholder="例如：妹妹對蝦子過敏；集合地點是飯店大廳" required></textarea>
          <div class="row"><select name="category">${["偏好", "決定", "預訂", "資訊", "待辦"].map((c) => `<option>${c}</option>`).join("")}</select>
          <button class="btn primary-sm">新增記憶</button></div>
        </form></div>
        <div class="card"><div class="list">
          ${st.memories.slice().reverse().map((m) => `<div class="item small"><div><span class="tag">${escapeHtml(m.category)}</span> ${escapeHtml(m.content)}<div class="muted">#${m.id}｜${escapeHtml(m.author)}｜${dayText(m.ts)}</div></div>
            <button class="btn danger small" data-del-mem="${m.id}">刪除</button></div>`).join("") || `<div class="small muted">還沒有記憶</div>`}
        </div></div>`;
      b.querySelector("#mem-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        action({ action: "add_memory", content: f.get("content"), category: f.get("category") });
      });
      b.querySelectorAll("[data-del-mem]").forEach((btn) =>
        btn.addEventListener("click", () => confirm("確定刪除這條記憶？") && action({ action: "delete_memory", id: Number(btn.dataset.delMem) })),
      );
      break;
    }
    case "settings":
      renderSettingsPanel(st, b);
      break;
    case "tripedit": {
      els.panelTitle.textContent = "🌏 旅程設定";
      b.innerHTML = `${tripForm(S.trip)}
        <div class="row" style="gap:8px"><button class="btn" id="te-rerun" style="flex:1">🔄 請 AI 重新查詢</button><button class="btn primary-sm" id="te-save" style="flex:1">儲存</button></div>`;
      const read = bindTripForm(b, S.trip);
      $("#te-save", b).addEventListener("click", () => action({ action: "update_profile", profile: read() }));
      $("#te-rerun", b).addEventListener("click", () => {
        if (confirm("讓 AI 重新查一次當地資料（時區、貨幣、指南、常用語）？查完要再確認一次，期間大家暫時不能聊天。")) {
          action({ action: "rerun_init" });
          els.panel.close();
        }
      });
      break;
    }
    case "keys": {
      els.panelTitle.textContent = "🔑 API 金鑰";
      const s = S.settings;
      b.innerHTML = `
        <div class="card small">
          <h3>AI 使用順序</h3>
          <ol class="steps">
            ${s.ownerGemini ? "<li>網站提供的 Gemini 免費額度</li>" : ""}
            <li>網站提供的 Workers AI 免費額度（每天台灣時間早上 8 點重置）</li>
            <li>這個旅程自己的 Gemini 金鑰：${s.gemini ? `✅ ${escapeHtml(s.gemini)}` : "❌ 未設定"}</li>
          </ol>
          ${s.gemini ? `<div class="muted">自己的 Gemini 用量：<span id="gemini-usage">${escapeHtml(geminiUsageText(S.state?.gemini))}</span></div>` : ""}
        </div>
        <div class="card"><h3>🔍 Tavily 搜尋金鑰</h3>
          <div class="small muted">目前：${escapeHtml(s.tavily || "未設定")}。額度用完時到 <a href="https://app.tavily.com" target="_blank" rel="noopener">app.tavily.com</a> 換一組。</div>
          <form class="row" id="k-tavily"><input name="k" placeholder="新的 tvly-…" autocomplete="off" style="flex:1" /><button class="btn primary-sm">更新</button></form>
        </div>
        <div class="card"><h3>🤖 Gemini 金鑰（選填）</h3>
          <div class="small muted">到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> 免費申請。網站提供的免費額度用完時才會用它。</div>
          <form class="row" id="k-gemini"><input name="k" placeholder="AIza…" autocomplete="off" style="flex:1" /><button class="btn primary-sm">更新</button></form>
          ${s.gemini ? `<button class="btn small danger" id="k-gemini-del" style="margin-top:6px">移除 Gemini 金鑰</button>` : ""}
        </div>
        <p class="small muted">🔐 金鑰加密保存，只有伺服器用得到，任何人（包含管理員）都看不到完整內容。</p>`;
      $("#k-tavily", b).addEventListener("submit", (e) => {
        e.preventDefault();
        const k = e.target.k.value.trim();
        if (k) action({ action: "update_keys", tavily: k });
      });
      $("#k-gemini", b).addEventListener("submit", (e) => {
        e.preventDefault();
        const k = e.target.k.value.trim();
        if (k) action({ action: "update_keys", gemini: k });
      });
      $("#k-gemini-del", b)?.addEventListener("click", () => confirm("移除 Gemini 金鑰？") && action({ action: "update_keys", gemini: "" }));
      break;
    }
  }
}

function renderSettingsPanel(st, b) {
  els.panelTitle.textContent = "⚙️ 設定";
  const s = S.settings;
  const t = S.trip;
  const auto = store("ta-autoloc") === 1;
  const link = `${location.origin}/t/${ROOM}`;
  b.innerHTML = `
    <div class="card"><div class="row between"><div><b>${escapeHtml(S.me.name)}</b>${S.me.admin ? ' <span class="tag">管理員</span>' : ""}</div>
      <div class="row" style="gap:6px"><a class="btn" href="/">🏠 首頁</a><button class="btn" id="logout">登出</button></div></div></div>
    <div class="card"><h3>📤 邀請家人</h3>
      <div class="small muted">把這個網址傳給家人，${S.me.admin ? "旅伴密碼另外告訴他們" : "密碼請問管理員"}。</div>
      <div class="share-link">${escapeHtml(link)}</div>
      <div class="row" style="gap:6px"><button class="btn" id="copy-link">📋 複製網址</button>${navigator.share ? `<button class="btn" id="share-link">📤 分享</button>` : ""}</div>
    </div>
    <div class="card"><label class="row between"><span>自動分享我的位置給 AI<br><span class="small muted">每 5 分鐘更新，問「附近」時更準</span></span>
      <input type="checkbox" id="autoloc" ${auto ? "checked" : ""} /></label></div>
    <div class="card small">
      <div>${escapeHtml(t.flag)} ${escapeHtml(t.country)}${t.city ? `・${escapeHtml(t.city)}` : ""}｜${escapeHtml(t.timezone)}（${escapeHtml(t.diff)}）｜${escapeHtml(t.currency)}</div>
      <div>回覆方式：<b>${s.replyMode === "mention" ? "只回覆 @AI 的訊息" : "每則訊息都回覆"}</b></div>
      <div>網路搜尋：${s.tavily ? "✅ Tavily" : "⚠️ 未設定"}｜自己的 Gemini：${s.gemini ? "✅" : "未設定"}</div>
    </div>
    ${S.me.admin ? `
    <div class="card"><h3>管理員設定</h3>
      <div class="stack">
        <button class="btn" data-go="tripedit">🌏 旅程設定（日期、住宿、旅伴、當地資訊）</button>
        <button class="btn" data-go="keys">🔑 API 金鑰</button>
      </div>
      <div class="small muted" style="margin-top:10px">AI 回覆時機</div>
      <div class="seg" id="seg-mode">
        <label><input type="radio" name="mode" value="all" ${s.replyMode !== "mention" ? "checked" : ""} />每則都回</label>
        <label><input type="radio" name="mode" value="mention" ${s.replyMode === "mention" ? "checked" : ""} />只回 @AI</label>
      </div>
      <div class="small muted" style="margin-top:10px">自動通知（旅程期間，當地時間）</div>
      <label class="row between small"><span>☀️ 每天 07:00 早報</span><input type="checkbox" data-auto="autoBrief" ${s.autoBrief ? "checked" : ""} /></label>
      <label class="row between small"><span>📔 每天 22:00 旅遊日記</span><input type="checkbox" data-auto="autoDiary" ${s.autoDiary ? "checked" : ""} /></label>
      <label class="row between small"><span>🆘 地震、颱風、強風豪雨通知</span><input type="checkbox" data-auto="autoAlerts" ${s.autoAlerts ? "checked" : ""} /></label>
      <div class="row" style="gap:6px;margin-top:6px">
        <button class="btn small" id="brief-now">現在發一次早報</button>
        <button class="btn small" id="diary-now">現在寫今天的日記</button>
      </div>
    </div>
    <div class="card"><h3>🔒 更改密碼</h3>
      <form class="form" id="pw-form">
        <input name="room" placeholder="新的旅伴密碼（不改就留空）" autocomplete="off" />
        <input name="admin" placeholder="新的管理員密碼（不改就留空）" autocomplete="off" />
        <button class="btn primary-sm">更改</button>
        <span class="small muted">改完所有人都要重新登入。</span>
      </form>
    </div>
    <div class="card"><h3>🧹 清除資料</h3>
      <p class="small muted">測試結束、正式使用前使用。只會清除勾選的項目，<b>清除後無法復原</b>。</p>
      <form class="form" id="reset-form">
        <div class="checks">
          <label><input type="checkbox" name="chat" /> 聊天紀錄（含照片、位置）</label>
          <label><input type="checkbox" name="memory" /> 長期記憶與摘要</label>
          <label><input type="checkbox" name="expenses" /> 帳目</label>
          <label><input type="checkbox" name="itinerary" /> 行程（清空）</label>
          <label><input type="checkbox" name="tools" /> 清單勾選與自己加的項目、提醒、票券、日記</label>
        </div>
        <button class="btn danger">清除勾選的資料</button>
      </form>
    </div>
    <div class="card"><h3>🗑 刪除整個旅程</h3>
      <p class="small muted">聊天、照片、帳目、金鑰全部刪除，網址也會失效，<b>無法復原</b>。</p>
      <button class="btn danger" id="delete-trip">刪除這個旅程</button>
    </div>` : ""}`;
  $("#logout", b).addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  });
  $("#copy-link", b).addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(link);
      e.target.textContent = "✅ 已複製";
    } catch {
      prompt("複製這個網址", link);
    }
  });
  $("#share-link", b)?.addEventListener("click", () => navigator.share({ title: t.title, text: `一起用旅伴 AI 準備「${t.title}」`, url: link }).catch(() => {}));
  $("#autoloc", b).addEventListener("change", (e) => {
    store("ta-autoloc", e.target.checked ? 1 : 0);
    e.target.checked ? startAutoLocation() : stopAutoLocation();
  });
  b.querySelectorAll("[data-go]").forEach((x) => x.addEventListener("click", () => openPanel(x.dataset.go)));
  b.querySelectorAll("#seg-mode input").forEach((r) => r.addEventListener("change", () => action({ action: "settings", replyMode: r.value })));
  b.querySelectorAll("[data-auto]").forEach((x) => x.addEventListener("change", () => action({ action: "settings", [x.dataset.auto]: x.checked })));
  $("#brief-now", b)?.addEventListener("click", (e) => {
    e.target.textContent = "產生中…";
    action({ action: "brief_now" });
    els.panel.close();
  });
  $("#diary-now", b)?.addEventListener("click", (e) => {
    e.target.textContent = "產生中…";
    action({ action: "diary_now" });
    els.panel.close();
  });
  $("#pw-form", b)?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const room = String(f.get("room")).trim(), admin = String(f.get("admin")).trim();
    if (!room && !admin) return alert("請輸入新密碼");
    if (confirm("確定更改密碼？所有人（包含你）都要用新密碼重新登入。")) action({ action: "update_passwords", roomPassword: room, adminPassword: admin });
  });
  $("#reset-form", b)?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const names = { chat: "聊天紀錄", memory: "長期記憶與摘要", expenses: "帳目", itinerary: "行程", tools: "清單勾選、提醒、票券、日記" };
    const picked = Object.keys(names).filter((k) => f.get(k));
    if (!picked.length) return alert("請至少勾選一項");
    const typed = prompt(`即將清除：${picked.map((k) => names[k]).join("、")}\n所有人的資料都會被清除，無法復原。\n\n確定的話請輸入「清除」`);
    if (typed?.trim() !== "清除") return;
    action({ action: "reset", ...Object.fromEntries(picked.map((k) => [k, true])) });
    e.target.reset();
  });
  $("#delete-trip", b)?.addEventListener("click", () => {
    const typed = prompt(`刪除後所有資料都無法復原。\n\n確定的話請輸入旅程名稱「${t.title}」`);
    if (typed == null) return;
    if (typed.trim() !== t.title) return alert("名稱不符，沒有刪除");
    action({ action: "delete_trip", confirm: typed.trim() });
  });
}

// ================= 工具箱分頁 =================

function toolCards() {
  return [
    ["itinerary", "calendar", "行程", "每天的安排，可以修改"],
    ["tickets", "ticket", "票券保管箱", "門票、訂位憑證，離線可看"],
    ["map", "users", "家人位置", "看大家在哪、走散求救"],
    ["checklist", "list", "共用清單", "行李、購物、待辦"],
    ["reminders", "bell", "提醒", "時間到在群組通知"],
    ["diary", "book", "旅遊日記", "每晚自動寫、匯出相簿"],
  ];
}

function renderToolPanel(st, b) {
  switch (S.panel) {
    case "hub": {
      const t = S.trip || {};
      els.panelTitle.textContent = "工具箱";
      // 旅遊指南卡片直接露出幾個重點：時差、貨幣、緊急電話（取前兩個號碼）
      const sos = (String(t.emergency || "").match(/\d{3,4}/g) || []).slice(0, 2).join("／");
      const facts = [t.diff, t.currency && `${t.currency}（${t.currencySymbol}）`, sos && `緊急 ${sos}`].filter(Boolean);
      b.innerHTML = `
        <button class="tb-feature" data-go="travel">
          <span class="tb-feature-top"><span class="tb-icon-big">${svg("compass")}</span>
            <span style="flex:1;min-width:0"><span class="tb-feature-title">${escapeHtml(t.country || "")}旅遊指南</span><span class="small muted" style="display:block">入境、插座、交通、退稅、緊急電話</span></span>
            <span class="muted">${svg("chev")}</span></span>
          ${facts.length ? `<span class="tb-chips">${facts.map((f) => `<span>${escapeHtml(f)}</span>`).join("")}</span>` : ""}
        </button>
        <div class="tb-grid">${toolCards().map(([id, icon, name, desc]) => `<button class="tb-card" data-go="${id}"><span class="tb-icon">${svg(icon)}</span><b>${name}</b><span class="small muted">${desc}</span></button>`).join("")}</div>
        <div class="tb-list">
          <button data-go="memories">${svg("bookmark")}<span>長期記憶 <span class="small muted">AI 記得的偏好與決定</span></span><span class="chev">${svg("chev")}</span></button>
          <button data-go="guide">${svg("help")}<span>使用說明 <span class="small muted">每個功能怎麼用</span></span><span class="chev">${svg("chev")}</span></button>
        </div>`;
      b.querySelectorAll("[data-go]").forEach((x) => x.addEventListener("click", () => (x.dataset.go === "translator" ? openTranslator() : openPanel(x.dataset.go))));
      break;
    }
    case "guide":
      renderGuidePanel(b);
      break;
    case "travel":
      renderTravelPanel(b);
      break;
    case "map":
      renderMapPanel(st, b);
      break;
    case "checklist":
      renderChecklistPanel(st, b);
      break;
    case "tickets":
      renderTicketsPanel(st, b);
      break;
    case "reminders":
      renderRemindersPanel(st, b);
      break;
    case "diary":
      renderDiaryPanel(st, b);
      break;
  }
}

const backToHub = () => `<button class="btn small" data-go-hub>← 工具箱</button>`;
function bindBack(b) {
  b.querySelector("[data-go-hub]")?.addEventListener("click", () => openPanel("hub"));
}

// ---------- 📘 旅遊指南 ----------

function renderTravelPanel(b) {
  const t = S.trip;
  const g = t.guide || {};
  els.panelTitle.textContent = `📘 ${t.country}旅遊指南`;
  const rows = [
    ["🆘 緊急電話", t.emergency],
    ["🕐 時間", `${t.timezone}，${t.diff}`],
    ["💴 貨幣", `${t.currency}（${t.currencySymbol}）`],
    ["🗣 語言", t.language],
    ["🏨 住宿", [t.accommodation?.name, t.accommodation?.address, t.accommodation?.note].filter(Boolean).join("\n")],
    ...GUIDE_FIELDS.map(([k, label]) => [label, g[k]]),
  ].filter(([, v]) => v);
  b.innerHTML = `${backToHub()}
    <p class="small muted">建立旅程時 AI 查的資料。規定可能會變動，出發前請再確認；有問題直接在聊天問 AI。</p>
    ${rows.map(([k, v]) => `<div class="card"><h3>${k}</h3><div class="small" style="white-space:pre-wrap">${escapeHtml(v)}</div></div>`).join("")}
    ${g.sources?.length ? `<div class="card small"><h3>📚 資料來源</h3>${g.sources.map((s) => `<div><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></div>`).join("")}</div>` : ""}`;
  bindBack(b);
}

// ---------- 📖 使用說明 ----------

function guideItems() {
  const t = S.trip || {};
  const who = t.travelers?.[0]?.name || "爸爸";
  const sym = t.currencySymbol || "";
  return [
    ["☀️", "每日早報", "每天早上自動發，不用操作", [
      `旅程期間（${t.startDate || ""}–${t.endDate || ""}）每天<b>當地時間 07:00</b> 左右，AI 會在群組發一則早報。`,
      "內容有：今天的行程與建議出門時間、天氣和穿著、要不要帶傘、今天的提醒與待辦。",
      "如果有地震、颱風或豪雨，會放在最前面提醒。",
    ], ["今天的行程和天氣？"]],
    ["⏰", "提醒", "時間到在群組通知全家", [
      "在聊天說「<b>幾月幾號 幾點 提醒大家…</b>」，AI 會設好提醒。",
      "也可以到下方「工具箱」→ 提醒，選日期時間、打內容。",
      `時間一律是<b>當地時間</b>（${escapeHtml(t.diff || "")}）。`,
    ], ["明天早上 9:30 提醒大家出門", "有哪些提醒？"]],
    ["🆘", "災害警報", "有狀況自動通知，不用操作", [
      "從出發前一天到回國，系統每 5 分鐘檢查全球地震、颱風、洪水、火山資料，以及隔天的強風豪雨。",
      "住宿附近有較大的地震、會影響當地的颱風，會自動在群組發警報，附上緊急電話。",
    ], ["最近有地震或颱風嗎？會影響行程嗎？"]],
    ["🚕", "計程車估價", "叫車前先知道大概多少錢", [
      "直接問「從哪裡到哪裡，計程車要多少錢」。",
      "AI 會回答距離、車程時間、大概的車資範圍（依建立旅程時查到的當地費率）。",
    ], ["從住宿叫車到市中心要多少錢？"]],
    ...(t.countryCode === "JP" ? [["🚆", "電車狀況", "出門前查有沒有延誤、停駛", [
      "按輸入框左邊的「＋」→「<b>電車狀況</b>」，或直接問某條線。",
      "查的是 Yahoo!路線 的即時運行資訊。",
    ], ["山手線現在有延誤嗎？"]]] : []),
    ["🎢", "樂園排隊", "迪士尼、環球影城等即時等待時間", [
      "在樂園裡直接問「現在哪些設施排隊最少」。",
      "資料來自 Queue-Times，全球有上百座樂園。",
    ], ["附近有哪些樂園可以查排隊？"]],
    ["🧾", "收據記帳", "拍收據，AI 幫你記帳", [
      "按輸入框左邊的「＋」→「<b>收據</b>」→ 拍照或選收據照片，確認後送出。",
      "如果是別人付的，把「我付的」改成「媽媽付的」。",
      `AI 會讀出店名、金額，用${escapeHtml(t.currency || "當地貨幣")}記帳並換算台幣，按 💰 可以看誰該給誰多少。`,
    ], [`午餐 ${sym}3000，${who}付的`, "目前花了多少錢？大家要怎麼分？"]],
    ["✅", "共用清單", "購物、行李、待辦，全家同步", [
      "到下方「工具箱」→ 共用清單，分成<b>行李、購物、待辦</b>三頁；打勾全家同步。",
      "在聊天請 AI 加：要明確說「<b>加入清單</b>」才會加。",
    ], ["把紀念品加入購物清單", "護照已經帶好了，幫我打勾"]],
    ["🎫", "票券保管箱", "門票、訂位確認，沒網路也能看", [
      "到下方「工具箱」→ 票券保管箱上傳，或在聊天傳照片說「存成票券」。",
      "<b>打開過一次之後，沒網路也能看</b>。建議出發前先把每張都點開一次。",
    ], ["給我看博物館的門票"]],
    ...(hasTranslator() ? [["🌏", "翻譯", `中文 ↔ ${escapeHtml(lang())}`, [
      "按最下方的「<b>翻譯</b>」，有常用句、即時翻譯（可語音輸入）和翻譯紀錄。",
      "點常用句就會念出來；📺 可以放大給司機、店員看。",
    ], []]] : []),
    ["🗺", "家人位置地圖", "看大家在哪，走散一鍵求救", [
      "到下方「工具箱」→ 家人位置，地圖上會顯示每個人最後的位置和住宿 🏠。",
      "走散了就按「<b>🆘 我走散了</b>」，你的位置會傳到群組，全家畫面會跳出紅色提示。",
    ], ["大家現在在哪裡？"]],
    ["📔", "旅遊日記", "每晚自動寫，可匯出相簿", [
      "旅程期間每晚<b>當地時間 22:00</b>，AI 會用當天的聊天和照片寫一篇日記。",
      "到下方「工具箱」→ 旅遊日記，按「📖 打開相簿」可以列印或存成 PDF。",
    ], []],
  ];
}

function renderGuidePanel(b) {
  els.panelTitle.textContent = "📖 使用說明";
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">點開每個功能看怎麼用。範例問法點一下會填進輸入框，確認後再按送出。</p>
    ${guideItems().map(([icon, name, tagline, steps, examples]) => `<details class="card guide">
      <summary><span class="guide-icon">${icon}</span><span><b>${name}</b><span class="small muted">${tagline}</span></span></summary>
      <ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      ${examples.length ? `<div class="guide-try">${examples.map((q) => `<button type="button" data-try="${escapeHtml(q)}">💬 ${escapeHtml(q)}</button>`).join("")}</div>` : ""}
    </details>`).join("")}`;
  bindBack(b);
  b.querySelectorAll("[data-try]").forEach((x) =>
    x.addEventListener("click", () => {
      els.input.value = x.dataset.try;
      els.input.dispatchEvent(new Event("input"));
      els.panel.close();
      els.input.focus();
    }),
  );
}

// ---------- 🗺 家人位置地圖 ----------

let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js";
    js.onload = resolve;
    js.onerror = () => {
      leafletLoading = null;
      reject(new Error("地圖載入失敗"));
    };
    document.head.appendChild(js);
  });
  return leafletLoading;
}

let leafletMap = null;
function renderMapPanel(st, b) {
  els.panelTitle.textContent = "🗺 家人位置";
  const locs = st.locations ?? [];
  b.innerHTML = `
    ${backToHub()}
    <div id="family-map" class="family-map"></div>
    <div class="list card">
      ${locs.length
        ? locs.map((l) => `<div class="item small"><span><b>${escapeHtml(l.name)}</b>　${escapeHtml(l.area || "")}</span><span class="muted">${Math.max(0, Math.round((Date.now() - l.ts) / 60000))} 分鐘前</span></div>`).join("")
        : `<div class="small muted">還沒有人分享位置。按下面的按鈕分享，或在下方「設定」開啟「自動分享位置」。</div>`}
    </div>
    <div class="row" style="gap:8px">
      <button class="btn" id="map-share" style="flex:1">📍 更新我的位置</button>
      <button class="btn danger sos-btn" id="map-sos" style="flex:1">🆘 我走散了</button>
    </div>
    <p class="small muted">按「🆘 我走散了」會把你的位置傳到群組，全家手機都會收到提醒，AI 也會幫忙安排集合地點。</p>`;
  bindBack(b);
  $("#map-share").addEventListener("click", async () => {
    try {
      const p = await getPosition();
      wsSend({ type: "location", ...p });
      setTimeout(() => wsSend({ type: "get_state" }), 2500);
      $("#map-share").textContent = "✅ 已更新";
    } catch (err) {
      alert(err.message);
    }
  });
  $("#map-sos").addEventListener("click", async () => {
    if (!confirm("確定要通知全家你走散了嗎？")) return;
    let loc = null;
    try {
      loc = await getPosition();
    } catch {}
    wsSend({ type: "send", text: "🆘 我跟大家走散了，請幫忙！", location: loc });
    els.panel.close();
  });
  loadLeaflet()
    .then(() => {
      const el = $("#family-map");
      if (!el || !window.L) return;
      leafletMap?.remove();
      const a = st.trip?.accommodation;
      const home = a?.lat != null ? [a.lat, a.lon] : st.trip?.center ? [st.trip.center.lat, st.trip.center.lon] : null;
      const points = locs.map((l) => [l.lat, l.lon]);
      leafletMap = L.map(el, { zoomControl: true }).setView(points[0] ?? home ?? [25.03, 121.56], 15);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(leafletMap);
      locs.forEach((l) => {
        L.circleMarker([l.lat, l.lon], { radius: 10, color: "#fff", weight: 3, fillColor: colorFor(l.name), fillOpacity: 1 })
          .addTo(leafletMap)
          .bindTooltip(`${l.name}（${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`, { permanent: true, direction: "top" });
      });
      if (a?.lat != null) L.marker([a.lat, a.lon]).addTo(leafletMap).bindTooltip("🏠 住宿");
      if (points.length > 1) leafletMap.fitBounds(points, { padding: [40, 40] });
      setTimeout(() => leafletMap?.invalidateSize(), 200);
    })
    .catch(() => {
      const el = $("#family-map");
      if (el) el.innerHTML = `<div class="small muted" style="padding:16px">地圖載入失敗，請確認網路</div>`;
    });
}

function showSos(msg) {
  navigator.vibrate?.([300, 150, 300, 150, 600]);
  const banner = $("#sos-banner");
  banner.innerHTML = `🆘 <b>${escapeHtml(msg.author)}</b> 走散了！點這裡看位置`;
  banner.hidden = false;
  banner.onclick = () => {
    banner.hidden = true;
    wsSend({ type: "get_state" });
    openPanel("map");
  };
  setTimeout(() => (banner.hidden = true), 60_000);
}

// ---------- ✅ 清單 ----------

let checklistTab = "行李";
function renderChecklistPanel(st, b) {
  els.panelTitle.textContent = "✅ 清單";
  const all = st.checklist ?? [];
  const items = all.filter((c) => c.list === checklistTab);
  const left = items.filter((c) => !c.done).length;
  b.innerHTML = `
    ${backToHub()}
    <div class="tr-dir">${["行李", "購物", "待辦"].map((t) => `<button data-tab="${t}" class="${t === checklistTab ? "active" : ""}">${t}（${all.filter((c) => c.list === t && !c.done).length}）</button>`).join("")}</div>
    <div class="card"><div class="list">
      ${items.length
        ? items.map((c) => `<label class="item check-item ${c.done ? "done" : ""}">
            <span><input type="checkbox" data-id="${c.id}" ${c.done ? "checked" : ""} /> ${escapeHtml(c.item)}${c.for ? ` <span class="tag">${escapeHtml(c.for)}</span>` : ""}${c.done_by ? `<span class="small muted">（${escapeHtml(c.done_by)} ✓）</span>` : ""}</span>
            <button class="btn danger small" data-del="${c.id}" type="button">✕</button></label>`).join("")
        : `<div class="small muted">還沒有項目</div>`}
    </div><div class="small muted" style="margin-top:6px">剩 ${left} 項。也可以在聊天說「把紀念品加入購物清單」「護照帶了」，AI 會幫你更新。</div></div>
    <div class="card"><form class="form" id="ck-form">
      <textarea name="item" rows="2" placeholder="一行一項，例如：&#10;轉接頭&#10;雨傘" required></textarea>
      <div class="row"><input name="forWhom" placeholder="給誰（可留空）" style="flex:1" /><button class="btn primary-sm">加入${checklistTab}</button></div>
    </form></div>`;
  bindBack(b);
  b.querySelectorAll("[data-tab]").forEach((x) =>
    x.addEventListener("click", () => {
      checklistTab = x.dataset.tab;
      renderPanel();
    }),
  );
  b.querySelectorAll("input[type=checkbox][data-id]").forEach((x) => x.addEventListener("change", () => action({ action: "checklist_toggle", id: Number(x.dataset.id), done: x.checked })));
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這一項？") && action({ action: "checklist_delete", id: Number(x.dataset.del) })));
  b.querySelector("#ck-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    action({ action: "checklist_add", list: checklistTab, item: f.get("item"), forWhom: f.get("forWhom") });
  });
}

// ---------- 🎫 票券保管箱 ----------

function renderTicketsPanel(st, b) {
  els.panelTitle.textContent = "🎫 票券保管箱";
  const docs = st?.documents ?? store(`ta-docs-${ROOM}`) ?? [];
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">門票、訂位確認、QR Code 存在這裡，全家都看得到；<b>打開過一次之後，沒網路也能看</b>。也可以在聊天傳照片說「存成票券」。</p>
    ${st ? `<div class="card"><form class="form" id="doc-form">
      <input name="title" placeholder="名稱，例如：博物館門票 10/4 11:00" required />
      <input name="note" placeholder="備註（可留空）" />
      <input name="photo" type="file" accept="image/*" required />
      <button class="btn primary-sm" id="doc-save">上傳</button>
    </form></div>` : ""}
    <div class="doc-grid">${docs.length
      ? docs.map((d) => `<div class="card doc">
          <img src="${escapeHtml(d.photo)}" loading="lazy" alt="" />
          <b>${escapeHtml(d.title)}</b>${d.note ? `<div class="small muted">${escapeHtml(d.note)}</div>` : ""}
          <div class="row between small muted"><span>${escapeHtml(d.author)}</span>${st ? `<button class="btn danger small" data-del="${d.id}">刪除</button>` : ""}</div>
        </div>`).join("")
      : `<div class="card small muted">還沒有票券</div>`}</div>`;
  bindBack(b);
  // 預先載入所有票券照片，讓離線快取有東西可看
  docs.forEach((d) => fetch(d.photo).catch(() => {}));
  b.querySelectorAll(".doc img").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這張票券？") && action({ action: "document_delete", id: Number(x.dataset.del) })));
  b.querySelector("#doc-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const file = f.get("photo");
    if (!file || !file.size) return;
    const btn = $("#doc-save");
    btn.disabled = true;
    btn.textContent = "上傳中…";
    try {
      const blob = await resizeImage(file, 1600, 0.88);
      const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": blob.type }, body: blob });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
      const { id } = await res.json();
      action({ action: "document_save", title: f.get("title"), note: f.get("note"), photoId: id });
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "上傳";
    }
  });
}

// ---------- ⏰ 提醒 ----------

function renderRemindersPanel(st, b) {
  els.panelTitle.textContent = "⏰ 提醒";
  const rs = st.reminders ?? [];
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">時間到了會在群組發訊息通知全家（<b>當地時間</b>，${escapeHtml(S.trip.diff)}）。也可以在聊天說「明天早上 9:30 提醒大家出門」。</p>
    <div class="card"><div class="list">
      ${rs.length
        ? rs.map((r) => `<div class="item small"><div><b>${escapeHtml(r.time)}</b><div>${escapeHtml(r.message)}</div><div class="muted">${escapeHtml(r.by)}</div></div><button class="btn danger small" data-del="${r.id}">刪除</button></div>`).join("")
        : `<div class="small muted">沒有待發的提醒</div>`}
    </div></div>
    <div class="card"><form class="form" id="rm-form">
      <label class="small muted">日期時間（當地時間）<input name="at" type="datetime-local" required /></label>
      <input name="message" placeholder="提醒內容，例如：出門囉！" required />
      <button class="btn primary-sm">新增提醒</button>
    </form></div>`;
  bindBack(b);
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => action({ action: "reminder_delete", id: Number(x.dataset.del) })));
  b.querySelector("#rm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    // 輸入的是旅遊地的當地時間，由伺服器依時區換算
    action({ action: "reminder_add", local: String(f.get("at")), message: f.get("message") });
  });
}

// ---------- 📔 旅遊日記 ----------

function renderDiaryPanel(st, b) {
  els.panelTitle.textContent = "📔 旅遊日記";
  const ds = st.diaries ?? [];
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">旅途中每晚 22:00（當地時間）AI 會用當天的對話和照片寫一篇日記。</p>
    <a class="btn primary-sm" href="/api/album" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none">📖 打開相簿（可列印／存成 PDF）</a>
    ${ds.length
      ? ds.map((d) => {
          const photos = JSON.parse(d.photo_ids || "[]");
          return `<div class="card"><h3>${escapeHtml(String(d.date).slice(5).replace("-", "/"))}</h3>
            <div class="small" style="white-space:pre-wrap">${escapeHtml(d.text)}</div>
            ${photos.length ? `<div class="gallery">${photos.map((p) => `<figure><img class="photo web" src="/api/photo/${escapeHtml(p)}" loading="lazy" /></figure>`).join("")}</div>` : ""}
          </div>`;
        }).join("")
      : `<div class="card small muted">還沒有日記</div>`}`;
  bindBack(b);
  b.querySelectorAll(".gallery img").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
}

// ================= 翻譯（中文 ↔ 當地語言） =================

const TR = { tab: "phrases", from: "zh", history: [], result: null, busy: false, adding: false, rec: null, reqId: null };

function phrasesData() {
  return S.state?.phrases ?? store(`ta-phrases-${ROOM}`) ?? [];
}

// ---------- 語音：念出來（瀏覽器內建，免費、離線也能用） ----------

let voices = [];
function loadVoices() {
  voices = "speechSynthesis" in window ? speechSynthesis.getVoices() : [];
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

function speak(text, which = "local") {
  if (!("speechSynthesis" in window)) return alert("這個瀏覽器不支援朗讀");
  speechSynthesis.cancel();
  const code = which === "local" ? S.trip?.langCode || "en-US" : "zh-TW";
  const u = new SpeechSynthesisUtterance(String(text).replace(/\n+/g, "、"));
  u.lang = code;
  u.rate = which === "local" ? 0.9 : 1;
  const short = code.slice(0, 2);
  const v = voices.find((x) => x.lang.replace("_", "-") === code) ?? voices.find((x) => x.lang.startsWith(short));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ---------- 全螢幕給對方看 ----------

let showcaseItem = null;
function showBig(item) {
  showcaseItem = item;
  $("#showcase-local").textContent = item.local;
  $("#showcase-reading").textContent = item.reading || "";
  $("#showcase-zh").textContent = item.zh || "";
  if (!els.showcase.open) els.showcase.showModal();
}
$("#showcase-speak").addEventListener("click", () => showcaseItem && speak(showcaseItem.local, "local"));
$("#showcase-close").addEventListener("click", () => els.showcase.close());

// ---------- 開關與分頁 ----------

function openTranslator() {
  renderTranslator();
  if (!els.translator.open) els.translator.showModal();
}
$("#tr-close").addEventListener("click", () => {
  TR.rec?.stop();
  els.translator.close();
});
els.trTabs.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    TR.rec?.stop();
    TR.tab = b.dataset.tab;
    if (TR.tab === "history" && S.ws?.readyState === 1) action({ action: "get_translations" });
    renderTranslator();
  }),
);

function renderTranslator() {
  els.trTabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === TR.tab));
  const b = els.trBody;
  if (TR.tab === "phrases") {
    const cats = [...new Set(phrasesData().map((p) => p.category))];
    if (!cats.includes("⭐ 我的常用句")) cats.push("⭐ 我的常用句");
    b.innerHTML = `
      <p class="small muted">點一下就用${escapeHtml(lang())}念出來；📺 放大給司機、店員看。全家共用，沒網路也能用。</p>
      <div id="ph-list"></div>
      <div class="card"><h3>➕ 新增常用句</h3>
        <form class="form" id="ph-form">
          <input name="zh" placeholder="輸入中文，例如：請問有推薦的菜嗎？" required />
          <div class="row">
            <select name="category">${cats.map((c) => `<option>${escapeHtml(c)}</option>`).join("")}</select>
            <button class="btn primary-sm" id="ph-add">${TR.adding ? "翻譯中…" : `新增（自動翻成${escapeHtml(lang())}）`}</button>
          </div>
        </form>
      </div>`;
    renderPhraseList();
    b.querySelector("#ph-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      TR.adding = true;
      e.target.querySelector("#ph-add").textContent = "翻譯中…";
      if (!action({ action: "add_phrase", zh: f.get("zh"), category: f.get("category") })) TR.adding = false;
      e.target.reset();
    });
  } else if (TR.tab === "live") {
    renderLive();
  } else {
    b.innerHTML = TR.history.length
      ? `<p class="small muted">全家的翻譯紀錄，點一下再念一次。AI 也看得到這些紀錄。</p>` +
        TR.history
          .map((t, i) => `<div class="card tr-item" data-i="${i}">
              <div class="small muted">${escapeHtml(t.author)}｜${dayText(t.ts)} ${timeText(t.ts)}｜${t.from_lang === "zh" ? `中→${escapeHtml(lang())}` : `${escapeHtml(lang())}→中`}</div>
              <div>${escapeHtml(t.source)}</div>
              <div class="tr-out">${escapeHtml(t.result)}</div>
              <div class="row"><button class="btn small" data-speak="${i}">🔊</button><button class="btn small" data-show="${i}">📺</button></div>
            </div>`)
          .join("")
      : `<div class="card small muted">還沒有翻譯紀錄</div>`;
    const item = (i) => {
      const t = TR.history[i];
      return t.from_lang === "zh" ? { local: t.result, reading: t.reading, zh: t.source } : { local: t.source, zh: t.result };
    };
    b.querySelectorAll("[data-speak]").forEach((x) => x.addEventListener("click", () => speak(item(x.dataset.speak).local, "local")));
    b.querySelectorAll("[data-show]").forEach((x) => x.addEventListener("click", () => showBig(item(x.dataset.show))));
  }
}

function renderPhraseList() {
  const list = $("#ph-list");
  if (!list) return;
  const phrases = phrasesData();
  const cats = [...new Set(phrases.map((p) => p.category))];
  list.innerHTML = phrases.length
    ? cats
        .map((c) => `<h3 class="ph-cat">${escapeHtml(c)}</h3><div class="ph-grid">${phrases
          .filter((p) => p.category === c)
          .map((p) => `<div class="phrase" data-id="${p.id}">
              <div class="ph-zh">${escapeHtml(p.zh)}</div>
              <div class="ph-ja">${escapeHtml(p.local)}</div>
              ${p.reading ? `<div class="ph-kana">${escapeHtml(p.reading)}</div>` : ""}
              <div class="ph-actions">
                <button class="btn small" data-show>📺 給對方看</button>
                <button class="btn small danger" data-del title="刪除">✕</button>
              </div>
            </div>`)
          .join("")}</div>`)
        .join("")
    : `<div class="card small muted">還沒有常用句，可以在下面新增。</div>`;
  list.querySelectorAll(".phrase").forEach((el) => {
    const p = phrases.find((x) => String(x.id) === el.dataset.id);
    el.addEventListener("click", () => {
      speak(p.local, "local");
      el.classList.add("speaking");
      setTimeout(() => el.classList.remove("speaking"), 1200);
    });
    el.querySelector("[data-show]").addEventListener("click", (e) => {
      e.stopPropagation();
      showBig(p);
      speak(p.local, "local");
    });
    el.querySelector("[data-del]").addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`刪除「${p.zh}」？（全家都會刪除）`)) action({ action: "delete_phrase", id: p.id });
    });
  });
}

// ---------- 即時翻譯 ----------

function renderLive() {
  const b = els.trBody;
  const zh = TR.from === "zh";
  const r = TR.result;
  b.innerHTML = `
    <div class="tr-dir">
      <button data-from="zh" class="${zh ? "active" : ""}">中文 → ${escapeHtml(lang())}</button>
      <button data-from="local" class="${zh ? "" : "active"}">${escapeHtml(lang())} → 中文</button>
    </div>
    <textarea id="tr-input" rows="4" placeholder="${zh ? "輸入或按 🎤 說中文" : `請對方輸入或按 🎤 說${escapeHtml(lang())}`}"></textarea>
    <div class="row tr-controls">
      <button class="btn tr-mic" id="tr-mic">🎤 ${zh ? "說中文" : `說${escapeHtml(lang())}`}</button>
      <button class="btn primary-sm tr-go" id="tr-go">${TR.busy ? "翻譯中…" : "翻譯"}</button>
    </div>
    ${
      r
        ? `<div class="card tr-result">
            <div class="small muted">${escapeHtml(r.source)}</div>
            <div class="tr-out big-text">${escapeHtml(r.result)}</div>
            ${r.reading ? `<div class="ph-kana">${escapeHtml(r.reading)}</div>` : ""}
            <div class="row tr-actions">
              <button class="btn" id="tr-speak">🔊 念出來</button>
              <button class="btn" id="tr-show">📺 給對方看</button>
              <button class="btn" id="tr-copy">📋 複製</button>
              <button class="btn" id="tr-swap">↔ 換對方說</button>
            </div>
          </div>`
        : `<p class="small muted">說完或打完按「翻譯」。語音輸入說完會自動翻譯。</p>`
    }`;
  b.querySelectorAll("[data-from]").forEach((x) =>
    x.addEventListener("click", () => {
      TR.rec?.stop();
      TR.from = x.dataset.from;
      renderLive();
    }),
  );
  $("#tr-mic").addEventListener("click", toggleMic);
  $("#tr-go").addEventListener("click", doTranslate);
  updateMic();
  if (r) {
    const local = r.from_lang === "zh" ? r.result : r.source;
    $("#tr-speak").addEventListener("click", () => speak(r.result, r.from_lang === "zh" ? "local" : "zh"));
    $("#tr-show").addEventListener("click", () => showBig(r.from_lang === "zh" ? { local, reading: r.reading, zh: r.source } : { local, zh: r.result }));
    $("#tr-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(r.result);
        $("#tr-copy").textContent = "✅ 已複製";
      } catch {}
    });
    $("#tr-swap").addEventListener("click", () => {
      TR.from = TR.from === "zh" ? "local" : "zh";
      renderLive();
      toggleMic();
    });
  }
}

function doTranslate() {
  const input = $("#tr-input");
  const text = input?.value.trim();
  if (!text || TR.busy) return;
  TR.reqId = Math.random().toString(36).slice(2);
  if (!action({ action: "translate", text, from: TR.from, reqId: TR.reqId })) return;
  TR.busy = true;
  $("#tr-go").textContent = "翻譯中…";
}

function onTranslation(m) {
  TR.history.unshift(m.item);
  if (m.reqId && m.reqId === TR.reqId) {
    TR.busy = false;
    TR.result = m.item;
    if (els.translator.open && TR.tab === "live") {
      renderLive();
      // 中文 → 當地語言：翻好直接念給對方聽
      if (m.item.from_lang === "zh") speak(m.item.result, "local");
    }
  } else if (els.translator.open && TR.tab === "history") {
    renderTranslator();
  }
}

function trActionDone(m) {
  if (m.action === "translate" && !m.ok) {
    TR.busy = false;
    if ($("#tr-go")) $("#tr-go").textContent = "翻譯";
  }
  if (m.action === "add_phrase") {
    TR.adding = false;
    if ($("#ph-add")) $("#ph-add").textContent = `新增（自動翻成${lang()}）`;
  }
}

// ---------- 語音輸入（瀏覽器內建） ----------

function updateMic() {
  const btn = $("#tr-mic");
  if (!btn) return;
  btn.classList.toggle("listening", !!TR.rec);
  btn.textContent = TR.rec ? "⏹ 說完了" : `🎤 ${TR.from === "zh" ? "說中文" : `說${lang()}`}`;
}

function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("這個瀏覽器不支援語音輸入，可以改用手機鍵盤上的 🎤 聽寫。");
  if (TR.rec) return TR.rec.stop();
  const input = $("#tr-input");
  const base = input.value.trim() ? input.value.trim() + " " : "";
  const rec = new SR();
  rec.lang = TR.from === "zh" ? "zh-TW" : S.trip?.langCode || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let t = "";
    for (const r of e.results) t += r[0].transcript;
    input.value = base + t;
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") alert("請允許這個網站使用麥克風");
  };
  rec.onend = () => {
    TR.rec = null;
    updateMic();
    // 說完自動翻譯
    if (input.value.trim() && input.value.trim() !== base.trim()) doTranslate();
  };
  TR.rec = rec;
  try {
    rec.start();
  } catch {
    TR.rec = null;
  }
  updateMic();
}

// 離線快取（常用句、票券照片沒網路也能用；畫面更新也會立刻生效）
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

if (ROOM) checkSession();
else if (location.pathname === "/new") renderWizard();
else renderLanding();
