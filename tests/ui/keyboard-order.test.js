import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Порядок Tab и клавиатурный доступ (отчёт тестировщика отображения):
// 1) главное действие пульта и плитки причин получают фокус раньше шкалы суток, а шкала — одна точка табуляции;
// 2) у каждой ячейки шкалы есть доступное имя с временем и статусом;
// 3) нижнее меню не закрывает плитку, получившую фокус с клавиатуры на 320×568.
const NOW = Date.parse('2026-10-01T20:00:00Z');
const z = (hm) => `2026-10-01T${hm}:00Z`;

test('UI: порядок Tab, шкала суток одной точкой табуляции, фокус не под нижним меню', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let chrome = null;
  t.after(async () => { await chrome?.stop(); await app.close(); });
  const post = async (events) => {
    const r = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    assert.deepEqual((await r.json()).rejected, []);
  };
  await post([{ id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') }]);

  chrome = await startChrome({});
  const { evaluate, send } = chrome;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const ready = (cond, what) => chrome.waitFor(cond, { what });
  const press = async (key, code, vk, { text, modifiers = 0 } = {}) => {
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(40);
  };
  const tab = () => press('Tab', 'Tab', 9);
  const active = () => evaluate(`(() => { const a = document.activeElement; return a ? { cls: a.className, act: a.dataset.act || '', txt: (a.textContent || '').trim().slice(0, 40), inScale: !!a.closest('.day-scale') } : null; })()`);
  // Чистый старт фокуса: перед первым элементом страницы
  const resetFocus = () => evaluate(`document.activeElement?.blur(); window.scrollTo(0, 0); 0`);
  const idx = () => evaluate(`[...document.querySelectorAll('.ds-row')].indexOf(document.activeElement)`);

  // ---- 1. Пульт «Стан работает»: до «Стан встал» — несколько Tab, не полсотни ----
  await chrome.viewport(1280, 800, { mobile: false });
  await chrome.navigate(origin + '/#key=k2');
  await chrome.reload();
  await ready(`!!document.querySelector('[data-act="stop"]')`, 'кнопка «Стан встал»');
  await sleep(600);
  await resetFocus();
  let presses = 0;
  for (; presses < 15; presses++) {
    await tab();
    const a = await active();
    if (a.act === 'stop') break;
    assert.ok(!a.inScale, `шкала получила фокус раньше «Стан встал» (Tab №${presses + 1}: ${a.cls})`);
  }
  assert.ok(presses < 15, '«Стан встал» достижим не более чем за 15 нажатий Tab');

  // ---- 1b. Шкала — одна точка табуляции; имя ячейки; стрелки, Home/End; Enter открывает сведения ----
  const info = JSON.parse(await evaluate(`JSON.stringify({ rows: document.querySelectorAll('.ds-row').length, tabbable: document.querySelectorAll('.ds-row:not([tabindex="-1"])').length,
    unnamed: [...document.querySelectorAll('.ds-row')].filter((r) => { const l = r.getAttribute('aria-label') || '';
      return !/\\d\\d:\\d\\d.\\d\\d:\\d\\d/.test(l) || !/(работа|нет данных|ещё не наступило|плановый|внеплановый|авария)/.test(l); }).length })`));
  assert.equal(info.rows, 48);
  assert.equal(info.tabbable, 1, 'в порядке Tab от шкалы — ровно одна ячейка');
  assert.equal(info.unnamed, 0, 'у каждой ячейки есть имя с временем и статусом');
  let guard = 0;
  while (!(await active()).inScale && guard++ < 40) await tab();
  assert.ok(guard < 40, 'шкала достижима с клавиатуры');
  const first = await idx();
  await press('ArrowRight', 'ArrowRight', 39);
  assert.equal(await idx(), Math.min(47, first + 1), 'стрелка вправо — следующая ячейка');
  await press('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await idx(), first, 'стрелка влево — назад');
  await press('End', 'End', 35);
  assert.equal(await idx(), 47, 'End — последняя ячейка');
  await press('Home', 'Home', 36);
  assert.equal(await idx(), 0, 'Home — первая ячейка');
  assert.equal(await evaluate(`document.querySelectorAll('.ds-row[tabindex="0"]').length`), 1, 'после стрелок точка табуляции по-прежнему одна');
  const ring = JSON.parse(await evaluate(`(() => { const s = getComputedStyle(document.activeElement); return JSON.stringify({ w: parseFloat(s.outlineWidth), st: s.outlineStyle, bs: s.boxShadow, fv: document.activeElement.matches(':focus-visible') }); })()`));
  assert.ok(ring.fv && ((ring.w > 0 && ring.st !== 'none') || ring.bs !== 'none'), 'контур фокуса ячейки виден: ' + JSON.stringify(ring));
  await press('Enter', 'Enter', 13, { text: '\r' });
  assert.ok(await evaluate(`!document.querySelector('.day-scale__details').hidden`), 'Enter открывает сведения ячейки');
  await press(' ', 'Space', 32, { text: ' ' });
  assert.ok(await evaluate(`document.querySelector('.day-scale__details').hidden`), 'пробел переключает сведения обратно');
  await tab();
  assert.ok(!(await active()).inScale, 'один Tab выводит из шкалы');
  // Клик мышью по ячейке работает
  await chrome.clickElement('.ds-row:nth-of-type(20)');
  assert.ok(await evaluate(`!document.querySelector('.day-scale__details').hidden`), 'клик по ячейке открывает сведения');

  // ---- 1c. Пульт «Стан стоит»: плитки причин и «Стан пошёл» раньше шкалы ----
  await post([{ id: 'st', type: 'stop', at: z('19:30') }]);
  await chrome.reload();
  await ready(`document.querySelectorAll('.ps-reason').length > 0`, 'плитки причин');
  await sleep(600);
  await resetFocus();
  const seen = [];
  for (let i = 0; i < 40; i++) {
    await tab();
    const a = await active();
    if (a.inScale) { seen.push('scale'); break; }
    seen.push(a.act || a.txt);
  }
  assert.equal(seen[seen.length - 1], 'scale', 'шкала получает фокус после главного содержимого: ' + seen.join(' | '));
  assert.ok(seen.includes('run'), '«Стан пошёл» получает фокус раньше шкалы: ' + seen.join(' | '));
  assert.ok(seen.length <= 20, 'до шкалы не больше 20 нажатий: ' + seen.length);

  // ---- 3. 320×568: сфокусированная плитка не под нижним меню ----
  await chrome.viewport(320, 568, { mobile: true });
  await chrome.reload();
  await ready(`document.querySelectorAll('.ps-reason').length > 0`, 'плитки причин на 320');
  await sleep(700);
  await resetFocus();
  const covered = [];
  const names = [];
  for (let i = 0; i < 40; i++) {
    await tab();
    await sleep(150);
    const r = JSON.parse(await evaluate(`(() => { const a = document.activeElement; if (!a || !a.closest('.ps-reason, .ps-action')) return JSON.stringify(null);
      const b = a.getBoundingClientRect(); const x = b.x + b.width / 2; const y = Math.min(b.y + b.height / 2, innerHeight - 1);
      const top = document.elementFromPoint(x, y); const nav = document.getElementById('nav').getBoundingClientRect();
      return JSON.stringify({ t: a.textContent.trim().slice(0, 30), under: !!top && !a.contains(top) && !top.contains(a), top: top?.id || top?.className, bottom: b.bottom, navTop: nav.top }); })()`));
    if (!r) { if ((await active()).inScale) break; continue; }
    names.push(r.t);
    if (r.under || r.bottom > r.navTop + 0.5) covered.push(r);
  }
  for (const n of ['Плановая', 'Бурёжка', 'Поломка, замена оборудования']) assert.ok(names.some((x) => x.startsWith(n)), 'проверена плитка «' + n + '»: ' + names.join(' | '));
  assert.deepEqual(covered, [], 'сфокусированный элемент закрыт нижним меню: ' + JSON.stringify(covered));
});
