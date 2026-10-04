import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Замечания qa6: 1) подписи нижнего меню не сливаются на 320 и 360 px; 2) пометка о браке открытого простоя в итогах сдачи;
// 3) формулировка пункта «что сделали» в проверке перед сдачей при открытом простое.
const NOW = Date.parse('2026-10-01T20:00:00Z');
const z = (hm) => `2026-10-01T${hm}:00Z`;

async function setup(t) {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const chrome = await startChrome({});
  t.after(async () => { await chrome.stop(); await app.close(); });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const post = async (events) => {
    const r = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    assert.deepEqual((await r.json()).rejected, []);
  };
  return { origin, chrome, post };
}

const NAV = `JSON.stringify([...document.querySelectorAll('#nav .pill')].filter((b) => !b.hidden).map((b) => {
  const tx = b.querySelector('.pill-text'); const vis = tx.getBoundingClientRect().width > 2;
  const rg = document.createRange(); rg.selectNodeContents(tx); const tr = rg.getBoundingClientRect();
  return { id: b.id, vis, l: tr.left, r: tr.right };
}))`;

test('UI: подписи нижнего меню не сливаются на 320×568 и 360×640', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { origin, chrome, post } = await setup(t);
  const { evaluate } = chrome;
  await post([{ id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') }]);
  await chrome.navigate(origin + '/#key=k1');
  await chrome.reload();
  await chrome.waitFor(`!!document.querySelector('.pult')`, { what: 'пульт' });
  for (const [w, h, mobile] of [[320, 568, false], [320, 568, true], [360, 640, false], [360, 640, true], [335, 640, true], [340, 640, true], [1280, 800, false]]) {
    await chrome.viewport(w, h, { mobile });
    await sleep(450);
    const nav = JSON.parse(await evaluate(NAV));
    const labelled = nav.filter((p) => p.vis).sort((a, b) => a.l - b.l);
    const gaps = labelled.slice(1).map((p, i) => Math.round((p.l - labelled[i].r) * 100) / 100);
    console.log(w, h, mobile, labelled.length, JSON.stringify(gaps));
    if (w < 600) for (const g of gaps) assert.ok(g >= 3, `${w}×${h}: зазор между подписями ${g} px`);
  }
});

test('UI: сдача смены при открытом простое — пометка о браке и точный пункт «что сделали»', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const { origin, chrome, post } = await setup(t);
  const { evaluate } = chrome;
  await post([
    { id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') },
    { id: 's1', type: 'stop', downtimeId: 'd1', reason: 'cobble_stand', note: 'Заклинил вал', at: z('19:00') },
    { id: 'f1', type: 'fix', downtimeId: 'd1', index: 0, billet: 0.5, at: z('19:10') },
  ]);
  await chrome.viewport(1280, 800, { mobile: false });
  await chrome.navigate(origin + '/#key=k2');
  await chrome.reload();
  await chrome.waitFor(`!!document.querySelector('.pult')`, { what: 'пульт' });
  await sleep(600);
  await chrome.clickText('.ps-btn, button', 'Сдать смену');
  await chrome.waitFor(`document.body.innerText.includes('Да, стоит')`, { what: 'вопрос о стане' });
  await chrome.clickText('.ps-btn', 'Да, стоит');
  await chrome.waitFor(`document.body.innerText.includes('Проверка перед сдачей')`, { what: 'проверка перед сдачей' });
  await sleep(450);
  const body = await evaluate('document.body.innerText');
  assert.match(body, /Брак за смену\s*0 тн/);
  assert.match(body, /Брак открытого простоя \(0,5 тн\) учтётся после пуска/);
  assert.doesNotMatch(body, /Везде указано, что сделали/);
  assert.match(body, /У завершённых простоев указано, что сделали \(идущий простой не проверяется\)/);
});
