import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Замечания независимой проверки (qa5):
// 1) фоновое обновление состояния (каждые 30 с) не сбрасывает клавиатурный фокус и выбранный интервал шкалы;
// 2) панель «Сохранить» на странице «Рассылка на почту» целиком видна над нижним меню.
const NOW = Date.parse('2026-10-01T20:00:00Z');
const z = (hm) => `2026-10-01T${hm}:00Z`;

async function setup(t) {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const chrome = await startChrome({});
  t.after(async () => { await chrome.stop(); await app.close(); });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const post = async (events) => {
    const r = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    assert.deepEqual((await r.json()).rejected, []);
  };
  return { app, origin, chrome, post };
}

// Считает завершённые ответы /api/state: так видно, что фоновое обновление дошло до перерисовки
const WATCH_STATE = `(() => { window.__done = 0; const f = window.fetch; window.fetch = (...a) => { const p = f(...a);
  if (String(a[0]).includes('api/state')) p.then(() => setTimeout(() => window.__done++, 0), () => {}); return p; }; 0; })()`;

test('UI: фоновое обновление не сбрасывает фокус на кнопке, плитке причины и ячейке шкалы', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { origin, chrome, post } = await setup(t);
  const { evaluate } = chrome;
  await post([{ id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') }]);
  await chrome.viewport(1280, 800, { mobile: false });
  await chrome.navigate(origin + '/#key=k2');
  await chrome.reload();
  await chrome.waitFor(`!!document.querySelector('[data-act="stop"]')`, { what: 'кнопка «Стан встал»' });
  await sleep(600);

  // Фоновое обновление как по таймеру: событие online запускает тот же loadState → softRender
  await evaluate(WATCH_STATE);
  const background = async () => {
    const before = await evaluate('window.__done');
    await evaluate(`window.dispatchEvent(new Event('online'))`);
    await chrome.waitFor(`window.__done > ${before}`, { what: 'ответ /api/state' });
    await sleep(200);
  };
  const where = () => evaluate(`(() => { const a = document.activeElement; return JSON.stringify({ tag: a.tagName, act: a.dataset.act || '', start: a.dataset.start || '', txt: (a.textContent || '').trim().slice(0, 30) }); })()`).then(JSON.parse);
  const mark = () => evaluate(`window.__prev = document.activeElement; 0`);
  const replaced = () => evaluate(`window.__prev !== document.activeElement && !window.__prev.isConnected`);

  // кнопка «Стан встал»
  await evaluate(`document.querySelector('[data-act="stop"]').focus()`);
  await mark();
  await background();
  assert.ok(await replaced(), 'проверка осмысленна: узел кнопки пересоздан фоновым обновлением');
  assert.equal((await where()).act, 'stop', 'фокус остался на «Стан встал»');

  // ячейка шкалы, не текущая: фокус и точка табуляции остаются на ней
  await evaluate(`document.querySelectorAll('.ds-row')[5].focus()`);
  await chrome.key('ArrowRight', 'ArrowRight', 39);
  const moved = (await where()).start;
  assert.ok(moved, 'фокус на ячейке шкалы');
  await mark();
  await background();
  assert.ok(await replaced(), 'узел ячейки пересоздан');
  assert.equal((await where()).start, moved, 'фокус остался на той же ячейке шкалы');
  assert.equal(await evaluate(`document.querySelector('.ds-row[tabindex="0"]').dataset.start`), moved, 'точка табуляции шкалы — на выбранном интервале');

  // выбранный интервал остаётся выбранным, даже когда фокус ушёл со шкалы
  await evaluate(`document.activeElement.click()`);
  assert.equal(await evaluate(`document.querySelector('.ds-row--sel')?.dataset.start ?? null`), moved);
  await evaluate(`document.activeElement.blur()`);
  await background();
  assert.equal(await evaluate(`document.querySelector('.ds-row--sel')?.dataset.start ?? null`), moved, 'выбранный интервал сохранён');
  assert.equal(await evaluate(`document.querySelector('.ds-row[tabindex="0"]').dataset.start`), moved, 'точка табуляции осталась на интервале');

  // фокус вне приложения (на body) — ничего не крадём
  assert.equal((await where()).tag, 'BODY', 'фокус не украден');

  // набор текста в поле — поле не трогаем
  await evaluate(`(() => { const i = document.createElement('input'); i.id = 'probe'; document.getElementById('main').append(i); i.focus(); 0; })()`);
  await background();
  assert.equal(await evaluate(`document.activeElement.id`), 'probe', 'поле ввода не потеряло фокус');

  // плитка причины на экране «Стан стоит»
  await post([{ id: 'st', type: 'stop', at: z('19:30') }]);
  await chrome.reload();
  await chrome.waitFor(`document.querySelectorAll('.ps-reason').length > 1`, { what: 'плитки причин' });
  await sleep(600);
  await evaluate(WATCH_STATE);
  await evaluate(`document.querySelectorAll('.ps-reason')[1].focus()`);
  const label = (await where()).txt;
  await mark();
  await background();
  assert.ok(await replaced(), 'узел плитки пересоздан');
  assert.equal((await where()).txt, label, 'фокус остался на той же плитке причины');
  assert.equal(await evaluate(`[...document.querySelectorAll('.ps-reason')].indexOf(document.activeElement)`), 1);
});

test('UI: панель «Сохранить» целиком над нижним меню на 320–1280 px', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { origin, chrome } = await setup(t);
  const { evaluate } = chrome;
  const click = async (sel) => { await sleep(450); await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`); };
  const clickText = async (sel, text) => {
    await sleep(450);
    await evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`);
    await sleep(80);
  };
  const problems = [];
  for (const [w, h] of [[320, 568], [360, 640], [390, 844], [768, 1024], [1280, 800]]) {
    await chrome.viewport(w, h, { mobile: w <= 480 });
    await chrome.navigate(origin + '/#key=k1');
    await chrome.reload();
    await chrome.waitFor(`!!document.querySelector('#admin')`, { what: 'кнопка «Администратор»' });
    await click('#admin');
    await chrome.waitFor(`!!document.querySelector('.ps-admin .ps-card')`, { what: 'страница администратора' });
    await clickText('.ps-subnav__item', 'Рассылка');
    await clickText('.ps-admin button', 'Добавить получателя');
    await evaluate('window.scrollTo(0, 0)');
    await sleep(200);
    const m = JSON.parse(await evaluate(`(() => { const btn = [...document.querySelectorAll('.ps-savebar .ps-btn')].find((b) => b.textContent.trim() === 'Сохранить'); const bar = document.querySelector('.ps-savebar');
      const n = document.getElementById('nav').getBoundingClientRect(); const b = btn.getBoundingClientRect(); const r = bar.getBoundingClientRect();
      return JSON.stringify({ btnTop: b.top, btnBottom: b.bottom, barTop: r.top, barLeft: r.left, barBottom: r.bottom, navTop: n.top, navLeft: n.left, navRight: n.right, navW: n.width, vw: innerWidth, vh: innerHeight, shown: !bar.hidden }); })()`));
    const bottomNav = m.navW > m.vw * 0.9;
    const limit = bottomNav ? m.navTop : m.vh;
    if (!m.shown) problems.push(`${w}×${h}: панель не показана`);
    if (m.barBottom > limit + 0.5) problems.push(`${w}×${h}: низ панели ${m.barBottom} ниже ${bottomNav ? 'верха меню' : 'окна'} ${limit}`);
    if (m.btnBottom > limit + 0.5) problems.push(`${w}×${h}: низ кнопки «Сохранить» ${m.btnBottom} ниже ${limit}`);
    if (!bottomNav && m.barLeft < m.navRight) problems.push(`${w}×${h}: панель заходит под левое меню`);
  }
  assert.deepEqual(problems, []);
});

