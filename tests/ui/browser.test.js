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
  const app = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', now: () => new Date(now), aiConfig: { apiKey: 'sk-test', model: 'test', baseUrl: 'https://ai.example.test', dailyUsd: 1, priceIn: 0.3, priceOut: 1.2 } });
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
  await send('Runtime.evaluate', { expression: `document.querySelector('.ps-action--stop')?.click()` });
  assert.equal(app.db.prepare("SELECT count(*) n FROM events WHERE type = 'stop'").get().n, 0, 'Второй тап после приёма не останавливает стан');
  await wait(`document.querySelector('.pult') && JSON.parse(localStorage.getItem('stan.queue')).length === 0`);
  await post([0, 1, 2].map((i) => ({ id: `short${i}`, type: 'manual', at: new Date(now).toISOString(),
    from: new Date(now - 3600000 + i * 60000).toISOString(), to: new Date(now - 3600000 + i * 60000 + 20000).toISOString() })));
  // Перезагрузка проверяет и очистку старых квитанций, и отдельное хранение очереди.
  const seedRecords = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const s = JSON.parse(localStorage.getItem('stan.session.v1'));
    s.records = Array.from({length:1000}, (_,i) => ({event:{id:'old'+i, type:'manual', at:new Date(Date.now()).toISOString()}, status:'saved'}));
    localStorage.setItem('stan.session.v1', JSON.stringify(s));
  })()` });
  await send('Page.reload');
  await wait(`document.querySelector('.pult') && document.querySelector('.ds-legend__item:has(.z-unplanned) .ds-legend__val')?.textContent === '1 мин'`);
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
  // «Спросить ассистента»: ключ владельца видит кнопку, она открывает отдельный экран с карточкой ИИ и ставит фокус в поле
  await wait(`document.querySelector('#ai-ask') && !document.querySelector('#ai-ask').hidden`);
  assert.equal(await evaluate(`document.querySelector('#ai-ask').getAttribute('aria-label')`), 'Спросить ассистента');
  await evaluate(`document.querySelector('#ai-ask').click()`);
  await wait(`document.querySelector('#main .ai-card .ai-input')`);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.ai-input')`), true);
  assert.equal(await evaluate(`document.querySelector('#ai-ask').classList.contains('is-on')`), true);
  assert.match(await evaluate(`document.querySelector('#main h1').textContent`), /Спросить ассистента/);
  assert.equal(await evaluate(`document.querySelector('#admin').querySelector('.pill-text') !== null && !document.querySelector('#main .adm-card:not(.ai-card)')`), true);
  await evaluate(`document.querySelector('#demo').click()`);
  await wait(`!document.querySelector('.ai-card')`);
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
      await evaluate(`document.querySelector('.ps-action--stop').click()`);
      await wait(`!document.querySelector('.pult')`);
      await wait(`document.querySelector('#toast').textContent.includes('Стан уже остановлен с 22:59')`);
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).draft.wz?.downtimeId`), 'remote-stop');
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stan.session.v1')).records.some(r=>r.status==='rejected')`), false);
      await evaluate(`document.querySelector('#demo').click()`);
      await wait(`document.querySelector('.ps-state[data-state="stop"]')`);
    }
    for (const [width, height] of [[320, 720], [375, 812], [600, 800], [768, 1024], [820, 900], [1100, 700], [1200, 800], [1600, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(60);
      if (width === 320 && state === 'running') {
        const ax = await send('Accessibility.getFullAXTree');
        for (const name of ['Администратор', 'Спросить ассистента', 'Связаться', 'Пульт', 'Простои за смену', 'Показатели стана', 'Переключить на светлую тему']) {
          assert.ok(ax.nodes.some((n) => n.role?.value === 'button' && n.name?.value === name), `Доступное имя: ${name}`);
        }
      }
      const sizes = await evaluate(`(() => {
        const h = document.querySelector('.topbar');
        const b = document.querySelector('.ps-action'), l = b.querySelector('.ps-action__label'), lamp = b;
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, header: h.scrollWidth, client: h.clientWidth,
          label: l.getBoundingClientRect().width, lamp: lamp.getBoundingClientRect().width, lampHeight: lamp.getBoundingClientRect().height, labelScroll: l.scrollWidth, labelClient: l.clientWidth };
      })()`);
      results.push({ state, width, height, ...sizes });
      assert.ok(sizes.page <= width, JSON.stringify(results.at(-1)));
      assert.ok(sizes.header <= sizes.client, JSON.stringify(results.at(-1)));
      if (state === 'stopped') {
        assert.ok(sizes.label <= sizes.lamp + 1, JSON.stringify(results.at(-1)));
        assert.ok(sizes.labelScroll <= sizes.labelClient, JSON.stringify(results.at(-1)));
        assert.ok(sizes.lampHeight >= 64, JSON.stringify(results.at(-1)));
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
  await wait(`document.querySelector('.pult')`);
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
  // Отказы хранятся на планшете, но не забирают высоту клавиш пульта.
  const layouts = [];
  const sizesToCheck = [[1280,800], [1366,768], [1920,1080], [2560,1080], [768,1024], [390,844]];
  await post([{ id: 'layout-start', type: 'start', downtimeId: 'remote-stop', at: new Date(now).toISOString() }]);
  for (const state of ['running', 'stopped']) {
    if (state === 'stopped') await post([{ id: 'layout-stop', type: 'stop', at: new Date(now).toISOString(),
      reason: 'avaria', note: 'Длинная заметка о замене подшипника. '.repeat(13) }]);
    for (const count of [0, 1, 3]) {
      const layoutSeed = await send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
        const s = JSON.parse(localStorage.getItem('stan.session.v1'));
        s.records = s.records.filter(r=>!r.event.id.startsWith('layout-reject'));
        s.records.push(...Array.from({length:${count}},(_,i)=>({event:{id:'layout-reject'+i,type:'fix',downtimeId:'missing'+i,index:0,at:new Date(Date.now()).toISOString(),note:'Ответ сохранён'},status:'rejected',error:'not_found'})));
        s.draft = {screen:'auto'};
        localStorage.setItem('stan.session.v1',JSON.stringify(s));
      })()`});
      await send('Page.reload'); await wait(`document.querySelector('.pult') && document.querySelector('#save-status').classList.contains('${count ? 'waiting' : 'online'}')`);
      await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:layoutSeed.identifier});
      for (const [width, height] of sizesToCheck) {
        await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false}); await sleep(130);
        const layout = await evaluate(`(() => {
          const keys = [...document.querySelectorAll('.ps-action')].map(b=>{
            const r=b.getBoundingClientRect(), lamp=r;
            return {height:r.height,lamp:lamp.height,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.ps-action')===b};
          });
          const tok=n=>{const p=document.createElement('i');p.style.background='var(--'+n+')';document.body.append(p);const c=getComputedStyle(p).backgroundColor;p.remove();return c;};
          const st=document.querySelector('#save-status'), txt=st.querySelector('.save-status-text').getBoundingClientRect();
          return {keys,page:document.documentElement.scrollWidth,statusColor:getComputedStyle(st,'::before').backgroundColor,expectColor:tok(${count ? "'warn'" : "'run'"}),
            count:st.querySelector('.save-status-count').textContent,textWidth:txt.width,
            touch:[...document.querySelectorAll('.topbar button')].filter(b=>!b.hidden).map(b=>{const r=b.getBoundingClientRect();return [r.width,r.height]})};
        })()`);
        layouts.push({state,count,width,height,...layout});
        assert.ok(layout.keys.every(k=>k.hit && k.height>=44 && k.lamp>35), JSON.stringify(layouts.at(-1)));
        assert.ok(layout.page<=width, JSON.stringify(layouts.at(-1)));
        assert.equal(layout.statusColor, layout.expectColor);
        assert.equal(layout.count, String(count));
        if (width===768) assert.ok(layout.textWidth>30);
        if (width===390) assert.ok(layout.touch.every(([w,h])=>w>=44 && h>=44), JSON.stringify(layout.touch));
        if (count===3 && [1366,390].includes(width)) {
          const shot=await send('Page.captureScreenshot',{format:'png'});
          fs.writeFileSync(path.join(root,`Раунд 2 ${state} ${width}.png`),Buffer.from(shot.data,'base64'));
        }
      }
    }
  }
  for (const state of ['running','stopped']) for (const [width] of sizesToCheck) {
    const own=layouts.filter(x=>x.state===state && x.width===width);
    assert.ok(Math.max(...own.map(x=>x.keys[0].height))-Math.min(...own.map(x=>x.keys[0].height))<2, JSON.stringify(own));
  }
  // Открытие/закрытие панели по индикатору, мобильное предупреждение и красный офлайн.
  await evaluate(`document.querySelector('#save-status').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#rejects')).display==='none'`),false);
  await evaluate(`[...document.querySelectorAll('#rejects button')].find(b=>b.textContent==='Закрыть список').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#rejects')).display`),'none');
  await click('Открыть полную запись'); await click('Брак');
  for (const value of ['1001','']) {
    await evaluate(`document.querySelector('#billet-value').value=${JSON.stringify(value)}`); await click('Сохранить');
    assert.match(await evaluate(`document.querySelector('#toast').textContent`),/от 0 до 1000 тн/);
    const toast=await evaluate(`(()=>{const t=document.querySelector('#toast'),r=t.getBoundingClientRect(),b=document.querySelector('#main .primary').getBoundingClientRect();return {warning:t.classList.contains('warning'),pointer:getComputedStyle(t).pointerEvents,width:r.width,viewport:document.documentElement.clientWidth,overlap:r.bottom>b.top && r.top<b.bottom};})()`);
    assert.equal(toast.warning,true); assert.equal(toast.pointer,'none'); assert.equal(toast.width,toast.viewport); assert.equal(toast.overlap,false);
  }
  await evaluate(`document.querySelector('#demo').click()`);
  await send('Network.enable');
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  await wait(`document.querySelector('#save-status').classList.contains('offline')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#save-status'),'::before').backgroundColor`), await evaluate(`(()=>{const p=document.createElement('i');p.style.background='var(--stop)';document.body.append(p);const c=getComputedStyle(p).backgroundColor;p.remove();return c;})()`));
  await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:0,uploadThroughput:0});
  await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  await wait(`document.querySelector('#save-status').classList.contains('waiting')`);
  // Светлая тема: нулевые строки и неподключённые контакты остаются читаемыми.
  if (await evaluate(`document.documentElement.dataset.theme`)!=='light') await evaluate(`document.querySelector('#theme').click()`);
  assert.ok(await evaluate(`[...document.querySelectorAll('.ds-legend__item--zero')].every(x=>Number(getComputedStyle(x).opacity)>=.7)`));
  const contrast = async selector => evaluate(`(()=>{
    const x=document.querySelector(${JSON.stringify(selector)}),rgb=getComputedStyle(x).color.match(/[0-9.]+/g).slice(0,3).map(Number);
    const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const l=lum(rgb);return [lum([238,241,244]),lum([244,246,248])].map(bg=>(Math.max(l,bg)+.05)/(Math.min(l,bg)+.05));
  })()`);
  assert.ok((await contrast('.ds-legend__item--zero')).every(c=>c>=4.5));
  await evaluate(`document.querySelector('#conn').click()`);
  assert.ok((await contrast('.ps-contact[aria-disabled="true"] .ps-contact__phone')).every(c=>c>=4.5));
  assert.ok((await contrast('.ps-contact[aria-disabled="true"] .ps-contact__name')).every(c=>c>=4.5));
  await evaluate(`document.querySelector('#demo').click()`);
  await send('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false}); await sleep(200);
  assert.ok(await evaluate(`[...document.querySelectorAll('.ds-row__label')].filter(x=>x.textContent).every(x=>getComputedStyle(x).overflow==='visible' && x.getBoundingClientRect().height>=parseFloat(getComputedStyle(x).lineHeight))`));
  const lightShot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(root,'Раунд 2 светлая тема 1366.png'),Buffer.from(lightShot.data,'base64'));
  await click('Показатели стана'); await click('7 суток'); await wait(`document.querySelector('.chart:not(.donut)')`);
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:740,deviceScaleFactor:1,mobile:false}); await sleep(250);
  const chartFonts=await evaluate(`[...document.querySelectorAll('.chart text')].map(x=>parseFloat(getComputedStyle(x).fontSize)*x.ownerSVGElement.getBoundingClientRect().width/x.ownerSVGElement.viewBox.baseVal.width)`);
  assert.ok(chartFonts.length && Math.min(...chartFonts)>=10,JSON.stringify(chartFonts));
  assert.equal(await evaluate(`document.querySelectorAll('.m-fill.neutral').length`),0);
  // Две настоящие вкладки одного профиля. Вторая намеренно пропускает storage,
  // затем записывает устаревший экран: чтение+слияние перед записью сохраняет удаление.
  const second = await send('Target.createTarget', { url: 'about:blank' });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const peer = new WebSocket(targets.find(x=>x.id===second.targetId).webSocketDebuggerUrl);
  await new Promise(r=>peer.addEventListener('open',r,{once:true}));
  let peerSeq=0; const peerPending=new Map();
  peer.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){const p=peerPending.get(m.id);peerPending.delete(m.id);if(p)m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const peerSend=(method,params={})=>new Promise((resolve,reject)=>{const id=++peerSeq;peerPending.set(id,{resolve,reject});peer.send(JSON.stringify({id,method,params}));});
  const peerEval=async expression=>(await peerSend('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
  await peerSend('Page.enable');
  await peerSend('Page.addScriptToEvaluateOnNewDocument',{source:`Date.now=()=>${now}; window.addEventListener('storage',e=>e.stopImmediatePropagation(),true);`});
  await peerSend('Page.navigate',{url:origin+'/#key=k1'});
  for(let i=0;i<100 && !(await peerEval(`document.querySelectorAll('#rejects .reject').length===3`));i++) await sleep(50);
  await sleep(300);
  assert.equal(await peerEval(`document.querySelectorAll('#rejects .reject').length`),3);
  await evaluate(`document.querySelector('#save-status').click()`);
  await evaluate(`[...document.querySelectorAll('#rejects .reject button')].find(b=>b.textContent==='Убрать запись').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#rejects .reject').length`),2);
  assert.equal(await peerEval(`document.querySelectorAll('#rejects .reject').length`),3);
  await sleep(425); await peerEval(`document.querySelector('#demo').click()`);
  assert.equal(await peerEval(`document.querySelectorAll('#rejects .reject').length`),2);
  assert.equal(await evaluate(`document.querySelectorAll('#rejects .reject').length`),2);
  await send('Target.closeTarget',{targetId:second.targetId}); peer.close();
  // Ключ без права администратора: кнопки «Спросить ассистента» нет совсем
  const guest = createApp({ dataDir: ':memory:', deviceKeys: 'a:k1,b:k2', adminDevices: ['a'], now: () => new Date(now) });
  await new Promise((r) => guest.server.listen(0, '127.0.0.1', r));
  try {
    await send('Page.navigate', { url: `http://127.0.0.1:${guest.server.address().port}/#key=k2` });
    await wait(`Object.keys(localStorage).some(k => /refs/i.test(k) && localStorage.getItem(k).includes('"canAdmin":false'))`);
    await sleep(500);
    assert.equal(await evaluate(`document.querySelector('#ai-ask').hidden && document.querySelector('#admin').hidden`), true);
  } finally { await guest.close(); }
  fs.writeFileSync(path.join(root,'Раунд 2 пульт и связь.json'),JSON.stringify(layouts,null,2));
  // Ошибки HTTP во время намеренного офлайна ожидаемы; исключения JS и нарушения CSP запрещены.
  for (let i=errors.length-1;i>=0;i--) if (/ERR_INTERNET_DISCONNECTED|Failed to fetch/i.test(errors[i])) errors.splice(i,1);
  assert.equal(errors.length, 0, errors.join('\n'));
  fs.writeFileSync(path.join(root, 'Проверка интерфейса.json'), JSON.stringify({ results, errors }, null, 2));
  // Browser.close закрывает все процессы нашего отдельного профиля.
  await send('Browser.close').catch(() => {});
});
