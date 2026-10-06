// 旅伴 AI 聊天室：即時群聊（WebSocket）、照片、定位、行程／記帳／記憶面板、工具箱、翻譯
const els = {
  app: $("#app"), messages: $("#messages"), loadMore: $("#load-more"), toLatest: $("#to-latest"), toLatestN: $("#to-latest-n"), conn: $("#conn"),
  dayBadge: $("#day-badge"), todayTitle: $("#today-title"), online: $("#online"), avatars: $("#avatars"), chips: $("#chips"),
  replyBar: $("#reply-bar"), pinBar: $("#pin-bar"), pins: $("#pins"), pinList: $("#pin-list"),
  nextCard: $("#next-card"), ncToggle: $("#nc-toggle"), chipsToggle: $("#chips-toggle"), tabbar: $("#tabbar"), more: $("#more"), moreActions: $("#more-actions"), moreAsks: $("#more-asks"),
  input: $("#input"), sendForm: $("#send-form"), sendBtn: $("#send-btn"), photoInput: $("#photo-input"),
  attach: $("#attach"), attachImgs: $("#attach-imgs"), attachLoc: $("#attach-loc"), attachClear: $("#attach-clear"),
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
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pushpin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
};
ICONS.mic = '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>';
ICONS.notebook = '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M2 6h4M2 10h4M2 14h4M2 18h4M15 2v20"/>';
ICONS.file = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>';
ICONS.idcard = '<rect width="20" height="14" x="2" y="5" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h4"/>';
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
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${ROOM}`);
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
  if (document.visibilityState !== "visible") return;
  if (S.ws && S.ws.readyState > 1) connect();
  else if (!S.offline) fetch(`/api/me?room=${ROOM}`).catch(() => {});
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
      checkVersion(m.version);
      S.me = m.me;
      S.aiName = m.aiName;
      S.settings = m.settings;
      S.status = m.status;
      setState(m.state);
      if (m.locateReq && m.locateReq.by !== m.me?.name && m.status === "active") reportLocationFor(m.locateReq);
      const t = S.trip;
      rememberTrip({ id: ROOM, title: t.title, flag: t.flag, kind: t.kind || "trip", dates: t.kind === "personal" ? "個人助理" : `${t.startDate} – ${t.endDate}` });
      if (m.status === "initializing") return renderInit(m.initProgress);
      if (m.status === "review") return S.me.admin ? renderReview() : renderWaitReview();
      if (els.panel.open && S.panel === "tripedit") els.panel.close();
      showApp();
      els.messages.querySelectorAll(".msg, .day-sep, .unread-sep").forEach((n) => n.remove());
      S.lastDay = null;
      S.live.clear();
      m.messages.forEach((msg) => appendMessage(msg));
      const shared = new URLSearchParams(location.search).get("share");
      if (shared && isPersonal()) {
        history.replaceState(null, "", location.pathname);
        S.ws.send(JSON.stringify({ type: "send", text: `存到知識庫：${shared.slice(0, 4000)}` }));
      }
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
      if (["settings", "keys", "diary", "memo"].includes(S.panel)) renderPanel();
      break;
    case "health_result":
      healthResult = m;
      if (S.panel === "health") renderPanel();
      break;
    case "health_import_result":
      importDone(m.result);
      break;
    case "note_text":
      S.noteText[m.id] = m.text;
      if (S.panel === "notes") renderPanel();
      break;
    case "memo_transcript":
      S.memoText[m.id] = m.text;
      if (S.panel === "memo") renderPanel();
      break;
    case "state":
      setState(m.state);
      break;
    case "locate_request":
      if (m.by !== S.me?.name) reportLocationFor(m);
      break;
    case "locations":
      if (S.state) {
        S.state.locations = m.locations;
        clearTimeout(S.mapRedraw);
        if (S.panel === "map") S.mapRedraw = setTimeout(() => S.panel === "map" && renderPanel(), 800);
      }
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
      if (m.action === "diary_edit") {
        if (m.ok) {
          S.diaryEdit = null;
          if (S.panel === "diary-edit") openPanel("diary");
        } else {
          const sv = $("#de-save");
          if (sv) {
            sv.disabled = false;
            sv.textContent = "儲存";
          }
        }
      }
      if (m.action === "diary_now" && S.panel === "diary") renderPanel();
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

/** 健康管家的回答、提醒、警示 */
const healthMeta = (meta) => !!meta?.health || String(meta?.kind ?? "").startsWith("health");

function messageNode(msg) {
  const isAI = msg.role === "assistant";
  const isMe = !isAI && msg.author === S.me?.name;
  const node = document.createElement("div");
  node.className = `msg ${isAI ? "ai" : isMe ? "me" : "other"}`;
  node.dataset.id = msg.id;
  node.dataset.ts = msg.ts;
  let body = "";
  // 這則是在回覆別的訊息：上面顯示引用，點一下跳回原訊息
  if (!isAI && msg.meta?.reply) body += `<button type="button" class="quote" data-quote="${escapeHtml(msg.meta.reply.id)}"><b>${escapeHtml(msg.meta.reply.author)}</b><span>${escapeHtml(plainExcerpt({ text: msg.meta.reply.text }))}</span></button>`;
  const pics = msg.photos?.length ? msg.photos : msg.photo ? [msg.photo] : [];
  if (pics.length > 1) body += `<div class="photo-grid">${pics.map((src) => `<img class="photo" src="${escapeHtml(src)}" loading="lazy" alt="照片" />`).join("")}</div>`;
  else if (pics.length) body += `<img class="photo" src="${escapeHtml(pics[0])}" loading="lazy" alt="照片" />`;
  if (msg.location) {
    const url = `https://www.google.com/maps/search/?api=1&query=${msg.location.lat},${msg.location.lon}`;
    body += `<div class="loc-card">📍 <a href="${url}" target="_blank" rel="noopener">分享了目前位置</a></div>`;
  }
  // 文字部分包一層，「複製」只拿這段（不含圖片說明）
  if (msg.text) body += isAI ? `<div class="msg-text">${md(msg.text)}</div>` : `<span class="msg-text">${escapeHtml(msg.text).replace(/\n/g, "<br>")}</span>`;
  const pinned = S.pinned?.has(msg.id);
  if (pinned) node.classList.add("pinned");
  const actions = `<div class="msg-actions"><button type="button" data-act="reply">${svg("reply")}<span>回覆</span></button><button type="button" data-act="copy">${svg("copy")}<span>複製</span></button><button type="button" data-act="pin">${svg("pushpin")}<span>${pinned ? "取消置頂" : "置頂"}</span></button></div>`;
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
    const hm = healthMeta(msg.meta);
    node.innerHTML = `<div class="ai-card${hm ? " health" : ""}">
      <div class="ai-head"><span class="ai-avatar">${svg(hm ? "heart" : "luggage")}</span><span class="ai-name">${hm ? "🩺 健康管家" : escapeHtml(msg.author)}</span>
        <span class="ai-tools">${(msg.meta?.tools ?? []).map(toolBadge).join("")}</span>
        <span class="ai-time">${timeText(msg.ts)}${provider ? ` · ${escapeHtml(provider)}` : ""}</span></div>
      <div class="ai-body rich">${body}</div>
      ${(msg.drafts ?? []).map(draftHtml).join("")}
      ${actions}
    </div>`;
  } else if (isMe) {
    node.innerHTML = `<div class="bubble-wrap"><div class="bubble rich">${body}</div><div class="meta">${timeText(msg.ts)}</div>${actions}</div>`;
  } else {
    node.innerHTML = `<div class="avatar" style="background:${colorFor(msg.author)}">${escapeHtml([...msg.author][0])}</div>
      <div class="bubble-wrap"><div class="name">${escapeHtml(msg.author)}・${timeText(msg.ts)}</div><div class="bubble rich">${body}</div>${actions}</div>`;
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

// ---------- 新版自動更新：每次部署版本號都不同，重新連線時比對 ----------
// 主畫面 App 從背景切回來不會重新載入程式，不處理的話會一直用舊版
function checkVersion(v) {
  if (!v) return;
  if (!S.version) S.version = v;
  else if (v !== S.version && !S.updateReady) {
    S.updateReady = true;
    if (document.hidden) return location.reload();
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "update-bar";
    bar.textContent = "🔄 新版本已推出，點這裡更新";
    bar.addEventListener("click", () => location.reload());
    els.conn.after(bar);
  }
}
// 切回 App 時，沒有打到一半的訊息就直接換新版
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.updateReady && !els.input.value.trim() && !document.querySelector("dialog[open]")) location.reload();
});

// ---------- 複製與置頂 ----------

els.messages.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const msgEl = btn.closest(".msg");
    if (btn.dataset.act === "copy") copyText(msgEl.querySelector(".msg-text")?.innerText.trim() || "", btn);
    else if (btn.dataset.act === "reply") startReply(msgEl);
    else action({ action: S.pinned?.has(msgEl.dataset.id) ? "unpin" : "pin", id: msgEl.dataset.id });
    return;
  }
  const quote = e.target.closest(".quote");
  if (quote) {
    const orig = els.messages.querySelector(`.msg[data-id="${quote.dataset.quote}"]`);
    if (orig) {
      orig.scrollIntoView({ block: "center", behavior: "smooth" });
      orig.classList.remove("flash");
      requestAnimationFrame(() => orig.classList.add("flash"));
    }
    return;
  }
  // 家人的訊息點一下才出現「複製／置頂」，畫面比較乾淨
  const bubble = e.target.closest(".msg:not(.ai) .bubble");
  if (bubble && !e.target.closest("a, img")) bubble.closest(".msg").classList.toggle("show-actions");
});

/** 回覆某一則訊息：輸入框上方顯示要回覆的內容，送出時一起帶給 AI */
function startReply(msgEl) {
  const author = msgEl.classList.contains("ai") ? S.aiName : msgEl.classList.contains("me") ? S.me.name : (msgEl.querySelector(".name")?.textContent || "").split("・")[0];
  const text = (msgEl.querySelector(".msg-text")?.innerText || "").replace(/\s+/g, " ").trim();
  S.replyTo = { id: msgEl.dataset.id, author, text: text.slice(0, 80) || "（照片）" };
  renderReplyBar();
  els.input.focus();
}

function renderReplyBar() {
  const r = S.replyTo;
  els.replyBar.hidden = !r;
  if (r) els.replyBar.innerHTML = `${svg("reply")}<span><b>回覆 ${escapeHtml(r.author)}</b>${escapeHtml(r.text)}</span><button type="button" class="icon" aria-label="取消回覆">✕</button>`;
}
els.replyBar.addEventListener("click", (e) => {
  if (!e.target.closest("button")) return;
  S.replyTo = null;
  renderReplyBar();
});

async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // 舊瀏覽器或沒有權限：用隱藏的文字框複製
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  const label = btn?.querySelector("span") ?? btn;
  if (!label) return;
  const old = label.textContent;
  label.textContent = ok ? "已複製 ✓" : "複製失敗";
  setTimeout(() => (label.textContent = old), 1500);
}

function plainExcerpt(msg) {
  const t = String(msg.text || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*(?:[-•]|\d+\.)\s+/gm, "").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  return t.slice(0, 80) || (msg.photo ? "（照片）" : msg.location ? "（位置）" : "");
}

/** 置頂：上方一條細列（不佔聊天空間），點開看全部；訊息上的按鈕跟著更新 */
function renderPins(pins = []) {
  S.pins = pins;
  S.pinned = new Set(pins.map((p) => p.message.id));
  els.messages.querySelectorAll(".msg[data-id]").forEach((n) => {
    const on = S.pinned.has(n.dataset.id);
    n.classList.toggle("pinned", on);
    const label = n.querySelector('[data-act="pin"] span');
    if (label) label.textContent = on ? "取消置頂" : "置頂";
  });
  els.pinBar.hidden = !pins.length;
  if (pins.length) els.pinBar.innerHTML = `${svg("pushpin")}<b>置頂 ${pins.length}</b><span>${escapeHtml(plainExcerpt(pins[0].message))}</span>${svg("chev")}`;
  if (els.pins.open) renderPinList();
}

function renderPinList() {
  const pins = S.pins ?? [];
  els.pinList.innerHTML = pins.length ? "" : `<div class="small muted">目前沒有置頂訊息</div>`;
  for (const p of pins) {
    const item = document.createElement("div");
    item.className = "pin-item";
    item.innerHTML = `<div class="pin-meta">${svg("pushpin")}${escapeHtml(p.by)} 置頂・${timeText(p.ts)}</div>`;
    const node = messageNode(p.message);
    node.querySelector(".msg-actions")?.remove();
    item.append(node);
    const inChat = els.messages.querySelector(`.msg[data-id="${p.message.id}"]`);
    item.insertAdjacentHTML(
      "beforeend",
      `<div class="pin-actions"><button type="button" data-pa="copy"><span>複製</span></button>${inChat ? `<button type="button" data-pa="jump">跳到原訊息</button>` : ""}<button type="button" data-pa="unpin">取消置頂</button></div>`,
    );
    item.querySelector('[data-pa="copy"]').addEventListener("click", (e) => copyText(node.querySelector(".msg-text")?.innerText.trim() || "", e.currentTarget));
    item.querySelector('[data-pa="unpin"]').addEventListener("click", () => action({ action: "unpin", id: p.message.id }));
    item.querySelector('[data-pa="jump"]')?.addEventListener("click", () => {
      els.pins.close();
      inChat.scrollIntoView({ block: "center", behavior: "smooth" });
      inChat.classList.remove("flash");
      requestAnimationFrame(() => inChat.classList.add("flash"));
    });
    els.pinList.append(item);
  }
}

els.pinBar.addEventListener("click", () => {
  renderPinList();
  els.pins.showModal();
});
$("#pins-close").addEventListener("click", () => els.pins.close());
els.pins.addEventListener("click", (e) => e.target === els.pins && els.pins.close());

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
    node.querySelector(".msg-actions")?.remove(); // 還在打字、還沒存檔的回答不能複製或置頂
    const sep = daySeparator(Date.now());
    if (sep) els.messages.appendChild(sep);
    els.messages.appendChild(node);
    live = { node, text: "", raf: 0 };
    S.live.set(m.id, live);
    arrived(node, stick);
  }
  live.node.querySelector(".ai-time").textContent = `${m.label || "AI"} 思考中…`;
  if (m.health) {
    live.node.querySelector(".ai-card")?.classList.add("health");
    live.node.querySelector(".ai-name").textContent = "🩺 健康管家";
    live.node.querySelector(".ai-avatar").innerHTML = svg("heart");
  }
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

// ---------- 輸入 @：叫出健康管家（個人助理） ----------
const MENTIONS = () => (isPersonal() ? [{ key: "健康管家", label: "🩺 健康管家", desc: "血壓、血糖、用藥、健康問題" }] : []);
let mentionBox = null;

function mentionQuery() {
  const pos = els.input.selectionStart ?? els.input.value.length;
  return els.input.value.slice(0, pos).match(/(^|\s)@([^\s@]*)$/);
}

function hideMention() {
  if (mentionBox) mentionBox.hidden = true;
}

