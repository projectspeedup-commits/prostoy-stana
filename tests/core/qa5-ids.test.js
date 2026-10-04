import { test } from "node:test";
import assert from "node:assert/strict";
import { eventInputError, eventTimeError, buildDowntimes } from "../../app/core/core.js";

const NOW = Date.parse("2026-10-04T15:00:00Z");
const iso = (s) => new Date(Date.parse(s)).toISOString();
const manual = (id, from, to, downtimeId) => ({ id, type: "manual", at: iso(to), from: iso(from), to: iso(to), reason: "avaria", ...(downtimeId !== undefined ? { downtimeId } : {}) });

test("manual с downtimeId, занятым другим ручным простоем, отклоняется duplicate_downtime", () => {
  const first = manual("m1", "2026-10-04T14:01:00Z", "2026-10-04T14:02:00Z", "shared");
  assert.equal(eventTimeError([], first, NOW), "");
  const second = manual("m2", "2026-10-04T14:02:00Z", "2026-10-04T14:03:00Z", "shared");
  assert.equal(eventTimeError([first], second, NOW), "duplicate_downtime");
  // без своего downtimeId номер — event.id; чужой простой с таким номером тоже занят
  const stop = { id: "x", type: "stop", at: iso("2026-10-04T13:00:00Z"), downtimeId: "z" };
  const start = { id: "y", type: "start", at: iso("2026-10-04T13:10:00Z"), downtimeId: "z" };
  assert.equal(eventTimeError([stop, start], manual("z", "2026-10-04T14:00:00Z", "2026-10-04T14:05:00Z"), NOW), "duplicate_downtime");
});

test("manual с номером открытого простоя отклоняется duplicate_downtime", () => {
  const stop = { id: "s", type: "stop", at: iso("2026-10-04T14:30:00Z"), downtimeId: "open1" };
  assert.equal(eventTimeError([stop], manual("m", "2026-10-04T13:00:00Z", "2026-10-04T13:10:00Z", "open1"), NOW), "duplicate_downtime");
});

test("manual с новым номером и без номера принимается; пересечение по-прежнему overlap", () => {
  const first = manual("m1", "2026-10-04T14:01:00Z", "2026-10-04T14:02:00Z", "a");
  assert.equal(eventTimeError([first], manual("m2", "2026-10-04T14:02:00Z", "2026-10-04T14:03:00Z", "b"), NOW), "");
  assert.equal(eventTimeError([first], manual("m3", "2026-10-04T14:02:00Z", "2026-10-04T14:03:00Z"), NOW), "");
  assert.equal(eventTimeError([first], manual("m4", "2026-10-04T14:01:30Z", "2026-10-04T14:03:00Z", "c"), NOW), "overlap");
  assert.equal(buildDowntimes([first], NOW).segments.length, 1);
});

test("пустой или пробельный downtimeId — bad_request у всех типов; null и отсутствие допустимы", () => {
  const at = iso("2026-10-04T14:00:00Z");
  for (const type of ["stop", "start", "reason", "split", "fix", "manual"]) {
    for (const downtimeId of ["", "   "]) {
      const e = { id: "e", type, at, downtimeId, index: 0, from: at, to: iso("2026-10-04T14:05:00Z") };
      assert.equal(eventInputError(e), "bad_request", `${type} ${JSON.stringify(downtimeId)}`);
    }
  }
  assert.equal(eventInputError({ id: "e", type: "stop", at }), "");
  assert.equal(eventInputError({ id: "e", type: "stop", at, downtimeId: null }), "");
  assert.equal(eventInputError({ id: "e", type: "stop", at, downtimeId: "ok" }), "");
});
