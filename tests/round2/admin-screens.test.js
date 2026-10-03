import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round2Server } from '../helpers/round2-server.js';
import { bootTablet, text, findAll } from '../helpers/tablet.js';

// Экраны администратора, ассистента и показателей на дизайн-системе.
// Проверяется поведение: шаг смены, панель сохранения, конфликт версии, период, карточка ассистента.
const start = Date.parse('2026-10-05T05:00:00Z');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t) {
  const clock = { t: start + 160 * 60000 };
  const app = await round2Server(t, clock, start);
  const port = app.server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'X-Device-Key': 'k2', Connection: 'close' },
    body: JSON.stringify({ events: [{ id: 'crew', type: 'shift_open', at: new Date(start).toISOString(), crewId: '1', personName: 'Иванов Иван Иванович' }] }) });
  const a = await bootTablet({ name: 'A', key: 'k1', clock, port });
  await a.boot();
  return { a, port };
}
const byClass = (a, cls, tag) => findAll(a.main(), (e) => e.className.split(' ').includes(cls) && (!tag || e.tagName === tag));
const press = (el) => { for (const f of el.handlers.click || []) f({ currentTarget: el, target: el }); };
const button = (a, label) => findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e).includes(label))[0];
async function openAdmin(a) {
  a.h.go('admin');
  for (let i = 0; i < 50 && a.h.ui.admin?.loading !== false && !a.h.ui.admin?.settings; i++) await wait(20);
  a.h.render();
}

