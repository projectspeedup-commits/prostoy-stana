// Чтение .xlsx для проверок: ZIP (store и deflate), небольшой строгий разбор XML и модель книги.
// Нужен, чтобы тесты смотрели на настоящие байты файла, а не на модель в памяти.
import zlib from "node:zlib";
import { crc32 } from "../../app/core/xlsx.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Разбирает ZIP; проверяет подписи, CRC и совпадение локальных и центральных заголовков. */
export function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Нет конца центрального каталога");
  const count = dv.getUint16(eocd + 10, true);
  const dirSize = dv.getUint32(eocd + 12, true);
  const dirStart = dv.getUint32(eocd + 16, true);
  if (dirStart + dirSize !== eocd) throw new Error("Центральный каталог не примыкает к концу");
  if (dv.getUint16(eocd + 8, true) !== count) throw new Error("Число записей на диске не сходится");
  const entries = [];
  let pos = dirStart;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error("Плохая запись каталога");
    const method = dv.getUint16(pos + 10, true);
    const crc = dv.getUint32(pos + 16, true);
    const packed = dv.getUint32(pos + 20, true);
    const size = dv.getUint32(pos + 24, true);
    const nameLength = dv.getUint16(pos + 28, true);
    const extra = dv.getUint16(pos + 30, true);
    const comment = dv.getUint16(pos + 32, true);
    const offset = dv.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    if (dv.getUint32(offset, true) !== 0x04034b50) throw new Error("Плохой локальный заголовок: " + name);
    const localName = dv.getUint16(offset + 26, true);
    const localExtra = dv.getUint16(offset + 28, true);
    if (decoder.decode(bytes.subarray(offset + 30, offset + 30 + localName)) !== name) throw new Error("Имя в заголовках расходится: " + name);
    const start = offset + 30 + localName + localExtra;
    let data = bytes.subarray(start, start + packed);
    if (method === 8) data = new Uint8Array(zlib.inflateRawSync(data));
    else if (method !== 0) throw new Error("Метод сжатия " + method);
    if (data.length !== size) throw new Error("Размер не сходится: " + name);
    if (crc32(data) !== crc) throw new Error("CRC не сходится: " + name);
    entries.push({ name, method, crc, size, offset });
    pos += 46 + nameLength + extra + comment;
  }
  if (pos !== eocd) throw new Error("В каталоге есть лишние байты");
  const files = new Map(entries.map((e) => [e.name, null]));
  if (files.size !== entries.length) throw new Error("Повторяющиеся имена в архиве");
  const out = new Map();
  for (const e of entries) {
    const nameLength = dv.getUint16(e.offset + 26, true);
    const extra = dv.getUint16(e.offset + 28, true);
    const packed = dv.getUint32(e.offset + 18, true);
    let data = bytes.subarray(e.offset + 30 + nameLength + extra, e.offset + 30 + nameLength + extra + packed);
    if (e.method === 8) data = new Uint8Array(zlib.inflateRawSync(data));
    out.set(e.name, data);
  }
  return { entries, files: out };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (!(e in ENTITIES)) throw new Error("Неизвестная сущность XML: " + m);
    return ENTITIES[e];
  });
}

