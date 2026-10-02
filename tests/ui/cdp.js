// Управление своим headless Chrome через DevTools Protocol (Node 22+: готовый WebSocket).
// Chrome запускается со своим --user-data-dir во временной папке и своим портом отладки (порт 0 —
// свободный, его Chrome пишет в DevToolsActivePort): чужие браузеры и вкладки не затрагиваются.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const CHROME = process.env.STAN_TEST_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Соединение с целью DevTools: send(метод, параметры) и подписка on(обработчик события). */
export function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("Не удалось подключиться к " + url)), { once: true });
  });
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (waiter) message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { opened, send, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn), close: () => ws.close() };
}

/** Запускает Chrome и подключается к странице и к самому браузеру (для скачивания файлов). */
export async function startChrome({ profileRoot = os.tmpdir(), extraArgs = [] } = {}) {
  if (!fs.existsSync(CHROME)) throw new Error("Chrome не найден: " + CHROME);
  const profile = fs.mkdtempSync(path.join(profileRoot, "stan-report-chrome-"));
  const child = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--lang=ru-RU",
    ...extraArgs, "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  const active = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 150 && !fs.existsSync(active); i++) await sleep(100);
  if (!fs.existsSync(active)) throw new Error("Chrome не открыл порт отладки");
  const [port, browserPath] = fs.readFileSync(active, "utf8").split("\n");
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = targets.find((target) => target.type === "page");
    if (!page) await sleep(100);
  }
  const tab = connect(page.webSocketDebuggerUrl);
  const browser = connect(`ws://127.0.0.1:${port}${browserPath}`);
  await Promise.all([tab.opened, browser.opened]);

  const consoleLog = [];
  tab.on((m) => {
    if (m.method === "Runtime.exceptionThrown") consoleLog.push({ kind: "exception", text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
    if (m.method === "Log.entryAdded") consoleLog.push({ kind: "log:" + m.params.entry.level, text: m.params.entry.text, url: m.params.entry.url });
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      consoleLog.push({ kind: "console:" + m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    }
  });
  await tab.send("Runtime.enable");
  await tab.send("Log.enable");
  await tab.send("Page.enable");
  await tab.send("Network.enable");

  const api = {
    child, profile, tab, browser, consoleLog,
    send: tab.send,
    async evaluate(expression) {
      const r = await tab.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, { timeout = 10000, what = expression } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await api.evaluate(expression)) return;
        await sleep(60);
      }
      throw new Error(`Не дождались: ${what}\nЭкран: ${await api.evaluate("document.body.innerText.slice(0, 600)")}`);
    },
    async viewport(width, height, { mobile = width <= 480 } = {}) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await sleep(120);
    },
    async mouse(x, y, { press = true } = {}) {
      await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (!press) return;
      await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    },
    /** Нажатие по центру элемента (настоящие события мыши: pointerdown, click). */
    async clickElement(selector) {
      const box = await api.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error("Нет элемента " + selector);
      await api.mouse(box.x, box.y);
    },
    async key(key, code = key, keyCode = 0) {
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    },
    /** Переход на адрес и ожидание загрузки страницы. */
    async navigate(url) {
      const loaded = new Promise((resolve) => {
        const fn = (m) => { if (m.method === "Page.loadEventFired") { tab.off(fn); resolve(); } };
        tab.on(fn);
      });
      await tab.send("Page.navigate", { url });
      await Promise.race([loaded, sleep(15000)]);
    },
    async reload() {
      const loaded = new Promise((resolve) => {
        const fn = (m) => { if (m.method === "Page.loadEventFired") { tab.off(fn); resolve(); } };
        tab.on(fn);
      });
      await tab.send("Page.reload");
      await Promise.race([loaded, sleep(15000)]);
    },
    /** Нажатие по центру первого элемента селектора, в тексте которого есть подстрока. */
    async clickText(selector, text) {
      const box = await api.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) return null; e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error("Нет элемента " + selector + " с текстом «" + text + "»");
      await api.mouse(box.x, box.y);
    },
    async screenshot(file) {
      const shot = await tab.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    },
    async stop() {
      try { await browser.send("Browser.close"); } catch { /* уже закрыт */ }
      tab.close();
      browser.close();
      for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
      if (child.exitCode === null) child.kill();
      for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
  return api;
}
