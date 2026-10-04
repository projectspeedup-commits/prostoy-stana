import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// qa7: на экране «Показатели» строка причины с нулевым простоем и браком читается и не ломает раскладку.
const NOW = Date.parse('2026-10-01T20:00:00Z');
const z = (hm) => `2026-10-01T${hm}:00Z`;

test('UI: «Показатели» — строка причины 0 мин с браком читается, без NaN, на 1280×800 и 320×568', { timeout: 240000, skip: !fs.existsSync(CHROME) }, async (t) => {
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'owner:k1,master:k2', adminDevices: ['owner'], now: () => new Date(NOW) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const chrome = await startChrome({});
  t.after(async () => { await chrome.stop(); await app.close(); });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });
  const r = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events: [
    { id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: z('17:05') },
    { id: 's1', type: 'stop', downtimeId: 'd1', reason: 'cobble_stand', note: 'ТЕСТ', at: z('18:00') },
    { id: 'e1', type: 'start', downtimeId: 'd1', action: 'ТЕСТ', at: z('19:00') },
    // нулевой простой с браком: stop, fix, start в один момент
    { id: 's2', type: 'stop', downtimeId: 'd2', reason: 'cobble_shears', note: 'ТЕСТ', at: z('19:30') },
    { id: 'f2', type: 'fix', downtimeId: 'd2', index: 0, billet: 1.25, at: z('19:30') },
    { id: 'e2', type: 'start', downtimeId: 'd2', action: 'ТЕСТ', at: z('19:30') },
  ] }) });
  assert.deepEqual((await r.json()).rejected, []);

  for (const [w, h, mobile] of [[1280, 800, false], [320, 568, true]]) {
    await chrome.viewport(w, h, { mobile });
    await chrome.navigate(origin + '/#key=k1');
    await chrome.reload();
    await chrome.waitFor(`!!document.querySelector('#nav-stats') && !document.querySelector('#nav-stats').hidden`, { what: 'меню' });
    await chrome.clickElement('#nav-stats');
    await chrome.waitFor(`!!document.querySelector('.ps-bars')`, { what: 'полосы причин' });
    await sleep(600);
    const info = JSON.parse(await chrome.evaluate(`JSON.stringify({
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      bars: [...document.querySelectorAll('.ps-bar')].map((b) => ({
        name: b.querySelector('.ps-bar__name').innerText.trim(), val: b.querySelector('.ps-bar__val').innerText.trim(),
        fill: b.querySelector('.ps-bar__fill') ? b.querySelector('.ps-bar__fill').getBoundingClientRect().width : 0,
        right: b.getBoundingClientRect().right })),
    })`));
    const label = `${w}×${h}`;
    assert.ok(!/NaN|Infinity|undefined|null/.test(info.text), `${label}: служебные слова на экране`);
    assert.ok(!info.overflow, `${label}: горизонтальная прокрутка`);
    const reasons = info.bars.slice(0, 2);
    assert.deepEqual(reasons.map((b) => b.name), ['Бурёжка: в клети', 'Бурёжка: в ножницах'], `${label}: порядок — по убыванию минут`);
    assert.equal(reasons[0].val, '1 ч · 1 ост. · 100%');
    assert.equal(reasons[1].val, '0 мин · 0 ост. · брак 1,25 тн · 0%', `${label}: нулевая строка читается`);
    assert.ok(reasons[1].fill > 0, `${label}: у полосы есть видимая часть`);
    for (const b of info.bars) assert.ok(b.name && b.right <= w, `${label}: название не пустое, строка в пределах окна`);
  }
});
