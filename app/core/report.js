// Отчёт «Отчёт в Excel»: модель книги из событий. Считает тем же ядром, что экран «Показатели стана»
// (computeStats, buildDowntimes, splitByShifts, shiftOf, zoneOf), поэтому итоги «Сводки» совпадают
// с показателями экрана за тот же период. Работает в Node и в браузере (демо ?mock=1).
//
// Четыре листа: «Сводка», «По сменам», «Журнал простоев», «Приём и сдача смен».
// Минуты везде целые. Сводка — прямо из computeStats. Таблица смен: минуты каждой зоны раскладываются по
// сменам методом наибольшего остатка, поэтому столбцы дают ровно итоги сводки, а в строке учтённое время
// равно работе плюс простоям. Часть простоя в журнале округляется сама, как на экране: сумма журнала
// может отличаться от «Простоя» на минуту-две — сводка говорит об этом в пояснении.
import { buildDowntimes, shiftOf, splitByShifts, toMs } from "./core.js";
import { computeStats } from "./stats.js";
import { zoneOf } from "./zones.js";
import { buildXlsx } from "./xlsx.js";
import {
  addDays, checkReportPeriod, dayIndex, dayStartHm, reportFileName, ruDate, ruDateTime, tzName,
} from "./report-period.js";

export { REPORT_MAX_DAYS, REPORT_PRESETS, XLSX_MIME, checkReportPeriod, presetRange, reportFileName } from "./report-period.js";

const MINUTE = 60_000;
const EXCEL_EPOCH = 25569; // серийный номер Excel для 1970-01-01

export const REPORT_SHEETS = ["Сводка", "По сменам", "Журнал простоев", "Приём и сдача смен"];

// Цвета зон — токены --z-plan, --z-unplanned, --z-failure светлой темы (app.css); тест сверяет их с файлом.
export const ZONE_FILL = { plan: "3B82F6", unplanned: "F2A900", failure: "E5383B" };
const ZONE_TEXT = { plan: "FFFFFF", unplanned: "1A1C20", failure: "FFFFFF" };
export const ZONE_LABEL = { plan: "Плановый", unplanned: "Внеплановый", failure: "Авария" };
const ZONES = ["plan", "unplanned", "failure"];

const FORMAT = {
  date: "dd\\.mm\\.yyyy",
  dateTime: "dd\\.mm\\.yyyy\\ hh:mm",
  duration: "[h]:mm",
  percent: "0.0%",
  tons: "0.0##",
  integer: "0",
};

const GRID = "C9D1DA";
const BODY = { border: "thin", borderColor: GRID, va: "top" };
const HEAD = { bold: true, fill: "E3E8EF", border: "thin", borderColor: "9AA5B1", wrap: true, h: "center", va: "center" };
const SECTION = { bold: true, fill: "EEF2F6", border: "thin", borderColor: GRID, va: "center" };
const TOTAL = { bold: true, fill: "F1F4F8", border: { left: "thin", right: "thin", top: "medium", bottom: "thin" }, borderColor: "6B7685", va: "top" };

/** Минуты → «3:57» для текста пояснений. */
const hm = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasText = (value) => typeof value === "string" && value.trim() !== "";
const clean = (value) => (hasText(value) ? value.trim() : "");

// ---------- Ячейки ----------

const text = (v, extra) => ({ v, ...BODY, wrap: true, ...extra });
const dash = (extra) => ({ v: "—", ...BODY, h: "right", ...extra });
const integer = (v, extra) => ({ v, numFmt: FORMAT.integer, ...BODY, h: "right", va: "center", ...extra });
const duration = (minutes, extra) => (minutes === null || minutes === undefined ? dash(extra)
  : { v: minutes / 1440, numFmt: FORMAT.duration, ...BODY, h: "right", va: "center", ...extra });
const percent = (share, extra) => (share === null || share === undefined ? dash(extra)
  : { v: share, numFmt: FORMAT.percent, ...BODY, h: "right", va: "center", ...extra });
const tons = (v, extra) => ({ v, numFmt: FORMAT.tons, ...BODY, h: "right", va: "center", ...extra });
const dayCell = (day, extra) => ({ v: dayIndex(day) + EXCEL_EPOCH, numFmt: FORMAT.date, ...BODY, h: "center", va: "center", ...extra });
const dateTime = (ms, tz, extra) => (ms === null || ms === undefined ? { v: null, ...BODY, ...extra }
  : { v: EXCEL_EPOCH + Math.floor((ms + tz * MINUTE) / MINUTE) / 1440, numFmt: FORMAT.dateTime, ...BODY, h: "center", va: "center", ...extra });
