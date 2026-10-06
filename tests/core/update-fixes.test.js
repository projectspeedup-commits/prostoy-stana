import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { migrateLegacyDraft } from '../../app/public/queue.js';

// Миграция черновика «Что сделали»/«Брак» из старой версии (поля af/bl, экраны actionFix/billet) в черновик редактора edit

test('миграция: af (что сделали) переходит в edit, открывается редактор этого простоя, af/bl исчезают', () => {
  const old = { screen: 'actionFix', card: { downtimeId: 'd1', index: 0 }, crewId: '2',
    af: { downtimeId: 'd1', index: 0, reason: 'avaria', field: 'action', value: 'Заменили вал, не дописано' } };
  const out = migrateLegacyDraft(old);
  assert.equal(out.screen, 'detail');
  assert.deepEqual(out.card, { downtimeId: 'd1', index: 0 });
  assert.equal(out.edit.downtimeId, 'd1');
  assert.equal(out.edit.index, 0);
  assert.equal(out.edit.action, 'Заменили вал, не дописано');
  assert.deepEqual(out.edit.migrated, ['action']);
  assert.equal(out.edit.base, null);
  assert.equal('af' in out, false);
  assert.equal('bl' in out, false);
  assert.equal(out.crewId, '2');
  assert.equal(old.af.value, 'Заменили вал, не дописано', 'исходный объект не меняется');
});

test('миграция: af с полем note попадает в «Что случилось», без field — в «Что сделали»', () => {
  const note = migrateLegacyDraft({ screen: 'actionFix', af: { downtimeId: 'd1', index: 1, field: 'note', value: 'Лом в ножницах' } });
  assert.equal(note.edit.note, 'Лом в ножницах');
  assert.equal(note.edit.action, '');
  assert.equal(note.edit.index, 1);
  const act = migrateLegacyDraft({ screen: 'actionFix', af: { downtimeId: 'd1', index: 0, value: 'Убрали' } });
  assert.equal(act.edit.action, 'Убрали');
});

test('миграция: bl (брак) переходит в edit.billet с запятой и признаком «Другое»', () => {
  const out = migrateLegacyDraft({ screen: 'billet', card: { downtimeId: 'd2', index: 0 },
    bl: { downtimeId: 'd2', index: 0, value: '1.5', custom: true } });
  assert.equal(out.screen, 'detail');
  assert.equal(out.edit.billet, '1,5');
  assert.equal(out.edit.billetOther, true);
  assert.deepEqual(out.edit.migrated, ['billet']);
  assert.equal('bl' in out, false);
});

test('миграция: af и bl одного простоя объединяются в один черновик', () => {
  const out = migrateLegacyDraft({ screen: 'billet', af: { downtimeId: 'd1', index: 0, field: 'action', value: 'Текст' },
    bl: { downtimeId: 'd1', index: 0, value: '2', custom: false } });
  assert.equal(out.edit.action, 'Текст');
  assert.equal(out.edit.billet, '2');
  assert.deepEqual(out.edit.migrated.sort(), ['action', 'billet']);
});

test('миграция: старый экран без данных не оставляет неизвестного экрана; новый черновик не трогается', () => {
  assert.equal(migrateLegacyDraft({ screen: 'billet' }).screen, 'auto');
  assert.equal(migrateLegacyDraft({ screen: 'actionFix', card: { downtimeId: 'd1', index: 0 } }).screen, 'detail');
  const fresh = { screen: 'detail', card: { downtimeId: 'd1', index: 0 },
    edit: { downtimeId: 'd1', index: 0, base: { note: '', action: '', billet: '' }, note: '', action: 'x', billet: '' } };
  assert.equal(migrateLegacyDraft(fresh), fresh);
  assert.equal(migrateLegacyDraft(undefined), undefined);
  // Уже есть новый edit: старые поля отбрасываются, правки редактора не затираются
  const both = migrateLegacyDraft({ ...fresh, af: { downtimeId: 'd1', index: 0, value: 'старое' } });
  assert.equal(both.edit.action, 'x');
  assert.equal('af' in both, false);
});

// Service worker: надёжное обновление

const SW_SOURCE = fs.readFileSync(new URL('../../app/public/sw.js', import.meta.url), 'utf8');

function loadSw({ cacheNames = [], failAssets = false } = {}) {
  const listeners = {};
  const deleted = [];
  const log = { skipWaiting: 0, claim: 0 };
  const cache = { add: async () => { if (failAssets) throw new Error('404'); }, put: async () => {} };
  // В браузере Request понимает относительные адреса (от адреса service worker), в Node — нет
  const RelRequest = class extends Request { constructor(u, o) { super(new URL(u, 'http://local/'), o); } };
  const context = {
    URL, Request: RelRequest, Response,
    self: { location: { origin: 'http://local' }, addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => { log.skipWaiting += 1; return Promise.resolve(); }, clients: { claim: async () => { log.claim += 1; } } },
    caches: { open: async () => cache, keys: async () => cacheNames, delete: async (k) => { deleted.push(k); return true; }, match: async () => undefined },
    fetch: async () => new Response('net'),
  };
  vm.runInNewContext(SW_SOURCE, context);
  return { listeners, deleted, log };
}
async function run(listener) {
  let p;
  listener({ waitUntil: (x) => { p = x; } });
  await p;
}

test('SW: версия кэша stan-v80', () => {
  assert.match(SW_SOURCE, /const CACHE = "stan-v80"/);
});

test('SW: install делает skipWaiting, даже если файл из списка не скачался', async () => {
  const sw = loadSw({ failAssets: true });
  await run(sw.listeners.install);
  assert.equal(sw.log.skipWaiting, 1);
});

test('SW: activate удаляет все кэши, кроме текущего, и забирает страницы (clients.claim)', async () => {
  const sw = loadSw({ cacheNames: ['stan-v70', 'stan-v75', 'stan-v78', 'stan-v79', 'stan-v80', 'other'] });
  await run(sw.listeners.activate);
  assert.deepEqual(sw.deleted.sort(), ['other', 'stan-v70', 'stan-v75', 'stan-v78', 'stan-v79']);
  assert.equal(sw.log.claim, 1);
});

test('SW: навигация идёт сначала в сеть; из кэша — только без связи', async () => {
  const cached = new Response('cached');
  let online = true;
  const listeners = {};
  const context = { URL, Request, Response,
    self: { location: { origin: 'http://local' }, addEventListener: (t, fn) => { listeners[t] = fn; } },
    caches: { match: async () => cached, open: async () => ({ put: async () => {} }) },
    fetch: async () => { if (!online) throw new TypeError('offline'); return new Response('fresh'); } };
  vm.runInNewContext(SW_SOURCE, context);
  const ask = async () => {
    let result;
    listeners.fetch({ request: new Request('http://local/index.html'), respondWith: (p) => { result = p; } });
    return (await result).text();
  };
  assert.equal(await ask(), 'fresh');
  online = false;
  assert.equal(await ask(), 'cached');
});

test('страница: регистрация SW перезагружает страницу один раз по controllerchange и вызывает reg.update()', () => {
  const src = fs.readFileSync(new URL('../../app/public/app.js', import.meta.url), 'utf8');
  assert.match(src, /addEventListener\("controllerchange"/);
  assert.match(src, /reg\.update\(\)/);
  assert.match(src, /stan\.swReload/);
});
