import { apportionMinutes } from "./core/core.js";
// Шкала суток: 48 ячеек по 30 минут, состояние стана цветом.
// ES-модуль без зависимостей. Стили — только классами из timeline.css,
// размеры цветных частей и положение метки «сейчас» — через el.style
// (flexBasis у частей, --nowpos у черты и плашки): работает в обеих
// ориентациях, атрибут style не используется.

const STATES = [
  ["work", "работа"],
  ["plan", "плановый"],
  ["unplanned", "внеплановый"],
  ["failure", "авария"],
  ["nodata", "нет данных"],
];

const LEGEND = [
  ["work", "Работает"],
  ["plan", "Плановый простой"],
  ["unplanned", "Внеплановый простой"],
  ["failure", "Аварийный простой"],
];

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return h + " ч " + m + " мин";
  if (h > 0) return h + " ч";
  return m + " мин";
}

function detailsText(cell, fmtClock) {
  const range = fmtClock(cell.startMs) + "–" + fmtClock(cell.endMs);
  if (cell.future) return range + ": ещё не наступило";
  const parts = [];
  for (const [key, name] of STATES) {
    const v = (cell.ms && cell.ms[key]) || 0;
    if (v > 0) parts.push(name + " " + Math.round(v / 60000) + " мин");
  }
  if (parts.length === 0) parts.push("нет данных");
  return range + ": " + parts.join(", ");
}

// Память шкалы между перерисовками: интервалы по началу ячейки (мс)
const memo = { stop: null, sel: null };