function updateMention() {
  const m = mentionQuery();
  const hits = m ? MENTIONS().filter((x) => x.key.startsWith(m[2]) || x.label.includes(m[2])) : [];
  if (!hits.length) return hideMention();
  if (!mentionBox) {
    mentionBox = document.createElement("div");
    mentionBox.className = "mention-box";
    els.sendForm.parentElement.append(mentionBox);
  }
  mentionBox.innerHTML = hits.map((x, i) => `<button type="button" data-mention="${i}"><b>${x.label}</b><span class="small muted">${x.desc}</span></button>`).join("");
  mentionBox.hidden = false;
  // pointerdown：在輸入框失去焦點之前選好
  mentionBox.querySelectorAll("[data-mention]").forEach((b) =>
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pickMention(hits[Number(b.dataset.mention)]);
    }),
  );
}

function pickMention(x) {
  const m = mentionQuery();
  const pos = els.input.selectionStart ?? els.input.value.length;
  const start = m ? pos - m[2].length - 1 : pos;
  const insert = `@${x.key} `;
  els.input.value = els.input.value.slice(0, start) + insert + els.input.value.slice(pos);
  const caret = start + insert.length;
  els.input.focus();
  els.input.setSelectionRange(caret, caret);
  hideMention();
  autoGrow();
}

/** 「＋」選單的「問健康管家」：在輸入框開頭放 @健康管家 */
function askHealth() {
  if (!/@健康管家/.test(els.input.value)) els.input.value = `@健康管家 ${els.input.value}`;
  els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  autoGrow();
}

els.input.addEventListener("input", updateMention);
els.input.addEventListener("blur", () => setTimeout(hideMention, 150));

els.input.addEventListener("keydown", (e) => {
  if (mentionBox && !mentionBox.hidden) {
    if (e.key === "Escape") {
      e.preventDefault();
      return hideMention();
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
      const first = MENTIONS().find((x) => x.key.startsWith(mentionQuery()?.[2] ?? ""));
      if (first) {
        e.preventDefault();
        return pickMention(first);
      }
    }
  }
  // 電腦上 Enter 送出、Shift+Enter 換行；手機用送出鍵
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    els.sendForm.requestSubmit();
  }
});

els.sendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  const { photos, location: loc } = S.pending;
  if (!text && !photos.length && !loc) return;
  els.sendBtn.disabled = true;
  try {
    const photoIds = [];
    for (const [i, ph] of photos.entries()) {
      if (photos.length > 1) els.attachImgs.dataset.status = `上傳 ${i + 1}/${photos.length}…`;
      const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": ph.blob.type }, body: ph.blob });
      if (!res.ok) throw new Error(res.status === 507 ? "這個旅程的照片空間已滿" : `照片上傳失敗（${res.status}）`);
      photoIds.push((await res.json()).id);
    }
    if (wsSend({ type: "send", text, photoId: photoIds[0] ?? null, photoIds, location: loc, replyTo: S.replyTo?.id })) {
      S.replyTo = null;
      renderReplyBar();
      els.input.value = "";
      autoGrow();
      clearAttachment();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    els.sendBtn.disabled = false;
    delete els.attachImgs.dataset.status;
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
  const chips = isPersonal() ? [
    ["sun", "今天", () => openPanel("today")],
    ["receipt", "收據記帳", receiptFlow],
    ["utensils", "附近美食", () => ask("我附近有什麼好吃的？", true)],
    ["pin", "附上位置", () => attachLocation(false)],
    null,
    ["list", "清單", () => openPanel("checklist")],
    ["bell", "提醒", () => openPanel("reminders")],
    ["calendar", "行事曆", () => openPanel("calendar")],
    ["book", "知識庫", () => openPanel("notes")],
    ["bookmark", "記憶", () => openPanel("memories")],
    ["plus", "更多", openMore],
  ] : [
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

const MORE_ASKS_PERSONAL = ["我今天有哪些待辦和提醒？", "這個月花了多少？預算還剩多少？", "你記得我哪些事？", "這個週末天氣如何？"];

function moreActions() {
  const t = S.trip || {};
  const cur = t.currency || "";
  if (isPersonal()) {
    return [
      ["heart", "問健康管家", askHealth],
      ["camera", "拍照問", () => els.photoInput.click()],
      ["file", "上傳文件", () => DOC_INPUT.click()],
      ["receipt", "收據記帳", receiptFlow],
      ["pin", "附上位置", () => attachLocation(false)],
      ["sun", "今天", () => ask("今天天氣如何？我有哪些提醒和待辦？")],
      ["utensils", "附近美食", () => ask("我附近有什麼好吃的？", true)],
    ];
  }
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
  const asks = isPersonal() ? MORE_ASKS_PERSONAL : MORE_ASKS;
  els.moreActions.innerHTML = actions.map(([icon, label], i) => `<button type="button" data-i="${i}"><span class="ag-icon">${svg(icon)}</span>${label}</button>`).join("");
  els.moreAsks.innerHTML = asks.map((q, i) => `<button type="button" data-q="${i}">${svg("msg")}${escapeHtml(q)}</button>`).join("");
  els.moreActions.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      els.more.close();
      actions[Number(b.dataset.i)][2]();
    }),
  );
  els.moreAsks.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      els.more.close();
      ask(asks[Number(b.dataset.q)]);
    }),
  );
  if (!els.more.open) els.more.showModal();
}
$("#more-close").addEventListener("click", () => els.more.close());
els.more.addEventListener("click", (e) => e.target === els.more && els.more.close());

// ---------- 照片 ----------

/** 一則訊息最多幾張照片（跟伺服器一樣）：菜單好幾頁可以一次翻譯整理 */
const MAX_PHOTOS = 6;

els.photoInput.addEventListener("change", async () => {
  const files = [...(els.photoInput.files || [])];
  els.photoInput.value = "";
  if (!files.length) return;
  const room = MAX_PHOTOS - S.pending.photos.length;
  if (files.length > room) alert(`一則訊息最多 ${MAX_PHOTOS} 張照片，${room > 0 ? `這次只加入前 ${room} 張` : "已經滿了"}；其他的請下一則再傳。`);
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      // 菜單、文件的小字要看得清楚：長邊 1600
      const blob = await resizeImage(file, 1600, 0.82);
      S.pending.photos.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      alert("有一張照片無法讀取");
    }
  }
  renderAttach();
  els.input.focus();
});

/** 附件列：照片縮圖（可以一張一張拿掉）＋再加一張 */
function renderAttach() {
  const list = S.pending.photos;
  delete els.attachImgs.dataset.status;
  els.attachImgs.innerHTML =
    list.map((p, i) => `<span class="attach-thumb"><img src="${p.url}" alt="照片 ${i + 1}" /><button type="button" data-rm="${i}" aria-label="拿掉第 ${i + 1} 張">✕</button></span>`).join("") +
    (list.length && list.length < MAX_PHOTOS ? `<button type="button" class="attach-add" aria-label="再加一張照片">＋</button>` : "");
  els.attachImgs.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      const [p] = S.pending.photos.splice(Number(b.dataset.rm), 1);
      URL.revokeObjectURL(p.url);
      renderAttach();
    }),
  );
  els.attachImgs.querySelector(".attach-add")?.addEventListener("click", () => els.photoInput.click());
  els.attach.hidden = !list.length && !S.pending.location && !els.attachLoc.textContent;
  els.input.placeholder = list.length > 1 ? "例如：翻譯整理這幾張菜單" : list.length ? "要問什麼？例如：這是什麼、幫我翻譯、比價" : (isPersonal() ? "跟你的助理說…" : "問旅伴 AI 任何事…");
}

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
    if (!S.pending.photos.length) els.attach.hidden = true;
    alert(err.message);
    if (thenSend && els.input.value) els.sendForm.requestSubmit();
  }
}

function clearLocation() {
  S.pending.location = null;
  els.attachLoc.textContent = "";
  if (!S.pending.photos.length) els.attach.hidden = true;
}

function clearAttachment() {
  for (const p of S.pending.photos) URL.revokeObjectURL(p.url);
  S.pending.photos = [];
  els.attachImgs.innerHTML = "";
  delete els.attachImgs.dataset.status;
  els.input.placeholder = isPersonal() ? "跟你的助理說…" : "問旅伴 AI 任何事…";
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
  renderPins(state.pins);
  applyTrip(state.trip);
  // 票券、常用句、旅程資料存一份在手機，沒網路也能打開
  store(`ta-trip-${ROOM}`, state.trip);
  if (state.documents) store(`ta-docs-${ROOM}`, state.documents);
  if (state.docFolders) store(`ta-docfolders-${ROOM}`, state.docFolders);
  if (state.phrases) {
    store(`ta-phrases-${ROOM}`, state.phrases);
    if (els.translator.open && TR.tab === "phrases") renderPhraseList();
  }
  const t = state.trip;
  const now = todayLocal();
  const day = Math.floor((Date.parse(now + "T00:00:00Z") - Date.parse(t.startDate + "T00:00:00Z")) / 86400e3) + 1;
  els.todayTitle.textContent = t.title;
  if (t.kind === "personal") {
    els.dayBadge.textContent = dateLabel(now);
    els.nextCard.hidden = els.ncToggle.hidden = true;
    for (const tab of ["translator", "itinerary"]) els.tabbar.querySelector(`[data-tab="${tab}"]`).hidden = true;
    for (const tab of ["today", "expenses"]) els.tabbar.querySelector(`[data-tab="${tab}"]`).hidden = false;
    if (!S.pending.photos.length) els.input.placeholder = "跟你的助理說…";
    const typing = document.activeElement && els.panel.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (S.panel && !typing && !["settings", "tripedit", "keys", "diary-edit"].includes(S.panel)) renderPanel();
    return;
  }
  els.dayBadge.textContent = day < 1 ? `倒數 ${1 - day} 天` : now <= t.endDate ? `Day ${day}` : "旅程結束";
  renderNextCard(state, now);
  els.tabbar.querySelector('[data-tab="translator"]').hidden = !hasTranslator();
  els.tabbar.querySelector('[data-tab="itinerary"]').hidden = hasTranslator();
  // 正在編輯日記時不重畫，免得打到一半的字被別人的動作洗掉
  if (S.panel && !["settings", "tripedit", "keys", "diary-edit"].includes(S.panel)) renderPanel();
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

const TAB_OF = { today: "today", itinerary: "itinerary", expenses: "expenses", settings: "settings", tripedit: "settings", keys: "settings" };

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
      if (els.translator.open) closeTranslator();
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
  // close 事件是非同步的：從面板直接切到翻譯時，別把分頁列標回聊天
  setTab(els.translator.open ? "translator" : "chat");
});

