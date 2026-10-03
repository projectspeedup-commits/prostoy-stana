// Симулятор планшета: текущий реальный app.js в обёртке с заглушками DOM, localStorage, сети и часов.
// app.js не изменяется: код читается с диска и исполняется как есть; в конец дописывается только return с «ручками».
import fs from "node:fs";
import http from "node:http";
import * as core from "../../app/core/core.js";
import * as zones from "../../app/core/zones.js";
import * as queueTools from "../../app/public/queue.js";

const APP_JS = new URL("../../app/public/app.js", import.meta.url);
const SRC = fs.readFileSync(APP_JS, "utf8");

class TextNode { constructor(t) { this.t = String(t); } get textContent() { return this.t; } }
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.style = { cssText: "" };
    this.dataset = {}; this.className = ""; this._text = ""; this.hidden = false; this.handlers = {}; this.value = ""; this.disabled = false;
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  append(...k) { for (const x of k) { if (x === null || x === undefined || x === false) continue; this.children.push(x instanceof El || x instanceof TextNode ? x : new TextNode(x)); } }
  replaceChildren(...k) { this.children = []; this._text = ""; this.append(...k); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "disabled") this.disabled = true; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); }
  querySelector() { return new El("x"); }
  querySelectorAll() { return []; }
  contains() { return false; }
  focus() {} setSelectionRange() {} scrollIntoView() {}
}
export const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
export function findAll(el, pred, acc = []) {
  if (!el || el instanceof TextNode) return acc;
  if (pred(el)) acc.push(el);
  for (const c of el.children) findAll(c, pred, acc);
  return acc;
}

