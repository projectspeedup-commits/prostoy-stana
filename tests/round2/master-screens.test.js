import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';

// Экраны мастера смены на дизайн-системе: приём смены, простои смены с редактором, сдача смены, карточка смены.
// Проверяется поведение (выбор, события, пункты чек-листа), а не цвета.
const start = Date.parse('2026-10-05T05:00:00Z');
const at = (mins) => new Date(start + mins * 60000).toISOString();
const post = (port, events) => fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'X-Device-Key': 'k2', Connection: 'close' },
  body: JSON.stringify({ events }) });
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
// Простои без «что сделали»: два закрытых, один с записью
async function seedStops(port) {
  await post(port, [
    { id: 'm1', type: 'manual', at: at(100), from: at(10), to: at(25), reason: 'cobble_shears', billet: 0 },
    { id: 'm2', type: 'manual', at: at(100), from: at(40), to: at(70), reason: 'avaria', note: 'Заклинило подшипник', action: 'Заменили подшипник', billet: 0 },
    { id: 'm3', type: 'manual', at: at(100), from: at(80), to: at(90) },
  ]);
}

test('приём смены: смена и мастер — карточки radio, «Принять смену» ждёт выбора и шлёт shift_open', async (t) => {
  const { a } = await fixture(t, { crew: false });
  assert.equal(a.h.needCrew(a.h.buildView()), true);
  a.screen();
  // Шаг 1: смены карточками, текущая отмечена aria-current
  const group = findAll(a.main(), (e) => e.attrs.role === 'radiogroup')[0];
  assert.equal(group.attrs['aria-label'], 'Смена');
  const crews = byClass(a, 'ps-choice', 'BUTTON');
  assert.ok(crews.length >= 2); assert.ok(crews.every((c) => c.attrs.role === 'radio' && c.attrs['aria-checked'] === 'false'));
  assert.equal(crews.filter((c) => c.attrs['aria-current'] === 'true').length, 1);
  assert.match(text(crews.find((c) => c.attrs['aria-current'] === 'true')), /Смена 1.*сейчас/);
  assert.equal(byClass(a, 'ps-state').length, 1, 'состояние стана видно до приёма');
  press(crews.find((c) => c.attrs['aria-current'] === 'true'));
  assert.equal(a.h.ui.crewId, '1');
  // Шаг 2: мастера этой смены карточками; без выбора принять нельзя
  a.screen();
  const masters = byClass(a, 'ps-choice', 'BUTTON');
  const own = a.h.refs.people.filter((p) => p.crewId === '1');
  assert.ok(own.length >= 2); assert.equal(masters.length, own.length, 'в списке только мастера этой смены');
  const accept = button(a, 'Принять смену');
  assert.equal(accept.disabled, true, 'до выбора мастера кнопка не работает');
  press(accept);
  assert.equal(a.h.queue.some((e) => e.type === 'shift_open'), false);
  const pickable = masters.find((m) => /Демонов|Петров|Иванов/.test(text(m))) ?? masters[0];
  press(pickable); a.h.render();
  const chosen = byClass(a, 'ps-choice', 'BUTTON').filter((m) => m.attrs['aria-checked'] === 'true');
  assert.equal(chosen.length, 1);
  assert.equal(button(a, 'Принять смену').disabled, false);
});

test('приём смены: записка прошлой смены «Передали по ремонту» и состояние стана рядом с кнопкой', async (t) => {
  const { a, port } = await fixture(t, { crew: false });
  await post(port, [{ id: 'bs', type: 'stop', downtimeId: 'long', at: at(-120) }, { id: 'bc', type: 'shift_close', at: at(-10), crewId: '2', personName: 'Сидоров Пётр Петрович', action: 'Сняли редуктор, ждём подшипник' }]);
  await a.h.loadState();
  a.h.ui.crewId = '1'; a.screen();
  const cards = byClass(a, 'ps-card');
  const note = cards.find((c) => /Передали по ремонту/.test(text(c)));
  assert.ok(note, 'карточка записки');
  assert.match(text(note), /Сняли редуктор, ждём подшипник/); assert.match(text(note), /Сидоров Пётр Петрович/);
  assert.equal(byClass(a, 'ps-notice', 'DIV').find((n) => /Сняли редуктор/.test(text(n))).attrs['data-tone'], 'info');
  assert.equal(byClass(a, 'ps-state')[0].attrs['data-state'], 'stop');
  assert.ok(cards.some((c) => /Стан сейчас/.test(text(c)) && /Стан стоит/.test(text(c))));
});