function openPanel(name) {
  if (els.translator.open) closeTranslator();
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
  if (isPersonal()) {
    if (S.panel === "today") return renderTodayPanel(st, b);
    if (S.panel === "expenses") return renderLedgerPanel(st, b);
    if (S.panel === "memories") return renderPersonalMemories(st, b);
    if (S.panel === "notes") return renderNotesPanel(st, b);
    if (S.panel === "calendar") return renderCalendarPanel(st, b);
    if (S.panel === "memo") return renderMemoPanel(st, b);
    if (S.panel === "health") return renderHealthPanel(st, b);
    if (S.panel === "iddocs") return renderIdDocsPanel(st, b);
  }
  if (["hub", "guide", "travel", "map", "checklist", "tickets", "reminders", "diary", "diary-edit"].includes(S.panel)) return renderToolPanel(st, b);
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
          ${isPersonal() ? `<ol class="steps">
            <li>你自己的 Gemini 金鑰：${s.gemini ? `✅ ${escapeHtml(s.gemini)}` : "❌ 未設定"}</li>
            <li>備援：網站提供的 Workers AI 免費額度（每天台灣時間早上 8 點重置）</li>
          </ol>` : `<ol class="steps">
            ${s.ownerGemini ? "<li>網站提供的 Gemini 免費額度</li>" : ""}
            <li>網站提供的 Workers AI 免費額度（每天台灣時間早上 8 點重置）</li>
            <li>這個旅程自己的 Gemini 金鑰：${s.gemini ? `✅ ${escapeHtml(s.gemini)}` : "❌ 未設定"}</li>
          </ol>`}
          ${s.gemini ? `<div class="muted">自己的 Gemini 用量：<span id="gemini-usage">${escapeHtml(geminiUsageText(S.state?.gemini))}</span></div>` : ""}
        </div>
        <div class="card"><h3>🔍 Tavily 搜尋金鑰</h3>
          <div class="small muted">目前：${escapeHtml(s.tavily || "未設定")}。額度用完時到 <a href="https://app.tavily.com" target="_blank" rel="noopener">app.tavily.com</a> 換一組。</div>
          <form class="row" id="k-tavily"><input name="k" placeholder="新的 tvly-…" autocomplete="off" style="flex:1" /><button class="btn primary-sm">更新</button></form>
        </div>
        <div class="card"><h3>🤖 Gemini 金鑰${isPersonal() ? "" : "（選填）"}</h3>
          <div class="small muted">到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> 免費申請。${isPersonal() ? "AI 會先用這把金鑰，額度用完才改用 Workers AI；沒有金鑰就只能用 Workers AI。" : "網站提供的免費額度用完時才會用它。"}</div>
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

// ================= 個人助理：今天、記帳、記憶、手機通知 =================

const nt = (n) => `NT$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "夜深了" : h < 11 ? "早安" : h < 17 ? "午安" : "晚安";
}

/** 長條：預算用（到八成變橘、超過變紅）；plain＝分類佔比，不用警示色 */
function meter(value, total, plain = false) {
  const pct = total ? Math.min(100, Math.round((value / total) * 100)) : 0;
  const cls = plain ? "" : pct >= 100 ? "over" : pct >= 80 ? "warn" : "";
  return `<div class="meter"><span class="${cls}" style="width:${pct}%"></span></div>`;
}

/** 今天頁：早報、提醒、待辦、本月花費，一頁看完 */
function renderTodayPanel(st, b) {
  els.panelTitle.textContent = "☀️ 今天";
  const s = S.settings || {};
  const now = todayLocal();
  const rem = (st.reminders || []).slice(0, 5);
  const todos = (st.checklist || []).filter((c) => c.list === "待辦" && !c.done);
  const shop = (st.checklist || []).filter((c) => c.list === "購物" && !c.done);
  const l = st.ledger || { total: 0, budget: 0, month: "" };
  const brief = st.brief;
  b.innerHTML = `
    <div class="today-head"><div class="today-date">${dateLabel(now)}</div><div class="muted">${greeting()}，${escapeHtml(S.me.name)}</div></div>
    ${dreamCardsHtml(st.cards)}
    <div class="card today-card">
      <div class="row between"><h3>📅 行程</h3><button class="btn small" data-go="calendar">行事曆</button></div>
      ${(() => {
        const soon = (st.events || []).filter((e) => e.date >= now).slice(0, 5);
        return soon.length
          ? `<div class="list">${soon.map((e) => `<div class="item small"><span><b>${e.date === now ? "今天" : escapeHtml(dateLabel(e.date))}</b> ${escapeHtml(e.start || "整天")}　${escapeHtml(e.title)}${e.location ? `<span class="muted">・${escapeHtml(e.location)}</span>` : ""}</span></div>`).join("")}</div>`
          : `<div class="small muted">接下來沒有行程。在聊天說「下週三下午 3 點看牙醫」就會加進來。</div>`;
      })()}
    </div>
    ${(() => {
      const h = st.health;
      if (!h) return "";
      const rows = [
        ...(h.alerts || []).filter((a) => a.level === "red").map((a) => `🚨 ${escapeHtml(a.text.replace(/\*\*/g, "").slice(0, 40))}…`),
        ...(h.task ? [`🩺 722 量血壓第 ${Math.min(h.task.day, 7)} 天`] : []),
        ...(h.meds || []).filter((m) => m.refill_in != null && m.refill_in >= 0 && m.refill_in <= 3).map((m) => `💊 ${escapeHtml(m.name)}：${m.refill_in === 0 ? "今天" : `${m.refill_in} 天後`}可以領藥`),
      ];
      return rows.length ? `<div class="card today-card">${rows.map((r) => `<button type="button" class="item small link-row" data-go="health">${r}</button>`).join("")}</div>` : "";
    })()}
    ${(() => {
      const ids = (st.idDocs || []).filter((d) => d.days <= 60);
      const busy = (st.memos || []).filter((x) => x.status === "recording" || x.status === "processing");
      if (!ids.length && !busy.length) return "";
      return `<div class="card today-card">
        ${ids.map((d) => `<button type="button" class="item small link-row" data-go="iddocs">🪪 ${escapeHtml(d.holder)}的${escapeHtml(d.kind)}${d.days < 0 ? `<b class="bad-text">已過期</b>` : `<b>${d.days} 天後到期</b>`}</button>`).join("")}
        ${busy.map((x) => `<button type="button" class="item small link-row" data-go="memo">🎙️ ${escapeHtml(memoStatus(x))}</button>`).join("")}
      </div>`;
    })()}
    <div class="card today-card">
      <div class="row between"><h3>☀️ 早報</h3>${brief ? "" : `<button class="btn small" id="td-brief">現在產生</button>`}</div>
      ${brief
        ? `<div class="small msg-text">${md(String(brief.text).replace(/^☀️[^\n]*\n+/, ""))}</div>`
        : `<div class="small muted">${s.autoBrief === false ? "每日早報目前關閉（可在 設定 開啟）。" : `每天 ${s.briefHour ?? 7}:00 左右會自動發早報。`}</div>`}
    </div>
    <div class="card today-card">
      <div class="row between"><h3>⏰ 提醒</h3><button class="btn small" data-go="reminders">全部</button></div>
      ${rem.length
        ? `<div class="list">${rem.map((r) => `<div class="item small"><span><b>${escapeHtml(String(r.time).slice(5, 16))}</b>　${escapeHtml(r.message)}</span></div>`).join("")}</div>`
        : `<div class="small muted">沒有提醒。在聊天說「明天 8 點提醒我繳費」就會設好。</div>`}
    </div>
    <div class="card today-card">
      <div class="row between"><h3>✅ 待辦</h3><button class="btn small" data-go="checklist">清單</button></div>
      <form class="row inline-form" id="td-add" style="gap:6px;margin:6px 0"><input name="item" placeholder="新增待辦…" style="flex:1" autocomplete="off" /><button class="btn primary-sm">加入</button></form>
      <div class="list">${todos.slice(0, 8).map((c) => `<label class="item check-item small"><span><input type="checkbox" data-done="${c.id}" /> ${escapeHtml(c.item)}</span></label>`).join("") || `<div class="small muted">待辦都完成了 🎉</div>`}</div>
      ${todos.length > 8 ? `<div class="small muted">還有 ${todos.length - 8} 項</div>` : ""}
      ${shop.length ? `<div class="small muted" style="margin-top:6px">🛒 購物清單還有 ${shop.length} 項</div>` : ""}
    </div>
    <button type="button" class="card today-card today-money-card" data-go="expenses">
      <div class="row between"><h3>💰 本月花費</h3><span class="small muted">${escapeHtml(l.month || "")}</span></div>
      <div class="today-money">${nt(l.total)}${l.budget ? `<span class="small muted">／預算 ${nt(l.budget)}</span>` : ""}</div>
      ${l.budget ? meter(l.total, l.budget) : `<div class="small muted">還沒設定月預算，點這裡設定</div>`}
    </button>`;
  b.querySelectorAll("[data-go]").forEach((x) => x.addEventListener("click", () => openPanel(x.dataset.go)));
  $("#td-brief", b)?.addEventListener("click", (e) => {
    e.target.disabled = true;
    e.target.textContent = "產生中…";
    action({ action: "brief_now" });
  });
  $("#td-add", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const item = e.target.item.value.trim();
    if (!item) return;
    action({ action: "checklist_add", list: "待辦", item });
    e.target.reset();
  });
  b.querySelectorAll("[data-done]").forEach((x) => x.addEventListener("change", () => action({ action: "checklist_toggle", id: Number(x.dataset.done), done: x.checked })));
  bindDreamCards(b, st.cards || []);
}

/** 個人帳本：本月總額、預算、分類、明細 */
function renderLedgerPanel(st, b) {
  els.panelTitle.textContent = "💰 記帳";
  const l = st.ledger || { items: [], by_category: {}, months: [], total: 0, budget: 0, count: 0, month: "" };
  const cats = Object.entries(l.by_category || {}).sort((x, y) => y[1] - x[1]);
  const left = l.budget ? l.budget - l.total : 0;
  b.innerHTML = `
    <div class="card">
      <div class="row between"><h3>${escapeHtml(l.month)} 花費</h3><span class="small muted">${l.count} 筆</span></div>
      <div class="today-money">${nt(l.total)}</div>
      ${l.budget ? `${meter(l.total, l.budget)}<div class="small ${left < 0 ? "error" : "muted"}">${left >= 0 ? `預算 ${nt(l.budget)}，還剩 ${nt(left)}` : `已超出預算 ${nt(-left)}`}</div>` : ""}
      <form class="row inline-form" id="lg-budget" style="gap:6px;margin-top:10px"><input name="amount" type="number" inputmode="numeric" min="0" step="100" placeholder="每月預算（NT$）" value="${l.budget || ""}" style="flex:1" /><button class="btn small">${l.budget ? "修改預算" : "設定預算"}</button></form>
      <div class="small muted">花到八成、超過預算時，會在聊天和手機通知你。</div>
    </div>
    ${cats.length ? `<div class="card"><h3>分類</h3>${cats.map(([c, v]) => `<div class="cat-row"><span>${escapeHtml(c)}</span>${meter(v, l.total, true)}<b>${nt(v)}</b></div>`).join("")}</div>` : ""}
    <div class="card"><h3>明細</h3>
      <p class="small muted">在聊天說「午餐 120」或拍收據，AI 會產生記帳卡片，按確認才會記進來。</p>
      <div class="list">${(l.items || []).map((x) => `<div class="item small"><div><b>${escapeHtml(x.description)}</b><div class="muted">${escapeHtml(String(x.date).slice(5))}・${escapeHtml(x.category)}${x.currency !== "TWD" ? `・${escapeHtml(x.currency)} ${escapeHtml(x.amount)}` : ""}</div></div>
        <div class="row" style="gap:6px"><b>${nt(x.twd)}</b><button class="btn danger small" data-del-exp="${x.id}" aria-label="刪除">✕</button></div></div>`).join("") || `<div class="small muted">這個月還沒有記帳</div>`}</div>
    </div>
    ${(l.months || []).length > 1 ? `<div class="card"><h3>最近幾個月</h3><div class="list">${l.months.map((m) => `<div class="item small"><span>${escapeHtml(m.month)}（${m.count} 筆）</span><b>${nt(m.total)}</b></div>`).join("")}</div></div>` : ""}`;
  $("#lg-budget", b).addEventListener("submit", (e) => {
    e.preventDefault();
    action({ action: "budget_set", amount: Number(e.target.amount.value) || 0 });
  });
  b.querySelectorAll("[data-del-exp]").forEach((x) => x.addEventListener("click", () => confirm("確定刪除這筆？") && action({ action: "delete_expense", id: Number(x.dataset.delExp) })));
}

/** 記憶頁：關於我、各類記憶（可改可刪）、已取代或過期的（可恢復）、暫停記憶、匯出 */
function renderPersonalMemories(st, b) {
  els.panelTitle.textContent = "🧠 記憶";
  const s = S.settings || {};
  const mems = st.memories || [];
  const arch = st.memoryArchive || [];
  const groups = ["偏好", "決定", "預訂", "資訊", "待辦"];
  const auto = (m) => (m.source ? m.source === "auto" : m.author === "AI 自動整理");
  const item = (m) => `<div class="item small"><div>${escapeHtml(m.content)}
      <div class="muted"><span class="tag ${auto(m) ? "" : "tag-you"}">${auto(m) ? "AI 整理" : "你說的"}</span> ${dayText(m.ts)}${m.expires ? `・到 ${escapeHtml(String(m.expires).slice(5))}` : ""}</div></div>
      <div class="row" style="gap:6px"><button class="btn small" data-edit-mem="${m.id}">改</button><button class="btn danger small" data-del-mem="${m.id}">刪</button></div></div>`;
  const sections = groups
    .map((g) => {
      const list = mems.filter((m) => m.category === g);
      return list.length ? `<div class="card"><h3>${g}（${list.length}）</h3><div class="list">${list.slice().reverse().map(item).join("")}</div></div>` : "";
    })
    .join("");
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">AI 聊天時會記下你的偏好、決定和重要的事，每次回答前都會先看這裡。說錯的可以改、可以刪；過期或被新資訊取代的會收到最下面，不會直接消失。</p>
    <div class="card"><label class="row between"><span><b>暫停記憶</b><br><span class="small muted">暫停期間的對話不會被記下來</span></span><input type="checkbox" id="mem-pause" ${s.memoryPaused ? "checked" : ""} /></label></div>
    <div class="card"><h3>🙋 關於我</h3><div class="small muted">AI 每次都會看這段。AI 會自動補充，你也可以自己改。</div>
      <form class="form" id="core-form"><textarea name="text" rows="5" maxlength="800" placeholder="例如：住台北中山區，有兩個小孩；不吃香菜；週末常去爬山">${escapeHtml(st.core || "")}</textarea><button class="btn primary-sm">儲存</button></form></div>
    <div class="card"><form class="form" id="mem-form">
      <textarea name="content" rows="2" placeholder="手動新增，例如：媽媽對花生過敏" required></textarea>
      <div class="row" style="gap:6px"><select name="category" style="flex:1">${groups.map((c) => `<option>${c}</option>`).join("")}</select><button class="btn primary-sm" style="white-space:nowrap">新增記憶</button></div>
    </form></div>
    ${sections || `<div class="card small muted">還沒有記憶。在聊天說「記住…」，或聊幾句之後 AI 會自動整理。</div>`}
    <div class="card"><h3>🌙 夜間整理</h3>
      <div class="small muted">每天凌晨會整理一次：寫當天回顧、合併重複的記憶、找出矛盾和習慣，早上在「今天」頁問你對不對。自動改的都可以復原。</div>
      <div class="small" style="margin-top:6px">${s.lastDream ? `上次：${escapeHtml(dateLabel(s.lastDream.date))}${s.lastDream.skipped ? `（${escapeHtml(s.lastDream.skipped)}）` : s.lastDream.error ? `（${escapeHtml(s.lastDream.error)}）` : `，合併 ${s.lastDream.merged ?? 0} 條、要你確認 ${s.lastDream.cards ?? 0} 件`}` : "還沒整理過"}</div>
      <button type="button" class="btn small" id="dream-now" style="margin-top:6px">現在整理一次</button>
      ${(st.dreamOps || []).length ? `<details style="margin-top:8px"><summary class="small">整理紀錄（${st.dreamOps.length}）</summary><div class="list">${st.dreamOps.map((o) => `<div class="item small"><div>${escapeHtml(o.reason)}<div class="muted">${dayText(o.ts)}${o.undone ? "・已復原" : ""}</div></div>${o.undone ? "" : `<button type="button" class="btn small" data-undo="${o.id}">復原</button>`}</div>`).join("")}</div></details>` : ""}
    </div>
    ${(st.episodes || []).length ? `<details class="card"><summary>📔 每天的回顧（${st.episodes.length}）</summary><div class="list">${st.episodes.map((e) => `<div class="item small"><div><b>${e.weekly ? "🗓 週回顧" : escapeHtml(dateLabel(String(e.date).slice(0, 10)))}</b><div style="white-space:pre-wrap">${escapeHtml(e.summary)}</div></div></div>`).join("")}</div></details>` : ""}
    ${arch.length ? `<details class="card"><summary>已取代、過期的記憶（${arch.length}）</summary><div class="list">${arch.map((m) => `<div class="item small"><div><span class="muted">${escapeHtml(m.content)}</span>
        <div class="muted">${m.status === "expired" ? "已過期" : "已被新資訊取代"}・${dayText(m.updated || m.ts)}</div></div>
        <div class="row" style="gap:6px"><button class="btn small" data-restore="${m.id}">恢復</button><button class="btn danger small" data-del-mem="${m.id}">刪</button></div></div>`).join("")}</div></details>` : ""}
    <div class="card"><a class="btn" href="/api/export?room=${ROOM}" download>⬇️ 匯出我的資料（JSON）</a><div class="small muted" style="margin-top:6px">聊天文字、記憶、清單、提醒、帳本、保管箱清單（不含照片）。</div></div>`;
  bindBack(b);
  $("#mem-pause", b).addEventListener("change", (e) => action({ action: "settings", memoryPaused: e.target.checked }));
  $("#core-form", b).addEventListener("submit", (e) => {
    e.preventDefault();
    action({ action: "core_save", text: e.target.text.value });
    e.target.querySelector("button").textContent = "已儲存";
  });
  $("#mem-form", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    action({ action: "add_memory", content: f.get("content"), category: f.get("category") });
  });
  b.querySelectorAll("[data-edit-mem]").forEach((x) =>
    x.addEventListener("click", () => {
      const m = mems.find((y) => y.id === Number(x.dataset.editMem));
      const content = prompt("修改這條記憶：", m.content);
      if (content && content.trim() && content.trim() !== m.content) action({ action: "edit_memory", id: m.id, content: content.trim(), expires: m.expires || "" });
    }),
  );
  b.querySelectorAll("[data-del-mem]").forEach((x) => x.addEventListener("click", () => confirm("確定刪除這條記憶？") && action({ action: "delete_memory", id: Number(x.dataset.delMem) })));
  b.querySelectorAll("[data-restore]").forEach((x) => x.addEventListener("click", () => action({ action: "restore_memory", id: Number(x.dataset.restore) })));
  $("#dream-now", b).addEventListener("click", (e) => {
    e.target.disabled = true;
    e.target.textContent = "整理中，約需 20 秒…";
    action({ action: "dream_now" });
  });
  b.querySelectorAll("[data-undo]").forEach((x) => x.addEventListener("click", () => confirm("復原這筆整理？") && action({ action: "dream_undo", id: Number(x.dataset.undo) })));
}

// ---------- 手機通知（Web Push） ----------

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

