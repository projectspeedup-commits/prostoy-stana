import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCHEDULE, shiftOf } from "../../app/core/core.js";
import { periodRange } from "../../app/core/stats.js";
import {
  REPORT_MAX_DAYS, REPORT_PRESETS, addDays, checkReportPeriod, currentDay, dayFromIndex, dayIndex, dayStartHm, dayStartMs,
  maxReportDay, presetRange, reportFileName, ruDate, ruDateTime, tzName,
} from "../../app/core/report-period.js";

const S = DEFAULT_SCHEDULE;
const msk = (d, h, m = 0, mo = 10) => Date.UTC(2026, mo - 1, d, h - 3, m);

test("даты: разбор строго по календарю", () => {
  assert.equal(dayIndex("2026-10-01"), Date.UTC(2026, 9, 1) / 86400000);
  assert.equal(dayFromIndex(dayIndex("2026-10-01") + 31), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "26-10-01", "2026-1-1", "2026/10/01", "", null, undefined, 20261001, "1999-12-31", "2101-01-01", "2026-10-01T00:00"]) {
    assert.equal(dayIndex(bad), null, String(bad));
  }
  assert.equal(ruDate("2026-10-01"), "01.10.2026");
  assert.equal(tzName(180), "МСК");
  assert.equal(tzName(300), "UTC+5");
  assert.equal(tzName(-330), "UTC-5:30");
  assert.equal(ruDateTime(Date.UTC(2026, 9, 1, 23, 5), 180), "02.10.2026 02:05");
});

test("начало суток — начало Смены 1 из расписания", () => {
  assert.equal(dayStartHm(S), "08:00");
  assert.equal(dayStartMs("2026-10-01", S), msk(1, 8));
  const custom = { tzOffsetMinutes: 300, shifts: [{ no: 1, start: "06:30" }, { no: 2, start: "18:30" }] };
  assert.equal(dayStartMs("2026-10-01", custom), Date.UTC(2026, 9, 1, 1, 30));
  assert.throws(() => dayStartHm({ shifts: [] }), /нет смен/);
  // Совпадает с границами суток экрана «Показатели» («Сутки») при любом расписании
  for (const schedule of [S, custom, { tzOffsetMinutes: 180, shifts: [{ no: 1, start: "07:00" }, { no: 2, start: "19:30" }] }]) {
    for (const now of [Date.UTC(2026, 9, 1, 12), Date.UTC(2026, 9, 1, 23, 59), Date.UTC(2026, 9, 2, 3), Date.UTC(2026, 11, 31, 22)]) {
      const day = shiftOf(now, schedule).day;
      assert.equal(currentDay(now, schedule), day);
      assert.equal(periodRange("day", now, schedule).fromMs, dayStartMs(day, schedule));
    }
  }
});

test("период: успешная проверка возвращает границы суток", () => {
  const now = msk(2, 15);
  const ok = checkReportPeriod({ from: "2026-10-01", to: "2026-10-02" }, now, S);
  assert.deepEqual(ok, { ok: true, fromDay: "2026-10-01", toDay: "2026-10-02", days: 2, today: "2026-10-02", fromMs: msk(1, 8), endMs: msk(3, 8) });
  const one = checkReportPeriod({ from: "2026-10-02", to: "2026-10-02" }, now, S);
  assert.equal(one.days, 1);
  assert.equal(one.endMs - one.fromMs, 86400000);
});

