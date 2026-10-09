import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createApp } from "../../app/server/index.js";

const GW_KEY = "gateway-test-key-0001";
const GW_KEY_2 = "gateway-test-key-0002";
const OWNER = "owner-test-key";
const TABLET = "tablet-test-key";
const NOW = new Date("2026-10-09T12:00:00.000Z"); // 15:00 по Москве
const DAY = 86_400_000;

async function start(t, options = {}) {
  const { clock } = options;
  const gatewayKeys = "gatewayKeys" in options ? options.gatewayKeys : [GW_KEY, GW_KEY_2];
  const time = { now: NOW, ...clock };
  const app = createApp({
    dataDir: ":memory:",
    deviceKeys: [{ name: "owner", key: OWNER }, { name: "tablet", key: TABLET }],
    adminDevices: ["owner"],
    gatewayKeys,
    now: () => time.now,
  });
  t.after(() => app.close());
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // Каждый запрос — «с нового адреса» (X-Real-IP принимается от петли), чтобы блокировка за неверные ключи не мешала
  let address = 0;
  const call = async (route, { method = "GET", headers = {}, body } = {}) => {
    const response = await fetch(base + route, { method, headers: { "X-Real-IP": `203.0.${++address >> 8}.${address & 255}`, ...headers }, body });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: response.status, body: json, text };
  };
  const post = (payload, key = GW_KEY, extra = {}) => call("/api/gateway/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key === null ? {} : { "X-Gateway-Key": key }), ...extra },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  const view = (query = "from=2026-10-09&to=2026-10-09", key = OWNER) =>
    call(`/api/admin/gateway?${query}`, { headers: { "X-Device-Key": key } });
  return { app, base, time, call, post, view };
}

const uuid = () => crypto.randomUUID();
const TS = "2026-10-09T15:00:00.000+03:00"; // = 12:00Z, ровно «сейчас»

function ev(type = "billet_out", data, over = {}) {
  const defaults = {
    heartbeat: { source: "opcua", connected: true, uptimeSec: 3600, queue: 0, version: "0.1.0" },
    signal: { tag: "1_50_01BFZI01", value: true },
    billet_out: { count: 1 },
    mill_state: { state: "stopped", rule: "no_billet_8min" },
    source_state: { connected: false, error: "timeout" },
  };
  return { id: uuid(), type, ts: TS, data: data ?? defaults[type], ...over };
}
const batch = (events, over = {}) => ({ gatewayId: "pc00248", sentAt: TS, events, ...over });

test("шлюз: 200 с подсчётом accepted и duplicates; повтор пачки — все duplicates", async (t) => {
  const s = await start(t);
  const events = ["heartbeat", "signal", "billet_out", "mill_state", "source_state"].map((type) => ev(type));
  const first = await s.post(batch(events));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { accepted: 5, duplicates: 0 });
  const again = await s.post(batch(events));
  assert.deepEqual(again.body, { accepted: 0, duplicates: 5 });
  // Смесь: два старых и одно новое; повтор внутри одной пачки тоже считается дублем
  const fresh = ev("billet_out");
  const mixed = await s.post(batch([events[0], events[1], fresh, fresh]));
  assert.deepEqual(mixed.body, { accepted: 1, duplicates: 3 });
  // Идентификатор в другом регистре — тот же UUID
  const upper = await s.post(batch([{ ...fresh, id: fresh.id.toUpperCase() }]));
  assert.deepEqual(upper.body, { accepted: 0, duplicates: 1 });
});

test("шлюз: необязательные поля quality и error принимаются, в том числе null", async (t) => {
  const s = await start(t);
  const r = await s.post(batch([
    ev("signal", { tag: "t", value: 12.5, quality: "good" }),
    ev("signal", { tag: "t", value: false, quality: null }),
    ev("source_state", { connected: true }),
    ev("source_state", { connected: true, error: null }),
  ]));
  assert.deepEqual(r.body, { accepted: 4, duplicates: 0 });
});

test("шлюз: ts на границах — ровно 40 суток назад и +5 минут принимаются", async (t) => {
  const s = await start(t);
  const old = new Date(NOW.getTime() - 40 * DAY).toISOString();
  const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  const r = await s.post(batch([ev("billet_out", undefined, { ts: old }), ev("billet_out", undefined, { ts: future })]));
  assert.deepEqual(r.body, { accepted: 2, duplicates: 0 });
});

