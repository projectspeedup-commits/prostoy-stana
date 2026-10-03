import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// «Показатели»: плитка «Брак, тн», брак у причин и смен, предупреждение «не указан брак». Замеры в настоящем Chrome 1280×800.
// Снимки — в %TEMP%\stan-screens-shots\billet\ (или STAN_SHOTS_DIR/billet).
const SHOTS = path.join(process.env.STAN_SHOTS_DIR || path.join(os.tmpdir(), 'stan-screens-shots'), 'billet');
const THEMES = ['light', 'dark'];

test('UI: «Показатели» — брак в плитке, у причин и смен, предупреждение о неуказанном браке', { timeout: 180000, skip: !fs.existsSync(CHROME) }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const now = Date.parse('2026-10-01T20:00:00Z'); // 23:00 МСК: идёт смена 2, сутки с 08:00 МСК
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(now) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let chrome = null;
  t.after(async () => { await chrome?.stop(); await app.close(); });
  const z = (hm) => `2026-10-01T${hm}:00Z`;
  const res = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events: [
    { id: 'o1', type: 'shift_open', crewId: '1', personName: 'Иванов Иван Иванович', at: z('05:10') },
    { id: 's1', type: 'stop', downtimeId: 'd1', reason: 'avaria', note: 'Заклинил вал', at: z('06:00') },
    { id: 'e1', type: 'start', downtimeId: 'd1', action: 'Заменили вал', at: z('06:45') },
    { id: 'f1', type: 'fix', downtimeId: 'd1', index: 0, billet: 2.5, at: z('06:45') },
    { id: 's2', type: 'stop', downtimeId: 'd2', reason: 'cobble_stand', note: 'Раскат застрял', at: z('09:00') },
    { id: 'e2', type: 'start', downtimeId: 'd2', action: 'Убрали лом', at: z('09:20') },
    { id: 'f2', type: 'fix', downtimeId: 'd2', index: 0, billet: 1, at: z('09:20') },
    { id: 'c1', type: 'shift_close', crewId: '1', personName: 'Иванов Иван Иванович', note: 'Сдал', at: z('16:55') },
    { id: 'o2', type: 'shift_open', crewId: '2', personName: 'Петров Пётр Петрович', at: z('17:05') },
    // Бурёжка в смене 2: брак спрашивают, но не указан
    { id: 's3', type: 'stop', downtimeId: 'd3', reason: 'cobble_shears', note: 'Лом в ножницах', at: z('18:00') },
    { id: 'e3', type: 'start', downtimeId: 'd3', action: 'Вырезали', at: z('18:30') },
  ] }) });
  const body = await res.json();
  assert.deepEqual(body.rejected, [], JSON.stringify(body.rejected));

  chrome = await startChrome({});
  const { evaluate, send } = chrome;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${now};` });
  const ready = (sel) => chrome.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, { what: sel });
  const click = async (sel) => { await sleep(450); await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`); };
  const setTheme = async (theme) => {
    if (await evaluate('document.documentElement.dataset.theme') !== theme) { await sleep(450); await evaluate(`document.querySelector('#theme').click()`); }
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
  };
  const tile = () => evaluate(`(() => { const k = document.querySelector('.ps-kpi[data-kind="billet"]'); return k && { label: k.querySelector('.ps-kpi__label').textContent, value: k.querySelector('.ps-kpi__value').textContent, tone: k.getAttribute('data-tone') }; })()`);

  await chrome.viewport(1280, 800);
  await chrome.navigate(origin + '/#key=k1');
  await ready('.pult');
  for (const theme of THEMES) {
    await setTheme(theme);
    await click('#nav-stats'); await ready('.ps-kpis--row');
    await click('.ps-period button:nth-child(1)'); await sleep(400);
    // Смена 2: брак спрашивали, но не указан — прочерк и предупреждение
    await chrome.waitFor(`!!document.querySelector('.ps-kpi[data-kind="billet"]')`, { what: 'плитка брака' });
    assert.deepEqual(await tile(), { label: 'Брак, тн', value: '—', tone: null });
    assert.match(await evaluate(`document.querySelector('.ps-stats').textContent`), /не указан брак: 1/);
    // Сутки: 2,5 + 1 = 3,5 тн
    await click('.ps-period button:nth-child(2)');
    await chrome.waitFor(`document.querySelector('.ps-kpi[data-kind="billet"] .ps-kpi__value')?.textContent === '3,5 тн'`, { what: 'брак за сутки' });
    assert.deepEqual(await tile(), { label: 'Брак, тн', value: '3,5 тн', tone: null });
    const text = await evaluate(`document.querySelector('.ps-stats').textContent`);
    assert.match(text, /не указан брак: 1/);
    const bars = await evaluate(`[...document.querySelectorAll('.ps-bar')].map((b) => b.textContent)`);
    assert.ok(bars.some((b) => /Аварийный простой.*брак 2,5 тн/.test(b)), JSON.stringify(bars));
    assert.ok(bars.some((b) => /Бурёжка: в клети.*брак 1 тн/.test(b)), JSON.stringify(bars));
    assert.ok(bars.some((b) => /Смена 1.*брак 3,5 тн/.test(b)), JSON.stringify(bars));
    assert.ok(bars.some((b) => /^Смена 2/.test(b) && !/брак/.test(b)), 'у смены 2 брак не указан — подписи нет');
    // Плитка влезает в ряд и не обрезана
    const fit = await evaluate(`(() => { const k = document.querySelector('.ps-kpi[data-kind="billet"]'); const r = k.getBoundingClientRect(); const v = k.querySelector('.ps-kpi__value'); return r.right <= innerWidth && v.scrollWidth <= v.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()`);
    assert.equal(fit, true);
    await sleep(500);
    await chrome.screenshot(path.join(SHOTS, `показатели-брак-${theme}-1280x800.png`));
  }
  assert.deepEqual(chrome.consoleLog.filter((m) => /exception|error/.test(m.kind)), []);
});
