import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';
import { build, summaryCell } from '../helpers/report-fixtures.js';
import { recentHandovers } from '../../app/core/core.js';

// Правки по второй проверке: брак из нескольких частей простоя, записка следующей смене при работающем стане,
// чек-лист с открытым простоем без причины, единое правило длительностей.
const start = Date.parse('2026-10-05T05:00:00Z'); // 08:00 МСК, начало дневной смены
const at = (mins) => new Date(start + mins * 60000).toISOString();
const headers = { 'X-Device-Key': 'k2', Connection: 'close' };
const post = (port, events) => fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers, body: JSON.stringify({ events }) }).then((r) => r.json());
async function fixture(t, { crew = true } = {}) {
  const clock = { t: start + 160 * 60000 };
  const app = await round2Server(t, clock, start);
  const port = app.server.address().port;
  if (crew) await post(port, [{ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' }]);
  const a = await bootTablet({ name: 'A', key: 'k1', clock, port });
  await a.boot();
  return { a, clock, port };
}
const byClass = (a, cls, tag) => findAll(a.main(), (e) => e.className.split(' ').includes(cls) && (!tag || e.tagName === tag));
const press = (el) => { for (const f of el.handlers.click || []) f({ currentTarget: el, target: el }); };
const type = (el, value) => { el.value = value; for (const f of el.handlers.input || []) f({}); };
const button = (a, label) => findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e).includes(label))[0];
const stateOf = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers })).json()).state;

// Остановка с двумя частями (смена причины по ходу простоя): индексы 0 и 1
const twoParts = (b0, b1) => [
  { id: 'p-stop', type: 'stop', downtimeId: 'p', at: at(10), reason: 'avaria', note: 'Заклинил вал' },
  { id: 'p-split', type: 'split', downtimeId: 'p', at: at(20), reason: 'cobble_shears' },
  { id: 'p-start', type: 'start', downtimeId: 'p', at: at(30), action: 'Заменили вал' },
  ...(b0 === undefined ? [] : [{ id: 'p-b0', type: 'fix', downtimeId: 'p', index: 0, at: at(31), billet: b0 }]),
  ...(b1 === undefined ? [] : [{ id: 'p-b1', type: 'fix', downtimeId: 'p', index: 1, at: at(32), billet: b1 }]),
];

test('брак простоя из нескольких частей — сумма частей, как в Excel (0,5 + 2,5 = 3)', async (t) => {
  const { a, port } = await fixture(t);
  const sent = twoParts(0.5, 2.5);
  const r = await post(port, sent);
  assert.deepEqual(r.rejected, []);
  await a.h.loadState();
  const list = a.h.shiftDowntimes(a.h.buildView());
  assert.equal(list.length, 1);
  assert.equal(list[0].segs.length, 2, 'две части одного простоя');
  assert.equal(list[0].billet, 3);
  // Итог сдачи смены — плитка «Брак за смену» — тот же
  a.h.go('closeConfirm');
  const tile = byClass(a, 'ps-kpi').find((k) => k.attrs['data-kind'] === 'billet');
  assert.equal(text(findAll(tile, (e) => e.className === 'ps-kpi__value')[0]), '3 тн');
  // Excel за те же сутки
  const events = [{ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' }, ...sent];
  const excel = build(events, { fromDay: '2026-10-05', toDay: '2026-10-05', nowMs: start + 160 * 60000 });
  assert.equal(summaryCell(excel.wb.sheets[0], 'Брак заготовки всего, тн').value, list[0].billet);
});

test('брак частей: ноль в первой части, брак только в последней, брак нигде и нули везде', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, twoParts(0, 2.5)); await a.h.loadState();
  assert.equal(a.h.shiftDowntimes(a.h.buildView())[0].billet, 2.5);
  const b = await fixture(t);
  await post(b.port, twoParts(undefined, 1.25)); await b.a.h.loadState();
  assert.equal(b.a.h.shiftDowntimes(b.a.h.buildView())[0].billet, 1.25);
  const c = await fixture(t);
  await post(c.port, twoParts(undefined, undefined)); await c.a.h.loadState();
  assert.equal(c.a.h.shiftDowntimes(c.a.h.buildView())[0].billet, null, 'не указан нигде — «не указан»');
  const d = await fixture(t);
  await post(d.port, twoParts(0, 0)); await d.a.h.loadState();
  assert.equal(d.a.h.shiftDowntimes(d.a.h.buildView())[0].billet, 0, 'указан 0 — это значение, а не пропуск');
});

