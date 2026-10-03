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
import { createReportHandler } from "./report.js";
import { createMailer, mailConfigFromEnv } from "./mailer.js";
import { createMailService, envRecipients } from "./mail-service.js";
import { createMailSettingsStore, versionOf } from "./mail-store.js";
import { validateMailSettings } from "../core/mail-settings.js";
import { createAi, aiConfigFromEnv } from "./ai.js";
import { createAiTools } from "./ai-tools.js";

export { aiConfigFromEnv };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
const MAX_BODY = 64 * 1024;
const RATE_LIMIT = 60; // запросов в минуту с одного ключа (по умолчанию; боевой запуск задаёт свой)
const RATE_LIMIT_SHARED = 600; // боевой: общей ссылкой с одним ключом пользуются многие устройства
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

export function createApp({ dataDir = "./data", deviceKeys, now = () => new Date(), peopleFile = process.env.STAN_PEOPLE_FILE, adminDevices, rateLimit = RATE_LIMIT, mailConfig, mailTransportFactory, aiConfig, aiFetch } = {}) {
  const clock = () => new Date(now());
  // Раздел «Администратор» — только перечисленным устройствам; без списка — всем (тесты, старый запуск)
  const canAdmin = (device) => !Array.isArray(adminDevices) || adminDevices.includes(device.name);
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
  const reportHandler = createReportHandler({ db, readRefs, clock });
  // Рассылка сводки смены: по умолчанию выключена (в тестах), боевой запуск передаёт mailConfig из окружения
  const mailCfg = mailConfig ?? { enabled: false, to: [] };
  const mailStore = createMailSettingsStore(dataDir);
  const readAllEvents = db.prepare("SELECT body FROM events ORDER BY at_ms, rowid");
  const mail = createMailService({
    mailer: mailCfg.enabled ? createMailer(mailCfg, mailTransportFactory ? { transportFactory: mailTransportFactory } : undefined) : null,
    config: mailCfg,
    readEvents: () => readAllEvents.all().map((row) => JSON.parse(row.body)),
    readMail: () => mailStore.read(),
    readRefs,
    clock,
    dataDir,
  });

  // ИИ-консультант: без ключа выключен; инструменты только читают базу тем же ядром, что экраны
  const aiTools = createAiTools({ readEvents: () => readAllEvents.all().map((row) => JSON.parse(row.body)), readRefs, eventStore, clock });
  const ai = createAi({ ...(aiConfig || {}), dataDir, tools: aiTools, clock, ...(aiFetch ? { fetchImpl: aiFetch } : {}) });
  let aiBusy = false;

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
    return w.count <= rateLimit;
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
    const isMailTest = pathname === "/api/mail/test" && req.method === "POST";
    const isMailGet = pathname === "/api/admin/mail" && req.method === "GET";
    const isMailPut = pathname === "/api/admin/mail" && req.method === "PUT";
    const isAiStatus = pathname === "/api/admin/ai/status" && req.method === "GET";
    const isAiAsk = pathname === "/api/admin/ai/ask" && req.method === "POST";

    const address = clientAddress(req);
    const ms = clock().getTime();
    for (const [ip, window] of failures) if (ms >= window.until) failures.delete(ip);
    // Блокировка по адресу бьёт только запросы без ключа или с неверным: на заводе все планшеты
    // и телефоны выходят через один общий адрес (NAT), и один браузер со старым ключом не должен
    // запирать остальных. Действующий ключ проходит всегда (его держит лимит allowed ниже);
    // ключи длинные и случайные, так что подбор через «ключ подошёл во время блокировки» нереален.
    const device = identify(req);
    if (!device) {
      const failed = failures.get(address);
      if (failed?.count >= 10) return send(res, 429, { ok: false, error: "busy" });
      // При заполнении карты новые адреса получают 429, действующие окна не вытесняются.
      if (!failed && failures.size >= 4096) return send(res, 429, { ok: false, error: "busy" });
      failures.set(address, { count: (failed?.count || 0) + 1, until: failed?.until ?? ms + 10 * 60_000 });
      return send(res, 401, { ok: false, error: "bad_key" });
    }
    if (!allowed(device.name)) return send(res, 429, { ok: false, error: "busy" });
    if (pathname === "/api/report.xlsx" && req.method === "GET") return reportHandler(res, searchParams);
    if ((isMailTest || isMailGet || isMailPut) && !canAdmin(device)) {
      return send(res, 403, { ok: false, error: "forbidden", message: "Рассылка на почту открывается только ключом владельца." });
    }
    if ((isAiStatus || isAiAsk) && !canAdmin(device)) {
      return send(res, 403, { ok: false, error: "forbidden", message: "ИИ-консультант открывается только ключом владельца." });
    }
    if (isAiStatus) return send(res, 200, { ok: true, ...ai.status() });
    if (isAiAsk) {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return send(res, e && e.code === "too_large" ? 413 : 400, { ok: false, error: "bad_request", message: "Некорректное тело запроса." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { ok: false, error: "bad_request", message: "Некорректное тело запроса." });
      if (aiBusy) return send(res, 429, { ok: false, error: "busy", message: "ИИ уже отвечает на другой вопрос. Повторите через минуту." });
      aiBusy = true;
      let result;
      try { result = await ai.ask({ question: body.question, history: body.history }); }
      finally { aiBusy = false; }
      const code = result.ok ? 200 : { ai_disabled: 409, daily_limit: 429, bad_request: 400 }[result.error] ?? 502;
      return send(res, code, result);
    }
    const mailView = () => {
      const mailSettings = mailStore.read();
      return { ok: true, mail: mailSettings, mailVersion: versionOf(mailSettings), smtpConfigured: Boolean(mailCfg.enabled), envFallback: mailSettings.recipients.length ? 0 : envRecipients(mailCfg).length };
    };
    if (isMailGet) return send(res, 200, mailView());
    if (isMailTest) {
      let body = {};
      try { const raw = await readBody(req); body = raw.trim() ? JSON.parse(raw) : {}; }
      catch (e) { return send(res, e && e.code === "too_large" ? 413 : 400, { ok: false, error: "bad_request", message: "Некорректное тело запроса." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
      const result = await mail.sendTest({ email: body.email, what: body.what });
      return send(res, result.ok ? 200 : result.error === "mail_disabled" ? 409 : result.error === "bad_request" ? 400 : 502, result);
    }
    if (!isPing && !isSummary && !isRefs && !isState && !isStats && !isEvents && !isAdminGet && !isAdminPut && !isMailPut) return send(res, 404, { ok: false, error: "not_found" });

    if (isSummary) return send(res, 200, summary());
    if (isRefs) return send(res, 200, { ok: true, ...readRefs(), canAdmin: canAdmin(device) });
    if ((isAdminGet || isAdminPut) && !canAdmin(device)) {
      return send(res, 403, { ok: false, error: "forbidden", message: "Раздел «Администратор» открывается только ключом владельца." });
    }
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
    if (isMailPut) {
      try {
        if (data?.mailVersion !== versionOf(mailStore.read())) {
          return send(res, 409, { ok: false, error: "conflict", message: "Рассылку уже изменили на другом устройстве. Обновите экран и повторите." });
        }
        const previous = mailStore.read();
        const next = validateMailSettings(data?.mail);
        mailStore.write(next);
        mail.noteSettingsChange(previous, next, clock().getTime());
        return send(res, 200, mailView());
      } catch (e) {
        if (e.code !== "bad_request") throw e;
        return send(res, 400, { ok: false, error: "bad_request", message: e.message });
      }
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
    const isCore = /^\/core\/[\w-]+\.js$/.test(rel); // общее ядро: странице отдаются все модули app/core
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
    res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
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
    mail.stop();
    return new Promise((resolve) => {
      const done = () => { try { db.close(); } catch { /* уже закрыта */ } resolve(); };
      if (!server.listening) return done();
      server.close(done);
      server.closeAllConnections?.();
    });
  }

  return { server, db, close, mail };
}

// Адрес клиента для лимита неверных ключей. На бою запрос идёт через nginx и туннель: у сокета
// у всех один внутренний адрес, настоящий nginx кладёт в X-Real-IP, затирая присланный клиентом.
// Заголовку верим только от локального или внутреннего адреса. CF-Connecting-IP не берём:
// Cloudflare снят, и этот заголовок клиент подделал бы, обходя лимит.
export function clientAddress(req) {
  const socket = String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const internal = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(socket);
  const real = req.headers["x-real-ip"];
  return internal && typeof real === "string" && real.trim() ? real.trim() : socket;
}

// Кому открыт «Администратор»: список имён из STAN_ADMIN_DEVICES, иначе устройство owner, если оно есть
export function adminDevicesFrom(text, keys) {
  const listed = String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (listed.length) return listed;
  return keys.some((k) => k.name === "owner") ? ["owner"] : undefined;
}

function main() {
  let app;
  try {
    app = createApp({
      dataDir: process.env.STAN_DATA_DIR || "./data",
      deviceKeys: parseDeviceKeys(process.env.STAN_DEVICE_KEYS),
      adminDevices: adminDevicesFrom(process.env.STAN_ADMIN_DEVICES, parseDeviceKeys(process.env.STAN_DEVICE_KEYS)),
      rateLimit: Number(process.env.STAN_RATE_LIMIT) || RATE_LIMIT_SHARED,
      mailConfig: mailConfigFromEnv(process.env),
      aiConfig: aiConfigFromEnv(process.env),
    });
  } catch (e) {
    console.error(`Ошибка запуска: ${e.message}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || "0.0.0.0";
  app.server.listen(port, host, () => console.log(`Сервер слушает ${host}:${port}`));
  app.mail.start();
  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
