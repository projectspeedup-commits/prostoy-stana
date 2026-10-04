// Очередь отправляется по порядку; лимит относится к UTF-8 JSON вместе с оболочкой.
export function eventBatch(queue, limit = 50, bytes = 40 * 1024) {
  const batch = [];
  for (const event of queue.slice(0, limit)) {
    if (["stop", "start"].includes(event.type) && batch.length) break;
    const next = [...batch, event];
    if (new TextEncoder().encode(JSON.stringify({ events: next })).length > bytes) break;
    batch.push(event);
    if (["stop", "start"].includes(event.type)) break; // ответы зависят от квитанции управления станом
  }
  return batch;
}

export async function deliverBatch(api, queue) {
  let batch = eventBatch(queue);
  if (!batch.length) return { batch: queue.slice(0, 1), data: { saved: [], rejected: [{ id: queue[0].id, error: "too_large" }] } };
  for (;;) {
    try {
      return { batch, data: await api("/api/events", { method: "POST", body: JSON.stringify({ events: batch }) }) };
    } catch (e) {
      if (e.status !== 400 && e.status !== 413) throw e;
      // Уменьшаем 413; 400 изолируем до конкретной записи, остальные не теряем.
      if (batch.length > 1) { batch = batch.slice(0, e.status === 413 ? Math.ceil(batch.length / 2) : 1); continue; }
      return { batch, data: { saved: [], rejected: [{ id: batch[0].id,
        error: e.status === 413 ? "too_large" : e.data?.error || "bad_request", message: e.data?.message }] } };
    }
  }
}

export function pruneRecords(records, nowMs) {
  const unresolved = new Set(records.filter((r) => ["pending", "rejected"].includes(r.status)).map((r) => r.groupId || downtimeKey(r.event)));
  const needed = new Set(records.filter((r) => ["pending", "rejected"].includes(r.status)).map((r) => r.event.after));
  const confirmed = records.filter((r) => ["saved", "replaced", "adopted", "dismissed"].includes(r.status)
    && Date.parse(["dismissed", "replaced"].includes(r.status) ? r.confirmedAt || r.event.at : r.event.at) >= nowMs - 3 * 86400000)
    .sort((a, b) => Date.parse(a.confirmedAt || a.event.at) - Date.parse(b.confirmedAt || b.event.at)).slice(-300);
  const keep = new Set(confirmed);
  return records.filter((r) => r.status === "rejected" || r.status === "pending" || keep.has(r) || needed.has(r.event.id)
    || unresolved.has(r.groupId || downtimeKey(r.event)));
}

// Цепочка исправлений переживает ограничение истории и перезагрузку с отдельной очередью.
// Метаданные остаются только у тех квитанций/неотправленных записей, которым они нужны.
export function settleRecords(records, state) {
  const byId = new Map(records.map((r) => [r.event.id, r]));
  const rootOf = (r) => {
    if (r.rootId) return r.rootId;
    const seen = new Set();
    let cur = r;
    while (cur.replaces && !seen.has(cur.replaces)) {
      seen.add(cur.replaces);
      const prev = byId.get(cur.replaces);
      if (!prev) return cur.replaces;
      if (prev.rootId) return prev.rootId;
      cur = prev;
    }
    return cur.event.id;
  };
  const roots = new Map(records.map((r) => [r.event.id, rootOf(r)]));
  const savedRoots = new Set(records.filter((r) => r.rootAccepted || (['saved', 'adopted'].includes(r.status) && r.replaces))
    .map((r) => roots.get(r.event.id)));
  const known = new Set([...(state?.day?.segments || []), ...(state?.segments || [])].map((s) => s.downtimeId));
  if (state?.open) known.add(state.open.downtimeId);
  let count = 0;
  const superseded = new Set(records.filter((r) => r.replaces).map((r) => r.replaces));
  for (const r of records) {
    r.rootId = roots.get(r.event.id);
    if (savedRoots.has(r.rootId)) r.rootAccepted = true;
    if (r.status === 'rejected' && (superseded.has(r.event.id) || r.rootAccepted || (r.event.type === 'stop' && r.error !== 'duplicate_downtime' && known.has(r.event.downtimeId ?? r.event.id)))) {
      r.status = 'replaced';
      r.confirmedAt ||= records.findLast((next) => next.replaces === r.event.id)?.event.at || r.event.at;
      count++;
    }
    if (r.status === 'rejected' && ['start', 'reason', 'split', 'fix'].includes(r.event.type)) {
      const own = [...(state?.day?.segments || []), ...(state?.segments || [])].filter((s) => s.downtimeId === r.event.downtimeId);
      if (own.length && state?.open?.downtimeId !== r.event.downtimeId) {
        r.conflict = { downtimeId: r.event.downtimeId, startMs: Math.min(...own.map((s) => s.startMs)),
          endMs: Math.max(...own.map((s) => s.endMs)), segments: own.sort((a, b) => a.index - b.index) };
      }
    }
  }
  return count;
}

