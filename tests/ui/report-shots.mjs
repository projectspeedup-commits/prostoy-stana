// Проверка кнопки «Отчёт в Excel» в настоящем Chrome: раскладка на 320–2560 px, обе темы, стан работает
// и стоит, панель периода (клавиатура, щелчок мимо, перерисовка по таймеру), скачивание файла
// с русским именем, ошибки, офлайн, демо. Снимки — в --out.
//
//   node tests/ui/report-shots.mjs --data <папка с stan.db и settings.json> --out <папка для снимков> [--port 8321]
//
// Копию данных скрипт делает сам, исходную папку не трогает. Сервер поднимается отдельным процессом:
//   PORT=… HOST=127.0.0.1 STAN_DATA_DIR=<копия> STAN_DEVICE_KEYS=post:1111,master:2222,owner:3333 node app/server/index.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startChrome, sleep } from "./cdp.js";
import { readXlsx } from "../helpers/xlsx-read.js";
import { presetRange } from "../../app/core/report-period.js";
import { durationWords } from "../../app/core/report.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : fallback; };
const DATA = arg("data");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "stan-report-shots")));
const PORT = Number(arg("port", 8321));
const KEYS = "post:1111,master:2222,owner:3333";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.STAN_TEST_PYTHON || "C:\\Users\\trush\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
if (!DATA || !fs.existsSync(path.join(DATA, "stan.db"))) {
  console.error("Нужен --data: папка с stan.db и settings.json (копия данных, не боевые)");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const DOWNLOADS = path.join(OUT, "downloads");
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const results = { checks: [], measures: [], notes: [] };
function check(ok, message, detail) {
  results.checks.push({ ok: !!ok, message, ...(detail === undefined ? {} : { detail }) });
  if (!ok) console.log("  ✖ " + message + (detail === undefined ? "" : " " + JSON.stringify(detail)));
}

// ---------- Сервер на копии данных ----------
const dataCopy = fs.mkdtempSync(path.join(os.tmpdir(), "stan-ui-data-"));
for (const name of fs.readdirSync(DATA)) {
  if (/^(stan\.db(-wal|-shm)?|settings\.json)$/.test(name)) fs.copyFileSync(path.join(DATA, name), path.join(dataCopy, name));
}
const server = spawn(process.execPath, ["app/server/index.js"], {
  cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", STAN_DATA_DIR: dataCopy, STAN_DEVICE_KEYS: KEYS },
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
async function api(pathname, { key = "1111", method = "GET", body } = {}) {
  const response = await fetch(ORIGIN + pathname, { method, headers: { "X-Device-Key": key, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => null) };
}
async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(ORIGIN + "/api/health")).ok) return; } catch { /* ещё не слушает */ }
    await sleep(100);
  }
  throw new Error("Сервер не поднялся:\n" + serverLog);
}

let uid = 0;
const newId = () => `ui-${Date.now()}-${++uid}`;
async function ensureCrew() {
  const { json } = await api("/api/state");
  const { shift, crew, closed } = json.state;
  const inShift = crew && Date.parse(crew.at) >= shift.startMs && Date.parse(crew.at) < shift.endMs;
  if (inShift && !closed) return;
  const refs = (await api("/api/refs")).json.refs;
  const person = refs.people.find((p) => p.crewId === String(shift.shiftNo)) || refs.people[0];
  const r = await api("/api/events", { method: "POST", body: { events: [{ id: newId(), type: "shift_open", at: new Date().toISOString(), crewId: person.crewId, personId: person.id, personName: person.name }] } });
  check(r.json.rejected.length === 0, "приём смены для проверки принят", r.json.rejected);
}
async function ensureMill(running) {
  const { json } = await api("/api/state");
  if (running === json.state.running) return;
  const at = new Date().toISOString();
  const events = running
    ? [{ id: newId(), type: "start", at, downtimeId: json.state.open.downtimeId }]
    : [{ id: newId(), type: "stop", at, downtimeId: newId() }];
  const r = await api("/api/events", { method: "POST", body: { events } });
  check(r.json.rejected.length === 0, `стан переведён в состояние «${running ? "работает" : "стоит"}»`, r.json.rejected);
}

