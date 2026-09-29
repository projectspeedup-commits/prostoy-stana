// Страница пробы связи: раз в минуту шлёт пинг и показывает итоги.
const STORE_KEY = "stan.deviceKey";
const STATS_KEY = "stan.probeStats";
const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 30_000;

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

function loadStats() {
  try {
    const s = JSON.parse(readStore(STATS_KEY));
    if (s && typeof s.total === "number") return s;
  } catch { /* пусто или повреждено */ }
  return { total: 0, ok: 0, lastOkAt: null, longestGapMs: 0 };
}
let stats = loadStats();
let prev = { ms: null, ok: null };

function fmtGap(ms) {
  const min = ms / 60_000;
  if (min < 1) return "нет";
  return min < 60 ? `${Math.round(min)} мин` : `${Math.floor(min / 60)} ч ${Math.round(min % 60)} мин`;
}

function render(state) {
  const box = $("state");
  box.className = "state " + (state === "ok" ? "ok" : state === "bad" ? "bad" : "wait");
  box.textContent = state === "ok" ? "Связь есть" : state === "bad" ? "Связи нет" : "Ожидание";
  $("total").textContent = String(stats.total);
  $("share").textContent = stats.total ? Math.round((stats.ok / stats.total) * 100) + " %" : "—";
  $("gap").textContent = fmtGap(stats.longestGapMs);
  $("last").textContent = stats.lastOkAt ? new Date(stats.lastOkAt).toLocaleTimeString("ru-RU") : "—";
}

async function probe() {
  const key = readStore(STORE_KEY);
  if (!key) return;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let ok = false;
  try {
    const r = await fetch("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Key": key },
      body: JSON.stringify({ clientAt: new Date(started).toISOString(), prevMs: prev.ms, prevOk: prev.ok }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    ok = r.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  const ended = Date.now();
  prev = { ms: ended - started, ok };
  stats.total += 1;
  if (ok) {
    stats.ok += 1;
    if (stats.lastOkAt) stats.longestGapMs = Math.max(stats.longestGapMs, ended - stats.lastOkAt);
    stats.lastOkAt = ended;
  }
  writeStore(STATS_KEY, JSON.stringify(stats));
  render(ok ? "ok" : "bad");
}

// Не даём экрану погаснуть, если браузер умеет.
let wakeLock = null;
async function requestWake() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* отказ — не критично */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !wakeLock) requestWake();
});

function start() {
  $("keyBox").hidden = true;
  $("work").hidden = false;
  render("wait");
  requestWake();
  probe();
  setInterval(probe, INTERVAL_MS);
}

takeKeyFromHash();
$("reset").addEventListener("click", () => {
  stats = { total: 0, ok: 0, lastOkAt: null, longestGapMs: 0 };
  writeStore(STATS_KEY, JSON.stringify(stats));
  render("wait");
});
$("keySave").addEventListener("click", () => {
  const v = $("keyInput").value.trim();
  if (!v) return;
  writeStore(STORE_KEY, v);
  start();
});
if (readStore(STORE_KEY)) start();
else $("keyBox").hidden = false;
