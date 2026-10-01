// Офлайн-кеш страницы рабочего. /api/* не кешируется никогда.
const CACHE = "stan-v32";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./app.css",
  "./theme.js",
  "./core/core.js",
  "./core/refs.js",
  "./core/stats.js",
  "./core/zones.js",
  "./timeline.js",
  "./timeline.css",
  "./charts.js",
  "./mock.js",
  "./icon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    // Мимо кэша браузера: после выкладки GitHub Pages до 10 минут отдаёт старые копии из него
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  // Сеть вперёд, кеш — запасной вариант; удачный ответ обновляет кеш.
  // Каждый раз сверяемся с сервером (no-cache): неизменённый файл приходит коротким ответом 304,
  // а свежая выкладка видна сразу, без ожидания срока кэша браузера
  e.respondWith(
    fetch(new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" }))
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request).then((cached) => {
          if (cached) return cached;
          if (e.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
