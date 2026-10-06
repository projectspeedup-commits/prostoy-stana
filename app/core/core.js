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
  if (typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= 8.64e15) return at;
  if (typeof at === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(at.trim());
    if (m) {
      const ms = m[7] ? Math.round(Number("0." + m[7]) * 1000) : 0;
      const date = new Date(0);
      date.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
      if (date.getUTCFullYear() !== +m[1] || date.getUTCMonth() !== +m[2] - 1 ||
        date.getUTCDate() !== +m[3] || +(m[4] || 0) > 23 || +(m[5] || 0) > 59 || +(m[6] || 0) > 59) {
        throw new Error("Некорректный момент времени");
      }
      date.setUTCHours(+(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms);
      let t = date.getTime();
      const z = m[8];
      if (z && z.toUpperCase() !== "Z") {
        const sign = z[0] === "-" ? -1 : 1;
        const digits = z.slice(1).replace(":", "");
        if (+digits.slice(0, 2) > 23 || +(digits.slice(2) || 0) > 59) throw new Error("Некорректный часовой пояс");
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

/**
 * Брак (испорченная заготовка, тн) отрезка простоя: число >= 0 или null («не указан»).
 * У открытого отрезка брака нет — его вводят при пуске.
 */
export function segmentBillet(segment) {
  if (!segment || segment.open === true || segment.endMs === null || segment.endMs === undefined) return null;
  const v = segment.billet;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Единое правило привязки брака — его используют отчёт Excel (report.js), «Показатели» (stats.js)
 * и экран смены (shiftBillet в app.js). Брак отрезка относится к смене, в которой отрезок ЗАВЕРШИЛСЯ;
 * в период попадают отрезки, завершившиеся в (fromMs, toMs]; открытый отрезок брака не имеет.
 * Возвращает [{segment, billet (число или null), day, shiftNo}] по закрытым отрезкам периода.
 */
export function billetSegments(segments, fromMs, toMs, schedule) {
  const rows = [];
  for (const segment of segments) {
    if (segment.open === true || segment.endMs === null || segment.endMs === undefined) continue;
    if (!(segment.endMs > fromMs && segment.endMs <= toMs)) continue;
    const shift = shiftOf(segment.endMs - 1, schedule);
    rows.push({ segment, billet: segmentBillet(segment), day: shift.day, shiftNo: shift.shiftNo });
  }
  return rows;
}

/** Сумма брака, тн, до тысячных (убирает хвосты плавающей запятой); null — ни одного указанного значения. */
export function sumBillet(values) {
  const list = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return list.length ? Math.round(list.reduce((a, b) => a + b, 0) * 1000) / 1000 : null;
}

// Проверка времени запоздалой остановки и пуска — одна для сервера и демо.
export function eventTimeError(events, event, nowMs) {
  if (!["stop", "start", "manual", "reason", "split", "fix"].includes(event.type)) return "";
  const at = toMs(event.at);
  const built = buildDowntimes(events, nowMs);
  if (["reason", "split", "fix"].includes(event.type)) {
    const id = event.downtimeId ?? built.open?.downtimeId;
    const own = built.segments.filter((s) => s.downtimeId === id);
    const target = event.index == null ? own.at(-1) : own.find((s) => s.index === event.index);
    if (!target) return "not_found";
    if (event.type === "split" && (!built.open || built.open.downtimeId !== id || target.index !== built.open.index)) return "not_open";
    if (at < target.startMs) return "bad_time";
    const after = buildDowntimes([...events, event], nowMs);
    if (event.type === "fix" && (event.from != null || event.to != null)) {
      // Конец раньше начала (или конец у идущего простоя) — неверное время, а не наложение
      const parts = built.segments.filter((s) => s.downtimeId === id);
      const running = parts.some((s) => s.open);
      const newFrom = event.from != null ? toMs(event.from) : Math.min(...parts.map((s) => s.startMs));
      const newTo = running ? null : event.to != null ? toMs(event.to) : Math.max(...parts.map((s) => s.endMs));
      if ((event.to != null && running) || (newTo !== null && newTo <= newFrom)) return "bad_time";
      // Не раньше 40 суток назад и не позже «сейчас» (+2 минуты допуска, как у остальных событий)
      if (event.from != null && (newFrom < nowMs - 40 * DAY_MS || newFrom > nowMs + 2 * MIN)) return "bad_time";
      if (event.to != null && newTo > nowMs + 2 * MIN) return "bad_time";
      // Правка не должна «потерять» уже принятые события: остановка, попавшая внутрь чужого простоя, — наложение;
      // потерянный пуск или причина этого же простоя — неверное время
      const gone = [...events, event].filter((e) => after.ignored.includes(e.id) && !built.ignored.includes(e.id));
      if (gone.some((e) => e.type === "stop")) return "overlap";
      if (gone.length) return "bad_time";
      return fixTimeError(after, id, nowMs);
    }
    if (after.ignored.includes(event.id)) return "bad_time";
    return "";
  }
  if (event.type === "stop") {
    if (built.open) {
      const start = Math.min(...built.segments.filter((s) => s.downtimeId === built.open.downtimeId).map((s) => s.startMs));
      // Раньше начала открытого — подмена чужого простоя задним числом. Позже — стан уже стоит:
      // клиент принимает открытый простой как свой. Устройство не сравниваем: общей ссылкой
      // многие телефоны работают с одним ключом.
      if (at <= start) return "overlap";
      return "already_stopped";
    }
    // Повторное использование идентификатора закрытого простоя слило бы две остановки в одну
    if (built.segments.some((s) => s.downtimeId === (event.downtimeId ?? event.id))) return "duplicate_downtime";
    // Конец закрытых отрезков уже учитывает пуски и правки времени
    if (built.segments.some((s) => !s.open && s.endMs > at)) return "overlap";
  } else if (event.type === "start") {
    const id = event.downtimeId ?? built.open?.downtimeId;
    if (!built.open || id !== built.open.downtimeId) return "not_open";
    const last = built.segments.filter((s) => s.downtimeId === id).at(-1);
    if (last && at < last.startMs) return "bad_time";
  } else {
    // Ручной простой с занятым номером (в том числе номером открытого простоя) слил бы две записи в одну
    if (built.segments.some((s) => s.downtimeId === (event.downtimeId ?? event.id))) return "duplicate_downtime";
    if (built.segments.some((s) => toMs(event.from) < (s.open ? Infinity : s.endMs) && toMs(event.to) > s.startMs)) return "overlap";
  }
  return "";
}

// Правка времени простоя: каждый отрезок имеет положительную длину, не выходит за «сейчас»
// и за 40 дней назад и не налезает на другие простои.
function fixTimeError(after, id, nowMs) {
  const own = after.segments.filter((s) => s.downtimeId === id);
  const others = after.segments.filter((s) => s.downtimeId !== id);
  for (const s of own) {
    if (!(s.startMs < s.endMs)) return "bad_time";
    if (s.startMs < nowMs - 40 * DAY_MS) return "bad_time";
    if (!s.open && s.endMs > nowMs + 2 * MIN) return "bad_time";
  }
  for (const s of own) {
    if (others.some((o) => s.startMs < o.endMs && s.endMs > o.startMs)) return "overlap";
  }
  return "";
}

/** Ограничения времени одинаковы для сервера и демо. */
export function eventBoundsError(event, nowMs) {
  const at = toMs(event.at);
  if (at < nowMs - 40 * DAY_MS || at > nowMs + 2 * MIN) return "bad_time";
  if (event.type === "manual") {
    const from = toMs(event.from), to = toMs(event.to);
    if (to <= from) return "bad_request";
    if (from < nowMs - 40 * DAY_MS || to > nowMs + 2 * MIN || to - from > 7 * DAY_MS) return "bad_time";
  }
  return "";
}

export function shiftStatus(events, nowMs, schedule) {
  const shift = shiftOf(nowMs, schedule);
  const own = events.filter((e) => toMs(e.at) >= shift.startMs && toMs(e.at) < shift.endMs)
    .sort((a, b) => toMs(a.at) - toMs(b.at));
  const last = own.findLast((e) => e.type === "shift_open" || e.type === "shift_close");
  const crew = own.findLast((e) => e.type === "shift_open");
  return { shift, own, closed: last?.type === "shift_close",
    crew: crew ? { crewId: crew.crewId ?? null, personId: crew.personId ?? null, personName: crew.personName ?? null, at: crew.at } : null };
}

/** Полная длительность сохраняется до обрезки границами отчёта. */
export function withDowntimeDuration(segments, nowMs = Infinity) {
  const durations = new Map();
  for (const s of segments) durations.set(s.downtimeId, (durations.get(s.downtimeId) || 0) + Math.max(0, Math.min(s.endMs, nowMs) - s.startMs));
  return segments.map((s) => ({ ...s, durationMs: Math.max(s.durationMs || 0, durations.get(s.downtimeId)) }));
}

// Контекст отказа доступен и для простоя прошлой смены, которого нет в текущем снимке.
export function eventConflict(events, event, nowMs) {
  const built = buildDowntimes(events, nowMs);
  const id = event.type === "stop"
    ? built.open?.downtimeId || built.segments.find((s) => s.endMs > toMs(event.at))?.downtimeId
    : event.downtimeId;
  const segments = built.segments.filter((s) => s.downtimeId === id);
  return segments.length ? { downtimeId: id, startMs: segments[0].startMs,
    endMs: segments.some((s) => s.open) ? null : segments.at(-1).endMs, segments } : null;
}

export const emptyField = (value) => value == null || (typeof value === "string" && !value.trim());

export function periodParts(segments, fromMs, toMs, refs, nowMs = Infinity) {
  return withDowntimeDuration(segments, nowMs).flatMap((s) => {
    const startMs = Math.max(s.startMs, fromMs), endMs = Math.min(s.endMs, toMs);
    if (endMs <= startMs) return [];
    return splitByShifts({ ...s, startMs, endMs, ...classify(s, refs, refs.settings) }, refs.settings.schedule)
      .map((p) => ({ ...p, continued: p.startMs > s.startMs }));
  });
}

// Граница для забытой остановки, включая пуски и простои прошлых смен.
export function lastRunningMs(events, nowMs) {
  const ends = buildDowntimes(events, nowMs).segments.filter((s) => !s.open).map((s) => s.endMs);
  return ends.length ? Math.max(...ends) : null;
}

// Записи, сделанные до 30.09.2026, хранят старые коды классификатора. Читаем их как три
// нынешние причины: плановые — перевалка; механика, электрика, энергия — аварийный простой;
// остальные внеплановые — бурёжка
export function reasonKey(reason) {
  if (typeof reason !== "string") return reason;
  if (/^П-\d\d$/.test(reason)) return "perevalka";
  if (/^В-[МЭВА]-\d\d$/.test(reason)) return "avaria";
  if (/^В-[ТОП]-\d\d$/.test(reason)) return "burezhka";
  return reason;
}

/**
 * Собирает отрезки простоя из событий.
 *
 * Правка времени (fix с from/to) двигает не готовый отрезок, а сами события: начало — время остановки
 * (stop) или начало ручного простоя, конец — время пуска (start) или конец ручного простоя. Поэтому такие
 * события сначала находим обычным проходом, затем собираем заново с исправленным временем: иначе остановка,
 * внесённая в освободившийся промежуток, считалась бы внутри «длинного» прежнего простоя и пропадала.
 */
export function buildDowntimes(events, nowMs) {
  const first = runBuild(events, nowMs, false);
  if (!first.patches.size) return first.out;
  const patched = events.map((e, i) => (first.patches.has(i) ? { ...e, ...first.patches.get(i) } : e));
  // Остановка сдвинута позже: причины, записанные в промежутке, переносим к новому началу
  for (const [i, patch] of first.patches) {
    const old = events[i];
    if (old.type !== "stop" || patch.at === undefined) continue;
    const from = toMs(old.at), to = toMs(patch.at);
    for (let j = 0; j < patched.length; j++) {
      const r = patched[j];
      if (r.type === "reason" && r.downtimeId === (old.downtimeId ?? old.id) && toMs(r.at) >= from && toMs(r.at) < to) {
        patched[j] = { ...r, at: patch.at };
      }
    }
  }
  return runBuild(patched, nowMs, true).out;
}

function runBuild(events, nowMs, timeApplied) {
  const now = toMs(nowMs);
  const sorted = events
    .map((e) => (typeof e.reason === "string" && e.reason !== reasonKey(e.reason) ? { ...e, reason: reasonKey(e.reason) } : e))
    .map((e, i) => ({ e, i, t: toMs(e.at !== undefined && e.at !== null ? e.at : e.from) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const segments = [];
  const ignored = [];
  const patches = new Map(); // номер события → новое время (при правке времени)
  const meta = new Map(); // отрезок → номера событий, которые его открыли и закрыли
  let cur = null; // единственный открытый отрезок (стан один)

  const val = (v, prev) => (v !== undefined ? v : prev !== undefined ? prev : null);
  const matches = (e) => e.downtimeId === undefined || e.downtimeId === null || e.downtimeId === cur.downtimeId;
  const open = (e, t, downtimeId, index, prev, i, kind) => {
    const seg = {
      downtimeId,
      index,
      startMs: t,
      endMs: null,
      reason: e.reason !== undefined ? e.reason : null,
      node: val(e.node, prev && prev.node),
      billet: val(e.billet),
      note: val(e.note),
      action: val(e.action),
      crewId: val(e.crewId, prev && prev.crewId),
      personId: val(e.personId, prev && prev.personId),
      manual: false,
      open: false,
    };
    meta.set(seg, { openIdx: i, openKind: kind });
    return seg;
  };
  const close = (t, i, kind) => {
    cur.endMs = t;
    Object.assign(meta.get(cur), { closeIdx: i, closeKind: kind });
    segments.push(cur);
    cur = null;
  };
  const patch = (i, fields) => patches.set(i, { ...patches.get(i), ...fields });

  for (const { e, i, t } of sorted) {
    switch (e.type) {
      case "stop":
        if (cur) ignored.push(e.id);
        else cur = open(e, t, e.downtimeId ?? e.id, 0, null, i, "stop");
        break;
      case "reason": {
        const target = [cur, ...segments.slice().reverse()].find((s) => s &&
          s.downtimeId === (e.downtimeId ?? cur?.downtimeId) && (e.index == null || s.index === e.index));
        if (!target) ignored.push(e.id);
        else {
          target.reason = e.reason !== undefined ? e.reason : null;
          // Своими словами: текст рабочего к причине
          if (e.note !== undefined) target.note = e.note;
        }
        break;
      }
      case "fix": {
        const target = [cur, ...segments].find((s) => s &&
          s.downtimeId === e.downtimeId && s.index === e.index);
        if (!target) ignored.push(e.id);
        else {
          for (const field of ["reason", "node", "billet", "note", "action"]) {
            if (e[field] !== undefined && (!e.onlyEmpty || emptyField(target[field]))) target[field] = e[field];
          }
          const m = meta.get(target);
          // Начало — только у первого отрезка простоя
          if (e.from != null) {
            if (target.index !== 0) ignored.push(e.id);
            else if (!timeApplied) patch(m.openIdx, m.openKind === "manual" ? { from: e.from } : { at: e.from });
          }
          // Конец — только у последнего закрытого отрезка
          if (e.to != null) {
            const lastClosed = target !== cur && !(cur && cur.downtimeId === target.downtimeId) &&
              !segments.some((s) => s.downtimeId === target.downtimeId && s.index > target.index);
            if (!lastClosed || (m.closeKind !== "start" && m.closeKind !== "manual")) ignored.push(e.id);
            else if (!timeApplied) patch(m.closeIdx, m.closeKind === "manual" ? { to: e.to } : { at: e.to });
          }
        }
        break;
      }
      case "split":
        if (!cur || !matches(e)) ignored.push(e.id);
        else {
          const prev = cur;
          close(t, i, "split");
          cur = open(e, t, prev.downtimeId, prev.index + 1, prev, i, "split");
        }
        break;
      case "start":
        if (!cur || !matches(e)) ignored.push(e.id);
        else {
          // Что сделали, чтобы запустить стан: обязательный текст при пуске
          if (e.action !== undefined) cur.action = e.action;
          close(t, i, "start");
        }
        break;
      case "manual": {
        const from = toMs(e.from);
        const to = toMs(e.to);
        if (!(to > from)) {
          ignored.push(e.id);
          break;
        }
        const seg = {
          downtimeId: e.downtimeId ?? e.id,
          index: 0,
          startMs: from,
          endMs: to,
          reason: e.reason !== undefined ? e.reason : null,
          node: val(e.node),
          billet: val(e.billet),
          note: val(e.note),
          action: val(e.action),
          crewId: val(e.crewId),
          personId: val(e.personId),
          manual: true,
          open: false,
        };
        meta.set(seg, { openIdx: i, openKind: "manual", closeIdx: i, closeKind: "manual" });
        segments.push(seg);
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
  return { out: { segments, ignored, open: openSeg }, patches };
}

/**
 * Передачи смены для открытого простоя: все shift_close не раньше начала простоя,
 * по возрастанию времени. Только читает события — на расчёт простоев не влияет
 * (action из shift_close не попадает в простой).
 */
export function handoversSince(events, sinceMs) {
  return events
    .filter((e) => e.type === "shift_close" && toMs(e.at) >= sinceMs)
    .sort((a, b) => toMs(a.at) - toMs(b.at))
    .map((e) => ({ at: e.at, crewId: e.crewId ?? null, personId: e.personId ?? null, personName: e.personName ?? null, action: e.action ?? null, note: e.note ?? null }));
}

/**
 * Записки сдачи смены при работающем стане: последние три сдачи с текстом «что сделали по ремонту
 * и что осталось» за последние 36 часов, по возрастанию времени. Формат события тот же (shift_close с action).
 */
export function recentHandovers(events, nowMs) {
  const from = nowMs - 36 * 3600000;
  return events
    .filter((e) => e.type === "shift_close" && typeof e.action === "string" && e.action.trim() && toMs(e.at) >= from && toMs(e.at) <= nowMs)
    .sort((a, b) => toMs(a.at) - toMs(b.at))
    .slice(-3)
    .map((e) => ({ at: e.at, crewId: e.crewId ?? null, personId: e.personId ?? null, personName: e.personName ?? null, action: e.action, note: e.note ?? null }));
}

/** Режим и группа отрезка. */
export function classify(segment, refs, settings) {
  const reason = segment.reason;
  const hasReason = reason !== null && reason !== undefined && reason !== "";
  const minutes = (segment.durationMs ?? (segment.endMs - segment.startMs)) / MIN;
  const ref = hasReason ? refs.reasons[reason] : undefined;
  let mode;
  if (!hasReason && minutes < settings.shortStopMinutes) mode = "short";
  else if (ref && ref.planned) mode = "planned";
  else mode = "unplanned";
  const group = !hasReason ? NO_REASON_GROUP : ref ? ref.group : UNKNOWN_GROUP;
  return { mode, group };
}

// Округляем общий итог один раз, распределяя остаток между категориями.
export function apportionMinutes(msList, totalMin = Math.round(msList.reduce((a, b) => a + b, 0) / MIN)) {
  const out = msList.map((ms) => Math.floor(ms / MIN));
  const rest = msList.map((ms, i) => ms - out[i] * MIN);
  let left = totalMin - out.reduce((a, b) => a + b, 0);
  for (const i of rest.map((_, i) => i).sort((a, b) => rest[b] - rest[a] || a - b)) {
    if (left-- <= 0) break;
    out[i]++;
  }
  return out;
}

const stopCount = (parts) => new Set(parts.filter((p) => p.downtimeId != null).map((p) => p.downtimeId)).size
  + parts.filter((p) => p.downtimeId == null && !p.continued).length;
const partMs = (p) => p.endMs - p.startMs;
export function summarizeParts(parts, totalMs, hasData) {
  const modes = ["planned", "unplanned", "short"];
  const downMs = parts.reduce((sum, p) => sum + partMs(p), 0);
  const downMinutes = Math.round(downMs / MIN);
  const [plannedMinutes, unplannedMinutes, shortMinutes] = apportionMinutes(modes.map((mode) =>
    parts.filter((p) => p.mode === mode).reduce((sum, p) => sum + partMs(p), 0)), downMinutes);
  const totalMinutes = Math.round(totalMs / MIN);
  return { totalMinutes, downMinutes, plannedMinutes, unplannedMinutes, shortMinutes,
    workMinutes: hasData ? Math.max(0, totalMinutes - downMinutes) : null, stops: stopCount(parts), hasData };
}

/** Единый итог смены для API и всех экранов, включая неотправленные события. */
export function summarizeShift(segments, shift, refs, nowMs, dataFromMs) {
  const parts = periodParts(segments, shift.startMs, Math.min(shift.endMs, nowMs), refs, nowMs);
  return summarizeDay(parts, [shift], { [shift.shiftNo]: dataFromMs != null },
    { nowMs, dataFromMs: dataFromMs ?? nowMs }).shifts[0];
}

/** Сводка по прошедшему времени с начала учёта. */
export function summarizeDay(parts, shiftsOfDay, signals, { nowMs = Infinity, dataFromMs = -Infinity } = {}) {
  const sig = signals || {};
  const visible = parts.flatMap((p) => {
    const sh = shiftsOfDay.find((s) => s.shiftNo === p.shiftNo);
    if (!sh) return [];
    const startMs = Math.max(p.startMs, sh.startMs), endMs = Math.min(p.endMs, sh.endMs, nowMs);
    return endMs > startMs ? [{ ...p, startMs, endMs }] : [];
  });
  const elapsed = (sh) => Math.max(0, Math.min(sh.endMs, nowMs) - Math.max(sh.startMs, dataFromMs));
  const shifts = shiftsOfDay.map((sh) => {
    const own = visible.filter((p) => p.shiftNo === sh.shiftNo);
    const hasData = sig[sh.shiftNo] === true || own.length > 0;
    return { shiftNo: sh.shiftNo, ...summarizeParts(own, elapsed(sh), hasData) };
  });
  const day = summarizeParts(visible, shiftsOfDay.reduce((sum, sh) => sum + elapsed(sh), 0), shifts.some((s) => s.hasData));
  const knownMs = shiftsOfDay.reduce((sum, sh, i) => sum + (shifts[i].hasData ? elapsed(sh) : 0), 0);
  if (day.hasData) day.workMinutes = Math.max(0, Math.round(knownMs / MIN) - day.downMinutes);
  const groups = new Map();
  for (const p of visible) {
    const reason = p.reason || null;
    const key = JSON.stringify([reason, p.mode, p.group]);
    if (!groups.has(key)) groups.set(key, { reason, mode: p.mode, group: p.group, parts: [] });
    groups.get(key).parts.push(p);
  }
  const rows = [...groups.values()];
  const rounded = apportionMinutes(rows.map((r) => r.parts.reduce((sum, p) => sum + partMs(p), 0)), day.downMinutes);
  const byReason = rows.map((r, i) => ({ reason: r.reason, mode: r.mode, group: r.group, minutes: rounded[i], stops: stopCount(r.parts) }))
    .sort((a, b) => b.minutes - a.minutes || String(a.reason).localeCompare(String(b.reason)));
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

/** Проверка формы события до расчётов; общая для демо и сервера. */
export function eventInputError(event) {
  const TYPES = new Set(["stop", "start", "reason", "split", "manual", "fix", "shift_open", "shift_close"]);
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.id !== "string" || !event.id.trim() || event.id.length > 64) return "bad_request";
  try {
    toMs(event.at);
    if (!TYPES.has(event.type)) throw new Error();
    if (event.device != null && typeof event.device !== "string") throw new Error();
    if (event.seq != null && (!Number.isSafeInteger(event.seq) || event.seq < 0)) throw new Error();
    for (const field of ["reason", "node", "note", "action", "downtimeId"]) {
      if (event[field] != null && typeof event[field] !== "string") throw new Error();
    }
    // Пустой номер простоя — не «нет номера»: простой с таким ID нельзя исправить через fix
    if (typeof event.downtimeId === "string" && !event.downtimeId.trim()) throw new Error();
    for (const field of ["crewId", "personId"]) {
      if (event[field] != null && typeof event[field] !== "string" && !Number.isSafeInteger(event[field])) throw new Error();
    }
    for (const field of ["reason", "downtimeId"]) if (typeof event[field] === "string" && event[field].length > 120) throw new Error();
    if (typeof event.note === "string" && event.note.length > 500) throw new Error();
    if (typeof event.action === "string" && event.action.length > 500) throw new Error();
    if (event.onlyEmpty !== undefined && typeof event.onlyEmpty !== "boolean") throw new Error();
    if (event.type === "fix" && ["reason", "node", "note", "action", "billet"].some((f) => event[f] === null)) throw new Error();
    if (event.index != null && (!Number.isSafeInteger(event.index) || event.index < 0)) throw new Error();
    if (event.personName != null && (typeof event.personName !== "string" || event.personName.length > 120)) throw new Error();
    if (event.billet != null && (typeof event.billet !== "number" || !Number.isFinite(event.billet) || event.billet < 0 || event.billet > 1000)) throw new Error();
    if (event.type === "fix" && (typeof event.downtimeId !== "string" || !event.downtimeId ||
      !Number.isSafeInteger(event.index) || event.index < 0)) throw new Error();
    if (event.type === "manual") {
      const from = toMs(event.from);
      const to = toMs(event.to);
      if (to <= from) throw new Error();
    }
    if (event.type === "fix") {
      // Правка времени: начало — только у первого отрезка простоя
      if (event.from != null) {
        toMs(event.from);
        if (event.index !== 0) throw new Error();
      }
      if (event.to != null) toMs(event.to);
      if (event.from != null && event.to != null && toMs(event.to) <= toMs(event.from)) throw new Error();
    }
  } catch {
    return "bad_request";
  }
  return "";
}