test("период: отказы — сообщения по-русски", () => {
  const now = msk(2, 15);
  const cases = [
    [{}, /Укажите период/],
    [{ from: "2026-10-01" }, /Укажите период/],
    [{ from: "", to: "2026-10-01" }, /Укажите период/],
    [{ from: "вчера", to: "2026-10-01" }, /Дата «С» указана неверно/],
    [{ from: "2026-10-01", to: "2026-02-30" }, /Дата «По» указана неверно/],
    [{ from: "2026-10-02", to: "2026-10-01" }, /«С» не может быть позже даты «По»/],
    [{ from: "2026-10-03", to: "2026-10-03" }, /Дата «По» \(03\.10\.2026\) ещё не наступила\. Последняя доступная дата — 02\.10\.2026/],
    [{ from: "2026-01-01", to: "2026-10-01" }, /не может быть длиннее 92 суток: выбрано 274/],
  ];
  for (const [query, pattern] of cases) {
    const result = checkReportPeriod(query, now, S);
    assert.equal(result.ok, false, JSON.stringify(query));
    assert.match(result.message, pattern);
    assert.match(result.message, /[а-яё]/i);
  }
});

test("период: ровно 92 суток можно, 93 — нельзя", () => {
  const now = msk(2, 15);
  assert.equal(REPORT_MAX_DAYS, 92);
  assert.equal(checkReportPeriod({ from: addDays("2026-10-02", -91), to: "2026-10-02" }, now, S).ok, true);
  assert.equal(checkReportPeriod({ from: addDays("2026-10-02", -92), to: "2026-10-02" }, now, S).ok, false);
});

test("последняя доступная дата: сегодняшняя по МСК; ночью — на день впереди текущих производственных суток", () => {
  // До 08:00 по Москве ещё идут прошлые сутки: 02.10 в 02:05 — текущие сутки 01.10, но сегодня уже 02.10
  assert.equal(currentDay(msk(2, 2, 5), S), "2026-10-01");
  assert.equal(maxReportDay(msk(2, 2, 5), S), "2026-10-02");
  assert.equal(maxReportDay(msk(2, 0, 0), S), "2026-10-02");
  assert.equal(maxReportDay(msk(1, 23, 59), S), "2026-10-01");
  assert.equal(maxReportDay(msk(2, 7, 59), S), "2026-10-02");
  assert.equal(maxReportDay(msk(2, 8, 0), S), "2026-10-02");
  assert.equal(maxReportDay(msk(2, 20, 0), S), "2026-10-02");
  // Пример из задания: отчёт 01.10–02.10, скачанный в 02:05 02.10, допустим; третье число — ещё нет
  const night = msk(2, 2, 5);
  assert.equal(checkReportPeriod({ from: "2026-10-01", to: "2026-10-02" }, night, S).ok, true);
  assert.equal(checkReportPeriod({ from: "2026-10-01", to: "2026-10-01" }, night, S).ok, true);
  const refused = checkReportPeriod({ from: "2026-10-01", to: "2026-10-03" }, night, S);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /Последняя доступная дата — 02\.10\.2026/);
  assert.equal(checkReportPeriod({ from: "2026-10-01", to: "2026-10-02" }, msk(2, 8, 0), S).ok, true);
  // Другой пояс расписания: пятичасовой сдвиг (UTC+5), 02:30 по местному 02.10 — сегодня 02.10, сутки с 08:00 ещё 01.10
  const ekb = { tzOffsetMinutes: 300, shifts: [{ no: 1, start: "08:00" }, { no: 2, start: "20:00" }] };
  const ekbNight = Date.UTC(2026, 9, 1, 21, 30); // 02:30 02.10 по UTC+5
  assert.equal(currentDay(ekbNight, ekb), "2026-10-01");
  assert.equal(maxReportDay(ekbNight, ekb), "2026-10-02");
});

test("отчёт за сутки, которые ещё не начались: допустим, но время считается только до «сейчас»", () => {
  const night = msk(2, 2, 5);
  const ok = checkReportPeriod({ from: "2026-10-01", to: "2026-10-02" }, night, S);
  assert.equal(ok.endMs, msk(3, 8));
  assert.ok(ok.endMs > night && ok.fromMs < night);
  assert.equal(ok.today, "2026-10-01", "быстрый выбор «Сегодня» остаётся текущими производственными сутками");
});

