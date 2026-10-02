import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../app/server/index.js";
import { createMailService } from "../../app/server/mail-service.js";
import { buildDigest } from "../../app/server/digest.js";
import { validateMailSettings } from "../../app/core/mail-settings.js";
import { dueSends, occurrences, periodFor, MAX_LATE_MS } from "../../app/core/mail-schedule.js";
import { computeStats } from "../../app/core/stats.js";
import { durationWords } from "../../app/core/report.js";
import { DEFAULT_SCHEDULE } from "../../app/core/core.js";
import { readXlsx } from "../helpers/xlsx-read.js";
import { redactSecrets, describeMailError } from "../../app/server/mail-errors.js";
import { shiftOf } from "../../app/core/core.js";
import { refs, dayFixture, T } from "../helpers/report-fixtures.js";

const MIN = 60_000;
const quiet = { log() {}, error() {} };
const S = DEFAULT_SCHEDULE;
const CONFIG = { enabled: true, host: "smtp.example.test", port: 465, secure: true, user: "u@example.test", pass: "secret", from: "u@example.test", to: [], publicUrl: "https://stan.example.test/" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stan-mail2-"));
const ALL = [1, 2, 3, 4, 5, 6, 7];
const fx = dayFixture();
const shift1 = shiftOf(T(fx.day, "10:00:00"), S);
const shift2 = shiftOf(T(fx.day, "21:00:00"), S);

const rec = (id, email, sends, extra = {}) => ({ id, name: `Имя ${id}`, email, enabled: true, sends, ...extra });
const snd = (time, what = "shift", days = ALL) => ({ time, what, days });

// ---- проверка настроек

const bad = (input, pattern) => assert.throws(() => validateMailSettings(input), (e) => e.code === "bad_request" && pattern.test(e.message), String(pattern));

test("проверка: нормальные настройки приводятся к чистому виду", () => {
  const out = validateMailSettings({ recipients: [{ id: "", name: "  Иванов   И. ", email: " Ivanov@Example.RU ", sends: [{ time: "08:05", what: "shift" }, { time: "08:10", what: "day", days: [5, 1, 1] }], лишнее: 1 }] });
  assert.equal(out.recipients.length, 1);
  const r = out.recipients[0];
  assert.match(r.id, /^m[0-9a-f]{8}$/);
  assert.equal(r.name, "Иванов И.");
  assert.equal(r.email, "ivanov@example.ru");
  assert.equal(r.enabled, true);
  assert.deepEqual(r.sends, [{ time: "08:05", what: "shift", days: ALL }, { time: "08:10", what: "day", days: [1, 5] }]);
  assert.equal("лишнее" in r, false);
  assert.deepEqual(validateMailSettings({ recipients: [] }), { recipients: [] });
});

test("проверка: ошибки по-русски", () => {
  bad(null, /Передайте объект/);
  bad({}, /Передайте объект/);
  bad({ recipients: [rec("a", "не-адрес", [])] }, /настоящий адрес/);
  bad({ recipients: [rec("a", "x@y", [])] }, /настоящий адрес/);
  bad({ recipients: [{ ...rec("a", "x@y.ru", []), name: " " }] }, /имя/);
  bad({ recipients: [rec("a", "x@y.ru", []), rec("b", "X@Y.ru", [])] }, /указан дважды/);
  bad({ recipients: [rec("a", "x@y.ru", []), rec("a", "z@y.ru", [])] }, /Идентификаторы/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("8:05")])] }, /ЧЧ:ММ/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("24:00")])] }, /ЧЧ:ММ/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("08:60")])] }, /ЧЧ:ММ/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("08:05", "month")])] }, /сводку смены, суток или недели/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("08:05", "shift", [0])])] }, /дни недели/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("08:05", "shift", [8])])] }, /дни недели/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("08:05", "shift", [])])] }, /хотя бы один день/);
  bad({ recipients: [rec("a", "x@y.ru", [snd("08:05"), snd("08:05", "shift", [1])])] }, /уже есть/);
  bad({ recipients: [rec("a", "x@y.ru", [], { enabled: "да" })] }, /Включён/);
});

