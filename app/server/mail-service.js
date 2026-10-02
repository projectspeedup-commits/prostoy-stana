// Рассылка сводки смены: выбор смены, планировщик, отметка «уже отправлено», повторы при ошибке.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { shiftOf } from "../core/core.js";
import { buildDigest } from "./digest.js";

export const SEND_DELAY_MS = 5 * 60_000; // письмо через 5 минут после конца смены (08:05 и 20:05)
export const MAX_LATE_MS = 2 * 3_600_000; // при запуске досылаем, только если с конца смены прошло меньше 2 часов
export const RETRY_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
const STATE_FILE = "mail-state.json";

/**
 * Последняя смена, закончившаяся не позже nowMs - delayMs. Границы смен берёт shiftOf из расписания (МСК),
 * часовой пояс процесса не участвует.
 */
export function lastFinishedShift(nowMs, schedule, delayMs = 0) {
  const current = shiftOf(nowMs, schedule);
  let prev = shiftOf(current.startMs - 1, schedule);
  while (prev.endMs + delayMs > nowMs) prev = shiftOf(prev.startMs - 1, schedule);
  return prev;
}

/** Ближайший момент отправки строго позже nowMs: граница смены + задержка. */
export function nextDueMs(nowMs, schedule, delayMs = SEND_DELAY_MS) {
  const current = shiftOf(nowMs, schedule);
  const start = current.startMs + delayMs;
  return start > nowMs ? start : current.endMs + delayMs;
}

/** Отметка об отправленной смене в файле каталога данных (в памяти, если база :memory:). */
export function createMailState(dataDir) {
  const file = !dataDir || dataDir === ":memory:" ? null : path.join(dataDir, STATE_FILE);
  let memory = null;
  return {
    file,
    read() {
      if (!file) return memory;
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
        return data && Number.isFinite(data.lastSentEndMs) ? data : null;
      } catch (e) {
        if (e.code !== "ENOENT") console.error("mail-state.json не прочитан:", e.code || e.name);
        return null;
      }
    },
    write(data) {
      if (!file) { memory = data; return; }
      const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
      try { fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
    },
  };
}

/**
 * Служба рассылки.
 * mailer — { send } или null (рассылка выключена); readEvents() -> события; readRefs() -> { refs };
 * clock() -> Date; timers — подмена setTimeout/clearTimeout в тестах.
 */
export function createMailService({
  mailer, config, readEvents, readRefs, clock, dataDir, log = console,
  timers = { setTimeout, clearTimeout }, retryMs = RETRY_MS, maxAttempts = MAX_ATTEMPTS,
}) {
  const enabled = Boolean(mailer && config?.enabled);
  const state = createMailState(dataDir);
  const attempts = new Map(); // endMs смены -> число неудачных попыток
  let timer = null;
  let retryTimer = null;
  let busy = null;
  let stopped = false;

  const nowMs = () => clock().getTime();
  const build = (shift) => buildDigest({
    events: readEvents(), refs: readRefs().refs, nowMs: nowMs(), shift, publicUrl: config?.publicUrl,
  });
  const deliver = async (digest) => mailer.send({
    subject: digest.subject, html: digest.html, text: digest.text, attachments: [digest.attachment],
  });

  /** Письмо о последней закончившейся смене. Состояние не трогает. */
  async function buildLast() {
    const { refs } = readRefs();
    return build(lastFinishedShift(nowMs(), refs.settings.schedule, 0));
  }

  /** Ручная проверка: отправить сейчас, результат или ошибка SMTP. Отметку не ставит. */
  async function sendTest() {
    if (!enabled) return { ok: false, error: "mail_disabled", message: "Рассылка выключена: не заданы SMTP_USER, SMTP_PASS или MAIL_TO." };
    try {
      const digest = await buildLast();
      const info = await deliver(digest);
      return { ok: true, subject: digest.subject, to: config.to, messageId: info.messageId, accepted: info.accepted };
    } catch (e) {
      return { ok: false, error: "smtp", message: String(e?.message || e) };
    }
  }

  /** Отправить, если последняя закончившаяся смена ещё не отправлена. */
  async function runDue() {
    if (!enabled) return { status: "disabled" };
    const { refs } = readRefs();
    const now = nowMs();
    const shift = lastFinishedShift(now, refs.settings.schedule, SEND_DELAY_MS);
    const sent = state.read();
    if (sent && sent.lastSentEndMs >= shift.endMs) return { status: "already_sent", shift };
    if (now - shift.endMs >= MAX_LATE_MS) return { status: "too_late", shift };
    if ((attempts.get(shift.endMs) || 0) >= maxAttempts) return { status: "gave_up", shift };
    try {
      const digest = build(shift);
      const info = await deliver(digest);
      try {
        state.write({ version: 1, lastSentEndMs: shift.endMs, lastSentAt: new Date(now).toISOString(), shift: `${shift.day}|${shift.shiftNo}`, messageId: info.messageId });
      } catch (e) {
        log.error(`Рассылка: письмо отправлено, но отметку записать не удалось (${e.code || e.name}); возможен повтор после перезапуска.`);
      }
      attempts.delete(shift.endMs);
      log.log(`Рассылка: отправлено «${digest.subject}» -> ${config.to.length} адр.`);
      return { status: "sent", shift, subject: digest.subject };
    } catch (e) {
      const n = (attempts.get(shift.endMs) || 0) + 1;
      attempts.set(shift.endMs, n);
      const more = n < maxAttempts;
      log.error(`Рассылка: ошибка отправки (попытка ${n} из ${maxAttempts}): ${e?.message || e}${more ? `; повтор через ${Math.round(retryMs / 60_000)} мин` : "; больше не повторяем"}`);
      if (more && !stopped) {
        retryTimer = timers.setTimeout(() => { retryTimer = null; void tick(); }, retryMs);
        retryTimer?.unref?.();
      }
      return { status: "failed", shift, attempt: n, error: String(e?.message || e) };
    }
  }

  /** Один проход; параллельные вызовы сливаются в один. */
  function tick() {
    busy ??= runDue().finally(() => { busy = null; });
    return busy;
  }

  function arm() {
    if (stopped) return;
    timers.clearTimeout(timer);
    const { refs } = readRefs();
    const wait = Math.max(1000, nextDueMs(nowMs(), refs.settings.schedule) - nowMs());
    timer = timers.setTimeout(async () => {
      try { await tick(); } catch (e) { log.error("Рассылка: сбой планировщика:", e?.message || e); }
      arm();
    }, wait);
    timer?.unref?.();
  }

  function start() {
    if (!enabled) { log.log("рассылка выключена"); return; }
    log.log(`Рассылка включена: ${config.host}:${config.port}, получателей: ${config.to.length}`);
    arm();
    tick().catch((e) => log.error("Рассылка: сбой при запуске:", e?.message || e));
  }

  function stop() {
    stopped = true;
    timers.clearTimeout(timer);
    timers.clearTimeout(retryTimer);
  }

  return { enabled, start, stop, tick, sendTest, buildLast, state };
}
