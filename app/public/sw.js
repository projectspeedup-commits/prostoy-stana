// Офлайн-кеш страницы рабочего. /api/* не кешируется никогда.
const CACHE = "stan-v78";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./queue.js",
  "./tokens.css",
  "./app.css",
  "./fonts/golos-text-cyrillic.woff2",
  "./fonts/golos-text-latin.woff2",
  "./theme.js",
  "./core/core.js",
  "./core/refs.js",
  "./core/stats.js",
  "./core/zones.js",
  "./core/settings.js",
  "./core/mail-settings.js",
  "./core/report-period.js",
  "./core/report.js",
  "./core/xlsx.js",
  "./timeline.js",
  "./timeline.css",
  "./charts.js",
  "./report-ui.js",
  "./report.css",
  "./pult.css",
  "./mock.js",
  "./icon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  // Новая версия вступает в силу сразу, даже если какой-то файл из списка не скачался:
  // иначе упавшая установка оставляла бы устройство на старой версии навсегда
  self.skipWaiting();
  e.waitUntil(
    // Мимо кэша браузера: после выкладки GitHub Pages до 10 минут отдаёт старые копии из него
    caches.open(CACHE).then((c) => Promise.all(ASSETS.map((u) =>
      c.add(new Request(u, { cache: "reload" })).catch(() => { /* файл подтянется при первом запросе */ }))))
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
      .then(async (r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        if ([500, 502, 503, 504].includes(r.status)) {
          const cached = await caches.match(e.request, { ignoreSearch: true }) || (e.request.mode === "navigate" ? await caches.match("./index.html") : null);
          if (cached) return cached;
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (e.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