test("проверка: не больше 30 получателей и 10 отправок", () => {
  const many = Array.from({ length: 31 }, (_, i) => rec(`r${i}`, `u${i}@y.ru`, []));
  bad({ recipients: many }, /не больше 30/);
  assert.equal(validateMailSettings({ recipients: many.slice(0, 30) }).recipients.length, 30);
  const sends = Array.from({ length: 11 }, (_, i) => snd(`0${i % 10}:${i < 10 ? "00" : "30"}`));
  bad({ recipients: [rec("a", "x@y.ru", sends)] }, /не больше 10/);
  assert.equal(validateMailSettings({ recipients: [rec("a", "x@y.ru", sends.slice(0, 10))] }).recipients[0].sends.length, 10);
});

// ---- периоды

test("период: смена, сутки, неделя на момент 08:10 пятницы 02.10.2026", () => {
  const at = T("2026-10-02", "08:10:00");
  const shift = periodFor("shift", at, S);
  assert.equal(shift.fromMs, T("2026-10-01", "20:00:00"));
  assert.equal(shift.toMs, T("2026-10-02", "08:00:00"));
  const day = periodFor("day", at, S);
  assert.deepEqual([day.fromDay, day.toDay], ["2026-10-01", "2026-10-01"]);
  assert.equal(day.fromMs, T("2026-10-01", "08:00:00"));
  assert.equal(day.toMs, T("2026-10-02", "08:00:00"));
  const week = periodFor("week", at, S);
  assert.deepEqual([week.fromDay, week.toDay], ["2026-09-25", "2026-10-01"]);
  assert.equal(week.toMs - week.fromMs, 7 * 86_400_000);
  // до 08:00 сутки ещё не закончились: берутся предыдущие
  const early = periodFor("day", T("2026-10-02", "07:30:00"), S);
  assert.equal(early.toDay, "2026-09-30");
});

// ---- какие отправки должны уйти сейчас

const due = (recipients, now) => dueSends(recipients, now, S).map((d) => `${d.recipient.id}|${d.send.time}|${d.send.what}`);

test("наступившие отправки: границы времени и допуск 2 часа", () => {
  const r = [rec("a", "a@y.ru", [snd("08:05")])];
  assert.deepEqual(due(r, T("2026-10-02", "08:04:59")), []);
  assert.deepEqual(due(r, T("2026-10-02", "08:05:00")), ["a|08:05|shift"]);
  assert.deepEqual(due(r, T("2026-10-02", "10:04:59")), ["a|08:05|shift"]);
  assert.deepEqual(due(r, T("2026-10-02", "10:05:00")), [], "ровно 2 часа — уже поздно");
  // сервер был выключен и включился в 09:30: догоняет
  assert.equal(dueSends(r, T("2026-10-02", "09:30:00"), S)[0].occMs, T("2026-10-02", "08:05:00"));
  // через полночь: 23:30 вчера, сейчас 01:00
  const late = [rec("a", "a@y.ru", [snd("23:30", "day")])];
  assert.equal(dueSends(late, T("2026-10-03", "01:00:00"), S)[0].occMs, T("2026-10-02", "23:30:00"));
  assert.equal(MAX_LATE_MS, 2 * 3_600_000);
});