function b64ToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function pushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** 這支手機的通知狀態（設定頁顯示） */
async function pushStatusText() {
  if (isIOS() && !isStandalone()) return "iPhone 要先把這個網頁「加入主畫面」，再從主畫面的圖示打開，才能開啟通知（Safari 分享按鈕 → 加入主畫面）。";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "這個瀏覽器不支援通知。";
  if (Notification.permission === "denied") return "通知被封鎖了：請到手機設定 → 通知，找到這個 App 打開。";
  const sub = await pushSubscription().catch(() => null);
  const n = S.settings?.pushDevices ?? 0;
  return sub && Notification.permission === "granted" ? `✅ 這支手機已開啟通知（這個空間共 ${n} 台裝置）` : `還沒開啟${n ? `（其他 ${n} 台裝置已開啟）` : ""}`;
}

async function enablePush() {
  if (isIOS() && !isStandalone()) return alert("iPhone 要先「加入主畫面」，再從主畫面的圖示打開，才能開啟通知。");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return alert("這個瀏覽器不支援通知");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return alert("沒有允許通知。要開啟的話請到手機設定 → 通知，找到這個 App 打開。");
  try {
    const reg = await navigator.serviceWorker.ready;
    const k = await api("/api/push/key");
    if (!k.ok) throw new Error(k.error || "拿不到通知金鑰");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
    const r = await api("/api/push/subscribe", { subscription: sub.toJSON() });
    if (!r.ok) throw new Error(r.error || "開啟失敗");
  } catch (e) {
    alert(`開啟通知失敗：${e.message || e}`);
  }
}

async function disablePush() {
  const sub = await pushSubscription().catch(() => null);
  // 瀏覽器的訂閱可能還有其他空間在用，只把這個空間的拿掉
  if (sub) await api("/api/push/unsubscribe", { endpoint: sub.endpoint });
}

// ---------- 行事曆 ----------

const REMIND_OPTS = [["", "不提醒"], ["0", "準時"], ["10", "10 分鐘前"], ["30", "30 分鐘前"], ["60", "1 小時前"], ["120", "2 小時前"], ["1440", "前一天"]];
const remindLabel = (m) => (m == null ? "" : (REMIND_OPTS.find(([v]) => v === String(m)) || [null, `前 ${m} 分鐘`])[1]);

function eventLine(e, del = true) {
  const time = e.start ? `${e.start}${e.end ? `–${e.end}` : ""}` : "整天";
  return `<div class="item small ev"><div><b class="ev-time">${escapeHtml(time)}</b> ${escapeHtml(e.title)}
      ${e.location ? `<div class="muted">📍 ${escapeHtml(e.location)}</div>` : ""}${e.remindMin != null ? `<div class="muted">🔔 ${escapeHtml(remindLabel(e.remindMin))}</div>` : ""}</div>
      ${del ? `<button type="button" class="btn danger small" data-del-ev="${e.id}" aria-label="刪除">✕</button>` : ""}</div>`;
}

function groupByDate(list) {
  const out = new Map();
  for (const e of list) (out.get(e.date) || out.set(e.date, []).get(e.date)).push(e);
  return out;
}

/** 行事曆：新增、近期行程、訂閱到手機日曆 */
function renderCalendarPanel(st, b) {
  els.panelTitle.textContent = "📅 行事曆";
  const s = S.settings || {};
  const today = todayLocal();
  const events = st.events || [];
  const upcoming = groupByDate(events.filter((e) => e.date >= today));
  const past = events.filter((e) => e.date < today);
  const icsUrl = s.ics ? `${location.origin}${s.ics}` : "";
  b.innerHTML = `
    ${backToHub()}
    <details class="card" ${S.calAddOpen ? "open" : ""} id="cal-add-box"><summary><b>＋ 新增行程</b></summary>
      <form class="form" id="cal-add" style="margin-top:8px">
        <input name="title" placeholder="例如：看牙醫、小美家長會" required />
        <div class="row" style="gap:6px"><input name="date" type="date" value="${today}" required style="flex:1" /><select name="remind" style="flex:1">${REMIND_OPTS.map(([v, l]) => `<option value="${v}">🔔 ${l}</option>`).join("")}</select></div>
        <div class="row" style="gap:6px"><input name="start" type="time" style="flex:1" aria-label="開始時間" /><span class="muted">到</span><input name="end" type="time" style="flex:1" aria-label="結束時間" /></div>
        <input name="location" placeholder="地點（可留空）" />
        <div class="small muted">沒填時間＝整天。也可以直接在聊天說「下週三下午 3 點看牙醫，前一天提醒我」。</div>
        <button class="btn primary-sm">加到行事曆</button>
      </form>
    </details>
    ${upcoming.size
      ? [...upcoming].map(([d, list]) => `<div class="card cal-day${d === today ? " is-today" : ""}"><h3>${dateLabel(d)}${d === today ? " ・今天" : ""}</h3><div class="list">${list.map((e) => eventLine(e)).join("")}</div></div>`).join("")
      : `<div class="card small muted">接下來沒有行程。</div>`}
    ${past.length ? `<details class="card"><summary>過去 7 天（${past.length}）</summary><div class="list">${past.slice().reverse().map((e) => `<div class="muted small">${dateLabel(e.date)}</div>${eventLine(e)}`).join("")}</div></details>` : ""}
    <div class="card"><h3>📲 訂閱到手機日曆</h3>
      ${icsUrl
        ? `<div class="small muted">把這個連結加到 iPhone 行事曆或 Google 日曆，這裡的行程就會出現在手機日曆（每幾小時更新一次）。連結等於密碼，不要給別人。</div>
           <div class="share-link">${escapeHtml(icsUrl)}</div>
           <div class="row" style="gap:6px;flex-wrap:wrap"><a class="btn" href="${escapeHtml(icsUrl.replace(/^https?:/, "webcal:"))}">加到 iPhone 行事曆</a><button type="button" class="btn" id="ics-copy">複製連結</button></div>
           <div class="small muted" style="margin-top:6px">Google 日曆：電腦版 → 左邊「其他日曆」旁的＋ → 「透過網址新增」→ 貼上連結。</div>
           <div class="row" style="gap:6px;margin-top:8px"><button type="button" class="btn small" id="ics-reset">換一個新連結</button><button type="button" class="btn small danger" id="ics-off">關閉訂閱</button></div>`
        : `<div class="small muted">產生一個訂閱連結，手機內建的行事曆或 Google 日曆就看得到這裡的行程。</div><button type="button" class="btn" id="ics-on" style="margin-top:6px">產生訂閱連結</button>`}
    </div>`;
  bindBack(b);
  $("#cal-add-box", b).addEventListener("toggle", (e) => (S.calAddOpen = e.target.open));
  $("#cal-add", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    action({ action: "event_add", title: f.get("title"), date: f.get("date"), start: f.get("start"), end: f.get("end"), location: f.get("location"), remind: f.get("remind") });
    e.target.reset();
    e.target.date.value = today;
  });
  b.querySelectorAll("[data-del-ev]").forEach((x) => x.addEventListener("click", () => confirm("刪除這個行程？") && action({ action: "event_delete", id: Number(x.dataset.delEv) })));
  $("#ics-on", b)?.addEventListener("click", () => action({ action: "ics_on" }));
  $("#ics-reset", b)?.addEventListener("click", () => confirm("換新連結後，舊的訂閱會失效，要在手機日曆重新訂閱一次。確定？") && action({ action: "ics_reset" }));
  $("#ics-off", b)?.addEventListener("click", () => confirm("關閉後手機日曆就拿不到新的行程。確定？") && action({ action: "ics_off" }));
  $("#ics-copy", b)?.addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(icsUrl);
      e.target.textContent = "✅ 已複製";
    } catch {
      prompt("複製這個連結", icsUrl);
    }
  });
}

// ---------- 做夢：早上的確認卡 ----------

const CARD_BUTTONS = {
  insight: [["yes", "✅ 對"], ["edit", "✏️ 改"], ["no", "❌ 不對"]],
  conflict: [["yes", "還是對的"], ["no", "已經不對了"]],
  merge: [["yes", "✅ 合併"], ["no", "不要"]],
  followup: [["done", "做好了"], ["later", "還沒，加到待辦"], ["dismiss", "不用了"]],
  weekly: [["dismiss", "看完了"]],
};

function dreamCardsHtml(cards) {
  if (!cards?.length) return "";
  return `<div class="card today-card dream-cards"><h3>🌙 昨晚我整理了這些，對嗎？</h3>
    ${cards.map((c) => `<div class="dream-card" data-card="${c.id}">
      <b>${escapeHtml(c.title)}</b>${c.body ? `<div class="small muted" style="white-space:pre-wrap">${escapeHtml(c.body)}</div>` : ""}
      <div class="row" style="gap:6px;flex-wrap:wrap">${(CARD_BUTTONS[c.kind] || [["dismiss", "知道了"]]).map(([a, l]) => `<button type="button" class="btn small" data-ans="${a}">${l}</button>`).join("")}</div>
    </div>`).join("")}</div>`;
}

function bindDreamCards(b, cards) {
  b.querySelectorAll("[data-card] [data-ans]").forEach((x) =>
    x.addEventListener("click", () => {
      const id = Number(x.closest("[data-card]").dataset.card);
      const c = cards.find((y) => y.id === id);
      let text = "";
      if (x.dataset.ans === "edit") {
        text = prompt("改成：", String(c.body || "").split("\n")[0]) || "";
        if (!text.trim()) return;
      }
      if (c.kind === "conflict" && x.dataset.ans === "no") text = prompt("現在正確的是？（可留空）", "") || "";
      x.closest("[data-card]").querySelectorAll("button").forEach((y) => (y.disabled = true));
      action({ action: "card_answer", id, answer: x.dataset.ans, text });
    }),
  );
}

/** 知識庫：貼連結讓 AI 整理存進來；可以搜尋、看重點、開原始連結、刪除 */
function renderNotesPanel(st, b) {
  els.panelTitle.textContent = "📚 知識庫";
  const notes = st.notes || [];
  const q = (S.noteQuery || "").trim().toLowerCase();
  const tagsOf = (n) => { try { return JSON.parse(n.tags || "[]"); } catch { return []; } };
  const list = q ? notes.filter((n) => `${n.title} ${n.summary} ${n.tags}`.toLowerCase().includes(q)) : notes;
  const inbox = notes.filter((n) => n.inbox);
  const noteCard = (n) => S.noteEdit === n.id
    ? `<form class="card form note" data-note-form="${n.id}" id="note-${n.id}">
        <input name="title" value="${escapeHtml(n.title)}" required />
        <input name="tags" value="${escapeHtml(tagsOf(n).join("、"))}" placeholder="標籤，用頓號隔開" />
        <textarea name="summary" rows="6" required>${escapeHtml(n.summary || "")}</textarea>
        <div class="row" style="gap:6px"><button class="btn primary-sm">儲存</button><button type="button" class="btn" data-edit-cancel>取消</button></div>
      </form>`
    : `<div class="card note${S.noteFocus === n.id ? " flash" : ""}" id="note-${n.id}">
        <div class="row between" style="align-items:flex-start"><b class="note-title">${escapeHtml(n.title)}</b><span class="small muted" style="white-space:nowrap">${dayText(n.ts)}</span></div>
        ${tagsOf(n).length ? `<div class="note-tags">${tagsOf(n).map((t) => `<button type="button" class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join("")}</div>` : ""}
        <div class="small msg-text note-body">${md(n.summary || "")}</div>
        ${S.noteText[n.id] != null ? `<div class="note-full small msg-text">${md(S.noteText[n.id])}</div>` : ""}
        <div class="row" style="gap:6px;flex-wrap:wrap">${n.inbox ? `<button type="button" class="btn small primary-sm" data-file="${n.id}">✅ 收好</button>` : ""}${n.clen > 300 ? `<button type="button" class="btn small" data-full="${n.id}">${S.noteText[n.id] != null ? "收起全文" : "看全文"}</button>` : ""}${n.file_id ? `<a class="btn small" href="/api/file/${n.file_id}?room=${ROOM}" target="_blank" rel="noopener">原檔</a>` : ""}${n.url ? `<a class="btn small" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">開原始連結</a>` : ""}<button type="button" class="btn small" data-edit-note="${n.id}">改</button><button type="button" class="btn small" data-ask="${n.id}">問 AI</button><button type="button" class="btn danger small" data-del-note="${n.id}">刪除</button></div>
      </div>`;
  b.innerHTML = `
    ${backToHub()}
    <div class="seg-tabs"><button type="button" class="on">📚 筆記與連結</button><button type="button" data-go-docs>🗂 照片文件</button></div>
    <p class="small muted">在聊天貼 Facebook／Instagram Reels 或網頁連結，AI 會看完幫你整理重點存進來（影片也看得到）。也可以上傳文件，之後在聊天問「之前存的那個…」「合約裡怎麼寫…」都找得到，回答會附上來源。</p>
    <div class="card file-up">
      <button type="button" class="btn big-btn" id="doc-up">${svg("file")}上傳文件</button>
      <div class="small muted">PDF、Word、PPT、Excel、CSV、MD、TXT，單檔 20MB 內。AI 讀完會整理重點，全文也存著。</div>
      ${(st.files || []).map((f) => `<div class="file-row small"><span>📄 ${escapeHtml(f.name)}</span><span class="${f.status === "error" ? "bad-text" : "muted"}">${f.status === "uploading" ? "上傳中…" : f.status === "processing" ? "AI 讀取整理中…" : `⚠️ ${escapeHtml(f.error || "失敗")}`}</span>
        ${f.status === "error" ? `<span class="row" style="gap:6px"><button type="button" class="btn small" data-file-retry="${f.id}">重試</button><button type="button" class="btn small danger" data-file-del="${f.id}">刪除</button></span>` : ""}</div>`).join("")}
    </div>
    <details class="card" id="note-add-box" ${S.noteAddOpen ? "open" : ""}><summary><b>＋ 新增筆記</b></summary>
      <form class="form" id="note-add" style="margin-top:8px">
        <input name="title" placeholder="標題" required />
        <textarea name="content" rows="4" placeholder="內容" required></textarea>
        <input name="tags" placeholder="標籤，用頓號隔開（可留空）" />
        <button class="btn primary-sm">存進知識庫</button>
      </form>
    </details>
    ${inbox.length && !q ? `<div class="card inbox-box"><h3>📥 剛收進來（${inbox.length}）</h3><div class="small muted">AI 幫你存的，看一下標題和標籤對不對，按「收好」就移到下面。</div></div>${inbox.map(noteCard).join("")}<hr class="soft" />` : ""}
    <input id="note-q" class="note-search" placeholder="搜尋標題、重點、標籤…" value="${escapeHtml(S.noteQuery || "")}" autocomplete="off" />
    <div class="small muted" style="margin:6px 2px">${q ? `找到 ${list.length} 筆` : `共 ${notes.length} 筆`}</div>
    ${(q ? list : list.filter((n) => !n.inbox)).map(noteCard).join("") || `<div class="card small muted">${q ? "找不到符合的內容" : inbox.length ? "整理好的筆記會出現在這裡" : "還沒有內容。試試在聊天貼一個 Reels 或網頁連結。"}</div>`}`;
  bindBack(b);
  const qi = $("#note-q", b);
  qi.addEventListener("input", () => {
    S.noteQuery = qi.value;
    const pos = qi.selectionStart;
    renderPanel();
    const again = $("#note-q", els.panelBody);
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  b.querySelectorAll("[data-tag]").forEach((x) => x.addEventListener("click", () => { S.noteQuery = x.dataset.tag; renderPanel(); }));
  $("[data-go-docs]", b).addEventListener("click", () => openPanel("tickets"));
  $("#doc-up", b).addEventListener("click", () => DOC_INPUT.click());
  b.querySelectorAll("[data-file-retry]").forEach((x) => x.addEventListener("click", () => action({ action: "file_retry", id: Number(x.dataset.fileRetry) })));
  b.querySelectorAll("[data-file-del]").forEach((x) => x.addEventListener("click", () => action({ action: "file_delete", id: Number(x.dataset.fileDel) })));
  b.querySelectorAll("[data-full]").forEach((x) =>
    x.addEventListener("click", () => {
      const id = Number(x.dataset.full);
      if (S.noteText[id] != null) {
        delete S.noteText[id];
        renderPanel();
      } else action({ action: "note_text", id });
    }),
  );
  $("#note-add-box", b).addEventListener("toggle", (e) => (S.noteAddOpen = e.target.open));
  $("#note-add", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    action({ action: "note_add", title: f.get("title"), content: f.get("content"), tags: f.get("tags") });
    e.target.reset();
  });
  b.querySelectorAll("[data-file]").forEach((x) => x.addEventListener("click", () => action({ action: "note_file", id: Number(x.dataset.file) })));
  b.querySelectorAll("[data-edit-note]").forEach((x) => x.addEventListener("click", () => { S.noteEdit = Number(x.dataset.editNote); renderPanel(); }));
  b.querySelectorAll("[data-note-form]").forEach((f) => {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = new FormData(f);
      action({ action: "note_edit", id: Number(f.dataset.noteForm), title: d.get("title"), tags: d.get("tags"), summary: d.get("summary") });
      S.noteEdit = null;
    });
    f.querySelector("[data-edit-cancel]").addEventListener("click", () => { S.noteEdit = null; renderPanel(); });
  });
  if (S.noteFocus) {
    $(`#note-${S.noteFocus}`, b)?.scrollIntoView({ block: "center" });
    setTimeout(() => (S.noteFocus = null), 1500);
  }
  b.querySelectorAll("[data-del-note]").forEach((x) => x.addEventListener("click", () => confirm("確定從知識庫刪除這筆？") && action({ action: "note_delete", id: Number(x.dataset.delNote) })));
  b.querySelectorAll("[data-ask]").forEach((x) =>
    x.addEventListener("click", () => {
      const n = notes.find((y) => y.id === Number(x.dataset.ask));
      els.panel.close();
      els.input.value = `關於知識庫裡的「${n.title}」，`;
      els.input.focus();
    }),
  );
}

