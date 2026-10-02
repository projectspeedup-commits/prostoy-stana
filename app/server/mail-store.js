// Файлы рассылки в каталоге данных:
//   mail-settings.json — получатели и расписание (правит владелец в «Администраторе»);
//   mail-sent.json     — отметки «отправлено» и «впервые увидена отправка».
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { emptyMailSettings, validateMailSettings } from "../core/mail-settings.js";

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); break; }
    catch (e) {
      if (!["EPERM", "EBUSY"].includes(e.code) || attempt === 4) { fs.rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
    }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch (e) {
    if (e.code !== "ENOENT") console.error(`${path.basename(file)} не прочитан:`, e.code || e.name);
    return null;
  }
}

const inMemory = (dataDir) => !dataDir || dataDir === ":memory:";
export const versionOf = (mail) => crypto.createHash("sha256").update(JSON.stringify(mail)).digest("hex").slice(0, 12);

/** Хранилище настроек рассылки. read() всегда возвращает проверенный объект. */
export function createMailSettingsStore(dataDir) {
  const file = inMemory(dataDir) ? null : path.join(dataDir, "mail-settings.json");
  let memory = emptyMailSettings();
  return {
    file,
    read() {
      if (!file) return memory;
      const saved = readJson(file);
      if (!saved) return emptyMailSettings();
      try { return validateMailSettings(saved); }
      catch (e) { console.error("mail-settings.json повреждён:", e.message); return emptyMailSettings(); }
    },
    write(mail) {
      if (!file) { memory = mail; return; }
      atomicWrite(file, { version: 1, ...mail });
    },
  };
}

const emptySent = () => ({ version: 1, firstSeen: {}, sent: {} });

/** Отметки отправок. */
export function createMailSentStore(dataDir) {
  const file = inMemory(dataDir) ? null : path.join(dataDir, "mail-sent.json");
  let memory = emptySent();
  return {
    file,
    read() {
      if (!file) return structuredClone(memory);
      const data = readJson(file);
      if (!data || typeof data.sent !== "object" || typeof data.firstSeen !== "object") return emptySent();
      return { version: 1, firstSeen: data.firstSeen, sent: data.sent };
    },
    write(data) {
      if (!file) { memory = structuredClone(data); return; }
      atomicWrite(file, data);
    },
  };
}

/** Старая отметка прежней рассылки (одна последняя смена) — только чтение, чтобы не слать повторно после обновления. */
export function readLegacyMailMark(dataDir) {
  if (inMemory(dataDir)) return null;
  const data = readJson(path.join(dataDir, "mail-state.json"));
  return data && Number.isFinite(data.lastSentEndMs) ? data.lastSentEndMs : null;
}
