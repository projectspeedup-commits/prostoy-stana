import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Находка QA: планшет А был без связи и выбрал причину открытого простоя, планшет Б успел записать свою.
// После возврата связи А видит ответы Б рядом со своими и не может затереть их незаметно.
const NOW = Date.parse('2026-10-01T20:00:00Z');

async function scenario(t, bAnswers) {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const chrome = await startChrome({});
  t.after(async () => { await chrome.stop(); await app.close(); });
  const { evaluate, send } = chrome;
  const at = (sec) => new Date(NOW - 600000 + sec * 1000).toISOString();
  const post = async (key, events) => {
    const res = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': key }, body: JSON.stringify({ events }) });
    const body = await res.json();
    assert.deepEqual(body.rejected, [], JSON.stringify(body.rejected));
  };
  const serverOpen = async () => (await (await fetch(origin + '/api/state', { headers: { 'X-Device-Key': 'k1' } })).json()).state.open.segments.at(-1);
  const body = () => evaluate('document.body.innerText');
  const click = async (txt, sel = 'button') => { await chrome.clickText(sel, txt); await sleep(500); };
  const fill = async (sel, value) => {
    await chrome.clickElement(sel);
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  await chrome.viewport(1280, 800);
  await post('k2', [{ id: 'o1', type: 'shift_open', crewId: '1', personName: 'Иванов Иван Иванович', at: at(0) }]);
  await chrome.navigate(origin + '/#key=k1');
  await chrome.waitFor(`!!document.querySelector('.pult')`, { what: '.pult' });
  await sleep(600);
  // А теряет связь и записывает остановку с причиной
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await click('Стан встал');
  // Стоп одним нажатием; причину планшет А указывает кнопкой «Указать причину сейчас»
  await click('Указать причину сейчас');
  await click('Поломка, замена');
  await click('Другое');
  await fill('#wz-note', 'QA Ответ планшета А');
  await click('Сохранить');
  // Б в это время записал остановку и свои ответы
  await post('k2', [{ id: 'bs', type: 'stop', downtimeId: 'bd', at: at(10), reason: 'plan_profile', ...bAnswers }]);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await chrome.waitFor(`document.body.innerText.includes('Нужно исправить')`, { timeout: 20000, what: 'Нужно исправить' });
  await click('Нужно исправить', 'a,button');
  return { body, click, chrome, serverOpen };
}

test('UI: конфликт причины открытого простоя — свои и чужие ответы рядом, перенос только пустых полей', { timeout: 120000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { body, click, serverOpen } = await scenario(t, {});
  let text = await body();
  assert.match(text, /Уже записано с другого устройства/);
  assert.match(text, /Ваши ответы/);
  assert.match(text, /Плановая: смена профиля|смена профиля/);
  assert.match(text, /QA Ответ планшета А/);
  await click('Открыть сохранённую запись');
  text = await body();
  assert.match(text, /Уже записано с другого устройства/);
  assert.match(text, /Перенести только пустые поля/);
  assert.match(text, /Заменить ответы устройства/);
  assert.match(text, /Убрать мою запись/);
  assert.doesNotMatch(text, /Отправить исправление/);
  await click('Перенести только пустые поля');
  await sleep(2500);
  const seg = await serverOpen();
  assert.equal(seg.reason, 'plan_profile', 'причина Б не затёрта');
  assert.equal(seg.note, 'QA Ответ планшета А', 'пустое поле «Что случилось» перенесено');
});

test('UI: замена ответов устройства — только после явного подтверждения', { timeout: 120000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { body, click, serverOpen } = await scenario(t, { note: 'QA Ответ планшета Б' });
  await click('Открыть сохранённую запись');
  const text = await body();
  assert.match(text, /QA Ответ планшета Б/);
  assert.match(text, /Свободных полей нет/);
  await click('Заменить ответы устройства');
  await sleep(1500);
  let seg = await serverOpen();
  assert.equal(seg.note, 'QA Ответ планшета Б', 'первое нажатие ничего не меняет');
  assert.match(await body(), /Да, заменить ответы устройства/);
  await click('Да, заменить ответы устройства');
  await sleep(2500);
  seg = await serverOpen();
  assert.equal(seg.note, 'QA Ответ планшета А');
  assert.equal(seg.reason, 'failure_other');
});