test("шлюз: 401 без ключа, с неверным ключом и при пустом STAN_GATEWAY_KEYS", async (t) => {
  const s = await start(t);
  const payload = batch([ev()]);
  for (const key of [null, "", "wrong-key", GW_KEY + "x", GW_KEY.slice(0, -1)]) {
    const r = await s.post(payload, key);
    assert.equal(r.status, 401, `ключ ${JSON.stringify(key)}`);
    assert.equal(typeof r.body.message, "string");
    assert.ok(r.body.message.length > 0);
  }
  // Ничего не сохранено
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get().n, 0);
  // Ключи не заданы: в опциях нет, пустая строка, пустой список — 401 на любой ключ
  for (const gatewayKeys of [undefined, "", " , ", []]) {
    const e = await start(t, { gatewayKeys });
    assert.equal((await e.post(payload, GW_KEY)).status, 401);
    assert.equal((await e.post(payload, "")).status, 401);
    assert.equal((await e.post(payload, null)).status, 401);
  }
});

test("шлюз: ключи можно задать строкой через запятую; подходит любой из них", async (t) => {
  const s = await start(t, { gatewayKeys: ` ${GW_KEY} , ${GW_KEY_2}` });
  assert.equal((await s.post(batch([ev()]), GW_KEY)).status, 200);
  assert.equal((await s.post(batch([ev()]), GW_KEY_2)).status, 200);
  assert.equal((await s.post(batch([ev()]), "other")).status, 401);
});

