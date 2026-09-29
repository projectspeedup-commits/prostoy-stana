import { buildDowntimes, classify, DEFAULT_SCHEDULE, shiftOf, splitByShifts, summarizeDay, toMs } from "../core/core.js";

const TYPES = new Set(["stop", "start", "reason", "split", "manual", "fix", "shift_open", "shift_close"]);
const MINUTE = 60_000;

// Начало учёта: самое раннее время среди событий (у ручного простоя — его начало)
function firstEventMs(events) {
  let first = Infinity;
  for (const e of events) {
    for (const v of [e.at, e.type === "manual" ? e.from : undefined]) {
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
        let at, from, to;
        try {
          at = toMs(event.at);
          if (!TYPES.has(event.type)) throw new Error();
          if (event.device != null && typeof event.device !== "string") throw new Error();
          if (event.seq != null && (!Number.isSafeInteger(event.seq) || event.seq < 0)) throw new Error();
          for (const field of ["reason", "node", "note", "action", "downtimeId"]) {
            if (event[field] != null && typeof event[field] !== "string") throw new Error();
          }
          for (const field of ["crewId", "personId"]) {
            if (event[field] != null && typeof event[field] !== "string" && !Number.isSafeInteger(event[field])) throw new Error();
          }
          if (typeof event.note === "string" && event.note.length > 500) throw new Error();
          if (typeof event.action === "string" && event.action.length > 500) throw new Error();
          if (event.billet != null && (typeof event.billet !== "number" || !Number.isFinite(event.billet) || event.billet < 0)) throw new Error();
          if (event.type === "fix" && (typeof event.downtimeId !== "string" || !event.downtimeId ||
            !Number.isSafeInteger(event.index) || event.index < 0)) throw new Error();
          if (event.type === "manual") {
            from = toMs(event.from);
            to = toMs(event.to);
            if (to <= from) throw new Error();
          }
        } catch {
          reject("bad_request");
          continue;
        }
        if (at > receivedMs + 2 * MINUTE || (event.type === "manual" && to > receivedMs + 2 * MINUTE)) {
          reject("bad_time");
          continue;
        }
        if (event.type === "manual" && buildDowntimes(accepted, receivedMs).segments.some((s) =>
          from < (s.open ? Infinity : s.endMs) && to > s.startMs)) {
          reject("overlap");
          continue;
        }
        const stored = { ...event, device: event.device ?? device };
        // Кто нажал: если устройство не прислало бригаду и человека,
        // берём их из последнего приёма смены в той же смене.
        if (event.type !== "shift_open" && (stored.crewId == null || stored.personId == null)) {
          const day = shiftOf(at, schedule);
          const open = accepted.findLast((e) => e.type === "shift_open" && toMs(e.at) <= at &&
            toMs(e.at) >= day.startMs);
          if (open) {
            stored.crewId ??= open.crewId ?? null;
            stored.personId ??= open.personId ?? null;
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
    const shift = shiftOf(nowMs, refs.settings.schedule);
    const inShift = (at) => at >= shift.startMs && at < shift.endMs;
    const ownEvents = events.filter((e) => inShift(toMs(e.at)));
    const lastCrew = ownEvents.findLast((e) => e.type === "shift_open");
    const ping = db.prepare("SELECT 1 FROM pings WHERE server_at >= ? AND server_at < ? LIMIT 1")
      .get(new Date(shift.startMs).toISOString(), new Date(shift.endMs).toISOString());
    const segments = built.segments.filter((s) => s.endMs > s.startMs)
      .flatMap((s) => splitByShifts(s, refs.settings.schedule))
      .filter((p) => p.day === shift.day && p.shiftNo === shift.shiftNo)
      .map((p) => ({ ...p, ...classify(p, refs, refs.settings) }));
    const openSegments = built.open ? built.segments.filter((s) => s.downtimeId === built.open.downtimeId) : [];
    return {
      running: built.open === null,
      open: built.open ? {
        downtimeId: built.open.downtimeId,
        startMs: Math.min(...openSegments.map((s) => s.startMs)),
        segments: openSegments,
      } : null,
      shift,
      crew: lastCrew ? { crewId: lastCrew.crewId ?? null, personId: lastCrew.personId ?? null, at: lastCrew.at } : null,
      segments,
      summary: summarizeDay(segments, [shift], { [shift.shiftNo]: ownEvents.length > 0 || !!ping }),
      closed: ownEvents.some((e) => e.type === "shift_close"),
      dataFromMs: firstEventMs(events),
    };
  }

  return { save, state };
}
