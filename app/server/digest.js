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

/**
 * Собирает письмо о смене shift (объект из shiftOf).
 * events — события из базы, refs — справочники, nowMs — «сейчас» (мс UTC), publicUrl — ссылка на пульт.
 */
export function buildDigest({ events, refs, nowMs, shift, publicUrl = "https://stan.tmpz-engineering.ru/" }) {
  const schedule = refs.settings.schedule;
  const tz = schedule.tzOffsetMinutes || 0;
  const stats = computeStats(events, { fromMs: shift.startMs, toMs: shift.endMs, nowMs, refs });
  const file = reportFile({ from: shift.day, to: shift.day, events, refs, nowMs });
  if (!file.ok) throw new Error(file.message);
  const { parts, masters } = file.book.meta;
  const stops = parts.filter((p) => p.day === shift.day && p.shiftNo === shift.shiftNo);
  const masterNames = masters[`${shift.day}|${shift.shiftNo}`] || [];
  const crews = stats.byCrew
    .filter((row) => row.crewId !== null && row.crewId !== undefined)
    .map((row) => refs.crews?.find((c) => c.id === row.crewId)?.title)
    .filter(Boolean);

  const kind = shiftKind(shift);
  const dateText = ruDate(shift.day);
  const period = `${hm(shift.startMs, tz)}–${hm(shift.endMs, tz)}`;
  const subject = `Стан: ${kind} ${dateText} — простой ${hoursMinutes(stats.downMin)}`;

  const topReasons = stats.byReason.filter((r) => r.minutes > 0).slice(0, 5);
  const summary = [
    ["Работа", durationWords(stats.workMin)],
    ["Простой всего", durationWords(stats.downMin)],
    ["Плановые", durationWords(stats.plannedMin)],
    ["Внеплановые", durationWords(stats.unplannedMin)],
    ...(stats.shortMin > 0 ? [["Короткие без причины", durationWords(stats.shortMin)]] : []),
    ["Остановок", String(stats.stops)],
  ];
  const stopRows = stops.map((p) => ({
    time: `${hm(p.startMs, tz)}–${p.ongoing ? "…" : hm(p.endMs, tz)}`,
    duration: durationWords(p.minutes),
    zone: ZONE_LABEL[p.zone] || "",
    reason: reasonTitle(p.reason, refs),
    note: p.note || "",
    action: p.action || "",
    marks: p.marks.join("; "),
  }));
  const people = [
    ...(masterNames.length ? [["Мастер", masterNames.join(", ")]] : []),
    ...(crews.length ? [["Бригада", crews.join(", ")]] : []),
  ];
  const attachNote = `Во вложении — Excel-отчёт за сутки ${dateText} (смена выделена на листе «По сменам»).`;

  // ---- текст
  const lines = [`${capital(kind)} ${dateText}, ${period} (${tzLabel(tz)})`, ""];
  if (stats.noData) lines.push("За эту смену данных нет.", "");
  for (const [k, v] of summary) lines.push(`${k}: ${v}`);
  for (const [k, v] of people) lines.push(`${k}: ${v}`);
  lines.push("", "Главные причины:");
  if (topReasons.length) topReasons.forEach((r, i) => lines.push(`${i + 1}. ${r.title} — ${durationWords(r.minutes)}, остановок: ${r.stops}`));
  else lines.push("простоев не было");
  lines.push("", "Простои смены:");
  if (stopRows.length) {
    stopRows.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.time}, ${r.duration} — ${r.reason}${r.zone ? ` (${r.zone.toLowerCase()})` : ""}`);
      if (r.note) lines.push(`   Что случилось: ${r.note}`);
      if (r.action) lines.push(`   Что сделали: ${r.action}`);
      if (r.marks) lines.push(`   Отметка: ${r.marks}`);
    });
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
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;">`
    + `<div style="max-width:640px;margin:0 auto;padding:16px;background:#ffffff;">`
    + `<h1 style="margin:0 0 4px;font-size:20px;color:#1a1c20;">${esc(capital(kind))} ${esc(dateText)}</h1>`
    + `<p style="margin:0 0 12px;font-size:14px;color:#5b6573;">${esc(period)} (${esc(tzLabel(tz))})</p>`
    + (stats.noData ? `<p style="margin:0 0 12px;font-size:15px;color:#b45309;">За эту смену данных нет.</p>` : "")
    + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${summaryHtml}</table>`
    + `<h2 style="${h2}">Главные причины</h2>${reasonsHtml}`
    + `<h2 style="${h2}">Простои смены</h2>${stopsHtml}`
    + `<p style="margin:20px 0 0;font-size:15px;"><a href="${esc(publicUrl)}" style="color:#1d4ed8;">Открыть пульт</a></p>`
    + `<p style="margin:8px 0 0;font-size:13px;color:#5b6573;">${esc(attachNote)}</p>`
    + `</div></body></html>`;

  return {
    subject, html, text, stats, shift, stops: stopRows,
    attachment: { filename: file.filename, content: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.length) },
  };
}
