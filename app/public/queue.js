// Очередь отправляется по порядку; лимит относится к UTF-8 JSON вместе с оболочкой.
export function eventBatch(queue, limit = 50, bytes = 40 * 1024) {
  const batch = [];
  for (const event of queue.slice(0, limit)) {
    const next = [...batch, event];
    if (new TextEncoder().encode(JSON.stringify({ events: next })).length > bytes) break;
    batch.push(event);
    if (event.type === "stop") break; // сначала получаем ID возможного уже открытого простоя
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
  const confirmed = records.filter((r) => ["saved", "replaced", "adopted"].includes(r.status)
    && Date.parse(r.event.at) >= nowMs - 3 * 86400000)
    .sort((a, b) => Date.parse(a.confirmedAt || a.event.at) - Date.parse(b.confirmedAt || b.event.at)).slice(-300);
  const keep = new Set(confirmed);
  return records.filter((r) => r.status === "rejected" || r.status === "pending" || keep.has(r));
}