test('приём смены: у мастера без полного ФИО карточка ведёт на ввод ФИО, принять смену можно только полным', async (t) => {
  const { a } = await fixture(t, { crew: false });
  a.h.refs.people.push({ id: 'short', name: 'Орлов И.', crewId: '1' });
  a.h.ui.crewId = '1'; a.screen();
  press(byClass(a, 'ps-choice', 'BUTTON').find((m) => /Орлов/.test(text(m)))); a.h.render();
  press(button(a, 'Принять смену'));
  assert.equal(a.h.ui.fio.personId, 'short');
  a.screen();
  assert.equal(button(a, 'Принять смену').disabled, true);
  for (const [id, v] of [['fio-last', 'Орлов'], ['fio-first', 'Иван'], ['fio-middle', 'Иванович']]) type(findAll(a.main(), (e) => e.attrs.id === id)[0], v);
  assert.equal(button(a, 'Принять смену').disabled, false);
  press(button(a, 'Принять смену')); await a.pump();
  assert.equal(a.h.serverState.crew.personName, 'Орлов Иван Иванович');
});

test('простои смены: строки ps-row с интервалом, зоной, «что сделали» и длительностью; без записи — пометка', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  a.h.go('shift');
  const rows = byClass(a, 'ps-row', 'BUTTON');
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /08:10–08:25/); assert.match(text(rows[0]), /15 м/);
  const tags = rows.map((r) => findAll(r, (e) => e.className === 'ps-tag')[0].attrs['data-zone']);
  assert.deepEqual(tags, ['unplanned', 'failure', 'pending']);
  const what = rows.map((r) => findAll(r, (e) => e.className.includes('ps-row__what'))[0]);
  assert.equal(what[0].attrs['data-missing'], '', 'у бурёжки нет «что сделали»'); assert.equal(text(what[0]), 'Не указано, что сделали');
  assert.equal(what[1].attrs['data-missing'], undefined); assert.equal(text(what[1]), 'Заменили подшипник');
  assert.equal(what[2].attrs['data-missing'], '');
  assert.equal(byClass(a, 'ps-row').filter((r) => r.attrs['aria-current']).length, 0, 'выбранной записи пока нет');
  // «Забыли отметить простой» — в шапке экрана
  assert.match(text(byClass(a, 'ps-head')[0]), /Забыли отметить простой/);
  press(button(a, 'Забыли отметить простой'));
  assert.equal(a.h.ui.screen, 'manual'); assert.equal(a.h.ui.mw.origin, 'shift');
});