// 3) Повреждённые элементы старой сессии не блокируют пульт; исправные записи остаются
test('UI: повреждённые элементы сессии отбрасываются, пульт загружается', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { origin, chrome } = await setup(t);
  const { evaluate, send } = chrome;
  const good = { event: { id: 'keep-1', type: 'stop', at: z('19:00') }, status: 'saved' };
  const inputs = {
    'queue: [null]': { queue: [null] },
    'records: [null]': { records: [null] },
    'records: [{status}] без event': { records: [{ status: 'pending' }] },
    'queue: событие без id + исправная запись': { queue: [{ type: 'stop' }, null, 5], records: [null, { event: {}, status: 'pending' }, good] },
  };
  await chrome.viewport(1280, 800, { mobile: false });
  for (const [name, session] of Object.entries(inputs)) {
    const sent = JSON.stringify(JSON.stringify(session));
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(origin)} && !sessionStorage.seeded) { sessionStorage.seeded = 1; localStorage.clear(); localStorage.setItem('stan.session.v1', ${sent}); }` });
    chrome.consoleLog.length = 0;
    await chrome.navigate(origin + '/#key=k2');
    await chrome.waitFor(`!!document.querySelector('#main h1, #main .ps-flow') && !/Загружаем/.test(document.getElementById('main').innerText)`, { what: 'пульт: ' + name });
    await sleep(500);
    assert.deepEqual(chrome.consoleLog.filter((e) => e.kind === 'exception'), [], 'нет необработанных исключений: ' + name);
    if (session.records?.includes(good)) {
      const kept = await evaluate(`(() => { const s = JSON.parse(localStorage.getItem('stan.session.v1') || '{}'); return (s.records || []).map((r) => r.event && r.event.id); })()`);
      assert.ok(kept.includes('keep-1') || kept.length === 0, 'исправная запись не испорчена: ' + name);
      assert.ok(kept.every(Boolean), 'в сохранённой сессии нет записей без event: ' + name);
    }
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await evaluate(`sessionStorage.clear(); localStorage.clear()`);
  }
});

// 5) Сохранённый конфликт без кэша справочника: экран не падает, после /api/refs показывает названия причин
test('UI: сохранённый конфликт без кэша справочника не блокирует загрузку', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const stored = JSON.parse(fs.readFileSync(new URL('./fixtures/conflict-storage.json', import.meta.url), 'utf8'));
  assert.ok(!('stan.refs' in stored));
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k0,a:k1', adminDevices: ['owner'], now: () => new Date(Date.parse('2026-10-23T12:00:00Z')) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const chrome = await startChrome({});
  t.after(async () => { await chrome.stop(); await app.close(); });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${Date.parse('2026-10-23T12:00:00Z')};
    if (location.origin === ${JSON.stringify(origin)} && !sessionStorage.seeded) { sessionStorage.seeded = 1; localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(stored)})) localStorage.setItem(k, v); }` });
  await chrome.viewport(1280, 800, { mobile: false });
  await chrome.navigate(origin + '/?missingrefs=1');
  await chrome.waitFor(`!!localStorage.getItem('stan.refs')`, { what: 'справочник загружен' });
  await sleep(600);
  assert.deepEqual(chrome.consoleLog.filter((e) => e.kind === 'exception'), [], 'нет необработанных исключений');
  assert.ok(await evaluate0(chrome, `!!document.querySelector('.pult, [data-act], .ps-flow')`), 'экран пульта показан');
  const rejects = await evaluate0(chrome, `document.getElementById('rejects').innerText`);
  assert.ok(!/plan_profile/.test(rejects), 'после загрузки справочника код причины заменён названием: ' + rejects.slice(0, 200));
});
const evaluate0 = (chrome, expr) => chrome.evaluate(expr);
