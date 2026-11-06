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
