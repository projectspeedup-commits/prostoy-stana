// Страница рабочего: учёт простоев стана. Чистый ES-модуль, без сборки.
// Версия 2: пошаговые экраны, один вопрос — один экран.
import * as core from "./core/core.js";
import { zoneOf } from "./core/zones.js";
import { dayChart, donut } from "./charts.js";
import { dayCells } from "./core/zones.js";
import { dayScale } from "./timeline.js";

const STORE_KEY = "stan.deviceKey";
const QUEUE_KEY = "stan.queue";
const REFS_KEY = "stan.refs";
const SEQ_KEY = "stan.seq";
const SESSION_KEY = "stan.session.v1";
const DEMO = location.hostname.endsWith("github.io") || new URLSearchParams(location.search).has("mock");
const storageErrors = new Set();
const storageName = (name) => DEMO && name !== STORE_KEY ? `demo.${name}` : name;
const STATE_POLL_MS = 30_000;
const QUEUE_RETRY_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const NOTE_MAX = 500;

const $ = (id) => document.getElementById(id);

function readStore(name) {
  try { return localStorage.getItem(storageName(name)); } catch { return null; }
}
function writeStore(name, value) {
  try {
    localStorage.setItem(storageName(name), value);
    if (localStorage.getItem(storageName(name)) !== value) throw new Error();
    storageErrors.delete(name);
    return true;
  } catch { storageErrors.add(name); return false; }
}
function readJSON(name, fallback) {
  try { return JSON.parse(readStore(name)) ?? fallback; } catch { return fallback; }
}

