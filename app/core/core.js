// Ядро расчёта простоев стана. Чистая арифметика по UTC-миллисекундам:
// не зависит от часового пояса компьютера, без node:-импортов (работает в браузере и Node).

const MIN = 60000;
const DAY_MIN = 1440;
const DAY_MS = DAY_MIN * MIN;
const NO_REASON_GROUP = "Без причины";
const UNKNOWN_GROUP = "Не из классификатора";

/** Расписание по умолчанию. */
export const DEFAULT_SCHEDULE = {
  tzOffsetMinutes: 180,
  shifts: [
    { no: 1, start: "08:00" },
    { no: 2, start: "20:00" },
  ],
};

/** Момент времени (число мс UTC или ISO 8601) -> мс UTC. Без пояса в строке считаем UTC. */
export function toMs(at) {
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(at.trim());
    if (m) {
      const ms = m[7] ? Math.round(Number("0." + m[7]) * 1000) : 0;
      let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms);
      const z = m[8];
      if (z && z.toUpperCase() !== "Z") {
        const sign = z[0] === "-" ? -1 : 1;
        const digits = z.slice(1).replace(":", "");
        const off = +digits.slice(0, 2) * 60 + +(digits.slice(2) || 0);
        t -= sign * off * MIN;
      }
      return t;
    }
  }
  throw new Error("Некорректный момент времени: " + String(at));
}

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error("Некорректное время начала смены: " + s);
  return +m[1] * 60 + +m[2];
}

function ymd(dayIdx) {
  return new Date(dayIdx * DAY_MS).toISOString().slice(0, 10);
}

/** Смена и производственные сутки для момента. */
export function shiftOf(at, schedule) {
  const tz = schedule.tzOffsetMinutes || 0;
  const shifts = schedule.shifts;
  if (!shifts || !shifts.length) throw new Error("В расписании нет смен");
  const starts = shifts.map((s) => parseHm(s.start));
  const n = shifts.length;
  const t = toMs(at);
  const localMin = Math.floor((t + tz * MIN) / MIN); // минуты от эпохи в поясе расписания
  const dayIdx = Math.floor(localMin / DAY_MIN);
  // Последняя граница смены не позже момента (смотрим вчера и сегодня)
  let best = null;
  for (let d = dayIdx - 1; d <= dayIdx; d++) {
    for (let i = 0; i < n; i++) {
      const b = d * DAY_MIN + starts[i];
      if (b <= localMin && (best === null || b > best.b)) best = { b, i };
    }
  }
  const { b, i } = best;
  const offsetFromFirst = (starts[i] - starts[0] + DAY_MIN) % DAY_MIN;
  const cycleStart = b - offsetFromFirst;
  const len = (starts[(i + 1) % n] - starts[i] + DAY_MIN) % DAY_MIN || DAY_MIN;
  return {
    day: ymd(Math.floor(cycleStart / DAY_MIN)),
    shiftNo: shifts[i].no,
    startMs: b * MIN - tz * MIN,
    endMs: (b + len) * MIN - tz * MIN,
  };
}

/** Разрезает отрезок на части по границам смен. */
export function splitByShifts(segment, schedule) {
  const startMs = toMs(segment.startMs);
  const endMs = toMs(segment.endMs);
  if (!(endMs > startMs)) throw new Error("Конец отрезка должен быть позже начала");
  const parts = [];
  let cur = startMs;
  while (cur < endMs) {
    const sh = shiftOf(cur, schedule);
    const partEnd = Math.min(endMs, sh.endMs);
    parts.push({
      ...segment,
      startMs: cur,
      endMs: partEnd,
      day: sh.day,
      shiftNo: sh.shiftNo,
      minutes: Math.round((partEnd - cur) / MIN),
      continued: parts.length > 0,
    });
    cur = partEnd;
  }
  return parts;
}

