import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../../app/server/index.js";
import { createRefsReader } from "../../app/server/people.js";
import { createSettingsStore } from "../../app/server/settings.js";
import { DEFAULT_SCHEDULE, shiftOf } from "../../app/core/core.js";
import { DEFAULT_CONTACTS, SETTINGS_CREWS, validateSettings } from "../../app/core/settings.js";

const HEAD = { "X-Device-Key": "admin-test-key", "Content-Type": "application/json" };
const NOW = new Date("2026-10-01T05:30:00Z"); // 08:30 Москвы: старая смена 1, новая — 2
const fresh = () => ({
  schedule: { shifts: [{ no: 1, start: "09:00" }, { no: 2, start: "21:00" }] },
  people: [{ id: null, name: "Петров Пётр Петрович", crewId: "1", phone: "+7 (999) 123-45-67" }],
  contacts: [{ title: "Дежурный механик", tel: "+7 999 111-22-33" }],
});

function temporaryDirectory(t, beforeRemove = () => {}) {
  const directory = fs.mkdtempSync(path.join(import.meta.dirname, ".admin-"));
  t.after(async () => {
    await beforeRemove();
    // Удаляем только собственную временную папку внутри этого worktree.
    assert.equal(path.dirname(path.resolve(directory)), import.meta.dirname);
    assert.ok(path.basename(directory).startsWith(".admin-"));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return directory;
}

async function start(t, { people, memory = false } = {}) {
  let app;
  const directory = temporaryDirectory(t, () => app?.close());
  const peopleFile = path.join(directory, "people.json");
  if (people) fs.writeFileSync(peopleFile, JSON.stringify(people));
  app = createApp({
    dataDir: memory ? ":memory:" : directory,
    peopleFile,
    deviceKeys: [{ name: "admin-test", key: HEAD["X-Device-Key"] }],
    now: () => NOW,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, { headers: HEAD, ...options });
    return { status: response.status, body: await response.json() };
  };
  return {
    app, base, directory, peopleFile, file: path.join(directory, "settings.json"), request,
    get: () => request("/api/admin/settings"),
    put: (settings) => request("/api/admin/settings", { method: "PUT", body: JSON.stringify({ settings }) }),
  };
}

test("admin GET без файла: демо, пустые телефоны и контакты по умолчанию", async (t) => {
  const s = await start(t);
  const before = await s.request("/api/refs");
  const result = await s.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.settings.schedule, { shifts: DEFAULT_SCHEDULE.shifts });
  assert.deepEqual(result.body.settings.contacts, DEFAULT_CONTACTS);
  assert.equal(result.body.settings.people.length, 4);
  assert.ok(result.body.settings.people.every((p) => p.phone === ""));
  assert.equal(result.body.refsVersion, before.body.refsVersion);
  assert.deepEqual(before.body.refs.crews, SETTINGS_CREWS);
  assert.equal(Object.hasOwn(before.body.refs.settings, "contacts"), false);
  assert.equal(fs.existsSync(s.file), false);
  await s.app.close();
});

test("admin GET без настроек берёт людей из peopleFile; изменения файла сбрасывают кеш", async (t) => {
  const people = { crews: SETTINGS_CREWS, people: [{ id: "existing", name: "Иванов Иван Иванович", crewId: "2" }] };
  const s = await start(t, { people });
  const before = (await s.get()).body;
  assert.deepEqual(before.settings.people, [{ ...people.people[0], phone: "" }]);
  people.people[0].name = "Сидоров Алексей Иванович";
  fs.writeFileSync(s.peopleFile, JSON.stringify(people));
  const after = (await s.get()).body;
  assert.equal(after.settings.people[0].name, people.people[0].name);
  assert.notEqual(after.refsVersion, before.refsVersion);
  await s.app.close();
});

test("admin PUT: файл, нормализация, новые ID, refs, state, повторное чтение и .bak", async (t) => {
  const s = await start(t);
  const before = (await s.request("/api/refs")).body;
  assert.equal((await s.request("/api/state")).body.state.shift.shiftNo, 1);
  const input = fresh();
  input.people[0].name = "  Петров Пётр Петрович  ";
  input.people[0].phone = "  +7 (999) 123-45-67  ";
  input.people[0].ignored = true;
  input.people.push({ id: "", name: "Сидоров Иван Петрович", crewId: "2", phone: "" });
  input.schedule.shifts.reverse();
  input.schedule.tzOffsetMinutes = -300;
  input.contacts[0].title = " Дежурный механик ";
  input.contacts[0].tel = " +7 999 111-22-33 ";
  input.ignored = true;
  const saved = await s.put(input);
  assert.equal(saved.status, 200);
  const settings = saved.body.settings;
  assert.equal(saved.body.ok, true);
  assert.match(settings.people[0].id, /^p[0-9a-f]{8}$/);
  assert.match(settings.people[1].id, /^p[0-9a-f]{8}$/);
  assert.notEqual(settings.people[0].id, settings.people[1].id);
  assert.deepEqual(settings.people[0], { ...fresh().people[0], id: settings.people[0].id });
  assert.deepEqual(settings.contacts, fresh().contacts);
  assert.deepEqual(settings.schedule, fresh().schedule);
  assert.equal(Object.hasOwn(settings, "ignored"), false);
  const originalFile = fs.readFileSync(s.file, "utf8");
  assert.deepEqual(JSON.parse(originalFile), { version: 1, ...settings });
  assert.equal(fs.existsSync(`${s.file}.bak`), false); // до первой записи предыдущей версии нет

  const refs = (await s.request("/api/refs")).body;
  assert.notEqual(refs.refsVersion, before.refsVersion);
  assert.equal(refs.refsVersion, saved.body.refsVersion);
  assert.deepEqual(refs.refs.settings.schedule, { tzOffsetMinutes: 180, ...settings.schedule });
  assert.deepEqual(refs.refs.people, settings.people);
  assert.deepEqual(refs.refs.settings.contacts, settings.contacts);
  assert.deepEqual(refs.refs.crews, SETTINGS_CREWS);
  for (const key of ["reasons", "tiles", "nodes"]) assert.deepEqual(refs.refs[key], before.refs[key]);
  assert.equal(refs.refs.settings.shortStopMinutes, before.refs.settings.shortStopMinutes);
  const state = (await s.request("/api/state")).body;
  assert.equal(state.state.shift.shiftNo, 2);
  assert.equal(state.state.shift.startMs, Date.parse("2026-09-30T18:00:00Z"));
  assert.equal(state.state.shift.endMs, Date.parse("2026-10-01T06:00:00Z"));
  assert.equal(state.refsVersion, saved.body.refsVersion);
  assert.deepEqual((await s.get()).body, saved.body);
  assert.deepEqual(createRefsReader(s.peopleFile, createSettingsStore(s.file))(), refsFromResponse(refs));

  settings.people[0].phone = "12345"; // только телефон также меняет хеш
  const next = await s.put(settings);
  assert.equal(next.status, 200);
  assert.notEqual(next.body.refsVersion, saved.body.refsVersion);
  assert.equal(next.body.settings.people[0].id, settings.people[0].id);
  assert.equal(fs.readFileSync(`${s.file}.bak`, "utf8"), originalFile);
  const secondFile = fs.readFileSync(s.file, "utf8");
  settings.people = [];
  settings.contacts = [];
  const empty = await s.put(settings);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.settings.people, []);
  assert.deepEqual((await s.request("/api/refs")).body.refs.settings.contacts, []);
  assert.equal(fs.readFileSync(`${s.file}.bak`, "utf8"), secondFile);
  assert.equal(fs.readdirSync(s.directory).some((file) => file.endsWith(".tmp")), false);
  await s.app.close();
});

