// Сервер пробы связи: принимает пинги от планшета и считает сводку.
// Только встроенные модули Node; база — node:sqlite.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

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

export function createApp({ dataDir = "./data", deviceKeys, now = () => new Date() } = {}) {
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

  const insertPing = db.prepare(
    "INSERT INTO pings (device, client_at, server_at, prev_ms, prev_ok) VALUES (?, ?, ?, ?, ?)"
  );
  const insertAlive = db.prepare("INSERT OR IGNORE INTO alive (at) VALUES (?)");

  // Журнал живости: момент запуска и далее раз в минуту.
  const beat = () => {
    try { insertAlive.run(now().toISOString()); } catch { /* база уже закрыта */ }
  };
  beat();
  const timer = setInterval(beat, 60_000);
  timer.unref();

  const windows = new Map(); // имя устройства -> { minute, count }
  function allowed(name) {
    const minute = Math.floor(now().getTime() / 60_000);
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

  async function handleApi(req, res, pathname) {
    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, { ok: true });
    }
    const isPing = pathname === "/api/ping" && req.method === "POST";
    const isSummary = pathname === "/api/probe-summary" && req.method === "GET";
    if (!isPing && !isSummary) return send(res, 404, { ok: false, error: "not_found" });

    const device = identify(req);
    if (!device) return send(res, 401, { ok: false, error: "bad_key" });
    if (!allowed(device.name)) return send(res, 429, { ok: false, error: "busy" });

    if (isSummary) return send(res, 200, summary());

    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch (e) {
      if (e && e.code === "too_large") return send(res, 413, { ok: false, error: "bad_request" });
      return send(res, 400, { ok: false, error: "bad_request" });
    }
    const okType = (v, t) => v === null || v === undefined || typeof v === t;
    if (
      !data || typeof data !== "object" || Array.isArray(data) ||
      !okType(data.clientAt, "string") || !okType(data.prevMs, "number") || !okType(data.prevOk, "boolean")
    ) {
      return send(res, 400, { ok: false, error: "bad_request" });
    }
    const serverTime = now().toISOString();
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
    const full = path.resolve(PUBLIC_DIR, "." + path.sep + rel);
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
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
      fs.createReadStream(full).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        await handleApi(req, res, pathname);
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
