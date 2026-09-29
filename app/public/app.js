// Страница рабочего: учёт простоев стана. Чистый ES-модуль, без сборки.
import * as core from "/core/core.js";

const STORE_KEY = "stan.deviceKey";
const QUEUE_KEY = "stan.queue";
const REFS_KEY = "stan.refs";
const SEQ_KEY = "stan.seq";
const STATE_POLL_MS = 30_000;
const QUEUE_RETRY_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const LONG_STOP_MS = 4 * 3_600_000;

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

// --- Обращения к серверу (при ?mock=1 — имитация из mock.js) ---
let api = realApi;
async function realApi(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(path, {
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

const ui = {
  screen: "auto",      // auto | crew | shift
  crewId: null,        // выбранная бригада на экране приёма
  pickerGroup: null,   // открытая группа причин
  confirm: null,       // {reason} — выбор «Исправить / Причина сменилась»
  shiftView: "main",   // main | fix | manual | confirm
  fixTarget: null,     // {downtimeId, index}
  fixReason: undefined,
  fixBillet: undefined,
  manual: null,        // {from, to, reason}
  manualPickerGroup: null,
  fixPickerGroup: null,
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
function send(type, fields = {}) {
  // Кто нажал: бригада и человек из текущего приёма смены
  const who = type === "shift_open" ? null : buildView().crew;
  const e = {
    ...(who ? { crewId: who.crewId, personId: who.personId } : {}),
    id: crypto.randomUUID(),
    type,
    at: new Date(nowMs()).toISOString(),
    device: "web",
    seq: nextSeq(),
    ...fields,
  };
  queue.push(e);
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
  render();
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
  render();
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
      manual: false,
      open: false,
      pending: true,
    });
  };
  switch (e.type) {
    case "stop":
      if (!v.open) {
        v.open = { downtimeId: e.downtimeId || e.id, startMs: t, reason: e.reason ?? null, index: 0 };
        v.running = false;
      }
      break;
    case "reason":
      if (matchOpen()) v.open.reason = e.reason ?? null;
      break;
    case "split":
      if (matchOpen()) {
        closeOpen(t);
        v.open = { downtimeId: v.open.downtimeId, index: v.open.index + 1, startMs: t, reason: e.reason ?? null };
      }
      break;
    case "start":
      if (matchOpen()) {
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
        }
      }
      if (v.open && v.open.downtimeId === e.downtimeId && v.open.index === e.index && e.reason !== undefined) {
        v.open.reason = e.reason;
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
    const endMs = Math.min(s.open ? nowMs() : s.endMs, shift.endMs);
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

// --- Форматирование ---
const two = (n) => String(n).padStart(2, "0");
function fmtClock(ms) {
  const off = (refs && refs.settings && refs.settings.schedule && refs.settings.schedule.tzOffsetMinutes) ?? 180;
  const d = new Date(ms + off * 60000);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
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
        h("button", { class: "btn ghost", style: "min-height:44px;margin-top:4px", onclick: () => { ui.rejects = ui.rejects.filter((x) => x !== r); renderRejects(); } }, "Понятно"))
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
  if (ui.screen === "crew") return true;
  if (!view.crew || view.closed) return true;
  try {
    const at = core.shiftOf(view.crew.at, refs.settings.schedule);
    return !(at.day === view.shift.day && at.shiftNo === view.shift.shiftNo);
  } catch {
    return true;
  }
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
  if (needCrew(view)) return renderCrew(main, view);
  if (ui.screen === "shift") return renderShift(main, view);
  if (view.open) return renderStop(main, view);
  return renderRun(main, view);
}

function renderKey(main) {
  const input = h("input", { type: "password", autocomplete: "off", "aria-label": "Ключ устройства" });
  fill(main, 
    h("h1", { text: "Устройство не подключено" }),
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
    h("h1", { text: "Нет данных" }),
    h("p", { class: "muted", text: "Не удалось получить справочники. Проверьте связь." }),
    h("button", { class: "btn primary", onclick: () => { loadRefs().then((ok) => { if (ok) loadState(); else render(); }); } }, "Повторить")
  );
}

function renderLoading(main) {
  fill(main, 
    h("h1", { text: "Загрузка…" }),
    h("p", { class: "muted", text: "Запрашиваем состояние стана." })
  );
}

// 1. Приём смены
function renderCrew(main, view) {
  const crews = refs.crews || [];
  const kids = [h("h1", { text: "Приём смены" })];
  if (view) {
    kids.push(h("p", { class: "muted", text: `Смена ${view.shift.shiftNo}, до ${fmtClock(view.shift.endMs)}` }));
  }
  const single = crews.length === 1 ? crews[0].id : null;
  const chosen = ui.crewId || single;
  if (!chosen) {
    kids.push(h("div", { class: "tiles" },
      crews.map((c) => h("button", { class: "tile", onclick: () => { ui.crewId = c.id; render(); } }, c.title))
    ));
  } else {
    const people = (refs.people || []).filter((p) => p.crewId === chosen);
    if (!single) {
      kids.push(h("button", { class: "btn ghost", onclick: () => { ui.crewId = null; render(); } }, "Назад"));
    }
    kids.push(h("div", { class: "tiles" },
      people.map((p) => h("button", {
        class: "tile",
        onclick: () => {
          send("shift_open", { crewId: chosen, personId: p.id });
          ui.crewId = null;
          ui.screen = "auto";
        },
      }, p.name))
    ));
  }
  fill(main, ...kids);
}

// 2. Стан работает
function renderRun(main, view) {
  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  // Простой = один downtimeId, даже если причина менялась (split)
  const stops = new Set(
    view.segments
      .filter((s) => (s.open ? nowMs() : s.endMs) > view.shift.startMs && s.startMs < view.shift.endMs)
      .map((s) => s.downtimeId)
  ).size;
  const lastStart = view.segments.length
    ? Math.max(...view.segments.map((s) => (s.open ? nowMs() : s.endMs)))
    : view.shift.startMs;
  fill(main, 
    h("p", { class: "muted", text: `Работает: ${personName(view.crew.personId)}` }),
    h("p", { class: "muted", text: `Смена ${view.shift.shiftNo}, ${crewTitle(view.crew.crewId)}` }),
    h("button", { class: "btn ghost", onclick: () => { ui.screen = "crew"; render(); } }, "Сменить"),
    h("div", { class: "bar green" },
      "Стан работает",
      h("span", { class: "timer", dataset: { since: String(lastStart) } }, fmtTimer(nowMs() - lastStart))
    ),
    h("button", {
      class: "btn danger btn-huge",
      onclick: () => {
        send("stop", { downtimeId: crypto.randomUUID() });
      },
    }, "Стан встал"),
    h("p", { class: "muted", text: `Простоев за смену: ${stops}, всего ${fmtDurMin(downMin)}` }),
    h("button", { class: "btn", onclick: () => { ui.screen = "shift"; ui.shiftView = "main"; render(); } }, "Итог смены")
  );
}

// Выбор причины: плитки групп → причины группы. onPick(reason|null)
function reasonPicker(groupKey, setGroup, current, onPick) {
  if (!groupKey) {
    const tiles = (refs.tiles || []).map((t) =>
      h("button", { class: "tile", onclick: () => { setGroup(t.id); } }, t.title)
    );
    tiles.push(h("button", { class: "tile unknown", onclick: () => onPick(null) }, "Выясняем"));
    return h("div", { class: "tiles" }, tiles);
  }
  const tile = (refs.tiles || []).find((t) => t.id === groupKey);
  const codes = tile ? tile.codes : [];
  return h("div", null,
    h("button", { class: "btn ghost", onclick: () => setGroup(null) }, "Назад"),
    h("div", { class: "tiles" },
      codes.map((code) => {
        const r = reasonRef(code);
        return h("button", {
          class: "tile" + (code === current ? " sel" : ""),
          onclick: () => onPick(code),
        },
          r ? r.short || r.title : code,
          h("span", { class: "t-code", text: code })
        );
      })
    )
  );
}

// 3. Стан стоит
function renderStop(main, view) {
  const open = view.open;
  const elapsed = nowMs() - open.startMs;
  const cur = open.reason;
  const curRef = reasonRef(cur);

  const left = h("div", null,
    h("div", { class: "bar red" },
      `Стоит с ${fmtClock(open.startMs)}`,
      h("span", { class: "timer", dataset: { since: String(open.startMs) } }, fmtTimer(elapsed))
    ),
    elapsed > LONG_STOP_MS ? h("div", { class: "banner-warn", text: "Стан всё ещё стоит?" }) : null,
    h("button", { class: "btn primary btn-go", onclick: () => send("start", { downtimeId: open.downtimeId }) }, "Стан пошёл")
  );

  const chip = cur
    ? h("span", { class: "chip" }, reasonLabel(cur), " ", h("span", { class: "t-code", text: cur }))
    : h("span", { class: "chip none", text: "Причина не выбрана" });

  const right = h("div", null,
    h("h2", { text: "Почему стоит" }),
    chip
  );

  if (ui.confirm) {
    const target = ui.confirm.reason;
    right.append(
      h("p", { text: target ? `Новая причина: ${reasonLabel(target)}` : "Убрать причину (выясняем)" }),
      h("button", {
        class: "btn",
        onclick: () => { send("reason", { downtimeId: open.downtimeId, reason: target }); ui.confirm = null; },
      }, "Исправить — отрезок тот же"),
      h("button", {
        class: "btn",
        onclick: () => { send("split", { downtimeId: open.downtimeId, reason: target }); ui.confirm = null; },
      }, "Причина сменилась — новый отрезок"),
      h("button", { class: "btn ghost", onclick: () => { ui.confirm = null; render(); } }, "Отмена")
    );
  } else {
    right.append(reasonPicker(
      ui.pickerGroup,
      (g) => { ui.pickerGroup = g; render(); },
      cur,
      (code) => {
        if (code === cur || (code === null && !cur)) {
          ui.pickerGroup = null;
          render();
          return;
        }
        if (cur) {
          ui.confirm = { reason: code };
        } else {
          send("reason", { downtimeId: open.downtimeId, reason: code });
          ui.pickerGroup = null;
        }
        render();
      }
    ));
  }

  fill(main, h("div", { class: "stop-grid" }, left, right));
}

// 4. Итог смены
function renderShift(main, view) {
  if (ui.shiftView === "fix") return renderFix(main, view);
  if (ui.shiftView === "manual") return renderManual(main, view);
  if (ui.shiftView === "confirm") return renderConfirmClose(main, view);

  const sum = shiftSummary(view);
  const downMin = sum.plannedMinutes + sum.unplannedMinutes + sum.shortMinutes;
  const shift = view.shift;
  const segs = view.segments.filter((s) => (s.open ? nowMs() : s.endMs) > shift.startMs && s.startMs < shift.endMs);
  if (view.open && view.open.startMs < shift.endMs) {
    segs.push({ downtimeId: view.open.downtimeId, index: view.open.index, startMs: view.open.startMs, endMs: null, reason: view.open.reason, open: true, manual: false });
    segs.sort((a, b) => a.startMs - b.startMs || (a.index || 0) - (b.index || 0));
  }

  fill(main, 
    h("h1", { text: "Итог смены" }),
    h("p", { class: "muted", text: `Смена ${view.shift.shiftNo}, ${crewTitle(view.crew.crewId)}` }),
    h("div", { class: "stats" },
      h("div", { class: "stat good" }, "Работа", h("span", { class: "v", text: fmtDurMin(Math.max(0, Math.round((Math.min(nowMs(), shift.endMs) - shift.startMs) / 60000) - downMin)) })),
      h("div", { class: "stat bad" }, "Простои", h("span", { class: "v", text: fmtDurMin(downMin) })),
      h("div", { class: "stat planned" }, "Плановые", h("span", { class: "v", text: fmtDurMin(sum.plannedMinutes) })),
      h("div", { class: "stat bad" }, "Внеплановые", h("span", { class: "v", text: fmtDurMin(sum.unplannedMinutes + sum.shortMinutes) }))
    ),
    h("h2", { text: "Отрезки" }),
    segs.length
      ? h("div", { class: "segs" }, segs.map((s) => segRow(s, view)))
      : h("p", { class: "muted", text: "Простоев не было." }),
    h("button", {
      class: "btn",
      onclick: () => {
        const now = nowMs();
        ui.manual = { from: now - 15 * 60000, to: now, reason: undefined };
        ui.manualPickerGroup = null;
        ui.shiftView = "manual";
        render();
      },
    }, "Добавить пропущенный простой"),
    h("button", {
      class: "btn primary",
      onclick: () => {
        const noReason = segs.filter((s) => !s.reason).length;
        if (noReason > 0) {
          ui.shiftView = "confirm";
          render();
        } else {
          send("shift_close");
          ui.screen = "auto";
          ui.shiftView = "main";
        }
      },
    }, "Сдать смену"),
    h("button", { class: "btn ghost", onclick: () => { ui.screen = "auto"; ui.shiftView = "main"; render(); } }, "Назад")
  );
}

function segRow(s, view) {
  const endMs = s.open ? nowMs() : s.endMs;
  const minutes = Math.round((endMs - s.startMs) / 60000);
  const why = s.reason
    ? h("span", { class: "why" }, reasonLabel(s.reason), " ", h("span", { class: "t-code", text: s.reason }))
    : h("span", { class: "why" }, h("span", { class: "badge-need", text: "Нужна причина" }));
  return h("button", {
    class: "seg" + (s.open ? " open" : ""),
    onclick: () => {
      ui.fixTarget = { downtimeId: s.downtimeId, index: s.index };
      ui.fixReason = undefined;
      ui.fixBillet = undefined;
      ui.fixPickerGroup = null;
      ui.shiftView = "fix";
      render();
    },
  },
    h("span", { class: "when", text: fmtClock(s.startMs) }),
    h("span", null, why, s.manual ? h("span", { class: "manual-tag", text: "добавлен вручную" }) : null, s.billet != null ? h("span", { class: "manual-tag", text: `заготовка: ${String(s.billet).replace(".", ",")} т` }) : null),
    h("span", { class: "dur", text: s.open ? "идёт" : fmtDurMin(minutes) })
  );
}

// Исправление отрезка: причина + расход заготовки
function renderFix(main, view) {
  const t = ui.fixTarget;
  const seg = view.segments.find((s) => s.downtimeId === t.downtimeId && s.index === t.index);
  const current = ui.fixReason !== undefined ? ui.fixReason : seg ? seg.reason : null;
  const billet = ui.fixBillet !== undefined ? ui.fixBillet : seg ? seg.billet : undefined;

  const billetBtns = [0, 0.5, 1, 2, 5].map((v) =>
    h("button", {
      class: "btn" + (billet === v ? " sel" : ""),
      onclick: () => { ui.fixBillet = v; render(); },
    }, String(v).replace(".", ","))
  );
  const input = h("input", { type: "number", min: "0", step: "0.1", inputmode: "decimal", placeholder: "тонны", "aria-label": "Расход заготовки в тоннах" });
  if (billet !== undefined && billet !== null) input.value = String(billet);
  input.addEventListener("input", () => {
    const v = parseFloat(String(input.value).replace(",", "."));
    ui.fixBillet = Number.isFinite(v) && v >= 0 ? v : undefined;
  });

  const changed = ui.fixReason !== undefined || ui.fixBillet !== undefined;
  fill(main, 
    h("h1", { text: seg ? `Отрезок с ${fmtClock(seg.startMs)}` : "Отрезок" }),
    h("h2", { text: "Причина" }),
    reasonPicker(
      ui.fixPickerGroup,
      (g) => { ui.fixPickerGroup = g; render(); },
      current,
      (code) => { ui.fixReason = code; ui.fixPickerGroup = null; render(); }
    ),
    h("h2", { text: "Расход заготовки, т" }),
    h("div", { class: "billet-row" }, billetBtns),
    input,
    h("button", {
      class: "btn primary",
      disabled: !changed,
      onclick: () => {
        const fields = { downtimeId: t.downtimeId, index: t.index };
        if (ui.fixReason !== undefined) fields.reason = ui.fixReason;
        if (ui.fixBillet !== undefined) fields.billet = ui.fixBillet;
        send("fix", fields);
        ui.shiftView = "main";
      },
    }, "Сохранить"),
    h("button", { class: "btn ghost", onclick: () => { ui.shiftView = "main"; render(); } }, "Отмена")
  );
}

// Шаг ±5 мин / ±1 ч для момента времени
function timeStepper(label, value, onChange) {
  const steps = [[-60, "−1 ч"], [-5, "−5 мин"], [5, "+5 мин"], [60, "+1 ч"]];
  return h("div", null,
    h("h2", { text: label }),
    h("div", { class: "stepval", text: fmtClock(value) }),
    h("div", { class: "stepper" },
      steps.map(([d, txt]) => h("button", { class: "btn", onclick: () => onChange(value + d * 60000) }, txt))
    )
  );
}

// Добавление пропущенного простоя
function renderManual(main, view) {
  const m = ui.manual;
  const bad = !(m.to > m.from);
  fill(main, 
    h("h1", { text: "Пропущенный простой" }),
    timeStepper("Начало", m.from, (v) => { m.from = v; render(); }),
    timeStepper("Конец", m.to, (v) => { m.to = v; render(); }),
    bad ? h("p", { class: "error-text", text: "Начало должно быть раньше конца." }) : null,
    h("h2", { text: "Причина" }),
    reasonPicker(
      ui.manualPickerGroup,
      (g) => { ui.manualPickerGroup = g; render(); },
      m.reason,
      (code) => { m.reason = code; ui.manualPickerGroup = null; render(); }
    ),
    h("button", {
      class: "btn primary",
      disabled: bad,
      onclick: () => {
        send("manual", {
          downtimeId: crypto.randomUUID(),
          from: new Date(m.from).toISOString(),
          to: new Date(m.to).toISOString(),
          reason: m.reason ?? null,
        });
        ui.shiftView = "main";
      },
    }, "Сохранить"),
    h("button", { class: "btn ghost", onclick: () => { ui.shiftView = "main"; render(); } }, "Отмена")
  );
}

function renderConfirmClose(main, view) {
  const shift = view.shift;
  const noReason = view.segments.filter((s) => !s.reason && (s.open ? nowMs() : s.endMs) > shift.startMs && s.startMs < shift.endMs).length
    + (view.open && !view.open.reason ? 1 : 0);
  fill(main, 
    h("h1", { text: "Сдать смену?" }),
    h("p", { class: "error-text", text: `Без причины осталось отрезков: ${noReason}.` }),
    h("button", {
      class: "btn primary",
      onclick: () => {
        send("shift_close");
        ui.screen = "auto";
        ui.shiftView = "main";
      },
    }, "Сдать смену"),
    h("button", { class: "btn ghost", onclick: () => { ui.shiftView = "main"; render(); } }, "Отмена")
  );
}

// --- Тики часов на экране ---
function tick() {
  const now = nowMs();
  for (const el of document.querySelectorAll("[data-since]")) {
    el.textContent = fmtTimer(now - Number(el.dataset.since));
  }
  // Простой перевалил за 4 часа — перерисовать с плашкой
  if (serverState && refs) {
    const view = buildView();
    if (view && view.open && now - view.open.startMs > LONG_STOP_MS && !document.querySelector(".banner-warn") && ui.screen !== "shift") {
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

// Имитация сервера для проверки: только при ?mock=1
if (new URLSearchParams(location.search).has("mock")) {
  const m = await import("/mock.js");
  api = m.api;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* офлайн-установка недоступна */ });
}

requestWake();
setInterval(loadState, STATE_POLL_MS);
setInterval(flush, QUEUE_RETRY_MS);
setInterval(tick, 1000);
boot();