test('брак частей: часть, закончившаяся в другой смене, и открытая часть в сумму смены не входят', async (t) => {
  const { a } = await fixture(t);
  const shift = { startMs: start, endMs: start + 12 * 3600000 };
  const seg = (endMs, billet, extra = {}) => ({ startMs: endMs - 600000, endMs, billet, ...extra });
  assert.equal(a.h.shiftBillet([seg(start + 3600000, 1), seg(start + 7200000, 2)], shift), 3);
  assert.equal(a.h.shiftBillet([seg(start + 3600000, 1), seg(shift.endMs + 1, 5)], shift), 1, 'следующая смена — её брак');
  assert.equal(a.h.shiftBillet([seg(start - 1, 5), seg(start + 60000, 1)], shift), 1, 'прошлая смена — её брак');
  assert.equal(a.h.shiftBillet([seg(null, 5, { open: true })], shift), null);
  assert.equal(a.h.shiftBillet([seg(shift.endMs, 0.1), seg(start + 1000, 0.2)], shift), 0.3, 'без хвостов двоичной дроби');
});

test('длительности: в тексте «N ч N мин», в плитках «N ч N м», нулевые части опускаются', async (t) => {
  const { a } = await fixture(t);
  const values = [0, 1, 46, 60, 120, 125, 720, 2748];
  assert.deepEqual(values.map((m) => a.h.fmtDurMin(m)), ['0 мин', '1 мин', '46 мин', '1 ч', '2 ч', '2 ч 5 мин', '12 ч', '45 ч 48 мин']);
  assert.deepEqual(values.map((m) => a.h.fmtHM(m)), ['0 м', '1 м', '46 м', '1 ч', '2 ч', '2 ч 5 м', '12 ч', '45 ч 48 м']);
  assert.equal(a.h.fmtDurLong(1440 + 600 + 21), '1 сут 10 ч 21 мин');
  assert.equal(a.h.fmtDurLong(2880), '2 сут');
  assert.equal(a.h.fmtLen(720), '12 ч');
  assert.equal(a.h.fmtLen(30), '30 мин', 'смена короче часа — без «0 ч»');
});

test('список простоев — «N ч N мин»; плитки — «N ч N м»', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'long', type: 'manual', at: at(150), from: at(5), to: at(138), reason: 'avaria', note: 'Заклинил вал', action: 'Заменили', billet: 0 }]);
  await a.h.loadState();
  a.h.go('shift');
  assert.equal(text(byClass(a, 'ps-row__dur')[0]), '2 ч 13 мин');
  const tiles = byClass(a, 'ps-kpi__value').map(text);
  assert.ok(tiles.includes('2 ч 13 м'), tiles.join(' | '));
  assert.ok(tiles.every((x) => !/мин/.test(x)), 'в плитках сокращение «м»');
});

test('сдача смены при работающем стане: поле записки есть, текст уходит в shift_close.action', async (t) => {
  const { a } = await fixture(t);
  assert.equal(a.h.buildView().open, null);
  a.h.go('closeConfirm');
  const ta = findAll(a.main(), (e) => e.attrs.id === 'close-action')[0];
  assert.ok(ta, 'поле «Что сделали по ремонту за смену и что осталось?» при работающем стане');
  assert.match(text(a.main()), /Что сделали по ремонту за смену и что осталось\?/);
  assert.equal(a.h.shiftCloseEvents(a.h.buildView(), true)[0].fields.action, undefined, 'пустое не отправляется');
  type(ta, 'Заменили ножи на третьей клети, осталось отрегулировать зазор');
  const ev = a.h.shiftCloseEvents(a.h.buildView(), true)[0];
  assert.equal(ev.type, 'shift_close');
  assert.equal(ev.fields.action, 'Заменили ножи на третьей клети, осталось отрегулировать зазор');
  assert.match(ev.fields.note, /Стан работает/);
});

test('записка при работающем стане доходит до следующего мастера при приёме смены', async (t) => {
  const { a, clock, port } = await fixture(t);
  a.h.go('closeConfirm');
  type(findAll(a.main(), (e) => e.attrs.id === 'close-action')[0], 'Заменили ножи, осталось отрегулировать зазор');
  press(button(a, 'Сдать смену')); await a.pump();
  assert.equal(a.h.ui.screen, 'closed');
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0, 'сервер принял shift_close с action');
  // Сервер отдаёт записки при работающем стане
  const state = await stateOf(port);
  assert.equal(state.running, true);
  assert.equal(state.handovers.length, 1);
  assert.equal(state.handovers[0].action, 'Заменили ножи, осталось отрегулировать зазор');
  assert.equal(state.handovers[0].personName, 'Иванов Иван Иванович');
  // Другой планшет (следующий мастер): экран приёма смены показывает «Передали по ремонту»
  const b = await bootTablet({ name: 'B', key: 'k2', clock, port });
  await b.boot();
  assert.equal(b.h.needCrew(b.h.buildView()), true);
  b.h.ui.crewId = '1';
  const screen = b.screen();
  assert.match(screen, /Передали по ремонту/);
  assert.match(screen, /Заменили ножи, осталось отрегулировать зазор/);
});

