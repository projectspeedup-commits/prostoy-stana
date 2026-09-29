import fs from "node:fs";
import crypto from "node:crypto";
import { DEFAULT_REFS } from "./refs.js";

function demoPeople() {
  const crews = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), title: `Бригада ${i + 1}` }));
  const names = ["Первый", "Второй", "Третий", "Четвёртый"];
  const people = crews.flatMap((crew) => names.map((name, i) => ({
    id: `${crew.id}-${i + 1}`, name: `Демо ${name} ${crew.id}`, crewId: crew.id,
  })));
  return { crews, people, demo: true };
}

export function createRefsReader(filename) {
  let signature;
  let cached;
  return () => {
    let next = "demo";
    if (filename) {
      try {
        const st = fs.statSync(filename, { bigint: true });
        next = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    if (next !== signature) {
      let data = demoPeople();
      if (next !== "demo") {
        const parsed = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
        const id = (v) => (typeof v === "string" && v.length > 0) || Number.isSafeInteger(v);
        if (!parsed || !Array.isArray(parsed.crews) || !Array.isArray(parsed.people) ||
          !parsed.crews.every((c) => c && id(c.id) && typeof c.title === "string") ||
          !parsed.people.every((p) => p && id(p.id) && typeof p.name === "string" && parsed.crews.some((c) => c.id === p.crewId)) ||
          new Set(parsed.crews.map((c) => c.id)).size !== parsed.crews.length ||
          new Set(parsed.people.map((p) => p.id)).size !== parsed.people.length) {
          throw new Error("Некорректный справочник людей");
        }
        data = {
          crews: parsed.crews.map(({ id, title }) => ({ id, title })),
          people: parsed.people.map(({ id, name, crewId }) => ({ id, name, crewId })),
          demo: false,
        };
      }
      const refs = { ...DEFAULT_REFS, ...data };
      const refsVersion = crypto.createHash("sha256").update(JSON.stringify(refs)).digest("hex").slice(0, 12);
      cached = { refs, refsVersion };
      signature = next;
    }
    return cached;
  };
}
