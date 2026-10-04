import { clearSessionCookie, createSessionCookie, newRoomId, readSession, safeEqual, sign } from "./auth";
import { flagEmoji } from "./profile";
import { checkDates, cleanTravelers, validateGemini, validateTavily, type SetupInput } from "./room";
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
async function inviteOk(req: Request, env: Env, code: unknown): Promise<string | null> {
  const r = await registry(env).checkInvite(ipOf(req), String(code ?? ""));
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
  return json({ ok: true, room: roomId }, { headers: { "set-cookie": await createSessionCookie(env, user) } });
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
      const session = await readSession(req, env);
      if (!session) {
        const err = await inviteOk(req, env, b.invite);
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
      return json(data, { headers: { "set-cookie": await createSessionCookie(env, data.user) } });
    }

    if (path === "/api/logout" && req.method === "POST") {
      return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
    }

    // ---------- 旅遊日記分享連結：不用登入，看不看得到由那個旅程的分享碼決定（管理員可隨時關閉） ----------
    const share = path.match(/^\/share\/([a-z0-9]+)\/([\w-]+(?:\/photo\/[\w-]+)?)$/);
    if (share && req.method === "GET") {
      if (!ROOM_ID.test(share[1])) return new Response("Not found", { status: 404 });
      return roomStub(env, share[1]).fetch(new Request(`https://room/share/${share[2]}${url.search}`, { headers: { "x-origin": url.origin } }));
    }

    // ---------- 要登入（依 cookie 裡的旅程轉給那個旅程房間） ----------
    if (path.startsWith("/api/") || path === "/ws") {
      const user = await readSession(req, env);
      if (!user) return bad("請先登入", 401);
      const headers = new Headers(req.headers);
      headers.set("x-user-name", encodeURIComponent(user.name));
      headers.set("x-user-admin", user.admin ? "1" : "0");
      headers.set("x-user-ver", String(user.ver));
      const room = roomStub(env, user.room);

      if (path === "/api/me") {
        // 手機上登入的是別的旅程：告訴前端，讓它顯示登入畫面
        const want = url.searchParams.get("room");
        if (want && want !== user.room) return json({ ok: false, error: "請先登入這個旅程", other: user.room }, { status: 401 });
        const res = await room.fetch(new Request("https://room/me", { headers }));
        if (!res.ok) return json({ ok: false, error: "請重新登入" }, { status: 401, headers: { "set-cookie": clearSessionCookie() } });
        return json({ ok: true, user: { room: user.room, name: user.name, admin: user.admin } });
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

      if (path === "/api/photo" && req.method === "POST") {
        return room.fetch(new Request("https://room/photo", { method: "POST", headers, body: req.body }));
      }

      const photo = path.match(/^\/api\/photo\/([\w-]+)$/);
      if (photo && req.method === "GET") return room.fetch(new Request(`https://room/photo/${photo[1]}`, { headers }));

      return bad("Not found", 404);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