function refsFromResponse({ refs, refsVersion }) { return { refs, refsVersion }; }

test("settings.json имеет приоритет; создание, замена и удаление сбрасывают кеш обоих файлов", async (t) => {
  const s = await start(t, { people: { crews: SETTINGS_CREWS, people: [] } });
  assert.deepEqual((await s.get()).body.settings.people, []);
  const saved = (await s.put(fresh())).body;
  fs.writeFileSync(s.peopleFile, "не JSON: этот файл теперь не используется");
  assert.deepEqual((await s.get()).body, saved);
  const replacement = { version: 1, ...saved.settings, contacts: [{ title: "Диспетчер", tel: "12345" }] };
  const temp = `${s.file}.external`;
  fs.writeFileSync(temp, JSON.stringify(replacement));
  fs.renameSync(temp, s.file);
  const after = (await s.get()).body;
  assert.deepEqual(after.settings.contacts, replacement.contacts);
  assert.notEqual(after.refsVersion, saved.refsVersion);
  fs.writeFileSync(s.peopleFile, JSON.stringify({ crews: SETTINGS_CREWS, people: [] }));
  fs.unlinkSync(s.file);
  assert.deepEqual((await s.get()).body.settings.contacts, DEFAULT_CONTACTS);
  assert.deepEqual((await s.get()).body.settings.people, []);
  fs.unlinkSync(s.peopleFile);
  assert.equal((await s.get()).body.settings.people.length, 4);
  await s.app.close();
});

