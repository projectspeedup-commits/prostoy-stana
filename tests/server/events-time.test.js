import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createEventStore } from "../../app/server/events.js";
import { DEFAULT_SCHEDULE } from "../../app/core/core.js";

const NOW = Date.parse("2026-01-02T12:00:00Z");
const refs = { settings: { schedule: DEFAULT_SCHEDULE, shortStopMinutes: 5 }, reasons: {} };
const at = (time) => `2026-01-02T${time}:00Z`;
const event = (id, type, time, downtimeId = "d1") => ({ id, type, at: at(time), downtimeId });

// Проверяем настоящее хранилище SQLite, без запуска HTTP-сервера.
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE pings (server_at TEXT)");
  t.after(() => db.close());
  const store = createEventStore(db);
  return {
    save: (...events) => {
      const r = store.save(events, NOW, "test");
      // Здесь проверяем исход/код; содержимое конфликта проверяется в round2/data.test.js.
      return { ...r, rejected: r.rejected.map(({ conflict, ...entry }) => entry) };
    },
    state: () => store.state(NOW, refs),
  };
}

test("stop в прошлом после последнего пуска открывает простой выбранным временем", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"), event("r1", "start", "10:00"));
  assert.deepEqual(s.save(event("s2", "stop", "11:00", "d2")), { saved: ["s2"], rejected: [] });
  assert.equal(s.state().running, false);
  assert.equal(s.state().open.startMs, Date.parse(at("11:00")));
});

test("stop раньше записанного закрытого простоя отклоняется как overlap", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"), event("r1", "start", "10:00"));
  assert.deepEqual(s.save(event("s2", "stop", "08:30", "d2")), {
    saved: [], rejected: [{ id: "s2", error: "overlap" }],
  });
  assert.equal(s.state().running, true);
  assert.equal(s.state().segments.length, 1);
});

test("start без открытого простоя отклоняется, не меняя историю", (t) => {
  const s = fixture(t);
  assert.deepEqual(s.save(event("r1", "start", "10:00")), { saved: [], rejected: [{ id: "r1", error: "not_open" }] });
  assert.deepEqual(s.save(event("s1", "stop", "09:00")), { saved: ["s1"], rejected: [] });
});

test("start в прошлом после смены причины закрывает простой выбранным временем", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"), { ...event("split", "split", "10:00"), reason: "В-М-01" });
  assert.deepEqual(s.save({ ...event("r1", "start", "11:00"), action: "заменили подшипник" }), {
    saved: ["r1"], rejected: [],
  });
  const state = s.state();
  assert.equal(state.running, true);
  assert.equal(state.open, null);
  assert.equal(state.segments.at(-1).endMs, Date.parse(at("11:00")));
  assert.equal(state.segments.at(-1).action, "заменили подшипник");
});

test("start раньше остановки отклоняется как bad_time", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "10:00"));
  assert.deepEqual(s.save(event("r1", "start", "09:00")), {
    saved: [], rejected: [{ id: "r1", error: "bad_time" }],
  });
  assert.equal(s.state().open.startMs, Date.parse(at("10:00")));
});

test("start раньше последней смены причины отклоняется как bad_time", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"), event("split", "split", "10:30"));
  assert.deepEqual(s.save(event("r1", "start", "10:00")), {
    saved: [], rejected: [{ id: "r1", error: "bad_time" }],
  });
  assert.equal(s.state().open.segments.at(-1).startMs, Date.parse(at("10:30")));
});

test("stop внутри открытого — already_stopped с номером открытого, раньше его начала или внутри закрытого — overlap", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"));
  const inside = s.save(event("s2", "stop", "09:30", "d2"));
  assert.deepEqual(inside.saved, []);
  assert.equal(inside.rejected[0].error, "already_stopped");
  assert.equal(inside.rejected[0].downtimeId, "d1");
  assert.deepEqual(s.save(event("s0", "stop", "08:30", "d0")), { saved: [], rejected: [{ id: "s0", error: "overlap" }] });
  s.save(event("r1", "start", "10:00"));
  assert.deepEqual(s.save(event("s3", "stop", "09:30", "d3")), { saved: [], rejected: [{ id: "s3", error: "overlap" }] });
});

test("stop раньше конца ручного простоя отклоняется как overlap", (t) => {
  const s = fixture(t);
  s.save({ ...event("manual", "manual", "11:00"), from: at("09:00"), to: at("10:00") });
  assert.deepEqual(s.save(event("s1", "stop", "09:30", "d2")), {
    saved: [], rejected: [{ id: "s1", error: "overlap" }],
  });
});

