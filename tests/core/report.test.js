import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { apportionMs, buildReport, durationWords, reportFile, ZONE_FILL, ZONE_LABEL, REPORT_SHEETS } from "../../app/core/report.js";
import { computeStats, periodRange } from "../../app/core/stats.js";
import { DEFAULT_SCHEDULE } from "../../app/core/core.js";
import { serialToMs } from "../helpers/xlsx-read.js";
import { T, build, dayFixture, eventMaker, minutesOf, refs, summaryCell } from "../helpers/report-fixtures.js";

const S = DEFAULT_SCHEDULE;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (cell) => new Date(serialToMs(cell.value)).toISOString().slice(0, 10);
const ymdhm = (cell) => new Date(serialToMs(cell.value)).toISOString().slice(0, 16).replace("T", " ");
const textsOf = (wb) => wb.sheets.flatMap((s) => s.rows.flatMap((row) => (row || []).filter((c) => c && c.type === "inlineStr").map((c) => c.value)));
const zoneMin = (stats, zone) => stats.byZone.find((z) => z.zone === zone).minutes;

/** Строки журнала простоев в виде объектов. */
function journal(wb) {
  const sheet = wb.sheets[2];
  const out = [];
  for (let r = 3; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    if (!row || typeof row[0]?.value !== "number") continue;
    out.push({
      n: row[0].value, day: ymd(row[1]), shift: row[2].value, master: row[3].value, start: ymdhm(row[4]),
      end: row[5] && row[5].value !== null ? ymdhm(row[5]) : null, minutes: minutesOf(row[6]), type: row[7].value, typeFill: row[7].fill,
      reason: row[8].value, note: row[9].value ?? "", action: row[10].value ?? "", billet: row[11].value ?? null, mark: row[12].value ?? "",
    });
  }
  return out;
}

/** Строки таблицы смен (без «Итого») и сама строка «Итого». */
function shiftTable(wb) {
  const sheet = wb.sheets[1];
  const rows = [];
  let total = null;
  for (let r = 3; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    const item = {
      label: row[0].value, shift: row[1]?.value, master: row[2]?.value, accounted: minutesOf(row[3]), work: minutesOf(row[4]),
      plan: minutesOf(row[5]), unplanned: minutesOf(row[6]), failure: minutesOf(row[7]), stops: row[8].value, share: row[9].value, billet: row[10].value,
    };
    if (item.label === "Итого") total = item; else rows.push({ ...item, day: ymd(row[0]) });
  }
  return { rows, total };
}

test("листы: четыре, в нужном порядке; строка 1 — заголовок, строка 2 — контекст, закреплена шапка", () => {
  const { events, now, day } = dayFixture();
  const { wb } = build(events, { fromDay: day, toDay: day, nowMs: now });
  assert.deepEqual(wb.sheets.map((s) => s.name), REPORT_SHEETS);
  assert.deepEqual(REPORT_SHEETS, ["Сводка", "По сменам", "Журнал простоев", "Приём и сдача смен"]);
  for (const sheet of wb.sheets) {
    assert.match(sheet.rows[0][0].value, /^Отчёт по простоям стана — /);
    assert.equal(sheet.rows[0][0].bold, true);
    const context = sheet.rows[1][0].value;
    assert.match(context, /^Период: с 01\.10\.2026 08:00 по 02\.10\.2026 08:00 МСК/);
    assert.match(context, /Скачан: 01\.10\.2026 в 22:30 МСК/);
    assert.match(context, /Смены: Смена 1 — 08:00–20:00; Смена 2 — 20:00–08:00/);
    assert.match(context, /Период включает текущий момент: время считается до момента скачивания/);
    assert.equal(sheet.rows[1][0].wrap, true);
    assert.ok(sheet.rowHeights.get(1) > 15, "контекст не обрезан по высоте строки");
    assert.ok(sheet.merges.includes(`A1:${String.fromCharCode(64 + sheet.columns.length)}1`));
    assert.ok(sheet.merges.includes(`A2:${String.fromCharCode(64 + sheet.columns.length)}2`));
    assert.equal(sheet.pane.ySplit, "3", "закреплены заголовок, контекст и шапка таблицы");
    assert.equal(sheet.pageSetup.orientation, "landscape");
  }
});

test("контекст: пометка только пока период включает «сейчас»; расписание берётся из настроек", () => {
  const { events, now } = dayFixture();
  const past = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: T("2026-10-02", "09:00:00") }).wb.sheets[0].rows[1][0].value;
  assert.doesNotMatch(past, /включает текущий момент/);
  assert.match(past, /Скачан: 02\.10\.2026 в 09:00 МСК/);
  const custom = { ...refs, settings: { ...refs.settings, schedule: { tzOffsetMinutes: 180, shifts: [{ no: 1, start: "07:00" }, { no: 2, start: "19:30" }] } } };
  const other = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: now, refs: custom }).wb.sheets[0].rows[1][0].value;
  assert.match(other, /Период: с 01\.10\.2026 07:00 по 02\.10\.2026 07:00 МСК \(сутки с 07:00 до 07:00\)/);
  assert.match(other, /Смена 1 — 07:00–19:30; Смена 2 — 19:30–07:00/);
});

