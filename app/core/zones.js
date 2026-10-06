// Цветовые зоны: чистый расчёт в миллисекундах, общий для страницы и сервера.
const MINUTE = 60_000;
const HALF_HOUR = 30 * MINUTE;
const ZONES = ["work", "plan", "unplanned", "failure", "nodata"];
const empty = () => Object.fromEntries(ZONES.map((zone) => [zone, 0]));
// Точные границы внутри ячейки нужны для суммы неполной смены.
const cellParts = new WeakMap();

export function zoneOf(reason, refs) {
  if (!reason) return "unplanned";
  const ref = refs?.reasons?.[reason];
  if (["plan", "unplanned", "failure"].includes(ref?.zone)) return ref.zone;
  return ref?.planned ? "plan" : "unplanned";
}

/** 48 получасовых ячеек производственных суток; будущее не считается работой. */
export function dayCells(segments, { fromMs, toMs = fromMs + 48 * HALF_HOUR, nowMs, dataFromMs, refs }) {
  const knownFrom = dataFromMs == null ? Infinity : dataFromMs;
  const stops = segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.open ? nowMs : segment.endMs,
    zone: zoneOf(segment.reason, refs),
    downtimeId: segment.downtimeId ?? null,
  })).filter((segment) => segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return Array.from({ length: 48 }, (_, index) => {
    const startMs = fromMs + index * HALF_HOUR;
    const endMs = Math.min(startMs + HALF_HOUR, toMs);
    const elapsedEnd = Math.max(startMs, Math.min(endMs, nowMs));
    // Номера простоев, отрезки которых заходят в эту ячейку (в уже прошедшей части)
    const downtimes = [...new Set(stops.filter((stop) => stop.downtimeId !== null && stop.endMs > startMs && stop.startMs < elapsedEnd)
      .map((stop) => stop.downtimeId))];
    const cell = { startMs, endMs, future: startMs >= nowMs, ms: empty(), downtimes };
    const parts = [];
    const add = (zone, start, end) => {
      if (end <= start) return;
      cell.ms[zone] += end - start;
      parts.push({ zone, startMs: start, endMs: end });
    };
    let cursor = Math.min(elapsedEnd, Math.max(startMs, knownFrom));
    add("nodata", startMs, cursor);
    for (const stop of stops) {
      if (stop.endMs <= cursor) continue;
      if (stop.startMs >= elapsedEnd) break;
      const start = Math.max(cursor, stop.startMs);
      const end = Math.min(elapsedEnd, stop.endMs);
      add("work", cursor, start);
      add(stop.zone, start, end);
      cursor = end;
    }
    add("work", cursor, elapsedEnd);
    cellParts.set(cell, parts);
    return cell;
  });
}

/** Минуты в отрезке; границы смены могут проходить внутри ячейки. */
export function zoneTotals(cells, fromMs, toMs) {
  const totals = empty();
  for (const cell of cells) {
    if (cell.future || cell.endMs <= fromMs || cell.startMs >= toMs) continue;
    const parts = cellParts.get(cell);
    if (parts) {
      for (const part of parts) {
        totals[part.zone] += Math.max(0, Math.min(toMs, part.endMs) - Math.max(fromMs, part.startMs));
      }
    } else {
      // После передачи через JSON точны целые ячейки; неполные распределяются пропорционально.
      const elapsed = Object.values(cell.ms).reduce((sum, ms) => sum + ms, 0);
      const overlap = Math.max(0, Math.min(toMs, cell.startMs + elapsed) - Math.max(fromMs, cell.startMs));
      for (const zone of ZONES) totals[zone] += elapsed ? cell.ms[zone] * overlap / elapsed : 0;
    }
  }
  return Object.fromEntries(ZONES.map((zone) => [zone, totals[zone] / MINUTE]));
}
