// Шкала суток: 48 ячеек по 30 минут, состояние стана цветом.
// ES-модуль без зависимостей. Стили — только классами из timeline.css,
// размеры цветных частей — через el.style.flexBasis (работает в обеих
// ориентациях: в строке это ширина, в столбике — высота).

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

export function dayScale({ cells, nowMs, shiftFromMs, shiftToMs, fmtClock }) {
  const root = document.createElement("section");
  root.className = "day-scale";
  root.setAttribute("aria-label", "Состояние стана за сутки");

  const title = document.createElement("h2");
  title.className = "day-scale__title";
  title.textContent = "Сутки по 30 минут";
  root.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "day-scale__rows";

  const details = document.createElement("div");
  details.className = "day-scale__details";
  details.setAttribute("aria-live", "polite");
  details.hidden = true;

  let selected = null;

  cells.forEach((cell) => {
    // Черта границы смены — перед ячейкой, с которой начинается новая смена.
    if (cell.startMs === shiftToMs) {
      const line = document.createElement("div");
      line.className = "ds-shift";
      const lineLabel = document.createElement("span");
      lineLabel.className = "ds-shift__label";
      lineLabel.textContent = "Смена 2";
      line.appendChild(lineLabel);
      rows.appendChild(line);
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "ds-row";

    const clock = fmtClock(cell.startMs);
    const isHour = clock.slice(3) === "00";
    if (isHour) {
      row.classList.add("ds-row--tick");
      const hour = parseInt(clock.slice(0, 2), 10);
      if (hour % 4 === 0) row.classList.add("ds-row--tick4");
    }
    if (cell.future) row.classList.add("ds-row--future");
    if (cell.startMs <= nowMs && nowMs < cell.endMs) {
      row.classList.add("ds-row--now");
    }

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
  for (const [key, name] of LEGEND) {
    const item = document.createElement("span");
    item.className = "ds-legend__item";
    const chip = document.createElement("span");
    chip.className = "ds-legend__chip z-" + key;
    item.appendChild(chip);
    const caption = document.createElement("span");
    caption.textContent = name + " — " + fmtDuration(sums[key]);
    item.appendChild(caption);
    legend.appendChild(item);
  }
  root.appendChild(legend);

  return root;
}