export function makeTablet({ name, key, clock, skew = 0, storage = new Map(), seedKey = true, port }) {
  const net = { offline: false, dropResponse: false, held: null, log: [], count: 0 };
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, new El("div")); return els.get(id); };
  const document = {
    getElementById: getEl, createElement: (t) => new El(t), createElementNS: (ns, t) => new El(t), querySelectorAll: () => [],
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }, handlers: {}, activeElement: null, visibilityState: "visible",
  };
  const location = { hostname: "localhost", search: "", hash: "", pathname: "/" };
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  if (seedKey && key) storage.set("stan.deviceKey", key);
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.t + skew); else super(...a); }
    static now() { return clock.t + skew; }
  }
  // Сеть: реальный HTTP к локальному серверу; офлайн / потерянный ответ / удержание пакета
  const realRequest = (rel, opts) => new Promise((resolve, reject) => {
    const payload = opts.body;
    const req = http.request({
      host: "127.0.0.1", port, path: "/" + rel, method: opts.method || "GET", agent: false,
      headers: { ...(opts.headers || {}), Connection: "close", ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const textBody = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: async () => JSON.parse(textBody) });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const fetchStub = async (rel, opts = {}) => {
    net.count++;
    const entry = { rel, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null, at: clock.t };
    net.log.push(entry);
    if (net.offline) { entry.result = "offline"; throw new TypeError("Failed to fetch"); }
    if (net.held && entry.rel.startsWith("api/events")) {
      // пакет «в пути»: уйдёт на сервер только после release()
      return new Promise((resolve, reject) => {
        net.held.push({ go: async () => { try { const r = await realRequest(rel, opts); entry.result = r.status; resolve(r); } catch (e) { reject(e); } } });
      });
    }
    const r = await realRequest(rel, opts);
    entry.result = r.status;
    if (net.dropResponse) { entry.result += " (ответ потерян)"; throw new TypeError("Failed to fetch"); }
    return r;
  };

  const header = `"use strict";\nconst {${Object.keys(queueTools).join(",")}} = queueTools;\n`;
  let code = SRC
    .replace(/^import .*$/gm, "")        // импорты подставлены параметрами
    .replace(/^boot\(\);\s*$/m, "");      // запуск вручную
  code = header + code + `
;return {
  get records() { return records; }, set records(v) { records = v; },
  get queue() { return queue; }, set queue(v) { queue = v; },
  get serverState() { return serverState; }, get refs() { return refs; }, get ui() { return ui; },
  get online() { return online; }, get key() { return key; }, get flushing() { return flushing; },
  get toasts() { return __toasts; },
  api: (...a) => api(...a),
  flush, loadState, loadRefs, buildView, applyEvent, send, sendBatch, queueEvent, acceptState, settleRejected, dismissRejected,
  submitRepair, finishReasonWizard, finishRestart, saveForgottenStop, doCloseShift, acceptShift, restartMatches, needCrew,
  shiftSummary, shiftDowntimes, shiftWorkMin, handoverGaps, manualError, forgottenTimeError, restartNeedsBillet, validBillet,
  receiptStatus, receiptFor, renderRejects, render, renderTopbar, go, nowMs, persistClient, shiftCloseEvents, eventTitle, humanError,
  renderRepair, renderScreen, startRestartReasonWizard, cancelDraft, closeActionDraft, runningSince, newRestart, renderRestartAction, renderStop, renderRun, renderCloseCheck, renderManual,
  groupFor, transferButton, conflictTarget, loadStats, renderShift, renderStats, renderClosed, resetStopDrafts,
  renderFio, mergeStored, armShiftTimer, renderDetail, renderCloseConfirm, renderCrew, shiftBlock, openDetail, renderHandoverCard, startManualWizard, cardData,
  needsNote, shiftBillet, fmtHM, fmtDurMin, fmtDurLong, fmtLen, forgottenTimeFields, shiftKpis, shiftZoneMinutes, renderAdmin, renderAi, aiCard, askAi, saveAdmin, adminDraft, loadAdmin, adminProblems, metrics, loadAiStatus, renderRecorded, renderManualCheck, renderForgotStop, renderKey, renderNoRefs, renderLoading, renderRestartTime, renderRestartConfirm, renderConfirmChange, renderStaleRestart, renderRepairField, aiUi,
};`;
  // перехват тостов: showToast пишет в элемент #toast; соберём в массив
  code = code.replace("let toastTimer = null;", "let toastTimer = null; const __toasts = [];")
             .replace("t.textContent = text;", "t.textContent = text; __toasts.push(text);");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("core", "zoneOf", "dayCells", "dayChart", "donut", "dayScale",
    "queueTools", "setTimeout", "clearTimeout", "document", "window", "location", "localStorage", "history", "navigator", "setInterval", "clearInterval", "fetch", "Date", code);
  const windowStub = { scrollTo() {}, addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }, handlers: {} };
  const historyStub = { replaceState() {} };
  const timers = [];
  const build = async () => fn(core, zones.zoneOf, zones.dayCells, () => null, () => null, () => null,
    queueTools, (fn, delay) => { timers.push({fn, delay}); return timers.length; }, () => {}, document, windowStub, location, localStorage, historyStub, {}, () => 0, () => {}, fetchStub, FakeDate);
  return { build, net, els, storage, document, name, timers, window: windowStub };
}

// Запуск планшета: реальный boot() без таймеров
export async function bootTablet(opts) {
  const t = makeTablet(opts);
  const h = await t.build();
  Object.assign(t, { h });
  t.boot = async () => { await h.loadRefs(); await h.loadState(); };
  t.rejectsBox = () => { h.renderRejects(); const box = t.els.get("rejects"); return { hidden: box.hidden, cards: findAll(box, (e) => e.className === "reject").map(text), buttons: findAll(box, (e) => e.tagName === "BUTTON").map(text) }; };
  t.click = (root, label) => {
    const btn = findAll(root, (e) => e.tagName === "BUTTON" && text(e).includes(label))[0];
    if (!btn) throw new Error("кнопка не найдена: " + label + " | есть: " + findAll(root, (e) => e.tagName === "BUTTON").map(text).join(" ; "));
    for (const f of btn.handlers.click || []) f({ currentTarget: btn, target: btn });
    return btn;
  };
  // имитация таймера setInterval(flush, 10 с): дождаться текущей отправки и отправить остаток
  t.pump = async (n = 4) => { for (let i = 0; i < n; i++) { for (let w = 0; w < 50 && h.flushing; w++) await new Promise((r) => setTimeout(r, 10)); if (!h.queue.length || t.net.offline) break; await h.flush(); await new Promise((r) => setTimeout(r, 20)); } };
  t.main = () => t.els.get("main");
  t.screen = () => { h.renderScreen(); return text(t.els.get("main")); };
  t.release = async () => { const held = net_held_take(t); for (const x of held) await x.go(); };
  return t;
}
function net_held_take(t) { const arr = t.net.held || []; t.net.held = null; return arr; }
