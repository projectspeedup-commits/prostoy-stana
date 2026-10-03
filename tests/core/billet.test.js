// Брак (испорченная заготовка, тн) в «Показателях»: одно правило с отчётом Excel и экраном смены.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats } from "../../app/core/stats.js";
import { billetSegments, buildDowntimes, segmentBillet, sumBillet } from "../../app/core/core.js";
import { addDays, currentDay, dayStartMs } from "../../app/core/report-period.js";
import { T, build, dayFixture, eventMaker, refs, summaryCell } from "../helpers/report-fixtures.js";

const DAY = 86_400_000;
const MIN = 60_000;
const schedule = refs.settings.schedule;
const iso = (ms) => new Date(ms).toISOString();

const statsOf = (events, fromMs, toMs, nowMs = toMs) => computeStats(events, { fromMs, toMs, nowMs, refs });

test("брак: сумма частей простоя, открытый простой — без брака, не указан — в предупреждении", () => {
  const E = eventMaker();
  const d = "2026-10-01";
  const events = [
    E("shift_open", d, "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    // Простой с двумя частями (смена причины), брак указан у каждой: 1,1 + 2,2 = 3,3
    E("stop", d, "09:00:00", { downtimeId: "A", reason: "burezhka" }),
    E("split", d, "09:30:00", { downtimeId: "A", reason: "avaria" }),
    E("start", d, "10:00:00", { downtimeId: "A" }),
    E("fix", d, "10:00:01", { downtimeId: "A", index: 0, billet: 1.1 }),
    E("fix", d, "10:00:02", { downtimeId: "A", index: 1, billet: 2.2 }),
    // Брак 0 указан явно
    E("stop", d, "11:00:00", { downtimeId: "B", reason: "avaria" }),
    E("start", d, "11:20:00", { downtimeId: "B" }),
    E("fix", d, "11:20:01", { downtimeId: "B", index: 0, billet: 0 }),
    // Брак спрашивают (бурёжка), но не указан
    E("stop", d, "12:00:00", { downtimeId: "C", reason: "burezhka" }),
    E("start", d, "12:10:00", { downtimeId: "C" }),
    // Идёт сейчас — брака нет и «не указан» не считается
    E("stop", d, "22:00:00", { downtimeId: "D", reason: "avaria" }),
  ];
  const now = T(d, "22:30:00");
  const from = dayStartMs(d, schedule);
  const st = statsOf(events, from, from + DAY, now);
  assert.equal(st.billetTn, 3.3, "1,1 + 2,2 без хвоста плавающей запятой");
  assert.equal(st.billetStops, 1);
  assert.equal(st.quality.noBillet, 1, "C: брак спрашивают, но не указан");
  assert.equal(st.byReason.find((r) => r.reason === "avaria").billetTn, 2.2);
  assert.equal(st.byReason.find((r) => r.reason === "burezhka").billetTn, 1.1);
  assert.equal(st.byCrew.find((c) => c.crewId === "1").billetTn, 3.3);
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: now });
  assert.equal(summaryCell(wb.sheets[0], "Брак заготовки всего, тн").value, st.billetTn);
});

