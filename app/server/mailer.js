// Отправка писем по SMTP (по умолчанию Яндекс: smtp.yandex.ru:465, SSL) и настройки из окружения.
// nodemailer подключается лениво: при выключенной рассылке пакет не нужен.

const DEFAULT_URL = "https://stan.tmpz-engineering.ru/";

/** Настройки из окружения. Рассылка включена только при заданных SMTP_USER, SMTP_PASS и MAIL_TO. */
export function mailConfigFromEnv(env = process.env) {
  const clean = (v) => String(v ?? "").trim();
  const user = clean(env.SMTP_USER);
  const pass = clean(env.SMTP_PASS);
  const to = clean(env.MAIL_TO).split(",").map((s) => s.trim()).filter(Boolean);
  const port = Number(env.SMTP_PORT) || 465;
  return {
    enabled: Boolean(user && pass && to.length),
    host: clean(env.SMTP_HOST) || "smtp.yandex.ru",
    port,
    secure: port === 465, // 465 — SSL сразу; иной порт (587) — STARTTLS
    user,
    pass,
    from: clean(env.MAIL_FROM) || user,
    to,
    publicUrl: clean(env.PUBLIC_URL) || DEFAULT_URL,
  };
}

async function defaultTransportFactory(options) {
  const { default: nodemailer } = await import("nodemailer");
  return nodemailer.createTransport(options);
}

/**
 * Отправитель. transportFactory(options) -> { sendMail(message) } подменяется в тестах.
 * send({ subject, html, text, attachments }) -> { messageId, accepted, rejected }; ошибка SMTP — исключение.
 */
export function createMailer(config, { transportFactory = defaultTransportFactory } = {}) {
  let transport;
  return {
    async send({ subject, html, text, attachments = [] }) {
      transport ??= await transportFactory({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
      const info = await transport.sendMail({ from: config.from, to: config.to, subject, html, text, attachments });
      if (Array.isArray(info?.accepted) && info.accepted.length === 0) {
        throw new Error(`SMTP отклонил всех получателей: ${(info.rejected || []).join(", ") || config.to.join(", ")}`);
      }
      return { messageId: info?.messageId ?? null, accepted: info?.accepted ?? config.to, rejected: info?.rejected ?? [] };
    },
  };
}
