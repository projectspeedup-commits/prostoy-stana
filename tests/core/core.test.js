import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCHEDULE, shiftOf, splitByShifts, buildDowntimes, classify, summarizeDay, workIntervals, handoversSince, reasonKey,
} from "../../app/core/core.js";

// Московское время 2026 года -> мс UTC (по умолчанию сентябрь)
const msk = (d, h, m = 0, mo = 9) => Date.UTC(2026, mo - 1, d, h - 3, m);
const S = DEFAULT_SCHEDULE;
const brief = (parts) => parts.map((p) => [p.day, p.shiftNo, p.minutes]);

test("19:40–20:25: две части, 20 и 25 минут", () => {
  const p = splitByShifts({ startMs: msk(28, 19, 40), endMs: msk(28, 20, 25) }, S);
  assert.deepEqual(brief(p), [["2026-09-28", 1, 20], ["2026-09-28", 2, 25]]);
  assert.deepEqual(p.map((x) => x.continued), [false, true]);
});

test("23:50–00:20: одна часть, смена 2 суток 28.09, 30 минут", () => {
  const p = splitByShifts({ startMs: msk(28, 23, 50), endMs: msk(29, 0, 20) }, S);
  assert.deepEqual(brief(p), [["2026-09-28", 2, 30]]);
});

test("07:30–08:40: смена 2 суток 28.09 — 30, смена 1 суток 29.09 — 40", () => {
  const p = splitByShifts({ startMs: msk(29, 7, 30), endMs: msk(29, 8, 40) }, S);
  assert.deepEqual(brief(p), [["2026-09-28", 2, 30], ["2026-09-29", 1, 40]]);
});

test("19:00–09:00 следующего дня: 60, 720, 60", () => {
  const p = splitByShifts({ startMs: msk(28, 19), endMs: msk(29, 9), extra: "x" }, S);
  assert.deepEqual(p.map((x) => x.minutes), [60, 720, 60]);
  assert.ok(p.every((x) => x.extra === "x"));
});

test("отрезок нулевой или отрицательной длины — ошибка", () => {
  assert.throws(() => splitByShifts({ startMs: 5, endMs: 5 }, S), Error);
  assert.throws(() => splitByShifts({ startMs: 6, endMs: 5 }, S), Error);
});

test("граница принадлежит начинающейся смене", () => {
  assert.equal(shiftOf(msk(28, 8), S).shiftNo, 1);
  assert.equal(shiftOf(msk(28, 20), S).shiftNo, 2);
  assert.equal(shiftOf(msk(28, 7, 59), S).shiftNo, 2);
  const a = shiftOf(msk(28, 8), S);
  assert.equal(a.startMs, msk(28, 8));
  assert.equal(a.endMs, msk(28, 20));
});

test("сутки для 02:00 при расписании по умолчанию — предыдущая дата; ISO-строка на входе", () => {
  assert.equal(shiftOf(msk(29, 2), S).day, "2026-09-28");
  assert.equal(shiftOf("2026-09-29T02:00:00+03:00", S).day, "2026-09-28");
  assert.equal(shiftOf("2026-09-28T23:00:00Z", S).day, "2026-09-28"); // 02:00 МСК 29.09
});

test("три смены 07:00, 15:00, 23:00", () => {
  const S3 = { tzOffsetMinutes: 180, shifts: [{ no: 1, start: "07:00" }, { no: 2, start: "15:00" }, { no: 3, start: "23:00" }] };
  const a = shiftOf(msk(29, 2), S3);
  assert.equal(a.day, "2026-09-28");
  assert.equal(a.shiftNo, 3);
  assert.equal(a.endMs, msk(29, 7));
  const b = shiftOf(msk(28, 23, 30), S3);
  assert.equal(b.day, "2026-09-28");
  assert.equal(b.shiftNo, 3);
  assert.equal(shiftOf(msk(28, 15), S3).shiftNo, 2);
});

