import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { mergeRecords, mergeQueue, tapGuard, settleRecords } from '../../app/public/queue.js';
import { bootTablet, text } from '../helpers/tablet.js';

const start = Date.parse('2026-10-05T05:00:00Z');
const at = (mins) => new Date(start + mins * 60000).toISOString();
async function fixture(t, minutes = 160) {
  const clock = { t: start + minutes * 60000 };
  const app = await round2Server(t, clock, start);
  const port = app.server.address().port;
  const save = async (...events) => (await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'X-Device-Key': 'k2', Connection: 'close' }, body: JSON.stringify({ events }) })).json();
  await save({ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' });
  const a = await bootTablet({ name: 'A', key: 'k1', clock, port }); await a.boot();
  return { clock, app, port, save, a };
}
const row = (id, status, seq = 0) => ({ event: { id, type: 'fix', at: at(120), seq }, status });

test('Раунд 2.8: защита ровно 400 мс после перехода, обновление того же экрана не мешает', () => {
  let now = 0; const guard = tapGuard(() => now);
  guard.screen('crew'); now = 400; assert.equal(guard.blocked(), false);
  guard.screen('run'); now += 150; assert.equal(guard.blocked(), true);
  guard.screen('run'); now += 250; assert.equal(guard.blocked(), false);
  guard.screen('reason'); assert.equal(guard.blocked(), true);
});

test('Раунд 2.8: второй тап через 150 мс перехватывается настоящим обработчиком страницы', async (t) => {
  const { a, app } = await fixture(t);
  a.h.go('crew');
  await new Promise((r) => setTimeout(r, 150));
  let blocked = false;
  const click = { target: {}, preventDefault() { blocked = true; }, stopImmediatePropagation() {} };
  for (const listener of a.document.handlers.click) listener(click);
  assert.equal(blocked, true);
  assert.equal(app.db.prepare("SELECT count(*) n FROM events WHERE type='stop' AND id='double-tap'").get().n, 0);
});

test('Раунд 2.9: окончательные статусы побеждают, очередь объединяется по seq', () => {
  for (const status of ['saved', 'adopted', 'replaced', 'dismissed']) {
    for (const lists of [[row('x', 'pending'), row('x', status)], [row('x', status), row('x', 'rejected')]]) {
      assert.equal(mergeRecords([lists[0]], [lists[1]])[0].status, status);
    }
  }
  const records = [row('one', 'pending', 1), row('two', 'pending', 2), row('gone', 'dismissed', 3)];
  assert.deepEqual(mergeQueue(records, [records[1].event, records[2].event], [records[0].event]).map((e) => e.id), ['one', 'two']);
});

test('Раунд 2.9: настоящие два клиента сохраняют объединение и не возвращают удалённое', async (t) => {
  const { a, clock, port } = await fixture(t);
  const b = await bootTablet({ name: 'B', key: 'k1', clock, port, storage: a.storage }); await b.boot();
  a.net.offline = b.net.offline = true;
  a.h.send('shift_open', { at: at(121), crewId: '1' }); await a.pump();
  b.h.send('shift_close', { at: at(122) }); await b.pump();
  a.h.persistClient(); b.h.persistClient();
  assert.equal(a.h.queue.length, 2); assert.equal(b.h.queue.length, 2);
  const bad = row('bad', 'rejected', 3);
  a.h.records.push(bad); a.h.persistClient();
  b.h.mergeStored(); assert.equal(b.h.records.find((r) => r.event.id === 'bad').status, 'rejected');
  a.h.dismissRejected(['bad']);
  b.h.ui.screen = 'contact'; b.h.persistClient();
  assert.equal(b.h.records.find((r) => r.event.id === 'bad').status, 'dismissed');
  assert.equal(a.rejectsBox().cards.length, 0); assert.equal(b.rejectsBox().cards.length, 0);
  // Разные локальные экраны не запускают вечную взаимную перезапись черновика.
  a.h.ui.screen = 'shift'; b.h.ui.screen = 'contact'; b.h.persistClient();
  const before = a.storage.get('stan.session.v1');
  for (const tablet of [a, b, a, b]) for (const fn of tablet.window.handlers.storage) fn({ key: 'stan.session.v1' });
  await a.pump(); await b.pump();
  assert.equal(a.storage.get('stan.session.v1'), before);
});

test('Раунд 2.10: отправка и новый снимок сбрасывают показатели, старый ответ не возвращается', async (t) => {
  const { a, save } = await fixture(t);
  a.h.loadStats('shift');
  for (let i = 0; i < 50 && a.h.ui.stats.shift?.loading; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(a.h.ui.stats.shift?.data);
  a.net.offline = true; a.h.send('stop', { downtimeId: 'local' }); await a.pump();
  assert.equal(a.h.ui.stats.shift, undefined);
  a.h.ui.stats.shift = { data: { downMin: 999 }, at: a.h.nowMs() };
  a.h.acceptState(a.h.serverState, new Date(a.h.nowMs()).toISOString());
  assert.equal(a.h.ui.stats.shift, undefined);
});

test('Раунд 2.11: таймер пересменки обновляет состояние и экран без очередного опроса', async (t) => {
  const { a, clock } = await fixture(t, 719 + 59 / 60);
  a.h.armShiftTimer(); const timer = a.timers.at(-1);
  assert.ok(timer.delay >= 1000 && timer.delay <= 1010);
  clock.t = start + 720 * 60000 + 6;
  timer.fn();
  for (let i = 0; i < 50 && a.h.serverState.shift.shiftNo !== 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(a.h.serverState.shift.shiftNo, 2);
  assert.match(a.screen(), /Выберите вашу смену/);
  assert.ok(!a.screen().includes('До конца 0 мин'));
});

test('Раунд 2.12: принятое чужое состояние с причиной закрывает мастер причины', async (t) => {
  const { a, save } = await fixture(t);
  await save({ id: 'peer-stop', type: 'stop', at: at(150), reason: 'avaria', note: 'Чужая причина' });
  a.h.renderRun(a.main(), a.h.buildView()); a.click(a.main(), 'Стан встал'); await a.pump();
  assert.equal(a.h.ui.wz, null); assert.equal(a.h.ui.screen, 'auto');
  assert.equal(a.h.serverState.open.segments[0].reason, 'avaria');
  assert.ok(a.h.toasts.some((s) => s.includes('Причина уже указана с другого устройства:')));
  assert.match(a.screen(), /Изменить/);
});

test('Раунд 2.13: закрытый простой сохраняет отклонённые ответы для переноса или удаления', () => {
  for (const type of ['start', 'reason', 'split', 'fix']) {
    const r = { ...row(type, 'rejected'), event: { ...row(type, 'rejected').event, type, downtimeId: 'closed' } };
    settleRecords([r], { segments: [{ downtimeId: 'closed', index: 0, startMs: 10, endMs: 20, open: false }] });
    assert.equal(r.status, 'rejected'); assert.equal(r.conflict.endMs, 20);
  }
});

test('Раунд 2.13–14: ручной простой прошлой смены исправляется; массовое удаление в два нажатия', async (t) => {
  const { a } = await fixture(t, 730);
  const rejected = { event: { id: 'old-manual', type: 'manual', at: at(719), from: at(600), to: at(605), reason: 'perevalka', note: 'Перевалка' }, status: 'rejected' };
  a.h.records.push(rejected);
  a.h.ui.repair = { id: rejected.event.id, event: { ...rejected.event } }; a.h.submitRepair(); await a.pump();
  assert.equal(a.h.records.findLast((r) => r.event.type === 'manual').status, 'saved');
  a.h.records.push(row('bad1', 'rejected'), row('bad2', 'rejected')); a.h.renderRejects();
  a.click(a.els.get('rejects'), 'Убрать все отклонённые записи (2)');
  assert.equal(a.rejectsBox().cards.length, 2);
  assert.match(text(a.els.get('rejects')), /Точно убрать 2 записей/);
  a.click(a.els.get('rejects'), 'Точно убрать 2 записей');
  assert.equal(a.rejectsBox().cards.length, 0);
});

test('Раунд 2.18: форма ФИО принимает расширенную кириллицу и объясняет неверный ввод', async (t) => {
  const { a } = await fixture(t);
  a.h.ui.fio = { crewId: '1', personId: 'p1', last: 'Әлімқұлов', first: 'Ғалымжан', middle: 'Нұрұлы' };
  a.h.renderFio(a.main(), a.h.buildView());
  a.click(a.main(), 'Принять смену'); await a.pump();
  assert.equal(a.h.serverState.crew.personName, 'Әлімқұлов Ғалымжан Нұрұлы');
  a.h.ui.fio = { crewId:'1', last:'Иванов', first:'И.', middle:'Иванович' };
  a.h.renderFio(a.main(), a.h.buildView());
  assert.match(text(a.main()), /без точек и цифр/);
});
