import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';

// Правки после независимой проверки: очистка необязательного «Что случилось», перенос мастера между сменами,
// длительности часами и минутами. Раскладку и зоны нажатия проверяет tests/ui/fixes.test.js в настоящем Chrome.
const start = Date.parse('2026-10-05T05:00:00Z');
const at = (mins) => new Date(start + mins * 60000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'X-Device-Key': 'k2', Connection: 'close' };
const post = (port, events) => fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers, body: JSON.stringify({ events }) });
async function fixture(t) {
  const clock = { t: start + 160 * 60000 };
  const app = await round2Server(t, clock, start);
  const port = app.server.address().port;
  await post(port, [{ id: 'crew', type: 'shift_open', at: at(0), crewId: '1', personName: 'Иванов Иван Иванович' }]);
  const a = await bootTablet({ name: 'A', key: 'k1', clock, port });
  await a.boot();
  return { a, port };
}
const hasClass = (e, cls) => e.className.split(' ').includes(cls);
const byClass = (a, cls, tag) => findAll(a.main(), (e) => hasClass(e, cls) && (!tag || e.tagName === tag));
const press = (el) => { for (const f of el.handlers.click || []) f({ currentTarget: el, target: el }); };
const type = (el, value) => { el.value = value; for (const f of el.handlers.input || []) f({}); };
const button = (a, label) => findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e).includes(label))[0];
const field = (a, id) => findAll(a.main(), (e) => e.attrs.id === id)[0];
async function openAdmin(a) {
  a.h.go('admin');
  for (let i = 0; i < 50 && a.h.ui.admin?.loading !== false && !a.h.ui.admin?.settings; i++) await wait(20);
  a.h.render();
}

test('редактор: необязательное «Что случилось» можно стереть — уходит fix с note: ""', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'm2', type: 'manual', at: at(100), from: at(40), to: at(70), reason: 'cobble_shears', note: 'Раскат не прошёл', action: 'Вырезали лом', billet: 0 }]);
  await a.h.loadState();
  a.h.openDetail(a.h.shiftDowntimes(a.h.buildView())[0].downtimeId); a.screen();
  assert.equal(a.h.needsNote('cobble_shears'), false, 'у бурёжки в ножницах описание необязательно');
  const note = field(a, 'edit-note');
  assert.equal(note.value, 'Раскат не прошёл');
  assert.equal(button(a, 'Сохранить').disabled, true);
  type(note, '');
  assert.equal(button(a, 'Сохранить').disabled, false, 'очистка — это изменение');
  press(button(a, 'Сохранить'));
  const fixes = a.h.queue.filter((e) => e.type === 'fix');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].note, '');
  assert.equal('action' in fixes[0], false, 'остальные поля не тронуты');
  await a.pump();
  assert.equal(a.h.records.filter((r) => r.status === 'rejected').length, 0, 'сервер принял пустое описание');
  assert.equal(a.h.shiftDowntimes(a.h.buildView())[0].note || '', '');
});

test('редактор: у «иной причины» описание обязательно — стереть нельзя, как и раньше', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'm5', type: 'manual', at: at(100), from: at(40), to: at(70), reason: 'plan_other', note: 'Своё описание', action: 'Сделали', billet: 0 }]);
  await a.h.loadState();
  a.h.openDetail(a.h.shiftDowntimes(a.h.buildView())[0].downtimeId); a.screen();
  assert.equal(a.h.needsNote('plan_other'), true);
  type(field(a, 'edit-note'), '');
  assert.equal(button(a, 'Сохранить').disabled, true, 'очищенное обязательное описание считается неизменённым');
  type(field(a, 'edit-note'), 'ab');
  press(button(a, 'Сохранить'));
  assert.equal(a.h.queue.length, 0, 'короткое описание не уходит');
  type(field(a, 'edit-note'), 'Другое описание причины');
  press(button(a, 'Сохранить'));
  assert.equal(a.h.queue.filter((e) => e.type === 'fix')[0].note, 'Другое описание причины');
});

