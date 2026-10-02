// Период отчёта «Отчёт в Excel»: проверка дат, быстрый выбор, имя файла. Лёгкий модуль без зависимостей
// от писателя xlsx: его берут и страница рабочего, и сервер, и демо. Сутки — производственные,
// по расписанию смен (начало суток — начало Смены 1), пояс из расписания (МСК).
import { shiftOf, toMs } from "./core.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const REPORT_MAX_DAYS = 92;
export const REPORT_PRESETS = [
  ["today", "Сегодня"], ["yesterday", "Вчера"], ["week", "7 дней"], ["month", "Этот месяц"], ["prevMonth", "Прошлый месяц"],
];

const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const two = (n) => String(n).padStart(2, "0");

/** «2026-10-01» → число суток от эпохи; не дата или год вне 2000–2100 → null. */
export function dayIndex(day) {
  const m = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2100) return null;
  const t = Date.UTC(year, month - 1, date);
  const check = new Date(t);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return t / DAY_MS;
}

export const dayFromIndex = (index) => new Date(index * DAY_MS).toISOString().slice(0, 10);
export const addDays = (day, n) => dayFromIndex(dayIndex(day) + n);

/** «2026-10-01» → «01.10.2026». */
export function ruDate(day) {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}

/** Название пояса расписания: 180 → «МСК», иначе «UTC+5». */
export function tzName(tzOffsetMinutes = 180) {
  if (tzOffsetMinutes === 180) return "МСК";
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(tzOffsetMinutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ":" + two(abs % 60) : ""}`;
}

/** Момент (мс UTC) → «дд.мм.гггг чч:мм» в поясе расписания. */
export function ruDateTime(ms, tzOffsetMinutes = 180) {
  const d = new Date(ms + tzOffsetMinutes * MINUTE);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

function zoneText(tzOffsetMinutes) {
  const abs = Math.abs(tzOffsetMinutes);
  return `${tzOffsetMinutes < 0 ? "-" : "+"}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** Начало смены 1 («08:00») — начало производственных суток. */
export function dayStartHm(schedule) {
  const first = schedule?.shifts?.[0]?.start;
  if (!first) throw new Error("В расписании нет смен");
  return first;
}

/** Начало производственных суток с этой датой (мс UTC). */
export function dayStartMs(day, schedule) {
  return toMs(`${day}T${dayStartHm(schedule)}:00${zoneText(schedule.tzOffsetMinutes || 0)}`);
}

/** Текущие производственные сутки («2026-10-01» до 08:00 МСК 02.10). */
export function currentDay(nowMs, schedule) {
  return shiftOf(nowMs, schedule).day;
}

/**
 * Последняя дата, которую можно запросить: сегодняшняя дата в поясе расписания. Ночью, до начала новых
 * производственных суток (до 08:00), это следующая за текущими суткам дата: отчёт за 01.10–02.10, поданный в 02:05
 * 02.10, допустим, а время после «сейчас» всё равно не считается.
 */
export function maxReportDay(nowMs, schedule) {
  const production = currentDay(nowMs, schedule);
  const calendar = new Date(nowMs + (schedule.tzOffsetMinutes || 0) * MINUTE).toISOString().slice(0, 10);
  return dayIndex(calendar) > dayIndex(production) ? calendar : production;
}

const fail = (message) => ({ ok: false, message });

/**
 * Проверка периода из запроса. Даты — производственные сутки включительно.
 * Успех: { ok: true, fromDay, toDay, days, today, fromMs, endMs }, где endMs — конец суток «По».
 * Отказ: { ok: false, message } — сообщение по-русски, его сервер отдаёт в ответе 400.
 */
export function checkReportPeriod({ from, to }, nowMs, schedule) {
  if (from === undefined || from === null || from === "" || to === undefined || to === null || to === "") {
    return fail("Укажите период: даты «С» и «По».");
  }
  const a = dayIndex(from);
  const b = dayIndex(to);
  if (a === null) return fail("Дата «С» указана неверно. Нужен формат ГГГГ-ММ-ДД, например 2026-10-01.");
  if (b === null) return fail("Дата «По» указана неверно. Нужен формат ГГГГ-ММ-ДД, например 2026-10-01.");
  if (a > b) return fail("Дата «С» не может быть позже даты «По».");
  const today = currentDay(nowMs, schedule);
  const last = maxReportDay(nowMs, schedule);
  if (b > dayIndex(last)) {
    return fail(`Дата «По» (${ruDate(to)}) ещё не наступила. Последняя доступная дата — ${ruDate(last)}.`);
  }
  const days = b - a + 1;
  if (days > REPORT_MAX_DAYS) {
    return fail(`Период не может быть длиннее ${REPORT_MAX_DAYS} суток: выбрано ${days}. Выберите период короче.`);
  }
  return { ok: true, fromDay: from, toDay: to, days, today, fromMs: dayStartMs(from, schedule), endMs: dayStartMs(to, schedule) + DAY_MS };
}

/** Быстрый выбор: today — текущие производственные сутки; возвращает { from, to } в виде «ГГГГ-ММ-ДД». */
export function presetRange(kind, today) {
  const index = dayIndex(today);
  if (index === null) throw new Error("Некорректные сутки");
  if (kind === "today") return { from: today, to: today };
  if (kind === "yesterday") return { from: dayFromIndex(index - 1), to: dayFromIndex(index - 1) };
  if (kind === "week") return { from: dayFromIndex(index - 6), to: today };
  if (kind === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (kind === "prevMonth") {
    const firstOfMonth = dayIndex(`${today.slice(0, 7)}-01`);
    const last = new Date((firstOfMonth - 1) * DAY_MS);
    const first = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1) / DAY_MS;
    return { from: dayFromIndex(first), to: dayFromIndex(firstOfMonth - 1) };
  }
  throw new Error("Неизвестный быстрый выбор: " + kind);
}

/**
 * Имя файла: «Отчёт по простоям стана за 01.10.2026–02.10.2026, скачан 02.10.2026 в 02-05.xlsx».
 * Одни сутки — «за 01.10.2026». Время скачивания — по часам сервера в поясе расписания;
 * двоеточие Windows в имени не принимает, поэтому «02-05».
 */
export function reportFileName({ fromDay, toDay, nowMs, tzOffsetMinutes = 180 }) {
  const t = new Date(nowMs + tzOffsetMinutes * MINUTE);
  const when = `${two(t.getUTCDate())}.${two(t.getUTCMonth() + 1)}.${t.getUTCFullYear()} в ${two(t.getUTCHours())}-${two(t.getUTCMinutes())}`;
  const period = fromDay === toDay ? ruDate(fromDay) : `${ruDate(fromDay)}–${ruDate(toDay)}`;
  return `Отчёт по простоям стана за ${period}, скачан ${when}.xlsx`;
}
