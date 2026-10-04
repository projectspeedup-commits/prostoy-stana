import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../../app/server/index.js";
import { contentDisposition } from "../../app/server/report.js";
import { XLSX_MIME, reportFileName } from "../../app/core/report-period.js";
import { readXlsx } from "../helpers/xlsx-read.js";
import { minutesOf, summaryCell } from "../helpers/report-fixtures.js";

const KEY = "report-key";
const HEAD = { "X-Device-Key": KEY, "Content-Type": "application/json" };
const NOW = new Date("2026-01-01T12:00:30.000Z"); // 15:00:30 МСК, сутки 01.01.2026

async function start(now = () => NOW) {
  const app = createApp({ dataDir: ":memory:", deviceKeys: [{ name: "rep", key: KEY }], now });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const postEvents = (base, events) => fetch(`${base}/api/events`, { method: "POST", headers: HEAD, body: JSON.stringify({ events }) }).then((r) => r.json());
const report = (base, query, headers = HEAD) => fetch(`${base}/api/report.xlsx${query}`, { headers });

test("отчёт: без ключа и с чужим ключом — 401", async () => {
  const { app, base } = await start();
  try {
    assert.equal((await report(base, "?from=2026-01-01&to=2026-01-01", {})).status, 401);
    assert.equal((await report(base, "?from=2026-01-01&to=2026-01-01", { "X-Device-Key": "wrong-key" })).status, 401);
  } finally { await app.close(); }
});

test("отчёт: неверный период — 400 с русским сообщением и без файла", async () => {
  const { app, base } = await start();
  try {
    const cases = [
      ["", /Укажите период/],
      ["?from=2026-01-01", /Укажите период/],
      ["?from=2026-01-01&to=", /Укажите период/],
      ["?from=сегодня&to=2026-01-01", /Дата «С» указана неверно/],
      ["?from=2026-01-01&to=2026-02-30", /Дата «По» указана неверно/],
      ["?from=2026-01-01&to=2025-12-31", /«С» не может быть позже даты «По»/],
      ["?from=2026-01-01&to=2026-01-02", /Дата «По» \(02\.01\.2026\) ещё не наступила\. Последняя доступная дата — 01\.01\.2026/],
      ["?from=2025-09-01&to=2026-01-01", /не может быть длиннее 92 суток: выбрано 123/],
    ];
    for (const [query, pattern] of cases) {
      const response = await report(base, query);
      assert.equal(response.status, 400, query);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "bad_request");
      assert.match(body.message, pattern, query);
      assert.match(body.message, /[а-яё]/i);
    }
    // Ровно 92 суток — можно
    assert.equal((await report(base, "?from=2025-10-02&to=2026-01-01")).status, 200);
  } finally { await app.close(); }
});

test("отчёт: заголовки, имя файла в Content-Disposition, настоящий xlsx", async () => {
  const { app, base } = await start();
  try {
    const response = await report(base, "?from=2026-01-01&to=2026-01-01");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), XLSX_MIME);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const disposition = response.headers.get("content-disposition");
    assert.match(disposition, /^attachment; filename="report\.xlsx"; filename\*=UTF-8''/);
    const name = decodeURIComponent(disposition.split("filename*=UTF-8''")[1]);
    assert.equal(name, "Отчёт по простоям стана за 01.01.2026, скачан 01.01.2026 в 15-00.xlsx");
    assert.equal(name, reportFileName({ fromDay: "2026-01-01", toDay: "2026-01-01", nowMs: NOW.getTime() }));
    assert.doesNotMatch(disposition.split("filename*=UTF-8''")[1], /[^A-Za-z0-9%._-]/, "в filename* только безопасные знаки");
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(Number(response.headers.get("content-length")), body.length);
    const wb = readXlsx(body);
    assert.deepEqual(wb.sheets.map((s) => s.name), ["Сводка", "По сменам", "Журнал простоев", "Приём и сдача смен"]);
  } finally { await app.close(); }
});

test("отчёт: Content-Disposition кодирует апострофы и скобки по RFC 5987", () => {
  const header = contentDisposition("a'b(c)*d привет.xlsx");
  assert.match(header, /filename\*=UTF-8''a%27b%28c%29%2Ad%20%D0%BF/);
});

