import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../../app/server/index.js";

const KEY = "test-key-123";
const HEAD = { "X-Device-Key": KEY, "Content-Type": "application/json" };

// Единый момент времени, чтобы окно лимита не «переезжало» посреди проверки.
const fixedNow = new Date("2026-01-01T12:00:30.000Z");

let app;
let base;

async function start(opts = {}) {
  const a = createApp({
    dataDir: ":memory:",
    deviceKeys: [{ name: "тест", key: KEY }],
    now: () => fixedNow,
    ...opts,
  });
  await new Promise((r) => a.server.listen(0, "127.0.0.1", r));
  return { a, url: `http://127.0.0.1:${a.server.address().port}` };
}

before(async () => {
  ({ a: app, url: base } = await start());
});
after(() => app.close());

test("health без ключа отвечает 200", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("ping без ключа даёт 401 bad_key", async () => {
  const r = await fetch(`${base}/api/ping`, { method: "POST", body: "{}" });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { ok: false, error: "bad_key" });
  const r2 = await fetch(`${base}/api/ping`, {
    method: "POST",
    headers: { "X-Device-Key": "wrong-key" },
    body: "{}",
  });
  assert.equal(r2.status, 401);
});

test("ping с ключом пишет строку в базу", async () => {
  const before = app.db.prepare("SELECT COUNT(*) AS n FROM pings").get().n;
  const r = await fetch(`${base}/api/ping`, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({ clientAt: "2026-01-01T12:00:00.000Z", prevMs: 120, prevOk: true }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.serverTime, fixedNow.toISOString());
  const row = app.db.prepare("SELECT * FROM pings ORDER BY id DESC").get();
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM pings").get().n, before + 1);
  assert.equal(row.device, "тест");
  assert.equal(row.prev_ms, 120);
  assert.equal(row.prev_ok, 1);
});

test("неверный JSON даёт 400 bad_request", async () => {
  const r = await fetch(`${base}/api/ping`, { method: "POST", headers: HEAD, body: "{не json" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: "bad_request" });
});

test("тело больше 64 КБ даёт 413 bad_request", async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.url}/api/ping`, {
      method: "POST",
      headers: HEAD,
      body: JSON.stringify({ clientAt: "x".repeat(70 * 1024) }),
    });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { ok: false, error: "bad_request" });
  } finally {
    await s.a.close();
  }
});

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test("запрос файла с .. не выходит за public", async () => {
  const port = app.server.address().port;
  for (const p of ["/../server/index.js", "/%2e%2e/server/index.js", "/..%2fserver/index.js", "/../../package.json"]) {
    const r = await rawGet(port, p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.includes("createApp"), p);
  }
  const ok = await rawGet(port, "/");
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes("probe.html"));
});

test("61-й запрос за минуту получает 429 busy", async () => {
  const s = await start();
  try {
    for (let i = 1; i <= 60; i++) {
      const r = await fetch(`${s.url}/api/probe-summary`, { headers: HEAD });
      assert.equal(r.status, 200, `запрос ${i}`);
    }
    const r = await fetch(`${s.url}/api/probe-summary`, { headers: HEAD });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { ok: false, error: "busy" });
  } finally {
    await s.a.close();
  }
});

test("ответы содержат заголовки безопасности", async () => {
  for (const p of ["/api/health", "/"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'self'");
  }
  const api = await fetch(`${base}/api/health`);
  assert.equal(api.headers.get("cache-control"), "no-store");
});

test("probe-summary считает долю и самый длинный перерыв", async () => {
  const s = await start();
  try {
    const ins = s.a.db.prepare(
      "INSERT INTO pings (device, client_at, server_at, prev_ms, prev_ok) VALUES ('тест', NULL, ?, ?, ?)"
    );
    ins.run("2026-01-01T10:00:00.000Z", 100, 1);
    ins.run("2026-01-01T10:01:00.000Z", 300, 1);
    ins.run("2026-01-01T10:11:00.000Z", 200, 1); // перерыв 10 минут
    ins.run("2026-01-01T10:12:00.000Z", 30000, 0);
    s.a.db.exec("DELETE FROM alive"); // убираем отметку запуска
    const a = s.a.db.prepare("INSERT OR IGNORE INTO alive (at) VALUES (?)");
    a.run("2026-01-01T10:00:00.000Z");
    a.run("2026-01-01T10:01:00.000Z");
    a.run("2026-01-01T10:08:00.000Z"); // простой сервера 7 минут
    const r = await fetch(`${s.url}/api/probe-summary`, { headers: HEAD });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.total, 4);
    assert.equal(j.okShare, 0.75);
    assert.equal(j.longestGapMinutes, 10);
    assert.equal(j.medianMs, 200);
    assert.equal(j.from, "2026-01-01T10:00:00.000Z");
    assert.equal(j.to, "2026-01-01T10:12:00.000Z");
    assert.equal(j.serverDownMinutes, 7);
  } finally {
    await s.a.close();
  }
});

test("сервер без ключей не создаётся", () => {
  assert.throws(() => createApp({ dataDir: ":memory:", deviceKeys: [] }), /ключ/);
});