test("брак: не указан ни разу — null, указан нулём — 0", () => {
  const E = eventMaker();
  const d = "2026-10-01";
  const base = [
    E("shift_open", d, "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("stop", d, "09:00:00", { downtimeId: "A", reason: "avaria" }),
    E("start", d, "09:30:00", { downtimeId: "A" }),
  ];
  const from = dayStartMs(d, schedule);
  const now = T(d, "15:00:00");
  const none = statsOf(base, from, from + DAY, now);
  assert.equal(none.billetTn, null);
  assert.equal(none.billetStops, 0);
  assert.equal(none.quality.noBillet, 1);
  const zero = statsOf([...base, E("fix", d, "09:30:01", { downtimeId: "A", index: 0, billet: 0 })], from, from + DAY, now);
  assert.equal(zero.billetTn, 0);
  assert.equal(zero.quality.noBillet, 0);
  assert.equal(statsOf([], from, from + DAY, now).billetTn, null);
});

test("брак: простой через границу смен — к смене, где он завершился; бригада — дежурная в этот момент", () => {
  const { events, now, day } = dayFixture();
  const from = dayStartMs(day, schedule);
  const st = statsOf(events, from, from + DAY, now);
  // D2 (14:50, смена 1) 2,5 тн + D3 (начат в смене 1, завершён в 20:25 в смене 2) 1,2 тн
  assert.equal(st.billetTn, 3.7);
  assert.equal(st.billetStops, 2);
  assert.equal(st.byCrew.find((c) => c.crewId === "1").billetTn, 2.5);
  assert.equal(st.byCrew.find((c) => c.crewId === "2").billetTn, 1.2);
  assert.equal(st.byReason.find((r) => r.reason === "burezhka").billetTn, 2.5);
  assert.equal(st.byReason.find((r) => r.reason === "avaria").billetTn, 1.2);
  // Отчёт Excel: итог и смены — те же числа
  const { wb, book } = build(events, { fromDay: day, toDay: day, nowMs: now });
  assert.equal(summaryCell(wb.sheets[0], "Брак заготовки всего, тн").value, 3.7);
  const shifts = new Map();
  for (const p of book.meta.parts) shifts.set(p.shiftNo, (shifts.get(p.shiftNo) ?? 0) + p.billet);
  assert.equal(Math.round(shifts.get(1) * 1000) / 1000, 2.5);
  assert.equal(Math.round(shifts.get(2) * 1000) / 1000, 1.2);
  // Период, закончившийся до завершения простоя D3, его брак не включает (как и отчёт)
  assert.equal(statsOf(events, from, T(day, "20:10:00"), now).billetTn, 2.5);
});

test("общее правило: segmentBillet, sumBillet, billetSegments", () => {
  assert.equal(segmentBillet({ open: true, endMs: 10, billet: 1 }), null);
  assert.equal(segmentBillet({ endMs: 10, billet: null }), null);
  assert.equal(segmentBillet({ endMs: 10, billet: -1 }), null);
  assert.equal(segmentBillet({ endMs: 10, billet: 0 }), 0);
  assert.equal(sumBillet([null, 0.1, 0.2]), 0.3);
  assert.equal(sumBillet([null, null]), null);
  const { events, now } = dayFixture();
  const rows = billetSegments(buildDowntimes(events, now).segments, 0, now, schedule);
  assert.ok(rows.length > 0 && rows.every((r) => r.segment.open !== true));
});

// Случайные сценарии: итог брака в «Показателях» и в Excel совпадает до 0,001 тн
const lcg = (seed) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; };
for (let seed = 1; seed <= 40; seed++) {
  test(`брак: случайный сценарий №${seed} — показатели совпадают с отчётом Excel`, () => {
    const rnd = lcg(seed * 104729 + 7);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const E = eventMaker();
    const events = [];
    const at = (type, ms, extra = {}) => events.push({ ...E(type, "2026-01-01", "00:00:00", extra), at: iso(ms) });
    const first = T("2026-09-24", "08:00:00") + Math.floor(rnd() * 3 * DAY);
    const now = first + Math.floor((1 + rnd() * 5) * DAY);
    at("shift_open", first, { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" });
    let t = first;
    let n = 0;
    while (t < now - 2 * MIN) {
      t += Math.floor((10 + rnd() * 500) * MIN);
      if (t >= now - 60_000) break;
      if (rnd() < 0.1) {
        at("shift_close", t, { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович", note: "сдача" });
        at("shift_open", t + 5_000, { crewId: "2", personId: "p2" });
        continue;
      }
      const id = `D${n++}`;
      at("stop", t, { downtimeId: id, reason: pick(["perevalka", "burezhka", "avaria", "cobble_shears"]) });
      const end = t + Math.floor((2 + rnd() * 400) * MIN);
      let index = 0;
      if (rnd() < 0.3 && end - t > 4 * MIN) {
        at("split", t + Math.floor((end - t) / 2), { downtimeId: id, reason: pick(["avaria", "burezhka"]) });
        index = 1;
      }
      if (end >= now - 60_000) break;
      at("start", end, { downtimeId: id });
      for (let i = 0; i <= index; i++) {
        if (rnd() < 0.5) at("fix", end + 1000 + i, { downtimeId: id, index: i, billet: pick([0, 0.1, 0.2, 0.5, 1.2, 2.5, 7]) });
      }
      t = end + 2000;
    }
    const today = currentDay(now, schedule);
    const from = addDays(today, -Math.floor(rnd() * 4));
    const to = addDays(from, Math.floor(rnd() * (Math.round((Date.parse(today) - Date.parse(from)) / DAY) + 1)));
    const { wb } = build(events, { fromDay: from, toDay: to, nowMs: now });
    const st = statsOf(events, dayStartMs(from, schedule), Math.min(dayStartMs(to, schedule) + DAY, now), now);
    const cell = summaryCell(wb.sheets[0], "Брак заготовки всего, тн").value;
    assert.ok(Math.abs((st.billetTn ?? 0) - cell) < 0.001, `показатели ${st.billetTn} тн, Excel ${cell} тн`);
    // Разбивки по причинам и сменам сходятся с итогом
    const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.billetTn, 0) * 1000) / 1000;
    assert.equal(sum(st.byReason), st.billetTn ?? 0);
    assert.equal(sum(st.byCrew), st.billetTn ?? 0);
  });
}