test("наступившие отправки: дни недели и выключенный получатель", () => {
  // 02.10.2026 — пятница (5), 05.10 — понедельник (1)
  const friday = T("2026-10-02", "08:20:00");
  const monday = T("2026-10-05", "08:20:00");
  const onlyMon = [rec("a", "a@y.ru", [snd("08:15", "week", [1])])];
  assert.deepEqual(due(onlyMon, friday), []);
  assert.deepEqual(due(onlyMon, monday), ["a|08:15|week"]);
  const onlyFri = [rec("a", "a@y.ru", [snd("08:15", "day", [5])])];
  assert.deepEqual(due(onlyFri, friday), ["a|08:15|day"]);
  assert.deepEqual(due(onlyFri, monday), []);
  assert.deepEqual(due([rec("a", "a@y.ru", [snd("08:15")], { enabled: false })], friday), []);
  // день недели считается по московской дате: 00:30 субботы МСК = ещё пятница по UTC
  const night = [rec("a", "a@y.ru", [snd("00:30", "shift", [6])])];
  assert.deepEqual(due(night, T("2026-10-03", "00:40:00")), ["a|00:30|shift"]);
  assert.deepEqual(due(night, T("2026-10-02", "23:40:00")), []);
});

test("наступившие отправки не зависят от часового пояса процесса", () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "America/New_York", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      assert.deepEqual(due([rec("a", "a@y.ru", [snd("08:05"), snd("20:05")])], T("2026-10-02", "20:30:00")), ["a|20:05|shift"], tz);
      assert.equal(occurrences(snd("08:05", "shift", [5]), T("2026-10-02", "08:10:00"), S).length, 1, tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

// ---- письма за сутки и неделю

test("письмо за сутки: цифры computeStats за производственные сутки, вложение — отчёт за эти сутки", () => {
  const now = T("2026-10-02", "08:10:00");
  const period = periodFor("day", now, S);
  const d = buildDigest({ events: fx.events, refs, nowMs: now, period });
  const s = computeStats(fx.events, { fromMs: period.fromMs, toMs: period.toMs, nowMs: now, refs });
  assert.deepEqual(d.stats, s);
  assert.equal(d.subject, `Стан: сутки 01.10.2026 — простой ${Math.floor(s.downMin / 60)} ч ${s.downMin % 60} мин`);
  for (const body of [d.text, d.html]) {
    assert.ok(body.includes(durationWords(s.downMin)));
    assert.ok(body.includes("убрали раскат") && body.includes("заменили муфту"));
  }
  assert.match(d.text, /По сменам:/);
  assert.match(d.text, /01\.10 08:00 – 02\.10 08:00 \(МСК\)/);
  assert.match(d.attachment.filename, /за 01\.10\.2026,/);
  assert.equal(readXlsx(new Uint8Array(d.attachment.content)).sheets.length, 4);
});

test("письмо за неделю: период из 7 суток, имя файла с диапазоном", () => {
  const now = T("2026-10-02", "08:15:00");
  const period = periodFor("week", now, S);
  const d = buildDigest({ events: fx.events, refs, nowMs: now, period });
  const s = computeStats(fx.events, { fromMs: period.fromMs, toMs: period.toMs, nowMs: now, refs });
  assert.deepEqual(d.stats, s);
  assert.match(d.subject, /^Стан: неделя 25\.09\.2026–01\.10\.2026 — простой /);
  assert.match(d.attachment.filename, /за 25\.09\.2026–01\.10\.2026,/);
});

// ---- защита от дублей

function svcFor({ dataDir, mail, now, sent }) {
  const ref = { now, mail };
  const mailer = { async send(m) { sent.push(m); return { messageId: "<x>", accepted: m.to, rejected: [] }; } };
  const svc = createMailService({ mailer, config: CONFIG, readMail: () => ref.mail, readEvents: () => fx.events, readRefs: () => ({ refs }), clock: () => new Date(ref.now), dataDir, log: quiet });
  return { svc, ref };
}

test("рассылка: несколько получателей, свои отметки, после перезапуска дублей нет", async () => {
  const dir = tmp();
  const sent = [];
  const mail = { recipients: [rec("a", "a@y.ru", [snd("08:05"), snd("08:10", "day")]), rec("b", "b@y.ru", [snd("08:05")]), rec("c", "c@y.ru", [snd("08:05")], { enabled: false })] };
  // сервер уже видел эти отправки до их времени
  const one = svcFor({ dataDir: dir, mail, now: T("2026-10-02", "08:00:00"), sent });
  await one.svc.tick();
  one.ref.now = T("2026-10-02", "08:05:30");
  assert.equal((await one.svc.tick()).sent.length, 2);
  one.ref.now = T("2026-10-02", "08:11:00");
  assert.equal((await one.svc.tick()).sent.length, 1);
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), ["a@y.ru", "a@y.ru", "b@y.ru"]);
  assert.match(sent.find((m) => /сутки/.test(m.subject)).subject, /^Стан: сутки 01\.10\.2026/);
  // перезапуск
  const two = svcFor({ dataDir: dir, mail, now: T("2026-10-02", "08:30:00"), sent });
  assert.equal((await two.svc.tick()).sent.length, 0);
  assert.equal(sent.length, 3);
});

