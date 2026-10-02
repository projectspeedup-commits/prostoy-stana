// Случайные, но повторяемые сценарии: инварианты отчёта на сотнях остановок с секундами, границами смен и суток.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats } from "../../app/core/stats.js";
import { shiftOf } from "../../app/core/core.js";
import { addDays, currentDay, dayStartMs } from "../../app/core/report-period.js";
import { T, build, eventMaker, minutesOf, refs, summaryCell } from "../helpers/report-fixtures.js";

const DAY = 86_400_000;
const MIN = 60_000;
const lcg = (seed) => {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
};

/** Случайная работа стана за несколько суток: остановки с секундами, смена причины, брак, ручные простои, смены. */
function scenario(seed) {
  const rnd = lcg(seed * 7919 + 13);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const E = eventMaker();
  const iso = (ms) => new Date(ms).toISOString();
  const first = T("2026-09-24", "08:00:00") + Math.floor(rnd() * 3 * DAY) + Math.floor(rnd() * 1000) * 7;
  const now = first + Math.floor((0.7 + rnd() * 5) * DAY) + Math.floor(rnd() * 59_000);
  const events = [];
  const at = (type, ms, extra = {}) => events.push({ ...E(type, "2026-01-01", "00:00:00", extra), at: iso(ms) });
  at("shift_open", first, { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" });
  let t = first;
  let n = 0;
  while (t < now - 2 * MIN) {
    t += Math.floor((3 + rnd() * 400) * MIN + rnd() * 59_000);
    if (t >= now - 60_000) break;
    const roll = rnd();
    if (roll < 0.08) {
      at("shift_close", t, { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович", note: "сдача" });
      at("shift_open", t + 5_000, { crewId: "2", personId: pick(["p2", "p3"]) });
      continue;
    }
    if (roll < 0.2) {
      const to = t + Math.floor((1 + rnd() * 40) * MIN + rnd() * 59_000);
      if (to >= now - 60_000) break;
      at("manual", to + 1000, { downtimeId: `M${n++}`, from: iso(t), to: iso(to), reason: pick([null, "perevalka", "burezhka", "avaria"]) });
      t = to + 2000;
      continue;
    }
    const id = `D${n++}`;
    const reasons = [null, "perevalka", "burezhka", "avaria", "П-02", "В-Т-03"];
    const reason = pick(reasons);
    at("stop", t, { downtimeId: id, ...(reason && rnd() < 0.7 ? { reason } : {}) });
    if (reason && events.at(-1).reason === undefined) at("reason", t + 20_000, { downtimeId: id, reason });
    const end = t + Math.floor((1 + rnd() * 300) * MIN + rnd() * 59_000);
    let index = 0;
    if (rnd() < 0.2 && end - t > 4 * MIN) {
      at("split", t + Math.floor((end - t) / 2), { downtimeId: id, reason: pick(["perevalka", "burezhka", "avaria"]), note: "причина изменилась" });
      index = 1;
    }
    if (end >= now - 60_000) break; // простой идёт сейчас
    at("start", end, { downtimeId: id, ...(rnd() < 0.5 ? { action: "устранили" } : {}) });
    if (rnd() < 0.35) at("fix", end + 1000, { downtimeId: id, index, billet: pick([0, 0.5, 1.2, 2.5, 7]) });
    t = end + 2000;
  }
  const today = currentDay(now, refs.settings.schedule);
  const firstDay = shiftOf(first, refs.settings.schedule).day;
  let from = addDays(firstDay, Math.floor(rnd() * 3) - 1); // от суток перед первой записью до суток после
  if (from > today) from = today;
  const span = Math.round((Date.parse(today) - Date.parse(from)) / DAY);
  const to = addDays(from, Math.floor(rnd() * (span + 1)));
  return { events, now, fromDay: from, toDay: to };
}

const stopsOf = (parts) => new Set(parts.map((p) => p.downtimeId)).size;

for (let seed = 1; seed <= 60; seed++) {
  test(`случайный сценарий №${seed}: сводка = показатели, таблицы сходятся, журнал целостен`, () => {
    const { events, now, fromDay, toDay } = scenario(seed);
    const { wb, book } = build(events, { fromDay, toDay, nowMs: now });
    const schedule = refs.settings.schedule;
    const fromMs = dayStartMs(fromDay, schedule);
    const toMsEff = Math.min(dayStartMs(toDay, schedule) + DAY, now);
    const stats = computeStats(events, { fromMs, toMs: toMsEff, nowMs: now, refs });
    const sum = wb.sheets[0];

    // 1. Сводка — те же числа, что на экране
    const zone = (z) => stats.byZone.find((r) => r.zone === z).minutes;
    for (const [label, minutes] of [
      ["Учтённое время", stats.totalMin], ["Работа", stats.workMin], ["Простой", stats.downMin], ["Плановый простой", zone("plan")],
      ["Внеплановый простой", zone("unplanned")], ["Аварийный простой", zone("failure")], ["Плановые", stats.plannedMin],
      ["Внеплановые", stats.unplannedMin], ["Работа между отказами", stats.mtbfMin], ["Время на ремонт", stats.mttrMin], ["Средний простой", stats.avgStopMin],
    ]) {
      const cell = summaryCell(sum, label);
      if (minutes === null) assert.equal(cell.value, "—", label);
      else assert.equal(minutesOf(cell), minutes, label);
    }
    assert.equal(summaryCell(sum, "Остановок, шт").value, stats.stops);
    assert.equal(summaryCell(sum, "Доступность").value, stats.availability ?? "—");
    assert.equal(summaryCell(sum, "Без причины, остановок").value, stats.quality.noReason);
    assert.equal(summaryCell(sum, "Не указано, что сделали, остановок").value, stats.quality.noAction);

    // 2. Таблица смен: «Итого» = сводка, строки складываются, в строке учтённое = работа + простои
    const sheet = wb.sheets[1];
    const rows = [];
    let total = null;
    for (let r = 3; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      if (!row || row[0].value === undefined) continue;
      if (row[0].value === "Итого") total = row; else if (typeof row[0].value === "number") rows.push(row);
    }
    if (stats.noData) {
      assert.equal(rows.length, 0);
    } else {
      assert.ok(total, "есть строка «Итого»");
      const col = (c) => rows.reduce((s, row) => s + (c === 8 || c === 10 ? row[c].value : minutesOf(row[c])), 0);
      assert.equal(minutesOf(total[3]), stats.totalMin);
      assert.equal(minutesOf(total[4]), stats.workMin);
      assert.equal(minutesOf(total[5]), zone("plan"));
      assert.equal(minutesOf(total[6]), zone("unplanned"));
      assert.equal(minutesOf(total[7]), zone("failure"));
      assert.equal(total[8].value, stats.stops);
      assert.equal(total[9].value, stats.byZone.find((z) => z.zone === "work").share);
      for (const c of [3, 4, 5, 6, 7]) assert.equal(col(c), minutesOf(total[c]), `столбец ${c}`);
      assert.equal(col(8), total[8].value);
      assert.ok(Math.abs(col(10) - total[10].value) < 1e-9);
      for (const row of rows) {
        assert.equal(minutesOf(row[3]), minutesOf(row[4]) + minutesOf(row[5]) + minutesOf(row[6]) + minutesOf(row[7]));
        assert.ok(minutesOf(row[3]) <= 720, "в смене не больше 12 часов учёта");
        assert.ok(row[9].value >= 0 && row[9].value <= 1);
      }
    }

    // 3. Журнал: части не пересекаются, не заходят за «сейчас» и период, остановки — по номеру простоя
    const parts = book.meta.parts;
    assert.equal(stopsOf(parts), stats.stops, "число остановок журнала = остановки сводки");
    parts.forEach((p, i) => {
      assert.ok(p.startMs >= fromMs && p.endMs <= toMsEff && p.endMs <= now && p.endMs > p.startMs);
      if (i) assert.ok(parts[i - 1].endMs <= p.startMs, "стан один: части простоев не пересекаются");
      assert.equal(p.minutes, Math.round((p.endMs - p.startMs) / MIN), "минуты части — как на экране");
      const sh = shiftOf(p.startMs, schedule);
      assert.ok(p.endMs <= sh.endMs && p.startMs >= sh.startMs, "часть внутри одной смены");
      assert.equal(p.day, sh.day);
      assert.equal(p.shiftNo, sh.shiftNo);
    });
    const ongoing = parts.filter((p) => p.ongoing);
    assert.ok(ongoing.length <= 1);
    if (ongoing.length) assert.equal(ongoing[0], parts.at(-1));
    for (const z of ["plan", "unplanned", "failure"]) {
      const ms = parts.filter((p) => p.zone === z).reduce((s, p) => s + p.endMs - p.startMs, 0);
      assert.ok(Math.abs(ms / MIN - zone(z)) < 1, `зона ${z}: ${ms / MIN} мин против ${zone(z)}`);
    }
    // брак: журнал = таблица смен = сводка
    const billet = Math.round(parts.reduce((s, p) => s + p.billet, 0) * 1000) / 1000;
    assert.equal(summaryCell(sum, "Брак заготовки всего, тн").value, billet);
    if (total) assert.ok(Math.abs(total[10].value - billet) < 1e-9);
    // строки журнала в файле: столько же, сколько частей; конец пуст только у идущей части
    const journalRows = wb.sheets[2].rows.slice(3).filter((row) => row && typeof row[0]?.value === "number");
    assert.equal(journalRows.length, parts.length);
    journalRows.forEach((row, i) => assert.equal(row[5].value === null, parts[i].ongoing));
  });
}

test("соседние сутки складываются: части и брак за период = части и брак по суткам", () => {
  for (let seed = 101; seed <= 130; seed++) {
    const { events, now } = scenario(seed);
    const today = currentDay(now, refs.settings.schedule);
    const from = addDays(today, -3);
    const key = (p) => `${p.downtimeId}|${p.index}|${p.startMs}|${p.endMs}|${p.zone}|${p.billet}`;
    const whole = build(events, { fromDay: from, toDay: today, nowMs: now }).book.meta.parts.map(key).sort();
    const daily = [];
    let billet = 0;
    for (let i = 0; i <= 3; i++) {
      const day = addDays(from, i);
      const { book } = build(events, { fromDay: day, toDay: day, nowMs: now });
      daily.push(...book.meta.parts.map(key));
      billet += book.meta.parts.reduce((s, p) => s + p.billet, 0);
    }
    assert.deepEqual(daily.sort(), whole, `сценарий ${seed}`);
    const wholeBillet = build(events, { fromDay: from, toDay: today, nowMs: now }).book.meta.parts.reduce((s, p) => s + p.billet, 0);
    assert.ok(Math.abs(billet - wholeBillet) < 1e-9, `брак по суткам и за период: сценарий ${seed}`);
  }
});