// Ключ из адреса (#key=...) сохраняем и убираем из адресной строки.
function takeKeyFromHash() {
  const m = /(?:^#|&)key=([^&]*)/.exec(location.hash);
  if (!m) return;
  try {
    const key = decodeURIComponent(m[1]);
    if (key) writeStore(STORE_KEY, key);
  } catch { /* битая запись в адресе */ }
  history.replaceState(null, "", location.pathname + location.search);
}

// --- Обращения к серверу (в демо — имитация из mock.js) ---
let api = realApi;
async function realApi(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(path.replace(/^\//, ""), {
      ...options,
      headers: { "Content-Type": "application/json", "X-Device-Key": key || "", ...(options.headers || {}) },
      signal: ctrl.signal,
      cache: "no-store",
    });
    const data = await r.json().catch(() => null);
    if (r.status === 401) throw Object.assign(new Error("bad_key"), { status: 401 });
    if (!r.ok || !data) throw Object.assign(new Error("http_" + r.status), { status: r.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// --- Состояние клиента ---
let key = null;
let refs = null;          // справочники (кешируются)
let refsVersion = null;
const restored = readJSON(SESSION_KEY, {});
let serverState = restored.state || null;
let stateAt = restored.stateAt || null;
let queue = Array.isArray(restored.queue) ? restored.queue : loadQueue();
let records = Array.isArray(restored.records) ? restored.records : [];
let clockOffset = restored.clockOffset || 0;
let stateEpoch = 0;
let loadingState = false;
let online = false;
let flushing = false;

// Экран и данные мастеров. screen: auto | crew | reason | confirmChange |
// manual | manualCheck | closeCheck | forgotStop | restartTime | restartConfirm | restartAction | actionFix |
// recorded | shift | billet | closeConfirm | closed
const ui = {
  screen: "auto",
  crewId: null,      // выбранная бригада на приёме смены
  crewBack: false,   // приём смены открыт кнопкой «Сменить» — есть куда вернуться
  wz: null,          // мастер причины: {mode, downtimeId, index, step, group, reason, note}
  mw: null,          // мастер «Забыл отметить простой»: {origin, step, from, durMin, group, reason, note}
  rw: null,          // мастер пуска: {downtimeId, index, startMs, reason, note, reasonChanged}
  fw: null,          // забытая остановка при закрытии смены: {step, atMs, group, reason, note}
  closeReceipt: null, // события исправленного состояния перед закрытием смены
  af: null,          // дописывание выполненного: {downtimeId, index, action}
  bl: null,          // шаг заготовки: {downtimeId, index, custom}
  rec: null,         // экран «Простой записан»: {downtimeId}
  closedInfo: null,  // итоги для экрана «Смена сдана»
  closeAction: null, // черновик «что сделали по ремонту» при сдаче смены: {key, text}
  focusNote: false,  // поставить курсор в поле «своими словами»
  keyError: null,
};
const DRAFT_FIELDS = ["screen", "crewId", "crewBack", "wz", "mw", "rw", "fw", "closeReceipt", "af", "bl", "rec", "closedInfo", "card", "repair", "resume", "contactBack", "closeAction", "fio"];
for (const field of DRAFT_FIELDS) {
  if (restored.draft && Object.hasOwn(restored.draft, field)) ui[field] = restored.draft[field];
}
function persistClient() {
  const draft = Object.fromEntries(DRAFT_FIELDS.map((field) => [field, ui[field]]));
  return writeStore(SESSION_KEY, JSON.stringify({ state: serverState, stateAt, queue, records, clockOffset, draft }));
}
function acceptState(state, time) {
  if (!state) return;
  serverState = state;
  stateAt = time || new Date(nowMs()).toISOString();
  updateClock(time);
  persistClient();
}

function loadQueue() {
  try {
    const q = JSON.parse(readStore(QUEUE_KEY));
    if (Array.isArray(q)) return q.filter((e) => e && typeof e.id === "string" && typeof e.type === "string");
  } catch { /* пусто или повреждено */ }
  return [];
}
function persistQueue() {
  return persistClient();
}
function nextSeq() {
  const n = (Number(readStore(SEQ_KEY)) || 0) + 1;
  writeStore(SEQ_KEY, String(n));
  return n;
}
function nowMs() {
  return Date.now() + clockOffset;
}
function updateClock(serverTime) {
  if (serverTime) {
    try { clockOffset = core.toMs(serverTime) - Date.now(); } catch { /* странное время */ }
  }
}

// --- Очередь событий ---
function queueEvent(type, fields = {}) {
  // Кто нажал: бригада и человек из текущего приёма смены
  const who = type === "shift_open" ? null : buildView()?.crew;
  const { at, ...rest } = fields;
  const e = {
    ...(who ? { crewId: who.crewId, personId: who.personId, ...(who.personName ? { personName: who.personName } : {}) } : {}),
    id: crypto.randomUUID(),
    type,
    at: at || new Date(nowMs()).toISOString(),
    device: "web",
    seq: nextSeq(),
    ...rest,
  };
  queue.push(e);
  records.push({ event: e, status: "pending" });
  return e;
}
function send(type, fields = {}) {
  const e = queueEvent(type, fields);
  persistQueue();
  render();
  flush();
  return e;
}
function sendBatch(events) {
  const sent = events.map(({ type, fields }) => queueEvent(type, fields));
  persistQueue();
  render();
  flush();
  return sent;
}

async function flush() {
  if (flushing || !queue.length || !key) return;
  flushing = true;
  stateEpoch++;
  try {
    const batch = queue.slice();
    const d = await api("/api/events", { method: "POST", body: JSON.stringify({ events: batch }) });
    const saved = new Set(d.saved || []);
    const rejected = d.rejected || [];
    const rejectedIds = new Set(rejected.map((r) => r.id));
    for (const event of batch) {
      let record = records.find((r) => r.event.id === event.id);
      if (!record) records.push((record = { event, status: "pending" }));
      if (saved.has(event.id)) {
        record.status = "saved";
        if (record.replaces) {
          const old = records.find((r) => r.event.id === record.replaces);
          if (old) old.status = "replaced";
        }
      }
      if (rejectedIds.has(event.id)) {
        record.status = "rejected";
        record.error = rejected.find((r) => r.id === event.id)?.error;
      }
    }
    // Состояние, результат и удаление из очереди сохраняются одной записью.
    // Без нового состояния сохраняем очередь: повтор того же ID безопасен на сервере.
    if (d.state) {
      queue = queue.filter((e) => !saved.has(e.id) && !rejectedIds.has(e.id));
      acceptState(d.state, d.serverTime);
    } else {
      queue = queue.filter((e) => !rejectedIds.has(e.id));
      persistClient();
    }
    setOnline(true);
  } catch (err) {
    if (err && err.status === 401) return badKey();
    setOnline(false);
  } finally {
    flushing = false;
    stateEpoch++;
  }
  softRender();
}

async function loadState() {
  if (!key || flushing || loadingState) return;
  loadingState = true;
  const epoch = stateEpoch;
  try {
    const d = await api("/api/state");
    if (d && d.ok) {
      if (epoch !== stateEpoch || flushing) return;
      acceptState(d.state, d.serverTime);
      if (d.refsVersion && refsVersion && d.refsVersion !== refsVersion) loadRefs();
      setOnline(true);
    }
  } catch (err) {
    if (err && err.status === 401) return badKey();
    setOnline(false);
  } finally {
    loadingState = false;
  }
  softRender();
}

async function loadRefs() {
  try {
    const d = await api("/api/refs");
    if (d && d.ok && d.refs) {
      refs = d.refs;
      refsVersion = d.refsVersion || null;
      writeStore(REFS_KEY, JSON.stringify({ refs, refsVersion }));
      setOnline(true);
      render();
      return true;
    }
  } catch (err) {
    if (err && err.status === 401) { badKey(); return false; }
    setOnline(false);
  }
  return false;
}

function loadCachedRefs() {
  try {
    const c = JSON.parse(readStore(REFS_KEY));
    if (c && c.refs && c.refs.reasons) {
      refs = c.refs;
      refsVersion = c.refsVersion || null;
    }
  } catch { /* кеш пуст */ }
}

function badKey() {
  ui.keyError = "Ключ не подошёл. Введите другой.";
  key = null;
  writeStore(STORE_KEY, "");
  render();
}

function setOnline(v) {
  online = v;
  renderTopbar();
}

// --- Наложение очереди на состояние сервера ---
function buildView() {
  if (!serverState) return null;
  const s = serverState;
  let open = null;
  if (s.open) {
    const segs = s.open.segments || [];
    const last = segs[segs.length - 1];
    open = {
      downtimeId: s.open.downtimeId,
      startMs: last ? last.startMs : core.toMs(s.open.startMs),
      since: core.toMs(s.open.startMs),
      reason: last && last.reason !== undefined ? last.reason : null,
      note: last && last.note !== undefined ? last.note : null,
      action: last && last.action !== undefined ? last.action : null,
      index: last ? last.index : 0,
      handovers: Array.isArray(s.open.handovers) ? s.open.handovers.slice() : [],
    };
  }
  const v = {
    running: !!s.running,
    open,
    crew: s.crew ? { ...s.crew } : null,
    closed: !!s.closed,
    shift: s.shift,
    dataFromMs: s.dataFromMs ?? null,
    runningSinceMs: s.runningSinceMs ?? null,
    segments: (s.segments || []).filter((x) => !open || x.downtimeId !== open.downtimeId || x.index !== open.index).map((x) => ({ ...x })),
  };
  // Серверный closed означает «была сдача в этом периоде». Новый местный
  // приём после неё подтверждён, если сервер вернул именно этого работника.
  const lastShift = records.filter((r) => r.status === "saved" &&
    ["shift_open", "shift_close"].includes(r.event.type))
    .sort((a, b) => core.toMs(a.event.at) - core.toMs(b.event.at) || (a.event.seq || 0) - (b.event.seq || 0)).at(-1)?.event;
  if (lastShift?.type === "shift_open" && s.crew?.at === lastShift.at) v.closed = false;
  for (const e of queue) applyEvent(v, e);
  // Первое нажатие ещё не дошло до сервера — учёт начался с него
  for (const e of queue) {
    for (const t of [e.at, e.type === "manual" ? e.from : undefined]) {
      if (t === undefined || t === null) continue;
      try { const ms = core.toMs(t); if (v.dataFromMs === null || ms < v.dataFromMs) v.dataFromMs = ms; } catch { /* битое время пропускаем */ }
    }
  }
  if (refs) v.shift = core.shiftOf(nowMs(), refs.settings.schedule);
  v.segments.sort((a, b) => a.startMs - b.startMs || (a.index || 0) - (b.index || 0));
  return v;
}

function applyEvent(v, e) {
  const t = e.at ? core.toMs(e.at) : nowMs();
  const matchOpen = () => v.open && (!e.downtimeId || e.downtimeId === v.open.downtimeId);
  const closeOpen = (endMs) => {
    v.segments.push({
      downtimeId: v.open.downtimeId,
      index: v.open.index,
      startMs: v.open.startMs,
      endMs,
      minutes: Math.max(0, Math.round((endMs - v.open.startMs) / 60000)),
      reason: v.open.reason,
      note: v.open.note ?? null,
      action: v.open.action ?? null,
      manual: false,
      open: false,
      pending: true,
    });
  };
  switch (e.type) {
    case "stop":
      if (!v.open) {
        v.open = { downtimeId: e.downtimeId || e.id, startMs: t, since: t, reason: e.reason ?? null, note: null, index: 0 };
        v.running = false;
      }
      break;
    case "reason":
      if (matchOpen()) {
        v.open.reason = e.reason !== undefined ? e.reason : null;
        if (e.note !== undefined) v.open.note = e.note;
      }
      break;
    case "split":
      if (matchOpen()) {
        closeOpen(t);
        v.open = {
          downtimeId: v.open.downtimeId,
          index: v.open.index + 1,
          startMs: t,
          since: v.open.since ?? v.open.startMs,
          reason: e.reason ?? null,
          note: e.note !== undefined ? e.note : null,
          handovers: v.open.handovers,
        };
      }
      break;
    case "start":
      if (matchOpen()) {
        if (e.action !== undefined) v.open.action = e.action;
        closeOpen(t);
        v.open = null;
        v.running = true;
        v.runningSinceMs = t;
      }
      break;
    case "manual": {
      const from = core.toMs(e.from);
      const to = core.toMs(e.to);
      if (to > from) {
        v.runningSinceMs = Math.max(v.runningSinceMs ?? to, to);
        v.segments.push({
          downtimeId: e.downtimeId || e.id,
          index: 0,
          startMs: from,
          endMs: to,
          minutes: Math.round((to - from) / 60000),
          reason: e.reason ?? null,
          note: e.note !== undefined ? e.note : null,
          action: e.action !== undefined ? e.action : null,
          manual: true,
          open: false,
          pending: true,
        });
      }
      break;
    }
    case "fix":
      for (const s of v.segments) {
        if (s.downtimeId === e.downtimeId && s.index === e.index) {
          if (e.reason !== undefined) s.reason = e.reason;
          if (e.billet !== undefined) s.billet = e.billet;
          if (e.note !== undefined) s.note = e.note;
          if (e.action !== undefined) s.action = e.action;
        }
      }
      if (v.open && v.open.downtimeId === e.downtimeId && v.open.index === e.index) {
        if (e.reason !== undefined) v.open.reason = e.reason;
        if (e.note !== undefined) v.open.note = e.note;
        if (e.action !== undefined) v.open.action = e.action;
      }
      break;
    case "shift_open":
      v.crew = { crewId: e.crewId, personId: e.personId, personName: e.personName ?? null, at: e.at };
      v.closed = false;
      break;
    case "shift_close":
      if (v.open && t >= (v.open.since ?? v.open.startMs) &&
          !(v.open.handovers || []).some((x) => x.at === e.at && x.crewId === (e.crewId ?? null))) {
        v.open.handovers = [...(v.open.handovers || []),
          { at: e.at, crewId: e.crewId ?? null, personId: e.personId ?? null, personName: e.personName ?? null, action: e.action ?? null, note: e.note ?? null }];
      }
      if (v.crew && core.toMs(v.crew.at) > t) break;
      v.crew = null;
      v.closed = true;
      break;
  }
}

// --- Сводка текущей смены по видимым отрезкам ---
function shiftSummary(view) {
  const schedule = refs.settings.schedule;
  const shift = view.shift;
  const segs = [];
  for (const s of view.segments) {
    const startMs = Math.max(s.startMs, shift.startMs);
    const endMs = Math.min(s.open || s.endMs === null ? nowMs() : s.endMs, shift.endMs);
    if (endMs > startMs) segs.push({ ...s, startMs, endMs });
  }
  if (view.open) {
    const startMs = Math.max(view.open.startMs, shift.startMs);
    const endMs = Math.min(nowMs(), shift.endMs);
    if (endMs > startMs) {
      segs.push({ downtimeId: view.open.downtimeId, index: view.open.index, startMs, endMs, reason: view.open.reason, manual: false, open: true });
    }
  }
  const parts = [];
  for (const s of segs) {
    try {
      for (const p of core.splitByShifts(s, schedule)) {
        parts.push({ ...p, ...core.classify(p, refs, refs.settings) });
      }
    } catch { /* битый отрезок — пропускаем */ }
  }
  const sum = core.summarizeDay(parts, [shift], {});
  return sum.shifts[0];
}

// Простои текущей смены, сгруппированные по downtimeId (один простой — одна строка)
function shiftDowntimes(view) {
  const shift = view.shift;
  const segs = view.segments.filter((s) =>
    (s.open || s.endMs === null ? nowMs() : s.endMs) > shift.startMs && s.startMs < shift.endMs);
  if (view.open && view.open.startMs < shift.endMs
      && !segs.some((s) => s.downtimeId === view.open.downtimeId && s.index === view.open.index)) {
    segs.push({
      downtimeId: view.open.downtimeId, index: view.open.index, startMs: view.open.startMs,
      endMs: null, reason: view.open.reason, note: view.open.note ?? null, action: view.open.action ?? null, open: true, manual: false,
    });
  }
  const map = new Map();
  for (const s of segs) {
    let g = map.get(s.downtimeId);
    if (!g) map.set(s.downtimeId, (g = { downtimeId: s.downtimeId, segs: [] }));
    g.segs.push(s);
  }
  const out = [];
  for (const g of map.values()) {
    g.segs.sort((a, b) => a.startMs - b.startMs || (a.index || 0) - (b.index || 0));
    const first = g.segs[0];
    const last = g.segs[g.segs.length - 1];
    const isOpen = !!last.open || last.endMs === null;
    out.push({
      downtimeId: g.downtimeId,
      startMs: first.startMs,
      endMs: isOpen ? null : last.endMs,
      open: isOpen,
      // Начался в прошлую смену: часть продолжения или открытый простой старше начала смены
      continued: !!first.continued || (isOpen && !!view.open && (view.open.since ?? view.open.startMs) < shift.startMs),
      minutes: Math.round(g.segs.reduce((a, s) => a + ((s.open || s.endMs === null ? nowMs() : s.endMs) - s.startMs), 0) / 60000),
      reason: last.reason ?? null,
      note: last.note ?? null,
      action: last.action ?? null,
      billet: g.segs.map((s) => s.billet).find((b) => b !== null && b !== undefined) ?? null,
      manual: g.segs.some((s) => s.manual),
      indexLast: last.index || 0,
      segs: g.segs,
    });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

// --- Форматирование ---
const two = (n) => String(n).padStart(2, "0");
function fmtClock(ms) {
  const off = (refs && refs.settings && refs.settings.schedule && refs.settings.schedule.tzOffsetMinutes) ?? 180;
  const d = new Date(ms + off * 60000);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}
// Период по часам: дневной или ночной, с границами — чтобы не путать со сменами-бригадами
function periodLabel(shift) {
  const off = (refs && refs.settings && refs.settings.schedule && refs.settings.schedule.tzOffsetMinutes) ?? 180;
  const h = new Date(shift.startMs + off * 60000).getUTCHours();
  const name = h >= 6 && h < 18 ? "Дневная" : "Ночная";
  return `${name} ${fmtClock(shift.startMs)}–${fmtClock(shift.endMs)}`;
}
function fmtDate(ms) {
  const off = (refs && refs.settings && refs.settings.schedule && refs.settings.schedule.tzOffsetMinutes) ?? 180;
  const d = new Date(ms + off * 60000);
  return String(d.getUTCDate()).padStart(2, "0") + "." + String(d.getUTCMonth() + 1).padStart(2, "0");
}
// Начало простоя: если оно раньше начала текущей смены — с датой («28.09 21:12»)
function fmtSince(ms, shift) {
  return ms < shift.startMs ? `${fmtDate(ms)} ${fmtClock(ms)}` : fmtClock(ms);
}

// Работа за смену: от начала смены, а если учёт начался позже — от первой записи.
// Записей нет совсем — о стане ничего не известно, работу не считаем
function shiftWorkMin(view, downMin) {
  const from = Math.max(view.shift.startMs, view.dataFromMs ?? nowMs());
  const to = Math.min(nowMs(), view.shift.endMs);
  return Math.max(0, Math.round((to - from) / 60000) - downMin);
}

// Табло стана: московское время, состояние, работа, простой и остановки за период
function board(view) {
  const shift = view.shift;
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const workMin = shiftWorkMin(view, downMin);
  const stops = shiftDowntimes(view).length;
  const stopped = !!view.open;
  return h("div", { class: "board" },
    h("div", { class: "board-top" },
      h("span", { class: "board-clock", text: fmtClock(nowMs()) }),
      h("span", { class: "board-date", text: `${fmtDate(nowMs())} · Москва` })),
    h("div", { class: "board-state " + (stopped ? "stopped" : "running"),
      text: stopped ? `Стан стоит с ${fmtSince(view.open.since ?? view.open.startMs, shift)}` : "Стан работает" }),
    h("div", { class: "board-period muted", text: `${periodLabel(shift)} · с начала периода${refs.demo ? " · демо-данные" : ""}` }),
    h("div", { class: "board-stats" },
      h("div", { class: "board-stat good" }, h("span", { class: "v", text: fmtHM(workMin) }), "работа"),
      h("div", { class: "board-stat bad" }, h("span", { class: "v", text: fmtHM(downMin) }), "простой"),
      h("div", { class: "board-stat" }, h("span", { class: "v", text: String(stops) }), "остановок")));
}

// Коротко для табло: «2 ч 11 м»
function fmtHM(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${min % 60} м` : `${min} м`;
}
// Подсказки в полях — по теме выбранной причины (из справочника)
const DEFAULT_NOTE_HINT = "Например: на третьей клети заклинило подшипник";
const DEFAULT_ACTION_HINT = "Например: заменили ножи, подтянули муфту";
function noteHint(code) { return (reasonRef(code) && reasonRef(code).hint) || DEFAULT_NOTE_HINT; }
function actionHint(code) { return (reasonRef(code) && reasonRef(code).actionHint) || DEFAULT_ACTION_HINT; }
// «Иная причина»: описание своими словами обязательно
function isOther(code) { return !!(reasonRef(code) && reasonRef(code).other); }
// Описание своими словами обязательно: у «иной» причины и у трёх блоков без подпунктов
function needsNote(code) { const r = reasonRef(code); return !!(r && (r.other || r.noteRequired)); }

function fmtDurMin(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
// Долгий простой: от суток — «1 сут 10 ч 21 мин», меньше — как fmtDurMin
function fmtDurLong(min) {
  min = Math.max(0, Math.round(min));
  const days = Math.floor(min / 1440);
  return days ? `${days} сут ${Math.floor((min % 1440) / 60)} ч ${min % 60} мин` : fmtDurMin(min);
}
// Сколько работает стан, с секундами: «6 ч 34 мин 12 с», «34 мин 12 с», «12 с»
function fmtDurSec(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h} ч ${m} мин ${ss} с` : m ? `${m} мин ${ss} с` : `${ss} с`;
}
function fmtTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  // От суток: «1 сут 02:30:12»
  if (days) return `${days} сут ${two(h)}:${two(m)}:${two(ss)}`;
  return h ? `${h}:${two(m)}:${two(ss)}` : `${two(m)}:${two(ss)}`;
}
function plural(n, one, few, many) {
  const m = Math.abs(n) % 100;
  const d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}
function fmtTons(v) {
  return String(v).replace(".", ",") + " т";
}

// --- DOM ---
// Заменить содержимое элемента, пропуская пустые узлы: replaceChildren(null) вывел бы слово «null»
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const val = attrs[k];
      if (val === null || val === undefined || val === false) continue;
      if (k === "class") el.className = val;
      else if (k === "text") el.textContent = val;
      // Стиль — через CSSOM: атрибут style запрещён политикой безопасности страницы
      else if (k === "style") el.style.cssText = val;
      else if (k === "dataset") Object.assign(el.dataset, val);
      else if (k.startsWith("on") && typeof val === "function") el.addEventListener(k.slice(2), val);
      else if (val === true) el.setAttribute(k, "");
      else el.setAttribute(k, val);
    }
  }
  for (const kid of kids.flat()) {
    if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  }
  return el;
}

// Кнопка «Назад»: первая строка вложенного экрана, во всю ширину, серая рамка
function backBtn(label, onclick) {
  return h("button", { class: "btn back", onclick }, "← " + label);
}
function stepLine(n, total) {
  return h("p", { class: "step", text: `Шаг ${n} из ${total}` });
}
function question(text) {
  return h("h1", { class: "q", text });
}

let toastTimer = null;
function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

function renderTopbar() {
  // Кнопка «Связаться»: открывает экран звонка. Цвет — состояние связи с сервером
  const conn = $("conn");
  if (!conn.dataset.bound) {
    conn.dataset.bound = "1";
    conn.addEventListener("click", () => { if (key && refs) { ui.contactBack = ui.screen; go("contact"); } });
  }
  conn.className = "pill";
  conn.textContent = "Связаться";
  const status = $("save-status");
  if (status) {
    const rejected = records.filter((r) => r.status === "rejected").length;
    status.className = "save-status" + (storageErrors.size || rejected ? " attention" : "");
    status.textContent = storageErrors.size
      ? "На планшете не сохранено. Не закрывайте страницу. Освободите память и повторите сохранение."
      : rejected ? `Нужно исправить: ${rejected}. Текст сохранён — откройте запись ниже.`
      : queue.length ? `Сохранено на планшете · ждут отправки: ${queue.length}`
      : online ? (records.some((r) => r.status === "saved") ? "Принято сервером" : "Связь с сервером есть")
      : stateAt ? `Без сети · последние данные: ${fmtDate(core.toMs(stateAt))}, ${fmtClock(core.toMs(stateAt))} МСК`
      : "Нет связи с сервером";
    status.hidden = !key;
  }
  // Главная страница не уничтожает ответы незаконченного шага.
  const home = $("demo");
  if (!home.dataset.bound) {
    home.dataset.bound = "1";
    home.addEventListener("click", () => {
      if (isDraftScreen(ui.screen)) ui.resume = ui.screen;
      go("auto");
    });
  }
  home.hidden = !key;
}

function renderRejects() {
  const box = $("rejects");
  const rejected = records.filter((r) => r.status === "rejected");
  if (!rejected.length && !storageErrors.size) {
    box.hidden = true;
    fill(box, );
    return;
  }
  box.hidden = false;
  fill(box,
    storageErrors.size ? h("button", { class: "btn", onclick: () => { persistClient(); render(); } }, "Повторить сохранение на планшете") : null,
    ...rejected.map((r) => h("div", { class: "reject" },
      h("strong", { text: "Нужно исправить · " + eventTitle(r.event) }),
      h("p", { text: humanError(r.error) }),
      h("button", { class: "btn", onclick: () => {
        ui.repair = { id: r.event.id, event: { ...r.event }, back: ui.screen };
        go("repair");
      } }, "Открыть сохранённую запись")))
  );
}

function humanError(code) {
  const messages = {
    overlap: "Остановка пересекается с записанным простоем или указана раньше последнего пуска. Проверьте время или дополните запись в итоге смены.",
    bad_time: "Время ещё не наступило или пуск указан раньше остановки либо последней смены причины. Проверьте время записи и часы планшета.",
    bad_range: "Конец простоя должен быть позже начала. Исправьте время.",
    bad_request: "Не удалось принять данные. Проверьте время и ответы, затем отправьте запись снова.",
    bad_event: "Не удалось принять запись. Проверьте ответы и отправьте её снова.",
    bad_key: "Планшет не подключён. Попросите мастера проверить подключение. Ответы сохранены.",
  };
  return messages[code] || "Сервер не принял запись. Ответы сохранены. Проверьте их и повторите отправку; если не поможет — свяжитесь с мастером.";
}
function eventTitle(e) {
  return ({ stop: "остановка", start: "пуск", reason: "причина", split: "смена причины", fix: "исправление", manual: "простой вручную", shift_open: "приём смены", shift_close: "закрытие смены" })[e.type] || "запись";
}
function receiptStatus(list) {
  if (list.some((r) => r.status === "rejected")) return "Нужно исправить";
  if (!list.length || list.some((r) => r.status === "pending")) {
    return storageErrors.has(SESSION_KEY) ? "На планшете не сохранено" : "Сохранено на планшете";
  }
  return "Принято сервером";
}
function receiptFor(downtimeId) {
  return records.filter((r) => r.status !== "replaced" && (r.event.downtimeId || r.event.id) === downtimeId);
}

function reasonRef(code) {
  return code && refs.reasons ? refs.reasons[code] : undefined;
}
function reasonLabel(code) {
  const r = reasonRef(code);
  // «Иная причина» — с группой: «Иная механическая причина»
  if (r && r.other) return r.title || r.short || "Иная причина";
  return r ? r.short || r.title || "Причина без названия" : code ? "Уточните причину" : "";
}
function personName(id) {
  const p = (refs.people || []).find((x) => x.id === id);
  return p ? p.name : "—";
}
// ФИО мастера: введённое при приёме смены, иначе из списка
function personLabel(id, name) {
  return typeof name === "string" && name.trim() ? name.trim() : personName(id);
}
function crewTitle(id) {
  const c = (refs.crews || []).find((x) => x.id === id);
  return c ? c.title : id != null && id !== "" ? `Смена ${id}` : "—";
}
// ФИО полностью: три слова и больше, без инициалов с точками
function fullName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return parts.length >= 3 && parts.every((p) => p.length >= 2 && !p.includes("."));
}

function needCrew(view) {
  if (!view.crew || view.closed) return true;
  try {
    const at = core.shiftOf(view.crew.at, refs.settings.schedule);
    return !(at.day === view.shift.day && at.shiftNo === view.shift.shiftNo);
  } catch {
    return true;
  }
}

function go(screen) {
  ui.screen = screen;
  if (isDraftScreen(screen)) ui.resume = null;
  render();
}

function isDraftScreen(screen) {
  return ["reason", "manual", "manualCheck", "closeCheck", "forgotStop", "restartTime", "restartConfirm", "restartAction", "actionFix", "billet", "repair", "repairField"].includes(screen);
}
function cancelDraft() {
  const from = ui.screen;
  ui.wz = ui.mw = ui.rw = ui.fw = ui.af = ui.bl = ui.repair = ui.resume = null;
  go(["actionFix", "billet"].includes(from) ? "detail" : "auto");
}

// --- Экраны ---
function render() {
  renderScreen();
  // На первом шаге причины выход уже есть: «Назад» и «Пока не знаю». Третья кнопка лишняя
  const firstReasonStep = ui.screen === "reason" && ui.wz?.step === 1 && !ui.rw;
  // На вопросе о состоянии стана выход уже есть: «На главный экран»
  const noCancel = firstReasonStep || ui.screen === "closeCheck";
  if (key && refs && serverState && isDraftScreen(ui.screen) && !noCancel) {
    $("main").append(h("button", { class: "btn btn-flat cancel", onclick: cancelDraft },
      ui.rw ? "Отменить оформление пуска" : "Отменить изменения"));
  }
  persistClient();
  renderTopbar();
  renderRejects();
}
function renderScreen() {
  renderTopbar();
  renderRejects();
  const main = $("main");
  if (!key) return renderKey(main);
  if (!refs) return renderNoRefs(main);
  const view = buildView();
  if (!view) return renderLoading(main);
  switch (ui.screen) {
    case "crew": return renderCrew(main, view);
    case "reason": return renderReasonWizard(main, view);
    case "confirmChange": return renderConfirmChange(main, view);
    case "manual": return renderManual(main, view);
    case "manualCheck": return renderManualCheck(main, view);
    case "closeCheck": return renderCloseCheck(main, view);
    case "forgotStop": return renderForgotStop(main, view);
    case "restartTime": return renderRestartTime(main, view);
    case "restartConfirm": return renderRestartConfirm(main, view);
    case "restartAction": return renderRestartAction(main, view);
    case "actionFix": return renderActionFix(main, view);
    case "recorded": return renderRecorded(main, view);
    case "shift": return renderShift(main, view);
    case "billet": return renderBillet(main, view);
    case "closeConfirm": return renderCloseConfirm(main, view);
    case "closed": return renderClosed(main, view);
    case "contact": return renderContact(main, view);
    case "stats": return renderStats(main, view);
    case "detail": return renderDetail(main, view);
    case "repair": return renderRepair(main, view);
    case "repairField": return renderRepairField(main, view);
  }
  if (view.closed && ui.closedInfo) return renderClosed(main, view);
  if (needCrew(view)) return renderCrew(main, view);
  if (view.open) return renderStop(main, view);
  return renderRun(main, view);
}

// Экран «Связаться»: звонок мастеру, ремонтникам, диспетчеру.
// Номера задаются в настройках (refs.settings.contacts); пока их нет — показываем, кому звонить.
const DEFAULT_CONTACTS = [
  { title: "Мастер смены", tel: "" },
  { title: "Дежурный механик", tel: "" },
  { title: "Дежурный электрик", tel: "" },
  { title: "Диспетчер", tel: "" },
];
function renderContact(main, view) {
  const list = (refs.settings && refs.settings.contacts) || DEFAULT_CONTACTS;
  const back = ui.contactBack && ui.contactBack !== "contact" ? ui.contactBack : "auto";
  const status = online && !queue.length ? "Связь с сервером есть, нажатия доходят."
    : online ? `Отправляются нажатия: ${queue.length}.`
    : `Нет связи с сервером. Нажатия сохранены на планшете${queue.length ? ` (${queue.length})` : ""} и уйдут сами, когда связь появится.`;
  fill(main,
    backBtn("Вернуться", () => go(back)),
    question("Связаться"),
    h("p", { class: "muted", text: status }),
    h("div", { class: "tiles one" },
      list.map((c) => c.tel
        ? h("a", { class: "tile", href: `tel:${c.tel}` }, c.title, h("span", { class: "t-code", text: c.tel }))
        : h("div", { class: "tile tile-off" }, c.title, h("span", { class: "t-code", text: "номер не задан" }))))
  );
}

// Рендер по таймерам/ответам сервера: не дёргать экран, пока рабочий печатает
function softRender() {
  const a = document.activeElement;
  if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && $("main").contains(a)) {
    renderTopbar();
    return;
  }
  render();
}