/** 個人助理的設定：只有本人，沒有邀請家人、旅程設定、回覆時機 */
function renderPersonalSettings(st, b) {
  els.panelTitle.textContent = "⚙️ 設定";
  const s = S.settings;
  const t = S.trip;
  const auto = store("ta-autoloc") === 1;
  const others = (store("ta-trips") || []).filter((x) => x.id !== ROOM);
  b.innerHTML = `
    <div class="card"><div class="row between"><div><b>${escapeHtml(S.me.name)}</b> <span class="tag">個人助理</span></div>
      <div class="row" style="gap:6px"><a class="btn" href="/">🏠 首頁</a><button class="btn" id="logout">登出</button></div></div>
      ${others.length ? `<div class="small muted" style="margin-top:8px">切換到：${others.map((x) => `<a href="/t/${escapeHtml(x.id)}">${escapeHtml(x.flag || "🌏")} ${escapeHtml(x.title)}</a>`).join("、")}</div>` : ""}
    </div>
    <div class="card"><label class="row between"><span>自動分享我的位置給 AI<br><span class="small muted">每 5 分鐘更新，問「附近」時更準</span></span>
      <input type="checkbox" id="autoloc" ${auto ? "checked" : ""} /></label></div>
    <div class="card small">
      <div>📍 ${escapeHtml(t.city || "未設定住的地方")}｜${escapeHtml(t.timezone)}</div>
      <div>🤖 AI：${s.gemini ? "你的 Gemini 金鑰優先，額度用完改用 Workers AI" : "⚠️ 還沒填 Gemini 金鑰，目前只用 Workers AI（到下方「API 金鑰」填）"}</div>
      <div>🔍 網路搜尋：${s.tavily ? "✅ Tavily" : "⚠️ 未設定（AI 不能上網查資料）"}</div>
    </div>
    <div class="card"><h3>🔔 手機通知</h3>
      <div class="small muted" id="push-state">檢查中…</div>
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><button class="btn" id="push-on">開啟這支手機的通知</button><button class="btn small" id="push-test">傳一則測試</button><button class="btn small" id="push-off">關閉</button></div>
      <div class="small muted" style="margin-top:6px">提醒時間到、早報、花費快超過預算時會通知你。</div>
    </div>
    <div class="card"><h3>☀️ 每日早報</h3>
      <label class="row between small"><span>每天自動發早報（天氣、提醒、待辦、本月花費）</span><input type="checkbox" id="brief-auto" ${s.autoBrief !== false ? "checked" : ""} /></label>
      <label class="row between small" style="margin-top:6px"><span>幾點發</span><select id="brief-hour">${[5, 6, 7, 8, 9, 10, 11].map((h) => `<option value="${h}" ${Number(s.briefHour ?? 7) === h ? "selected" : ""}>${h}:00</option>`).join("")}</select></label>
      <button class="btn small" id="brief-now" style="margin-top:8px">現在發一次</button>
    </div>
    <div class="card"><h3>🎙️ 語音與日記</h3>
      <label class="row between small"><span>錄音、文件用的 AI</span><select id="set-voice"><option value="gemini" ${s.voiceEngine !== "private" ? "selected" : ""}>Gemini 優先</option><option value="private" ${s.voiceEngine === "private" ? "selected" : ""}>隱私模式（只用 Cloudflare）</option></select></label>
      <div class="small muted" style="margin:2px 0 8px">${VOICE_HINT(s)}</div>
      <label class="row between small"><span>自動寫日記</span><select id="set-diary">${DIARY_MODES.map(([v, t]) => `<option value="${v}" ${(s.diaryMode || "weekly") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    </div>
    <div class="card"><h3>📥 從其他 App 存進知識庫</h3>
      <div class="small"><b>Android</b>：先把這個網站「加到主畫面」，之後在 Facebook、Chrome… 按「分享」→ 選「旅伴 AI」，就會存進知識庫。</div>
      <div class="small" style="margin-top:8px"><b>iPhone</b>：用「捷徑」App 做一個分享捷徑（每支手機設定一次）。</div>
      ${s.inbox ? `
        <div class="row" style="gap:6px;margin-top:8px"><input readonly id="inbox-url" value="${escapeHtml(location.origin + s.inbox)}" style="flex:1;min-width:0" /><button type="button" class="btn small" id="inbox-copy">複製</button></div>
        <details class="small" style="margin-top:6px"><summary>iPhone 捷徑設定步驟</summary><ol class="steps">
          <li>打開「捷徑」App，按右上角「＋」新增捷徑，名稱取「存到助理」。</li>
          <li>點上方名稱旁的箭頭 →「詳細資訊」，打開「在分享表單中顯示」。</li>
          <li>加入動作「取得 URL 的內容」：網址貼上面複製的收件網址，「方法」選 POST，「要求本文」選 JSON，新增一個文字欄位：鍵輸入 text、值選「捷徑輸入」。</li>
          <li>再加入動作「顯示通知」，內容選「URL 的內容」。</li>
          <li>完成。之後在 Safari、Facebook… 按「分享」→「存到助理」，就會存進知識庫。</li>
        </ol></details>
        <div class="small muted" style="margin-top:6px">這個網址等於你的知識庫收件匣，不要給別人；外流了就按「換一個網址」，舊的立刻失效。</div>
        <div class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn small" id="inbox-reset">換一個網址</button><button type="button" class="btn small" id="inbox-off">停用</button></div>`
      : `<button type="button" class="btn" id="inbox-on" style="margin-top:8px">產生 iPhone 捷徑用的收件網址</button>`}
    </div>
    <div class="card"><div class="stack"><button class="btn" data-go="memories">🧠 記憶（關於我、暫停記憶）</button><button class="btn" data-go="keys">🔑 API 金鑰</button><a class="btn" href="/api/export?room=${ROOM}" download>⬇️ 匯出我的資料</a></div></div>
    <div class="card"><h3>🔒 更改密碼</h3>
      <form class="form" id="pw-form">
        <input name="admin" type="password" placeholder="新密碼（至少 6 個字）" autocomplete="new-password" />
        <button class="btn primary-sm">更改</button>
        <span class="small muted">改完要用新密碼重新登入。</span>
      </form>
    </div>
    <div class="card"><h3>🧹 清除資料</h3>
      <p class="small muted">只會清除勾選的項目，<b>清除後無法復原</b>。</p>
      <form class="form" id="reset-form">
        <div class="checks">
          <label><input type="checkbox" name="chat" /> 聊天紀錄（含照片、位置）</label>
          <label><input type="checkbox" name="memory" /> 長期記憶與摘要</label>
          <label><input type="checkbox" name="tools" /> 清單、提醒、保管箱、日記、語音備忘、證件</label>
          <label><input type="checkbox" name="health" /> 健康管家的紀錄（量測、用藥、健康檔案）</label>
        </div>
        <button class="btn danger">清除勾選的資料</button>
      </form>
    </div>
    <div class="card"><h3>🗑 刪除個人助理</h3>
      <p class="small muted">聊天、照片、記憶、金鑰全部刪除，網址也會失效，<b>無法復原</b>。</p>
      <button class="btn danger" id="delete-trip">刪除這個個人助理</button>
    </div>`;
  $("#logout", b).addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.href = "/";
  });
  $("#autoloc", b).addEventListener("change", (e) => {
    store("ta-autoloc", e.target.checked ? 1 : 0);
    e.target.checked ? startAutoLocation() : stopAutoLocation();
  });
  b.querySelectorAll("[data-go]").forEach((x) => x.addEventListener("click", () => openPanel(x.dataset.go)));
  const refreshPush = () => pushStatusText().then((t) => { const el = $("#push-state", b); if (el) el.textContent = t; });
  refreshPush();
  $("#push-on", b).addEventListener("click", async () => {
    await enablePush();
    setTimeout(refreshPush, 800);
  });
  $("#push-off", b).addEventListener("click", async () => {
    await disablePush();
    setTimeout(refreshPush, 800);
  });
  $("#push-test", b).addEventListener("click", () => action({ action: "push_test" }));
  $("#set-voice", b).addEventListener("change", (e) => action({ action: "settings", voiceEngine: e.target.value }));
  $("#set-diary", b).addEventListener("change", (e) => action({ action: "settings", diaryMode: e.target.value }));
  $("#inbox-on", b)?.addEventListener("click", () => action({ action: "inbox_on" }));
  $("#inbox-reset", b)?.addEventListener("click", () => confirm("換新網址後，舊的捷徑會失效，要把新網址貼進捷徑。確定？") && action({ action: "inbox_reset" }));
  $("#inbox-off", b)?.addEventListener("click", () => confirm("停用後 iPhone 捷徑就不能存東西進來。確定？") && action({ action: "inbox_off" }));
  $("#inbox-copy", b)?.addEventListener("click", (e) => copyText(location.origin + s.inbox, e.target));
  $("#brief-auto", b).addEventListener("change", (e) => action({ action: "settings", autoBrief: e.target.checked }));
  $("#brief-hour", b).addEventListener("change", (e) => action({ action: "settings", briefHour: Number(e.target.value) }));
  $("#brief-now", b).addEventListener("click", (e) => {
    e.target.textContent = "產生中…";
    action({ action: "brief_now" });
  });
  $("#pw-form", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const admin = String(new FormData(e.target).get("admin")).trim();
    if (admin.length < 6) return alert("密碼至少 6 個字");
    if (confirm("確定更改密碼？改完要用新密碼重新登入。")) action({ action: "update_passwords", roomPassword: "", adminPassword: admin });
  });
  $("#reset-form", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const names = { chat: "聊天紀錄", memory: "長期記憶與摘要", tools: "清單、提醒、保管箱、日記、語音備忘、證件", health: "健康管家的紀錄" };
    const picked = Object.keys(names).filter((k) => f.get(k));
    if (!picked.length) return alert("請至少勾選一項");
    const typed = prompt(`即將清除：${picked.map((k) => names[k]).join("、")}\n清除後無法復原。\n\n確定的話請輸入「清除」`);
    if (typed?.trim() !== "清除") return;
    action({ action: "reset", ...Object.fromEntries(picked.map((k) => [k, true])) });
    e.target.reset();
  });
  $("#delete-trip", b).addEventListener("click", () => {
    const typed = prompt(`刪除後所有資料都無法復原。\n\n確定的話請輸入「${t.title}」`);
    if (typed == null) return;
    if (typed.trim() !== t.title) return alert("名稱不符，沒有刪除");
    action({ action: "delete_trip", confirm: typed.trim() });
  });
}

function renderSettingsPanel(st, b) {
  if (isPersonal()) return renderPersonalSettings(st, b);
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
  if (isPersonal()) {
    return [
      ["calendar", "calendar", "行事曆", "行程、提醒、訂閱到手機日曆"],
      ["health", "heart", "健康管家", "血壓血糖、用藥、健檢提醒"],
      ["notes", "book", "知識庫", "連結、筆記、文件、照片"],
      ["memo", "mic", "語音備忘", "錄音、會議記錄自動整理"],
      ["checklist", "list", "清單", "待辦、購物"],
      ["reminders", "bell", "提醒", "時間到通知你"],
      ["diary", "notebook", "日記", "每週（或每天）自動寫"],
      ["iddocs", "idcard", "證件到期", "護照、駕照到期前提醒"],
      ["memories", "bookmark", "記憶", "AI 記得你的事，可以刪改"],
    ];
  }
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
      b.innerHTML = isPersonal() ? `
        <div class="tb-grid">${toolCards().map(([id, icon, name, desc]) => `<button class="tb-card" data-go="${id}"><span class="tb-icon">${svg(icon)}</span><b>${name}</b><span class="small muted">${desc}</span></button>`).join("")}</div>` : `
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
    case "diary-edit":
      renderDiaryEditor(st, b);
      break;
  }
}

// ---------- 🎙️ 語音備忘：錄音（每 5 分鐘切一段上傳，邊錄邊轉文字）或上傳錄音檔 ----------

const VOICE_HINT = (s) =>
  s.voiceEngine === "private"
    ? "錄音、文件都不經過 Google；每天能轉的時數比較少（整個網站共用），摘要也比較簡單，掃描版 PDF 讀不了。"
    : s.gemini
      ? "錄音用你的 Gemini 金鑰轉文字（中文比較準），額度用完自動改用 Cloudflare Whisper；文件的重點也由 Gemini 整理。免費版 Gemini 的內容可能被 Google 拿去改進產品，在意的話選隱私模式。"
      : "還沒填 Gemini 金鑰，會用 Cloudflare Whisper 轉文字。";
const DIARY_MODES = [["weekly", "每週一篇（週一早上）"], ["daily", "每天一篇（隔天早上）"], ["off", "不要自動寫"]];
const SEG_MS = 5 * 60_000;
const UPLOAD_PART = 8_000_000;
const REC = { on: false, id: null, stream: null, rec: null, mime: "", seq: 0, t0: 0, timer: null, cut: null, lock: null, queue: [], busy: false, fails: 0, note: "" };
S.memoText = {};

