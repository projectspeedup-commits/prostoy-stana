import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Поток «без причины» в настоящем Chrome: стоп и пуск одним нажатием, разбор простоев с правкой времени,
// подробности получаса на шкале суток (кнопки «Разобрать» и «Отметить простой здесь»). Политика CSP не должна ругаться.
const NOW = Date.parse('2026-10-01T20:00:00Z'); // 23:00 МСК, смена 2 (20:00–08:00)
const z = (hm) => `2026-10-01T${hm}:00Z`;

test('UI: стоп и пуск одним нажатием, разбор простоев с правкой времени, шкала суток с подробностями', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const chrome = await startChrome({});
  t.after(async () => { await chrome.stop(); await app.close(); });
  const { evaluate } = chrome;
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const post = async (events) => {
    const r = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    assert.deepEqual((await r.json()).rejected, []);
  };
  const rows = (sql) => app.db.prepare(sql).all().map((r) => ({ ...r, body: JSON.parse(r.body) }));
  const click = async (selector) => { await chrome.clickElement(selector); await sleep(150); };
  const clickText = async (selector, text) => { await chrome.clickText(selector, text); await sleep(150); };
  const body = () => evaluate('document.body.innerText');
  const setInput = (selector, value) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  await post([{ id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') }]);
  await chrome.viewport(1280, 800, { mobile: false });
  await chrome.navigate(origin + '/#key=k2');
  await chrome.waitFor(`!!document.querySelector('[data-act="stop"]')`, { what: 'кнопка «Стан встал»' });
  await sleep(600);

  // ---- «Стан встал»: одно нажатие, окна причины нет ----
  await click('[data-act="stop"]');
  await chrome.waitFor(`document.querySelector('.ps-state[data-state="stop"]')`, { what: 'пульт «Стан стоит»' });
  await chrome.waitFor(`JSON.parse(localStorage.getItem('stan.queue')).length === 0`, { what: 'остановка отправлена' });
  assert.equal(await evaluate(`document.querySelectorAll('.ps-reason').length`), 0, 'плиток причины нет');
  assert.match(await body(), /Причину укажете в разборе смены/);
  const stops = rows(`SELECT body FROM events WHERE type = 'stop'`);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].body.reason, undefined);
  // ---- «Стан пошёл»: одно нажатие, тост, возврат на главный ----
  await click('[data-act="run"]');
  await chrome.waitFor(`document.querySelector('.ps-state[data-state="run"]')`, { what: 'пульт «Стан работает»' });
  await chrome.waitFor(`JSON.parse(localStorage.getItem('stan.queue')).length === 0`, { what: 'пуск отправлен' });
  assert.match(await evaluate(`document.querySelector('#toast').textContent`), /Записано\. Причину и что сделали — в разборе смены/);
  const starts = rows(`SELECT body FROM events WHERE type = 'start'`);
  assert.equal(starts.length, 1);
  assert.deepEqual(['reason', 'note', 'action', 'billet'].filter((k) => k in starts[0].body), []);

  // ---- Разбор простоев: счётчик, начало разбора, правка времени ----
  await post([
    { id: 'm1', type: 'manual', at: z('19:55'), from: z('17:10'), to: z('17:25') },
    { id: 'm2', type: 'manual', at: z('19:55'), from: z('17:40'), to: z('18:10') },
  ]);
  await chrome.reload();
  await chrome.waitFor(`!!document.querySelector('[data-act="stop"]')`, { what: 'пульт' });
  await sleep(600);
  assert.match(await evaluate(`document.querySelector('.shift-block').innerText`), /Без причины: 2/, 'на главном экране есть предупреждение');
  await click('#nav-shift');
  await chrome.waitFor(`document.querySelector('#main h1')?.textContent === 'Разбор простоев'`, { what: 'экран «Разбор простоев»' });
  assert.match(await body(), /Без причины: 2/);
  assert.equal(await evaluate(`document.querySelector('#nav-shift').getAttribute('aria-label')`), 'Разбор простоев');
  await clickText('#main button', 'Начать разбор');
  await chrome.waitFor(`!!document.querySelector('.ps-editor')`, { what: 'редактор простоя' });
  const first = await evaluate(`document.querySelector('.ps-editor .ps-card__title').textContent`);
  assert.match(first, /20:10–20:25/, 'первым открыт самый ранний простой без причины');
  assert.equal(await evaluate(`[...document.querySelectorAll('.ps-editor button')].find((b) => b.textContent === 'Сохранить время').disabled`), true);
  // Наложение на соседний простой — понятная ошибка, кнопка не работает
  await setInput('.ps-editor input[aria-label="Стан пошёл, Москва"]', '2026-10-01T20:50');
  assert.match(await evaluate(`document.querySelector('.ps-timefix .ps-field__error').textContent`), /Пересекается с другим простоем 20:40–21:10/);
  assert.equal(await evaluate(`[...document.querySelectorAll('.ps-editor button')].find((b) => b.textContent === 'Сохранить время').disabled`), true);
  // Верное время: начало на 5 минут раньше
  await setInput('.ps-editor input[aria-label="Стан пошёл, Москва"]', '2026-10-01T20:25');
  await setInput('.ps-editor input[aria-label="Стан встал, Москва"]', '2026-10-01T20:05');
  assert.equal(await evaluate(`document.querySelector('.ps-timefix .ps-field__error').hidden`), true);
  await clickText('.ps-editor button', 'Сохранить время');
  await chrome.waitFor(`JSON.parse(localStorage.getItem('stan.queue')).length === 0`, { what: 'правка времени отправлена' });
  const fixes = rows(`SELECT body FROM events WHERE type = 'fix'`);
  assert.equal(fixes.length, 1);
  assert.equal(Date.parse(fixes[0].body.from), Date.parse(z('17:05'))); assert.equal(fixes[0].body.downtimeId, 'm1'); assert.equal(fixes[0].body.index, 0);
  assert.equal('to' in fixes[0].body, false, 'конец не менялся — в событии его нет');
  assert.match(await evaluate(`document.querySelector('.ps-editor .ps-card__title').textContent`), /20:05–20:25/);

  // ---- Причина по классификатору и «Следующий без причины →» ----
  await clickText('.ps-editor .ps-chip', 'Бурёжка');
  await clickText('#main button', 'В ножницах');
  await clickText('#main button', 'Без описания');
  await chrome.waitFor(`[...document.querySelectorAll('#main button')].some((b) => b.textContent === 'Следующий без причины →')`, { what: 'кнопка «Следующий без причины →»' });
  await clickText('#main button', 'Следующий без причины →');
  await chrome.waitFor(`/20:40–21:10/.test(document.querySelector('.ps-editor .ps-card__title')?.textContent || '')`, { what: 'открыт следующий простой' });

  // ---- Шкала суток: подробности получаса ----
  await clickText('#demo', 'Пульт');
  await chrome.waitFor(`!!document.querySelector('.ds-row')`, { what: 'шкала суток' });
  await sleep(450);
  const cellStart = Date.parse(z('17:00'));
  await chrome.clickElement(`.ds-row[data-start="${cellStart}"]`);
  await chrome.waitFor(`!document.querySelector('.day-scale__details').hidden && !!document.querySelector('.day-scale__details .ds-detail')`, { what: 'подробности получаса' });
  const details = await evaluate(`document.querySelector('.day-scale__details').innerText`);
  assert.match(details, /20:05–20:25 · Бурёжка|20:05–20:25 · В ножницах|20:05–20:25 · /);
  const buttons = await evaluate(`[...document.querySelectorAll('.day-scale__details button')].map((b) => b.textContent)`);
  assert.deepEqual(buttons, ['Разобрать', 'Отметить простой здесь']);
  // «Отметить простой здесь» открывает мастер с началом получаса
  await clickText('.day-scale__details button', 'Отметить простой здесь');
  await chrome.waitFor(`document.querySelector('#main h1')?.textContent === 'Когда стан встал?'`, { what: 'мастер «Забыли отметить простой»' });
  assert.equal(await evaluate(`document.querySelector('#main input[type="datetime-local"]').value`), '2026-10-01T20:00', 'начало подставлено со шкалы');
  // «Разобрать» открывает запись простоя
  await clickText('#main button', 'Назад');
  await chrome.waitFor(`!!document.querySelector('.ds-row')`, { what: 'пульт после мастера' });
  // Выбранный получас запомнен шкалой: подробности открыты сразу, повторное нажатие закрыло бы их
  await chrome.waitFor(`!document.querySelector('.day-scale__details').hidden && !!document.querySelector('.day-scale__details .ds-detail__btn')`, { what: 'подробности получаса после возврата' });
  await clickText('.day-scale__details button', 'Разобрать');
  await chrome.waitFor(`!!document.querySelector('.ps-editor')`, { what: 'редактор из шкалы' });
  assert.match(await evaluate(`document.querySelector('.ps-editor .ps-card__title').textContent`), /20:05–20:25/);

  const csp = chrome.consoleLog.filter((e) => /Content Security|Refused to|violat/i.test(e.text) || e.kind === 'exception');
  assert.deepEqual(csp, [], JSON.stringify(csp));
});