function renderKey(main) {
  const input = h("input", { type: "password", autocomplete: "off", "aria-label": "Ключ устройства" });
  fill(main,
    h("h1", { class: "q", text: "Устройство не подключено" }),
    h("p", { class: "muted", text: "Введите ключ устройства из письма мастера или откройте ссылку с ключом." }),
    ui.keyError ? h("p", { class: "error-text", text: ui.keyError }) : null,
    input,
    h("button", {
      class: "btn primary",
      onclick: () => {
        const v = input.value.trim();
        if (!v) return;
        key = v;
        ui.keyError = null;
        writeStore(STORE_KEY, v);
        boot();
      },
    }, "Подключить")
  );
}

function renderNoRefs(main) {
  fill(main,
    h("h1", { class: "q", text: "Нет данных" }),
    h("p", { class: "muted", text: "На планшете ещё нет списка работников и причин простоя. Подключитесь к сети и повторите загрузку." }),
    h("button", { class: "btn primary", onclick: () => { loadRefs().then((ok) => { if (ok) loadState(); else render(); }); } }, "Повторить")
  );
}

function renderLoading(main) {
  fill(main,
    question(loadingState ? "Получаем состояние стана…" : "Нужно первое подключение"),
    h("p", { class: "muted", text: "На планшете ещё нет состояния стана. Подключитесь к сети и нажмите «Повторить». После этого можно будет работать без сети." }),
    h("button", { class: "btn", disabled: loadingState, onclick: () => boot() }, "Повторить")
  );
}

// Приём смены: шаг 1 — бригада, шаг 2 — человек
function acceptShift(crewId, personId, personName) {
  ui.fio = null;
  if (ui.repair?.event.type === "shift_open") {
    Object.assign(ui.repair.event, { crewId, personId, personName });
    ui.crewId = null;
    return go("repair");
  }
  send("shift_open", { crewId, personId, personName });
  ui.crewId = null;
  ui.crewBack = false;
  go("auto");
}

// Фамилия, имя и отчество мастера — обязательно полностью
function renderFio(main, view) {
  const fio = ui.fio;
  const fields = [["last", "Фамилия"], ["first", "Имя"], ["middle", "Отчество"]];
  const ok = (v) => /^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z\u2019' -]{1,39}$/.test(String(v || "").trim());
  const cap = (v) => String(v || "").trim().replace(/\s+/g, " ").replace(/(^|[ -])([а-яёa-z])/g, (m, p, c) => p + c.toUpperCase());
  const error = h("p", { class: "error-text", text: "Впишите фамилию, имя и отчество полностью, без сокращений." });
  error.hidden = true;
  const submit = h("button", { class: "btn primary", onclick: () => {
    if (!fields.every(([k]) => ok(fio[k]))) { error.hidden = false; return; }
    acceptShift(fio.crewId, fio.personId, fields.map(([k]) => cap(fio[k])).join(" "));
  } }, "Принять смену");
  const update = () => { submit.disabled = !fields.every(([k]) => ok(fio[k])); };
  const inputs = fields.map(([k, label]) => {
    const input = h("input", { type: "text", id: `fio-${k}`, autocomplete: "off", autocapitalize: "words", spellcheck: "false", maxlength: "40" });
    input.value = fio[k] || "";
    input.addEventListener("input", () => { fio[k] = input.value; error.hidden = true; update(); persistClient(); });
    return [h("label", { for: `fio-${k}`, text: label }), input];
  });
  update();
  fill(main, backBtn("К списку мастеров", () => { ui.fio = null; render(); }),
    question("Фамилия, имя и отчество мастера"),
    h("p", { class: "muted", text: `${crewTitle(fio.crewId)} · ${periodLabel(view.shift)}. Полностью, как в документах: так мастер будет записан в приёме смены.` }),
    ...inputs.flat(), error, submit);
  if (!fio.last) main.querySelector("#fio-last")?.focus();
  else if (!fio.first) main.querySelector("#fio-first")?.focus();
}

function renderCrew(main, view) {
  if (ui.fio) return renderFio(main, view);
  const crews = refs.crews || [];
  const single = crews.length === 1 ? crews[0].id : null;
  const chosen = ui.crewId || single;
  const kids = [];
  if (!chosen) {
    if (ui.crewBack) kids.push(backBtn("На главный экран", () => { ui.crewBack = false; go("auto"); }));
    kids.push(board(view), stepLine(1, 2), question("Выберите вашу смену"),
      h("p", { class: "muted", text: `Сейчас: ${periodLabel(view.shift)}` }));
    kids.push(h("div", { class: "tiles" },
      crews.map((c) => h("button", { class: "tile", onclick: () => { ui.crewId = c.id; render(); } }, c.title))
    ));
    kids.push(metrics());
  } else {
    if (!single) {
      kids.push(backBtn("К выбору смены", () => { ui.crewId = null; render(); }));
    } else if (ui.crewBack) {
      kids.push(backBtn("На главный экран", () => { ui.crewBack = false; go("auto"); }));
    }
    // У кого в списке только инициалы — ФИО дописывают при приёме
    const pick = (p) => {
      if (fullName(p.name)) return acceptShift(chosen, p.id, p.name.trim().replace(/\s+/g, " "));
      ui.fio = { crewId: chosen, personId: p.id, last: p.name.trim().split(/\s+/)[0] || "", first: "", middle: "" };
      render();
    };
    const tile = (p) => h("button", { class: "tile", onclick: () => pick(p) }, p.name);
    const own = (refs.people || []).filter((p) => p.crewId === chosen);
    kids.push(stepLine(single ? 1 : 2, single ? 1 : 2), question("Мастер, который принимает смену"),
      h("p", { class: "muted", text: `${crewTitle(chosen)} · ${periodLabel(view.shift)}` }),
      h("div", { class: "tiles" }, own.map(tile)),
      h("button", { class: "btn", onclick: () => { ui.fio = { crewId: chosen, personId: null, last: "", first: "", middle: "" }; render(); } }, "Нет в списке — ввести ФИО"));
  }
  fill(main, ...kids);
}

// Шкала суток: 48 получасовых ячеек текущих производственных суток (08:00–08:00).
// Прошлая смена этих суток — с сервера, текущая — с учётом ещё не отправленных нажатий
function scaleFor(view) {
  try {
    const HOUR = 3_600_000;
    const now = nowMs();
    const shiftFrom = view.shift.startMs;
    const fromMs = serverState?.day?.fromMs ?? (view.shift.shiftNo === 1 ? shiftFrom : shiftFrom - 12 * HOUR);
    const endOf = (s) => (s.open || s.endMs == null ? now : s.endMs);
    const earlier = (serverState?.day?.segments || [])
      .filter((s) => s.startMs < shiftFrom)
      .map((s) => ({ startMs: s.startMs, endMs: Math.min(endOf(s), shiftFrom), reason: s.reason ?? null }));
    const current = view.segments.map((s) => ({ startMs: Math.max(s.startMs, shiftFrom), endMs: endOf(s), reason: s.reason ?? null }));
    if (view.open) current.push({ startMs: Math.max(view.open.startMs, shiftFrom), endMs: now, reason: view.open.reason ?? null });
    const cells = dayCells([...earlier, ...current], { fromMs, toMs: fromMs + 24 * HOUR, nowMs: now, dataFromMs: view.dataFromMs, refs });
    return dayScale({ cells, nowMs: now, shiftFromMs: shiftFrom, shiftToMs: view.shift.endMs, fmtClock, fmtDate: () => fmtDate(fromMs) });
  } catch (e) {
    console.error("Шкала суток:", e);
    return null;
  }
}
// Главный экран: шкала слева (на узком экране — под кнопками), справа всё остальное
function withScale(view, ...kids) {
  return h("div", { class: "with-scale" }, scaleFor(view), h("div", { class: "with-scale__main" }, ...kids));
}

