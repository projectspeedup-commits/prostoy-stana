import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';
import { dayCells } from '../../app/core/zones.js';

// Поток «без причины»: стоп и пуск одним нажатием, время задним числом, разбор смены с правкой времени и причины.
// Проверяется поведение (события, экраны, ответы сервера), а не цвета.
const start = Date.parse('2026-10-05T05:00:00Z'); // 08:00 МСК
const at = (mins) => new Date(start + mins * 60000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'X-Device-Key': 'k2', Connection: 'close' };
const post = (port, events) => fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers, body: JSON.stringify({ events }) });
async function fixture(t, minutes = 160) {
  const clock = { t: start + minutes * 60000 }; // 10:40 МСК
  const app = await round2Server(t, clock, start);
  const port = app.server.address().port;
  await post(port, [{ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' }]);
  const a = await bootTablet({ name: 'A', key: 'k1', clock, port });
  await a.boot();
  return { a, clock, port };
}
const byClass = (a, cls, tag) => findAll(a.main(), (e) => e.className.split(' ').includes(cls) && (!tag || e.tagName === tag));
const question = (a) => text(findAll(a.main(), (e) => e.className === 'q')[0]);
const buttons = (a) => findAll(a.main(), (e) => e.tagName === 'BUTTON').map(text);
const tap = (a, label) => { a.click(a.main(), label); return a.screen(); };
const press = (el) => { for (const f of el.handlers.click || []) f({ currentTarget: el, target: el }); };
const type = (el, value) => { el.value = value; for (const f of el.handlers.input || []) f({}); };
const field = (a, label) => findAll(a.main(), (e) => e.tagName === 'INPUT' && e.attrs['aria-label'] === label)[0];
const local = (mins) => new Date(start + mins * 60000 + 3 * 3600000).toISOString().slice(0, 16); // «ГГГГ-ММ-ДДTЧЧ:ММ» по Москве
async function until(cond, tries = 100) { for (let i = 0; i < tries && !cond(); i++) await wait(20); }

test('пульт: «Стан встал» и «Стан пошёл» — по одному нажатию, без причины и вопросов', async (t) => {
  const { a, clock } = await fixture(t);
  a.screen();
  a.click(a.main(), 'Стан встал');
  assert.equal(a.h.ui.screen, 'auto'); assert.equal(a.h.ui.wz, null);
  const stop = a.h.queue.find((e) => e.type === 'stop');
  assert.ok(stop); assert.equal(stop.reason, undefined);
  await a.pump(); a.screen();
  assert.equal(byClass(a, 'ps-reason', 'BUTTON').length, 0, 'плиток причины нет');
  assert.match(text(a.main()), /Причину укажете в разборе смены/);
  clock.t += 5 * 60000;
  a.click(a.main(), 'Стан пошёл');
  assert.equal(a.h.ui.screen, 'auto');
  const startEvent = a.h.queue.find((e) => e.type === 'start');
  assert.ok(startEvent);
  assert.deepEqual(['reason', 'note', 'action', 'billet'].filter((k) => k in startEvent), [], 'у пуска нет ни причины, ни «что сделали», ни брака');
  assert.equal(a.h.toasts.at(-1), 'Записано. Причину и что сделали — в разборе смены');
  await a.pump();
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0);
  assert.equal(a.h.serverState.running, true);
  assert.equal(a.h.serverState.segments[0].reason, null);
  assert.equal(a.h.records.filter((r) => ['reason', 'fix'].includes(r.event.type)).length, 0, 'вопросов и дополнительных событий не было');
  assert.equal(a.h.noReasonList(a.h.buildView()).length, 1, 'простой ждёт разбора');
});

test('сдача смены: «Нет, уже работает» — время пуска и сразу к сдаче, без причины и «что сделали»', async (t) => {
  const { a } = await fixture(t);
  a.h.send('stop', { downtimeId: 'f1', at: at(120) }); await a.pump(); await a.h.loadState();
  a.h.go('closeCheck'); a.screen();
  a.click(a.main(), 'Нет, уже работает');
  assert.equal(a.h.ui.screen, 'restartTime'); a.screen();
  assert.equal(question(a), 'Когда стан пошёл?');
  // Раньше начала простоя — не сохраняется
  a.h.ui.rw.startMs = start + 119 * 60000;
  a.click(a.main(), 'Сохранить пуск');
  assert.equal(a.h.queue.some((e) => e.type === 'start'), false); assert.equal(a.h.ui.screen, 'restartTime');
  a.h.ui.rw.startMs = start + 150 * 60000; delete a.h.ui.rw.timeValue;
  a.click(a.main(), 'Сохранить пуск');
  assert.equal(a.h.ui.screen, 'closeConfirm'); assert.equal(a.h.ui.rw, null);
  const ev = a.h.queue.find((e) => e.type === 'start');
  assert.equal(ev.at, at(150)); assert.deepEqual(['reason', 'note', 'action', 'billet'].filter((k) => k in ev), []);
  await a.pump();
  const seg = a.h.serverState.segments.find((s) => s.downtimeId === 'f1');
  assert.equal(seg.endMs, start + 150 * 60000); assert.equal(seg.reason, null);
});

test('сдача смены: «Нет, стан стоит» — время → «Проверьте» → остановка без причины; причину можно добавить кнопкой', async (t) => {
  const { a } = await fixture(t);
  a.h.go('closeCheck'); a.screen();
  a.click(a.main(), 'Нет, стан стоит');
  assert.equal(a.h.ui.screen, 'forgotStop'); assert.equal(a.h.ui.fw.step, 1);
  a.h.ui.fw.atMs = start + 130 * 60000; delete a.h.ui.fw.timeValue; a.screen();
  tap(a, 'Далее');
  assert.equal(question(a), 'Проверьте');
  assert.ok(buttons(a).includes('Указать причину сейчас'));
  tap(a, 'Сохранить');
  assert.equal(a.h.ui.screen, 'closeConfirm');
  assert.deepEqual(a.h.queue.map((e) => e.type), ['stop']); assert.equal(a.h.queue[0].at, at(130));
  await a.pump();
  assert.equal(a.h.serverState.open.segments[0].reason ?? null, null);
  // С причиной на экране проверки уходят остановка и причина
  const { a: b } = await fixture(t);
  b.h.ui.fw = { step: 2, atMs: start + 130 * 60000, group: null, reason: 'avaria', note: 'Заклинило подшипник' };
  b.h.saveForgottenStop();
  assert.deepEqual(b.h.queue.map((e) => e.type), ['stop', 'reason']); assert.equal(b.h.queue[1].reason, 'avaria');
});

test('«Забыли отметить простой»: сохраняется только со временем; «Указать причину сейчас» открывает разбор простоя', async (t) => {
  const { a } = await fixture(t);
  a.h.startManualWizard('shift'); a.screen();
  tap(a, 'Далее'); tap(a, 'Далее');
  assert.equal(a.h.ui.screen, 'manualCheck');
  a.click(a.main(), 'Сохранить простой');
  await until(() => a.h.records.some((r) => r.event.type === 'manual'));
  const manual = a.h.records.find((r) => r.event.type === 'manual')?.event;
  assert.ok(manual);
  assert.deepEqual(Object.keys(manual).filter((k) => ['reason', 'note', 'action', 'billet'].includes(k)), []);
  assert.equal(a.h.ui.screen, 'recorded');
  await a.pump();
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0);
  a.screen();
  assert.match(text(a.main()), /не указана, укажете в разборе/);
  assert.ok(buttons(a).includes('Указать причину сейчас'));
  // Второй простой: сохранить и сразу открыть его разбор
  a.h.startManualWizard('shift', start + 100 * 60000); a.screen();
  tap(a, 'Далее'); tap(a, 'Далее');
  a.click(a.main(), 'Указать причину сейчас');
  await until(() => a.h.records.filter((r) => r.event.type === 'manual').length === 2);
  const second = a.h.records.filter((r) => r.event.type === 'manual')[1].event;
  assert.equal(a.h.ui.screen, 'detail'); assert.equal(a.h.ui.card.downtimeId, second.downtimeId);
  assert.equal(second.from, at(100)); assert.equal(second.to, at(130));
  await a.pump();
  assert.equal(a.h.cardData(a.h.buildView()).d.reason, null);
});

test('«Забыли отметить простой»: начало со шкалы суток подставляется, время проверяется', async (t) => {
  const { a } = await fixture(t);
  a.h.startManualWizard('scale', start + 60 * 60000); a.screen();
  assert.equal(a.h.ui.mw.from, start + 60 * 60000); assert.equal(a.h.ui.mw.to, start + 90 * 60000);
  assert.equal(question(a), 'Когда стан встал?');
  assert.equal(a.h.manualError(a.h.buildView(), a.h.ui.mw), '');
  assert.match(a.h.manualError(a.h.buildView(), { ...a.h.ui.mw, to: a.h.nowMs() + 600000 }), /в будущем/);
  assert.match(a.h.manualError(a.h.buildView(), { ...a.h.ui.mw, from: start - 60000 }), /этой смены/);
});

async function seedTwo(port) {
  await post(port, [
    { id: 'm1', type: 'manual', at: at(100), from: at(10), to: at(25) },
    { id: 'm2', type: 'manual', at: at(100), from: at(40), to: at(70) },
  ]);
}

test('разбор простоев: счётчик «Без причины», «Начать разбор», все разобраны', async (t) => {
  const { a, port } = await fixture(t);
  a.h.go('shift');
  assert.match(text(a.main()), /Разбор простоев/); assert.match(text(a.main()), /Простоев не было/);
  assert.match(text(a.main()), /Все простои разобраны/);
  await seedTwo(port); await a.h.loadState(); a.screen();
  assert.match(text(a.main()), /Без причины: 2/);
  assert.ok(!text(a.main()).includes('Все простои разобраны'));
  assert.ok(!text(a.main()).includes('Простои смены'));
  a.click(a.main(), 'Начать разбор');
  assert.equal(a.h.ui.screen, 'detail'); assert.equal(a.h.ui.card.downtimeId, 'm1', 'первый по времени');
  // На главном экране есть предупреждение с кнопкой в разбор
  a.h.go('auto');
  assert.match(text(a.main()), /Без причины: 2/);
  const notice = byClass(a, 'ps-notice').find((n) => /Без причины/.test(text(n)));
  press(findAll(notice, (e) => e.tagName === 'BUTTON')[0]);
  assert.equal(a.h.ui.screen, 'shift');
});

test('разбор: время простоя правится в редакторе; наложение, конец раньше начала и будущее не уходят', async (t) => {
  const { a, port } = await fixture(t);
  await seedTwo(port); await a.h.loadState();
  a.h.openDetail('m1'); a.screen();
  assert.doesNotMatch(text(a.main()), /Время ставит система/);
  const save = () => findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e) === 'Сохранить время')[0];
  const error = () => byClass(a, 'ps-timefix')[0] && findAll(byClass(a, 'ps-timefix')[0], (e) => e.className === 'ps-field__error')[0];
  assert.equal(save().disabled, true, 'без правок сохранять нечего');
  // Конец заходит на соседний простой 08:40–09:10
  type(field(a, 'Стан пошёл, Москва'), local(50));
  assert.match(text(error()), /Пересекается с другим простоем 08:40–09:10/); assert.equal(error().hidden, false); assert.equal(save().disabled, true);
  // Конец раньше начала
  type(field(a, 'Стан пошёл, Москва'), local(5));
  assert.match(text(error()), /Пуск раньше остановки/);
  // Время в будущем
  type(field(a, 'Стан пошёл, Москва'), local(240));
  assert.match(text(error()), /Время в будущем/);
  // Пустое поле
  type(field(a, 'Стан пошёл, Москва'), '');
  assert.match(text(error()), /Укажите дату и время/);
  press(save());
  assert.equal(a.h.queue.length, 0, 'ничего не отправлено');
  // Верное время: начало на 5 минут раньше, конец на 3 минуты позже — одним событием
  type(field(a, 'Стан встал, Москва'), local(5));
  type(field(a, 'Стан пошёл, Москва'), local(28));
  assert.equal(error().hidden, true); assert.equal(save().disabled, false);
  press(save());
  const fixes = a.h.queue.filter((e) => e.type === 'fix');
  assert.equal(fixes.length, 1); assert.equal(fixes[0].from, at(5)); assert.equal(fixes[0].to, at(28)); assert.equal(fixes[0].index, 0);
  // Экран уже показывает новое время, не дожидаясь сервера
  const seg = a.h.shiftDowntimes(a.h.buildView()).find((d) => d.downtimeId === 'm1');
  assert.equal(seg.startMs, start + 5 * 60000); assert.equal(seg.endMs, start + 28 * 60000);
  await a.pump();
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0);
  const saved = a.h.serverState.segments.find((s) => s.downtimeId === 'm1');
  assert.equal(saved.startMs, start + 5 * 60000); assert.equal(saved.endMs, start + 28 * 60000);
  assert.equal(a.h.queue.length, 0);
});

