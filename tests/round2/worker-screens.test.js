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

test('пульт стоящего стана без причины: плиток нет, есть текст и кнопка «Указать причину сейчас»', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'p1' }); await a.pump();
  a.h.renderStop(a.main(), a.h.buildView());
  assert.equal(byClass(a, 'ps-reason', 'BUTTON').length, 0, 'плиток причины на пульте больше нет');
  assert.match(text(a.main()), /Стан стоит с \d\d:\d\d\. Причину укажете в разборе смены/);
  assert.ok(!text(a.main()).includes('Почему стоит?'));
  // Кнопка вторичная (не крупная) и открывает прежний мастер причины на первом шаге
  const later = findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e) === 'Указать причину сейчас')[0];
  assert.ok(later); assert.ok(!later.className.includes('ps-btn--lg')); assert.ok(later.className.includes('ps-btn--secondary'));
  a.click(a.main(), 'Указать причину сейчас');
  assert.equal(a.h.ui.screen, 'reason'); assert.equal(a.h.ui.wz.mode, 'current'); assert.equal(a.h.ui.wz.step, 1);
  a.screen();
  const tiles = byClass(a, 'ps-reason', 'BUTTON');
  assert.deepEqual(tiles.map((x) => x.attrs['data-zone']), ['plan', 'unplanned', 'failure']);
  assert.ok(tiles.every((x) => x.attrs['aria-pressed'] === 'false'));
  tap(a, 'Бурёжка');
  assert.equal(question(a), 'Что именно?');
  // Назад к плиткам: плитка, выбранная ранее, отмечена
  tap(a, 'К выбору причины');
  const pressed = byClass(a, 'ps-reason', 'BUTTON').filter((x) => x.attrs['aria-pressed'] === 'true');
  assert.equal(pressed.length, 1); assert.match(text(pressed[0]), /Бурёжка/);
});

test('мастер причины при остановке показывает панель состояния, при правке в разборе — нет; «Укажу позже» нет нигде', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'p2' }); await a.pump();
  a.h.ui.wz = { mode: 'current', downtimeId: 'p2', step: 1, group: null, reason: null, note: '' };
  a.h.go('reason');
  assert.equal(byClass(a, 'ps-state').length, 1); assert.match(text(byClass(a, 'ps-state')[0]), /Стан стоит/);
  a.h.ui.wz = { mode: 'shiftfix', downtimeId: 'p2', index: 0, step: 1, group: null, reason: null, note: '' };
  a.screen();
  assert.equal(byClass(a, 'ps-state').length, 0);
  assert.ok(!text(a.main()).includes('Укажу позже'));
  // Режим старой версии («past», «restart») из черновика не ломает экран: возврат на главный
  a.h.ui.wz = { mode: 'restart', downtimeId: 'p2', step: 1, group: null, reason: null, note: '' };
  a.screen();
  assert.equal(a.h.ui.wz, null); assert.equal(a.h.ui.screen, 'auto');
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