test("buildDowntimes: stop, reason, split, start — два отрезка одного простоя", () => {
  const ev = [
    { id: "e1", type: "stop", at: msk(28, 10), downtimeId: "d1", crewId: "c1", node: "стан" },
    { id: "e2", type: "reason", at: msk(28, 10, 5), downtimeId: "d1", reason: "R1" },
    { id: "e3", type: "split", at: msk(28, 10, 30), downtimeId: "d1", reason: "R2" },
    { id: "e4", type: "start", at: msk(28, 11), downtimeId: "d1" },
  ];
  const r = buildDowntimes(ev, msk(28, 12));
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments.map((s) => [s.index, s.reason]), [[0, "R1"], [1, "R2"]]);
  const sum = r.segments.reduce((a, s) => a + (s.endMs - s.startMs) / 60000, 0);
  assert.equal(sum, 60);
  assert.equal(r.open, null);
  assert.deepEqual(r.ignored, []);
});

test("buildDowntimes: двойной stop и start без простоя попадают в ignored", () => {
  const ev = [
    { id: "a", type: "start", at: msk(28, 9) },
    { id: "b", type: "stop", at: msk(28, 10), downtimeId: "d1" },
    { id: "c", type: "stop", at: msk(28, 10, 10), downtimeId: "d2" },
    { id: "d", type: "start", at: msk(28, 10, 20) },
  ];
  const r = buildDowntimes(ev, msk(28, 12));
  assert.deepEqual(r.ignored, ["a", "c"]);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].reason, null);
});

test("buildDowntimes: незакрытый простой open, конец = nowMs; manual", () => {
  const now = msk(28, 12);
  const r = buildDowntimes([
    { id: "m", type: "manual", from: msk(28, 8), to: msk(28, 9), reason: "R1" },
    { id: "s", type: "stop", at: msk(28, 11), downtimeId: "d1" },
  ], now);
  assert.equal(r.open.open, true);
  assert.equal(r.open.endMs, now);
  assert.equal(r.segments[0].manual, true);
  assert.equal(r.segments[1].manual, false);
});

test("buildDowntimes: fix меняет закрытый отрезок и не трогает непереданные поля", () => {
  const r = buildDowntimes([
    { id: "s", type: "stop", at: msk(28, 10), downtimeId: "d1", reason: "R1", node: "клети", billet: 2, note: "до" },
    { id: "e", type: "start", at: msk(28, 10, 30), downtimeId: "d1" },
    { id: "f", type: "fix", at: msk(28, 10, 40), downtimeId: "d1", index: 0, reason: "R2", note: "после" },
  ], msk(28, 12));
  assert.equal(r.segments[0].reason, "R2");
  assert.equal(r.segments[0].node, "клети");
  assert.equal(r.segments[0].billet, 2);
  assert.equal(r.segments[0].note, "после");
  assert.deepEqual(r.ignored, []);
});

test("buildDowntimes: fix неизвестного отрезка и reason без цели попадают в ignored", () => {
  const r = buildDowntimes([
    { id: "s", type: "stop", at: msk(28, 10), downtimeId: "d1" },
    { id: "e", type: "start", at: msk(28, 10, 30), downtimeId: "d1" },
    { id: "f", type: "fix", at: msk(28, 10, 40), downtimeId: "d1", index: 1, reason: "R2" },
    { id: "r", type: "reason", at: msk(28, 10, 41), downtimeId: "нет", reason: "R3" },
  ], msk(28, 12));
  assert.deepEqual(r.ignored, ["f", "r"]);
});

test("buildDowntimes: reason после закрытия применяется к последнему отрезку простоя", () => {
  const r = buildDowntimes([
    { id: "s", type: "stop", at: msk(28, 10), downtimeId: "d1" },
    { id: "sp", type: "split", at: msk(28, 10, 10), downtimeId: "d1", reason: "R1" },
    { id: "e", type: "start", at: msk(28, 10, 30), downtimeId: "d1" },
    { id: "r", type: "reason", at: msk(28, 10, 40), downtimeId: "d1", reason: "R2" },
  ], msk(28, 12));
  assert.deepEqual(r.segments.map((s) => [s.index, s.reason, s.billet, s.note]), [
    [0, null, null, null],
    [1, "R2", null, null],
  ]);
});

const refs = { reasons: { R1: { group: "Механика", planned: false }, P1: { group: "Плановые", planned: true } } };
const settings = { shortStopMinutes: 5 };