test('простои смены: нажатие открывает запись, выбранная строка отмечена, редактор — причина, текст, брак', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  a.h.go('shift');
  press(byClass(a, 'ps-row', 'BUTTON')[0]);
  assert.equal(a.h.ui.screen, 'detail'); a.screen();
  const cur = byClass(a, 'ps-row').filter((r) => r.attrs['aria-current'] === 'true');
  assert.equal(cur.length, 1); assert.match(text(cur[0]), /08:10–08:25/);
  const editor = byClass(a, 'ps-editor')[0];
  assert.match(text(editor), /Простой 08:10–08:25/); assert.match(text(editor), /15 мин/);
  assert.match(text(editor), /Стан встал.*08:10.*Стан пошёл.*08:25/, 'время показано, ставит его система');
  // Причина: три плитки чипами, текущая отмечена; уточнение — пункты группы
  const reasonChips = findAll(editor, (e) => e.attrs['aria-labelledby'] === 'edit-reason-label')[0];
  const groups = findAll(reasonChips, (e) => e.tagName === 'BUTTON');
  assert.equal(groups.length, 3); assert.equal(groups.filter((g) => g.attrs['aria-pressed'] === 'true').length, 1);
  assert.match(text(groups.find((g) => g.attrs['aria-pressed'] === 'true')), /Бурёжка/);
  assert.ok(findAll(editor, (e) => e.attrs.id === 'edit-item-label').length === 1);
  // Брак: чипы 0…2 и «Другое»
  const billet = findAll(editor, (e) => e.attrs['aria-labelledby'] === 'edit-billet-label')[0];
  assert.deepEqual(findAll(billet, (e) => e.tagName === 'BUTTON').map(text), ['0', '0,5', '1', '1,5', '2', 'Другое']);
  assert.equal(button(a, 'Сохранить').disabled, true, 'без правок сохранять нечего');
  // Выбор плитки причины ведёт в мастер причины на нужный шаг (без потери логики)
  press(groups.find((g) => /Поломка/.test(text(g))));
  assert.equal(a.h.ui.screen, 'reason'); assert.equal(a.h.ui.wz.mode, 'shiftfix'); assert.equal(a.h.ui.wz.step, 2);
  assert.equal(a.h.ui.wz.index, 0);
});

test('редактор записи: «что сделали» и брак уходят событиями fix, пустое и неверное не уходит', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  a.h.openDetail(a.h.shiftDowntimes(a.h.buildView())[0].downtimeId); a.screen();
  const id = a.h.ui.card.downtimeId;
  const area = findAll(a.main(), (e) => e.attrs.id === 'edit-action')[0];
  type(area, 'ab');
  assert.equal(button(a, 'Сохранить').disabled, false);
  press(button(a, 'Сохранить'));
  assert.equal(a.h.queue.length, 0, 'слишком короткое «что сделали» не отправляется');
  assert.match(a.h.toasts.at(-1), /Напишите, что сделали/);
  type(area, 'Заменили ролик');
  const billet = findAll(a.main(), (e) => e.attrs['aria-labelledby'] === 'edit-billet-label')[0];
  press(findAll(billet, (e) => e.tagName === 'BUTTON' && text(e) === '1,5')[0]);
  press(button(a, 'Сохранить'));
  const fixes = a.h.queue.filter((e) => e.type === 'fix');
  assert.deepEqual(fixes.map((e) => Object.keys(e).filter((k) => ['action', 'billet', 'note', 'reason'].includes(k))), [['action'], ['billet']]);
  assert.equal(fixes[0].action, 'Заменили ролик'); assert.equal(fixes[1].billet, 1.5);
  assert.ok(fixes.every((e) => e.downtimeId === id && e.index === 0));
  // Черновик пересоздан по новым данным: изменённых полей нет, сохранять нечего
  assert.equal(a.h.ui.edit.base.action, 'Заменили ролик'); assert.equal(a.h.ui.edit.base.billet, '1,5');
  await a.pump();
  assert.equal(a.h.queue.length, 0); assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0);
  assert.equal(a.h.shiftDowntimes(a.h.buildView())[0].action, 'Заменили ролик');
});

test('редактор: другое значение брака вне 0–1000 не сохраняется, «Отмена» возвращает исходное', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  a.h.openDetail(a.h.shiftDowntimes(a.h.buildView())[1].downtimeId); a.screen();
  const billet = findAll(a.main(), (e) => e.attrs['aria-labelledby'] === 'edit-billet-label')[0];
  press(findAll(billet, (e) => e.tagName === 'BUTTON' && text(e) === 'Другое')[0]);
  const input = findAll(a.main(), (e) => e.attrs.id === 'edit-billet')[0];
  assert.equal(input.hidden, false);
  type(input, '1001'); press(button(a, 'Сохранить'));
  assert.equal(a.h.queue.length, 0); assert.match(a.h.toasts.at(-1), /от 0 до 1000 тн/);
  type(input, '2,5'); press(button(a, 'Отмена'));
  assert.equal(a.h.ui.edit.billet, '0', 'черновик сброшен к записи');
  a.screen();
  assert.equal(findAll(a.main(), (e) => e.attrs.id === 'edit-billet')[0].value, '0', 'после отмены в поле значение записи');
});

