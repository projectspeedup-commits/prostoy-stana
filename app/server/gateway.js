// Приём событий шлюза завода и просмотр их администратором. Формат — docs/gateway/CONTRACT.md.
// События шлюза хранятся в своей таблице gateway_events и пока никуда больше не попадают:
// ни в смены, ни в сводки, ни в отчёт Excel, ни в рассылку.
import crypto from "node:crypto";
import { toMs } from "../core/core.js";
import { dayIndex } from "../core/report-period.js";

export const GATEWAY_MAX_EVENTS = 200; // событий в одной пачке
export const GATEWAY_TYPES = ["heartbeat", "signal", "billet_out", "mill_state", "source_state"];
export const GATEWAY_VIEW_MAX_DAYS = 31; // период просмотра, суток
export const GATEWAY_VIEW_MAX_EVENTS = 5000; // событий в ответе просмотра

const DAY_MS = 86_400_000;
const MSK_OFFSET_MS = 180 * 60_000; // даты просмотра — по Москве
const MAX_AGE_MS = 40 * DAY_MS; // ts не старше 40 суток
const MAX_FUTURE_MS = 5 * 60_000; // и не позже чем через 5 минут
const MAX_DATA_BYTES = 2048;

const GATEWAY_ID = /^[a-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Разбор STAN_GATEWAY_KEYS: ключи через запятую; пустое значение — ни одного ключа. */
export function parseGatewayKeys(text) {
  return String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Какой из ключей подошёл: номер или -1. Перебираем все, сравнение хешей — в постоянное время. */
export function matchGatewayKey(given, keys) {
  if (typeof given !== "string" || !given) return -1;
  const hg = crypto.createHash("sha256").update(given).digest();
  let found = -1;
  keys.forEach((key, i) => {
    const hk = crypto.createHash("sha256").update(String(key)).digest();
    if (crypto.timingSafeEqual(hg, hk)) found = i;
  });
  return found;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v, min, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
const isText = (v, max) => typeof v === "string" && v.length <= max;
const given = (v) => v !== undefined && v !== null; // необязательное поле: нет или null — не прислано

// Проверка data по типу; возвращает текст ошибки или null.
const DATA_CHECKS = {
  heartbeat(d) {
    if (!["opcua", "s7", "simulator"].includes(d.source)) return "поле source должно быть opcua, s7 или simulator";
    if (typeof d.connected !== "boolean") return "поле connected должно быть true или false";
    if (!isCount(d.uptimeSec, 0)) return "поле uptimeSec должно быть целым числом не меньше 0";
    if (!isCount(d.queue, 0)) return "поле queue должно быть целым числом не меньше 0";
    if (!isText(d.version, 32)) return "поле version должно быть строкой не длиннее 32 знаков";
    return null;
  },
  signal(d) {
    if (!isText(d.tag, 128)) return "поле tag должно быть строкой не длиннее 128 знаков";
    if (typeof d.value !== "boolean" && !(typeof d.value === "number" && Number.isFinite(d.value))) return "поле value должно быть числом или true/false";
    if (given(d.quality) && !isText(d.quality, 32)) return "поле quality должно быть строкой не длиннее 32 знаков";
    return null;
  },
  billet_out(d) {
    return isCount(d.count, 1, 100) ? null : "поле count должно быть целым числом от 1 до 100";
  },
  mill_state(d) {
    if (d.state !== "running" && d.state !== "stopped") return "поле state должно быть running или stopped";
    if (!isText(d.rule, 64)) return "поле rule должно быть строкой не длиннее 64 знаков";
    return null;
  },
  source_state(d) {
    if (typeof d.connected !== "boolean") return "поле connected должно быть true или false";
    if (given(d.error) && !isText(d.error, 500)) return "поле error должно быть строкой не длиннее 500 знаков";
    return null;
  },
};

/**
 * Проверка пачки целиком: хоть одно событие неверно — отказ всей пачке, в базу ничего не пишется.
 * Успех: { ok: true, gatewayId, events: [{ id, type, ts, tsMs, dataJson }] }.
 * Отказ: { ok: false, message } — по-русски, уходит шлюзу в ответе 400.
 */
export function validateBatch(body, nowMs) {
  const fail = (message) => ({ ok: false, message });
  if (!isObject(body)) return fail("Тело запроса должно быть JSON-объектом.");
  if (typeof body.gatewayId !== "string" || !GATEWAY_ID.test(body.gatewayId)) {
    return fail("Поле gatewayId должно быть строкой из латинских строчных букв, цифр, «_» и «-», от 1 до 32 знаков.");
  }
  if (given(body.sentAt) && typeof body.sentAt !== "string") return fail("Поле sentAt должно быть строкой со временем.");
  if (!Array.isArray(body.events)) return fail("Поле events должно быть списком событий.");
  if (body.events.length < 1) return fail("В запросе нет событий: нужно от 1 до 200.");
  if (body.events.length > GATEWAY_MAX_EVENTS) return fail(`В запросе ${body.events.length} событий: можно не больше ${GATEWAY_MAX_EVENTS}.`);

  const events = [];
  for (let i = 0; i < body.events.length; i++) {
    const e = body.events[i];
    const bad = (why) => fail(`Событие №${i + 1}: ${why}.`);
    if (!isObject(e)) return bad("должно быть объектом");
    if (typeof e.id !== "string" || !UUID.test(e.id)) return bad("поле id должно быть UUID");
    if (typeof e.type !== "string" || !GATEWAY_TYPES.includes(e.type)) {
      return bad(`неизвестный тип события, допустимы ${GATEWAY_TYPES.join(", ")}`);
    }
    let tsMs;
    try {
      if (typeof e.ts !== "string" || !ISO_WITH_OFFSET.test(e.ts)) throw new Error("формат");
      tsMs = toMs(e.ts);
    } catch {
      return bad("поле ts должно быть временем ISO 8601 со смещением, например 2026-10-09T15:00:00.000+03:00");
    }
    if (tsMs < nowMs - MAX_AGE_MS) return bad("поле ts старше 40 суток");
    if (tsMs > nowMs + MAX_FUTURE_MS) return bad("поле ts позже текущего времени сервера больше чем на 5 минут");
    if (!isObject(e.data)) return bad("поле data должно быть объектом");
    const dataJson = JSON.stringify(e.data);
    if (Buffer.byteLength(dataJson, "utf8") > MAX_DATA_BYTES) return bad("поле data больше 2 КБ");
    const dataError = DATA_CHECKS[e.type](e.data);
    if (dataError) return bad(`${dataError} (тип ${e.type})`);
    events.push({ id: e.id.toLowerCase(), type: e.type, ts: e.ts, tsMs, dataJson });
  }
  return { ok: true, gatewayId: body.gatewayId, events };
}

/**
 * Период просмотра из запроса: даты МСК включительно, from ≤ to, не больше 31 суток.
 * Успех: { ok: true, fromMs, endMs }, отказ: { ok: false, message }.
 */
export function checkViewPeriod({ from, to }) {
  const fail = (message) => ({ ok: false, message });
  if (!from || !to) return fail("Укажите период: даты «С» и «По».");
  const a = dayIndex(from);
  const b = dayIndex(to);
  if (a === null) return fail("Дата «С» указана неверно. Нужен формат ГГГГ-ММ-ДД, например 2026-10-01.");
  if (b === null) return fail("Дата «По» указана неверно. Нужен формат ГГГГ-ММ-ДД, например 2026-10-01.");
  if (a > b) return fail("Дата «С» не может быть позже даты «По».");
  const days = b - a + 1;
  if (days > GATEWAY_VIEW_MAX_DAYS) {
    return fail(`Период не может быть длиннее ${GATEWAY_VIEW_MAX_DAYS} суток: выбрано ${days}. Выберите период короче.`);
  }
  return { ok: true, fromMs: a * DAY_MS - MSK_OFFSET_MS, endMs: (b + 1) * DAY_MS - MSK_OFFSET_MS };
}

export function createGatewayStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_events (
      id TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gateway_events_ts_ms ON gateway_events (ts_ms);
    CREATE INDEX IF NOT EXISTS gateway_events_received ON gateway_events (received_at);
    CREATE INDEX IF NOT EXISTS gateway_events_gateway ON gateway_events (gateway_id, type, ts_ms);
  `);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO gateway_events (id, gateway_id, type, ts, ts_ms, received_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const lastSeenAll = db.prepare("SELECT MAX(received_at) AS at FROM gateway_events");
  const gatewayIds = db.prepare("SELECT DISTINCT gateway_id AS id FROM gateway_events ORDER BY gateway_id");
  const lastSeenOf = db.prepare("SELECT MAX(received_at) AS at FROM gateway_events WHERE gateway_id = ?");
  const lastBeatOf = db.prepare(
    "SELECT id, gateway_id, type, ts, received_at, data_json FROM gateway_events WHERE gateway_id = ? AND type = 'heartbeat' ORDER BY ts_ms DESC, rowid DESC LIMIT 1"
  );

  const view = (row) => ({
    id: row.id, gatewayId: row.gateway_id, type: row.type, ts: row.ts, receivedAt: row.received_at, data: JSON.parse(row.data_json),
  });

  /** Сохраняет проверенную пачку; повтор того же id в базе или в самой пачке — не дубль, а duplicates. */
  function save(batch, receivedAt) {
    let accepted = 0;
    let duplicates = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of batch.events) {
        const r = insert.run(e.id, batch.gatewayId, e.type, e.ts, e.tsMs, receivedAt, e.dataJson);
        if (r.changes > 0) accepted++; else duplicates++;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { accepted, duplicates };
  }

  /** Время последнего принятого события любого шлюза (ISO) или null. */
  const lastSeen = () => lastSeenAll.get()?.at ?? null;

  /** Ответ просмотра: шлюзы, события периода по возрастанию ts (не больше 5000), признак обрезки. */
  function list({ fromMs, endMs, type, gatewayId }) {
    const gateways = gatewayIds.all()
      .map((r) => r.id)
      .filter((id) => !gatewayId || id === gatewayId)
      .map((id) => {
        const beat = lastBeatOf.get(id);
        return { gatewayId: id, lastSeen: lastSeenOf.get(id)?.at ?? null, lastHeartbeat: beat ? view(beat) : null };
      });
    const where = ["ts_ms >= ?", "ts_ms < ?"];
    const args = [fromMs, endMs];
    if (type) { where.push("type = ?"); args.push(type); }
    if (gatewayId) { where.push("gateway_id = ?"); args.push(gatewayId); }
    const rows = db.prepare(
      `SELECT id, gateway_id, type, ts, received_at, data_json FROM gateway_events WHERE ${where.join(" AND ")} ORDER BY ts_ms, rowid LIMIT ?`
    ).all(...args, GATEWAY_VIEW_MAX_EVENTS + 1);
    const truncated = rows.length > GATEWAY_VIEW_MAX_EVENTS;
    return { gateways, events: rows.slice(0, GATEWAY_VIEW_MAX_EVENTS).map(view), truncated };
  }

  return { save, lastSeen, list };
}