test("рассылка: правка расписания не рождает дублей и пропусков", async () => {
  const dir = tmp();
  const sent = [];
  const mail = { recipients: [rec("a", "a@y.ru", [snd("08:05")])] };
  const s = svcFor({ dataDir: dir, mail, now: T("2026-10-02", "08:00:00"), sent });
  await s.svc.tick();
  s.ref.now = T("2026-10-02", "08:06:00");
  assert.equal((await s.svc.tick()).sent.length, 1);
  // сменили только дни: то же письмо повторно не уходит
  s.ref.mail = { recipients: [rec("a", "a@y.ru", [snd("08:05", "shift", [4, 5])])] };
  s.ref.now = T("2026-10-02", "08:20:00");
  assert.equal((await s.svc.tick()).sent.length, 0);
  // сменили время на более раннее, чем «сейчас»: новая отправка до момента её появления не догоняется
  s.ref.mail = { recipients: [rec("a", "a@y.ru", [snd("08:10")])] };
  s.ref.now = T("2026-10-02", "08:25:00");
  assert.equal((await s.svc.tick()).sent.length, 0);
  // а будущее время срабатывает в свой срок
  s.ref.mail = { recipients: [rec("a", "a@y.ru", [snd("08:40")])] };
  assert.equal((await s.svc.tick()).sent.length, 0);
  s.ref.now = T("2026-10-02", "08:41:00");
  assert.equal((await s.svc.tick()).sent.length, 1);
  assert.equal(sent.length, 2);
  // добавленный получатель не получает прошедшие письма, но получает следующее
  s.ref.mail = { recipients: [rec("a", "a@y.ru", [snd("08:40")]), rec("n", "n@y.ru", [snd("08:05"), snd("20:05")])] };
  s.ref.now = T("2026-10-02", "09:00:00");
  assert.equal((await s.svc.tick()).sent.length, 0);
  s.ref.now = T("2026-10-02", "20:06:00");
  const evening = await s.svc.tick();
  assert.deepEqual(evening.sent.map((x) => x.email), ["n@y.ru"]);
});

test("рассылка: старые отметки чистятся через 30 дней", async () => {
  const dir = tmp();
  const sent = [];
  const mail = { recipients: [rec("a", "a@y.ru", [snd("08:05")])] };
  const s = svcFor({ dataDir: dir, mail, now: T("2026-10-02", "08:00:00"), sent });
  await s.svc.tick();
  s.ref.now = T("2026-10-02", "08:06:00");
  await s.svc.tick();
  assert.equal(Object.keys(s.svc.store.read().sent).length, 1);
  s.ref.now = T("2026-11-05", "12:00:00");
  await s.svc.tick();
  assert.deepEqual(s.svc.store.read().sent, {});
});

// ---- интерфейс сервера: права и хранение

