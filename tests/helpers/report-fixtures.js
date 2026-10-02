// Общие данные для проверок отчёта: справочники, часы по Москве, события.
import { DEFAULT_REFS } from "../../app/core/refs.js";
import { SETTINGS_CREWS } from "../../app/core/settings.js";
import { buildXlsx } from "../../app/core/xlsx.js";
import { buildReport, durationWords } from "../../app/core/report.js";
import { readXlsx } from "./xlsx-read.js";

export const people = [
  { id: "p1", name: "Иванов Иван Иванович", crewId: "1", phone: "" },
  { id: "p2", name: "Петров Пётр Петрович", crewId: "2", phone: "" },
  { id: "p3", name: "Сидоров Сидор Сидорович", crewId: "1", phone: "" },
];

export const refs = { ...DEFAULT_REFS, crews: SETTINGS_CREWS, people };

/** Момент по Москве: T("2026-10-01", "14:20:05") → мс UTC. */
export const T = (day, hms) => {
  const [h, m, s = 0] = hms.split(":").map(Number);
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - 3, m, s);
};

/** Конструктор событий с повторяемыми номерами. */
export function eventMaker() {
  let n = 0;
  return (type, day, hms, extra = {}) => ({ id: `e${++n}`, type, at: new Date(T(day, hms)).toISOString(), device: "web", ...extra });
}

/** Модель → байты → прочитанная книга: проверяем настоящий файл. */
export function build(events, options) {
  const book = buildReport(events, { refs, ...options });
  return { book, bytes: buildXlsx(book), wb: readXlsx(buildXlsx(book)) };
}

/** Значение второй колонки строки «Показатель | Значение» сводки по подписи первой. */
export function summaryCell(sheet, label) {
  for (const row of sheet.rows) if (row && row[0] && row[0].value === label) return row[1];
  throw new Error("В сводке нет строки «" + label + "»");
}

/** Длительность ячейки в минутах. Ячейка обязана хранить её словами в точности как durationWords: «1 день, 0 часов, 30 минут». */
export function minutesOf(cell) {
  const m = /^(?:(\d+) (?:день|дня|дней), )?(?:(\d+) (?:час|часа|часов), )?(\d+) (?:минута|минуты|минут)$/.exec(cell?.value ?? "");
  if (!m) throw new Error("Нет длительности словами: " + JSON.stringify(cell));
  const minutes = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3]);
  if (durationWords(minutes) !== cell.value) throw new Error("Длительность записана не по правилу: " + cell.value);
  return minutes;
}

/** Строки таблицы листа после шапки: массивы значений. */
export function tableRows(sheet, headerRow = 2) {
  const out = [];
  for (let r = headerRow + 1; r < sheet.rows.length; r++) if (sheet.rows[r]) out.push(sheet.rows[r]);
  return out;
}

/**
 * Сутки 01.10.2026, «сейчас» 22:30 по Москве. Всё посчитано руками (минуты округлены по правилам экрана):
 *  Смена 1 (мастер Иванов): перевалка 09:00:30–09:45:50 (45 мин 20 с); бурёжка 14:20–14:50:30 (брак 2,5 т);
 *  авария 19:40:20–20:25:10 через границу смен (брак 1,2 т); сдача смены в 19:55.
 *  Смена 2 (мастер Петров): простой вручную 21:10–21:14 без причины; простой без причины с 22:00 — идёт.
 */
export function dayFixture() {
  const E = eventMaker();
  const d = "2026-10-01";
  const events = [
    E("shift_open", d, "08:05:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("stop", d, "09:00:30", { downtimeId: "D1", reason: "perevalka", note: "плановая перевалка валков" }),
    E("start", d, "09:45:50", { downtimeId: "D1", action: "валки заменены" }),
    E("stop", d, "14:20:00", { downtimeId: "D2", reason: "burezhka", note: "застряла заготовка" }),
    E("start", d, "14:50:30", { downtimeId: "D2", action: "убрали раскат" }),
    E("fix", d, "14:50:31", { downtimeId: "D2", index: 0, billet: 2.5 }),
    E("stop", d, "19:40:20", { downtimeId: "D3", reason: "avaria", note: "сломался привод" }),
    E("shift_close", d, "19:55:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович", note: "Стан стоит. Простой передан." }),
    E("shift_open", d, "20:05:00", { crewId: "2", personId: "p2", personName: "Петров Пётр Петрович" }),
    E("start", d, "20:25:10", { downtimeId: "D3", action: "заменили муфту" }),
    E("fix", d, "20:25:11", { downtimeId: "D3", index: 0, billet: 1.2 }),
    E("manual", d, "21:15:00", { downtimeId: "M1", from: new Date(T(d, "21:10:00")).toISOString(), to: new Date(T(d, "21:14:00")).toISOString() }),
    E("stop", d, "22:00:00", { downtimeId: "D4" }),
  ];
  return { events, now: T(d, "22:30:00"), day: d };
}