test("classify", () => {
  const seg = (min, reason) => ({ startMs: 0, endMs: min * 60000, reason });
  assert.deepEqual(classify(seg(3, null), refs, settings), { mode: "short", group: "Без причины" });
  assert.deepEqual(classify(seg(10, null), refs, settings), { mode: "unplanned", group: "Без причины" });
  assert.deepEqual(classify(seg(3, "R1"), refs, settings), { mode: "unplanned", group: "Механика" });
  assert.deepEqual(classify(seg(30, "P1"), refs, settings), { mode: "planned", group: "Плановые" });
  assert.deepEqual(classify(seg(30, "ZZ"), refs, settings), { mode: "unplanned", group: "Не из классификатора" });
});

test("summarizeDay: byReason сходится с простоями; смена без данных", () => {
  const segs = [
    { startMs: msk(28, 19, 40), endMs: msk(28, 20, 25), reason: "R1" },
    { startMs: msk(28, 9), endMs: msk(28, 10), reason: "P1" },
    { startMs: msk(28, 11), endMs: msk(28, 11, 3), reason: null },
  ];
  const parts = segs.flatMap((s) => splitByShifts(s, S)).map((p) => ({ ...p, ...classify(p, refs, settings) }));
  const shiftsOfDay = [
    { shiftNo: 1, startMs: msk(28, 8), endMs: msk(28, 20) },
    { shiftNo: 2, startMs: msk(28, 20), endMs: msk(29, 8) },
  ];
  const r = summarizeDay(parts, shiftsOfDay, { 1: true, 2: false });
  const byReasonSum = r.byReason.reduce((a, x) => a + x.minutes, 0);
  assert.equal(byReasonSum, 45 + 60 + 3);
  assert.equal(byReasonSum, r.day.plannedMinutes + r.day.unplannedMinutes + r.day.shortMinutes);
  assert.equal(r.byReason[0].minutes, 60);
  assert.equal(r.day.stops, 3); // продолженная часть не считается новой остановкой
  assert.equal(r.shifts[0].workMinutes, 720 - 20 - 60 - 3);

  const empty = summarizeDay([], shiftsOfDay, { 1: true, 2: false });
  assert.equal(empty.shifts[1].hasData, false);
  assert.equal(empty.shifts[1].workMinutes, null);
  assert.equal(empty.shifts[0].workMinutes, 720);
  assert.equal(empty.day.workMinutes, 720); // смена без данных не считается работой
  const none = summarizeDay([], shiftsOfDay, {});
  assert.equal(none.day.hasData, false);
  assert.equal(none.day.workMinutes, null);
});

test("workIntervals: дополнение простоев, слияние пересечений", () => {
  const shift = { startMs: msk(28, 8), endMs: msk(28, 20) };
  const parts = [
    { startMs: msk(28, 7), endMs: msk(28, 9) },
    { startMs: msk(28, 8, 30), endMs: msk(28, 10) },
    { startMs: msk(28, 19), endMs: msk(28, 21) },
  ];
  const w = workIntervals(parts, shift);
  assert.deepEqual(w.map((x) => [x.startMs, x.endMs, x.minutes]), [[msk(28, 10), msk(28, 19), 540]]);
  assert.deepEqual(workIntervals([], shift).map((x) => x.minutes), [720]);
});

test("buildDowntimes: reason сохраняет текст рабочего", () => {
  const r = buildDowntimes([
    { id: "a", type: "stop", at: "2026-09-28T10:00:00+03:00", downtimeId: "d" },
    { id: "b", type: "reason", at: "2026-09-28T10:01:00+03:00", downtimeId: "d", reason: "avaria", note: "датчик на ножницах глючит" },
    { id: "c", type: "start", at: "2026-09-28T10:15:00+03:00", downtimeId: "d" },
  ], Date.parse("2026-09-28T12:00:00+03:00"));
  assert.equal(r.segments[0].reason, "avaria");
  assert.equal(r.segments[0].note, "датчик на ножницах глючит");
});

