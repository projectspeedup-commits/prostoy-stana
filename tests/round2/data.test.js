import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../app/server/index.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';
import { eventBatch, reusableRestart, rejectionGroups } from '../../app/public/queue.js';

const base = Date.parse('2026-10-05T05:00:00Z'); // 08:00 МСК
const at = (minutes) => new Date(base + minutes * 60000).toISOString();
async function fixture(t, minutes = 160) {
  const clock = { t: base + minutes * 60000 };
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(clock.t) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const port = app.server.address().port;
  const api = async (route, body) => (await fetch(`http://127.0.0.1:${port}${route}`, {
    headers: { 'X-Device-Key': 'k2' }, ...(body ? { method: 'POST', body: JSON.stringify({ events: body }) } : {}),
  })).json();
  const save = (...events) => api('/api/events', events);
  await save({ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' });
  const tablet = await bootTablet({ name: 'A', key: 'k1', clock, port });
  await tablet.boot();
  return { app, port, clock, api, save, tablet };
}
const event = (id, type, minute, fields = {}) => ({ id, type, at: at(minute), ...fields });

test('Раунд 2.1: неизвестные отрезки, закрытый split и null не получают saved', async (t) => {
  const s = await fixture(t);
  for (const type of ['reason', 'split', 'fix']) {
    assert.equal((await s.save(event(type, type, 10, { downtimeId: 'absent', index: 0, reason: 'avaria' }))).rejected[0].error, 'not_found');
  }
  await s.save(event('stop', 'stop', 20));
  for (const type of ['reason', 'split', 'fix']) {
    assert.equal((await s.save(event(type + '-index', type, 21, { downtimeId: 'stop', index: 99 }))).rejected[0].error, 'not_found');
  }
  for (const field of ['reason', 'note', 'action', 'billet', 'node']) {
    assert.equal((await s.save(event('null-' + field, 'fix', 22, { downtimeId: 'stop', index: 0, [field]: null }))).rejected[0].error, 'bad_request');
  }
  await s.save(event('start', 'start', 30, { downtimeId: 'stop' }));
  for (const minute of [25, 31]) assert.equal((await s.save(event('closed' + minute, 'split', minute, { downtimeId: 'stop' }))).rejected[0].error, 'not_open');
  await s.save(event('first', 'fix', 40, { downtimeId: 'stop', index: 0, reason: 'avaria', billet: 1 }));
  const r = await s.save(event('empty-only', 'fix', 41, { downtimeId: 'stop', index: 0, onlyEmpty: true, reason: 'perevalka', billet: 7, action: 'Заменили вал' }));
  const seg = r.state.segments[0];
  assert.equal(seg.reason, 'avaria'); assert.equal(seg.billet, 1); assert.equal(seg.action, 'Заменили вал');
});

test('Раунд 2.1: ответы отклонённого stop ждут, карточка одна, исправление выпускает всю цепочку', async (t) => {
  const { tablet: a, save, clock, port } = await fixture(t);
  a.net.offline = true;
  a.h.sendBatch([
    { type: 'stop', fields: { downtimeId: 'offline', at: at(120) } },
    { type: 'reason', fields: { downtimeId: 'offline', reason: 'avaria', note: 'Заклинил вал', at: at(120) } },
    { type: 'start', fields: { downtimeId: 'offline', action: 'Заменили вал', at: at(150) } },
    { type: 'fix', fields: { downtimeId: 'offline', index: 0, billet: 2.5, at: at(150) } },
  ]);
  await a.pump();
  await save(event('peer', 'manual', 140, { from: at(130), to: at(140), reason: 'burezhka' }));
  a.net.offline = false; await a.pump();
  assert.deepEqual(a.h.records.map((r) => r.status), ['rejected', 'pending', 'pending', 'pending']);
  assert.equal(a.h.queue.length, 3);
  const info = a.rejectsBox();
  assert.equal(info.cards.length, 1);
  for (const value of ['10:00', '10:30', 'Заклинил вал', 'Заменили вал', '2,5 тн']) assert.ok(info.cards[0].includes(value), value);
  for (let i = 0; i < 2; i++) {
    const bad = a.h.records.findLast((r) => r.status === 'rejected');
    a.h.ui.repair = { id: bad.event.id, event: { ...bad.event } };
    a.h.submitRepair(); await a.pump();
    assert.equal(a.rejectsBox().cards.length, 1);
    assert.equal(a.h.records.find((r) => r.event.id === bad.event.id).status, 'replaced');
  }
  const restored = await bootTablet({ name: 'reload', key: 'k1', port, clock, storage: a.storage });
  await restored.boot();
  const bad = restored.h.records.findLast((r) => r.status === 'rejected');
  restored.h.ui.repair = { id: bad.event.id, event: { ...bad.event, at: at(141) } };
  restored.h.submitRepair(); await restored.pump();
  assert.equal(restored.h.queue.length, 0);
  assert.equal(restored.rejectsBox().cards.length, 0);
  const seg = restored.h.serverState.segments.find((s) => s.downtimeId === 'offline');
  assert.equal(seg.startMs, Date.parse(at(141))); assert.equal(seg.endMs, Date.parse(at(150)));
  assert.equal(seg.reason, 'avaria'); assert.equal(seg.note, 'Заклинил вал'); assert.equal(seg.action, 'Заменили вал'); assert.equal(seg.billet, 2.5);
});

test('Раунд 2.1–2: пуск отдельным пакетом, чужие поля сохраняются, перенос заполняет пустое', async (t) => {
  const { tablet: a, save } = await fixture(t);
  await save(event('open', 'stop', 120, { reason: 'avaria' }));
  await a.h.loadState();
  a.h.ui.rw = { ...a.h.newRestart(a.h.buildView()), startMs: Date.parse(at(150)), reason: 'perevalka', reasonChanged: true, billet: '7' };
  await save(event('peer-start', 'start', 140, { downtimeId: 'open' }), event('peer-billet', 'fix', 140, { downtimeId: 'open', index: 0, billet: 1 }));
  a.h.finishRestart('Наши работы'); await a.pump();
  assert.equal(a.h.records.find((r) => r.event.type === 'start').error, 'not_open');
  assert.ok(a.h.queue.every((e) => ['reason', 'fix'].includes(e.type)));
  assert.equal(a.h.serverState.segments[0].reason, 'avaria');
  assert.equal(a.h.serverState.segments[0].billet, 1);
  const g = rejectionGroups(a.h.records)[0];
  assert.match(a.rejectsBox().cards[0], /Стан уже пущен в 10:20 с другого устройства/);
  const button = a.h.transferButton(g);
  a.click(button, 'Добавить мою причину'); await a.pump();
  assert.equal(a.h.serverState.segments[0].reason, 'avaria');
  assert.equal(a.h.serverState.segments[0].billet, 1);
  assert.equal(a.h.serverState.segments[0].action, 'Наши работы');
  assert.equal(a.h.queue.length, 0); assert.equal(a.rejectsBox().cards.length, 0);
  assert.equal(eventBatch([{ type: 'reason' }, { type: 'start' }, { type: 'fix' }]).length, 1);
  assert.equal(eventBatch([{ type: 'start' }, { type: 'fix' }]).length, 1);
});

test('Раунд 2.3–4: черновик моложе 10 минут и своей смены; пустой action не стирает', async (t) => {
  const { tablet: a, save, clock } = await fixture(t);
  await save(event('open', 'stop', 120, { reason: 'perevalka' }), event('work', 'fix', 130, { downtimeId: 'open', index: 0, action: 'Уже заменили вал' }));
  await a.h.loadState();
  const view = a.h.buildView(), draft = a.h.newRestart(view);
  assert.equal(reusableRestart(draft, view, clock.t + 599999), true);
  assert.equal(reusableRestart(draft, view, clock.t + 600000), false);
  assert.equal(reusableRestart(draft, { ...view, shift: { startMs: 99 } }, clock.t), false);
  a.h.ui.rw = draft; a.h.renderRestartAction(a.main(), view);
  assert.equal(findAll(a.main(), (e) => e.tagName === 'TEXTAREA')[0].value, 'Уже заменили вал');
  a.h.finishRestart(''); await a.pump();
  assert.equal(a.h.serverState.segments[0].action, 'Уже заменили вал');
  assert.equal(Object.hasOwn(a.h.records.find((r) => r.event.type === 'start').event, 'action'), false);
  a.h.ui.rw = draft; a.h.ui.wz = {}; a.h.ui.fw = {};
  a.h.acceptShift('1', 'p1', 'Иванов Иван Иванович');
  assert.equal(a.h.ui.rw, null); assert.equal(a.h.ui.wz, null); assert.equal(a.h.ui.fw, null);
  await a.pump();
});

for (const [count, sec, down] of [[8, 36, 5], [6, 26, 3]]) test(`Раунд 2.5: ${count}×${sec} с — одинаковые итоги и экраны`, async (t) => {
  const { tablet: a, save, api } = await fixture(t, 22);
  await save(...Array.from({ length: count }, (_, i) => event('short' + i, 'manual', 22, {
    from: at(i * 2 + 1), to: new Date(base + (i * 2 + 1) * 60000 + sec * 1000).toISOString(), reason: 'burezhka', billet: 0, action: 'Исправили',
  })));
  await a.h.loadState(); const view = a.h.buildView();
  const stats = (await api('/api/stats?period=shift')).stats;
  assert.equal(a.h.shiftSummary(view).downMinutes, down);
  assert.equal(a.h.serverState.summary.shift.downMinutes, down);
  assert.equal(a.h.serverState.summary.day, undefined);
  assert.equal(stats.downMin, down); assert.equal(stats.workMin, 22 - down); assert.equal(stats.stops, count);
  a.h.renderRun(a.main(), view); assert.match(text(a.main()), new RegExp(`${count} простоев · ${down} мин`));
  a.h.renderShift(a.main(), view); assert.match(text(a.main()), new RegExp(`Простой ${down} мин`));
  a.h.doCloseShift(true); await a.pump();
  assert.equal(a.h.ui.closedInfo.downMin, down); assert.equal(a.h.ui.closedInfo.workMin, 22 - down);
});

test('Раунд 2.6–7: брак предыдущей зоны, продолженный простой и будущий пуск', async (t) => {
  const { tablet: a, save, api } = await fixture(t, 8);
  await save(event('old-open', 'stop', -10, { reason: 'avaria' }), event('planned', 'split', 2, { downtimeId: 'old-open', reason: 'perevalka' }));
  await a.h.loadState(); const view = a.h.buildView();
  a.h.ui.rw = { ...a.h.newRestart(view), billet: '0' };
  assert.equal(a.h.restartNeedsBillet(a.h.ui.rw, view), true);
  a.h.finishRestart('Исправили'); await a.pump();
  assert.equal(a.h.serverState.segments.find((s) => s.index === 0).billet, 0);
  assert.equal(a.h.serverState.segments.find((s) => s.index === 1).billet, null);
  assert.equal(a.h.manualError(view, { from: base + 1, to: base + 60000, reason: 'avaria', note: 'Авария', action: '' }).includes('уже есть'), true);
  assert.equal(a.h.serverState.summary.shift.stops, 1);
  const stats = (await api('/api/stats?period=shift')).stats;
  assert.equal(stats.stops, 1); assert.equal(stats.downMin, a.h.serverState.summary.shift.downMinutes);
  await save(event('future-stop', 'stop', 8), event('future-start', 'start', 10, { downtimeId: 'future-stop' }));
  await a.h.loadState();
  assert.equal(a.h.shiftSummary(a.h.buildView()).downMinutes, 8);
  assert.equal((await api('/api/stats?period=shift')).stats.downMin, 8);
});

test('Раунд 2.1: убрать stop можно только вместе с ответами после подтверждения', async (t) => {
  const { tablet: a } = await fixture(t);
  a.net.offline = true;
  a.h.sendBatch([{ type: 'stop', fields: { downtimeId: 'bad' } }, { type: 'reason', fields: { downtimeId: 'bad', reason: 'avaria', note: 'Наш текст' } }]);
  await a.pump();
  const stop = a.h.records[0]; stop.status = 'rejected';
  a.h.queue = a.h.queue.filter((e) => e.type !== 'stop');
  a.h.dismissRejected([stop.event.id]);
  assert.match(text(a.main()), /Убрать остановку вместе с причиной, пуском и браком/);
  assert.equal(a.h.queue.length, 1);
  a.click(a.main(), 'Убрать вместе');
  assert.equal(a.h.queue.length, 0);
  assert.ok(a.h.records.every((r) => r.status === 'dismissed'));
  assert.equal(JSON.parse(a.storage.get('stan.queue')).length, 0);
});

test('Раунд 2.6: ручной простой требует брак; при закрытии есть переход к незаполненному', async (t) => {
  const { tablet: a, save } = await fixture(t);
  const mw = { from: base + 60000, to: base + 120000, reason: 'avaria', note: 'Заклинило', action: 'Заменили' };
  assert.match(a.h.manualError(a.h.buildView(), mw), /от 0 до 1000 тн/);
  mw.billet = '0'; assert.equal(a.h.manualError(a.h.buildView(), mw), '');
  await save(event('manual', 'manual', 150, { ...mw, from: at(1), to: at(2), billet: undefined }));
  await a.h.loadState();
  const gaps = a.h.handoverGaps(a.h.buildView());
  assert.equal(gaps.length, 1); assert.deepEqual(gaps[0].missing, ['брак']);
  a.h.go('closeConfirm');
  assert.match(text(a.main()), /Без брака: 1/);
  assert.ok(findAll(a.main(), (e) => e.tagName === 'BUTTON').some((b) => text(b).includes('дополнить: брак')));
});