test("сводка: итоги равны ручному расчёту и показателям экрана за те же сутки", () => {
  const { events, now, day } = dayFixture();
  const { wb } = build(events, { fromDay: day, toDay: day, nowMs: now });
  const sheet = wb.sheets[0];
  // Руками: учёт с 08:05 до 22:30 = 14 ч 25 мин; простой 154,67 мин → 155; зоны 45 + 65 + 45
  assert.equal(minutesOf(summaryCell(sheet, "Учтённое время")), 865);
  assert.equal(minutesOf(summaryCell(sheet, "Работа")), 710);
  assert.equal(minutesOf(summaryCell(sheet, "Простой")), 155);
  assert.equal(minutesOf(summaryCell(sheet, "Плановый простой")), 45);
  assert.equal(minutesOf(summaryCell(sheet, "Внеплановый простой")), 65);
  assert.equal(minutesOf(summaryCell(sheet, "Аварийный простой")), 45);
  assert.equal(summaryCell(sheet, "Остановок, шт").value, 5);
  assert.equal(summaryCell(sheet, "Брак заготовки всего, тн").value, 3.7);

  // Те же значения, что на экране «Показатели стана» → «Сутки»
  const stats = computeStats(events, { ...periodRange("day", now, S), nowMs: now, refs });
  const labelled = [
    ["Учтённое время", stats.totalMin], ["Работа", stats.workMin], ["Простой", stats.downMin],
    ["Плановый простой", zoneMin(stats, "plan")], ["Внеплановый простой", zoneMin(stats, "unplanned")], ["Аварийный простой", zoneMin(stats, "failure")],
    ["Средний простой", stats.avgStopMin], ["Самый долгий простой", stats.longest.minutes],
    ["Работа между отказами", stats.mtbfMin], ["Время на ремонт", stats.mttrMin], ["Плановые", stats.plannedMin], ["Внеплановые", stats.unplannedMin],
  ];
  for (const [label, minutes] of labelled) assert.equal(minutesOf(summaryCell(sheet, label)), minutes, label);
  assert.equal(summaryCell(sheet, "Остановок, шт").value, stats.stops);
  assert.equal(summaryCell(sheet, "Доступность").value, stats.availability);
  assert.equal(summaryCell(sheet, "Доля работы").value, stats.byZone.find((z) => z.zone === "work").share);
  assert.equal(summaryCell(sheet, "Без причины, остановок").value, stats.quality.noReason);
  assert.equal(summaryCell(sheet, "Не указано, что сделали, остановок").value, stats.quality.noAction);
  assert.equal(stats.quality.noReason, 2);
  assert.equal(stats.quality.noAction, 1);
  assert.equal(summaryCell(sheet, "причина").value, "Плановая (вид не указан)", "самый долгий — перевалка 45 мин 20 с");
});

test("сводка: таблица причин при печати начинается с новой страницы", () => {
  const { events, now, day } = dayFixture();
  const sheet = build(events, { fromDay: day, toDay: day, nowMs: now }).wb.sheets[0];
  const title = sheet.rows.findIndex((r) => r && r[0] && r[0].value === "Простои по причинам");
  assert.ok(title > 0);
  assert.deepEqual(sheet.rowBreaks, [{ id: title, max: 16383, man: "1" }]);
  for (const other of [1, 2, 3]) assert.deepEqual(build(events, { fromDay: day, toDay: day, nowMs: now }).wb.sheets[other].rowBreaks, []);
});

test("сводка: подписи как на экране, формат ячеек по заданию, шапка «Показатель | Значение»", () => {
  const { events, now, day } = dayFixture();
  const sheet = build(events, { fromDay: day, toDay: day, nowMs: now }).wb.sheets[0];
  const labels = sheet.rows.filter((r) => r && r[0] && r[1]).map((r) => r[0].value);
  for (const name of ["Учтённое время", "Работа", "Доля работы", "Простой", "Плановый простой", "Внеплановый простой", "Аварийный простой",
    "Остановок, шт", "Средний простой", "Самый долгий простой", "Доступность", "Работа между отказами", "Время на ремонт",
    "Плановые", "Внеплановые", "Брак заготовки всего, тн"]) assert.ok(labels.includes(name), name);
  assert.deepEqual(sheet.rows[2].map((c) => c.value), ["Показатель", "Значение"]);
  for (const label of ["Учтённое время", "Работа", "Простой", "Средний простой", "Самый долгий простой", "Работа между отказами", "Время на ремонт"]) {
    const cell = summaryCell(sheet, label);
    if (cell.value !== "—") assert.equal(typeof minutesOf(cell), "number", label); // словами: «2 часа, 29 минут»
  }
  for (const label of ["Доля работы", "Доступность"]) assert.equal(summaryCell(sheet, label).format, "0.0%", label);
  assert.equal(summaryCell(sheet, "Брак заготовки всего, тн").format, "0.0##");
  assert.equal(summaryCell(sheet, "Остановок, шт").format, "0");
  assert.equal(summaryCell(sheet, "начало").format, "dd\\.mm\\.yyyy\\ hh:mm");
});

