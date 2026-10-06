// 離線支援：App 畫面與照片（票券）快取。
// 畫面檔案走「網路優先」：有網路一定拿最新版（更新馬上生效），沒網路才用快取。
// 照片走「快取優先」：照片網址不會變，看過一次就存起來，離線也能看票券。
const SHELL_CACHE = "ta-shell-v1";
const PHOTO_CACHE = "ta-photos-v1";
const SHELL = ["/", "/index.html", "/common.js", "/onboard.js", "/app.js", "/health.js", "/photos.js", "/style.css", "/manifest.webmanifest", "/icon.svg", "/vendor/marked.min.js", "/vendor/purify.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// 手機推播：伺服器送來的內容已加密，瀏覽器解開後交給這裡顯示（iOS 規定每則推播都要顯示通知）
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "旅伴 AI", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "旅伴 AI", {
      body: d.body || "",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
      icon: "/icon.svg",
      badge: "/icon.svg",
    }),
  );
});

// 點通知：已經開著這個空間就切過去，不然開新視窗
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((all) => {
      const hit = all.find((c) => c.url.startsWith(url));
      return hit ? hit.focus() : self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/photo/")) {
    e.respondWith(
      caches.open(PHOTO_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // 其他 API 與 WebSocket 不快取
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (await caches.match("/")) || Response.error()),
  );
});
