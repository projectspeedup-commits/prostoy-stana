// Страница рабочего: учёт простоев стана. Чистый ES-модуль, без сборки.
// Версия 2: пошаговые экраны, один вопрос — один экран.
import * as core from "./core/core.js";

const STORE_KEY = "stan.deviceKey";
const QUEUE_KEY = "stan.queue";
const REFS_KEY = "stan.refs";
const SEQ_KEY = "stan.seq";
const STATE_POLL_MS = 30_000;
const QUEUE_RETRY_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const LONG_STOP_MS = 4 * 3_600_000;
const NOTE_MAX = 500;

const $ = (id) => document.getElementById(id);

function readStore(name) {
  try { return localStorage.getItem(name); } catch { return null; }
}
function writeStore(name, value) {
  try { localStorage.setItem(name, value); } catch { /* хранилище недоступно */ }
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
let serverState = null;   // последнее состояние от сервера
let queue = loadQueue();  // неподтверждённые события
let clockOffset = 0;      // serverTime - Date.now()
let online = false;
let flushing = false;
let recTimer = null;      // авто-возврат с экрана «Простой записан»

// Экран и данные мастеров. screen: auto | crew | reason | confirmChange |
// manual | manualCheck | restartConfirm | restartAction | actionFix |
// recorded | shift | billet | closeConfirm | closed
const ui = {
  screen: "auto",
  crewId: null,      // выбранная бригада на приёме смены
  crewBack: false,   // приём смены открыт кнопкой «Сменить» — есть куда вернуться
  wz: null,          // мастер причины: {mode, downtimeId, index, step, group, reason, note}
  mw: null,          // мастер «Забыл отметить простой»: {origin, step, from, durMin, group, reason, note}
  rw: null,          // мастер пуска: {downtimeId, index, startMs, reason, note, reasonChanged}
  af: null,          // дописывание выполненного: {downtimeId, index, action}
  bl: null,          // шаг заготовки: {downtimeId, index, custom}
  rec: null,         // экран «Простой записан»: {downtimeId}
  closedInfo: null,  // итоги для экрана «Смена сдана»
  focusNote: false,  // поставить курсор в поле «своими словами»
  rejects: [],
  keyError: null,
};

function loadQueue() {
  try {
    const q = JSON.parse(readStore(QUEUE_KEY));
    if (Array.isArray(q)) return q.filter((e) => e && typeof e.id === "string" && typeof e.type === "string");
  } catch { /* пусто или повреждено */ }
  return [];
}
function persistQueue() {
  writeStore(QUEUE_KEY, JSON.stringify(queue));
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
  const who = type === "shift_open" ? null : buildView().crew;
  const { at, ...rest } = fields;
  const e = {
    ...(who ? { crewId: who.crewId, personId: who.personId } : {}),
    id: crypto.randomUUID(),
    type,
    at: at || new Date(nowMs()).toISOString(),
    device: "web",
    seq: nextSeq(),
    ...rest,
  };
  queue.push(e);
  return e;
}
function send(type, fields = {}) {
  queueEvent(type, fields);
  persistQueue();
  render();
  flush();
}
function sendBatch(events) {
  for (const { type, fields } of events) queueEvent(type, fields);
  persistQueue();
  render();
  flush();
}

async function flush() {
  if (flushing || !queue.length || !key) return;
  flushing = true;
  try {
    const d = await api("/api/events", { method: "POST", body: JSON.stringify({ events: queue }) });
    const saved = new Set(d.saved || []);
    const rejected = d.rejected || [];
    const rejectedIds = new Set(rejected.map((r) => r.id));
    queue = queue.filter((e) => !saved.has(e.id) && !rejectedIds.has(e.id));
    persistQueue();
    for (const r of rejected) {
      ui.rejects.push({ id: r.id, error: r.error || "отклонено" });
    }
    if (ui.rejects.length > 5) ui.rejects = ui.rejects.slice(-5);
    if (d.state) serverState = d.state;
    updateClock(d.serverTime);
    setOnline(true);
  } catch (err) {
    if (err && err.status === 401) return badKey();
    setOnline(false);
  } finally {
    flushing = false;
  }
  softRender();
}

async function loadState() {
  if (!key) return;
  try {
    const d = await api("/api/state");
    if (d && d.ok) {
      serverState = d.state;
      updateClock(d.serverTime);
      if (d.refsVersion && refsVersion && d.refsVersion !== refsVersion) loadRefs();
      setOnline(true);
    }
  } catch (err) {
    if (err && err.status === 401) return badKey();
    setOnline(false);
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
      reason: last && last.reason !== undefined ? last.reason : null,
      note: last && last.note !== undefined ? last.note : null,
      action: last && last.action !== undefined ? last.action : null,
      index: last ? last.index : 0,
    };
  }
  const v = {
    running: !!s.running,
    open,
    crew: s.crew ? { ...s.crew } : null,
    closed: !!s.closed,
    shift: s.shift,
    segments: (s.segments || []).map((x) => ({ ...x })),
  };
  for (const e of queue) applyEvent(v, e);
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
        v.open = { downtimeId: e.downtimeId || e.id, startMs: t, reason: e.reason ?? null, note: null, index: 0 };
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
          reason: e.reason ?? null,
          note: e.note !== undefined ? e.note : null,
        };
      }
      break;
    case "start":
      if (matchOpen()) {
        if (e.action !== undefined) v.open.action = e.action;
        closeOpen(t);
        v.open = null;
        v.running = true;
      }
      break;
    case "manual": {
      const from = core.toMs(e.from);
      const to = core.toMs(e.to);
      if (to > from) {
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
      v.crew = { crewId: e.crewId, personId: e.personId, at: e.at };
      v.closed = false;
      break;
    case "shift_close":
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
      minutes: Math.round(g.segs.reduce((a, s) => a + ((s.open || s.endMs === null ? nowMs() : s.endMs) - s.startMs), 0) / 60000),
      reason: last.reason ?? null,
      note: last.note ?? null,
      action: last.action ?? null,
      billet: g.segs.map((s) => s.billet).find((b) => b !== null && b !== undefined) ?? null,
      manual: g.segs.some((s) => s.manual),
      indexLast: last.index || 0,
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

// Табло стана: московское время, состояние, работа, простой и остановки за период
function board(view) {
  const shift = view.shift;
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const workMin = Math.max(0, Math.round((Math.min(nowMs(), shift.endMs) - shift.startMs) / 60000) - downMin);
  const stops = shiftDowntimes(view).length;
  const stopped = !!view.open;
  return h("div", { class: "board" },
    h("div", { class: "board-top" },
      h("span", { class: "board-clock", text: fmtClock(nowMs()) }),
      h("span", { class: "board-date", text: `${fmtDate(nowMs())} · Москва` })),
    h("div", { class: "board-state " + (stopped ? "stopped" : "running"),
      text: stopped ? `Стан стоит с ${fmtClock(view.open.startMs)}` : "Стан работает" }),
    h("div", { class: "board-period muted", text: `${periodLabel(shift)} · с начала периода` }),
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
function fmtDurMin(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
function fmtTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
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
  const conn = $("conn");
  if (!key) {
    conn.className = "pill wait";
    conn.textContent = "Нет ключа";
  } else if (online && !queue.length) {
    conn.className = "pill ok";
    conn.textContent = "На связи";
  } else if (online) {
    conn.className = "pill warn";
    conn.textContent = `Отправка: ${queue.length}`;
  } else {
    conn.className = "pill bad";
    conn.textContent = queue.length ? `Нет связи, в очереди ${queue.length}` : "Нет связи";
  }
  $("demo").hidden = !(refs && refs.demo);
}

function renderRejects() {
  const box = $("rejects");
  if (!ui.rejects.length) {
    box.hidden = true;
    fill(box, );
    return;
  }
  box.hidden = false;
  fill(box,
    ...ui.rejects.map((r) =>
      h("div", { class: "reject" }, `Сервер отклонил нажатие: ${r.error}. `,
        h("button", { class: "btn back", style: "min-height:44px;margin-top:4px", onclick: () => { ui.rejects = ui.rejects.filter((x) => x !== r); renderRejects(); } }, "Понятно"))
    )
  );
}

function reasonRef(code) {
  return code && refs.reasons ? refs.reasons[code] : undefined;
}
function reasonLabel(code) {
  const r = reasonRef(code);
  return r ? r.short || r.title || code : code || "";
}
function personName(id) {
  const p = (refs.people || []).find((x) => x.id === id);
  return p ? p.name : "—";
}
function crewTitle(id) {
  const c = (refs.crews || []).find((x) => x.id === id);
  return c ? c.title : "—";
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
  if (recTimer) { clearTimeout(recTimer); recTimer = null; }
  ui.screen = screen;
  render();
}

// --- Экраны ---
function render() {
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
    case "restartConfirm": return renderRestartConfirm(main, view);
    case "restartAction": return renderRestartAction(main, view);
    case "actionFix": return renderActionFix(main, view);
    case "recorded": return renderRecorded(main, view);
    case "shift": return renderShift(main, view);
    case "billet": return renderBillet(main, view);
    case "closeConfirm": return renderCloseConfirm(main, view);
    case "closed": return renderClosed(main, view);
  }
  if (needCrew(view)) return renderCrew(main, view);
  if (view.open) return renderStop(main, view);
  return renderRun(main, view);
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
    h("p", { class: "muted", text: "Не удалось получить справочники. Проверьте связь." }),
    h("button", { class: "btn primary", onclick: () => { loadRefs().then((ok) => { if (ok) loadState(); else render(); }); } }, "Повторить")
  );
}

function renderLoading(main) {
  fill(main,
    h("h1", { class: "q", text: "Загрузка…" }),
    h("p", { class: "muted", text: "Запрашиваем состояние стана." })
  );
}

// Приём смены: шаг 1 — бригада, шаг 2 — человек
function renderCrew(main, view) {
  const crews = refs.crews || [];
  const single = crews.length === 1 ? crews[0].id : null;
  const chosen = ui.crewId || single;
  const kids = [];
  if (!chosen) {
    if (ui.crewBack) kids.push(backBtn("На главный экран", () => { ui.crewBack = false; go("auto"); }));
    kids.push(board(view), stepLine(1, 2), question("Выберите вашу смену"));
    kids.push(h("div", { class: "tiles" },
      crews.map((c) => h("button", { class: "tile", onclick: () => { ui.crewId = c.id; render(); } }, c.title))
    ));
  } else {
    if (!single) {
      kids.push(backBtn("К выбору смены", () => { ui.crewId = null; render(); }));
    } else if (ui.crewBack) {
      kids.push(backBtn("На главный экран", () => { ui.crewBack = false; go("auto"); }));
    }
    kids.push(stepLine(single ? 1 : 2, single ? 1 : 2), question(crewTitle(chosen)));
    const people = (refs.people || []).filter((p) => p.crewId === chosen);
    kids.push(h("div", { class: "tiles" },
      people.map((p) => h("button", {
        class: "tile",
        onclick: () => {
          send("shift_open", { crewId: chosen, personId: p.id });
          ui.crewId = null;
          ui.crewBack = false;
          go("auto");
        },
      }, p.name))
    ));
  }
  fill(main, ...kids);
}

// Главный экран: стан работает
function renderRun(main, view) {
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const dts = shiftDowntimes(view);
  const stops = dts.length;
  const lastStart = dts.length
    ? Math.max(...dts.map((d) => (d.open || d.endMs === null ? nowMs() : d.endMs)))
    : view.shift.startMs;
  fill(main,
    h("div", { class: "runhead" },
      h("span", { class: "muted", text: `${personName(view.crew.personId)} · ${crewTitle(view.crew.crewId)} · ${periodLabel(view.shift)}` }),
      h("button", { class: "btn btn-flat btn-inline", onclick: () => { ui.crewBack = true; go("crew"); } }, "Сменить")
    ),
    h("div", { class: "bar green" },
      "Стан работает · ",
      h("span", { dataset: { since: String(lastStart), fmt: "dur" } }, fmtDurMin((nowMs() - lastStart) / 60000))
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
    h("div", { class: "row2" },
      h("button", { class: "btn", onclick: () => startManualWizard("run") }, "Забыл отметить простой"),
      h("button", { class: "btn", onclick: () => go("shift") }, "Итог смены")
    ),
    h("p", { class: "muted", text: `За смену: ${stops} ${plural(stops, "простой", "простоя", "простоев")}, ${fmtDurMin(downMin)}` })
  );
}

// Экран «Стан стоит»
function renderStop(main, view) {
  const open = view.open;
  const elapsed = nowMs() - open.startMs;
  const cur = open.reason;

  const left = h("div", null,
    h("div", { class: "bar red" },
      `Стан стоит с ${fmtClock(open.startMs)}`,
      h("span", { class: "timer", dataset: { since: String(open.startMs) } }, fmtTimer(elapsed))
    ),
    elapsed > LONG_STOP_MS
      ? h("div", { class: "banner-warn", text: "Стан всё ещё стоит? Если уже работает — нажмите зелёную кнопку" })
      : null,
    h("button", {
      class: "btn primary btn-go",
      onclick: () => {
        ui.rw = {
          downtimeId: open.downtimeId,
          index: open.index,
          startMs: nowMs(),
          reason: open.reason,
          note: open.note,
          reasonChanged: false,
        };
        if (open.reason) go("restartConfirm");
        else startRestartReasonWizard();
      },
    }, "СТАН ПОШЁЛ"),
    h("p", { class: "hint", text: "Когда исправили — нажмите. Потом укажете причину и что сделали" })
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

  fill(main, h("div", { class: "stop-grid" }, left, h("div", null, card)));
}

function cancelRestart() {
  ui.wz = null;
  ui.rw = null;
  go("auto");
}

function restartBack() {
  return backBtn("Вернуться к простою (стан ещё стоит)", cancelRestart);
}

function startRestartReasonWizard() {
  const rw = ui.rw;
  ui.wz = { mode: "restart", downtimeId: rw.downtimeId, index: rw.index, step: 1, group: null, reason: null, note: "" };
  go("reason");
}

function renderRestartConfirm(main, view) {
  const rw = ui.rw;
  if (!rw || !view.open) return go("auto");
  fill(main,
    restartBack(),
    stepLine(1, 2),
    question(`Причина: ${reasonLabel(rw.reason)} — верно?`),
    h("button", { class: "btn primary", onclick: () => go("restartAction") }, "Да, верно"),
    h("button", { class: "btn", onclick: startRestartReasonWizard }, "Изменить")
  );
}

// Вопрос перед сменой причины на ходу
function renderConfirmChange(main, view) {
  const open = view.open;
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

// Мастер выбора причины: группа → причина → своими словами
function renderReasonWizard(main, view) {
  const wz = ui.wz;
  const restarting = wz.mode === "restart";
  const past = wz.mode === "past" || wz.mode === "shiftfix" || restarting;
  const total = restarting ? 4 : 3;
  const back1 = {
    current: ["Вернуться к простою (причину можно указать позже)", () => go("auto")],
    refix: ["Вернуться к простою", () => go("auto")],
    split: ["Вернуться к простою", () => go("auto")],
    past: ["На главный экран", () => go("auto")],
    shiftfix: ["К итогу смены", () => go("shift")],
    restart: ["Вернуться к простою (стан ещё стоит)", cancelRestart],
  }[wz.mode];

  if (wz.step === 1) {
    fill(main,
      backBtn(...back1),
      stepLine(1, total),
      question(past ? "Почему стоял?" : "Почему стоит?"),
      h("div", { class: "tiles" },
        (refs.tiles || []).map((t) =>
          h("button", { class: "tile", onclick: () => { wz.group = t.id; wz.step = 2; render(); } }, t.title)
        ),
        !restarting ? h("button", {
          class: "tile unknown",
          onclick: () => {
            if (wz.mode === "past") go("recorded"); // «Укажу позже»
            else go(wz.mode === "shiftfix" ? "shift" : "auto");
          },
        }, wz.mode === "past" ? "Укажу позже" : "Пока не знаю") : null
      )
    );
    return;
  }

  if (wz.step === 2) {
    const tile = (refs.tiles || []).find((t) => t.id === wz.group);
    const codes = tile ? tile.codes : [];
    fill(main,
      restarting ? restartBack() : backBtn("К выбору группы", () => { wz.step = 1; render(); }),
      stepLine(2, total),
      question("Что именно?"),
      h("div", { class: "tiles" },
        codes.map((code) => {
          const r = reasonRef(code);
          return h("button", {
            class: "tile",
            onclick: () => { wz.reason = code; wz.step = 3; ui.focusNote = true; render(); },
          },
            r ? r.short || r.title : code,
            h("span", { class: "t-code", text: code })
          );
        })
      )
    );
    return;
  }

  // Шаг 3: своими словами
  const ta = h("textarea", {
    class: "note-input",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: "Например: на третьей клети заклинило подшипник",
    "aria-label": "Описание своими словами",
  });
  ta.value = wz.note || "";
  ta.addEventListener("input", () => { wz.note = ta.value; });
  const done = (withNote) => finishReasonWizard(withNote ? ta.value : undefined);
  fill(main,
    restarting ? restartBack() : backBtn("К выбору причины", () => { wz.step = 2; render(); }),
    stepLine(3, total),
    question("Расскажите своими словами"),
    h("div", { class: "card" }, h("div", { class: "card-title", text: reasonLabel(wz.reason) })),
    ta,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
    h("button", { class: "btn primary", onclick: () => done(true) }, "Готово"),
    h("button", { class: "btn", onclick: () => done(false) }, "Пропустить")
  );
  if (ui.focusNote) {
    ui.focusNote = false;
    ta.focus();
  }
}

function finishReasonWizard(rawNote) {
  const wz = ui.wz;
  const note = rawNote && rawNote.trim() ? rawNote.trim() : undefined;
  const noteField = note !== undefined ? { note } : {};
  if (wz.mode === "restart") {
    ui.rw.reason = wz.reason;
    ui.rw.note = note;
    ui.rw.reasonChanged = true;
    ui.wz = null;
    go("restartAction");
  } else if (wz.mode === "split") {
    send("split", { downtimeId: wz.downtimeId, reason: wz.reason, ...noteField });
    showToast("Записано");
    go("auto");
  } else if (wz.mode === "past") {
    send("fix", { downtimeId: wz.downtimeId, index: wz.index, reason: wz.reason, ...noteField });
    go("recorded");
  } else if (wz.mode === "shiftfix") {
    send("fix", { downtimeId: wz.downtimeId, index: wz.index, reason: wz.reason, ...noteField });
    const ref = reasonRef(wz.reason);
    if (ref && !ref.planned) {
      ui.bl = { downtimeId: wz.downtimeId, index: wz.index, custom: false };
      go("billet");
    } else {
      showToast("Записано");
      go("shift");
    }
  } else {
    // current и refix: событие reason для текущего отрезка
    send("reason", { downtimeId: wz.downtimeId, reason: wz.reason, ...noteField });
    showToast("Записано");
    go("auto");
  }
}

function validAction(value) {
  return value.trim().length >= 3;
}

function actionText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return validAction(text) ? text : "";
}

function renderRestartAction(main, view) {
  const rw = ui.rw;
  if (!rw || !view.open) return go("auto");
  const ta = h("textarea", {
    class: "note-input",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: "Например: заменили ножи, подтянули муфту",
    "aria-label": "Что сделали, чтобы запустить стан",
  });
  ta.value = rw.action || "";
  const error = h("p", { class: "error-text", text: "Напишите, что сделали" });
  const submit = h("button", { class: "btn primary btn-go", onclick: () => finishRestart(ta.value) }, "СТАН ПОШЁЛ");
  const update = () => {
    rw.action = ta.value;
    const ok = validAction(ta.value);
    submit.disabled = !ok;
    error.hidden = ok;
  };
  ta.addEventListener("input", update);
  update();
  const total = rw.reasonChanged ? 4 : 2;
  fill(main,
    restartBack(),
    stepLine(total, total),
    question("Что сделали, чтобы запустить стан?"),
    h("div", { class: "card" }, h("div", { class: "card-title", text: reasonLabel(rw.reason) })),
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
  const at = new Date(rw.startMs).toISOString();
  const events = [];
  if (rw.reasonChanged) {
    events.push({ type: "reason", fields: {
      downtimeId: rw.downtimeId,
      reason: rw.reason,
      ...(rw.note ? { note: rw.note } : {}),
      at,
    } });
  }
  events.push({ type: "start", fields: { downtimeId: rw.downtimeId, action, at } });
  ui.rec = { downtimeId: rw.downtimeId };
  ui.rw = null;
  ui.screen = "recorded";
  sendBatch(events);
}

// Мастер «Забыл отметить простой»
function startManualWizard(origin) {
  ui.mw = { origin, step: 1, from: nowMs() - 30 * 60000, durMin: 15, group: null, reason: null, note: "", action: "" };
  go("manual");
}

function manualClampFrom(mw, view) {
  const lo = view.shift.startMs;
  const hi = nowMs() - 60000;
  mw.from = Math.min(Math.max(mw.from, lo), hi);
}
function manualTo(mw) {
  return Math.min(mw.from + mw.durMin * 60000, nowMs());
}
function manualOverlap(view, from, to) {
  for (const s of view.segments) {
    const e = s.open || s.endMs === null ? nowMs() : s.endMs;
    if (from < e && to > s.startMs) return s;
  }
  if (view.open && from < nowMs() && to > view.open.startMs) return { startMs: view.open.startMs, endMs: null };
  return null;
}

function renderManual(main, view) {
  const mw = ui.mw;
  const back1 = mw.origin === "shift"
    ? ["К итогу смены", () => go("shift")]
    : ["На главный экран", () => go("auto")];
  const manualBacks = {
    2: ["К моменту остановки", () => { mw.step = 1; render(); }],
    3: ["К длительности", () => { mw.step = 2; render(); }],
    4: ["К выбору группы", () => { mw.step = 3; render(); }],
    5: ["К выбору причины", () => { mw.step = 4; render(); }],
    6: ["К описанию причины", () => { mw.step = 5; render(); }],
  };

  if (mw.step === 1) {
    manualClampFrom(mw, view);
    const quick = [[10, "10 мин назад"], [30, "30 мин назад"], [60, "1 ч назад"], [120, "2 ч назад"]];
    fill(main,
      backBtn(...back1),
      stepLine(1, 6),
      question("Когда стан встал?"),
      h("div", { class: "stepval", text: fmtClock(mw.from) }),
      h("div", { class: "tiles" },
        quick.map(([m, label]) =>
          h("button", { class: "tile", onclick: () => { mw.from = nowMs() - m * 60000; manualClampFrom(mw, view); render(); } }, label)
        )
      ),
      h("div", { class: "row2" },
        h("button", { class: "btn", onclick: () => { mw.from -= 5 * 60000; manualClampFrom(mw, view); render(); } }, "−5 мин"),
        h("button", { class: "btn", onclick: () => { mw.from += 5 * 60000; manualClampFrom(mw, view); render(); } }, "+5 мин")
      ),
      h("button", { class: "btn primary", onclick: () => { mw.step = 2; render(); } }, "Далее")
    );
    return;
  }

  if (mw.step === 2) {
    const durs = [[5, "5 мин"], [10, "10 мин"], [15, "15 мин"], [20, "20 мин"], [30, "30 мин"], [45, "45 мин"], [60, "1 ч"], [90, "1,5 ч"], [120, "2 ч"]];
    const to = manualTo(mw);
    const overlap = manualOverlap(view, mw.from, to);
    const tooShort = to - mw.from < 60000;
    fill(main,
      backBtn(...manualBacks[2]),
      stepLine(2, 6),
      question("Сколько стоял?"),
      h("div", { class: "tiles" },
        durs.map(([m, label]) =>
          h("button", { class: "tile" + (mw.durMin === m ? " sel" : ""), onclick: () => { mw.durMin = m; render(); } }, label)
        )
      ),
      h("div", { class: "row2" },
        h("button", { class: "btn", onclick: () => { mw.durMin = Math.max(5, mw.durMin - 5); render(); } }, "−5 мин"),
        h("button", { class: "btn", onclick: () => { mw.durMin += 5; render(); } }, "+5 мин")
      ),
      h("div", { class: "stepval", text: `с ${fmtClock(mw.from)} до ${fmtClock(to)}` }),
      overlap
        ? h("p", { class: "error-text", text: `В это время уже записан простой ${fmtClock(overlap.startMs)}–${overlap.endMs === null ? "сейчас" : fmtClock(overlap.endMs)}` })
        : null,
      h("button", {
        class: "btn primary",
        disabled: !!overlap || tooShort,
        onclick: () => { mw.step = 3; render(); },
      }, "Далее")
    );
    return;
  }

  if (mw.step === 3) {
    fill(main,
      backBtn(...manualBacks[3]),
      stepLine(3, 6),
      question("Почему стоял?"),
      h("div", { class: "tiles" },
        (refs.tiles || []).map((t) =>
          h("button", { class: "tile", onclick: () => { mw.group = t.id; mw.step = 4; render(); } }, t.title)
        )
      )
    );
    return;
  }

  if (mw.step === 4) {
    const tile = (refs.tiles || []).find((t) => t.id === mw.group);
    const codes = tile ? tile.codes : [];
    fill(main,
      backBtn(...manualBacks[4]),
      stepLine(4, 6),
      question("Что именно?"),
      h("div", { class: "tiles" },
        codes.map((code) => {
          const r = reasonRef(code);
          return h("button", {
            class: "tile",
            onclick: () => { mw.reason = code; mw.step = 5; ui.focusNote = true; render(); },
          },
            r ? r.short || r.title : code,
            h("span", { class: "t-code", text: code })
          );
        })
      )
    );
    return;
  }

  if (mw.step === 6) {
    const ta = h("textarea", {
      class: "note-input",
      rows: "4",
      maxlength: String(NOTE_MAX),
      placeholder: "Например: заменили ножи, подтянули муфту",
      "aria-label": "Что сделали, чтобы запустить стан",
    });
    ta.value = mw.action || "";
    const error = h("p", { class: "error-text", text: "Напишите, что сделали" });
    const submit = h("button", { class: "btn primary", onclick: () => {
      if (!validAction(ta.value)) return;
      mw.action = ta.value.trim();
      go("manualCheck");
    } }, "Далее");
    const update = () => {
      mw.action = ta.value;
      const ok = validAction(ta.value);
      submit.disabled = !ok;
      error.hidden = ok;
    };
    ta.addEventListener("input", update);
    update();
    fill(main,
      backBtn(...manualBacks[6]),
      stepLine(6, 6),
      question("Что сделали, чтобы запустить стан?"),
      ta,
      h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
      error,
      submit
    );
    return;
  }

  // Шаг 5: своими словами
  const ta = h("textarea", {
    class: "note-input",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: "Например: на третьей клети заклинило подшипник",
    "aria-label": "Описание своими словами",
  });
  ta.value = mw.note || "";
  ta.addEventListener("input", () => { mw.note = ta.value; });
  fill(main,
    backBtn(...manualBacks[5]),
    stepLine(5, 6),
    question("Расскажите своими словами"),
    h("div", { class: "card" }, h("div", { class: "card-title", text: reasonLabel(mw.reason) })),
    ta,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
    h("button", { class: "btn primary", onclick: () => { mw.note = ta.value; mw.step = 6; render(); } }, "Далее"),
    h("button", { class: "btn", onclick: () => { mw.note = ""; mw.step = 6; render(); } }, "Пропустить")
  );
  if (ui.focusNote) {
    ui.focusNote = false;
    ta.focus();
  }
}

function renderManualCheck(main, view) {
  const mw = ui.mw;
  const to = manualTo(mw);
  const note = mw.note && mw.note.trim() ? mw.note.trim() : "";
  const action = mw.action && mw.action.trim() ? mw.action.trim() : "";
  fill(main,
    backBtn("Исправить", () => { mw.step = 1; go("manual"); }),
    question("Проверьте"),
    h("div", { class: "card" },
      h("div", { class: "card-title", text: `Стан стоял с ${fmtClock(mw.from)} до ${fmtClock(to)} · ${fmtDurMin((to - mw.from) / 60000)}` }),
      h("div", { class: "card-line", text: reasonLabel(mw.reason) }),
      note ? h("div", { class: "card-note", text: `Что случилось: «${note}»` }) : null,
      h("div", { class: "card-note", text: `Что сделали: ${action}` })
    ),
    h("button", {
      class: "btn primary",
      onclick: () => {
        const downtimeId = crypto.randomUUID();
        send("manual", {
          downtimeId,
          from: new Date(mw.from).toISOString(),
          to: new Date(to).toISOString(),
          reason: mw.reason,
          ...(note ? { note } : {}),
          action,
        });
        ui.rec = { downtimeId };
        go("recorded");
      },
    }, "Сохранить")
  );
}

// Экран «Простой записан»
function renderRecorded(main, view) {
  const d = shiftDowntimes(view).find((x) => x.downtimeId === ui.rec.downtimeId);
  fill(main,
    question("Простой записан"),
    h("div", { class: "card ok" },
      d
        ? h("div", { class: "card-title", text: `${fmtClock(d.startMs)} – ${d.endMs === null ? "сейчас" : fmtClock(d.endMs)} · ${fmtDurMin(d.minutes)}` })
        : null,
      d && d.reason ? h("div", { class: "card-line", text: reasonLabel(d.reason) }) : null,
      d ? h("div", { class: "card-note", text: `Что случилось: ${d.note ? `«${d.note}»` : "не указано"}` }) : null,
      d ? h("div", { class: "card-note", text: `Что сделали: ${actionText(d.action) || "не указано"}` }) : null
    ),
    h("button", { class: "btn primary", onclick: () => go("auto") }, "Хорошо")
  );
  if (!recTimer) {
    recTimer = setTimeout(() => {
      recTimer = null;
      if (ui.screen === "recorded") go("auto");
    }, 8000);
  }
}

// Итог смены
function renderShift(main, view) {
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const shift = view.shift;
  const workMin = Math.max(0, Math.round((Math.min(nowMs(), shift.endMs) - shift.startMs) / 60000) - downMin);
  const dts = shiftDowntimes(view);
  fill(main,
    backBtn("На главный экран", () => go("auto")),
    h("h1", { class: "q", text: "Итог смены" }),
    h("p", { class: "muted", text: `${periodLabel(shift)} · ${crewTitle(view.crew?.crewId)}` }),
    h("div", { class: "stats" },
      h("div", { class: "stat good" }, "Работа", h("span", { class: "v", text: fmtDurMin(workMin) })),
      h("div", { class: "stat bad" }, "Простои", h("span", { class: "v", text: fmtDurMin(downMin) })),
      h("div", { class: "stat planned" }, "Плановые", h("span", { class: "v", text: fmtDurMin(sum.plannedMinutes) })),
      h("div", { class: "stat bad" }, "Внеплановые", h("span", { class: "v", text: fmtDurMin(sum.unplannedMinutes + sum.shortMinutes) }))
    ),
    h("h2", { text: "Простои смены" }),
    dts.length
      ? h("div", { class: "segs" }, dts.map((d) => downtimeRow(d)))
      : h("p", { class: "muted", text: "Простоев не было." }),
    h("button", { class: "btn", onclick: () => startManualWizard("shift") }, "Забыл отметить простой"),
    h("button", {
      class: "btn primary",
      onclick: () => {
        const noReason = dts.filter((d) => !d.reason).length;
        if (noReason > 0) go("closeConfirm");
        else doCloseShift(view);
      },
    }, "Сдать смену")
  );
}

function downtimeRow(d) {
  const action = actionText(d.action);
  return h("button", {
    class: "seg" + (d.open ? " open" : ""),
    onclick: () => {
      if (!action) {
        ui.af = { downtimeId: d.downtimeId, index: d.indexLast, action: "" };
        go("actionFix");
      } else {
        ui.wz = { mode: "shiftfix", downtimeId: d.downtimeId, index: d.indexLast, step: 1, group: null, reason: null, note: "" };
        go("reason");
      }
    },
  },
    h("span", { class: "when", text: d.open ? `${fmtClock(d.startMs)} – …` : `${fmtClock(d.startMs)} – ${fmtClock(d.endMs)}` }),
    h("span", null,
      d.reason
        ? h("span", { class: "why" }, reasonLabel(d.reason))
        : h("span", { class: "why" }, h("span", { class: "badge-need", text: "Нет причины — нажмите, чтобы указать" })),
      d.note ? h("span", { class: "manual-tag", text: `«${d.note}»` }) : null,
      action
        ? h("span", { class: "manual-tag", text: `Что сделали: ${action}` })
        : h("span", { class: "badge-need", text: "Не указано, что сделали" }),
      d.billet !== null ? h("span", { class: "manual-tag", text: `заготовка в брак: ${fmtTons(d.billet)}` }) : null,
      d.manual ? h("span", { class: "manual-tag", text: "добавлен вручную" }) : null
    ),
    h("span", { class: "dur", text: d.open ? "идёт" : fmtDurMin(d.minutes) })
  );
}

function renderActionFix(main, view) {
  const af = ui.af;
  if (!af) return go("shift");
  const ta = h("textarea", {
    class: "note-input",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: "Например: заменили ножи, подтянули муфту",
    "aria-label": "Что сделали, чтобы запустить стан",
  });
  ta.value = af.action || "";
  const error = h("p", { class: "error-text", text: "Напишите, что сделали" });
  const save = h("button", { class: "btn primary", onclick: () => {
    if (!validAction(ta.value)) return;
    send("fix", { downtimeId: af.downtimeId, index: af.index, action: ta.value.trim() });
    ui.af = null;
    showToast("Записано");
    go("shift");
  } }, "Сохранить");
  const update = () => {
    af.action = ta.value;
    const ok = validAction(ta.value);
    save.disabled = !ok;
    error.hidden = ok;
  };
  ta.addEventListener("input", update);
  update();
  fill(main,
    backBtn("К итогу смены", () => go("shift")),
    question("Что сделали, чтобы запустить стан?"),
    ta,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }),
    error,
    save
  );
}

// Шаг «Сколько заготовки ушло в брак?» после выбора причины в итоге смены
function renderBillet(main, view) {
  const bl = ui.bl;
  const save = (v) => {
    send("fix", { downtimeId: bl.downtimeId, index: bl.index, billet: v });
    showToast("Записано");
    go("shift");
  };
  const kids = [
    backBtn("К итогу смены", () => { showToast("Записано"); go("shift"); }),
    question("Сколько заготовки ушло в брак?"),
    h("div", { class: "tiles" },
      [0, 0.5, 1, 2, 5].map((v) =>
        h("button", { class: "tile", onclick: () => save(v) }, fmtTons(v))
      ),
      h("button", { class: "tile", onclick: () => { bl.custom = true; render(); } }, "Другое количество")
    ),
  ];
  if (bl.custom) {
    const input = h("input", { type: "number", min: "0", step: "0.1", inputmode: "decimal", placeholder: "тонны", "aria-label": "Заготовка в брак, тонны" });
    kids.push(
      input,
      h("button", {
        class: "btn primary",
        onclick: () => {
          const v = parseFloat(String(input.value).replace(",", "."));
          if (Number.isFinite(v) && v >= 0) save(v);
        },
      }, "Готово")
    );
  }
  fill(main, ...kids);
}

// Подтверждение сдачи, если есть простои без причины
function renderCloseConfirm(main, view) {
  const dts = shiftDowntimes(view);
  const noReason = dts.filter((d) => !d.reason);
  const n = noReason.length;
  fill(main,
    backBtn("К итогу смены", () => go("shift")),
    question(`У ${n} ${plural(n, "простоя", "простоев", "простоев")} нет причины`),
    h("button", {
      class: "btn primary",
      onclick: () => {
        const d = noReason[0];
        ui.wz = { mode: "shiftfix", downtimeId: d.downtimeId, index: d.indexLast, step: 1, group: null, reason: null, note: "" };
        go("reason");
      },
    }, "Указать сейчас"),
    h("button", { class: "btn", onclick: () => doCloseShift(view) }, "Сдать без причины")
  );
}

function doCloseShift(view) {
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const workMin = Math.max(0, Math.round((Math.min(nowMs(), view.shift.endMs) - view.shift.startMs) / 60000) - downMin);
  ui.closedInfo = { workMin, downMin, stops: shiftDowntimes(view).length };
  // Сначала переключаем экран: send() перерисует страницу, а «Итог смены» без бригады не рисуется
  ui.screen = "closed";
  send("shift_close");
}

// Экран «Смена сдана»
function renderClosed(main, view) {
  const info = ui.closedInfo;
  fill(main,
    question("Смена сдана"),
    info
      ? h("div", { class: "stats" },
          h("div", { class: "stat good" }, "Работа", h("span", { class: "v", text: fmtDurMin(info.workMin) })),
          h("div", { class: "stat bad" }, "Простои", h("span", { class: "v", text: `${info.stops} · ${fmtDurMin(info.downMin)}` }))
        )
      : null,
    h("button", { class: "btn primary", onclick: () => { ui.crewId = null; go("crew"); } }, "Принять новую смену")
  );
}

// --- Тики часов на экране ---
function tick() {
  const now = nowMs();
  for (const el of document.querySelectorAll("[data-since]")) {
    const since = Number(el.dataset.since);
    el.textContent = el.dataset.fmt === "dur" ? fmtDurMin((now - since) / 60000) : fmtTimer(now - since);
  }
  // Простой перевалил за 4 часа — перерисовать с плашкой
  if (serverState && refs && ui.screen === "auto") {
    const view = buildView();
    if (view && view.open && now - view.open.startMs > LONG_STOP_MS && !document.querySelector(".banner-warn")) {
      render();
    }
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

// --- Запуск ---
async function boot() {
  if (!key) { render(); return; }
  if (!refs) {
    const ok = await loadRefs();
    if (!ok && !refs) { render(); return; }
  }
  await loadState();
  render();
}

takeKeyFromHash();
key = readStore(STORE_KEY) || null;
loadCachedRefs();

// Демо-режим: имитация сервера в браузере. Включается на GitHub Pages
// (там сервера нет) или вручную параметром ?mock=1.
const DEMO = location.hostname.endsWith("github.io") || new URLSearchParams(location.search).has("mock");
if (DEMO) {
  const m = await import("./mock.js");
  api = m.api;
  if (!key) key = "demo"; // ключ устройства в демо не нужен
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* офлайн-установка недоступна */ });
}

requestWake();
setInterval(loadState, STATE_POLL_MS);
setInterval(flush, QUEUE_RETRY_MS);
setInterval(tick, 1000);
boot();