test("сводка: простои по причинам — одна причина одна строка, тип, остановки, время, доля, «Итого»", () => {
  const { events, now, day } = dayFixture();
  const sheet = build(events, { fromDay: day, toDay: day, nowMs: now }).wb.sheets[0];
  const top = sheet.rows.findIndex((r) => r && r[0] && r[0].value === "Причина");
  assert.deepEqual(sheet.rows[top].map((c) => c.value), ["Причина", "Тип", "Остановок", "Время", "Доля от всех простоев"]);
  const body = [];
  for (let r = top + 1; sheet.rows[r]; r++) {
    const row = sheet.rows[r];
    body.push([row[0].value, row[1].value, row[2].value, minutesOf(row[3]), Math.round(row[4].value * 10000) / 10000]);
  }
  // «Без причины» экран делит на два режима, в файле — одна строка; сортировка по времени
  assert.deepEqual(body, [
    ["Аварийный простой", "Аварийный простой", 1, 45, Math.round(45 / 155 * 10000) / 10000],
    ["Плановая (вид не указан)", "Плановый простой", 1, 45, Math.round(45 / 155 * 10000) / 10000],
    ["Без причины", "Внеплановый простой", 2, 34, Math.round(34 / 155 * 10000) / 10000],
    ["Бурёжка (место не указано)", "Внеплановый простой", 1, 31, Math.round(31 / 155 * 10000) / 10000],
    ["Итого", undefined, 5, 155, 1],
  ].map((row) => (row[1] === undefined ? [row[0], null, row[2], row[3], row[4]] : row)));
  const fills = [];
  for (let r = top + 1; r < top + 5; r++) fills.push(sheet.rows[r][1].fill);
  assert.deepEqual(fills, ["FFE5383B", "FF3B82F6", "FFF2A900", "FFF2A900"]);
  assert.equal(sheet.rows[top + 5][0].bold, true);
  assert.equal(typeof minutesOf(sheet.rows[top + 5][3]), "number");
});

test("по сменам: значения как посчитано руками; «Итого» равно сводке; строки складываются", () => {
  const { events, now, day } = dayFixture();
  const { wb } = build(events, { fromDay: day, toDay: day, nowMs: now });
  assert.deepEqual(wb.sheets[1].rows[2].map((c) => c.value), ["Сутки", "Смена", "Мастер", "Учтено", "Работа", "Плановые", "Внеплановые", "Аварии", "Остановок", "Доля работы", "Брак, тн"]);
  const { rows, total } = shiftTable(wb);
  assert.deepEqual(rows.map((r) => [r.day, r.shift, r.master, r.accounted, r.work, r.plan, r.unplanned, r.failure, r.stops, r.billet]), [
    ["2026-10-01", "Смена 1", "Иванов Иван Иванович", 715, 619, 45, 31, 20, 3, 2.5],
    ["2026-10-01", "Смена 2", "Петров Пётр Петрович", 150, 91, 0, 34, 25, 2, 1.2],
  ]);
  assert.ok(Math.abs(rows[0].share - (715 * 60000 - (45.3333333 + 30.5 + 19.6666667) * 60000) / (715 * 60000)) < 1e-6);
  const sheet = wb.sheets[0];
  assert.equal(total.accounted, minutesOf(summaryCell(sheet, "Учтённое время")));
  assert.equal(total.work, minutesOf(summaryCell(sheet, "Работа")));
  assert.equal(total.plan, minutesOf(summaryCell(sheet, "Плановый простой")));
  assert.equal(total.unplanned, minutesOf(summaryCell(sheet, "Внеплановый простой")));
  assert.equal(total.failure, minutesOf(summaryCell(sheet, "Аварийный простой")));
  assert.equal(total.stops, summaryCell(sheet, "Остановок, шт").value);
  assert.equal(total.share, summaryCell(sheet, "Доля работы").value, "доля в «Итого» — как в сводке, по точному времени");
  assert.equal(total.billet, summaryCell(sheet, "Брак заготовки всего, тн").value);
  for (const key of ["accounted", "work", "plan", "unplanned", "failure", "stops", "billet"]) {
    assert.equal(Math.round(rows.reduce((sum, r) => sum + r[key], 0) * 1000) / 1000, total[key], key);
  }
  for (const r of rows) assert.equal(r.accounted, r.work + r.plan + r.unplanned + r.failure, "в строке учтённое = работа + простои");
  assert.equal(wb.sheets[1].rows[5][8].format, "0");
  assert.equal(wb.sheets[1].rows[3][0].format, "dd\\.mm\\.yyyy");
  assert.equal(wb.sheets[1].rows[3][9].format, "0.0%");
  assert.equal(wb.sheets[1].rows[3][10].format, "0.0##");
});

