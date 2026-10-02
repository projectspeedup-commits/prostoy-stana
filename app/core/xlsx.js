// Писатель книг .xlsx без зависимостей. Одинаково работает в Node и в браузере:
// только TextEncoder, Uint8Array и DataView. Строки пишутся как inlineStr, ZIP — методом store,
// CRC32 — по таблице. Порядок элементов в листе жёсткий (Excel иначе предлагает «восстановить файл»):
// sheetPr → dimension → sheetViews → sheetFormatPr → cols → sheetData → autoFilter → mergeCells →
// pageMargins → pageSetup → headerFooter → rowBreaks.
//
// Модель книги (её строит core/report.js):
//   { title, creator, createdMs, sheets: [Лист] }
//   Лист:  { name, columns: [{ width }], rows: [Строка], freeze: { rows, cols }, autoFilter: { r, c, r2, c2 },
//            merges: [{ r, c, r2, c2 }], printTitleRows: [r, r2], landscape: true, tabColor,
//            pageBreaks: [r] — разрыв страницы перед строкой r при печати }
//   Строка: массив ячеек или { cells: [...], height } (высота в пунктах; без неё Excel подбирает сам)
//   Ячейка: null | строка | число | boolean | { v, numFmt, bold, italic, size, color, fill, h, va, wrap, border,
//            borderColor, indent }
// Номера строк и столбцов в модели — с нуля.

const encoder = new TextEncoder();
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006";
const MAX_TEXT = 32767; // предел Excel на ячейку
const MAX_ROWS = 1048576;
const MAX_COLS = 16384;

// ---------- CRC32 и ZIP (store) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) байтов; для «123456789» — 0xCBF43926. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(ms) {
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * ZIP без сжатия. files: [{ name, data: Uint8Array | string }]. Время файлов — по dateMs (UTC),
 * поэтому одинаковый вход даёт одинаковые байты.
 */
export function zipStore(files, dateMs = Date.UTC(2026, 0, 1)) {
  const items = files.map((f) => {
    const name = encoder.encode(f.name);
    const data = typeof f.data === "string" ? encoder.encode(f.data) : f.data;
    return { name, data, crc: crc32(data) };
  });
  if (items.length > 0xffff) throw new Error("В архиве слишком много файлов");
  const { time, date } = dosStamp(dateMs);
  let size = 22;
  for (const it of items) size += 30 + it.name.length + it.data.length + 46 + it.name.length;
  if (size > 0xffffffff) throw new Error("Архив слишком большой");
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const offsets = [];
  let pos = 0;
  for (const it of items) {
    offsets.push(pos);
    dv.setUint32(pos, 0x04034b50, true); // локальный заголовок
    dv.setUint16(pos + 4, 20, true); // версия для распаковки
    dv.setUint16(pos + 6, 0, true); // флаги
    dv.setUint16(pos + 8, 0, true); // метод: store
    dv.setUint16(pos + 10, time, true);
    dv.setUint16(pos + 12, date, true);
    dv.setUint32(pos + 14, it.crc, true);
    dv.setUint32(pos + 18, it.data.length, true);
    dv.setUint32(pos + 22, it.data.length, true);
    dv.setUint16(pos + 26, it.name.length, true);
    dv.setUint16(pos + 28, 0, true);
    out.set(it.name, pos + 30);
    out.set(it.data, pos + 30 + it.name.length);
    pos += 30 + it.name.length + it.data.length;
  }
  const directoryStart = pos;
  items.forEach((it, i) => {
    dv.setUint32(pos, 0x02014b50, true); // запись центрального каталога
    dv.setUint16(pos + 4, 20, true); // версия создателя
    dv.setUint16(pos + 6, 20, true); // версия для распаковки
    dv.setUint16(pos + 8, 0, true);
    dv.setUint16(pos + 10, 0, true);
    dv.setUint16(pos + 12, time, true);
    dv.setUint16(pos + 14, date, true);
    dv.setUint32(pos + 16, it.crc, true);
    dv.setUint32(pos + 20, it.data.length, true);
    dv.setUint32(pos + 24, it.data.length, true);
    dv.setUint16(pos + 28, it.name.length, true);
    dv.setUint16(pos + 30, 0, true); // extra
    dv.setUint16(pos + 32, 0, true); // комментарий
    dv.setUint16(pos + 34, 0, true); // диск
    dv.setUint16(pos + 36, 0, true); // внутренние атрибуты
    dv.setUint32(pos + 38, 0, true); // внешние атрибуты
    dv.setUint32(pos + 42, offsets[i], true);
    out.set(it.name, pos + 46);
    pos += 46 + it.name.length;
  });
  dv.setUint32(pos, 0x06054b50, true); // конец каталога
  dv.setUint16(pos + 4, 0, true);
  dv.setUint16(pos + 6, 0, true);
  dv.setUint16(pos + 8, items.length, true);
  dv.setUint16(pos + 10, items.length, true);
  dv.setUint32(pos + 12, pos - directoryStart, true);
  dv.setUint32(pos + 16, directoryStart, true);
  dv.setUint16(pos + 20, 0, true);
  return out;
}

