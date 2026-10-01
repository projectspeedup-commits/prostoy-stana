// Общий контракт администратора для Node и демо в браузере.
export const SETTINGS_CREWS = [{ id: "1", title: "Смена 1" }, { id: "2", title: "Смена 2" }];
export const DEFAULT_CONTACTS = [
  { title: "Дежурный механик", tel: "" },
  { title: "Дежурный электрик", tel: "" },
  { title: "Диспетчер", tel: "" },
];

const TIME = /^([01]\d|2[0-3]):(00|30)$/;
const PHONE = /^\+?[0-9 ()\-]{5,24}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bad = (message) => { throw Object.assign(new Error(message), { code: "bad_request" }); };

function text(value, min, max, message) {
  if (typeof value !== "string") bad(message);
  const result = value.trim();
  if (result.length < min || result.length > max) bad(message);
  return result;
}

function phone(value, label) {
  if (typeof value !== "string") bad(`${label}: телефон должен быть строкой.`);
  const result = value.trim();
  if (result !== "" && !PHONE.test(result)) {
    bad(`${label}: укажите телефон из 5–24 символов — цифры, пробелы, скобки, дефис и плюс в начале.`);
  }
  return result;
}

function newPersonId() {
  return "p" + globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0");
}

/** Возвращает только разрешённые поля, не изменяя входной объект. */
export function validateSettings(input, currentPeople = []) {
  if (!object(input)) bad("Передайте объект настроек settings.");
  const shifts = input.schedule?.shifts;
  if (!object(input.schedule) || !Array.isArray(shifts) || shifts.length !== 2 ||
    !shifts.every((s) => object(s) && (s.no === 1 || s.no === 2)) ||
    new Set(shifts.map((s) => s.no)).size !== 2) {
    bad("Нужны ровно две смены с номерами 1 и 2.");
  }
  if (!shifts.every((s) => typeof s.start === "string" && TIME.test(s.start))) {
    bad("Начало смены укажите в формате ЧЧ:ММ, от 00:00 до 23:30, с шагом 30 минут.");
  }
  const schedule = { shifts: shifts.map(({ no, start }) => ({ no, start })).sort((a, b) => a.no - b.no) };
  const minutes = (start) => Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
  const duration = (minutes(schedule.shifts[1].start) - minutes(schedule.shifts[0].start) + 1440) % 1440;
  if (duration === 0) bad("Время начала двух смен должно различаться.");
  if (duration < 60 || 1440 - duration < 60) bad("Каждая смена должна длиться не менее 60 минут.");

  if (!Array.isArray(input.people) || input.people.length > 50) bad("Список мастеров должен содержать от 0 до 50 человек.");
  const existing = new Set(currentPeople.map((p) => String(p.id)));
  const used = new Set();
  const people = input.people.map((p, i) => {
    const label = `Мастер ${i + 1}`;
    if (!object(p)) bad(`${label}: передайте данные человека.`);
    const name = text(p.name, 3, 120, `${label}: ФИО должно содержать от 3 до 120 символов.`);
    if (p.crewId !== "1" && p.crewId !== "2") bad(`${label}: выберите смену 1 или 2.`);
    const normalizedPhone = phone(p.phone, label);
    let id = p.id;
    if (id === "" || id == null) {
      do { id = newPersonId(); } while (existing.has(id) || used.has(id));
    } else if (typeof id !== "string" || !existing.has(id)) {
      bad(`${label}: неизвестный идентификатор; для нового человека оставьте id пустым.`);
    }
    if (used.has(id)) bad("Идентификаторы мастеров не должны повторяться.");
    used.add(id);
    return { id, name, crewId: p.crewId, phone: normalizedPhone };
  });

  if (!Array.isArray(input.contacts) || input.contacts.length > 12) bad("Список контактов должен содержать от 0 до 12 записей.");
  const contacts = input.contacts.map((c, i) => {
    const label = `Контакт ${i + 1}`;
    if (!object(c)) bad(`${label}: передайте название и телефон.`);
    return {
      title: text(c.title, 1, 60, `${label}: название должно содержать от 1 до 60 символов.`),
      tel: phone(c.tel, label),
    };
  });
  return { schedule, people, contacts };
}

/** Снимок для формы администратора, без версии файла и служебных полей refs. */
export function settingsFromRefs(refs) {
  return {
    schedule: { shifts: refs.settings.schedule.shifts.map(({ no, start }) => ({ no, start })) },
    people: refs.people.map(({ id, name, crewId, phone = "" }) => ({ id: String(id), name, crewId: String(crewId), phone })),
    contacts: (refs.settings.contacts ?? DEFAULT_CONTACTS).map(({ title, tel }) => ({ title, tel })),
  };
}