test("шлюз: ключ устройства не принимается на этом маршруте, ключ шлюза не открывает остальное", async (t) => {
  const s = await start(t);
  const payload = batch([ev()]);
  // Ключ устройства в обоих заголовках
  assert.equal((await s.post(payload, OWNER)).status, 401);
  assert.equal((await s.post(payload, null, { "X-Device-Key": OWNER })).status, 401);
  assert.equal((await s.post(payload, TABLET)).status, 401);
  // Ключ шлюза как ключ устройства и в своём заголовке на чужих маршрутах
  for (const route of ["/api/state", "/api/refs", "/api/stats?period=day", "/api/admin/settings", "/api/admin/gateway?from=2026-10-09&to=2026-10-09", "/api/admin/mail", "/api/probe-summary"]) {
    for (const headers of [{ "X-Device-Key": GW_KEY }, { "X-Gateway-Key": GW_KEY }]) {
      assert.equal((await s.call(route, { headers })).status, 401, `${route} ${Object.keys(headers)[0]}`);
    }
  }
  for (const [route, method] of [["/api/events", "POST"], ["/api/ping", "POST"], ["/api/admin/settings", "PUT"]]) {
    const r = await s.call(route, { method, headers: { "X-Gateway-Key": GW_KEY, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401, `${method} ${route}`);
  }
  assert.equal((await s.call("/api/report.xlsx?from=2026-10-09&to=2026-10-09", { headers: { "X-Gateway-Key": GW_KEY } })).status, 401);
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get().n, 0);
});

test("шлюз: 400 на каждое нарушение контракта, пачка не сохраняется целиком", async (t) => {
  const s = await start(t);
  const good = ev("billet_out");
  const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
  const cases = {
    "тело не JSON": "{oops",
    "тело — массив": [],
    "тело — число": "5",
    "нет gatewayId": { events: [good] },
    "gatewayId с заглавными": batch([good], { gatewayId: "PC00248" }),
    "gatewayId с пробелом": batch([good], { gatewayId: "pc 1" }),
    "gatewayId длиннее 32": batch([good], { gatewayId: "a".repeat(33) }),
    "gatewayId пустой": batch([good], { gatewayId: "" }),
    "gatewayId не строка": batch([good], { gatewayId: 5 }),
    "sentAt не строка": batch([good], { sentAt: 5 }),
    "events не список": batch(null, { events: "x" }),
    "нет events": { gatewayId: "pc1" },
    "0 событий": batch([]),
    "201 событие": batch(Array.from({ length: 201 }, () => ev())),
    "событие — не объект": batch([good, 5]),
    "id не UUID": batch([good, ev("billet_out", undefined, { id: "not-a-uuid" })]),
    "id — число": batch([ev("billet_out", undefined, { id: 5 })]),
    "нет id": batch([{ type: "billet_out", ts: TS, data: { count: 1 } }]),
    "неизвестный type": batch([ev("billet_out", undefined, { type: "explosion" })]),
    "type не строка": batch([ev("billet_out", undefined, { type: 1 })]),
    "ts без смещения": batch([ev("billet_out", undefined, { ts: "2026-10-09T15:00:00" })]),
    "ts не время": batch([ev("billet_out", undefined, { ts: "вчера" })]),
    "ts — число": batch([ev("billet_out", undefined, { ts: NOW.getTime() })]),
    "ts — несуществующая дата": batch([ev("billet_out", undefined, { ts: "2026-02-30T10:00:00+03:00" })]),
    "ts старше 40 суток": batch([ev("billet_out", undefined, { ts: iso(-40 * DAY - 1000) })]),
    "ts в будущем больше 5 минут": batch([ev("billet_out", undefined, { ts: iso(5 * 60_000 + 1000) })]),
    "data не объект": batch([ev("billet_out", 5)]),
    "data — массив": batch([ev("billet_out", [])]),
    "data null": batch([ev("billet_out", undefined, { data: null })]),
    "data больше 2 КБ": batch([ev("signal", { tag: "t", value: 1, extra: "x".repeat(2100) })]),
    // heartbeat
    "heartbeat: source неизвестный": batch([ev("heartbeat", { source: "modbus", connected: true, uptimeSec: 1, queue: 0, version: "1" })]),
    "heartbeat: connected не bool": batch([ev("heartbeat", { source: "s7", connected: 1, uptimeSec: 1, queue: 0, version: "1" })]),
    "heartbeat: uptimeSec отрицательный": batch([ev("heartbeat", { source: "s7", connected: true, uptimeSec: -1, queue: 0, version: "1" })]),
    "heartbeat: uptimeSec дробный": batch([ev("heartbeat", { source: "s7", connected: true, uptimeSec: 1.5, queue: 0, version: "1" })]),
    "heartbeat: queue строкой": batch([ev("heartbeat", { source: "s7", connected: true, uptimeSec: 1, queue: "0", version: "1" })]),
    "heartbeat: version длиннее 32": batch([ev("heartbeat", { source: "s7", connected: true, uptimeSec: 1, queue: 0, version: "v".repeat(33) })]),
    "heartbeat: нет version": batch([ev("heartbeat", { source: "s7", connected: true, uptimeSec: 1, queue: 0 })]),
    // signal
    "signal: нет tag": batch([ev("signal", { value: true })]),
    "signal: tag длиннее 128": batch([ev("signal", { tag: "t".repeat(129), value: true })]),
    "signal: value строкой": batch([ev("signal", { tag: "t", value: "1" })]),
    "signal: нет value": batch([ev("signal", { tag: "t" })]),
    "signal: quality длиннее 32": batch([ev("signal", { tag: "t", value: 1, quality: "q".repeat(33) })]),
    // billet_out
    "billet_out: count 0": batch([ev("billet_out", { count: 0 })]),
    "billet_out: count 101": batch([ev("billet_out", { count: 101 })]),
    "billet_out: count дробный": batch([ev("billet_out", { count: 1.5 })]),
    "billet_out: нет count": batch([ev("billet_out", {})]),
    // mill_state
    "mill_state: state неизвестный": batch([ev("mill_state", { state: "paused", rule: "r" })]),
    "mill_state: rule длиннее 64": batch([ev("mill_state", { state: "running", rule: "r".repeat(65) })]),
    "mill_state: нет rule": batch([ev("mill_state", { state: "running" })]),
    // source_state
    "source_state: connected не bool": batch([ev("source_state", { connected: "yes" })]),
    "source_state: error длиннее 500": batch([ev("source_state", { connected: false, error: "e".repeat(501) })]),
    "source_state: error числом": batch([ev("source_state", { connected: false, error: 5 })]),
  };
  for (const [name, payload] of Object.entries(cases)) {
    const r = await s.post(payload);
    assert.equal(r.status, 400, name);
    assert.equal(typeof r.body.message, "string", name);
    assert.match(r.body.message, /[А-Яа-яЁё]/, `${name}: сообщение по-русски`);
  }
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get().n, 0);
  // Верное событие рядом с битым не сохраняется
  const mixed = await s.post(batch([good, ev("billet_out", { count: 0 })]));
  assert.equal(mixed.status, 400);
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get().n, 0);
});

