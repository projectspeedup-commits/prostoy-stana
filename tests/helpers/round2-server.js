// По умолчанию — память. STAN_QA_COPY включает отдельную копию базы на порту 8299.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../../app/server/index.js';

export async function round2Server(t, clock, beforeMs) {
  const root = path.resolve(import.meta.dirname, '../../private');
  let dataDir = ':memory:';
  if (process.env.STAN_QA_COPY) {
    fs.mkdirSync(root, { recursive: true });
    dataDir = fs.mkdtempSync(path.join(root, 'round2-data-'));
    fs.cpSync(process.env.STAN_QA_COPY, dataDir, { recursive: true });
  }
  const app = createApp({ dataDir, deviceKeys: 'a:k1,b:k2', now: () => new Date(clock.t) });
  t.after(async () => {
    await app.close();
    if (dataDir !== ':memory:') { assert.equal(path.dirname(dataDir), root); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(dataDir === ':memory:' ? 0 : 8299, '127.0.0.1', resolve);
  });
  if (dataDir !== ':memory:') {
    // Завершаем только открытый простой в тестовой копии перед началом сценария.
    const port = app.server.address().port;
    const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Device-Key': 'k2', Connection: 'close' } })).json()).state;
    if (state.open) {
      const r = await (await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'X-Device-Key': 'k2', Connection: 'close' },
        body: JSON.stringify({ events: [{ id: 'qa-close-copy', type: 'start', downtimeId: state.open.downtimeId, at: new Date(beforeMs - 3600000).toISOString() }] }) })).json();
      assert.deepEqual(r.rejected, []);
    }
  }
  return app;
}
