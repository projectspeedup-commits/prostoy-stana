// Отчёт не должен зависеть от пояса компьютера: гоняем его проверки под разными TZ (как tz.test.js для ядра).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const targets = ["./report.test.js", "./report-period.test.js", "./xlsx.test.js"].map((name) => fileURLToPath(new URL(name, import.meta.url)));

for (const tz of ["America/New_York", "Europe/Moscow", "Asia/Kolkata", "UTC"]) {
  test(`проверки отчёта проходят при TZ=${tz}`, (t) => {
    const env = { ...process.env, TZ: tz };
    delete env.NODE_TEST_CONTEXT; // иначе дочерний процесс считает себя частью родительского прогона
    const r = spawnSync(process.execPath, ["--test", ...targets], { env, encoding: "utf8" });
    if (r.error?.code === "EPERM") {
      t.skip("Среда запретила запуск дочернего Node-процесса");
      return;
    }
    assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-1000));
  });
}
