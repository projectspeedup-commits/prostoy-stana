import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';
import { zoneOf } from '../../app/core/zones.js';

// Мастер выбора причины на модели планшета: плитка → «Что именно?» → своими словами
const start = Date.parse('2026-10-05T05:00:00Z');
const at = (mins) => new Date(start + mins * 60000).toISOString();
async function fixture(t) {
  const clock = { t: start + 160 * 60000 };
  const app = await round2Server(t, clock, start);
  const port = app.server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'X-Device-Key': 'k2', Connection: 'close' },
    body: JSON.stringify({ events: [{ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' }] }) });
  const a = await bootTablet({ name: 'A', key: 'k1', clock, port });
  await a.boot();
  return { a, clock };
}
const buttons = (a) => findAll(a.main(), (e) => e.tagName === 'BUTTON').map(text);
const step = (a) => text(findAll(a.main(), (e) => e.className === 'step')[0]);
const question = (a) => text(findAll(a.main(), (e) => e.className === 'q')[0]);
// Нажатие и перерисовка, как делает страница
const tap = (a, label) => { a.click(a.main(), label); return a.screen(); };
async function openStop(a, downtimeId = 'd1') {
  a.h.send('stop', { downtimeId });
  await a.pump();
  a.h.ui.wz = { mode: 'current', downtimeId, step: 1, group: null, reason: null, note: '' };
  a.h.go('reason');
  a.screen();
}

test('справочник на странице: зоны пунктов', () => {
  const refs = { reasons: {
    tech_stands: { zone: 'unplanned' }, avaria: { zone: 'failure' }, plan_setup: { zone: 'plan' } } };
  assert.equal(zoneOf('tech_stands', refs), 'unplanned');
  assert.equal(zoneOf('avaria', refs), 'failure');
  assert.equal(zoneOf('plan_setup', refs), 'plan');
});

test('бурёжка: плитка → «Что именно?» (5 кнопок) → «В ножницах» → «Без описания» → событие reason', async (t) => {
  const { a } = await fixture(t);
  await openStop(a);
  assert.equal(question(a), 'Почему стоит?'); assert.equal(step(a), 'Шаг 1 из 3');
  tap(a, 'Бурёжка');
  assert.equal(question(a), 'Что именно?'); assert.equal(step(a), 'Шаг 2 из 3');
  const items = buttons(a).filter((b) => /ТРИО|ножницах|ТМУ|холодильнике|Другое место/.test(b));
  assert.equal(items.length, 5);
  assert.ok(items.every((b) => b.includes('внеплановый простой')), 'подпись зоны пункта');
  // Назад с описания → «Что именно?» → плитки
  tap(a, 'В ножницах');
  assert.equal(question(a), 'Расскажите своими словами'); assert.equal(step(a), 'Шаг 3 из 3');
  assert.ok(buttons(a).some((b) => b.includes('К выбору пункта')));
  tap(a, 'К выбору пункта');
  assert.equal(question(a), 'Что именно?'); assert.equal(step(a), 'Шаг 2 из 3');
  assert.equal(findAll(a.main(), (e) => /\bsel\b/.test(e.className)).length, 0, 'пункты одного цвета, без подсветки');
  tap(a, 'К выбору причины');
  assert.equal(question(a), 'Почему стоит?'); assert.equal(step(a), 'Шаг 1 из 3');
  tap(a, 'Бурёжка'); tap(a, 'В ножницах');
  tap(a, 'Без описания');
  const ev = a.h.queue.findLast((e) => e.type === 'reason');
  assert.equal(ev.reason, 'cobble_shears');
  await a.pump();
  assert.equal(a.h.serverState.open.segments[0].reason, 'cobble_shears');
});

test('«в другом месте» и «Выход из строя оборудования»: без описания сохранить нельзя', async (t) => {
  const { a } = await fixture(t);
  await openStop(a);
  tap(a, 'Поломка, замена оборудования');
  assert.equal(findAll(a.main(), (e) => e.tagName === 'BUTTON' && /Замена|Выход|Другое/.test(text(e))).length, 6);
  tap(a, 'Выход из строя оборудования');
  assert.ok(!buttons(a).some((b) => b.includes('Без описания')));
  a.click(a.main(), 'Сохранить'); a.screen();
  assert.equal(a.h.queue.some((e) => e.type === 'reason'), false, 'пустое описание не уходит');
  assert.equal(question(a), 'Что случилось? Опишите своими словами');
  // другое место бурёжки — тоже обязательно
  tap(a, 'К выбору пункта'); tap(a, 'К выбору причины');
  tap(a, 'Бурёжка'); tap(a, 'Другое место');
  assert.ok(!buttons(a).some((b) => b.includes('Без описания')));
  // технологическая замена — можно без описания, зона внеплановая
  tap(a, 'К выбору пункта'); tap(a, 'К выбору причины');
  tap(a, 'Поломка, замена оборудования'); tap(a, 'Замена клетей');
  assert.ok(buttons(a).some((b) => b.includes('Без описания')));
  tap(a, 'Без описания');
  assert.equal(a.h.queue.findLast((e) => e.type === 'reason').reason, 'tech_stands');
});

test('черновик на шаге описания без пункта возвращается на плитки', async (t) => {
  const { a } = await fixture(t);
  await openStop(a);
  a.h.ui.wz.step = 3; a.h.ui.wz.group = 'cobble'; a.h.ui.wz.reason = null;
  a.screen(); assert.equal(question(a), 'Почему стоит?');
  a.h.ui.wz.step = 3; a.h.ui.wz.reason = 'нет_такой';
  a.screen(); assert.equal(question(a), 'Почему стоит?');
});

test('«Забыл отметить простой»: плитка → «Что именно?» → описание, шаги без пропусков', async (t) => {
  const { a } = await fixture(t);
  a.h.ui.fw = { step: 2, atMs: a.h.nowMs() - 20 * 60000, group: null, reason: null, note: '' };
  a.h.go('forgotStop'); a.screen();
  assert.equal(question(a), 'Почему стоит?'); assert.equal(step(a), 'Шаг 2 из 5');
  tap(a, 'Бурёжка');
  assert.equal(question(a), 'Что именно?'); assert.equal(step(a), 'Шаг 3 из 5');
  tap(a, 'На холодильнике');
  assert.equal(question(a), 'Расскажите своими словами'); assert.equal(step(a), 'Шаг 4 из 5');
  assert.ok(buttons(a).some((b) => b.includes('К выбору пункта')));
  tap(a, 'Далее');
  assert.equal(question(a), 'Всё верно?'); assert.equal(step(a), 'Шаг 5 из 5');
  assert.equal(a.h.ui.fw.reason, 'cobble_coolbed');
});

test('ручной ввод прошлого простоя: плитка → «Что именно?» → описание → «что сделали»', async (t) => {
  const { a } = await fixture(t);
  const openedAt = Math.floor(a.h.nowMs() / 60000) * 60000;
  a.h.ui.mw = { origin: 'auto', step: 3, from: openedAt - 40 * 60000, to: openedAt - 20 * 60000, openedAt, group: null, reason: null, note: '', action: '' };
  a.h.go('manual'); a.screen();
  assert.equal(question(a), 'Почему стоял?'); assert.equal(step(a), 'Шаг 3 из 7');
  tap(a, 'Бурёжка');
  assert.equal(question(a), 'Что именно?'); assert.equal(step(a), 'Шаг 4 из 7');
  tap(a, 'В трассе ТМУ');
  assert.equal(question(a), 'Расскажите своими словами'); assert.equal(step(a), 'Шаг 5 из 7');
  tap(a, 'К выбору пункта');
  assert.equal(question(a), 'Что именно?');
  tap(a, 'В трассе ТМУ');
  tap(a, 'Без описания');
  assert.equal(question(a), 'Что сделали, чтобы запустить стан?'); assert.equal(step(a), 'Шаг 6 из 7');
  assert.equal(a.h.ui.mw.reason, 'cobble_tmu');
});

test('пуск со сменой причины: плитка → пункт → «Что сделали»; брак — для cobble_* и avaria, не для tech_* и plan_*', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'd2' }); await a.pump();
  const cases = [
    ['Бурёжка', 'В клети ТРИО', true], ['Бурёжка', 'Другое место', true],
    ['Поломка, замена оборудования', 'Выход из строя оборудования', true],
    ['Поломка, замена оборудования', 'Замена клетей', false], ['Поломка, замена оборудования', 'Замена ножей', false],
    ['Плановая', 'Настройка стана', false], ['Плановая', 'Смена профиля', false], ['Плановая', 'Другое', false], ['Поломка, замена оборудования', 'Другое', true],
  ];
  for (const [tile, item, billet] of cases) {
    const view = a.h.buildView();
    a.h.ui.wz = null;
    a.h.ui.rw = a.h.newRestart(view);
    a.h.startRestartReasonWizard(); a.screen();
    assert.equal(question(a), 'Почему стоял?');
    tap(a, tile);
    assert.equal(question(a), 'Что именно?'); assert.equal(step(a), 'Шаг 2 из 3');
    tap(a, item);
    assert.equal(a.h.ui.screen, 'restartAction', item);
    a.screen(); assert.equal(step(a), 'Шаг 3 из 3', item);
    assert.equal(a.h.restartNeedsBillet(a.h.ui.rw, a.h.buildView()), billet, item);
    // «Назад» с «Что сделали» ведёт на «Что именно?»
    assert.ok(buttons(a).some((b) => b.includes('К выбору пункта')), item);
  }
  // старые коды: поведение прежнее
  for (const [code, expected] of [['perevalka', false], ['burezhka', true], ['avaria', true]]) {
    a.h.ui.rw = { ...a.h.newRestart(a.h.buildView()), reason: code };
    assert.equal(a.h.restartNeedsBillet(a.h.ui.rw, a.h.buildView()), expected, code);
  }
});
