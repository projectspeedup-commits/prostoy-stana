import fs from "node:fs";
import crypto from "node:crypto";
import { DEFAULT_REFS } from "./refs.js";
import { SETTINGS_CREWS, validateSettings } from "../core/settings.js";
import { fileSignature } from "./settings.js";

// Две смены по 12 часов: Смена 1 — дневная, Смена 2 — ночная; в списке — мастера с полным ФИО
function demoPeople() {
  const crews = SETTINGS_CREWS;
  const people = [
    ["Демонов Первый Иванович", "1"], ["Демонов Второй Петрович", "1"],
    ["Демонов Третий Сергеевич", "2"], ["Демонов Четвёртый Павлович", "2"],
  ].map(([name, crewId], i) => ({ id: `d${i + 1}`, name, crewId, phone: "" }));
  return { crews, people, demo: true };
}

export function createRefsReader(filename, settingsStore) {
  let signature;
  let cached;
  return () => {
    const peopleSignature = fileSignature(filename);
    const next = `${settingsStore?.signature() ?? "missing"}|${peopleSignature}`;
    if (next !== signature) {
      let data = demoPeople();
      const saved = settingsStore?.read();
      if (saved != null) {
        if (saved.version !== 1 || !Array.isArray(saved.people) ||
          !saved.people.every((p) => p && typeof p.id === "string" && p.id.length > 0)) {
          throw new Error("Некорректный файл настроек");
        }
        const settings = validateSettings(saved, saved.people);
        data = {
          crews: SETTINGS_CREWS,
          people: settings.people,
          demo: false,
          settings: {
            ...DEFAULT_REFS.settings,
            schedule: { tzOffsetMinutes: 180, shifts: settings.schedule.shifts },
            contacts: settings.contacts,
          },
        };
      } else if (peopleSignature !== "missing") {
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
          crews: SETTINGS_CREWS,
          people: parsed.people.map(({ id, name, crewId }) => ({ id: String(id), name, crewId: String(crewId), phone: "" })),
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