const zoneCell = (zone, extra) => ({
  v: ZONE_LABEL[zone], fill: ZONE_FILL[zone], color: ZONE_TEXT[zone], bold: true, ...BODY, h: "center", va: "center", ...extra,
});

// ---------- Минуты: наибольший остаток ----------

/** Целые минуты по долям в мс так, чтобы сумма равнялась target (сначала получают +1 самые большие остатки). */
export function apportionMs(msList, targetMin) {
  const out = msList.map((ms) => Math.floor(ms / MINUTE));
  const rest = msList.map((ms, i) => ms - out[i] * MINUTE);
  let left = targetMin - out.reduce((sum, v) => sum + v, 0);
  const order = rest.map((_, i) => i).sort((a, b) => rest[b] - rest[a] || a - b);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length) {
    out[order[k]] += 1;
    left -= 1;
  }
  return out;
}

// ---------- Сбор данных ----------

function personName(event, refs) {
  if (hasText(event.personName)) return event.personName.trim();
  const person = (refs.people || []).find((p) => p.id === event.personId);
  return person && hasText(person.name) ? person.name.trim() : null;
}

function reasonTitle(code, refs) {
  if (!hasText(code)) return "Без причины";
  const ref = refs.reasons?.[code];
  return ref ? ref.short || ref.title || "Причина без названия" : "Причина не из справочника";
}

function sortedEvents(events, types) {
  const out = [];
  events.forEach((event, index) => {
    if (!types.includes(event.type)) return;
    let t;
    try { t = toMs(event.at); } catch { return; }
    out.push({ event, index, t });
  });
  return out.sort((a, b) => a.t - b.t || a.index - b.index);
}

/** Мастера каждой смены: все, кто принимал смену (shift_open) в её границах, без повторов. */
function mastersByShift(events, refs, schedule) {
  const map = new Map();
  for (const { event, t } of sortedEvents(events, ["shift_open"])) {
    const name = personName(event, refs);
    if (!name) continue;
    let sh;
    try { sh = shiftOf(t, schedule); } catch { continue; }
    const key = `${sh.day}|${sh.shiftNo}`;
    const list = map.get(key) || [];
    if (!list.includes(name)) list.push(name);
    map.set(key, list);
  }
  return map;
}

/** Приём и сдача: строка на приём смены, сдача — в ту же строку (до двух часов после конца смены). */
function handoverRows(events, refs, schedule, fromMs, toMsEff) {
  const rows = [];
  let open = null; // последняя строка с приёмом и без сдачи
  for (const { event, t } of sortedEvents(events, ["shift_open", "shift_close"])) {
    if (t < fromMs || t > toMsEff) continue;
    const name = personName(event, refs);
    if (event.type === "shift_open") {
      // Повторный приём тем же человеком без сдачи между ними — та же запись
      if (open && !open.close && (open.open.name === name || !name)) continue;
      const sh = shiftOf(t, schedule);
      open = { day: sh.day, shiftNo: sh.shiftNo, open: { name, t }, close: null };
      rows.push(open);
    } else {
      const close = { name, t, note: clean(event.note) };
      if (open && !open.close && t <= shiftOf(open.open.t, schedule).endMs + 2 * 3_600_000) {
        open.close = { ...close, name: close.name ?? open.open.name };
      } else {
        const sh = shiftOf(t, schedule);
        rows.push({ day: sh.day, shiftNo: sh.shiftNo, open: null, close });
        open = null;
      }
    }
  }
  return rows;
}

