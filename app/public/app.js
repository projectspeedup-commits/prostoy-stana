// Страница рабочего: учёт простоев стана. Чистый ES-модуль, без сборки.
// Версия 2: пошаговые экраны, один вопрос — один экран.
import { deliverBatch, pruneRecords, settleRecords, readyEvents, rejectionGroups, transferFields, reusableRestart, downtimeKey, mergeRecords, mergeQueue, tapGuard, fullNameError, migrateLegacyDraft } from "./queue.js";
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

// Метка ключа для кэша прав: сам ключ в кэше не хранится, но чужой кэш (другой ключ) не принимаем
function keyTag(k) {
  let a = 5381;
  for (const ch of String(k || "")) a = ((a * 33) ^ ch.codePointAt(0)) >>> 0;
  return a.toString(36);
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
// Первая загрузка справочников и состояния: пока запрос в пути, экран говорит «Загружаем…», а не «нет связи».
// «Нет связи» — после ошибки или если ответа нет дольше LOAD_SLOW_MS
const LOAD_SLOW_MS = 15_000;
const firstLoad = { refs: { busy: false, bad: false }, state: { busy: false, bad: false } };
function watchLoad(part) {
  const f = firstLoad[part];
  f.busy = true; f.bad = false;
  const timer = setTimeout(() => { if (f.busy) { f.bad = true; render(); } }, LOAD_SLOW_MS);
  return () => { f.busy = false; clearTimeout(timer); };
}
let online = false;
let flushing = false;
let shiftTimer = null;
let statsEpoch = 0;
let handlingStorage = false;
const taps = tapGuard();

// Экран и данные мастеров. screen: auto | crew | reason | confirmChange |
// manual | manualCheck | closeCheck | forgotStop | restartTime | restartConfirm | restartAction |
// recorded | shift | detail | closeConfirm | closed
const ui = {
  screen: "auto",
  crewId: null,      // выбранная бригада на приёме смены
  crewBack: false,   // приём смены открыт кнопкой «Сменить» — есть куда вернуться
  wz: null,          // мастер причины: {mode, downtimeId, index, step, group, reason, note}
  mw: null,          // мастер «Забыл отметить простой»: {origin, step, from, durMin, group, reason, note}
  rw: null,          // мастер пуска: {downtimeId, index, startMs, reason, note, reasonChanged}
  fw: null,          // забытая остановка при закрытии смены: {step, atMs, group, reason, note}
  closeReceipt: null, // события исправленного состояния перед закрытием смены
  edit: null,        // правка записи в «Простоях смены»: {downtimeId, index, base, note, action, billet}
  pickPerson: null,  // мастер, отмеченный на приёме смены
  rec: null,         // экран «Простой записан»: {downtimeId}
  closedInfo: null,  // итоги для экрана «Смена сдана»
  closeAction: null, // черновик «что сделали по ремонту» при сдаче смены: {key, text}
  focusNote: false,  // поставить курсор в поле «своими словами»
  keyError: null,
};
const DRAFT_FIELDS = ["screen", "crewId", "crewBack", "wz", "mw", "rw", "fw", "closeReceipt", "edit", "rec", "closedInfo", "card", "repair", "resume", "contactBack", "closeAction", "fio", "stopContext"];
// Черновик старой версии (af/bl, экраны actionFix/billet) переносим в черновик редактора до первой записи в хранилище
const restoredDraft = migrateLegacyDraft(restored.draft);
for (const field of DRAFT_FIELDS) {
  if (restoredDraft && Object.hasOwn(restoredDraft, field)) ui[field] = restoredDraft[field];
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
  const done = watchLoad("state");
  if (!serverState) render();
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
    firstLoad.state.bad = true;
    setOnline(false);
  } finally {
    loadingState = false;
    done();
  }
  softRender();
}

async function loadRefs() {
  if (firstLoad.refs.busy) return false; // запрос уже в пути: второй не запускаем
  const done = watchLoad("refs");
  if (!refs) render();
  try {
    const d = await api("/api/refs");
    if (d && d.ok && d.refs) {
      refs = d.refs;
      refsVersion = d.refsVersion || null;
      canAdmin = d.canAdmin !== false;
      if (!canAdmin && (ui.screen === "admin" || ui.screen === "ai")) ui.screen = "auto";
      writeStore(REFS_KEY, JSON.stringify({ refs, refsVersion, canAdmin, keyTag: keyTag(key) }));
      setOnline(true);
      done();
      render();
      return true;
    }
    firstLoad.refs.bad = true;
  } catch (err) {
    if (err && err.status === 401) { done(); badKey(); return false; }
    firstLoad.refs.bad = true;
    setOnline(false);
  }
  done();
  if (!refs) render();
  return false;
}

function loadCachedRefs() {
  try {
    const c = JSON.parse(readStore(REFS_KEY));
    if (c && c.refs && c.refs.reasons) {
      refs = c.refs;
      refsVersion = c.refsVersion || null;
      // Права из кэша верны только для того ключа, под которым их получили; иначе ждём ответ сервера
      canAdmin = c.keyTag === keyTag(key) && c.canAdmin !== false;
    }
  } catch { /* кеш пуст */ }
}

// Права и ассистент принадлежат ключу: при смене ключа в том же браузере кэш ролей сбрасываем
function resetKeyScopedState() {
  canAdmin = false;
  ui.admin = null;
  aiUi.status = null; aiUi.statusReq = false; aiUi.log = []; aiUi.text = ""; aiUi.error = ""; aiUi.busy = false;
  if (ui.screen === "admin" || ui.screen === "ai") ui.screen = "auto";
  writeStore(REFS_KEY, "");
}