// Главный экран: стан работает
function renderRun(main, view) {
  const dts = shiftDowntimes(view);
  // С последнего пуска, даже если он был в прошлую смену; до первой записи о стане ничего не известно
  const lastStart = Math.min(nowMs(), runningSince(view));
  fill(main, withScale(view,
    h("div", { class: "bar green" },
      "Стан работает · ",
      h("span", { dataset: { since: String(lastStart), fmt: "durs" } }, fmtDurSec((nowMs() - lastStart) / 1000)),
      h("span", { class: "msk", "data-msk": "1", text: fmtClock(nowMs()) + " МСК" })
    ),
    h("button", {
      class: "btn danger btn-huge",
      onclick: () => {
        const downtimeId = crypto.randomUUID();
        send("stop", { downtimeId });
        // Сразу предлагаем причину, но можно и позже
        ui.wz = { mode: "current", downtimeId, step: 1, group: null, reason: null, note: "" };
        go("reason");
      },
    }, "СТАН ВСТАЛ"),
    h("p", { class: "hint", text: "Нажмите, как только стан остановился" }),
    shiftBlock(view)
  ));
}

// --- Метрики работы стана за период (первый экран) ---
const PERIODS = [["shift", "Смена"], ["day", "Сутки"], ["week", "7 суток"], ["month", "Месяц"]];
const STATS_TTL_MS = 60000;
function loadStats(period) {
  ui.stats = ui.stats || {};
  const c = ui.stats[period];
  if (c && (c.loading || nowMs() - c.at < STATS_TTL_MS)) return;
  ui.stats[period] = { ...(c || {}), loading: true };
  api(`/api/stats?period=${period}`)
    .then((d) => { ui.stats[period] = { data: d.stats, label: d.label, at: nowMs() }; })
    .catch(() => { ui.stats[period] = { ...(c || {}), error: true, at: nowMs() }; })
    .finally(() => softRender());
}
const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const mins = (x) => (x === null || x === undefined ? "—" : fmtHM(x));
// Подпись строки: время · остановки · доля · принят стоящим (у смен, принявших простой уже стоящим)
function barValue(r, total) {
  const parts = [fmtHM(r.minutes)];
  if (r.stops || !r.carried) parts.push(`${r.stops} ост.`);
  if (total) parts.push(`${Math.round((r.minutes / total) * 100)}%`);
  if (r.carried) parts.push(r.carried === 1 ? "принят стоящим" : `принят стоящим: ${r.carried}`);
  return parts.join(" · ");
}
function barList(title, rows, total, label, zone = null) {
  if (!rows || !rows.length) return null;
  const max = Math.max(...rows.map((r) => r.minutes), 1);
  return h("div", { class: "m-block" },
    h("div", { class: "m-title", text: title }),
    rows.slice(0, 8).map((r) => h("div", { class: "m-bar" },
      h("div", { class: "m-bar-head" },
        h("span", { class: "m-bar-name" }, zone ? zoneMark(zone(r)) : null, label(r)),
        h("span", { class: "m-bar-val", text: barValue(r, total) })),
      h("div", { class: "m-track" }, h("div", { class: "m-fill", style: `width:${Math.max(2, Math.round((r.minutes / max) * 100))}%` })))));
}
function zoneMark(zone) {
  return h("span", { class: "reason-zone-mark reason-zone-" + zone, "aria-hidden": "true" });
}
function zoneMetrics(st) {
  const labels = { work: "Работа", plan: "Перевалка и плановые",
    unplanned: "Внеплановый простой", failure: "Аварийный простой" };
  return h("section", { class: "m-block zone-metrics", "aria-label": "Простой по зонам" },
    h("div", { class: "m-title", text: "Простой по зонам" }),
    Object.entries(labels).map(([zone, label]) => {
      const row = (st.byZone || []).find((item) => item.zone === zone);
      return h("div", { class: "zone-metric-row" },
        h("span", { class: "zone-metric-name" }, zoneMark(zone), label),
        h("span", { class: "zone-metric-value",
          text: row ? row.minutes + " мин · " + row.stops + " ост. · " + pct(row.share) : "—" }));
    }),
    h("p", { class: "hint", text: "Доля — от времени учёта за выбранный период. Остановка со сменой зоны учитывается в каждой из этих зон." }));
}
function metrics() {
  const period = ui.statsPeriod || "shift";
  loadStats(period);
  const c = (ui.stats || {})[period] || {};
  const st = c.data;
  const tabs = h("div", { class: "m-tabs" },
    PERIODS.map(([id, name]) => h("button", {
      class: "m-tab" + (id === period ? " on" : ""),
      onclick: () => { ui.statsPeriod = id; render(); },
    }, name)));
  if (!st) {
    return h("div", { class: "metrics" }, h("div", { class: "m-head", text: "Работа стана" }), tabs,
      h("p", { class: "muted", text: c.error ? "Нет связи с сервером. Показатели появятся, когда связь вернётся." : "Считаем…" }));
  }
  if (st.noData) {
    return h("div", { class: "metrics" }, h("div", { class: "m-head", text: "Работа стана" }), tabs,
      h("p", { class: "muted", text: "За этот период записей ещё нет." }));
  }
  const kpi = (v, t, cls = "") => h("div", { class: "board-stat " + cls }, h("span", { class: "v", text: v }), t);
  const q = st.quality || {};
  const warn = [];
  if (q.noReason) warn.push(`без причины: ${q.noReason}`);
  if (q.noAction) warn.push(`не указано, что сделали: ${q.noAction}`);
  if (q.otherShare > 0.1) warn.push(`«иная причина» — ${pct(q.otherShare)} простоя, стоит дополнить список причин`);
  const crewName = (id) => (id ? crewTitle(id) : "Смена не указана");
  return h("div", { class: "metrics" },
    h("div", { class: "m-head", text: "Работа стана" }),
    tabs,
    zoneMetrics(st),
    barList("Причины простоя", st.byReason, st.downMin, (r) => (r.reason ? reasonLabel(r.reason) : "Без причины"),
      (r) => zoneOf(r.reason, refs)),
    h("div", { class: "board-stats m-kpi" },
      kpi(pct(st.availability), "доступность", st.availability !== null && st.availability < 0.85 ? "bad" : "good"),
      kpi(mins(st.workMin), "работа", "good"),
      kpi(mins(st.downMin), "простой", "bad"),
      kpi(String(st.stops), "остановок"),
      kpi(mins(st.plannedMin), "плановые"),
      kpi(mins(st.unplannedMin), "внеплановые", "bad"),
      kpi(mins(st.avgStopMin), "средний простой"),
      kpi(mins(st.mtbfMin), "работа между отказами"),
      kpi(mins(st.mttrMin), "время на ремонт")),
    st.longest ? h("p", { class: "muted", text: `Самый долгий простой: ${fmtHM(st.longest.minutes)}, ${reasonLabel(st.longest.reason) || "без причины"}, с ${fmtClock(st.longest.startMs)} ${fmtDate(st.longest.startMs)}` }) : null,
    warn.length ? h("div", { class: "banner-warn", text: "Проверить: " + warn.join("; ") }) : null,
    st.byGroup && st.byGroup.length ? h("div", { class: "m-block" },
      h("div", { class: "m-title", text: "Простой по группам причин" }),
      donut(st.byGroup.map((g) => ({ name: g.group, minutes: g.minutes })), "простой")) : null,
    barList("По сменам", st.byCrew, st.downMin, (r) => crewName(r.crewId)),
    st.byDay && st.byDay.length > 1 ? h("div", { class: "m-block" },
      h("div", { class: "m-title", text: "По суткам: работа и простой, часы" }),
      dayChart(st.byDay),
      h("div", { class: "chart-legend" },
        h("span", { class: "lg work", text: "работа" }), h("span", { class: "lg down", text: "простой" }), h("span", { class: "lg nodata", text: "нет данных" }))) : null,
    h("p", { class: "hint", text: "Доступность — доля работы во времени без плановых остановок. «Работа между отказами» и «время на ремонт» считаются по внеплановым простоям." })
  );
}

// Блок смены: кто принял, время смены, остаток, закрытие. Одинаков при работающем и стоящем стане
function shiftBlock(view) {
  const c = view.crew;
  const dts = shiftDowntimes(view);
  const sum = shiftSummary(view);
  const down = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const action = (title, help, onclick) => h("button", { class: "btn shift-action", onclick },
    h("span", { text: title }), h("span", { class: "action-help", text: help }));
  return h("section", { class: "shift-block", "aria-label": "Ваша смена" },
    h("div", { class: "shift-person" },
      c ? h("p", { class: "muted", text: "Мастер смены" }) : null,
      h("h2", { text: c ? personLabel(c.personId, c.personName) : "Смена не принята" }),
      c ? h("p", { class: "muted", text: `Смену принял в ${fmtClock(core.toMs(c.at))} · ${crewTitle(c.crewId)} · ${periodLabel(view.shift).split(" ")[0].toLowerCase()}` }) : null,
      c ? h("p", null, "На смене ", h("strong", { dataset: { since: String(core.toMs(c.at)), fmt: "dur" } }, fmtDurMin((nowMs() - core.toMs(c.at)) / 60000))) : null),
    h("div", { class: "shift-time" },
      h("span", { text: `${fmtClock(view.shift.startMs)}–${fmtClock(view.shift.endMs)} · МСК` }),
      h("span", null, "До конца ", h("strong", { dataset: { until: String(view.shift.endMs) } }, fmtDurMin((view.shift.endMs - nowMs()) / 60000)))),
    ui.resume ? action("Продолжить заполнение", "Ответы предыдущего шага сохранены", () => go(ui.resume)) : null,
    action("Закрыть смену", "Проверить состояние стана и закрыть смену", () => { ui.closeReceipt = null; go("closeCheck"); }),
    action("Простои за смену", `${dts.length} ${plural(dts.length, "простой", "простоя", "простоев")} · ${fmtDurMin(down)} · посмотреть или исправить`, () => go("shift")),
    action("Показатели стана", "Работа и простои за смену, сутки и месяц", () => go("stats"))
  );
}

// Экран «Показатели стана»: табло и метрики за период, доступен в любой момент
function renderStats(main, view) {
  fill(main, backBtn("На главный экран", () => go("auto")), board(view), metrics());
}

// Ключ простоя в пределах смены: черновик «что сделали по ремонту» относится к своему простою и своей смене
function stopShiftKey(view) {
  return `${view.open.downtimeId}|${view.shift.day}|${view.shift.shiftNo}`;
}

// Что передали прошлые смены по ремонту: текст сдачи смены или пусто
function handoverText(item) {
  return typeof item?.action === "string" ? item.action.trim() : "";
}
// Карточка «Ремонт по сменам»: три последние передачи, новая сверху. Только для чтения
function renderHandoverCard(open) {
  const list = (open.handovers || []).slice(-3).reverse();
  if (!list.length) return null;
  return h("div", { class: "card" },
    h("div", { class: "card-title", text: "Ремонт по сменам" }),
    list.map((x) => {
      const at = core.toMs(x.at);
      const text = handoverText(x);
      return h("div", null,
        h("div", { class: "card-line", text: `${crewTitle(x.crewId)} · ${personLabel(x.personId, x.personName)} · передал ${fmtDate(at)} в ${fmtClock(at)}` }),
        h("div", { class: "card-note", text: text ? `«${text}»` : "без записи" }));
    }));
}

// Экран «Стан стоит»
function renderStop(main, view) {
  const open = view.open;
  const since = open.since ?? open.startMs; // начало всего простоя, не текущего отрезка
  const elapsed = nowMs() - since;
  const cur = open.reason;

  const left = h("div", null,
    h("div", { class: "bar red" },
      `Стан стоит с ${fmtSince(since, view.shift)}`,
      h("span", { class: "msk", "data-msk": "1", text: fmtClock(nowMs()) + " МСК" }),
      h("span", { class: "timer", dataset: { since: String(since) } }, fmtTimer(elapsed))
    ),
    h("button", {
      class: "btn primary btn-go",
      onclick: () => {
        // Возврат на главную не сбрасывает уже зафиксированное время пуска.
        if (restartMatches(view, ui.rw)) {
          if (ui.rw.thenClose && !ui.rw.timeConfirmed) return go("restartTime");
          return go(ui.wz?.mode === "restart" ? "reason" : ui.rw.route ? "restartAction" : "restartConfirm");
        }
        ui.rw = {
          downtimeId: open.downtimeId,
          index: open.index,
          startMs: nowMs(),
          reason: open.reason,
          note: open.note,
          reasonChanged: false,
          hadReason: !!open.reason,
        };
        if (open.reason) go("restartConfirm");
        else startRestartReasonWizard();
      },
    }, "СТАН ПОШЁЛ"),
    h("p", { class: "hint", text: "Нажмите, когда стан заработал. Время пуска запомним сразу, затем заполним запись." })
  );

  let card;
  if (cur) {
    card = h("div", { class: "card" },
      h("div", { class: "card-title", text: reasonLabel(cur) }),
      open.note ? h("div", { class: "card-note", text: `«${open.note}»` }) : null,
      h("button", { class: "btn", onclick: () => go("confirmChange") }, "Изменить")
    );
  } else {
    card = h("div", null,
      h("div", { class: "card none" },
        h("div", { class: "card-title", text: "Причина не указана" })
      ),
      h("button", {
        class: "btn warn-btn",
        onclick: () => {
          ui.wz = { mode: "current", downtimeId: open.downtimeId, step: 1, group: null, reason: null, note: "" };
          go("reason");
        },
      }, "Указать причину")
    );
  }

  fill(main, withScale(view, h("div", { class: "stop-grid" }, left, h("div", null, card, renderHandoverCard(open))), shiftBlock(view)));
}

// Закрытие смены начинается со сверки записи на планшете с состоянием стана.
function runningSince(view) {
  const ends = view.segments.filter((s) => !s.open && Number.isFinite(s.endMs)).map((s) => s.endMs);
  return Math.max(view.runningSinceMs ?? -Infinity, ...ends,
    ends.length || view.runningSinceMs != null ? -Infinity : view.dataFromMs ?? nowMs());
}
function renderCloseCheck(main, view) {
  const open = view.open;
  fill(main, backBtn("На главный экран", () => go("auto")),
    question(open ? "Стан всё ещё стоит?" : "Стан в рабочем состоянии?"),
    h("p", { class: "hint", text: open
      ? `На планшете: стан стоит с ${fmtSince(open.since ?? open.startMs, view.shift)} · ${reasonLabel(open.reason) || "причина не указана"}`
      : `На планшете: стан работает с ${fmtSince(runningSince(view), view.shift)}` }),
    h("button", { class: "btn primary", onclick: () => go("closeConfirm") }, open ? "Да, стоит" : "Да, работает"),
    h("button", { class: "btn", onclick: () => {
      const current = buildView();
      if (!!current.open !== !!open) { render(); return; }
      if (current.open) {
        if (!restartMatches(current, ui.rw)) {
          ui.rw = { downtimeId: current.open.downtimeId, index: current.open.index,
            startMs: nowMs(), reason: current.open.reason, note: current.open.note,
            reasonChanged: false, hadReason: !!current.open.reason };
        }
        ui.rw.thenClose = true;
        go("restartTime");
      } else {
        ui.fw ||= { step: 1, atMs: nowMs(), group: null, reason: null, note: "" };
        go("forgotStop");
      }
    } }, open ? "Нет, уже работает" : "Нет, стан стоит"));
}