async function startApp({ transport, config = CONFIG, dataDir = ":memory:" } = {}) {
  const app = createApp({
    dataDir, now: () => new Date(T("2026-10-02", "09:00:00")), mailConfig: config, mailTransportFactory: transport,
    deviceKeys: [{ name: "owner", key: "owner-key" }, { name: "worker", key: "worker-key" }], adminDevices: ["owner"],
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const call = (base, key, method, url, body) => fetch(`${base}${url}`, { method, headers: { ...(key ? { "X-Device-Key": key } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("API: не владелец получает 403 на чтение, запись и пробное письмо", async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await call(base, null, "GET", "/api/admin/mail")).status, 401);
    assert.equal((await call(base, "worker-key", "GET", "/api/admin/mail")).status, 403);
    assert.equal((await call(base, "worker-key", "PUT", "/api/admin/mail", { mail: { recipients: [] }, mailVersion: "x" })).status, 403);
    assert.equal((await call(base, "worker-key", "POST", "/api/mail/test", { email: "a@y.ru" })).status, 403);
    assert.deepEqual(app.mail.store.read().sent, {});
  } finally { await app.close(); }
});

test("API: владелец читает и сохраняет настройки, версия защищает от гонки, ошибки по-русски", async () => {
  const dir = tmp();
  const { app, base } = await startApp({ dataDir: dir });
  try {
    const first = await (await call(base, "owner-key", "GET", "/api/admin/mail")).json();
    assert.deepEqual(first.mail, { recipients: [] });
    assert.equal(first.smtpConfigured, true);
    const mail = { recipients: [rec("", "a@y.ru", [snd("08:05")])] };
    const bad = await call(base, "owner-key", "PUT", "/api/admin/mail", { mail: { recipients: [rec("", "oops", [])] }, mailVersion: first.mailVersion });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).message, /настоящий адрес/);
    const stale = await call(base, "owner-key", "PUT", "/api/admin/mail", { mail, mailVersion: "старая" });
    assert.equal(stale.status, 409);
    const ok = await call(base, "owner-key", "PUT", "/api/admin/mail", { mail, mailVersion: first.mailVersion });
    assert.equal(ok.status, 200);
    const saved = await ok.json();
    assert.equal(saved.mail.recipients[0].email, "a@y.ru");
    assert.match(saved.mail.recipients[0].id, /^m[0-9a-f]{8}$/);
    assert.notEqual(saved.mailVersion, first.mailVersion);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "mail-settings.json"), "utf8"));
    assert.equal(onDisk.recipients.length, 1);
    // обычные настройки администратора не затронуты
    assert.equal((await call(base, "owner-key", "GET", "/api/admin/settings")).status, 200);
  } finally { await app.close(); }
});

test("API: SMTP не настроен — админка читается, список правится, пробное письмо 409", async () => {
  const { app, base } = await startApp({ config: { enabled: false, to: ["env@y.ru"] } });
  try {
    const view = await (await call(base, "owner-key", "GET", "/api/admin/mail")).json();
    assert.equal(view.smtpConfigured, false);
    assert.equal(view.envFallback, 1, "пока список пуст, письма идут на MAIL_TO");
    const put = await call(base, "owner-key", "PUT", "/api/admin/mail", { mail: { recipients: [rec("", "a@y.ru", [])] }, mailVersion: view.mailVersion });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).envFallback, 0);
    assert.equal((await call(base, "owner-key", "POST", "/api/mail/test", { email: "a@y.ru" })).status, 409);
  } finally { await app.close(); }
});

