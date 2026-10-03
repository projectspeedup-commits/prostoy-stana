// Страница рабочего: учёт простоев стана. Чистый ES-модуль, без сборки.
// Версия 2: пошаговые экраны, один вопрос — один экран.
import { deliverBatch, pruneRecords, settleRecords, readyEvents, rejectionGroups, transferFields, reusableRestart, downtimeKey, mergeRecords, mergeQueue, tapGuard, fullNameError } from "./queue.js";
import * as core from "./core/core.js";
import { zoneOf } from "./core/zones.js";
import { dayChart, donut } from "./charts.js";
import { dayCells } from "./core/zones.js";
import { dayScale } from "./timeline.js";
import { validateMailSettings, normalizeEmail, MAIL_WHAT_TITLE } from "./core/mail-settings.js";

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
    if (!r.ok || !data) throw Object.assign(new Error("http_" + r.status), { status: r.status, data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// --- Состояние клиента ---
let key = null;
let refs = null;          // справочники (кешируются)
let refsVersion = null;
let canAdmin = true;      // открыт ли этому ключу «Администратор» (сервер говорит в /api/refs)
const restored = readJSON(SESSION_KEY, {});
let serverState = restored.state || null;
let stateAt = restored.stateAt || null;
let queueStoredSeparately = restored.queueSeparated === true || !Array.isArray(restored.queue);
let queue = queueStoredSeparately ? loadQueue() : restored.queue;
let records = Array.isArray(restored.records) ? restored.records : [];
for (const event of queue) if (!records.some((r) => r.event.id === event.id)) {
  const receipt = restored.pendingReplacements?.find((r) => r.id === event.id);
  records.push({ ...receipt, event, status: "pending" });
}
let clockOffset = restored.clockOffset || 0;
let stateEpoch = 0;
let loadingState = false;
let online = false;
let flushing = false;
let shiftTimer = null;
let statsEpoch = 0;
let handlingStorage = false;
const taps = tapGuard();

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
const DRAFT_FIELDS = ["screen", "crewId", "crewBack", "wz", "mw", "rw", "fw", "closeReceipt", "af", "bl", "rec", "closedInfo", "card", "repair", "resume", "contactBack", "closeAction", "fio", "stopContext"];
for (const field of DRAFT_FIELDS) {
  if (restored.draft && Object.hasOwn(restored.draft, field)) ui[field] = restored.draft[field];
}
settleRejected();
function mergeStored() {
  if (!queueStoredSeparately) return;
  const saved = readJSON(SESSION_KEY, {});
  const diskQueue = loadQueue();
  const missing = diskQueue.filter((e) => !records.some((r) => r.event.id === e.id))
    .map((event) => ({ ...saved.pendingReplacements?.find((r) => r.id === event.id), event, status: "pending" }));
  records = mergeRecords(saved.records || [], missing, records);
  settleRejected();
  queue = mergeQueue(records, diskQueue, queue);
}
function persistClient() {
  mergeStored();
  // При обновлении старой версии сначала переносим очередь, потом убираем её из снимка.
  if (!queueStoredSeparately) {
    if (!writeStore(QUEUE_KEY, JSON.stringify(queue))) return false;
    queueStoredSeparately = true;
  }
  settleRejected();
  queue = mergeQueue(records, queue);
  if (JSON.stringify(loadQueue()) !== JSON.stringify(queue)) writeStore(QUEUE_KEY, JSON.stringify(queue));
  records = pruneRecords(records, nowMs());
  const draft = Object.fromEntries(DRAFT_FIELDS.map((field) => [field, ui[field]]));
  // Очередь имеет отдельную запись и не переписывается при каждом вводе текста.
  const savedRecords = records.filter((r) => r.status !== "pending");
  const pendingReplacements = records.filter((r) => r.status === "pending" && (r.replaces || r.rootAccepted || r.transfers)).map(({ event, status, ...r }) => ({ ...r, id: event.id }));
  const peer = handlingStorage ? readJSON(SESSION_KEY, {}) : null;
  const snapshot = (list) => JSON.stringify({ state: peer?.state || serverState, stateAt: peer?.stateAt || stateAt,
    records: list, pendingReplacements, clockOffset: peer?.clockOffset ?? clockOffset, draft: peer?.draft || draft, queueSeparated: true });
  if (writeStore(SESSION_KEY, snapshot(savedRecords))) return true;
  records = records.filter((r) => !["saved", "replaced", "adopted", "dismissed"].includes(r.status));
  return writeStore(SESSION_KEY, snapshot(records.filter((r) => r.status !== "pending")));
}
function acceptState(state, time) {
  if (!state) return;
  serverState = state;
  invalidateStats();
  stateAt = time || new Date(nowMs()).toISOString();
  updateClock(time);
  armShiftTimer();
  syncStopContext();
  settleRejected();
  persistClient();
}
// Отклонённая запись больше не нужна, если сервер уже принял то же самое другой отправкой:
// дошло исправление из той же цепочки или остановка с этим номером простоя уже записана.
// Иначе копии одной остановки висят карточками, а повторная отправка снова получает отказ.
function settleRejected() {
  const n = settleRecords(records, serverState);
  if (ui.repair && records.find((r) => r.event.id === ui.repair.id)?.status === "replaced") ui.repair = null;
  return n;
}

function loadQueue() {
  try {
    const q = JSON.parse(readStore(QUEUE_KEY));
    if (Array.isArray(q)) return q.filter((e) => e && typeof e.id === "string" && typeof e.type === "string");
  } catch { /* пусто или повреждено */ }
  return [];
}
function persistQueue() {
  mergeStored();
  const json = JSON.stringify(queue);
  let stored = writeStore(QUEUE_KEY, json);
  if (!stored) {
    // Сначала освобождаем место, занятое восстанавливаемым снимком, затем повторяем очередь.
    try { localStorage.removeItem(storageName(SESSION_KEY)); } catch { /* предупреждение уже видно */ }
    stored = writeStore(QUEUE_KEY, json);
  }
  if (stored) queueStoredSeparately = true;
  persistClient();
  return stored;
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
  mergeStored();
  invalidateStats();
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
  if (!["stop", "manual", "shift_open", "shift_close"].includes(type) && !e.onlyEmpty) {
    const gate = records.findLast((r) => downtimeKey(r.event) === downtimeKey(e) &&
      ["stop", "start", "manual"].includes(r.event.type) && ["pending", "rejected"].includes(r.status));
    if (gate) e.after = gate.event.id;
  }
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
    while (queue.length) {
      const ready = readyEvents(queue, records);
      if (!ready.length) break;
      const { batch, data: d } = await deliverBatch(api, ready);
      const saved = new Set(d.saved || []);
      const rejected = d.rejected || [];
      const rejectedIds = new Set(rejected.map((r) => r.id));
      for (const event of batch) {
        let record = records.find((r) => r.event.id === event.id);
        if (!record) records.push((record = { event, status: "pending" }));
        if (saved.has(event.id)) {
          record.status = "saved";
          record.confirmedAt = d.serverTime || new Date(nowMs()).toISOString();
          if (record.transfers) {
            for (const r of records) if (record.transfers.includes(r.event.id)) r.status = "replaced";
            queue = queue.filter((e) => !record.transfers.includes(e.id));
          }
          if (record.replaces) {
            const old = records.find((r) => r.event.id === record.replaces);
            if (old) old.status = "replaced";
          }
        }
        if (rejectedIds.has(event.id)) {
          record.status = "rejected";
          const rejection = rejected.find((r) => r.id === event.id);
          record.error = rejection?.error;
          record.conflict = rejection?.conflict || null;
          if (rejection?.error === "already_stopped" && rejection.downtimeId) {
            record.status = "adopted";
            record.adoptedDowntimeId = rejection.downtimeId;
            record.confirmedAt = d.serverTime || new Date(nowMs()).toISOString();
            if (ui.stopContext?.endsWith("|" + downtimeKey(event))) ui.stopContext = ui.stopContext.slice(0, ui.stopContext.lastIndexOf("|") + 1) + rejection.downtimeId;
            for (const e of queue) if (e.id !== event.id && e.downtimeId === (event.downtimeId || event.id)) e.downtimeId = rejection.downtimeId;
            for (const field of ["wz", "rw", "fw", "rec", "af", "bl"]) {
              if (ui[field]?.downtimeId === (event.downtimeId || event.id)) ui[field].downtimeId = rejection.downtimeId;
            }
            const current = d.state?.open?.segments?.at(-1);
            if (current?.reason) {
              for (const e of queue) if (e.downtimeId === rejection.downtimeId && ["reason", "split"].includes(e.type)) {
                const r = records.find((r) => r.event.id === e.id);
                if (r) { r.status = "rejected"; r.error = "fields_taken"; r.conflict = d.state.open; }
              }
              queue = queue.filter((e) => records.find((r) => r.event.id === e.id)?.status === "pending");
              ui.wz = null; ui.screen = "auto";
              showToast(`Причина уже указана с другого устройства: ${reasonLabel(current.reason)}`);
            } else showToast(`Стан уже остановлен с ${fmtClock(rejection.startMs ?? d.state?.open?.startMs)}`);
          }
        }
      }
      // Сначала снимок и квитанции, затем очередь; повтор того же ID безопасен.
      // Без нового состояния сохраняем очередь: повтор того же ID безопасен на сервере.
      if (d.state) {
        queue = queue.filter((e) => !saved.has(e.id) && !rejectedIds.has(e.id));
        acceptState(d.state, d.serverTime);
      } else {
        queue = queue.filter((e) => !rejectedIds.has(e.id));
        persistClient();
      }
      persistQueue();
      setOnline(true);
      if (!saved.size && !rejected.length) break;
      if (!d.state && saved.size) break; // подтверждение без снимка повторяем безопасно
    }
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
      canAdmin = d.canAdmin !== false;
      if (!canAdmin && ui.screen === "admin") ui.screen = "auto";
      writeStore(REFS_KEY, JSON.stringify({ refs, refsVersion, canAdmin }));
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
      canAdmin = c.canAdmin !== false;
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
    shift: refs ? core.shiftOf(nowMs(), refs.settings.schedule) : s.shift,
    dataFromMs: s.dataFromMs ?? null,
    runningSinceMs: s.runningSinceMs ?? null,
    segments: (s.segments || []).filter((x) => !open || x.downtimeId !== open.downtimeId || x.index !== open.index).map((x) => ({ ...x })),
  };
  if (v.shift.startMs !== s.shift.startMs) { v.crew = null; v.closed = false; }
  for (const e of readyEvents(queue, records, true)) applyEvent(v, e);
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
          for (const field of ["reason", "billet", "note", "action"]) {
            if (e[field] !== undefined && (!e.onlyEmpty || core.emptyField(s[field]))) s[field] = e[field];
          }
        }
      }
      if (v.open && v.open.downtimeId === e.downtimeId && v.open.index === e.index) {
        for (const field of ["reason", "billet", "note", "action"]) {
          if (e[field] !== undefined && (!e.onlyEmpty || core.emptyField(v.open[field]))) v.open[field] = e[field];
        }
      }
      break;
    case "shift_open":
      if (t < v.shift.startMs || t >= v.shift.endMs) break;
      v.crew = { crewId: e.crewId, personId: e.personId, personName: e.personName ?? null, at: e.at };
      v.closed = false;
      break;
    case "shift_close":
      if (v.open && t >= (v.open.since ?? v.open.startMs) &&
          !(v.open.handovers || []).some((x) => x.at === e.at && x.crewId === (e.crewId ?? null))) {
        v.open.handovers = [...(v.open.handovers || []),
          { at: e.at, crewId: e.crewId ?? null, personId: e.personId ?? null, personName: e.personName ?? null, action: e.action ?? null, note: e.note ?? null }];
      }
      if (t < v.shift.startMs || t >= v.shift.endMs || (v.crew && core.toMs(v.crew.at) > t)) break;
      v.crew = null;
      v.closed = true;
      break;
  }
}