test('кнопки ± у времени шагают на минуту и не меняют проверки и событие', async (t) => {
  const { a } = await fixture(t);
  a.h.startManualWizard('shift'); a.screen();
  const from0 = a.h.ui.mw.from;
  const stepper = byClass(a, 'ps-stepper')[0];
  const [minus, plus] = findAll(stepper, (e) => e.tagName === 'BUTTON');
  assert.equal(minus.attrs['aria-label'], 'Раньше на минуту');
  press(minus); assert.equal(a.h.ui.mw.from, from0 - 60000);
  a.screen(); press(findAll(byClass(a, 'ps-stepper')[0], (e) => e.tagName === 'BUTTON')[1]); a.screen();
  press(findAll(byClass(a, 'ps-stepper')[0], (e) => e.tagName === 'BUTTON')[1]);
  assert.equal(a.h.ui.mw.from, from0 + 60000);
  assert.match(text(byClass(a, 'ps-stepper')[0]), /\d\d:\d\d/);
  // Время «пуска» забытой остановки: тот же шаг, значение в черновике, проверка ядра прежняя
  a.h.ui.fw = { step: 1, atMs: a.h.nowMs() - 5 * 60000, group: null, reason: null, note: '' };
  const fields = a.h.forgottenTimeFields(a.h.buildView(), a.h.ui.fw, 'atMs', false, () => {});
  const holder = { children: fields, className: '', handlers: {}, attrs: {}, tagName: 'DIV' };
  const step = findAll(holder, (e) => e.className === 'ps-stepper')[0];
  const before = a.h.ui.fw.atMs;
  press(findAll(step, (e) => e.tagName === 'BUTTON')[1]);
  assert.equal(a.h.ui.fw.atMs, before + 60000);
  assert.equal(a.h.forgottenTimeError(a.h.buildView(), a.h.nowMs() + 60000), 'Это время ещё не наступило.');
});

test('сдача смены: чек-лист считает система, у незаполненных пунктов — переход к записи, сдать можно и так', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  a.h.go('closeConfirm');
  const items = byClass(a, 'ps-check', 'LI');
  assert.equal(items.length, 5);
  const status = items.map((i) => i.attrs['data-status']);
  assert.deepEqual(status, ['done', 'todo', 'todo', 'done', 'done']);
  assert.match(text(items[0]), /Все остановки закрыты — стан работает с \d\d:\d\d/);
  assert.match(text(items[1]), /1 простой без причины/);
  assert.match(text(items[2]), /2 простоя без «что сделали»/);
  assert.match(text(items[3]), /Брак и описания указаны/); assert.match(text(items[4]), /Все записи приняты сервером/);
  // Кнопка у todo ведёт к первой незаполненной записи
  press(findAll(items[1], (e) => e.tagName === 'BUTTON')[0]);
  assert.equal(a.h.ui.screen, 'detail'); assert.match(a.h.ui.card.downtimeId, /m3|^[0-9a-f-]+$/);
  assert.equal(a.h.cardData(a.h.buildView()).d.reason, null);
  // Сдать смену можно с незаполненными пунктами; событие то же, что и раньше
  a.h.go('closeConfirm');
  assert.equal(button(a, 'Сдать смену').disabled, false);
  press(button(a, 'Сдать смену')); await a.pump();
  assert.equal(a.h.ui.screen, 'closed');
  assert.ok(a.h.records.some((r) => r.event.type === 'shift_close' && /Не заполнено записей/.test(r.event.note)));
  a.screen();
  assert.match(text(a.main()), /Смена закрыта/);
});

