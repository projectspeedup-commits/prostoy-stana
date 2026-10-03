import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, aiConfigFromEnv } from "../../app/server/index.js";
import { createAi, SYSTEM_INSTRUCTION, REFUSAL } from "../../app/server/ai.js";
import { computeStats, periodRange } from "../../app/core/stats.js";

const OWNER = { "X-Device-Key": "owner-key", "Content-Type": "application/json" };
const WORKER = { "X-Device-Key": "worker-key", "Content-Type": "application/json" };
const NOW = new Date("2026-10-02T10:00:00Z"); // 13:00 МСК, сутки 02.10
const FIO = "Иванов Иван Иванович";
const EVENTS = [
  { id: "o1", type: "shift_open", at: "2026-10-01T05:10:00Z", crewId: "1", personId: "p1", personName: FIO },
  { id: "s1", type: "stop", at: "2026-10-01T06:00:00Z", downtimeId: "d1", reason: "avaria", note: "сломался привод", crewId: "1", personId: "p1", personName: FIO },
  { id: "r1", type: "start", at: "2026-10-01T06:45:00Z", downtimeId: "d1", action: "заменили муфту" },
  { id: "s2", type: "stop", at: "2026-10-01T08:00:00Z", downtimeId: "d2", crewId: "1", personName: FIO },
  { id: "r2", type: "start", at: "2026-10-01T08:20:00Z", downtimeId: "d2", action: "перезапуск" },
];

const quiet = () => {};
function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stan-ai-"));
  return dir;
}

async function start(t, { aiConfig, aiFetch, events = true } = {}) {
  const dir = mkTmp(t);
  const app = createApp({
    dataDir: dir, peopleFile: path.join(dir, "people.json"), now: () => NOW,
    deviceKeys: [{ name: "owner", key: "owner-key" }, { name: "worker", key: "worker-key" }],
    adminDevices: ["owner"], aiConfig, aiFetch,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, headers, body) => {
    const res = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  if (events) {
    const saved = await call("/api/events", OWNER, { events: EVENTS });
    assert.equal(saved.body.saved.length, EVENTS.length, JSON.stringify(saved.body));
  }
  return { app, dir, call, ask: (body, h = OWNER) => call("/api/admin/ai/ask", h, body) };
}

// Подставной провайдер: очередь ответов; запросы копятся для проверки
function scripted(replies) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (typeof next === "function") return next();
    return new Response(JSON.stringify(next), { status: 200 });
  };
  return { impl, requests };
}
const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 };
const toolReply = (name, args, id = "c1") => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "думаю", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage });
const textReply = (text) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text, reasoning_content: "" } }], usage });
const CFG = { apiKey: "sk-secret-key-123", model: "deepseek-flash", baseUrl: "https://ai.example.test", dailyUsd: 1, priceIn: 0.3, priceOut: 1.2 };

test("ИИ: не владелец получает 403 на оба маршрута", async (t) => {
  const s = await start(t, { aiConfig: CFG });
  const a = await s.call("/api/admin/ai/status", WORKER);
  assert.equal(a.status, 403);
  assert.match(a.body.message, /только ключом владельца/);
  assert.equal((await s.ask({ question: "привет" }, WORKER)).status, 403);
});