test("журнал: часть простоя в пределах смены, типы с цветом зоны, брак, отметки", () => {
  const { events, now, day } = dayFixture();
  const { wb } = build(events, { fromDay: day, toDay: day, nowMs: now });
  const sheet = wb.sheets[2];
  assert.deepEqual(sheet.rows[2].map((c) => c.value), ["№", "Сутки", "Смена", "Мастер", "Начало", "Конец", "Длительность", "Тип", "Причина", "Что случилось", "Что сделали", "Брак, тн", "Отметка", "Длительность, мин"]);
  assert.ok(sheet.rows[2].every((c) => c.bold && c.fill === "FFE3E8EF" && c.wrap), "жирная шапка с заливкой и переносом");
  assert.equal(sheet.autoFilter, "A3:N9");
  assert.equal(sheet.pane.topLeftCell, "A4");
  const rows = journal(wb);
  assert.deepEqual(rows.map((r) => [r.n, r.shift, r.start, r.end, r.minutes, r.type, r.reason, r.billet, r.mark]), [
    [1, "Смена 1", "2026-10-01 09:00", "2026-10-01 09:45", 45, "Плановый простой", "Плановая (вид не указан)", null, ""],
    [2, "Смена 1", "2026-10-01 14:20", "2026-10-01 14:50", 31, "Внеплановый простой", "Бурёжка (место не указано)", 2.5, ""],
    [3, "Смена 1", "2026-10-01 19:40", "2026-10-01 20:00", 20, "Аварийный простой", "Аварийный простой", null, "перешёл в следующую смену"],
    [4, "Смена 2", "2026-10-01 20:00", "2026-10-01 20:25", 25, "Аварийный простой", "Аварийный простой", 1.2, "продолжение с прошлой смены"],
    [5, "Смена 2", "2026-10-01 21:10", "2026-10-01 21:14", 4, "Внеплановый простой", "Без причины", null, "записан вручную; причина не указана"],
    [6, "Смена 2", "2026-10-01 22:00", null, 30, "Внеплановый простой", "Без причины", null, "ещё идёт; причина не указана"],
  ]);
  assert.deepEqual(rows.map((r) => r.master), [...Array(3).fill("Иванов Иван Иванович"), ...Array(3).fill("Петров Пётр Петрович")]);
  assert.deepEqual(rows.map((r) => [r.note, r.action]), [
    ["плановая перевалка валков", "валки заменены"], ["застряла заготовка", "убрали раскат"],
    ["сломался привод", "заменили муфту"], ["сломался привод", "заменили муфту"], ["", ""], ["", ""],
  ]);
  // Тип залит цветом зоны, как на экране
  assert.deepEqual(rows.map((r) => r.typeFill), ["FF3B82F6", "FFF2A900", "FFE5383B", "FFE5383B", "FFF2A900", "FFF2A900"]);
  // Даты — настоящие даты Excel по МСК, длительность — словами, число минут — последней колонкой
  assert.equal(sheet.rows[3][1].format, "dd\\.mm\\.yyyy");
  assert.equal(sheet.rows[3][4].format, "dd\\.mm\\.yyyy\\ hh:mm");
  assert.equal(sheet.rows[3][6].value, "45 минут");
  assert.equal(sheet.rows[2][13].value, "Длительность, мин");
  assert.equal(sheet.rows[3][13].value, 45);
  assert.equal(sheet.rows[3][4].value, 25569 + (Date.UTC(2026, 9, 1, 9, 0) / 86400000));
  assert.ok(sheet.rows[8][5].value === null, "у идущего простоя конца нет");
  assert.equal(sheet.rows[4][11].format, "0.0##");
  // Брак журнала = брак сводки
  const billet = rows.reduce((sum, r) => sum + (r.billet ?? 0), 0);
  assert.equal(Math.round(billet * 1000) / 1000, summaryCell(wb.sheets[0], "Брак заготовки всего, тн").value);
});

test("журнал: простой через границу суток 08:00 делится на строки двух суток", () => {
  const E = eventMaker();
  const events = [
    E("shift_open", "2026-10-01", "20:05:00", { crewId: "2", personId: "p2", personName: "Петров Пётр Петрович" }),
    E("stop", "2026-10-02", "07:50:00", { downtimeId: "N1", reason: "burezhka", note: "ночная бурёжка" }),
    E("start", "2026-10-02", "08:20:00", { downtimeId: "N1", action: "убрали" }),
  ];
  const now = T("2026-10-02", "12:00:00");
  const both = build(events, { fromDay: "2026-10-01", toDay: "2026-10-02", nowMs: now }).wb;
  assert.deepEqual(journal(both).map((r) => [r.day, r.shift, r.start, r.end, r.minutes, r.mark]), [
    ["2026-10-01", "Смена 2", "2026-10-02 07:50", "2026-10-02 08:00", 10, "перешёл в следующую смену"],
    ["2026-10-02", "Смена 1", "2026-10-02 08:00", "2026-10-02 08:20", 20, "продолжение с прошлой смены"],
  ]);
  assert.equal(summaryCell(both.sheets[0], "Остановок, шт").value, 1, "одна остановка, а не две части");
  assert.equal(shiftTable(both).total.stops, 1);
  assert.deepEqual(shiftTable(both).rows.map((r) => [r.day, r.shift, r.accounted, r.work, r.unplanned, r.stops]), [
    ["2026-10-01", "Смена 2", 715, 705, 10, 1], ["2026-10-02", "Смена 1", 240, 220, 20, 0],
  ]);
  // Один из двух суток: видна своя часть, начало помечено продолжением, остановка считается один раз
  const second = build(events, { fromDay: "2026-10-02", toDay: "2026-10-02", nowMs: now }).wb;
  assert.deepEqual(journal(second).map((r) => [r.day, r.minutes, r.mark]), [["2026-10-02", 20, "продолжение с прошлой смены"]]);
  assert.equal(summaryCell(second.sheets[0], "Остановок, шт").value, 1);
  const first = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: now }).wb;
  assert.deepEqual(journal(first).map((r) => [r.day, r.minutes, r.mark]), [["2026-10-01", 10, "перешёл в следующую смену"]]);
});