/** Строгий разбор XML нашего подмножества: теги, атрибуты в двойных кавычках, текст. */
export function parseXml(source) {
  let text = source;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const prolog = /^<\?xml [^>]*\?>\s*/.exec(text);
  if (prolog) text = text.slice(prolog[0].length);
  // Недопустимые в XML 1.0 символы в тексте — ошибка
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text)) throw new Error("Недопустимый символ в XML");
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let m;
  while ((m = token.exec(text))) {
    if (m[6]) throw new Error("Лишний знак «<» на позиции " + m.index);
    if (m[5] !== undefined) {
      stack[stack.length - 1].children.push({ text: decodeEntities(m[5]) });
      continue;
    }
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Закрывающий тег </${name}> не к месту`);
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([A-Za-z_][\w:.-]*)="([^"<]*)"/g)) {
      if (Object.hasOwn(attrs, a[1])) throw new Error("Повтор атрибута " + a[1]);
      attrs[a[1]] = decodeEntities(a[2]);
    }
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("Не закрыт тег <" + stack[stack.length - 1].name + ">");
  const elements = root.children.filter((c) => c.name);
  if (elements.length !== 1) throw new Error("Должен быть ровно один корневой элемент");
  if (root.children.some((c) => c.text !== undefined && c.text.trim())) throw new Error("Текст вне корня");
  return elements[0];
}

export const kids = (node, name) => node.children.filter((c) => c.name === name);
export const kid = (node, name) => node.children.find((c) => c.name === name);
export const textOf = (node) => node.children.map((c) => (c.text !== undefined ? c.text : textOf(c))).join("");

const BUILTIN = { 0: "General", 1: "0", 2: "0.00", 9: "0%", 10: "0.00%" };

function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Читает книгу: имена листов, ячейки со значениями, форматами и оформлением. */
export function readXlsx(bytes) {
  const { entries, files } = readZip(bytes);
  const xml = (name) => {
    if (!files.has(name)) throw new Error("Нет части " + name);
    return parseXml(decoder.decode(files.get(name)));
  };
  for (const name of files.keys()) if (name.endsWith(".xml") || name.endsWith(".rels")) xml(name);
  const workbook = xml("xl/workbook.xml");
  const rels = new Map(kids(xml("xl/_rels/workbook.xml.rels"), "Relationship").map((r) => [r.attrs.Id, r.attrs.Target]));
  const styles = xml("xl/styles.xml");
  const formats = new Map(kids(kid(styles, "numFmts") || { children: [] }, "numFmt").map((n) => [Number(n.attrs.numFmtId), n.attrs.formatCode]));
  const fonts = kids(kid(styles, "fonts"), "font").map((f) => ({
    bold: !!kid(f, "b"), italic: !!kid(f, "i"), size: Number(kid(f, "sz")?.attrs.val), color: kid(f, "color")?.attrs.rgb,
  }));
  const fills = kids(kid(styles, "fills"), "fill").map((f) => {
    const p = kid(f, "patternFill");
    return p.attrs.patternType === "solid" ? kid(p, "fgColor").attrs.rgb : null;
  });
  const borders = kids(kid(styles, "borders"), "border").map((b) => Object.fromEntries(
    ["left", "right", "top", "bottom"].map((side) => [side, kid(b, side)?.attrs.style || null])));
  const xfs = kids(kid(styles, "cellXfs"), "xf").map((x) => {
    const id = Number(x.attrs.numFmtId);
    const align = kid(x, "alignment")?.attrs || {};
    return { format: id >= 164 ? formats.get(id) : BUILTIN[id] ?? "builtin:" + id, font: fonts[Number(x.attrs.fontId)],
      fill: fills[Number(x.attrs.fillId)], border: borders[Number(x.attrs.borderId)],
      wrap: align.wrapText === "1", h: align.horizontal || null, v: align.vertical || null };
  });
  if (Number(kid(styles, "cellXfs").attrs.count) !== xfs.length) throw new Error("count у cellXfs не сходится");
  if (Number(kid(styles, "fonts").attrs.count) !== fonts.length) throw new Error("count у fonts не сходится");
  for (const xf of xfs) if (!xf.font || xf.fill === undefined || !xf.border) throw new Error("Стиль ссылается на несуществующий шрифт, заливку или рамку");

  const definedNames = kids(kid(workbook, "definedNames") || { children: [] }, "definedName").map((d) => ({
    name: d.attrs.name, localSheetId: Number(d.attrs.localSheetId), hidden: d.attrs.hidden === "1", ref: textOf(d),
  }));
  const sheets = kids(kid(workbook, "sheets"), "sheet").map((s, index) => {
    const target = rels.get(s.attrs["r:id"]);
    const sheet = xml("xl/" + target);
    const order = kids(sheet, "sheetData").length ? sheet.children.filter((c) => c.name).map((c) => c.name) : [];
    const cells = new Map();
    const rows = [];
    const rowHeights = new Map();
    let previousRow = 0;
    for (const row of kids(kid(sheet, "sheetData"), "row")) {
      const r = Number(row.attrs.r) - 1;
      if (r < previousRow) throw new Error("Строки не по порядку");
      previousRow = r;
      if (row.attrs.ht) rowHeights.set(r, Number(row.attrs.ht));
      let previousCol = -1;
      for (const c of kids(row, "c")) {
        const ref = /^([A-Z]+)(\d+)$/.exec(c.attrs.r);
        const col = columnIndex(ref[1]);
        if (Number(ref[2]) - 1 !== r) throw new Error("Ячейка не в своей строке: " + c.attrs.r);
        if (col <= previousCol) throw new Error("Ячейки не по порядку: " + c.attrs.r);
        previousCol = col;
        const style = c.attrs.s ? Number(c.attrs.s) : 0;
        if (!xfs[style]) throw new Error("Нет стиля " + style);
        let value = null;
        const type = c.attrs.t || "n";
        if (type === "inlineStr") value = textOf(kid(c, "is"));
        else if (kid(c, "v")) value = type === "b" ? textOf(kid(c, "v")) === "1" : Number(textOf(kid(c, "v")));
        const cell = { ref: c.attrs.r, r, c: col, type, value, style, ...xfs[style], bold: xfs[style].font.bold, italic: xfs[style].font.italic };
        cells.set(c.attrs.r, cell);
        (rows[r] ||= [])[col] = cell;
      }
    }
    const pane = kid(kid(kid(sheet, "sheetViews"), "sheetView"), "pane")?.attrs || null;
    return {
      name: s.attrs.name, index, order, cells, rows, rowHeights, pane,
      dimension: kid(sheet, "dimension")?.attrs.ref,
      columns: kids(kid(sheet, "cols") || { children: [] }, "col").map((c) => ({ min: Number(c.attrs.min), max: Number(c.attrs.max), width: Number(c.attrs.width) })),
      autoFilter: kid(sheet, "autoFilter")?.attrs.ref || null,
      merges: kids(kid(sheet, "mergeCells") || { children: [] }, "mergeCell").map((m) => m.attrs.ref),
      pageSetup: kid(sheet, "pageSetup")?.attrs || null,
      /** значения по строкам: values[r][c] */
      values: Array.from({ length: rows.length }, (_, r) => Array.from({ length: Math.max(0, ...(rows[r] || []).map((x, i) => (x ? i + 1 : 0))) }, (_, c) => rows[r]?.[c]?.value ?? null)),
    };
  });
  return { entries, parts: [...files.keys()], sheets, definedNames, xfs, workbook };
}

/** Серийный номер Excel → мс UTC «наивного» момента (даты и время как есть, без пояса). */
export const serialToMs = (serial) => Math.round((serial - 25569) * 86400000);
