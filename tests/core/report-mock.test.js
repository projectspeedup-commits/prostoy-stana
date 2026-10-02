// Демо (?mock=1, GitHub Pages) строит отчёт без сервера тем же ядром: проверяем, что файл тот же, что у сервера.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../../app/server/index.js";
import { readXlsx } from "../helpers/xlsx-read.js";
import { minutesOf, summaryCell } from "../helpers/report-fixtures.js";

const NOW = Date.parse("2026-10-01T20:00:00Z"); // 23:00 МСК, сутки 01.10.2026

async function loadMock() {
  // Браузерный ./core/ лежит в app/core; в тесте сохраняем тот же граф модулей (приём — как в admin.test.js)
  const coreUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../app/core/")).href + "/";
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../app/public/mock.js"), "utf8")
    .replaceAll('"./core/', '"' + coreUrl) + `\n// ${Math.random()}`;
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

const events = [
  { id: "so", type: "shift_open", at: "2026-10-01T17:05:00Z", crewId: "2", personId: "p4", personName: "Волков Евгений Николаевич" },
  { id: "s1", type: "stop", at: "2026-10-01T17:30:20Z", downtimeId: "d1", reason: "avaria", note: "привод" },
  { id: "e1", type: "start", at: "2026-10-01T18:12:40Z", downtimeId: "d1", action: "муфта" },
  { id: "f1", type: "fix", at: "2026-10-01T18:12:41Z", downtimeId: "d1", index: 0, billet: 1.5 },
  { id: "s2", type: "stop", at: "2026-10-01T19:00:00Z", downtimeId: "d2", reason: "perevalka" },
  { id: "e2", type: "start", at: "2026-10-01T19:20:00Z", downtimeId: "d2" },
  { id: "s3", type: "stop", at: "2026-10-01T19:40:00Z", downtimeId: "d3" },
];

test("демо: отчёт из имитации сервера — тот же файл, что отдаёт настоящий сервер", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { api } = await loadMock();
  const posted = await api("/api/events", { method: "POST", body: JSON.stringify({ events }) });
  assert.deepEqual(posted.rejected, []);

  const demo = await api("/api/report.xlsx?from=2026-10-01&to=2026-10-01");
  assert.equal(demo.ok, true);
  assert.ok(demo.bytes instanceof Uint8Array);
  assert.deepEqual([...demo.bytes.slice(0, 2)], [0x50, 0x4b]);
  assert.equal(demo.filename, "Отчёт по простоям стана за 01.10.2026, скачан 01.10.2026 в 23-00.xlsx");

  const app = createApp({ dataDir: ":memory:", deviceKeys: "a:k1", now: () => new Date(NOW) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const real = await (await fetch(`${base}/api/events`, { method: "POST", headers: { "X-Device-Key": "k1" }, body: JSON.stringify({ events }) })).json();
  assert.deepEqual(real.rejected, []);
  const file = new Uint8Array(await (await fetch(`${base}/api/report.xlsx?from=2026-10-01&to=2026-10-01`, { headers: { "X-Device-Key": "k1" } })).arrayBuffer());
  const a = readXlsx(demo.bytes);
  const b = readXlsx(file);
  assert.deepEqual(a.sheets.map((s) => s.name), b.sheets.map((s) => s.name));
  for (const [i, sheet] of a.sheets.entries()) assert.deepEqual(sheet.values, b.sheets[i].values, sheet.name);

  // И те же числа, что в «Показателях» демо
  const stats = (await api("/api/stats?period=day")).stats;
  assert.equal(minutesOf(summaryCell(a.sheets[0], "Простой")), stats.downMin);
  assert.equal(summaryCell(a.sheets[0], "Остановок, шт").value, stats.stops);
  assert.equal(summaryCell(a.sheets[0], "Брак заготовки всего, тн").value, 1.5);
});

test("демо: неверный период — ошибка как 400 сервера, с русским сообщением", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { api } = await loadMock();
  for (const [query, pattern] of [
    ["from=2026-10-02&to=2026-10-02", /ещё не наступила/],
    ["from=2026-10-01", /Укажите период/],
    ["from=2026-10-03&to=2026-10-01", /не может быть позже/],
    ["from=2026-01-01&to=2026-10-01", /длиннее 92 суток/],
  ]) {
    await assert.rejects(api(`/api/report.xlsx?${query}`), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.data.error, "bad_request");
      assert.match(error.data.message, pattern);
      return true;
    });
  }
});

test("демо: пустая имитация даёт корректный отчёт, офлайн-рубильник ломает его как остальные запросы", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { api } = await loadMock();
  const empty = await api("/api/report.xlsx?from=2026-10-01&to=2026-10-01");
  assert.equal(readXlsx(empty.bytes).sheets.length, 4);
  globalThis.sessionStorage = { getItem: (key) => (key === "stan.mockOffline" ? "1" : null) };
  t.after(() => { delete globalThis.sessionStorage; });
  await assert.rejects(api("/api/report.xlsx?from=2026-10-01&to=2026-10-01"), { message: "mock_offline" });
});