/** Собирает отрезки простоя из событий. */
export function buildDowntimes(events, nowMs) {
  const now = toMs(nowMs);
  const sorted = events
    .map((e, i) => ({ e, i, t: toMs(e.at !== undefined && e.at !== null ? e.at : e.from) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const segments = [];
  const ignored = [];
  let cur = null; // единственный открытый отрезок (стан один)

  const val = (v, prev) => (v !== undefined ? v : prev !== undefined ? prev : null);
  const matches = (e) => e.downtimeId === undefined || e.downtimeId === null || e.downtimeId === cur.downtimeId;
  const open = (e, t, downtimeId, index, prev) => ({
    downtimeId,
    index,
    startMs: t,
    endMs: null,
    reason: e.reason !== undefined ? e.reason : null,
    node: val(e.node, prev && prev.node),
    crewId: val(e.crewId, prev && prev.crewId),
    personId: val(e.personId, prev && prev.personId),
    manual: false,
    open: false,
  });
  const close = (t) => {
    cur.endMs = t;
    segments.push(cur);
    cur = null;
  };

  for (const { e, t } of sorted) {
    switch (e.type) {
      case "stop":
        if (cur) ignored.push(e.id);
        else cur = open(e, t, e.downtimeId ?? e.id, 0, null);
        break;
      case "reason":
        if (!cur || !matches(e)) ignored.push(e.id);
        else cur.reason = e.reason !== undefined ? e.reason : null;
        break;
      case "split":
        if (!cur || !matches(e)) ignored.push(e.id);
        else {
          const prev = cur;
          close(t);
          cur = open(e, t, prev.downtimeId, prev.index + 1, prev);
        }
        break;
      case "start":
        if (!cur || !matches(e)) ignored.push(e.id);
        else close(t);
        break;
      case "manual": {
        const from = toMs(e.from);
        const to = toMs(e.to);
        if (!(to > from)) {
          ignored.push(e.id);
          break;
        }
        segments.push({
          downtimeId: e.downtimeId ?? e.id,
          index: 0,
          startMs: from,
          endMs: to,
          reason: e.reason !== undefined ? e.reason : null,
          node: val(e.node),
          crewId: val(e.crewId),
          personId: val(e.personId),
          manual: true,
          open: false,
        });
        break;
      }
      default:
        ignored.push(e.id);
    }
  }
  let openSeg = null;
  if (cur) {
    cur.endMs = Math.max(now, cur.startMs);
    cur.open = true;
    openSeg = cur;
    segments.push(cur);
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.index - b.index);
  return { segments, ignored, open: openSeg };
}

/** Режим и группа отрезка. */
export function classify(segment, refs, settings) {
  const reason = segment.reason;
  const hasReason = reason !== null && reason !== undefined && reason !== "";
  const minutes = (segment.endMs - segment.startMs) / MIN;
  const ref = hasReason ? refs.reasons[reason] : undefined;
  let mode;
  if (!hasReason && minutes < settings.shortStopMinutes) mode = "short";
  else if (ref && ref.planned) mode = "planned";
  else mode = "unplanned";
  const group = !hasReason ? NO_REASON_GROUP : ref ? ref.group : UNKNOWN_GROUP;
  return { mode, group };
}

function emptySums() {
  return { totalMinutes: 0, plannedMinutes: 0, unplannedMinutes: 0, shortMinutes: 0, workMinutes: 0, stops: 0 };
}

function addPart(sums, p) {
  if (p.mode === "planned") sums.plannedMinutes += p.minutes;
  else if (p.mode === "short") sums.shortMinutes += p.minutes;
  else sums.unplannedMinutes += p.minutes;
  if (p.continued !== true) sums.stops += 1;
}

/** Сводка производственных суток. */
export function summarizeDay(parts, shiftsOfDay, signals) {
  const sig = signals || {};
  const shifts = shiftsOfDay.map((sh) => {
    const own = parts.filter((p) => p.shiftNo === sh.shiftNo);
    // Данные есть, если был сигнал/событие; наличие простоя само по себе есть событие
    const hasData = sig[sh.shiftNo] === true || own.length > 0;
    const s = { shiftNo: sh.shiftNo, hasData, ...emptySums() };
    s.totalMinutes = Math.round((sh.endMs - sh.startMs) / MIN);
    for (const p of own) addPart(s, p);
    const down = s.plannedMinutes + s.unplannedMinutes + s.shortMinutes;
    s.workMinutes = hasData ? Math.max(0, s.totalMinutes - down) : null;
    return s;
  });
  const day = { ...emptySums(), hasData: shifts.some((s) => s.hasData) };
  let anyWork = false;
  let work = 0;
  for (const s of shifts) {
    day.totalMinutes += s.totalMinutes;
    day.plannedMinutes += s.plannedMinutes;
    day.unplannedMinutes += s.unplannedMinutes;
    day.shortMinutes += s.shortMinutes;
    day.stops += s.stops;
    if (s.workMinutes !== null) {
      anyWork = true;
      work += s.workMinutes;
    }
  }
  day.workMinutes = anyWork ? work : null;

  const known = new Set(shiftsOfDay.map((s) => s.shiftNo));
  const map = new Map();
  for (const p of parts) {
    if (!known.has(p.shiftNo)) continue;
    const reason = p.reason === undefined || p.reason === "" ? null : p.reason;
    const key = JSON.stringify([reason, p.mode, p.group]);
    let r = map.get(key);
    if (!r) map.set(key, (r = { reason, group: p.group, mode: p.mode, minutes: 0, stops: 0 }));
    r.minutes += p.minutes;
    if (p.continued !== true) r.stops += 1;
  }
  const byReason = [...map.values()].sort((a, b) => b.minutes - a.minutes || String(a.reason).localeCompare(String(b.reason)));
  return { shifts, day, byReason };
}

/** Промежутки работы внутри смены: смена минус объединение простоев. */
export function workIntervals(parts, shift) {
  const clipped = parts
    .map((p) => ({ s: Math.max(p.startMs, shift.startMs), e: Math.min(p.endMs, shift.endMs) }))
    .filter((c) => c.e > c.s)
    .sort((a, b) => a.s - b.s);
  const out = [];
  let cursor = shift.startMs;
  const push = (s, e) => {
    if (e > s) out.push({ startMs: s, endMs: e, minutes: Math.round((e - s) / MIN) });
  };
  for (const c of clipped) {
    push(cursor, c.s);
    cursor = Math.max(cursor, c.e);
  }
  push(cursor, shift.endMs);
  return out;
}