test("отчёт: сводка совпадает с «Показателями» (GET /api/stats?period=day) за те же сутки", async () => {
  const { app, base } = await start();
  try {
    const open = new Date("2026-01-01T05:20:00Z").toISOString();
    const saved = await postEvents(base, [
      { id: "so", type: "shift_open", at: open, crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" },
      { id: "s1", type: "stop", at: "2026-01-01T07:00:07Z", downtimeId: "d1", reason: "avaria", note: "привод" },
      { id: "e1", type: "start", at: "2026-01-01T07:41:40Z", downtimeId: "d1", action: "починили" },
      { id: "f1", type: "fix", at: "2026-01-01T07:41:41Z", downtimeId: "d1", index: 0, billet: 3 },
      { id: "s2", type: "stop", at: "2026-01-01T09:00:10Z", downtimeId: "d2", reason: "perevalka" },
      { id: "e2", type: "start", at: "2026-01-01T09:20:55Z", downtimeId: "d2" },
      { id: "s3", type: "stop", at: "2026-01-01T11:30:00Z", downtimeId: "d3" },
    ]);
    assert.deepEqual(saved.rejected, []);
    const stats = (await (await fetch(`${base}/api/stats?period=day`, { headers: HEAD })).json()).stats;
    const wb = readXlsx(new Uint8Array(await (await report(base, "?from=2026-01-01&to=2026-01-01")).arrayBuffer()));
    const sheet = wb.sheets[0];
    const zone = (z) => stats.byZone.find((r) => r.zone === z);
    assert.equal(minutesOf(summaryCell(sheet, "Учтённое время")), stats.totalMin);
    assert.equal(minutesOf(summaryCell(sheet, "Работа")), stats.workMin);
    assert.equal(minutesOf(summaryCell(sheet, "Простой")), stats.downMin);
    assert.equal(minutesOf(summaryCell(sheet, "Плановый простой")), zone("plan").minutes);
    assert.equal(minutesOf(summaryCell(sheet, "Внеплановый простой")), zone("unplanned").minutes);
    assert.equal(minutesOf(summaryCell(sheet, "Аварийный простой")), zone("failure").minutes);
    assert.equal(summaryCell(sheet, "Остановок, шт").value, stats.stops);
    assert.equal(stats.stops, 3);
    assert.equal(summaryCell(sheet, "Доступность").value, stats.availability);
    assert.equal(summaryCell(sheet, "Доля работы").value, zone("work").share);
    assert.equal(minutesOf(summaryCell(sheet, "Работа между отказами")), stats.mtbfMin);
    assert.equal(minutesOf(summaryCell(sheet, "Время на ремонт")), stats.mttrMin);
    assert.equal(minutesOf(summaryCell(sheet, "Средний простой")), stats.avgStopMin);
    assert.equal(summaryCell(sheet, "Брак заготовки всего, тн").value, 3);
    // Идущий простой считается до момента запроса (15:00:30 МСК), а не до конца суток
    const journal = wb.sheets[2].rows.slice(3).filter((r) => r && typeof r[0]?.value === "number");
    assert.equal(journal.length, 3);
    assert.equal(journal.at(-1)[12].value, "ещё идёт; причина не указана");
    assert.equal(minutesOf(journal.at(-1)[6]), 30, "с 14:30:00 до 15:00:30 — 30 мин 30 с; остаток округления ушёл частям с большим остатком");
    assert.equal(journal.reduce((sum, r) => sum + minutesOf(r[6]), 0), stats.downMin, "сумма журнала = «Простой» из /api/stats");
  } finally { await app.close(); }
});

test("отчёт: часы сервера — «сейчас»; одни и те же события в другой день дают другой период", async () => {
  let now = NOW;
  const { app, base } = await start(() => now);
  try {
    await postEvents(base, [{ id: "a", type: "stop", at: "2026-01-01T07:00:00Z", downtimeId: "x", reason: "burezhka" }]);
    now = new Date("2026-01-02T06:00:00Z"); // 09:00 МСК 02.01: идут новые сутки
    const wb = readXlsx(new Uint8Array(await (await report(base, "?from=2026-01-01&to=2026-01-02")).arrayBuffer()));
    const rows = wb.sheets[2].rows.slice(3).filter((r) => r && typeof r[0]?.value === "number");
    assert.deepEqual(rows.map((r) => r[12].value), [
      "перешёл в следующую смену", "продолжение с прошлой смены; перешёл в следующую смену", "продолжение с прошлой смены; ещё идёт",
    ]);
    assert.deepEqual(rows.map((r) => minutesOf(r[6])), [600, 720, 60]);
    // С 10:00 01.01 до 09:00 02.01 по часам сервера — 23 часа, и ни минуты после «сейчас»
    assert.equal(minutesOf(summaryCell(wb.sheets[0], "Простой")), 1380);
    assert.equal(minutesOf(summaryCell(wb.sheets[0], "Учтённое время")), 1380);
  } finally { await app.close(); }
});

test("отчёт: ночью период 01.10–02.10 допустим (сегодня уже 02.10), а третье число — нет", async () => {
  const now = new Date("2026-10-01T23:05:00Z"); // 02:05 МСК 02.10.2026: текущие производственные сутки ещё 01.10
  const { app, base } = await start(() => now);
  try {
    await postEvents(base, [
      { id: "a", type: "shift_open", at: "2026-10-01T18:00:00Z", crewId: "2", personId: "p4", personName: "Волков Евгений Николаевич" },
      { id: "b", type: "stop", at: "2026-10-01T20:00:00Z", downtimeId: "n1", reason: "burezhka" },
      { id: "c", type: "start", at: "2026-10-01T20:30:00Z", downtimeId: "n1" },
    ]);
    const both = await report(base, "?from=2026-10-01&to=2026-10-02");
    assert.equal(both.status, 200);
    const name = decodeURIComponent(both.headers.get("content-disposition").split("filename*=UTF-8''")[1]);
    assert.equal(name, "Отчёт по простоям стана за 01.10.2026–02.10.2026, скачан 02.10.2026 в 02-05.xlsx");
    const wb = readXlsx(new Uint8Array(await both.arrayBuffer()));
    assert.match(wb.sheets[0].rows[1][0].value, /^Период: с 01\.10\.2026 08:00 по 03\.10\.2026 08:00 МСК.*Период включает текущий момент/);
    const single = readXlsx(new Uint8Array(await (await report(base, "?from=2026-10-01&to=2026-10-01")).arrayBuffer()));
    assert.deepEqual(wb.sheets[0].values.slice(2), single.sheets[0].values.slice(2), "числа те же: время после «сейчас» не считается");
    const third = await report(base, "?from=2026-10-01&to=2026-10-03");
    assert.equal(third.status, 400);
    assert.match((await third.json()).message, /Последняя доступная дата — 02\.10\.2026/);
  } finally { await app.close(); }
});

test("отчёт: только GET; другие методы — 404 как у неизвестного пути", async () => {
  const { app, base } = await start();
  try {
    const response = await fetch(`${base}/api/report.xlsx?from=2026-01-01&to=2026-01-01`, { method: "POST", headers: HEAD, body: "{}" });
    assert.equal(response.status, 404);
  } finally { await app.close(); }
});