test('сдача смены: итоги плитками из ядра, минуты сходятся с простоями смены; поле записки есть при любом состоянии стана', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  const view = a.h.buildView();
  const sum = a.h.shiftSummary(view);
  const zones = a.h.shiftZoneMinutes(view, sum.downMinutes);
  assert.equal(zones.plan + zones.unplanned + zones.failure, sum.downMinutes, 'зоны распределены по общему итогу ядра');
  assert.equal(zones.unplanned, 25, 'бурёжка 15 мин и запись без причины 10 мин'); assert.equal(zones.failure, 30);
  a.h.go('closeConfirm');
  const tiles = byClass(a, 'ps-kpi');
  assert.deepEqual(tiles.map((k) => text(findAll(k, (e) => e.className === 'ps-kpi__label')[0])), ['Работа', 'Плановый', 'Внеплановый', 'Аварийный', 'Брак за смену']);
  assert.equal(text(findAll(tiles[3], (e) => e.className === 'ps-kpi__value')[0]), '30 м');
  assert.equal(tiles[1].attrs['data-zero'], '', 'нулевая плитка приглушена');
  assert.equal(findAll(a.main(), (e) => e.attrs.id === 'close-action').length, 1, 'стан работает: поле записки следующей смене тоже есть');
  // Стан стоит: то же поле «Что сделали по ремонту…», текст уходит в shift_close.action
  a.h.send('stop', { downtimeId: 'long' }); await a.pump(); a.h.render();
  const ta = findAll(a.main(), (e) => e.attrs.id === 'close-action')[0];
  assert.ok(ta); assert.equal(ta.attrs['aria-label'], 'Что сделали по ремонту за смену и что осталось');
  type(ta, 'Сняли редуктор, ждём подшипник');
  assert.equal(a.h.shiftCloseEvents(a.h.buildView(), true)[0].fields.action, 'Сняли редуктор, ждём подшипник');
  assert.match(text(findAll(a.main(), (e) => e.className === 'ps-checklist')[0]), /Стан стоит с \d\d:\d\d/);
});

test('карточка смены на пульте: аватар, ФИО, прогресс «до конца», записка о простоях без «что сделали», «Сдать смену»', async (t) => {
  const { a, port } = await fixture(t);
  await seedStops(port); await a.h.loadState();
  a.h.go('auto');
  const card = byClass(a, 'ps-shift')[0];
  assert.equal(findAll(card, (e) => e.className === 'ps-avatar')[0].textContent, 'ИИ');
  assert.equal(text(findAll(card, (e) => e.className === 'ps-shift__name')[0]), 'Иванов Иван Иванович');
  const progress = findAll(card, (e) => e.className === 'ps-progress__fill')[0];
  assert.match(progress.style.cssText, /^width: \d+(\.\d+)?%$/);
  assert.match(text(findAll(card, (e) => e.className === 'ps-progress')[0]), /до конца \d+ ч \d+ мин/);
  const notice = findAll(card, (e) => e.className === 'ps-notice')[0];
  assert.match(text(notice), /2 простоя без «что сделали»/);
  press(findAll(notice, (e) => e.tagName === 'BUTTON')[0]);
  assert.equal(a.h.ui.screen, 'detail');
  a.h.go('auto');
  // Старые карточки-ссылки убраны: «Простои за смену» и «Показатели» есть в навигации
  assert.equal(findAll(a.main(), (e) => (e.className || '').includes('shift-action')).length, 0);
  press(button(a, 'Сдать смену'));
  assert.equal(a.h.ui.screen, 'closeCheck');
});

test('сдача смены: проверка состояния стана — две крупные кнопки, ответы ведут на прежние шаги', async (t) => {
  const { a } = await fixture(t);
  a.h.go('closeCheck');
  assert.equal(byClass(a, 'ps-btn--lg', 'BUTTON').length, 2);
  press(button(a, 'Да, работает'));
  assert.equal(a.h.ui.screen, 'closeConfirm');
  a.h.go('closeCheck'); press(button(a, 'Нет, стан стоит'));
  assert.equal(a.h.ui.screen, 'forgotStop'); assert.equal(a.h.ui.fw.step, 1);
});
