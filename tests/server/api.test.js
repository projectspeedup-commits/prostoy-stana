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
      { id: "r", type: "reason", at: "2026-01-01T10:05:00Z", downtimeId: "d1", reason: "В-М-01" },
      { id: "e", type: "start", at: "2026-01-01T10:30:00Z", downtimeId: "d1" },
    ]);
    assert.equal(body.state.running, true);
    assert.equal(body.state.segments.length, 1);
    assert.equal(body.state.segments[0].reason, "В-М-01");
    assert.equal(body.state.segments[0].group, "Механическая");
  } finally {
    await app.close();
  }
});

test("events: fix меняет причину закрытого простоя", async () => {
  const { app, base } = await start();
  try {
    const { body } = await postEvents(base, [
      { id: "s", type: "stop", at: "2026-01-01T10:00:00Z", downtimeId: "d1", reason: "В-М-01" },
      { id: "e", type: "start", at: "2026-01-01T10:30:00Z", downtimeId: "d1" },
      { id: "f", type: "fix", at: "2026-01-01T10:40:00Z", downtimeId: "d1", index: 0, reason: "В-Э-01", note: "исправлено" },
    ]);
    assert.deepEqual(body.rejected, []);
    assert.equal(body.state.segments[0].reason, "В-Э-01");
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
    assert.deepEqual(body.state.crew, { crewId: "2", personId: "2-3", at: "2026-01-01T11:00:00Z" });
  } finally {
    await app.close();
  }
});

test("refs: 35 причин, 7 плиток и демо-люди", async () => {
  const { app, base } = await start();
  try {
    const response = await fetch(`${base}/api/refs`, { headers: HEAD });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(Object.keys(body.refs.reasons).length, 35);
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
    const lastCodes = {
      mech: "В-М-99", elec: "В-Э-99", tech: "В-Т-99", org: "В-О-99",
      ext: "В-В-99", plan: "П-99", other: "В-П-99",
    };
    for (const tile of body.refs.tiles) {
      const last = tile.codes.at(-1);
      assert.equal(last, lastCodes[tile.id], `${tile.id}: последняя причина`);
      assert.equal(body.refs.reasons[last]?.other, true, `${tile.id}: other`);
      if (tile.id !== "other") {
        assert.equal(body.refs.reasons[last].short, "Иная причина", last);
      }
      assert.equal(body.refs.reasons[last].planned, tile.id === "plan", last);
    }
    assert.equal(body.refs.tiles.length, 7);
    assert.equal(body.refs.nodes.length, 14);
    assert.equal(body.refs.demo, true);
    assert.equal(body.refs.crews.length, 4);
    assert.equal(body.refs.people.length, 16);
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