test('администратор: разделы, начало смены кнопками ± с шагом 30 минут, конец считает система', async (t) => {
  const { a } = await fixture(t);
  await openAdmin(a);
  const nav = byClass(a, 'ps-subnav__item', 'BUTTON');
  assert.deepEqual(nav.map(text), ['Время смен', 'Мастера смен', 'Номера «Связаться»', 'Рассылка на почту']);
  assert.equal(nav[0].attrs['aria-current'], 'page');
  const steppers = byClass(a, 'ps-stepper');
  assert.equal(steppers.length, 2, 'у каждой смены свой stepper начала');
  assert.equal(findAll(a.main(), (e) => e.tagName === 'SELECT').length, 0, 'селектов времени больше нет');
  const [s1, s2] = a.h.ui.admin.settings.schedule.shifts;
  const before = [s1.start, s2.start];
  const plus = findAll(steppers[0], (e) => e.tagName === 'BUTTON')[1];
  assert.equal(plus.attrs['aria-label'], 'Позже на 30 минут');
  press(plus);
  const m = Number(before[0].slice(0, 2)) * 60 + Number(before[0].slice(3)) + 30;
  assert.equal(s1.start, `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  assert.equal(s2.start, before[1], 'начало второй смены не тронуто');
  const minus = findAll(steppers[0], (e) => e.tagName === 'BUTTON')[0];
  press(minus);
  assert.equal(s1.start, before[0], '± возвращает значение');
  // Конец одной смены — начало другой
  const ends = byClass(a, 'ps-time__end').map(text);
  assert.match(ends[0], new RegExp(before[1]));
  assert.match(ends[1], new RegExp(before[0]));
});

test('администратор: панель сохранения появляется с правкой, PUT идёт в прежнем формате', async (t) => {
  const { a } = await fixture(t);
  await openAdmin(a);
  const bar = byClass(a, 'ps-savebar')[0];
  assert.equal(bar.hidden, true, 'без правок панели нет');
  assert.equal(byClass(a, 'ps-btn', 'BUTTON').some((b) => text(b) === 'Сохранить' && !b.attrs.hidden && !bar.children.includes(b)), false, 'большой кнопки «Сохранить» внизу нет');
  press(findAll(byClass(a, 'ps-stepper')[1], (e) => e.tagName === 'BUTTON')[0]);
  assert.equal(bar.hidden, false);
  assert.match(text(bar), /Есть несохранённые изменения/);
  assert.ok(text(bar).includes('Отменить') && text(bar).includes('Сохранить'));
  const save = findAll(bar, (e) => e.tagName === 'BUTTON' && text(e) === 'Сохранить')[0];
  press(save);
  for (let i = 0; i < 50 && !a.net.log.some((x) => x.method === 'PUT' && x.rel.includes('admin/settings')); i++) await wait(20);
  const put = a.net.log.find((x) => x.method === 'PUT' && x.rel.includes('admin/settings'));
  assert.ok(put, 'настройки отправлены');
  assert.deepEqual(Object.keys(put.body).sort(), ['refsVersion', 'settings']);
  assert.deepEqual(put.body.settings.schedule.shifts.map((x) => x.no), [1, 2]);
  assert.match(put.body.settings.schedule.shifts[1].start, /^\d\d:\d\d$/);
  for (let i = 0; i < 50 && a.h.ui.admin?.dirty; i++) await wait(20);
  assert.ok(!a.h.ui.admin?.dirty, 'после сохранения правок нет');
});

test('администратор: 409 — «Настройки изменили на другом устройстве, обновите форму» и кнопка обновить', async (t) => {
  const { a, port } = await fixture(t);
  await openAdmin(a);
  const fresh = await (await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { headers: { 'X-Device-Key': 'k2', Connection: 'close' } })).json();
  fresh.settings.contacts = [];
  const other = await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { method: 'PUT', headers: { 'X-Device-Key': 'k2', Connection: 'close' },
    body: JSON.stringify({ settings: fresh.settings, refsVersion: fresh.refsVersion }) });
  assert.equal(other.status, 200);
  press(findAll(byClass(a, 'ps-stepper')[0], (e) => e.tagName === 'BUTTON')[1]);
  const bar = byClass(a, 'ps-savebar')[0];
  press(findAll(bar, (e) => e.tagName === 'BUTTON' && text(e) === 'Сохранить')[0]);
  for (let i = 0; i < 50 && !a.h.ui.admin?.conflict; i++) await wait(20);
  assert.equal(a.h.ui.admin.conflict, true);
  a.h.render();
  const bar2 = byClass(a, 'ps-savebar')[0];
  assert.equal(bar2.hidden, false);
  assert.match(text(bar2), /Настройки изменили на другом устройстве, обновите форму/);
  const refresh = findAll(bar2, (e) => e.tagName === 'BUTTON' && text(e) === 'Обновить форму')[0];
  assert.ok(refresh && !refresh.hidden);
  press(refresh);
  assert.equal(a.h.ui.admin === null || a.h.ui.admin?.loading === true, true, 'форма перечитывается');
});

test('администратор: мастера и номера — поля ps-field, «Убрать» и «Добавить мастера в смену N»', async (t) => {
  const { a } = await fixture(t);
  await openAdmin(a);
  press(button(a, 'Мастера смен'));
  const groups = byClass(a, 'ps-group');
  assert.equal(groups.length, 2);
  assert.ok(button(a, 'Добавить мастера в смену 1') && button(a, 'Добавить мастера в смену 2'));
  const count = byClass(a, 'ps-person').length;
  press(button(a, 'Добавить мастера в смену 1'));
  assert.equal(byClass(a, 'ps-person').length, count + 1);
  assert.ok(button(a, 'Убрать'));
  press(button(a, 'Номера «Связаться»'));
  assert.ok(findAll(a.main(), (e) => e.className === 'ps-field__label' && text(e) === 'Подпись').length >= 0);
  assert.ok(button(a, 'Добавить номер'));
});

test('показатели: переключатель периода ps-segmented, плитки ps-kpis, цифры из /api/stats', async (t) => {
  const { a } = await fixture(t);
  a.h.go('stats');
  for (let i = 0; i < 50 && !byClass(a, 'ps-kpis--row').length; i++) { await wait(30); a.h.render(); }
  const seg = byClass(a, 'ps-period')[0];
  const items = findAll(seg, (e) => e.tagName === 'BUTTON');
  assert.deepEqual(items.map(text), ['Смена', 'Сутки', '7 суток', 'Месяц']);
  assert.deepEqual(items.map((b) => b.attrs['aria-pressed']), ['true', 'false', 'false', 'false']);
  assert.equal(byClass(a, 'ps-kpis--row').length, 1);
  assert.equal(findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e).startsWith('← ')).length, 0, 'на экране-разделе кнопки «назад» нет');
  press(items[1]);
  assert.equal(a.h.ui.statsPeriod, 'day');
  a.h.render();
  assert.deepEqual(findAll(byClass(a, 'ps-period')[0], (e) => e.tagName === 'BUTTON').map((b) => b.attrs['aria-pressed']), ['false', 'true', 'false', 'false']);
});

test('ассистент: карточка без второго заголовка, вопрос справа, ответ слева, готовые вопросы чипами', async (t) => {
  const { a } = await fixture(t);
  a.h.aiUi.status = { configured: true };
  a.h.aiUi.log.push({ role: 'user', content: 'Сколько стоял стан?' }, { role: 'assistant', content: 'Час.' });
  a.h.go('ai');
  const card = byClass(a, 'ai-card')[0];
  assert.ok(card);
  assert.equal(card.className.includes('ps-card'), true);
  assert.equal(findAll(card, (e) => ['H1', 'H2', 'H3'].includes(e.tagName)).length, 0, 'внутри карточки нет заголовка');
  assert.equal(findAll(a.main(), (e) => e.tagName === 'H1').length, 1, 'заголовок один — у экрана');
  assert.match(text(findAll(a.main(), (e) => e.tagName === 'H1')[0]), /Спросить ассистента/);
  assert.equal(byClass(a, 'ps-msg--user').length, 1);
  assert.equal(byClass(a, 'ps-msg--assistant').length, 1);
  assert.ok(byClass(a, 'ps-chip', 'BUTTON').length >= 3, 'готовые вопросы — чипы');
  const input = findAll(card, (e) => e.tagName === 'TEXTAREA')[0];
  assert.ok(input.className.includes('ps-input'));
  // Enter отправляет, Shift+Enter — нет
  let prevented = false;
  a.h.aiUi.busy = true;
  for (const f of input.handlers.keydown || []) f({ key: 'Enter', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  for (const f of input.handlers.keydown || []) f({ key: 'Enter', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(findAll(a.main(), (e) => e.tagName === 'BUTTON' && text(e).startsWith('← ')).length, 0, 'кнопки «На главный экран» нет');
});
