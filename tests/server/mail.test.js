import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../../app/server/index.js";
import { mailConfigFromEnv, createMailer } from "../../app/server/mailer.js";
import { buildDigest, hoursMinutes } from "../../app/server/digest.js";
import { createMailService, lastFinishedShift, nextDueMs, MAX_LATE_MS, RETRY_MS } from "../../app/server/mail-service.js";
import { computeStats } from "../../app/core/stats.js";
import { durationWords } from "../../app/core/report.js";
import { DEFAULT_SCHEDULE, shiftOf } from "../../app/core/core.js";
import { readXlsx } from "../helpers/xlsx-read.js";
import { refs, dayFixture, T, eventMaker } from "../helpers/report-fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIN = 60_000;
const quiet = { log() {}, error() {} };
const CONFIG = { enabled: true, host: "smtp.example.test", port: 465, secure: true, user: "u@example.test", pass: "secret", from: "u@example.test", to: ["a@example.test", "b@example.test"], publicUrl: "https://stan.example.test/" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stan-mail-"));

// ---- настройки

test("настройки: по умолчанию Яндекс 465/SSL, MAIL_FROM = SMTP_USER, адреса через запятую", () => {
  const c = mailConfigFromEnv({ SMTP_USER: "me@yandex.ru", SMTP_PASS: "p", MAIL_TO: "a@x.ru, b@x.ru ,," });
  assert.equal(c.enabled, true);
  assert.equal(c.host, "smtp.yandex.ru");
  assert.equal(c.port, 465);
  assert.equal(c.secure, true);
  assert.equal(c.from, "me@yandex.ru");
  assert.deepEqual(c.to, ["a@x.ru", "b@x.ru"]);
  assert.equal(c.publicUrl, "https://stan.tmpz-engineering.ru/");
  const d = mailConfigFromEnv({ SMTP_USER: "me@yandex.ru", SMTP_PASS: "p", MAIL_TO: "a@x.ru", MAIL_FROM: "stan@x.ru", SMTP_PORT: "", PUBLIC_URL: "https://p/" });
  assert.equal(d.from, "stan@x.ru");
  assert.equal(d.port, 465);
  assert.equal(d.publicUrl, "https://p/");
});

test("настройки: пустые SMTP_USER, SMTP_PASS или MAIL_TO выключают рассылку", () => {
  const full = { SMTP_USER: "u", SMTP_PASS: "p", MAIL_TO: "a@x.ru" };
  assert.equal(mailConfigFromEnv(full).enabled, true);
  for (const key of Object.keys(full)) assert.equal(mailConfigFromEnv({ ...full, [key]: "  " }).enabled, false, key);
  assert.equal(mailConfigFromEnv({}).enabled, false);
});

// ---- выбор смены

const msk = (day, hms) => T(day, hms);
const pick = (now) => { const s = lastFinishedShift(now, DEFAULT_SCHEDULE, 5 * MIN); return `${s.day}|${s.shiftNo}`; };

test("последняя закончившаяся смена: границы 08:05 и 20:05", () => {
  assert.equal(pick(msk("2026-10-02", "08:04:59")), "2026-10-01|1");
  assert.equal(pick(msk("2026-10-02", "08:05:00")), "2026-10-01|2");
  assert.equal(pick(msk("2026-10-02", "12:00:00")), "2026-10-01|2");
  assert.equal(pick(msk("2026-10-02", "20:04:59")), "2026-10-01|2");
  assert.equal(pick(msk("2026-10-02", "20:05:00")), "2026-10-02|1");
  assert.equal(pick(msk("2026-10-02", "23:59:00")), "2026-10-02|1");
  assert.equal(pick(msk("2026-10-03", "02:00:00")), "2026-10-02|1");
  // без задержки смена считается закончившейся ровно в 08:00
  assert.equal(lastFinishedShift(msk("2026-10-02", "08:00:00"), DEFAULT_SCHEDULE, 0).shiftNo, 2);
  assert.equal(lastFinishedShift(msk("2026-10-02", "07:59:59"), DEFAULT_SCHEDULE, 0).shiftNo, 1);
});

test("следующая отправка: 08:05 и 20:05 по Москве", () => {
  assert.equal(nextDueMs(msk("2026-10-02", "03:00:00"), DEFAULT_SCHEDULE), msk("2026-10-02", "08:05:00"));
  assert.equal(nextDueMs(msk("2026-10-02", "08:05:00"), DEFAULT_SCHEDULE), msk("2026-10-02", "20:05:00"));
  assert.equal(nextDueMs(msk("2026-10-02", "08:02:00"), DEFAULT_SCHEDULE), msk("2026-10-02", "08:05:00"));
  assert.equal(nextDueMs(msk("2026-10-02", "21:00:00"), DEFAULT_SCHEDULE), msk("2026-10-03", "08:05:00"));
});

test("выбор смены не зависит от часового пояса процесса", () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Europe/Moscow"]) {
      process.env.TZ = tz;
      assert.equal(pick(msk("2026-10-02", "08:04:59")), "2026-10-01|1", tz);
      assert.equal(pick(msk("2026-10-02", "08:05:00")), "2026-10-01|2", tz);
      assert.equal(pick(msk("2026-10-02", "20:05:00")), "2026-10-02|1", tz);
      assert.equal(nextDueMs(msk("2026-10-02", "09:00:00"), DEFAULT_SCHEDULE), msk("2026-10-02", "20:05:00"), tz);
      const digest = buildDigest({ events: fx.events, refs, nowMs: fx.now, shift: shiftOf(msk("2026-10-01", "10:00:00"), DEFAULT_SCHEDULE) });
      assert.match(digest.text, /08:00–20:00 \(МСК\)/, tz);
      assert.match(digest.text, /09:00–09:45/, tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

// ---- содержимое письма

const fx = dayFixture(); // сутки 01.10.2026, «сейчас» 22:30
const shift1 = shiftOf(T(fx.day, "10:00:00"), DEFAULT_SCHEDULE);
const shift2 = shiftOf(T(fx.day, "21:00:00"), DEFAULT_SCHEDULE);

test("письмо: цифры совпадают с computeStats, есть причины, действия, мастер, ссылка", () => {
  const d = buildDigest({ events: fx.events, refs, nowMs: fx.now, shift: shift1, publicUrl: "https://stan.example.test/" });
  const s = computeStats(fx.events, { fromMs: shift1.startMs, toMs: shift1.endMs, nowMs: fx.now, refs });
  assert.deepEqual(d.stats, s);
  assert.ok(s.downMin > 90 && s.downMin < 100, "около 95 минут: 45:20 + 30:30 + 19:40");
  assert.equal(d.subject, `Стан: дневная смена 01.10.2026 — простой ${hoursMinutes(s.downMin)}`);
  assert.match(d.subject, /^Стан: дневная смена 01\.10\.2026 — простой 1 ч (35|36) мин$/);
  for (const body of [d.text, d.html]) {
    assert.ok(body.includes(durationWords(s.workMin)), "работа");
    assert.ok(body.includes(durationWords(s.downMin)), "простой");
    assert.ok(body.includes(durationWords(s.plannedMin)), "плановые");
    assert.ok(body.includes(durationWords(s.unplannedMin)), "внеплановые");
    assert.ok(body.includes(String(s.stops)), "остановки");
    for (const r of s.byReason.slice(0, 5)) assert.ok(body.includes(durationWords(r.minutes)), r.title);
    assert.ok(body.includes("убрали раскат"), "что сделали");
    assert.ok(body.includes("застряла заготовка"), "что случилось");
    assert.ok(body.includes("Иванов Иван Иванович"), "мастер");
    assert.ok(body.includes("https://stan.example.test/"), "ссылка");
  }
  assert.equal(s.byCrew.length > 0, true);
  assert.match(d.html, /<table/);
  assert.match(d.html, /style="/);
  assert.equal(d.stops.length, 3, "перевалка, бурёжка, авария до 20:00");
  assert.ok(!d.text.includes("Петров"), "мастер другой смены в письмо не попадает");
});

test("письмо: ночная смена с идущим простоем, текст экранируется в HTML", () => {
  const E = eventMaker();
  const events = [...fx.events, E("fix", fx.day, "22:10:00", { downtimeId: "D4", index: 0, note: "<b>привод</b> & \"муфта\"", action: "ждём <запчасть>" })];
  const d = buildDigest({ events, refs, nowMs: fx.now, shift: shift2 });
  const s = computeStats(events, { fromMs: shift2.startMs, toMs: shift2.endMs, nowMs: fx.now, refs });
  assert.equal(d.subject, `Стан: ночная смена 01.10.2026 — простой ${Math.floor(s.downMin / 60)} ч ${s.downMin % 60} мин`);
  assert.ok(d.text.includes("<b>привод</b>"), "в тексте как есть");
  assert.ok(!d.html.includes("<b>привод</b>"), "в HTML экранировано");
  assert.ok(d.html.includes("&lt;b&gt;привод&lt;/b&gt; &amp; &quot;муфта&quot;"));
  assert.ok(d.html.includes("ждём &lt;запчасть&gt;"));
  assert.match(d.text, /Мастер: Петров Пётр Петрович/);
  assert.match(d.text, /ещё идёт/);
  assert.ok(d.text.includes("https://stan.tmpz-engineering.ru/"), "ссылка по умолчанию");
});

test("письмо: вложение — настоящий Excel-отчёт за сутки смены", () => {
  const d = buildDigest({ events: fx.events, refs, nowMs: fx.now, shift: shift1 });
  assert.match(d.attachment.filename, /^Отчёт по простоям стана за 01\.10\.2026, скачан 01\.10\.2026 в 22-30\.xlsx$/);
  const wb = readXlsx(new Uint8Array(d.attachment.content));
  assert.deepEqual(wb.sheets.map((x) => x.name), ["Сводка", "По сменам", "Журнал простоев", "Приём и сдача смен"]);
});

test("письмо: смена без простоев", () => {
  const E = eventMaker();
  const events = [E("shift_open", "2026-10-01", "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" })];
  const d = buildDigest({ events, refs, nowMs: T("2026-10-01", "22:30:00"), shift: shift1 });
  assert.equal(d.subject, "Стан: дневная смена 01.10.2026 — простой 0 ч 0 мин");
  assert.match(d.text, /Остановок: 0/);
  assert.match(d.text, /простоев не было/);
});

// ---- служба: защита от повтора, повторы при ошибке, выключенная рассылка

function mockMailer({ failTimes = 0 } = {}) {
  const sent = [];
  let failures = failTimes;
  return {
    sent,
    mailer: {
      async send(message) {
        if (failures > 0) { failures--; throw new Error("535 5.7.8 Authentication failed"); }
        sent.push(message);
        return { messageId: `<m${sent.length}@test>`, accepted: CONFIG.to, rejected: [] };
      },
    },
  };
}

function fakeTimers() {
  const list = [];
  return {
    list,
    timers: {
      setTimeout(fn, ms) { const t = { fn, ms, cleared: false, unref() {} }; list.push(t); return t; },
      clearTimeout(t) { if (t) t.cleared = true; },
    },
    active: () => list.filter((t) => !t.cleared),
  };
}

function service({ now, dataDir, mailer, config = CONFIG, timers, retryMs }) {
  const clockRef = { now };
  const svc = createMailService({
    mailer, config, readEvents: () => fx.events, readRefs: () => ({ refs }), clock: () => new Date(clockRef.now),
    dataDir, log: quiet, ...(timers ? { timers } : {}), ...(retryMs ? { retryMs } : {}),
  });
  return { svc, clockRef };
}

test("служба: письмо уходит один раз, после перезапуска не повторяется", async () => {
  const dir = tmp();
  const now = T("2026-10-02", "08:06:00"); // с конца ночной смены 6 минут
  const m = mockMailer();
  const { svc } = service({ now, dataDir: dir, mailer: m.mailer });
  const first = await svc.tick();
  assert.equal(first.status, "sent");
  assert.equal(first.shift.shiftNo, 2);
  assert.equal(m.sent.length, 1);
  assert.deepEqual(m.sent[0].attachments.map((a) => a.filename).length, 1);
  assert.match(m.sent[0].subject, /^Стан: ночная смена 01\.10\.2026 — простой /);
  assert.equal((await svc.tick()).status, "already_sent");
  // перезапуск сервера: новая служба читает отметку из файла
  const again = service({ now: now + 30 * MIN, dataDir: dir, mailer: m.mailer });
  assert.equal((await again.svc.tick()).status, "already_sent");
  assert.equal(m.sent.length, 1);
  const mark = JSON.parse(fs.readFileSync(path.join(dir, "mail-state.json"), "utf8"));
  assert.equal(mark.lastSentEndMs, shiftOf(T("2026-10-01", "21:00:00"), DEFAULT_SCHEDULE).endMs);
  // следующая смена — отправляется
  again.clockRef.now = T("2026-10-02", "20:05:00");
  assert.equal((await again.svc.tick()).status, "sent");
  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1].subject, /дневная смена 02\.10\.2026/);
});

test("служба: при запуске шлёт, если с конца смены меньше 2 часов, и не шлёт, если больше", async () => {
  const end = shiftOf(T("2026-10-01", "21:00:00"), DEFAULT_SCHEDULE).endMs; // 02.10 08:00
  const late = mockMailer();
  const s1 = service({ now: end + MAX_LATE_MS, dataDir: tmp(), mailer: late.mailer });
  assert.equal((await s1.svc.tick()).status, "too_late");
  assert.equal(late.sent.length, 0);
  const ok = mockMailer();
  const s2 = service({ now: end + MAX_LATE_MS - MIN, dataDir: tmp(), mailer: ok.mailer });
  assert.equal((await s2.svc.tick()).status, "sent");
  assert.equal(ok.sent.length, 1);
});

test("служба: ошибка отправки не роняет, повтор через 10 минут, не более 3 попыток", async () => {
  const t = fakeTimers();
  const m = mockMailer({ failTimes: 99 });
  const { svc } = service({ now: T("2026-10-02", "08:05:00"), dataDir: tmp(), mailer: m.mailer, timers: t.timers });
  const retries = () => t.list.filter((x) => x.ms === RETRY_MS);
  assert.equal((await svc.tick()).status, "failed");
  assert.equal(retries().length, 1, "после 1-й неудачи планируется повтор через 10 минут");
  assert.equal((await svc.tick()).status, "failed");
  assert.equal(retries().length, 2, "после 2-й — ещё один");
  assert.equal((await svc.tick()).status, "failed");
  assert.equal(retries().length, 2, "после 3-й повторов больше нет");
  assert.equal((await svc.tick()).status, "gave_up");
  assert.equal(m.sent.length, 0);
});

test("служба: после неудачи повтор доставляет письмо и ставит отметку", async () => {
  const t = fakeTimers();
  const m = mockMailer({ failTimes: 1 });
  const dir = tmp();
  const { svc, clockRef } = service({ now: T("2026-10-02", "08:05:00"), dataDir: dir, mailer: m.mailer, timers: t.timers });
  assert.equal((await svc.tick()).status, "failed");
  assert.equal(fs.existsSync(path.join(dir, "mail-state.json")), false, "отметки нет, пока не доставлено");
  clockRef.now += RETRY_MS;
  assert.equal((await svc.tick()).status, "sent");
  assert.equal(m.sent.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "mail-state.json")), true);
});