function collect(events, { fromMs, endMs, nowMs, refs }) {
  const schedule = refs.settings.schedule;
  const toEff = Math.min(endMs, nowMs);
  const stats = computeStats(events, { fromMs, toMs: toEff, nowMs, refs });
  const built = buildDowntimes(events, nowMs);

  // Остановка целиком (по downtimeId): начало, конец, идёт ли
  const stops = new Map();
  for (const seg of built.segments) {
    const stop = stops.get(seg.downtimeId) || { startMs: seg.startMs, endMs: seg.endMs, open: false };
    stop.startMs = Math.min(stop.startMs, seg.startMs);
    stop.endMs = Math.max(stop.endMs, seg.endMs);
    stop.open = stop.open || seg.open === true;
    stops.set(seg.downtimeId, stop);
  }

  // Части: отрезок простоя в границах одной смены и периода
  const parts = [];
  for (const seg of built.segments) {
    const startMs = Math.max(seg.startMs, fromMs);
    const endMsClip = Math.min(seg.endMs, toEff);
    if (endMsClip <= startMs) continue;
    for (const piece of splitByShifts({ startMs, endMs: endMsClip }, schedule)) {
      const shift = shiftOf(piece.startMs, schedule);
      const stop = stops.get(seg.downtimeId);
      const ongoing = seg.open === true && piece.endMs >= nowMs;
      const marks = [];
      if (stop.startMs < shift.startMs) marks.push("продолжение с прошлой смены");
      if (!ongoing && piece.endMs >= shift.endMs && (stop.open || stop.endMs > shift.endMs)) marks.push("перешёл в следующую смену");
      if (ongoing) marks.push("ещё идёт");
      if (seg.manual) marks.push("записан вручную");
      if (!hasText(seg.reason)) marks.push("причина не указана");
      const billet = seg.open !== true && Number.isFinite(seg.billet) && seg.billet > 0 && piece.endMs === seg.endMs ? seg.billet : 0;
      parts.push({
        downtimeId: seg.downtimeId, index: seg.index ?? 0, startMs: piece.startMs, endMs: piece.endMs,
        ms: piece.endMs - piece.startMs, day: shift.day, shiftNo: shift.shiftNo, shiftStartMs: shift.startMs,
        reason: hasText(seg.reason) ? seg.reason : null, zone: zoneOf(seg.reason, refs), note: clean(seg.note),
        action: clean(seg.action), billet, manual: seg.manual === true, ongoing, marks, minutes: 0,
      });
    }
  }
  parts.sort((a, b) => a.startMs - b.startMs || compareText(String(a.downtimeId), String(b.downtimeId)) || a.index - b.index);

  // Минуты части — как в списке простоев на экране: каждая часть округляется сама
  for (const p of parts) p.minutes = Math.round(p.ms / MINUTE);

  // Смены периода по расписанию и учтённое время в каждой
  const slots = [];
  for (let t = fromMs; t < endMs;) {
    const sh = shiftOf(t, schedule);
    slots.push({ day: sh.day, shiftNo: sh.shiftNo, startMs: sh.startMs, endMs: sh.endMs });
    t = sh.endMs;
  }
  const accounted = slots.map((s) => Math.max(0, Math.min(s.endMs, toEff) - Math.max(s.startMs, stats.dataFromMs ?? toEff)));
  const accountedMin = apportionMs(accounted, stats.totalMin);
  const slotParts = slots.map((slot) => parts.filter((p) => p.day === slot.day && p.shiftNo === slot.shiftNo));
  // Таблица смен: минуты зоны раскладываются по сменам так, что столбец даёт ровно минуты зоны из показателей
  const zoneCells = Object.fromEntries(ZONES.map((zone) => {
    const msList = slotParts.map((own) => own.filter((p) => p.zone === zone).reduce((sum, p) => sum + p.ms, 0));
    const row = (stats.byZone || []).find((r) => r.zone === zone);
    const target = row ? row.minutes : Math.round(msList.reduce((sum, ms) => sum + ms, 0) / MINUTE);
    return [zone, apportionMs(msList, target)];
  }));
  const firstShift = new Map(); // остановка → ключ смены, где она появилась в периоде первой
  for (const p of parts) if (!firstShift.has(p.downtimeId)) firstShift.set(p.downtimeId, `${p.day}|${p.shiftNo}`);
  const shiftRows = [];
  slots.forEach((slot, i) => {
    if (accounted[i] <= 0) return;
    const key = `${slot.day}|${slot.shiftNo}`;
    const zoneMin = Object.fromEntries(ZONES.map((z) => [z, zoneCells[z][i]]));
    const down = ZONES.reduce((sum, z) => sum + zoneMin[z], 0);
    const work = Math.max(0, accountedMin[i] - down);
    const downMs = slotParts[i].reduce((sum, p) => sum + p.ms, 0);
    shiftRows.push({
      day: slot.day, shiftNo: slot.shiftNo, key, accountedMin: work + down, workMin: work, zoneMin, downMin: down,
      // Доля — по точным миллисекундам, как «Доля работы» на экране
      share: Math.max(0, accounted[i] - downMs) / accounted[i],
      stops: [...firstShift.values()].filter((k) => k === key).length,
      billet: slotParts[i].reduce((sum, p) => sum + p.billet, 0),
    });
  });

  return { stats, parts, shiftRows, stops, toEff };
}