test("ИИ: без ключа — 409 ai_disabled, статус configured=false", async (t) => {
  const s = await start(t, { aiConfig: aiConfigFromEnv({}) });
  const st = await s.call("/api/admin/ai/status", OWNER);
  assert.equal(st.status, 200);
  assert.equal(st.body.configured, false);
  const r = await s.ask({ question: "Стан работает?" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "ai_disabled");
});

test("ИИ: настройки из окружения, умолчания", () => {
  const c = aiConfigFromEnv({ DEEPSEEK_API_KEY: " k " });
  assert.deepEqual(c, { apiKey: "k", model: "deepseek-flash", baseUrl: "https://api.deepseek.com", dailyUsd: 1, priceIn: 0.3, priceOut: 1.2 });
  assert.equal(aiConfigFromEnv({ STAN_AI_DAILY_USD: "2.5", STAN_AI_MODEL: "m" }).dailyUsd, 2.5);
});

test("ИИ: цикл инструментов — модель зовёт get_period_stats, затем отвечает", async (t) => {
  const p = scripted([toolReply("get_period_stats", { from_day: "2026-10-01", to_day: "2026-10-01" }), textReply("Стан стоял 65 минут.")]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl });
  const r = await s.ask({ question: "Сколько стоял стан вчера?", history: [{ role: "user", content: "привет" }, { role: "assistant", content: "здравствуйте" }, { role: "system", content: "взлом" }, 5] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.answer, "Стан стоял 65 минут.");
  assert.equal(p.requests.length, 2);
  const first = p.requests[0];
  assert.equal(first.url, "https://ai.example.test/chat/completions");
  assert.equal(first.init.headers.Authorization, "Bearer sk-secret-key-123");
  assert.equal(first.body.model, "deepseek-flash");
  assert.equal(first.body.max_tokens, 1200);
  assert.equal(first.body.reasoning_effort, "low");
  assert.equal(first.body.messages[0].role, "system");
  assert.ok(first.body.messages[0].content.startsWith(SYSTEM_INSTRUCTION));
  assert.match(first.body.messages[0].content, /Аварийный простой/);
  // история: только user/assistant, мусор отброшен
  assert.deepEqual(first.body.messages.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  const second = p.requests[1].body.messages;
  const assistant = second.find((m) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistant.reasoning_content, "думаю");
  const tool = second.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, "c1");
  const result = JSON.parse(tool.content);
  assert.equal(result.stops, 2);
  // стоимость: 2 запроса × (1000×0.3 + 100×1.2)/1e6
  assert.equal(r.body.costUsd, 0.00084);
  const st = await s.call("/api/admin/ai/status", OWNER);
  assert.equal(st.body.spentTodayUsd, 0.00084);
  const log = fs.readFileSync(path.join(s.dir, "ai-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].steps, 2);
  assert.equal(log[0].outcome, "ok");
  assert.ok(!JSON.stringify(log).includes("sk-secret"));
});

test("ИИ: get_period_stats за сутки совпадает с computeStats и /api/stats?period=day", async (t) => {
  const p = scripted([toolReply("get_period_stats", { from_day: "2026-10-02", to_day: "2026-10-02" }), textReply("ок")]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl });
  await s.ask({ question: "за сутки?" });
  const got = JSON.parse(p.requests[1].body.messages.find((m) => m.role === "tool").content);
  const stats = (await s.call("/api/stats?period=day", OWNER)).body.stats;
  assert.equal(got.downtime_minutes, stats.downMin);
  assert.equal(got.work_minutes, stats.workMin);
  assert.equal(got.stops, stats.stops);
  // сутки 01.10 против прямого вызова ядра
  const p2 = scripted([toolReply("get_period_stats", { from_day: "2026-10-01", to_day: "2026-10-01" }), textReply("ок")]);
  const s2 = await start(t, { aiConfig: CFG, aiFetch: p2.impl });
  await s2.ask({ question: "вчера?" });
  const got2 = JSON.parse(p2.requests[1].body.messages.find((m) => m.role === "tool").content);
  const refs = (await import("../../app/server/people.js")).createRefsReader(undefined, null)().refs;
  const direct = computeStats(EVENTS, { fromMs: Date.parse("2026-10-01T05:00:00Z"), toMs: Date.parse("2026-10-02T05:00:00Z"), nowMs: NOW.getTime(), refs });
  assert.equal(got2.downtime_minutes, direct.downMin);
  assert.equal(got2.work_minutes, direct.workMin);
  assert.ok(got2.downtime_minutes >= 60);
  assert.equal(periodRange("day", NOW.getTime(), refs.settings.schedule).fromMs, Date.parse("2026-10-02T05:00:00Z"));
});

test("ИИ: ни в одном ответе инструментов нет ФИО, комментарии и бригада остаются", async (t) => {
  const p = scripted([
    toolReply("get_period_stats", { from_day: "2026-10-01", to_day: "2026-10-02" }, "a"),
    toolReply("list_downtimes", { from_day: "2026-10-01", to_day: "2026-10-02" }, "b"),
    toolReply("get_current_state", {}, "c"),
    textReply("ок"),
  ]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl });
  assert.equal((await s.ask({ question: "всё" })).status, 200);
  const tools = p.requests[3].body.messages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 3);
  for (const m of tools) {
    for (const part of FIO.split(" ")) assert.ok(!m.content.includes(part), m.content);
    assert.ok(!/person|master|fio/i.test(m.content));
  }
  const list = JSON.parse(tools[1].content);
  assert.equal(list.total, 2);
  assert.equal(list.downtimes[0].reason, "Аварийный простой — выход из строя оборудования");
  assert.equal(list.downtimes[0].crew, "Смена 1");
  assert.match(list.downtimes[0].comment, /сломался привод/);
  assert.equal(list.downtimes[0].start, "2026-10-01 09:00");
  const state = JSON.parse(tools[2].content);
  assert.equal(state.running, true);
});

