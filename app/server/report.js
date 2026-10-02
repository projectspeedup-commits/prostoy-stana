// GET /api/report.xlsx?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД — отчёт «Отчёт в Excel» за производственные сутки.
// Всё считает общее ядро (core/report.js); здесь только чтение событий и разбор ответа HTTP.
import { reportFile, XLSX_MIME } from "../core/report.js";

/** Content-Disposition с русским именем: простое имя для старых клиентов и filename* (RFC 5987). */
export function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="report.xlsx"; filename*=UTF-8''${encoded}`;
}

export function createReportHandler({ db, readRefs, clock }) {
  const readEvents = db.prepare("SELECT body FROM events ORDER BY at_ms, rowid");
  return function handleReport(res, searchParams) {
    const { refs } = readRefs();
    const nowMs = clock().getTime();
    const events = readEvents.all().map((row) => JSON.parse(row.body));
    const result = reportFile({ from: searchParams.get("from"), to: searchParams.get("to"), events, refs, nowMs });
    if (!result.ok) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "bad_request", message: result.message }));
      return;
    }
    const body = Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.length);
    res.writeHead(200, {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": contentDisposition(result.filename),
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  };
}