// ---------- Листы ----------

function shiftsText(schedule) {
  const shifts = schedule.shifts;
  return shifts.map((s, i) => `Смена ${s.no} — ${s.start}–${shifts[(i + 1) % shifts.length].start}`).join("; ");
}

function contextText({ fromDay, toDay, nowMs, schedule, includesNow }) {
  const tz = schedule.tzOffsetMinutes || 0;
  const zone = tzName(tz);
  const start = dayStartHm(schedule);
  const [date, time] = ruDateTime(nowMs, tz).split(" ");
  return `Период: с ${ruDate(fromDay)} ${start} по ${ruDate(addDays(toDay, 1))} ${start} ${zone} (сутки с ${start} до ${start}). ` +
    `Скачан: ${date} в ${time} ${zone}. Смены: ${shiftsText(schedule)}.` +
    `${includesNow ? " Период включает текущий момент: время считается до момента скачивания." : ""}`;
}

/** Первые две строки листа: заголовок и контекст; высота контекста — по числу строк текста. */
function frame(title, context, widths) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  const lines = Math.max(1, Math.ceil(context.length / Math.max(20, total * 1.05)));
  const last = widths.length - 1;
  return {
    rows: [
      { cells: [{ v: title, bold: true, size: 14 }], height: 24 },
      { cells: [{ v: context, size: 10, color: "4A5463", wrap: true, va: "top" }], height: 13.5 * lines + 4 },
    ],
    merges: [{ r: 0, c: 0, r2: 0, c2: last }, { r: 1, c: 0, r2: 1, c2: last }],
  };
}

function headerRow(titles) {
  return { cells: titles.map((v) => ({ v, ...HEAD })), height: 32 };
}

function noteRow(v, widths) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  const lines = Math.max(1, Math.ceil(v.length / Math.max(20, total * 1.05)));
  return { cells: [{ v, size: 10, color: "4A5463", wrap: true, va: "top" }], height: 13.5 * lines + 3 };
}

