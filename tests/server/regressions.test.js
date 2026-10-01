import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../../app/server/index.js';
import { deliverBatch } from '../../app/public/queue.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
async function fixture(t, disk = false) {
  const dir = disk ? fs.mkdtempSync(path.join(import.meta.dirname, '.qa-')) : ':memory:';
  let now = NOW;
  const app = createApp({ dataDir: dir, deviceKeys: 'a:k1,b:k2', now: () => new Date(now) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    if (disk) {
      assert.equal(path.dirname(dir), import.meta.dirname);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const req = async (route, options = {}) => {
    const r = await fetch(url + route, { headers: { 'X-Device-Key': 'k1' }, ...options });
    return { status: r.status, data: await r.json() };
  };
  const save = async (...events) => (await req('/api/events', { method: 'POST', body: JSON.stringify({ events }) })).data;
  return { app, dir, url, req, save, advance: (ms) => { now += ms; } };
}

test('P1: старые даты и manual > 7 суток отклоняются; точные границы разрешены', async (t) => {
  const s = await fixture(t);
  for (const year of ['0001', '1900', '1970']) {
    const r = await s.save({ id: year, type: 'stop', at: `${year}-01-01T00:00:00Z` });
    assert.equal(r.rejected[0].error, 'bad_time');
  }
  const manual = (id, from, to) => ({ id, type: 'manual', at: iso(NOW), from: iso(from), to: iso(to) });
  assert.equal((await s.save(manual('long', NOW - 8 * 86400000, NOW))).rejected[0].error, 'bad_time');
  assert.equal((await s.save(manual('old', NOW - 41 * 86400000, NOW - 40 * 86400000))).rejected[0].error, 'bad_time');
  assert.deepEqual((await s.save(manual('edge', NOW - 40 * 86400000, NOW - 33 * 86400000))).saved, ['edge']);
});

test('P1: исторические интервалы режутся окном до splitByShifts', { timeout: 3000 }, async (t) => {
  const s = await fixture(t);
  const e = { id: 'ancient', type: 'stop', at: '0001-01-01T00:00:00Z' };
  s.app.db.prepare('INSERT INTO events (id, at_ms, body) VALUES (?, ?, ?)').run(e.id, Date.parse(e.at), JSON.stringify(e));
  const state = (await s.req('/api/state')).data.state;
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].startMs, state.shift.startMs);
  const stats = (await s.req('/api/stats?period=shift')).data.stats;
  assert.equal(stats.downMin, state.summary.day.downMinutes);
});

test('P1: stop раньше/в начале открытого — overlap; второй планшет получает ID; лишний start — not_open', async (t) => {
  const s = await fixture(t);
  await s.save({ id: 'open', type: 'stop', at: iso(NOW - 60000) });
  for (const offset of [120000, 60000]) {
    const r = await s.save({ id: `early-${offset}`, type: 'stop', at: iso(NOW - offset) });
    assert.equal(r.rejected[0].error, 'overlap');
    assert.equal(r.state.open.downtimeId, 'open');
  }
  const r = await s.req('/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events: [{ id: 'second', type: 'stop', at: iso(NOW) }] }) });
  assert.equal(r.data.rejected[0].error, 'already_stopped');
  assert.equal(r.data.rejected[0].downtimeId, 'open');
  assert.equal((await s.save({ id: 'wrong', type: 'start', at: iso(NOW), downtimeId: 'absent' })).rejected[0].error, 'not_open');
  assert.deepEqual((await s.save({ id: 'start', type: 'start', at: iso(NOW), downtimeId: 'open' })).saved, ['start']);
  assert.equal((await s.save({ id: 'extra', type: 'start', at: iso(NOW) })).rejected[0].error, 'not_open');
});

test('P1/P2: 251 событий > 64 КБ доходят до сервера по порядку', async (t) => {
  const s = await fixture(t);
  const queue = Array.from({ length: 251 }, (_, i) => ({ id: `q${i}`, type: 'shift_open', at: iso(NOW - 251000 + i * 1000), note: 'Я'.repeat(500) }));
  const api = async (route, options) => {
    assert.ok(Buffer.byteLength(options.body) <= 40 * 1024);
    assert.ok(JSON.parse(options.body).events.length <= 50);
    const r = await s.req(route, options);
    assert.equal(r.status, 200);
    return r.data;
  };
  const saved = [];
  while (queue.length) {
    const { batch, data } = await deliverBatch(api, queue);
    assert.equal(data.rejected.length, 0);
    saved.push(...data.saved);
    queue.splice(0, batch.length);
  }
  assert.deepEqual(saved, Array.from({ length: 251 }, (_, i) => `q${i}`));
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM events').get().n, 251);
});

test('P1/P2: fallback из памяти, .bak, демо; восстановление PUT и health', async (t) => {
  const s = await fixture(t, true);
  const initial = (await s.req('/api/admin/settings')).data;
  const settings = structuredClone(initial.settings);
  settings.contacts = [{ title: 'Резерв', tel: '12345' }];
  await s.req('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ settings, refsVersion: initial.refsVersion }) });
  fs.writeFileSync(path.join(s.dir, 'settings.json'), '{');
  assert.deepEqual((await s.req('/api/admin/settings')).data.settings.contacts, settings.contacts);
  assert.equal((await s.req('/api/health')).data.settings, 'fallback');
  const { createRefsReader } = await import('../../app/server/people.js');
  const { createSettingsStore } = await import('../../app/server/settings.js');
  fs.writeFileSync(path.join(s.dir, 'settings.json.bak'), JSON.stringify({ version: 1, ...settings }));
  const reader = createRefsReader(null, createSettingsStore(path.join(s.dir, 'settings.json')));
  assert.deepEqual(reader().refs.settings.contacts, settings.contacts);
  assert.equal(reader.status(), 'fallback');
  const current = (await s.req('/api/admin/settings')).data;
  assert.equal((await s.req('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ settings, refsVersion: current.refsVersion }) })).status, 200);
  assert.equal((await s.req('/api/health')).data.settings, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'settings.json.bak'), 'utf8')).contacts, settings.contacts);
  assert.ok(fs.readdirSync(s.dir).some((name) => name.startsWith('settings.json.bak-')));
});

test('P2: карта неверных ключей ограничена, действующее окно не вытесняется', { timeout: 30000 }, async (t) => {
  const s = await fixture(t);
  for (let offset = 0; offset < 4096; offset += 32) {
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => s.req('/api/state', {
      headers: { 'X-Device-Key': 'wrong', 'X-Real-IP': `198.18.${(offset + i) >> 8}.${(offset + i) % 256}` },
    })));
    assert.ok(results.every((r) => r.status === 401));
  }
  assert.equal((await s.req('/api/state', { headers: { 'X-Device-Key': 'wrong', 'X-Real-IP': '203.0.113.1' } })).status, 429);
  assert.equal((await s.req('/api/state')).status, 200);
  s.advance(600000);
  assert.equal((await s.req('/api/state', { headers: { 'X-Device-Key': 'wrong', 'X-Real-IP': '203.0.113.1' } })).status, 401);
});

test('P2: повторный приём после сдачи открывает смену', async (t) => {
  const s = await fixture(t);
  const r = await s.save(...['shift_open', 'shift_close', 'shift_open'].map((type, i) => ({ id: `shift${i}`, type, at: iso(NOW - 3000 + i * 1000), crewId: '1' })));
  assert.equal(r.state.closed, false);
  assert.equal(r.state.crew.at, iso(NOW - 1000));
});

test('P2: 10 неверных ключей, 429 до конца 10 минут, отдельные адреса', async (t) => {
  const s = await fixture(t);
  const bad = { headers: { 'X-Device-Key': 'wrong', 'X-Real-IP': '192.0.2.1' } };
  for (let i = 0; i < 10; i++) assert.equal((await s.req('/api/state', bad)).status, 401);
  assert.equal((await s.req('/api/state', bad)).status, 429);
  assert.equal((await s.req('/api/state')).status, 200);
  s.advance(599999);
  assert.equal((await s.req('/api/state', bad)).status, 429);
  s.advance(1);
  assert.equal((await s.req('/api/state', bad)).status, 401);
});

test('P2: ошибка потока статического файла не завершает сервер', async (t) => {
  const s = await fixture(t);
  const real = fs.createReadStream;
  const mock = t.mock.method(fs, 'createReadStream', () => new Readable({ read() { this.destroy(new Error('test read failure')); } }));
  await fetch(s.url + '/index.html').then((r) => r.text()).catch(() => {});
  mock.mock.mockImplementation(real);
  assert.equal((await s.req('/api/health')).status, 200);
});

test('P2: брак 0..1000 т, за границами отказ', async (t) => {
  const s = await fixture(t);
  for (const [i, billet] of [0, 1000, -1, 1000.1, 99999].entries()) {
    const r = await s.save({ id: `billet${i}`, type: 'shift_open', at: iso(NOW), billet });
    assert.equal(r.saved.length, billet >= 0 && billet <= 1000 ? 1 : 0);
  }
});

test('P2: поддельный CF-Connecting-IP не обходит лимит неверных ключей', async (t) => {
  const s = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const r = await s.req('/api/state', { headers: { 'X-Device-Key': 'wrong', 'X-Real-IP': '192.0.2.7', 'CF-Connecting-IP': `198.51.100.${i}` } });
    assert.equal(r.status, 401);
  }
  assert.equal((await s.req('/api/state', { headers: { 'X-Device-Key': 'wrong', 'X-Real-IP': '192.0.2.7', 'CF-Connecting-IP': '198.51.100.99' } })).status, 429);
  assert.equal((await s.req('/api/state', { headers: { 'X-Device-Key': 'k1', 'X-Real-IP': '192.0.2.8' } })).status, 200);
});
