// Метрики простоев за производственный период. Работает и в браузере, и в Node.
import { apportionMinutes, buildDowntimes, classify, shiftOf, toMs, withDowntimeDuration } from "./core.js";
import { zoneOf } from "./zones.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NO_REASON_TITLE = "Без причины";

function firstShiftStart(day, schedule) {
  const start = schedule.shifts?.[0]?.start;
  if (!start) throw new Error("В расписании нет смен");
  const tz = schedule.tzOffsetMinutes || 0;
  const sign = tz >= 0 ? "+" : "-";
  const off = Math.abs(tz);
  const zone = `${sign}${String(Math.floor(off / 60)).padStart(2, "0")}:${String(off % 60).padStart(2, "0")}`;
  return toMs(`${day}T${start}:00${zone}`);
}

function localDate(ms, schedule) {
  return new Date(ms + (schedule.tzOffsetMinutes || 0) * MINUTE).toISOString().slice(0, 10);
}

function nextMonthDay(day) {
  const [year, month] = day.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

function clippedSegments(segments, fromMs, toMs, refs) {
  return segments.flatMap((segment) => {
    const startMs = Math.max(segment.startMs, fromMs);
    const endMs = Math.min(segment.endMs, toMs);
    if (endMs <= startMs) return [];
    const clipped = { ...segment, startMs, endMs };
    return [{ ...clipped, ...classify(segment, refs, refs.settings) }];
  });
}

function minutes(ms) {
  return Math.round(ms / MINUTE);
}

function compareRows(a, b, first) {
  return b.minutes - a.minutes || String(a[first]).localeCompare(String(b[first]));
}

function downtimeMap(segments) {
  const map = new Map();
  for (const segment of segments) {
    const key = segment.downtimeId;
    let row = map.get(key);
    if (!row) {
      row = { downtimeId: key, startMs: segment.startMs, crewId: segment.crewId ?? null, segments: [] };
      map.set(key, row);
    }
    if (segment.startMs < row.startMs) {
      row.startMs = segment.startMs;
      row.crewId = segment.crewId ?? null;
    }
    row.segments.push(segment);
  }
  return map;
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Дежурство бригады: с её shift_open до ближайшего из — следующий приём смены,
// следующая сдача смены, конец производственной смены, в которой был приём
function dutyIntervals(events, schedule) {
  const timed = [];
  events.forEach((e, index) => {
    if (e.type !== "shift_open" && e.type !== "shift_close") return;
    try { timed.push({ e, index, t: toMsValue(e.at) }); } catch { /* пропускаем битое время */ }
  });
  timed.sort((a, b) => a.t - b.t || a.index - b.index);
  const duties = [];
  timed.forEach(({ e, t }, i) => {
    if (e.type !== "shift_open") return;
    const next = timed[i + 1];
    const endMs = Math.min(next ? next.t : Infinity, shiftOf(t, schedule).endMs);
    if (endMs > t) duties.push({ startMs: t, endMs, crewId: e.crewId ?? null });
  });
  return duties;
}

// Режет отрезок простоя по дежурствам: кусок в дежурстве — дежурной бригаде,
// кусок вне любого дежурства — запасной (той, что нажала «Стан встал»)
function cutByDuty(segment, duties, fallbackCrew) {
  const pieces = [];
  const push = (crewId, fromMs, endMs, duty) => {
    if (endMs > fromMs) pieces.push({ crewId, ms: endMs - fromMs, duty });
  };
  let cur = segment.startMs;
  for (const duty of duties) {
    if (duty.endMs <= cur) continue;
    if (duty.startMs >= segment.endMs) break;
    push(fallbackCrew, cur, duty.startMs, false);
    const endMs = Math.min(duty.endMs, segment.endMs);
    push(duty.crewId, Math.max(cur, duty.startMs), endMs, true);
    cur = endMs;
  }
  push(fallbackCrew, cur, segment.endMs, false);
  return pieces;
}

/** Границы запрошенного периода по производственному расписанию. */
export function periodRange(period, nowMs, schedule) {
  const now = toMs(nowMs);
  const shift = shiftOf(now, schedule);
  const dayStart = firstShiftStart(shift.day, schedule);
  let fromMs;
  let endMs;
  let label;
  if (period === "shift") {
    fromMs = shift.startMs;
    endMs = shift.endMs;
    label = "Текущая смена";
  } else if (period === "day") {
    fromMs = dayStart;
    endMs = dayStart + DAY;
    label = "Сутки";
  } else if (period === "week") {
    fromMs = dayStart - 6 * DAY;
    endMs = dayStart + DAY;
    label = "7 суток";
  } else if (period === "month") {
    // Месяц — по производственным суткам: 1-го числа до 08:00 ещё идут сутки прошлого месяца
    const monthStart = `${shift.day.slice(0, 7)}-01`;
    fromMs = firstShiftStart(monthStart, schedule);
    endMs = firstShiftStart(nextMonthDay(monthStart), schedule);
    label = "Месяц";
  } else {
    throw new Error("Неизвестный период");
  }
  return { fromMs, toMs: Math.min(endMs, now), label };
}

/** Рассчитывает метрики по отрезку [fromMs, toMs). */
export function computeStats(events, { fromMs, toMs, nowMs, refs }) {
  const from = toMsValue(fromMs);
  const now = toMsValue(nowMs);
  const to = Math.min(toMsValue(toMs), now);
  if (to < from) throw new Error("Некорректный период");
  const built = buildDowntimes(events, now);
  built.segments = withDowntimeDuration(built.segments);
  // Учёт начинается с первого события: раньше данных нет, и считать это время работой нельзя
  let firstAt = Infinity;
  for (const e of events) {
    for (const v of [e.at, e.type === "manual" ? e.from : undefined]) {
      if (v === undefined || v === null) continue;
      try { firstAt = Math.min(firstAt, toMsValue(v)); } catch { /* пропускаем битое время */ }
    }
  }
  const dataFrom = Number.isFinite(firstAt) ? Math.min(Math.max(from, firstAt), to) : to;
  const visible = clippedSegments(built.segments, from, to, refs);
  const visibleByDowntime = downtimeMap(visible);
  const allByDowntime = downtimeMap(built.segments);
  const totalMs = to - dataFrom;
  const downMs = visible.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
  const modeMs = { planned: 0, unplanned: 0, short: 0 };
  for (const segment of visible) modeMs[segment.mode] += segment.endMs - segment.startMs;
  const stops = visibleByDowntime.size;
  const unplannedIds = new Set(visible.filter((segment) => segment.mode === "unplanned").map((segment) => segment.downtimeId));

  const reasonRows = new Map();
  const groupRows = new Map();
  for (const segment of visible) {
    const reason = hasText(segment.reason) ? segment.reason : null;
    const ref = reason ? refs.reasons[reason] : null;
    const reasonKey = JSON.stringify([reason, segment.group, segment.mode]);
    let reasonRow = reasonRows.get(reasonKey);
    if (!reasonRow) {
      reasonRow = { reason, title: reason === null ? NO_REASON_TITLE : ref?.title || reason, group: segment.group, mode: segment.mode, ms: 0, ids: new Set() };
      reasonRows.set(reasonKey, reasonRow);
    }
    reasonRow.ms += segment.endMs - segment.startMs;
    reasonRow.ids.add(segment.downtimeId);
    let groupRow = groupRows.get(segment.group);
    if (!groupRow) {
      groupRow = { group: segment.group, ms: 0, ids: new Set() };
      groupRows.set(segment.group, groupRow);
    }
    groupRow.ms += segment.endMs - segment.startMs;
    groupRow.ids.add(segment.downtimeId);
  }

  // Простой по бригадам: минуты — тому, кто был на посту (дежурство от shift_open),
  // stops — начатые бригадой в периоде, carried — принятые уже стоящими на своём дежурстве
  const duties = dutyIntervals(events, refs.settings.schedule);
  const crewRows = new Map();
  const crewRow = (crewId) => {
    let row = crewRows.get(crewId);
    if (!row) {
      row = { crewId, ms: 0, stops: 0, carried: 0 };
      crewRows.set(crewId, row);
    }
    return row;
  };
  for (const row of visibleByDowntime.values()) {
    const whole = allByDowntime.get(row.downtimeId) || row;
    const stopper = whole.crewId ?? null;
    // Бригада в простое не записана — начавшей считаем ту, что была на посту в момент остановки
    const starter = stopper ?? duties.find((d) => d.startMs <= whole.startMs && whole.startMs < d.endMs)?.crewId ?? null;
    const onDuty = new Set();
    for (const segment of row.segments) {
      for (const piece of cutByDuty(segment, duties, stopper)) {
        crewRow(piece.crewId).ms += piece.ms;
        if (piece.duty) onDuty.add(piece.crewId);
      }
    }
    const startedHere = whole.startMs >= from;
    if (startedHere) crewRow(starter).stops += 1;
    for (const crewId of onDuty) {
      if (!(startedHere && crewId === starter)) crewRow(crewId).carried += 1;
    }
  }

  const days = [];
  if (to > from) {
    const first = shiftOf(from, refs.settings.schedule).day;
    for (let start = firstShiftStart(first, refs.settings.schedule); start < to; start += DAY) {
      const dayTo = Math.min(start + DAY, to);
      if (dayTo <= dataFrom) {
        days.push({ day: localDate(start, refs.settings.schedule), noData: true, workMin: null, downMin: 0, stops: 0 });
        continue;
      }
      const dayFrom = Math.max(start, from, dataFrom);
      const own = clippedSegments(built.segments, dayFrom, dayTo, refs);
      const dayDown = own.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
      days.push({ day: localDate(start, refs.settings.schedule), workMin: minutes(dayTo - dayFrom - dayDown), downMin: minutes(dayDown), stops: new Set(own.map((segment) => segment.downtimeId)).size });
    }
  }

  const otherMs = visible.reduce((sum, segment) => sum + (refs.reasons[segment.reason]?.other ? segment.endMs - segment.startMs : 0), 0);
  let noReason = 0;
  let noAction = 0;
  for (const row of visibleByDowntime.values()) {
    const whole = allByDowntime.get(row.downtimeId) || row;
    if (!whole.segments.some((segment) => hasText(segment.reason))) noReason += 1;
    if (!whole.segments.some((segment) => segment.open) && !whole.segments.some((segment) => hasText(segment.action))) noAction += 1;
  }

  const longest = [...visibleByDowntime.values()].map((row) => {
    const own = [...row.segments].sort((a, b) => a.startMs - b.startMs);
    return { downtimeId: row.downtimeId, ms: own.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0), reason: own[0].reason ?? null, startMs: own[0].startMs };
  }).sort((a, b) => b.ms - a.ms || a.startMs - b.startMs)[0] || null;
  const workMs = Math.max(0, totalMs - downMs);
  const denominator = totalMs - modeMs.planned;
  const rounded = (value) => minutes(value);
  const totalMin = rounded(totalMs);
  const downMin = rounded(downMs);
  const crewList = [...crewRows.values()];
  const crewMinutes = apportionMinutes(crewList.map((row) => row.ms), downMin);
  // Одна остановка считается один раз в каждой затронутой зоне.
  const zoneRows = ["plan", "unplanned", "failure"].map((zone) => {
    const own = visible.filter((segment) => zoneOf(segment.reason, refs) === zone);
    return { zone, ms: own.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0),
      stops: new Set(own.map((segment) => segment.downtimeId)).size };
  });
  const zoneMinutes = apportionMinutes(zoneRows.map((row) => row.ms), downMin);
  const byZone = zoneRows.map((row, i) => ({
    zone: row.zone, minutes: zoneMinutes[i], stops: row.stops, share: totalMs ? row.ms / totalMs : 0,
  }));
  byZone.push({ zone: "work", minutes: Math.max(0, totalMin - downMin), stops: 0,
    share: totalMs ? workMs / totalMs : 0 });
  const reasonList = [...reasonRows.values()], groupList = [...groupRows.values()];
  const reasonMinutes = apportionMinutes(reasonList.map((r) => r.ms), downMin);
  const groupMinutes = apportionMinutes(groupList.map((r) => r.ms), downMin);
  const modeMinutes = apportionMinutes([modeMs.planned, modeMs.unplanned, modeMs.short], downMin);
  return {
    fromMs: from,
    toMs: to,
    dataFromMs: dataFrom,
    noData: dataFrom >= to,
    totalMin,
    workMin: Math.max(0, totalMin - downMin),
    downMin,
    byZone,
    plannedMin: modeMinutes[0],
    unplannedMin: modeMinutes[1],
    shortMin: modeMinutes[2],
    stops,
    unplannedStops: unplannedIds.size,
    availability: denominator > 0 ? Math.max(0, Math.min(1, workMs / denominator)) : null,
    avgStopMin: stops ? rounded(downMs / stops) : null,
    mtbfMin: unplannedIds.size ? rounded(workMs / unplannedIds.size) : null,
    mttrMin: unplannedIds.size ? rounded(modeMs.unplanned / unplannedIds.size) : null,
    longest: longest && { downtimeId: longest.downtimeId, minutes: rounded(longest.ms), reason: longest.reason, startMs: longest.startMs },
    byReason: reasonList.map((row, i) => ({ reason: row.reason, title: row.title, group: row.group, mode: row.mode, minutes: reasonMinutes[i], stops: row.ids.size })).sort((a, b) => compareRows(a, b, "reason")),
    byGroup: groupList.map((row, i) => ({ group: row.group, minutes: groupMinutes[i], stops: row.ids.size })).sort((a, b) => compareRows(a, b, "group")),
    byCrew: crewList.map((row, i) => ({ crewId: row.crewId, minutes: crewMinutes[i], stops: row.stops, carried: row.carried })).sort((a, b) => compareRows(a, b, "crewId")),
    byDay: days,
    quality: { noReason, noAction, otherShare: downMs ? otherMs / downMs : 0 },
  };
}

function toMsValue(value) {
  return toMs(value);
}
