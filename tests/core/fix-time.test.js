// Правка времени простоя через fix { from, to } и простои без причины.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDowntimes, classify, eventInputError, eventTimeError, lastRunningMs, toMs } from "../../app/core/core.js";
import { DEFAULT_REFS } from "../../app/core/refs.js";

const day = "2026-11-20";
const iso = (hm) => `${day}T${hm}:00.000Z`;
const NOW = toMs(iso("15:00"));
let n = 0;
const ev = (type, hm, extra = {}) => ({ id: `e${++n}`, type, at: iso(hm), device: "web", ...extra });
const fix = (hm, extra) => ev("fix", hm, { downtimeId: "a", index: 0, ...extra });

// a: 09:00–09:30, b: 10:00–10:30, c открыт с 14:00
const base = () => [
  ev("stop", "09:00", { downtimeId: "a" }), ev("start", "09:30", { downtimeId: "a" }),
  ev("stop", "10:00", { downtimeId: "b" }), ev("start", "10:30", { downtimeId: "b" }),
  ev("stop", "14:00", { downtimeId: "c" }),
];
const seg = (events, id, index = 0) => buildDowntimes(events, NOW).segments.find((s) => s.downtimeId === id && s.index === index);

test("fix с from и to меняет начало и конец простоя", () => {
  const e = fix("14:50", { from: iso("08:50"), to: iso("09:40") });
  assert.equal(eventInputError(e), "");
  assert.equal(eventTimeError(base(), e, NOW), "");
  const s = seg([...base(), e], "a");
  assert.equal(s.startMs, toMs(iso("08:50")));
  assert.equal(s.endMs, toMs(iso("09:40")));
  assert.equal(buildDowntimes([...base(), e], NOW).ignored.length, 0);
});

test("fix только с from у открытого простоя двигает начало", () => {
  const e = ev("fix", "14:50", { downtimeId: "c", index: 0, from: iso("13:40") });
  assert.equal(eventTimeError(base(), e, NOW), "");
  assert.equal(seg([...base(), e], "c").startMs, toMs(iso("13:40")));
});

test("fix с причиной и временем сразу: причина и время применяются вместе", () => {
  const e = fix("14:50", { reason: "avaria", from: iso("08:55") });
  assert.equal(eventTimeError(base(), e, NOW), "");
  const s = seg([...base(), e], "a");
  assert.equal(s.reason, "avaria");
  assert.equal(s.startMs, toMs(iso("08:55")));
});

test("наложение на соседний простой даёт overlap", () => {
  // конец a сдвигаем за начало b
  assert.equal(eventTimeError(base(), fix("14:50", { to: iso("10:10") }), NOW), "overlap");
  // начало b сдвигаем внутрь a
  const b = ev("fix", "14:50", { downtimeId: "b", index: 0, from: iso("09:10") });
  assert.equal(eventTimeError(base(), b, NOW), "overlap");
  // открытый c сдвигаем на b
  const c = ev("fix", "14:50", { downtimeId: "c", index: 0, from: iso("10:20") });
  assert.equal(eventTimeError(base(), c, NOW), "overlap");
});

test("конец не позже начала — bad_time", () => {
  assert.equal(eventTimeError(base(), fix("14:50", { to: iso("09:00") }), NOW), "bad_time");
  assert.equal(eventTimeError(base(), fix("14:50", { to: iso("08:00") }), NOW), "bad_time");
  assert.equal(eventTimeError(base(), fix("14:50", { from: iso("09:30") }), NOW), "bad_time");
  assert.equal(eventTimeError(base(), fix("14:50", { from: iso("09:45") }), NOW), "bad_time");
  // оба поля вместе: конец раньше начала — ошибка формы
  assert.equal(eventInputError(fix("14:50", { from: iso("09:20"), to: iso("09:10") })), "bad_request");
});

test("to у открытого простоя — bad_time", () => {
  const e = ev("fix", "14:50", { downtimeId: "c", index: 0, to: iso("14:30") });
  assert.equal(eventInputError(e), "");
  assert.equal(eventTimeError(base(), e, NOW), "bad_time");
});

