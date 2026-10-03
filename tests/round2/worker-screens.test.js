import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';

// Экраны рабочего у поста на дизайн-системе: плитки причины, лист «что сделали», связь.
// Проверяется поведение (шаги, события, блокировки), а не цвета.
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
const byClass = (a, cls, tag) => findAll(a.main(), (e) => e.className.split(' ').includes(cls) && (!tag || e.tagName === tag));
const question = (a) => text(findAll(a.main(), (e) => e.className === 'q')[0]);
const tap = (a, label) => { a.click(a.main(), label); return a.screen(); };
const chip = (a, label) => findAll(a.main(), (e) => e.tagName === 'BUTTON' && e.className.includes('ps-chip') && text(e) === label)[0];

test('пульт стоящего стана без причины: три плитки под панелью, нажатие ведёт на «Что именно?»', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'p1' }); await a.pump();
  a.h.renderStop(a.main(), a.h.buildView());
  const tiles = byClass(a, 'ps-reason', 'BUTTON');
  assert.deepEqual(tiles.map((x) => x.attrs['data-zone']), ['plan', 'unplanned', 'failure']);
  assert.ok(tiles.every((x) => x.attrs['aria-pressed'] === 'false'));
  assert.ok(!text(a.main()).includes('Указать причину'), 'плитки заменили кнопку «Указать причину»');
  a.click(a.main(), 'Бурёжка');
  assert.equal(a.h.ui.screen, 'reason'); assert.equal(a.h.ui.wz.mode, 'current'); assert.equal(a.h.ui.wz.step, 2);
  a.screen(); assert.equal(question(a), 'Что именно?');
  // Назад к плиткам: плитка, выбранная ранее, отмечена
  tap(a, 'К выбору причины');
  const pressed = byClass(a, 'ps-reason', 'BUTTON').filter((x) => x.attrs['aria-pressed'] === 'true');
  assert.equal(pressed.length, 1); assert.match(text(pressed[0]), /Бурёжка/);
});

test('мастер причины при остановке показывает панель состояния, при правке прошлого — нет', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'p2' }); await a.pump();
  a.h.ui.wz = { mode: 'current', downtimeId: 'p2', step: 1, group: null, reason: null, note: '' };
  a.h.go('reason');
  assert.equal(byClass(a, 'ps-state').length, 1); assert.match(text(byClass(a, 'ps-state')[0]), /Стан стоит/);
  a.h.ui.wz = { mode: 'past', downtimeId: 'p2', index: 0, step: 1, group: null, reason: null, note: '' };
  a.screen();
  assert.equal(byClass(a, 'ps-state').length, 0);
  assert.ok(text(a.main()).includes('Укажу позже'));
});

test('уточнение причины чипами: у каждого пункта своя зона словами', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'p3' }); await a.pump();
  a.h.ui.wz = { mode: 'current', downtimeId: 'p3', step: 1, group: null, reason: null, note: '' };
  a.h.go('reason');
  tap(a, 'Поломка, замена оборудования');
  const chips = byClass(a, 'ps-chip', 'BUTTON');
  assert.equal(chips.length, 6);
  assert.ok(chips.some((c) => /Выход из строя/.test(text(c)) && /аварийный простой/.test(text(c))));
  assert.ok(chips.some((c) => /Замена клетей/.test(text(c)) && /внеплановый простой/.test(text(c))));
});

async function openRestart(a, tile, item, id) {
  a.h.send('stop', { downtimeId: id }); await a.pump();
  const view = a.h.buildView();
  a.h.ui.wz = null;
  a.h.ui.rw = a.h.newRestart(view);
  a.h.startRestartReasonWizard(); a.screen();
  tap(a, tile); tap(a, item);
  assert.equal(a.h.ui.screen, 'restartAction');
  a.screen();
}