test("повреждённый settings.json не подменяется демо и не перезаписывается через PUT", async (t) => {
  const s = await start(t);
  for (const damaged of ["null", "{", '{"version":2,"people":[]}']) {
    fs.writeFileSync(s.file, damaged);
    assert.equal((await s.get()).status, 500);
    assert.equal((await s.put(fresh())).status, 500);
    assert.equal(fs.readFileSync(s.file, "utf8"), damaged);
    assert.equal(fs.existsSync(`${s.file}.bak`), false);
  }
  await s.app.close();
});

const invalidCases = [
  ["плохое время", (s) => { s.schedule.shifts[0].start = "25:00"; }],
  ["минуты не кратны 30", (s) => { s.schedule.shifts[0].start = "08:15"; }],
  ["однозначный час", (s) => { s.schedule.shifts[0].start = "8:00"; }],
  ["одинаковые старты", (s) => { s.schedule.shifts[1].start = "09:00"; }],
  ["смена 1 короче часа", (s) => { s.schedule.shifts[1].start = "09:30"; }],
  ["смена 2 короче часа через полночь", (s) => { s.schedule.shifts = [{ no: 1, start: "00:00" }, { no: 2, start: "23:30" }]; }],
  ["три смены", (s) => { s.schedule.shifts.push({ no: 3, start: "23:00" }); }],
  ["повтор номера смены", (s) => { s.schedule.shifts[1].no = 1; }],
  ["номер смены строкой", (s) => { s.schedule.shifts[0].no = "1"; }],
  ["нет расписания", (s) => { delete s.schedule; }],
  ["пустое ФИО", (s) => { s.people[0].name = "   "; }],
  ["слишком длинное ФИО", (s) => { s.people[0].name = "я".repeat(121); }],
  ["плохой телефон мастера", (s) => { s.people[0].phone = "+7abcde"; }],
  ["слишком короткий телефон", (s) => { s.people[0].phone = "1234"; }],
  ["слишком длинный телефон", (s) => { s.people[0].phone = "1".repeat(25); }],
  ["телефон не строка", (s) => { s.people[0].phone = 12345; }],
  ["неизвестная смена мастера", (s) => { s.people[0].crewId = "3"; }],
  ["смена мастера числом", (s) => { s.people[0].crewId = 1; }],
  ["неизвестный ID", (s) => { s.people[0].id = "unknown"; }],
  ["повтор ID", (s) => { s.people.push({ ...s.people[0] }); }],
  ["51 мастер", (s) => { s.people = Array.from({ length: 51 }, () => ({ ...s.people[0], id: null })); }],
  ["люди не массив", (s) => { s.people = {}; }],
  ["пустой контакт", (s) => { s.contacts[0].title = " "; }],
  ["длинное название контакта", (s) => { s.contacts[0].title = "я".repeat(61); }],
  ["плохой телефон контакта", (s) => { s.contacts[0].tel = "call me"; }],
  ["13 контактов", (s) => { s.contacts = Array.from({ length: 13 }, () => ({ title: "Механик", tel: "" })); }],
  ["контакты не массив", (s) => { s.contacts = null; }],
];

for (const [label, change] of invalidCases) {
  test(`admin PUT отклоняет: ${label}; файл, .bak и refs неизменны`, async (t) => {
    const s = await start(t);
    const saved = (await s.put(fresh())).body;
    await s.put(saved.settings); // резервная копия тоже должна остаться прежней
    const before = fs.readFileSync(s.file, "utf8");
    const backup = fs.readFileSync(`${s.file}.bak`, "utf8");
    const input = structuredClone(saved.settings);
    change(input);
    const result = await s.put(input);
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, "bad_request");
    assert.match(result.body.message, /[а-яё]/i);
    assert.equal(fs.readFileSync(s.file, "utf8"), before);
    assert.equal(fs.readFileSync(`${s.file}.bak`, "utf8"), backup);
    assert.deepEqual((await s.get()).body, saved);
    assert.equal(fs.readdirSync(s.directory).some((file) => file.endsWith(".tmp")), false);
    await s.app.close();
  });
}

