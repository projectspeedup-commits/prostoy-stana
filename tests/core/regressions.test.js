import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDowntimes, periodParts, shiftOf, summarizeDay, DEFAULT_SCHEDULE } from '../../app/core/core.js';
import { computeStats, periodRange } from '../../app/core/stats.js';
const nowMs = Date.parse('2026-10-01T12:00:00Z');
const refs = { reasons: { p: { planned: true }, u: { planned: false } }, settings: { schedule: DEFAULT_SCHEDULE, shortStopMinutes: 5 } };
const shift = shiftOf(nowMs, DEFAULT_SCHEDULE);
const manual = (id, startMs, duration, reason = null) => ({ id, type: 'manual', at: startMs + duration, from: startMs, to: startMs + duration, reason });

test('P2: три простоя по 20 с — одна минута во всех сводках; работа только до сейчас', () => {
  const events = [{ id: 'crew', type: 'shift_open', at: shift.startMs }, ...[0, 1, 2].map((i) => manual(`m${i}`, shift.startMs + i * 60000, 20000))];
  const built = buildDowntimes(events, nowMs);
  const parts = periodParts(built.segments, shift.startMs, nowMs, refs);
  const summary = summarizeDay(parts, [shift], { [shift.shiftNo]: true }, { nowMs, dataFromMs: shift.startMs });
  const stats = computeStats(events, { ...periodRange('shift', nowMs, DEFAULT_SCHEDULE), nowMs, refs });
  assert.equal(summary.day.downMinutes, 1);
  assert.equal(summary.day.stops, 3);
  assert.equal(summary.day.downMinutes, stats.downMin);
  assert.equal(summary.day.workMinutes, stats.workMin);
  assert.equal(summary.day.totalMinutes, 420);
});

test('P2: смена причины не удваивает остановку, округление категорий сохраняет сумму', () => {
  const events = [{ id: 's', type: 'stop', at: shift.startMs, reason: 'p' },
    { id: 'split', type: 'split', at: shift.startMs + 20000, reason: 'u' },
    { id: 'r', type: 'start', at: shift.startMs + 40000 }];
  const parts = periodParts(buildDowntimes(events, nowMs).segments, shift.startMs, nowMs, refs);
  const summary = summarizeDay(parts, [shift], {}, { nowMs });
  const stats = computeStats(events, { fromMs: shift.startMs, toMs: nowMs, nowMs, refs });
  assert.equal(summary.day.stops, 1);
  assert.equal(summary.day.downMinutes, 1);
  assert.equal(summary.day.plannedMinutes + summary.day.unplannedMinutes + summary.day.shortMinutes, 1);
  assert.equal(summary.day.plannedMinutes, stats.plannedMin);
  assert.equal(summary.day.unplannedMinutes, stats.unplannedMin);
});

test('P2: категория по полному простою, даже при двух причинах и обрезке до минуты', () => {
  const events = [{ id: 's', type: 'stop', at: shift.startMs - 10 * 60000 },
    { id: 'split', type: 'split', at: shift.startMs - 30000 },
    { id: 'r', type: 'start', at: shift.startMs + 30000 }];
  const stats = computeStats(events, { fromMs: shift.startMs, toMs: nowMs, nowMs, refs });
  const parts = periodParts(buildDowntimes(events, nowMs).segments, shift.startMs, nowMs, refs);
  assert.equal(stats.shortMin, 0);
  assert.equal(stats.unplannedStops, 1);
  assert.equal(parts[0].mode, 'unplanned');
});