test("открытый простой: до «сейчас»; прошедшие сутки — «перешёл», текущие — «ещё идёт»", () => {
  const E = eventMaker();
  const events = [
    E("shift_open", "2026-10-01", "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("stop", "2026-10-01", "22:00:00", { downtimeId: "O1", reason: "burezhka", note: "идёт" }),
  ];
  const night = T("2026-10-02", "03:00:00"); // ещё сутки 01.10, смена 2
  const a = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: night }).wb;
  assert.deepEqual(journal(a).map((r) => [r.start, r.end, r.minutes, r.mark]), [["2026-10-01 22:00", null, 300, "ещё идёт"]]);
  assert.equal(minutesOf(summaryCell(a.sheets[0], "Простой")), 300);
  const morning = T("2026-10-02", "09:00:00");
  const past = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: morning }).wb;
  assert.deepEqual(journal(past).map((r) => [r.start, r.end, r.minutes, r.mark]), [["2026-10-01 22:00", "2026-10-02 08:00", 600, "перешёл в следующую смену"]]);
  const current = build(events, { fromDay: "2026-10-02", toDay: "2026-10-02", nowMs: morning }).wb;
  assert.deepEqual(journal(current).map((r) => [r.start, r.end, r.minutes, r.mark]), [["2026-10-02 08:00", null, 60, "продолжение с прошлой смены; ещё идёт"]]);
  assert.equal(minutesOf(summaryCell(current.sheets[0], "Простой")), 60);
  assert.equal(summaryCell(current.sheets[0], "Остановок, шт").value, 1);
  // Учтено считается до «сейчас»: с начала суток 08:00 до 09:00
  assert.equal(shiftTable(current).total.accounted, 60);
});

test("время после «сейчас» не считается", () => {
  const E = eventMaker();
  const now = T("2026-10-01", "12:00:00");
  const events = [
    E("shift_open", "2026-10-01", "08:00:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("manual", "2026-10-01", "12:00:00", { downtimeId: "F1", reason: "avaria", from: iso(T("2026-10-01", "11:50:00")), to: iso(T("2026-10-01", "12:01:00")) }),
    E("stop", "2026-10-01", "12:01:00", { downtimeId: "F2", reason: "burezhka" }), // допуск сервера на 2 минуты
  ];
  const { wb, book } = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: now });
  assert.equal(minutesOf(summaryCell(wb.sheets[0], "Учтённое время")), 240);
  assert.equal(minutesOf(summaryCell(wb.sheets[0], "Простой")), 10);
  assert.equal(summaryCell(wb.sheets[0], "Остановок, шт").value, 1);
  assert.deepEqual(journal(wb).map((r) => [r.start, r.end, r.minutes]), [["2026-10-01 11:50", "2026-10-01 12:00", 10]]);
  assert.ok(book.meta.parts.every((p) => p.endMs <= now));
  assert.equal(shiftTable(wb).total.accounted, 240);
  assert.equal(shiftTable(wb).rows.length, 1, "будущая смена 2 в таблице не появляется");
});

test("остановки считаются по номеру простоя; смена причины не делает вторую остановку", () => {
  const E = eventMaker();
  const d = "2026-10-01";
  const events = [
    E("shift_open", d, "08:00:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("stop", d, "19:30:00", { downtimeId: "S1", reason: "burezhka", note: "сначала бурёжка" }),
    E("split", d, "19:50:00", { downtimeId: "S1", reason: "avaria", note: "оказалась авария" }),
    E("start", d, "20:30:00", { downtimeId: "S1", action: "починили" }),
  ];
  const now = T(d, "22:00:00");
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: now });
  const stats = computeStats(events, { ...periodRange("day", now, S), nowMs: now, refs });
  assert.equal(stats.stops, 1);
  assert.equal(summaryCell(wb.sheets[0], "Остановок, шт").value, 1);
  assert.equal(shiftTable(wb).total.stops, 1);
  assert.deepEqual(shiftTable(wb).rows.map((r) => r.stops), [1, 0]);
  assert.deepEqual(journal(wb).map((r) => [r.shift, r.reason, r.start, r.end, r.minutes, r.mark]), [
    ["Смена 1", "Бурёжка (место не указано)", "2026-10-01 19:30", "2026-10-01 19:50", 20, ""],
    ["Смена 1", "Аварийный простой", "2026-10-01 19:50", "2026-10-01 20:00", 10, "перешёл в следующую смену"],
    ["Смена 2", "Аварийный простой", "2026-10-01 20:00", "2026-10-01 20:30", 30, "продолжение с прошлой смены"],
  ]);
  // В таблице причин остановка видна в каждой из двух причин, итог — одна; файл говорит об этом сам
  const notes = textsOf(wb).filter((t) => t.startsWith("Остановка, у которой менялась причина"));
  assert.equal(notes.length, 1);
});

