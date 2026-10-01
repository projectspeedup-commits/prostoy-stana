// Сервер учёта простоев и пробы связи.
// Только встроенные модули Node; база — node:sqlite.
import { pipeline } from "node:stream";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createEventStore } from "./events.js";
import { createRefsReader } from "./people.js";
import { createSettingsStore } from "./settings.js";
import { settingsFromRefs, validateSettings } from "../core/settings.js";
import { computeStats, periodRange } from "../core/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
const MAX_BODY = 64 * 1024;
const RATE_LIMIT = 60; // запросов в минуту с одного ключа
const ALIVE_GAP_MINUTES = 3; // разрыв живости больше этого — простой сервера

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Разбор строки STAN_DEVICE_KEYS вида «название:ключ,название:ключ». */
export function parseDeviceKeys(text) {
  const result = [];
  for (const part of String(text ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const i = item.indexOf(":");
    if (i <= 0 || i === item.length - 1) {
      throw new Error("STAN_DEVICE_KEYS: элемент должен иметь вид название:ключ");
    }
    result.push({ name: item.slice(0, i).trim(), key: item.slice(i + 1).trim() });
  }
  return result;
}

function sameKey(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // Сравниваем хеши одинаковой длины, чтобы время не зависело от длины ключа.
  const ha = crypto.createHash("sha256").update(ba).digest();
  const hb = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ba.length === bb.length;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function createApp({ dataDir = "./data", deviceKeys, now = () => new Date(), peopleFile = process.env.STAN_PEOPLE_FILE } = {}) {
  const clock = () => new Date(now());
  const settingsStore = createSettingsStore(dataDir === ":memory:" ? null : path.join(dataDir, "settings.json"));
  const readRefs = createRefsReader(peopleFile, settingsStore);
  let settingsWrites = Promise.resolve();
  function updateSettings(input, refsVersion) {
    // Проверяем ID и возвращаем версию внутри очереди: следующий PUT видит завершённый предыдущий.
    const update = settingsWrites.then(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Некорректные настройки."), { code: "bad_request" });
      const current = readRefs();
      if (refsVersion !== current.refsVersion) throw Object.assign(new Error("Настройки уже изменили на другом устройстве. Обновите экран и повторите."), { code: "conflict" });
      const settings = validateSettings(input, current.refs.people);
      await settingsStore.write(settings);
      return { ok: true, settings, refsVersion: readRefs().refsVersion };
    });
    settingsWrites = update.catch(() => {});
    return update;
  }
  const keys = Array.isArray(deviceKeys) ? deviceKeys : parseDeviceKeys(deviceKeys);
  if (!keys.length) {
    throw new Error("Не заданы ключи устройств (STAN_DEVICE_KEYS): сервер без ключей не запускается.");
  }

  let db;
  if (dataDir === ":memory:") {
    db = new DatabaseSync(":memory:");
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(path.join(dataDir, "stan.db"));
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY,
      device TEXT,
      client_at TEXT,
      server_at TEXT,
      prev_ms INTEGER,
      prev_ok INTEGER
    );
    CREATE TABLE IF NOT EXISTS alive (at TEXT PRIMARY KEY);
  `);
  const eventStore = createEventStore(db);

  const insertPing = db.prepare(
    "INSERT INTO pings (device, client_at, server_at, prev_ms, prev_ok) VALUES (?, ?, ?, ?, ?)"
  );
  const insertAlive = db.prepare("INSERT OR IGNORE INTO alive (at) VALUES (?)");

  // Журнал живости: момент запуска и далее раз в минуту.
  const beat = () => {
    try { insertAlive.run(clock().toISOString()); } catch { /* база уже закрыта */ }
  };
  beat();
  const timer = setInterval(beat, 60_000);
  timer.unref();

  const failures = new Map();
  const windows = new Map(); // имя устройства -> { minute, count }
  function allowed(name) {
    const minute = Math.floor(clock().getTime() / 60_000);
    const w = windows.get(name);
    if (!w || w.minute !== minute) {
      windows.set(name, { minute, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= RATE_LIMIT;
  }

  function identify(req) {
    const given = req.headers["x-device-key"];
    if (typeof given !== "string" || !given) return null;
    let found = null;
    for (const k of keys) {
      if (sameKey(given, k.key)) found = k; // перебираем все, не выходим раньше
    }
    return found;
  }

  function send(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("too_large"), { code: "too_large" }));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function summary() {
    const rows = db.prepare("SELECT server_at, prev_ms, prev_ok FROM pings ORDER BY server_at, id").all();
    const total = rows.length;
    const judged = rows.filter((r) => r.prev_ok !== null && r.prev_ok !== undefined);
    const okShare = judged.length
      ? Math.round((judged.filter((r) => r.prev_ok === 1).length / judged.length) * 1000) / 1000
      : null;
    // Самый длинный перерыв — между соседними принятыми пробами.
    let longest = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = (Date.parse(rows[i].server_at) - Date.parse(rows[i - 1].server_at)) / 60_000;
      if (gap > longest) longest = gap;
    }
    const ms = rows.filter((r) => r.prev_ok === 1 && Number.isFinite(r.prev_ms)).map((r) => r.prev_ms);
    const alive = db.prepare("SELECT at FROM alive ORDER BY at").all();
    let down = 0;
    for (let i = 1; i < alive.length; i++) {
      const gap = (Date.parse(alive[i].at) - Date.parse(alive[i - 1].at)) / 60_000;
      if (gap > ALIVE_GAP_MINUTES) down += gap;
    }
    return {
      ok: true,
      total,
      okShare,
      longestGapMinutes: Math.round(longest * 10) / 10,
      medianMs: median(ms),
      from: total ? rows[0].server_at : null,
      to: total ? rows[total - 1].server_at : null,
      serverDownMinutes: Math.round(down * 10) / 10,
    };
  }

  async function handleApi(req, res, pathname, searchParams) {
    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, { ok: true, settings: readRefs.status() });
    }
    const isPing = pathname === "/api/ping" && req.method === "POST";
    const isSummary = pathname === "/api/probe-summary" && req.method === "GET";
    const isRefs = pathname === "/api/refs" && req.method === "GET";
    const isState = pathname === "/api/state" && req.method === "GET";
    const isStats = pathname === "/api/stats" && req.method === "GET";
    const isEvents = pathname === "/api/events" && req.method === "POST";
    const isAdminGet = pathname === "/api/admin/settings" && req.method === "GET";
    const isAdminPut = pathname === "/api/admin/settings" && req.method === "PUT";

    const address = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
    const ms = clock().getTime();
    for (const [ip, window] of failures) if (ms >= window.until) failures.delete(ip);
    const failed = failures.get(address);
    if (failed?.count >= 10) return send(res, 429, { ok: false, error: "busy" });
    const device = identify(req);
    if (!device) {
      // При заполнении карты новые адреса получают 429, действующие окна не вытесняются.
      if (!failed && failures.size >= 4096) return send(res, 429, { ok: false, error: "busy" });
      failures.set(address, { count: (failed?.count || 0) + 1, until: failed?.until ?? ms + 10 * 60_000 });
      return send(res, 401, { ok: false, error: "bad_key" });
    }
    if (!allowed(device.name)) return send(res, 429, { ok: false, error: "busy" });
    if (!isPing && !isSummary && !isRefs && !isState && !isStats && !isEvents && !isAdminGet && !isAdminPut) return send(res, 404, { ok: false, error: "not_found" });

    if (isSummary) return send(res, 200, summary());
    if (isRefs) return send(res, 200, { ok: true, ...readRefs() });
    if (isAdminGet) {
      const { refs, refsVersion } = readRefs();
      return send(res, 200, { ok: true, settings: settingsFromRefs(refs), refsVersion });
    }
    if (isState) {
      const { refs, refsVersion } = readRefs();
      const time = clock();
      return send(res, 200, { ok: true, state: eventStore.state(time.getTime(), refs), refsVersion, serverTime: time.toISOString() });
    }
    if (isStats) {
      const period = searchParams.get("period");
      if (!new Set(["shift", "day", "week", "month"]).has(period)) {
        return send(res, 400, { ok: false, error: "bad_request" });
      }
      const { refs } = readRefs();
      const time = clock();
      const range = periodRange(period, time.getTime(), refs.settings.schedule);
      const events = db.prepare("SELECT body FROM events ORDER BY at_ms, rowid").all().map((row) => JSON.parse(row.body));
      const stats = computeStats(events, { ...range, nowMs: time.getTime(), refs });
      return send(res, 200, { ok: true, period, label: range.label, stats, serverTime: time.toISOString() });
    }

    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch (e) {
      const tooLarge = e && e.code === "too_large";
      return send(res, tooLarge ? 413 : 400, {
        ok: false, error: "bad_request",
        ...(isAdminPut ? { message: tooLarge ? "Тело запроса не должно превышать 64 КБ." : "Некорректный JSON в теле запроса." } : {}),
      });
    }
    if (isAdminPut) {
      try { return send(res, 200, await updateSettings(data?.settings, data?.refsVersion)); }
      catch (e) {
        if (e.code === "conflict") return send(res, 409, { ok: false, message: e.message });
        if (e.code !== "bad_request") throw e;
        return send(res, 400, { ok: false, error: "bad_request", message: e.message });
      }
    }
    if (isEvents) {
      if (!data || !Array.isArray(data.events) || data.events.length > 200) {
        return send(res, 400, { ok: false, error: "bad_request" });
      }
      const { refs } = readRefs();
      const time = clock();
      const result = eventStore.save(data.events, time.getTime(), device.name, refs.settings.schedule);
      return send(res, 200, { ok: true, ...result, state: eventStore.state(time.getTime(), refs), serverTime: time.toISOString() });
    }
    const okType = (v, t) => v === null || v === undefined || typeof v === t;
    if (
      !data || typeof data !== "object" || Array.isArray(data) ||
      !okType(data.clientAt, "string") || !okType(data.prevMs, "number") || !okType(data.prevOk, "boolean")
    ) {
      return send(res, 400, { ok: false, error: "bad_request" });
    }
    const serverTime = clock().toISOString();
    insertPing.run(
      device.name,
      data.clientAt ?? null,
      serverTime,
      data.prevMs == null ? null : Math.round(data.prevMs),
      data.prevOk == null ? null : data.prevOk ? 1 : 0
    );
    return send(res, 200, { ok: true, serverTime });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Метод не поддерживается");
    }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { rel = null; }
    if (rel === null || rel.includes("\0")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Плохой запрос");
    }
    if (rel.endsWith("/")) rel += "index.html";
    const isCore = rel === "/core/core.js" || rel === "/core/refs.js" || rel === "/core/stats.js" || rel === "/core/zones.js" || rel === "/core/settings.js";
    const full = isCore ? path.resolve(HERE, "..", "core", rel.slice("/core/".length)) : path.resolve(PUBLIC_DIR, "." + path.sep + rel);
    if (!isCore && full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Не найдено");
    }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Не найдено");
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size,
      });
      if (req.method === "HEAD") return res.end();
      pipeline(fs.createReadStream(full), res, (error) => {
        if (error) {
          console.error("Ошибка чтения статического файла:", error.code || error.name);
          if (!res.destroyed) res.destroy();
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      if (pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        await handleApi(req, res, pathname, url.searchParams);
      } else {
        serveStatic(req, res, pathname);
      }
    } catch {
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal" });
      else res.end();
    }
  });

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(timer);
    return new Promise((resolve) => {
      const done = () => { try { db.close(); } catch { /* уже закрыта */ } resolve(); };
      if (!server.listening) return done();
      server.close(done);
      server.closeAllConnections?.();
    });
  }

  return { server, db, close };
}

function main() {
  let app;
  try {
    app = createApp({
      dataDir: process.env.STAN_DATA_DIR || "./data",
      deviceKeys: parseDeviceKeys(process.env.STAN_DEVICE_KEYS),
    });
  } catch (e) {
    console.error(`Ошибка запуска: ${e.message}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || "0.0.0.0";
  app.server.listen(port, host, () => console.log(`Сервер слушает ${host}:${port}`));
  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