// ---------- Текст и XML ----------

/**
 * Текст ячейки для XML: переводы строк — «\n»; символы, которых нет в XML 1.0, — кодом «_xHHHH_»
 * (так их читает Excel); настоящие «_xHHHH_» в тексте прячутся («_x005F_»), чтобы не стать кодом.
 */
export function cleanText(value) {
  let s = String(value).replace(/\r\n?/g, "\n");
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT);
  s = s.replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1");
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const legal = c === 0x9 || c === 0xa || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) ||
      (c >= 0x10000 && c <= 0x10ffff);
    out += legal ? ch : `_x${c.toString(16).toUpperCase().padStart(4, "0")}_`;
  }
  return out;
}

/** Экранирование для текста и значений атрибутов. */
export function escapeXml(text) {
  return String(text).replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** Имя листа: до 31 знака, без : \ / ? * [ ], без апострофа по краям, не пустое. */
export function sanitizeSheetName(name) {
  let s = String(name ?? "").replace(/[:\\/?*[\]\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^'+|'+$/g, "").trim();
  if (s.length > 31) {
    s = s.slice(0, 31);
    const last = s.charCodeAt(30);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, 30); // не режем суррогатную пару
    s = s.replace(/^'+|'+$/g, "").trim();
  }
  return s || "Лист";
}

function uniqueNames(names) {
  const taken = new Set();
  return names.map((raw) => {
    const base = sanitizeSheetName(raw);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length).trimEnd() + suffix;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

/** Имя столбца Excel: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const cellRef = (r, c) => columnName(c) + (r + 1);
const rangeRef = (r, c, r2, c2) => `${cellRef(r, c)}:${cellRef(r2, c2)}`;
const absRange = (r, c, r2, c2) => `$${columnName(c)}$${r + 1}:$${columnName(c2)}$${r2 + 1}`;

// ---------- Стили ----------

const BORDER_STYLES = new Set(["thin", "medium", "hair", "dotted", "dashed", "thick", "double"]);
const BUILTIN_FORMATS = { General: 0, "0": 1, "0.00": 2, "0%": 9, "0.00%": 10 };

function argb(color, fallback = "FF000000") {
  const s = String(color ?? "").replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(s)) return "FF" + s;
  if (/^[0-9A-F]{8}$/.test(s)) return s;
  return fallback;
}

function createStyles() {
  const fonts = [];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = [];
  const formats = [];
  const xfs = [];
  const index = { font: new Map(), fill: new Map(), border: new Map(), format: new Map(), xf: new Map() };

  const intern = (map, list, key, make) => {
    if (!map.has(key)) {
      map.set(key, list.length);
      list.push(make());
    }
    return map.get(key);
  };

  const fontId = (c) => {
    const spec = { b: !!c.bold, i: !!c.italic, sz: Number(c.size) > 0 ? Number(c.size) : 11, color: argb(c.color) };
    return intern(index.font, fonts, JSON.stringify(spec), () =>
      `<font>${spec.b ? "<b/>" : ""}${spec.i ? "<i/>" : ""}<sz val="${spec.sz}"/><color rgb="${spec.color}"/>` +
      '<name val="Calibri"/><family val="2"/></font>');
  };
  const fillId = (c) => {
    if (!c.fill) return 0;
    const color = argb(c.fill, "");
    if (!color) return 0;
    return intern(index.fill, fills, color, () =>
      `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`);
  };
  const borderSide = (name, side, color) => (side
    ? `<${name} style="${side}"><color rgb="${color}"/></${name}>` : `<${name}/>`);
  const borderId = (c) => {
    const b = c.border;
    const sides = typeof b === "string" ? { left: b, right: b, top: b, bottom: b } : b && typeof b === "object" ? b : {};
    const color = argb(c.borderColor, "FFBFC7D1");
    const pick = (s) => (BORDER_STYLES.has(s) ? s : null);
    const spec = [pick(sides.left), pick(sides.right), pick(sides.top), pick(sides.bottom)];
    if (spec.every((s) => s === null)) return 0;
    return intern(index.border, borders, JSON.stringify([spec, color]), () =>
      `<border>${borderSide("left", spec[0], color)}${borderSide("right", spec[1], color)}` +
      `${borderSide("top", spec[2], color)}${borderSide("bottom", spec[3], color)}<diagonal/></border>`);
  };
  const formatId = (code) => {
    if (!code || code === "General") return 0;
    if (Object.hasOwn(BUILTIN_FORMATS, code)) return BUILTIN_FORMATS[code];
    return intern(index.format, formats, code, () => code) + 164;
  };

  // Нулевые записи — «обычный» шрифт, пустая рамка и обычный xf: ячейка без стиля ссылается на s=0
  fontId({});
  borders.push("<border><left/><right/><top/><bottom/><diagonal/></border>");
  xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');

  function xf(c) {
    const font = fontId(c);
    const fill = fillId(c);
    const border = borderId(c);
    const format = formatId(c.numFmt);
    const align = {
      h: ["left", "center", "right", "justify", "fill"].includes(c.h) ? c.h : null,
      v: ["top", "center", "bottom"].includes(c.va) ? c.va : null,
      wrap: !!c.wrap,
      indent: Number.isInteger(c.indent) && c.indent > 0 ? c.indent : 0,
    };
    const key = JSON.stringify([format, font, fill, border, align]);
    if (font === 0 && fill === 0 && border === 0 && format === 0 && !align.h && !align.v && !align.wrap && !align.indent) return 0;
    return intern(index.xf, xfs, key, () => {
      const alignment = align.h || align.v || align.wrap || align.indent
        ? `<alignment${align.h ? ` horizontal="${align.h}"` : ""}${align.v ? ` vertical="${align.v}"` : ""}` +
          `${align.wrap ? ' wrapText="1"' : ""}${align.indent ? ` indent="${align.indent}"` : ""}/>`
        : "";
      return `<xf numFmtId="${format}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"` +
        `${format ? ' applyNumberFormat="1"' : ""}${font ? ' applyFont="1"' : ""}${fill ? ' applyFill="1"' : ""}` +
        `${border ? ' applyBorder="1"' : ""}${alignment ? ' applyAlignment="1">' + alignment + "</xf>" : "/>"}`;
    });
  }

  function xml() {
    const numFmts = formats.length
      ? `<numFmts count="${formats.length}">${formats.map((code, i) =>
        `<numFmt numFmtId="${164 + i}" formatCode="${escapeXml(code)}"/>`).join("")}</numFmts>`
      : "";
    return XML_HEAD + `<styleSheet xmlns="${NS_MAIN}">${numFmts}` +
      `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
      `<fills count="${fills.length}">${fills.join("")}</fills>` +
      `<borders count="${borders.length}">${borders.join("")}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>' +
      "</styleSheet>";
  }

  return { xf, xml };
}

// ---------- Листы ----------

function normalizeCell(cell) {
  if (cell !== null && typeof cell === "object") return cell;
  return { v: cell };
}

function sheetXml(sheet, sheetIndex, styles) {
  const rows = (sheet.rows || []).map((row) => (Array.isArray(row) ? { cells: row } : row));
  if (rows.length > MAX_ROWS) throw new Error("Слишком много строк для листа");
  let lastCol = Math.max(0, (sheet.columns || []).length - 1);
  for (const row of rows) lastCol = Math.max(lastCol, row.cells.length - 1);
  if (lastCol >= MAX_COLS) throw new Error("Слишком много столбцов для листа");
  const lastRow = Math.max(0, rows.length - 1);

  const parts = [];
  const sheetPr = `${sheet.tabColor ? `<tabColor rgb="${argb(sheet.tabColor)}"/>` : ""}` +
    `${sheet.landscape || sheet.fitWidth ? '<pageSetUpPr fitToPage="1"/>' : ""}`;
  if (sheetPr) parts.push(`<sheetPr>${sheetPr}</sheetPr>`);
  parts.push(`<dimension ref="${rangeRef(0, 0, lastRow, lastCol)}"/>`);

  const freeze = sheet.freeze && (sheet.freeze.rows > 0 || sheet.freeze.cols > 0) ? sheet.freeze : null;
  let view = `<sheetView workbookViewId="0"${sheetIndex === 0 ? ' tabSelected="1"' : ""}>`;
  if (freeze) {
    const top = cellRef(freeze.rows || 0, freeze.cols || 0);
    const pane = freeze.rows > 0 && freeze.cols > 0 ? "bottomRight" : freeze.rows > 0 ? "bottomLeft" : "topRight";
    view += `<pane${freeze.cols > 0 ? ` xSplit="${freeze.cols}"` : ""}${freeze.rows > 0 ? ` ySplit="${freeze.rows}"` : ""}` +
      ` topLeftCell="${top}" activePane="${pane}" state="frozen"/>` +
      `<selection pane="${pane}" activeCell="${top}" sqref="${top}"/>`;
  }
  parts.push(`<sheetViews>${view}</sheetView></sheetViews>`);
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');

  const columns = sheet.columns || [];
  if (columns.length) {
    parts.push("<cols>" + columns.map((col, i) => {
      const width = Number(col?.width) > 0 ? Number(col.width) : 9;
      return `<col min="${i + 1}" max="${i + 1}" width="${Math.round((width + 0.7109375) * 1e7) / 1e7}" customWidth="1"/>`;
    }).join("") + "</cols>");
  }

  const body = [];
  rows.forEach((row, r) => {
    const cells = [];
    row.cells.forEach((raw, c) => {
      const cell = normalizeCell(raw);
      const s = styles.xf(cell);
      const ref = cellRef(r, c);
      const style = s ? ` s="${s}"` : "";
      let v = cell.v;
      if (typeof v === "number" && !Number.isFinite(v)) v = null;
      if (v === null || v === undefined || v === "") {
        if (s) cells.push(`<c r="${ref}"${style}/>`);
      } else if (typeof v === "number") {
        cells.push(`<c r="${ref}"${style}><v>${v}</v></c>`);
      } else if (typeof v === "boolean") {
        cells.push(`<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cleanText(v))}</t></is></c>`);
      }
    });
    const height = Number(row.height) > 0 ? ` ht="${row.height}" customHeight="1"` : "";
    if (cells.length || height) body.push(`<row r="${r + 1}"${height}>${cells.join("")}</row>`);
  });
  parts.push(`<sheetData>${body.join("")}</sheetData>`);

  const filter = sheet.autoFilter;
  if (filter) parts.push(`<autoFilter ref="${rangeRef(filter.r, filter.c, filter.r2, filter.c2)}"/>`);
  const merges = (sheet.merges || []).filter((m) => m.r2 > m.r || m.c2 > m.c);
  if (merges.length) {
    parts.push(`<mergeCells count="${merges.length}">${merges.map((m) =>
      `<mergeCell ref="${rangeRef(m.r, m.c, m.r2, m.c2)}"/>`).join("")}</mergeCells>`);
  }
  parts.push('<pageMargins left="0.4" right="0.4" top="0.55" bottom="0.6" header="0.3" footer="0.3"/>');
  if (sheet.landscape || sheet.fitWidth) {
    parts.push(`<pageSetup paperSize="9"${sheet.landscape ? ' orientation="landscape"' : ""} fitToWidth="1" fitToHeight="0"/>`);
    parts.push("<headerFooter><oddFooter>&amp;L&amp;A&amp;RСтраница &amp;P из &amp;N</oddFooter></headerFooter>");
  }
  const breaks = [...new Set((sheet.pageBreaks || []).filter((r) => Number.isInteger(r) && r > 0 && r < MAX_ROWS))].sort((a, b) => a - b);
  if (breaks.length) {
    // id — номер строки (с единицы), после которой начинается новая страница, то есть индекс строки с нуля
    parts.push(`<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((r) =>
      `<brk id="${r}" max="16383" man="1"/>`).join("")}</rowBreaks>`);
  }
  return XML_HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${parts.join("")}</worksheet>`;
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Собирает книгу и возвращает байты .xlsx. */
export function buildXlsx(book) {
  const sheetsIn = book.sheets || [];
  if (!sheetsIn.length) throw new Error("В книге нет листов");
  const createdMs = Number.isFinite(book.createdMs) ? book.createdMs : Date.UTC(2026, 0, 1);
  const names = uniqueNames(sheetsIn.map((s) => s.name));
  const styles = createStyles();
  const sheetFiles = sheetsIn.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, i, styles)]);

  const quote = (name) => `'${name.replace(/'/g, "''")}'`;
  const definedNames = [];
  sheetsIn.forEach((sheet, i) => {
    if (sheet.printTitleRows) {
      const [r, r2] = sheet.printTitleRows;
      definedNames.push({ name: "_xlnm.Print_Titles", sheet: i, xml: `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${escapeXml(quote(names[i]))}!$${r + 1}:$${r2 + 1}</definedName>` });
    }
    if (sheet.autoFilter) {
      const f = sheet.autoFilter;
      definedNames.push({ name: "_xlnm._FilterDatabase", sheet: i, xml: `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(quote(names[i]))}!${absRange(f.r, f.c, f.r2, f.c2)}</definedName>` });
    }
  });
  // Порядок, как у самого Excel: по имени без учёта регистра, затем по листу
  definedNames.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.sheet - b.sheet));

  const workbook = XML_HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>' +
    `<sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
    `${definedNames.length ? `<definedNames>${definedNames.map((d) => d.xml).join("")}</definedNames>` : ""}</workbook>`;

  const workbookRels = XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">` +
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${names.length + 1}" Type="${REL}/relationships/styles" Target="styles.xml"/></Relationships>`;

  const contentTypes = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';

  const rootRels = XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

  const app = XML_HEAD + `<Properties xmlns="${REL}/extended-properties" xmlns:vt="${REL}/docPropsVTypes">` +
    `<Application>${escapeXml(cleanText(book.creator || "Простой стана"))}</Application></Properties>`;

  const created = isoSeconds(createdMs);
  const core = XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(cleanText(book.title || "Отчёт"))}</dc:title>` +
    `<dc:creator>${escapeXml(cleanText(book.creator || "Простой стана"))}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`;

  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/app.xml", data: app },
    { name: "docProps/core.xml", data: core },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: styles.xml() },
    ...sheetFiles.map(([name, data]) => ({ name, data })),
  ], createdMs);
}