test("служба: planned-таймер ставится на ближайшие 08:05 / 20:05", () => {
  const t = fakeTimers();
  const m = mockMailer();
  const logs = [];
  const now = T("2026-10-02", "09:00:00");
  const svc = createMailService({ mailer: m.mailer, config: CONFIG, readEvents: () => fx.events, readRefs: () => ({ refs }), clock: () => new Date(now), dataDir: tmp(), log: { log: (x) => logs.push(x), error() {} }, timers: t.timers });
  svc.start();
  assert.equal(t.active()[0].ms, msk("2026-10-02", "20:05:00") - now);
  svc.stop();
  assert.equal(t.active().length, 0);
});

test("служба: выключенная рассылка ничего не шлёт и пишет одну строку", async () => {
  const logs = [];
  const m = mockMailer();
  const t = fakeTimers();
  const svc = createMailService({ mailer: null, config: { enabled: false }, readEvents: () => fx.events, readRefs: () => ({ refs }), clock: () => new Date(T("2026-10-02", "08:06:00")), dataDir: tmp(), log: { log: (x) => logs.push(x), error: (x) => logs.push(x) }, timers: t.timers });
  svc.start();
  assert.deepEqual(logs, ["рассылка выключена"]);
  assert.equal(t.list.length, 0);
  assert.equal((await svc.tick()).status, "disabled");
  assert.equal((await svc.sendTest()).error, "mail_disabled");
  assert.equal(m.sent.length, 0);
});