test("шлюз: 200 событий в пачке принимается", async (t) => {
  const s = await start(t);
  const r = await s.post(batch(Array.from({ length: 200 }, () => ev("billet_out"))));
  assert.deepEqual(r.body, { accepted: 200, duplicates: 0 });
});

test("шлюз: тело больше 64 КБ — 413", async (t) => {
  const s = await start(t);
  const big = JSON.stringify(batch([ev("signal", { tag: "t", value: 1 })], { sentAt: "x".repeat(70 * 1024) }));
  assert.ok(big.length > 64 * 1024);
  const r = await s.post(big);
  assert.equal(r.status, 413);
  assert.equal(typeof r.body.message, "string");
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get().n, 0);
});

test("шлюз: 429 после 120 запросов в минуту на ключ; другой ключ и устройства не затронуты", async (t) => {
  const s = await start(t);
  for (let i = 0; i < 120; i++) {
    const r = await s.post({}); // пустое тело — 400, но запрос засчитан
    assert.equal(r.status, 400, `запрос ${i + 1}`);
  }
  const limited = await s.post(batch([ev()]));
  assert.equal(limited.status, 429);
  assert.equal(typeof limited.body.message, "string");
  assert.equal((await s.post(batch([ev()]), GW_KEY_2)).status, 200);
  // Лимит устройств не тронут
  assert.equal((await s.call("/api/refs", { headers: { "X-Device-Key": TABLET } })).status, 200);
  // Новая минута — снова можно
  s.time.now = new Date(NOW.getTime() + 61_000);
  assert.equal((await s.post(batch([ev("billet_out", undefined, { ts: new Date(NOW.getTime() + 61_000).toISOString() })]))).status, 200);
});

test("просмотр: 403 без права администратора, 401 без ключа", async (t) => {
  const s = await start(t);
  const q = "from=2026-10-09&to=2026-10-09";
  assert.equal((await s.view(q, TABLET)).status, 403);
  assert.equal((await s.view(q, "bad")).status, 401);
  assert.equal((await s.call(`/api/admin/gateway?${q}`)).status, 401);
  assert.equal((await s.view(q, OWNER)).status, 200);
});

test("просмотр: проверка периода — 400", async (t) => {
  const s = await start(t);
  const bad = [
    "", "from=2026-10-09", "to=2026-10-09",
    "from=2026-10-10&to=2026-10-09",
    "from=2026-13-01&to=2026-13-02", "from=вчера&to=2026-10-09", "from=2026-10-09&to=09.10.2026",
    "from=2026-09-01&to=2026-10-02", // 32 суток
    "from=2026-10-09&to=2026-10-09&type=explosion",
    "from=2026-10-09&to=2026-10-09&gatewayId=PC%2000",
  ];
  for (const q of bad) {
    const r = await s.view(q);
    assert.equal(r.status, 400, q);
    assert.match(r.body.message, /[А-Яа-яЁё]/, q);
  }
  // Ровно 31 сутки — можно
  assert.equal((await s.view("from=2026-09-01&to=2026-10-01")).status, 200);
});