// ---------- Страница ----------
const chrome = await startChrome({ profileRoot: os.tmpdir() });
const downloads = [];
chrome.browser.on((m) => {
  if (m.method === "Browser.downloadWillBegin") downloads.push({ guid: m.params.guid, name: m.params.suggestedFilename, url: m.params.url, state: "begun" });
  if (m.method === "Browser.downloadProgress") {
    const d = downloads.find((x) => x.guid === m.params.guid);
    if (d && m.params.state !== "inProgress") d.state = m.params.state;
  }
});
const E = (expression) => chrome.evaluate(expression);
const stateName = (running) => (running ? "running" : "stopped");
const safeName = (s) => s.replace(/[^\w.-]+/g, "_");

async function setTheme(want) {
  if ((await E("document.documentElement.dataset.theme")) !== want) await chrome.clickElement("#theme");
  await sleep(100);
}
async function waitButton(what = "кнопка отчёта") {
  await chrome.waitFor("!!document.querySelector('.mill-status') && !!document.querySelector('.rep-btn')", { what, timeout: 15000 });
}
async function setValue(selector, value) {
  await E(`(() => { const f = document.querySelector(${JSON.stringify(selector)}); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

// Измерения полосы состояния: рост высоты из-за кнопки, переполнение, перекрытия
const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
  const strip = q('.mill-status'), rep = q('.rep'), btn = q('.rep-btn'), label = q('.rep-label'), clock = q('.mill-clock'), state = q('.mill-state'), main = q('#main');
  if (!strip || !rep) return { missing: true };
  const withBtn = strip.getBoundingClientRect().height;
  const mainWith = main.scrollHeight;
  const pageWith = document.documentElement.scrollHeight;
  const scrollWWith = document.documentElement.scrollWidth;
  rep.style.display = 'none';
  const without = strip.getBoundingClientRect().height;
  const mainWithout = main.scrollHeight;
  const pageWithout = document.documentElement.scrollHeight;
  const scrollWWithout = document.documentElement.scrollWidth;
  rep.style.display = '';
  const s = rect(strip), b = rect(btn), c = rect(clock), st = rect(state);
  const overlap = (a, o) => a.x < o.r - 0.5 && o.x < a.r - 0.5 && a.y < o.b - 0.5 && o.y < a.b - 0.5;
  return {
    innerWidth, innerHeight, clientW: document.documentElement.clientWidth, scrollW: scrollWWith, scrollWWithout, bodyScrollW: document.body.scrollWidth,
    strip: s, stripWith: withBtn, stripWithout: without, btn: b, labelShown: getComputedStyle(label).display !== 'none',
    containerWidth: strip.parentElement.getBoundingClientRect().width,
    btnInsideStrip: b.x >= s.x - 0.5 && b.r <= s.r + 0.5 && b.y >= s.y - 0.5 && b.b <= s.b + 0.5,
    btnOverlapsClock: overlap(b, c), btnOverlapsState: overlap(b, st),
    stripOverflowX: strip.scrollWidth > strip.clientWidth + 1, titleOverflow: state.scrollWidth > state.clientWidth + 1,
    mainGrew: mainWith - mainWithout, pageGrew: pageWith - pageWithout,
    ariaLabel: btn.getAttribute('aria-label'), title: btn.title, btnW: b.w, btnH: b.h,
    fit: matchMedia('(min-width:1100px) and (min-height:600px) and (orientation: landscape)').matches,
  };
})()`;
const PANEL = `(() => {
  const panel = document.querySelector('.rep-panel');
  const p = panel.getBoundingClientRect();
  const main = document.querySelector('#main');
  const inset = 22;
  const points = [[p.x + inset, p.y + inset], [p.right - inset, p.y + inset], [p.x + inset, p.bottom - inset], [p.right - inset, p.bottom - inset], [p.x + p.width / 2, p.y + p.height / 2]];
  const covered = points.filter(([x, y]) => { const e = document.elementFromPoint(x, y); return !(e && panel.contains(e)); }).length;
  return { hidden: panel.hidden, x: p.x, y: p.y, w: p.width, h: p.height, r: p.right, b: p.bottom, innerWidth, innerHeight,
    scrollW: document.documentElement.scrollWidth, covered, mainScroll: main.scrollHeight - main.clientHeight, panelScroll: panel.scrollHeight - panel.clientHeight,
    font: getComputedStyle(panel).fontSize };
})()`;

async function openPanel() {
  if (await E("document.querySelector('.rep-panel').hidden")) await chrome.clickElement(".rep-btn");
  await chrome.waitFor("!document.querySelector('.rep-panel').hidden", { what: "панель открылась" });
  await sleep(80);
}
async function closePanel() {
  if (!(await E("document.querySelector('.rep-panel').hidden"))) await chrome.key("Escape", "Escape", 27);
  await sleep(60);
}

async function layoutRun(label, w, h, { shot = false } = {}) {
  await chrome.viewport(w, h);
  await sleep(100);
  await closePanel();
  const m = await E(MEASURE);
  if (m.missing) { check(false, `${label}: нет полосы состояния или кнопки`); return; }
  results.measures.push({ label, w, h, stage: "closed", ...m });
  check(m.scrollW <= m.scrollWWithout, `${label}: кнопка не добавила горизонтальной прокрутки`, { with: m.scrollW, without: m.scrollWWithout });
  // Ширину сравниваем с областью без полосы прокрутки (clientWidth): прокрутка, что была и без кнопки, — отдельная находка
  if (m.scrollWWithout > m.clientW) results.notes.push({ baselineOverflow: label, scrollW: m.scrollWWithout, clientWidth: m.clientW, innerWidth: m.innerWidth });
  else check(m.scrollW <= m.clientW, `${label}: нет горизонтальной прокрутки`, { scrollW: m.scrollW, clientWidth: m.clientW });
  check(Math.abs(m.stripWith - m.stripWithout) < 0.6, `${label}: полоса не выросла в высоту`, { with: m.stripWith, without: m.stripWithout });
  check(m.mainGrew <= 0 && m.pageGrew <= 0, `${label}: кнопка не прибавила высоты экрану`, { main: m.mainGrew, page: m.pageGrew });
  check(m.btnInsideStrip, `${label}: кнопка внутри полосы`);
  check(!m.btnOverlapsClock && !m.btnOverlapsState, `${label}: кнопка не налезает на состояние и часы`);
  check(!m.stripOverflowX, `${label}: полоса без переполнения по ширине`);
  check(m.ariaLabel === "Скачать отчёт в Excel" && m.title === "Скачать отчёт в Excel", `${label}: aria-label и title кнопки`);
  check(m.btnH >= (m.fit ? 20 : 44), `${label}: кнопка не мельче допустимого`, { h: m.btnH });
  if (shot) await chrome.screenshot(path.join(OUT, `${safeName(label)}-closed.png`));
  await openPanel();
  const p = await E(PANEL);
  results.measures.push({ label, w, h, stage: "open", ...p });
  check(!p.hidden, `${label}: панель раскрыта`);
  check(p.x >= -0.5 && p.r <= p.innerWidth + 0.5 && p.y >= -0.5 && p.b <= p.innerHeight + 0.5, `${label}: панель целиком в экране`, { x: p.x, y: p.y, r: p.r, b: p.b, innerWidth: p.innerWidth, innerHeight: p.innerHeight });
  check(p.scrollW <= Math.max(m.clientW, m.scrollWWithout), `${label}: с панелью нет новой горизонтальной прокрутки`, { scrollW: p.scrollW });
  check(p.covered === 0, `${label}: панель поверх пульта и шкалы, ничто её не перекрывает`, { covered: p.covered });
  check(p.mainScroll <= 1, `${label}: панель не вызывает прокрутку главной области`, { mainScroll: p.mainScroll });
  check(p.panelScroll <= 1, `${label}: панель помещается без внутренней прокрутки`, { panelScroll: p.panelScroll });
  if (w <= 480) check(p.w >= m.strip.w - 1, `${label}: на телефоне панель во всю ширину полосы`, { panel: p.w, strip: m.strip.w });
  const after = await E(MEASURE);
  check(Math.abs(after.stripWith - m.stripWith) < 0.6, `${label}: открытая панель не меняет высоту полосы`, { before: m.stripWith, after: after.stripWith });
  if (shot) await chrome.screenshot(path.join(OUT, `${safeName(label)}-open.png`));
  await closePanel();
}

// ---------- Ход проверки ----------
let exitCode = 0;
try {
  await waitServer();
  await ensureCrew();
  await ensureMill(false);

  // Вход: ключ вводится в поле приложения (локальный тестовый сервер, ключ из задания)
  await chrome.navigate(ORIGIN + "/");
  await chrome.viewport(1280, 800);
  await chrome.waitFor("!!document.querySelector('input[type=password]')", { what: "экран ключа" });
  await E("document.querySelector('input[type=password]').focus()");
  await chrome.send("Input.insertText", { text: "3333" });
  await chrome.clickElement("button.btn.primary");
  await waitButton("кнопка отчёта после входа");
  await E("navigator.serviceWorker.ready.then(() => true)");
  await chrome.reload();
  await waitButton("кнопка отчёта после перезагрузки");
  await setTheme("light");

  // Офлайн-кеш: новые файлы лежат в кеше service worker
  await sleep(1500);
  const cached = await E(`(async () => { const out = []; for (const n of await caches.keys()) { const c = await caches.open(n); out.push(...(await c.keys()).map((r) => new URL(r.url).pathname)); } return out; })()`);
  for (const file of ["/report-ui.js", "/report.css", "/core/report-period.js", "/core/report.js", "/core/xlsx.js"]) {
    check(cached.includes(file), `офлайн-кеш содержит ${file}`);
  }

  // Обязательные экраны, обе темы, оба состояния стана, и частые ширины 320–2560
  const REQUIRED = [[375, 812], [768, 1024], [1100, 700], [1920, 1080], [1080, 1920]];
  const SWEEP = [[320, 568], [360, 640], [390, 844], [412, 915], [480, 800], [540, 900], [600, 960], [700, 900], [820, 1180], [900, 700], [1024, 768],
    [1099, 700], [1100, 600], [1100, 599], [1180, 820], [1280, 720], [1366, 768], [1440, 900], [1536, 864], [2560, 1440], [1440, 2560]];
  for (const running of [false, true]) {
    await ensureMill(running);
    await chrome.reload();
    await waitButton("кнопка после смены состояния");
    await chrome.waitFor(`document.querySelector('.mill-status').classList.contains('${running ? "is-run" : "is-stop"}')`, { what: "состояние стана на экране" });
    for (const t of ["light", "dark"]) {
      await setTheme(t);
      console.log(`Состояние: ${stateName(running)}, тема: ${t}`);
      for (const [w, h] of REQUIRED) await layoutRun(`${w}x${h}-${t}-${stateName(running)}`, w, h, { shot: true });
      for (const [w, h] of SWEEP) await layoutRun(`sweep ${w}x${h} ${t} ${stateName(running)}`, w, h);
    }
  }

  // Поведение панели: стан стоит, светлая тема, ширина монитора
  await ensureMill(false);
  await chrome.reload();
  await waitButton();
  await setTheme("light");
  await chrome.viewport(1280, 800);
  await openPanel();
  // По умолчанию в полях — текущие производственные сутки; выбрать можно до сегодняшней даты по МСК включительно
  const today = await E("document.querySelector('#rep-from').value");
  const maxDay = await E("document.querySelector('.rep-date').max");
  check(/^\d{4}-\d{2}-\d{2}$/.test(today) && /^\d{4}-\d{2}-\d{2}$/.test(maxDay) && maxDay >= today, "поля дат: по умолчанию текущие сутки, предел — последняя доступная дата", { today, maxDay });
  check((await E("document.querySelector('.rep-title').textContent")) === "Отчёт в Excel", "заголовок панели «Отчёт в Excel»");
  const chips = await E("[...document.querySelectorAll('.rep-chip')].map((c) => c.textContent)");
  check(JSON.stringify(chips) === JSON.stringify(["Сегодня", "Вчера", "7 дней", "Этот месяц", "Прошлый месяц"]), "быстрый выбор: пять вариантов", chips);
  check((await E("document.querySelector('.rep-hint').textContent")) === "Сутки считаются с 08:00 до 08:00 МСК", "подсказка про сутки");
  check((await E("[...document.querySelectorAll('.rep-field-name')].map((e) => e.textContent).join('|')")) === "С|По", "поля дат «С» и «По»");
  check((await E("document.querySelector('#rep-from').value + '|' + document.querySelector('#rep-to').value")) === `${today}|${today}`, "по умолчанию в обоих полях сегодняшние сутки");
  check((await E("document.querySelector('.rep-go').textContent.trim()")) === "Скачать", "кнопка «Скачать»");
  for (const [id, label] of [["yesterday", "Вчера"], ["week", "7 дней"], ["month", "Этот месяц"], ["prevMonth", "Прошлый месяц"], ["today", "Сегодня"]]) {
    await chrome.clickText(".rep-chip", label);
    const want = presetRange(id, today);
    const got = await E("document.querySelector('#rep-from').value + '|' + document.querySelector('#rep-to').value");
    check(got === `${want.from}|${want.to}`, `быстрый выбор «${label}»`, { got, want });
    check(JSON.stringify(await E("[...document.querySelectorAll('.rep-chip.on')].map((c) => c.textContent)")) === JSON.stringify([label]), `«${label}» подсвечен, и только он`);
  }

  // Esc, щелчок мимо, повторное нажатие
  await chrome.key("Escape", "Escape", 27);
  check(await E("document.querySelector('.rep-panel').hidden"), "Esc закрывает панель");
  check(await E("document.activeElement === document.querySelector('.rep-btn')"), "после Esc фокус на кнопке");
  await openPanel();
  await chrome.mouse(1280 - 5, 800 - 5);
  check(await E("document.querySelector('.rep-panel').hidden"), "щелчок мимо закрывает панель");
  await chrome.clickElement(".rep-btn");
  check(!(await E("document.querySelector('.rep-panel').hidden")), "нажатие открывает панель");
  check((await E("document.querySelector('.rep-btn').getAttribute('aria-expanded')")) === "true", "aria-expanded=true у открытой");
  await chrome.clickElement(".rep-btn");
  check(await E("document.querySelector('.rep-panel').hidden"), "повторное нажатие закрывает панель");
  check((await E("document.querySelector('.rep-btn').getAttribute('aria-expanded')")) === "false", "aria-expanded=false у закрытой");
  await openPanel();
  await chrome.clickElement(".rep-title");
  check(!(await E("document.querySelector('.rep-panel').hidden")), "нажатие внутри панели её не закрывает");
  await chrome.clickElement(".rep-close");
  check(await E("document.querySelector('.rep-panel').hidden"), "крестик закрывает панель");

  // Панель переживает перерисовку страницы по таймеру и держит выбранные даты
  await openPanel();
  await setValue("#rep-from", "2026-09-30");
  await E("document.activeElement && document.activeElement.blur()");
  await E("document.dispatchEvent(new Event('visibilitychange'))");
  await sleep(900);
  check(!(await E("document.querySelector('.rep-panel').hidden")), "перерисовка по таймеру не закрывает панель");
  check((await E("document.querySelector('#rep-from').value")) === "2026-09-30", "выбранная дата сохраняется при перерисовке");
  // Уход с экрана пульта закрывает панель
  await chrome.clickText(".shift-action", "Простои за смену");
  await chrome.waitFor("!document.querySelector('.rep-btn')", { what: "экран смены без пульта" });
  await sleep(450); // защита от двойного касания гасит нажатия в первые 400 мс после смены экрана
  await E("document.querySelector('#demo').click()");
  await waitButton("возврат на пульт");
  check(await E("document.querySelector('.rep-panel').hidden"), "после ухода с экрана панель не появляется сама");

  // Сообщения о неверном периоде (проверка на странице)
  await openPanel();
  await setValue("#rep-from", "");
  await chrome.clickElement(".rep-go");
  check((await E("document.querySelector('.rep-error').textContent")) === "Укажите период: даты «С» и «По».", "пустая дата: сообщение в панели");
  await setValue("#rep-from", "2026-10-05");
  await setValue("#rep-to", "2026-10-01");
  await chrome.clickElement(".rep-go");
  check(/не может быть позже даты «По»/.test(await E("document.querySelector('.rep-error').textContent")), "С позже По: сообщение в панели");
  await chrome.screenshot(path.join(OUT, "panel-error-client.png"));

  // Сообщение сервера при 400 показывается в панели как есть
  await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "*api/report.xlsx*" }] });
  const intercepted = [];
  let intercepting = true;
  chrome.tab.on((m) => {
    if (!intercepting || m.method !== "Fetch.requestPaused") return;
    intercepted.push(m.params.request.url);
    chrome.send("Fetch.fulfillRequest", {
      requestId: m.params.requestId, responseCode: 400,
      responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
      body: Buffer.from(JSON.stringify({ ok: false, error: "bad_request", message: "Сообщение сервера: период нельзя." })).toString("base64"),
    }).catch(() => {});
  });
  await setValue("#rep-from", today);
  await setValue("#rep-to", today);
  await chrome.clickElement(".rep-go");
  await chrome.waitFor("document.querySelector('.rep-error').textContent.includes('Сообщение сервера')", { what: "сообщение сервера в панели" });
  check(intercepted.some((u) => u.includes(`from=${today}&to=${today}`)), "на сервер ушёл запрос с периодом", intercepted);
  check(!(await E("document.querySelector('.rep-go').disabled")), "после ошибки кнопка снова активна");
  intercepting = false;
  await chrome.send("Fetch.disable");

  // Скачивание за «Сегодня»: «Готовлю файл…», файл с русским именем, содержимое
  await chrome.browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS, eventsEnabled: true });
  await chrome.clickText(".rep-chip", "Сегодня");
  await chrome.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
  await chrome.clickElement(".rep-go");
  await sleep(300);
  check((await E("document.querySelector('.rep-go').textContent.trim()")) === "Готовлю файл…" && (await E("document.querySelector('.rep-go').disabled")),
    "пока файл готовится: кнопка неактивна, текст «Готовлю файл…»");
  await chrome.screenshot(path.join(OUT, "panel-busy.png"));
  for (let i = 0; i < 100 && !downloads.some((d) => d.state === "completed"); i++) await sleep(100);
  await chrome.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const done = downloads.find((d) => d.state === "completed");
  check(!!done, "файл скачан (Chrome сообщил о завершении)", downloads);
  const prefix = `Отчёт по простоям стана за ${today.slice(8)}.${today.slice(5, 7)}.${today.slice(0, 4)}, скачан `;
  check(done && done.name.startsWith(prefix) && /в \d\d-\d\d\.xlsx$/.test(done.name), "имя файла — по-русски, с датой и временем скачивания (МСК)", done && done.name);
  const saved = fs.readdirSync(DOWNLOADS);
  check(saved.length === 1 && done && saved[0] === done.name, "файл на диске сохранён под тем же русским именем", saved);
  if (saved.length) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(DOWNLOADS, saved[0])));
    const wb = readXlsx(bytes);
    check(wb.sheets.map((s) => s.name).join("|") === "Сводка|По сменам|Журнал простоев|Приём и сдача смен", "в скачанном файле все четыре листа");
    const stats = (await api("/api/stats?period=day")).json.stats;
    const cell = (label) => wb.sheets[0].rows.find((r) => r && r[0] && r[0].value === label)[1];
    // Длительность в книге словами («2 часа, 29 минут») — сверяем с той же функцией, что её пишет
    const downWords = cell("Простой").value;
    check(downWords === durationWords(stats.downMin) && cell("Остановок, шт").value === stats.stops,
      "скачанная сводка = «Показатели» за сутки", { down: downWords, stats: stats.downMin });
    const py = spawnSync(PYTHON, ["-c",
      "import sys,zipfile,openpyxl; p=sys.argv[1]; z=zipfile.ZipFile(p); assert z.testzip() is None; wb=openpyxl.load_workbook(p); print('|'.join(wb.sheetnames))",
      path.join(DOWNLOADS, saved[0])], { encoding: "utf8" });
    if (!py.error) check(py.status === 0 && py.stdout.trim() === "Сводка|По сменам|Журнал простоев|Приём и сдача смен", "openpyxl открывает скачанный файл", py.stderr || py.stdout);
  }
  // Файл с сервера откладываем под другим именем: демо ниже скачает отчёт с тем же именем, и его надо отличить
  if (saved.length) fs.renameSync(path.join(DOWNLOADS, saved[0]), path.join(DOWNLOADS, "с сервера — " + saved[0]));
  check(await E("document.querySelector('.rep-panel').hidden"), "после скачивания панель закрыта");
  check((await E("document.querySelector('#toast').textContent")) === "Отчёт скачан", "сообщение «Отчёт скачан»");

  // Нет сети: сообщение в панели
  await chrome.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await openPanel();
  await chrome.clickElement(".rep-go");
  await chrome.waitFor("document.querySelector('.rep-error').textContent.length > 0", { what: "сообщение об отсутствии связи" });
  check((await E("document.querySelector('.rep-error').textContent")) === "Нет связи с сервером. Отчёт скачивается только при связи.", "нет сети: сообщение в панели");
  check(!(await E("document.querySelector('.rep-go').disabled")), "после отказа сети кнопка снова активна");
  await chrome.screenshot(path.join(OUT, "panel-error-offline.png"));
  await chrome.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // Демо: без сервера, тем же ядром
  await chrome.navigate(ORIGIN + "/?mock=1");
  await chrome.waitFor("!!document.querySelector('.tiles .tile')", { what: "демо: выбор смены" });
  await chrome.clickElement(".tiles .tile");
  // Другая смена, чем идёт по часам, просит подтверждения («Принять выбранную смену») — в новых версиях страницы
  await chrome.waitFor("/Принять выбранную смену/.test(document.body.innerText) || (/Мастер/.test(document.body.innerText) && !!document.querySelector('.tiles .tile'))", { what: "демо: подтверждение смены или выбор мастера" });
  if (await E("/Принять выбранную смену/.test(document.body.innerText)")) await chrome.clickText("button", "Принять выбранную смену");
  await chrome.waitFor("document.querySelector('.tiles .tile') && /Мастер/.test(document.body.innerText)", { what: "демо: выбор мастера" });
  await chrome.clickElement(".tiles .tile");
  await waitButton("демо: кнопка отчёта");
  await openPanel();
  const before = downloads.length;
  await chrome.clickElement(".rep-go");
  for (let i = 0; i < 100 && downloads.length === before; i++) await sleep(100);
  for (let i = 0; i < 50 && downloads.at(-1).state !== "completed"; i++) await sleep(100);
  check(downloads.length === before + 1 && downloads.at(-1).state === "completed", "демо: файл скачан без сервера", downloads.at(-1));
  check(/^Отчёт по простоям стана за \d\d\.\d\d\.\d{4}, скачан/.test(downloads.at(-1).name), "демо: русское имя файла", downloads.at(-1).name);
  const demoFile = path.join(DOWNLOADS, downloads.at(-1).name);
  check(fs.existsSync(demoFile) && readXlsx(new Uint8Array(fs.readFileSync(demoFile))).sheets.length === 4, "демо: файл — книга из четырёх листов");
  if (fs.existsSync(demoFile)) fs.renameSync(demoFile, path.join(DOWNLOADS, "из демо — " + downloads.at(-1).name));
  await chrome.screenshot(path.join(OUT, "demo-after-download.png"));

  // Консоль: ни ошибок, ни нарушений политики безопасности (ожидаемые сетевые отказы из проверок выше не считаются)
  const expected = /ERR_INTERNET_DISCONNECTED|Failed to fetch|status of 400|Failed to load resource/;
  const bad = chrome.consoleLog.filter((m) => !expected.test(m.text) && m.kind !== "log:verbose" && m.kind !== "log:info");
  check(bad.length === 0, "в консоли нет ошибок JavaScript и нарушений CSP", bad);
  check(chrome.consoleLog.filter((m) => /Content Security Policy|Refused to/i.test(m.text)).length === 0, "нарушений политики безопасности нет");
  results.notes.push({ console: chrome.consoleLog });

  // Без сервера: страница и кнопка загружаются из офлайн-кеша (сервер останавливаем по-настоящему)
  await chrome.navigate(ORIGIN + "/");
  await waitButton("перед остановкой сервера");
  server.kill();
  for (let i = 0; i < 50 && server.exitCode === null; i++) await sleep(100);
  await chrome.reload();
  await waitButton("кнопка отчёта из кеша без сервера");
  await openPanel();
  await chrome.clickElement(".rep-go");
  await chrome.waitFor("document.querySelector('.rep-error').textContent.length > 0", { what: "сообщение при остановленном сервере" });
  check((await E("document.querySelector('.rep-error').textContent")) === "Нет связи с сервером. Отчёт скачивается только при связи.", "сервер остановлен: страница из кеша, в панели сообщение про связь");
} catch (error) {
  exitCode = 1;
  console.error("ПРОВАЛ ПРОВЕРКИ:", error.stack || error);
  results.notes.push({ fatal: String(error.stack || error) });
  try { await chrome.screenshot(path.join(OUT, "fatal.png")); } catch { /* не вышло */ }
} finally {
  await chrome.stop().catch(() => {});
  server.kill();
  await sleep(300);
  fs.rmSync(dataCopy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const failed = results.checks.filter((c) => !c.ok);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ passed: results.checks.length - failed.length, failed: failed.length, failures: failed, measures: results.measures, notes: results.notes }, null, 2));
console.log(`\nПроверок: ${results.checks.length}, не прошло: ${failed.length}. Снимки и results.json — ${OUT}`);
process.exit(exitCode || (failed.length ? 1 : 0));