test("buildDowntimes: start сохраняет, что сделали для пуска", () => {
  const r = buildDowntimes([
    { id: "a", type: "stop", at: "2026-09-28T10:00:00+03:00", downtimeId: "d" },
    { id: "b", type: "reason", at: "2026-09-28T10:14:00+03:00", downtimeId: "d", reason: "avaria", note: "ножи тупые" },
    { id: "c", type: "start", at: "2026-09-28T10:14:00+03:00", downtimeId: "d", action: "заменили ножи" },
  ], Date.parse("2026-09-28T12:00:00+03:00"));
  assert.equal(r.segments[0].action, "заменили ножи");
  assert.equal(r.segments[0].note, "ножи тупые");
  assert.equal(r.segments[0].endMs, Date.parse("2026-09-28T10:14:00+03:00"));
});

test("buildDowntimes: action из shift_close не попадает в простой", () => {
  const events = [
    { id: "a", type: "stop", at: "2026-09-28T10:00:00+03:00", downtimeId: "d", reason: "avaria" },
    { id: "b", type: "shift_close", at: "2026-09-28T19:50:00+03:00", crewId: "1", action: "сняли редуктор, ждём подшипник", note: "Стан стоит." },
  ];
  // Простой ещё открыт: передача смены его не закрывает и текст в него не пишет
  const open = buildDowntimes(events, Date.parse("2026-09-28T21:00:00+03:00"));
  assert.equal(open.open?.downtimeId, "d");
  assert.equal(open.segments.length, 1);
  assert.equal(open.segments[0].action, null);
  assert.equal(open.segments[0].note, null);
  assert.deepEqual(open.ignored, ["b"]);
  // После пуска у простоя только то, что сказано в start
  const closed = buildDowntimes([
    ...events,
    { id: "c", type: "start", at: "2026-09-29T09:00:00+03:00", downtimeId: "d", action: "заменили подшипник" },
  ], Date.parse("2026-09-29T12:00:00+03:00"));
  assert.equal(closed.segments.length, 1);
  assert.equal(closed.segments[0].action, "заменили подшипник");
  assert.equal(closed.segments[0].note, null);
});

test("handoversSince: сдачи смены не раньше начала простоя, по возрастанию времени", () => {
  const events = [
    { id: "x0", type: "shift_close", at: "2026-09-28T08:00:00+03:00", crewId: "1", action: "до простоя" },
    { id: "s", type: "stop", at: "2026-09-28T10:00:00+03:00", downtimeId: "d" },
    { id: "x2", type: "shift_close", at: "2026-09-29T08:00:00+03:00", crewId: "2", personId: "p4", action: "ждём подшипник", note: "Стан стоит." },
    { id: "x1", type: "shift_close", at: "2026-09-28T20:00:00+03:00", crewId: "1", personId: "p1" },
    { id: "o", type: "shift_open", at: "2026-09-28T20:05:00+03:00", crewId: "2", personId: "p4" },
  ];
  const list = handoversSince(events, msk(28, 10));
  assert.deepEqual(list.map((x) => x.crewId), ["1", "2"]);
  assert.deepEqual(list[0], { at: "2026-09-28T20:00:00+03:00", crewId: "1", personId: "p1", personName: null, action: null, note: null });
  assert.equal(list[1].action, "ждём подшипник");
  assert.deepEqual(handoversSince(events, msk(30, 0)), []);
});

test("старые коды классификатора читаются как три нынешние причины", () => {
  assert.equal(reasonKey("П-05"), "perevalka");
  assert.equal(reasonKey("В-М-01"), "avaria");
  assert.equal(reasonKey("В-Э-99"), "avaria");
  assert.equal(reasonKey("В-В-02"), "avaria");
  assert.equal(reasonKey("В-Т-01"), "burezhka");
  assert.equal(reasonKey("В-О-03"), "burezhka");
  assert.equal(reasonKey("burezhka"), "burezhka");
  assert.equal(reasonKey(null), null);
  const built = buildDowntimes([
    { id: "s", type: "stop", at: "2026-09-28T10:00:00+03:00", downtimeId: "d1", reason: "В-М-02" },
    { id: "e", type: "start", at: "2026-09-28T10:30:00+03:00", downtimeId: "d1" },
  ], "2026-09-28T11:00:00+03:00");
  assert.equal(built.segments[0].reason, "avaria");
});