test("просмотр: шлюзы с lastSeen и последним heartbeat, события по возрастанию ts, фильтры", async (t) => {
  const s = await start(t);
  const a = (type, ts, data) => ev(type, data, { ts });
  // Шлюз pc00248, события отправлены не по порядку
  const e3 = a("billet_out", "2026-10-09T14:00:00+03:00");
  const e1 = a("heartbeat", "2026-10-09T10:00:00+03:00");
  const e2 = a("signal", "2026-10-09T12:00:00+03:00", { tag: "tag1", value: 3.5 });
  const e4 = a("heartbeat", "2026-10-09T14:30:00+03:00", { source: "s7", connected: true, uptimeSec: 7200, queue: 2, version: "0.1.1" });
  s.time.now = new Date("2026-10-09T11:00:00.000Z");
  await s.post(batch([e3, e1, e2]));
  s.time.now = new Date("2026-10-09T12:00:00.000Z");
  await s.post(batch([e4]));
  // Второй шлюз
  const other = a("source_state", "2026-10-09T13:00:00+03:00", { connected: false, error: "timeout" });
  s.time.now = new Date("2026-10-09T12:03:00.000Z");
  await s.post(batch([other], { gatewayId: "pc2" }), GW_KEY_2);
  // Граница суток МСК: 23:59:59 вчера — вне периода, 00:00:00 сегодня — внутри
  const before = a("billet_out", "2026-10-08T23:59:59+03:00");
  const midnight = a("billet_out", "2026-10-09T00:00:00+03:00");
  const after = a("billet_out", "2026-10-10T00:00:00+03:00", undefined);
  s.time.now = new Date("2026-10-10T12:00:00.000Z");
  await s.post(batch([before, midnight, after]));

  const r = await s.view();
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, false);
  assert.deepEqual(r.body.events.map((e) => e.id), [midnight.id, e1.id, e2.id, other.id, e3.id, e4.id]);
  const first = r.body.events[1];
  assert.deepEqual(first, { id: e1.id, gatewayId: "pc00248", type: "heartbeat", ts: "2026-10-09T10:00:00+03:00", receivedAt: "2026-10-09T11:00:00.000Z", data: e1.data });
  assert.equal(r.body.events.find((e) => e.id === other.id).gatewayId, "pc2");

  // Шлюзы: по всем данным, а не только по периоду
  const gws = Object.fromEntries(r.body.gateways.map((g) => [g.gatewayId, g]));
  assert.deepEqual(Object.keys(gws).sort(), ["pc00248", "pc2"]);
  assert.equal(gws.pc00248.lastSeen, "2026-10-10T12:00:00.000Z");
  assert.equal(gws.pc2.lastSeen, "2026-10-09T12:03:00.000Z");
  assert.equal(gws.pc00248.lastHeartbeat.id, e4.id);
  assert.deepEqual(gws.pc00248.lastHeartbeat.data, e4.data);
  assert.equal(gws.pc2.lastHeartbeat, null);

  // Фильтры
  const byType = await s.view("from=2026-10-09&to=2026-10-09&type=heartbeat");
  assert.deepEqual(byType.body.events.map((e) => e.id), [e1.id, e4.id]);
  const byGw = await s.view("from=2026-10-09&to=2026-10-09&gatewayId=pc2");
  assert.deepEqual(byGw.body.events.map((e) => e.id), [other.id]);
  assert.deepEqual(byGw.body.gateways.map((g) => g.gatewayId), ["pc2"]);
  const both = await s.view("from=2026-10-09&to=2026-10-09&gatewayId=pc2&type=heartbeat");
  assert.deepEqual(both.body.events, []);
  // Широкий период захватывает соседние сутки
  const wide = await s.view("from=2026-10-08&to=2026-10-10");
  assert.equal(wide.body.events.length, 8);
  assert.equal(wide.body.events[0].id, before.id);
  assert.equal(wide.body.events.at(-1).id, after.id);
  // Пустой период
  const empty = await s.view("from=2026-10-01&to=2026-10-02");
  assert.deepEqual(empty.body.events, []);
  assert.equal(empty.body.truncated, false);
});

test("просмотр: не больше 5000 событий, truncated, берутся самые ранние", async (t) => {
  const s = await start(t);
  const base = Date.parse("2026-10-09T00:00:00+03:00");
  const ids = [];
  const all = [];
  for (let i = 0; i < 5100; i++) {
    all.push(ev("billet_out", { count: 1 }, { ts: new Date(base + i * 1000).toISOString() }));
    ids.push(all[i].id);
  }
  // Отправляем в обратном порядке пачками по 200
  const reversed = [...all].reverse();
  for (let i = 0; i < reversed.length; i += 200) {
    const r = await s.post(batch(reversed.slice(i, i + 200)));
    assert.equal(r.status, 200);
  }
  const r = await s.view();
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true);
  assert.equal(r.body.events.length, 5000);
  assert.equal(r.body.events[0].id, ids[0]);
  assert.equal(r.body.events[4999].id, ids[4999]);
  // С фильтрами обрезка работает так же
  const filtered = await s.view("from=2026-10-09&to=2026-10-09&type=billet_out&gatewayId=pc00248");
  assert.equal(filtered.body.truncated, true);
  assert.equal(filtered.body.events.length, 5000);
});

