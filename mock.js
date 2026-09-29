// Имитация сервера в памяти для проверки страницы без backend.
// Подключается только из app.js при ?mock=1. Считает на том же ядре, что и сервер.
import * as core from "./core/core.js";

const refs = {
  reasons: {
    R03: { title: "Замятие полосы", short: "Замятие", group: "Прокатка", planned: false },
    R04: { title: "Обрыв полосы", short: "Обрыв", group: "Прокатка", planned: false },
    R01: { title: "Настройка клетей", short: "Настройка клетей", group: "Наладка", planned: false },
    R02: { title: "Перевалка валков", short: "Перевалка валков", group: "Наладка", planned: true },
    E01: { title: "Нет напряжения", short: "Нет напряжения", group: "Электрика", planned: false },
    E02: { title: "Авария привода", short: "Авария привода", group: "Электрика", planned: false },
    M01: { title: "Подшипник клети", short: "Подшипник клети", group: "Механика", planned: false },
    M02: { title: "Гидравлика", short: "Гидравлика", group: "Механика", planned: false },
    O01: { title: "Нет заготовок", short: "Нет заготовок", group: "Организация", planned: false },
    O02: { title: "Ожидание крана", short: "Ожидание крана", group: "Организация", planned: false },
    P01: { title: "Плановый ремонт", short: "Плановый ремонт", group: "Плановые", planned: true },
    P02: { title: "Технологическая пауза", short: "Тех. пауза", group: "Плановые", planned: true },
  },
  tiles: [
    { id: "t-roll", title: "Прокатка", codes: ["R03", "R04"] },
    { id: "t-setup", title: "Наладка", codes: ["R01", "R02"] },
    { id: "t-elec", title: "Электрика", codes: ["E01", "E02"] },
    { id: "t-mech", title: "Механика", codes: ["M01", "M02"] },
    { id: "t-org", title: "Организация", codes: ["O01", "O02"] },
    { id: "t-plan", title: "Плановые", codes: ["P01", "P02"] },
  ],
  nodes: [
    { id: "n1", title: "Печь" },
    { id: "n2", title: "Черновая группа" },
    { id: "n3", title: "Чистовая группа" },
  ],
  settings: { shortStopMinutes: 5, schedule: core.DEFAULT_SCHEDULE },
  crews: [
    { id: "c1", title: "Бригада А" },
    { id: "c2", title: "Бригада Б" },
  ],
  people: [
    { id: "p1", name: "Тест Один", crewId: "c1" },
    { id: "p2", name: "Тест Два", crewId: "c1" },
    { id: "p3", name: "Тест Три", crewId: "c2" },
  ],
  demo: true,
};
const REFS_VERSION = "mock-1";

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

  // Последняя правка fix на отрезок (ядро fix не применяет — это дело сервера)
  const fixes = new Map();
  for (const e of events) {
    if (e.type === "fix") fixes.set(`${e.downtimeId}|${e.index}`, e);
  }

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
      const fix = fixes.get(`${p.downtimeId}|${p.index}`);
      const reason = fix && fix.reason !== undefined ? fix.reason : p.reason ?? null;
      const part = { ...p, reason };
      const cls = core.classify(part, refs, refs.settings);
      const full = {
        ...part,
        ...cls,
        open: seg.open === true && p.endMs === seg.endMs,
        billet: fix && fix.billet !== undefined ? fix.billet : null,
        note: fix && fix.note !== undefined ? fix.note : null,
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