test("отправитель: SMTP-параметры из настроек, письмо уходит всем адресатам", async () => {
  const calls = [];
  const mailer = createMailer(CONFIG, { transportFactory: async (options) => ({ sendMail: async (message) => { calls.push({ options, message }); return { messageId: "<x>", accepted: message.to, rejected: [] }; } }) });
  const info = await mailer.send({ subject: "s", html: "<p>h</p>", text: "t", attachments: [] });
  assert.equal(info.messageId, "<x>");
  assert.equal(calls[0].options.host, "smtp.example.test");
  assert.equal(calls[0].options.secure, true);
  assert.deepEqual(calls[0].options.auth, { user: "u@example.test", pass: "secret" });
  assert.deepEqual(calls[0].message.to, CONFIG.to);
  assert.equal(calls[0].message.from, "u@example.test");
  const rejecting = createMailer(CONFIG, { transportFactory: async () => ({ sendMail: async () => ({ accepted: [], rejected: CONFIG.to }) }) });
  await assert.rejects(() => rejecting.send({ subject: "s", html: "", text: "" }), /отклонил/);
});

// ---- маршрут POST /api/mail/test

async function startApp({ mailConfig, transport, now = T("2026-10-02", "09:00:00") }) {
  const app = createApp({
    dataDir: ":memory:", now: () => new Date(now), mailConfig, mailTransportFactory: transport,
    deviceKeys: [{ name: "owner", key: "owner-key" }, { name: "worker", key: "worker-key" }], adminDevices: ["owner"],
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const post = (base, key) => fetch(`${base}/api/mail/test`, { method: "POST", headers: key ? { "X-Device-Key": key } : {} });

test("POST /api/mail/test: без ключа 401, не владелец 403, рассылка выключена 409", async () => {
  const { app, base } = await startApp({ mailConfig: undefined });
  try {
    assert.equal((await post(base)).status, 401);
    assert.equal((await post(base, "worker-key")).status, 403);
    const res = await post(base, "owner-key");
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "mail_disabled");
  } finally { await app.close(); }
});

test("POST /api/mail/test: владелец отправляет письмо о последней закончившейся смене", async () => {
  const sent = [];
  const transport = async () => ({ sendMail: async (message) => { sent.push(message); return { messageId: "<t@test>", accepted: message.to, rejected: [] }; } });
  const { app, base } = await startApp({ mailConfig: CONFIG, transport });
  try {
    const res = await post(base, "owner-key");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.to, CONFIG.to);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /^Стан: ночная смена 01\.10\.2026 — простой 0 ч 0 мин$/);
    assert.equal(sent[0].attachments.length, 1);
    assert.equal(app.mail.state.read(), null, "ручная проверка не ставит отметку отправки");
  } finally { await app.close(); }
});