function badKey() {
  ui.keyError = "Ключ не подошёл. Введите другой.";
  resetKeyScopedState();
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
    // Записки прошлых сдач при работающем стане; при простое они лежат в open.handovers
    handovers: !open && Array.isArray(s.handovers) ? s.handovers.slice() : [],
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
      if (!v.open && typeof e.action === "string" && e.action.trim() && !(v.handovers || []).some((x) => x.at === e.at && x.crewId === (e.crewId ?? null))) {
        v.handovers = [...(v.handovers || []),
          { at: e.at, crewId: e.crewId ?? null, personId: e.personId ?? null, personName: e.personName ?? null, action: e.action, note: e.note ?? null }];
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

// Брак простоя за смену — сумма по всем частям (смена причины по ходу простоя даёт несколько частей).
// Привязка как в отчёте Excel (core/report.js): брак части относится к смене, в которой часть завершилась;
// открытая часть брака не имеет. Брак не указан ни в одной части — null («не указан»), указан 0 — 0
// Правило привязки и суммирования — общее (core.segmentBillet / core.sumBillet), его же держат отчёт и «Показатели»
function shiftBillet(segs, shift) {
  return core.sumBillet(segs
    .filter((s) => s.endMs > shift.startMs && s.endMs <= shift.endMs)
    .map((s) => core.segmentBillet(s)));
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
      billet: shiftBillet(g.segs, shift),
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

// Правило длительностей: в тексте «N ч N мин», в плитках «N ч N м»; нулевые части опускаются («12 ч», «46 мин»)
function fmtParts(min, unit) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} ${unit}`;
  return m ? `${h} ч ${m} ${unit}` : `${h} ч`;
}
// Для плиток и табло: «2 ч 11 м»
function fmtHM(min) { return fmtParts(min, "м"); }
// Подсказки в полях — по теме выбранной причины (из справочника)
const DEFAULT_NOTE_HINT = "Например: на третьей клети заклинило подшипник";
const DEFAULT_ACTION_HINT = "Например: заменили ножи, подтянули муфту";
function noteHint(code) { return (reasonRef(code) && reasonRef(code).hint) || DEFAULT_NOTE_HINT; }
function actionHint(code) { return (reasonRef(code) && reasonRef(code).actionHint) || DEFAULT_ACTION_HINT; }
// «Иная причина»: описание своими словами обязательно
function isOther(code) { return !!(reasonRef(code) && reasonRef(code).other); }
// Описание своими словами обязательно: у «иной» причины и у трёх блоков без подпунктов
function needsNote(code) { const r = reasonRef(code); return !!(r && (r.other || r.noteRequired)); }

// В тексте: «2 ч 11 мин»
function fmtDurMin(min) { return fmtParts(min, "мин"); }
// Долгий простой: от суток — «1 сут 10 ч 21 мин», меньше — как fmtDurMin
function fmtDurLong(min) {
  min = Math.max(0, Math.round(min));
  const days = Math.floor(min / 1440);
  if (!days) return fmtDurMin(min);
  const rest = min % 1440;
  return rest ? `${days} сут ${fmtDurMin(rest)}` : `${days} сут`;
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
// cls — "ico" (прежние экраны) или "ps-ico" (дизайн-система, обводка 2 px)
function icon(name, cls = "ico") {
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
    stopSq: "M7 7h10v10H7z",
    play: "M8 5.5v13l10.5-6.5z",
    calendar: "M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM7 2v4M17 2v4M3 9h18M7 13h3M14 13h3M7 17h3",
    cobble: "M2 15c2.5 0 2.5-6 5-6s2.5 6 5 6 2.5-6 5-6 2.5 6 5 6",
    wrench: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
    tick: "M20 6 9 17l-5-5",
    mail: "M3 5h18v14H3zM3 6l9 7 9-7",
    plus: "M12 5v14M5 12h14",
    clip: "M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1ZM8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 14l2 2 4-4",
    alert: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7.5v5.5M12 16.5h.01",
    wifioff: "M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5-2.7M19 12.9a10 10 0 0 0-2.3-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8a15 15 0 0 0-11.3-3.7M12 20h.01",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}

// Кнопка «Назад»: компактная, первая строка шага мастера. На экранах-разделах её нет — там навигация
function backBtn(label, onclick, extra = "") {
  return h("button", { type: "button", class: "ps-btn ps-btn--secondary ps-back" + (extra ? " " + extra : ""), onclick }, "← " + label);
}
// Кнопка дизайн-системы: kind — primary | secondary | ghost; по умолчанию крупная (64 px)
function psButton(kind, label, onclick, { lg = true, block = false, ...attrs } = {}) {
  return h("button", { type: "button", class: `ps-btn ps-btn--${kind}` + (lg ? " ps-btn--lg" : "") + (block ? " ps-btn--block" : ""), onclick, ...attrs }, label);
}
// Строка ошибки под полем: видна читалке экрана сразу, когда появляется
function fieldError(text = "", hidden = false) {
  return h("p", { class: "ps-field__error", role: "alert", hidden: hidden || !text, text });
}
// Поле с подписью; control — input или textarea с классом ps-input
function psField(label, control, hint = null) {
  return h("label", { class: "ps-field" }, h("span", { class: "ps-field__label", text: label }), control,
    hint ? h("span", { class: "ps-field__hint", text: hint }) : null);
}
// Сводка записи: заголовок и строки «подпись — значение»
function summaryCard(title, rows) {
  return h("section", { class: "ps-card ps-summary" },
    title ? h("h2", { class: "ps-card__title", text: title }) : null,
    rows.filter(Boolean).map(([k, v]) => h("div", { class: "ps-kv" }, h("span", { class: "ps-kv__k", text: k }), h("span", { class: "ps-kv__v", text: v }))));
}
function stepLine(n, total) {
  return h("p", { class: "step", text: `Шаг ${n} из ${total}` });
}
function question(text) {
  return h("h1", { class: "q", text });
}
// Экраны мастера смены (дизайн-система): шапка с надзаголовком и действием справа
function screenHead(over, title, extra = null, cls = "") {
  return h("div", { class: "ps-head" + (cls ? " " + cls : "") },
    h("div", { class: "ps-head__text" }, over ? h("div", { class: "ps-overline", text: over }) : null, question(title)),
    extra);
}
// Карточка с заголовком и подписью справа
function psCard(title, aside, ...kids) {
  return h("section", { class: "ps-card" },
    h("div", { class: "ps-card__head" }, h("h2", { class: "ps-card__title", text: title }), aside ? h("span", { class: "ps-card__aside", text: aside }) : null),
    ...kids);
}
// Выбор карточкой: role=radio, отмеченная — aria-checked
function choiceCard({ title, sub = "", checked = false, current = false, onclick }) {
  return h("button", { type: "button", class: "ps-choice", role: "radio", "aria-checked": String(!!checked), "aria-current": current ? "true" : null, onclick },
    h("span", { class: "ps-choice__radio", "aria-hidden": "true" }),
    h("span", { class: "ps-choice__text" },
      h("span", { class: "ps-choice__title", text: title }),
      sub ? h("span", { class: "ps-choice__sub", text: sub }) : null));
}
// Время кнопками ±1 мин рядом с полем ввода: формат значения и проверки остаются прежними
function timeStepper(label, ms, step) {
  return h("div", { class: "ps-stepper", role: "group", "aria-label": label },
    h("button", { type: "button", "aria-label": "Раньше на минуту", onclick: () => step(-1) }, "−"),
    h("output", { text: Number.isFinite(ms) ? fmtClock(ms) : "—:—" }),
    h("button", { type: "button", "aria-label": "Позже на минуту", onclick: () => step(1) }, "+"));
}
const minuteNow = () => Math.floor(nowMs() / 60000) * 60000;
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return (((parts[0] || "")[0] || "") + ((parts[1] || "")[0] || "")).toUpperCase() || "—";
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
      : (firstLoad.refs.busy && !firstLoad.refs.bad) || (firstLoad.state.busy && !firstLoad.state.bad) ? "Загружаем…"
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
        if (!ui.admin?.dirty) ui.admin = null; // несохранённые правки не теряем при переходе по разделам
        window.scrollTo(0, 0);
        go("admin");
      });
    }
    admin.hidden = !key || !canAdmin;
    admin.classList.toggle("is-on", ui.screen === "admin");
  }
  // «Спросить ассистента»: только ключу владельца и только если ИИ есть на сервере (статус ещё не пришёл — кнопки нет)
  const ask = $("ai-ask");
  if (ask) {
    if (!ask.dataset.bound) {
      ask.dataset.bound = "1";
      ask.addEventListener("click", () => {
        if (!key || !refs || !canAdmin) return;
        ui.aiFocus = true;
        window.scrollTo(0, 0);
        go("ai");
      });
    }
    if (key && refs && canAdmin) loadAiStatus();
    ask.hidden = !key || !refs || !canAdmin || !aiUi.status || Boolean(aiUi.status.unavailable);
    ask.classList.toggle("is-on", ui.screen === "ai");
  }
  // Навигация: «Простои» и «Показатели», отметка текущего раздела
  for (const [id, screen] of [["nav-shift", "shift"], ["nav-stats", "stats"]]) {
    const b = $(id);
    if (!b) continue;
    if (!b.dataset.bound) {
      b.dataset.bound = "1";
      b.addEventListener("click", () => {
        if (!key || !refs) return;
        if (isDraftScreen(ui.screen)) ui.resume = ui.screen;
        window.scrollTo(0, 0);
        go(screen);
      });
    }
    b.hidden = !key;
  }
  const current = { contact: "conn", shift: "nav-shift", detail: "nav-shift", stats: "nav-stats", admin: "admin", ai: "ai-ask" }[ui.screen]
    || (!ui.screen || ui.screen === "auto" ? "demo" : null);
  for (const id of ["demo", "nav-shift", "nav-stats", "conn", "admin", "ai-ask"]) {
    const b = $(id);
    if (!b) continue;
    if (id === current) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  const clock = $("topclock-time");
  if (clock && !clock.textContent) clock.textContent = fmtClock(nowMs()) + " МСК";
  const date = $("topdate");
  if (date) date.textContent = fmtDateLong(nowMs());
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
      psButton("secondary", "Закрыть список", () => { ui.rejectsOpen = false; renderRejects(); renderTopbar(); }, { lg: false })),
    !rejected.length ? h("p", { class: "ps-field__hint", text: queue.length ? `Ждут отправки: ${queue.length}` : "Записей для исправления нет." }) : null,
    storageErrors.size ? psButton("secondary", "Повторить сохранение на планшете", () => { persistQueue(); render(); }, { lg: false }) : null,
    rejected.length > 1 ? psButton("ghost", ui.dismissAllConfirm === rejected.map((g) => g.record.event.id).join("|")
      ? `Точно убрать ${rejected.length} записей?` : `Убрать все отклонённые записи (${rejected.length})`, () => {
      const ids = rejected.map((g) => g.record.event.id);
      const token = ids.join("|");
      if (ui.dismissAllConfirm === token) { ui.dismissAllConfirm = null; dismissRejected(ids, true); }
      else { ui.dismissAllConfirm = token; renderRejects(); }
    }, { lg: false }) : null,
    ...rejected.map((g) => { const r = g.record; return h("div", { class: "reject" },
      h("strong", { text: "Нужно исправить · " + eventTitle(r.event) }),
      h("p", { text: conflictMessage(g) }),
      conflictAnswers(g),
      psButton("secondary", "Открыть сохранённую запись", () => {
        ui.repair = { id: r.event.id, event: { ...r.event }, back: ui.screen };
        ui.rejectsOpen = false;
        go("repair");
      }, { lg: false }),
      transferButton(g),
      psButton("ghost", "Убрать запись", () => dismissRejected([r.event.id]), { lg: false })); })
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
function savedAnswers(g, caption = null) {
  const f = g.fields;
  return h("div", { class: "ps-saved" },
    caption ? h("strong", { text: caption }) : null,
    f.from ? h("p", { text: `Остановка: ${fmtDate(core.toMs(f.from))} ${fmtClock(core.toMs(f.from))}` }) : null,
    h("p", { text: `Причина: ${reasonLabel(f.reason) || "Не указана"}` }),
    h("p", { text: `Что случилось: ${f.note || "Не указано"}` }),
    f.to ? h("p", { text: `Пуск: ${fmtDate(core.toMs(f.to))} ${fmtClock(core.toMs(f.to))}` }) : null,
    h("p", { text: `Что сделали: ${f.action || "Не указано"}` }),
    h("p", { text: `Брак: ${f.billet == null ? "Не указан" : fmtTons(f.billet)}` }));
}
// Ответы, которые уже записаны на сервере с другого устройства (когда наша запись не прошла из-за занятых полей)
function takenFields(g) {
  if (g.record.error !== "fields_taken") return null;
  const last = conflictTarget(g)?.segments?.at(-1);
  if (!last) return null;
  const f = { reason: last.reason, note: last.note, action: last.action, billet: last.billet };
  return Object.values(f).some((v) => !core.emptyField(v)) ? f : null;
}
function otherAnswers(g) {
  const f = takenFields(g);
  if (!f) return null;
  return h("div", { class: "ps-saved ps-saved--other" },
    h("strong", { text: "Уже записано с другого устройства" }),
    h("p", { text: `Причина: ${reasonLabel(f.reason) || "Не указана"}` }),
    h("p", { text: `Что случилось: ${core.emptyField(f.note) ? "Не указано" : f.note}` }),
    h("p", { text: `Что сделали: ${core.emptyField(f.action) ? "Не указано" : f.action}` }),
    h("p", { text: `Брак: ${f.billet == null ? "Не указан" : fmtTons(f.billet)}` }));
}
// Свои ответы и ответы другого устройства рядом. Без чужих ответов — прежний вид
function conflictAnswers(g) {
  const other = otherAnswers(g);
  return other ? [other, savedAnswers(g, "Ваши ответы")] : savedAnswers(g);
}
function transferButton(g) {
  const target = conflictTarget(g);
  if (!target || (!target.endMs && !["stop", "reason", "split", "fix"].includes(g.record.event.type))) return null;
  const last = target.segments.at(-1);
  const fields = transferFields(g.fields, last);
  const names = { reason: "Причина", note: "Что случилось", action: "Что сделали", billet: "Брак" };
  const busy = Object.keys(names).filter((k) => !core.emptyField(last[k]));
  return h("div", { class: "transfer" },
    busy.map((k) => h("p", { class: "ps-field__hint", text: `${names[k]} уже записано: ${k === "reason" ? reasonLabel(last[k]) : k === "billet" ? fmtTons(last[k]) : last[k]}. Это поле сохраним.` })),
    psButton("secondary", g.record.error === "fields_taken" ? "Перенести только пустые поля"
      : g.record.event.type === "stop"
      ? `Перенести мою причину, брак и «что сделали» в простой ${fmtClock(target.startMs)}–${target.endMs ? fmtClock(target.endMs) : "сейчас"}`
      : "Добавить мою причину, брак и «что сделали» к этому простою", () => {
      const fresh = conflictTarget(g).segments.at(-1);
      const payload = transferFields(g.fields, fresh);
      if (!Object.keys(payload).length) return render();
      const next = queueEvent("fix", { downtimeId: target.downtimeId, index: fresh.index, onlyEmpty: true, ...payload });
      const receipt = records.find((r) => r.event.id === next.id);
      receipt.groupId = g.key;
      receipt.transfers = g.records.filter((r) => ["pending", "rejected"].includes(r.status)).map((r) => r.event.id);
      persistQueue(); flush(); render();
    }, { lg: false, disabled: !Object.keys(fields).length }),
    g.record.error === "fields_taken" && !Object.keys(fields).length
      ? h("p", { class: "ps-field__hint", text: "Свободных полей нет, переносить нечего. Ответы другого устройства останутся." }) : null);
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
  // Новый экран открывается с самого верха, а не с позиции кнопки, по которой нажали
  window.scrollTo(0, 0);
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
  return ["reason", "manual", "manualCheck", "closeCheck", "forgotStop", "restartTime", "restartConfirm", "restartAction", "repair", "repairField"].includes(screen);
}
function cancelDraft() {
  ui.wz = ui.mw = ui.rw = ui.fw = ui.repair = ui.resume = null;
  go("auto");
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
  // На вопросе о состоянии стана выход уже есть: «Назад»
  const noCancel = firstReasonStep || ui.screen === "closeCheck";
  if (key && refs && serverState && isDraftScreen(ui.screen) && !noCancel) {
    $("main").append(h("button", { type: "button", class: "ps-btn ps-btn--ghost cancel", onclick: cancelDraft },
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
    case "dismissConfirm": return fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
      question("Убрать остановку вместе с причиной, пуском и браком?"),
      h("div", { class: "ps-notice" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: "В учёт они не попадут." })),
      h("div", { class: "ps-actions ps-actions--col" },
        psButton("primary", "Оставить запись", () => go(ui.dismissBack || "auto")),
        psButton("secondary", "Убрать вместе с ответами", () => dismissRejected(ui.dismissPendingIds, true)))));
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
    case "recorded": return renderRecorded(main, view);
    case "shift": return renderShift(main, view);
    case "closeConfirm": return renderCloseConfirm(main, view);
    case "closed": return renderClosed(main, view);
    case "contact": return renderContact(main, view);
    case "admin": return renderAdmin(main, view);
    case "ai": return renderAi(main);
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
  const masterTile = master ? { role: "Мастер смены", name: master.name, tel: master.phone || "" } : { name: "Мастер смены", tel: "" };
  const list = [masterTile, ...((refs.settings && refs.settings.contacts) || DEFAULT_CONTACTS.slice(1)).map((c) => ({ name: c.title, tel: c.tel }))];
  const status = online && !queue.length ? "Связь с сервером есть, нажатия доходят."
    : online ? `Отправляются нажатия: ${queue.length}.`
    : `Нет связи с сервером. Нажатия сохранены на планшете${queue.length ? ` (${queue.length})` : ""} и уйдут сами, когда связь появится.`;
  const statusTone = online && !queue.length ? "ok" : "warn";
  // Карточка звонка: мастер — «роль + имя», остальные — название из настроек. Номера нет — серая, без звонка
  const card = (c) => {
    const inside = [
      h("span", { class: "ps-contact__icon" }, icon("phone", "ps-ico")),
      h("span", { class: "ps-contact__text" },
        c.role ? h("span", { class: "ps-contact__role", text: c.role }) : null,
        h("span", { class: "ps-contact__name", text: c.name }),
        h("span", { class: "ps-contact__phone", text: c.tel || "номер не задан" })),
    ];
    return c.tel
      ? h("a", { class: "ps-contact", href: `tel:${c.tel.replace(/[^\d+]/g, "")}`, "aria-label": `Позвонить: ${c.role ? c.role + ", " : ""}${c.name}, ${c.tel}` }, ...inside)
      : h("div", { class: "ps-contact", "aria-disabled": "true" }, ...inside);
  };
  fill(main, h("div", { class: "ps-flow" },
    question("Связаться"),
    h("div", { class: "ps-notice", "data-tone": statusTone, role: "status" }, icon(statusTone === "ok" ? "tick" : online ? "alert" : "wifioff", "ps-ico"), h("span", { text: status })),
    h("div", { class: "ps-contacts" }, list.map(card))));
}

// --- Раздел «Администратор»: время смен, мастера с телефонами, номера для «Связаться» ---
// Две смены закрывают сутки без промежутков: конец одной — начало другой. Шаг — 30 минут, как у шкалы суток
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
const fmtLen = (min) => fmtDurMin(min);
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
    const keep = { mail: a.mail, mailVersion: a.mailVersion, smtpConfigured: a.smtpConfigured, envFallback: a.envFallback, mailDirty: a.mailDirty, section: a.section };
    ui.admin = { settings: adminDraft(d.settings), refsVersion: d.refsVersion, ...keep };
    if (mailOut) {
      try {
        const m = await api("/api/admin/mail", { method: "PUT", body: JSON.stringify({ mail: mailOut, mailVersion: a.mailVersion }) });
        Object.assign(ui.admin, { mail: mailDraft(m.mail), mailVersion: m.mailVersion, envFallback: m.envFallback || 0, mailDirty: false });
      } catch (err) {
        if (err && err.status === 401) badKey();
        ui.admin.dirty = true;
        ui.admin.conflict = !!(err && err.status === 409);
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
    // 409: версию настроек успели сменить с другого устройства — форму нужно обновить, правки не потеряны до этого момента
    if (err && err.status === 409) { a.conflict = true; a.error = null; }
    else a.error = [(err && err.status === 413 ? "Настроек слишком много: сократите списки и повторите." : err && err.data && err.data.message) || (err && err.status
      ? "Сервер не принял настройки."
      : "Нет связи с сервером. Настройки не сохранены — повторите, когда связь появится.")];
  }
  render();
}
// --- «Спросить ИИ о работе стана»: разговор живёт только в памяти страницы (POST /api/admin/ai/ask)
const AI_EXAMPLES = ["Сколько стоял стан за эту неделю и почему?", "Какие причины простоев чаще всего в этом месяце?", "Сравни вчерашние сутки с позавчерашними", "Стан сейчас работает?"];
const aiUi = { status: null, statusReq: false, log: [], text: "", busy: false, error: "" };
function loadAiStatus() {
  if (!key || !canAdmin || aiUi.statusReq || aiUi.status) return;
  aiUi.statusReq = true;
  api("/api/admin/ai/status")
    .then((d) => { aiUi.status = d; })
    .catch((err) => {
      if (err && err.status === 401) badKey();
      aiUi.status = { unavailable: true }; // старый сервер без ИИ: карточку не показываем
    })
    .finally(() => { if (ui.screen === "ai") render(); else renderTopbar(); });
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
  } catch (err) {
    if (err && err.status === 401) badKey();
    // Вопрос без ответа убираем из ленты и истории и возвращаем в поле — его можно отправить ещё раз
    aiUi.log.pop();
    aiUi.text = question;
    aiUi.error = (err && err.data && err.data.message) || "Нет связи с сервером. Повторите, когда связь появится.";
  }
  aiUi.busy = false;
  if (ui.screen === "ai") ui.aiFocus = true;
  render();
}
function aiCard() {
  const st = aiUi.status;
  if (!st || st.unavailable) return null;
  const input = h("textarea", { class: "ps-input ai-input", maxlength: "1000", rows: "3", "aria-label": "Вопрос о работе стана", placeholder: "Например: почему вчера стоял стан?" });
  input.value = aiUi.text;
  input.addEventListener("input", () => { aiUi.text = input.value; });
  // Enter отправляет вопрос, Shift+Enter — перенос строки (при наборе по-китайски/японски Enter не трогаем)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); askAi(aiUi.text); }
  });
  const ready = st.configured !== false;
  return h("section", { class: "ps-card ai-card", "aria-label": "Спросить ИИ о работе стана" },
    !ready ? h("div", { class: "ps-notice", role: "status" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: "ИИ-консультант не настроен на сервере" })) : null,
    h("div", { class: "ps-chat", role: "log", "aria-live": "polite" },
      aiUi.log.length ? aiUi.log.map((m) => h("div", { class: "ps-msg ps-msg--" + (m.role === "user" ? "user" : "assistant") },
        h("span", { class: "ps-msg__who", text: m.role === "user" ? "Вы" : "ИИ" }),
        h("p", { class: "ps-msg__text", text: m.content })))
        : (ready ? h("p", { class: "ps-field__hint", text: "Задайте вопрос о работе стана или выберите готовый." }) : null)),
    !ready ? null : h("div", { class: "ps-chips", role: "group", "aria-label": "Примеры вопросов" },
      AI_EXAMPLES.map((q) => h("button", { type: "button", class: "ps-chip", disabled: aiUi.busy, onclick: () => askAi(q) }, q))),
    aiUi.error ? h("div", { class: "ps-notice", "data-tone": "stop", role: "alert" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: aiUi.error })) : null,
    !ready ? null : input,
    !ready ? null : h("div", { class: "ps-actions" },
      psButton("primary", aiUi.busy ? "Думаю…" : "Спросить", () => askAi(aiUi.text), { disabled: aiUi.busy }),
      psButton("ghost", "Новый разговор", () => { aiUi.log = []; aiUi.error = ""; aiUi.text = ""; render(); }, { disabled: aiUi.busy })));
}
// Отдельный экран ассистента: карточка с лентой сообщений; заголовок у экрана, а не у карточки
function renderAi(main) {
  if (!canAdmin) return go("auto");
  loadAiStatus();
  const card = aiCard();
  fill(main, h("div", { class: "ps-flow ps-flow--chat" }, question("Спросить ассистента"),
    card || h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"), h("span", { class: "ps-notice__body", text: "Ассистент сейчас недоступен." }))));
  if (ui.aiFocus) {
    ui.aiFocus = false;
    const input = main.querySelector(".ai-input");
    if (input) input.focus();
  }
}

// Разделы «Администратора»: слева (от 1024 px), на узких экранах — строкой с прокруткой
const ADMIN_SECTIONS = [["shifts", "Время смен", "clock"], ["masters", "Мастера смен", "helmet"], ["contacts", "Номера «Связаться»", "phone"], ["mail", "Рассылка на почту", "mail"]];
const MAIL_WHAT_SHORT = { shift: "Смена", day: "Сутки", week: "Неделя" };
const stepHalfHour = (value, dir) => {
  const m = (hmMin(value) + dir * 30 + 1440) % 1440;
  return `${two(Math.floor(m / 60))}:${two(m % 60)}`;
};
function scheduleProblem(shifts) {
  const [a, b] = shifts.map((x) => hmMin(x.start));
  const len = (b - a + 1440) % 1440;
  return a === b ? "Смены не могут начинаться в одно время." : len < 60 || 1440 - len < 60 ? "Каждая смена должна длиться не меньше часа." : "";
}
function renderAdmin(main) {
  if (!canAdmin) return go("auto");
  if (!ui.admin) loadAdmin();
  loadAiStatus();
  const a = ui.admin;
  const head = screenHead("Настройки системы", "Администратор");
  const shell = (...kids) => fill(main, h("div", { class: "ps-flow ps-admin" }, head, ...kids));
  if (a.loading) return shell(h("p", { class: "ps-lead", text: "Загружаем настройки…" }));
  if (a.loadError) {
    return shell(h("div", { class: "ps-notice", "data-tone": "stop", role: "alert" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: a.loadError })),
      h("div", null, psButton("secondary", "Повторить", () => { ui.admin = null; render(); })));
  }
  const s = a.settings;
  const sections = ADMIN_SECTIONS.filter(([id]) => id !== "mail" || a.mail || a.mailError);
  const section = sections.some(([id]) => id === a.section) ? a.section : "shifts";

  // Панель сохранения: появляется с первой правкой, обновляется без перерисовки экрана — иначе пропадёт курсор
  const barText = h("span", { class: "ps-savebar__text" });
  const cancelBtn = psButton("ghost", "Отменить", () => { ui.admin = null; render(); }, { lg: false });
  const saveBtn = psButton("primary", "Сохранить", saveAdmin, { lg: false });
  const refreshBtn = psButton("primary", "Обновить форму", () => { ui.admin = null; render(); }, { lg: false });
  const bar = h("div", { class: "ps-savebar", role: "region", "aria-label": "Сохранение настроек" }, barText, cancelBtn, saveBtn, refreshBtn);
  const paintBar = () => {
    bar.hidden = !(a.dirty || a.conflict || a.saving);
    barText.textContent = a.conflict ? "Настройки изменили на другом устройстве, обновите форму" : "Есть несохранённые изменения";
    cancelBtn.hidden = !!a.conflict;
    saveBtn.hidden = !!a.conflict;
    saveBtn.disabled = !!a.saving;
    saveBtn.textContent = a.saving ? "Сохраняем…" : "Сохранить";
    refreshBtn.hidden = !a.conflict;
  };
  const touch = () => { a.dirty = true; paintBar(); };
  paintBar();

  // Поля пишут прямо в черновик и не перерисовывают экран — иначе пропадёт курсор
  const txt = (value, attrs, set) => {
    const el = h("input", { type: "text", class: "ps-input", autocomplete: "off", ...attrs });
    el.value = value;
    el.addEventListener("input", () => { set(el.value); touch(); });
    return el;
  };
  const field = (label, control, cls) => h("label", { class: "ps-field" + (cls ? " " + cls : "") }, h("span", { class: "ps-field__label", text: label }), control);
  const remove = (label, onclick) => psButton("ghost", "Убрать", onclick, { lg: false, "aria-label": label });
  const empty = (text) => h("p", { class: "ps-field__hint", text });

  // --- Время смен: начало — кнопками ± с шагом 30 минут, конец считается сам
  const shiftsCard = () => {
    const [s1, s2] = s.schedule.shifts;
    const outs = {}, ends = {}, lens = {};
    const warn = fieldError();
    const lenText = (from, to) => { const len = (hmMin(to) - hmMin(from) + 1440) % 1440; return len ? fmtLen(len) : ""; };
    const paint = () => {
      outs[1].textContent = s1.start; outs[2].textContent = s2.start;
      ends[1].textContent = s2.start; ends[2].textContent = s1.start;
      lens[1].textContent = lenText(s1.start, s2.start); lens[2].textContent = lenText(s2.start, s1.start);
      const problem = scheduleProblem(s.schedule.shifts);
      warn.textContent = problem;
      warn.hidden = !problem;
    };
    const row = (sh, other) => {
      const out = outs[sh.no] = h("output", { "aria-live": "polite", text: sh.start });
      ends[sh.no] = h("b", { text: other.start });
      lens[sh.no] = h("span", { class: "ps-field__hint" });
      const move = (dir) => { sh.start = stepHalfHour(sh.start, dir); touch(); paint(); };
      return h("div", { class: "ps-time" },
        h("div", { class: "ps-time__name" }, icon(sh.no === 1 ? "sun" : "moon", "ps-ico"), h("strong", { text: `Смена ${sh.no}` }), lens[sh.no]),
        h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Начало" }),
          h("div", { class: "ps-stepper", role: "group", "aria-label": `Начало смены ${sh.no}` },
            h("button", { type: "button", "aria-label": "Раньше на 30 минут", onclick: () => move(-1) }, "−"), out,
            h("button", { type: "button", "aria-label": "Позже на 30 минут", onclick: () => move(1) }, "+"))),
        h("div", { class: "ps-time__end" }, "конец ", ends[sh.no]));
    };
    const node = psCard("Время смен", "2 смены",
      h("div", { class: "ps-rows" }, row(s1, s2), row(s2, s1)), warn,
      h("p", { class: "ps-field__hint", text: "Конец одной смены — это начало другой: две смены закрывают сутки без промежутков. Время меняйте между сменами — по нему считаются отчёты. Шаг — 30 минут." }));
    paint();
    return node;
  };

  // --- Мастера по сменам
  // Перенос между сменами меняет только crewId: id мастера остаётся, и у принятой смены не пропадает его телефон
  const crewSwitch = (p) => h("div", { class: "ps-field ps-person__crew" }, h("span", { class: "ps-field__label", text: "Смена" }),
    h("div", { class: "ps-segmented", role: "group", "aria-label": `Смена мастера ${p.name}`.trim() },
      ["1", "2"].map((no) => h("button", { type: "button", "data-crew-pick": no, "aria-pressed": String(p.crewId === no),
        onclick: () => {
          if (p.crewId === no) return;
          p.crewId = no; touch(); render();
          main.querySelector?.(`[data-crew="${no}"] [data-crew-pick="${no}"][aria-pressed="true"]`)?.focus();
        } }, `Смена ${no}`))));
  const personRow = (p) => h("div", { class: "ps-person" },
    field("Фамилия, имя, отчество", txt(p.name, { maxlength: "120", autocapitalize: "words", spellcheck: "false", "data-role": "name" }, (v) => { p.name = v; }), "ps-person__name"),
    field("Телефон", txt(p.phone, { type: "tel", inputmode: "tel", maxlength: "24", placeholder: "+7 900 000-00-00" }, (v) => { p.phone = v; })),
    crewSwitch(p),
    remove(`Убрать мастера ${p.name}`.trim(), () => { s.people.splice(s.people.indexOf(p), 1); touch(); render(); }));
  const crewGroup = (crewId) => {
    const own = s.people.filter((p) => p.crewId === crewId);
    const start = (s.schedule.shifts.find((x) => String(x.no) === crewId) || {}).start;
    return h("div", { class: "ps-group", "data-crew": crewId },
      h("h3", { class: "ps-group__title", text: `Смена ${crewId}` + (start ? ` · с ${start}` : "") }),
      own.length ? own.map(personRow) : empty("Мастеров нет."),
      psButton("secondary", `Добавить мастера в смену ${crewId}`, () => {
        s.people.push({ id: null, name: "", crewId, phone: "" }); touch(); render();
        const names = main.querySelectorAll(`[data-crew="${crewId}"] input[data-role="name"]`);
        names?.[names.length - 1]?.focus();
      }, { lg: false }));
  };
  const mastersCard = () => psCard("Мастера смен", `${s.people.length}`, crewGroup("1"), crewGroup("2"));

  // --- Номера для «Связаться»
  const contactRow = (c) => h("div", { class: "ps-person" },
    field("Подпись", txt(c.title, { maxlength: "60", placeholder: "Например: дежурный механик" }, (v) => { c.title = v; }), "ps-person__name"),
    field("Телефон", txt(c.tel, { type: "tel", inputmode: "tel", maxlength: "24", placeholder: "+7 900 000-00-00" }, (v) => { c.tel = v; })),
    remove(`Убрать номер ${c.title}`.trim(), () => { s.contacts.splice(s.contacts.indexOf(c), 1); touch(); render(); }));
  const contactsCard = () => psCard("Номера для «Связаться»", "видят все устройства",
    h("p", { class: "ps-field__hint", text: "Первая кнопка на экране «Связаться» сама звонит мастеру, который принял смену, — по его телефону из раздела «Мастера смен». Здесь — остальные номера." }),
    s.contacts.length ? s.contacts.map(contactRow) : empty("Номеров нет."),
    s.contacts.length < 12 ? psButton("secondary", "Добавить номер", () => { s.contacts.push({ title: "", tel: "" }); touch(); render(); }, { lg: false }) : null);

  // --- Рассылка на почту
  const mailTouch = () => { a.mailDirty = true; touch(); };
  const addSends = (r, preset) => {
    for (const [time, what, days] of preset) {
      if (r.sends.length >= 10) break;
      if (!r.sends.some((x) => x.time === time && x.what === what)) r.sends.push({ time, what, days: [...days] });
    }
    mailTouch(); render();
  };
  const sendRow = (r, x) => {
    const time = h("input", { type: "time", class: "ps-input", step: "60", required: true, "aria-label": "Время отправки, московское" });
    time.value = x.time;
    time.addEventListener("input", () => { x.time = time.value; mailTouch(); });
    const whatBtns = Object.keys(MAIL_WHAT_TITLE).map((id) => h("button", { type: "button", "aria-pressed": String(x.what === id), title: MAIL_WHAT_TITLE[id],
      onclick: () => { x.what = id; whatBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(Object.keys(MAIL_WHAT_TITLE)[i] === id))); mailTouch(); } }, MAIL_WHAT_SHORT[id]));
    const dayBtns = MAIL_DAYS.map(([n, label]) => h("button", { type: "button", class: "ps-chip", "aria-pressed": String(x.days.includes(n)),
      onclick: (e) => {
        x.days = x.days.includes(n) ? x.days.filter((d) => d !== n) : [...x.days, n].sort((p, q) => p - q);
        e.currentTarget.setAttribute("aria-pressed", String(x.days.includes(n)));
        mailTouch();
      } }, label));
    return h("div", { class: "ps-send" },
      h("div", { class: "ps-form-row" },
        field("Время, московское", time),
        h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Что слать" }), h("div", { class: "ps-segmented", role: "group", "aria-label": "Что слать" }, whatBtns))),
      h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Дни недели" }), h("div", { class: "ps-chips ps-days", role: "group", "aria-label": "Дни недели" }, dayBtns)),
      remove("Убрать отправку", () => { r.sends.splice(r.sends.indexOf(x), 1); mailTouch(); render(); }));
  };
  const recipientCard = (r) => {
    const name = txt(r.name, { maxlength: "80", placeholder: "Например: Иванов И. И.", autocapitalize: "words" }, (v) => { r.name = v; mailTouch(); });
    const email = txt(r.email, { type: "email", inputmode: "email", maxlength: "120", placeholder: "master@example.ru", autocapitalize: "none", spellcheck: "false" }, (v) => { r.email = v; mailTouch(); });
    const switchText = h("span", { text: r.enabled ? "Включён" : "Выключен" });
    const on = h("button", { type: "button", class: "ps-switch", role: "switch", "aria-checked": String(!!r.enabled),
      onclick: (e) => { r.enabled = !r.enabled; e.currentTarget.setAttribute("aria-checked", String(r.enabled)); switchText.textContent = r.enabled ? "Включён" : "Выключен"; mailTouch(); } },
    h("span", { class: "ps-switch__knob", "aria-hidden": "true" }), switchText);
    const t = r._test;
    return h("div", { class: "ps-subcard" },
      h("div", { class: "ps-form-row" }, field("Имя", name), field("Адрес почты", email), on),
      r.sends.length ? r.sends.map((x) => sendRow(r, x)) : empty("Отправок нет: этому получателю ничего не придёт."),
      h("div", { class: "ps-chips", role: "group", "aria-label": "Быстрый выбор" },
        MAIL_QUICK.map(([title, preset]) => h("button", { type: "button", class: "ps-chip", onclick: () => addSends(r, preset) }, title))),
      h("div", { class: "ps-actions" },
        r.sends.length < 10 ? psButton("secondary", "Добавить отправку", () => { r.sends.push({ time: "08:05", what: "shift", days: [1, 2, 3, 4, 5, 6, 7] }); mailTouch(); render(); }, { lg: false }) : null,
        psButton("secondary", t && t.busy ? "Отправляем…" : "Отправить пробное письмо", () => sendMailTest(r), { lg: false, disabled: !!(t && t.busy) })),
      t && !t.busy && t.text ? h("div", { class: "ps-notice", "data-tone": t.ok ? "ok" : "stop", role: "status" }, icon(t.ok ? "tick" : "alert", "ps-ico"), h("span", { class: "ps-notice__body", text: t.text })) : null,
      r._confirmDel
        ? h("div", { class: "ps-notice", role: "alert" }, h("span", { class: "ps-notice__body", text: "Удалить получателя?" }),
          psButton("primary", "Да, удалить", () => { a.mail.recipients.splice(a.mail.recipients.indexOf(r), 1); mailTouch(); render(); }, { lg: false }),
          psButton("secondary", "Отмена", () => { r._confirmDel = false; render(); }, { lg: false }))
        : h("div", null, psButton("ghost", "Удалить получателя", () => { r._confirmDel = true; render(); }, { lg: false })));
  };
  const mailCard = () => a.mail ? psCard("Рассылка на почту", "время московское",
    a.smtpConfigured === false ? h("div", { class: "ps-notice", role: "status" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: "Отправка почты не настроена на сервере. Список можно править, но письма не уйдут." })) : null,
    a.envFallback && !a.mail.recipients.length ? h("p", { class: "ps-field__hint", text: `Пока список пуст, письма о смене уходят на адреса из настроек сервера (${a.envFallback}).` }) : null,
    h("p", { class: "ps-field__hint", text: "Письмо о смене приходит после её окончания: дневная заканчивается в 20:00, ночная в 08:00." }),
    a.mail.recipients.length ? a.mail.recipients.map(recipientCard) : empty("Получателей нет."),
    a.mail.recipients.length < 30 ? h("div", null, psButton("secondary", "Добавить получателя", () => {
      a.mail.recipients.push({ id: null, name: "", email: "", enabled: true, sends: [{ time: "08:05", what: "shift", days: [1, 2, 3, 4, 5, 6, 7] }] });
      mailTouch(); render();
    }, { lg: false })) : null)
    : h("div", { class: "ps-notice", "data-tone": "stop", role: "alert" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: a.mailError || "" }));

  const nav = h("nav", { class: "ps-subnav", "aria-label": "Разделы настроек" }, sections.map(([id, label, ic]) =>
    h("button", { type: "button", class: "ps-subnav__item", "aria-current": id === section ? "page" : null,
      onclick: () => { a.section = id; render(); } }, icon(ic, "ps-ico"), h("span", { text: label }))));
  const body = { shifts: shiftsCard, masters: mastersCard, contacts: contactsCard, mail: mailCard }[section]();
  shell(h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"),
      h("span", { class: "ps-notice__body", text: "Изменения вступают в силу после «Сохранить» — сразу на всех планшетах." })),
    h("div", { class: "ps-cols ps-cols--admin" }, nav,
      h("div", { class: "ps-stack" }, body,
        a.error ? h("div", { class: "ps-notice", "data-tone": "stop", role: "alert" }, icon("alert", "ps-ico"),
          h("span", { class: "ps-notice__body" }, a.error.map((t) => h("span", { text: t })))) : null,
        bar)));
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
  const input = h("input", { type: "password", class: "ps-input", autocomplete: "off" });
  const connect = () => {
    const v = input.value.trim();
    if (!v) return;
    if (v !== key) resetKeyScopedState();
    key = v;
    ui.keyError = null;
    writeStore(STORE_KEY, v);
    boot();
  };
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    question("Устройство не подключено"),
    h("p", { class: "ps-lead", text: "Введите ключ устройства из письма мастера или откройте ссылку с ключом." }),
    ui.keyError ? h("div", { class: "ps-notice", "data-tone": "stop", role: "alert" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: ui.keyError })) : null,
    h("section", { class: "ps-card" }, psField("Ключ устройства", input), psButton("primary", "Подключить", connect, { block: true }))));
}

function renderNoRefs(main) {
  const f = firstLoad.refs;
  // Запрос ещё ждёт ответа: просто «Загружаем…», без сообщения об отсутствии связи и без «Повторить»
  if (f.busy && !f.bad) return fill(main, h("div", { class: "ps-flow ps-flow--narrow", role: "status" },
    question("Загружаем…"), h("p", { class: "ps-lead", text: "Получаем список работников и причин простоя." })));
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    question("Нет данных"),
    h("div", { class: "ps-notice" }, icon("alert", "ps-ico"),
      h("span", { class: "ps-notice__body", text: "На планшете ещё нет списка работников и причин простоя. Подключитесь к сети и повторите загрузку." })),
    psButton("primary", "Повторить", () => { loadRefs().then((ok) => { if (ok) loadState(); else render(); }); }, { disabled: f.busy })));
}

function renderLoading(main) {
  const f = firstLoad.state;
  if (!f.bad) return fill(main, h("div", { class: "ps-flow ps-flow--narrow", role: "status" },
    question("Загружаем…"), h("p", { class: "ps-lead", text: "Получаем состояние стана." })));
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    question("Нужно первое подключение"),
    h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"),
      h("span", { class: "ps-notice__body", text: "На планшете ещё нет состояния стана. Подключитесь к сети и нажмите «Повторить». После этого можно будет работать без сети." })),
    psButton("primary", "Повторить", () => boot(), { disabled: loadingState })));
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
  const error = h("p", { class: "ps-field__error", text: "Впишите фамилию, имя и отчество полностью, без сокращений." });
  error.hidden = true;
  const submit = h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg ps-btn--block", onclick: () => {
    const problem = fullNameError(fields.map(([k]) => fio[k] || ""));
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    acceptShift(fio.crewId, fio.personId, fields.map(([k]) => cap(fio[k])).join(" "));
  } }, icon("tick", "ps-ico"), "Принять смену");
  const update = () => { const problem = fullNameError(fields.map(([k]) => fio[k] || "")); error.textContent = problem; error.hidden = !problem; submit.disabled = !!problem; };
  const inputs = fields.map(([k, label]) => {
    const input = h("input", { type: "text", class: "ps-input", id: `fio-${k}`, autocomplete: "off", autocapitalize: "words", spellcheck: "false", maxlength: "120" });
    input.value = fio[k] || "";
    input.addEventListener("input", () => { fio[k] = input.value; error.hidden = true; update(); persistClient(); });
    return h("div", { class: "ps-field" }, h("label", { class: "ps-field__label", for: `fio-${k}`, text: label }), input);
  });
  update();
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    backBtn("К списку мастеров", () => { ui.fio = null; render(); }),
    question("Фамилия, имя и отчество мастера"),
    h("section", { class: "ps-card" },
      h("p", { class: "ps-field__hint", text: `${crewTitle(fio.crewId)} · ${periodLabel(view.shift)}. Полностью, как в документах: так мастер будет записан в приёме смены.` }),
      ...inputs, error, submit)));
  if (!fio.last) main.querySelector("#fio-last")?.focus();
  else if (!fio.first) main.querySelector("#fio-first")?.focus();
}

function crewHours(id) {
  const shifts = refs.settings.schedule.shifts;
  const i = shifts.findIndex((s) => String(s.no) === String(id));
  return i < 0 ? "" : `${shifts[i].start}–${shifts[(i + 1) % shifts.length].start}`;
}

// Состояние стана на экране приёма смены: панель с таймером
function stateNow(view) {
  if (view.open) {
    const since = view.open.since ?? view.open.startMs;
    return statePanel({ running: false, since, subtitle: `Стоит с ${fmtSince(since, view.shift)}`, compact: true });
  }
  const since = Math.min(nowMs(), runningSince(view));
  return statePanel({ running: true, since, subtitle: Number.isFinite(since) ? `Пущен в ${fmtClock(since)}` : null, compact: true });
}

function renderCrew(main, view) {
  if (ui.fio) return renderFio(main, view);
  const crews = refs.crews || [];
  const single = crews.length === 1 ? crews[0].id : null;
  const chosen = ui.crewId || single;
  const kids = [];
  if (ui.confirmCrew) {
    const current = core.shiftOf(nowMs(), refs.settings.schedule);
    return fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
      question(`Сейчас идёт Смена ${current.shiftNo} (${fmtClock(current.startMs)}–${fmtClock(current.endMs)}). Принять Смену ${ui.confirmCrew}?`),
      h("div", { class: "ps-actions" },
        h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg", onclick: () => { ui.crewId = ui.confirmCrew; ui.confirmCrew = null; render(); } }, "Принять выбранную смену"),
        h("button", { type: "button", class: "ps-btn ps-btn--secondary ps-btn--lg", onclick: () => { ui.confirmCrew = null; render(); } }, "Вернуться к выбору"))));
  }
  if (!chosen) {
    if (ui.crewBack) kids.push(backBtn("Назад", () => { ui.crewBack = false; go("auto"); }));
    kids.push(stepLine(1, 2), screenHead(`Сейчас: ${periodLabel(view.shift)}`, "Выберите вашу смену"));
    kids.push(h("div", { class: "ps-cols" },
      h("div", { class: "ps-stack" },
        psCard("Какая смена", null,
          h("div", { class: "ps-choices", role: "radiogroup", "aria-label": "Смена" }, crews.map((c) => {
            const now = String(c.id) === String(view.shift.shiftNo);
            return choiceCard({ title: c.title, sub: `по расписанию ${crewHours(c.id)}${now ? " · сейчас" : ""}`, current: now, checked: false, onclick: () => {
              if (String(c.id) !== String(core.shiftOf(nowMs(), refs.settings.schedule).shiftNo)) ui.confirmCrew = c.id;
              else ui.crewId = c.id;
              render();
            } });
          })))),
      h("div", { class: "ps-stack" }, psCard("Стан сейчас", null, stateNow(view)))));
  } else {
    if (!single) {
      kids.push(backBtn("К выбору смены", () => { ui.crewId = null; render(); }));
    } else if (ui.crewBack) {
      kids.push(backBtn("Назад", () => { ui.crewBack = false; go("auto"); }));
    }
    // У кого в списке только инициалы — ФИО дописывают при приёме
    const pick = (p) => {
      if (fullName(p.name)) return acceptShift(chosen, p.id, p.name.trim().replace(/\s+/g, " "));
      ui.fio = { crewId: chosen, personId: p.id, last: p.name.trim().split(/\s+/)[0] || "", first: "", middle: "" };
      render();
    };
    const own = (refs.people || []).filter((p) => p.crewId === chosen);
    // Мастер один — он и отмечен; иначе кнопка «Принять смену» ждёт выбора
    const picked = own.find((p) => p.id === ui.pickPerson) || (own.length === 1 ? own[0] : null);
    const accept = h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg ps-btn--block", disabled: !picked,
      onclick: () => picked && pick(picked) }, icon("tick", "ps-ico"), "Принять смену");
    kids.push(stepLine(single ? 1 : 2, single ? 1 : 2),
      screenHead(`${crewTitle(chosen)} · по расписанию ${crewHours(chosen)}`, "Кто принимает смену"));
    kids.push(h("div", { class: "ps-cols" },
      h("div", { class: "ps-stack" },
        psCard("Мастер, который принимает смену", null,
          own.length ? h("div", { class: "ps-choices", role: "radiogroup", "aria-label": "Кто принимает смену" }, own.map((p) =>
            choiceCard({ title: p.name, sub: fullName(p.name) ? "" : "ФИО допишете при приёме", checked: !!picked && picked.id === p.id,
              onclick: () => { ui.pickPerson = p.id; render(); } }))) : h("p", { class: "ps-field__hint", text: "В списке этой смены пока никого нет." }),
          h("button", { type: "button", class: "ps-btn ps-btn--secondary", onclick: () => { ui.fio = { crewId: chosen, personId: null, last: "", first: "", middle: "" }; render(); } }, "Нет в списке — ввести ФИО"))),
      h("div", { class: "ps-stack" },
        renderHandoverCard(view.open || { handovers: view.handovers }),
        psCard("Стан сейчас", null, stateNow(view)),
        accept)));
  }
  fill(main, h("div", { class: "ps-flow" }, kids));
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

// Пульт стана (дизайн-система, вариант A): панель состояния с таймером и одна кнопка —
// единственное действие, доступное сейчас. Стан работает — «Стан встал», стоит — «Стан пошёл»
function statePanel({ running, since, subtitle, compact = false, withReport = false }) {
  const start = Number.isFinite(since) ? since : nowMs();
  return h("section", { class: "ps-state" + (compact ? " ps-state--compact" : ""), "data-state": running ? "run" : "stop", "aria-live": "polite" },
    h("div", { class: "pult-state__top" },
      h("div", { class: "ps-state__eyebrow" }, h("span", { class: "ps-dot", "data-live": true, "data-tone": running ? "run" : "stop" }), "Сейчас"),
      withReport ? reportMenu() : null),
    h(compact ? "h2" : "h1", { class: "ps-state__title", text: running ? "Стан работает" : "Стан стоит" }),
    h("div", { class: "ps-state__timer", dataset: { since: String(start) } }, fmtTimer(nowMs() - start)),
    subtitle ? h("p", { class: "ps-state__meta", text: subtitle }) : null);
}
// below — блок между панелью и кнопкой (плитки причин, пока стан стоит)
function millPanel({ running, since, subtitle, hint, onGo, onStop, below = null }) {
  return h("div", { class: "pult" },
    statePanel({ running, since, subtitle, withReport: true }),
    below,
    h("button", { class: "ps-action ps-action--" + (running ? "stop" : "run"), type: "button", "data-act": running ? "stop" : "run",
      onclick: running ? onStop : onGo },
      h("span", { class: "ps-action__icon" }, icon(running ? "stopSq" : "play")),
      h("span", { class: "ps-action__text" },
        h("span", { class: "ps-action__label", text: running ? "Стан встал" : "Стан пошёл" }),
        hint ? h("span", { class: "ps-action__hint", text: hint }) : null)));
}

// Главный экран: стан работает
function renderRun(main, view) {
  // С последнего пуска, даже если он был в прошлую смену; до первой записи о стане ничего не известно
  const lastStart = Math.min(nowMs(), runningSince(view));
  fill(main, withScale(view,
    millPanel({
      running: true,
      since: lastStart,
      subtitle: Number.isFinite(lastStart) ? `Пущен в ${fmtClock(lastStart)}` : null,
      hint: "Нажмите сразу при остановке — время поставит система",
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
  const parts = [fmtDurMin(r.minutes)];
  if (r.stops || !r.carried) parts.push(`${r.stops} ост.`);
  if (r.billetTn > 0) parts.push(`брак ${fmtTons(r.billetTn)}`);
  if (total) parts.push(`${Math.round((r.minutes / total) * 100)}%`);
  if (r.carried) parts.push(r.carried === 1 ? "принят стоящим" : `принят стоящим: ${r.carried}`);
  return parts.join(" · ");
}
// Полосы причин: zone(r) — зона причины (цвет полосы и квадрат у названия); без неё — нейтральная полоса
function barList(title, rows, total, label, zone = null) {
  if (!rows || !rows.length) return null;
  const max = Math.max(...rows.map((r) => r.minutes), 1);
  return psCard(title, null, h("div", { class: "ps-bars" },
    rows.slice(0, 8).map((r) => h("div", { class: "ps-bar" },
      h("div", { class: "ps-bar__head" },
        h("span", { class: "ps-bar__name" }, zone ? h("span", { class: "ps-swatch", "data-zone": zone(r), "aria-hidden": "true" }) : null, h("span", { text: label(r) })),
        h("span", { class: "ps-bar__val", text: barValue(r, total) })),
      h("div", { class: "ps-bar__track" }, r.byZone ? r.byZone.filter((z) => z.minutes > 0).map((z) =>
        h("div", { class: "ps-bar__fill", "data-zone": z.zone, style: `width:${z.minutes / max * 100}%`, title: fmtDurMin(z.minutes) }))
        : h("div", { class: "ps-bar__fill", "data-zone": zone ? zone(r) : "neutral", style: `width:${Math.max(2, Math.round((r.minutes / max) * 100))}%` }))))));
}
// Кольцо «работа и простой»: доли зон теми же цветами, что шкала суток
function zoneDonut(st) {
  const names = { work: "Работа", plan: "Плановый простой", unplanned: "Внеплановый простой", failure: "Аварийный простой" };
  const rows = Object.keys(names).map((zone) => {
    const row = (st.byZone || []).find((item) => item.zone === zone);
    return { name: names[zone], minutes: row ? row.minutes : 0, cls: "z-" + zone };
  }).filter((r) => r.minutes > 0);
  if (!rows.length) return null;
  return psCard("Работа и простой по видам", null, donut(rows, "за период"));
}
function zoneMetrics(st) {
  const labels = { work: "Работа", plan: "Плановый простой",
    unplanned: "Внеплановый простой", failure: "Аварийный простой" };
  return psCard("Простой по зонам", null, h("div", { class: "ps-zrows" },
    Object.entries(labels).map(([zone, label]) => {
      const row = (st.byZone || []).find((item) => item.zone === zone);
      return h("div", { class: "ps-zrow" },
        h("span", { class: "ps-zrow__name" }, h("span", { class: "ps-swatch", "data-zone": zone, "aria-hidden": "true" }), h("span", { text: label })),
        h("span", { class: "ps-zrow__val", text: row ? fmtDurMin(row.minutes) + " · " + row.stops + " ост. · " + pct(row.share) : "—" }));
    })),
  h("p", { class: "ps-field__hint", text: "Доля — от времени учёта за выбранный период. Остановка со сменой зоны учитывается в каждой из этих зон." }));
}
// Показатели (вариант «Диспетчерская»): период, плитки, полосы причин. Цифры — из /api/stats, здесь они не пересчитываются
function metrics(view) {
  const period = ui.statsPeriod || "shift";
  loadStats(period);
  const c = (ui.stats || {})[period] || {};
  const st = c.data;
  const tabs = h("div", { class: "ps-segmented ps-period", role: "group", "aria-label": "Период" },
    PERIODS.map(([id, name]) => h("button", { type: "button", "aria-pressed": String(id === period),
      onclick: () => { ui.statsPeriod = id; render(); } }, name)));
  const stopped = !!view.open;
  const state = h("div", { class: "ps-notice", "data-tone": stopped ? "stop" : "ok", role: "status" }, icon(stopped ? "alert" : "tick", "ps-ico"),
    h("span", { class: "ps-notice__body", text: stopped ? `Стан стоит с ${fmtSince(view.open.since ?? view.open.startMs, view.shift)}` : "Стан работает" }));
  const head = screenHead(c.label || periodLabel(view.shift), "Показатели стана", reportMenu(), "ps-head--stats");
  const top = [head, h("div", { class: "ps-toolbar" }, tabs, state)];
  if (!st) {
    return h("div", { class: "ps-flow ps-stats" }, ...top,
      h("div", { class: "ps-notice", "data-tone": c.error ? "stop" : "info", role: "status" }, icon(c.error ? "alert" : "info", "ps-ico"),
        h("span", { class: "ps-notice__body", text: c.error ? "Нет связи с сервером. Показатели появятся, когда связь вернётся." : "Считаем…" })));
  }
  if (st.noData) {
    return h("div", { class: "ps-flow ps-stats" }, ...top,
      h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"), h("span", { class: "ps-notice__body", text: "За этот период записей ещё нет." })));
  }
  const kpi = (v, t, tone = "") => h("div", { class: "ps-kpi", "data-tone": tone || null },
    h("span", { class: "ps-kpi__label", text: t }), h("span", { class: "ps-kpi__value", text: v }));
  const q = st.quality || {};
  const warn = [];
  if (q.noReason) warn.push(`без причины: ${q.noReason}`);
  if (q.noAction) warn.push(`не указано, что сделали: ${q.noAction}`);
  if (q.noBillet) warn.push(`не указан брак: ${q.noBillet}`);
  if (q.otherShare > 0.1) warn.push(`«иная причина» — ${pct(q.otherShare)} простоя, стоит дополнить список причин`);
  const crewName = (id) => (id ? crewTitle(id) : "Смена не указана");
  return h("div", { class: "ps-flow ps-stats" }, ...top,
    h("div", { class: "ps-kpis ps-kpis--row" },
      kpi(pct(st.availability), "Доступность", st.availability !== null && st.availability < 0.85 ? "bad" : "good"),
      kpi(mins(st.workMin), "Работа", "good"),
      kpi(mins(st.downMin), "Простой", "bad"),
      kpi(String(st.stops), "Остановок"),
      // Брак — только заготовка, испорченная при простоях (в тоннах); не указан ни разу — прочерк
      h("div", { class: "ps-kpi", "data-kind": "billet" },
        h("span", { class: "ps-kpi__label", text: "Брак, тн" }),
        h("span", { class: "ps-kpi__value", text: st.billetTn == null ? "—" : fmtTons(st.billetTn) }))),
    h("div", { class: "ps-kpis ps-kpis--auto" },
      kpi(mins(st.plannedMin), "Плановые"),
      kpi(mins(st.unplannedMin + st.shortMin), "Внеплановые", "bad"),
      kpi(mins(st.avgStopMin), "Средний простой"),
      kpi(mins(st.mtbfMin), "Работа между отказами"),
      kpi(mins(st.mttrMin), "Время на ремонт")),
    warn.length ? h("div", { class: "ps-notice" }, icon("alert", "ps-ico"), h("span", { class: "ps-notice__body", text: "Проверить: " + warn.join("; ") })) : null,
    h("div", { class: "ps-cols" },
      h("div", { class: "ps-stack" },
        barList("Причины простоя", st.byReason, st.downMin, (r) => (r.reason ? reasonLabel(r.reason) : "Без причины"),
          (r) => zoneOf(r.reason, refs)),
        barList("По сменам", st.byCrew, st.downMin, (r) => crewName(r.crewId)),
        st.longest ? h("div", { class: "ps-notice", "data-tone": "info" }, icon("clock", "ps-ico"),
          h("span", { class: "ps-notice__body", text: `Самый долгий простой: ${fmtDurMin(st.longest.minutes)}, ${reasonLabel(st.longest.reason) || "без причины"}, с ${fmtClock(st.longest.startMs)} ${fmtDate(st.longest.startMs)}` })) : null),
      h("div", { class: "ps-stack" },
        zoneMetrics(st),
        zoneDonut(st),
        st.byDay && st.byDay.length > 1 ? psCard("По суткам: работа и простой, часы", null, dayChart(st.byDay),
          h("div", { class: "chart-legend" },
            h("span", { class: "lg work", text: "работа" }), h("span", { class: "lg down", text: "простой" }), h("span", { class: "lg nodata", text: "нет данных" }))) : null)),
    h("p", { class: "ps-field__hint", text: "Доступность — доля работы во времени без плановых остановок. «Работа между отказами» и «время на ремонт» считаются по внеплановым простоям." }));
}

// Блок смены: кто принял, время смены, остаток, закрытие. Одинаков при работающем и стоящем стане
// Карточка смены на пульте: мастер, сколько осталось, что нужно дописать, «Сдать смену»
function shiftBlock(view) {
  const c = view.crew;
  let stopsLine = "";
  try {
    const sum = shiftSummary(view);
    const n = sum.stops;
    stopsLine = n ? `${n} ${plural(n, "простой", "простоя", "простоев")} · ${fmtDurMin(sum.downMinutes)}` : "Простоев не было";
  } catch { /* Сводка не должна мешать управлению станом. */ }
  // Закрытые простои, где не указано «что сделали»: первый открывается кнопкой «Заполнить»
  let missing = [];
  try {
    missing = [...new Map(handoverGaps(view).filter((s) => s.missing.includes("что сделали")).map((s) => [s.downtimeId, s])).values()];
  } catch { /* то же */ }
  const { startMs, endMs } = view.shift;
  const pct = Math.max(0, Math.min(100, ((nowMs() - startMs) / (endMs - startMs)) * 100));
  return h("section", { class: "shift-block", "aria-label": "Ваша смена" },
    h("div", { class: "ps-card ps-shift" },
      h("div", { class: "ps-shift__who" },
        h("span", { class: "ps-avatar", "aria-hidden": "true", text: c ? initials(personLabel(c.personId, c.personName)) : "—" }),
        h("div", { class: "ps-shift__text" },
          h("div", { class: "ps-overline", text: "Мастер смены" }),
          h("h2", { class: "ps-shift__name", text: c ? personLabel(c.personId, c.personName) : "Смена не принята" }),
          c ? h("div", { class: "ps-shift__meta", text: `Принял смену в ${fmtClock(core.toMs(c.at))} · ${crewTitle(c.crewId)} · ${periodLabel(view.shift).split(" ")[0].toLowerCase()}` }) : null,
          stopsLine ? h("div", { class: "ps-shift__meta", text: stopsLine }) : null)),
      h("div", { class: "ps-progress" },
        h("div", { class: "ps-progress__row" },
          h("span", { text: `${fmtClock(startMs)} – ${fmtClock(endMs)} · МСК` }),
          h("span", null, "до конца ", h("b", { dataset: { until: String(endMs) } }, fmtDurMin((endMs - nowMs()) / 60000)))),
        h("div", { class: "ps-progress__track" }, h("div", { class: "ps-progress__fill", dataset: { from: String(startMs), to: String(endMs) }, style: `width: ${pct.toFixed(1)}%` }))),
      missing.length ? h("div", { class: "ps-notice" }, icon("alert", "ps-ico"),
        h("span", { class: "ps-notice__body", text: `${missing.length} ${plural(missing.length, "простой", "простоя", "простоев")} без «что сделали»` }),
        h("button", { type: "button", class: "ps-btn ps-btn--secondary", onclick: () => openDetail(missing[0].downtimeId, missing[0].index) }, "Заполнить")) : null,
      ui.resume ? h("button", { type: "button", class: "ps-btn ps-btn--ghost ps-btn--block", onclick: () => go(ui.resume) }, "Продолжить заполнение: ответы предыдущего шага сохранены") : null,
      h("button", { type: "button", class: "ps-btn ps-btn--secondary ps-btn--lg ps-btn--block", onclick: () => { ui.closeReceipt = null; go("closeCheck"); } },
        icon("clip", "ps-ico"), "Сдать смену")));
}

// Экран «Показатели стана»: табло и метрики за период, доступен в любой момент
function renderStats(main, view) {
  fill(main, metrics(view));
}

// Ключ простоя (или работающего стана) в пределах смены: черновик «что сделали по ремонту» относится к своему простою и своей смене
function stopShiftKey(view) {
  return `${view.open ? view.open.downtimeId : "run"}|${view.shift.day}|${view.shift.shiftNo}`;
}

// Что передали прошлые смены по ремонту: текст сдачи смены или пусто
function handoverText(item) {
  return typeof item?.action === "string" ? item.action.trim() : "";
}
// Карточка «Передали по ремонту»: три последние передачи, новая сверху. Только для чтения
function renderHandoverCard(open) {
  const list = (open.handovers || []).slice(-3).reverse();
  if (!list.length) return null;
  return psCard("Передали по ремонту", list.length > 1 ? `последние ${list.length}` : "",
    list.map((x) => {
      const at = core.toMs(x.at);
      const text = handoverText(x);
      return h("div", { class: "ps-notice", "data-tone": "info" }, icon("wrench", "ps-ico"),
        h("div", { class: "ps-notice__body" },
          h("span", { class: "ps-notice__line", text: text ? `«${text}»` : "без записи" }),
          h("span", { class: "ps-field__hint", text: `${crewTitle(x.crewId)} · ${personLabel(x.personId, x.personName)} · передал ${fmtDate(at)} в ${fmtClock(at)}` })));
    }));
}

// Экран «Стан стоит»
function renderStop(main, view) {
  const open = view.open;
  const since = open.since ?? open.startMs; // начало всего простоя, не текущего отрезка
  const cur = open.reason;

  // Причины ещё нет — плитки сразу под панелью состояния; нажатие открывает тот же мастер на втором шаге
  const pick = cur ? null : h("section", { class: "ps-pick", "aria-label": "Причина остановки" },
    h("div", { class: "ps-overline", text: "Почему стоит?" }),
    reasonGroups(() => {
      if (!(ui.wz && ui.wz.mode === "current" && ui.wz.downtimeId === open.downtimeId)) {
        ui.wz = { mode: "current", downtimeId: open.downtimeId, step: 1, group: null, reason: null, note: "" };
      }
      return ui.wz;
    }, (single) => { ui.wz.step = single ? 3 : 2; go("reason"); }));
  const left = h("div", null,
    millPanel({
      running: false,
      since,
      subtitle: `Стоит с ${fmtSince(since, view.shift)}`,
      below: pick,
      hint: "Время пуска поставит система",
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
    card = h("section", { class: "ps-card" },
      h("div", { class: "ps-overline", text: "Причина простоя" }),
      h("h2", { class: "ps-card__title", text: reasonLabel(cur) }),
      open.note ? h("p", { class: "ps-lead ps-note-preview", text: `«${open.note}»`, title: open.note }) : null,
      h("div", { class: "ps-actions" },
        psButton("secondary", "Открыть полную запись", () => openDetail(open.downtimeId), { lg: false }),
        psButton("secondary", "Изменить", () => go("confirmChange"), { lg: false }))
    );
  } else {
    card = null;
  }

  fill(main, withScale(view, h("div", { class: "stop-grid" }, left, h("div", null, card, renderHandoverCard(open))), shiftBlock(view)));
}

// Минуты простоя по зонам за смену: те же отрезки, что в сводке; округляет ядро (apportionMinutes)
function shiftZoneMinutes(view, downMin) {
  const shift = view.shift;
  const ms = { plan: 0, unplanned: 0, failure: 0 };
  const add = (reason, from, to) => {
    const a = Math.max(from, shift.startMs);
    const b = Math.min(to, shift.endMs, nowMs());
    if (b > a) ms[zoneOf(reason, refs)] += b - a;
  };
  for (const s of view.segments) add(s.reason, s.startMs, s.open || s.endMs === null ? nowMs() : s.endMs);
  if (view.open) add(view.open.reason, view.open.startMs, nowMs());
  const keys = ["plan", "unplanned", "failure"];
  const mins = core.apportionMinutes(keys.map((k) => ms[k]), downMin);
  return Object.fromEntries(keys.map((k, i) => [k, mins[i]]));
}
// Итоги смены плитками: работа и три вида простоя; ниже — брак за смену
function shiftKpis(view) {
  const sum = shiftSummary(view);
  const downMin = sum.downMinutes;
  const zones = shiftZoneMinutes(view, downMin);
  const tile = (zone, label, min) => h("div", { class: "ps-kpi", "data-zone": zone, "data-zero": min >= 1 ? null : "" },
    h("span", { class: "ps-kpi__label" }, h("span", { class: "ps-swatch", "data-zone": zone, "aria-hidden": "true" }), label),
    h("span", { class: "ps-kpi__value", text: fmtHM(min) }));
  const billet = Math.round(shiftDowntimes(view).reduce((n, d) => n + (Number(d.billet) || 0), 0) * 1000) / 1000;
  return [
    h("div", { class: "ps-kpis" },
      tile("work", "Работа", shiftWorkMin(view, downMin)), tile("plan", "Плановый", zones.plan),
      tile("unplanned", "Внеплановый", zones.unplanned), tile("failure", "Аварийный", zones.failure)),
    h("div", { class: "ps-kpi", "data-kind": "billet", "data-zero": billet ? null : "" },
      h("span", { class: "ps-kpi__label", text: "Брак за смену" }),
      h("span", { class: "ps-kpi__value", text: fmtTons(billet) }))];
}

// Пункт проверки: считает система, мастер его не отмечает; у todo — кнопка перехода к исправлению
function checkItem(done, text, action = null) {
  return h("li", { class: "ps-check", "data-status": done ? "done" : "todo" },
    h("span", { class: "ps-check__mark", "aria-hidden": "true" }, icon(done ? "tick" : "alert", "ps-ico")),
    h("span", { class: "ps-check__text" }, h("span", { class: "ps-sr", text: done ? "Готово: " : "Нужно сделать: " }), text),
    !done && action ? h("button", { type: "button", class: "ps-btn ps-btn--secondary", onclick: action.onclick }, action.label) : null);
}

// Закрытие смены начинается со сверки записи на планшете с состоянием стана.
function runningSince(view) {
  const ends = view.segments.filter((s) => !s.open && Number.isFinite(s.endMs)).map((s) => s.endMs);
  return Math.max(view.runningSinceMs ?? -Infinity, ...ends,
    ends.length || view.runningSinceMs != null ? -Infinity : view.dataFromMs ?? nowMs());
}
function renderCloseCheck(main, view) {
  const open = view.open;
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    backBtn("Назад", () => go("auto")),
    question(open ? "Стан всё ещё стоит?" : "Стан в рабочем состоянии?"),
    h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"), h("span", { class: "ps-notice__body", text: open
      ? `На планшете: стан стоит с ${fmtSince(open.since ?? open.startMs, view.shift)} · ${reasonLabel(open.reason) || "причина не указана"}`
      : `На планшете: стан работает с ${fmtSince(runningSince(view), view.shift)}` })),
    h("div", { class: "ps-actions ps-actions--col" },
      h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg", onclick: () => go("closeConfirm") }, open ? "Да, стоит" : "Да, работает"),
      h("button", { type: "button", class: "ps-btn ps-btn--secondary ps-btn--lg", onclick: () => {
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
      } }, open ? "Нет, уже работает" : "Нет, стан стоит"))));
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
  const input = h("input", { type: "datetime-local", class: "ps-input", "aria-label": restart ? "Время пуска, Москва" : "Время остановки, Москва" });
  input.value = draft.timeValue ?? localTimeValue(draft[field]);
  const error = fieldError();
  const submit = psButton("primary", "Далее", () => {
    const msg = forgottenTimeError(buildView(), draft[field], restart);
    if (msg) { error.textContent = msg; error.hidden = false; return; }
    next();
  });
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
  // Кнопки ±1 мин двигают то же значение, что и поле: проверки и формат события прежние
  const stepper = timeStepper(restart ? "Время пуска" : "Время остановки", draft[field], (dir) => {
    draft[field] = (Number.isFinite(draft[field]) ? draft[field] : minuteNow()) + dir * 60000;
    delete draft.timeValue;
    render();
  });
  return [h("section", { class: "ps-card" },
    h("div", { class: "ps-form-row" }, h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Время по Москве" }), stepper), psField("Или дата и время", input)),
    h("div", { class: "ps-chips", role: "group", "aria-label": "Быстрый выбор" }, [[10, "10 мин назад"], [30, "30 мин назад"], [60, "1 ч назад"], [120, "2 ч назад"]].map(([min, label]) =>
      h("button", { type: "button", class: "ps-chip", onclick: () => {
        draft[field] = Math.floor(nowMs() / 60000) * 60000 - min * 60000;
        delete draft.timeValue;
        render();
      } }, label)))), error, submit];
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
    h("div", { class: "ps-overline", text: "Забыли отметить остановку" }),
    fw.unknown ? stepLine(fw.step === 5 ? 3 : fw.step, 3) : fw.step >= 4 && !tileMulti(fw) ? stepLine(fw.step - 1, 4) : stepLine(fw.step, 5)];
  const next = () => { fw.step++; render(); };
  const flow = (...kids) => fill(main, h("div", { class: "ps-flow ps-flow--narrow" }, ...kids));
  if (fw.step === 1) {
    flow(...top(), question("Когда стан встал?"), ...forgottenTimeFields(view, fw, "atMs", false, next));
    return;
  }
  if (fw.reason) fw.reason = core.reasonKey(fw.reason);
  if (fw.step === 4 && !fw.unknown && !reasonRef(fw.reason)) fw.step = 2;
  if (fw.step === 3 && !(refs.tiles || []).some((t) => t.id === fw.group)) fw.step = 2;
  if (fw.step === 2) {
    flow(...top(), question("Почему стоит?"),
      reasonGroups(fw, (single) => { fw.step = single ? 4 : 3; render(); }));
    return;
  }
  if (fw.step === 3) {
    flow(...top(), question("Что именно?"), reasonChoices(fw, () => { fw.step = 4; render(); }));
    return;
  }
  if (fw.step === 4) {
    const ta = h("textarea", { class: "ps-input", rows: "4", maxlength: String(NOTE_MAX),
      placeholder: noteHint(fw.reason) });
    ta.value = fw.note || "";
    const error = fieldError("Опишите своими словами, что случилось.");
    const submit = psButton("primary", "Далее", next);
    let touched = !!ta.value;
    const update = () => {
      fw.note = ta.value;
      submit.disabled = needsNote(fw.reason) && !validAction(ta.value);
      error.hidden = !submit.disabled || !touched;
    };
    ta.addEventListener("input", () => { touched = true; fw.noteEdited = true; update(); });
    update();
    flow(...top(), question("Расскажите своими словами"),
      h("div", { class: "ps-picked" }, h("span", { class: "ps-swatch", "data-zone": zoneOf(core.reasonKey(fw.reason), refs), "aria-hidden": "true" }), h("span", { text: reasonLabel(fw.reason) })),
      psField("Что случилось", ta, "Можно надиктовать — кнопка микрофона на клавиатуре"), error, submit);
    focusReasonNote(ta);
    return;
  }
  const error = forgottenStopError(view, fw);
  flow(...top(), question("Всё верно?"),
    summaryCard(`Стан стоит с ${fmtDate(fw.atMs)} ${fmtClock(fw.atMs)}`, [
      ["Причина", fw.unknown ? "не указана" : reasonLabel(fw.reason)],
      !fw.unknown && fw.note?.trim() ? ["Что случилось", fw.note.trim()] : null]),
    error ? fieldError(error) : null,
    psButton("primary", "Сохранить", saveForgottenStop, { disabled: !!error }));
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
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    backBtn("К проверке состояния стана", () => { go("closeCheck"); ui.resume = "restartTime"; persistClient(); }),
    h("div", { class: "ps-overline", text: "Забыли отметить пуск" }), stepLine(1, total), question("Когда стан пошёл?"),
    ...forgottenTimeFields(view, rw, "startMs", true, () => {
      if (!restartMatches(buildView(), rw)) { render(); return; }
      rw.timeConfirmed = true;
      if (rw.route === "reason" && ui.wz?.mode === "restart") { ui.wz.step = 1; go("reason"); }
      else if (rw.reason) go("restartConfirm");
      else startRestartReasonWizard();
    })));
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
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    restartBack(),
    stepLine(rw.thenClose ? 2 : 1, rw.thenClose ? 3 : 2),
    question("Причина простоя верна?"),
    h("div", { class: "ps-picked" }, h("span", { class: "ps-swatch", "data-zone": zoneOf(core.reasonKey(rw.reason), refs), "aria-hidden": "true" }), h("span", { text: reasonLabel(rw.reason) })),
    h("div", { class: "ps-actions ps-actions--col" },
      psButton("primary", "Да, верно", () => {
        // При пуске причину своими словами не спрашиваем (решение владельца 01.10.2026)
        rw.route = "confirm"; go("restartAction");
      }),
      psButton("secondary", "Изменить", startRestartReasonWizard))));
}

// Вопрос перед сменой причины на ходу
function renderConfirmChange(main, view) {
  const open = view.open;
  if (!open) return go("auto");
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    backBtn("К простою", () => go("auto")),
    question("Причина сменилась по ходу простоя?"),
    h("div", { class: "ps-actions ps-actions--col" },
      psButton("primary", "Да, теперь стоим по другой причине", () => {
        ui.wz = { mode: "split", downtimeId: open.downtimeId, step: 1, group: null, reason: null, note: "" };
        go("reason");
      }),
      psButton("secondary", "Нет, исправить ошибку", () => {
        ui.wz = { mode: "refix", downtimeId: open.downtimeId, step: 1, group: null, reason: null, note: "" };
        go("reason");
      }))));
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
// Иконка плитки: плановая — календарь, бурёжка — волна, поломка — ключ
const REASON_ICON = { plan: "calendar", unplanned: "cobble", failure: "wrench" };
// Плитка → next(true), если пункт выбран сразу (он один); иначе next(false) — нужен шаг «Что именно?»
// draft — черновик мастера или функция, которая даёт его в момент нажатия (на пульте черновика ещё нет)
function reasonGroups(draft, next) {
  const current = typeof draft === "function" ? draft : () => draft;
  const shown = typeof draft === "function" ? null : draft;
  return h("div", { class: "ps-reasons-box" },
    h("div", { class: "ps-reasons", role: "group", "aria-label": "Причина остановки" }, (refs.tiles || []).map((tile) =>
      h("button", { type: "button", class: "ps-reason", "data-zone": tile.zone, "aria-pressed": String(!!shown && shown.group === tile.id),
        onclick: () => {
          const d = current();
          d.group = tile.id;
          d.unknown = false;
          const items = reasonItems(tile);
          const single = items.length === 1;
          if (single) chooseReasonItem(d, tile, items[0]);
          next(single);
        } },
      h("span", { class: "ps-reason__icon" }, icon(REASON_ICON[tile.zone] || "wrench", "ps-ico")),
      h("span", { class: "ps-reason__title", text: tile.title }),
      h("span", { class: "ps-reason__sub", text: tile.subtitle })))));
}
// Шаг «Что именно?»: пункты плитки чипами, квадрат и подпись — по зоне пункта
const ITEM_ZONE_LABEL = { plan: "плановый простой", unplanned: "внеплановый простой", failure: "аварийный простой" };
function reasonChoices(draft, next) {
  const tile = (refs.tiles || []).find((item) => item.id === draft.group);
  return h("div", { class: "ps-chips ps-chips--items", role: "group", "aria-label": "Что именно" }, reasonItems(tile).map((item) => {
    const zone = zoneOf(core.reasonKey(item.code), refs);
    return h("button", { type: "button", class: "ps-chip ps-chip--item", "aria-pressed": String(draft.itemKey === reasonItemKey(tile, item)),
      onclick: () => { chooseReasonItem(draft, tile, item); next(); } },
    h("span", { class: "ps-swatch", "data-zone": zone, "aria-hidden": "true" }),
    h("span", { class: "ps-chip__text" },
      h("span", { class: "ps-chip__label", text: item.label }),
      h("span", { class: "ps-chip__zone", text: ITEM_ZONE_LABEL[zone] || "" })));
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
    // Пока стан стоит, плитки идут сразу под панелью состояния
    const stopped = ["current", "refix", "split"].includes(wz.mode) && view.open;
    fill(main, h("div", { class: "ps-flow" },
      backBtn(...back1),
      stopped ? statePanel({ running: false, since: view.open.since ?? view.open.startMs,
        subtitle: `Стоит с ${fmtSince(view.open.since ?? view.open.startMs, view.shift)}`, compact: true }) : null,
      stepLine(1 + offset, total),
      question(past ? "Почему стоял?" : "Почему стоит?"),
      reasonGroups(wz, (single) => {
        if (single && restarting) return finishReasonWizard(wz.note || "");
        wz.step = single ? 3 : 2; render();
      }),
      !restarting && wz.mode === "past" ? h("button", {
        type: "button",
        class: "ps-btn ps-btn--ghost ps-btn--block",
        onclick: () => {
          if (wz.mode === "past") go("recorded");
          else go(wz.mode === "shiftfix" ? "detail" : wz.mode === "repair" ? "repair" : "auto");
        },
      }, "Укажу позже") : null
    ));
    return;
  }

  if (wz.step === 2) {
    fill(main, h("div", { class: "ps-flow" },
      backBtn("К выбору причины", () => { wz.step = 1; render(); }),
      stepLine(2 + offset, total),
      question("Что именно?"),
      reasonChoices(wz, () => {
        if (restarting) return finishReasonWizard(wz.note || "");
        wz.step = 3; render();
      })));
    return;
  }

  // Шаг 3: своими словами
  const ta = h("textarea", {
    class: "ps-input",
    id: "wz-note",
    rows: "4",
    maxlength: String(NOTE_MAX),
    placeholder: noteHint(wz.reason),
    "aria-label": "Описание своими словами",
  });
  ta.value = wz.note || "";
  const must = needsNote(wz.reason);
  const needText = h("p", { class: "ps-field__error", text: "Напишите, что случилось" });
  // Красная строка — только после попытки пройти дальше с пустым полем
  let tried = false;
  const upd = () => { needText.hidden = !must || !tried || validAction(ta.value); };
  ta.addEventListener("input", () => { wz.note = ta.value; wz.noteEdited = true; upd(); });
  upd();
  const done = (withNote) => {
    if (must && !validAction(ta.value)) { tried = true; upd(); ta.focus(); return; }
    finishReasonWizard(withNote ? ta.value : "");
  };
  fill(main, h("div", { class: "ps-flow" },
    backBtn(reasonItems((refs.tiles || []).find((t) => t.id === wz.group)).length > 1 ? "К выбору пункта" : "К выбору причины",
      () => { wz.step = reasonItems((refs.tiles || []).find((t) => t.id === wz.group)).length > 1 ? 2 : 1; render(); }),
    stepLine(tileMulti(wz) ? 3 : 2, tileMulti(wz) ? 3 : 2),
    question(must ? "Что случилось? Опишите своими словами" : "Расскажите своими словами"),
    h("div", { class: "ps-picked" },
      h("span", { class: "ps-swatch", "data-zone": zoneOf(core.reasonKey(wz.reason), refs), "aria-hidden": "true" }),
      h("span", { text: reasonLabel(wz.reason) })),
    h("div", { class: "ps-field" },
      h("label", { class: "ps-field__label", for: "wz-note", text: must ? "Что случилось" : "Что случилось (по желанию)" }),
      ta,
      must ? needText : null,
      h("span", { class: "ps-field__hint", text: "Можно надиктовать — кнопка микрофона на клавиатуре" })),
    h("div", { class: "ps-actions" },
      h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg", onclick: () => done(true) }, restarting ? "Далее" : "Сохранить"),
      must ? null : h("button", { type: "button", class: "ps-btn ps-btn--secondary ps-btn--lg", onclick: () => done(false) }, "Без описания"))
  ));
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
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" }, question("Состояние стана изменилось"),
    h("div", { class: "ps-notice" }, icon("alert", "ps-ico"),
      h("span", { class: "ps-notice__body", text: "Этот простой уже изменили. Ответы оставлены в черновике. Вернитесь к стану и проверьте его перед пуском." })),
    psButton("primary", "Вернуться к стану", () => { ui.resume = ui.screen; go("auto"); })));
}

function actionText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return validAction(text) ? text : "";
}

// Быстрые варианты «что сделали» — из подсказки справочника к причине: «Например: заменили ножи, подтянули муфту»
function quickActions(code) {
  const hint = reasonRef(code) && reasonRef(code).actionHint;
  if (!hint) return [];
  return hint.replace(/^[^:]*:\s*/, "").split(",").map((t) => t.trim()).filter((t) => t.length >= 3)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 4);
}
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
// Брак чипами; другое значение вводится в поле (текст с запятой, 0–1000)
const BILLET_CHIPS = ["0", "0,5", "1", "1,5", "2"];
const sameTons = (a, b) => {
  const x = String(a ?? "").trim().replace(",", ".");
  return x !== "" && Number(x) === Number(b.replace(",", "."));
};

function renderRestartAction(main, view) {
  const rw = ui.rw;
  if (!restartMatches(view, rw)) return renderStaleRestart(main);
  const reasonNow = rw.reason !== undefined && rw.reason !== null ? rw.reason : view.open.reason;
  const ta = h("textarea", {
    class: "ps-input",
    id: "restart-action",
    rows: "3",
    maxlength: String(NOTE_MAX),
    placeholder: actionHint(reasonNow),
    "aria-label": "Что сделали, чтобы запустить стан",
  });
  ta.value = rw.action ?? view.open.action ?? "";
  // «Заполню потом» — тот же пуск без текста «что сделали»; мастер увидит простой с пометкой
  const later = h("button", { type: "button", class: "ps-btn ps-btn--secondary ps-btn--lg" }, "Заполню потом");
  // Быстрые варианты дописывают фразу в поле; повторное нажатие убирает её
  const quick = quickActions(reasonNow);
  const quickChips = quick.map((text) => h("button", { type: "button", class: "ps-chip", "aria-pressed": "false",
    onclick: () => {
      const cur = ta.value;
      const hit = [text, lowerFirst(text)].find((v) => cur.includes(v));
      if (hit) {
        const rest = cur.replace(hit, "").replace(/\s*,\s*,/g, ",").replace(/^[\s,;.]+|[\s,;]+$/g, "").replace(/\s{2,}/g, " ");
        ta.value = rest.charAt(0).toUpperCase() + rest.slice(1);
      } else {
        ta.value = cur.trim() ? cur.trim().replace(/[.,;]+$/, "") + ", " + lowerFirst(text) : text;
      }
      syncAction();
    } }, text));
  const syncAction = () => {
    rw.action = ta.value;
    quickChips.forEach((chip, i) => chip.setAttribute("aria-pressed", String([quick[i], lowerFirst(quick[i])].some((v) => ta.value.includes(v)))));
    later.hidden = !!ta.value.trim();
  };
  ta.addEventListener("input", syncAction);
  // После бурёжки и аварии — обязательно, сколько заготовки испорчено (владелец, 01.10.2026)
  const needBillet = restartNeedsBillet(rw, view);
  // Текстовое поле с цифровой клавиатурой: number не принимает «2,5» с русской клавиатуры
  const billet = needBillet ? h("input", { id: "restart-billet", class: "ps-input", type: "text", maxlength: "8",
    inputmode: "decimal", autocomplete: "off", placeholder: "Своё значение, тонн", "aria-label": "Сколько заготовки испорчено, в тоннах" }) : null;
  const billetError = needBillet ? h("p", { class: "ps-field__error", text: "Укажите от 0 до 1000 тн. Если брака нет — 0." }) : null;
  let billetBox = null;
  if (needBillet) {
    billet.value = rw.billet ?? "";
    billetError.hidden = true;
    let other = String(rw.billet ?? "").trim() !== "" && !BILLET_CHIPS.some((v) => sameTons(rw.billet, v));
    const otherChip = h("button", { type: "button", class: "ps-chip", "aria-pressed": "false" }, "Другое");
    const billetChips = BILLET_CHIPS.map((v) => h("button", { type: "button", class: "ps-chip", "aria-pressed": "false",
      onclick: () => { other = false; billet.value = ""; rw.billet = v; billetError.hidden = true; syncBillet(); } }, v));
    const syncBillet = () => {
      billetChips.forEach((chip, i) => chip.setAttribute("aria-pressed", String(!other && sameTons(rw.billet, BILLET_CHIPS[i]))));
      otherChip.setAttribute("aria-pressed", String(other));
      billet.hidden = !other;
    };
    otherChip.addEventListener("click", () => { other = true; rw.billet = billet.value; billetError.hidden = true; syncBillet(); billet.focus(); });
    billet.addEventListener("input", () => { rw.billet = billet.value; billetError.hidden = true; });
    syncBillet();
    billetBox = h("div", { class: "ps-field", role: "group", "aria-labelledby": "restart-billet-label" },
      h("span", { class: "ps-field__label", id: "restart-billet-label", text: "Сколько заготовки испорчено, тн" }),
      h("div", { class: "ps-chips" }, billetChips, otherChip),
      billet, billetError,
      h("span", { class: "ps-field__hint", text: "Если брака нет — 0" }));
  }
  const save = (rawAction) => {
    if (needBillet && !validBillet(rw.billet)) {
      billetError.hidden = false; if (!billet.hidden) billet.focus(); return;
    }
    finishRestart(rawAction);
  };
  const submit = h("button", { type: "button", class: "ps-btn ps-btn--run ps-btn--lg", onclick: () => save(ta.value) }, "Сохранить пуск");
  later.addEventListener("click", () => save(""));
  syncAction();
  const total = (rw.route === "reason" && ui.wz && tileMulti(ui.wz) ? 3 : 2) + (rw.thenClose ? 1 : 0);
  // Что по этому простою уже сделали прошлые смены (последние три записи)
  const earlier = (view.open.handovers || []).map(handoverText).filter(Boolean).slice(-3).reverse();
  fill(main, h("div", { class: "ps-flow" },
    backBtn(rw.route === "reason" ? (tileMulti(ui.wz) ? "К выбору пункта" : "К выбору причины") : "К причине", () => {
      if (rw.route === "reason") { ui.wz.step = tileMulti(ui.wz) ? 2 : 1; go("reason"); }
      else go("restartConfirm");
    }),
    stepLine(total, total),
    h("section", { class: "ps-card ps-restart", "aria-label": "Что сделали" },
      h("div", null,
        question("Что сделали, чтобы запустить стан?"),
        h("p", { class: "ps-field__hint", text: `Время пуска: ${fmtSince(rw.startMs, view.shift)} МСК${rw.thenClose ? "" : " — по первому нажатию"}` })),
      earlier.length ? h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"),
        h("div", { class: "ps-notice__body" },
          h("span", { text: "Раньше по этому простою:" }),
          earlier.map((text) => h("span", { class: "ps-notice__line", text: `«${text}»` })))) : null,
      h("div", { class: "ps-field", role: "group", "aria-labelledby": "restart-action-label" },
        h("span", { class: "ps-field__label", id: "restart-action-label", text: "Что сделали" }),
        quickChips.length ? h("div", { class: "ps-chips" }, quickChips) : null,
        ta,
        h("span", { class: "ps-field__hint", text: "Можно оставить пустым. Можно надиктовать — кнопка микрофона на клавиатуре" })),
      billetBox,
      h("div", { class: "ps-actions" }, submit, later),
      h("p", { class: "ps-field__hint", text: "Не заполните сейчас — мастер увидит простой с пометкой «не указано, что сделали»." }))
  ));
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
  const top = () => [backBtn(mw.step > 1 ? backLabel : mw.origin === "shift" ? "К простоям смены" : "Назад", back), mw.step >= 4 && !tileMulti(mw) ? stepLine(mw.step - 1, 6) : stepLine(mw.step, 7)];
  const next = () => { mw.step++; mw.error = ""; render(); };
  const flow = (...kids) => fill(main, h("div", { class: "ps-flow ps-flow--narrow" }, ...kids));
  if (mw.step <= 2) {
    const start = mw.step === 1;
    const field = start ? "from" : "to";
    const input = h("input", { type: "datetime-local", class: "ps-input", "aria-label": start ? "Начало простоя, Москва" : "Конец простоя, Москва" });
    input.value = localTimeValue(mw[field]);
    const error = fieldError();
    const submit = psButton("primary", "Далее", next);
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
    const stepper = timeStepper(start ? "Начало простоя" : "Конец простоя", mw[field], (dir) => {
      mw[field] = (Number.isFinite(mw[field]) ? mw[field] : minuteNow()) + dir * 60000;
      render();
    });
    flow(...top(), question(start ? "Когда стан встал?" : "Когда стан снова пошёл?"),
      h("section", { class: "ps-card" },
        h("p", { class: "ps-field__hint", text: "Дата и время по Москве. Добавляем уже закончившийся простой этой смены." }),
        h("div", { class: "ps-form-row" }, h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Время по Москве" }), stepper), psField("Или дата и время", input)),
        h("div", { class: "ps-chips", role: "group", "aria-label": "Быстрый выбор" }, choices.map(([min, label]) => h("button", { type: "button", class: "ps-chip", onclick: () => {
          mw[field] = start ? mw.openedAt - min * 60000 : mw.from + min * 60000;
          render();
        } }, label))),
        start ? null : h("p", { class: "ps-field__hint", text: `Начало: ${fmtDate(mw.from)} в ${fmtClock(mw.from)}. Выбранный конец не меняется, пока вы заполняете запись.` })),
      error, submit);
    return;
  }
  if (mw.reason) mw.reason = core.reasonKey(mw.reason);
  if (mw.step >= 5 && mw.step <= 6 && !reasonRef(mw.reason)) mw.step = 3;
  if (mw.step === 4 && !(refs.tiles || []).some((t) => t.id === mw.group)) mw.step = 3;
  if (mw.step === 3) {
    flow(...top(), question("Почему стоял?"), reasonGroups(mw, (single) => { mw.step = single ? 5 : 4; mw.error = ""; render(); }));
    return;
  }
  if (mw.step === 4) {
    flow(...top(), question("Что именно?"), reasonChoices(mw, () => { mw.step = 5; mw.error = ""; render(); }));
    return;
  }
  const action = mw.step === 6;
  const billet = action && reasonNeedsBillet(mw.reason) ? h("input", { id: "manual-billet", class: "ps-input", type: "text", inputmode: "decimal" }) : null;
  const billetError = fieldError("Укажите от 0 до 1000 тн. Если брака нет — 0.", true);
  if (billet) { billet.value = mw.billet ?? ""; billet.addEventListener("input", () => { mw.billet = billet.value; billetError.hidden = true; }); }

  const field = action ? "action" : "note";
  const must = !action && needsNote(mw.reason);
  const ta = h("textarea", { class: "ps-input", rows: "4", maxlength: String(NOTE_MAX),
    placeholder: action ? actionHint(mw.reason) : noteHint(mw.reason) });
  ta.value = mw[field] || "";
  const error = fieldError(action ? "Напишите, что сделали." : "Опишите своими словами, что случилось.");
  const submit = psButton("primary", "Далее", () => {
    if (must && !validAction(ta.value)) return;
    mw[field] = ta.value;
    if (action && reasonNeedsBillet(mw.reason) && !validBillet(mw.billet)) {
      billetError.hidden = false; return;
    }
    if (action) go("manualCheck"); else next();
  });
  const update = () => {
    mw[field] = ta.value;
    submit.disabled = must && !validAction(ta.value);
    error.hidden = !submit.disabled || !touched;
  };
  let touched = !!ta.value;
  ta.addEventListener("input", () => { touched = true; if (!action) mw.noteEdited = true; update(); });
  update();
  flow(...top(), question(action ? "Что сделали, чтобы запустить стан?" : "Расскажите своими словами"),
    action ? null : h("div", { class: "ps-picked" }, h("span", { class: "ps-swatch", "data-zone": zoneOf(core.reasonKey(mw.reason), refs), "aria-hidden": "true" }), h("span", { text: reasonLabel(mw.reason) })),
    psField(action ? "Что сделали" : "Что случилось", ta, "Можно надиктовать — кнопка микрофона на клавиатуре"), error,
    billet ? psField("Брак, тн (0 — если нет)", billet) : null, billetError, submit,
    !must && !action ? psButton("secondary", "Без описания", () => { mw.note = ""; mw.noteEdited = true; next(); }) : null);
  if (!action) focusReasonNote(ta);
}

function renderManualCheck(main, view) {
  const mw = ui.mw;
  if (!mw) return go("auto");
  const error = manualError(view, mw);
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    backBtn("К выполненным работам", () => { mw.step = 6; go("manual"); }),
    stepLine(7, 7), question("Всё верно?"),
    summaryCard(`${fmtDate(mw.from)} · ${fmtClock(mw.from)}–${fmtClock(mw.to)} · ${fmtDurMin((mw.to - mw.from) / 60000)}`, [
      ["Причина", reasonLabel(mw.reason)],
      ["Что случилось", mw.note || "не указано"],
      ["Что сделали", mw.action || "не указано"]]),
    error || mw.error ? fieldError(error || mw.error) : null,
    h("div", { class: "ps-actions ps-actions--col" },
      psButton("primary", mw.saving ? "Проверяем время…" : "Сохранить простой", async () => {
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
      }, { disabled: !!error || mw.saving }),
      psButton("secondary", "Исправить время", () => { mw.step = 1; go("manual"); }))));
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
  const tone = status === "Принято сервером" ? "ok" : status === "Нужно исправить" || status === "На планшете не сохранено" ? "stop" : "info";
  const title = d && longRec ? `${fmtDate(ui.rec.sinceMs)} ${fmtClock(ui.rec.sinceMs)} – ${fmtDate(ui.rec.endMs)} ${fmtClock(ui.rec.endMs)} · ${fmtDurLong((ui.rec.endMs - ui.rec.sinceMs) / 60000)}`
    : d ? `${fmtClock(d.startMs)}–${d.endMs === null ? "идёт" : fmtClock(d.endMs)} · ${fmtDurMin(d.minutes)}` : "Простой";
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" }, question(status),
    h("div", { class: "ps-notice", "data-tone": tone }, icon(tone === "ok" ? "tick" : tone === "stop" ? "alert" : "info", "ps-ico"),
      h("span", { class: "ps-notice__body", text: status === "Принято сервером" ? "Запись простоя принята."
        : status === "Нужно исправить" ? "Сервер не принял часть записи. Ответы сохранены ниже."
        : status === "На планшете не сохранено" ? "Не закрывайте страницу. Повторите сохранение."
        : "Запись уйдёт сама, когда появится связь. Можно продолжать работу." })),
    summaryCard(title, [
      d && longRec ? ["В эту смену", fmtDurMin(d.minutes)] : null,
      ["Причина", reasonLabel(d?.reason || original.findLast((e) => e.reason)?.reason)],
      ["Что случилось", note || "не указано"],
      ["Что сделали", action || "не указано"],
      billetLine(d, original)]),
    psButton("primary", "Готово", () => go("auto"))));
}
// Брак в карточке «Запись принята»: из учтённого простоя, а пока он не пришёл с сервера — из отправленного fix
function billetLine(d, original) {
  const b = d && d.billet != null ? d.billet : original.findLast((e) => e.type === "fix" && e.billet != null)?.billet;
  return b != null ? ["Испорчено заготовки", fmtTons(b)] : null;
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
  // Редактор простоя показываем целиком, с его верха
  $("main").querySelector(".ps-editor")?.scrollIntoView({ block: "start" });
}

// Простои смены: слева список, справа редактор записи (от 1024 px); на узких экранах
// список и редактор — два экрана по ui.screen: «shift» (список) и «detail» (запись)
function renderShift(main, view) { renderDowntimes(main, view, false); }
function renderDetail(main, view) { renderDowntimes(main, view, true); }

// Строка простоя: интервал, причина с зоной, что сделали, длительность
function downtimeRow(d, shift, selected) {
  const missing = d.open ? [] : [...new Set(d.segs.flatMap(missingFields))];
  const what = d.open ? "Идёт сейчас"
    : missing.includes("что сделали") ? "Не указано, что сделали"
    : missing.length ? `Дополнить: ${missing.join(", ")}`
    : String(d.action || "").trim() || "—";
  const note = [d.continued ? "Начался в прошлую смену" : "", d.segs.length > 1 ? `Причина менялась · частей: ${d.segs.length}` : ""].filter(Boolean).join(" · ");
  return h("button", { type: "button", class: "ps-row", "aria-current": selected ? "true" : null, onclick: () => openDetail(d.downtimeId) },
    h("span", { class: "ps-row__time", text: `${fmtSince(d.startMs, shift)}–${d.endMs === null ? "сейчас" : fmtClock(d.endMs)}` }),
    h("span", { class: "ps-row__main" },
      h("span", null, h("span", { class: "ps-tag", "data-zone": reasonRef(d.reason) ? zoneOf(core.reasonKey(d.reason), refs) : "pending",
        text: reasonLabel(d.reason) || "Причина не указана" })),
      h("span", { class: "ps-row__what", "data-missing": missing.length ? "" : null, text: what }),
      note ? h("span", { class: "ps-row__note", text: note }) : null),
    h("span", { class: "ps-row__dur", text: d.open ? "идёт" : fmtDurMin(d.minutes) }));
}

function cardData(view) {
  const d = shiftDowntimes(view).find((x) => x.downtimeId === ui.card?.downtimeId);
  if (!d) return null;
  const s = d.segs.find((x) => x.index === ui.card.index) || d.segs.at(-1);
  return { d, s };
}

// Черновик правки записи: поля, которые мастер не менял, подтягивают свежие данные
function editorDraft(s) {
  const now = { note: s.note || "", action: s.action || "", billet: s.billet == null ? "" : String(s.billet).replace(".", ",") };
  let e = ui.edit;
  if (!e || e.downtimeId !== s.downtimeId || e.index !== s.index) {
    e = ui.edit = { downtimeId: s.downtimeId, index: s.index, base: { ...now }, ...now, billetOther: false };
  } else if (!e.base) {
    // Черновик перенесён из старой версии: исходные значения берём из записи, правки мастера остаются
    const mine = e.migrated || [];
    for (const f of ["note", "action", "billet"]) if (!mine.includes(f)) e[f] = now[f];
    e.base = { ...now };
    delete e.migrated;
  } else {
    for (const f of ["note", "action", "billet"]) if (e[f] === e.base[f]) e[f] = e.base[f] = now[f];
  }
  return e;
}
// Тонны: чипы 0 … 2, «Другое» открывает поле; значение хранится в черновике записи
function billetPicker(draft, onChange) {
  const input = h("input", { id: "edit-billet", class: "ps-input", type: "text", maxlength: "8", inputmode: "decimal", autocomplete: "off",
    placeholder: "Своё значение, тонн", "aria-label": "Брак в тоннах" });
  input.value = draft.billet;
  let other = draft.billetOther || (String(draft.billet).trim() !== "" && !BILLET_CHIPS.some((v) => sameTons(draft.billet, v)));
  const otherChip = h("button", { type: "button", class: "ps-chip", "aria-pressed": "false" }, "Другое");
  const chips = BILLET_CHIPS.map((v) => h("button", { type: "button", class: "ps-chip", "aria-pressed": "false",
    onclick: () => { other = false; draft.billetOther = false; input.value = ""; draft.billet = v; sync(); onChange(); } }, v));
  const sync = () => {
    chips.forEach((chip, i) => chip.setAttribute("aria-pressed", String(!other && sameTons(draft.billet, BILLET_CHIPS[i]))));
    otherChip.setAttribute("aria-pressed", String(other));
    input.hidden = !other;
  };
  otherChip.addEventListener("click", () => { other = true; draft.billetOther = true; draft.billet = input.value; sync(); onChange(); input.focus(); });
  input.addEventListener("input", () => { draft.billet = input.value; onChange(); });
  sync();
  return h("div", { class: "ps-chips" }, chips, otherChip, input);
}

// Редактор записи простоя: причина, что случилось, что сделали, брак. Время ставит система
function renderEditor(view, data) {
  const { d, s } = data;
  ui.card.index = s.index;
  const draft = editorDraft(s);
  const tile = (refs.tiles || []).find((t) => t.id === reasonGroup(s.reason)) || null;
  // Смена причины идёт теми же шагами мастера, что и у пульта: плитка → «Что именно?» → описание
  const openWizard = (t, item) => {
    ui.wz = { mode: "shiftfix", downtimeId: s.downtimeId, index: s.index, step: 1, group: reasonGroup(s.reason), reason: s.reason, note: s.note || "" };
    ui.wz.group = t.id;
    ui.wz.unknown = false;
    const items = reasonItems(t);
    if (item) { chooseReasonItem(ui.wz, t, item); ui.wz.step = 3; }
    else if (items.length === 1) { chooseReasonItem(ui.wz, t, items[0]); ui.wz.step = 3; }
    else ui.wz.step = 2;
    go("reason");
  };
  const noteMust = needsNote(s.reason);
  const note = h("textarea", { class: "ps-input", id: "edit-note", rows: "3", maxlength: String(NOTE_MAX), placeholder: noteHint(s.reason), "aria-label": "Что случилось" });
  note.value = draft.note;
  const action = h("textarea", { class: "ps-input", id: "edit-action", rows: "3", maxlength: String(NOTE_MAX), placeholder: actionHint(s.reason), "aria-label": "Что сделали" });
  action.value = draft.action;
  const error = h("p", { class: "ps-field__error" });
  error.hidden = true;
  const save = h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg" }, "Сохранить");
  const cancel = h("button", { type: "button", class: "ps-btn ps-btn--ghost ps-btn--lg" }, "Отмена");
  // Пустое поле не отправляем, кроме необязательного «Что случилось»: его можно стереть (сервер принимает note: "").
  // Если описание обязательно («иная причина»), очищенное считается неизменённым, как и у остальных полей
  const changed = () => ["note", "action", "billet"].filter((f) => {
    const now = String(draft[f]).trim();
    if (now === String(draft.base[f]).trim()) return false;
    return now !== "" || (f === "note" && !noteMust);
  });
  // Что мешает сохранить: пустое поле не отправляем, непустое проверяем так же, как раньше
  const problem = () => {
    const list = changed();
    if (list.includes("note") && noteMust && !validAction(draft.note)) return "Опишите своими словами, что случилось.";
    if (list.includes("action") && !validAction(draft.action)) return "Напишите, что сделали.";
    if (list.includes("billet") && !validBillet(draft.billet)) return "Укажите от 0 до 1000 тн.";
    return "";
  };
  let touched = false;
  const update = () => {
    const list = changed();
    save.disabled = !list.length;
    cancel.hidden = !list.length;
    const msg = touched ? problem() : "";
    error.textContent = msg;
    error.hidden = !msg;
  };
  note.addEventListener("input", () => { draft.note = note.value; touched = true; update(); });
  action.addEventListener("input", () => { draft.action = action.value; touched = true; update(); });
  cancel.addEventListener("click", () => { ui.edit = null; render(); });
  save.addEventListener("click", () => {
    if (problem()) { touched = true; update(); showToast(problem()); return; }
    const fresh = cardData(buildView());
    if (!fresh || fresh.s.downtimeId !== s.downtimeId || fresh.s.index !== s.index) {
      error.textContent = "Запись изменилась. Вернитесь к списку и проверьте её."; error.hidden = false; return;
    }
    const fields = {};
    for (const f of changed()) {
      const raw = String(draft[f]).trim();
      fields[f] = f === "billet" ? Number(raw.replace(",", ".")) : raw;
    }
    ui.edit = null;
    ui.screen = "detail";
    // Каждое поле — отдельное событие fix, как и раньше: сервер сверяет их поэтому по одному
    for (const [field, value] of Object.entries(fields)) send("fix", { downtimeId: s.downtimeId, index: s.index, [field]: value });
  });
  update();
  const parts = d.segs.length > 1 ? h("div", { class: "ps-chips", role: "group", "aria-label": "Часть простоя" }, d.segs.map((part) =>
    h("button", { type: "button", class: "ps-chip", "aria-pressed": String(part.index === s.index),
      onclick: () => { ui.card.index = part.index; ui.edit = null; render(); } },
    `${fmtClock(part.startMs)}–${part.open ? "сейчас" : fmtClock(part.endMs)} · ${reasonLabel(part.reason) || "Без причины"}`))) : null;
  const items = tile ? reasonItems(tile) : [];
  const receipt = receiptFor(d.downtimeId);
  return h("section", { class: "ps-card ps-editor", "aria-label": "Запись простоя" },
    h("div", { class: "ps-card__head" },
      h("h2", { class: "ps-card__title", text: `Простой ${fmtSince(d.startMs, view.shift)}–${d.endMs === null ? "сейчас" : fmtClock(d.endMs)}` }),
      h("span", { class: "ps-card__aside", text: d.open ? "идёт" : fmtDurMin(d.minutes) })),
    d.open ? h("p", { class: "ps-field__hint", text: "Ещё идёт. Заполнение записи не отмечает пуск." }) : null,
    parts,
    h("div", { class: "ps-form-row" },
      h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Стан встал" }), h("output", { class: "ps-readout", text: fmtSince(d.startMs, view.shift) })),
      h("div", { class: "ps-field" }, h("span", { class: "ps-field__label", text: "Стан пошёл" }), h("output", { class: "ps-readout", text: d.endMs === null ? "ещё стоит" : fmtClock(d.endMs) })),
      h("span", { class: "ps-field__hint", text: "Время ставит система." })),
    h("div", { class: "ps-field", role: "group", "aria-labelledby": "edit-reason-label" },
      h("span", { class: "ps-field__label", id: "edit-reason-label", text: "Причина" }),
      h("div", { class: "ps-chips" }, (refs.tiles || []).map((t) =>
        h("button", { type: "button", class: "ps-chip", "aria-pressed": String(!!tile && tile.id === t.id), onclick: () => openWizard(t) }, t.title))),
      h("span", { class: "ps-field__hint", text: reasonRef(s.reason) ? reasonLabel(s.reason) : "Причина не указана" })),
    items.length > 1 ? h("div", { class: "ps-field", role: "group", "aria-labelledby": "edit-item-label" },
      h("span", { class: "ps-field__label", id: "edit-item-label", text: "Уточнение" }),
      h("div", { class: "ps-chips" }, items.map((item) =>
        h("button", { type: "button", class: "ps-chip", "aria-pressed": String(core.reasonKey(item.code) === core.reasonKey(s.reason)), onclick: () => openWizard(tile, item) }, item.label)))) : null,
    h("div", { class: "ps-field" },
      h("label", { class: "ps-field__label", for: "edit-note", text: noteMust ? "Что случилось" : "Что случилось (по желанию)" }), note),
    h("div", { class: "ps-field" },
      h("label", { class: "ps-field__label", for: "edit-action", text: "Что сделали" }), action,
      h("span", { class: "ps-field__hint", text: d.open ? "Можно записать уже выполненную работу" : "Нужно заполнить до сдачи смены" })),
    h("div", { class: "ps-field", role: "group", "aria-labelledby": "edit-billet-label" },
      h("span", { class: "ps-field__label", id: "edit-billet-label", text: "Брак, тн" }),
      billetPicker(draft, update),
      h("span", { class: "ps-field__hint", text: "Если брака нет — 0" })),
    error,
    h("div", { class: "ps-actions" }, save, cancel),
    h("p", { class: "ps-field__hint", text: receipt.length ? receiptStatus(receipt) : "Запись из данных сервера" }));
}

function renderDowntimes(main, view, editing) {
  const sum = shiftSummary(view);
  const downMin = sum.downMinutes;
  const workMin = shiftWorkMin(view, downMin);
  const dts = shiftDowntimes(view);
  const gaps = handoverGaps(view);
  const data = editing ? cardData(view) : null;
  if (editing && !data) {
    return fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
      backBtn("К простоям смены", () => go("shift")), question("Записи нет в этой смене"),
      h("p", { text: "Возможно, смена уже закончилась или запись изменили. Проверьте итог текущей смены." })));
  }
  const head = screenHead(`${periodLabel(view.shift)} · ${crewTitle(view.crew?.crewId)}`, "Простои смены",
    h("button", { type: "button", class: "ps-btn ps-btn--secondary", onclick: () => startManualWizard("shift") }, icon("plus", "ps-ico"), "Забыли отметить простой"),
    editing ? "ps-head--list" : "");
  const kpis = h("div", { class: "ps-kpis" },
    h("div", { class: "ps-kpi", "data-kind": "work", "data-zero": workMin ? null : "" },
      h("span", { class: "ps-kpi__label" }, h("span", { class: "ps-swatch", "data-zone": "work", "aria-hidden": "true" }), "Работа"),
      h("span", { class: "ps-kpi__value", text: fmtHM(workMin) })),
    h("div", { class: "ps-kpi", "data-kind": "down", "data-zero": downMin ? null : "" },
      h("span", { class: "ps-kpi__label" }, h("span", { class: "ps-swatch", "data-zone": "unplanned", "aria-hidden": "true" }), "Простой"),
      h("span", { class: "ps-kpi__value", text: fmtHM(downMin) })));
  const list = h("div", { class: "ps-stack ps-dt-list" },
    view.open ? h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"),
      h("span", { class: "ps-notice__body", text: "Стан стоит. После сдачи смены простой продолжится у следующей смены. Пуск отмечать не нужно." })) : null,
    gaps.length ? h("div", { class: "ps-notice" }, icon("alert", "ps-ico"),
      h("span", { class: "ps-notice__body", text: `Нужно дополнить записи: ${gaps.length}. Откройте их ниже или сдайте смену с пометкой.` })) : null,
    kpis,
    psCard(dts.length ? `${dts.length} ${plural(dts.length, "простой", "простоя", "простоев")}` : "Простои", dts.length ? "нажмите, чтобы исправить" : "",
      dts.length ? h("div", { class: "ps-rows" }, dts.map((d) => downtimeRow(d, view.shift, !!data && data.d.downtimeId === d.downtimeId)))
        : h("p", { class: "ps-field__hint", text: "Простоев не было." })));
  const side = data ? renderEditor(view, data)
    : h("section", { class: "ps-card ps-editor-empty" }, h("p", { class: "ps-field__hint", text: "Выберите простой в списке: здесь можно указать причину, что сделали и брак." }));
  fill(main, h("div", { class: "ps-flow" },
    editing ? backBtn("К простоям смены", () => go("shift"), "ps-back-narrow") : null,
    head,
    h("div", { class: "ps-cols ps-cols--list", "data-editing": editing ? "" : null }, list, h("div", { class: "ps-stack ps-dt-editor" }, side)),
    h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg ps-btn--block ps-close-link", disabled: view.closed || !view.crew,
      onclick: () => { ui.closeReceipt = null; go("closeCheck"); } }, icon("clip", "ps-ico"), "Сдать смену")));
}

// Черновик «что сделали по ремонту» относится к своему простою и своей смене
function closeActionDraft(view) {
  const d = ui.closeAction;
  return d && d.key === stopShiftKey(view) && typeof d.text === "string" ? d.text : "";
}
function renderCloseConfirm(main, view) {
  const gaps = handoverGaps(view);
  const trouble = rejectionGroups(records).length;
  const receipt = records.filter((r) => ui.closeReceipt?.includes(r.event.id));
  // Пункты проверки: по одной записи на простой, переход — к первой незаполненной
  const byDowntime = (name) => [...new Map(gaps.filter((s) => s.missing.includes(name)).map((s) => [s.downtimeId, s])).values()];
  const noReason = byDowntime("причина");
  const noAction = byDowntime("что сделали");
  const noBillet = byDowntime("брак");
  const noOther = byDowntime("описание иной причины");
  const fix = (list) => ({ label: "Заполнить", onclick: () => openDetail(list[0].downtimeId, list[0].index) });
  const count = (list, what) => `${list.length} ${plural(list.length, "простой", "простоя", "простоев")} ${what}`;
  const extra = [...noBillet, ...noOther];
  const since = runningSince(view);
  // Открытый простой без причины тоже считается: причину можно выбрать, не дожидаясь пуска
  const openNoReason = !!view.open && !reasonRef(view.open.reason);
  const noReasonCount = noReason.length + (openNoReason ? 1 : 0);
  const fixReason = noReason.length ? fix(noReason) : { label: "Выбрать", onclick: () => {
    ui.wz = { mode: "current", downtimeId: view.open.downtimeId, step: 1, group: null, reason: null, note: "" };
    go("reason");
  } };
  const checks = h("ul", { class: "ps-checklist" },
    view.open ? checkItem(false, `Стан стоит с ${fmtSince(view.open.since ?? view.open.startMs, view.shift)}: простой перейдёт следующей смене, пуск отмечать не нужно`)
      : checkItem(true, Number.isFinite(since) ? `Все остановки закрыты — стан работает с ${fmtSince(since, view.shift)}` : "Все остановки закрыты"),
    checkItem(!noReasonCount, noReasonCount ? count({ length: noReasonCount }, "без причины") : "У каждого простоя есть причина", noReasonCount ? fixReason : null),
    checkItem(!noAction.length, noAction.length ? count(noAction, "без «что сделали»") : "Везде указано, что сделали", noAction.length ? fix(noAction) : null),
    checkItem(!extra.length, extra.length
      ? `Дополнить: ${[noBillet.length ? `брак (${noBillet.length})` : "", noOther.length ? `описание иной причины (${noOther.length})` : ""].filter(Boolean).join(", ")}`
      : "Брак и описания указаны", extra.length ? fix(extra) : null),
    checkItem(!trouble && !queue.length, trouble ? `Сервер не принял записей: ${trouble}. Они останутся на планшете для исправления`
      : queue.length ? `Ждут отправки: ${queue.length}` : "Все записи приняты сервером",
    trouble ? { label: "Показать", onclick: () => { ui.rejectsOpen = true; renderRejects(); renderTopbar(); } } : null));
  // Записка следующей смене — при любом состоянии стана
  let repairWork = null;
  {
    const ta = h("textarea", {
      class: "ps-input",
      id: "close-action",
      rows: "4",
      maxlength: String(NOTE_MAX),
      placeholder: "Например: сняли редуктор, ждём подшипник со склада",
      "aria-label": "Что сделали по ремонту за смену и что осталось",
    });
    ta.value = closeActionDraft(view);
    ta.addEventListener("input", () => { ui.closeAction = { key: stopShiftKey(view), text: ta.value }; });
    repairWork = psCard("Что сделали по ремонту за смену и что осталось?", "увидит следующая смена", ta,
      h("span", { class: "ps-field__hint", text: (view.open ? "Стан стоит, простой перейдёт следующей смене. " : "Необязательно. ") + "Можно надиктовать — кнопка микрофона на клавиатуре." }));
  }
  const status = receipt.length ? receiptStatus(receipt) : null;
  const { endMs } = view.shift;
  fill(main, h("div", { class: "ps-flow" },
    backBtn("К проверке состояния стана", () => go("closeCheck")),
    screenHead(`${periodLabel(view.shift)} · ${crewTitle(view.crew?.crewId)}`, "Сдача смены"),
    h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"),
      h("span", { class: "ps-notice__body" },
        h("span", { text: "Закрытие смены ещё не отправлено" }),
        status ? h("span", { class: "ps-notice__line", text: status }) : null,
        status === "Сохранено на планшете" ? h("span", { class: "ps-notice__line", text: "Запись уйдёт на сервер, когда появится связь." }) : null)),
    h("div", { class: "ps-cols" },
      h("div", { class: "ps-stack" }, psCard("Проверка перед сдачей", null, checks), repairWork),
      h("div", { class: "ps-stack" },
        psCard("Итоги смены", `до конца ${fmtDurMin((endMs - nowMs()) / 60000)}`, shiftKpis(view)),
        h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg ps-btn--block", disabled: !view.crew || view.closed,
          onclick: () => doCloseShift(gaps.length > 0 || trouble > 0) }, icon("clip", "ps-ico"), "Сдать смену"),
        h("p", { class: "ps-field__hint", text: "Сдать можно и с незаполненным пунктом — следующая смена увидит его в списке." })))));
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
  // Что сделали по ремонту: необязательно, при любом состоянии стана; пустое не отправляем
  const action = closeActionDraft(view).trim().slice(0, NOTE_MAX);
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
  const status = receiptStatus(list);
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    question(rejected ? "Закрытие смены нужно исправить" : "Смена закрыта"),
    h("div", { class: "ps-notice", "data-tone": rejected ? "stop" : status === "Принято сервером" ? "ok" : "info" }, icon(rejected ? "alert" : "tick", "ps-ico"),
      h("span", { class: "ps-notice__body" },
        h("span", { text: status }),
        status === "Сохранено на планшете" ? h("span", { class: "ps-notice__line", text: "Запись уйдёт на сервер, когда появится связь." }) : null)),
    info ? h("div", { class: "ps-kpis" },
      h("div", { class: "ps-kpi", "data-kind": "work", "data-zero": info.workMin ? null : "" },
        h("span", { class: "ps-kpi__label" }, h("span", { class: "ps-swatch", "data-zone": "work", "aria-hidden": "true" }), "Работа"),
        h("span", { class: "ps-kpi__value", text: fmtHM(info.workMin) })),
      h("div", { class: "ps-kpi", "data-kind": "down", "data-zero": info.downMin ? null : "" },
        h("span", { class: "ps-kpi__label" }, h("span", { class: "ps-swatch", "data-zone": "unplanned", "aria-hidden": "true" }), `Простои · ${info.stops}`),
        h("span", { class: "ps-kpi__value", text: fmtHM(info.downMin) }))) : null,
    info?.note ? h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"), h("span", { class: "ps-notice__body", text: info.note })) : null,
    info?.action ? psCard("Передали по ремонту", "", h("div", { class: "ps-notice", "data-tone": "info" }, icon("wrench", "ps-ico"),
      h("span", { class: "ps-notice__body", text: `«${info.action}»` }))) : null,
    info?.open ? h("p", { class: "ps-field__hint", text: "Следующий работник примет смену со стоящим станом. Простой продолжается." }) : null,
    h("button", { type: "button", class: "ps-btn ps-btn--primary ps-btn--lg", onclick: () => { ui.crewId = null; ui.crewBack = false; go("crew"); } }, "Принять смену")));
}

// Отклонённое событие хранится целиком, пока исправление не примет сервер.
function renderRepair(main, view) {
  const repair = ui.repair;
  if (!repair) return go("auto");
  const e = repair.event;
  const record = records.find((r) => r.event.id === repair.id);
  const group = groupFor(repair.id);
  // Строка «что исправить»: подпись и текущее значение, нажатие открывает поле
  const row = (label, value, onclick) => h("button", { type: "button", class: "ps-edit", onclick },
    h("span", { class: "ps-edit__label", text: label }), h("span", { class: "ps-edit__value", text: value || "Не указано" }));
  const choice = (field, label, value) => row(label, value, () => { repair.field = field; go("repairField"); });
  const replacement = records.findLast((r) => r.replaces === repair.id && r.status === "pending");
  const taken = group && takenFields(group);
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" },
    backBtn("Вернуться, не исправляя", () => go(repair.back === "repair" ? "auto" : repair.back || "auto")),
    screenHead(eventTitle(e), "Исправить запись"),
    h("div", { class: "ps-notice", "data-tone": "stop" }, icon("alert", "ps-ico"),
      h("span", { class: "ps-notice__body", text: group ? conflictMessage(group) : humanError(record?.error) })),
    group ? conflictAnswers(group) : null, group ? transferButton(group) : null,
    h("section", { class: "ps-card" },
      h("h2", { class: "ps-card__title", text: "Что исправить" }),
      h("div", { class: "ps-rows" },
        choice("at", e.type === "stop" ? "Исправить время остановки" : "Когда отметили", `${fmtDate(core.toMs(e.at))} ${fmtClock(core.toMs(e.at))} · МСК`),
        e.type === "manual" ? choice("from", "Когда стан встал", `${fmtDate(core.toMs(e.from))} ${fmtClock(core.toMs(e.from))}`) : null,
        e.type === "manual" ? choice("to", "Когда стан пошёл", `${fmtDate(core.toMs(e.to))} ${fmtClock(core.toMs(e.to))}`) : null,
        !["shift_open", "shift_close"].includes(e.type) ? row("Причина", reasonLabel(e.reason ?? group?.fields.reason) || "Не указана", () => {
          ui.wz = { mode: "repair", downtimeId: e.downtimeId, index: e.index, step: 1,
            reason: e.reason, group: reasonGroup(e.reason), note: e.note || "" };
          go("reason");
        }) : null,
        choice("note", e.type === "shift_close" ? "Пометка при закрытии смены" : "Что случилось", e.note ?? group?.fields.note),
        ["start", "manual", "fix"].includes(e.type) ? choice("action", "Что сделали", e.action) : null,
        ["manual", "fix"].includes(e.type) ? choice("billet", "Брак", e.billet == null ? "Не указан" : fmtTons(e.billet)) : null),
      e.type === "shift_open" ? psButton("secondary", "Выбрать работника", () => { ui.crewId = null; ui.crewBack = true; go("crew"); }, { lg: false }) : null),
    repair.error ? fieldError(repair.error) : null,
    replacement ? h("div", { class: "ps-notice", "data-tone": "info" }, icon("info", "ps-ico"),
      h("span", { class: "ps-notice__body", text: "Исправление сохранено на планшете и ждёт ответа сервера." })) : null,
    taken ? h("div", { class: "ps-notice", "data-tone": "stop" }, icon("alert", "ps-ico"),
      h("span", { class: "ps-notice__body", text: repair.confirmReplace
        ? "Ответы другого устройства будут стёрты и заменены вашими. Это нельзя отменить."
        : "Если отправить свои ответы, ответы другого устройства пропадут." })) : null,
    taken ? psButton("secondary", repair.confirmReplace ? "Да, заменить ответы устройства" : "Заменить ответы устройства",
      () => { if (repair.confirmReplace) { repair.confirmReplace = false; submitRepair(); } else { repair.confirmReplace = true; render(); } },
      { disabled: !!replacement })
      : psButton("primary", "Отправить исправление", submitRepair, { disabled: !!replacement }),
    taken ? psButton("ghost", "Убрать мою запись", () => dismissRejected([repair.id]), { lg: false }) : null));
}
function renderRepairField(main) {
  const repair = ui.repair;
  if (!repair) return go("auto");
  const { field, event: e } = repair;
  const time = ["at", "from", "to"].includes(field);
  const labels = { at: "Когда отметили?", from: "Когда стан встал?", to: "Когда стан пошёл?", note: e.type === "shift_close" ? "Пометка при закрытии смены" : "Что случилось?", action: "Что сделали?", billet: "Сколько брака, в тоннах?" };
  const input = time || field === "billet"
    ? h("input", { class: "ps-input", type: time ? "datetime-local" : "number", min: field === "billet" ? "0" : null, max: field === "billet" ? "1000" : null, step: field === "billet" ? "0.1" : null })
    : h("textarea", { class: "ps-input", rows: "4", maxlength: String(NOTE_MAX), placeholder: field === "action" ? actionHint(e.reason) : noteHint(e.reason) });
  input.value = time ? localTimeValue(core.toMs(e[field])) : e[field] ?? "";
  const error = fieldError();
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
  fill(main, h("div", { class: "ps-flow ps-flow--narrow" }, backBtn("К сохранённой записи", () => go("repair")),
    question(labels[field]),
    h("section", { class: "ps-card" },
      psField(labels[field], input, time ? "Дата и время по Москве. Меняйте время только если оно было указано неверно." : null)),
    error, psButton("primary", "Готово", () => {
      const value = time ? parseLocalTime(input.value) : field === "billet" ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
      if ((time && (!Number.isFinite(value) || value > nowMs())) || (field === "billet" && (!Number.isFinite(value) || value < 0 || value > 1000))) {
        error.textContent = time ? "Укажите прошедшее время." : "Укажите вес от 0 до 1000 тн."; error.hidden = false; return;
      }
      e[field] = time ? new Date(value).toISOString() : value;
      repair.invalid[field] = false;
      go("repair");
    })));
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
  for (const el of document.querySelectorAll(".ps-progress__fill[data-from]")) {
    const from = Number(el.dataset.from);
    el.style.width = `${Math.max(0, Math.min(100, ((now - from) / (Number(el.dataset.to) - from)) * 100)).toFixed(1)}%`;
  }
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
  const button = event.target.closest?.("button.primary, button.mill-btn, button.tile, button.ps-reason, button.ps-btn--primary, button.ps-btn--run");
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
  if (refs) render(); // без справочника экран перерисует сама загрузка: «Загружаем…», а не «Нет данных»
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
  // Новый service worker забирает страницу сам (skipWaiting + clients.claim): перезагружаемся один раз,
  // чтобы не остаться со старым app.js; черновики лежат в localStorage и перезагрузку переживают
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    try {
      // защита от цикла: после перезагрузки новая не раньше чем через минуту
      if (Date.now() - Number(sessionStorage.getItem("stan.swReload") || 0) < 60000) return;
      sessionStorage.setItem("stan.swReload", String(Date.now()));
    } catch { /* без sessionStorage защищает флаг reloaded */ }
    persistClient();
    location.reload();
  });
  navigator.serviceWorker.register("./sw.js")
    .then((reg) => reg.update())
    .catch(() => { /* офлайн-установка недоступна */ });
}

requestWake();
setInterval(loadState, STATE_POLL_MS);
setInterval(flush, QUEUE_RETRY_MS);
setInterval(tick, 1000);
boot();
