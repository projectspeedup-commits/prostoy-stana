import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { eventBatch, deliverBatch, pruneRecords } from '../../app/public/queue.js';

test('P1: очередь ограничена байтами UTF-8, порядком и 50 событиями', () => {
  const q = Array.from({ length: 230 }, (_, id) => ({ id: String(id), note: 'Я'.repeat(500) }));
  const batch = eventBatch(q);
  assert.ok(batch.length < 50);
  assert.ok(Buffer.byteLength(JSON.stringify({ events: batch })) <= 40 * 1024);
  assert.deepEqual(batch, q.slice(0, batch.length));
  assert.equal(eventBatch(q.map(({ id }) => ({ id }))).length, 50);
  assert.equal(eventBatch([{ id: 's', type: 'stop' }, { id: 'r', type: 'reason' }]).length, 1);
});

test('P1: 413 уменьшает пачку, 400 выделяет отказ и сохраняет последующие события', async () => {
  const q = Array.from({ length: 10 }, (_, id) => ({ id: String(id) }));
  const sizes = [];
  const { data } = await deliverBatch(async (_, { body }) => {
    const events = JSON.parse(body).events;
    sizes.push(events.length);
    if (events.length > 2) throw { status: 413 };
    return { saved: events.map((e) => e.id) };
  }, q);
  assert.deepEqual(sizes, [10, 5, 3, 2]);
  assert.deepEqual(data.saved, ['0', '1']);
  const rejected = await deliverBatch(async () => { throw { status: 400, data: { error: 'bad_request' } }; }, q);
  assert.deepEqual(rejected.batch, [q[0]]);
  assert.equal(rejected.data.rejected[0].id, '0');
  assert.equal(q.length, 10);
});

test('P2: подтверждённые записи — 3 суток и 300, очередь и отказы сохраняются', () => {
  const now = Date.now();
  const make = (id, status, age = 0) => ({ event: { id, at: new Date(now - age).toISOString() }, status });
  const q = Array.from({ length: 700 }, (_, i) => make(`q${i}`, 'pending', 10 * 86400000));
  const records = [...Array.from({ length: 400 }, (_, i) => make(`s${i}`, 'saved')), make('old', 'saved', 4 * 86400000), make('bad', 'rejected'), ...q];
  const pruned = pruneRecords(records, now);
  assert.equal(pruned.filter((r) => r.status === 'saved').length, 300);
  assert.deepEqual(pruned.filter((r) => r.status === 'pending'), q);
  assert.equal(pruned.some((r) => r.event.id === 'old'), false);
  assert.equal(pruned.some((r) => r.event.id === 'bad'), true);
});

test('P2: SW возвращает кеш при 500/502/503/504, API не кешируется', async () => {
  const source = fs.readFileSync(new URL('../../app/public/sw.js', import.meta.url), 'utf8');
  const listeners = {};
  let status = 500;
  const cached = new Response('cached');
  const context = { URL, Request, Response, self: { location: { origin: 'http://local' }, addEventListener: (type, fn) => { listeners[type] = fn; } },
    caches: { match: async () => cached }, fetch: async () => new Response('failed', { status }) };
  vm.runInNewContext(source, context);
  for (status of [500, 502, 503, 504]) {
    let result;
    listeners.fetch({ request: new Request('http://local/index.html'), respondWith: (p) => { result = p; } });
    assert.equal(await result, cached);
  }
  let called = false;
  listeners.fetch({ request: new Request('http://local/api/state'), respondWith: () => { called = true; } });
  assert.equal(called, false);
});