test('записка при работающем стане: сразу видна на этом же планшете, простоев не добавляет', async (t) => {
  const { a } = await fixture(t);
  a.h.send('shift_close', { action: 'Ждём подшипник', note: 'Стан работает.' });
  const v = a.h.buildView();
  assert.equal(v.open, null);
  assert.equal(v.handovers.length, 1);
  assert.equal(v.handovers[0].action, 'Ждём подшипник');
  assert.equal(a.h.shiftDowntimes(v).length, 0);
});

test('записки сдачи: последние три за 36 часов; пустые и чужие типы события не считаются', () => {
  const now = start + 100 * 3600000;
  const close = (id, hoursAgo, action) => ({ id, type: 'shift_close', at: new Date(now - hoursAgo * 3600000).toISOString(), crewId: '1', ...(action === undefined ? {} : { action }) });
  const list = recentHandovers([
    close('old', 40, 'слишком давно'), close('a', 30, 'первая'), close('empty', 20, '   '), close('none', 15),
    close('b', 12, 'вторая'), close('c', 6, 'третья'), close('d', 1, 'четвёртая'),
    { id: 'x', type: 'start', at: new Date(now - 3600000).toISOString(), action: 'не сдача' },
  ], now);
  assert.deepEqual(list.map((x) => x.action), ['первая', 'вторая', 'третья', 'четвёртая'].slice(-3));
  assert.deepEqual(recentHandovers([], now), []);
});

test('сервер: при простое записки — в open.handovers, верхний список пуст; при работе — верхний список', async (t) => {
  const { port } = await fixture(t);
  await post(port, [{ id: 'c0', type: 'shift_close', at: at(120), crewId: '1', action: 'Ждём подшипник' }]);
  const running = await stateOf(port);
  assert.deepEqual(running.handovers.map((x) => x.action), ['Ждём подшипник']);
  await post(port, [{ id: 's0', type: 'stop', at: at(150) }]);
  const stopped = await stateOf(port);
  assert.deepEqual(stopped.handovers, []);
  assert.deepEqual(stopped.open.handovers, []);
});

test('чек-лист: открытый простой без причины — не «У каждого простоя есть причина»; кнопка «Выбрать» открывает выбор причины', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'm1', type: 'manual', at: at(100), from: at(10), to: at(25), reason: 'avaria', note: 'Заклинил вал', action: 'Заменили', billet: 0 },
    { id: 'o-stop', type: 'stop', downtimeId: 'open1', at: at(140) }]);
  await a.h.loadState();
  a.h.go('closeConfirm');
  const items = byClass(a, 'ps-check', 'LI');
  assert.equal(items[1].attrs['data-status'], 'todo');
  assert.match(text(items[1]), /1 простой без причины/);
  assert.doesNotMatch(text(items[1]), /У каждого простоя есть причина/);
  press(findAll(items[1], (e) => e.tagName === 'BUTTON')[0]);
  assert.equal(a.h.ui.screen, 'reason');
  assert.equal(a.h.ui.wz.mode, 'current');
  assert.equal(a.h.ui.wz.downtimeId, 'open1');
  // Причина выбрана — пункт зелёный
  await post(port, [{ id: 'o-reason', type: 'reason', downtimeId: 'open1', at: at(150), reason: 'avaria' }]);
  await a.h.loadState();
  a.h.go('closeConfirm');
  const done = byClass(a, 'ps-check', 'LI')[1];
  assert.equal(done.attrs['data-status'], 'done');
  assert.match(text(done), /У каждого простоя есть причина/);
});

test('чек-лист: закрытый и открытый без причины считаются вместе', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'm3', type: 'manual', at: at(100), from: at(80), to: at(90) }, { id: 'o-stop', type: 'stop', downtimeId: 'open1', at: at(140) }]);
  await a.h.loadState();
  a.h.go('closeConfirm');
  assert.match(text(byClass(a, 'ps-check', 'LI')[1]), /2 простоя без причины/);
});