test("мастера: все принимавшие смену через запятую, без повторов; нет приёма — «Смена не принята»", () => {
  const E = eventMaker();
  const d = "2026-10-01";
  const events = [
    E("shift_open", d, "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("shift_open", d, "10:00:00", { crewId: "1", personId: "p3" }), // имя — из справочника по personId
    E("shift_open", d, "11:00:00", { crewId: "1", personId: "p1", personName: "  Иванов Иван Иванович " }),
    E("stop", d, "21:00:00", { downtimeId: "Z1", reason: "avaria" }),
    E("start", d, "21:30:00", { downtimeId: "Z1" }),
  ];
  const now = T(d, "22:00:00");
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: now });
  const { rows } = shiftTable(wb);
  assert.deepEqual(rows.map((r) => r.master), ["Иванов Иван Иванович, Сидоров Сидор Сидорович", "Смена не принята"]);
  assert.deepEqual(journal(wb).map((r) => r.master), ["Смена не принята"]);
});

test("приём и сдача: повтор без сдачи — одна запись, поздняя сдача в той же строке, повторный приём — новая", () => {
  const E = eventMaker();
  const d1 = "2026-10-01";
  const d2 = "2026-10-02";
  const events = [
    E("shift_open", d1, "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("shift_open", d1, "08:06:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("shift_close", d1, "20:10:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович", note: "Передали смену." }),
    E("shift_open", d1, "20:15:00", { crewId: "2", personId: "p2", personName: "Петров Пётр Петрович" }),
    E("shift_close", d2, "07:50:00", { crewId: "2", personId: "p2", personName: "Петров Пётр Петрович", note: "Ночь без происшествий" }),
    E("shift_open", d2, "07:55:00", { crewId: "2", personId: "p3", personName: "Сидоров Сидор Сидорович" }),
    E("shift_close", d2, "15:00:00", { crewId: "1", personId: "p1" }), // сдача без приёма в этой смене
  ];
  const now = T(d2, "16:00:00");
  const sheet = build(events, { fromDay: d1, toDay: d2, nowMs: now }).wb.sheets[3];
  assert.deepEqual(sheet.rows[2].map((c) => c.value), ["Сутки", "Смена", "Принял", "Время приёма", "Сдал", "Время сдачи", "Замечание при сдаче"]);
  const rows = [];
  for (let r = 3; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    rows.push([ymd(row[0]), row[1].value, row[2].value ?? "", row[3].value === null ? null : ymdhm(row[3]), row[4].value ?? "", row[5].value === null ? null : ymdhm(row[5]), row[6].value ?? ""]);
  }
  assert.deepEqual(rows, [
    ["2026-10-01", "Смена 1", "Иванов Иван Иванович", "2026-10-01 08:05", "Иванов Иван Иванович", "2026-10-01 20:10", "Передали смену."],
    ["2026-10-01", "Смена 2", "Петров Пётр Петрович", "2026-10-01 20:15", "Петров Пётр Петрович", "2026-10-02 07:50", "Ночь без происшествий"],
    ["2026-10-01", "Смена 2", "Сидоров Сидор Сидорович", "2026-10-02 07:55", "", null, ""],
    ["2026-10-02", "Смена 1", "", null, "Иванов Иван Иванович", "2026-10-02 15:00", ""],
  ]);
  assert.equal(sheet.rows[3][3].format, "dd\\.mm\\.yyyy\\ hh:mm");
});

test("в файле нет внутренних кодов: ни ключей причин, ни номеров простоев, ни старых кодов", () => {
  const E = eventMaker();
  const d = "2026-10-01";
  const events = [
    E("shift_open", d, "08:00:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("stop", d, "09:00:00", { downtimeId: "uuid-1111", reason: "perevalka" }), E("start", d, "09:10:00", { downtimeId: "uuid-1111" }),
    E("stop", d, "10:00:00", { downtimeId: "uuid-2222", reason: "burezhka" }), E("start", d, "10:10:00", { downtimeId: "uuid-2222" }),
    E("stop", d, "11:00:00", { downtimeId: "uuid-3333", reason: "avaria" }), E("start", d, "11:10:00", { downtimeId: "uuid-3333" }),
    E("stop", d, "12:00:00", { downtimeId: "uuid-4444", reason: "П-03" }), E("start", d, "12:10:00", { downtimeId: "uuid-4444" }),
    E("stop", d, "13:00:00", { downtimeId: "uuid-5555", reason: "В-Э-01" }), E("start", d, "13:10:00", { downtimeId: "uuid-5555" }),
    E("stop", d, "14:00:00", { downtimeId: "uuid-6666", reason: "В-Т-05" }), E("start", d, "14:10:00", { downtimeId: "uuid-6666" }),
    E("stop", d, "15:00:00", { downtimeId: "uuid-7777", reason: "какой-то-код-xyz" }), E("start", d, "15:10:00", { downtimeId: "uuid-7777" }),
  ];
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: T(d, "18:00:00") });
  const all = textsOf(wb).join("\n");
  for (const hidden of [...Object.keys(refs.reasons), "uuid-", "П-03", "В-Э-01", "В-Т-05", "xyz", "downtimeId", "undefined", "null", "NaN", "[object"]) {
    assert.ok(!all.includes(hidden), `в файле есть «${hidden}»`);
  }
  const reasons = journal(wb).map((r) => r.reason);
  assert.deepEqual(reasons, ["Плановая (вид не указан)", "Бурёжка (место не указано)", "Аварийный простой", "Плановая (вид не указан)", "Аварийный простой", "Бурёжка (место не указано)", "Причина не из справочника"]);
});

