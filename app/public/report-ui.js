// «Отчёт в Excel»: кнопка в полосе состояния пульта и выпадающая панель периода.
// Подключается из app.js отдельно (import()): если файл не загрузится, пульт работает как раньше.
// Стили — report.css (классы .rep-*), DOM строится через h() страницы; атрибут style и inline-код
// запрещены политикой безопасности, поэтому ничего этого здесь нет.
import { REPORT_PRESETS, XLSX_MIME, checkReportPeriod, currentDay, dayStartHm, maxReportDay, presetRange, reportFileName, tzName } from "./core/report-period.js";

const FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_SCHEDULE = { tzOffsetMinutes: 180, shifts: [{ no: 1, start: "08:00" }, { no: 2, start: "20:00" }] };
const TITLE = "Скачать отчёт в Excel";
const ICONS = {
  table: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 9h18M3 15h18M9 3v18",
  download: "M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  close: "M6 6l12 12M18 6 6 18",
};

function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** Текст ошибки для панели: сообщение сервера при 400, иначе понятная причина. */
export function reportErrorText(error) {
  const status = error && error.status;
  if (status === 400 && error.data && error.data.message) return error.data.message;
  if (status === 401) return "Устройство не подключено: ключ не подошёл. Введите ключ заново.";
  if (status === 429) return "Слишком много запросов. Подождите минуту и повторите.";
  if (error && error.name === "AbortError") return "Сервер не ответил за минуту. Повторите позже.";
  if (status >= 500) return "Сервер не смог подготовить отчёт. Повторите позже.";
  if (status) return `Сервер ответил ошибкой (${status}). Повторите позже.`;
  return "Нет связи с сервером. Отчёт скачивается только при связи.";
}

/** Сохраняет blob файлом с заданным именем: скрытая ссылка с download, клик, освобождение адреса. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Сразу освобождать нельзя: часть браузеров начинает чтение файла после возврата из click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * deps: h — построитель DOM страницы; nowMs — часы с поправкой на сервер; getSchedule — расписание смен;
 * getKey — ключ устройства; getApi — функция запросов страницы (в демо — имитация сервера); demo — режим демо;
 * toast — короткое сообщение внизу экрана.
 * Возвращает reportMenu(): новый элемент кнопки с панелью для вставки в полосу состояния.
 * Состояние панели живёт здесь, а не в DOM: страница перерисовывается по таймеру, панель переживает это.
 */