test("быстрый выбор: пять вариантов, границы месяцев и года", () => {
  assert.deepEqual(REPORT_PRESETS.map(([id]) => id), ["today", "yesterday", "week", "month", "prevMonth"]);
  assert.deepEqual(REPORT_PRESETS.map(([, title]) => title), ["Сегодня", "Вчера", "7 дней", "Этот месяц", "Прошлый месяц"]);
  const t = "2026-10-02";
  assert.deepEqual(presetRange("today", t), { from: t, to: t });
  assert.deepEqual(presetRange("yesterday", t), { from: "2026-10-01", to: "2026-10-01" });
  assert.deepEqual(presetRange("week", t), { from: "2026-09-26", to: t });
  assert.deepEqual(presetRange("month", t), { from: "2026-10-01", to: t });
  assert.deepEqual(presetRange("prevMonth", t), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("prevMonth", "2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("prevMonth", "2028-03-01"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(presetRange("yesterday", "2026-03-01"), { from: "2026-02-28", to: "2026-02-28" });
  assert.deepEqual(presetRange("month", "2026-10-01"), { from: "2026-10-01", to: "2026-10-01" });
  assert.throws(() => presetRange("год", t), /Неизвестный/);
  assert.throws(() => presetRange("today", "вчера"), /Некорректные/);
  // Любой быстрый выбор проходит проверку периода в любой день года
  for (let i = 0; i < 400; i++) {
    const today = addDays("2025-12-01", i);
    const now = dayStartMs(today, S) + 5 * 3_600_000;
    for (const [id] of REPORT_PRESETS) {
      const range = presetRange(id, today);
      const result = checkReportPeriod(range, now, S);
      assert.equal(result.ok, true, `${id} ${today}: ${result.message}`);
    }
  }
});

test("быстрый выбор даёт те же границы, что вкладки экрана «Показатели»", () => {
  for (const now of [msk(2, 15), msk(1, 0, 30), msk(1, 7, 59), msk(31, 23, 59, 12)]) {
    const today = currentDay(now, S);
    assert.equal(dayStartMs(presetRange("today", today).from, S), periodRange("day", now, S).fromMs);
    assert.equal(dayStartMs(presetRange("week", today).from, S), periodRange("week", now, S).fromMs);
    assert.equal(dayStartMs(presetRange("month", today).from, S), periodRange("month", now, S).fromMs);
  }
});

test("имя файла: период, время скачивания по МСК, «02-05» вместо «02:05»", () => {
  const now = Date.UTC(2026, 9, 1, 23, 5, 40); // 02:05:40 МСК 02.10.2026
  assert.equal(reportFileName({ fromDay: "2026-10-01", toDay: "2026-10-02", nowMs: now }),
    "Отчёт по простоям стана за 01.10.2026–02.10.2026, скачан 02.10.2026 в 02-05.xlsx");
  assert.equal(reportFileName({ fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: now }),
    "Отчёт по простоям стана за 01.10.2026, скачан 02.10.2026 в 02-05.xlsx");
  assert.equal(reportFileName({ fromDay: "2026-01-05", toDay: "2026-03-09", nowMs: Date.UTC(2026, 2, 9, 6, 3, 9) }),
    "Отчёт по простоям стана за 05.01.2026–09.03.2026, скачан 09.03.2026 в 09-03.xlsx");
  assert.equal(reportFileName({ fromDay: "2026-10-01", toDay: "2026-10-01", nowMs: now, tzOffsetMinutes: 0 }),
    "Отчёт по простоям стана за 01.10.2026, скачан 01.10.2026 в 23-05.xlsx");
  // Для Windows: ни одного запрещённого знака, расширение .xlsx
  const name = reportFileName({ fromDay: "2026-10-01", toDay: "2026-10-02", nowMs: now });
  assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
  assert.ok(name.endsWith(".xlsx"));
  assert.equal(name, name.normalize("NFC"));
});