test('«что сделали»: брак чипами, другое значение, быстрый вариант, сохранение одним пакетом', async (t) => {
  const { a } = await fixture(t);
  await openRestart(a, 'Бурёжка', 'В ножницах', 'r1');
  assert.equal(question(a), 'Что сделали, чтобы запустить стан?');
  for (const v of ['0', '0,5', '1', '1,5', '2', 'Другое']) assert.ok(chip(a, v), 'чип брака ' + v);
  // Без брака пуск не сохраняется: брак после бурёжки обязателен
  a.click(a.main(), 'Сохранить пуск');
  assert.equal(a.h.queue.some((e) => e.type === 'start'), false);
  const error = byClass(a, 'ps-field__error')[0];
  assert.equal(error.hidden, false);
  assert.match(text(error), /от 0 до 1000 тн/);
  // Другое значение: поле появляется и принимает запятую; вне 0–1000 — отказ
  a.click(a.main(), 'Другое');
  const input = findAll(a.main(), (e) => e.tagName === 'INPUT' && e.attrs.id === 'restart-billet')[0];
  assert.equal(input.hidden, false);
  input.value = '1001'; for (const f of input.handlers.input) f({});
  a.click(a.main(), 'Сохранить пуск');
  assert.equal(a.h.queue.some((e) => e.type === 'start'), false);
  input.value = '2,5'; for (const f of input.handlers.input) f({});
  assert.equal(a.h.ui.rw.billet, '2,5');
  // Чип сбрасывает своё значение и отмечается нажатым
  a.click(a.main(), '1,5');
  assert.equal(a.h.ui.rw.billet, '1,5');
  assert.equal(chip(a, '1,5').attrs['aria-pressed'], 'true'); assert.equal(chip(a, '0,5').attrs['aria-pressed'], 'false');
  // Быстрый вариант дописывает фразу в поле, повторное нажатие убирает
  const quick = byClass(a, 'ps-chip', 'BUTTON').filter((c) => !/^(0|0,5|1|1,5|2|Другое)$/.test(text(c)));
  assert.ok(quick.length >= 1, 'быстрые варианты из подсказки справочника');
  const area = findAll(a.main(), (e) => e.tagName === 'TEXTAREA')[0];
  for (const f of quick[0].handlers.click) f({});
  assert.equal(area.value, text(quick[0])); assert.equal(a.h.ui.rw.action, text(quick[0]));
  assert.equal(quick[0].attrs['aria-pressed'], 'true');
  for (const f of quick[0].handlers.click) f({});
  assert.equal(area.value, ''); assert.equal(quick[0].attrs['aria-pressed'], 'false');
  for (const f of quick[0].handlers.click) f({});
  const said = area.value;
  a.click(a.main(), 'Сохранить пуск');
  const events = a.h.queue.slice();
  assert.equal(events.find((e) => e.type === 'start').action, said);
  assert.equal(events.find((e) => e.type === 'fix').billet, 1.5);
  await a.pump();
  assert.equal(a.h.queue.length, 0, 'сервер принял весь пакет');
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0);
});

test('«Заполню потом»: пуск без текста «что сделали», брак по-прежнему обязателен', async (t) => {
  const { a } = await fixture(t);
  await openRestart(a, 'Бурёжка', 'В ножницах', 'r2');
  a.click(a.main(), 'Заполню потом');
  assert.equal(a.h.queue.some((e) => e.type === 'start'), false, 'без брака нельзя');
  for (const f of chip(a, '0').handlers.click) f({});
  a.click(a.main(), 'Заполню потом');
  const startEvent = a.h.queue.find((e) => e.type === 'start');
  assert.ok(startEvent); assert.equal(startEvent.action, undefined);
  assert.equal(a.h.queue.find((e) => e.type === 'fix').billet, 0);
});

test('«Заполню потом» прячется, когда текст уже введён; после плановой брак не спрашивают', async (t) => {
  const { a } = await fixture(t);
  await openRestart(a, 'Плановая', 'Настройка стана и профиля', 'r3');
  assert.equal(findAll(a.main(), (e) => e.attrs.id === 'restart-billet').length, 0);
  assert.equal(byClass(a, 'ps-chips').filter((c) => /^0/.test(text(c))).length, 0);
  const later = findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e) === 'Заполню потом')[0];
  const area = findAll(a.main(), (e) => e.tagName === 'TEXTAREA')[0];
  assert.equal(later.hidden, false);
  area.value = 'Настроили зазоры'; for (const f of area.handlers.input) f({});
  assert.equal(later.hidden, true);
  a.click(a.main(), 'Сохранить пуск');
  assert.equal(a.h.queue.find((e) => e.type === 'start').action, 'Настроили зазоры');
  assert.equal(a.h.queue.some((e) => e.type === 'fix'), false);
});

test('«Связаться»: звонок по tel:, без номера — серая карточка без ссылки, мастер первым, статус связи', async (t) => {
  const { a } = await fixture(t);
  a.h.refs.settings.contacts = [
    { title: 'Дежурный механик', tel: '+7 (900) 000-00-02' },
    { title: 'Диспетчер', tel: '' },
  ];
  a.h.go('contact');
  const cards = byClass(a, 'ps-contact');
  assert.equal(cards.length, 3);
  assert.match(text(cards[0]), /Мастер смены/); assert.equal(cards[0].attrs['aria-disabled'], 'true'); assert.equal(cards[0].tagName, 'DIV');
  assert.equal(cards[1].tagName, 'A'); assert.equal(cards[1].attrs.href, 'tel:+79000000002'); assert.equal(cards[1].attrs['aria-disabled'], undefined);
  assert.match(text(cards[1]), /Дежурный механик.*\+7 \(900\) 000-00-02/);
  assert.equal(cards[2].tagName, 'DIV'); assert.equal(cards[2].attrs['aria-disabled'], 'true'); assert.match(text(cards[2]), /номер не задан/);
  assert.equal(findAll(a.main(), (e) => e.attrs.href).length, 1, 'у карточки без номера нет ссылки');
  const notice = byClass(a, 'ps-notice')[0];
  assert.equal(notice.attrs['data-tone'], 'ok'); assert.match(text(notice), /Связь с сервером есть/);
  // Нет связи: предупреждение и число сохранённых нажатий
  a.net.offline = true;
  a.h.send('stop', { downtimeId: 'c1' }); await a.pump();
  a.h.go('contact');
  assert.equal(byClass(a, 'ps-notice')[0].attrs['data-tone'], 'warn');
});