function summarySheet(data, ctx) {
  const { stats, parts } = data;
  const { refs } = ctx;
  const widths = [46, 22, 14, 14, 22];
  const f = frame("Отчёт по простоям стана — сводка", ctx.context, widths);
  const rows = [...f.rows, headerRow(["Показатель", "Значение"])];
  const section = (title) => rows.push({ cells: [{ v: title, ...SECTION }, { v: null, ...SECTION }], height: 20 });
  const row = (label, cell, extra) => rows.push([text(label, extra), cell]);
  const byZone = (zone) => (stats.byZone || []).find((r) => r.zone === zone);
  const noData = stats.noData;

  section("Время");
  row("Учтённое время", duration(stats.totalMin));
  section("Простой по зонам");
  row("Работа", duration(byZone("work")?.minutes ?? stats.workMin));
  row("Доля работы", percent(noData ? null : byZone("work")?.share ?? null));
  row("Плановый простой", duration(byZone("plan")?.minutes ?? 0));
  row("Внеплановый простой", duration(byZone("unplanned")?.minutes ?? 0));
  row("Аварийный простой", duration(byZone("failure")?.minutes ?? 0));
  row("Простой", duration(stats.downMin), { bold: true });
  section("Показатели");
  row("Остановок, шт", integer(stats.stops));
  row("Средний простой", duration(stats.avgStopMin));
  row("Самый долгий простой", duration(stats.longest ? stats.longest.minutes : null));
  if (stats.longest) {
    const tz = refs.settings.schedule.tzOffsetMinutes || 0;
    row("причина", text(reasonTitle(stats.longest.reason, refs), { h: "right" }), { indent: 2, color: "4A5463" });
    row("начало", dateTime(stats.longest.startMs, tz), { indent: 2, color: "4A5463" });
  }
  row("Доступность", percent(stats.availability));
  row("Работа между отказами", duration(stats.mtbfMin));
  row("Время на ремонт", duration(stats.mttrMin));
  row("Плановые", duration(stats.plannedMin));
  row("Внеплановые", duration(stats.unplannedMin));
  section("Проверить");
  row("Без причины, остановок", integer(stats.quality?.noReason ?? 0));
  row("Не указано, что сделали, остановок", integer(stats.quality?.noAction ?? 0));
  section("Брак");
  row("Брак заготовки всего, тн", tons(Math.round(parts.reduce((sum, p) => sum + p.billet, 0) * 1000) / 1000));

  // Простои по причинам
  rows.push([]);
  rows.push({ cells: [{ v: "Простои по причинам", bold: true, size: 12 }], height: 20 });
  const tableTop = rows.length;
  rows.push(headerRow(["Причина", "Тип", "Остановок", "Время", "Доля от всех простоев"]));
  // Строки экрана делятся ещё и по режиму (остановка без причины короче порога — «короткая»); в файле
  // одна причина — одна строка. Остановки считаем по номеру простоя, время — суммой строк экрана.
  const merged = new Map();
  for (const r of stats.byReason || []) {
    const key = r.reason ?? "";
    merged.set(key, { reason: r.reason ?? null, minutes: (merged.get(key)?.minutes ?? 0) + r.minutes });
  }
  const reasons = [...merged.values()].map((r) => ({
    ...r, stops: new Set(parts.filter((p) => p.reason === r.reason).map((p) => p.downtimeId)).size,
  })).sort((a, b) => b.minutes - a.minutes || compareText(reasonTitle(a.reason, refs), reasonTitle(b.reason, refs)));
  let sumMin = 0;
  let sumStops = 0;
  for (const r of reasons) {
    sumMin += r.minutes;
    sumStops += r.stops;
    rows.push([
      text(reasonTitle(r.reason, refs)), zoneCell(zoneOf(r.reason, refs)), integer(r.stops), duration(r.minutes),
      percent(stats.downMin > 0 ? r.minutes / stats.downMin : null),
    ]);
  }
  if (!reasons.length) rows.push([text("Простоев за период не было"), text(""), text(""), text(""), text("")]);
  rows.push([
    { v: "Итого", ...TOTAL }, { v: null, ...TOTAL }, integer(stats.stops, TOTAL), duration(stats.downMin, TOTAL),
    percent(stats.downMin > 0 ? 1 : null, TOTAL),
  ]);

  // Пояснения: чтобы файл читался без экрана
  rows.push([]);
  const notes = [];
  if (reasons.length && sumMin !== stats.downMin) notes.push("Время по причинам округлено по каждой строке, поэтому сумма строк может отличаться от итога на 1–2 минуты.");
  const journalMin = parts.reduce((sum, p) => sum + p.minutes, 0);
  if (journalMin !== stats.downMin) {
    notes.push(`Длительность каждой части простоя в журнале округлена до минуты, как на экране, поэтому сумма журнала (${hm(journalMin)}) может немного отличаться от «Простоя» в сводке (${hm(stats.downMin)}), посчитанного по точному времени.`);
  }
  if (sumStops > stats.stops) notes.push("Остановка, у которой менялась причина, учтена в каждой своей причине, поэтому сумма остановок по строкам больше итога.");
  notes.push("Тип простоя определяется причиной: плановый, внеплановый или авария. Остановка без причины считается внеплановой, как на экране «Показатели стана».");
  notes.push("Доступность — доля работы во времени без плановых остановок. «Работа между отказами» и «время на ремонт» считаются по внеплановым простоям.");
  notes.push(`«Плановые» и «Внеплановые» — как на экране «Показатели стана»: внеплановые включают аварии; остановки без причины короче ${refs.settings.shortStopMinutes ?? 5} мин в них не входят, но входят в «Простой».`);
  for (const n of notes) rows.push(noteRow(n, widths));
  const last = rows.length - 1;
  const merges = [...f.merges];
  for (let r = last - notes.length + 1; r <= last; r++) merges.push({ r, c: 0, r2: r, c2: widths.length - 1 });
  merges.push({ r: tableTop - 1, c: 0, r2: tableTop - 1, c2: widths.length - 1 });
  return { name: REPORT_SHEETS[0], columns: widths.map((width) => ({ width })), rows, merges, freeze: { rows: 3, cols: 0 }, landscape: true };
}

