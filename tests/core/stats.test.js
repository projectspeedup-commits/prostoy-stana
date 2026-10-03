import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeStats, periodRange } from "../../app/core/stats.js";
import { DEFAULT_SCHEDULE, toMs } from "../../app/core/core.js";

const MINUTE = 60_000;
const t = (value) => toMs(value);
const refs = {
  reasons: {
    U1: { title: "Авария", group: "Механическая", planned: false, zone: "failure" },
    U2: { title: "Нет заготовки", group: "Организационная", planned: false, zone: "unplanned" },
    P1: { title: "ППР", group: "Плановый", planned: true, zone: "plan" },
    O1: { title: "Иная", group: "Прочее", planned: false, other: true },
  },
  settings: { shortStopMinutes: 5, schedule: DEFAULT_SCHEDULE },
};

function stats(events, from, to, now = to) {
  return computeStats(events, { fromMs: t(from), toMs: t(to), nowMs: t(now), refs });
}

if (process.env.STATS_TZ_CHILD === "1") {
  const range = periodRange("month", t("2026-03-15T12:00:00Z"), DEFAULT_SCHEDULE);
  console.log(JSON.stringify(range));
} else {
  test("byZone: четыре зоны, минуты, остановки и доля времени учёта", () => {
    const result = stats([
      { id: "p", type: "manual", at: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z", to: "2026-01-01T08:10:00Z", reason: "P1" },
      { id: "u", type: "manual", at: "2026-01-01T08:20:00Z", from: "2026-01-01T08:20:00Z", to: "2026-01-01T08:40:00Z", reason: "U2" },
      { id: "f", type: "stop", at: "2026-01-01T09:00:00Z", reason: "U1" },
      { id: "end", type: "start", at: "2026-01-01T09:30:00Z" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.deepEqual(result.byZone, [
      { zone: "plan", minutes: 10, stops: 1, share: 10 / 120 },
      { zone: "unplanned", minutes: 20, stops: 1, share: 20 / 120 },
      { zone: "failure", minutes: 30, stops: 1, share: 30 / 120 },
      { zone: "work", minutes: 60, stops: 0, share: 60 / 120 },
    ]);
  });

  test("byZone: смена причины не удваивает остановку внутри зоны", () => {
    const result = stats([
      { id: "s", type: "stop", at: "2026-01-01T08:00:00Z", reason: "U1" },
      { id: "same", type: "split", at: "2026-01-01T08:10:00Z", reason: "U1" },
      { id: "other", type: "split", at: "2026-01-01T08:20:00Z", reason: "U2" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T08:30:00Z");
    assert.equal(result.stops, 1);
    assert.equal(result.byZone.find((row) => row.zone === "failure").stops, 1);
    assert.equal(result.byZone.find((row) => row.zone === "unplanned").stops, 1);
    assert.equal(result.byZone.reduce((sum, row) => sum + row.minutes, 0), result.totalMin);
  });

  test("byZone: короткий простой без причины — жёлтый, округление сохраняет итог", () => {
    const result = stats([
      { id: "p", type: "manual", at: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z", to: "2026-01-01T08:00:20Z", reason: "P1" },
      { id: "u", type: "manual", at: "2026-01-01T08:00:20Z", from: "2026-01-01T08:00:20Z", to: "2026-01-01T08:00:40Z" },
      { id: "f", type: "manual", at: "2026-01-01T08:00:40Z", from: "2026-01-01T08:00:40Z", to: "2026-01-01T08:01:00Z", reason: "U1" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T08:02:00Z");
    assert.equal(result.byZone.filter((row) => row.zone !== "work").reduce((sum, row) => sum + row.minutes, 0), result.downMin);
    const unknown = result.byZone.find((row) => row.zone === "unplanned");
    assert.equal(unknown.stops, 1);
    assert.equal(unknown.share, 1 / 6);
  });

  test("byZone: до первого события нет работы, пустые зоны имеют нули", () => {
    const empty = stats([], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.ok(empty.byZone.every((row) => row.minutes === 0 && row.stops === 0 && row.share === 0));
    const result = stats([{ id: "open", type: "shift_open", at: "2026-01-01T09:00:00Z" }],
      "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.deepEqual(result.byZone.find((row) => row.zone === "work"), { zone: "work", minutes: 60, stops: 0, share: 1 });
  });
  test("отрезок простоя через границу периода обрезается", () => {
    const result = stats([
      { id: "m", type: "manual", from: "2026-01-01T07:00:00Z", to: "2026-01-01T09:00:00Z", at: "2026-01-01T07:00:00Z", reason: "U1" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.equal(result.downMin, 60);
    assert.equal(result.workMin, 60);
    assert.equal(result.stops, 1);
  });

  test("открытый простой считается до nowMs", () => {
    const result = stats([
      { id: "s", type: "stop", at: "2026-01-01T08:00:00Z", downtimeId: "d", reason: "U1" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T12:00:00Z", "2026-01-01T10:00:00Z");
    assert.equal(result.downMin, 120);
  });

  test("availability без плановых простоев равна work/total", () => {
    const result = stats([
      { id: "m", type: "manual", from: "2026-01-01T08:00:00Z", to: "2026-01-01T09:00:00Z", at: "2026-01-01T08:00:00Z", reason: "U1" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.equal(result.availability, 0.5);
  });

  test("mtbf и mttr считаются по двум внеплановым остановкам", () => {
    const result = stats([
      { id: "a", type: "manual", from: "2026-01-01T08:00:00Z", to: "2026-01-01T08:30:00Z", at: "2026-01-01T08:00:00Z", reason: "U1" },
      { id: "b", type: "manual", from: "2026-01-01T10:30:00Z", to: "2026-01-01T11:00:00Z", at: "2026-01-01T10:30:00Z", reason: "U2" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T13:00:00Z");
    assert.equal(result.unplannedStops, 2);
    assert.equal(result.mtbfMin, 120);
    assert.equal(result.mttrMin, 30);
  });

  test("два отрезка одного downtimeId считаются одной остановкой", () => {
    const result = stats([
      { id: "s", type: "stop", at: "2026-01-01T08:00:00Z", downtimeId: "d", reason: "U1" },
      { id: "x", type: "split", at: "2026-01-01T08:30:00Z", downtimeId: "d" },
      { id: "e", type: "start", at: "2026-01-01T09:00:00Z", downtimeId: "d", action: "устранили" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.equal(result.downMin, 60);
    assert.equal(result.stops, 1);
    assert.equal(result.longest.downtimeId, "d");
  });

  test("byReason отсортирован, а минуты дают downMin", () => {
    const result = stats([
      { id: "a", type: "manual", from: "2026-01-01T08:00:00Z", to: "2026-01-01T08:20:00Z", at: "2026-01-01T08:00:00Z", reason: "U1" },
      { id: "b", type: "manual", from: "2026-01-01T09:00:00Z", to: "2026-01-01T09:40:00Z", at: "2026-01-01T09:00:00Z", reason: "U2" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.deepEqual(result.byReason.map((row) => row.reason), ["U2", "U1"]);
    assert.equal(result.byReason.reduce((sum, row) => sum + row.minutes, 0), result.downMin);
  });

  test("quality.noAction считает закрытые простои без action", () => {
    const result = stats([
      { id: "s1", type: "stop", at: "2026-01-01T08:00:00Z", downtimeId: "d1", reason: "U1" },
      { id: "e1", type: "start", at: "2026-01-01T08:20:00Z", downtimeId: "d1" },
      { id: "s2", type: "stop", at: "2026-01-01T09:00:00Z", downtimeId: "d2", reason: "U2" },
      { id: "e2", type: "start", at: "2026-01-01T09:20:00Z", downtimeId: "d2", action: "настроили" },
    ], "2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z");
    assert.equal(result.quality.noAction, 1);
  });

  test("месяц начинается первого числа в 08:00 по Москве", () => {
    const range = periodRange("month", t("2026-03-15T12:00:00Z"), DEFAULT_SCHEDULE);
    assert.equal(range.fromMs, t("2026-03-01T05:00:00Z"));
  });

  test("periodRange не зависит от TZ процесса", () => {
    const target = fileURLToPath(import.meta.url);
    const results = ["America/New_York", "UTC"].map((TZ) => {
      const env = { ...process.env, TZ, STATS_TZ_CHILD: "1" };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [target], { env, encoding: "utf8" });
      if (child.error?.code === "EPERM") return null;
      assert.equal(child.status, 0, child.stdout + child.stderr);
      return child.stdout.trim();
    });
    if (results.includes(null)) return;
    assert.equal(results[0], results[1]);
  });

  const withoutZones = ({ byZone, billetTn, ...r }) => r;
  const crewRow = (result, crewId) => withoutZones(result.byCrew.find((row) => row.crewId === crewId));
  const sumCrew = (result) => result.byCrew.reduce((sum, row) => sum + row.minutes, 0);

  test("byCrew: простой, начатый Сменой 1, делится с бригадой, принявшей смену стоящим", () => {
    const result = stats([
      { id: "o1", type: "shift_open", at: "2026-01-01T09:00:00Z", crewId: "1", personId: "p1" },
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d", reason: "U1", crewId: "1", personId: "p1" },
      { id: "o2", type: "shift_open", at: "2026-01-01T12:00:00Z", crewId: "2", personId: "p4" },
      { id: "e", type: "start", at: "2026-01-01T15:00:00Z", downtimeId: "d", action: "заменили", crewId: "2", personId: "p4" },
    ], "2026-01-01T05:00:00Z", "2026-01-01T17:00:00Z");
    assert.equal(result.downMin, 300);
    assert.deepEqual(crewRow(result, "1"), { crewId: "1", minutes: 120, stops: 1, carried: 0 });
    assert.deepEqual(crewRow(result, "2"), { crewId: "2", minutes: 180, stops: 0, carried: 1 });
    assert.equal(sumCrew(result), result.downMin);
  });

  test("byCrew: сдача смены и конец производственной смены обрывают дежурство", () => {
    // Сдача: Смена 1 держит пост с 09:00 до 11:00, до приёма Смены 2 (13:00) простой остаётся за нажавшей
    const closed = stats([
      { id: "o1", type: "shift_open", at: "2026-01-01T09:00:00Z", crewId: "1", personId: "p1" },
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d", crewId: "1", personId: "p1" },
      { id: "c", type: "shift_close", at: "2026-01-01T11:00:00Z", crewId: "1", personId: "p1", action: "ждём подшипник" },
      { id: "o2", type: "shift_open", at: "2026-01-01T13:00:00Z", crewId: "2", personId: "p4" },
      { id: "e", type: "start", at: "2026-01-01T14:00:00Z", downtimeId: "d", action: "заменили" },
    ], "2026-01-01T05:00:00Z", "2026-01-01T17:00:00Z");
    assert.equal(crewRow(closed, "1").minutes, 180);
    assert.equal(crewRow(closed, "2").minutes, 60);
    assert.equal(sumCrew(closed), closed.downMin);
    // Ночная смена кончается в 05:00 UTC (08:00 по Москве) — приём в 00:00 не тянется дальше
    const night = stats([
      { id: "o1", type: "shift_open", at: "2026-01-01T00:00:00Z", crewId: "1", personId: "p1" },
      { id: "s", type: "stop", at: "2026-01-01T04:00:00Z", downtimeId: "d", crewId: "1", personId: "p1" },
      { id: "o2", type: "shift_open", at: "2026-01-01T06:00:00Z", crewId: "2", personId: "p4" },
      { id: "e", type: "start", at: "2026-01-01T08:00:00Z", downtimeId: "d", action: "заменили" },
    ], "2026-01-01T00:00:00Z", "2026-01-01T12:00:00Z");
    assert.equal(crewRow(night, "1").minutes, 120);
    assert.equal(crewRow(night, "2").minutes, 120);
    assert.equal(crewRow(night, "2").stops, 0);
    assert.equal(sumCrew(night), night.downMin);
  });

  test("byCrew: простой, начатый до периода, у принявшей смену бригады — принят стоящим, без остановок", () => {
    const result = stats([
      { id: "o1", type: "shift_open", at: "2025-12-31T21:00:00Z", crewId: "1", personId: "p1" },
      { id: "s", type: "stop", at: "2025-12-31T22:00:00Z", downtimeId: "d", crewId: "1", personId: "p1" },
      { id: "o2", type: "shift_open", at: "2026-01-01T05:00:00Z", crewId: "2", personId: "p4" },
      { id: "e", type: "start", at: "2026-01-01T09:00:00Z", downtimeId: "d", action: "заменили" },
    ], "2026-01-01T05:00:00Z", "2026-01-01T17:00:00Z");
    assert.deepEqual(result.byCrew.map(withoutZones), [{ crewId: "2", minutes: 240, stops: 0, carried: 1 }]);
    assert.equal(result.downMin, 240);
  });

  test("byCrew: без единого shift_open простой целиком у бригады, нажавшей «Стан встал»", () => {
    const result = stats([
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d", reason: "U1", crewId: "1" },
      { id: "x", type: "split", at: "2026-01-01T11:00:00Z", downtimeId: "d", reason: "U2", crewId: "2" },
      { id: "e", type: "start", at: "2026-01-01T12:00:00Z", downtimeId: "d", action: "заменили", crewId: "2" },
    ], "2026-01-01T05:00:00Z", "2026-01-01T17:00:00Z");
    assert.deepEqual(result.byCrew.map(withoutZones), [{ crewId: "1", minutes: 120, stops: 1, carried: 0 }]);
    const noCrew = stats([
      { id: "m", type: "manual", from: "2026-01-01T08:00:00Z", to: "2026-01-01T09:00:00Z", at: "2026-01-01T08:00:00Z", reason: "U1" },
    ], "2026-01-01T05:00:00Z", "2026-01-01T17:00:00Z");
    assert.deepEqual(noCrew.byCrew.map(withoutZones), [{ crewId: null, minutes: 60, stops: 1, carried: 0 }]);
  });

  test("byCrew: сумма минут равна общему простою и при долях минуты", () => {
    const result = stats([
      { id: "o1", type: "shift_open", at: "2026-01-01T09:00:00Z", crewId: "1", personId: "p1" },
      { id: "s", type: "stop", at: "2026-01-01T10:00:20Z", downtimeId: "d", crewId: "1", personId: "p1" },
      { id: "o2", type: "shift_open", at: "2026-01-01T12:00:40Z", crewId: "2", personId: "p4" },
      { id: "e", type: "start", at: "2026-01-01T14:00:50Z", downtimeId: "d", action: "заменили" },
    ], "2026-01-01T05:00:00Z", "2026-01-01T17:00:00Z");
    assert.equal(result.downMin, 241);
    assert.equal(sumCrew(result), result.downMin);
  });
}

if (process.env.STATS_TZ_CHILD !== "1") test("computeStats: время до первого события не считается работой", async () => {
  const { computeStats } = await import("../../app/core/stats.js");
  const { DEFAULT_REFS } = await import("../../app/core/refs.js");
  const from = Date.parse("2026-09-01T05:00:00Z");
  const to = Date.parse("2026-09-03T05:00:00Z");
  const st = computeStats([
    { id: "a", type: "stop", at: "2026-09-02T10:00:00Z", downtimeId: "d" },
    { id: "b", type: "start", at: "2026-09-02T11:00:00Z", downtimeId: "d", reason: "avaria", action: "x" },
  ], { fromMs: from, toMs: to, nowMs: to, refs: DEFAULT_REFS });
  assert.equal(st.byDay[0].noData, true);
  assert.equal(st.byDay[0].workMin, null);
  assert.equal(st.totalMin, 19 * 60);
  assert.equal(st.downMin, 60);
});

if (process.env.STATS_TZ_CHILD !== "1") test("месяц 1-го числа до 08:00 — ещё прошлый месяц по производственным суткам", () => {
  const now = Date.parse("2026-10-01T07:45:00+03:00");
  const range = periodRange("month", now, DEFAULT_SCHEDULE);
  assert.equal(range.fromMs, Date.parse("2026-09-01T08:00:00+03:00"));
  assert.equal(range.toMs, now);
  assert.ok(range.toMs > range.fromMs);
});
