import { createSessionCookie, newRoomId, pickSession, readSessions, safeEqual, sessionCookie, sign } from "./auth";
import { flagEmoji } from "./profile";
import { checkDates, cleanTravelers, validateGemini, validateTavily, type PersonalSetupInput, type SetupInput } from "./room";
import { searchPlaces } from "./tools";
import type { Env, SessionUser } from "./types";

export { TripRoom } from "./room";
export { Registry } from "./registry";

const ROOM_ID = /^[a-z0-9]{6,20}$/;

function roomStub(env: Env, id: string) {
  return env.ROOM.get(env.ROOM.idFromName(id));
}

function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
}

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

const bad = (error: string, status = 400) => json({ ok: false, error }, { status });
const ipOf = (req: Request) => req.headers.get("cf-connecting-ip") ?? "local";
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function readJson(req: Request): Promise<any> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 64_000) return {};
  return req.json().catch(() => ({}));
}

/** 還沒建立旅程前（引導設置中）的 API，用邀請碼當通行證 */
async function inviteOk(req: Request, env: Env, code: unknown, kind: "trip" | "personal" | "any" = "trip"): Promise<string | null> {
  const r = await registry(env).checkInvite(ipOf(req), String(code ?? ""), kind);
  return r.ok ? null : r.error ?? "邀請碼不正確";
}

async function createTrip(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const inviteErr = await inviteOk(req, env, b.invite);
  if (inviteErr) return bad(inviteErr, 403);

  const country = str(b.country, 30);
  if (!country) return bad("請填寫要去的國家");
  const startDate = str(b.startDate, 10), endDate = str(b.endDate, 10);
  const dateErr = checkDates(startDate, endDate);
  if (dateErr) return bad(dateErr);
  const travelers = cleanTravelers(Array.isArray(b.travelers) ? b.travelers : []);
  if (!travelers.length) return bad("至少要有一位旅伴");
  const me = str(b.me, 16);
  if (!travelers.some((t) => t.name === me)) return bad("請選擇你是哪一位旅伴");
  const roomPassword = str(b.roomPassword, 64), adminPassword = str(b.adminPassword, 64);
  if (roomPassword.length < 4) return bad("旅伴密碼至少 4 個字");
  if (adminPassword.length < 6) return bad("管理員密碼至少 6 個字");
  if (roomPassword === adminPassword) return bad("管理員密碼不能和旅伴密碼一樣");
  const tavilyKey = str(b.tavilyKey, 200), geminiKey = str(b.geminiKey, 200);
  const tErr = await validateTavily(tavilyKey);
  if (tErr) return bad(tErr);
  if (geminiKey) {
    const gErr = await validateGemini(geminiKey);
    if (gErr) return bad(gErr);
  }
  if (!(await registry(env).allowCreate(ipOf(req)))) return bad("今天建立的旅程太多了，請明天再試", 429);

  const acc = b.accommodation ?? {};
  const lat = Number(acc.lat), lon = Number(acc.lon);
  const hasCoord = acc.lat != null && acc.lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const roomId = newRoomId();
  const input: SetupInput = {
    roomId,
    title: str(b.title, 40),
    country,
    city: str(b.city, 40),
    startDate,
    endDate,
    accommodation: { name: str(acc.name, 100), address: str(acc.address, 300), lat: hasCoord ? lat : null, lon: hasCoord ? lon : null },
    flights: str(b.flights, 600),
    travelers,
    roomPassword,
    adminPassword,
    tavilyKey,
    geminiKey,
  };
  const r = await roomStub(env, roomId).setup(input);
  if (!r.ok) return bad(r.error ?? "建立失敗", 500);
  await registry(env).registerRoom({
    id: roomId, title: input.title || `${input.city || country}旅行 ${startDate.slice(0, 4)}`, country, flag: flagEmoji(""), city: input.city,
    startDate, endDate, creator: me, status: "initializing", created: Date.now(), lastActive: Date.now(),
  });
  const user: SessionUser = { room: roomId, name: me, admin: true, ver: 1 };
  return json({ ok: true, room: roomId }, { headers: { "set-cookie": await createSessionCookie(env, user, await readSessions(req, env)) } });
}

