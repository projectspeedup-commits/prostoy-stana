import { test } from "node:test";
import assert from "node:assert/strict";
import { dayCells, zoneOf, zoneTotals } from "../../app/core/zones.js";
import { DEFAULT_REFS as refs } from "../../app/core/refs.js";

const M = 60_000;
const fromMs = Date.parse("2026-01-01T05:00:00Z"); // 08:00 МСК
const at = (minutes) => fromMs + minutes * M;
const options = (now, data = 0) => ({
  fromMs, toMs: at(1440), nowMs: at(now), dataFromMs: data === null ? null : at(data), refs,
});
const segment = (from, to, reason = "burezhka", open = false) =>
  ({ startMs: at(from), endMs: to === null ? null : at(to), reason, open });
const sum = (cell) => Object.values(cell.ms).reduce((total, ms) => total + ms, 0);

test("зона причины: плановая, внеплановая, авария, без причины", () => {
  assert.equal(zoneOf("perevalka", refs), "plan");
  assert.equal(zoneOf("avaria", refs), "failure");
  for (const code of ["burezhka", "", null, "неизвестная"]) {
    assert.equal(zoneOf(code, refs), "unplanned");
  }
});

test("сутки: 48 ячеек от 08:00 МСК с точными границами", () => {
  const cells = dayCells([], options(1440));
  assert.equal(cells.length, 48);
  cells.forEach((cell, index) => {
    assert.equal(cell.startMs, at(index * 30));
    assert.equal(cell.endMs, at((index + 1) * 30));
    assert.equal(cell.future, false);
    assert.equal(cell.ms.work, 30 * M);
    assert.equal(sum(cell), 30 * M);
  });
  assert.equal(cells.at(-1).endMs, at(1440));
});

test("текущая ячейка учитывает прошедшую часть, будущее пусто", () => {
  const cells = dayCells([], options(45));
  assert.equal(cells[0].ms.work, 30 * M);
  assert.equal(cells[1].ms.work, 15 * M);
  assert.equal(cells[1].future, false);
  assert.ok(cells.slice(2).every((cell) => cell.future && sum(cell) === 0));
  const boundary = dayCells([], options(30));
  assert.equal(boundary[1].future, true);
  assert.equal(sum(boundary[1]), 0);
  assert.ok(dayCells([], options(-1)).every((cell) => cell.future && sum(cell) === 0));
});

test("открытый простой идёт до nowMs, включая время после снимка состояния", () => {
  const cells = dayCells([segment(20, 25, "avaria", true)], options(45));
  assert.equal(cells[0].ms.work, 20 * M);
  assert.equal(cells[0].ms.failure, 10 * M);
  assert.equal(cells[1].ms.failure, 15 * M);
  assert.equal(sum(cells[1]), 15 * M);
});

test("nodata до начала учёта имеет приоритет над простоем", () => {
  const cells = dayCells([segment(0, 60, "perevalka")], options(75, 40));
  assert.equal(cells[0].ms.nodata, 30 * M);
  assert.equal(cells[1].ms.nodata, 10 * M);
  assert.equal(cells[1].ms.plan, 20 * M);
  assert.equal(cells[2].ms.work, 15 * M);
  assert.deepEqual(zoneTotals(dayCells([], options(45, null)), at(0), at(1440)),
    { work: 0, plan: 0, unplanned: 0, failure: 0, nodata: 45 });
});

test("простой через границу ячейки и суток обрезается", () => {
  const cells = dayCells([segment(-10, 10, "perevalka"), segment(25, 40), segment(1430, 1450, "avaria")], options(1500));
  assert.deepEqual(cells[0].ms, { work: 15 * M, plan: 10 * M, unplanned: 5 * M, failure: 0, nodata: 0 });
  assert.equal(cells[1].ms.unplanned, 10 * M);
  assert.equal(cells[47].ms.failure, 10 * M);
  assert.equal(cells.reduce((total, cell) => total + sum(cell), 0), 1440 * M);
});

test("сумма зон каждой ячейки равна её прошедшему времени, пересечения не удваиваются", () => {
  const cells = dayCells([segment(5, 50), segment(20, 80, "avaria"), segment(80, null, null, true)], options(101.5, 10));
  for (const cell of cells) {
    assert.equal(sum(cell), Math.max(0, Math.min(cell.endMs, at(101.5)) - cell.startMs));
    assert.ok(Object.values(cell.ms).every((ms) => ms >= 0));
  }
});

test("zoneTotals: точный отрезок внутри ячейки, граница смены и пустой период", () => {
  const cells = dayCells([segment(10, 20, "perevalka"), segment(710, 730, "avaria")], options(750));
  assert.deepEqual(zoneTotals(cells, at(12), at(25)), { work: 5, plan: 8, unplanned: 0, failure: 0, nodata: 0 });
  assert.deepEqual(zoneTotals(cells, at(720), at(1440)), { work: 20, plan: 0, unplanned: 0, failure: 10, nodata: 0 });
  assert.equal(Object.values(zoneTotals(cells, at(0), at(1440))).reduce((a, b) => a + b, 0), 750);
  assert.deepEqual(zoneTotals(cells, at(20), at(20)), { work: 0, plan: 0, unplanned: 0, failure: 0, nodata: 0 });
});