test("цвета типов — токены --z-plan, --z-unplanned, --z-failure светлой темы app.css; подписи — как в легенде шкалы", () => {
  const css = fs.readFileSync(new URL("../../app/public/app.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf(':root[data-theme="light"] {'));
  const token = (name) => new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(block.slice(0, block.indexOf("\n}")))[1].toUpperCase();
  assert.deepEqual(ZONE_FILL, { plan: token("z-plan"), unplanned: token("z-unplanned"), failure: token("z-failure") });
  const legend = fs.readFileSync(new URL("../../app/public/timeline.js", import.meta.url), "utf8");
  for (const [zone, label] of Object.entries(ZONE_LABEL)) assert.ok(legend.includes(`["${zone}", "${label}"]`), `${zone}: ${label}`);
  assert.deepEqual(ZONE_LABEL, { plan: "Плановый простой", unplanned: "Внеплановый простой", failure: "Аварийный простой" });
});

test("пустая база: файл есть, на листах пояснения вместо таблиц, без фильтра", () => {
  const now = T("2026-10-01", "12:00:00");
  const { wb } = build([], { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: now });
  assert.deepEqual(wb.sheets.map((s) => s.name), REPORT_SHEETS);
  const sheet = wb.sheets[0];
  assert.equal(minutesOf(summaryCell(sheet, "Учтённое время")), 0);
  assert.equal(minutesOf(summaryCell(sheet, "Простой")), 0);
  assert.equal(summaryCell(sheet, "Остановок, шт").value, 0);
  for (const label of ["Доля работы", "Доступность", "Средний простой", "Самый долгий простой", "Работа между отказами", "Время на ремонт"]) {
    assert.equal(summaryCell(sheet, label).value, "—", label);
  }
  assert.ok(!sheet.rows.some((r) => r && r[0] && r[0].value === "причина"), "нет строк про самый долгий простой");
  assert.ok(textsOf(wb).includes("За выбранный период записей нет: учёт начинается с первого нажатия на планшете."));
  assert.ok(textsOf(wb).includes("За выбранный период простоев не было."));
  assert.ok(textsOf(wb).includes("За выбранный период приёма и сдачи смен не было."));
  assert.equal(wb.sheets[2].autoFilter, null);
});

test("пустая сводка по причинам: «Простоев за период не было» и «Итого» нули", () => {
  const E = eventMaker();
  const events = [E("shift_open", "2026-10-01", "08:00:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" })];
  const sheet = build(events, { fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: T("2026-10-01", "10:00:00") }).wb.sheets[0];
  const top = sheet.rows.findIndex((r) => r && r[0] && r[0].value === "Причина");
  assert.equal(sheet.rows[top + 1][0].value, "Простоев за период не было");
  assert.equal(sheet.rows[top + 2][0].value, "Итого");
  assert.equal(sheet.rows[top + 2][2].value, 0);
  assert.equal(minutesOf(summaryCell(sheet, "Работа")), 120);
  assert.equal(summaryCell(sheet, "Доля работы").value, 1);
});

test("сумма журнала округляется по строкам: расхождение с «Простоем» объясняется в сводке", () => {
  const E = eventMaker();
  const d = "2026-10-01";
  const events = [E("shift_open", d, "08:00:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" })];
  ["09:00:00", "10:00:00", "11:00:00"].forEach((from, i) => {
    const [h] = from.split(":");
    events.push(E("stop", d, from, { downtimeId: "R" + i, reason: "burezhka" }), E("start", d, `${h}:01:30`, { downtimeId: "R" + i }));
  });
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: T(d, "12:00:00") });
  assert.equal(minutesOf(summaryCell(wb.sheets[0], "Простой")), 5, "три по 1 мин 30 с = 4,5 мин → 5");
  assert.deepEqual(journal(wb).map((r) => r.minutes), [2, 2, 2], "каждая часть округлена, как на экране");
  assert.equal(shiftTable(wb).total.unplanned, 5, "таблица смен сходится со сводкой");
  const note = textsOf(wb).find((t) => t.startsWith("Длительность каждой части простоя в журнале округлена"));
  assert.ok(note && note.includes("(6 минут)") && note.includes("(5 минут)"), String(note));
});

