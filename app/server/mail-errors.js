// Ошибки отправки почты: наружу (в журнал и в ответ API) уходит только понятное русское описание
// и код ответа SMTP, но не сырая строка исключения: в ней сервер может эхом вернуть логин или пароль.

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** Все виды, в которых пароль SMTP может попасть в текст: как есть, в адресе, в base64 (AUTH PLAIN/LOGIN/CRAM-подобные). */
function secretForms(config) {
  const user = String(config?.user ?? "");
  const pass = String(config?.pass ?? "");
  const forms = new Set();
  if (pass) {
    forms.add(pass);
    forms.add(encodeURIComponent(pass));
    forms.add(b64(pass));
    forms.add(b64(`\0${user}\0${pass}`));
    forms.add(b64(`${user}\0${user}\0${pass}`));
    forms.add(b64(`${user}:${pass}`));
    forms.add(b64(`${user}\0${pass}`));
  }
  return [...forms].filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
}

/** Вырезает пароль SMTP и строки AUTH из любого текста. */
export function redactSecrets(text, config) {
  let out = String(text ?? "");
  for (const form of secretForms(config)) out = out.split(form).join("***");
  // base64 после AUTH: даже если это не наш пароль, в журнал оно не нужно
  out = out.replace(/\b(AUTH(?:\s+(?:PLAIN|LOGIN|CRAM-MD5|XOAUTH2))?)\s+[A-Za-z0-9+/=]{8,}/gi, "$1 ***");
  return out;
}

const NETWORK = {
  ECONNREFUSED: "SMTP-сервер не принимает соединение.",
  ECONNECTION: "Не удалось соединиться с SMTP-сервером.",
  ETIMEDOUT: "SMTP-сервер не ответил вовремя.",
  ESOCKET: "Сбой защищённого соединения с SMTP-сервером.",
  ECONNRESET: "SMTP-сервер оборвал соединение.",
  ENOTFOUND: "Адрес SMTP-сервера не найден.",
  EDNS: "Адрес SMTP-сервера не найден.",
  EAI_AGAIN: "Не удалось определить адрес SMTP-сервера.",
};

/** Код ответа SMTP (535, 550 …) из исключения или его текста; null, если нет. */
export function smtpCodeOf(error) {
  const direct = Number(error?.responseCode);
  if (direct >= 400 && direct <= 599) return direct;
  const m = /(?:^|[^\d])([45]\d\d)[ -]\d\.\d\.\d/.exec(String(error?.response || error?.message || "")) ||
    /^(?:[\w ]*:\s*)?([45]\d\d)\b/.exec(String(error?.response || error?.message || ""));
  return m ? Number(m[1]) : null;
}

/**
 * { code, message }: message — по-русски и без сырого текста ошибки.
 * code — числовой ответ SMTP или null.
 */
export function describeMailError(error, config) {
  const code = smtpCodeOf(error);
  const net = NETWORK[error?.code];
  let text;
  if (code === 535 || code === 534 || code === 530 || error?.code === "EAUTH") text = "SMTP-сервер не принял логин или пароль. Проверьте SMTP_USER и SMTP_PASS (для Яндекса нужен пароль приложения).";
  else if (code === 550 || code === 551 || code === 553) text = "SMTP-сервер отклонил адрес получателя или отправителя.";
  else if (code === 552) text = "SMTP-сервер отклонил письмо: слишком большой размер.";
  else if (code === 554) text = "SMTP-сервер отклонил письмо.";
  else if (code && code >= 500) text = "SMTP-сервер вернул постоянную ошибку.";
  else if (code) text = "SMTP-сервер временно не принял письмо, попробуйте позже.";
  else if (net) text = net;
  else if (/получател/i.test(String(error?.message)) && /отклонил/i.test(String(error?.message))) text = "SMTP-сервер отклонил всех получателей.";
  else text = "Не удалось отправить письмо.";
  const message = redactSecrets(code ? `${text} Код ответа SMTP: ${code}.` : text, config);
  return { code, message };
}
