import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, periodRange } from "../../app/core/stats.js";
import { T, build, eventMaker, refs, summaryCell } from "../helpers/report-fixtures.js";

const handoverRows = (wb) => wb.sheets[3].rows.slice(3).filter((r) => r && r[0]);

test("брак отрезка нулевой длительности попадает в сводку и по сменам, как в API", () => {
  const E = eventMaker();
  const d = "2026-11-20";
  const events = [
    E("stop", d, "14:50:00", { downtimeId: "s1", reason: "burezhka" }),
    E("fix", d, "14:55:00", { downtimeId: "s1", index: 0, billet: 3 }),
    E("split", d, "14:55:00", { downtimeId: "s1", reason: "avaria" }),
    E("fix", d, "14:55:00", { downtimeId: "s1", index: 1, billet: 7 }),
    E("start", d, "14:55:00", { downtimeId: "s1" }),
  ];
  const nowMs = T(d, "15:00:00");
  const stats = computeStats(events, { ...periodRange("day", nowMs, refs.settings.schedule), nowMs, refs });
  assert.equal(stats.billetTn, 10);
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs });
  assert.equal(summaryCell(wb.sheets[0], "Брак заготовки всего, тн").value, 10);
  const total = wb.sheets[1].rows.find((r) => r && r[0]?.value === "Итого");
  assert.equal(total[10].value, 10);
});

test("сдача смены: текст «что сделали» попадает на лист «Приём и сдача смен»", () => {
  const E = eventMaker();
  const d = "2026-11-20";
  const events = [
    E("shift_open", d, "13:00:00", { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" }),
    E("shift_close", d, "14:00:00", { personId: "p1", personName: "Иванов Иван Иванович", note: "Стан работает.", action: "Заменили привод; осталось проверить датчик" }),
  ];
  const { wb } = build(events, { fromDay: d, toDay: d, nowMs: T(d, "15:00:00") });
  const rows = handoverRows(wb);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][6].value, "Стан работает.\nЧто сделали: Заменили привод; осталось проверить датчик");
});

test("повторный приём тем же мастером в другие сутки — отдельная строка; дубль в той же смене не плодится", () => {
  const E = eventMaker();
  const m = { crewId: "1", personId: "p1", personName: "Иванов Иван Иванович" };
  const events = [
    E("shift_open", "2026-11-20", "09:00:00", m),
    E("shift_open", "2026-11-20", "09:20:00", m),
    E("shift_open", "2026-11-21", "08:30:00", m),
  ];
  const { wb } = build(events, { fromDay: "2026-11-20", toDay: "2026-11-21", nowMs: T("2026-11-21", "12:00:00") });
  assert.equal(handoverRows(wb).length, 2);
});
