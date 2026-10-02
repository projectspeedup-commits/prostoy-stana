// Тексты ошибок панели «Отчёт в Excel». Модуль страницы подключает ядро по адресу ./core/…, которого в репозитории нет
// (сервер отдаёт app/core под этим именем), поэтому в тесте адрес подменяется — приём из tests/server/admin.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadUi() {
  const coreUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../app/core/")).href + "/";
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../app/public/report-ui.js"), "utf8")
    .replaceAll('"./core/', '"' + coreUrl);
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

test("панель отчёта: текст ошибки по ответу сервера и по состоянию связи", async () => {
  const { reportErrorText } = await loadUi();
  // 400 — сообщение сервера как есть
  assert.equal(reportErrorText({ status: 400, data: { message: "Период не может быть длиннее 92 суток: выбрано 100." } }),
    "Период не может быть длиннее 92 суток: выбрано 100.");
  // 400 без текста — общий ответ об ошибке
  assert.match(reportErrorText({ status: 400, data: null }), /Сервер ответил ошибкой \(400\)/);
  assert.match(reportErrorText({ status: 401 }), /ключ не подошёл/);
  assert.match(reportErrorText({ status: 429 }), /Слишком много запросов/);
  assert.match(reportErrorText({ status: 500 }), /Сервер не смог подготовить отчёт/);
  assert.match(reportErrorText({ status: 503 }), /Сервер не смог подготовить отчёт/);
  assert.match(reportErrorText({ status: 404 }), /Сервер ответил ошибкой \(404\)/);
  assert.match(reportErrorText({ name: "AbortError" }), /не ответил за минуту/);
  // Нет ответа вообще (fetch упал, сети нет, имитация «рубильника» в демо) — текст из задания
  for (const error of [new TypeError("Failed to fetch"), new Error("mock_offline"), null, undefined]) {
    assert.equal(reportErrorText(error), "Нет связи с сервером. Отчёт скачивается только при связи.");
  }
  for (const error of [{ status: 400, data: { message: "а" } }, { status: 401 }, { status: 429 }, { status: 500 }, { name: "AbortError" }, null]) {
    assert.match(reportErrorText(error), /[а-яё]/i, "все тексты — по-русски");
  }
});
