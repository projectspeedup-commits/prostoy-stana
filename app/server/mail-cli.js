// Сборка письма по базе без отправки:
//   node app/server/mail-cli.js --dry-run --out <папка> [--now 2026-10-02T09:00:00+03:00]
// Данные берутся оттуда же, откуда у сервера: STAN_DATA_DIR (stan.db, settings.json), STAN_PEOPLE_FILE.
// Сохраняет digest.html, digest.txt и Excel-вложение; в консоль пишет тему и имена файлов.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { toMs } from "../core/core.js";
import { createRefsReader } from "./people.js";
import { createSettingsStore } from "./settings.js";
import { lastFinishedShift } from "./mail-service.js";
import { buildDigest } from "./digest.js";
import { mailConfigFromEnv } from "./mailer.js";

function parseArgs(argv) {
  const args = { dryRun: false, out: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--now") args.now = argv[++i];
    else throw new Error(`Неизвестный параметр: ${a}`);
  }
  return args;
}

export function runCli(argv, env = process.env, out = console) {
  const args = parseArgs(argv);
  if (!args.dryRun) throw new Error("Поддерживается только --dry-run (отправка — через сервер: POST /api/mail/test).");
  if (!args.out) throw new Error("Укажите папку для файлов: --out <папка>");
  const dataDir = env.STAN_DATA_DIR || "./data";
  const dbFile = path.join(dataDir, "stan.db");
  if (!fs.existsSync(dbFile)) throw new Error(`Нет базы: ${dbFile}`);
  const nowMs = args.now ? toMs(args.now) : Date.now();
  const db = new DatabaseSync(dbFile);
  try {
    const readRefs = createRefsReader(env.STAN_PEOPLE_FILE, createSettingsStore(path.join(dataDir, "settings.json")));
    const { refs } = readRefs();
    const events = db.prepare("SELECT body FROM events ORDER BY at_ms, rowid").all().map((row) => JSON.parse(row.body));
    const shift = lastFinishedShift(nowMs, refs.settings.schedule, 0);
    const digest = buildDigest({ events, refs, nowMs, shift, publicUrl: mailConfigFromEnv(env).publicUrl });
    fs.mkdirSync(args.out, { recursive: true });
    const files = {
      html: path.join(args.out, "digest.html"),
      text: path.join(args.out, "digest.txt"),
      xlsx: path.join(args.out, digest.attachment.filename),
    };
    fs.writeFileSync(files.html, digest.html);
    fs.writeFileSync(files.text, digest.text);
    fs.writeFileSync(files.xlsx, digest.attachment.content);
    out.log(`Тема: ${digest.subject}`);
    for (const file of Object.values(files)) out.log(`Файл: ${file}`);
    return { digest, files };
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exit(1);
  }
}