function shiftSheet(data, ctx, masters) {
  const { shiftRows } = data;
  const widths = [12, 10, 34, 11, 11, 11, 13, 11, 11, 12, 10];
  const f = frame("Отчёт по простоям стана — по сменам", ctx.context, widths);
  const rows = [...f.rows, headerRow(["Сутки", "Смена", "Мастер", "Учтено", "Работа", "Плановые", "Внеплановые", "Аварии", "Остановок", "Доля работы", "Брак, тн"])];
  const merges = [...f.merges];
  for (const s of shiftRows) {
    const names = masters.get(s.key) || [];
    rows.push([
      dayCell(s.day), text(`Смена ${s.shiftNo}`, { h: "center" }), text(names.length ? names.join(", ") : "Смена не принята"),
      duration(s.accountedMin), duration(s.workMin), duration(s.zoneMin.plan), duration(s.zoneMin.unplanned), duration(s.zoneMin.failure),
      integer(s.stops), percent(s.share), tons(Math.round(s.billet * 1000) / 1000),
    ]);
  }
  if (!shiftRows.length) {
    rows.push(noteRow("За выбранный период записей нет: учёт начинается с первого нажатия на планшете.", widths));
    merges.push({ r: rows.length - 1, c: 0, r2: rows.length - 1, c2: widths.length - 1 });
  } else {
    const sum = (pick) => shiftRows.reduce((total, s) => total + pick(s), 0);
    const accounted = sum((s) => s.accountedMin);
    const work = sum((s) => s.workMin);
    // Итоговая доля — та же, что «Доля работы» в сводке (по точному времени, не по округлённым минутам)
    const workShare = (data.stats.byZone || []).find((r) => r.zone === "work")?.share;
    rows.push([
      { v: "Итого", ...TOTAL }, { v: null, ...TOTAL }, { v: null, ...TOTAL },
      duration(accounted, TOTAL), duration(work, TOTAL), duration(sum((s) => s.zoneMin.plan), TOTAL),
      duration(sum((s) => s.zoneMin.unplanned), TOTAL), duration(sum((s) => s.zoneMin.failure), TOTAL),
      integer(sum((s) => s.stops), TOTAL), percent(accounted > 0 ? (workShare ?? work / accounted) : null, TOTAL),
      tons(Math.round(sum((s) => s.billet) * 1000) / 1000, TOTAL),
    ]);
  }
  return {
    name: REPORT_SHEETS[1], columns: widths.map((width) => ({ width })), rows, merges,
    freeze: { rows: 3, cols: 0 }, printTitleRows: [2, 2], landscape: true,
  };
}

function journalSheet(data, ctx, masters) {
  const { parts } = data;
  const { refs } = ctx;
  const tz = refs.settings.schedule.tzOffsetMinutes || 0;
  const widths = [5, 11, 9, 24, 16, 16, 12, 12, 20, 34, 34, 8, 28];
  const f = frame("Отчёт по простоям стана — журнал простоев", ctx.context, widths);
  const rows = [...f.rows, headerRow(["№", "Сутки", "Смена", "Мастер", "Начало", "Конец", "Длительность", "Тип", "Причина", "Что случилось", "Что сделали", "Брак, тн", "Отметка"])];
  const merges = [...f.merges];
  parts.forEach((p, i) => {
    const names = masters.get(`${p.day}|${p.shiftNo}`) || [];
    rows.push([
      integer(i + 1, { h: "center" }), dayCell(p.day), text(`Смена ${p.shiftNo}`, { h: "center" }),
      text(names.length ? names.join(", ") : "Смена не принята"),
      dateTime(p.startMs, tz), p.ongoing ? text("", { h: "center" }) : dateTime(p.endMs, tz), duration(p.minutes),
      zoneCell(p.zone), text(reasonTitle(p.reason, refs)), text(p.note), text(p.action),
      p.billet > 0 ? tons(Math.round(p.billet * 1000) / 1000) : text(""), text(p.marks.join("; ")),
    ]);
  });
  if (!parts.length) {
    rows.push(noteRow("За выбранный период простоев не было.", widths));
    merges.push({ r: rows.length - 1, c: 0, r2: rows.length - 1, c2: widths.length - 1 });
  }
  return {
    name: REPORT_SHEETS[2], columns: widths.map((width) => ({ width })), rows, merges,
    freeze: { rows: 3, cols: 0 }, printTitleRows: [2, 2], landscape: true,
    autoFilter: parts.length ? { r: 2, c: 0, r2: rows.length - 1, c2: widths.length - 1 } : null,
  };
}

