import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../../app/server/index.js";

const KEY = "assets-key";
const NOW = new Date("2026-01-01T12:00:30.000Z");

async function start() {
  const app = createApp({ dataDir: ":memory:", deviceKeys: [{ name: "assets", key: KEY }], now: () => NOW });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test("страница: каждый файл из списка офлайн-кеша отдаётся сервером (иначе установка service worker падает)", async () => {
  const { app, base } = await start();
  try {
    const source = fs.readFileSync(new URL("../../app/public/sw.js", import.meta.url), "utf8");
    const assets = [...source.slice(source.indexOf("const ASSETS"), source.indexOf("];")).matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
    assert.ok(assets.includes("core/report.js") && assets.includes("core/xlsx.js") && assets.includes("core/report-period.js"));
    assert.ok(assets.includes("report-ui.js") && assets.includes("report.css"));
    for (const asset of assets) {
      const response = await fetch(`${base}/${asset}`);
      assert.equal(response.status, 200, asset);
      const type = response.headers.get("content-type");
      if (asset.endsWith(".js")) assert.match(type, /javascript/, asset);
      await response.arrayBuffer();
    }
    // Все модули ядра отдаются странице, остальное — нет
    for (const file of fs.readdirSync(path.resolve(import.meta.dirname, "../../app/core"))) {
      assert.equal((await fetch(`${base}/core/${file}`)).status, 200, file);
    }
    assert.equal((await fetch(`${base}/core/нет-такого.js`)).status, 404);
    assert.equal((await fetch(`${base}/core/nope.js`)).status, 404);
    assert.equal((await fetch(`${base}/core/..%2Fserver%2Findex.js`)).status, 404);
    assert.equal((await fetch(`${base}/core/%2e%2e/server/index.js`)).status, 404);
    assert.equal((await fetch(`${base}/core/sub/x.js`)).status, 404);
  } finally { await app.close(); }
});