function forgottenTimeError(view, ms, restart = false) {
  if (!Number.isFinite(ms)) return "Укажите дату и время.";
  if (ms > nowMs()) return "Это время ещё не наступило.";
  if (!restart && view.open) return "На планшете уже записана остановка. Вернитесь к проверке состояния стана.";
  const from = restart ? view.open?.startMs : runningSince(view);
  if (ms < from) return restart
    ? `Пуск не может быть раньше ${fmtDate(from)} ${fmtClock(from)} — тогда начался простой или сменилась его причина.`
    : `Остановка не может быть раньше ${fmtDate(from)} ${fmtClock(from)} — тогда стан пошёл или начался учёт.`;
  return "";
}

// Общий шаг московского времени. Неверный ввод также сохраняется в черновике.
function forgottenTimeFields(view, draft, field, restart, next) {
  const input = h("input", { type: "datetime-local", "aria-label": restart ? "Время пуска, Москва" : "Время остановки, Москва" });
  input.value = draft.timeValue ?? localTimeValue(draft[field]);
  const error = h("p", { class: "error-text" });
  const submit = h("button", { class: "btn primary", onclick: () => {
    const msg = forgottenTimeError(buildView(), draft[field], restart);
    if (msg) { error.textContent = msg; error.hidden = false; return; }
    next();
  } }, "Далее");
  const update = () => {
    const msg = forgottenTimeError(view, draft[field], restart);
    error.textContent = msg;
    error.hidden = !msg;
    submit.disabled = !!msg;
  };
  input.addEventListener("input", () => {
    draft.timeValue = input.value;
    draft[field] = parseLocalTime(input.value);
    update();
  });
  update();
  return [h("p", { class: "muted", text: "Дата и время по Москве." }), input,
    h("div", { class: "tiles" }, [[10, "10 мин назад"], [30, "30 мин назад"], [60, "1 ч назад"], [120, "2 ч назад"]].map(([min, label]) =>
      h("button", { class: "tile", onclick: () => {
        draft[field] = Math.floor(nowMs() / 60000) * 60000 - min * 60000;
        delete draft.timeValue;
        render();
      } }, label))), error, submit];
}

function renderForgotStop(main, view) {
  const fw = ui.fw;
  if (!fw) return go("closeCheck");
  const back = () => {
    if (fw.step === 1) { go("closeCheck"); ui.resume = "forgotStop"; persistClient(); }
    else { fw.step = (fw.step === 5 && fw.unknown) || fw.step === 4 ? 2 : fw.step - 1; render(); }
  };
  const backLabels = { 1: "К проверке состояния стана", 2: "К времени остановки", 3: "К выбору группы", 4: "К выбору причины", 5: fw.unknown ? "К выбору группы" : "К описанию причины" };
  const top = () => [backBtn(backLabels[fw.step], back),
    h("p", { class: "muted", text: "Забыли отметить остановку" }),
    stepLine(fw.unknown && fw.step === 5 ? 3 : fw.step > 3 ? fw.step - 1 : fw.step, fw.unknown ? 3 : 4)];
  const next = () => { fw.step++; render(); };
  if (fw.step === 1) {
    fill(main, ...top(), question("Когда стан встал?"), ...forgottenTimeFields(view, fw, "atMs", false, next));
    return;
  }
  if (fw.step === 3) fw.step = 4; // шага «Что именно?» больше нет
  if (fw.reason) fw.reason = core.reasonKey(fw.reason);
  if (fw.step === 4 && !fw.unknown && !reasonRef(fw.reason)) fw.step = 2;
  if (fw.step === 2) {
    fill(main, ...top(), question("Почему стоит?"),
      reasonGroups(fw, () => { fw.step = 4; render(); }),
      h("button", { class: "btn btn-flat reason-later",
        onclick: () => { fw.unknown = true; fw.step = 5; render(); } }, "Пока не знаю"));
    return;
  }
  if (fw.step === 4) {
    const ta = h("textarea", { class: "note-input", rows: "4", maxlength: String(NOTE_MAX),
      placeholder: noteHint(fw.reason), "aria-label": "Описание своими словами" });
    ta.value = fw.note || "";
    const error = h("p", { class: "error-text", text: "Опишите своими словами, что случилось." });
    const submit = h("button", { class: "btn primary", onclick: next }, "Далее");
    let touched = !!ta.value;
    const update = () => {
      fw.note = ta.value;
      submit.disabled = needsNote(fw.reason) && !validAction(ta.value);
      error.hidden = !submit.disabled || !touched;
    };
    ta.addEventListener("input", () => { touched = true; fw.noteEdited = true; update(); });
    update();
    fill(main, ...top(), question("Расскажите своими словами"),
      h("p", { class: "muted", text: reasonLabel(fw.reason) }), ta, error,
      h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }), submit);
    focusReasonNote(ta);
    return;
  }
  const error = forgottenStopError(view, fw);
  fill(main, ...top(), question("Всё верно?"),
    h("div", { class: "card" }, h("div", { class: "card-title", text:
      `Стан стоит с ${fmtDate(fw.atMs)} ${fmtClock(fw.atMs)} · ${fw.unknown ? "причина не указана" : reasonLabel(fw.reason)}${!fw.unknown && fw.note?.trim() ? ` · «${fw.note.trim()}»` : ""}` })),
    error ? h("p", { class: "error-text", text: error }) : null,
    h("button", { class: "btn primary", disabled: !!error, onclick: saveForgottenStop }, "Сохранить"));
}
function forgottenStopError(view, fw) {
  return forgottenTimeError(view, fw.atMs) || (!fw.unknown && !reasonRef(fw.reason) ? "Выберите причину простоя."
    : !fw.unknown && needsNote(fw.reason) && !validAction(fw.note) ? "Опишите своими словами, что случилось." : "");
}
function saveForgottenStop() {
  const fw = ui.fw;
  if (!fw || forgottenStopError(buildView(), fw)) { render(); return; }
  const downtimeId = crypto.randomUUID();
  const at = new Date(fw.atMs).toISOString();
  const events = [{ type: "stop", fields: { downtimeId, at } }];
  if (!fw.unknown) events.push({ type: "reason", fields: { downtimeId, at, reason: fw.reason, note: fw.note.trim() } });
  ui.fw = null;
  ui.resume = null;
  ui.screen = "closeConfirm";
  const sent = sendBatch(events);
  ui.closeReceipt = sent.map((e) => e.id);
  render();
}

function renderRestartTime(main, view) {
  const rw = ui.rw;
  if (!restartMatches(view, rw)) return renderStaleRestart(main);
  const total = rw.route === "reason" || !rw.reason ? 4 : 3;
  fill(main, backBtn("К проверке состояния стана", () => { go("closeCheck"); ui.resume = "restartTime"; persistClient(); }),
    h("p", { class: "muted", text: "Забыли отметить пуск" }), stepLine(1, total), question("Когда стан пошёл?"),
    ...forgottenTimeFields(view, rw, "startMs", true, () => {
      if (!restartMatches(buildView(), rw)) { render(); return; }
      rw.timeConfirmed = true;
      if (rw.route === "reason" && ui.wz?.mode === "restart") { ui.wz.step = 1; go("reason"); }
      else if (rw.reason) go("restartConfirm");
      else startRestartReasonWizard();
    }));
}

function restartBack() {
  if (ui.rw?.thenClose) return backBtn("К времени пуска", () => go("restartTime"));
  return backBtn("К простою", () => { ui.resume = ui.screen; go("auto"); });
}

function startRestartReasonWizard() {
  const rw = ui.rw;
  rw.route = "reason";
  if (ui.wz?.mode === "restart" && ui.wz.downtimeId === rw.downtimeId && ui.wz.index === rw.index) ui.wz.step = 1;
  else ui.wz = { mode: "restart", downtimeId: rw.downtimeId, index: rw.index, step: 1,
    group: reasonGroup(rw.reason), reason: rw.reason, note: rw.note || "" };
  go("reason");
}

function renderRestartConfirm(main, view) {
  const rw = ui.rw;
  if (!restartMatches(view, rw)) return renderStaleRestart(main);
  if (rw.reason) rw.reason = core.reasonKey(rw.reason);
  if (!reasonRef(rw.reason)) return startRestartReasonWizard();
  fill(main,
    restartBack(),
    stepLine(rw.thenClose ? 2 : 1, rw.thenClose ? 3 : 2),
    question(`Причина: ${reasonLabel(rw.reason)} — верно?`),
    h("button", { class: "btn primary", onclick: () => {
      if (needsNote(rw.reason) && !validAction(rw.note)) { startRestartReasonWizard(); ui.wz.step = 3; render(); }
      else { rw.route = "confirm"; go("restartAction"); }
    } }, "Да, верно"),
    h("button", { class: "btn", onclick: startRestartReasonWizard }, "Изменить")
  );
}

// Вопрос перед сменой причины на ходу
function renderConfirmChange(main, view) {
  const open = view.open;
  if (!open) return go("auto");
  fill(main,
    backBtn("Вернуться к простою", () => go("auto")),
    question("Причина сменилась по ходу простоя?"),
    h("button", {
      class: "btn",
      onclick: () => {
        ui.wz = { mode: "refix", downtimeId: open.downtimeId, step: 1, group: null, reason: null, note: "" };
        go("reason");
      },
    }, "Нет, исправить ошибку"),
    h("button", {
      class: "btn primary",
      onclick: () => {
        ui.wz = { mode: "split", downtimeId: open.downtimeId, step: 1, group: null, reason: null, note: "" };
        go("reason");
      },
    }, "Да, теперь стоим по другой причине")
  );
}

// Один выбор причины во всех мастерах. Ключ отличает пункты с одинаковым кодом.
function reasonItems(tile) {
  return tile?.items || (tile?.codes || []).map((code) => ({ code, label: reasonLabel(code), text: "" }));
}
function reasonItemKey(tile, item) { return JSON.stringify([tile.id, item.code, item.label]); }
function chooseReasonItem(draft, tile, item) {
  const ownText = draft.noteEdited || (!!draft.note && draft.note !== draft.autoNote);
  draft.itemKey = reasonItemKey(tile, item);
  draft.reason = item.code;
  draft.noteEdited = !!ownText;
  if (!ownText) {
    draft.note = isOther(item.code) ? "" : item.text;
    draft.autoNote = draft.note;
  }
  ui.focusNote = true;
}
function reasonGroups(draft, next) {
  return h("div", { class: "tiles reason-groups" }, (refs.tiles || []).map((tile) =>
    h("button", { class: "tile reason-group reason-zone-" + tile.zone + (draft.group === tile.id ? " sel" : ""),
      onclick: () => {
        draft.group = tile.id;
        draft.unknown = false;
        const items = reasonItems(tile);
        if (items.length === 1) chooseReasonItem(draft, tile, items[0]);
        next();
      } },
    h("span", { class: "reason-group-title", text: tile.title }),
    h("span", { class: "reason-group-subtitle", text: tile.subtitle }))));
}
function focusReasonNote(ta) {
  if (!ui.focusNote) return;
  ui.focusNote = false;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// Мастер выбора причины: группа → причина → своими словами
function renderReasonWizard(main, view) {
  const wz = ui.wz;
  if (!wz) return go("auto");
  const restarting = wz.mode === "restart";
  if (restarting && !restartMatches(view, ui.rw)) return renderStaleRestart(main);
  const past = wz.mode === "past" || wz.mode === "shiftfix" || restarting;
  const offset = restarting && ui.rw?.thenClose ? 1 : 0;
  const total = restarting ? 3 + offset : 2;
  const restartHasReason = ui.rw?.hadReason ?? !!ui.rw?.reason;
  const back1 = {
    current: ["Вернуться к простою (причину можно указать позже)", () => go("auto")],
    refix: ["Вернуться к простою", () => go("auto")],
    split: ["Вернуться к простою", () => go("auto")],
    past: ["На главный экран", () => go("auto")],
    shiftfix: ["К записи простоя", () => go("detail")],
    repair: ["К сохранённой записи", () => go("repair")],
    restart: [restartHasReason ? "К подтверждению причины" : ui.rw?.thenClose ? "К времени пуска" : "К простою",
      () => restartHasReason ? go("restartConfirm") : ui.rw.thenClose ? go("restartTime") : (ui.resume = "reason", go("auto"))],
  }[wz.mode];

  if (wz.step === 1) {
    fill(main,
      backBtn(...back1),
      stepLine(1 + offset, total),
      question(past ? "Почему стоял?" : "Почему стоит?"),
      reasonGroups(wz, () => { wz.step = 3; render(); }),
      !restarting ? h("button", {
        class: "btn btn-flat reason-later",
        onclick: () => {
          if (wz.mode === "past") go("recorded");
          else go(wz.mode === "shiftfix" ? "detail" : wz.mode === "repair" ? "repair" : "auto");
        },
      }, wz.mode === "past" ? "Укажу позже" : "Пока не знаю") : null
    );
    return;
  }

  if (wz.step === 2) wz.step = 3; // шага «Что именно?» больше нет
  if (wz.reason) wz.reason = core.reasonKey(wz.reason);
  if (wz.step >= 2 && !reasonRef(wz.reason)) wz.step = 1;

  // Шаг 3: своими словами
  const ta = h("textarea", {
    class: "note-input",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: noteHint(wz.reason),
    "aria-label": "Описание своими словами",
  });
  ta.value = wz.note || "";
  const must = needsNote(wz.reason);
  const needText = h("p", { class: "error-text", text: "Напишите, что случилось" });
  // Красная строка — только после попытки пройти дальше с пустым полем
  let tried = false;
  const upd = () => { needText.hidden = !must || !tried || validAction(ta.value); };
  ta.addEventListener("input", () => { wz.note = ta.value; wz.noteEdited = true; upd(); });
  upd();
  const done = (withNote) => {
    if (must && !validAction(ta.value)) { tried = true; upd(); ta.focus(); return; }
    finishReasonWizard(withNote ? ta.value : "");
  };
  fill(main,
    backBtn("К выбору причины", () => { wz.step = 1; render(); }),
    stepLine(2 + offset, total),
    question(must ? "Что случилось? Опишите своими словами" : "Расскажите своими словами"),
    h("div", { class: "card" }, h("div", { class: "card-title", text: reasonLabel(wz.reason) })),
    ta,
    must ? needText : null,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
    h("button", { class: "btn primary", onclick: () => done(true) }, restarting ? "Далее" : "Сохранить"),
    must ? null : h("button", { class: "btn", onclick: () => done(false) }, "Без описания")
  );
  focusReasonNote(ta);
}

function finishReasonWizard(rawNote) {
  const wz = ui.wz;
  if (["current", "refix", "split"].includes(wz.mode) && buildView()?.open?.downtimeId !== wz.downtimeId) {
    showToast("Простой уже изменился. Проверьте стан; текст остаётся в черновике."); return;
  }
  const note = String(rawNote || "").trim();
  if (!reasonRef(wz.reason)) { wz.step = 1; render(); return; }
  if (needsNote(wz.reason) && !validAction(note)) { showToast("Напишите, что случилось"); return; }
  const noteField = { note };
  if (wz.mode === "repair") {
    ui.repair.event.reason = wz.reason;
    ui.repair.event.note = note;
    ui.wz = null;
    return go("repair");
  }
  if (wz.mode === "shiftfix" && !cardData(buildView())) {
    showToast("Запись изменилась. Ответы остаются в черновике; проверьте итог смены."); return;
  }
  if (wz.mode === "restart") {
    ui.rw.reason = wz.reason;
    ui.rw.note = note;
    ui.rw.reasonChanged = true;
    go("restartAction");
  } else if (wz.mode === "split") {
    send("split", { downtimeId: wz.downtimeId, reason: wz.reason, ...noteField });
    showToast(receiptStatus(receiptFor(wz.downtimeId)));
    go("auto");
  } else if (wz.mode === "past") {
    send("fix", { downtimeId: wz.downtimeId, index: wz.index, reason: wz.reason, ...noteField });
    go("recorded");
  } else if (wz.mode === "shiftfix") {
    send("fix", { downtimeId: wz.downtimeId, index: wz.index, reason: wz.reason, ...noteField });
    ui.wz = null;
    go("detail");
  } else {
    // current и refix: событие reason для текущего отрезка
    send("reason", { downtimeId: wz.downtimeId, reason: wz.reason, ...noteField });
    showToast(receiptStatus(receiptFor(wz.downtimeId)));
    go("auto");
  }
}

function validAction(value) {
  return typeof value === "string" && value.trim().length >= 3;
}
function reasonGroup(code) { return (refs.tiles || []).find((t) => t.codes.includes(code))?.id || null; }
function restartMatches(view, rw) {
  return rw && view.open && view.open.downtimeId === rw.downtimeId && view.open.index === rw.index;
}
function renderStaleRestart(main) {
  fill(main, question("Состояние стана изменилось"),
    h("p", { text: "Этот простой уже изменили. Ответы оставлены в черновике. Вернитесь на главный экран и проверьте стан перед пуском." }),
    h("button", { class: "btn", onclick: () => { ui.resume = ui.screen; go("auto"); } }, "На главный экран"));
}

function actionText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return validAction(text) ? text : "";
}