test('разбор: у идущего простоя правится только «Стан встал», у продолжения из прошлой смены время не правится', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'o-stop', type: 'stop', downtimeId: 'o1', at: at(130) }]);
  await a.h.loadState();
  a.h.openDetail('o1'); a.screen();
  assert.match(text(byClass(a, 'ps-timefix')[0]), /Стан встал.*Стан пошёл.*ещё стоит/);
  assert.ok(field(a, 'Стан встал, Москва')); assert.equal(field(a, 'Стан пошёл, Москва'), undefined);
  type(field(a, 'Стан встал, Москва'), local(120));
  const save = findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e) === 'Сохранить время')[0];
  assert.equal(save.disabled, false);
  press(save);
  const fix = a.h.queue.find((e) => e.type === 'fix');
  assert.equal(fix.from, at(120)); assert.equal('to' in fix, false);
  await a.pump();
  assert.equal(a.h.serverState.open.startMs, start + 120 * 60000);
  assert.equal(a.h.buildView().open.since, start + 120 * 60000);
});

test('разбор: отказ сервера на правку времени объясняется понятным текстом', async (t) => {
  const { a, port } = await fixture(t);
  await seedTwo(port); await a.h.loadState();
  // Такое событие клиент не отправил бы, но сервер обязан отказать и показать понятный текст
  a.h.send('fix', { downtimeId: 'm1', index: 0, to: at(45) }); await a.pump();
  assert.equal(a.h.records.find((r) => r.event.type === 'fix').error, 'overlap');
  assert.match(a.rejectsBox().cards[0], /Пересекается с другим простоем/);
  assert.equal(a.h.humanError('bad_time', a.h.records.find((r) => r.event.type === 'fix').event).startsWith('Проверьте время'), true);
  assert.notEqual(a.h.humanError('bad_time'), a.h.humanError('bad_time', { type: 'fix', from: at(1) }), 'обычный bad_time говорит прежнее');
});