function handoverSheet(handovers, ctx) {
  const { refs } = ctx;
  const tz = refs.settings.schedule.tzOffsetMinutes || 0;
  const widths = [12, 10, 32, 17, 32, 17, 60];
  const f = frame("Отчёт по простоям стана — приём и сдача смен", ctx.context, widths);
  const rows = [...f.rows, headerRow(["Сутки", "Смена", "Принял", "Время приёма", "Сдал", "Время сдачи", "Замечание при сдаче"])];
  const merges = [...f.merges];
  for (const h of handovers) {
    rows.push([
      dayCell(h.day), text(`Смена ${h.shiftNo}`, { h: "center" }),
      text(h.open ? h.open.name || "Не указан" : ""), dateTime(h.open?.t ?? null, tz),
      text(h.close ? h.close.name || "Не указан" : ""), dateTime(h.close?.t ?? null, tz), text(h.close ? h.close.note : ""),
    ]);
  }
  if (!handovers.length) {
    rows.push(noteRow("За выбранный период приёма и сдачи смен не было.", widths));
    merges.push({ r: rows.length - 1, c: 0, r2: rows.length - 1, c2: widths.length - 1 });
  }
  return {
    name: REPORT_SHEETS[3], columns: widths.map((width) => ({ width })), rows, merges,
    freeze: { rows: 3, cols: 0 }, printTitleRows: [2, 2], landscape: true,
  };
}

/**
 * Модель книги отчёта за производственные сутки fromDay…toDay включительно (мс — по часам nowMs).
 * events — события из базы (объекты); refs — справочники (reasons, people, settings.schedule).
 */
export function buildReport(events, { fromDay, toDay, nowMs, refs, settings } = {}) {
  const useRefs = settings ? { ...refs, settings } : refs;
  const schedule = useRefs.settings.schedule;
  const period = checkReportPeriod({ from: fromDay, to: toDay }, nowMs, schedule);
  if (!period.ok) throw new Error(period.message);
  const tz = schedule.tzOffsetMinutes || 0;
  const data = collect(events, { fromMs: period.fromMs, endMs: period.endMs, nowMs, refs: useRefs });
  const includesNow = nowMs < period.endMs;
  const context = contextText({ fromDay, toDay, nowMs, schedule, includesNow });
  const ctx = { refs: useRefs, nowMs, context };
  const masters = mastersByShift(events, useRefs, schedule);
  const handovers = handoverRows(events, useRefs, schedule, period.fromMs, data.toEff);
  return {
    title: "Отчёт по простоям стана",
    creator: "Простой стана",
    createdMs: nowMs,
    sheets: [summarySheet(data, ctx), shiftSheet(data, ctx, masters), journalSheet(data, ctx, masters), handoverSheet(handovers, ctx)],
    meta: {
      fromDay, toDay, fromMs: period.fromMs, endMs: period.endMs, toMs: data.toEff, nowMs, tzOffsetMinutes: tz, includesNow,
      stats: data.stats, parts: data.parts, shiftRows: data.shiftRows, handovers, masters: Object.fromEntries(masters),
    },
  };
}

/**
 * Файл отчёта по запросу ?from=…&to=…: проверка периода, книга, байты .xlsx и имя файла.
 * Одно и то же для сервера и для демо. Отказ: { ok: false, message }.
 */
export function reportFile({ from, to, events, refs, nowMs }) {
  const schedule = refs.settings.schedule;
  const period = checkReportPeriod({ from, to }, nowMs, schedule);
  if (!period.ok) return period;
  const book = buildReport(events, { fromDay: period.fromDay, toDay: period.toDay, nowMs, refs });
  return {
    ok: true,
    bytes: buildXlsx(book),
    filename: reportFileName({ fromDay: period.fromDay, toDay: period.toDay, nowMs, tzOffsetMinutes: schedule.tzOffsetMinutes || 0 }),
    book,
  };
}