export const downtimeKey = (e) => e.downtimeId || e.id;
export const isAccepted = (r) => r && (["saved", "adopted"].includes(r.status) || r.rootAccepted);

// Независимые события продолжают отправляться, даже когда один простой ждёт исправления.
export function readyEvents(queue, records, optimistic = false) {
  const byId = new Map(records.map((r) => [r.event.id, r]));
  const passed = (r) => isAccepted(r) || (optimistic && r?.status === "pending");
  const latest = (r) => {
    const seen = new Set();
    while (r && !seen.has(r.event.id)) {
      seen.add(r.event.id);
      const next = records.findLast((x) => x.replaces === r.event.id);
      if (!next) break;
      r = next;
    }
    return r;
  };
  return queue.filter((e) => {
    if (byId.get(e.id)?.status !== "pending") return false;
    if (e.onlyEmpty) return true;
    if (e.after && !passed(latest(byId.get(e.after)))) return false;
    if (["stop", "manual", "shift_open", "shift_close"].includes(e.type)) return true;
    const stop = records.findLast((r) => ["stop", "manual"].includes(r.event.type) && downtimeKey(r.event) === downtimeKey(e));
    if (stop && !passed(latest(stop))) return false;
    // Очередь старых версий ещё не содержит after. Сохраняем порядок пуска и его ответов.
    const pos = records.findIndex((r) => r.event.id === e.id);
    const start = records.slice(0, pos).findLast((r) => r.event.type === "start" && downtimeKey(r.event) === downtimeKey(e));
    return !["reason", "fix"].includes(e.type) || !start || passed(latest(start));
  });
}

export function rejectionGroups(records) {
  const groups = new Map();
  for (const r of records) {
    const key = r.groupId || downtimeKey(r.event);
    if (!groups.has(key)) groups.set(key, { key, records: [] });
    groups.get(key).records.push(r);
  }
  return [...groups.values()].filter((g) => g.records.some((r) => r.status === "rejected")).map((g) => {
    const active = g.records.filter((r) => !["dismissed", "replaced"].includes(r.status));
    const record = active.find((r) => r.status === "rejected" && ["stop", "start", "manual"].includes(r.event.type))
      || active.find((r) => r.status === "rejected");
    const fields = {};
    for (const { event: e } of active) {
      for (const k of ["reason", "note", "action", "billet"]) if (e[k] !== undefined) fields[k] = e[k];
      if (e.type === "stop") fields.from = e.at;
      if (e.type === "start") fields.to = e.at;
      if (e.type === "manual") { fields.from = e.from; fields.to = e.to; }
    }
    return { ...g, record, fields };
  });
}

// Не стираем занятые поля даже при одновременном переносе с другого устройства.
export function transferFields(fields, target) {
  const empty = (v) => v == null || (typeof v === "string" && !v.trim());
  return Object.fromEntries(["reason", "note", "action", "billet"].filter((k) => !empty(fields[k]) && empty(target[k])).map((k) => [k, fields[k]]));
}

export function reusableRestart(draft, view, nowMs) {
  return !!(draft && view.open && draft.downtimeId === view.open.downtimeId && draft.index === view.open.index
    && draft.shiftStartMs === view.shift.startMs && nowMs >= draft.createdMs && nowMs - draft.createdMs < 600000);
}