test('разбор: причина по классификатору, затем «Следующий без причины →», а когда все разобраны — назад в разбор', async (t) => {
  const { a, port } = await fixture(t);
  await seedTwo(port); await a.h.loadState();
  a.h.openDetail('m1'); a.screen();
  assert.ok(!buttons(a).some((b) => b.includes('Следующий без причины')), 'у простоя без причины кнопки нет');
  tap(a, 'Бурёжка');
  assert.equal(a.h.ui.wz.mode, 'shiftfix');
  tap(a, 'В ножницах');
  tap(a, 'Без описания');
  assert.equal(a.h.queue.find((e) => e.type === 'fix').reason, 'cobble_shears');
  assert.equal(a.h.ui.screen, 'detail', 'остался без причины m2 — остаёмся в записи');
  a.screen();
  assert.ok(buttons(a).includes('Следующий без причины →'));
  a.click(a.main(), 'Следующий без причины →');
  assert.equal(a.h.ui.card.downtimeId, 'm2'); a.screen();
  tap(a, 'Плановая');
  tap(a, 'Смена профиля');
  tap(a, 'Без описания');
  assert.equal(a.h.ui.screen, 'shift', 'без причины никого не осталось — назад в разбор');
  a.screen();
  assert.match(text(a.main()), /Все простои разобраны/);
  await a.pump();
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0);
  assert.equal(a.h.noReasonList(a.h.buildView()).length, 0);
});

