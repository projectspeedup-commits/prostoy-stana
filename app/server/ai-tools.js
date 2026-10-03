// Инструменты ИИ-консультанта: только чтение. Считают тем же ядром, что экраны и отчёты
// (computeStats, buildDowntimes, eventStore.state), своей арифметики простоев здесь нет.
// В ответ кладём только перечисленные поля: ФИО людей (person*, мастер) в результат не попадают.
import { buildDowntimes, classify, shiftOf, withDowntimeDuration } from "../core/core.js";
import { checkReportPeriod, ruDate } from "../core/report-period.js";
import { computeStats } from "../core/stats.js";
import { zoneOf } from "../core/zones.js";

const MINUTE = 60_000;
const two = (n) => String(n).padStart(2, "0");
const ZONE_TITLE = { plan: "плановые простои", unplanned: "внеплановые простои", failure: "поломки и аварии", work: "работа" };
const MODE_TITLE = { planned: "плановый", unplanned: "внеплановый", short: "короткий (без причины)" };
const NOTE_LIMIT = 200;
const TOP_REASONS = 12;

/** Описания инструментов в формате OpenAI function calling. */
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_period_stats",
      description: "Сводка по простоям стана за период: минуты работы и простоя, число остановок, плановые и внеплановые, топ причин, группы, зоны, бригады, по суткам. Даты — производственные сутки (начало суток — начало Смены 1), включительно.",
      parameters: {
        type: "object",
        properties: {
          from_day: { type: "string", description: "Первые сутки периода, ГГГГ-ММ-ДД" },
          to_day: { type: "string", description: "Последние сутки периода включительно, ГГГГ-ММ-ДД" },
        },
        required: ["from_day", "to_day"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_downtimes",
      description: "Список отдельных простоев за период: начало и конец, минуты, причина, группа, зона, бригада, комментарий. Можно отфильтровать по причине (код или часть названия) и зоне (plan, unplanned, failure).",
      parameters: {
        type: "object",
        properties: {
          from_day: { type: "string", description: "Первые сутки, ГГГГ-ММ-ДД" },
          to_day: { type: "string", description: "Последние сутки включительно, ГГГГ-ММ-ДД" },
          reason: { type: "string", description: "Код или часть названия причины" },
          zone: { type: "string", enum: ["plan", "unplanned", "failure"] },
          sort: { type: "string", enum: ["start", "duration"], description: "По времени начала (по умолчанию) или по убыванию длительности" },
          limit: { type: "integer", description: "Сколько отдать, по умолчанию 50, максимум 100" },
        },
        required: ["from_day", "to_day"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_state",
      description: "Текущее состояние стана: работает или стоит, с какого времени, текущая смена и бригада.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export function createAiTools({ readEvents, readRefs, eventStore, clock }) {
  const tzOf = (refs) => refs.settings.schedule.tzOffsetMinutes || 0;
  const local = (ms, refs) => {
    const d = new Date(ms + tzOf(refs) * MINUTE);
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  };
  const crewTitle = (crewId, refs) => {
    if (crewId == null) return "не определена";
    return (refs.crews || []).find((c) => c.id === crewId)?.title || `Смена ${crewId}`;
  };
  const min = (ms) => Math.round(ms / MINUTE);

  // Проверка периода тем же правилом, что у отчёта в Excel: не больше 92 суток, даты настоящие, не из будущего
  function period(args, nowMs, schedule) {
    const checked = checkReportPeriod({ from: args.from_day, to: args.to_day }, nowMs, schedule);
    return checked.ok ? checked : { error: checked.message };
  }

  function periodStats(args) {
    const { refs } = readRefs();
    const nowMs = clock().getTime();
    const p = period(args, nowMs, refs.settings.schedule);
    if (p.error) return { error: p.error };
    if (p.fromMs >= nowMs) return { error: "Этот период ещё не начался." };
    const s = computeStats(readEvents(), { fromMs: p.fromMs, toMs: p.endMs, nowMs, refs });
    return {
      period: { from_day: p.fromDay, to_day: p.toDay, days: p.days, from: local(s.fromMs, refs), to: local(s.toMs, refs), timezone: "МСК" },
      no_data: s.noData,
      data_starts: s.noData ? null : local(s.dataFromMs, refs),
      total_minutes: s.totalMin,
      work_minutes: s.workMin,
      downtime_minutes: s.downMin,
      planned_minutes: s.plannedMin,
      unplanned_minutes: s.unplannedMin,
      short_minutes: s.shortMin,
      stops: s.stops,
      unplanned_stops: s.unplannedStops,
      availability_percent: s.availability == null ? null : Math.round(s.availability * 1000) / 10,
      avg_stop_minutes: s.avgStopMin,
      longest_stop: s.longest && { minutes: s.longest.minutes, reason: s.longest.reason ? (refs.reasons[s.longest.reason]?.title || s.longest.reason) : "Без причины", start: local(s.longest.startMs, refs) },
      zones: s.byZone.map((z) => ({ zone: ZONE_TITLE[z.zone] || z.zone, minutes: z.minutes, stops: z.stops })),
      top_reasons: s.byReason.slice(0, TOP_REASONS).map((r) => ({ reason: r.title, group: r.group, kind: MODE_TITLE[r.mode] || r.mode, minutes: r.minutes, stops: r.stops })),
      groups: s.byGroup.map((g) => ({ group: g.group, minutes: g.minutes, stops: g.stops })),
      crews: s.byCrew.map((c) => ({ crew: crewTitle(c.crewId, refs), minutes: c.minutes, stops_started: c.stops, stops_carried: c.carried })),
      by_day: s.byDay.map((d) => ({ day: d.day, work_minutes: d.workMin, downtime_minutes: d.downMin, stops: d.stops, no_data: Boolean(d.noData) })),
      quality: { stops_without_reason: s.quality.noReason, stops_without_action: s.quality.noAction },
    };
  }

  function listDowntimes(a) {
    const { refs } = readRefs();
    const nowMs = clock().getTime();
    const p = period(a, nowMs, refs.settings.schedule);
    if (p.error) return { error: p.error };
    if (a.zone !== undefined && !["plan", "unplanned", "failure"].includes(a.zone)) return { error: "zone: допустимы plan, unplanned, failure." };
    const wanted = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim().toLowerCase() : null;
    const limit = Math.min(100, Math.max(1, Number.isInteger(a.limit) ? a.limit : 50));
    const segments = withDowntimeDuration(buildDowntimes(readEvents(), nowMs).segments, nowMs);
    const rows = [];
    for (const segment of segments) {
      if (segment.endMs <= p.fromMs || segment.startMs >= p.endMs) continue;
      const reason = typeof segment.reason === "string" && segment.reason.trim() ? segment.reason : null;
      const title = reason ? (refs.reasons[reason]?.title || reason) : "Без причины";
      const zone = zoneOf(reason, refs);
      if (a.zone && zone !== a.zone) continue;
      if (wanted && !(reason && reason.toLowerCase() === wanted) && !title.toLowerCase().includes(wanted)) continue;
      const { mode, group } = classify(segment, refs, refs.settings);
      const note = [segment.note, segment.action].filter((t) => typeof t === "string" && t.trim());
      rows.push({
        ms: segment.endMs - segment.startMs,
        startMs: segment.startMs,
        item: {
          start: local(segment.startMs, refs),
          end: segment.open ? null : local(segment.endMs, refs),
          ongoing: Boolean(segment.open),
          minutes: min(segment.endMs - segment.startMs),
          reason: title,
          group,
          kind: MODE_TITLE[mode] || mode,
          zone: ZONE_TITLE[zone],
          crew: crewTitle(segment.crewId ?? null, refs),
          ...(note.length ? { comment: note.join(" / ").slice(0, NOTE_LIMIT) } : {}),
        },
      });
    }
    if (a.sort === "duration") rows.sort((x, y) => y.ms - x.ms || x.startMs - y.startMs);
    else rows.sort((x, y) => x.startMs - y.startMs);
    const given = rows.slice(0, limit);
    return {
      period: `${ruDate(p.fromDay)} – ${ruDate(p.toDay)}`,
      total: rows.length,
      returned: given.length,
      downtimes: given.map((r) => r.item),
    };
  }

  function currentState() {
    const { refs } = readRefs();
    const nowMs = clock().getTime();
    const st = eventStore.state(nowMs, refs);
    const shift = shiftOf(nowMs, refs.settings.schedule);
    const open = st.open;
    const first = open?.segments?.[0];
    const reason = first && typeof first.reason === "string" && first.reason ? (refs.reasons[first.reason]?.title || first.reason) : null;
    return {
      now: local(nowMs, refs),
      running: st.running,
      stopped_since: open ? local(open.startMs, refs) : null,
      stopped_minutes: open ? min(nowMs - open.startMs) : null,
      stop_reason: open ? (reason || "причина ещё не указана") : null,
      running_since: st.running && st.runningSinceMs ? local(st.runningSinceMs, refs) : null,
      shift: { production_day: shift.day, number: shift.shiftNo, from: local(shift.startMs, refs), to: local(shift.endMs, refs), accepted: Boolean(st.crew), closed: Boolean(st.closed), crew: st.crew ? crewTitle(st.crew.crewId, refs) : null },
    };
  }

  const handlers = { get_period_stats: periodStats, list_downtimes: listDowntimes, get_current_state: currentState };

  /** Выполняет инструмент; ошибка — не исключение, а { error } для модели. */
  function execute(name, args) {
    const fn = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!fn) return { error: `Неизвестный инструмент: ${name}` };
    try {
      return fn(args && typeof args === "object" && !Array.isArray(args) ? args : {});
    } catch {
      return { error: "Не удалось посчитать: внутренняя ошибка." };
    }
  }

  /** Справочник для системной инструкции: причины, зоны, расписание смен (кратко). */
  function reference() {
    const { refs } = readRefs();
    const schedule = refs.settings.schedule;
    const reasons = Object.entries(refs.reasons)
      .map(([code, r]) => `${r.title} (${r.group}; ${r.planned ? "плановая" : "внеплановая"}; ${ZONE_TITLE[zoneOf(code, refs)]})`);
    const shifts = schedule.shifts.map((s) => `Смена ${s.no} с ${s.start}`).join(", ");
    const tz = schedule.tzOffsetMinutes || 0;
    return [
      `Причины простоев: ${reasons.join("; ")}.`,
      `Зоны: ${Object.values(ZONE_TITLE).join(", ")}.`,
      `Смены: ${shifts}; пояс UTC${tz < 0 ? "-" : "+"}${Math.abs(tz) / 60}. Производственные сутки начинаются с началом Смены 1.`,
    ].join("\n");
  }

  return { definitions: TOOL_DEFINITIONS, execute, reference };
}