test("to не у последнего отрезка — bad_time, у последнего — принимается", () => {
  const events = [ev("stop", "09:00", { downtimeId: "a" }), ev("split", "09:20", { downtimeId: "a" }),
    ev("start", "09:40", { downtimeId: "a" })];
  const first = { id: "x1", type: "fix", at: iso("14:50"), downtimeId: "a", index: 0, to: iso("09:25") };
  assert.equal(eventTimeError(events, first, NOW), "bad_time");
  const last = { id: "x2", type: "fix", at: iso("14:50"), downtimeId: "a", index: 1, to: iso("09:50") };
  assert.equal(eventTimeError(events, last, NOW), "");
  assert.equal(seg([...events, last], "a", 1).endMs, toMs(iso("09:50")));
  // начало первого отрезка при разрезе должно остаться раньше точки разреза
  const early = { id: "x3", type: "fix", at: iso("14:50"), downtimeId: "a", index: 0, from: iso("09:30") };
  assert.equal(eventTimeError(events, early, NOW), "bad_time");
});

test("from у отрезка с index > 0 — отказ формы", () => {
  const e = { id: "x1", type: "fix", at: iso("14:50"), downtimeId: "a", index: 1, from: iso("09:25") };
  assert.equal(eventInputError(e), "bad_request");
  assert.equal(eventInputError({ ...e, from: "не дата", index: 0 }), "bad_request");
  assert.equal(eventInputError({ ...e, from: 5, index: 0 }), "");
});

test("конец в будущем и начало старше 40 дней — bad_time", () => {
  assert.equal(eventTimeError(base(), fix("14:50", { to: iso("15:30") }), NOW), "bad_time");
  const old = new Date(NOW - 41 * 86400000).toISOString();
  assert.equal(eventTimeError(base(), fix("14:50", { from: old }), NOW), "bad_time");
});

test("stop после сдвинутого назад пуска принимается", () => {
  // пуск a правкой перенесён с 09:30 на 09:10; простой в 09:20 теперь не пересекается
  const events = [...base().slice(0, 2), fix("14:00", { to: iso("09:10") })];
  const stop = ev("stop", "09:20", { downtimeId: "z" });
  assert.equal(eventTimeError(events, stop, NOW), "");
  // а без правки тот же простой пересёкся бы
  assert.equal(eventTimeError(base().slice(0, 2), stop, NOW), "overlap");
});

test("правка начала в прошлое не мешает проверке at < startMs", () => {
  const e = fix("14:50", { from: iso("08:00") });
  assert.equal(eventTimeError(base(), e, NOW), "");
  // повторная правка того же простоя, уже сдвинутого раньше
  const e2 = fix("14:55", { from: iso("07:00") });
  assert.equal(eventTimeError([...base(), e], e2, NOW), "");
});

test("runningSince считается по закрытым отрезкам и учитывает сдвинутый пуск", () => {
  const events = base().slice(0, 2);
  assert.equal(lastRunningMs(events, NOW), toMs(iso("09:30")));
  assert.equal(lastRunningMs([...events, fix("14:00", { to: iso("09:10") })], NOW), toMs(iso("09:10")));
  assert.equal(lastRunningMs([], NOW), null);
});

test("ручной простой без причины принимается; короткий — short, длинный — unplanned «Без причины»", () => {
  const short = ev("manual", "14:50", { downtimeId: "m1", from: iso("11:00"), to: iso("11:03") });
  const long = ev("manual", "14:50", { downtimeId: "m2", from: iso("12:00"), to: iso("12:20") });
  assert.equal(eventInputError(short), "");
  assert.equal(eventTimeError(base(), short, NOW), "");
  const built = buildDowntimes([...base(), short, long], NOW);
  const refs = { ...DEFAULT_REFS };
  const c1 = classify(built.segments.find((s) => s.downtimeId === "m1"), refs, refs.settings);
  const c2 = classify(built.segments.find((s) => s.downtimeId === "m2"), refs, refs.settings);
  assert.deepEqual(c1, { mode: "short", group: "Без причины" });
  assert.deepEqual(c2, { mode: "unplanned", group: "Без причины" });
});

test("остановка и пуск без причины и без остальных полей принимаются", () => {
  const events = [ev("stop", "09:00", { downtimeId: "a" })];
  assert.equal(eventTimeError(events, ev("start", "09:12", { downtimeId: "a" }), NOW), "");
  const s = seg([...events, ev("start", "09:12", { downtimeId: "a" })], "a");
  assert.equal(s.reason, null);
  assert.equal(s.endMs, toMs(iso("09:12")));
});