test('шкала суток: подробности получаса — простои с «Разобрать» и «Отметить простой здесь»', async (t) => {
  const { a, port } = await fixture(t);
  await seedTwo(port); await a.h.loadState();
  const view = a.h.buildView();
  const day = a.h.serverState.day;
  const cells = dayCells(day.segments.map((s) => ({ downtimeId: s.downtimeId, startMs: s.startMs, endMs: s.endMs, reason: s.reason })),
    { fromMs: day.fromMs, toMs: day.fromMs + 86400000, nowMs: a.h.nowMs(), dataFromMs: view.dataFromMs, refs: a.h.refs });
  const info = a.h.scaleDowntimes(view, day.segments);
  const mine = new Set(a.h.shiftDowntimes(view).map((d) => d.downtimeId));
  const cell = cells.find((c) => c.startMs === start); // 08:00–08:30: простой m1 08:10–08:25
  assert.deepEqual(cell.downtimes, ['m1']);
  const node = a.h.cellDetails(view, info, mine, cell);
  assert.match(text(node), /08:10–08:25 · Без причины/);
  assert.deepEqual(findAll(node, (e) => e.tagName === 'BUTTON').map(text), ['Разобрать', 'Отметить простой здесь']);
  press(findAll(node, (e) => e.tagName === 'BUTTON')[1]);
  assert.equal(a.h.ui.screen, 'manual'); assert.equal(a.h.ui.mw.from, cell.startMs); assert.equal(a.h.ui.mw.origin, 'scale');
  press(findAll(node, (e) => e.tagName === 'BUTTON')[0]);
  assert.equal(a.h.ui.screen, 'detail'); assert.equal(a.h.ui.card.downtimeId, 'm1');
  // Получас целиком простоя (08:40–09:10 покрывает 08:30–09:00 только частично, а 09:00–09:30 — частично) и будущее
  const full = cells.find((c) => c.startMs === start + 30 * 60000); // 08:30–09:00: m2 с 08:40, работа 10 минут
  assert.deepEqual(full.downtimes, ['m2']);
  const future = cells.find((c) => c.future);
  assert.equal(a.h.cellDetails(view, info, mine, future), null, 'в будущем подробностей и кнопок нет');
  const quiet = cells.find((c) => c.startMs === start + 120 * 60000); // 10:00–10:30: работа без простоев
  assert.deepEqual(quiet.downtimes, []);
  assert.deepEqual(findAll(a.h.cellDetails(view, info, mine, quiet), (e) => e.tagName === 'BUTTON').map(text), ['Отметить простой здесь']);
});
