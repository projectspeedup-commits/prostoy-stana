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
    U1: { title: "Авария", group: "Механическая", planned: false },
    U2: { title: "Нет заготовки", group: "Организационная", planned: false },
    P1: { title: "ППР", group: "Плановый", planned: true },
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
}

if (process.env.STATS_TZ_CHILD !== "1") test("computeStats: время до первого события не считается работой", async () => {
  const { computeStats } = await import("../../app/core/stats.js");
  const { DEFAULT_REFS } = await import("../../app/core/refs.js");
  const from = Date.parse("2026-09-01T05:00:00Z");
  const to = Date.parse("2026-09-03T05:00:00Z");
  const st = computeStats([
    { id: "a", type: "stop", at: "2026-09-02T10:00:00Z", downtimeId: "d" },
    { id: "b", type: "start", at: "2026-09-02T11:00:00Z", downtimeId: "d", reason: "В-М-01", action: "x" },
  ], { fromMs: from, toMs: to, nowMs: to, refs: DEFAULT_REFS });
  assert.equal(st.byDay[0].noData, true);
  assert.equal(st.byDay[0].workMin, null);
  assert.equal(st.totalMin, 19 * 60);
  assert.equal(st.downMin, 60);
});