// --- Сводка текущей смены по видимым отрезкам ---
function shiftSummary(view) {
  const shift = view.shift;
  const segs = [];
  for (const s of view.segments) {
    const startMs = Math.max(s.startMs, shift.startMs);
    const endMs = Math.min(s.open || s.endMs === null ? nowMs() : s.endMs, shift.endMs, nowMs());
    if (endMs > startMs) segs.push({ ...s, startMs, endMs });
  }
  if (view.open) {
    const startMs = Math.max(view.open.startMs, shift.startMs);
    const endMs = Math.min(nowMs(), shift.endMs);
    if (endMs > startMs) {
      segs.push({ downtimeId: view.open.downtimeId, index: view.open.index, startMs, endMs, durationMs: nowMs() - (view.open.since ?? view.open.startMs), reason: view.open.reason, manual: false, open: true });
    }
  }
  return core.summarizeShift(segs, shift, refs, nowMs(), view.dataFromMs);
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
      minutes: Math.round(g.segs.reduce((a, s) => a + Math.max(0, Math.min(s.open || s.endMs === null ? nowMs() : s.endMs, shift.endMs, nowMs()) - Math.max(s.startMs, shift.startMs)), 0) / 60000),
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
function fmtDateLong(ms) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "2-digit", month: "long",
  }).format(ms);
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
  const downMin = sum.downMinutes;
  const workMin = shiftWorkMin(view, downMin);
  const stops = sum.stops;
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
  return String(v).replace(".", ",") + " тн";
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