function renderRestartAction(main, view) {
  const rw = ui.rw;
  if (!restartMatches(view, rw)) return renderStaleRestart(main);
  const ta = h("textarea", {
    class: "note-input",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: actionHint(rw.reason !== undefined && rw.reason !== null ? rw.reason : view.open.reason),
    "aria-label": "Что сделали, чтобы запустить стан",
  });
  ta.value = rw.action || "";
  const error = h("p", { class: "error-text", text: "Напишите, что сделали" });
  const submit = h("button", { class: "btn primary", onclick: () => finishRestart(ta.value) }, "Сохранить пуск");
  let touched = !!ta.value;
  const update = () => {
    rw.action = ta.value;
    const ok = validAction(ta.value);
    submit.disabled = !ok;
    error.hidden = ok || !touched;
  };
  ta.addEventListener("input", () => { touched = true; update(); });
  update();
  const total = (rw.route === "reason" ? 3 : 2) + (rw.thenClose ? 1 : 0);
  // Что по этому простою уже сделали прошлые смены (последние три записи)
  const earlier = (view.open.handovers || []).map(handoverText).filter(Boolean).slice(-3).reverse();
  fill(main,
    backBtn(rw.route === "reason" ? "К описанию причины" : "К причине", () => {
      if (rw.route === "reason") { ui.wz.step = 3; go("reason"); }
      else go("restartConfirm");
    }),
    stepLine(total, total),
    question("Что сделали, чтобы запустить стан?"),
    h("p", { class: "muted", text: `Время пуска: ${fmtSince(rw.startMs, view.shift)} МСК${rw.thenClose ? "" : " — по первому нажатию"}` }),
    earlier.length ? h("div", { class: "earlier" },
      h("p", { class: "hint", text: "Раньше по этому простою:" }),
      earlier.map((text) => h("p", { class: "hint earlier-text", text: `«${text}»` }))) : null,
    ta,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
    error,
    submit
  );
}

function finishRestart(rawAction) {
  const rw = ui.rw;
  const action = rawAction.trim();
  if (!rw || action.length < 3) return;
  if (!restartMatches(buildView(), rw)) { render(); return; }
  if (!reasonRef(rw.reason) || (needsNote(rw.reason) && !validAction(rw.note))) { startRestartReasonWizard(); return; }
  if (rw.startMs < buildView().open.startMs || rw.startMs > nowMs()) {
    showToast("Проверьте время пуска и часы планшета"); return;
  }
  const at = new Date(rw.startMs).toISOString();
  const events = [];
  if (rw.reasonChanged) {
    events.push({ type: "reason", fields: {
      downtimeId: rw.downtimeId,
      reason: rw.reason,
      note: rw.note || "",
      at,
    } });
  }
  events.push({ type: "start", fields: { downtimeId: rw.downtimeId, action, at } });
  const openNow = buildView().open;
  ui.rec = { downtimeId: rw.downtimeId, sinceMs: openNow.since ?? openNow.startMs, endMs: rw.startMs };
  ui.rw = null;
  ui.wz = null;
  ui.screen = rw.thenClose ? "closeConfirm" : "recorded";
  const sent = sendBatch(events);
  if (rw.thenClose) { ui.closeReceipt = sent.map((e) => e.id); render(); }
}

// Мастер «Забыл отметить простой»
function startManualWizard(origin) {
  const openedAt = Math.floor(nowMs() / 60000) * 60000;
  ui.mw = { origin, step: 1, from: openedAt - 30 * 60000, to: openedAt - 15 * 60000,
    openedAt, group: null, reason: null, note: "", action: "" };
  go("manual");
}

function localTimeValue(ms) {
  if (!Number.isFinite(ms)) return "";
  const offset = refs.settings.schedule.tzOffsetMinutes ?? 180;
  return new Date(ms + offset * 60000).toISOString().slice(0, 16);
}
function parseLocalTime(value) {
  if (!value) return NaN;
  try { return core.toMs(value + "Z") - (refs.settings.schedule.tzOffsetMinutes ?? 180) * 60000; }
  catch { return NaN; }
}
function manualTo(mw) { return mw.to; }
function manualOverlap(view, from, to) {
  for (const s of view.segments) {
    if (from < (s.open || s.endMs === null ? Infinity : s.endMs) && to > s.startMs) return s;
  }
  if (view.open && to > (view.open.since ?? view.open.startMs)) return { startMs: view.open.since ?? view.open.startMs, endMs: null };
  return null;
}
function manualError(view, mw) {
  if (!Number.isFinite(mw.from) || !Number.isFinite(mw.to)) return "Укажите начало и конец простоя.";
  if (mw.to <= mw.from) return "Конец должен быть позже начала. Исправьте время.";
  if (mw.to > nowMs()) return "Конец простоя в будущем. Укажите, когда стан уже заработал.";
  if (mw.from < view.shift.startMs) return "Здесь можно добавить простой этой смены. О более раннем простое сообщите мастеру.";
  const overlap = manualOverlap(view, mw.from, mw.to);
  if (overlap) return `В это время уже есть простой с ${fmtClock(overlap.startMs)}. Исправьте время или дополните запись в итоге смены.`;
  if (!reasonRef(mw.reason)) return "Выберите причину простоя.";
  if (needsNote(mw.reason) && !validAction(mw.note)) return "Опишите своими словами, что случилось.";
  if (!validAction(mw.action)) return "Напишите, что сделали перед пуском.";
  return "";
}

function renderManual(main, view) {
  const mw = ui.mw;
  if (!mw) return go("auto");
  const back = () => {
    if (mw.step > 1) { mw.step = mw.step === 5 ? 3 : mw.step - 1; render(); }
    else { ui.resume = "manual"; go(mw.origin === "shift" ? "shift" : "auto"); }
  };
  const top = () => [backBtn(mw.step > 1 ? "К предыдущему вопросу" : mw.origin === "shift" ? "К итогу смены" : "На главный экран", back), stepLine(mw.step > 4 ? mw.step - 1 : mw.step, 6)];
  const next = () => { mw.step++; mw.error = ""; render(); };
  if (mw.step <= 2) {
    const start = mw.step === 1;
    const field = start ? "from" : "to";
    const input = h("input", { type: "datetime-local", "aria-label": start ? "Начало простоя, Москва" : "Конец простоя, Москва" });
    input.value = localTimeValue(mw[field]);
    const error = h("p", { class: "error-text" });
    const submit = h("button", { class: "btn primary", onclick: next }, "Далее");
    // Одна проверка и при открытии шага, и при вводе; мешающий простой называем по времени
    const timeError = () => {
      const busy = !Number.isFinite(mw.from) ? null
        : start ? manualOverlap(view, mw.from, mw.from + 1)
        : Number.isFinite(mw.to) && mw.to > mw.from ? manualOverlap(view, mw.from, mw.to) : null;
      return !Number.isFinite(mw[field]) ? "Укажите дату и время."
        : mw[field] > nowMs() ? "Это время ещё не наступило."
        : mw.from < view.shift.startMs ? "Укажите время в пределах этой смены."
        : !start && mw.to <= mw.from ? "Конец должен быть позже начала."
        : busy ? `В это время уже записан простой ${fmtClock(busy.startMs)}–${busy.endMs ? fmtClock(busy.endMs) : "сейчас"}. Выберите другое время.` : "";
    };
    const update = () => {
      mw[field] = parseLocalTime(input.value);
      const msg = timeError();
      error.textContent = msg;
      error.hidden = !msg;
      submit.disabled = !!msg;
    };
    input.addEventListener("input", update);
    // Не округляем сохранённое время при перерисовке; только проверяем.
    const msg0 = timeError();
    submit.disabled = !!msg0;
    error.textContent = msg0;
    error.hidden = !msg0;
    const choices = start ? [[10, "10 мин назад"], [30, "30 мин назад"], [60, "Час назад"]]
      : [[5, "Стоял 5 мин"], [15, "Стоял 15 мин"], [30, "Стоял 30 мин"]];
    fill(main, ...top(), question(start ? "Когда стан встал?" : "Когда стан снова пошёл?"),
      h("p", { class: "muted", text: "Дата и время по Москве. Добавляем уже закончившийся простой этой смены." }),
      input,
      h("div", { class: "tiles" }, choices.map(([min, label]) => h("button", { class: "tile", onclick: () => {
        mw[field] = start ? mw.openedAt - min * 60000 : mw.from + min * 60000;
        render();
      } }, label))),
      start ? null : h("p", { class: "hint", text: `Начало: ${fmtDate(mw.from)} в ${fmtClock(mw.from)}. Выбранный конец не меняется, пока вы заполняете запись.` }),
      error, submit);
    return;
  }
  if (mw.step === 4) mw.step = 5; // шага «Что именно?» больше нет
  if (mw.reason) mw.reason = core.reasonKey(mw.reason);
  if (mw.step >= 5 && mw.step <= 6 && !reasonRef(mw.reason)) mw.step = 3;
  if (mw.step === 3) {
    fill(main, ...top(), question("Почему стоял?"), reasonGroups(mw, () => { mw.step = 5; mw.error = ""; render(); }));
    return;
  }
  const action = mw.step === 6;
  const field = action ? "action" : "note";
  const must = action || needsNote(mw.reason);
  const ta = h("textarea", { class: "note-input", rows: "4", maxlength: String(NOTE_MAX),
    placeholder: action ? actionHint(mw.reason) : noteHint(mw.reason), "aria-label": action ? "Что сделали" : "Что случилось" });
  ta.value = mw[field] || "";
  const error = h("p", { class: "error-text", text: action ? "Напишите, что сделали." : "Опишите своими словами, что случилось." });
  const submit = h("button", { class: "btn primary", onclick: () => {
    if (must && !validAction(ta.value)) return;
    mw[field] = ta.value;
    if (action) go("manualCheck"); else next();
  } }, "Далее");
  const update = () => {
    mw[field] = ta.value;
    submit.disabled = must && !validAction(ta.value);
    error.hidden = !submit.disabled || !touched;
  };
  let touched = !!ta.value;
  ta.addEventListener("input", () => { touched = true; if (!action) mw.noteEdited = true; update(); });
  update();
  fill(main, ...top(), question(action ? "Что сделали, чтобы запустить стан?" : "Расскажите своими словами"),
    action ? null : h("p", { class: "muted", text: reasonLabel(mw.reason) }), ta, error,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }), submit,
    !must ? h("button", { class: "btn", onclick: () => { mw.note = ""; mw.noteEdited = true; next(); } }, "Без описания") : null);
  if (!action) focusReasonNote(ta);
}