/** 個人助理：只有本人一個人用，建好就能聊，不必等 AI 查目的地資料 */
async function createPersonal(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const inviteErr = await inviteOk(req, env, b.invite, "personal");
  if (inviteErr) return bad(inviteErr, 403);
  const name = str(b.name, 16);
  if (!name) return bad("請填寫你的稱呼");
  const password = str(b.password, 64);
  if (password.length < 6) return bad("密碼至少 6 個字");
  const home = b.home ?? {};
  const lat = Number(home.lat), lon = Number(home.lon);
  const hasCoord = home.lat != null && home.lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  // 個人助理不用網站的 Gemini 額度：每個人用自己的金鑰，用完才改用 Workers AI
  const geminiKey = str(b.geminiKey, 200);
  if (!geminiKey) return bad("請填你自己的 Gemini API 金鑰");
  const gErr = await validateGemini(geminiKey);
  if (gErr) return bad(gErr);
  const tavilyKey = str(b.tavilyKey, 200);
  if (tavilyKey) {
    const tErr = await validateTavily(tavilyKey);
    if (tErr) return bad(tErr);
  }
  if (!(await registry(env).allowCreate(ipOf(req)))) return bad("今天建立的空間太多了，請明天再試", 429);
  const roomId = newRoomId();
  const input: PersonalSetupInput = {
    roomId, name, password, timezone: str(b.timezone, 60), city: str(home.city, 40),
    home: { address: str(home.address, 300), lat: hasCoord ? lat : null, lon: hasCoord ? lon : null },
    tavilyKey,
    geminiKey,
  };
  const r = await roomStub(env, roomId).setupPersonal(input);
  if (!r.ok) return bad(r.error ?? "建立失敗", 500);
  const today = new Date().toISOString().slice(0, 10);
  await registry(env).registerRoom({
    id: roomId, kind: "personal", title: r.title ?? `${name}的助理`, country: "台灣", flag: "🙋", city: input.city,
    startDate: today, endDate: today, creator: name, status: "active", created: Date.now(), lastActive: Date.now(),
  });
  const user: SessionUser = { room: roomId, name, admin: true, ver: 1 };
  return json({ ok: true, room: roomId }, { headers: { "set-cookie": await createSessionCookie(env, user, await readSessions(req, env)) } });
}

