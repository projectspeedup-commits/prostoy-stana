import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, periodRange } from "../../app/core/stats.js";
import { T, build, eventMaker, refs, summaryCell } from "../helpers/report-fixtures.js";

const d = "2026-11-20";

// Обычный простой 15:00–15:10 и нулевой с браком (stop, start, fix в один момент)
function scenario() {
  const E = eventMaker();
  const events = [
    E("stop", d, "09:00:00", { downtimeId: "n1", reason: "avaria" }),
    E("start", d, "09:10:00", { downtimeId: "n1" }),
    E("stop", d, "12:10:00", { downtimeId: "z1", reason: "cobble_shears" }),
    E("start", d, "12:10:00", { downtimeId: "z1" }),
    E("fix", d, "12:10:00", { downtimeId: "z1", index: 0, billet: 1.25 }),
  ];
  return { events, nowMs: T(d, "15:00:00") };
}

test("брак нулевого простоя есть в разбивке по причинам, сумма причин = общему браку", () => {
  const { events, nowMs } = scenario();
  const stats = computeStats(events, { ...periodRange("day", nowMs, refs.settings.schedule), nowMs, refs });
  assert.equal(stats.billetTn, 1.25);
  assert.equal(stats.stops, 1);
  const row = stats.byReason.find((r) => r.reason === "cobble_shears");
  assert.ok(row, "строка причины есть");
  assert.equal(row.minutes, 0);
  assert.equal(row.stops, 0);
  assert.equal(row.billetTn, 1.25);
  assert.equal(Math.round(stats.byReason.reduce((s, r) => s + r.billetTn, 0) * 1000) / 1000, stats.billetTn);
  assert.equal(stats.byReason.reduce((s, r) => s + r.minutes, 0), stats.downMin);
});

test("Excel: остановки одинаково на сводке, по сменам, по причинам; брак и время не теряются", () => {
  const { events, nowMs } = scenario();
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs });
  const stops = summaryCell(wb.sheets[0], "Остановок, шт").value;
  assert.equal(stops, 1);
  const total = wb.sheets[1].rows.find((r) => r && r[0]?.value === "Итого");
  assert.equal(total[8].value, stops);
  const shiftStops = wb.sheets[1].rows.slice(3).filter((r) => r && r[0]?.value !== "Итого" && r[8]).reduce((s, r) => s + (r[8].value || 0), 0);
  assert.equal(shiftStops, stops);
  assert.equal(total[10].value, 1.25);
  assert.equal(summaryCell(wb.sheets[0], "Брак заготовки всего, тн").value, 1.25);
  // по причинам: сумма остановок не больше итога
  const idx = wb.sheets[0].rows.findIndex((r) => r && r[0]?.value === "Простои по причинам");
  const reasonRows = wb.sheets[0].rows.slice(idx + 2).filter((r) => r && r[0]?.value && r[0].value !== "Итого" && typeof r[2]?.value === "number");
  assert.equal(reasonRows.reduce((s, r) => s + r[2].value, 0), stops);
});

test("Excel: старые данные (период давно прошёл) — те же числа остановок", () => {
  const { events } = scenario();
  const nowMs = T("2027-01-20", "15:00:00");
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs });
  const stops = summaryCell(wb.sheets[0], "Остановок, шт").value;
  const total = wb.sheets[1].rows.find((r) => r && r[0]?.value === "Итого");
  assert.equal(total[8].value, stops);
  assert.equal(stops, 1);
});

test("нулевая часть многоразделённого простоя не считается лишней остановкой в смене", () => {
  const E = eventMaker();
  const events = [
    E("stop", d, "14:50:00", { downtimeId: "s1", reason: "burezhka" }),
    E("fix", d, "14:55:00", { downtimeId: "s1", index: 0, billet: 3 }),
    E("split", d, "14:55:00", { downtimeId: "s1", reason: "avaria" }),
    E("fix", d, "14:55:00", { downtimeId: "s1", index: 1, billet: 7 }),
    E("start", d, "14:55:00", { downtimeId: "s1" }),
  ];
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: T(d, "15:00:00") });
  const total = wb.sheets[1].rows.find((r) => r && r[0]?.value === "Итого");
  assert.equal(total[8].value, summaryCell(wb.sheets[0], "Остановок, шт").value);
  assert.equal(total[10].value, 10);
});
