// Имитация сервера в памяти для проверки страницы без backend.
// Подключается только из app.js при ?mock=1. Считает на том же ядре, что и сервер.
import * as core from "./core/core.js";
import { DEFAULT_REFS } from "./core/refs.js";

// Справочник причин, плиток и узлов — тот же, что у сервера
const refs = {
  reasons: DEFAULT_REFS.reasons,
  tiles: DEFAULT_REFS.tiles,
  nodes: DEFAULT_REFS.nodes,
  settings: { shortStopMinutes: 5, schedule: core.DEFAULT_SCHEDULE },
  crews: [
    { id: "1", title: "Смена 1" },
    { id: "2", title: "Смена 2" },
    { id: "3", title: "Смена 3" },
  ],
  // Условные имена для демо, не настоящие работники
  people: [
    { id: "p1", name: "Кузнецов А.В", crewId: "1" },
    { id: "p2", name: "Смирнов Д.С", crewId: "1" },
    { id: "p3", name: "Орлов К.Р", crewId: "1" },
    { id: "p4", name: "Волков Е.Н", crewId: "2" },
    { id: "p5", name: "Морозов А.П", crewId: "2" },
    { id: "p6", name: "Лебедев Г.О", crewId: "2" },
    { id: "p7", name: "Новиков С.И", crewId: "3" },
    { id: "p8", name: "Фёдоров М.А", crewId: "3" },
    { id: "p9", name: "Соколов В.Т", crewId: "3" },
  ],
  demo: true,
};
const REFS_VERSION = "mock-3";

const events = []; // журнал событий, как в базе сервера

function shiftsOfDay(day, schedule) {
  const tz = schedule.tzOffsetMinutes || 0;
  const sign = tz >= 0 ? "+" : "-";
  const off = `${String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0")}:${String(Math.abs(tz) % 60).padStart(2, "0")}`;
  const out = [];
  for (const s of schedule.shifts) {
    const sh = core.shiftOf(`${day}T${s.start}:00${sign}${off}`, schedule);
    if (sh.day === day && !out.some((o) => o.shiftNo === sh.shiftNo)) out.push(sh);
  }
  return out;
}

function computeState() {
  const now = Date.now();
  const schedule = refs.settings.schedule;
  const built = core.buildDowntimes(events, now);

  // Бригада на посту: последний shift_open, снятый shift_close
  let crew = null;
  let closed = false;
  for (const e of events) {
    if (e.type === "shift_open") {
      crew = { crewId: e.crewId, personId: e.personId, at: e.at };
      closed = false;
    } else if (e.type === "shift_close") {
      crew = null;
      closed = true;
    }
  }

  const shift = core.shiftOf(now, schedule);
  const allParts = [];
  const segments = [];
  for (const seg of built.segments) {
    for (const p of core.splitByShifts(seg, schedule)) {
      // reason/billet/note уже применены ядром (fix и note в reason поддерживает core)
      const part = { ...p, reason: p.reason ?? null, billet: p.billet ?? null, note: p.note ?? null };
      const cls = core.classify(part, refs, refs.settings);
      const full = {
        ...part,
        ...cls,
        open: seg.open === true && p.endMs === seg.endMs,
        personId: crew ? crew.personId : null,
        crewId: crew ? crew.crewId : null,
      };
      allParts.push(full);
      if (p.day === shift.day) segments.push(full);
    }
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.index - b.index);

  const openSegs = built.open ? segments.filter((s) => s.downtimeId === built.open.downtimeId) : [];
  const dayParts = allParts.filter((p) => p.day === shift.day);
  const summary = core.summarizeDay(dayParts, shiftsOfDay(shift.day, schedule), {});

  return {
    running: !built.open,
    open: built.open
      ? { downtimeId: built.open.downtimeId, startMs: built.open.startMs, segments: openSegs }
      : null,
    shift,
    crew,
    segments,
    summary,
    closed,
  };
}

function serverTime() {
  return new Date().toISOString();
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Замена fetch для app.js: api(path, {method, body}) → распарсенный ответ. */
export async function api(path, options = {}) {
  await pause(120); // как сеть в цеху
  // Тестовый рубильник связи: sessionStorage stan.mockOffline = "1"
  if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("stan.mockOffline") === "1") {
    throw new Error("mock_offline");
  }
  if (path === "/api/refs") {
    return { ok: true, refs, refsVersion: REFS_VERSION };
  }
  if (path === "/api/state") {
    return { ok: true, state: computeState(), refsVersion: REFS_VERSION, serverTime: serverTime() };
  }
  if (path === "/api/events" && options.method === "POST") {
    let body;
    try {
      body = JSON.parse(options.body || "{}");
    } catch {
      return { ok: false, saved: [], rejected: [], state: computeState(), serverTime: serverTime() };
    }
    const saved = [];
    const rejected = [];
    const types = new Set(["stop", "start", "reason", "split", "manual", "fix", "shift_open", "shift_close"]);
    for (const e of Array.isArray(body.events) ? body.events : []) {
      if (!e || typeof e.id !== "string" || !types.has(e.type)) {
        rejected.push({ id: e && e.id ? e.id : "?", error: "bad_event" });
        continue;
      }
      if (e.type === "manual") {
        try {
          if (!(core.toMs(e.to) > core.toMs(e.from))) throw new Error("bad_range");
        } catch {
          rejected.push({ id: e.id, error: "bad_range" });
          continue;
        }
      }
      events.push(e);
      saved.push(e.id);
    }
    return { ok: true, saved, rejected, state: computeState(), serverTime: serverTime() };
  }
  const err = new Error("not_found");
  err.status = 404;
  throw err;
}
