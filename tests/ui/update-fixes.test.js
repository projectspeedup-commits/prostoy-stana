import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Четыре дефекта после выкладки, замеры в настоящем Chrome:
// 1) черновик «Что сделали»/«Брак» старой версии (af/bl) переезжает в редактор; 3) новый экран открывается с начала;
// 4) смена ключа сбрасывает кэш прав и не запрашивает ассистента без права администратора.
const NOW = Date.parse('2026-10-01T20:00:00Z');
const z = (hm) => `2026-10-01T${hm}:00Z`;

async function startServer() {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const calls = [];
  app.server.prependListener('request', (req) => calls.push({ url: req.url, key: req.headers['x-device-key'] }));
  const events = [{ id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') }];
  // Шесть закрытых простоев без «что сделали»: список на узком экране длиннее окна
  for (let i = 1; i <= 6; i++) {
    const at = (m) => z(`${String(17 + Math.floor((i * 20 + m) / 60)).padStart(2, '0')}:${String((i * 20 + m) % 60).padStart(2, '0')}`);
    events.push({ id: `s${i}`, type: 'stop', downtimeId: `d${i}`, reason: 'avaria', note: `Заклинил вал ${i}`, at: at(0) },
      { id: `e${i}`, type: 'start', downtimeId: `d${i}`, at: at(10) });
  }
  const res = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
  const body = await res.json();
  assert.deepEqual(body.rejected, [], JSON.stringify(body.rejected));
  return { app, origin, calls };
}

test('UI: черновик старой версии, прокрутка при смене экрана, права при смене ключа', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { app, origin, calls } = await startServer();
  let chrome = null;
  t.after(async () => { await chrome?.stop(); await app.close(); });
  chrome = await startChrome({});
  const { evaluate, send } = chrome;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const ready = (cond, what) => chrome.waitFor(cond, { what });

  // Старая сессия подкладывается скриптом нового документа: при перезагрузке страница сама пишет сессию в pagehide
  let seedId = null;
  const unseed = async () => { if (seedId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedId }); seedId = null; };
  const seedSession = async (session) => {
    await unseed();
    seedId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('stan.session.v1', ${JSON.stringify(JSON.stringify(session))});` })).identifier;
    await chrome.reload();
  };

  // ---- 1. Черновик старой версии: сессия с af/bl на экране actionFix ----
  await chrome.navigate(origin + '/#key=k2');
  await ready(`!!document.querySelector('.pult, .ps-flow')`, 'первая загрузка');
  await sleep(600);
  const legacy = { draft: { screen: 'actionFix', crewId: '2', card: { downtimeId: 'd2', index: 0 },
    af: { downtimeId: 'd2', index: 0, reason: 'avaria', field: 'action', value: 'Черновик из старой версии' } }, queueSeparated: true };
  await seedSession(legacy);
  await ready(`!!document.querySelector('#edit-action')`, 'редактор простоя после миграции');
  assert.equal(await evaluate(`document.querySelector('#edit-action').value`), 'Черновик из старой версии');
  assert.match(await evaluate(`document.querySelector('.ps-editor').innerText`), /Заклинил вал 2|Простой/);
  // Новая сессия перезаписала хранилище: старых полей нет, правка живёт в edit
  await sleep(300);
  const stored = JSON.parse(await evaluate(`localStorage.getItem('stan.session.v1')`));
  assert.equal(stored.draft.af, undefined);
  assert.equal(stored.draft.bl, undefined);
  assert.equal(stored.draft.edit.downtimeId, 'd2');
  assert.equal(stored.draft.edit.action, 'Черновик из старой версии');
  assert.equal(stored.draft.screen, 'detail');
  // Ещё одна перезагрузка: черновик не потерялся
  await unseed();
  await chrome.reload();
  await ready(`!!document.querySelector('#edit-action')`, 'редактор после второй перезагрузки');
  assert.equal(await evaluate(`document.querySelector('#edit-action').value`), 'Черновик из старой версии');

  // Брак: экран billet, значение с точкой и «Другое»
  const legacyBillet = { draft: { screen: 'billet', crewId: '2', card: { downtimeId: 'd3', index: 0 },
    bl: { downtimeId: 'd3', index: 0, value: '1.5', custom: true } }, queueSeparated: true };
  await seedSession(legacyBillet);
  await ready(`!!document.querySelector('#edit-billet')`, 'поле брака после миграции');
  assert.equal(await evaluate(`document.querySelector('#edit-billet').value`), '1,5');
  await unseed();
  await evaluate(`localStorage.removeItem('stan.session.v1'); 0`);

  // ---- 3. Прокрутка: узкий экран, длинный список ----
  await chrome.viewport(390, 640);
  await chrome.reload();
  await ready(`!!document.querySelector('.pult, .ps-flow')`, 'пульт на узком экране');
  await sleep(500);
  await chrome.clickElement('#nav-shift');
  await ready(`document.querySelectorAll('.ps-row').length >= 6`, 'список простоев');
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight); 0`);
  await sleep(200);
  assert.ok(await evaluate('scrollY') > 100, 'список прокручен вниз');
  // Нажатие по нижней строке открывает редактор: он виден с верха, а не с позиции строки
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('.ps-row')].at(-1).click(); 0`);
  await ready(`!!document.querySelector('.ps-editor')`, 'редактор открыт');
  await sleep(200);
  const top = await evaluate(`document.querySelector('.ps-editor').getBoundingClientRect().top`);
  assert.ok(top >= 0 && top < 320, `редактор виден с верха: top=${top}`);
  // Смена экрана вообще: прокрутили вниз, нажали «Сдать смену» — новый экран с начала
  await chrome.clickElement('.ps-back-narrow button, .ps-back-narrow');
  await ready(`document.querySelectorAll('.ps-row').length >= 6`, 'список после «Назад»');
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight); 0`);
  await sleep(200);
  assert.ok(await evaluate('scrollY') > 100);
  await sleep(500);
  await evaluate(`document.querySelector('.ps-close-link').click(); 0`);
  await sleep(300);
  assert.equal(await evaluate('scrollY'), 0, 'новый экран открыт с самого верха: ' + await evaluate(`document.querySelector('h1')?.textContent`));
  await chrome.viewport(1280, 800);

  // ---- 4. Смена ключа owner → master: кэш прав сброшен, ассистент не запрашивается ----
  await chrome.navigate(origin + '/#key=k1');
  await chrome.reload();
  await ready(`!!document.querySelector('.pult, .ps-flow')`, 'владелец');
  await sleep(900);
  assert.ok(calls.some((c) => c.url === '/api/admin/ai/status' && c.key === 'k1'), 'владелец спрашивает статус ассистента');
  assert.equal(JSON.parse(await evaluate(`localStorage.getItem('stan.refs')`)).canAdmin, true);
  calls.length = 0;
  // Тот же браузер, другой ключ: ссылка с ключом мастера
  await chrome.navigate(origin + '/#key=k2');
  await ready(`localStorage.getItem('stan.deviceKey') === 'k2'`, 'ключ мастера сохранён');
  await sleep(1500);
  await chrome.reload();
  await ready(`!!document.querySelector('.pult, .ps-flow')`, 'мастер');
  await sleep(1200);
  assert.deepEqual(calls.filter((c) => c.url.startsWith('/api/admin/') && c.key === 'k2').map((c) => c.url), [],
    'мастер не запрашивает админские адреса');
  assert.equal(JSON.parse(await evaluate(`localStorage.getItem('stan.refs')`)).canAdmin, false);
  assert.equal(await evaluate(`document.getElementById('ai-ask').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('admin').hidden`), true);
});