// Единые контурные иконки: SVG строится через DOM, без inline-кода и стилей.
function icon(name) {
  const paths = {
    pulse: "M2 12h5l3-8 4 16 3-8h5",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
    helmet: "M4 11a8 8 0 0 1 16 0M3 11h18M9 3v5M15 3v5M7 12v2a5 5 0 0 0 10 0v-2M3 22v-2c0-2 4-3 6-3l3 3 3-3c2 0 6 1 6 3v2",
    check: "m5 12 4 4L19 6M20 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10",
    bars: "M4 20V10h3v10M10.5 20V4h3v16M17 20V8h3v12M2 20h20",
    chart: "M3 3v18h18M6 16l4-5 4 2 6-8",
    info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7v.1",
    chevron: "m9 5 7 7-7 7",
    sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 1v2M12 21v2M1 12h2M21 12h2M4 4l1.5 1.5M18.5 18.5 20 20M4 20l1.5-1.5M18.5 5.5 20 4",
    moon: "M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z",
    calendar: "M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM7 2v4M17 2v4M3 9h18M7 13h3M14 13h3M7 17h3",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
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
  t.className = "toast" + (/Укажите|Проверьте|Напишите|Нет |Не |не принят|не сохран|уже |Ошибка/i.test(text) ? " warning" : "");
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
  conn.querySelector(".pill-text").textContent = "Связаться";
  const status = $("save-status");
  if (status) {
    const rejected = rejectionGroups(records).length;
    status.className = "save-status " + (!online ? "offline" : storageErrors.size || rejected || queue.length ? "waiting" : "online");
    const statusText = storageErrors.size
      ? "На планшете не сохранено. Не закрывайте страницу. Освободите память и повторите сохранение."
      : rejected ? `Нужно исправить: ${rejected} — показать`
      : queue.length ? `Сохранено на планшете · ждут отправки: ${queue.length}`
      : ui.screen === "closeConfirm" ? "Закрытие смены ещё не отправлено"
      : online ? (records.some((r) => r.status === "saved") ? "Принято сервером" : "Связь с сервером есть")
      : stateAt ? `Без сети · последние данные: ${fmtDate(core.toMs(stateAt))}, ${fmtClock(core.toMs(stateAt))} МСК`
      : "Нет связи с сервером";
    status.replaceChildren(h("span", { class: "save-status-text", text: statusText }),
      h("span", { class: "save-status-count", text: String(rejected || queue.length || 0), "aria-hidden": "true" }));
    status.title = statusText;
    status.setAttribute("aria-label", statusText);
    status.setAttribute("aria-expanded", String(!!ui.rejectsOpen));
    if (!status.dataset.bound) {
      status.dataset.bound = "1";
      status.addEventListener("click", () => { ui.rejectsOpen = !ui.rejectsOpen; renderRejects(); renderTopbar(); });
    }
    status.hidden = !key;
  }
  // Главная страница не уничтожает ответы незаконченного шага.
  const home = $("demo");
  if (!home.dataset.bound) {
    home.dataset.bound = "1";
    home.addEventListener("click", () => {
      if (isDraftScreen(ui.screen)) ui.resume = ui.screen;
      // Приём смены начинается заново: иначе главный экран снова открывал выбор мастера
      ui.crewId = null;
      ui.fio = null;
      ui.crewBack = false;
      window.scrollTo(0, 0);
      go("auto");
    });
  }
  home.hidden = !key;
  // Раздел администратора: смены, мастера, номера для «Связаться». Пароля пока нет (решение владельца)
  const admin = $("admin");
  if (admin) {
    if (!admin.dataset.bound) {
      admin.dataset.bound = "1";
      admin.addEventListener("click", () => {
        if (!key || !refs || !canAdmin) return;
        if (ui.screen !== "admin") ui.adminBack = ui.screen;
        ui.admin = null;
        window.scrollTo(0, 0);
        go("admin");
      });
    }
    admin.hidden = !key || !canAdmin;
    admin.classList.toggle("is-on", ui.screen === "admin");
  }
}

function renderRejects() {
  const box = $("rejects");
  const rejected = rejectionGroups(records);
  if (!rejected.length && !storageErrors.size && !ui.rejectsOpen) {
    box.hidden = true;
    fill(box, );
    return;
  }
  box.hidden = false;
  box.className = "rejects" + (ui.rejectsOpen ? " is-open" : "");
  fill(box,
    h("div", { class: "rejects-heading" }, h("strong", { text: `Нужно исправить: ${rejected.length}` }),
      h("button", { class: "btn", onclick: () => { ui.rejectsOpen = false; renderRejects(); renderTopbar(); } }, "Закрыть список")),
    !rejected.length ? h("p", { text: queue.length ? `Ждут отправки: ${queue.length}` : "Записей для исправления нет." }) : null,
    storageErrors.size ? h("button", { class: "btn", onclick: () => { persistQueue(); render(); } }, "Повторить сохранение на планшете") : null,
    rejected.length > 1 ? h("button", { class: "btn btn-flat", onclick: () => {
      const ids = rejected.map((g) => g.record.event.id);
      const token = ids.join("|");
      if (ui.dismissAllConfirm === token) { ui.dismissAllConfirm = null; dismissRejected(ids, true); }
      else { ui.dismissAllConfirm = token; renderRejects(); }
    } }, ui.dismissAllConfirm === rejected.map((g) => g.record.event.id).join("|")
      ? `Точно убрать ${rejected.length} записей?` : `Убрать все отклонённые записи (${rejected.length})`) : null,
    ...rejected.map((g) => { const r = g.record; return h("div", { class: "reject" },
      h("strong", { text: "Нужно исправить · " + eventTitle(r.event) }),
      h("p", { text: conflictMessage(g) }),
      savedAnswers(g),
      h("button", { class: "btn", onclick: () => {
        ui.repair = { id: r.event.id, event: { ...r.event }, back: ui.screen };
        ui.rejectsOpen = false;
        go("repair");
      } }, "Открыть сохранённую запись"),
      transferButton(g),
      h("button", { class: "btn btn-flat", onclick: () => dismissRejected([r.event.id]) }, "Убрать запись")); })
  );
}

function groupFor(id) { return rejectionGroups(records).find((g) => g.records.some((r) => r.event.id === id)); }
function conflictTarget(g) {
  const known = [...(serverState?.day?.segments || []), ...(serverState?.segments || []), ...(serverState?.open?.segments || [])];
  const id = g.record.conflict?.downtimeId || g.key;
  const all = known.filter((s) => s.downtimeId === id);
  if (all.length) return { downtimeId: id, startMs: Math.min(...all.map((s) => s.startMs)),
    endMs: all.some((s) => s.open) ? null : Math.max(...all.map((s) => s.endMs)),
    segments: all.sort((a, b) => a.index - b.index) };
  return g.record.conflict || null;
}
function conflictMessage(g) {
  const target = conflictTarget(g);
  return g.record.event.type === "start" && target?.endMs != null
    ? `Стан уже пущен в ${fmtClock(target.endMs)} с другого устройства. Ваши ответы ждут решения.` : humanError(g.record.error);
}
function savedAnswers(g) {
  const f = g.fields;
  return h("div", { class: "saved-answers" },
    f.from ? h("p", { text: `Остановка: ${fmtDate(core.toMs(f.from))} ${fmtClock(core.toMs(f.from))}` }) : null,
    h("p", { text: `Причина: ${reasonLabel(f.reason) || "Не указана"}` }),
    h("p", { text: `Что случилось: ${f.note || "Не указано"}` }),
    f.to ? h("p", { text: `Пуск: ${fmtDate(core.toMs(f.to))} ${fmtClock(core.toMs(f.to))}` }) : null,
    h("p", { text: `Что сделали: ${f.action || "Не указано"}` }),
    h("p", { text: `Брак: ${f.billet == null ? "Не указан" : fmtTons(f.billet)}` }));
}
function transferButton(g) {
  const target = conflictTarget(g);
  if (!target || (!target.endMs && g.record.event.type !== "stop")) return null;
  const last = target.segments.at(-1);
  const fields = transferFields(g.fields, last);
  const names = { reason: "Причина", note: "Что случилось", action: "Что сделали", billet: "Брак" };
  const busy = Object.keys(names).filter((k) => !core.emptyField(last[k]));
  return h("div", { class: "transfer" },
    busy.map((k) => h("p", { text: `${names[k]} уже записано: ${k === "reason" ? reasonLabel(last[k]) : k === "billet" ? fmtTons(last[k]) : last[k]}. Это поле сохраним.` })),
    h("button", { class: "btn", disabled: !Object.keys(fields).length, onclick: () => {
      const fresh = conflictTarget(g).segments.at(-1);
      const payload = transferFields(g.fields, fresh);
      if (!Object.keys(payload).length) return render();
      const next = queueEvent("fix", { downtimeId: target.downtimeId, index: fresh.index, onlyEmpty: true, ...payload });
      const receipt = records.find((r) => r.event.id === next.id);
      receipt.groupId = g.key;
      receipt.transfers = g.records.filter((r) => ["pending", "rejected"].includes(r.status)).map((r) => r.event.id);
      persistQueue(); flush(); render();
    } }, g.record.event.type === "stop"
      ? `Перенести мою причину, брак и «что сделали» в простой ${fmtClock(target.startMs)}–${target.endMs ? fmtClock(target.endMs) : "сейчас"}`
      : "Добавить мою причину, брак и «что сделали» к этому простою"));
}
// Отклонённую запись, которая больше не нужна, убирают с планшета: она не показывается и не отправляется.
// На сервере её нет — он её не принял, поэтому убрать можно без следа в учёте
function dismissRejected(ids, confirmed = false) {
  const groups = rejectionGroups(records).filter((g) => g.records.some((r) => ids.includes(r.event.id)));
  const related = new Set(groups.flatMap((g) => g.records.filter((r) => ["pending", "rejected"].includes(r.status)).map((r) => r.event.id)));
  if (!confirmed && groups.some((g) => g.records.some((r) => r.event.type === "stop") && g.records.length > 1)) {
    ui.rejectsOpen = false;
    ui.dismissPendingIds = ids;
    ui.dismissBack = ui.screen;
    return go("dismissConfirm");
  }
  if (ui.screen === "dismissConfirm") ui.screen = ui.dismissBack || "auto";
  let n = 0;
  for (const r of records) if (related.has(r.event.id)) { r.status = "dismissed"; r.confirmedAt = new Date(nowMs()).toISOString(); n += 1; }
  queue = queue.filter((e) => !related.has(e.id));
  if (ui.repair && ids.includes(ui.repair.id)) ui.repair = null;
  persistQueue();
  showToast(n === 1 ? "Запись убрана" : `Убрано записей: ${n}`);
  render();
}

function humanError(code) {
  const messages = {
    overlap: "Остановка пересекается с записанным простоем или указана раньше последнего пуска. Проверьте время или дополните запись в итоге смены.",
    bad_time: "Дата должна быть не старше 40 суток, длительность ручного простоя — не больше 7 суток. Пуск не может быть раньше остановки или смены причины. Проверьте время записи.",
    not_found: "Простой или его отрезок не найден. Ответы ждут исправления остановки.",
    fields_taken: "Причина уже указана с другого устройства. Сравните ответы и перенесите только пустые поля либо уберите свою запись.",
    not_open: "Нет открытого простоя для этого пуска. Обновите состояние стана.",
    too_large: "Запись слишком большая. Сократите текст и повторите отправку.",
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
  const active = list.filter((r) => !["dismissed", "replaced"].includes(r.status));
  if (list.length && !active.length) return list.some((r) => r.status === "dismissed") ? "Запись убрана с планшета" : "Запись заменена";
  list = active;
  if (list.some((r) => r.status === "rejected")) return "Нужно исправить";
  if (!list.length || list.some((r) => r.status === "pending")) {
    return storageErrors.has(QUEUE_KEY) ? "На планшете не сохранено" : "Сохранено на планшете";
  }
  return "Принято сервером";
}
function receiptFor(downtimeId) {
  return records.filter((r) => r.status !== "replaced" && r.status !== "dismissed" && (r.event.downtimeId || r.event.id) === downtimeId);
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

function resetStopDrafts() {
  ui.rw = ui.wz = ui.fw = null;
  ui.resume = null;
}
function newRestart(view) {
  return { downtimeId: view.open.downtimeId, index: view.open.index,
    startMs: nowMs(), createdMs: nowMs(), shiftStartMs: view.shift.startMs,
    reason: view.open.reason, note: view.open.note, action: view.open.action ?? "",
    reasonChanged: false, hadReason: !!view.open.reason };
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
function syncStopContext() {
  const current = buildView();
  if (current) {
    const context = `${current.shift.startMs}|${current.crew?.at || ""}|${current.closed}|${current.open?.downtimeId || ""}`;
    if (ui.stopContext && ui.stopContext !== context) {
      resetStopDrafts();
      if (["reason", "confirmChange", "restartTime", "restartAction", "restartConfirm", "forgotStop"].includes(ui.screen) && !ui.repair) ui.screen = "auto";
    }
    ui.stopContext = context;
  }
}
function needCrewSafe(view) { return view && refs ? needCrew(view) : false; }
function render() {
  syncStopContext();
  renderScreen();
  const view = buildView();
  taps.screen(JSON.stringify([ui.screen, ui.crewId, ui.confirmCrew, !!ui.fio, ui.wz?.step, ui.mw?.step, ui.fw?.step,
    !!view?.open, needCrewSafe(view), $("main").querySelector("h1")?.textContent]));
  // На первом шаге причины выход уже есть: «Назад». Вторая кнопка лишняя
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
    case "dismissConfirm": return fill(main, question("Убрать остановку вместе с причиной, пуском и браком? В учёт они не попадут"),
      h("button", { class: "btn", onclick: () => go(ui.dismissBack || "auto") }, "Оставить запись"),
      h("button", { class: "btn warn-btn", onclick: () => dismissRejected(ui.dismissPendingIds, true) }, "Убрать вместе с ответами"));
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
    case "admin": return renderAdmin(main, view);
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
  // Первая плитка звонит мастеру, который принял смену, — по телефону из раздела «Администратор»
  const master = view.crew && (refs.people || []).find((p) => p.id === view.crew.personId);
  const masterTile = { title: master ? `Мастер смены · ${master.name}` : "Мастер смены", tel: (master && master.phone) || "" };
  const list = [masterTile, ...((refs.settings && refs.settings.contacts) || DEFAULT_CONTACTS.slice(1))];
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
        ? h("a", { class: "tile", href: `tel:${c.tel.replace(/[^\d+]/g, "")}` }, c.title, h("span", { class: "t-code", text: c.tel }))
        : h("div", { class: "tile tile-off" }, c.title, h("span", { class: "t-code", text: "номер не задан" }))))
  );
}

// --- Раздел «Администратор»: время смен, мастера с телефонами, номера для «Связаться» ---
// Две смены закрывают сутки без промежутков: конец одной — начало другой. Шаг — 30 минут, как у шкалы суток
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${two(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);
const PHONE_RE = /^\+?[0-9 ()\-]{5,24}$/;
let adminReq = null;

function adminDraft(s) {
  const shifts = (s && s.schedule && s.schedule.shifts) || [];
  const startOf = (no) => (shifts.find((x) => x.no === no) || {}).start || (no === 1 ? "08:00" : "20:00");
  return {
    schedule: { shifts: [1, 2].map((no) => ({ no, start: startOf(no) })) },
    people: ((s && s.people) || []).map((p) => ({ id: p.id ?? null, name: p.name || "", crewId: String(p.crewId || "1"), phone: p.phone || "" })),
    contacts: ((s && s.contacts) || []).map((c) => ({ title: c.title || "", tel: c.tel || "" })),
  };
}
function loadAdmin() {
  if (adminReq) return;
  ui.admin = { loading: true };
  adminReq = api("/api/admin/settings")
    .then(async (d) => {
      ui.admin = { settings: adminDraft(d.settings), refsVersion: d.refsVersion };
      await loadAdminMail(ui.admin); // рассылка не должна ломать остальной раздел
    })
    .catch((err) => {
      if (err && err.status === 401) badKey();
      ui.admin = { loadError: err && err.status === 403 ? (err.data?.message || "Раздел «Администратор» открывается только ключом владельца.")
        : err && err.status === 404
        ? "Сервер ещё не умеет хранить настройки: его нужно обновить."
        : "Нет связи с сервером. Настройки открываются и сохраняются только при связи." };
    })
    .finally(() => { adminReq = null; if (ui.screen === "admin") render(); });
}

// --- «Рассылка на почту»: получатели и расписание (отдельное хранилище на сервере, GET/PUT /api/admin/mail)
const MAIL_DAYS = [[1, "Пн"], [2, "Вт"], [3, "Ср"], [4, "Чт"], [5, "Пт"], [6, "Сб"], [7, "Вс"]];
const MAIL_QUICK = [
  ["После каждой смены", [["08:05", "shift", [1, 2, 3, 4, 5, 6, 7]], ["20:05", "shift", [1, 2, 3, 4, 5, 6, 7]]]],
  ["Утром за сутки", [["08:10", "day", [1, 2, 3, 4, 5, 6, 7]]]],
  ["По понедельникам за неделю", [["08:15", "week", [1]]]],
];
function mailDraft(m) {
  return {
    recipients: ((m && m.recipients) || []).map((r) => ({
      id: r.id ?? null, name: r.name || "", email: r.email || "", enabled: r.enabled !== false,
      sends: (r.sends || []).map((x) => ({ time: x.time, what: x.what, days: [...(x.days || [1, 2, 3, 4, 5, 6, 7])] })),
    })),
  };
}
async function loadAdminMail(a) {
  try {
    const d = await api("/api/admin/mail");
    a.mail = mailDraft(d.mail);
    a.mailVersion = d.mailVersion;
    a.smtpConfigured = d.smtpConfigured !== false;
    a.envFallback = d.envFallback || 0;
  } catch (err) {
    if (err && err.status === 401) badKey();
    a.mail = null; // старый сервер без рассылки: раздел просто не показываем
    a.mailError = err && err.status && err.status !== 404 ? "Рассылку не удалось загрузить." : null;
  }
}
function mailPayload(a) {
  // Проверка тем же правилом, что на сервере; ошибка — по-русски
  return validateMailSettings({ recipients: a.mail.recipients.map(({ id, name, email, enabled, sends }) => ({ id, name, email, enabled, sends })) });
}
async function sendMailTest(r) {
  const test = r._test = { busy: true };
  render();
  const email = normalizeEmail(r.email);
  if (!email) { r._test = { ok: false, text: "Сначала впишите настоящий адрес почты." }; return render(); }
  try {
    const d = await api("/api/mail/test", { method: "POST", body: JSON.stringify({ email, what: r.sends[0]?.what || "shift" }) });
    r._test = { ok: true, text: d.message || `Пробное письмо отправлено на ${email}.` };
  } catch (err) {
    if (err && err.status === 401) badKey();
    r._test = { ok: false, text: (err && err.data && err.data.message) || "Нет связи с сервером. Пробное письмо не отправлено." };
  }
  void test;
  render();
}
const hmMin = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
const fmtLen = (min) => (min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min / 60} ч`);
function adminProblems(s) {
  const out = [];
  const [a, b] = s.schedule.shifts.map((x) => hmMin(x.start));
  const len1 = (b - a + 1440) % 1440;
  if (a === b) out.push("Смены не могут начинаться в одно время.");
  else if (len1 < 60 || 1440 - len1 < 60) out.push("Каждая смена должна длиться не меньше часа.");
  const phoneOk = (v) => !v.trim() || PHONE_RE.test(v.trim());
  s.people.forEach((p, i) => {
    if (p.name.trim().length < 3) out.push(`Мастер № ${i + 1}: впишите фамилию, имя и отчество.`);
    if (!phoneOk(p.phone)) out.push(`${p.name.trim() || `Мастер № ${i + 1}`}: в телефоне только цифры, «+», пробелы, скобки и дефис.`);
  });
  s.contacts.forEach((c, i) => {
    if (!c.title.trim()) out.push(`Номер № ${i + 1}: впишите, кому звонить.`);
    if (!phoneOk(c.tel)) out.push(`${c.title.trim() || `Номер № ${i + 1}`}: в телефоне только цифры, «+», пробелы, скобки и дефис.`);
  });
  return out;
}
async function saveAdmin() {
  const a = ui.admin;
  if (!a || !a.settings || a.saving) return;
  const s = a.settings;
  const problems = adminProblems(s);
  let mailOut = null;
  if (a.mail && a.mailDirty) {
    try { mailOut = mailPayload(a); } catch (e) { problems.push(e.message); }
  }
  if (problems.length) { a.error = problems; return render(); }
  a.saving = true;
  a.error = null;
  render();
  const settings = {
    schedule: { shifts: s.schedule.shifts.map(({ no, start }) => ({ no, start })) },
    people: s.people.map((p) => ({ id: p.id, name: p.name.trim().replace(/\s+/g, " "), crewId: p.crewId, phone: p.phone.trim() })),
    contacts: s.contacts.map((c) => ({ title: c.title.trim().replace(/\s+/g, " "), tel: c.tel.trim() })),
  };
  try {
    const d = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ settings, refsVersion: a.refsVersion }) });
    const keep = { mail: a.mail, mailVersion: a.mailVersion, smtpConfigured: a.smtpConfigured, envFallback: a.envFallback, mailDirty: a.mailDirty };
    ui.admin = { settings: adminDraft(d.settings), refsVersion: d.refsVersion, ...keep };
    if (mailOut) {
      try {
        const m = await api("/api/admin/mail", { method: "PUT", body: JSON.stringify({ mail: mailOut, mailVersion: a.mailVersion }) });
        Object.assign(ui.admin, { mail: mailDraft(m.mail), mailVersion: m.mailVersion, envFallback: m.envFallback || 0, mailDirty: false });
      } catch (err) {
        if (err && err.status === 401) badKey();
        ui.admin.error = ["Настройки сохранены, а рассылка нет: " + ((err && err.data && err.data.message) || "нет связи с сервером. Повторите, когда связь появится.")];
        render();
        return;
      }
    }
    showToast("Настройки сохранены");
    await loadRefs();
  } catch (err) {
    if (err && err.status === 401) badKey();
    a.saving = false;
    a.error = [(err && err.data && err.data.message) || (err && err.status
      ? "Сервер не принял настройки."
      : "Нет связи с сервером. Настройки не сохранены — повторите, когда связь появится.")];
  }
  render();
}
// --- «Спросить ИИ о работе стана»: разговор живёт только в памяти страницы (POST /api/admin/ai/ask)
const AI_EXAMPLES = ["Сколько стоял стан за эту неделю и почему?", "Какие причины простоев чаще всего в этом месяце?", "Сравни вчерашние сутки с позавчерашними", "Стан сейчас работает?"];
const aiUi = { status: null, statusReq: false, log: [], text: "", busy: false, error: "" };
function loadAiStatus() {
  if (aiUi.statusReq || aiUi.status) return;
  aiUi.statusReq = true;
  api("/api/admin/ai/status")
    .then((d) => { aiUi.status = d; })
    .catch((err) => {
      if (err && err.status === 401) badKey();
      aiUi.status = { unavailable: true }; // старый сервер без ИИ: карточку не показываем
    })
    .finally(() => { if (ui.screen === "admin") render(); });
}
async function askAi(question) {
  question = String(question || "").trim();
  if (!question || aiUi.busy) return;
  const history = aiUi.log.slice(-6).map((m) => ({ role: m.role, content: m.content }));
  aiUi.log.push({ role: "user", content: question });
  aiUi.text = ""; aiUi.error = ""; aiUi.busy = true;
  render();
  try {
    const d = await api("/api/admin/ai/ask", { method: "POST", body: JSON.stringify({ question, history }) });
    aiUi.log.push({ role: "assistant", content: String(d.answer || "") });
    if (aiUi.status && !aiUi.status.unavailable && Number.isFinite(d.costUsd)) aiUi.status.spentTodayUsd = Math.round(((aiUi.status.spentTodayUsd || 0) + d.costUsd) * 1e6) / 1e6;
  } catch (err) {
    if (err && err.status === 401) badKey();
    // Вопрос без ответа убираем из ленты и истории и возвращаем в поле — его можно отправить ещё раз
    aiUi.log.pop();
    aiUi.text = question;
    aiUi.error = (err && err.data && err.data.message) || "Нет связи с сервером. Повторите, когда связь появится.";
  }
  aiUi.busy = false;
  render();
}
function aiCard() {
  const st = aiUi.status;
  if (!st || st.unavailable) return null;
  const input = h("textarea", { class: "ai-input", maxlength: "1000", rows: "3", "aria-label": "Вопрос о работе стана", placeholder: "Например: почему вчера стоял стан?" });
  input.value = aiUi.text;
  input.addEventListener("input", () => { aiUi.text = input.value; });
  const usd = (n) => "$" + (Math.round(n * 1000) / 1000);
  return h("section", { class: "adm-card ai-card", "aria-label": "Спросить ИИ о работе стана" },
    h("h2", { text: "Спросить ИИ о работе стана" }),
    st.configured === false
      ? h("p", { class: "adm-banner", role: "status", text: "ИИ-консультант не настроен на сервере" })
      : h("p", { class: "muted adm-note", text: `Потрачено сегодня: ${usd(st.spentTodayUsd || 0)} из $${st.dailyUsd}` }),
    h("div", { class: "ai-log", role: "log", "aria-live": "polite" },
      aiUi.log.map((m) => h("div", { class: "ai-msg ai-" + m.role },
        h("span", { class: "ai-who", text: m.role === "user" ? "Вы" : "ИИ" }),
        h("p", { class: "ai-text", text: m.content })))),
    st.configured === false ? null : h("div", { class: "ai-examples", role: "group", "aria-label": "Примеры вопросов" },
      AI_EXAMPLES.map((q) => h("button", { type: "button", class: "btn btn-flat adm-chip", disabled: aiUi.busy, onclick: () => askAi(q) }, q))),
    aiUi.error ? h("p", { class: "error-text", role: "alert", text: aiUi.error }) : null,
    st.configured === false ? null : input,
    st.configured === false ? null : h("div", { class: "ai-actions" },
      h("button", { type: "button", class: "btn primary", disabled: aiUi.busy, onclick: () => askAi(aiUi.text) }, aiUi.busy ? "Думаю…" : "Спросить"),
      h("button", { type: "button", class: "btn btn-flat", disabled: aiUi.busy, onclick: () => { aiUi.log = []; aiUi.error = ""; aiUi.text = ""; render(); } }, "Новый разговор")));
}
function renderAdmin(main) {
  if (!canAdmin) return go("auto");
  const back = ui.adminBack && ui.adminBack !== "admin" ? ui.adminBack : "auto";
  const leave = () => {
    if (ui.admin && ui.admin.dirty && !ui.admin.leaveArmed) {
      ui.admin.leaveArmed = true;
      return showToast("Изменения не сохранены. Нажмите «Вернуться» ещё раз, чтобы выйти без сохранения");
    }
    ui.admin = null;
    go(back);
  };
  const head = [backBtn("Вернуться", leave), question("Администратор")];
  if (!ui.admin) loadAdmin();
  loadAiStatus();
  const a = ui.admin;
  if (a.loading) return fill(main, ...head, h("p", { class: "muted", text: "Загружаем настройки…" }));
  if (a.loadError) {
    return fill(main, ...head, h("p", { class: "error-text", text: a.loadError }),
      h("button", { class: "btn", onclick: () => { ui.admin = null; render(); } }, "Повторить"));
  }
  const s = a.settings;
  const touch = () => { a.dirty = true; a.leaveArmed = false; };
  // Поля пишут прямо в черновик и не перерисовывают экран — иначе пропадёт курсор
  const txt = (value, attrs, set) => {
    const el = h("input", { type: "text", autocomplete: "off", ...attrs });
    el.value = value;
    el.addEventListener("input", () => { set(el.value); touch(); });
    return el;
  };
  const sel = (value, label, options, set) => {
    const el = h("select", { "aria-label": label }, options.map(([v, t]) => h("option", { value: v, text: t })));
    el.value = value;
    el.addEventListener("change", () => { set(el.value); touch(); render(); });
    return el;
  };
  const field = (label, control, cls) => h("label", { class: "adm-field" + (cls ? " " + cls : "") }, h("span", { text: label }), control);
  const times = HALF_HOURS.map((t) => [t, t]);

  const [s1, s2] = s.schedule.shifts;
  const len1 = (hmMin(s2.start) - hmMin(s1.start) + 1440) % 1440;
  const shiftRow = (sh, other, len) => h("div", { class: "adm-shift" },
    h("div", { class: "adm-shift-name" }, icon(sh.no === 1 ? "sun" : "moon"),
      h("strong", { text: `Смена ${sh.no}` }), h("span", { class: "muted", text: len ? fmtLen(len) : "" })),
    field("Начало", sel(sh.start, `Смена ${sh.no}, начало`, times, (v) => { sh.start = v; })),
    field("Конец", sel(other.start, `Смена ${sh.no}, конец`, times, (v) => { other.start = v; })));

  const crewOptions = [["1", "Смена 1"], ["2", "Смена 2"]];
  const personRow = (p) => h("div", { class: "adm-row" },
    field("Фамилия, имя, отчество", txt(p.name, { maxlength: "120", autocapitalize: "words", spellcheck: "false" }, (v) => { p.name = v; }), "adm-grow"),
    field("Смена", sel(p.crewId, "Смена мастера", crewOptions, (v) => { p.crewId = v; })),
    field("Телефон", txt(p.phone, { type: "tel", inputmode: "tel", maxlength: "24", placeholder: "+7 900 000-00-00" }, (v) => { p.phone = v; })),
    h("button", { class: "btn btn-flat adm-del", "aria-label": `Убрать мастера ${p.name}`.trim(), onclick: () => {
      s.people.splice(s.people.indexOf(p), 1); touch(); render();
    } }, "Убрать"));
  const crewGroup = (crewId) => {
    const own = s.people.filter((p) => p.crewId === crewId);
    return h("div", { class: "adm-group" },
      h("h3", { class: "adm-group-title", text: `Смена ${crewId}` }),
      own.length ? own.map(personRow) : h("p", { class: "muted", text: "Мастеров нет." }),
      h("button", { class: "btn adm-add", onclick: () => {
        s.people.push({ id: null, name: "", crewId, phone: "" }); touch(); render();
        const names = main.querySelectorAll(".adm-group")[Number(crewId) - 1]?.querySelectorAll('input[maxlength="120"]');
        names?.[names.length - 1]?.focus();
      } }, `Добавить мастера в смену ${crewId}`));
  };
  const contactRow = (c) => h("div", { class: "adm-row" },
    field("Кому звонить", txt(c.title, { maxlength: "60", placeholder: "Например: дежурный механик" }, (v) => { c.title = v; }), "adm-grow"),
    field("Телефон", txt(c.tel, { type: "tel", inputmode: "tel", maxlength: "24", placeholder: "+7 900 000-00-00" }, (v) => { c.tel = v; })),
    h("button", { class: "btn btn-flat adm-del", "aria-label": `Убрать номер ${c.title}`.trim(), onclick: () => {
      s.contacts.splice(s.contacts.indexOf(c), 1); touch(); render();
    } }, "Убрать"));


  // --- Рассылка на почту
  const mailTouch = () => { a.mailDirty = true; touch(); };
  const addSends = (r, preset) => {
    for (const [time, what, days] of preset) {
      if (r.sends.length >= 10) break;
      if (!r.sends.some((x) => x.time === time && x.what === what)) r.sends.push({ time, what, days: [...days] });
    }
    mailTouch(); render();
  };
  const sendRow = (r, x) => h("div", { class: "adm-send" },
    h("div", { class: "adm-send-main" },
      field("В", (() => {
        const el = h("input", { type: "time", step: "60", required: true, "aria-label": "Время отправки, московское" });
        el.value = x.time;
        el.addEventListener("input", () => { x.time = el.value; mailTouch(); });
        return el;
      })()),
      field("Что слать", sel(x.what, "Что слать", Object.entries(MAIL_WHAT_TITLE), (v) => { x.what = v; mailTouch(); }), "adm-grow")),
    h("div", { class: "adm-days", role: "group", "aria-label": "Дни недели" },
      MAIL_DAYS.map(([n, label]) => h("button", {
        type: "button", class: "adm-day" + (x.days.includes(n) ? " is-on" : ""), "aria-pressed": x.days.includes(n) ? "true" : "false",
        onclick: () => { x.days = x.days.includes(n) ? x.days.filter((d) => d !== n) : [...x.days, n].sort((p, q) => p - q); mailTouch(); render(); },
      }, label))),
    h("button", { type: "button", class: "btn btn-flat adm-del", "aria-label": "Убрать отправку", onclick: () => {
      r.sends.splice(r.sends.indexOf(x), 1); mailTouch(); render();
    } }, "Убрать"));
  const recipientCard = (r) => {
    const name = txt(r.name, { maxlength: "80", placeholder: "Например: Иванов И. И.", autocapitalize: "words" }, (v) => { r.name = v; mailTouch(); });
    const email = txt(r.email, { type: "email", inputmode: "email", maxlength: "120", placeholder: "master@example.ru", autocapitalize: "none", spellcheck: "false" }, (v) => { r.email = v; mailTouch(); });
    const on = h("button", { type: "button", class: "adm-switch" + (r.enabled ? " is-on" : ""), role: "switch", "aria-checked": r.enabled ? "true" : "false",
      onclick: () => { r.enabled = !r.enabled; mailTouch(); render(); } }, h("span", { class: "adm-switch-knob" }), h("span", { text: r.enabled ? "Включён" : "Выключен" }));
    const t = r._test;
    return h("div", { class: "adm-mail-card" + (r.enabled ? "" : " is-off") },
      h("div", { class: "adm-row adm-mail-head" }, field("Имя", name, "adm-grow"), field("Адрес почты", email, "adm-grow"), on),
      h("div", { class: "adm-sends" },
        r.sends.length ? r.sends.map((x) => sendRow(r, x)) : h("p", { class: "muted", text: "Отправок нет: этому получателю ничего не придёт." }),
        r.sends.length < 10 ? h("button", { type: "button", class: "btn adm-add", onclick: () => { r.sends.push({ time: "08:05", what: "shift", days: [1, 2, 3, 4, 5, 6, 7] }); mailTouch(); render(); } }, "Добавить отправку") : null),
      h("div", { class: "adm-quick", role: "group", "aria-label": "Быстрый выбор" },
        MAIL_QUICK.map(([title, preset]) => h("button", { type: "button", class: "btn btn-flat adm-chip", onclick: () => addSends(r, preset) }, title))),
      h("div", { class: "adm-mail-foot" },
        h("button", { type: "button", class: "btn adm-add", disabled: !!(t && t.busy), onclick: () => sendMailTest(r) }, t && t.busy ? "Отправляем…" : "Отправить пробное письмо"),
        r._confirmDel
          ? h("div", { class: "adm-confirm", role: "alert" }, h("span", { text: "Удалить получателя?" }),
            h("button", { type: "button", class: "btn adm-del", onclick: () => { a.mail.recipients.splice(a.mail.recipients.indexOf(r), 1); mailTouch(); render(); } }, "Да, удалить"),
            h("button", { type: "button", class: "btn btn-flat adm-del", onclick: () => { r._confirmDel = false; render(); } }, "Отмена"))
          : h("button", { type: "button", class: "btn btn-flat adm-del", onclick: () => { r._confirmDel = true; render(); } }, "Удалить получателя")),
      t && !t.busy && t.text ? h("p", { class: t.ok ? "adm-test-ok" : "error-text", role: "status", text: t.text }) : null);
  };
  const mailSection = a.mail ? h("section", { class: "adm-card", "aria-label": "Рассылка на почту" },
    h("h2", { text: "Рассылка на почту" }),
    a.smtpConfigured === false ? h("p", { class: "adm-banner", role: "status", text: "Отправка почты не настроена на сервере. Список можно править, но письма не уйдут." }) : null,
    a.envFallback && !a.mail.recipients.length ? h("p", { class: "muted adm-note", text: `Пока список пуст, письма о смене уходят на адреса из настроек сервера (${a.envFallback}).` }) : null,
    h("p", { class: "muted adm-note", text: "Время — московское. Письмо о смене приходит после её окончания: дневная заканчивается в 20:00, ночная в 08:00" }),
    a.mail.recipients.length ? a.mail.recipients.map(recipientCard) : h("p", { class: "muted", text: "Получателей нет." }),
    a.mail.recipients.length < 30 ? h("button", { type: "button", class: "btn adm-add", onclick: () => {
      a.mail.recipients.push({ id: null, name: "", email: "", enabled: true, sends: [{ time: "08:05", what: "shift", days: [1, 2, 3, 4, 5, 6, 7] }] });
      mailTouch(); render();
    } }, "Добавить получателя") : null) : (a.mailError ? h("p", { class: "error-text", text: a.mailError }) : null);

  fill(main, ...head,
    h("p", { class: "muted", text: "Изменения вступают в силу после «Сохранить» — сразу на всех планшетах." }),
    h("section", { class: "adm-card", "aria-label": "Время смен" },
      h("h2", { text: "Время смен" }),
      shiftRow(s1, s2, len1), shiftRow(s2, s1, len1 ? 1440 - len1 : 0),
      h("p", { class: "muted adm-note", text: "Конец одной смены — это начало другой: две смены закрывают сутки без промежутков. Время меняйте между сменами — по нему считаются отчёты." })),
    h("section", { class: "adm-card", "aria-label": "Мастера смен" },
      h("h2", { text: "Мастера смен" }),
      crewGroup("1"), crewGroup("2")),
    h("section", { class: "adm-card", "aria-label": "Номера для «Связаться»" },
      h("h2", { text: "Номера для «Связаться»" }),
      h("p", { class: "muted adm-note", text: "Первая кнопка на экране «Связаться» сама звонит мастеру, который принял смену, — по его телефону выше. Здесь — остальные номера." }),
      s.contacts.length ? s.contacts.map(contactRow) : h("p", { class: "muted", text: "Номеров нет." }),
      s.contacts.length < 12 ? h("button", { class: "btn adm-add", onclick: () => { s.contacts.push({ title: "", tel: "" }); touch(); render(); } }, "Добавить номер") : null),
    mailSection,
    aiCard(),
    a.error ? h("div", { class: "adm-errors", role: "alert" }, a.error.map((t) => h("p", { class: "error-text", text: t }))) : null,
    h("div", { class: "adm-actions" },
      h("button", { class: "btn primary", disabled: a.saving, onclick: saveAdmin }, a.saving ? "Сохраняем…" : "Сохранить"),
      a.dirty ? h("button", { class: "btn btn-flat", onclick: () => { ui.admin = null; render(); } }, "Отменить изменения") : null));
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
  resetStopDrafts();
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
  const cap = (v) => String(v || "").trim().replace(/\s+/g, " ").replace(/(^|[ -])([\p{Script=Cyrillic}a-z])/gu, (m, p, c) => p + c.toUpperCase());
  const error = h("p", { class: "error-text", text: "Впишите фамилию, имя и отчество полностью, без сокращений." });
  error.hidden = true;
  const submit = h("button", { class: "btn primary", onclick: () => {
    const problem = fullNameError(fields.map(([k]) => fio[k] || ""));
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    acceptShift(fio.crewId, fio.personId, fields.map(([k]) => cap(fio[k])).join(" "));
  } }, "Принять смену");
  const update = () => { const problem = fullNameError(fields.map(([k]) => fio[k] || "")); error.textContent = problem; error.hidden = !problem; submit.disabled = !!problem; };
  const inputs = fields.map(([k, label]) => {
    const input = h("input", { type: "text", id: `fio-${k}`, autocomplete: "off", autocapitalize: "words", spellcheck: "false", maxlength: "120" });
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

function crewHours(id) {
  const shifts = refs.settings.schedule.shifts;
  const i = shifts.findIndex((s) => String(s.no) === String(id));
  return i < 0 ? "" : `${shifts[i].start}–${shifts[(i + 1) % shifts.length].start}`;
}

function renderCrew(main, view) {
  if (ui.fio) return renderFio(main, view);
  const crews = refs.crews || [];
  const single = crews.length === 1 ? crews[0].id : null;
  const chosen = ui.crewId || single;
  const kids = [];
  if (ui.confirmCrew) {
    const current = core.shiftOf(nowMs(), refs.settings.schedule);
    return fill(main, question(`Сейчас идёт Смена ${current.shiftNo} (${fmtClock(current.startMs)}–${fmtClock(current.endMs)}). Принять Смену ${ui.confirmCrew}?`),
      h("button", { class: "btn primary", onclick: () => { ui.crewId = ui.confirmCrew; ui.confirmCrew = null; render(); } }, "Принять выбранную смену"),
      h("button", { class: "btn", onclick: () => { ui.confirmCrew = null; render(); } }, "Вернуться к выбору"));
  }
  if (!chosen) {
    if (ui.crewBack) kids.push(backBtn("На главный экран", () => { ui.crewBack = false; go("auto"); }));
    kids.push(board(view), stepLine(1, 2), question("Выберите вашу смену"),
      h("p", { class: "muted", text: `Сейчас: ${periodLabel(view.shift)}` }));
    kids.push(h("div", { class: "tiles" },
      crews.map((c) => h("button", { class: "tile" + (String(c.id) === String(view.shift.shiftNo) ? " current-shift" : ""),
        "aria-current": String(c.id) === String(view.shift.shiftNo) ? "true" : null,
        onclick: () => {
          if (String(c.id) !== String(core.shiftOf(nowMs(), refs.settings.schedule).shiftNo)) ui.confirmCrew = c.id;
          else ui.crewId = c.id;
          render();
        } }, c.title, String(c.id) === String(view.shift.shiftNo) ? " · сейчас" : ""))
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
      h("p", { class: "muted", text: `${crewTitle(chosen)} · по расписанию ${crewHours(chosen)}` }),
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
    const schedule = refs.settings.schedule;
    const first = view.shift.shiftNo === 1 ? view.shift : core.shiftOf(shiftFrom - 1, schedule);
    const fromMs = serverState?.day?.fromMs ?? first.startMs;
    // Смены этих суток по расписанию: заголовки шкалы ставятся по их началу, а не по 08:00 и 20:00
    const dayShifts = [];
    for (let t = fromMs; t < fromMs + 24 * HOUR && dayShifts.length < 4;) {
      const sh = core.shiftOf(t, schedule);
      dayShifts.push({ no: sh.shiftNo, startMs: sh.startMs, endMs: sh.endMs });
      t = sh.endMs;
    }
    const endOf = (s) => (s.open || s.endMs == null ? now : s.endMs);
    const earlier = (serverState?.day?.segments || [])
      .filter((s) => s.startMs < shiftFrom)
      .map((s) => ({ startMs: s.startMs, endMs: Math.min(endOf(s), shiftFrom), reason: s.reason ?? null }));
    const current = view.segments.map((s) => ({ startMs: Math.max(s.startMs, shiftFrom), endMs: endOf(s), reason: s.reason ?? null }));
    if (view.open) current.push({ startMs: Math.max(view.open.startMs, shiftFrom), endMs: now, reason: view.open.reason ?? null });
    const cells = dayCells([...earlier, ...current], { fromMs, toMs: fromMs + 24 * HOUR, nowMs: now, dataFromMs: view.dataFromMs, refs });
    return dayScale({ cells, nowMs: now, shiftFromMs: shiftFrom, shiftToMs: view.shift.endMs, shifts: dayShifts, fmtClock, fmtDate: () => fmtDate(fromMs), icon });
  } catch (e) {
    console.error("Шкала суток:", e);
    return null;
  }
}
// Главный экран: шкала слева (на узком экране — под кнопками), справа всё остальное
function withScale(view, ...kids) {
  return h("div", { class: "with-scale" }, scaleFor(view), h("div", { class: "with-scale__main" }, ...kids));
}

// «Отчёт в Excel» подключается отдельно: если файл не загрузится, пульт работает как раньше
let reportMenu = () => null;
import("./report-ui.js").then((m) => {
  reportMenu = m.createReportMenu({ h, nowMs, demo: DEMO, toast: showToast, getKey: () => key, getApi: () => api,
    getSchedule: () => refs?.settings?.schedule });
  softRender();
}).catch(() => { /* кнопки отчёта не будет */ });

// Пульт стана: две одинаковые кнопки, как на станке. Горит та, что совпадает с состоянием стана
function millPanel({ running, info, subtitle, hint, onGo, onStop }) {
  const btn = (kind, on, label, onclick) => h("button", {
    class: `mill-btn mill-${kind}${on ? " is-on" : ""}`,
    "aria-pressed": on ? "true" : "false",
    "aria-label": "СТАН " + label,
    onclick: on ? () => showToast(running ? "Стан уже работает" : "Стан уже стоит") : onclick,
  }, h("span", { class: "mill-lamp", "aria-hidden": "true" }),
    h("span", { class: "mill-label" }, h("span", { text: "СТАН" }), h("span", { text: label })));
  return h("div", { class: "mill-console" },
    h("div", { class: "mill-status " + (running ? "is-run" : "is-stop") },
      h("div", { class: "mill-state" }, icon("pulse"),
        h("div", null, h("div", { class: "mill-state-title" }, running ? "Стан работает · " : "Стан стоит · ", info),
          subtitle ? h("p", { class: "mill-subtitle", text: subtitle }) : null)),
      reportMenu(),
      h("div", { class: "mill-clock" }, icon("clock"),
        h("div", null, h("span", { "data-msk": "1", text: fmtClock(nowMs()) + " МСК" }),
          h("p", { class: "mill-subtitle", text: fmtDateLong(nowMs()) })))),
    h("div", { class: "mill-panel" },
      btn("go", running, "РАБОТАЕТ", onGo),
      btn("stop", !running, "ОСТАНОВЛЕН", onStop),
      hint ? h("p", { class: "mill-hint" }, icon("info"), h("span", { text: hint })) : null));
}

// Главный экран: стан работает
function renderRun(main, view) {
  const dts = shiftDowntimes(view);
  // С последнего пуска, даже если он был в прошлую смену; до первой записи о стане ничего не известно
  const lastStart = Math.min(nowMs(), runningSince(view));
  fill(main, withScale(view,
    millPanel({
      running: true,
      info: h("span", { class: "mill-info", dataset: { since: String(lastStart), fmt: "durs" } }, fmtDurSec((nowMs() - lastStart) / 1000)),
      subtitle: Number.isFinite(lastStart) ? `с ${fmtClock(lastStart)}` : null,
      hint: "Нажмите красную кнопку, как только стан остановился",
      onStop: () => {
        const downtimeId = crypto.randomUUID();
        send("stop", { downtimeId });
        // Сразу предлагаем причину, но можно и позже
        ui.wz = { mode: "current", downtimeId, step: 1, group: null, reason: null, note: "" };
        go("reason");
      },
    }),
    shiftBlock(view)
  ));
}

// --- Метрики работы стана за период (первый экран) ---
const PERIODS = [["shift", "Смена"], ["day", "Сутки"], ["week", "7 суток"], ["month", "Месяц"]];
const STATS_TTL_MS = 60000;
function invalidateStats() { statsEpoch++; ui.stats = {}; }
function loadStats(period) {
  ui.stats = ui.stats || {};
  const c = ui.stats[period];
  if (c && (c.loading || nowMs() - c.at < STATS_TTL_MS)) return;
  const epoch = statsEpoch;
  ui.stats[period] = { ...(c || {}), loading: true };
  api(`/api/stats?period=${period}`)
    .then((d) => { if (epoch !== statsEpoch) return; ui.stats[period] = { data: d.stats, label: d.label, at: nowMs() }; })
    .catch(() => { if (epoch !== statsEpoch) return; ui.stats[period] = { ...(c || {}), error: true, at: nowMs() }; })
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
// zone(r) — цвет полосы по зоне причины; fill — свой класс полосы (например, нейтральный для смен)
function barList(title, rows, total, label, zone = null, fill = "") {
  if (!rows || !rows.length) return null;
  const max = Math.max(...rows.map((r) => r.minutes), 1);
  return h("div", { class: "m-block" },
    h("div", { class: "m-title", text: title }),
    rows.slice(0, 8).map((r) => h("div", { class: "m-bar" },
      h("div", { class: "m-bar-head" },
        h("span", { class: "m-bar-name" }, zone ? zoneMark(zone(r)) : null, label(r)),
        h("span", { class: "m-bar-val", text: barValue(r, total) })),
      h("div", { class: "m-track" }, r.byZone ? r.byZone.filter((z) => z.minutes > 0).map((z) =>
        h("div", { class: "m-fill z-" + z.zone, style: `width:${z.minutes / max * 100}%`, title: `${z.minutes} мин` }))
        : h("div", { class: "m-fill" + (zone ? " z-" + zone(r) : fill ? " " + fill : ""), style: `width:${Math.max(2, Math.round((r.minutes / max) * 100))}%` })))));
}
function zoneMark(zone) {
  return h("span", { class: "reason-zone-mark reason-zone-" + zone, "aria-hidden": "true" });
}
// Кольцо «работа и простой»: доли зон теми же цветами, что шкала суток
function zoneDonut(st) {
  const names = { work: "Работа", plan: "Плановый простой", unplanned: "Внеплановый простой", failure: "Аварийный простой" };
  const rows = Object.keys(names).map((zone) => {
    const row = (st.byZone || []).find((item) => item.zone === zone);
    return { name: names[zone], minutes: row ? row.minutes : 0, cls: "z-" + zone };
  }).filter((r) => r.minutes > 0);
  if (!rows.length) return null;
  return h("div", { class: "m-block" },
    h("div", { class: "m-title", text: "Работа и простой по видам" }),
    donut(rows, "за период"));
}
function zoneMetrics(st) {
  const labels = { work: "Работа", plan: "Плановый простой",
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
      kpi(mins(st.unplannedMin + st.shortMin), "внеплановые", "bad"),
      kpi(mins(st.avgStopMin), "средний простой"),
      kpi(mins(st.mtbfMin), "работа между отказами"),
      kpi(mins(st.mttrMin), "время на ремонт")),
    st.longest ? h("p", { class: "muted", text: `Самый долгий простой: ${fmtHM(st.longest.minutes)}, ${reasonLabel(st.longest.reason) || "без причины"}, с ${fmtClock(st.longest.startMs)} ${fmtDate(st.longest.startMs)}` }) : null,
    warn.length ? h("div", { class: "banner-warn", text: "Проверить: " + warn.join("; ") }) : null,
    zoneDonut(st),
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
  let downtimeHelp = "Посмотреть или исправить простои за смену";
  try {
    const sum = shiftSummary(view);
    const n = sum.stops;
    const downMin = sum.downMinutes;
    downtimeHelp = n ? `${n} ${plural(n, "простой", "простоя", "простоев")} · ${fmtDurMin(downMin)} · посмотреть или исправить` : "Простоев не было";
  } catch { /* Сводка не должна мешать управлению станом. */ }
  const action = (name, title, help, onclick) => h("button", { class: "btn shift-action", onclick },
    h("span", { class: "action-ico" }, icon(name)),
    h("span", { class: "action-copy" }, h("span", { text: title }), h("span", { class: "action-help", text: help })), icon("chevron"));
  return h("section", { class: "shift-block", "aria-label": "Ваша смена" },
    h("div", { class: "shift-card" },
    h("div", { class: "shift-person" },
      h("div", { class: "shift-avatar" }, icon("helmet")),
      h("div", { class: "shift-person-copy" },
      c ? h("p", { class: "muted", text: "Мастер смены" }) : null,
      h("h2", { text: c ? personLabel(c.personId, c.personName) : "Смена не принята" }),
      c ? h("p", { class: "muted", text: `Смену принял в ${fmtClock(core.toMs(c.at))} · ${crewTitle(c.crewId)} · ${periodLabel(view.shift).split(" ")[0].toLowerCase()}` }) : null,
      c ? h("p", null, "На смене ", h("strong", { dataset: { since: String(core.toMs(c.at)), fmt: "dur" } }, fmtDurMin((nowMs() - core.toMs(c.at)) / 60000))) : null)),
    h("div", { class: "shift-time" },
      icon("clock"),
      h("span", { text: `${fmtClock(view.shift.startMs)}–${fmtClock(view.shift.endMs)} · МСК` }),
      h("span", { class: "shift-remaining" }, "До конца ", h("strong", { dataset: { until: String(view.shift.endMs) } }, fmtDurMin((view.shift.endMs - nowMs()) / 60000))), icon("chevron"))),
    ui.resume ? action("info", "Продолжить заполнение", "Ответы предыдущего шага сохранены", () => go(ui.resume)) : null,
    action("check", "Закрыть смену", "Проверить состояние стана и закрыть смену", () => { ui.closeReceipt = null; go("closeCheck"); }),
    action("bars", "Простои за смену", downtimeHelp, () => go("shift")),
    action("chart", "Показатели стана", "Работа и простои за смену, сутки и месяц", () => go("stats"))
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
        h("details", { class: "handover-preview" }, h("summary", { class: "card-note note-preview", text: text ? `«${text}»` : "без записи" }), h("p", { class: "card-note", text: text || "без записи" })));
    }));
}

// Экран «Стан стоит»
function renderStop(main, view) {
  const open = view.open;
  const since = open.since ?? open.startMs; // начало всего простоя, не текущего отрезка
  const elapsed = nowMs() - since;
  const cur = open.reason;

  const left = h("div", null,
    millPanel({
      running: false,
      info: h("span", { class: "mill-info" }, h("span", { class: "mill-timer", dataset: { since: String(since) } }, fmtTimer(elapsed))),
      subtitle: `стоит с ${fmtSince(since, view.shift)}`,
      hint: "Нажмите зелёную кнопку, когда стан заработал. Время пуска запомним сразу.",
      onGo: () => {
        if (reusableRestart(ui.rw, view, nowMs()) && !ui.rw.thenClose) {
          return go(ui.wz?.mode === "restart" ? "reason" : ui.rw.route ? "restartAction" : "restartConfirm");
        }
        ui.wz = null;
        ui.rw = newRestart(view);
        if (open.reason) go("restartConfirm");
        else startRestartReasonWizard();
      },
    })
  );

  let card;
  if (cur) {
    card = h("div", { class: "card" },
      h("div", { class: "card-title", text: reasonLabel(cur) }),
      open.note ? h("div", { class: "card-note note-preview", text: `«${open.note}»`, title: open.note }) : null,
      h("button", { class: "btn btn-flat", onclick: () => openDetail(open.downtimeId) }, "Открыть полную запись"),
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
        if (!reusableRestart(ui.rw, current, nowMs())) { ui.wz = null; ui.rw = newRestart(current); }
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

// У плитки черновика больше одного пункта — значит, шаг «Что именно?» был
function tileMulti(draft) {
  return reasonItems((refs.tiles || []).find((t) => t.id === draft.group)).length > 1;
}
function renderForgotStop(main, view) {
  const fw = ui.fw;
  if (!fw) return go("closeCheck");
  const back = () => {
    if (fw.step === 1) { go("closeCheck"); ui.resume = "forgotStop"; persistClient(); }
    else { fw.step = fw.step === 5 && fw.unknown ? 2 : fw.step === 4 && !tileMulti(fw) ? 2 : fw.step - 1; render(); }
  };
  const backLabels = { 1: "К проверке состояния стана", 2: "К времени остановки", 3: "К выбору причины", 4: tileMulti(fw) ? "К выбору пункта" : "К выбору причины", 5: fw.unknown ? "К выбору группы" : "К описанию причины" };
  const top = () => [backBtn(backLabels[fw.step], back),
    h("p", { class: "muted", text: "Забыли отметить остановку" }),
    fw.unknown ? stepLine(fw.step === 5 ? 3 : fw.step, 3) : fw.step >= 4 && !tileMulti(fw) ? stepLine(fw.step - 1, 4) : stepLine(fw.step, 5)];
  const next = () => { fw.step++; render(); };
  if (fw.step === 1) {
    fill(main, ...top(), question("Когда стан встал?"), ...forgottenTimeFields(view, fw, "atMs", false, next));
    return;
  }
  if (fw.reason) fw.reason = core.reasonKey(fw.reason);
  if (fw.step === 4 && !fw.unknown && !reasonRef(fw.reason)) fw.step = 2;
  if (fw.step === 3 && !(refs.tiles || []).some((t) => t.id === fw.group)) fw.step = 2;
  if (fw.step === 2) {
    fill(main, ...top(), question("Почему стоит?"),
      reasonGroups(fw, (single) => { fw.step = single ? 4 : 3; render(); }));
    return;
  }
  if (fw.step === 3) {
    fill(main, ...top(), question("Что именно?"), reasonChoices(fw, () => { fw.step = 4; render(); }));
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
      // При пуске причину своими словами не спрашиваем (решение владельца 01.10.2026)
      rw.route = "confirm"; go("restartAction");
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
// Плитка → next(true), если пункт выбран сразу (он один); иначе next(false) — нужен шаг «Что именно?»
function reasonGroups(draft, next) {
  return h("div", { class: "tiles reason-groups" }, (refs.tiles || []).map((tile) =>
    h("button", { class: "tile reason-group reason-zone-" + tile.zone,
      onclick: () => {
        draft.group = tile.id;
        draft.unknown = false;
        const items = reasonItems(tile);
        const single = items.length === 1;
        if (single) chooseReasonItem(draft, tile, items[0]);
        next(single);
      } },
    h("span", { class: "reason-group-title", text: tile.title }),
    h("span", { class: "reason-group-subtitle", text: tile.subtitle }))));
}
// Шаг «Что именно?»: пункты плитки, полоска и подпись — по зоне пункта
const ITEM_ZONE_LABEL = { plan: "плановый простой", unplanned: "внеплановый простой", failure: "аварийный простой" };
function reasonChoices(draft, next) {
  const tile = (refs.tiles || []).find((item) => item.id === draft.group);
  return h("div", { class: "tiles reason-groups reason-items" }, reasonItems(tile).map((item) => {
    const zone = zoneOf(core.reasonKey(item.code), refs);
    return h("button", { class: "tile reason-group reason-zone-" + zone,
      onclick: () => { chooseReasonItem(draft, tile, item); next(); } },
    h("span", { class: "reason-group-title", text: item.label }),
    h("span", { class: "reason-group-subtitle", text: ITEM_ZONE_LABEL[zone] || "" }));
  }));
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
  const total = restarting ? (wz.step === 1 || tileMulti(wz) ? 3 : 2) + offset : 3;
  // При пуске шага «своими словами» нет: плитка → «Что именно?» → «Что сделали»
  if (restarting && wz.step === 3) wz.step = 2;
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

  if (wz.reason) wz.reason = core.reasonKey(wz.reason);
  if (wz.step === 3 && !reasonRef(wz.reason)) wz.step = 1;
  if (wz.step === 2 && !(refs.tiles || []).some((t) => t.id === wz.group)) wz.step = 1;

  if (wz.step === 1) {
    fill(main,
      backBtn(...back1),
      stepLine(1 + offset, total),
      question(past ? "Почему стоял?" : "Почему стоит?"),
      reasonGroups(wz, (single) => {
        if (single && restarting) return finishReasonWizard(wz.note || "");
        wz.step = single ? 3 : 2; render();
      }),
      !restarting && wz.mode === "past" ? h("button", {
        class: "btn btn-flat reason-later",
        onclick: () => {
          if (wz.mode === "past") go("recorded");
          else go(wz.mode === "shiftfix" ? "detail" : wz.mode === "repair" ? "repair" : "auto");
        },
      }, "Укажу позже") : null
    );
    return;
  }

  if (wz.step === 2) {
    fill(main,
      backBtn("К выбору причины", () => { wz.step = 1; render(); }),
      stepLine(2 + offset, total),
      question("Что именно?"),
      reasonChoices(wz, () => {
        if (restarting) return finishReasonWizard(wz.note || "");
        wz.step = 3; render();
      }));
    return;
  }

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
    backBtn(reasonItems((refs.tiles || []).find((t) => t.id === wz.group)).length > 1 ? "К выбору пункта" : "К выбору причины",
      () => { wz.step = reasonItems((refs.tiles || []).find((t) => t.id === wz.group)).length > 1 ? 2 : 1; render(); }),
    stepLine(tileMulti(wz) ? 3 : 2, tileMulti(wz) ? 3 : 2),
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
  if (wz.mode !== "restart" && needsNote(wz.reason) && !validAction(note)) { showToast("Напишите, что случилось"); return; }
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
  ta.value = rw.action ?? view.open.action ?? "";
  // После бурёжки и аварии — обязательно, сколько заготовки испорчено (владелец, 01.10.2026)
  const needBillet = restartNeedsBillet(rw, view);
  // Текстовое поле с цифровой клавиатурой: number не принимает «2,5» с русской клавиатуры
  const billet = needBillet ? h("input", { id: "restart-billet", type: "text", maxlength: "8",
    inputmode: "decimal", autocomplete: "off", placeholder: "Тонны, 0 — если брака нет", "aria-label": "Сколько заготовки испорчено, в тоннах" }) : null;
  const billetError = needBillet ? h("p", { class: "error-text", text: "Укажите от 0 до 1000 тн. Если брака нет — 0." }) : null;
  if (needBillet) {
    billet.value = rw.billet ?? "";
    billetError.hidden = true;
    billet.addEventListener("input", () => { rw.billet = billet.value; billetError.hidden = true; });
  }
  const submit = h("button", { class: "btn primary", onclick: () => {
    if (needBillet && !validBillet(billet.value)) { billetError.hidden = false; billet.focus(); return; }
    finishRestart(ta.value);
  } }, "Сохранить пуск");
  ta.addEventListener("input", () => { rw.action = ta.value; });
  const total = (rw.route === "reason" && ui.wz && tileMulti(ui.wz) ? 3 : 2) + (rw.thenClose ? 1 : 0);
  // Что по этому простою уже сделали прошлые смены (последние три записи)
  const earlier = (view.open.handovers || []).map(handoverText).filter(Boolean).slice(-3).reverse();
  fill(main,
    backBtn(rw.route === "reason" ? (tileMulti(ui.wz) ? "К выбору пункта" : "К выбору причины") : "К причине", () => {
      if (rw.route === "reason") { ui.wz.step = tileMulti(ui.wz) ? 2 : 1; go("reason"); }
      else go("restartConfirm");
    }),
    stepLine(total, total),
    question("Что сделали, чтобы запустить стан?"),
    h("p", { class: "muted", text: `Время пуска: ${fmtSince(rw.startMs, view.shift)} МСК${rw.thenClose ? "" : " — по первому нажатию"}` }),
    earlier.length ? h("div", { class: "earlier" },
      h("p", { class: "hint", text: "Раньше по этому простою:" }),
      earlier.map((text) => h("p", { class: "hint earlier-text", text: `«${text}»` }))) : null,
    ta,
    h("p", { class: "hint", text: "Можно оставить пустым. Можно надиктовать — кнопка микрофона на клавиатуре" }),
    needBillet ? h("label", { for: "restart-billet", class: "billet-label", text: "Сколько заготовки испорчено, тн" }) : null,
    billet,
    billetError,
    submit
  );
}
// Брак спрашиваем, если простой был внеплановым (бурёжка) или аварией
function reasonNeedsBillet(reason) {
  const r = reason && reasonRef(core.reasonKey(reason));
  return !!(r && r.askBillet);
}
function restartBilletSegment(rw, view) {
  const all = [...(serverState?.open?.segments || []), ...view.segments, view.open].filter((s) => s && s.downtimeId === rw.downtimeId);
  return all.map((s) => s.index === view.open?.index ? { ...s, reason: rw.reason ?? s.reason } : s)
    .sort((a, b) => a.index - b.index).findLast((s) => reasonNeedsBillet(s.reason));
}
function restartNeedsBillet(rw, view) { return !!restartBilletSegment(rw, view); }
function validBillet(v) {
  const s = String(v ?? "").trim().replace(",", ".");
  if (!s) return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1000;
}

function finishRestart(rawAction) {
  const rw = ui.rw;
  const action = rawAction.trim();
  if (!rw) return;
  if (!restartMatches(buildView(), rw)) { render(); return; }
  if (!reasonRef(rw.reason)) { startRestartReasonWizard(); return; }
  if (rw.startMs < buildView().open.startMs || rw.startMs > nowMs()) {
    showToast("Проверьте время пуска и часы планшета"); return;
  }
  const at = new Date(rw.startMs).toISOString();
  const events = [{ type: "start", fields: { downtimeId: rw.downtimeId, ...(action ? { action } : {}), at } }];
  if (rw.reasonChanged) {
    events.push({ type: "reason", fields: {
      downtimeId: rw.downtimeId,
      reason: rw.reason,
      note: rw.note || "",
      at,
    } });
  }
  const openNow = buildView().open;
  // Брак — к последнему отрезку этого простоя (тот же fix, что правка «Брак» в итоге смены)
  if (restartNeedsBillet(rw, buildView())) {
    if (!validBillet(rw.billet)) { render(); return; }
    // Номер последнего отрезка открытого простоя: после смены причины их несколько
    const index = restartBilletSegment(rw, buildView()).index;
    events.push({ type: "fix", fields: { downtimeId: rw.downtimeId, index,
      billet: Number(String(rw.billet).trim().replace(",", ".")), at } });
  }
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
  if (reasonNeedsBillet(mw.reason) && !validBillet(mw.billet)) return "Укажите от 0 до 1000 тн.";
  return "";
}

function renderManual(main, view) {
  const mw = ui.mw;
  if (!mw) return go("auto");
  const back = () => {
    if (mw.step > 1) { mw.step = mw.step === 5 && !tileMulti(mw) ? 3 : mw.step - 1; render(); }
    else { ui.resume = "manual"; go(mw.origin === "shift" ? "shift" : "auto"); }
  };
  const backLabel = mw.step === 4 ? "К выбору причины" : mw.step === 5 && tileMulti(mw) ? "К выбору пункта" : "К предыдущему вопросу";
  const top = () => [backBtn(mw.step > 1 ? backLabel : mw.origin === "shift" ? "К итогу смены" : "На главный экран", back), mw.step >= 4 && !tileMulti(mw) ? stepLine(mw.step - 1, 6) : stepLine(mw.step, 7)];
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
  if (mw.reason) mw.reason = core.reasonKey(mw.reason);
  if (mw.step >= 5 && mw.step <= 6 && !reasonRef(mw.reason)) mw.step = 3;
  if (mw.step === 4 && !(refs.tiles || []).some((t) => t.id === mw.group)) mw.step = 3;
  if (mw.step === 3) {
    fill(main, ...top(), question("Почему стоял?"), reasonGroups(mw, (single) => { mw.step = single ? 5 : 4; mw.error = ""; render(); }));
    return;
  }
  if (mw.step === 4) {
    fill(main, ...top(), question("Что именно?"), reasonChoices(mw, () => { mw.step = 5; mw.error = ""; render(); }));
    return;
  }
  const action = mw.step === 6;
  const billet = action && reasonNeedsBillet(mw.reason) ? h("input", { id: "manual-billet", type: "text", inputmode: "decimal", "aria-label": "Брак, тн" }) : null;
  const billetError = h("p", { class: "error-text", hidden: true, text: "Укажите от 0 до 1000 тн. Если брака нет — 0." });
  if (billet) { billet.value = mw.billet ?? ""; billet.addEventListener("input", () => { mw.billet = billet.value; billetError.hidden = true; }); }

  const field = action ? "action" : "note";
  const must = !action && needsNote(mw.reason);
  const ta = h("textarea", { class: "note-input", rows: "4", maxlength: String(NOTE_MAX),
    placeholder: action ? actionHint(mw.reason) : noteHint(mw.reason), "aria-label": action ? "Что сделали" : "Что случилось" });
  ta.value = mw[field] || "";
  const error = h("p", { class: "error-text", text: action ? "Напишите, что сделали." : "Опишите своими словами, что случилось." });
  const submit = h("button", { class: "btn primary", onclick: () => {
    if (must && !validAction(ta.value)) return;
    mw[field] = ta.value;
    if (action && reasonNeedsBillet(mw.reason) && !validBillet(mw.billet)) {
      billetError.hidden = false; return;
    }
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
    billet ? h("label", { for: "manual-billet", text: "Брак, тн (0 — если нет)" }) : null, billet, billetError,
    h("p", { class: "hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" }), submit,
    !must && !action ? h("button", { class: "btn", onclick: () => { mw.note = ""; mw.noteEdited = true; next(); } }, "Без описания") : null);
  if (!action) focusReasonNote(ta);
}

function renderManualCheck(main, view) {
  const mw = ui.mw;
  if (!mw) return go("auto");
  const error = manualError(view, mw);
  fill(main,
    backBtn("К выполненным работам", () => { mw.step = 6; go("manual"); }),
    stepLine(7, 7), question("Всё верно?"),
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
        reason: mw.reason, note: mw.note.trim(), action: mw.action.trim(),
        ...(reasonNeedsBillet(mw.reason) ? { billet: Number(String(mw.billet).replace(",", ".")) } : {}) });
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
      h("div", { class: "card-note", text: `Что сделали: ${action || "не указано"}` }),
      billetLine(d, original)),
    h("button", { class: "btn primary", onclick: () => go("auto") }, "На главный экран"));
}
// Брак в карточке «Запись принята»: из учтённого простоя, а пока он не пришёл с сервера — из отправленного fix
function billetLine(d, original) {
  const b = d && d.billet != null ? d.billet : original.findLast((e) => e.type === "fix" && e.billet != null)?.billet;
  return b != null ? h("div", { class: "card-note", text: `Испорчено заготовки: ${fmtTons(b)}` }) : null;
}

function missingFields(segment) {
  const missing = [];
  if (!reasonRef(segment.reason)) missing.push("причина");
  if (!String(segment.action || "").trim()) missing.push("что сделали");
  if (reasonNeedsBillet(segment.reason) && segment.billet == null) missing.push("брак");
  if (isOther(segment.reason) && !validAction(segment.note)) missing.push("описание иной причины");
  return missing;
}
function handoverGaps(view) {
  return shiftDowntimes(view).filter((d) => !d.open).flatMap((d) => {
    const required = d.segs.filter((s) => reasonNeedsBillet(s.reason));
    const billetAt = required.some((s) => s.billet != null) ? null : required.at(-1)?.index;
    return d.segs.map((s) => ({ ...s, missing: missingFields(s).filter((name) => name !== "брак" || s.index === billetAt) }))
      .filter((s) => s.missing.length);
  });
}
function openDetail(downtimeId, index = null) {
  ui.card = { downtimeId, index };
  go("detail");
}

// Сводка перед сдачей. Здесь же исправляют записи в течение смены.
function renderShift(main, view) {
  const sum = shiftSummary(view);
  const downMin = sum.downMinutes;
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
    if (!validBillet(value)) return showToast("Укажите от 0 до 1000 тн.");
    ui.bl = null;
    ui.screen = "detail";
    send("fix", { downtimeId: bl.downtimeId, index: bl.index, billet: value });
  };
  const input = h("input", { type: "text", maxlength: "8", inputmode: "decimal", "aria-label": "Брак в тоннах", placeholder: "Тонны" });
  input.value = bl.value;
  input.addEventListener("input", () => { bl.value = input.value; });
  fill(main, backBtn("К записи простоя", () => go("detail")), question("Сколько заготовки ушло в брак?"),
    h("p", { class: "muted", text: bl.value !== "" ? `В записи: ${fmtTons(bl.value)}` : "Если брака не было, выберите 0 тн." }),
    h("div", { class: "tiles" }, [0, 0.5, 1, 2, 5].map((v) => h("button", { class: "tile", onclick: () => save(v) }, fmtTons(v)))),
    h("label", { for: "billet-value", text: "Другое количество, тн" }),
    Object.assign(input, { id: "billet-value" }),
    h("button", { class: "btn primary", onclick: () => {
      if (validBillet(input.value)) save(Number(input.value.trim().replace(",", ".")));
      else showToast("Укажите от 0 до 1000 тн.");
    } }, "Сохранить"));
}

// Черновик «что сделали по ремонту» относится к своему простою и своей смене
function closeActionDraft(view) {
  const d = ui.closeAction;
  return view.open && d && d.key === stopShiftKey(view) && typeof d.text === "string" ? d.text : "";
}
function renderCloseConfirm(main, view) {
  const gaps = handoverGaps(view);
  const trouble = rejectionGroups(records).length;
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
    h("p", { class: "receipt", text: "Закрытие смены ещё не отправлено" }),
    receipt.length ? h("p", { class: "receipt", text: receiptStatus(receipt) }) : null,
    receipt.length && receiptStatus(receipt) === "Сохранено на планшете"
      ? h("p", { class: "muted", text: "Запись уйдёт на сервер, когда появится связь." }) : null,
    h("p", { text: view.open ? "Стан стоит. Простой перейдёт следующей смене, пуск отмечать не нужно. Напишите, что успели сделать по ремонту, — следующей смене будет проще."
      : "Стан работает. Закроем смену с записанными итогами." }),
    gaps.length ? h("div", { class: "handover-note" },
      h("p", { text: `Без причины: ${gaps.filter((s) => s.missing.includes("причина")).length}. Без «что сделали»: ${gaps.filter((s) => s.missing.includes("что сделали")).length}. Без брака: ${gaps.filter((s) => s.missing.includes("брак")).length}. Дополните записи или закройте смену с пометкой.` }),
      gaps.map((s) => h("button", { class: "btn", onclick: () => openDetail(s.downtimeId, s.index) },
        `${fmtClock(s.startMs)} · дополнить: ${s.missing.join(", ")}`))) : h("p", { class: "muted", text: "У закрытых простоев заполнены причины, выполненные работы и необходимый брак." }),
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
  const rejected = rejectionGroups(records).length;
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
  const downMin = sum.downMinutes;
  const workMin = shiftWorkMin(view, downMin);
  ui.closedInfo = { workMin, downMin, stops: sum.stops, open: !!view.open,
    note: events[0].fields.note, action: events[0].fields.action || "", gaps: handoverGaps(view), at: nowMs() };
  resetStopDrafts();
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
  const group = groupFor(repair.id);
  const choice = (field, label, value) => h("button", { class: "btn shift-action", onclick: () => {
    repair.field = field; go("repairField");
  } }, h("span", { text: label }), h("span", { class: "action-help", text: value || "Не указано" }));
  const replacement = records.findLast((r) => r.replaces === repair.id && r.status === "pending");
  fill(main, backBtn("Вернуться, не исправляя", () => go(repair.back === "repair" ? "auto" : repair.back || "auto")),
    question("Исправить запись"),
    h("p", { text: group ? conflictMessage(group) : humanError(record?.error) }),
    group ? savedAnswers(group) : null, group ? transferButton(group) : null,
    h("p", { class: "muted", text: eventTitle(e) }),
    choice("at", e.type === "stop" ? "Исправить время остановки" : "Когда отметили", `${fmtDate(core.toMs(e.at))} ${fmtClock(core.toMs(e.at))} · МСК`),
    e.type === "manual" ? choice("from", "Когда стан встал", `${fmtDate(core.toMs(e.from))} ${fmtClock(core.toMs(e.from))}`) : null,
    e.type === "manual" ? choice("to", "Когда стан пошёл", `${fmtDate(core.toMs(e.to))} ${fmtClock(core.toMs(e.to))}`) : null,
    !["shift_open", "shift_close"].includes(e.type) ? h("button", { class: "btn shift-action", onclick: () => {
      ui.wz = { mode: "repair", downtimeId: e.downtimeId, index: e.index, step: 1,
        reason: e.reason, group: reasonGroup(e.reason), note: e.note || "" };
      go("reason");
    } }, "Причина", h("span", { class: "action-help", text: reasonLabel(e.reason ?? group?.fields.reason) || "Не указана" })) : null,
    choice("note", e.type === "shift_close" ? "Пометка при закрытии смены" : "Что случилось", e.note ?? group?.fields.note),
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
    ? h("input", { type: time ? "datetime-local" : "number", min: field === "billet" ? "0" : null, max: field === "billet" ? "1000" : null, step: field === "billet" ? "0.1" : null, "aria-label": labels[field] })
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
      (field === "billet" && (!Number.isFinite(value) || value < 0 || value > 1000));
    if (!repair.invalid[field]) e[field] = time ? new Date(value).toISOString() : value;
  });
  fill(main, backBtn("К сохранённой записи", () => go("repair")),
    question(labels[field]), time ? h("p", { class: "muted", text: "Дата и время по Москве. Меняйте время только если оно было указано неверно." }) : null,
    input, error, h("button", { class: "btn primary", onclick: () => {
      const value = time ? parseLocalTime(input.value) : field === "billet" ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
      if ((time && (!Number.isFinite(value) || value > nowMs())) || (field === "billet" && (!Number.isFinite(value) || value < 0 || value > 1000))) {
        error.textContent = time ? "Укажите прошедшее время." : "Укажите вес от 0 до 1000 тн."; error.hidden = false; return;
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
  if (e.type === "manual") repair.error = manualError({ ...view, shift: core.shiftOf(core.toMs(records.find((r) => r.event.id === repair.id)?.event.from || e.from), refs.settings.schedule) }, { ...e, from: core.toMs(e.from), to: core.toMs(e.to) });
  if (e.type === "start") {
    const reason = e.reason || view.open?.reason;
    if (!view.open || view.open.downtimeId !== e.downtimeId) repair.error = "Этот простой уже изменился. Проверьте его в итоге смены; сохранённые ответы остаются здесь.";
    else if (!reasonRef(reason)) repair.error = "Укажите причину.";
    else if (core.toMs(e.at) < view.open.startMs) repair.error = "Пуск не может быть раньше остановки.";
  }
  if (["reason", "split"].includes(e.type) && (!reasonRef(e.reason) || (needsNote(e.reason) && !validAction(e.note)))) repair.error = "Выберите причину. Для иной причины нужно описание.";
  if (core.toMs(e.at) > nowMs()) repair.error = "Время записи в будущем. Исправьте его.";
  if (Object.values(repair.invalid || {}).some(Boolean)) repair.error = "Проверьте введённое время или вес. Ответ остался в своём поле.";
  if (repair.error) { render(); return; }
  const { id, type, device, seq, ...fields } = e;
  if (["stop", "manual"].includes(type)) fields.downtimeId ||= id;
  const next = queueEvent(type, fields);
  const receipt = records.find((r) => r.event.id === next.id);
  receipt.replaces = id;
  // Сначала исправленный stop/start, затем ожидающие ответы. Более раннее время
  // ответа переносим к исправленной границе, сохраняя время пуска и все тексты.
  for (const pending of queue) {
    if (pending.id === next.id || downtimeKey(pending) !== downtimeKey(next)) continue;
    if (pending.after === id) pending.after = next.id;
    if (type === "stop" && !["start", "stop"].includes(pending.type) && core.toMs(pending.at) < core.toMs(next.at)) pending.at = next.at;
  }
  if (type === "start" && e.reason) queueEvent("reason", { downtimeId: e.downtimeId, reason: e.reason, note: e.note || "", at: e.at, after: next.id });
  if (type === "shift_close" && ui.closedInfo) ui.closedInfo.eventIds = [next.id];
  persistQueue();
  ui.repair = null;
  go(type === "shift_close" ? "closed" : "auto");
  flush();
}

// Точная граница смены не зависит от 30-секундного опроса.
function armShiftTimer() {
  clearTimeout(shiftTimer);
  if (!refs) return;
  const boundary = core.shiftOf(nowMs(), refs.settings.schedule).endMs;
  shiftTimer = setTimeout(() => { syncStopContext(); render(); loadState(); armShiftTimer(); }, Math.max(1, boundary - nowMs() + 5));
}
// --- Тики часов на экране ---
function tick() {
  const now = nowMs();
  if (refs && serverState && serverState.shift.endMs <= now) { syncStopContext(); render(); loadState(); }
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
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (ui.screen === "stats") render(); }, 100); });
window.addEventListener("online", () => { flush(); loadState(); });
document.addEventListener("click", (event) => {
  if (taps.blocked()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  const button = event.target.closest?.("button.primary, button.mill-btn, button.tile");
  if (button && !button.disabled) {
    button.disabled = true;
    setTimeout(() => { if (button.isConnected) button.disabled = false; }, 400);
  }
}, true);
window.addEventListener("storage", (event) => {
  if (![SESSION_KEY, QUEUE_KEY].map(storageName).includes(event.key)) return;
  handlingStorage = true;
  try { mergeStored(); persistQueue(); softRender(); }
  finally { handlingStorage = false; }
});
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
  // Справочник берём с сервера при каждом открытии, если есть связь: кэш на устройстве —
  // только на случай без сети. Иначе после выкладки страница могла работать со старыми причинами
  const ok = await loadRefs();
  if (!ok && !refs) { render(); return; }
  await loadState();
  render();
  flush();
}

takeKeyFromHash();
// Общую ссылку вставили в уже открытую вкладку: страница сама не перезагружается — берём ключ и перезапускаемся
window.addEventListener("hashchange", () => {
  if (/(?:^#|&)key=/.test(location.hash)) { takeKeyFromHash(); location.reload(); }
});
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