test('мастера смен: смену существующего мастера меняют селектором, id остаётся, мастер переезжает в другой список', async (t) => {
  const { a, port } = await fixture(t);
  const cur = await (await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { headers })).json();
  cur.settings.people = [{ id: null, name: 'Петров Пётр Петрович', crewId: '1', phone: '+7 900 111-22-33' }];
  const saved = await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { method: 'PUT', headers, body: JSON.stringify({ settings: cur.settings, refsVersion: cur.refsVersion }) });
  assert.equal(saved.status, 200);
  const before = (await (await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { headers })).json()).settings.people[0];
  assert.ok(before.id, 'сервер выдал id');
  await openAdmin(a);
  press(button(a, 'Мастера смен'));
  const groupOf = (no) => byClass(a, 'ps-group').find((g) => g.attrs['data-crew'] === no);
  const peopleIn = (no) => findAll(groupOf(no), (e) => hasClass(e, 'ps-person')).length;
  assert.equal(byClass(a, 'ps-person').length, 1);
  assert.equal(peopleIn('1'), 1);
  const picks = () => findAll(findAll(a.main(), (e) => hasClass(e, 'ps-segmented'))[0], (e) => e.tagName === 'BUTTON');
  assert.deepEqual(picks().map(text), ['Смена 1', 'Смена 2']);
  assert.deepEqual(picks().map((b) => b.attrs['aria-pressed']), ['true', 'false']);
  press(picks()[1]);
  assert.equal(a.h.ui.admin.dirty, true);
  assert.equal(peopleIn('1'), 0, 'из первой смены ушёл');
  assert.equal(peopleIn('2'), 1, 'во второй появился');
  assert.deepEqual(picks().map((b) => b.attrs['aria-pressed']), ['false', 'true']);
  const bar = byClass(a, 'ps-savebar')[0];
  press(findAll(bar, (e) => e.tagName === 'BUTTON' && text(e) === 'Сохранить')[0]);
  for (let i = 0; i < 50 && !a.net.log.some((x) => x.method === 'PUT' && x.rel.includes('admin/settings')); i++) await wait(20);
  const put = a.net.log.find((x) => x.method === 'PUT' && x.rel.includes('admin/settings'));
  assert.deepEqual(Object.keys(put.body).sort(), ['refsVersion', 'settings'], 'формат PUT прежний');
  assert.deepEqual(put.body.settings.people.map((p) => [p.id, p.crewId]), [[before.id, '2']]);
  const after = (await (await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { headers })).json()).settings.people;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before.id, 'id не изменился: у принятой смены находится телефон');
  assert.equal(after[0].crewId, '2');
  assert.equal(after[0].phone, '+7 900 111-22-33');
});

test('показатели: «Простой по зонам» и подписи частей полос — «2 ч 13 мин», а не «133 мин»', async (t) => {
  const { a, port } = await fixture(t);
  await post(port, [{ id: 'long', type: 'manual', at: at(150), from: at(5), to: at(138), reason: 'avaria', note: 'Заклинил вал', action: 'Заменили', billet: 0 }]);
  await a.h.loadState();
  a.h.go('stats');
  for (let i = 0; i < 50 && !byClass(a, 'ps-zrow').length; i++) { await wait(30); a.h.render(); }
  const zones = byClass(a, 'ps-zrow__val').map(text);
  assert.ok(zones.some((z) => z.startsWith('2 ч 13 мин · ')), zones.join(' | '));
  assert.ok(zones.every((z) => !/^\d{3,} мин/.test(z)), 'минут больше сотни числом нет');
  const titles = byClass(a, 'ps-bar__fill').map((e) => e.attrs.title).filter(Boolean);
  assert.ok(titles.length > 0 && titles.every((x) => /^(\d+ ч )?\d+ мин$/.test(x)), titles.join(' | '));
  assert.ok(titles.includes('2 ч 13 мин'), titles.join(' | '));
});