test("точная граница разрешена, повтор принятого ID не меняет историю", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"), event("r1", "start", "10:00"));
  const stop = event("s2", "stop", "10:00", "d2");
  assert.deepEqual(s.save(stop), { saved: ["s2"], rejected: [] });
  assert.deepEqual(s.save(event("r2", "start", "10:00", "d2")), { saved: ["r2"], rejected: [] });
  assert.deepEqual(s.save(stop), { saved: ["s2"], rejected: [] });
  assert.equal(s.state().running, true);
});

test("состояние хранит время пуска прошлой смены для проверки забытой остановки", (t) => {
  const s = fixture(t);
  s.save(
    { id: "s1", type: "stop", at: "2026-01-01T18:00:00Z", downtimeId: "d1" },
    { id: "r1", type: "start", at: "2026-01-01T19:00:00Z", downtimeId: "d1" },
  );
  assert.equal(s.state().segments.length, 0);
  assert.equal(s.state().runningSinceMs, Date.parse("2026-01-01T19:00:00Z"));
});

test("stop с уже использованным downtimeId закрытого простоя отклоняется как duplicate_downtime", (t) => {
  const s = fixture(t);
  s.save(event("a1", "stop", "08:00", "same"), event("a2", "start", "08:05", "same"));
  assert.deepEqual(s.save(event("b1", "stop", "09:00", "same")), { saved: [], rejected: [{ id: "b1", error: "duplicate_downtime" }] });
  // повтор того же события — идемпотентно
  assert.deepEqual(s.save(event("a1", "stop", "08:00", "same")), { saved: ["a1"], rejected: [] });
  assert.equal(s.state().running, true);
  // новый id — нормально
  assert.deepEqual(s.save(event("c1", "stop", "10:00", "other")), { saved: ["c1"], rejected: [] });
});

test("fix с from/to двигает простой, отказывает на наложении и будущем, stop принимается после сдвинутого пуска", (t) => {
  const s = fixture(t);
  const fix = (id, time, extra, downtimeId = "d1", index = 0) => ({ id, type: "fix", at: at(time), downtimeId, index, ...extra });
  s.save(event("s1", "stop", "09:00"), event("r1", "start", "10:00"), event("s2", "stop", "10:30", "d2"), event("r2", "start", "10:50", "d2"));
  // конец d1 заходит на d2
  assert.deepEqual(s.save(fix("x1", "11:00", { to: at("10:40") })).rejected, [{ id: "x1", error: "overlap" }]);
  // конец в будущем (сейчас 12:00)
  assert.deepEqual(s.save(fix("x2", "11:00", { to: at("13:00") })).rejected, [{ id: "x2", error: "bad_time" }]);
  // to у отрезка с index > 0 или начало у index > 0 — форма неверна
  assert.deepEqual(s.save(fix("x3", "11:00", { from: at("08:50") }, "d1", 1)).rejected, [{ id: "x3", error: "bad_request" }]);
  // верная правка: d1 теперь 08:50–09:40
  assert.deepEqual(s.save(fix("x4", "11:00", { from: at("08:50"), to: at("09:40") })), { saved: ["x4"], rejected: [] });
  const d1 = s.state().segments.find((x) => x.downtimeId === "d1");
  assert.equal(d1.startMs, Date.parse(at("08:50"))); assert.equal(d1.endMs, Date.parse(at("09:40")));
  // runningSinceMs — конец последнего закрытого отрезка
  assert.equal(s.state().runningSinceMs, Date.parse(at("10:50")));
});

test("stop между сдвинутым назад пуском и прежним пуском принимается (раньше был бы overlap)", (t) => {
  const s = fixture(t);
  s.save(event("s1", "stop", "09:00"), event("r1", "start", "10:00"));
  assert.deepEqual(s.save(event("s2", "stop", "09:50", "d2")).rejected, [{ id: "s2", error: "overlap" }]);
  assert.deepEqual(s.save({ id: "x1", type: "fix", at: at("11:00"), downtimeId: "d1", index: 0, to: at("09:40") }), { saved: ["x1"], rejected: [] });
  assert.deepEqual(s.save(event("s3", "stop", "09:50", "d3"), event("r3", "start", "10:10", "d3")), { saved: ["s3", "r3"], rejected: [] });
  assert.equal(s.state().runningSinceMs, Date.parse(at("10:10")));
});