test("API: пробное письмо уходит только на указанный адрес, нужного вида, без отметок", async () => {
  const sent = [];
  const transport = async () => ({ sendMail: async (m) => { sent.push(m); return { messageId: "<t>", accepted: m.to, rejected: [] }; } });
  const { app, base } = await startApp({ transport, config: { ...CONFIG, to: ["env@y.ru"] } });
  try {
    for (const what of ["shift", "day", "week"]) {
      const res = await call(base, "owner-key", "POST", "/api/mail/test", { email: " Test@Y.ru ", what });
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).to, ["test@y.ru"]);
    }
    assert.deepEqual(sent.map((m) => m.to), [["test@y.ru"], ["test@y.ru"], ["test@y.ru"]]);
    assert.match(sent[0].subject, /ночная смена/);
    assert.match(sent[1].subject, /^Стан: сутки 01\.10\.2026/);
    assert.match(sent[2].subject, /^Стан: неделя 25\.09\.2026–01\.10\.2026/);
    assert.equal((await call(base, "owner-key", "POST", "/api/mail/test", { email: "плохой" })).status, 400);
    assert.equal((await call(base, "owner-key", "POST", "/api/mail/test", { email: "a@y.ru", what: "год" })).status, 400);
    assert.deepEqual(app.mail.store.read().sent, {});
    // без тела — на MAIL_TO, как раньше
    await call(base, "owner-key", "POST", "/api/mail/test");
    assert.deepEqual(sent.at(-1).to, ["env@y.ru"]);
  } finally { await app.close(); }
});

test("API: ошибка SMTP при пробном письме приходит текстом", async () => {
  const transport = async () => ({ sendMail: async () => { throw new Error("535 5.7.8 authentication failed"); } });
  const { app, base } = await startApp({ transport });
  try {
    const res = await call(base, "owner-key", "POST", "/api/mail/test", { email: "a@y.ru" });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.message, /Код ответа SMTP: 535/);
    assert.ok(!body.message.includes("authentication failed"));
  } finally { await app.close(); }
});

// ---- страница: файлы раздела отдаются и закешированы