test("admin PUT принимает границы: час через полночь, 50 мастеров, 12 контактов", async (t) => {
  const s = await start(t);
  const settings = fresh();
  settings.schedule.shifts = [{ no: 1, start: "23:30" }, { no: 2, start: "00:30" }];
  settings.people = Array.from({ length: 50 }, (_, i) => ({ id: null, name: i ? "Аба" : "я".repeat(120), crewId: "2", phone: "1".repeat(24) }));
  settings.contacts = Array.from({ length: 12 }, () => ({ title: "я".repeat(60), tel: "12345" }));
  const result = await s.put(settings);
  assert.equal(result.status, 200);
  assert.equal(new Set(result.body.settings.people.map((p) => p.id)).size, 50);
  settings.people = result.body.settings.people;
  settings.schedule.shifts = [{ no: 1, start: "00:30" }, { no: 2, start: "23:30" }];
  assert.equal((await s.put(settings)).status, 200); // вторая смена ровно час
  await s.app.close();
});

test("admin: ключ устройства, 404 для метода/пути, JSON, лимит тела в байтах", async (t) => {
  const s = await start(t);
  for (const method of ["GET", "PUT"]) {
    assert.equal((await s.request("/api/admin/settings", { method, headers: {} })).status, 401);
    assert.equal((await s.request("/api/admin/settings", { method, headers: { "X-Device-Key": "wrong" } })).status, 401);
  }
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.equal((await s.request("/api/admin/settings", { method })).status, 404);
  }
  assert.equal((await s.request("/api/admin/unknown")).status, 404);
  for (const body of ["{", "null", "{}", "[]", '{"settings":null}']) {
    const result = await s.request("/api/admin/settings", { method: "PUT", body });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /[а-яё]/i);
  }
  const oversized = JSON.stringify({ settings: fresh(), ignored: "я".repeat(33000) });
  assert.ok(oversized.length < 64 * 1024);
  const result = await s.request("/api/admin/settings", { method: "PUT", body: oversized });
  assert.equal(result.status, 413);
  assert.equal(fs.existsSync(s.file), false);
  const module = await fetch(`${s.base}/core/settings.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /javascript/);
  assert.match(await module.text(), /export function validateSettings/);
  await s.app.close();
});

test("admin использует общий лимит запросов устройства", async (t) => {
  const s = await start(t);
  for (let i = 0; i < 60; i++) {
    const result = await s.request(i % 2 ? "/api/refs" : "/api/admin/settings");
    assert.equal(result.status, 200);
  }
  assert.equal((await s.put(fresh())).status, 429);
  assert.equal(fs.existsSync(s.file), false);
  await s.app.close();
});

test("после нового расписания событие получает мастера новой смены; старые события не меняются", async (t) => {
  const s = await start(t);
  const post = (events) => s.request("/api/events", { method: "POST", body: JSON.stringify({ events }) });
  const personName = "Иванов Иван Иванович";
  await post([{ id: "open", type: "shift_open", at: "2026-09-30T18:30:00Z", crewId: "2", personId: "d3", personName }]);
  const old = s.app.db.prepare("SELECT body FROM events WHERE id = 'open'").get().body;
  const settings = fresh();
  settings.people = []; // удалённое ФИО остаётся в журнале
  assert.equal((await s.put(settings)).status, 200);
  const event = await post([{ id: "stop-new", type: "stop", at: NOW.toISOString() }]);
  assert.deepEqual(event.body.saved, ["stop-new"]);
  const stored = JSON.parse(s.app.db.prepare("SELECT body FROM events WHERE id = 'stop-new'").get().body);
  assert.equal(stored.personName, personName);
  assert.equal(stored.personId, "d3");
  assert.equal(stored.crewId, "2");
  assert.equal(s.app.db.prepare("SELECT body FROM events WHERE id = 'open'").get().body, old);
  await s.app.close();
});

test("одновременные PUT оставляют целый файл и предыдущую версию в .bak", async (t) => {
  const s = await start(t);
  const first = fresh();
  const second = fresh();
  first.contacts[0].title = "Первая запись";
  second.contacts[0].title = "Вторая запись";
  const results = await Promise.all([s.put(first), s.put(second)]);
  assert.ok(results.every((r) => r.status === 200));
  const current = JSON.parse(fs.readFileSync(s.file, "utf8"));
  const previous = JSON.parse(fs.readFileSync(`${s.file}.bak`, "utf8"));
  assert.notEqual(current.contacts[0].title, previous.contacts[0].title);
  for (const result of results) assert.ok([current, previous].some((r) => r.people[0].id === result.body.settings.people[0].id));
  const final = (await s.get()).body;
  assert.deepEqual({ version: 1, ...final.settings }, current);
  assert.equal(final.refsVersion, results.find((r) => r.body.settings.people[0].id === current.people[0].id).body.refsVersion);
  await s.app.close();
});

test("запись повторяет rename при EPERM/EBUSY и сохраняет старую версию при полном отказе", async (t) => {
  const directory = temporaryDirectory(t);
  const file = path.join(directory, "settings.json");
  const store = createSettingsStore(file);
  const first = validateSettings(fresh());
  await store.write(first);
  const original = fs.readFileSync(file, "utf8");
  const rename = fs.promises.rename;
  let failures = 0;
  const mocked = t.mock.method(fs.promises, "rename", async (from, to) => {
    if (to === file && failures++ < 2) throw Object.assign(new Error("locked"), { code: failures === 1 ? "EPERM" : "EBUSY" });
    return rename(from, to);
  });
  const second = structuredClone(first);
  second.contacts = [];
  await store.write(second);
  assert.equal(failures, 3);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), original);
  const preserved = fs.readFileSync(file, "utf8");
  let attempts = 0;
  mocked.mock.mockImplementation(async (from, to) => {
    if (to === file) { attempts++; throw Object.assign(new Error("locked"), { code: "EPERM" }); }
    return rename(from, to);
  });
  await assert.rejects(store.write(first), { code: "EPERM" });
  assert.equal(attempts, 5);
  assert.equal(fs.readFileSync(file, "utf8"), preserved);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), preserved);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["settings.json", "settings.json.bak"]);
  mocked.mock.mockImplementation(async (from, to) => {
    if (to === `${file}.bak`) throw Object.assign(new Error("backup denied"), { code: "EACCES" });
    return rename(from, to);
  });
  await assert.rejects(store.write(first), { code: "EACCES" });
  assert.equal(fs.readFileSync(file, "utf8"), preserved);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), preserved);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["settings.json", "settings.json.bak"]);
});

test("admin работает с SQLite :memory: без создания файла", async (t) => {
  const s = await start(t, { memory: true });
  const result = await s.put(fresh());
  assert.equal(result.status, 200);
  assert.deepEqual((await s.get()).body, result.body);
  assert.equal(fs.existsSync(s.file), false);
  await s.app.close();
});

async function loadMock() {
  // Браузерный /core/ на сервере указывает на app/core. В тесте сохраняем тот же граф модулей.
  const coreUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../app/core/")).href + "/";
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../app/public/mock.js"), "utf8")
    .replaceAll('"./core/', '"' + coreUrl);
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

test("mock admin: тот же контракт, ошибки, новый refsVersion и новое расписание в state", async () => {
  const { api } = await loadMock();
  const before = await api("/api/admin/settings");
  assert.deepEqual(before.settings.contacts, DEFAULT_CONTACTS);
  assert.ok(before.settings.people.every((p) => p.phone === ""));
  assert.equal(Object.hasOwn((await api("/api/refs")).refs.settings, "contacts"), false);
  const result = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ settings: fresh() }) });
  assert.equal(result.ok, true);
  assert.match(result.settings.people[0].id, /^p[0-9a-f]{8}$/);
  assert.notEqual(result.refsVersion, before.refsVersion);
  const refs = await api("/api/refs");
  assert.equal(refs.refsVersion, result.refsVersion);
  assert.deepEqual(refs.refs.people, result.settings.people);
  assert.deepEqual(refs.refs.settings.contacts, result.settings.contacts);
  assert.deepEqual(refs.refs.settings.schedule, { tzOffsetMinutes: 180, ...result.settings.schedule });
  const state = await api("/api/state");
  assert.deepEqual(state.state.shift, shiftOf(state.serverTime, refs.refs.settings.schedule));
  assert.equal(state.refsVersion, result.refsVersion);
  // Ответы не дают форме менять данные «сервера» до нажатия «Сохранить».
  refs.refs.people[0].phone = "сломано";
  const snapshot = structuredClone(result);
  result.settings.people[0].name = "сломано";
  assert.deepEqual(await api("/api/admin/settings"), snapshot);
  for (const [, change] of invalidCases) {
    const input = structuredClone(snapshot.settings);
    change(input);
    await assert.rejects(api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ settings: input }) }), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.data.error, "bad_request");
      assert.match(e.data.message, /[а-яё]/i);
      return true;
    });
  }
  assert.deepEqual(await api("/api/admin/settings"), snapshot);
  await assert.rejects(api("/api/admin/settings", { method: "POST" }), { status: 404 });
  await assert.rejects(api("/api/admin/settings", { method: "PUT", body: "{" }), { status: 400 });
  await assert.rejects(api("/api/admin/settings", { method: "PUT", body: "я".repeat(33000) }), { status: 413 });
  snapshot.settings.people = [];
  snapshot.settings.contacts = [];
  const empty = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ settings: snapshot.settings }) });
  assert.deepEqual(empty.settings.people, []);
  assert.deepEqual((await api("/api/refs")).refs.settings.contacts, []);
});
