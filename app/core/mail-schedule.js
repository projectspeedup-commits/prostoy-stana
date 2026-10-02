// Расписание писем: какие отправки наступили и за какой период письмо. Чистая арифметика,
// без node:-импортов: пояс берётся из расписания смен (МСК), пояс процесса не участвует.
import { shiftOf } from "./core.js";
import { addDays, dayStartMs, dayFromIndex } from "./report-period.js";

const MIN = 60_000;
const DAY_MS = 86_400_000;
export const MAX_LATE_MS = 2 * 3_600_000; // догон после простоя сервера — не дальше 2 часов
export const DAYS_ALL = [1, 2, 3, 4, 5, 6, 7];

/** Последняя смена, закончившаяся не позже nowMs - delayMs. */
export function lastFinishedShift(nowMs, schedule, delayMs = 0) {
  const current = shiftOf(nowMs, schedule);
  let prev = shiftOf(current.startMs - 1, schedule);
  while (prev.endMs + delayMs > nowMs) prev = shiftOf(prev.startMs - 1, schedule);
  return prev;
}

/**
 * Период письма на момент atMs.
 * shift — последняя закончившаяся смена; day — последние закончившиеся производственные сутки;
 * week — 7 последних закончившихся суток. Результат: { kind, fromMs, toMs, fromDay, toDay, shift? }.
 */
export function periodFor(what, atMs, schedule) {
  if (what === "shift") {
    const shift = lastFinishedShift(atMs, schedule, 0);
    return { kind: "shift", fromMs: shift.startMs, toMs: shift.endMs, fromDay: shift.day, toDay: shift.day, shift };
  }
  if (what !== "day" && what !== "week") throw new Error("Неизвестный вид сводки: " + what);
  const current = shiftOf(atMs, schedule).day; // сутки, в которых лежит atMs: они ещё не закончились
  const toDay = addDays(current, -1);
  const fromDay = what === "day" ? toDay : addDays(current, -7);
  return { kind: what, fromMs: dayStartMs(fromDay, schedule), toMs: dayStartMs(toDay, schedule) + DAY_MS, fromDay, toDay };
}

/** День недели по индексу суток от эпохи: 1 = понедельник … 7 = воскресенье. */
const weekdayOfIndex = (index) => (((index + 3) % 7) + 7) % 7 + 1;

/**
 * Наступившие моменты одной отправки { time, what, days }: не раньше чем maxLateMs назад и не позже nowMs.
 * Возвращает [{ occMs, weekday }]. Время и день недели — по поясу расписания.
 */
export function occurrences(send, nowMs, schedule, maxLateMs = MAX_LATE_MS) {
  const tz = schedule.tzOffsetMinutes || 0;
  const m = /^(\d{2}):(\d{2})$/.exec(send.time);
  if (!m) return [];
  const minuteOfDay = Number(m[1]) * 60 + Number(m[2]);
  const days = send.days?.length ? send.days : DAYS_ALL;
  const today = Math.floor((nowMs + tz * MIN) / DAY_MS);
  const out = [];
  for (let index = today - 1; index <= today; index++) {
    const occMs = index * DAY_MS + (minuteOfDay - tz) * MIN;
    const weekday = weekdayOfIndex(index);
    if (occMs <= nowMs && nowMs - occMs < maxLateMs && days.includes(weekday)) out.push({ occMs, weekday });
  }
  return out;
}

/**
 * Какие отправки должны уйти сейчас (без учёта отметок «отправлено»).
 * recipients — настройки; возвращает [{ recipient, send, key, markKey, occMs, period }].
 * key — отправка (получатель, время, вид); markKey — ещё и конкретный момент, это и есть отметка.
 */
export function dueSends(recipients, nowMs, schedule, maxLateMs = MAX_LATE_MS) {
  const out = [];
  for (const recipient of recipients) {
    if (!recipient.enabled) continue;
    for (const send of recipient.sends) {
      const key = sendKey(recipient, send);
      for (const { occMs } of occurrences(send, nowMs, schedule, maxLateMs)) {
        out.push({ recipient, send, key, markKey: `${key}|${occMs}`, occMs, period: periodFor(send.what, occMs, schedule) });
      }
    }
  }
  return out;
}

/**
 * Ключ отправки: получатель, адрес, время, вид и дни недели. Любое изменение этих полей даёт новый ключ,
 * то есть новую отправку: отсчёт «с момента сохранения» начинается заново, письмо за уже прошедший срок не уходит,
 * а отметки «отправлено» старого адреса или старых дней не блокируют будущие письма.
 */
export const sendKey = (recipient, send) =>
  `${recipient.id}|${recipient.email}|${send.time}|${send.what}|${(send.days?.length ? send.days : DAYS_ALL).join("")}`;
export { dayFromIndex };