test("страница: общий модуль настроек рассылки есть в кеше service worker и отдаётся сервером; версия кеша поднята", async () => {
  const sw = fs.readFileSync(new URL("../../app/public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /"\.\/core\/mail-settings\.js"/);
  assert.match(sw, /const CACHE = "stan-v(6[5-9]|[7-9]\d)"/);
  const { app, base } = await startApp();
  try {
    const res = await fetch(`${base}/core/mail-settings.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /validateMailSettings/);
  } finally { await app.close(); }
});


// ---- проверка Codex от 02.10.2026: четыре дефекта

const textsOf = (bytes) => readXlsx(new Uint8Array(bytes)).sheets.flatMap((sheet) => sheet.values.flat()).filter((v) => typeof v === "string").join("\n");

test("дефект 1: отправка, сохранённая в 08:04:50, не теряется (момент фиксирует сохранение настроек)", async () => {
  const clock = { now: T("2026-10-02", "08:04:50") };
  const sent = [];
  const transport = async () => ({ sendMail: async (m) => { sent.push(m); return { messageId: "<x>", accepted: m.to, rejected: [] }; } });
  const app = createApp({
    dataDir: ":memory:", now: () => new Date(clock.now), mailConfig: CONFIG, mailTransportFactory: transport,
    deviceKeys: [{ name: "owner", key: "owner-key" }], adminDevices: ["owner"],
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const view = await (await call(base, "owner-key", "GET", "/api/admin/mail")).json();
    const put = await call(base, "owner-key", "PUT", "/api/admin/mail", { mail: { recipients: [rec("", "a@y.ru", [snd("08:05")])] }, mailVersion: view.mailVersion });
    assert.equal(put.status, 200);
    clock.now = T("2026-10-02", "08:05:01"); // первый проход планировщика уже после срока
    assert.equal((await app.mail.tick()).sent.length, 1);
    // а то, что сохранено уже после срока, прошлое письмо не получает
    clock.now = T("2026-10-02", "08:20:00");
    const view2 = await (await call(base, "owner-key", "GET", "/api/admin/mail")).json();
    await call(base, "owner-key", "PUT", "/api/admin/mail", { mail: { recipients: [...view2.mail.recipients, rec("", "b@y.ru", [snd("08:05")])] }, mailVersion: view2.mailVersion });
    clock.now = T("2026-10-02", "08:25:00");
    assert.equal((await app.mail.tick()).sent.length, 0);
    assert.equal(sent.length, 1);
  } finally { await app.close(); }
});

test("дефект 2: получатель выключен в момент срока — письма за этот срок нет и после повторного включения", async () => {
  const ref = { now: T("2026-10-02", "08:00:00"), enabled: true };
  const sent = [];
  const mailer = { async send(m) { sent.push(m); return { messageId: "<x>", accepted: m.to, rejected: [] }; } };
  const make = (dataDir) => createMailService({
    mailer, config: CONFIG, readMail: () => ({ recipients: [rec("r", "a@y.ru", [snd("08:05")], { enabled: ref.enabled })] }),
    readEvents: () => fx.events, readRefs: () => ({ refs }), clock: () => new Date(ref.now), dataDir, log: quiet,
  });
  const svc = make(tmp());
  await svc.tick();
  ref.enabled = false; ref.now = T("2026-10-02", "08:05:01");
  await svc.tick();
  ref.enabled = true; ref.now = T("2026-10-02", "08:30:00");
  await svc.tick();
  assert.equal(sent.length, 0, "письмо за 08:05 не приходит после включения в 08:30");
  // включение действует как новая отправка: следующее письмо — завтра
  ref.now = T("2026-10-03", "08:06:00");
  assert.equal((await svc.tick()).sent.length, 1);
});

test("дефект 2: то же через API — выключили до срока, включили после", async () => {
  const clock = { now: T("2026-10-02", "08:00:00") };
  const sent = [];
  const transport = async () => ({ sendMail: async (m) => { sent.push(m); return { messageId: "<x>", accepted: m.to, rejected: [] }; } });
  const app = createApp({
    dataDir: ":memory:", now: () => new Date(clock.now), mailConfig: CONFIG, mailTransportFactory: transport,
    deviceKeys: [{ name: "owner", key: "owner-key" }], adminDevices: ["owner"],
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const save = async (enabled) => {
    const v = await (await call(base, "owner-key", "GET", "/api/admin/mail")).json();
    const recipients = v.mail.recipients.length ? v.mail.recipients.map((r) => ({ ...r, enabled })) : [rec("", "a@y.ru", [snd("08:05")], { enabled })];
    assert.equal((await call(base, "owner-key", "PUT", "/api/admin/mail", { mail: { recipients }, mailVersion: v.mailVersion })).status, 200);
  };
  try {
    await save(true);
    clock.now = T("2026-10-02", "08:04:00");
    await save(false); // выключен на момент срока, между проходами планировщика
    clock.now = T("2026-10-02", "08:30:00");
    await save(true);
    assert.equal((await app.mail.tick()).sent.length, 0);
    assert.equal(sent.length, 0);
  } finally { await app.close(); }
});

test("дефект 3: вложение к письму о смене содержит только эту смену", () => {
  const night = buildDigest({ events: fx.events, refs, nowMs: fx.now, shift: shift1 });
  const attachment = textsOf(night.attachment.content);
  assert.ok(!attachment.includes("Петров"), "мастера ночной смены в вложении нет");
  assert.ok(attachment.includes("Иванов Иван Иванович"));
  assert.ok(attachment.includes("только эта смена"));
  const wb = readXlsx(new Uint8Array(night.attachment.content));
  const journal = wb.sheets.find((x) => x.name === "Журнал простоев");
  const rows = journal.values.slice(3).filter((r) => r[0] !== null);
  assert.ok(rows.length > 0 && rows.every((r) => r[2] === "Смена 1"), "в журнале только Смена 1");
  assert.equal(wb.sheets.find((x) => x.name === "По сменам").values.flat().filter((v) => v === "Смена 2").length, 0);
  // письмо о ночной смене — наоборот
  const other = textsOf(buildDigest({ events: fx.events, refs, nowMs: fx.now, shift: shift2 }).attachment.content);
  assert.ok(other.includes("Петров") && !other.includes("Иванов Иван Иванович"));
  // сутки целиком — по-прежнему обе смены
  const day = textsOf(buildDigest({ events: fx.events, refs, nowMs: T("2026-10-02", "08:10:00"), period: periodFor("day", T("2026-10-02", "08:10:00"), S) }).attachment.content);
  assert.ok(day.includes("Петров") && day.includes("Иванов Иван Иванович"));
});

test("дефект 3: /api/report.xlsx за сутки не затронут ограничением по интервалу", async () => {
  const { app, base } = await startApp();
  try {
    const insert = app.db.prepare("INSERT INTO events (id, type, at_ms, received_ms, device, body, flag) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const e of fx.events) insert.run(e.id, e.type, Date.parse(e.at), Date.parse(e.at), "web", JSON.stringify(e), null);
    const res = await fetch(`${base}/api/report.xlsx?from=2026-10-01&to=2026-10-01`, { headers: { "X-Device-Key": "owner-key" } });
    assert.equal(res.status, 200);
    const text = textsOf(new Uint8Array(await res.arrayBuffer()));
    assert.ok(text.includes("Петров") && text.includes("Иванов Иван Иванович"));
    assert.ok(!text.includes("только эта смена"));
  } finally { await app.close(); }
});

test("дефект 4: пароль SMTP вырезается из любого текста, в том числе base64 AUTH", () => {
  const cfg = { user: "robot@yandex.ru", pass: "p@ss/w0rd!" };
  const b64 = (x) => Buffer.from(x).toString("base64");
  const text = [
    `plain ${cfg.pass}`, `url ${encodeURIComponent(cfg.pass)}`, `login ${b64(cfg.pass)}`,
    `plain-auth AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, `AUTH LOGIN ${b64(cfg.user)}`, `pair ${b64(`${cfg.user}:${cfg.pass}`)}`,
  ].join("\n");
  const out = redactSecrets(text, cfg);
  for (const leak of [cfg.pass, encodeURIComponent(cfg.pass), b64(cfg.pass), b64(`\0${cfg.user}\0${cfg.pass}`), b64(`${cfg.user}:${cfg.pass}`), b64(cfg.user)]) {
    assert.ok(!out.includes(leak), `утекло: ${leak}`);
  }
  assert.equal(describeMailError(Object.assign(new Error("Invalid login: 535 5.7.8 bad"), { responseCode: 535 }), cfg).code, 535);
  assert.equal(describeMailError(new Error("535 5.7.8 Authentication failed"), cfg).code, 535);
  assert.match(describeMailError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), cfg).message, /не принимает соединение/);
});

test("дефект 4: ни журнал планировщика, ни ответ API не содержат пароля и сырого текста ошибки", async () => {
  const pass = "S3cret-Pass-123";
  const cfg = { ...CONFIG, pass };
  const raw = `Invalid login: 535 5.7.8 Authentication failed for ${pass} AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${pass}`).toString("base64")}`;
  const logs = [];
  const ref = { now: T("2026-10-02", "08:00:00") };
  const svc = createMailService({
    mailer: { async send() { throw Object.assign(new Error(raw), { responseCode: 535 }); } }, config: cfg,
    readMail: () => ({ recipients: [rec("r", "a@y.ru", [snd("08:05")])] }), readEvents: () => fx.events, readRefs: () => ({ refs }),
    clock: () => new Date(ref.now), dataDir: tmp(), log: { log: (x) => logs.push(String(x)), error: (...a) => logs.push(a.join(" ")) },
  });
  await svc.tick();
  ref.now = T("2026-10-02", "08:05:01");
  const run = await svc.tick();
  const test = await svc.sendTest({ email: "a@y.ru" });
  for (const text of [...logs, JSON.stringify(run), JSON.stringify(test)]) {
    assert.ok(!text.includes(pass), text);
    assert.ok(!text.includes("AUTH PLAIN"), text);
    assert.ok(!text.includes("Invalid login"), text);
  }
  assert.match(logs.join("\n"), /Код ответа SMTP: 535/);
  assert.equal(test.smtpCode, 535);
  assert.match(test.message, /не принял логин или пароль/);
});
