// Настройки рассылки: кому, когда и что слать. Общий контракт для сервера и демо в браузере.
export const MAIL_MAX_RECIPIENTS = 30;
export const MAIL_MAX_SENDS = 10;
export const MAIL_WHAT = ["shift", "day", "week"];
export const MAIL_WHAT_TITLE = { shift: "Сводка смены", day: "Сводка за сутки", week: "Сводка за неделю" };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bad = (message) => { throw Object.assign(new Error(message), { code: "bad_request" }); };

const newId = () => "m" + globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0");

/** Проверка адреса: возвращает приведённый к нижнему регистру или null. */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 120 && EMAIL.test(email) ? email : null;
}

/** Пустые настройки. */
export const emptyMailSettings = () => ({ recipients: [] });

/** Возвращает только разрешённые поля, не изменяя входной объект. Ошибки — по-русски, code = "bad_request". */
export function validateMailSettings(input) {
  if (!object(input) || !Array.isArray(input.recipients)) bad("Передайте объект рассылки mail со списком получателей recipients.");
  if (input.recipients.length > MAIL_MAX_RECIPIENTS) bad(`Получателей не больше ${MAIL_MAX_RECIPIENTS}.`);
  const ids = new Set();
  const emails = new Set();
  const recipients = input.recipients.map((r, i) => {
    const label = `Получатель ${i + 1}`;
    if (!object(r)) bad(`${label}: передайте имя, адрес и отправки.`);
    if (typeof r.name !== "string" || r.name.trim().length < 1 || r.name.trim().length > 80) bad(`${label}: имя должно содержать от 1 до 80 символов.`);
    const name = r.name.trim().replace(/\s+/g, " ");
    const email = normalizeEmail(r.email);
    if (!email) bad(`${name}: укажите настоящий адрес электронной почты, например master@example.ru.`);
    if (emails.has(email)) bad(`Адрес ${email} указан дважды: у каждого получателя должен быть свой адрес.`);
    emails.add(email);
    let id = r.id;
    if (id === "" || id == null) { do { id = newId(); } while (ids.has(id)); }
    else if (typeof id !== "string" || !/^[\w-]{1,40}$/.test(id)) bad(`${name}: неверный идентификатор получателя.`);
    if (ids.has(id)) bad("Идентификаторы получателей не должны повторяться.");
    ids.add(id);
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") bad(`${name}: «Включён» — да или нет.`);
    if (!Array.isArray(r.sends)) bad(`${name}: передайте список отправок.`);
    if (r.sends.length > MAIL_MAX_SENDS) bad(`${name}: отправок не больше ${MAIL_MAX_SENDS}.`);
    const seen = new Set();
    const sends = r.sends.map((s, j) => {
      const where = `${name}, отправка ${j + 1}`;
      if (!object(s)) bad(`${where}: передайте время, вид сводки и дни.`);
      if (typeof s.time !== "string" || !TIME.test(s.time)) bad(`${where}: время укажите в формате ЧЧ:ММ, например 08:05.`);
      if (!MAIL_WHAT.includes(s.what)) bad(`${where}: выберите сводку смены, суток или недели.`);
      let days = [1, 2, 3, 4, 5, 6, 7];
      if (s.days !== undefined) {
        if (!Array.isArray(s.days) || !s.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) bad(`${where}: дни недели — числа от 1 (пн) до 7 (вс).`);
        days = [...new Set(s.days)].sort((a, b) => a - b);
        if (!days.length) bad(`${where}: выберите хотя бы один день недели.`);
      }
      const key = `${s.time}|${s.what}`;
      if (seen.has(key)) bad(`${where}: такая отправка уже есть — сведите дни в одну строку.`);
      seen.add(key);
      return { time: s.time, what: s.what, days };
    });
    return { id, name, email, enabled: r.enabled !== false, sends };
  });
  return { recipients };
}
