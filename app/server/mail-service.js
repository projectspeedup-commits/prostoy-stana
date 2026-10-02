// Рассылка сводок: получатели и расписание берутся из настроек владельца, раз в минуту проверяется,
// какие отправки наступили. Отметка «отправлено» стоит на уровне (получатель, время, вид, момент),
// поэтому после перезапуска и правки расписания нет ни дублей, ни пропусков.
import { buildDigest } from "./digest.js";
import { createMailSentStore, readLegacyMailMark } from "./mail-store.js";
import { dueSends, periodFor, sendKey, lastFinishedShift, MAX_LATE_MS } from "../core/mail-schedule.js";
import { normalizeEmail } from "../core/mail-settings.js";
import { describeMailError } from "./mail-errors.js";

export { lastFinishedShift, MAX_LATE_MS };
export const RETRY_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
export const TICK_MS = 60_000;
export const KEEP_MARKS_MS = 30 * 24 * 3_600_000;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** Запасной список из MAIL_TO: после каждой смены, в 08:05 и 20:05. Используется, пока в настройках нет получателей. */
export function envRecipients(config) {
  return (config?.to || []).map((email) => ({
    id: `env-${email}`, name: email, email, enabled: true, source: "env",
    sends: ["08:05", "20:05"].map((time) => ({ time, what: "shift", days: ALL_DAYS })),
  }));
}

/**
 * mailer — { send } или null (SMTP не настроен); readMail() -> { recipients }; readEvents(); readRefs();
 * clock() -> Date; timers — подмена setTimeout/clearTimeout для тестов.
 */
