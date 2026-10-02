// Сводка смены для письма: тема, HTML, текст и вложение-Excel.
// Цифры считает общее ядро: computeStats (как /api/stats), части простоев и книга — buildReport/reportFile
// (как /api/report.xlsx). Своих расчётов здесь нет, только оформление.
import { computeStats } from "../core/stats.js";
import { reportFile, durationWords, ZONE_LABEL } from "../core/report.js";
import { ruDate } from "../core/report-period.js";

const MINUTE = 60_000;
const two = (n) => String(n).padStart(2, "0");

/** «дневная смена» / «ночная смена» по номеру; для других расписаний — «смена N». */
export function shiftKind(shift) {
  if (shift.shiftNo === 1) return "дневная смена";
  if (shift.shiftNo === 2) return "ночная смена";
  return `смена ${shift.shiftNo}`;
}

/** Часы и минуты для темы: «1 ч 25 мин». */
export function hoursMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)} ч ${total % 60} мин`;
}

function hm(ms, tzOffsetMinutes) {
  const d = new Date(ms + tzOffsetMinutes * MINUTE);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

function tzLabel(tz) {
  if (tz === 180) return "МСК";
  const abs = Math.abs(tz);
  return `UTC${tz < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? ":" + two(abs % 60) : ""}`;
}

const hasText = (v) => typeof v === "string" && v.trim() !== "";
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function reasonTitle(code, refs) {
  if (!hasText(code)) return "Без причины";
  const ref = refs.reasons?.[code];
  return ref ? ref.short || ref.title || "Причина без названия" : "Причина не из справочника";
}

const MAX_STOP_ROWS = 40; // в письме за сутки и неделю длинный список обрезается, полный — в Excel

function dm(ms, tz) {
  const d = new Date(ms + tz * MINUTE);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}`;
}

/**
 * Собирает письмо о периоде: period = { kind: "shift"|"day"|"week", fromMs, toMs, fromDay, toDay, shift? }
 * (см. periodFor в core/mail-schedule.js). Для совместимости можно передать shift (объект из shiftOf).
 * events — события из базы, refs — справочники, nowMs — «сейчас» (мс UTC), publicUrl — ссылка на пульт.
 */
