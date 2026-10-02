import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../../app/server/index.js';

const chrome = process.env.STAN_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('UI: выбор ночной смены, квитанции, темы, шапка и пульт 320–1600 px', { timeout: 180000, skip: !fs.existsSync(chrome) }, async (t) => {
  const root = path.resolve(import.meta.dirname, '../../private');
  fs.mkdirSync(root, { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, 'chrome-qa-'));
  const now = Date.parse('2026-10-01T20:00:00Z');
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(now) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (events) => {
    const response = await fetch(origin + '/api/events', { method: 'POST', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ events }) });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.rejected.length, 0);
    return result;
  };
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let ws;
  t.after(async () => {
    ws?.close();
    child.kill();
    await app.close();
    for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
    assert.equal(path.dirname(profile), root);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const active = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(active); i++) await sleep(100);
  const port = fs.readFileSync(active, 'utf8').split('\n')[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(tabs.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (p) m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    if (expression.includes(".click()")) await sleep(425);
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`Ожидание: ${expression}; экран: ${await evaluate('document.body.innerText.slice(0,1500)')}`);
  };
  const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('#main button')].find(b => b.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('Нет кнопки'); b.click(); })()`);
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${now};` });
  await send('Page.navigate', { url: origin + '/#key=k1' });
  await wait(`document.querySelector('.current-shift')`);
  assert.match(await evaluate(`document.querySelector('.current-shift').textContent`), /Смена 2/);
  await click('Смена 1');
  await wait(`document.querySelector('#main').textContent.includes('Принять Смену 1?')`);
  assert.match(await evaluate(`document.querySelector('#main').textContent`), /Сейчас идёт Смена 2 \(20:00–08:00\)/);
  await click('Принять выбранную смену');
  assert.match(await evaluate(`document.querySelector('#main').textContent`), /Смена 1 · по расписанию 08:00–20:00/);
  await click('К выбору смены');
  await click('Смена 2');
  await evaluate(`document.querySelector('#main .tiles button').click()`);
  await sleep(150);
  await send('Runtime.evaluate', { expression: `document.querySelector('.mill-stop')?.click()` });
  assert.equal(app.db.prepare("SELECT count(*) n FROM events WHERE type = 'stop'").get().n, 0, 'Второй тап после приёма не останавливает стан');
  await wait(`document.querySelector('.mill-panel') && JSON.parse(localStorage.getItem('stan.queue')).length === 0`);
  await post([0, 1, 2].map((i) => ({ id: `short${i}`, type: 'manual', at: new Date(now).toISOString(),
    from: new Date(now - 3600000 + i * 60000).toISOString(), to: new Date(now - 3600000 + i * 60000 + 20000).toISOString() })));
  // Перезагрузка проверяет и очистку старых квитанций, и отдельное хранение очереди.
  const seedRecords = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const s = JSON.parse(localStorage.getItem('stan.session.v1'));
    s.records = Array.from({length:1000}, (_,i) => ({event:{id:'old'+i, type:'manual', at:new Date(Date.now()).toISOString()}, status:'saved'}));
    localStorage.setItem('stan.session.v1', JSON.stringify(s));
  })()` });
  await send('Page.reload');
  await wait(`document.querySelector('.mill-panel') && document.querySelector('.ds-legend__item:has(.z-unplanned) .ds-legend__val')?.textContent === '1 мин'`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).records.length`), 300);
  assert.equal(await evaluate(`Object.hasOwn(JSON.parse(localStorage.getItem('stan.session.v1')), 'queue')`), false);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedRecords.identifier });
  assert.match(await evaluate(`[...document.querySelectorAll('.shift-action')].find(x=>x.textContent.includes('Простои за смену')).textContent`), /1 мин/);
  await click('Показатели стана');
  await wait(`document.querySelector('.m-kpi')`);
  assert.equal(await evaluate(`document.querySelector('.board .board-stat.bad .v').textContent`), '1 м');
  assert.match(await evaluate(`document.querySelector('.m-kpi').textContent`), /1 мпростой/);
  await evaluate(`document.querySelector('#demo').click()`);
  await click('Простои за смену');
  assert.equal(await evaluate(`document.querySelector('.stats .stat.bad .v').textContent`), '1 мин');
  await evaluate(`document.querySelector('#demo').click()`);
  assert.equal(await evaluate(`document.querySelector('#admin').getAttribute('aria-label')`), 'Администратор');
  assert.equal(await evaluate(`document.querySelector('#admin').title`), 'Администратор');
  for (const [theme, pressed, label] of [['light', 'false', 'тёмную'], ['dark', 'true', 'светлую']]) {
    if (await evaluate(`document.documentElement.dataset.theme`) !== theme) await evaluate(`document.querySelector('#theme').click()`);
    assert.equal(await evaluate(`document.querySelector('#theme').getAttribute('aria-pressed')`), pressed);
    assert.match(await evaluate(`document.querySelector('#theme').getAttribute('aria-label')`), new RegExp(label));
  }
  const results = [];
  for (const state of ['running', 'stopped']) {
    if (state === 'stopped') {
      // Второй планшет уже остановил стан, первый ещё видит прежний снимок.
      await post([{ id: 'remote-stop', type: 'stop', at: new Date(now - 60000).toISOString() }]);
      await evaluate(`document.querySelector('.mill-stop').click()`);
      await wait(`!document.querySelector('.mill-panel')`);
      await wait(`document.querySelector('#toast').textContent.includes('Стан уже остановлен с 22:59')`);
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).draft.wz?.downtimeId`), 'remote-stop');
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).records.some(r=>r.status==='rejected')`), false);
      await evaluate(`document.querySelector('#demo').click()`);
      await wait(`document.querySelector('.mill-status.is-stop')`);
    }
    for (const [width, height] of [[320, 720], [375, 812], [600, 800], [768, 1024], [820, 900], [1100, 700], [1200, 800], [1600, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(60);
      if (width === 320 && state === 'running') {
        const ax = await send('Accessibility.getFullAXTree');
        for (const name of ['Администратор', 'Связаться', 'На главный экран', 'Переключить на светлую тему']) {
          assert.ok(ax.nodes.some((n) => n.role?.value === 'button' && n.name?.value === name), `Доступное имя: ${name}`);
        }
      }
      const sizes = await evaluate(`(() => {
        const h = document.querySelector('.topbar');
        const b = document.querySelector('.mill-stop'), l = b.querySelector('.mill-label'), lamp = b.querySelector('.mill-lamp');
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, header: h.scrollWidth, client: h.clientWidth,
          label: l.getBoundingClientRect().width, lamp: lamp.getBoundingClientRect().width, lampHeight: lamp.getBoundingClientRect().height, labelScroll: l.scrollWidth, labelClient: l.clientWidth };
      })()`);
      results.push({ state, width, height, ...sizes });
      assert.ok(sizes.page <= width, JSON.stringify(results.at(-1)));
      assert.ok(sizes.header <= sizes.client, JSON.stringify(results.at(-1)));
      if (state === 'stopped') {
        assert.ok(sizes.label <= sizes.lamp + 1, JSON.stringify(results.at(-1)));
        assert.ok(sizes.labelScroll <= sizes.labelClient, JSON.stringify(results.at(-1)));
        if (width >= 1100) assert.ok(sizes.lampHeight >= sizes.lamp * 0.5, JSON.stringify(results.at(-1)));
      }
      if (state === 'stopped' && [320, 768, 1100].includes(width)) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(root, `Пульт ${width}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  await click('Закрыть смену');
  await wait(`document.querySelector('#main').textContent.includes('Да, стоит')`);
  await click('Да, стоит');
  assert.match(await evaluate(`document.querySelector('#main').textContent`), /Закрытие смены ещё не отправлено/);
  assert.match(await evaluate(`document.querySelector('#main').textContent`), /Без причины: 3. Без «что сделали»: 3/);
  await evaluate(`document.querySelector('#admin').click()`);
  await wait(`document.querySelector('.adm-card')`);
  const admin = await (await fetch(origin + '/api/admin/settings', { headers: { 'X-Device-Key': 'k2' } })).json();
  admin.settings.contacts = [];
  const changed = await fetch(origin + '/api/admin/settings', { method: 'PUT', headers: { 'X-Device-Key': 'k2' }, body: JSON.stringify({ settings: admin.settings, refsVersion: admin.refsVersion }) });
  assert.equal(changed.status, 200);
  await evaluate(`(() => { const input = document.querySelector('.adm-grow input[maxlength="120"]'); input.value += 'а'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('Сохранить');
  await wait(`document.querySelector('#main').textContent.includes('Настройки уже изменили на другом устройстве. Обновите экран и повторите.')`);
  // Ожидаемый 409 фиксируется браузером как ошибка HTTP, это не JS/CSP-ошибка.
  const unexpected = errors.filter((e) => !e.includes('409'));
  assert.equal(unexpected.length, 0, unexpected.join('\n'));
  errors.length = 0;
  const migrate = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const s = JSON.parse(localStorage.getItem('stan.session.v1'));
    delete s.queueSeparated;
    s.queue = [{id:'legacy-queue', type:'shift_open', crewId:'2', at:new Date(Date.now()).toISOString()}];
    s.draft = {};
    localStorage.setItem('stan.session.v1', JSON.stringify(s));
    localStorage.setItem('stan.queue', '[]'); // оставшийся ключ старой версии не должен победить снимок
  })()` });
  await send('Page.reload');
  await wait(`JSON.parse(localStorage.getItem('stan.session.v1'))?.records.some(r=>r.event.id==='legacy-queue' && r.status==='saved')`);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: migrate.identifier });
  assert.equal(app.db.prepare("SELECT count(*) n FROM events WHERE id = 'legacy-queue'").get().n, 1);
  const seedRejected = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const s = JSON.parse(localStorage.getItem('stan.session.v1'));
    const row = (id, status, replaces, type='fix', downtimeId) => ({event:{id,type,downtimeId,at:new Date(Date.now()).toISOString()},status,replaces});
    s.records.push(row('copy','rejected',null,'stop','remote-stop'), row('root','rejected'), row('middle','rejected','root'),
      row('accepted-copy','saved','middle'), ...[1,2,3].map(i=>row('dismiss'+i,'rejected')));
    s.draft = {};
    localStorage.setItem('stan.session.v1',JSON.stringify(s));
  })()` });
  await send('Page.reload');
  await wait(`document.querySelectorAll('#rejects .reject').length === 3`);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedRejected.identifier });
  for (const id of ['copy', 'root', 'middle']) assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).records.find(r=>r.event.id===${JSON.stringify(id)}).status`), 'replaced');
  await evaluate(`[...document.querySelectorAll('#rejects .reject button')].find(b=>b.textContent==='Убрать запись').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#rejects .reject').length`), 2);
  await evaluate(`[...document.querySelectorAll('#rejects button')].find(b=>b.textContent==='Убрать все отклонённые записи (2)').click()`);
  assert.match(await evaluate(`document.querySelector('#rejects').textContent`), /Точно убрать 2 записей/);
  await evaluate(`[...document.querySelectorAll('#rejects button')].find(b=>b.textContent==='Точно убрать 2 записей?').click()`);
  assert.equal(await evaluate(`document.querySelector('#rejects').hidden`), true);
  for (const id of ['dismiss1', 'dismiss2', 'dismiss3']) assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).records.find(r=>r.event.id===${JSON.stringify(id)}).status`), 'dismissed');
  await send('Page.reload');
  await wait(`document.querySelector('.mill-panel')`);
  assert.equal(await evaluate(`document.querySelector('#rejects').hidden`), true);
  await click('Простои за смену');
  await evaluate(`document.querySelector('.segs button').click()`);
  await click('Брак');
  assert.equal(await evaluate(`document.querySelector('#billet-value').type`), 'text');
  await evaluate(`document.querySelector('#billet-value').value='1001'`);
  await click('Сохранить');
  assert.ok(await evaluate(`!!document.querySelector('#billet-value')`));
  await evaluate(`document.querySelector('#billet-value').value='2,5'`);
  await click('Сохранить');
  await wait(`document.querySelector('#main').textContent.includes('2,5 тн') && JSON.parse(localStorage.getItem('stan.queue')).length===0`);
  const billet = app.db.prepare("SELECT body FROM events WHERE type = 'fix' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(JSON.parse(billet.body).billet, 2.5);
  assert.equal(errors.length, 0, errors.join('\n'));
  fs.writeFileSync(path.join(root, 'Проверка интерфейса.json'), JSON.stringify({ results, errors }, null, 2));
  // Browser.close закрывает все процессы нашего отдельного профиля.
  await send('Browser.close').catch(() => {});
});
