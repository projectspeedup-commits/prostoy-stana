// Имитация сервера в памяти для проверки страницы без backend.
// Подключается только из app.js при ?mock=1. Считает на том же ядре, что и сервер.
import * as core from "./core/core.js";
import { DEFAULT_REFS } from "./core/refs.js";
import { computeStats, periodRange } from "./core/stats.js";
import { settingsFromRefs, validateSettings } from "./core/settings.js";
import { reportFile } from "./core/report.js";

// Справочник причин, плиток и узлов — тот же, что у сервера
const refs = {
  reasons: DEFAULT_REFS.reasons,
  tiles: DEFAULT_REFS.tiles,
  nodes: DEFAULT_REFS.nodes,
  settings: { shortStopMinutes: 5, schedule: core.DEFAULT_SCHEDULE },
  // Две смены по 12 часов: Смена 1 — дневная 08:00–20:00, Смена 2 — ночная 20:00–08:00
  crews: [
    { id: "1", title: "Смена 1" },
    { id: "2", title: "Смена 2" },
  ],
  // Условные мастера для демо, не настоящие работники
  people: [
    { id: "p1", name: "Кузнецов Алексей Викторович", crewId: "1" },
    { id: "p2", name: "Смирнов Дмитрий Сергеевич", crewId: "1" },
    { id: "p3", name: "Орлов Константин Романович", crewId: "1" },
    { id: "p4", name: "Волков Евгений Николаевич", crewId: "2" },
    { id: "p5", name: "Морозов Андрей Павлович", crewId: "2" },
    { id: "p6", name: "Лебедев Григорий Олегович", crewId: "2" },
  ].map((person) => ({ ...person, phone: "" })),
  demo: true,
};
// Версия справочника — по содержимому, как у сервера: иначе страница держит старый справочник в кэше
const refsVersion = () => "mock-" + [...JSON.stringify(refs)].reduce((h, ch) => (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0, 7).toString(16);
let REFS_VERSION = refsVersion();

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

// Начало учёта: самое раннее время среди событий (у ручного простоя — его начало)
function firstEventMs() {
  let first = Infinity;
  for (const e of events) {
    for (const v of [e.at, e.type === "manual" ? e.from : undefined]) {
      if (v === undefined || v === null) continue;
      try { first = Math.min(first, core.toMs(v)); } catch { /* битое время пропускаем */ }
    }
  }
  return Number.isFinite(first) ? first : null;
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
      crew = { crewId: e.crewId, personId: e.personId, personName: e.personName ?? null, at: e.at };
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
    // Мгновенное нажатие ещё не даёт длительности, как и на сервере.
    if (seg.endMs <= seg.startMs) continue;
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

  // Для времени пуска нужны исходные отрезки, без обрезки по границе смены.
  const openSegs = built.open ? built.segments.filter((s) => s.downtimeId === built.open.downtimeId) : [];
  // Начало всего простоя (не последнего отрезка) — как у сервера
  const openStartMs = built.open
    ? Math.min(...built.segments.filter((s) => s.downtimeId === built.open.downtimeId).map((s) => s.startMs))
    : null;
  const dayParts = allParts.filter((p) => p.day === shift.day);
  const summary = core.summarizeDay(dayParts, shiftsOfDay(shift.day, schedule), {});
  const dayRange = periodRange("day", now, schedule);
  const day = {
    fromMs: dayRange.fromMs, toMs: dayRange.fromMs + 24 * 60 * 60000,
    segments: built.segments.map((segment) => ({
      ...segment, startMs: Math.max(segment.startMs, dayRange.fromMs),
      endMs: Math.min(segment.endMs, dayRange.fromMs + 24 * 60 * 60000),
    })).filter((segment) => segment.endMs > segment.startMs),
  };

  return {
    running: !built.open,
    open: built.open
      ? {
        downtimeId: built.open.downtimeId,
        startMs: openStartMs,
        segments: openSegs,
        // Что передали прошлые смены по ремонту, как у сервера
        handovers: core.handoversSince(events, openStartMs),
      }
      : null,
    shift,
    crew,
    segments,
    day,
    summary,
    closed,
    dataFromMs: firstEventMs(),
    runningSinceMs: core.lastRunningMs(events, now),
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
  const url = new URL(path, "http://mock.local");
  const method = (options.method || "GET").toUpperCase();
  if (url.pathname === "/api/admin/settings" && method === "GET") {
    return { ok: true, settings: settingsFromRefs(refs), refsVersion: REFS_VERSION };
  }
  if (url.pathname === "/api/admin/settings" && method === "PUT") {
    const fail = (status, message) => {
      throw Object.assign(new Error("http_" + status), { status, data: { ok: false, error: "bad_request", message } });
    };
    if (new TextEncoder().encode(options.body || "").length > 64 * 1024) {
      fail(413, "Тело запроса не должно превышать 64 КБ.");
    }
    let body;
    try { body = JSON.parse(options.body || ""); }
    catch { fail(400, "Некорректный JSON в теле запроса."); }
    let settings;
    try { settings = validateSettings(body?.settings, refs.people); }
    catch (e) {
      if (e.code !== "bad_request") throw e;
      fail(400, e.message);
    }
    refs.people = settings.people;
    refs.settings = { ...refs.settings, schedule: { tzOffsetMinutes: 180, ...settings.schedule }, contacts: settings.contacts };
    REFS_VERSION = refsVersion();
    return { ok: true, settings: settingsFromRefs(refs), refsVersion: REFS_VERSION };
  }
  if (url.pathname === "/api/report.xlsx" && method === "GET") {
    // Отчёт — тем же ядром, что на сервере; отказ — как 400 сервера, с русским сообщением
    const result = reportFile({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), events, refs, nowMs: Date.now() });
    if (!result.ok) throw Object.assign(new Error("http_400"), { status: 400, data: { ok: false, error: "bad_request", message: result.message } });
    return { ok: true, bytes: result.bytes, filename: result.filename };
  }
  if (url.pathname === "/api/refs" && method === "GET") {
    return { ok: true, refs: structuredClone(refs), refsVersion: REFS_VERSION };
  }
  if (url.pathname === "/api/state" && method === "GET") {
    return { ok: true, state: computeState(), refsVersion: REFS_VERSION, serverTime: serverTime() };
  }
  if (url.pathname === "/api/stats" && method === "GET") {
    const period = url.searchParams.get("period");
    if (!new Set(["shift", "day", "week", "month"]).has(period)) {
      const err = new Error("bad_request");
      err.status = 400;
      throw err;
    }
    const now = Date.now();
    const range = periodRange(period, now, refs.settings.schedule);
    return { ok: true, period, label: range.label, stats: computeStats(events, { ...range, nowMs: now, refs }), serverTime: serverTime() };
  }
  if (url.pathname === "/api/events" && method === "POST") {
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
      // Повтор очереди подтверждаем без повторной записи, как на сервере.
      if (events.some((old) => old.id === e.id)) {
        saved.push(e.id);
        continue;
      }
      let at;
      try { at = core.toMs(e.at); }
      catch {
        rejected.push({ id: e.id, error: "bad_request" });
        continue;
      }
      if (at > Date.now() + 2 * 60000) {
        rejected.push({ id: e.id, error: "bad_time" });
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
      const timeError = core.eventTimeError(events, e, Date.now());
      if (timeError) {
        rejected.push({ id: e.id, error: timeError });
        continue;
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