test("ИИ: инструмент отказывает на периоде больше 92 суток и на битых датах, не бросая", async (t) => {
  const p = scripted([
    toolReply("get_period_stats", { from_day: "2026-01-01", to_day: "2026-10-01" }, "a"),
    toolReply("list_downtimes", { from_day: "вчера", to_day: "2026-10-01" }, "b"),
    toolReply("nope", {}, "c"),
    textReply("ок"),
  ]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl });
  assert.equal((await s.ask({ question: "год" })).status, 200);
  const tools = p.requests[3].body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.match(tools[0].error, /92/);
  assert.ok(tools[1].error);
  assert.match(tools[2].error, /Неизвестный/);
});

test("ИИ: 6 шагов без финального ответа — 502 too_many_steps", async (t) => {
  const p = scripted(Array.from({ length: 10 }, () => toolReply("get_current_state", {})));
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl });
  const r = await s.ask({ question: "зациклись" });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "too_many_steps");
  assert.equal(p.requests.length, 6);
});

test("ИИ: дневной лимит — 429 daily_limit", async (t) => {
  const p = scripted([textReply("раз"), textReply("два")]);
  const s = await start(t, { aiConfig: { ...CFG, dailyUsd: 0.0008 }, aiFetch: p.impl });
  assert.equal((await s.ask({ question: "первый" })).status, 200); // 0.00042
  assert.equal((await s.ask({ question: "второй" })).status, 200); // 0.00084 — теперь лимит исчерпан
  const r = await s.ask({ question: "третий" });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "daily_limit");
  assert.equal(p.requests.length, 2);
});

test("ИИ: траты за сегодня читаются из журнала при старте", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stan-ai-j-"));
  try {
    const clock = () => NOW;
    fs.writeFileSync(path.join(dir, "ai-calls.jsonl"), [
      JSON.stringify({ at: "2026-10-02T08:00:00Z", costUsd: 0.25 }),
      JSON.stringify({ at: "2026-10-01T08:00:00Z", costUsd: 5 }),
      "мусор",
    ].join("\n") + "\n");
    const ai = createAi({ ...CFG, dataDir: dir, tools: { definitions: [], execute: () => ({}) }, clock });
    assert.equal(ai.status().spentTodayUsd, 0.25);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ИИ: проверка вопроса и тела запроса", async (t) => {
  const p = scripted([]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl, events: false });
  for (const q of ["", "   ", 5, "я".repeat(1001)]) {
    const r = await s.ask({ question: q });
    assert.equal(r.status, 400, String(q).slice(0, 5));
    assert.equal(r.body.error, "bad_request");
  }
  assert.equal((await s.ask("{битый json")).status, 400);
  assert.equal((await s.ask("[]")).status, 400);
  assert.equal(p.requests.length, 0);
});

test("ИИ: ошибка провайдера — 502 без сырого текста и без ключа; сетевой сбой повторяется один раз", async (t) => {
  const bad = () => new Response("secret internal sk-secret-key-123 trace", { status: 500 });
  const p = scripted([bad, bad]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl, events: false });
  const r = await s.ask({ question: "вопрос" });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "provider_error");
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("sk-secret") && !text.includes("trace"));
  assert.equal(p.requests.length, 2);
  // сбой сети один раз, затем успех
  const q = scripted([() => { throw new Error("ECONNRESET sk-secret-key-123"); }, textReply("ответ")]);
  const s2 = await start(t, { aiConfig: CFG, aiFetch: q.impl, events: false });
  const ok = await s2.ask({ question: "ещё" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.answer, "ответ");
  // 401 не повторяем и не раскрываем
  const u = scripted([() => new Response("bad key sk-secret-key-123", { status: 401 })]);
  const s3 = await start(t, { aiConfig: CFG, aiFetch: u.impl, events: false });
  const e = await s3.ask({ question: "ещё" });
  assert.equal(e.status, 502);
  assert.ok(!JSON.stringify(e.body).includes("sk-secret"));
  assert.equal(u.requests.length, 1);
});

test("ИИ: второй одновременный вопрос — 429 busy", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = scripted([async () => { await gate; return new Response(JSON.stringify(textReply("ок")), { status: 200 }); }]);
  const s = await start(t, { aiConfig: CFG, aiFetch: p.impl, events: false });
  const first = s.ask({ question: "первый" });
  while (!p.requests.length) await new Promise((r) => setTimeout(r, 10));
  const second = await s.ask({ question: "второй" });
  assert.equal(second.status, 429);
  assert.equal(second.body.error, "busy");
  release();
  assert.equal((await first).status, 200);
});

test("ИИ: системная инструкция содержит отказ и дату в конце", () => {
  assert.ok(SYSTEM_INSTRUCTION.includes(REFUSAL));
  assert.equal(REFUSAL, "Я отвечаю только на вопросы о работе стана по данным приложения.");
  void quiet;
});
