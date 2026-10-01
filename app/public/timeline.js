// Шкала суток: 48 ячеек по 30 минут, состояние стана цветом.
// ES-модуль без зависимостей. Стили — только классами из timeline.css,
// размеры цветных частей и положение метки «сейчас» — через el.style
// (flexBasis у частей, --nowpos у черты и плашки): работает в обеих
// ориентациях, атрибут style не используется.

const STATES = [
  ["work", "работа"],
  ["plan", "перевалка"],
  ["unplanned", "внеплановый"],
  ["failure", "авария"],
  ["nodata", "нет данных"],
];

const LEGEND = [
  ["work", "Работает"],
  ["plan", "Перевалка"],
  ["unplanned", "Внеплановый"],
  ["failure", "Авария"],
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

export function dayScale({ cells, nowMs, shiftFromMs, shiftToMs, fmtClock, fmtDate, icon }) {
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

    // Заголовок смены — перед строками 08:00 и 20:00.
    if (isHour && (hour === 8 || hour === 20)) {
      const header = document.createElement("div");
      header.className = "ds-shift";
      if (cell.startMs <= nowMs && nowMs < cell.startMs + shiftLen) {
        header.classList.add("ds-shift--active");
      }
      const name = document.createElement("span");
      name.className = "ds-shift__name";
      name.textContent = hour === 8 ? "Смена 1" : "Смена 2";
      if (icon) name.prepend(icon(hour === 8 ? "sun" : "moon"));
      header.appendChild(name);
      const times = document.createElement("span");
      times.className = "ds-shift__times";
      times.textContent = "· " + clock + "–" + fmtClock(cell.startMs + shiftLen);
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
    const isNow = cell.startMs <= nowMs && nowMs < cell.endMs;
    if (isNow) row.classList.add("ds-row--now");

    const text = detailsText(cell, fmtClock);
    row.title = text;

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
        details.hidden = true;
        details.textContent = "";
        return;
      }
      if (selected) selected.classList.remove("ds-row--sel");
      selected = row;
      row.classList.add("ds-row--sel");
      details.textContent = text;
      details.hidden = false;
    });

    rows.appendChild(row);
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