test("просмотр: ровно 5000 событий в периоде — truncated false", async (t) => {
  const s = await start(t);
  const base = Date.parse("2026-10-09T00:00:00+03:00");
  const all = Array.from({ length: 5000 }, (_, i) => ev("billet_out", { count: 1 }, { ts: new Date(base + i * 1000).toISOString() }));
  for (let i = 0; i < all.length; i += 200) assert.equal((await s.post(batch(all.slice(i, i + 200)))).status, 200);
  const r = await s.view();
  assert.equal(r.body.events.length, 5000);
  assert.equal(r.body.truncated, false);
});

test("health: gateway.lastSeen — null до первого события, потом время последнего приёма", async (t) => {
  const s = await start(t);
  const before = await s.call("/api/health");
  assert.equal(before.status, 200);
  assert.equal(before.body.ok, true);
  assert.deepEqual(before.body.gateway, { lastSeen: null });
  assert.ok("settings" in before.body);
  // Отказанная пачка lastSeen не меняет
  await s.post(batch([ev("billet_out", { count: 0 })]));
  assert.equal((await s.call("/api/health")).body.gateway.lastSeen, null);
  await s.post(batch([ev()]));
  assert.equal((await s.call("/api/health")).body.gateway.lastSeen, NOW.toISOString());
  s.time.now = new Date("2026-10-09T12:30:00.000Z");
  await s.post(batch([ev("billet_out", undefined, { ts: "2026-10-09T15:30:00+03:00" })]), GW_KEY_2);
  assert.equal((await s.call("/api/health")).body.gateway.lastSeen, "2026-10-09T12:30:00.000Z");
  // Повтор уже принятого события время приёма не сдвигает
  const dup = ev();
  await s.post(batch([dup]));
  s.time.now = new Date("2026-10-09T12:40:00.000Z");
  await s.post(batch([dup]));
  assert.equal((await s.call("/api/health")).body.gateway.lastSeen, "2026-10-09T12:30:00.000Z");
});

test("события шлюза не меняют ответы /api/state и /api/stats и пишутся в отдельную таблицу", async (t) => {
  const s = await start(t);
  const headers = { "X-Device-Key": OWNER };
  const read = async () => ({
    state: (await s.call("/api/state", { headers })).body,
    stats: (await s.call("/api/stats?period=day", { headers })).body,
    refs: (await s.call("/api/refs", { headers })).body,
  });
  // Ручное событие, чтобы сравнение не было пустым
  await s.call("/api/events", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ events: [{ id: "stop-1", type: "stop", at: "2026-10-09T10:00:00Z", downtimeId: "d1" }] }) });
  const before = await read();
  const events = ["heartbeat", "signal", "billet_out", "mill_state", "source_state"].map((type) => ev(type));
  assert.equal((await s.post(batch(events))).status, 200);
  assert.equal((await s.post(batch([ev("mill_state", { state: "running", rule: "r" })]))).status, 200);
  assert.deepEqual(await read(), before);
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM gateway_events").get().n, 6);
  // Отчёт Excel тоже работает как раньше
  const report = await fetch(`${s.base}/api/report.xlsx?from=2026-10-09&to=2026-10-09`, { headers });
  assert.equal(report.status, 200);
});

test("таблица gateway_events: нужные столбцы и индекс по ts_ms", async (t) => {
  const s = await start(t);
  const columns = s.app.db.prepare("PRAGMA table_info(gateway_events)").all().map((c) => c.name);
  assert.deepEqual(columns, ["id", "gateway_id", "type", "ts", "ts_ms", "received_at", "data_json"]);
  const indexed = s.app.db.prepare("PRAGMA index_list(gateway_events)").all()
    .some((i) => s.app.db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().some((c) => c.name === "ts_ms" && c.seqno === 0));
  assert.ok(indexed);
  // Ключ шлюза нигде не лежит в базе
  await s.post(batch([ev()]));
  const dump = JSON.stringify(s.app.db.prepare("SELECT * FROM gateway_events").all());
  assert.equal(dump.includes(GW_KEY), false);
});