test("POST /api/mail/test: ошибка SMTP возвращается текстом, сервер жив", async () => {
  const transport = async () => ({ sendMail: async () => { throw new Error("535 5.7.8 Error: authentication failed"); } });
  const { app, base } = await startApp({ mailConfig: CONFIG, transport });
  try {
    const res = await post(base, "owner-key");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.message, /authentication failed/);
    assert.ok(!JSON.stringify(body).includes("secret"));
    assert.equal((await fetch(`${base}/api/health`, { headers: { "X-Device-Key": "owner-key" } })).status, 200);
  } finally { await app.close(); }
});

// ---- CLI --dry-run

test("mail-cli --dry-run: собирает .html, .txt и .xlsx по базе без отправки", () => {
  const dir = tmp();
  const data = path.join(dir, "data");
  const app = createApp({ dataDir: data, deviceKeys: [{ name: "k", key: "k" }] });
  const insert = app.db.prepare("INSERT INTO events (id, type, at_ms, received_ms, device, body, flag) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const e of fx.events) insert.run(e.id, e.type, Date.parse(e.at), Date.parse(e.at), "web", JSON.stringify(e), null);
  return app.close().then(() => {
    const out = path.join(dir, "out");
    const run = spawnSync(process.execPath, ["app/server/mail-cli.js", "--dry-run", "--out", out, "--now", "2026-10-01T22:30:00+03:00"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, STAN_DATA_DIR: data, SMTP_USER: "", SMTP_PASS: "", MAIL_TO: "" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Тема: Стан: дневная смена 01\.10\.2026 — простой \d+ ч \d+ мин/);
    const files = fs.readdirSync(out).sort();
    assert.ok(files.includes("digest.html") && files.includes("digest.txt"));
    const xlsx = files.find((f) => f.endsWith(".xlsx"));
    assert.ok(xlsx);
    assert.ok(readXlsx(new Uint8Array(fs.readFileSync(path.join(out, xlsx)))).sheets.length === 4);
    assert.match(fs.readFileSync(path.join(out, "digest.html"), "utf8"), /убрали раскат/);
    const bad = spawnSync(process.execPath, ["app/server/mail-cli.js", "--out", out], { cwd: ROOT, encoding: "utf8", env: { ...process.env, STAN_DATA_DIR: data } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--dry-run/);
  });
});