export function createReportMenu({ h, nowMs, getSchedule, getKey, getApi, demo, toast }) {
  const state = { open: false, from: "", to: "", preset: "today", busy: false, error: "" };
  let current = null;

  const schedule = () => getSchedule() || DEFAULT_SCHEDULE;
  const today = () => currentDay(nowMs(), schedule());

  function paint() {
    const c = current;
    if (!c) return;
    const t = today();
    c.root.classList.toggle("is-open", state.open);
    c.root.classList.toggle("is-busy", state.busy);
    c.button.setAttribute("aria-expanded", state.open ? "true" : "false");
    c.panel.hidden = !state.open;
    // Подсвечен один вариант: последний нажатый, пока даты ему соответствуют, иначе первый подходящий
    // (1-го числа «Сегодня» и «Этот месяц» — один и тот же период)
    const fits = REPORT_PRESETS.map(([id]) => id).filter((id) => {
      const range = presetRange(id, t);
      return range.from === state.from && range.to === state.to;
    });
    const chosen = fits.includes(state.preset) ? state.preset : fits[0];
    for (const chip of c.chips) {
      const on = chip.dataset.preset === chosen;
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const [input, key] of [[c.from, "from"], [c.to, "to"]]) {
      if (input.value !== state[key]) input.value = state[key];
      input.max = maxReportDay(nowMs(), schedule());
    }
    c.error.textContent = state.error;
    c.error.hidden = !state.error;
    c.go.disabled = state.busy;
    c.goLabel.textContent = state.busy ? "Готовлю файл…" : "Скачать";
  }

  function open() {
    if (!state.busy) {
      state.from = state.to = today();
      state.preset = "today";
      state.error = "";
    }
    state.open = true;
    paint();
    if (current) {
      current.panel.focus({ preventScroll: true });
      current.panel.scrollIntoView({ block: "nearest" });
    }
  }

  function close(returnFocus) {
    state.open = false;
    paint();
    if (returnFocus && current) current.button.focus({ preventScroll: true });
  }

  async function fetchReport(from, to) {
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    if (demo) {
      const data = await getApi()(`/api/report.xlsx?${query}`);
      return new Blob([data.bytes], { type: XLSX_MIME });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`api/report.xlsx?${query}`, {
        headers: { "X-Device-Key": getKey() || "" }, cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw Object.assign(new Error("http_" + response.status), { status: response.status, data });
      }
      return await response.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  async function download() {
    if (state.busy) return;
    const sched = schedule();
    const check = checkReportPeriod({ from: state.from, to: state.to }, nowMs(), sched);
    if (!check.ok) {
      state.error = check.message;
      paint();
      return;
    }
    // Имя — по времени скачивания (часы сервера через поправку страницы), берём момент отправки запроса
    const name = reportFileName({ fromDay: check.fromDay, toDay: check.toDay, nowMs: nowMs(), tzOffsetMinutes: sched.tzOffsetMinutes || 0 });
    state.busy = true;
    state.error = "";
    paint();
    try {
      saveBlob(await fetchReport(check.fromDay, check.toDay), name);
      state.open = false;
      toast("Отчёт скачан");
    } catch (error) {
      state.error = reportErrorText(error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  // Esc закрывает панель, щелчок мимо — тоже; слушатели ставятся один раз на всё время жизни страницы
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.open) {
      event.preventDefault();
      close(true);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (state.open && current && !current.root.contains(event.target)) close(false);
  }, true);
  // Ушли с экрана с пультом (кнопка исчезла из страницы) — панель закрывается, чтобы не появиться позже сама
  const main = document.getElementById("main");
  if (main && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      if (state.open && (!current || !current.root.isConnected)) state.open = false;
    }).observe(main, { childList: true });
  }

  return function reportMenu() {
    const sched = schedule();
    const start = dayStartHm(sched);
    const button = h("button", {
      class: "rep-btn", type: "button", "aria-label": TITLE, title: TITLE,
      "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "rep-panel",
      onclick: () => (state.open ? close(false) : open()),
    }, svgIcon("table"), h("span", { class: "rep-label", text: "Отчёт в Excel" }));

    const chips = REPORT_PRESETS.map(([id, label]) => h("button", {
      class: "rep-chip", type: "button", "aria-pressed": "false", dataset: { preset: id },
      onclick: () => {
        Object.assign(state, presetRange(id, today()), { preset: id, error: "" });
        paint();
      },
    }, label));

    const dateInput = (key, ariaLabel) => {
      const input = h("input", { class: "rep-date", type: "date", id: `rep-${key}`, "aria-label": ariaLabel, min: "2000-01-01" });
      const update = () => {
        state[key] = input.value;
        state.error = "";
        paint();
      };
      input.addEventListener("input", update);
      input.addEventListener("change", update);
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") download(); });
      return input;
    };
    const from = dateInput("from", "С — первые сутки периода");
    const to = dateInput("to", "По — последние сутки периода");

    const error = h("p", { class: "rep-error error-text", role: "alert", hidden: true });
    const goLabel = h("span", { text: "Скачать" });
    const go = h("button", { class: "ps-btn ps-btn--primary rep-go", type: "button", onclick: download }, svgIcon("download"), goLabel);
    const panel = h("div", { class: "rep-panel", id: "rep-panel", role: "dialog", "aria-label": "Отчёт в Excel", tabindex: "-1", hidden: true },
      h("div", { class: "rep-head" },
        h("h2", { class: "rep-title", text: "Отчёт в Excel" }),
        h("button", { class: "rep-close", type: "button", "aria-label": "Закрыть", title: "Закрыть", onclick: () => close(true) }, svgIcon("close"))),
      h("div", { class: "rep-quick", role: "group", "aria-label": "Быстрый выбор периода" }, chips),
      h("div", { class: "rep-dates" },
        h("label", { class: "rep-field", for: "rep-from" }, h("span", { class: "rep-field-name", text: "С" }), from),
        h("label", { class: "rep-field", for: "rep-to" }, h("span", { class: "rep-field-name", text: "По" }), to)),
      h("p", { class: "rep-hint", text: `Сутки считаются с ${start} до ${start} ${tzName(sched.tzOffsetMinutes ?? 180)}` }),
      error, go);

    const root = h("div", { class: "rep" }, button, panel);
    current = { root, button, panel, chips, from, to, error, go, goLabel };
    paint();
    return root;
  };
}