export function dayScale({ cells, nowMs, shiftFromMs, shiftToMs, shifts, fmtClock, fmtDate, icon }) {
  const shiftLen = Math.max(1, shiftToMs - shiftFromMs);

  const root = document.createElement("section");
  root.className = "day-scale";
  root.setAttribute("aria-label", "Состояние стана за сутки");

  const title = document.createElement("h2");
  title.className = "day-scale__title";
  title.textContent = fmtDate
    ? "Сутки " + fmtDate(cells[0].startMs) + " по 30 минут"
    : "Сутки по 30 минут";
  root.appendChild(title);
  if (icon) title.prepend(icon("calendar"));

  const rows = document.createElement("div");
  rows.className = "day-scale__rows";

  const details = document.createElement("div");
  details.className = "day-scale__details";
  details.setAttribute("aria-live", "polite");
  details.hidden = true;

  let selected = null;

  cells.forEach((cell) => {
    const clock = fmtClock(cell.startMs);
    const isHour = clock.slice(3) === "00";
    const hour = parseInt(clock.slice(0, 2), 10);

    // Заголовок смены — перед строкой её начала (по расписанию; без него — 08:00 и 20:00).
    const sh = shifts
      ? shifts.find((s) => s.startMs === cell.startMs)
      : isHour && (hour === 8 || hour === 20) ? { no: hour === 8 ? 1 : 2, startMs: cell.startMs, endMs: cell.startMs + shiftLen } : null;
    if (sh) {
      const header = document.createElement("div");
      header.className = "ds-shift";
      if (sh.startMs <= nowMs && nowMs < sh.endMs) {
        header.classList.add("ds-shift--active");
      }
      const name = document.createElement("span");
      name.className = "ds-shift__name";
      name.textContent = "Смена " + sh.no;
      if (icon) name.prepend(icon(sh.no === 1 ? "sun" : "moon"));
      header.appendChild(name);
      const times = document.createElement("span");
      times.className = "ds-shift__times";
      times.textContent = "· " + clock + "–" + fmtClock(sh.endMs);
      header.appendChild(times);
      rows.appendChild(header);
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "ds-row";

    if (isHour) {
      row.classList.add("ds-row--tick");
      if (hour % 4 === 0) row.classList.add("ds-row--tick4");
    } else {
      row.classList.add("ds-row--half");
    }
    if (cell.future) row.classList.add("ds-row--future");
    // Ячейка целиком без данных выглядит пустой, как будущее: серого цвета на шкале нет
    else if (!STATES.some(([k]) => k !== "nodata" && cell.ms && cell.ms[k] > 0)) row.classList.add("ds-row--nodata");
    const isNow = cell.startMs <= nowMs && nowMs < cell.endMs;
    if (isNow) row.classList.add("ds-row--now");

    const text = detailsText(cell, fmtClock);
    row.title = text;
    // Имя ячейки для экранного диктора и клавиатуры: время и статус (подпись внутри — только часы)
    row.setAttribute("aria-label", text);
    row.tabIndex = -1;
    row.dataset.start = String(cell.startMs);

    const label = document.createElement("span");
    label.className = "ds-row__label";
    label.textContent = isHour ? clock : "";
    row.appendChild(label);

    const track = document.createElement("span");
    track.className = "ds-row__track";
    if (!cell.future) {
      const len = Math.max(1, cell.endMs - cell.startMs);
      for (const [key] of STATES) {
        const v = (cell.ms && cell.ms[key]) || 0;
        if (v <= 0) continue;
        const seg = document.createElement("span");
        seg.className = "ds-seg z-" + key;
        seg.style.flexBasis = (v / len) * 100 + "%";
        track.appendChild(seg);
      }
    }

    // Метка текущего времени: черта поперёк полосы в точной доле ячейки
    // и плашка с часами слева (в горизонтали — над столбиком).
    if (isNow) {
      const len = Math.max(1, cell.endMs - cell.startMs);
      const pos = Math.min(1, Math.max(0, (nowMs - cell.startMs) / len)) * 100 + "%";
      const line = document.createElement("span");
      line.className = "ds-nowline";
      line.style.setProperty("--nowpos", pos);
      track.appendChild(line);
      const badge = document.createElement("span");
      badge.className = "ds-nowbadge";
      badge.style.setProperty("--nowpos", pos);
      badge.textContent = fmtClock(nowMs);
      row.appendChild(badge);
    }

    row.appendChild(track);

    row.addEventListener("click", () => {
      if (selected === row) {
        row.classList.remove("ds-row--sel");
        selected = null;
        memo.sel = null;
        details.hidden = true;
        details.textContent = "";
        return;
      }
      if (selected) selected.classList.remove("ds-row--sel");
      selected = row;
      memo.sel = row.dataset.start;
      row.classList.add("ds-row--sel");
      details.textContent = text;
      details.hidden = false;
    });

    rows.appendChild(row);
  });

  // Шкала — одна точка табуляции (roving tabindex): Tab входит один раз, ←/→/↑/↓, Home, End двигают по ячейкам.
  const rowList = [...rows.querySelectorAll(".ds-row")];
  const setStop = (row) => { for (const r of rowList) r.tabIndex = r === row ? 0 : -1; };
  // Шкала перерисовывается по таймеру: точка табуляции и открытая ячейка остаются на прежнем интервале
  const byStart = (start) => (start ? rowList.find((r) => r.dataset.start === start) : null);
  setStop(byStart(memo.stop) || rowList.find((r) => r.classList.contains("ds-row--now")) || rowList[0]);
  const keep = byStart(memo.sel);
  if (keep) {
    selected = keep;
    keep.classList.add("ds-row--sel");
    details.textContent = keep.title;
    details.hidden = false;
  } else memo.sel = null;
  rows.addEventListener("focusin", (e) => { if (rowList.includes(e.target)) { setStop(e.target); memo.stop = e.target.dataset.start; } });
  rows.addEventListener("keydown", (e) => {
    const at = rowList.indexOf(document.activeElement);
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: rowList.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = rowList[Math.min(rowList.length - 1, Math.max(0, to))];
    setStop(next);
    memo.stop = next.dataset.start;
    next.focus();
  });

  root.appendChild(rows);
  root.appendChild(details);

  // Легенда с итогами за текущую смену.
  const sums = { work: 0, plan: 0, unplanned: 0, failure: 0 };
  for (const cell of cells) {
    if (cell.future || !cell.ms) continue;
    if (cell.startMs < shiftFromMs || cell.startMs >= shiftToMs) continue;
    for (const key of Object.keys(sums)) sums[key] += cell.ms[key] || 0;
  }

  const zoneKeys = ["plan", "unplanned", "failure"];
  const down = zoneKeys.reduce((n, key) => n + sums[key], 0);
  const rounded = apportionMinutes(zoneKeys.map((key) => sums[key]));
  sums.work = Math.max(0, Math.round((sums.work + down) / 60000) - Math.round(down / 60000)) * 60000;
  zoneKeys.forEach((key, i) => { sums[key] = rounded[i] * 60000; });

  const legend = document.createElement("div");
  legend.className = "day-scale__legend";
  const legendTitle = document.createElement("div");
  legendTitle.className = "day-scale__legend-title";
  legendTitle.textContent = "За смену";
  legend.appendChild(legendTitle);
  for (const [key, name] of LEGEND) {
    const item = document.createElement("span");
    item.className = "ds-legend__item";
    if (sums[key] <= 0) item.classList.add("ds-legend__item--zero");
    const chip = document.createElement("span");
    chip.className = "ds-legend__chip z-" + key;
    item.appendChild(chip);
    const caption = document.createElement("span");
    caption.className = "ds-legend__name";
    caption.textContent = name;
    item.appendChild(caption);
    const value = document.createElement("span");
    value.className = "ds-legend__val";
    value.textContent = fmtDuration(sums[key]);
    item.appendChild(value);
    legend.appendChild(item);
  }
  root.appendChild(legend);

  return root;
}