const fmtDur = (sec) => {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};

function memoStatus(m) {
  if (m.status === "recording") return `錄音中（已收到 ${m.segs} 段）`;
  if (m.status === "processing") return `${m.title || "錄音"}：${m.done_segs < m.segs ? `轉文字中 ${m.done_segs}/${m.segs} 段` : "整理重點中"}${m.error ? `｜${m.error}` : ""}`;
  if (m.status === "error") return `⚠️ ${m.error || "處理失敗"}`;
  return "";
}

function pickAudioMime() {
  if (!window.MediaRecorder) return "";
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}

async function recStart() {
  const mime = pickAudioMime();
  if (!mime || !navigator.mediaDevices?.getUserMedia) return alert("這個瀏覽器不能錄音，請改用「上傳錄音檔」");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    return alert("沒有麥克風權限：請到手機的設定允許這個 App 使用麥克風");
  }
  const r = await api("/api/memo/start", { mime });
  if (!r.ok) {
    stream.getTracks().forEach((t) => t.stop());
    return alert(r.error || "開始錄音失敗");
  }
  Object.assign(REC, { on: true, id: r.id, stream, mime, seq: 0, t0: Date.now(), note: "" });
  // 系統把麥克風收走（來電、鎖定螢幕）：把錄到的送出去整理
  stream.getAudioTracks()[0]?.addEventListener("ended", () => recStop("錄音被系統中斷（可能是來電、鎖定螢幕或切到別的 App），已把錄到的部分送去整理。"));
  recSegment();
  REC.timer = setInterval(() => {
    const el = $("#rec-time");
    if (el) el.textContent = fmtDur((Date.now() - REC.t0) / 1000);
  }, 1000);
  try {
    REC.lock = await navigator.wakeLock?.request("screen");
  } catch {}
  renderPanel();
}

// 每 5 分鐘換一個錄音器：每一段都是完整的音檔，可以先上傳、先轉文字
function recSegment() {
  let rec;
  try {
    rec = new MediaRecorder(REC.stream, { mimeType: REC.mime, audioBitsPerSecond: 32000 });
  } catch {
    rec = new MediaRecorder(REC.stream);
  }
  const chunks = [];
  const seq = REC.seq++;
  const started = Date.now();
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const live = REC.on && REC.stream?.getAudioTracks()[0]?.readyState === "live";
    recEnqueue({ id: REC.id, seq, blob: new Blob(chunks, { type: rec.mimeType || REC.mime }), seconds: (Date.now() - started) / 1000, last: !live });
    if (live) recSegment();
    else if (REC.on) recStop();
  };
  rec.start(10_000);
  REC.rec = rec;
  clearTimeout(REC.cut);
  REC.cut = setTimeout(() => rec.state === "recording" && rec.stop(), SEG_MS);
}

function recStop(note = "") {
  if (!REC.on) return;
  REC.on = false;
  REC.note = note;
  clearTimeout(REC.cut);
  clearInterval(REC.timer);
  if (REC.rec && REC.rec.state !== "inactive") REC.rec.stop();
  // 錄音器已經停了（被系統中斷）：補一個「錄完了」的訊號
  else recEnqueue({ id: REC.id, seq: REC.seq, blob: new Blob([]), seconds: 0, last: true });
  setTimeout(() => REC.stream?.getTracks().forEach((t) => t.stop()), 500);
  REC.lock?.release?.().catch(() => {});
  REC.lock = null;
  if (S.panel === "memo") renderPanel();
}

function recEnqueue(item) {
  REC.queue.push(item);
  recPump();
}

// 依序上傳；失敗就等一下再試（最多約 10 分鐘），網路恢復會接著傳
async function recPump() {
  if (REC.busy) return;
  REC.busy = true;
  try {
    while (REC.queue.length) {
      const it = REC.queue[0];
      if (await uploadSegment(it)) {
        REC.queue.shift();
        REC.fails = 0;
      } else {
        REC.fails++;
        recNote();
        if (REC.fails > 20) break;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * REC.fails)));
      }
    }
  } finally {
    REC.busy = false;
    recNote();
  }
}

async function uploadSegment({ id, seq, blob, seconds, last }) {
  const parts = Math.max(1, Math.ceil(blob.size / UPLOAD_PART));
  for (let k = 0; k < parts; k++) {
    try {
      const res = await fetch(`/api/memo/${id}/seg?seq=${seq}&part=${k}&parts=${parts}&seconds=${Math.round(seconds)}&last=${last ? 1 : 0}`, {
        method: "POST",
        headers: { "content-type": blob.type || "application/octet-stream" },
        body: blob.slice(k * UPLOAD_PART, (k + 1) * UPLOAD_PART),
      });
      if (res.status === 409) return true; // 伺服器已經收過、錄音已結束
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          alert(e.error || "上傳失敗");
          return true;
        }
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function recNote() {
  const el = $("#rec-status");
  if (!el) return;
  const waiting = REC.queue.length;
  el.textContent = REC.note || (waiting ? (REC.fails ? `網路不穩，${waiting} 段等待重新上傳…` : `上傳中（${waiting} 段）…`) : "");
  const retry = $("#rec-retry");
  if (retry) retry.hidden = !(waiting && REC.fails > 20);
}

// 上傳手機錄好的檔案（語音備忘錄、Line 錄音…）
async function memoUploadFile(file) {
  if (!file) return;
  if (file.size > 100_000_000) return alert("檔案太大（上限 100MB）。長的會議建議直接在這裡錄音。");
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const mime = (file.type || { m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", aac: "audio/aac", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime" }[ext] || "").split(";")[0];
  const seconds = await new Promise((resolve) => {
    const a = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) ? v : 0);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    a.src = url;
  });
  const r = await api("/api/memo/start", { mime, title: file.name.replace(/\.[^.]+$/, "").slice(0, 60), source: "file" });
  if (!r.ok) return alert(r.error || "上傳失敗");
  recEnqueue({ id: r.id, seq: 0, blob: file, seconds, last: true });
  REC.note = "上傳中…傳完會自動轉文字，可以先離開這頁";
  recNote();
}

// 回放錄音：整個頁面共用一個播放器，畫面重畫時搬到那筆錄音底下（同一輪搬回去就不會停）
const PLAYER = Object.assign(document.createElement("audio"), { controls: true, preload: "none", className: "memo-audio" });
const PLAY = { id: null, seq: 0, parts: [] };
function memoPlay(m, seq) {
  Object.assign(PLAY, { id: m.id, seq, parts: (m.parts || []).filter((p) => p.status !== "failed").map((p) => p.seq) });
  PLAYER.src = `/api/memo/${m.id}/audio?seq=${seq}&room=${ROOM}`;
  PLAYER.play().catch(() => {});
  if (S.panel === "memo") renderPanel();
}
// 一段播完接下一段
PLAYER.addEventListener("ended", () => {
  const next = PLAY.parts[PLAY.parts.indexOf(PLAY.seq) + 1];
  const m = (S.state?.memos || []).find((x) => x.id === PLAY.id);
  if (next != null && m) memoPlay(m, next);
});