function renderManualCheck(main, view) {
  const mw = ui.mw;
  if (!mw) return go("auto");
  const error = manualError(view, mw);
  fill(main,
    backBtn("К выполненным работам", () => { mw.step = 6; go("manual"); }),
    stepLine(6, 6), question("Всё верно?"),
    h("div", { class: "card" },
      h("div", { class: "card-title", text: `${fmtDate(mw.from)} · ${fmtClock(mw.from)}–${fmtClock(mw.to)} · ${fmtDurMin((mw.to - mw.from) / 60000)}` }),
      h("div", { class: "card-line", text: reasonLabel(mw.reason) }),
      h("div", { class: "card-note", text: `Что случилось: ${mw.note || "не указано"}` }),
      h("div", { class: "card-note", text: `Что сделали: ${mw.action || "не указано"}` })),
    error || mw.error ? h("p", { class: "error-text", text: error || mw.error }) : null,
    h("button", { class: "btn", onclick: () => { mw.step = 1; go("manual"); } }, "Исправить время"),
    h("button", { class: "btn primary", disabled: !!error || mw.saving, onclick: async () => {
      mw.saving = true;
      render();
      // Проверяем ещё раз после свежего состояния, если связь доступна.
      if (online) await loadState();
      if (ui.mw !== mw || ui.screen !== "manualCheck") { mw.saving = false; return; }
      mw.saving = false;
      mw.error = manualError(buildView(), mw);
      if (mw.error) { render(); return; }
      const downtimeId = crypto.randomUUID();
      ui.rec = { downtimeId };
      ui.screen = "recorded";
      ui.mw = null;
      send("manual", { downtimeId, from: new Date(mw.from).toISOString(), to: new Date(mw.to).toISOString(),
        reason: mw.reason, note: mw.note.trim(), action: mw.action.trim() });
    } }, mw.saving ? "Проверяем время…" : "Сохранить простой"));
}

// Результат сохраняется вместе с событиями и не исчезает по таймеру.
function renderRecorded(main, view) {
  if (!ui.rec) return go("auto");
  const list = receiptFor(ui.rec.downtimeId);
  const status = receiptStatus(list);
  const d = shiftDowntimes(view).find((x) => x.downtimeId === ui.rec.downtimeId);
  const original = list.map((r) => r.event);
  const action = d ? d.action : original.findLast((e) => e.action !== undefined)?.action;
  const note = d ? d.note : original.findLast((e) => e.note !== undefined)?.note;
  // Простой начался до этой смены — показываем его целиком и отдельно часть этой смены
  const longRec = Number.isFinite(ui.rec.sinceMs) && Number.isFinite(ui.rec.endMs) && ui.rec.sinceMs < view.shift.startMs;
  fill(main, question(status),
    h("p", { class: "muted", text: status === "Принято сервером" ? "Запись простоя принята."
      : status === "Нужно исправить" ? "Сервер не принял часть записи. Ответы сохранены ниже."
      : status === "На планшете не сохранено" ? "Не закрывайте страницу. Повторите сохранение."
      : "Запись уйдёт сама, когда появится связь. Можно продолжать работу." }),
    h("div", { class: "card" },
      d && longRec ? h("div", { class: "card-title", text: `${fmtDate(ui.rec.sinceMs)} ${fmtClock(ui.rec.sinceMs)} – ${fmtDate(ui.rec.endMs)} ${fmtClock(ui.rec.endMs)} · ${fmtDurLong((ui.rec.endMs - ui.rec.sinceMs) / 60000)}` }) : null,
      d && longRec ? h("div", { class: "card-line", text: `В эту смену: ${fmtDurMin(d.minutes)}` }) : null,
      d && !longRec ? h("div", { class: "card-title", text: `${fmtClock(d.startMs)}–${d.endMs === null ? "идёт" : fmtClock(d.endMs)} · ${fmtDurMin(d.minutes)}` }) : null,
      h("div", { class: "card-line", text: reasonLabel(d?.reason || original.findLast((e) => e.reason)?.reason) }),
      h("div", { class: "card-note", text: `Что случилось: ${note || "не указано"}` }),
      h("div", { class: "card-note", text: `Что сделали: ${action || "не указано"}` })),
    h("button", { class: "btn primary", onclick: () => go("auto") }, "На главный экран"));
}

function missingFields(segment) {
  const missing = [];
  if (!reasonRef(segment.reason)) missing.push("причина");
  if (!actionText(segment.action)) missing.push("что сделали");
  if (isOther(segment.reason) && !validAction(segment.note)) missing.push("описание иной причины");
  return missing;
}
function handoverGaps(view) {
  return shiftDowntimes(view).filter((d) => !d.open).flatMap((d) => d.segs
    .filter((s) => missingFields(s).length)
    .map((s) => ({ ...s, missing: missingFields(s) })));
}
function openDetail(downtimeId, index = null) {
  ui.card = { downtimeId, index };
  go("detail");
}

// Сводка перед сдачей. Здесь же исправляют записи в течение смены.
function renderShift(main, view) {
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const workMin = shiftWorkMin(view, downMin);
  const dts = shiftDowntimes(view);
  const gaps = handoverGaps(view);
  fill(main, backBtn("На главный экран", () => go("auto")), question("Итог смены"),
    h("p", { class: "muted", text: `${periodLabel(view.shift)} · ${crewTitle(view.crew?.crewId)}` }),
    h("div", { class: "stats" },
      h("div", { class: "stat good" }, "Работа", h("span", { class: "v", text: fmtDurMin(workMin) })),
      h("div", { class: "stat bad" }, "Простой", h("span", { class: "v", text: fmtDurMin(downMin) }))),
    view.open ? h("p", { class: "handover-note", text: "Стан стоит. После закрытия смены простой продолжится у следующей смены. Пуск отмечать не нужно." }) : null,
    gaps.length ? h("p", { class: "handover-note", text: `Нужно дополнить записи: ${gaps.length}. Откройте их ниже или закройте смену с пометкой.` }) : null,
    h("h2", { text: "Простои смены" }),
    dts.length ? h("div", { class: "segs" }, dts.map((d) => downtimeRow(d, view.shift))) : h("p", { class: "muted", text: "Простоев не было." }),
    h("button", { class: "btn", onclick: () => startManualWizard("shift") }, "Забыл отметить простой"),
    h("button", { class: "btn primary", disabled: view.closed || !view.crew, onclick: () => { ui.closeReceipt = null; go("closeCheck"); } }, "Перейти к закрытию смены"));
}

function downtimeRow(d, shift) {
  const missing = d.open ? [] : [...new Set(d.segs.flatMap(missingFields))];
  return h("button", { class: "seg" + (d.open ? " open" : ""), onclick: () => openDetail(d.downtimeId) },
    h("span", { class: "when", text: `${fmtSince(d.startMs, shift)}–${d.endMs === null ? "сейчас" : fmtClock(d.endMs)}` }),
    h("span", null,
      h("span", { class: "why", text: reasonLabel(d.reason) || "Причина не указана" }),
      d.segs.length > 1 ? h("span", { class: "manual-tag", text: `Причина менялась · частей: ${d.segs.length}` }) : null,
      d.continued ? h("span", { class: "manual-tag", text: "Начался в прошлую смену" }) : null,
      d.open ? h("span", { class: "manual-tag", text: "Простой продолжается · передаётся следующей смене" }) : null,
      missing.length ? h("span", { class: "badge-need", text: "Дополнить: " + missing.join(", ") }) : null,
      h("span", { class: "manual-tag", text: "Открыть запись" })),
    h("span", { class: "dur", text: d.open ? "идёт" : fmtDurMin(d.minutes) }));
}

function cardData(view) {
  const d = shiftDowntimes(view).find((x) => x.downtimeId === ui.card?.downtimeId);
  if (!d) return null;
  const s = d.segs.find((x) => x.index === ui.card.index) || d.segs.at(-1);
  return { d, s };
}
function renderDetail(main, view) {
  const data = cardData(view);
  if (!data) {
    fill(main, backBtn("К итогу смены", () => go("shift")), question("Записи нет в этой смене"),
      h("p", { text: "Возможно, смена уже закончилась или запись изменили. Проверьте итог текущей смены." }));
    return;
  }
  const { d, s } = data;
  ui.card.index = s.index;
  const editText = (field) => {
    ui.af = { downtimeId: s.downtimeId, index: s.index, reason: s.reason, field, value: s[field] || "" };
    go("actionFix");
  };
  const choice = (title, value, onclick) => h("button", { class: "btn shift-action", onclick },
    h("span", { text: title }), h("span", { class: "action-help", text: value }));
  fill(main, backBtn("К итогу смены", () => go("shift")),
    question(`Простой с ${fmtClock(d.startMs)}`),
    h("p", { class: "muted", text: d.open ? "Ещё идёт. Заполнение карточки не отмечает пуск." : `До ${fmtClock(d.endMs)} · ${fmtDurMin(d.minutes)}` }),
    d.segs.length > 1 ? h("div", { class: "tiles" }, d.segs.map((part) => h("button", {
      class: "tile" + (part.index === s.index ? " sel" : ""), onclick: () => { ui.card.index = part.index; render(); },
    }, `${fmtClock(part.startMs)}–${part.open ? "сейчас" : fmtClock(part.endMs)}`, h("span", { class: "t-code", text: reasonLabel(part.reason) || "Без причины" })))) : null,
    question("Что изменить?"),
    choice("Причина", reasonLabel(s.reason) || "Не указана", () => {
      ui.wz = { mode: "shiftfix", downtimeId: s.downtimeId, index: s.index, step: 1,
        group: reasonGroup(s.reason), reason: s.reason, note: s.note || "" };
      go("reason");
    }),
    choice("Что случилось", s.note || "Не указано", () => editText("note")),
    choice("Что сделали", s.action || (d.open ? "Можно записать уже выполненную работу" : "Не указано"), () => editText("action")),
    choice("Брак", s.billet == null ? "Не указан" : fmtTons(s.billet), () => {
      ui.bl = { downtimeId: s.downtimeId, index: s.index, value: s.billet == null ? "" : String(s.billet), custom: false };
      go("billet");
    }),
    h("p", { class: "hint", text: receiptFor(d.downtimeId).length ? receiptStatus(receiptFor(d.downtimeId)) : "Запись из данных сервера" }));
}

function renderActionFix(main, view) {
  const af = ui.af;
  if (!af) return go("detail");
  const field = af.field || "action";
  const note = field === "note";
  const must = !note || needsNote(af.reason);
  const ta = h("textarea", { class: "note-input", rows: "4", maxlength: String(NOTE_MAX),
    placeholder: note ? noteHint(af.reason) : actionHint(af.reason), "aria-label": note ? "Что случилось" : "Что сделали" });
  ta.value = af.value || "";
  const error = h("p", { class: "error-text", text: note ? "Опишите своими словами, что случилось." : "Напишите, что сделали." });
  const save = h("button", { class: "btn primary", onclick: () => {
    if (must && !validAction(ta.value)) return;
    const data = cardData(buildView());
    if (!data || data.s.downtimeId !== af.downtimeId || data.s.index !== af.index) {
      error.hidden = false; error.textContent = "Запись изменилась. Вернитесь к карточке и проверьте её."; return;
    }
    ui.af = null;
    ui.screen = "detail";
    send("fix", { downtimeId: af.downtimeId, index: af.index, [field]: ta.value.trim() });
  } }, "Сохранить");
  const update = () => {
    af.value = ta.value;
    save.disabled = must && !validAction(ta.value);
    error.hidden = !save.disabled || !touched;
  };
  let touched = !!ta.value;
  ta.addEventListener("input", () => { touched = true; update(); });
  update();
  fill(main, backBtn("К записи простоя", () => go("detail")), question(note ? "Что случилось?" : "Что сделали?"),
    note ? h("p", { class: "muted", text: reasonLabel(af.reason) }) : null, ta,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }), error, save);
}

// Брак — самостоятельный вопрос карточки, не скрытый шаг после причины.
function renderBillet(main, view) {
  const bl = ui.bl;
  if (!bl) return go("detail");
  const save = (value) => {
    if (!Number.isFinite(value) || value < 0) return;
    ui.bl = null;
    ui.screen = "detail";
    send("fix", { downtimeId: bl.downtimeId, index: bl.index, billet: value });
  };
  const input = h("input", { type: "number", min: "0", step: "0.1", inputmode: "decimal", "aria-label": "Брак в тоннах", placeholder: "Тонны" });
  input.value = bl.value;
  input.addEventListener("input", () => { bl.value = input.value; });
  fill(main, backBtn("К записи простоя", () => go("detail")), question("Сколько заготовки ушло в брак?"),
    h("p", { class: "muted", text: bl.value !== "" ? `В записи: ${fmtTons(bl.value)}` : "Если брака не было, выберите 0 т." }),
    h("div", { class: "tiles" }, [0, 0.5, 1, 2, 5].map((v) => h("button", { class: "tile", onclick: () => save(v) }, fmtTons(v)))),
    h("label", { for: "billet-value", text: "Другое количество, т" }),
    Object.assign(input, { id: "billet-value" }),
    h("button", { class: "btn primary", onclick: () => {
      if (input.value.trim()) save(Number(input.value.replace(",", ".")));
    } }, "Сохранить"));
}

// Черновик «что сделали по ремонту» относится к своему простою и своей смене
function closeActionDraft(view) {
  const d = ui.closeAction;
  return view.open && d && d.key === stopShiftKey(view) && typeof d.text === "string" ? d.text : "";
}
function renderCloseConfirm(main, view) {
  const gaps = handoverGaps(view);
  const trouble = records.filter((r) => r.status === "rejected").length;
  const receipt = records.filter((r) => ui.closeReceipt?.includes(r.event.id));
  let repairWorkField = null;
  if (view.open) {
    const ta = h("textarea", {
      class: "note-input",
      id: "close-action",
      rows: "4",
      maxlength: String(NOTE_MAX),
      placeholder: "Например: сняли редуктор, ждём подшипник со склада",
    });
    ta.value = closeActionDraft(view);
    ta.addEventListener("input", () => { ui.closeAction = { key: stopShiftKey(view), text: ta.value }; });
    repairWorkField = [
      h("label", { for: "close-action", text: "Что сделали по ремонту за смену и что осталось?" }),
      ta,
      h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
    ];
  }
  fill(main, backBtn("К проверке состояния стана", () => go("closeCheck")), question("Закрыть смену?"),
    receipt.length ? h("p", { class: "receipt", text: receiptStatus(receipt) }) : null,
    receipt.length && receiptStatus(receipt) === "Сохранено на планшете"
      ? h("p", { class: "muted", text: "Запись уйдёт на сервер, когда появится связь." }) : null,
    h("p", { text: view.open ? "Стан стоит. Простой перейдёт следующей смене, пуск отмечать не нужно. Напишите, что успели сделать по ремонту, — следующей смене будет проще."
      : "Стан работает. Закроем смену с записанными итогами." }),
    gaps.length ? h("div", { class: "handover-note" },
      h("p", { text: "Есть незаполненные записи. Дополните их или закройте смену с пометкой — ничего выдумывать не нужно." }),
      gaps.map((s) => h("button", { class: "btn", onclick: () => openDetail(s.downtimeId, s.index) },
        `${fmtClock(s.startMs)} · дополнить: ${s.missing.join(", ")}`))) : h("p", { class: "muted", text: "У закрытых простоев указаны причина и выполненные работы." }),
    trouble ? h("p", { class: "error-text", text: `Есть записи, которые сервер не принял: ${trouble}. Они останутся на планшете для исправления.` }) : null,
    repairWorkField,
    h("button", { class: "btn primary", disabled: !view.crew || view.closed, onclick: () => doCloseShift(gaps.length > 0 || trouble > 0) },
      gaps.length || trouble ? "Закрыть смену с пометкой" : "Закрыть смену"));
}

