import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../app/server/index.js";

const KEY = "api-test-key";
const HEAD = { "X-Device-Key": KEY, "Content-Type": "application/json" };
const NOW = new Date("2026-01-01T12:00:30.000Z");

async function start(now = () => NOW) {
  const app = createApp({
    dataDir: ":memory:",
    deviceKeys: [{ name: "api", key: KEY }],
    now,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function postEvents(base, events, headers = HEAD) {
  const response = await fetch(`${base}/api/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events }),
  });
  return { response, body: await response.json() };
}

test("events: stop переводит state.running в false", async () => {
  const { app, base } = await start();
  try {
    const { response, body } = await postEvents(base, [
      { id: "stop-1", type: "stop", at: "2026-01-01T11:00:00Z", downtimeId: "d1" },
    ]);
    assert.equal(response.status, 200);
    assert.deepEqual(body.saved, ["stop-1"]);
    assert.equal(body.state.running, false);
    assert.equal(body.state.open.downtimeId, "d1");
  } finally {
    await app.close();
  }
});

test("events: повторный id подтверждается, но не пишется второй раз", async () => {
  const { app, base } = await start();
  try {
    const event = { id: "dup-1", type: "stop", at: "2026-01-01T11:00:00Z", downtimeId: "d1" };
    assert.equal((await postEvents(base, [event])).body.saved[0], "dup-1");
    assert.equal((await postEvents(base, [event])).body.saved[0], "dup-1");
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE id = 'dup-1'").get().n, 1);
  } finally {
    await app.close();
  }
});

test("events: stop + reason + start дают часть с причиной", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d1" },
      { id: "r", type: "reason", at: "2026-01-01T10:05:00Z", downtimeId: "d1", reason: "avaria" },
      { id: "e", type: "start", at: "2026-01-01T10:30:00Z", downtimeId: "d1" },
    ]);
    assert.equal(body.state.running, true);
    assert.equal(body.state.segments.length, 1);
    assert.equal(body.state.segments[0].reason, "avaria");
    assert.equal(body.state.segments[0].group, "Аварийный простой");
  } finally {
    await app.close();
  }
});

test("events: fix меняет причину закрытого простоя", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d1", reason: "burezhka" },
      { id: "e", type: "start", at: "2026-01-01T10:30:00Z", downtimeId: "d1" },
      { id: "f", type: "fix", at: "2026-01-01T10:40:00Z", downtimeId: "d1", index: 0, reason: "avaria", note: "исправлено" },
    ]);
    assert.deepEqual(body.rejected, []);
    assert.equal(body.state.segments[0].reason, "avaria");
    assert.equal(body.state.segments[0].note, "исправлено");
  } finally {
    await app.close();
  }
});

test("events: manual с пересечением отклоняется как overlap", async () => {
  const { app, base } = await start();
  try {
    await postEvents(base, [
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d1" },
      { id: "e", type: "start", at: "2026-01-01T10:30:00Z", downtimeId: "d1" },
    ]);
    const { body } = await postEvents(base, [
      { id: "m", type: "manual", at: "2026-01-01T11:00:00Z", from: "2026-01-01T10:10:00Z", to: "2026-01-01T10:40:00Z" },
    ]);
    assert.deepEqual(body.saved, []);
    assert.deepEqual(body.rejected, [{ id: "m", error: "overlap" }]);
  } finally {
    await app.close();
  }
});

test("events: событие дальше чем на 2 минуты в будущем отклоняется как bad_time", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "future", type: "stop", at: "2026-01-01T12:03:00Z", downtimeId: "d1" },
    ]);
    assert.deepEqual(body.saved, []);
    assert.deepEqual(body.rejected, [{ id: "future", error: "bad_time" }]);
  } finally {
    await app.close();
  }
});

test("events: shift_open попадает в state.crew", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "shift", type: "shift_open", at: "2026-01-01T11:00:00Z", crewId: "2", personId: "2-3" },
    ]);
    assert.deepEqual(body.state.crew, { crewId: "2", personId: "2-3", personName: null, at: "2026-01-01T11:00:00Z" });
  } finally {
    await app.close();
  }
});

test("refs: три причины без кодов, 3 блока по одной причине с обязательным описанием, демо-люди", async () => {
  const { app, base } = await start();
  try {
    const response = await fetch(`${base}/api/refs`, { headers: HEAD });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(Object.keys(body.refs.reasons), ["perevalka", "burezhka", "avaria"]);
    for (const [code, reason] of Object.entries(body.refs.reasons)) {
      for (const field of ["hint", "actionHint"]) {
        assert.equal(typeof reason[field], "string", `${code}: ${field}`);
        assert.ok(reason[field].trim().length > 0, `${code}: пустой ${field}`);
        assert.ok(reason[field].length <= 70, `${code}: длинный ${field}`);
      }
      assert.match(reason.actionHint, /^Например: /, `${code}: actionHint`);
      if (reason.other) assert.equal(reason.hint, "Опишите, что случилось", code);
      else assert.match(reason.hint, /^Например: /, `${code}: hint`);
    }
    // Три блока без подпунктов: у каждого одна причина, описание своими словами обязательно
    assert.deepEqual(body.refs.tiles.map((tile) => [tile.id, tile.zone, tile.codes]), [
      ["plan", "plan", ["perevalka"]], ["cobble", "unplanned", ["burezhka"]], ["failure", "failure", ["avaria"]]]);
    for (const tile of body.refs.tiles) {
      assert.ok(tile.title && tile.subtitle, tile.id);
      assert.equal(tile.items.length, 1, tile.id);
      const reason = body.refs.reasons[tile.items[0].code];
      assert.equal(reason.zone, tile.zone, tile.id);
      assert.equal(reason.noteRequired, true, tile.id);
      assert.equal(tile.items[0].text, "", tile.id);
    }
    for (const [code, reason] of Object.entries(body.refs.reasons)) {
      assert.equal(reason.zone, { perevalka: "plan", burezhka: "unplanned", avaria: "failure" }[code], code);
    }
    assert.equal(body.refs.tiles.length, 3);
    assert.equal(body.refs.nodes.length, 14);
    assert.equal(body.refs.demo, true);
    // Две смены по 12 часов, в списке — мастера с полным ФИО
    assert.deepEqual(body.refs.crews.map((c) => c.title), ["Смена 1", "Смена 2"]);
    assert.equal(body.refs.people.length, 4);
    for (const p of body.refs.people) assert.equal(p.name.split(" ").length, 3, p.name);
    assert.match(body.refsVersion, /^[a-f0-9]{12}$/);
  } finally {
    await app.close();
  }
});

test("api без ключа получает 401, кроме health", async () => {
  const { app, base } = await start();
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const response = await fetch(`${base}/api/state`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "bad_key" });
  } finally {
    await app.close();
  }
});

test("stats: период day отдаёт метрики, неверный период — 400, без ключа — 401", async () => {
  const { app, base } = await start();
  try {
    const ok = await fetch(`${base}/api/stats?period=day`, { headers: HEAD });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.stats.stops, "number");
    const bad = await fetch(`${base}/api/stats?period=year`, { headers: HEAD });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, error: "bad_request" });
    assert.equal((await fetch(`${base}/api/stats?period=day`)).status, 401);
  } finally {
    await app.close();
  }
});

test("/core/core.js отдаётся как text/javascript", async () => {
  const { app, base } = await start();
  try {
    const response = await fetch(`${base}/core/core.js`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.ok(text.includes("export function buildDowntimes"));
  } finally {
    await app.close();
  }
});

test("events: простой без человека получает бригаду и человека из приёма смены", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "open-1", type: "shift_open", at: "2026-01-01T09:00:00Z", crewId: "1", personId: "p2" },
      { id: "stop-w", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "dw" },
      { id: "start-w", type: "start", at: "2026-01-01T10:20:00Z", downtimeId: "dw" },
    ]);
    const seg = body.state.segments.find((s) => s.downtimeId === "dw");
    assert.equal(seg.personId, "p2");
    assert.equal(seg.crewId, "1");
  } finally {
    await app.close();
  }
});

test("state: dataFromMs — начало учёта, у ручного простоя берётся его начало", async () => {
  const { app, base } = await start();
  try {
    const empty = await fetch(`${base}/api/state`, { headers: HEAD }).then((r) => r.json());
    assert.equal(empty.state.dataFromMs, null);
    await postEvents(base, [
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d1" },
      { id: "e", type: "start", at: "2026-01-01T10:30:00Z", downtimeId: "d1" },
    ]);
    const { body } = await postEvents(base, [
      { id: "m", type: "manual", at: "2026-01-01T11:00:00Z", from: "2026-01-01T09:00:00Z", to: "2026-01-01T09:20:00Z" },
    ]);
    assert.deepEqual(body.saved, ["m"]);
    assert.equal(body.state.dataFromMs, Date.parse("2026-01-01T09:00:00Z"));
  } finally {
    await app.close();
  }
});

test("events: ремонт через смены — shift_close с action виден новой смене, пуск закрывает один простой", async () => {
  const { app, base } = await start();
  try {
    const action = "сняли редуктор, ждём подшипник со склада";
    // Старая сдача смены до простоя в передачи не попадает
    await postEvents(base, [
      { id: "old-close", type: "shift_close", at: "2025-12-31T16:59:00Z", crewId: "3", personId: "p7", action: "до простоя" },
      { id: "open-1", type: "shift_open", at: "2025-12-31T17:30:00Z", crewId: "1", personId: "p1" },
      { id: "stop-1", type: "stop", at: "2025-12-31T23:00:00Z", downtimeId: "d1" },
    ]);
    // Сдача смены при стоящем стане: бригада и человек берутся из приёма смены
    const closed = await postEvents(base, [
      { id: "close-1", type: "shift_close", at: "2026-01-01T04:50:00Z", action, note: "Стан стоит." },
    ]);
    assert.deepEqual(closed.body.rejected, []);
    assert.equal(closed.body.state.running, false);
    assert.equal(closed.body.state.open.downtimeId, "d1");
    assert.deepEqual(closed.body.state.open.handovers, [
      { at: "2026-01-01T04:50:00Z", crewId: "1", personId: "p1", personName: null, action, note: "Стан стоит." },
    ]);
    // Другая бригада принимает смену: стан стоит, передача на месте, простой не менялся
    const opened = await postEvents(base, [
      { id: "open-2", type: "shift_open", at: "2026-01-01T05:10:00Z", crewId: "2", personId: "p4" },
    ]);
    const { state } = opened.body;
    assert.equal(state.running, false);
    assert.equal(state.crew.crewId, "2");
    assert.equal(state.open.downtimeId, "d1");
    assert.equal(state.open.startMs, Date.parse("2025-12-31T23:00:00Z"));
    assert.equal(state.open.handovers.length, 1);
    assert.equal(state.open.handovers[0].action, action);
    const fromState = await fetch(`${base}/api/state`, { headers: HEAD }).then((r) => r.json());
    assert.deepEqual(fromState.state.open.handovers, state.open.handovers);
    // Новая бригада указывает причину и пускает стан: это тот же простой, а не новый
    const done = await postEvents(base, [
      { id: "reason-1", type: "reason", at: "2026-01-01T05:30:00Z", downtimeId: "d1", reason: "avaria", crewId: "2", personId: "p4" },
      { id: "start-1", type: "start", at: "2026-01-01T11:00:00Z", downtimeId: "d1", action: "заменили подшипник", crewId: "2", personId: "p4" },
    ]);
    assert.deepEqual(done.body.rejected, []);
    assert.equal(done.body.state.running, true);
    assert.equal(done.body.state.open, null);
    const own = done.body.state.segments.filter((x) => x.downtimeId === "d1");
    assert.equal(own.length, 1);
    assert.equal(own[0].reason, "avaria");
    assert.equal(own[0].action, "заменили подшипник");
    // action из shift_close в простой не попал
    assert.notEqual(own[0].action, action);
    // Итоги суток: один простой, минуты — тому, кто был на посту
    const stats = (await fetch(`${base}/api/stats?period=day`, { headers: HEAD }).then((r) => r.json())).stats;
    assert.equal(stats.stops, 1);
    assert.equal(stats.downMin, 360);
    assert.deepEqual(stats.byCrew.find((row) => row.crewId === "2"), { crewId: "2", minutes: 350, stops: 0, carried: 1 });
    assert.equal(stats.byCrew.reduce((sum, row) => sum + row.minutes, 0), stats.downMin);
  } finally {
    await app.close();
  }
});

test("events: shift_close с action длиннее 500 знаков отклоняется, ровно 500 принимается", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "c-ok", type: "shift_close", at: "2026-01-01T11:00:00Z", crewId: "1", action: "а".repeat(500) },
      { id: "c-long", type: "shift_close", at: "2026-01-01T11:01:00Z", crewId: "1", action: "а".repeat(501) },
    ]);
    assert.deepEqual(body.saved, ["c-ok"]);
    assert.deepEqual(body.rejected, [{ id: "c-long", error: "bad_request" }]);
  } finally {
    await app.close();
  }
});

test("events: ФИО мастера из приёма смены попадает в состояние и в следующие нажатия", async () => {
  const { app, base } = await start();
  try {
    const personName = "Петров Пётр Петрович";
    const { body } = await postEvents(base, [
      { id: "open", type: "shift_open", at: "2026-01-01T09:00:00Z", crewId: "1", personId: null, personName },
      { id: "stop", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d1" },
      { id: "close", type: "shift_close", at: "2026-01-01T11:00:00Z" },
    ]);
    assert.deepEqual(body.saved, ["open", "stop", "close"]);
    assert.equal(body.state.crew.personName, personName);
    assert.equal(body.state.open.handovers[0].personName, personName);
    const long = await postEvents(base, [
      { id: "long", type: "shift_open", at: "2026-01-01T11:30:00Z", crewId: "1", personName: "Я".repeat(121) },
    ]);
    assert.deepEqual(long.body.saved, []);
  } finally {
    await app.close();
  }
});

test("state.day: обе смены, обрезка по суткам, причины и открытый простой", async () => {
  const now = new Date("2026-01-01T22:00:00Z");
  const { app, base } = await start(() => now);
  try {
    const { body } = await postEvents(base, [
      { id: "d-old", type: "stop", at: "2026-01-01T04:00:00Z", reason: "П-02" },
      { id: "d-old-end", type: "start", at: "2026-01-01T06:00:00Z" },
      { id: "d-cross", type: "stop", at: "2026-01-01T16:50:00Z", reason: "В-Т-01" },
      { id: "d-split", type: "split", at: "2026-01-01T17:10:00Z", reason: "В-М-02" },
      { id: "d-cross-end", type: "start", at: "2026-01-01T18:00:00Z" },
      { id: "d-open", type: "stop", at: "2026-01-01T21:00:00Z" },
    ]);
    assert.deepEqual(body.rejected, []);
    const day = body.state.day;
    assert.equal(day.fromMs, Date.parse("2026-01-01T05:00:00Z"));
    assert.equal(day.toMs, Date.parse("2026-01-02T05:00:00Z"));
    assert.deepEqual(day.segments.map((s) => [s.startMs, s.endMs, s.reason, s.open]), [
      [day.fromMs, Date.parse("2026-01-01T06:00:00Z"), "perevalka", false],
      [Date.parse("2026-01-01T16:50:00Z"), Date.parse("2026-01-01T17:10:00Z"), "burezhka", false],
      [Date.parse("2026-01-01T17:10:00Z"), Date.parse("2026-01-01T18:00:00Z"), "avaria", false],
      [Date.parse("2026-01-01T21:00:00Z"), now.getTime(), null, true],
    ]);
    const state = await fetch(`${base}/api/state`, { headers: HEAD }).then((r) => r.json());
    assert.deepEqual(state.state.day, day);
    assert.ok(body.state.segments.every((s) => s.startMs >= body.state.shift.startMs));
    const source = await fetch(`${base}/core/zones.js`);
    assert.equal(source.status, 200);
    assert.equal(source.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.ok((await source.text()).includes("export function dayCells"));
  } finally {
    await app.close();
  }
});