addEventListener("beforeunload", (e) => {
  if (REC.on || REC.queue.length) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// 逐字稿：一句一行，說話者用不同顏色的小圓標；【5:00】這類分段時間做成分隔線
function transcriptHtml(text) {
  const who = {};
  return String(text)
    .split(/\n+/)
    .map((line) => {
      const t = line.trim();
      if (!t) return "";
      const time = t.match(/^【([\d:]+)】$/);
      if (time) return `<div class="tr-time">${escapeHtml(time[1])}</div>`;
      const m = t.match(/^說話者(\S)：\s*(.*)$/);
      if (!m) return `<p>${escapeHtml(t)}</p>`;
      who[m[1]] ??= Object.keys(who).length % 4;
      return `<p class="tr-turn"><b class="spk spk-${who[m[1]]}">${escapeHtml(m[1])}</b><span>${escapeHtml(m[2])}</span></p>`;
    })
    .join("");
}

function renderMemoPanel(st, b) {
  els.panelTitle.textContent = "🎙️ 語音備忘";
  const s = S.settings || {};
  const memos = st.memos || [];
  const card = (m) => {
    let acts = [];
    try {
      acts = JSON.parse(m.actions || "[]");
    } catch {}
    const status = memoStatus(m);
    const text = S.memoText[m.id];
    return `<div class="card memo">
      <div class="row between" style="align-items:flex-start;gap:8px"><b>${escapeHtml(m.title || (m.source === "file" ? "上傳的錄音" : "錄音"))}</b><span class="small muted" style="white-space:nowrap">${dayText(m.ts)} ${timeText(m.ts)}${m.seconds ? `｜${fmtDur(m.seconds)}` : ""}</span></div>
      ${status ? `<div class="small ${m.status === "error" ? "bad-text" : "muted"}">${escapeHtml(status)}</div>` : ""}
      ${m.status === "done" ? `<div class="small msg-text">${md(m.summary || "")}</div>` : ""}
      ${acts.length ? `<div class="memo-acts">${acts.map((a, i) => `<div class="memo-act small"><span>${a.added ? "✅" : "▫️"} ${escapeHtml(a.item)}${a.who ? `<span class="muted">（${escapeHtml(a.who)}）</span>` : ""}${a.due ? `<span class="muted">｜${escapeHtml(a.due)}</span>` : ""}</span>${a.added ? "" : `<button type="button" class="btn small" data-memo-todo="${m.id}" data-idx="${i}">加到待辦</button>`}</div>`).join("")}
        ${acts.filter((a) => !a.added).length > 1 ? `<button type="button" class="btn small primary-sm" data-memo-todo="${m.id}">全部加到待辦</button>` : ""}</div>` : ""}
      ${(() => {
        if (m.status !== "done" && m.status !== "error") return "";
        const parts = (m.parts || []).filter((p) => p.status !== "failed");
        if (!m.audio_bytes) return m.status === "done" && parts.length ? `<div class="small muted" style="margin-top:6px">錄音檔已超過保留期限刪除，逐字稿還在。</div>` : "";
        let at = 0;
        const starts = new Map((m.parts || []).map((p) => [p.seq, (at += Number(p.seconds) || 0) - (Number(p.seconds) || 0)]));
        const failed = (m.parts || []).filter((p) => p.status === "failed").length;
        return `<div class="memo-play">
          <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
            ${parts.length > 1
              ? parts.map((p) => `<button type="button" class="btn small${PLAY.id === m.id && PLAY.seq === p.seq ? " primary-sm" : ""}" data-play="${m.id}" data-seq="${p.seq}">▶ ${fmtDur(starts.get(p.seq) || 0)}</button>`).join("")
              : `<button type="button" class="btn small" data-play="${m.id}" data-seq="${parts[0]?.seq ?? 0}">▶ 播放錄音</button>`}
            <span class="small muted">保留到 ${dayText(Number(m.updated || m.ts) + 30 * 86400e3)}</span>
          </div>
          <div id="memo-player-${m.id}"></div>
          ${failed && m.status === "done" ? `<button type="button" class="btn small" data-memo-retry="${m.id}" style="margin-top:6px">重轉失敗的 ${failed} 段</button>` : ""}
        </div>`;
      })()}
      ${text != null ? `<div class="transcript small">${transcriptHtml(text)}</div>` : ""}
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">
        ${m.status === "done" ? `<button type="button" class="btn small" data-memo-text="${m.id}">${text != null ? "收起逐字稿" : "看逐字稿"}</button>` : ""}
        ${m.note_id ? `<a class="btn small" href="#note-${m.note_id}">在知識庫</a>` : ""}
        ${m.status === "error" ? `<button type="button" class="btn small" data-memo-retry="${m.id}">重試</button>` : ""}
        ${REC.on && REC.id === m.id ? "" : `<button type="button" class="btn small danger" data-memo-del="${m.id}">刪除</button>`}
      </div>
    </div>`;
  };
  b.innerHTML = `
    ${backToHub()}
    <div class="card rec-card${REC.on ? " on" : ""}">
      ${REC.on
        ? `<div class="rec-live"><span class="rec-dot"></span><span class="rec-time" id="rec-time">${fmtDur((Date.now() - REC.t0) / 1000)}</span></div>
           <div class="small muted">錄音中…每 5 分鐘自動送出一段，邊錄邊轉文字</div>
           <button type="button" class="btn danger big-btn" id="rec-stop">⏹ 停止並整理</button>`
        : `<button type="button" class="primary" id="rec-start">🎙️ 開始錄音</button>
           <label class="btn big-btn center">📁 上傳錄音檔<input type="file" id="memo-file" accept="audio/*,video/mp4,video/quicktime,.m4a,.mp3,.wav,.aac" hidden /></label>`}
      <div class="small" id="rec-status"></div>
      <button type="button" class="btn small" id="rec-retry" hidden>重新上傳</button>
      <p class="small muted">開會、上課、想記事情時錄下來，錄完會自動轉成文字、整理重點和待辦，存進知識庫。錄音時畫面請保持開著（可以調暗），不要鎖定螢幕或切到別的 App，不然手機會暫停錄音。</p>
    </div>
    <div class="card small">
      <label class="row between"><span>語音轉文字</span><select id="voice-engine"><option value="gemini" ${s.voiceEngine !== "private" ? "selected" : ""}>Gemini 優先</option><option value="private" ${s.voiceEngine === "private" ? "selected" : ""}>隱私模式（只用 Cloudflare）</option></select></label>
      <div class="muted" style="margin-top:4px">${VOICE_HINT(s)}</div>
    </div>
    ${memos.map(card).join("") || `<div class="card small muted">還沒有錄音。</div>`}`;
  bindBack(b);
  recNote();
  $("#rec-start", b)?.addEventListener("click", (e) => {
    e.target.disabled = true;
    recStart().finally(() => (e.target.disabled = false));
  });
  $("#rec-stop", b)?.addEventListener("click", () => recStop());
  $("#rec-retry", b).addEventListener("click", () => {
    REC.fails = 0;
    recPump();
  });
  $("#memo-file", b)?.addEventListener("change", (e) => memoUploadFile(e.target.files[0]));
  $("#voice-engine", b).addEventListener("change", (e) => action({ action: "settings", voiceEngine: e.target.value }));
  b.querySelectorAll("[data-memo-todo]").forEach((x) =>
    x.addEventListener("click", () => action({ action: "memo_todo", id: Number(x.dataset.memoTodo), ...(x.dataset.idx != null ? { idx: Number(x.dataset.idx) } : {}) })),
  );
  b.querySelectorAll("[data-memo-text]").forEach((x) =>
    x.addEventListener("click", () => {
      const id = Number(x.dataset.memoText);
      if (S.memoText[id] != null) {
        delete S.memoText[id];
        renderPanel();
      } else action({ action: "memo_transcript", id });
    }),
  );
  b.querySelectorAll("[data-memo-retry]").forEach((x) => x.addEventListener("click", () => action({ action: "memo_retry", id: Number(x.dataset.memoRetry) })));
  b.querySelectorAll("[data-play]").forEach((x) =>
    x.addEventListener("click", () => {
      const m = memos.find((y) => y.id === Number(x.dataset.play));
      if (m) memoPlay(m, Number(x.dataset.seq));
    }),
  );
  $(`#memo-player-${PLAY.id}`, b)?.append(PLAYER);
  b.querySelectorAll("[data-memo-del]").forEach((x) =>
    x.addEventListener("click", () => confirm("刪除這段錄音？（已經存進知識庫的逐字稿會保留）") && action({ action: "memo_delete", id: Number(x.dataset.memoDel) })),
  );
}

// ---------- 📄 知識庫上傳文件 ----------

const DOC_ACCEPT = ".pdf,.docx,.pptx,.xlsx,.xls,.csv,.md,.markdown,.txt,.odt,.ods,.html,.htm";
const DOC_INPUT = Object.assign(document.createElement("input"), { type: "file", multiple: true, accept: DOC_ACCEPT });
S.noteText = {};
DOC_INPUT.addEventListener("change", async () => {
  const files = [...DOC_INPUT.files];
  DOC_INPUT.value = "";
  for (const f of files) await uploadDoc(f);
});

async function uploadDoc(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  let blob = file;
  // 純文字、CSV 可能是舊的 Big5 編碼：先轉成 UTF-8 再上傳
  if (["md", "markdown", "txt", "csv"].includes(ext)) {
    const buf = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder("big5").decode(buf);
    }
    blob = new Blob([text.replace(/^\uFEFF/, "")], { type: ext === "csv" ? "text/csv" : "text/plain" });
  }
  if (blob.size > 20_000_000) return alert(`「${file.name}」太大，單檔上限 20MB`);
  const r = await api("/api/file/start", { name: file.name, size: blob.size });
  if (!r.ok) return alert(r.error || "上傳失敗");
  const parts = Math.max(1, Math.ceil(blob.size / UPLOAD_PART));
  for (let k = 0; k < parts; k++) {
    for (let tries = 0; ; tries++) {
      try {
        const res = await fetch(`/api/file/${r.id}/part?part=${k}&parts=${parts}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob.slice(k * UPLOAD_PART, (k + 1) * UPLOAD_PART) });
        if (res.ok || res.status === 409) break;
        if (res.status < 500 || tries >= 3) {
          const e = await res.json().catch(() => ({}));
          return alert(e.error || "上傳失敗");
        }
      } catch {
        if (tries >= 3) return alert("網路不穩，上傳失敗，請再試一次");
      }
      await new Promise((ok) => setTimeout(ok, 2000 * (tries + 1)));
    }
  }
}

// ---------- 🪪 證件到期 ----------

function renderIdDocsPanel(st, b) {
  els.panelTitle.textContent = "🪪 證件到期";
  const docs = st.idDocs || [];
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">記下護照、身分證、駕照…的到期日，到期前會在聊天和手機通知提醒你（護照提前 6 個月，其他提前 3 個月、1 個月、1 週）。只記號碼末四碼，不要輸入完整號碼。</p>
    <form class="card form" id="id-add">
      <div class="row" style="gap:6px"><select name="kind" style="width:7.5em;flex:none">${["護照", "身分證", "駕照", "機車駕照", "健保卡", "居留證", "信用卡", "其他"].map((k) => `<option>${k}</option>`).join("")}</select><input name="holder" placeholder="持有人（例如 我、小美）" style="flex:1;min-width:0" /></div>
      <div class="row" style="gap:6px"><label class="small" style="flex:1">到期日<input type="date" name="expires" required /></label><label class="small" style="width:7.5em">末四碼<input name="last4" inputmode="numeric" maxlength="4" placeholder="選填" autocomplete="off" /></label></div>
      <button class="btn primary-sm">新增</button>
    </form>
    ${docs.map((d) => `<div class="card id-doc${d.days < 0 ? " bad" : d.days <= 90 ? " warn" : ""}">
      <div><b>${escapeHtml(d.holder)}・${escapeHtml(d.kind)}</b>${d.last4 ? ` <span class="small muted">末四碼 ${escapeHtml(d.last4)}</span>` : ""}
        <div class="small">${escapeHtml(d.expires)} 到期｜${d.days < 0 ? `已過期 ${-d.days} 天` : d.days === 0 ? "今天到期" : `還有 ${d.days} 天`}</div></div>
      <button type="button" class="btn small danger" data-id-del="${d.id}">刪除</button>
    </div>`).join("") || `<div class="card small muted">還沒有記錄。也可以在聊天說「我的護照 2028/3/5 到期」。</div>`}`;
  bindBack(b);
  $("#id-add", b).addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    action({ action: "iddoc_add", kind: f.get("kind"), holder: f.get("holder"), expires: f.get("expires"), last4: f.get("last4") });
    e.target.reset();
  });
  b.querySelectorAll("[data-id-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這筆證件紀錄？") && action({ action: "iddoc_delete", id: Number(x.dataset.idDel) })));
}

// ---------- 📔 個人日記：預設每週一篇，也可以改成每天一篇 ----------

function renderPersonalDiary(st, b) {
  els.panelTitle.textContent = "📔 日記";
  const ds = st.diaries ?? [];
  const mode = S.settings?.diaryMode || "weekly";
  const range = (d) => {
    const span = Number(d.span) || 1;
    if (span <= 1) return dateLabel(d.date);
    const from = new Date(Date.parse(d.date + "T00:00:00Z") - (span - 1) * 86400e3);
    return `${from.getUTCMonth() + 1}/${from.getUTCDate()}–${dateLabel(d.date)}`;
  };
  b.innerHTML = `
    ${backToHub()}
    <div class="card diary-top">
      <p class="small muted">${mode === "weekly" ? "每週一早上，AI 會用上一週的對話、照片、行事曆幫你寫一篇週記。" : mode === "daily" ? "每天早上，AI 會用前一天的對話、照片、行事曆幫你寫一篇日記。" : "自動日記已關閉，可以隨時按「現在寫一篇」。"}只有你看得到。</p>
      <label class="row between small"><span>自動寫日記</span><select id="diary-mode">${DIARY_MODES.map(([v, t]) => `<option value="${v}" ${mode === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <a class="diary-main" href="/api/album?room=${ROOM}" target="_blank" rel="noopener">${svg("book")}打開日記網頁</a>
      <div class="diary-row">
        <a class="btn" href="/api/album?room=${ROOM}&print=1" target="_blank" rel="noopener">下載 PDF</a>
        <button type="button" class="btn" id="diary-now">${mode === "daily" ? "現在寫今天的" : "現在寫最近 7 天"}</button>
      </div>
    </div>
    ${ds.length
      ? ds.map((d) => {
          const photos = JSON.parse(d.photo_ids || "[]");
          const excerpt = String(d.text || "").replace(/\s+/g, " ").slice(0, 100);
          return `<div class="diary-card">
            <a href="/api/album?room=${ROOM}#${escapeHtml(d.date)}" target="_blank" rel="noopener">
              ${photos[0] ? `<img src="/api/photo/${escapeHtml(photos[0])}" loading="lazy" alt="" />` : ""}
              <div class="diary-card-body">
                <div class="diary-kicker">${Number(d.span) > 1 ? "週記" : "日記"}・${range(d)}・${photos.length} 張照片</div>
                <h3>${escapeHtml(d.title || "日記")}</h3>
                <p>${escapeHtml(excerpt)}…</p>
              </div>
            </a>
            <div class="diary-card-btns">
              <button type="button" class="btn small" data-edit-diary="${escapeHtml(d.date)}">編輯文字與照片</button>
              <button type="button" class="btn small" data-rewrite="${escapeHtml(d.date)}">AI 重寫</button>
            </div>
          </div>`;
        }).join("")
      : `<div class="card small muted">還沒有日記。</div>`}`;
  bindBack(b);
  $("#diary-mode", b).addEventListener("change", (e) => action({ action: "settings", diaryMode: e.target.value }));
  $("#diary-now", b).addEventListener("click", (e) => {
    e.target.disabled = true;
    e.target.textContent = "寫作中，約需 30 秒…";
    action({ action: "diary_now" });
  });
  b.querySelectorAll("[data-edit-diary]").forEach((x) =>
    x.addEventListener("click", () => {
      const d = ds.find((y) => y.date === x.dataset.editDiary);
      S.diaryEdit = { date: d.date, title: d.title || "", text: d.text || "", photos: JSON.parse(d.photo_ids || "[]"), base: d.ts, editedBy: d.edited_by || "", dirty: false };
      openPanel("diary-edit");
    }),
  );
  b.querySelectorAll("[data-rewrite]").forEach((x) =>
    x.addEventListener("click", () => {
      if (!confirm("用那段時間的對話和照片重新寫這篇？（你改過的文字和照片會被蓋掉）")) return;
      x.disabled = true;
      x.textContent = "重寫中，約需 30 秒…";
      action({ action: "diary_rewrite", date: x.dataset.rewrite });
    }),
  );
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
    <p class="small muted">打開這一頁時，每個家人的手機會自動回報一次位置：開著 App 的人幾秒內就會更新，沒開的人下次打開 App 時補報。</p>
    <p class="small muted">按「🆘 我走散了」會把你的位置傳到群組，全家手機都會收到提醒，AI 也會幫忙安排集合地點。</p>`;
  bindBack(b);
  if (!S.locateAsked || Date.now() - S.locateAsked > 60_000) {
    S.locateAsked = Date.now();
    wsSend({ type: "locate_all" });
    getPosition().then((p) => wsSend({ type: "location", ...p })).catch(() => {});
  }
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

// 家人在找人：自動回報一次位置（同一次請求只回報一次）
async function reportLocationFor(req) {
  try {
    if (Number(localStorage.getItem("ta-located")) >= req.ts) return;
    localStorage.setItem("ta-located", String(req.ts));
  } catch {}
  try {
    const p = await getPosition();
    wsSend({ type: "location", ...p });
    flashNote(`📍 ${req.by} 在找家人，已回報你的位置`);
  } catch {
    flashNote(`📍 ${req.by} 在找家人，但這支手機沒開定位權限`);
  }
}

function flashNote(text) {
  let el = document.querySelector(".flash-note");
  if (!el) {
    el = document.createElement("div");
    el.className = "flash-note";
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(flashNote.t);
  flashNote.t = setTimeout(() => el.classList.remove("on"), 4000);
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
const checklistTabs = () => (isPersonal() ? ["待辦", "購物"] : ["行李", "購物", "待辦"]);
function renderChecklistPanel(st, b) {
  els.panelTitle.textContent = "✅ 清單";
  if (!checklistTabs().includes(checklistTab)) checklistTab = checklistTabs()[0];
  const all = st.checklist ?? [];
  const items = all.filter((c) => c.list === checklistTab);
  const left = items.filter((c) => !c.done).length;
  b.innerHTML = `
    ${backToHub()}
    <div class="tr-dir">${checklistTabs().map((t) => `<button data-tab="${t}" class="${t === checklistTab ? "active" : ""}">${t}（${all.filter((c) => c.list === t && !c.done).length}）</button>`).join("")}</div>
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

// ---------- 🎫 票券保管箱（可以分資料夾，沒放進資料夾的在最外層） ----------

function renderTicketsPanel(st, b) {
  els.panelTitle.textContent = isPersonal() ? "🗂 保管箱" : "🎫 票券保管箱";
  const docs = st?.documents ?? store(`ta-docs-${ROOM}`) ?? [];
  const folders = st?.docFolders ?? store(`ta-docfolders-${ROOM}`) ?? [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  // 正在看的資料夾被別人刪掉了：回最外層
  if (S.docFolder != null && !byId.has(S.docFolder)) S.docFolder = null;
  const here = S.docFolder ?? null;
  const trail = [];
  for (let f = byId.get(here); f && !trail.includes(f); f = byId.get(f.parent)) trail.unshift(f);
  const hereName = trail.at(-1)?.name ?? "";
  const byName = (a, c) => a.name.localeCompare(c.name, "zh-Hant");
  const subs = folders.filter((f) => (f.parent ?? null) === here).sort(byName);
  const items = docs.filter((d) => (d.folder ?? null) === here);
  // 資料夾自己加上裡面所有子資料夾
  const subtree = (id) => {
    const ids = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders) if (ids.has(f.parent) && !ids.has(f.id)) (ids.add(f.id), (grew = true));
    }
    return ids;
  };
  const count = (id) => {
    const ids = subtree(id);
    return docs.filter((d) => ids.has(d.folder)).length;
  };
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">${isPersonal() ? "照片、票券、文件存在這裡，只有你看得到" : "門票、訂位確認、QR Code 存在這裡，全家都看得到"}；<b>打開過一次之後，沒網路也能看</b>。可以建資料夾分類，沒放進資料夾的就在最外層。也可以在聊天傳照片說「存起來」。</p>
    <nav class="doc-crumbs"><button type="button" data-go="">🎫 全部</button>${trail.map((f) => `<span>›</span><button type="button" data-go="${f.id}">📁 ${escapeHtml(f.name)}</button>`).join("")}</nav>
    ${st ? `<div class="doc-tools">
      <button type="button" class="btn small" id="doc-add">${S.docUpload ? "收起上傳" : "＋ 上傳票券"}</button>
      <button type="button" class="btn small" id="folder-new">＋ 新資料夾</button>
      ${here != null ? `<button type="button" class="btn small" id="folder-rename">改名</button><button type="button" class="btn small" id="folder-move">移動資料夾</button><button type="button" class="btn danger small" id="folder-del">刪除資料夾</button>` : ""}
    </div>
    ${S.docUpload ? `<div class="card"><form class="form" id="doc-form">
      <div class="small muted">上傳到：${here != null ? `📁 ${escapeHtml(hereName)}` : "最外層"}</div>
      <input name="title" placeholder="名稱，例如：博物館門票 10/4 11:00" required />
      <input name="note" placeholder="備註（可留空）" />
      <input name="photo" type="file" accept="image/*" required />
      <button class="btn primary-sm" id="doc-save">上傳</button>
    </form></div>` : ""}` : ""}
    <div class="doc-grid">
      ${subs.map((f) => `<button type="button" class="card doc-folder" data-go="${f.id}"><span class="doc-folder-icon">📁</span><b>${escapeHtml(f.name)}</b><span class="small muted">${count(f.id)} 張</span></button>`).join("")}
      ${items.map((d) => `<div class="card doc">
          <img src="${escapeHtml(d.photo)}" loading="lazy" alt="" />
          <b>${escapeHtml(d.title)}</b>${d.note ? `<div class="small muted">${escapeHtml(d.note)}</div>` : ""}
          <div class="small muted">${escapeHtml(d.author)}</div>
          ${st ? `<div class="doc-btns"><button type="button" class="btn small" data-move="${d.id}">移動</button><button type="button" class="btn danger small" data-del="${d.id}">刪除</button></div>` : ""}
        </div>`).join("")}
      ${subs.length || items.length ? "" : `<div class="card small muted">${here != null ? "這個資料夾是空的" : "還沒有票券"}</div>`}
    </div>`;
  bindBack(b);
  // 預先載入所有票券照片（包含資料夾裡的），讓離線快取有東西可看
  docs.forEach((d) => fetch(d.photo).catch(() => {}));
  b.querySelectorAll("[data-go]").forEach((x) =>
    x.addEventListener("click", () => {
      S.docFolder = x.dataset.go === "" ? null : Number(x.dataset.go);
      renderPanel();
    }),
  );
  b.querySelectorAll(".doc img").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這張票券？") && action({ action: "document_delete", id: Number(x.dataset.del) })));
  b.querySelectorAll("[data-move]").forEach((x) =>
    x.addEventListener("click", async () => {
      const d = docs.find((y) => y.id === Number(x.dataset.move));
      const to = await pickFolder(d.title, folders, d.folder ?? null);
      if (to !== undefined) action({ action: "document_move", id: d.id, folder: to });
    }),
  );
  $("#doc-add", b)?.addEventListener("click", () => {
    S.docUpload = !S.docUpload;
    renderPanel();
  });
  $("#folder-new", b)?.addEventListener("click", () => {
    const name = prompt(here != null ? `在「${hereName}」裡新增資料夾，名稱：` : "新資料夾名稱：")?.trim();
    if (name) action({ action: "folder_create", name, parent: here });
  });
  $("#folder-rename", b)?.addEventListener("click", () => {
    const name = prompt("資料夾新名稱：", hereName)?.trim();
    if (name && name !== hereName) action({ action: "folder_rename", id: here, name });
  });
  $("#folder-move", b)?.addEventListener("click", async () => {
    // 不能搬進自己或自己裡面的資料夾
    const to = await pickFolder(`📁 ${hereName}`, folders, byId.get(here)?.parent ?? null, subtree(here));
    if (to !== undefined) action({ action: "folder_move", id: here, parent: to });
  });
  $("#folder-del", b)?.addEventListener("click", () => {
    if (!confirm(`刪除「${hereName}」資料夾？裡面的票券和資料夾會移到上一層，不會被刪掉。`)) return;
    S.docFolder = byId.get(here)?.parent ?? null;
    action({ action: "folder_delete", id: here });
  });
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
      S.docUpload = false;
      action({ action: "document_save", title: f.get("title"), note: f.get("note"), photoId: id, folder: here });
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "上傳";
    }
  });
}

/** 選資料夾的小視窗：回傳資料夾 id、null＝最外層、undefined＝取消；banned＝不能選的（自己和裡面的資料夾） */
function pickFolder(what, folders, current, banned = new Set()) {
  return new Promise((resolve) => {
    const rows = [];
    const walk = (parent, depth) => {
      for (const f of folders.filter((x) => (x.parent ?? null) === parent).sort((a, c) => a.name.localeCompare(c.name, "zh-Hant"))) {
        if (banned.has(f.id)) continue;
        rows.push({ ...f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    const opt = (id, label, depth) =>
      `<button type="button" data-to="${id ?? ""}" style="padding-left:${14 + depth * 20}px" ${id === current ? "disabled" : ""}>${label}${id === current ? "（現在在這裡）" : ""}</button>`;
    const dlg = document.createElement("dialog");
    dlg.className = "sheet";
    dlg.innerHTML = `<div class="sheet-handle"></div>
      <div class="sheet-head"><h2>移到哪裡？</h2><button type="button" class="icon" data-x aria-label="關閉">✕</button></div>
      <div class="small muted">${escapeHtml(what)}</div>
      <div class="folder-pick">${opt(null, "🎫 最外層", 0)}${rows.map((r) => opt(r.id, `📁 ${escapeHtml(r.name)}`, r.depth + 1)).join("")}</div>
      ${rows.length ? "" : `<div class="small muted">還沒有資料夾，先按「＋ 新資料夾」建立</div>`}`;
    let choice;
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest("[data-x]")) return dlg.close();
      const btn = e.target.closest("[data-to]");
      if (!btn || btn.disabled) return;
      choice = btn.dataset.to === "" ? null : Number(btn.dataset.to);
      dlg.close();
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(choice);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// ---------- ⏰ 提醒 ----------

function renderRemindersPanel(st, b) {
  els.panelTitle.textContent = "⏰ 提醒";
  const rs = st.reminders ?? [];
  b.innerHTML = `
    ${backToHub()}
    ${isPersonal()
      ? `<p class="small muted">時間到了會在聊天裡通知你。也可以在聊天說「明天早上 8 點提醒我繳費」。</p>`
      : `<p class="small muted">時間到了會在群組發訊息通知全家（<b>當地時間</b>，${escapeHtml(S.trip.diff)}）。也可以在聊天說「明天早上 9:30 提醒大家出門」。</p>`}
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

// 每天一張卡片（封面照＋標題＋摘要），點進去是圖文版日記網頁，那裡可以下載 PDF、分享
function renderDiaryPanel(st, b) {
  if (isPersonal()) return renderPersonalDiary(st, b);
  els.panelTitle.textContent = "📔 旅遊日記";
  const ds = st.diaries ?? [];
  const share = S.settings?.share ? location.origin + S.settings.share : "";
  const start = st.trip?.startDate;
  const dayNo = (date) => (start ? Math.floor((Date.parse(date + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400e3) + 1 : "");
  b.innerHTML = `
    ${backToHub()}
    <div class="card diary-top">
      <p class="small muted">旅途中每晚 22:00（當地時間）AI 會用當天的對話和照片寫一篇日記，整理成圖文版的日記網頁。</p>
      <a class="diary-main" href="/api/album?room=${ROOM}" target="_blank" rel="noopener">${svg("book")}打開日記網頁</a>
      <div class="diary-row">
        <a class="btn" href="/api/album?room=${ROOM}&print=1" target="_blank" rel="noopener">下載 PDF</a>
        <button type="button" class="btn" id="diary-share">分享給親友</button>
      </div>
      <div class="small muted">${share ? "分享連結已開啟：拿到連結的人不用登入就能看日記和照片。" : S.me.admin ? "分享連結還沒開啟，按「分享給親友」會先問你要不要開啟。" : "分享連結要由管理員開啟。"}</div>
      ${S.me.admin && share ? `<button type="button" class="btn small" id="diary-share-off">關閉分享連結（舊連結會失效）</button>` : ""}
    </div>
    ${ds.length
      ? ds.map((d) => {
          const photos = JSON.parse(d.photo_ids || "[]");
          const excerpt = String(d.text || "").replace(/\s+/g, " ").slice(0, 100);
          return `<div class="diary-card">
            <a href="/api/album?room=${ROOM}#${escapeHtml(d.date)}" target="_blank" rel="noopener">
              ${photos[0] ? `<img src="/api/photo/${escapeHtml(photos[0])}" loading="lazy" alt="" />` : ""}
              <div class="diary-card-body">
                <div class="diary-kicker">DAY ${dayNo(d.date)}・${dateLabel(d.date)}・${photos.length} 張照片</div>
                <h3>${escapeHtml(d.title || "旅途中的一天")}</h3>
                <p>${escapeHtml(excerpt)}…</p>
              </div>
            </a>
            <div class="diary-card-btns">
              ${d.edited_by ? `<span class="small muted">${escapeHtml(d.edited_by)} 修改過</span>` : ""}
              <button type="button" class="btn small" data-edit-diary="${escapeHtml(d.date)}">編輯文字與照片</button>
              ${S.me.admin ? `<button type="button" class="btn small" data-rewrite="${escapeHtml(d.date)}" data-edited="${escapeHtml(d.edited_by || "")}">AI 重寫</button>` : ""}
            </div>
          </div>`;
        }).join("")
      : `<div class="card small muted">還沒有日記</div>`}`;
  bindBack(b);
  $("#diary-share", b).addEventListener("click", () => {
    if (share) return shareLink(share, `${st.trip?.title || "旅遊"}｜旅遊日記`);
    if (!S.me.admin) return alert("分享連結要由管理員開啟");
    if (confirm("開啟分享連結後，拿到連結的人不用登入就能看日記和照片（之後隨時可以關閉）。要開啟嗎？")) action({ action: "share_on" });
  });
  $("#diary-share-off", b)?.addEventListener("click", () => {
    if (confirm("關閉後，之前分享出去的連結都會失效。確定關閉？")) action({ action: "share_off" });
  });
  b.querySelectorAll("[data-edit-diary]").forEach((x) =>
    x.addEventListener("click", () => {
      const d = ds.find((y) => y.date === x.dataset.editDiary);
      S.diaryEdit = { date: d.date, title: d.title || "", text: d.text || "", photos: JSON.parse(d.photo_ids || "[]"), base: d.ts, editedBy: d.edited_by || "", dirty: false };
      openPanel("diary-edit");
    }),
  );
  b.querySelectorAll("[data-rewrite]").forEach((x) =>
    x.addEventListener("click", () => {
      const warn = x.dataset.edited ? `\n\n⚠️ ${x.dataset.edited} 修改過這篇，重寫會蓋掉家人改的文字和照片。` : "";
      if (!confirm(`用 ${x.dataset.rewrite.slice(5).replace("-", "/")} 的對話和照片重新寫這篇日記？（不會在群組重貼）${warn}`)) return;
      x.disabled = true;
      x.textContent = "重寫中，約需 30 秒…";
      action({ action: "diary_rewrite", date: x.dataset.rewrite });
    }),
  );
}

// 家人修改日記：標題、內文、照片（新增、移除、調順序；第一張是這天的大圖）
function renderDiaryEditor(st, b) {
  const e = S.diaryEdit;
  if (!e) return openPanel("diary");
  els.panelTitle.textContent = `編輯 ${dateLabel(e.date)} 的日記`;
  const n = e.photos.length;
  b.innerHTML = `
    <button type="button" class="btn small" id="de-back">← 旅遊日記</button>
    <div class="card diary-edit">
      <label class="small muted" for="de-title">標題</label>
      <input id="de-title" maxlength="40" value="${escapeHtml(e.title)}" />
      <label class="small muted" for="de-text">內文（段落之間空一行）</label>
      <textarea id="de-text" rows="12">${escapeHtml(e.text)}</textarea>
      <div class="small muted">照片 ${n} 張・依順序穿插在文章裡（第一張也是這天的封面），用 ◀ ▶ 調整順序</div>
      <div class="de-photos">
        ${e.photos
          .map(
            (id, i) => `<figure>
          <img src="/api/photo/${escapeHtml(id)}" loading="lazy" alt="" />
          ${i === 0 ? `<span class="de-cover">大圖</span>` : ""}
          <div class="de-ph-btns">
            <button type="button" data-mv="${i}:-1" ${i === 0 ? "disabled" : ""} aria-label="往前">◀</button>
            <button type="button" data-rm="${i}" aria-label="移除">✕</button>
            <button type="button" data-mv="${i}:1" ${i === n - 1 ? "disabled" : ""} aria-label="往後">▶</button>
          </div>
        </figure>`,
          )
          .join("")}
        <label class="de-add">${svg("plus")}<span>${e.uploading || "新增照片"}</span><input type="file" accept="image/*" multiple hidden /></label>
      </div>
      ${e.editedBy ? `<div class="small muted">上次修改：${escapeHtml(e.editedBy)}</div>` : ""}
      <div class="diary-row"><button type="button" class="btn" id="de-cancel">取消</button><button type="button" class="btn primary-sm" id="de-save">儲存</button></div>
    </div>`;
  const leave = () => {
    if (e.dirty && !confirm("還沒儲存，確定放棄這些修改？")) return;
    S.diaryEdit = null;
    openPanel("diary");
  };
  $("#de-back", b).addEventListener("click", leave);
  $("#de-cancel", b).addEventListener("click", leave);
  $("#de-title", b).addEventListener("input", (ev) => {
    e.title = ev.target.value;
    e.dirty = true;
  });
  $("#de-text", b).addEventListener("input", (ev) => {
    e.text = ev.target.value;
    e.dirty = true;
  });
  b.querySelectorAll("[data-mv]").forEach((x) =>
    x.addEventListener("click", () => {
      const [i, d] = x.dataset.mv.split(":").map(Number);
      [e.photos[i], e.photos[i + d]] = [e.photos[i + d], e.photos[i]];
      e.dirty = true;
      renderPanel();
    }),
  );
  b.querySelectorAll("[data-rm]").forEach((x) =>
    x.addEventListener("click", () => {
      e.photos.splice(Number(x.dataset.rm), 1);
      e.dirty = true;
      renderPanel();
    }),
  );
  b.querySelector(".de-add input").addEventListener("change", async (ev) => {
    const files = [...ev.target.files];
    for (const [k, file] of files.entries()) {
      e.uploading = `上傳中 ${k + 1}/${files.length}…`;
      if (S.panel === "diary-edit") renderPanel();
      try {
        const blob = await resizeImage(file, 1600, 0.85);
        const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": blob.type }, body: blob });
        if (!res.ok) throw new Error(String(res.status));
        e.photos.push((await res.json()).id);
        e.dirty = true;
      } catch {
        alert(`第 ${k + 1} 張照片上傳失敗`);
      }
    }
    e.uploading = "";
    if (S.panel === "diary-edit") renderPanel();
  });
  $("#de-save", b).addEventListener("click", (ev) => {
    if (!e.title.trim() && !e.text.trim() && !e.photos.length) return alert("日記不能全部清空");
    ev.target.disabled = true;
    ev.target.textContent = "儲存中…";
    if (!wsSend({ type: "action", action: "diary_edit", date: e.date, title: e.title, text: e.text, photos: e.photos, base: e.base })) {
      ev.target.disabled = false;
      ev.target.textContent = "儲存";
    }
  });
}

/** 手機用分享面板（LINE、訊息…），電腦或不支援時複製連結 */
function shareLink(url, title) {
  const copy = () =>
    navigator.clipboard ? navigator.clipboard.writeText(url).then(() => alert("已複製分享連結"), () => prompt("複製這個連結分享：", url)) : prompt("複製這個連結分享：", url);
  if (navigator.share) navigator.share({ title, url }).catch((e) => e.name !== "AbortError" && copy());
  else copy();
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
  if (els.panel.open) els.panel.close();
  renderTranslator();
  // 不用 showModal：modal 會讓底部分頁列點不到
  if (!els.translator.open) els.translator.show();
  setTab("translator");
}
function closeTranslator() {
  TR.rec?.stop();
  els.translator.close();
}
$("#tr-close").addEventListener("click", closeTranslator);
els.translator.addEventListener("close", () => {
  if (!els.panel.open) setTab("chat");
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
// AI 回答裡的知識庫來源連結：#note-12 打開那一筆筆記，#doc-3 打開保管箱
document.addEventListener(
  "click",
  (e) => {
    const a = e.target.closest?.('a[href^="#note-"], a[href^="#doc-"]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const [kind, id] = a.getAttribute("href").slice(1).split("-");
    if (kind === "note") {
      S.noteFocus = Number(id);
      S.noteQuery = "";
      openPanel("notes");
    } else openPanel("tickets");
  },
  true,
);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

function routeCapture() {
  const q = new URLSearchParams(location.search);
  const parts = [];
  for (const k of ["title", "text", "url"]) {
    const v = (q.get(k) || "").trim();
    if (v && !parts.some((p) => p.includes(v))) parts.push(v);
  }
  const mine = (store("ta-trips") || []).find((t) => t.kind === "personal");
  if (!mine) {
    alert("要先在這支手機打開過個人助理，才能用分享存進知識庫");
    return location.replace("/");
  }
  location.replace(`/t/${mine.id}${parts.length ? `?share=${encodeURIComponent(parts.join("\n").slice(0, 4000))}` : ""}`);
}

if (ROOM) checkSession();
else if (location.pathname === "/capture") routeCapture();
else if (location.pathname === "/new") renderWizard();
else renderLanding();
