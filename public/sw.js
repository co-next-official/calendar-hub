// Offline shell only. API, auth, guest and feed responses are never cached (they are personal data).
const CACHE = "calendar-hub-shell-v1";
const SHELL = ["/", "/app.js", "/app.css", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Web Push: show a notification for a reminder, and focus the app when tapped.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "予定のリマインダー";
  const when = data.startAt ? new Date(data.startAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
  const body = when ? `まもなく開始：${when}` : "まもなく始まります";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: data.eventId || undefined,
    data: { eventId: data.eventId || null },
    icon: "/favicon.svg",
    badge: "/favicon.svg",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) { if (c.url.startsWith(location.origin)) return c.focus(); }
    return self.clients.openWindow("/");
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (!SHELL.includes(url.pathname) && event.request.mode !== "navigate") return;
  if (event.request.mode === "navigate" && url.pathname !== "/") return;
  // Network first so deploys show up immediately; fall back to the cached shell when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
  );
});
