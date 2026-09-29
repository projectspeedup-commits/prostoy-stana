// Графики для метрик стана: чистый SVG без библиотек.
// Стили — только через атрибуты SVG и классы: политика безопасности страницы запрещает style="".

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
}
function text(x, y, s, attrs = {}) {
  const t = el("text", { x, y, ...attrs });
  t.textContent = s;
  return t;
}

/**
 * Столбчатый график по суткам: по X — сутки, по Y — часы.
 * Каждый столбец — работа (зелёный) снизу и простой (красный) сверху.
 * Сутки без данных — серый пунктирный контур с подписью «нет данных».
 * days: [{ day: "YYYY-MM-DD", workMin, downMin, noData }]
 */
export function dayChart(days) {
  const W = 720, H = 300;
  const L = 44, R = 12, T = 16, B = 44;
  const plotW = W - L - R, plotH = H - T - B;
  const maxH = 24;
  const y = (hours) => T + plotH - (hours / maxH) * plotH;
  const n = Math.max(1, days.length);
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(36, slot * 0.7));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Работа и простой по суткам, часы" });

  // Сетка и ось Y: 0, 6, 12, 18, 24 часа
  for (const hh of [0, 6, 12, 18, 24]) {
    svg.append(el("line", { x1: L, x2: W - R, y1: y(hh), y2: y(hh), class: hh === 0 ? "ax" : "grid" }));
    svg.append(text(L - 6, y(hh) + 4, `${hh}`, { class: "tick", "text-anchor": "end" }));
  }
  svg.append(text(4, T + 4, "ч", { class: "tick" }));

  // Подписи по X: не чаще, чем помещается
  const every = Math.ceil(n / Math.max(1, Math.floor(plotW / 38)));
  days.forEach((d, i) => {
    const cx = L + slot * i + slot / 2;
    const x = cx - bw / 2;
    if (d.noData) {
      svg.append(el("rect", { x, y: y(maxH), width: bw, height: plotH, class: "nodata", rx: 2 }));
    } else {
      const wh = (d.workMin || 0) / 60;
      const dh = (d.downMin || 0) / 60;
      if (wh > 0) svg.append(el("rect", { x, y: y(wh), width: bw, height: y(0) - y(wh), class: "work", rx: 2 }));
      if (dh > 0) svg.append(el("rect", { x, y: y(wh + dh), width: bw, height: y(wh) - y(wh + dh), class: "down", rx: 2 }));
      const title = el("title");
      title.textContent = `${label(d.day)}: работа ${hm(d.workMin)}, простой ${hm(d.downMin)}`;
      svg.lastChild && svg.lastChild.append(title);
    }
    if (i % every === 0 || i === n - 1) {
      svg.append(text(cx, H - B + 18, label(d.day), { class: "tick", "text-anchor": "middle" }));
    }
  });
  svg.append(text(L + plotW / 2, H - 6, "сутки", { class: "tick", "text-anchor": "middle" }));
  return svg;
}

/**
 * Круговая диаграмма (кольцо) по группам причин с подписями долей.
 * rows: [{ name, minutes }]
 */
export function donut(rows, centerTitle) {
  const W = 480, H = 200, cx = 100, cy = 100, r = 80, w = 28;
  const total = rows.reduce((s, r2) => s + r2.minutes, 0);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart donut", role: "img", "aria-label": "Доли простоя по группам причин" });
  if (!total) return svg;
  let a0 = -Math.PI / 2;
  rows.forEach((row, i) => {
    const frac = row.minutes / total;
    const a1 = a0 + frac * Math.PI * 2;
    const cls = `seg-${i % 7}`;
    if (frac >= 0.999) {
      svg.append(el("circle", { cx, cy, r: r - w / 2, class: `ring ${cls}`, "stroke-width": w, fill: "none" }));
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, rr) => `${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`;
      const ro = r, ri = r - w;
      svg.append(el("path", {
        d: `M ${p(a0, ro)} A ${ro} ${ro} 0 ${large} 1 ${p(a1, ro)} L ${p(a1, ri)} A ${ri} ${ri} 0 ${large} 0 ${p(a0, ri)} Z`,
        class: cls,
      }));
    }
    // Легенда справа
    const ly = 24 + i * 24;
    if (ly < H - 8) {
      svg.append(el("rect", { x: 200, y: ly - 11, width: 14, height: 14, rx: 3, class: cls }));
      svg.append(text(220, ly, `${row.name} ${Math.round(frac * 100)}%`, { class: "legend" }));
    }
    a0 = a1;
  });
  svg.append(text(cx, cy - 2, hm(total), { class: "center", "text-anchor": "middle" }));
  svg.append(text(cx, cy + 16, centerTitle, { class: "tick", "text-anchor": "middle" }));
  return svg;
}

function label(day) { return `${day.slice(8, 10)}.${day.slice(5, 7)}`; }
function hm(min) {
  min = Math.max(0, Math.round(min || 0));
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${min % 60} м` : `${min} м`;
}