export function createMailService({
  mailer, config, readMail = () => ({ recipients: [] }), readEvents, readRefs, clock, dataDir, log = console,
  timers = { setTimeout, clearTimeout }, retryMs = RETRY_MS, maxAttempts = MAX_ATTEMPTS,
}) {
  const enabled = Boolean(mailer && config?.enabled);
  const store = createMailSentStore(dataDir);
  const attempts = new Map(); // markKey -> { n, nextAt }
  let timer = null;
  let busy = null;
  let stopped = false;
  const nowMs = () => clock().getTime();

  const recipients = () => {
    const saved = readMail().recipients;
    return saved.length ? saved : envRecipients(config);
  };

  const build = (period) => buildDigest({ events: readEvents(), refs: readRefs().refs, nowMs: nowMs(), period, publicUrl: config?.publicUrl });
  const deliver = (digest, to) => mailer.send({
    subject: digest.subject, html: digest.html, text: digest.text, attachments: [digest.attachment], to,
  });

  /** Письмо для проверки: последний закончившийся период, адрес только этот (или MAIL_TO), отметок нет. */
  async function sendTest({ email, what = "shift" } = {}) {
    if (!enabled) return { ok: false, error: "mail_disabled", message: "Отправка почты не настроена на сервере (нет SMTP_USER или SMTP_PASS)." };
    let to;
    if (email !== undefined && email !== null && email !== "") {
      const normal = normalizeEmail(email);
      if (!normal) return { ok: false, error: "bad_request", message: "Укажите настоящий адрес электронной почты." };
      to = [normal];
    } else {
      to = config.to;
      if (!to.length) return { ok: false, error: "bad_request", message: "Не указан адрес: передайте email или задайте MAIL_TO." };
    }
    if (!["shift", "day", "week"].includes(what)) return { ok: false, error: "bad_request", message: "Вид сводки: shift, day или week." };
    try {
      const { refs } = readRefs();
      const digest = build(periodFor(what, nowMs(), refs.settings.schedule));
      const info = await deliver(digest, to);
      return { ok: true, subject: digest.subject, to, messageId: info.messageId, accepted: info.accepted };
    } catch (e) {
      const d = describeMailError(e, config);
      return { ok: false, error: "smtp", message: d.message, smtpCode: d.code };
    }
  }

  /** Один проход планировщика. */
  async function runDue() {
    if (!enabled) return { status: "disabled", sent: [], failed: [] };
    const { refs } = readRefs();
    const schedule = refs.settings.schedule;
    const now = nowMs();
    const list = recipients();
    const state = store.read();
    let dirty = false;

    // Отправка действует «с момента появления или включения»: добавленный или включённый в 09:00 получатель
    // не получает письмо за 08:05. Момент фиксирует сохранение настроек (noteSettingsChange); здесь —
    // запасной путь для отправок, о которых сервер узнал не через API (файл правили вручную, запасной список).
    // Выключенный получатель не имеет момента: включение начинает отсчёт заново.
    // Отправки из MAIL_TO были всегда (0), поэтому догоняются после простоя.
    const keys = new Set();
    for (const r of list) {
      if (!r.enabled) continue;
      for (const x of r.sends) {
        const key = sendKey(r, x);
        keys.add(key);
        if (state.firstSeen[key] === undefined) { state.firstSeen[key] = r.source === "env" ? 0 : now; dirty = true; }
      }
    }
    for (const key of Object.keys(state.firstSeen)) if (!keys.has(key)) { delete state.firstSeen[key]; dirty = true; }
    for (const [mark, at] of Object.entries(state.sent)) {
      if (now - Number(mark.slice(mark.lastIndexOf("|") + 1)) > KEEP_MARKS_MS || now - at > KEEP_MARKS_MS) { delete state.sent[mark]; dirty = true; }
    }
    if (dirty) {
      try { store.write(state); dirty = false; } catch (e) { log.error("Рассылка: отметки не записаны:", e.code || e.name); }
    }

    const legacyEndMs = readLegacyMailMark(dataDir);
    const due = dueSends(list, now, schedule, MAX_LATE_MS).filter((d) => {
      if (state.sent[d.markKey] !== undefined) return false;
      if (d.occMs < state.firstSeen[d.key]) return false;
      if (d.recipient.source === "env" && legacyEndMs !== null && d.period.toMs <= legacyEndMs) return false;
      const a = attempts.get(d.markKey);
      return !a || (a.n < maxAttempts && a.nextAt <= now);
    }).sort((x, y) => x.occMs - y.occMs);

    const sent = [];
    const failed = [];
    const digests = new Map();
    for (const d of due) {
      const groupKey = `${d.send.what}|${d.occMs}`;
      try {
        if (!digests.has(groupKey)) digests.set(groupKey, build(d.period));
        const digest = digests.get(groupKey);
        const info = await deliver(digest, [d.recipient.email]);
        // по свежему состоянию: пока шла отправка, настройки могли измениться (noteSettingsChange)
        const fresh = store.read();
        fresh.sent[d.markKey] = now;
        store.write(fresh);
        state.sent[d.markKey] = now;
        attempts.delete(d.markKey);
        sent.push({ markKey: d.markKey, email: d.recipient.email, subject: digest.subject, messageId: info.messageId });
        log.log(`Рассылка: отправлено «${digest.subject}» -> ${d.recipient.email}`);
      } catch (e) {
        const n = (attempts.get(d.markKey)?.n || 0) + 1;
        attempts.set(d.markKey, { n, nextAt: now + retryMs });
        const info = describeMailError(e, config);
        failed.push({ markKey: d.markKey, email: d.recipient.email, attempt: n, error: info.message, smtpCode: info.code });
        log.error(`Рассылка: ошибка отправки на ${d.recipient.email} (попытка ${n} из ${maxAttempts}): ${info.message}${n < maxAttempts ? `; повтор через ${Math.round(retryMs / 60_000)} мин` : "; больше не повторяем"}`);
      }
    }
    return { status: "ok", sent, failed, due: due.length };
  }

  /**
   * Вызывается при сохранении настроек (PUT /api/admin/mail): фиксирует момент появления или включения отправок.
   * Отправка, сохранённая в 08:04:50, получает момент 08:04:50, и письмо за 08:05 уйдёт; выключенная и убранные
   * теряют момент, повторное включение начинает отсчёт с нуля.
   */
  function noteSettingsChange(prev, next, at = nowMs()) {
    const active = (mail) => {
      const set = new Set();
      for (const r of mail.recipients) if (r.enabled) for (const x of r.sends) set.add(sendKey(r, x));
      return set;
    };
    const before = active(prev);
    const after = active(next);
    const state = store.read();
    for (const key of after) if (!before.has(key) || state.firstSeen[key] === undefined) state.firstSeen[key] = at;
    for (const key of before) if (!after.has(key)) delete state.firstSeen[key];
    store.write(state);
  }

  /** Параллельные вызовы сливаются в один проход. */
  function tick() {
    busy ??= runDue().finally(() => { busy = null; });
    return busy;
  }

  function arm() {
    if (stopped) return;
    timers.clearTimeout(timer);
    const wait = TICK_MS - (nowMs() % TICK_MS) + 1000; // ближайшая минута плюс секунда
    timer = timers.setTimeout(async () => {
      try { await tick(); } catch (e) { log.error("Рассылка: сбой планировщика:", e?.message || e); }
      arm();
    }, wait);
    timer?.unref?.();
  }

  function start() {
    if (!enabled) { log.log("рассылка выключена"); return; }
    log.log(`Рассылка включена: ${config.host}:${config.port}`);
    arm();
    tick().catch((e) => log.error("Рассылка: сбой при запуске:", e?.message || e));
  }

  function stop() {
    stopped = true;
    timers.clearTimeout(timer);
  }

  return { enabled, start, stop, tick, sendTest, noteSettingsChange, store };
}
