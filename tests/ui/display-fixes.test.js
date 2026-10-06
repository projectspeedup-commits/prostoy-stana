import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Отображение по отчёту второго раунда, замеры в настоящем Chrome:
// 5) «Загружаем…» вместо «нет связи», пока первый запрос ждёт ответа; 6) нижнее меню на 320 px со scrollbar;
// 7) панель Excel после уменьшения окна; 8) вкладки администратора на 320 px; 9) пояснения причин без обрезки.
const NOW = Date.parse('2026-10-01T20:00:00Z');
const z = (hm) => `2026-10-01T${hm}:00Z`;

test('UI: загрузка, нижнее меню, панель Excel, вкладки администратора, пояснения причин', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let chrome = null;
  t.after(async () => { await chrome?.stop(); await app.close(); });
  const events = [{ id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') }];
  for (let i = 1; i <= 5; i++) {
    const m = (x) => `${String(17 + Math.floor((i * 20 + x) / 60)).padStart(2, '0')}:${String((i * 20 + x) % 60).padStart(2, '0')}`;
    events.push({ id: `s${i}`, type: 'stop', downtimeId: `d${i}`, reason: 'avaria', note: `Заклинил вал ${i}`, at: z(m(0)) },
      { id: `e${i}`, type: 'start', downtimeId: `d${i}`, action: 'Заменили', at: z(m(10)) });
  }
  const res = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
  assert.deepEqual((await res.json()).rejected, []);

  chrome = await startChrome({});
  const { evaluate, send, tab } = chrome;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const ready = (cond, what) => chrome.waitFor(cond, { what });
  const text = () => evaluate('document.body.innerText');

  // ---- 5. Первая загрузка: запрос в пути — «Загружаем…», без «нет связи» и без активной «Повторить» ----
  const held = [];
  tab.on((m) => { if (m.method === 'Fetch.requestPaused') held.push(m.params); });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/refs*' }, { urlPattern: '*/api/state*' }] });
  const release = async (part) => {
    await ready(`true`, 'пауза');
    for (let i = 0; i < 100 && !held.some((r) => r.request.url.includes(part)); i++) await sleep(50);
    const taken = held.filter((r) => r.request.url.includes(part));
    assert.ok(taken.length, `запрос ${part} ждёт ответа`);
    return taken;
  };
  await chrome.navigate(origin + '/#key=k2');
  const refsHeld = await release('/api/refs');
  await sleep(1500);
  let page = await text();
  assert.match(page, /Загружаем/);
  assert.doesNotMatch(page, /Нет данных|Подключитесь к сети|нет связи/i);
  assert.equal(await evaluate(`[...document.querySelectorAll('main button')].filter((b) => b.textContent.includes('Повторить') && !b.disabled).length`), 0);
  held.length = 0;
  for (const r of refsHeld) await send('Fetch.continueRequest', { requestId: r.requestId });
  const stateHeld = await release('/api/state');
  await sleep(1500);
  page = await text();
  assert.match(page, /Загружаем/);
  assert.doesNotMatch(page, /Нужно первое подключение|нет связи/i);
  assert.equal(await evaluate(`[...document.querySelectorAll('main button')].filter((b) => b.textContent.includes('Повторить') && !b.disabled).length`), 0);
  for (const r of stateHeld) await send('Fetch.continueRequest', { requestId: r.requestId });
  await send('Fetch.disable');
  await ready(`!!document.querySelector('.pult')`, 'пульт после ответов');

  // ---- 6. Нижнее меню владельца на 320 px (desktop Chrome, полоса прокрутки): подписи не перекрываются ----
  await chrome.navigate(origin + '/#key=k1');
  await chrome.reload();
  await ready(`!!document.querySelector('.pult')`, 'владелец');
  await sleep(900);
  await chrome.viewport(320, 640, { mobile: false });
  await sleep(300);
  await evaluate(`document.getElementById('nav-shift').click(); 0`);
  await ready(`document.querySelectorAll('.ps-row').length >= 5`, 'список простоев');
  await sleep(500);
  const nav = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#nav .pill')].filter((b) => !b.hidden).map((b) => {
    const tx = b.querySelector('.pill-text'); const r = b.getBoundingClientRect(); const vis = tx.getBoundingClientRect().width > 2;
    const rg = document.createRange(); rg.selectNodeContents(tx); const tr = rg.getBoundingClientRect();
    return { id: b.id, w: r.width, h: r.height, vis, l: vis ? tr.left : null, r: vis ? tr.right : null, fs: parseFloat(getComputedStyle(tx).fontSize), bl: r.left, br: r.right };
  }))`));
  assert.ok(nav.length >= 5, 'у владельца не меньше пяти пунктов меню');
  for (const p of nav) {
    assert.ok(p.w >= 44 && p.h >= 44, `${p.id}: зона ${p.w}×${p.h}`);
    if (p.vis) { assert.ok(p.fs >= 13, `${p.id}: шрифт ${p.fs}`); assert.ok(p.l >= p.bl - 0.5 && p.r <= p.br + 0.5, `${p.id}: подпись вышла за кнопку`); }
  }
  const labelled = nav.filter((p) => p.vis).sort((a, b) => a.l - b.l);
  for (let i = 1; i < labelled.length; i++) assert.ok(labelled[i].l >= labelled[i - 1].r, 'подписи нижнего меню не перекрываются');
  assert.ok(Math.max(...nav.map((p) => p.br)) <= await evaluate('document.documentElement.clientWidth') + 0.5, 'меню не шире окна');

  // ---- 8. Вкладки администратора на 320 px: подпись не выходит за кнопку, шрифт не меньше 13 px ----
  await evaluate(`document.getElementById('admin').click(); 0`);
  await ready(`document.querySelectorAll('.ps-subnav__item').length >= 3`, 'вкладки администратора');
  await sleep(400);
  const tabs = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.ps-subnav__item')].map((b) => {
    const r = b.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(b); const tr = rg.getBoundingClientRect();
    return { t: b.textContent.trim(), br: r.right, bl: r.left, tr: tr.right, tl: tr.left, fs: parseFloat(getComputedStyle(b).fontSize), h: r.height };
  }))`));
  for (const b of tabs) {
    assert.ok(b.tr <= b.br - 1 && b.tl >= b.bl, `вкладка «${b.t}»: текст вышел за кнопку (${b.tr} > ${b.br})`);
    assert.ok(b.fs >= 13 && b.h >= 44, `вкладка «${b.t}»: шрифт ${b.fs}, высота ${b.h}`);
  }

  // ---- 7. Панель «Отчёт в Excel»: открыта на 1280×800, окно уменьшили до 320×640 ----
  await chrome.viewport(1280, 800, { mobile: false });
  await evaluate(`document.getElementById('demo').click(); 0`);
  await ready(`!!document.querySelector('.rep-btn')`, 'кнопка Excel');
  await sleep(500);
  await evaluate(`document.querySelector('.rep-btn').click(); 0`);
  await ready(`!document.querySelector('.rep-panel').hidden`, 'панель открыта');
  await chrome.viewport(320, 640, { mobile: false });
  await sleep(400);
  const box = JSON.parse(await evaluate(`(() => { const p = document.querySelector('.rep-panel'); const g = p.querySelector('.rep-go'); g.scrollIntoView({ block: 'nearest' });
    const r = p.getBoundingClientRect(); const gr = g.getBoundingClientRect(); return JSON.stringify({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, gb: gr.bottom, gt: gr.top, ih: innerHeight, iw: document.documentElement.clientWidth }); })()`));
  assert.ok(box.top >= 0 && box.bottom <= box.ih + 1, `панель в окне: ${box.top}…${box.bottom} из ${box.ih}`);
  assert.ok(box.gt >= 0 && box.gb <= box.ih + 1, `кнопка «Скачать» видна: ${box.gt}…${box.gb} из ${box.ih}`);
  assert.ok(box.left >= 0 && box.right <= box.iw + 1, 'панель не вылезает по ширине');
  // Уменьшение по высоте на широком окне: панель ужимается по свободному месту
  await chrome.viewport(1280, 800, { mobile: false });
  await sleep(300);
  await chrome.viewport(1280, 480, { mobile: false });
  await sleep(300);
  const low = JSON.parse(await evaluate(`(() => { const r = document.querySelector('.rep-panel').getBoundingClientRect(); return JSON.stringify({ bottom: r.bottom, ih: innerHeight }); })()`));
  assert.ok(low.bottom <= low.ih + 1, `панель на 1280×480 помещается: ${low.bottom} из ${low.ih}`);

  // ---- 9. Пояснения групп причин не обрезаются ----
  assert.doesNotMatch(fs.readFileSync(new URL('../../app/public/pult.css', import.meta.url), 'utf8'), /line-clamp/, 'в pult.css нет line-clamp');
  await chrome.viewport(1280, 800, { mobile: false });
  await evaluate(`document.querySelector('.rep-close')?.click(); 0`);
  await post(origin, { id: 'st', type: 'stop', at: z('19:30') });
  await chrome.reload();
  await ready(`document.querySelector('.ps-state[data-state="stop"]')`, 'пульт стоящего стана');
  assert.ok(await evaluate('document.documentElement.scrollHeight') <= 800, 'пульт 1280×800 остаётся без прокрутки');
  assert.equal(await evaluate(`document.querySelectorAll('.ps-reason').length`), 0, 'на пульте стоящего стана плиток причины нет');
  // Плитки открываются кнопкой «Указать причину сейчас»
  await sleep(450);
  await evaluate(`[...document.querySelectorAll('#main button')].find((b) => b.textContent === 'Указать причину сейчас').click(); 0`);
  await ready(`document.querySelectorAll('.ps-reason__sub').length > 0`, 'плитки причин');
  const subs = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.ps-reason__sub')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => ({ t: e.textContent, c: e.clientHeight, s: e.scrollHeight, lc: getComputedStyle(e).webkitLineClamp })))`));
  assert.ok(subs.length > 0);
  for (const s of subs) assert.ok(s.s <= s.c + 1 && s.lc === 'none', `пояснение «${s.t}» обрезано: ${s.s} > ${s.c}`);
});

async function post(origin, event) {
  const r = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k1' }, body: JSON.stringify({ events: [event] }) });
  assert.deepEqual((await r.json()).rejected, []);
}
