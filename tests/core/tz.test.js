// Расчёт не должен зависеть от пояса компьютера: гоняем core.test.js под разными TZ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./core.test.js", import.meta.url));

for (const tz of ["America/New_York", "Europe/Moscow", "UTC"]) {
  test(`core.test.js проходит при TZ=${tz}`, (t) => {
    const env = { ...process.env, TZ: tz };
    delete env.NODE_TEST_CONTEXT; // иначе дочерний процесс считает себя частью родительского прогона
    const r = spawnSync(process.execPath, [target], { env, encoding: "utf8" });
    if (r.error?.code === "EPERM") {
      t.skip("Среда запретила запуск дочернего Node-процесса");
      return;
    }
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