export function buildDigest({ events, refs, nowMs, shift, period, publicUrl = "https://stan.tmpz-engineering.ru/" }) {
  const schedule = refs.settings.schedule;
  const tz = schedule.tzOffsetMinutes || 0;
  if (!period) period = { kind: "shift", fromMs: shift.startMs, toMs: shift.endMs, fromDay: shift.day, toDay: shift.day, shift };
  const isShift = period.kind === "shift";
  shift = period.shift;
  const stats = computeStats(events, { fromMs: period.fromMs, toMs: period.toMs, nowMs, refs });
  const file = reportFile({ from: period.fromDay, to: period.toDay, events, refs, nowMs });
  if (!file.ok) throw new Error(file.message);
  const { parts, masters, shiftRows } = file.book.meta;
  const stops = isShift ? parts.filter((p) => p.day === shift.day && p.shiftNo === shift.shiftNo) : parts;
  const masterNames = isShift ? masters[`${shift.day}|${shift.shiftNo}`] || [] : [];
  const crews = isShift ? stats.byCrew
    .filter((row) => row.crewId !== null && row.crewId !== undefined)
    .map((row) => refs.crews?.find((c) => c.id === row.crewId)?.title)
    .filter(Boolean) : [];

  const fromText = ruDate(period.fromDay);
  const rangeText = period.fromDay === period.toDay ? fromText : `${fromText}–${ruDate(period.toDay)}`;
  let kind, dateText, periodText, subjectKind;
  if (isShift) {
    kind = shiftKind(shift);
    dateText = fromText;
    periodText = `${hm(shift.startMs, tz)}–${hm(shift.endMs, tz)}`;
    subjectKind = kind;
  } else {
    kind = period.kind === "day" ? "сутки" : "неделя";
    dateText = rangeText;
    periodText = `${dm(period.fromMs, tz)} ${hm(period.fromMs, tz)} – ${dm(period.toMs, tz)} ${hm(period.toMs, tz)}`;
    subjectKind = kind;
  }
  const subject = `Стан: ${subjectKind} ${dateText} — простой ${hoursMinutes(stats.downMin)}`;

  const topReasons = stats.byReason.filter((r) => r.minutes > 0).slice(0, 5);
  const summary = [
    ["Работа", durationWords(stats.workMin)],
    ["Простой всего", durationWords(stats.downMin)],
    ["Плановые", durationWords(stats.plannedMin)],
    ["Внеплановые", durationWords(stats.unplannedMin)],
    ...(stats.shortMin > 0 ? [["Короткие без причины", durationWords(stats.shortMin)]] : []),
    ["Остановок", String(stats.stops)],
  ];
  const stampOf = (ms) => (isShift ? hm(ms, tz) : `${dm(ms, tz)} ${hm(ms, tz)}`);
  const allStopRows = stops.map((p) => ({
    time: `${stampOf(p.startMs)}–${p.ongoing ? "…" : stampOf(p.endMs)}`,
    duration: durationWords(p.minutes),
    zone: ZONE_LABEL[p.zone] || "",
    reason: reasonTitle(p.reason, refs),
    note: p.note || "",
    action: p.action || "",
    marks: p.marks.join("; "),
  }));
  const stopRows = isShift ? allStopRows : allStopRows.slice(0, MAX_STOP_ROWS);
  const hidden = allStopRows.length - stopRows.length;
  const byShift = isShift ? [] : shiftRows.map((r) => ({
    title: `${ruDate(r.day)}, смена ${r.shiftNo}`, text: `работа ${durationWords(r.workMin)}, простой ${durationWords(r.downMin)}, остановок: ${r.stops}`,
  }));
  const people = [
    ...(masterNames.length ? [["Мастер", masterNames.join(", ")]] : []),
    ...(crews.length ? [["Бригада", crews.join(", ")]] : []),
  ];
  const attachNote = isShift
    ? `Во вложении — Excel-отчёт за сутки ${dateText} (смена выделена на листе «По сменам»).`
    : `Во вложении — Excel-отчёт за ${period.kind === "day" ? "сутки" : "период"} ${dateText}.`;
  const hiddenNote = hidden > 0 ? `Показаны первые ${MAX_STOP_ROWS} простоев, ещё ${hidden} — в Excel.` : "";

  // ---- текст
  const lines = [`${capital(kind)} ${dateText}, ${periodText} (${tzLabel(tz)})`, ""];
  if (stats.noData) lines.push("За эту смену данных нет.", "");
  for (const [k, v] of summary) lines.push(`${k}: ${v}`);
  for (const [k, v] of people) lines.push(`${k}: ${v}`);
  lines.push("", "Главные причины:");
  if (topReasons.length) topReasons.forEach((r, i) => lines.push(`${i + 1}. ${r.title} — ${durationWords(r.minutes)}, остановок: ${r.stops}`));
  else lines.push("простоев не было");
  if (byShift.length) { lines.push("", "По сменам:"); byShift.forEach((r) => lines.push(`${r.title}: ${r.text}`)); }
  lines.push("", isShift ? "Простои смены:" : "Простои:");
  if (stopRows.length) {
    stopRows.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.time}, ${r.duration} — ${r.reason}${r.zone ? ` (${r.zone.toLowerCase()})` : ""}`);
      if (r.note) lines.push(`   Что случилось: ${r.note}`);
      if (r.action) lines.push(`   Что сделали: ${r.action}`);
      if (r.marks) lines.push(`   Отметка: ${r.marks}`);
    });
    if (hiddenNote) lines.push(hiddenNote);
  } else lines.push("простоев не было");
  lines.push("", `Пульт: ${publicUrl}`, attachNote);
  const text = lines.join("\n");

  // ---- HTML (inline-стили, одна колонка до 640 px: читается в почте Яндекса и на телефоне)
  const td = "padding:6px 10px;border-bottom:1px solid #e3e8ef;font-size:15px;line-height:1.4;vertical-align:top;";
  const h2 = "margin:20px 0 8px;font-size:16px;color:#1a1c20;";
  const summaryHtml = [...summary, ...people].map(([k, v]) =>
    `<tr><td style="${td}color:#5b6573;">${esc(k)}</td><td style="${td}font-weight:bold;color:#1a1c20;">${esc(v)}</td></tr>`).join("");
  const reasonsHtml = topReasons.length
    ? `<ol style="margin:0;padding-left:22px;font-size:15px;line-height:1.5;color:#1a1c20;">${topReasons.map((r) =>
      `<li>${esc(r.title)} — <b>${esc(durationWords(r.minutes))}</b>, остановок: ${r.stops}</li>`).join("")}</ol>`
    : `<p style="margin:0;font-size:15px;color:#5b6573;">Простоев не было.</p>`;
  const stopsHtml = stopRows.length
    ? stopRows.map((r) => `<div style="border:1px solid #e3e8ef;border-radius:6px;padding:8px 10px;margin:0 0 8px;font-size:15px;line-height:1.4;color:#1a1c20;">`
      + `<div><b>${esc(r.time)}</b> · ${esc(r.duration)}</div>`
      + `<div>${esc(r.reason)}${r.zone ? ` <span style="color:#5b6573;">(${esc(r.zone.toLowerCase())})</span>` : ""}</div>`
      + (r.note ? `<div><span style="color:#5b6573;">Что случилось:</span> ${esc(r.note)}</div>` : "")
      + (r.action ? `<div><span style="color:#5b6573;">Что сделали:</span> ${esc(r.action)}</div>` : "")
      + (r.marks ? `<div style="color:#5b6573;font-size:13px;">${esc(r.marks)}</div>` : "")
      + `</div>`).join("")
    : `<p style="margin:0;font-size:15px;color:#5b6573;">Простоев не было.</p>`;
  const byShiftHtml = byShift.map((r) => `<div style="font-size:14px;line-height:1.4;padding:4px 0;border-bottom:1px solid #e3e8ef;color:#1a1c20;"><b>${esc(r.title)}</b>: ${esc(r.text)}</div>`).join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;">`
    + `<div style="max-width:640px;margin:0 auto;padding:16px;background:#ffffff;">`
    + `<h1 style="margin:0 0 4px;font-size:20px;color:#1a1c20;">${esc(capital(kind))} ${esc(dateText)}</h1>`
    + `<p style="margin:0 0 12px;font-size:14px;color:#5b6573;">${esc(periodText)} (${esc(tzLabel(tz))})</p>`
    + (stats.noData ? `<p style="margin:0 0 12px;font-size:15px;color:#b45309;">За эту смену данных нет.</p>` : "")
    + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${summaryHtml}</table>`
    + `<h2 style="${h2}">Главные причины</h2>${reasonsHtml}`
    + (byShift.length ? `<h2 style="${h2}">По сменам</h2>${byShiftHtml}` : "")
    + `<h2 style="${h2}">${isShift ? "Простои смены" : "Простои"}</h2>${stopsHtml}${hiddenNote ? `<p style="margin:0;font-size:13px;color:#5b6573;">${esc(hiddenNote)}</p>` : ""}`
    + `<p style="margin:20px 0 0;font-size:15px;"><a href="${esc(publicUrl)}" style="color:#1d4ed8;">Открыть пульт</a></p>`
    + `<p style="margin:8px 0 0;font-size:13px;color:#5b6573;">${esc(attachNote)}</p>`
    + `</div></body></html>`;

  return {
    subject, html, text, stats, shift, period, stops: stopRows,
    attachment: { filename: file.filename, content: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.length) },
  };
}
