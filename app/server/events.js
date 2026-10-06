import { buildDowntimes, DEFAULT_SCHEDULE, eventConflict, eventInputError, eventBoundsError, eventTimeError, periodParts, shiftStatus, handoversSince, recentHandovers, lastRunningMs, summarizeShift, toMs } from "../core/core.js";

import { periodRange } from "../core/stats.js";

const MINUTE = 60_000;

// Начало учёта: самое раннее время среди событий (у ручного простоя и правки времени — их начало)
function firstEventMs(events) {
  let first = Infinity;
  for (const e of events) {
    for (const v of [e.at, e.type === "manual" || e.type === "fix" ? e.from : undefined]) {
      if (v === undefined || v === null) continue;
      try { first = Math.min(first, toMs(v)); } catch { /* битое время пропускаем */ }
    }
  }
  return Number.isFinite(first) ? first : null;
}

export function createEventStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, type TEXT, at_ms INTEGER, received_ms INTEGER,
    device TEXT, body TEXT, flag TEXT
  )`);
  const all = db.prepare("SELECT body FROM events ORDER BY at_ms, rowid");
  const exists = db.prepare("SELECT id FROM events WHERE id = ?");
  const insert = db.prepare("INSERT INTO events (id, type, at_ms, received_ms, device, body, flag) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const read = () => all.all().map((row) => JSON.parse(row.body));

  function save(events, receivedMs, device, schedule = DEFAULT_SCHEDULE) {
    const saved = [];
    const rejected = [];
    const accepted = read();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        const reject = (error) => rejected.push({ id: event?.id ?? null, error });
        if (!event || typeof event !== "object" || Array.isArray(event) ||
          typeof event.id !== "string" || !event.id.trim() || event.id.length > 64) {
          reject("bad_request");
          continue;
        }
        // Подтверждаем уже принятый ID, не меняя первоначальное событие.
        if (exists.get(event.id)) {
          saved.push(event.id);
          continue;
        }
        const inputError = eventInputError(event);
        if (inputError) { reject(inputError); continue; }
        const at = toMs(event.at);
        const boundsError = eventBoundsError(event, receivedMs);
        if (boundsError) { reject(boundsError); continue; }
        const timeError = eventTimeError(accepted, { ...event, device }, receivedMs);
        if (timeError) {
          if (timeError === "already_stopped") {
            const built = buildDowntimes(accepted, receivedMs);
            rejected.push({ id: event.id, error: timeError, downtimeId: built.open.downtimeId,
              startMs: Math.min(...built.segments.filter((s) => s.downtimeId === built.open.downtimeId).map((s) => s.startMs)) });
          } else {
            const conflict = eventConflict(accepted, event, receivedMs);
            rejected.push({ id: event.id, error: timeError, ...(conflict ? { conflict } : {}) });
          }
          continue;
        }
        const stored = { ...event, device };
        // Кто нажал: если устройство не прислало бригаду и человека,
        // берём их из последнего приёма смены в той же смене.
        if (event.type !== "shift_open" && (stored.crewId == null || stored.personId == null)) {
          const { crew: open } = shiftStatus(accepted.filter((e) => toMs(e.at) <= at), at, schedule);
          if (open) {
            stored.crewId ??= open.crewId ?? null;
            stored.personId ??= open.personId ?? null;
            if (stored.personName == null && open.personName != null) stored.personName = open.personName;
          }
        }
        insert.run(event.id, event.type, at, receivedMs, stored.device, JSON.stringify(stored),
          receivedMs - at > 10 * MINUTE ? "late" : null);
        accepted.push(stored);
        saved.push(event.id);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { saved, rejected };
  }

  function state(nowMs, refs) {
    const events = read();
    const built = buildDowntimes(events, nowMs);
    const { shift, crew, closed } = shiftStatus(events, nowMs, refs.settings.schedule);
    const ping = db.prepare("SELECT 1 FROM pings WHERE server_at >= ? AND server_at < ? LIMIT 1")
      .get(new Date(shift.startMs).toISOString(), new Date(shift.endMs).toISOString());
    const segments = periodParts(built.segments, shift.startMs, Math.min(shift.endMs, nowMs), refs, nowMs);
    const openSegments = built.open ? built.segments.filter((s) => s.downtimeId === built.open.downtimeId) : [];
    const openStartMs = built.open ? Math.min(...openSegments.map((s) => s.startMs)) : null;
    const dayRange = periodRange("day", nowMs, refs.settings.schedule);
    const day = {
      fromMs: dayRange.fromMs, toMs: dayRange.fromMs + 24 * 60 * MINUTE,
      segments: built.segments.map((segment) => ({
        ...segment, startMs: Math.max(segment.startMs, dayRange.fromMs),
        endMs: Math.min(segment.endMs, dayRange.fromMs + 24 * 60 * MINUTE, nowMs),
      })).filter((segment) => segment.endMs > segment.startMs),
    };
    return {
      running: built.open === null,
      open: built.open ? {
        downtimeId: built.open.downtimeId,
        startMs: openStartMs,
        segments: openSegments,
        // Что передали прошлые смены по ремонту: все сдачи смены с начала этого простоя
        handovers: handoversSince(events, openStartMs),
      } : null,
      // Записки сдачи смены, пока стан работает (при простое они лежат в open.handovers)
      handovers: built.open ? [] : recentHandovers(events, nowMs),
      shift,
      crew,
      segments,
      day,
      summary: { shift: summarizeShift(built.segments, shift, refs, nowMs, firstEventMs(events) ?? (ping ? nowMs : null)) },
      closed,
      dataFromMs: firstEventMs(events),
      runningSinceMs: lastRunningMs(events, nowMs),
    };
  }

  return { save, state };
}