test("метод наибольшего остатка: сумма равна цели, каждое число — вниз или вверх от точного", () => {
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 300; run++) {
    const msList = Array.from({ length: Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 5_000_000));
    const exact = msList.reduce((sum, v) => sum + v, 0) / 60000;
    const target = Math.round(exact);
    const out = apportionMs(msList, target);
    assert.equal(out.reduce((sum, v) => sum + v, 0), msList.length ? target : 0, JSON.stringify(msList));
    out.forEach((v, i) => assert.ok(v === Math.floor(msList[i] / 60000) || v === Math.floor(msList[i] / 60000) + 1));
  }
  assert.deepEqual(apportionMs([], 0), []);
  assert.deepEqual(apportionMs([90_000, 90_000], 3), [2, 1], "при равных остатках первым достаётся +1 тому, кто раньше");
});

test("ошибки периода: buildReport бросает, reportFile возвращает сообщение", () => {
  const { events, now } = dayFixture();
  assert.throws(() => buildReport(events, { fromDay: "2026-10-02", toDay: "2026-10-01", nowMs: now, refs }), /не может быть позже/);
  assert.throws(() => buildReport(events, { fromDay: "2026-10-01", toDay: "2026-10-05", nowMs: now, refs }), /ещё не наступила/);
  const bad = reportFile({ from: "2026-10-01", to: "2026-13-01", events, refs, nowMs: now });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Дата «По» указана неверно/);
  const good = reportFile({ from: "2026-10-01", to: "2026-10-01", events, refs, nowMs: now });
  assert.equal(good.ok, true);
  assert.equal(good.filename, "Отчёт по простоям стана за 01.10.2026, скачан 01.10.2026 в 22-30.xlsx");
  assert.deepEqual([...good.bytes.slice(0, 2)], [0x50, 0x4b]);
  assert.equal(good.book.sheets.length, 4);
});

test("несколько суток: сводка равна показателям за весь период; сутки идут строками смен", () => {
  const E = eventMaker();
  const events = [];
  for (const [i, d] of ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"].entries()) {
    events.push(
      E("shift_open", d, "08:10:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
      E("stop", d, "10:00:20", { downtimeId: "A" + i, reason: i % 2 ? "avaria" : "perevalka" }),
      E("start", d, "10:47:50", { downtimeId: "A" + i, action: "ok" }),
      E("stop", d, "19:50:00", { downtimeId: "B" + i, reason: "burezhka" }),
      E("start", d, "20:40:30", { downtimeId: "B" + i, action: "ok" }),
      E("fix", d, "20:40:31", { downtimeId: "B" + i, index: 0, billet: 0.5 * (i + 1) }),
    );
  }
  const now = T("2026-10-01", "21:30:00");
  const { wb } = build(events, { fromDay: "2026-09-28", toDay: "2026-10-01", nowMs: now });
  const range = periodRange("week", now, S); // 7 суток; данные начались 28.09
  const stats = computeStats(events, { fromMs: T("2026-09-28", "08:00:00"), toMs: now, nowMs: now, refs });
  assert.ok(range.fromMs <= T("2026-09-28", "08:00:00"));
  const sheet = wb.sheets[0];
  assert.equal(minutesOf(summaryCell(sheet, "Простой")), stats.downMin);
  assert.equal(minutesOf(summaryCell(sheet, "Учтённое время")), stats.totalMin);
  assert.equal(summaryCell(sheet, "Остановок, шт").value, stats.stops);
  assert.equal(stats.stops, 8);
  assert.equal(summaryCell(sheet, "Доступность").value, stats.availability);
  assert.equal(summaryCell(sheet, "Брак заготовки всего, тн").value, 0.5 + 1 + 1.5 + 2);
  const { rows, total } = shiftTable(wb);
  assert.deepEqual(rows.map((r) => [r.day, r.shift]), [
    ["2026-09-28", "Смена 1"], ["2026-09-28", "Смена 2"], ["2026-09-29", "Смена 1"], ["2026-09-29", "Смена 2"],
    ["2026-09-30", "Смена 1"], ["2026-09-30", "Смена 2"], ["2026-10-01", "Смена 1"], ["2026-10-01", "Смена 2"],
  ], "последняя ночная смена уже идёт: 20:00–21:30");
  assert.equal(rows.at(-1).accounted, 90);
  assert.equal(total.stops, 8);
  assert.equal(total.billet, 5);
  assert.equal(total.accounted, minutesOf(summaryCell(sheet, "Учтённое время")));
  assert.equal(total.work + total.plan + total.unplanned + total.failure, total.accounted);
});

test("длительность словами, как просил владелец: «1 день, 0 часов, 30 минут»", () => {
  const cases = {
    0: "0 минут", 1: "1 минута", 2: "2 минуты", 5: "5 минут", 11: "11 минут", 21: "21 минута", 22: "22 минуты",
    60: "1 час, 0 минут", 149: "2 часа, 29 минут", 692: "11 часов, 32 минуты", 1260: "21 час, 0 минут",
    1440: "1 день, 0 часов, 0 минут", 1470: "1 день, 0 часов, 30 минут", 3011: "2 дня, 2 часа, 11 минут",
    [7 * 1440 + 25]: "7 дней, 0 часов, 25 минут", [21 * 1440 + 61]: "21 день, 1 час, 1 минута",
  };
  for (const [minutes, words] of Object.entries(cases)) assert.equal(durationWords(Number(minutes)), words, minutes);
  assert.equal(durationWords(29.6), "30 минут", "секунды округляются до минуты");
});
