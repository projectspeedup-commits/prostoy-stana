import fs from "node:fs";
import crypto from "node:crypto";

export function fileSignature(filename) {
  if (!filename) return "missing";
  try {
    const st = fs.statSync(filename, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return "missing";
  }
}

// Антивирус или индексатор Windows может ненадолго удерживать файл.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      if (!["EPERM", "EBUSY"].includes(e.code) || attempt === 4) throw e;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 100)));
    }
  }
}

// filename=null используется только вместе с SQLite :memory: (без файлов на диске).
export function createSettingsStore(filename) {
  let memory = null;
  return {
    signature: () => filename ? fileSignature(filename) : JSON.stringify(memory),
    read() {
      if (!filename) return memory;
      try {
        const data = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Некорректный файл настроек");
        return data;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        return null;
      }
    },
    async write(settings) {
      const data = { version: 1, ...settings };
      if (!filename) { memory = data; return; }
      const suffix = `${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`;
      const temporary = `${filename}.${suffix}`;
      const backupTemporary = `${filename}.bak.${suffix}`;
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
        let previous;
        try { previous = await fs.promises.readFile(filename); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
        if (previous !== undefined) {
          await fs.promises.writeFile(backupTemporary, previous, { flag: "wx" });
          await renameWithRetry(backupTemporary, `${filename}.bak`);
        }
        await renameWithRetry(temporary, filename);
      } finally {
        await Promise.all([temporary, backupTemporary].map((file) => fs.promises.rm(file, { force: true })));
      }
    },
  };
}
