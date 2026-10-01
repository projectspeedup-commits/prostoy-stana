import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApp } from '../../app/server/index.js';

test('Демо и сервер: текущая смена, пересечения, границы, повторный приём и метрики', async (t) => {
  const now = Date.parse('2026-10-01T20:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const source = fs.readFileSync(new URL('../../app/public/mock.js', import.meta.url), 'utf8')
    .replaceAll('"./core/', '"' + pathToFileURL(path.resolve(import.meta.dirname, '../../app/core')).href + '/');
  const { api } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1', now: () => new Date(now) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const post = async (events) => {
    const options = { method: 'POST', body: JSON.stringify({ events }) };
    const real = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/events`, { ...options, headers: { 'X-Device-Key': 'k1' } })).json();
    const mock = await api('/api/events', options);
    assert.deepEqual(mock.saved, real.saved);
    assert.deepEqual(mock.rejected, real.rejected);
    for (const field of ['crew', 'closed', 'segments', 'summary', 'running']) assert.deepEqual(mock.state[field], real.state[field], field);
    return mock;
  };
  const at = (offset) => new Date(now + offset).toISOString();
  const old = await post([{ id: 'old-shift', type: 'shift_open', at: at(-8 * 3600000), crewId: '1', personId: 'p1' }]);
  assert.equal(old.state.crew, null);
  await post(['shift_open', 'shift_close', 'shift_open'].map((type, i) => ({ id: `crew${i}`, type, crewId: '2', personId: 'p2', at: at(-60000 + i * 1000) })));
  await post([{ id: 'manual', type: 'manual', at: at(-10000), from: at(-50000), to: at(-20000), reason: 'avaria' }]);
  assert.equal((await post([{ id: 'overlap', type: 'manual', at: at(-5000), from: at(-40000), to: at(-10000) }])).rejected[0].error, 'overlap');
  await post([{ id: 'old', type: 'stop', at: '1900-01-01T00:00:00Z' }, { id: 'billet', type: 'manual', at: at(0), from: at(-15000), to: at(-10000), billet: 1001 }]);
});