async function ownerApi(req: Request, env: Env, path: string): Promise<Response> {
  const pw = (env.OWNER_PASSWORD ?? "").trim();
  if (!pw || !safeEqual(req.headers.get("x-owner-password") ?? "", pw)) {
    // 猜錯也算進邀請碼的嘗試次數，避免被暴力猜
    await registry(env).checkInvite(ipOf(req), "\u0000");
    return bad("擁有者密碼不正確", 401);
  }
  if (path === "/api/owner/rooms") return json({ ok: true, rooms: await registry(env).listRooms() });
  if (path === "/api/owner/delete" && req.method === "POST") {
    const id = str((await readJson(req)).room, 20);
    if (!ROOM_ID.test(id)) return bad("旅程代碼不正確");
    await roomStub(env, id).destroy();
    await registry(env).removeRoom(id);
    return json({ ok: true });
  }
  return bad("Not found", 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---------- 不用登入 ----------
    if (path === "/api/invite" && req.method === "POST") {
      const err = await inviteOk(req, env, (await readJson(req)).code);
      return err ? bad(err, 403) : json({ ok: true });
    }
    if (path === "/api/check-key" && req.method === "POST") {
      const b = await readJson(req);
      const err = await inviteOk(req, env, b.invite);
      if (err) return bad(err, 403);
      const key = str(b.key, 200);
      const e = b.type === "gemini" ? await validateGemini(key) : await validateTavily(key);
      return e ? bad(e) : json({ ok: true });
    }
    if (path === "/api/places" && req.method === "POST") {
      // 引導設置（用邀請碼）或管理員改住宿（用登入）都可以查地點
      const b = await readJson(req);
      const session = await readSessions(req, env);
      if (!session) {
        const err = await inviteOk(req, env, b.invite, "any");
        if (err) return bad(err, 403);
      }
      const q = str(b.q, 200);
      if (!q) return bad("請輸入地點");
      try {
        return json({ ok: true, places: await searchPlaces(q, str(b.countryCode, 2) || undefined, 5) });
      } catch {
        return bad("地圖搜尋暫時無法使用", 502);
      }
    }
    if (path === "/api/rooms" && req.method === "POST") return createTrip(req, env);
    if (path === "/api/personal" && req.method === "POST") return createPersonal(req, env);
    if (path.startsWith("/api/owner/")) return ownerApi(req, env, path);

    const info = path.match(/^\/api\/room\/([a-z0-9]+)$/);
    if (info && req.method === "GET") {
      if (!ROOM_ID.test(info[1])) return json({ exists: false });
      return roomStub(env, info[1]).fetch("https://room/info");
    }

    if (path === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const room = str(body.room, 20);
      if (!ROOM_ID.test(room)) return bad("旅程代碼不正確");
      const res = await roomStub(env, room).fetch("https://room/login", {
        method: "POST",
        body: JSON.stringify({ name: body.name, password: body.password }),
        headers: { "x-ip": ipOf(req) },
      });
      const data = (await res.json()) as { ok: boolean; user?: SessionUser; error?: string };
      if (!data.ok || !data.user) return json(data, { status: res.status });
      // 登入新的空間不會把手機上其他空間的登入擠掉
      return json(data, { headers: { "set-cookie": await createSessionCookie(env, data.user, await readSessions(req, env)) } });
    }

    // 只登出目前這個空間，其他空間保持登入
    if (path === "/api/logout" && req.method === "POST") {
      const set = await readSessions(req, env);
      const room = req.headers.get("x-room") || set?.cur || "";
      if (set) {
        delete set.rooms[room];
        if (set.cur === room) set.cur = Object.keys(set.rooms).at(-1) ?? "";
      }
      return json({ ok: true }, { headers: { "set-cookie": await sessionCookie(env, set) } });
    }

    // ---------- 個人助理的行事曆訂閱（ICS）：不用登入，Google／Apple 日曆定時來拿；看得到與否由網址裡的密語決定 ----------
    const ics = path.match(/^\/ics\/([a-z0-9]+)\/([\w-]+)\.ics$/);
    if (ics && req.method === "GET") {
      if (!ROOM_ID.test(ics[1])) return new Response("Not found", { status: 404 });
      return roomStub(env, ics[1]).fetch(new Request(`https://room/ics/${ics[2]}.ics`));
    }

    // ---------- 個人助理的分享收件網址（iPhone 捷徑）：不用登入，收不收由網址裡的密語決定 ----------
    const inbox = path.match(/^\/in\/([a-z0-9]+)\/([\w-]+)$/);
    if (inbox && req.method === "POST") {
      if (!ROOM_ID.test(inbox[1])) return new Response("Not found", { status: 404 });
      return roomStub(env, inbox[1]).fetch(
        new Request(`https://room/inbox/${inbox[2]}`, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: req.body }),
      );
    }

    // ---------- 旅遊日記分享連結：不用登入，看不看得到由那個旅程的分享碼決定（管理員可隨時關閉） ----------
    const share = path.match(/^\/share\/([a-z0-9]+)\/([\w-]+(?:\/photo\/[\w-]+)?)$/);
    if (share && req.method === "GET") {
      if (!ROOM_ID.test(share[1])) return new Response("Not found", { status: 404 });
      return roomStub(env, share[1]).fetch(new Request(`https://room/share/${share[2]}${url.search}`, { headers: { "x-origin": url.origin } }));
    }

    // ---------- 要登入（依請求指定的空間，或最近用的空間，轉給那個房間） ----------
    if (path.startsWith("/api/") || path === "/ws") {
      const set = await readSessions(req, env);
      const want = req.headers.get("x-room") || url.searchParams.get("room") || null;
      const user = pickSession(set, want);
      if (!user || !set) {
        // 這支手機沒登入過這個空間：告訴前端，讓它顯示登入畫面
        if (path === "/api/me" && want) return json({ ok: false, error: "請先登入", other: set?.cur || null }, { status: 401 });
        return bad("請先登入", 401);
      }
      const headersFor = (u: SessionUser) => {
        const h = new Headers(req.headers);
        h.set("x-user-name", encodeURIComponent(u.name));
        h.set("x-user-admin", u.admin ? "1" : "0");
        h.set("x-user-ver", String(u.ver));
        return h;
      };
      const headers = headersFor(user);
      const room = roomStub(env, user.room);

      if (path === "/api/me") {
        const res = await room.fetch(new Request("https://room/me", { headers }));
        if (!res.ok) {
          // 密碼改過或空間被刪：只登出這個空間
          delete set.rooms[user.room];
          if (set.cur === user.room) set.cur = Object.keys(set.rooms).at(-1) ?? "";
          return json({ ok: false, error: "請重新登入" }, { status: 401, headers: { "set-cookie": await sessionCookie(env, set) } });
        }
        const body = { ok: true, user: { room: user.room, name: user.name, admin: user.admin } };
        // 打開哪個空間，哪個就是「最近用的」：沒帶空間代碼的請求（圖片、日記網頁）才會送對地方
        if (set.cur === user.room) return json(body);
        return json(body, { headers: { "set-cookie": await sessionCookie(env, { ...set, cur: user.room }) } });
      }

      // 旅遊日記網頁（日記＋照片），可列印成 PDF；?print=1 打開就直接列印
      if (path === "/api/album" && req.method === "GET") {
        headers.set("x-origin", url.origin);
        return room.fetch(new Request("https://room/album" + url.search, { headers }));
      }

      // 網路圖片轉送：避免原網站擋外連；網址由 find_images 簽章，不能當成公開代理使用
      if (path === "/api/img" && req.method === "GET") {
        const target = url.searchParams.get("u") ?? "";
        const sig = url.searchParams.get("s") ?? "";
        if (!/^https?:\/\//.test(target) || !safeEqual(sig, await sign(env, "img:" + target))) return new Response("Forbidden", { status: 403 });
        try {
          const res = await fetch(target, {
            headers: { "user-agent": "Mozilla/5.0 (compatible; TripAgent/1.0)", accept: "image/*" },
            signal: AbortSignal.timeout(15_000),
          });
          const type = res.headers.get("content-type") ?? "";
          if (!res.ok || !type.startsWith("image/") || Number(res.headers.get("content-length") || 0) > 5_000_000) {
            await res.body?.cancel();
            return new Response("Image unavailable", { status: 502 });
          }
          return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
        } catch {
          return new Response("Image unavailable", { status: 502 });
        }
      }

      if (path === "/ws") {
        if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
        return room.fetch(new Request("https://room/ws", { headers }));
      }

      // 個人助理：手機推播訂閱、匯出資料
      const direct: Record<string, string> = { "/api/push/key": "/push/key", "/api/push/subscribe": "/push/subscribe", "/api/push/unsubscribe": "/push/unsubscribe", "/api/export": "/export" };
      if (direct[path]) {
        headers.set("x-origin", url.origin);
        return room.fetch(new Request(`https://room${direct[path]}`, { method: req.method, headers, body: req.method === "POST" ? req.body : undefined }));
      }

      // 語音備忘：開始錄音、上傳每一段（錄音每 5 分鐘一段，大檔切成好幾塊）
      // 知識庫上傳文件：開始、分塊上傳、下載原檔（下載連結帶 ?room=）
      const file = path.match(/^\/api\/file\/(start|\d+\/part|\d+)$/);
      if (file && (req.method === "POST" || req.method === "GET")) {
        return room.fetch(new Request(`https://room/file/${file[1]}${url.search}`, { method: req.method, headers, body: req.method === "POST" ? req.body : undefined }));
      }

      // 回放錄音（<audio> 帶不了標頭：網址上的 ?room= 指定空間；Range 標頭照轉）
      const memoAudio = path.match(/^\/api\/memo\/(\d+)\/audio$/);
      if (memoAudio && req.method === "GET") return room.fetch(new Request(`https://room/memo/${memoAudio[1]}/audio${url.search}`, { headers }));
      const memo = path.match(/^\/api\/memo\/(start|\d+\/seg)$/);
      if (memo && req.method === "POST") {
        return room.fetch(new Request(`https://room/memo/${memo[1]}${url.search}`, { method: "POST", headers, body: req.body }));
      }

      if (path === "/api/photo" && req.method === "POST") {
        return room.fetch(new Request("https://room/photo", { method: "POST", headers, body: req.body }));
      }

      const photo = path.match(/^\/api\/photo\/([\w-]+)$/);
      if (photo && req.method === "GET") {
        const res = await room.fetch(new Request(`https://room/photo/${photo[1]}`, { headers }));
        if (res.status !== 404 || want) return res;
        // <img> 沒辦法帶空間代碼：同時開著兩個空間時，照片可能在另一個空間
        for (const [id, u] of Object.entries(set.rooms)) {
          if (id === user.room) continue;
          const other = await roomStub(env, id).fetch(new Request(`https://room/photo/${photo[1]}`, { headers: headersFor({ room: id, ...u }) }));
          if (other.ok) return other;
        }
        return res;
      }

      return bad("Not found", 404);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
