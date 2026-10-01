// Отдельный процесс сервера и HTTP-проверка на 127.0.0.1:8299. Только временные данные worktree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deliverBatch } from '../app/public/queue.js';
const root = path.resolve(import.meta.dirname, '..');
const temporaryRoot = path.join(root, 'private');
fs.mkdirSync(temporaryRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'http-qa-'));
const origin = 'http://127.0.0.1:8299';
const child = spawn(process.execPath, ['app/server/index.js'], { cwd: root, windowsHide: true,
  env: { ...process.env, PORT: '8299', HOST: '127.0.0.1', STAN_DATA_DIR: directory, STAN_DEVICE_KEYS: 'a:k1,b:k2', STAN_PEOPLE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (s) => { output += s; });
child.stderr.on('data', () => {}); // ошибки повреждённого settings ожидаемы, содержимое файла не выводим
const exit = new Promise((r) => child.once('exit', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (route, options = {}) => {
  const response = await fetch(origin + route, { headers: { 'X-Device-Key': 'k1' }, ...options });
  return { status: response.status, data: await response.json() };
};
const save = async (events, device = 'k1') => (await req('/api/events', { method: 'POST', headers: { 'X-Device-Key': device }, body: JSON.stringify({ events }) })).data;
try {
  for (let i = 0; i < 100 && !output.includes('Сервер слушает'); i++) {
    if (child.exitCode !== null) throw new Error('Не удалось запустить отдельный сервер на 8299');
    await sleep(50);
  }
  assert.match(output, /127\.0\.0\.1:8299/);
  const now = Date.now();
  const at = (offset = 0) => new Date(now + offset).toISOString();
  for (const year of ['0001', '1900', '1970']) assert.equal((await save([{ id: year, type: 'stop', at: `${year}-01-01T00:00:00Z` }])).rejected[0].error, 'bad_time');
  assert.equal((await save([{ id: 'huge', type: 'manual', at: at(), from: at(-8 * 86400000), to: at() }])).rejected[0].error, 'bad_time');
  const queue = Array.from({ length: 251 }, (_, i) => ({ id: `q${i}`, type: 'shift_open', at: at(-300000 + i * 1000), crewId: '1', note: 'Я'.repeat(500) }));
  let batches = 0;
  while (queue.length) {
    const { batch, data } = await deliverBatch(async (route, options) => {
      const r = await req(route, options); assert.equal(r.status, 200); return r.data;
    }, queue);
    assert.equal(data.saved.length, batch.length);
    queue.splice(0, batch.length); batches++;
  }
  await save([{ id: 'open', type: 'stop', at: at(-30000) }]);
  assert.equal((await save([{ id: 'early', type: 'stop', at: at(-60000) }])).rejected[0].error, 'overlap');
  const duplicate = await save([{ id: 'second', type: 'stop', at: at(-10000) }], 'k2');
  assert.equal(duplicate.rejected[0].error, 'already_stopped');
  assert.equal(duplicate.rejected[0].downtimeId, 'open');
  const reopened = await save(['shift_open', 'shift_close', 'shift_open'].map((type, i) => ({ id: `reopen${i}`, type, at: at(-3000 + i * 1000), crewId: '2' })));
  assert.equal(reopened.state.closed, false);
  const admin = (await req('/api/admin/settings')).data;
  fs.writeFileSync(path.join(directory, 'settings.json'), '{broken');
  assert.equal((await req('/api/health')).data.settings, 'fallback');
  assert.equal((await req('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ settings: admin.settings, refsVersion: admin.refsVersion }) })).status, 200);
  assert.equal((await req('/api/health')).data.settings, 'ok');
  const invalid = { headers: { 'X-Device-Key': 'wrong' } };
  for (let i = 0; i < 10; i++) assert.equal((await req('/api/state', invalid)).status, 401);
  assert.equal((await req('/api/state', invalid)).status, 429);
  const result = { host: '127.0.0.1', port: 8299, scenarios: [1, 2, 3, 4, 8, 11], passed: true, queuedEvents: 251, batches };
  fs.writeFileSync(path.join(temporaryRoot, 'Проверка HTTP.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  child.kill();
  await exit;
  assert.equal(path.dirname(directory), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log('Тестовый процесс остановлен; временные данные удалены.');
}