// Контракт: передача смены — только shift_close. Открытый простой не закрываем.
function shiftCloseEvents(view, withGaps) {
  const gaps = handoverGaps(view);
  if (gaps.length && !withGaps) return [];
  const lines = [view.open ? "Стан стоит. Открытый простой передан следующей смене." : "Стан работает."];
  if (gaps.length) lines.push(`Не заполнено записей: ${gaps.length}. ` +
    gaps.map((s) => `${fmtClock(s.startMs)}: ${s.missing.join(", ")}`).join("; "));
  const rejected = records.filter((r) => r.status === "rejected").length;
  if (rejected) lines.push(`Не приняты сервером записи: ${rejected}. Требуется исправление на планшете.`);
  // Что сделали по ремонту: необязательно; пустое не отправляем
  const action = view.open ? closeActionDraft(view).trim().slice(0, NOTE_MAX) : "";
  return [{ type: "shift_close", fields: { note: lines.join(" ").slice(0, NOTE_MAX), ...(action ? { action } : {}) } }];
}
function doCloseShift(withGaps = false) {
  const view = buildView();
  if (!view?.crew || view.closed) return;
  const events = shiftCloseEvents(view, withGaps);
  if (!events.length) return go("closeConfirm");
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const workMin = shiftWorkMin(view, downMin);
  ui.closedInfo = { workMin, downMin, stops: shiftDowntimes(view).length, open: !!view.open,
    note: events[0].fields.note, action: events[0].fields.action || "", gaps: handoverGaps(view), at: nowMs() };
  ui.screen = "closed";
  ui.resume = null;
  ui.closeAction = null;
  const sent = sendBatch(events);
  ui.closedInfo.eventIds = sent.map((e) => e.id);
  persistClient();
}

function renderClosed(main, view) {
  const info = ui.closedInfo;
  const list = records.filter((r) => info?.eventIds?.includes(r.event.id));
  const rejected = list.some((r) => r.status === "rejected");
  fill(main, question(rejected ? "Закрытие смены нужно исправить" : "Смена закрыта"),
    h("p", { class: "receipt", text: receiptStatus(list) }),
    receiptStatus(list) === "Сохранено на планшете" ? h("p", { class: "muted", text: "Запись уйдёт на сервер, когда появится связь." }) : null,
    info ? h("div", { class: "stats" },
      h("div", { class: "stat good" }, "Работа", h("span", { class: "v", text: fmtDurMin(info.workMin) })),
      h("div", { class: "stat bad" }, "Простои", h("span", { class: "v", text: `${info.stops} · ${fmtDurMin(info.downMin)}` }))) : null,
    info?.note ? h("p", { class: "handover-note", text: info.note }) : null,
    info?.action ? h("div", { class: "card" },
      h("div", { class: "card-title", text: "Передали по ремонту" }),
      h("div", { class: "card-note", text: `«${info.action}»` })) : null,
    info?.open ? h("p", { class: "muted", text: "Следующий работник примет смену со стоящим станом. Простой продолжается." }) : null,
    h("button", { class: "btn primary", onclick: () => { ui.crewId = null; ui.crewBack = false; go("crew"); } }, "Принять смену"));
}

// Отклонённое событие хранится целиком, пока исправление не примет сервер.
function renderRepair(main, view) {
  const repair = ui.repair;
  if (!repair) return go("auto");
  const e = repair.event;
  const record = records.find((r) => r.event.id === repair.id);
  const choice = (field, label, value) => h("button", { class: "btn shift-action", onclick: () => {
    repair.field = field; go("repairField");
  } }, h("span", { text: label }), h("span", { class: "action-help", text: value || "Не указано" }));
  const replacement = records.findLast((r) => r.replaces === repair.id && r.status === "pending");
  fill(main, backBtn("Вернуться, не исправляя", () => go(repair.back === "repair" ? "auto" : repair.back || "auto")),
    question("Исправить запись"),
    h("p", { text: humanError(record?.error) }),
    h("p", { class: "muted", text: eventTitle(e) }),
    choice("at", "Когда отметили", `${fmtDate(core.toMs(e.at))} ${fmtClock(core.toMs(e.at))} · МСК`),
    e.type === "manual" ? choice("from", "Когда стан встал", `${fmtDate(core.toMs(e.from))} ${fmtClock(core.toMs(e.from))}`) : null,
    e.type === "manual" ? choice("to", "Когда стан пошёл", `${fmtDate(core.toMs(e.to))} ${fmtClock(core.toMs(e.to))}`) : null,
    !["shift_open", "shift_close"].includes(e.type) ? h("button", { class: "btn shift-action", onclick: () => {
      ui.wz = { mode: "repair", downtimeId: e.downtimeId, index: e.index, step: 1,
        reason: e.reason, group: reasonGroup(e.reason), note: e.note || "" };
      go("reason");
    } }, "Причина", h("span", { class: "action-help", text: reasonLabel(e.reason) || "Не указана" })) : null,
    choice("note", e.type === "shift_close" ? "Пометка при закрытии смены" : "Что случилось", e.note),
    ["start", "manual", "fix"].includes(e.type) ? choice("action", "Что сделали", e.action) : null,
    ["manual", "fix"].includes(e.type) ? choice("billet", "Брак", e.billet == null ? "Не указан" : fmtTons(e.billet)) : null,
    e.type === "shift_open" ? h("button", { class: "btn", onclick: () => { ui.crewId = null; ui.crewBack = true; go("crew"); } }, "Выбрать работника") : null,
    repair.error ? h("p", { class: "error-text", text: repair.error }) : null,
    replacement ? h("p", { text: "Исправление сохранено на планшете и ждёт ответа сервера." }) : null,
    h("button", { class: "btn primary", disabled: !!replacement, onclick: submitRepair }, "Отправить исправление"));
}
function renderRepairField(main) {
  const repair = ui.repair;
  if (!repair) return go("auto");
  const { field, event: e } = repair;
  const time = ["at", "from", "to"].includes(field);
  const labels = { at: "Когда отметили?", from: "Когда стан встал?", to: "Когда стан пошёл?", note: e.type === "shift_close" ? "Пометка при закрытии смены" : "Что случилось?", action: "Что сделали?", billet: "Сколько брака, в тоннах?" };
  const input = time || field === "billet"
    ? h("input", { type: time ? "datetime-local" : "number", min: field === "billet" ? "0" : null, step: field === "billet" ? "0.1" : null, "aria-label": labels[field] })
    : h("textarea", { class: "note-input", maxlength: String(NOTE_MAX), "aria-label": labels[field], placeholder: field === "action" ? actionHint(e.reason) : noteHint(e.reason) });
  input.value = time ? localTimeValue(core.toMs(e[field])) : e[field] ?? "";
  const error = h("p", { class: "error-text", hidden: true });
  repair.values ||= {};
  repair.invalid ||= {};
  if (Object.hasOwn(repair.values, field)) input.value = repair.values[field];
  input.addEventListener("input", () => {
    // Даже ещё не подтверждённый ответ переживает перезагрузку.
    repair.values[field] = input.value;
    const value = time ? parseLocalTime(input.value) : field === "billet" ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
    repair.invalid[field] = (time && (!Number.isFinite(value) || value > nowMs())) ||
      (field === "billet" && (!Number.isFinite(value) || value < 0));
    if (!repair.invalid[field]) e[field] = time ? new Date(value).toISOString() : value;
  });
  fill(main, backBtn("К сохранённой записи", () => go("repair")),
    question(labels[field]), time ? h("p", { class: "muted", text: "Дата и время по Москве. Меняйте время только если оно было указано неверно." }) : null,
    input, error, h("button", { class: "btn primary", onclick: () => {
      const value = time ? parseLocalTime(input.value) : field === "billet" ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
      if ((time && (!Number.isFinite(value) || value > nowMs())) || (field === "billet" && (!Number.isFinite(value) || value < 0))) {
        error.textContent = time ? "Укажите прошедшее время." : "Укажите вес от нуля."; error.hidden = false; return;
      }
      e[field] = time ? new Date(value).toISOString() : value;
      repair.invalid[field] = false;
      go("repair");
    } }, "Готово"));
}
function submitRepair() {
  const repair = ui.repair;
  if (!repair) return;
  const e = repair.event;
  const view = buildView();
  repair.error = "";
  const target = e.type === "fix" ? [...view.segments, view.open].find((s) => s && s.downtimeId === e.downtimeId && s.index === e.index) : null;
  const effectiveReason = e.reason === undefined ? target?.reason : e.reason;
  const effectiveNote = e.note === undefined ? target?.note : e.note;
  if (effectiveReason && (!reasonRef(effectiveReason) || (needsNote(effectiveReason) && !validAction(effectiveNote)))) {
    repair.error = "Проверьте причину. Для иной причины нужно описание своими словами.";
  }
  if (e.type === "fix" && e.action !== undefined && !validAction(e.action)) repair.error = "Напишите, что сделали.";
  if (e.type === "manual") repair.error = manualError(view, { ...e, from: core.toMs(e.from), to: core.toMs(e.to) });
  if (e.type === "start") {
    const reason = e.reason || view.open?.reason;
    const note = e.note ?? view.open?.note;
    if (!view.open || view.open.downtimeId !== e.downtimeId) repair.error = "Этот простой уже изменился. Проверьте его в итоге смены; сохранённые ответы остаются здесь.";
    else if (!reasonRef(reason) || !validAction(e.action) || (needsNote(reason) && !validAction(note))) repair.error = "Укажите причину и что сделали. Для иной причины нужно описание.";
    else if (core.toMs(e.at) < view.open.startMs) repair.error = "Пуск не может быть раньше остановки.";
  }
  if (["reason", "split"].includes(e.type) && (!reasonRef(e.reason) || (needsNote(e.reason) && !validAction(e.note)))) repair.error = "Выберите причину. Для иной причины нужно описание.";
  if (core.toMs(e.at) > nowMs()) repair.error = "Время записи в будущем. Исправьте его.";
  if (Object.values(repair.invalid || {}).some(Boolean)) repair.error = "Проверьте введённое время или вес. Ответ остался в своём поле.";
  if (repair.error) { render(); return; }
  const { id, type, device, seq, ...fields } = e;
  // start сам по себе не меняет причину в ядре: отправляем её отдельно.
  if (type === "start" && e.reason) queueEvent("reason", { downtimeId: e.downtimeId, reason: e.reason, note: e.note || "", at: e.at });
  const next = queueEvent(type, fields);
  records.find((r) => r.event.id === next.id).replaces = id;
  if (type === "shift_close" && ui.closedInfo) ui.closedInfo.eventIds = [next.id];
  persistClient();
  ui.repair = null;
  go(type === "shift_close" ? "closed" : "auto");
  flush();
}

// --- Тики часов на экране ---
function tick() {
  const now = nowMs();
  // Московское время в полосах и на табло
  for (const el of document.querySelectorAll("[data-msk]")) el.textContent = fmtClock(now) + " МСК";
  for (const el of document.querySelectorAll("[data-until]")) el.textContent = fmtDurMin((Number(el.dataset.until) - now) / 60000);
  for (const el of document.querySelectorAll(".board-clock")) el.textContent = fmtClock(now);
  for (const el of document.querySelectorAll("[data-since]")) {
    const since = Number(el.dataset.since);
    el.textContent = el.dataset.fmt === "durs" ? fmtDurSec((now - since) / 1000)
      : el.dataset.fmt === "dur" ? fmtDurMin((now - since) / 60000) : fmtTimer(now - since);
  }
}

// --- Не даём экрану погаснуть ---
let wakeLock = null;
async function requestWake() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* отказ — не критично */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (!wakeLock) requestWake();
    loadState();
  }
});
window.addEventListener("online", () => { flush(); loadState(); });
document.addEventListener("input", (event) => {
  if (!key || event.target.type === "password") return;
  persistClient();
  renderTopbar();
});
document.addEventListener("change", () => { if (key) persistClient(); });
window.addEventListener("pagehide", persistClient);

// --- Запуск ---
async function boot() {
  if (!key) { render(); return; }
  render();
  if (!refs) {
    const ok = await loadRefs();
    if (!ok && !refs) { render(); return; }
  }
  await loadState();
  render();
  flush();
}

takeKeyFromHash();
key = readStore(STORE_KEY) || null;
loadCachedRefs();

// Демо-режим: имитация сервера в браузере. Включается на GitHub Pages
// (там сервера нет) или вручную параметром ?mock=1.
if (DEMO) {
  const m = await import("./mock.js");
  // Имитация хранит сервер в памяти вкладки. Восстанавливаем только уже
  // принятые ею события, отдельно от очереди и данных настоящего стана.
  let seeded = false;
  let seeding = null;
  api = async (path, options) => {
    if (!seeded) {
      if (!seeding) seeding = (async () => {
        const accepted = records.filter((r) => r.status === "saved").map((r) => r.event);
        if (accepted.length) await m.api("/api/events", { method: "POST", body: JSON.stringify({ events: accepted }) });
        seeded = true;
      })().finally(() => { seeding = null; });
      await seeding;
    }
    return m.api(path, options);
  };
  if (!key) key = "demo"; // ключ устройства в демо не нужен
}
if (ui.mw) ui.mw.saving = false;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* офлайн-установка недоступна */ });
}

requestWake();
setInterval(loadState, STATE_POLL_MS);
setInterval(flush, QUEUE_RETRY_MS);
setInterval(tick, 1000);
boot();
