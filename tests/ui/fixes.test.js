import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Раскладка и зоны нажатия в настоящем Chrome: панель «Отчёт в Excel», «Показатели», рассылка,
// чипы брака, нижнее меню, подписи графиков. Окна 320, 375, 1280×800, 1600×900 в обеих темах.
// Снимки — в %TEMP%\stan-screens-shots\fixes\ (или STAN_SHOTS_DIR).
const SHOTS = process.env.STAN_SHOTS_DIR || path.join(os.tmpdir(), 'stan-screens-shots', 'fixes');
const SIZES = [[320, 720], [375, 812], [1280, 800], [1600, 900]];
const THEMES = ['light', 'dark'];

test('UI: исправления раскладки на 320–1600 px в обеих темах', { timeout: 300000, skip: !fs.existsSync(CHROME) }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // Проверки копят замечания, а не останавливают прогон: за один запуск видны все дефекты сразу
  const problems = [];
  const ok = (cond, msg) => { if (!cond) problems.push(msg); };
  const eq = (actual, expected, msg) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${msg}: ${JSON.stringify(actual)}`); };
  const now = Date.parse('2026-10-01T20:00:00Z');
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(now) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let chrome = null;
  t.after(async () => { await chrome?.stop(); await app.close(); });
  const at = (min) => new Date(Date.parse('2026-10-01T17:00:00Z') + min * 60000).toISOString();
  const post = async (events) => {
    const res = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    const body = await res.json();
    assert.deepEqual(body.rejected, [], JSON.stringify(body.rejected));
  };
  await post([
    { id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: at(5) },
    { id: 'd1', type: 'stop', at: at(60), reason: 'avaria', note: 'Заклинил вал' },
    { id: 'd1s', type: 'start', downtimeId: 'd1', at: at(150), action: 'Заменили вал' },
  ]);
  // Мастер в списке: на нём видны выбор смены и зоны нажатия карточки мастера
  const cur = await (await fetch(origin + '/api/admin/settings', { headers: { 'X-Device-Key': 'k2' } })).json();
  cur.settings.people = [{ id: null, name: 'Петров Пётр Петрович', crewId: '1', phone: '+7 900 111-22-33' }];
  const put = await fetch(origin + '/api/admin/settings', { method: 'PUT', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ settings: cur.settings, refsVersion: cur.refsVersion }) });
  assert.equal(put.status, 200);
  chrome = await startChrome({});
  const { evaluate, send } = chrome;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${now};` });
  const ready = (sel) => chrome.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, { what: sel });
  const click = async (sel) => { await sleep(450); await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`); };
  const clickText = async (sel, text) => {
    await sleep(450);
    await evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(sel)})]; (all.find((b) => b.textContent.trim() === ${JSON.stringify(text)}) || all.find((b) => b.textContent.includes(${JSON.stringify(text)}))).click(); })()`);
    await sleep(80);
  };
  const setTheme = async (theme) => {
    if (await evaluate('document.documentElement.dataset.theme') !== theme) await sleep(450), await evaluate(`document.querySelector('#theme').click()`);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
  };
  const shot = (name) => chrome.screenshot(path.join(SHOTS, name + '.png'));
  // Общие проверки: страница не шире окна, у всех кнопок и чипов — зона не меньше 44 px (шкала суток — отдельная задача)
  const audit = async (label, width, extra = '') => {
    const r = await evaluate(`(() => {
      const bad = [];
      for (const e of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
        if (e.closest('.ds-row, .day-scale, .ds-seg') || e.hidden || e.type === 'hidden') continue;
        const b = e.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        if (e.matches('input[type="checkbox"], input[type="radio"]')) continue;
        if (b.width < 44 - 0.5 || b.height < 44 - 0.5) bad.push((e.id || e.className || e.tagName) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) + ' «' + (e.textContent || '').trim().slice(0, 20) + '»');
      }
      return { page: document.documentElement.scrollWidth, vw: innerWidth, bad };
    })()`);
    ok(r.page <= r.vw, `${label} ${width}: страница ${r.page} шире окна ${r.vw}`);
    eq(r.bad, [], `${label} ${width}: малые зоны нажатия`);
    void extra;
  };
  const panelCheck = async (label, width) => {
    const p = await evaluate(`(() => {
      const el = document.querySelector('.rep-panel'); if (!el || el.hidden) return null;
      const b = el.getBoundingClientRect();
      const inputs = [...el.querySelectorAll('.rep-date')].map((i) => i.scrollWidth <= i.clientWidth + 1);
      return { left: b.left, right: b.right, width: b.width, vw: innerWidth, hscroll: el.scrollWidth > el.clientWidth + 1, inputs };
    })()`);
    ok(p, `${label} ${width}: панели нет`);
    ok(p.left >= 0 && p.right <= p.vw, `${label} ${width}: панель вне окна ${JSON.stringify(p)}`);
    ok(p.width >= Math.min(360, p.vw - 40), `${label} ${width}: панель сжата ${JSON.stringify(p)}`);
    eq(p.hscroll, false, `${label} ${width}: у панели горизонтальная прокрутка`);
    ok(p.inputs.every(Boolean), `${label} ${width}: даты обрезаны`);
  };

  await chrome.navigate(origin + '/#key=k1');
  await ready('.pult');
  for (const theme of THEMES) {
    await setTheme(theme);
    for (const [width, height] of SIZES) {
      await chrome.viewport(width, height);
      const tag = `${theme}-${width}`;

      // Пульт: нижнее меню и панель «Отчёт в Excel»
      await click('#demo'); await ready('.pult');
      await audit('пульт', width);
      const nav = await evaluate(`(() => { const n = document.querySelector('#nav'); return { scroll: n.scrollWidth <= n.clientWidth + 1, labels: [...n.querySelectorAll('.pill:not(#admin):not(#ai-ask) .pill-text')].filter((s) => s.offsetParent && s.clientWidth > 2 && s.scrollWidth > s.clientWidth + 1).length }; })()`);
      eq(nav.scroll, true, `меню ${width}: прокрутка`);
      eq(nav.labels, 0, `меню ${width}: подпись обрезана`);
      await shot(`пульт-${tag}`);
      await click('.pult .rep-btn, .rep-btn'); await ready('.rep-panel');
      await sleep(150);
      await panelCheck('панель на пульте', width);
      await shot(`пульт-отчёт-${tag}`);
      await click('.rep-close');

      // Показатели: периоды, панель отчёта, подписи графиков
      await click('#nav-stats'); await ready('.ps-kpis--row');
      await audit('показатели', width);
      await click('.ps-period button:nth-child(4)'); await ready('.ps-period');
      await sleep(400);
      await audit('показатели, месяц', width);
      await shot(`показатели-${tag}`);
      const period = await evaluate(`[...document.querySelectorAll('.ps-period button')].every((b) => b.getBoundingClientRect().right <= innerWidth)`);
      eq(period, true, `периоды ${width}: вылезли за окно`);
      await click('.ps-head--stats .rep-btn'); await ready('.rep-panel');
      await sleep(150);
      await panelCheck('панель на показателях', width);
      await shot(`показатели-отчёт-${tag}`);
      await click('.rep-close');
      const fonts = await evaluate(`[...document.querySelectorAll('.chart text')].map((x) => {
        const svg = x.ownerSVGElement; const vb = svg.viewBox.baseVal.width;
        return parseFloat(getComputedStyle(x).fontSize) * svg.getBoundingClientRect().width / vb;
      })`);
      ok(fonts.length > 0, 'графики есть');
      ok(fonts.every((f) => f >= 12.95), `подписи графиков ${width}: ${Math.min(...fonts)} px`);

      // Простой по зонам: часы и минуты
      const zones = await evaluate(`[...document.querySelectorAll('.ps-zrow__val')].map((x) => x.textContent)`);
      ok(zones.every((z) => !/^\\d{3,} мин/.test(z)), `зоны: ${zones}`);

      // Администратор: мастера и рассылка
      await click('#admin'); await ready('.ps-admin .ps-card');
      await clickText('.ps-subnav__item', 'Мастера');
      await audit('мастера', width);
      await shot(`мастера-${tag}`);
      await clickText('.ps-subnav__item', 'Рассылка');
      await clickText('.ps-admin button', 'Добавить получателя');
      await audit('рассылка', width);
      const inside = await evaluate(`(() => { const out = [];
        for (const card of document.querySelectorAll('.ps-admin .ps-card')) { const c = card.getBoundingClientRect();
          for (const e of card.querySelectorAll('*')) { const b = e.getBoundingClientRect(); if (b.width && (b.right > c.right + 1 || b.left < c.left - 1)) out.push(e.className || e.tagName); } }
        return out; })()`);
      eq(inside, [], `рассылка ${width}: элементы вылезли из карточки`);
      await shot(`рассылка-${tag}`);

      // Редактор простоя: чипы брака
      await click('#nav-shift'); await ready('.ps-row');
      await click('.ps-row'); await ready('.ps-editor');
      await sleep(300);
      await shot(`простой-${tag}`);
      await audit('простой', width);
    }
  }
  assert.deepEqual([...new Set(problems)], []);
  assert.ok(fs.readdirSync(SHOTS).length >= 20);
});