const statusRank = { pending: 0, rejected: 1, replaced: 2, dismissed: 3, adopted: 4, saved: 4 };
// Порядок аргументов решает лишь равные версии. Квитанция всегда сильнее старого черновика.
export function mergeRecords(...lists) {
  const byId = new Map();
  for (const r of lists.flat()) {
    if (!r?.event?.id) continue;
    const old = byId.get(r.event.id);
    if (!old || (statusRank[r.status] ?? 0) >= (statusRank[old.status] ?? 0)) byId.set(r.event.id, { ...old, ...r });
  }
  return [...byId.values()].sort((a, b) => (a.event.seq || 0) - (b.event.seq || 0));
}
export function mergeQueue(records, ...lists) {
  const receipt = new Map(records.map((r) => [r.event.id, r]));
  const result = new Map();
  for (const e of lists.flat()) {
    if (e?.id && (!receipt.has(e.id) || receipt.get(e.id).status === "pending")) result.set(e.id, receipt.get(e.id)?.event || e);
  }
  const queue = [...result.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const r of records.filter((r) => r.status === 'adopted' && r.adoptedDowntimeId)) {
    for (const e of queue) if (e.downtimeId === downtimeKey(r.event)) e.downtimeId = r.adoptedDowntimeId;
  }
  return queue;
}

export function tapGuard(now = () => performance.now()) {
  let screen = null, until = 0;
  return {
    screen(value) { if (value !== screen) { screen = value; until = now() + 400; } },
    blocked() { return now() < until; },
  };
}

export function fullNameError(parts) {
  if (parts.some((v) => !String(v || "").trim())) return "Впишите фамилию, имя и отчество полностью.";
  if (parts.map((s) => s.trim()).join(" ").length > 120) return "ФИО должно содержать не больше 120 символов вместе с пробелами.";
  if (parts.some((v) => !/^[\p{Script=Cyrillic}A-Za-z][\p{Script=Cyrillic}A-Za-z’' -]+$/u.test(v.trim()))) {
    return "Используйте буквы кириллицы или латиницы, пробел, дефис или апостроф. Каждое слово — полностью, не меньше двух букв, без точек и цифр.";
  }
  return "";
}

// Миграция черновика старой версии. Раньше несохранённые правки «Что случилось/Что сделали» лежали в af
// ({downtimeId, index, field, value}, экран actionFix), а «Брак» — в bl ({downtimeId, index, value, custom}, экран billet).
// Теперь это один черновик редактора простоя `edit`. Возвращает новый черновик; без старых полей отдаёт тот же объект.
export function migrateLegacyDraft(draft) {
  if (!draft || typeof draft !== "object") return draft;
  const legacyScreen = draft.screen === "actionFix" || draft.screen === "billet";
  if (!legacyScreen && !draft.af && !draft.bl) return draft;
  const target = (x) => x && typeof x === "object" && typeof x.downtimeId === "string" && x.downtimeId ? x : null;
  const af = target(draft.af);
  const bl = target(draft.bl);
  const out = { ...draft };
  delete out.af;
  delete out.bl;
  const first = draft.screen === "billet" ? (bl || af) : (af || bl);
  if (first && !out.edit) {
    const edit = { downtimeId: first.downtimeId, index: first.index ?? null, base: null, migrated: [],
      note: "", action: "", billet: "", billetOther: false };
    const same = (x) => x && x.downtimeId === edit.downtimeId && (x.index ?? null) === edit.index;
    if (same(af)) {
      const field = af.field === "note" ? "note" : "action";
      edit[field] = String(af.value ?? "");
      edit.migrated.push(field);
    }
    if (same(bl)) {
      edit.billet = String(bl.value ?? "").replace(".", ",");
      edit.billetOther = bl.custom === true;
      edit.migrated.push("billet");
    }
    out.edit = edit;
    out.card = { downtimeId: edit.downtimeId, index: edit.index };
    out.screen = "detail";
  } else if (legacyScreen) {
    out.screen = out.card && typeof out.card === "object" ? "detail" : "auto";
  }
  return out;
}
