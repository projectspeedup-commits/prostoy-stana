import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app/server/index.js';
import { startChrome, sleep, CHROME } from './cdp.js';

// Правки по второй проверке, замеры в настоящем Chrome: пульт без прокрутки на 1280×800, статус связи не заходит на часы,
// даты в панели Excel на 320, кольцо и ось графиков, нейтральные цвета настроек, вкладки администратора на телефоне.
// Снимки — в %TEMP%\stan-screens-shots\qa-fixes\ (или STAN_SHOTS_DIR/qa-fixes).
const SHOTS = path.join(process.env.STAN_SHOTS_DIR || path.join(os.tmpdir(), 'stan-screens-shots'), 'qa-fixes');
const THEMES = ['light', 'dark'];

test('UI: правки по второй проверке — высота пульта, шапка, Excel, графики, цвета, вкладки', { timeout: 300000, skip: !fs.existsSync(CHROME) }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const problems = [];
  const ok = (cond, msg) => { if (!cond) problems.push(msg); };
  const now = Date.parse('2026-10-01T20:00:00Z');
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(now) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let chrome = null;
  t.after(async () => { await chrome?.stop(); await app.close(); });
  const base = Date.parse('2026-10-01T17:00:00Z');
  const at = (min) => new Date(base + min * 60000).toISOString();
  const post = async (events) => {
    const res = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    const body = await res.json();
    assert.deepEqual(body.rejected, [], JSON.stringify(body.rejected));
  };
  const DAY = 1440;
  await post([
    { id: 'o1', type: 'shift_open', crewId: '2', personName: 'Иванов Иван Иванович', at: at(5) },
    { id: 'd1', type: 'stop', at: at(60), reason: 'avaria', note: 'Заклинил вал' },
    { id: 'd1s', type: 'start', downtimeId: 'd1', at: at(150), action: 'Заменили вал' },
    { id: 'h1', type: 'manual', at: at(10), from: at(-2 * DAY), to: at(-2 * DAY + 190), reason: 'avaria', note: 'Заклинил вал', action: 'Заменили', billet: 1.5 },
    { id: 'h2', type: 'manual', at: at(11), from: at(-3 * DAY), to: at(-3 * DAY + 600), reason: 'cobble_shears', action: 'Вырезали', billet: 0 },
    { id: 'h3', type: 'manual', at: at(12), from: at(-4 * DAY), to: at(-4 * DAY + 120), reason: 'plan_other', note: 'Настройка', action: 'Настроили', billet: 0 },
  ]);
  chrome = await startChrome({});
  const { evaluate, send } = chrome;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${now};` });
  const ready = (sel) => chrome.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, { what: sel });
  const click = async (sel) => { await sleep(450); await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`); };
  const clickText = async (sel, txt) => {
    await sleep(450);
    await evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(txt)})).click()`);
    await sleep(80);
  };
  const setTheme = async (theme) => {
    if (await evaluate('document.documentElement.dataset.theme') !== theme) { await sleep(450); await evaluate(`document.querySelector('#theme').click()`); }
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
  };
  const shot = (name) => chrome.screenshot(path.join(SHOTS, name + '.png'));
  const reload = async () => { await chrome.reload(); await ready('.pult, .ps-flow'); await sleep(500); };
  const pageHeight = () => evaluate(`({ sh: document.documentElement.scrollHeight, ih: innerHeight, btn: document.querySelector('.ps-action')?.getBoundingClientRect().height ?? null })`);

  await chrome.navigate(origin + '/#key=k1');
  await ready('.pult');

  // ---- 1. Пульт: помещается в окно без прокрутки; главная кнопка не ниже 64 px ----
  const states = [
    ['работает', async () => {}, [[1280, 800], [1366, 768], [1024, 768]]],
    ['стоит без причины', async () => { await post([{ id: 'd2', type: 'stop', at: at(170) }]); await reload(); }, [[1280, 800], [1366, 768], [1024, 768]]],
    // С указанной причиной правая колонка длиннее: кнопка смены встаёт под кнопку пуска; 1024×768 — допустима небольшая прокрутка
    ['стоит с причиной', async () => { await post([{ id: 'd2r', type: 'reason', downtimeId: 'd2', at: at(172), reason: 'avaria', note: 'Заклинил вал' }]); await reload(); }, [[1280, 800], [1366, 768]]],
  ];
  for (const [name, prepare, sizes] of states) {
    await prepare();
    for (const theme of THEMES) {
      await setTheme(theme);
      for (const [w, h] of sizes) {
        await chrome.viewport(w, h); await sleep(350);
        const r = await pageHeight();
        ok(r.sh <= r.ih, `пульт «${name}» ${w}×${h} ${theme}: высота страницы ${r.sh} больше окна ${r.ih}`);
        ok(r.btn >= 64, `пульт «${name}» ${w}×${h}: главная кнопка ${r.btn} px`);
        if (w === 1280) await shot(`пульт-${name.replaceAll(' ', '-')}-1280x800-${theme}`);
      }
    }
  }
  // Высокое окно: прежняя раскладка не сломана — кнопка крупная, скролла нет и там
  await chrome.viewport(1280, 1000); await sleep(300);
  ok((await pageHeight()).btn >= 120, 'высокое окно: кнопка осталась крупной');

  // Вернём работу стана для остальных замеров
  await post([{ id: 'd2s', type: 'start', downtimeId: 'd2', at: at(175), action: 'Заменили' }]);
  await reload();

  // ---- 2. Шапка: статус связи не заходит на часы, бренд и кнопку темы ----
  const overlap = `(() => {
    const q = (s) => document.querySelector(s)?.getBoundingClientRect();
    const rects = { status: q('.topbar .save-status'), clock: q('.topclock'), brand: q('.topbar .brand'), theme: q('#theme') };
    const hit = (a, b) => a && b && a.width && b.width && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const bad = [];
    for (const [x, y] of [['status', 'clock'], ['status', 'brand'], ['status', 'theme'], ['clock', 'theme'], ['brand', 'clock']]) if (hit(rects[x], rects[y])) bad.push(x + '×' + y);
    return { bad, page: document.documentElement.scrollWidth, vw: innerWidth };
  })()`;
  for (const theme of THEMES) {
    await setTheme(theme);
    for (const w of [700, 820, 900, 1024, 1100, 1200, 1280, 1366]) {
      await chrome.viewport(w, 800); await sleep(250);
      const norm = await evaluate(overlap);
      ok(norm.bad.length === 0, `шапка ${w} ${theme}: пересечения ${norm.bad}`);
      ok(norm.page <= norm.vw, `шапка ${w}: страница шире окна`);
      // Проблемный статус: длинный текст обрезается многоточием внутри своей ширины
      await evaluate(`document.querySelector('.topbar .save-status').className = 'save-status waiting';
        document.querySelector('.topbar .save-status .save-status-text').textContent = 'Нужно исправить: 12 — показать, сохранено на планшете · ждут отправки: 30'`);
      const long = await evaluate(overlap);
      ok(long.bad.length === 0, `шапка с длинным статусом ${w} ${theme}: пересечения ${long.bad}`);
      await evaluate(`document.querySelector('.topbar .save-status').className = 'save-status online';
        document.querySelector('.topbar .save-status .save-status-text').textContent = 'Связь с сервером есть'`);
    }
    await chrome.viewport(1024, 768); await sleep(250);
    await shot(`шапка-1024-${theme}`);
  }
  // При норме — точка, у неё есть название для чтения с экрана
  const dot = await evaluate(`(() => { const s = document.querySelector('.topbar .save-status'); return { label: s.getAttribute('aria-label'), w: s.getBoundingClientRect().width }; })()`);
  ok(/Связь с сервером|Принято сервером/.test(dot.label || ''), `у точки связи нет названия: ${dot.label}`);

  // ---- 3. Панель «Отчёт в Excel» на 320: даты видны целиком, поля одно под другим ----
  for (const theme of THEMES) {
    await setTheme(theme);
    for (const [w, h, stacked] of [[320, 640, true], [360, 740, true], [1280, 800, false]]) {
      await chrome.viewport(w, h); await sleep(300);
      await click('.pult .rep-btn, .rep-btn'); await ready('.rep-panel'); await sleep(200);
      const m = await evaluate(`(() => {
        const inputs = [...document.querySelectorAll('.rep-date')];
        const ctx = document.createElement('canvas').getContext('2d');
        return inputs.map((i) => { const cs = getComputedStyle(i); ctx.font = cs.fontSize + ' ' + cs.fontFamily;
          const need = ctx.measureText('00.00.0000').width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 30; // 30 — значок календаря
          const b = i.getBoundingClientRect(); return { w: b.width, need, top: Math.round(b.top), value: i.value }; });
      })()`);
      ok(m.length === 2, `Excel ${w}: полей дат ${m.length}`);
      ok(m.every((x) => x.w >= x.need), `Excel ${w} ${theme}: дата не помещается (${JSON.stringify(m)})`);
      ok(m.every((x) => /^\d{4}-\d\d-\d\d$|^\d\d\.\d\d\.\d{4}$/.test(x.value)), `Excel ${w}: значение даты ${JSON.stringify(m.map((x) => x.value))}`);
      ok(stacked ? m[0].top !== m[1].top : m[0].top === m[1].top, `Excel ${w}: раскладка полей ${JSON.stringify(m)}`);
      if (w === 320) await shot(`excel-320-${theme}`);
      await click('.rep-close');
    }
  }

  // ---- 4. Показатели за 7 суток на 1024: подписи графиков, штриховка аварии, единица оси, длительности ----
  await chrome.viewport(1024, 768);
  for (const theme of THEMES) {
    await setTheme(theme);
    await click('#nav-stats'); await ready('.ps-period'); await sleep(450);
    await evaluate(`document.querySelector('.ps-period button:nth-child(3)').click()`);
    await chrome.waitFor(`document.querySelectorAll('.chart').length >= 2`, { what: 'графики' }); await sleep(600);
    const c = await evaluate(`(() => {
      const fs = [...document.querySelectorAll('.chart text')].map((x) => { const svg = x.ownerSVGElement; return [x.textContent, parseFloat(getComputedStyle(x).fontSize) * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width]; });
      const center = [...document.querySelectorAll('.chart .center')].map((x) => parseFloat(getComputedStyle(x).fontSize) * x.ownerSVGElement.getBoundingClientRect().width / x.ownerSVGElement.viewBox.baseVal.width);
      const donut = document.querySelector('.donut');
      const hatch = donut ? donut.querySelectorAll('.hatch').length : 0;
      const fail = donut ? donut.querySelectorAll('.z-failure').length : 0;
      const pat = donut ? donut.querySelectorAll('pattern').length : 0;
      const box = (x) => x.getBoundingClientRect();
      const unit = [...document.querySelectorAll('.chart text')].find((x) => x.textContent === 'ч' && x.classList.contains('unit'));
      const top = [...document.querySelectorAll('.chart text')].find((x) => x.textContent === '24');
      const a = unit && box(unit), b = top && box(top);
      const gap = a && b ? b.top - a.bottom : null;
      const inner = donut ? (() => { const t = donut.querySelector('.center'); const bb = t.getBBox(); return bb.width; })() : 0;
      return { fonts: fs.map((x) => x[1]), center, hatch, fail, pat, gap, inner,
        durations: [...document.querySelectorAll('.ps-bar__val, .ps-zrow__val, .ps-notice__body')].map((x) => x.textContent) };
    })()`);
    ok(c.fonts.length > 0 && c.fonts.every((f) => f >= 12.95), `графики ${theme}: подпись ${Math.min(...c.fonts)} px`);
    ok(c.center.length > 0 && c.center.every((f) => f >= 12.95), `кольцо ${theme}: центр ${c.center} px`);
    ok(c.fail >= 2 && c.hatch >= 2 && c.pat === 1, `штриховка аварии ${theme}: сектор/образец ${c.fail}, штриховок ${c.hatch}, паттернов ${c.pat}`);
    ok(c.gap !== null && c.gap >= 1, `единица оси «ч» касается «24»: зазор ${c.gap}`);
    ok(c.inner <= 2 * (80 - 24) - 6, `текст в центре кольца шире отверстия: ${c.inner}`);
    ok(c.durations.every((x) => !/\d м(\s|$|·)/.test(x)), `длительности вне плиток с «м»: ${c.durations.filter((x) => /\d м(\s|$|·)/.test(x))}`);
    await evaluate(`document.querySelector('.donut')?.scrollIntoView({ block: 'center' })`); await sleep(300);
    await shot(`показатели-7суток-1024-${theme}`);
    // Цвет значений — чернила, не цвет состояния
    const colors = await evaluate(`(() => {
      const probe = document.createElement('i'); probe.style.color = 'var(--ink)'; document.body.append(probe);
      const ink = getComputedStyle(probe).color; probe.remove();
      return { ink, values: [...document.querySelectorAll('.ps-kpi[data-tone] .ps-kpi__value')].map((x) => getComputedStyle(x).color) };
    })()`);
    ok(colors.values.length >= 2 && colors.values.every((v) => v === colors.ink), `значения показателей ${theme} не нейтральные: ${JSON.stringify(colors)}`);
  }

  // ---- 5. Администратор: переключатель рассылки нейтральный; вкладки на телефоне — сетка 2×2 без прокрутки ----
  for (const theme of THEMES) {
    await setTheme(theme);
    await chrome.viewport(1280, 800); await sleep(250);
    await click('#admin'); await ready('.ps-admin .ps-card');
    await clickText('.ps-subnav__item', 'Рассылка');
    await clickText('.ps-admin button', 'Добавить получателя');
    const sw = await evaluate(`(() => {
      const probe = document.createElement('i'); probe.style.color = 'var(--ink)'; document.body.append(probe);
      const ink = getComputedStyle(probe).color; probe.remove();
      const s = document.querySelector('.ps-switch[aria-checked="true"]');
      return s ? { ink, border: getComputedStyle(s).borderColor, knob: getComputedStyle(s.querySelector('.ps-switch__knob')).backgroundColor } : null;
    })()`);
    ok(sw && sw.border === sw.ink && sw.knob === sw.ink, `переключатель ${theme} не нейтральный: ${JSON.stringify(sw)}`);
    await shot(`рассылка-переключатель-1280-${theme}`);
    for (const w of [320, 375, 480]) {
      await chrome.viewport(w, 720); await sleep(300);
      const nav = await evaluate(`(() => {
        const n = document.querySelector('.ps-subnav'); const items = [...n.querySelectorAll('.ps-subnav__item')].map((i) => i.getBoundingClientRect());
        return { scroll: n.scrollWidth <= n.clientWidth + 1, rows: new Set(items.map((b) => Math.round(b.top))).size, count: items.length, minH: Math.min(...items.map((b) => b.height)), maxRight: Math.max(...items.map((b) => b.right)), vw: innerWidth };
      })()`);
      ok(nav.scroll && nav.maxRight <= nav.vw, `вкладки админа ${w} ${theme}: горизонтальная прокрутка`);
      ok(nav.rows === 2 && nav.count === 4, `вкладки админа ${w} ${theme}: строк ${nav.rows} при ${nav.count} вкладках`);
      ok(nav.minH >= 44, `вкладки админа ${w}: высота ${nav.minH}`);
      if (w === 320) await shot(`админ-вкладки-320-${theme}`);
    }
    await chrome.viewport(1280, 800); await sleep(200);
    await click('#demo'); await ready('.pult');
  }

  // ---- 6. Сдача смены при работающем стане: поле записки следующей смене ----
  for (const theme of THEMES) {
    await setTheme(theme);
    await chrome.viewport(1280, 800); await sleep(250);
    await clickText('.ps-btn, button', 'Сдать смену'); await ready('.ps-flow');
    await clickText('.ps-btn', 'Да, работает'); await ready('#close-action'); await sleep(250);
    ok(await evaluate(`!!document.querySelector('#close-action') && /Что сделали по ремонту за смену и что осталось/.test(document.body.textContent)`), `сдача смены ${theme}: нет поля записки`);
    await shot(`сдача-смены-работает-1280-${theme}`);
    await click('#demo'); await ready('.pult');
  }

  assert.deepEqual([...new Set(problems)], []);
  assert.ok(fs.readdirSync(SHOTS).length >= 18);
});
