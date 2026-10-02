import { test } from "node:test";
import assert from "node:assert/strict";
import { buildXlsx, cleanText, columnName, crc32, escapeXml, sanitizeSheetName, zipStore } from "../../app/core/xlsx.js";
import { readXlsx, readZip, parseXml } from "../helpers/xlsx-read.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("CRC32: контрольные значения", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(enc.encode("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

test("ZIP: разбирается обратно, CRC и размеры сходятся, байты повторяемы", () => {
  const files = [
    { name: "a.txt", data: "привет, мир" },
    { name: "dir/b.bin", data: new Uint8Array([0, 1, 2, 255, 254]) },
    { name: "пусто.txt", data: "" },
  ];
  const bytes = zipStore(files, Date.UTC(2026, 9, 2, 2, 5, 31));
  const zip = readZip(bytes);
  assert.deepEqual(zip.entries.map((e) => e.name), ["a.txt", "dir/b.bin", "пусто.txt"]);
  assert.equal(dec.decode(zip.files.get("a.txt")), "привет, мир");
  assert.deepEqual([...zip.files.get("dir/b.bin")], [0, 1, 2, 255, 254]);
  assert.equal(zip.files.get("пусто.txt").length, 0);
  for (const e of zip.entries) {
    assert.equal(e.method, 0);
    assert.equal(e.crc, crc32(zip.files.get(e.name)));
  }
  assert.deepEqual(zipStore(files, Date.UTC(2026, 9, 2, 2, 5, 31)), bytes);
  // Время в заголовке — из переданной даты (DOS-формат, секунды с шагом 2)
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(dv.getUint16(10, true), (2 << 11) | (5 << 5) | 15);
  assert.equal(dv.getUint16(12, true), ((2026 - 1980) << 9) | (10 << 5) | 2);
});

test("ZIP: испорченный CRC обнаруживается читателем", () => {
  const bytes = zipStore([{ name: "x", data: "данные" }]);
  bytes[40] ^= 0xff; // байт данных
  assert.throws(() => readZip(bytes), /CRC/);
});

const sample = () => ({
  title: "Тест", creator: "Простой стана", createdMs: Date.UTC(2026, 9, 2, 2, 5),
  sheets: [{
    name: "Журнал",
    columns: [{ width: 6 }, { width: 20 }, { width: 14 }],
    rows: [
      { cells: [{ v: "Заголовок", bold: true, size: 14 }], height: 24 },
      [{ v: "№", bold: true, fill: "#dce6f1", wrap: true, border: "thin" }, "Текст", { v: "Время", h: "center" }],
      [1, { v: 46296.5, numFmt: "dd\\.mm\\.yyyy\\ hh:mm" }, { v: 50 / 1440, numFmt: "[h]:mm" }],
      [2, { v: 0.25, numFmt: "0.0%" }, { v: 2.5, numFmt: "0.0##" }],
      [true, null, ""],
    ],
    freeze: { rows: 2, cols: 0 },
    autoFilter: { r: 1, c: 0, r2: 3, c2: 2 },
    merges: [{ r: 0, c: 0, r2: 0, c2: 2 }],
    printTitleRows: [1, 1],
    landscape: true,
  }],
});

test("книга: состав частей ровно как требуется", () => {
  const wb = readXlsx(buildXlsx({ ...sample(), sheets: [sample().sheets[0], { name: "Второй", rows: [["x"]] }] }));
  assert.deepEqual(wb.parts, [
    "[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
  ]);
  assert.deepEqual(wb.sheets.map((s) => s.name), ["Журнал", "Второй"]);
  for (const e of wb.entries) assert.equal(e.method, 0, "ZIP без сжатия (store)");
});

test("книга: все части — правильный XML, типы содержимого и связи согласованы", () => {
  const bytes = buildXlsx(sample());
  const { files } = readZip(bytes);
  for (const [name, data] of files) parseXml(dec.decode(data)); // бросит при любой неправильности
  const types = parseXml(dec.decode(files.get("[Content_Types].xml")));
  const overrides = types.children.filter((c) => c.name === "Override").map((c) => c.attrs.PartName);
  for (const part of ["/xl/workbook.xml", "/xl/styles.xml", "/xl/worksheets/sheet1.xml", "/docProps/core.xml", "/docProps/app.xml"]) {
    assert.ok(overrides.includes(part), part);
    assert.ok(files.has(part.slice(1)), part);
  }
  const rels = parseXml(dec.decode(files.get("_rels/.rels")));
  assert.deepEqual(rels.children.map((r) => r.attrs.Target), ["xl/workbook.xml", "docProps/core.xml", "docProps/app.xml"]);
  const core = dec.decode(files.get("docProps/core.xml"));
  assert.match(core, /<dc:title>Тест<\/dc:title>/);
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-02T02:05:00Z<\/dcterms:created>/);
});

test("лист: порядок элементов, ширины, закрепление, фильтр, объединение, печать", () => {
  const wb = readXlsx(buildXlsx(sample()));
  const sheet = wb.sheets[0];
  assert.deepEqual(sheet.order, ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "autoFilter", "mergeCells", "pageMargins", "pageSetup", "headerFooter"]);
  assert.equal(sheet.dimension, "A1:C5");
  assert.deepEqual(sheet.columns.map((c) => [c.min, c.max]), [[1, 1], [2, 2], [3, 3]]);
  assert.ok(sheet.columns.every((c, i) => c.width > [6, 20, 14][i]), "ширина = символы + поле");
  assert.deepEqual(sheet.pane, { ySplit: "2", topLeftCell: "A3", activePane: "bottomLeft", state: "frozen" });
  assert.equal(sheet.autoFilter, "A2:C4");
  assert.deepEqual(sheet.merges, ["A1:C1"]);
  assert.equal(sheet.rowHeights.get(0), 24);
  assert.equal(sheet.pageSetup.orientation, "landscape");
  assert.equal(sheet.pageSetup.fitToWidth, "1");
  assert.equal(sheet.pageSetup.fitToHeight, "0");
  assert.deepEqual(wb.definedNames.map((d) => [d.name, d.localSheetId, d.hidden, d.ref]), [
    ["_xlnm._FilterDatabase", 0, true, "'Журнал'!$A$2:$C$4"],
    ["_xlnm.Print_Titles", 0, false, "'Журнал'!$2:$2"],
  ]);
});

test("ячейки: типы, форматы, жирная шапка с заливкой, перенос текста", () => {
  const sheet = readXlsx(buildXlsx(sample())).sheets[0];
  const cell = (ref) => sheet.cells.get(ref);
  assert.equal(cell("A1").type, "inlineStr");
  assert.equal(cell("A1").bold, true);
  assert.equal(cell("A2").fill, "FFDCE6F1");
  assert.equal(cell("A2").wrap, true);
  assert.equal(cell("A2").border.left, "thin");
  assert.equal(cell("B3").value, 46296.5);
  assert.equal(cell("B3").format, "dd\\.mm\\.yyyy\\ hh:mm");
  assert.equal(cell("C3").format, "[h]:mm");
  assert.equal(cell("B4").format, "0.0%");
  assert.equal(cell("C4").format, "0.0##");
  assert.equal(cell("C2").h, "center");
  assert.equal(cell("A5").type, "b");
  assert.equal(cell("A5").value, true);
  assert.equal(cell("B5"), undefined, "пустая ячейка без стиля не пишется");
  assert.equal(cell("A3").format, "General", "число без формата");
});

test("текст: спецсимволы XML, управляющие знаки и поддельные _xHHHH_", () => {
  const hostile = 'a&b <c> "d" \'e\' \u0001\u0008 x\u000b￾ \ud800 _x0041_ и ещё _x005F_ ';
  const book = { sheets: [{ name: "T", rows: [[hostile, "строка 1\r\nстрока 2\rстрока 3", "  пробелы  "]] }] };
  const sheet = readXlsx(buildXlsx(book)).sheets[0];
  assert.equal(sheet.cells.get("A1").value, 'a&b <c> "d" \'e\' _x0001__x0008_ x_x000B__xFFFE_ _xD800_ _x005F_x0041_ и ещё _x005F_x005F_ ');
  assert.equal(sheet.cells.get("B1").value, "строка 1\nстрока 2\nстрока 3");
  assert.equal(sheet.cells.get("C1").value, "  пробелы  ");
  assert.equal(cleanText("😀"), "😀", "символы вне BMP остаются");
  assert.equal(escapeXml(`&<>"`), "&amp;&lt;&gt;&quot;");
});

test("текст длиннее предела Excel обрезается, число не-конечное не пишется", () => {
  const sheet = readXlsx(buildXlsx({ sheets: [{ name: "T", rows: [["я".repeat(40000), Infinity, NaN, 7]] }] })).sheets[0];
  assert.equal(sheet.cells.get("A1").value.length, 32767);
  assert.equal(sheet.cells.get("B1"), undefined);
  assert.equal(sheet.cells.get("C1"), undefined);
  assert.equal(sheet.cells.get("D1").value, 7);
});

test("имена листов: до 31 знака, без запрещённых знаков, без повторов", () => {
  assert.equal(sanitizeSheetName("Журнал: простоев/тест?[1]*\\"), "Журнал простоев тест 1");
  assert.equal(sanitizeSheetName("'апостроф'"), "апостроф");
  assert.equal(sanitizeSheetName(""), "Лист");
  assert.equal(sanitizeSheetName("   "), "Лист");
  assert.equal(sanitizeSheetName("я".repeat(50)).length, 31);
  assert.equal(sanitizeSheetName("a".repeat(30) + "😀").length, 30, "суррогатная пара не режется");
  const wb = readXlsx(buildXlsx({ sheets: [{ name: "Лист" }, { name: "лист" }, { name: "Лист" }, { name: "Я".repeat(40) }, { name: "Я".repeat(40) }] }));
  const names = wb.sheets.map((s) => s.name);
  assert.deepEqual(names.slice(0, 3), ["Лист", "лист (2)", "Лист (3)"]);
  assert.ok(names.every((n) => n.length <= 31));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
});

test("имя листа с апострофом в определённых именах удваивается", () => {
  const book = { sheets: [{ name: "Дом ч", rows: [["a"], ["b"]], autoFilter: { r: 0, c: 0, r2: 1, c2: 0 } }] };
  const wb = readXlsx(buildXlsx(book));
  assert.equal(wb.definedNames[0].ref, "'Дом ч'!$A$1:$A$2");
});

test("столбцы: имена и предел", () => {
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA", "XFD"]);
  assert.throws(() => buildXlsx({ sheets: [{ name: "T", rows: [new Array(16385).fill("x")] }] }), /столбцов/);
  assert.throws(() => buildXlsx({ sheets: [] }), /нет листов/);
});

test("стили: одинаковые стили общие, нулевой стиль — обычный, число форматов считается", () => {
  const book = { sheets: [{ name: "T", rows: [
    [{ v: 1, bold: true }, { v: 2, bold: true }, { v: 3 }],
    [{ v: 4, numFmt: "0.0%" }, { v: 5, numFmt: "0.0%" }, { v: 6, numFmt: "[h]:mm", fill: "FF0000" }],
  ] }] };
  const wb = readXlsx(buildXlsx(book));
  const s = wb.sheets[0];
  assert.equal(s.cells.get("A1").style, s.cells.get("B1").style);
  assert.equal(s.cells.get("C1").style, 0);
  assert.equal(s.cells.get("A2").style, s.cells.get("B2").style);
  assert.notEqual(s.cells.get("C2").style, s.cells.get("A2").style);
  assert.equal(s.cells.get("C2").fill, "FFFF0000");
  assert.equal(wb.xfs.length, 4, "обычный, жирный, процент, часы с заливкой");
});

test("большой лист собирается быстро и читается обратно", () => {
  const rows = Array.from({ length: 20000 }, (_, i) => [i, { v: i / 1440, numFmt: "[h]:mm" }, `строка ${i}`, { v: 46296 + i / 1440, numFmt: "dd\\.mm\\.yyyy\\ hh:mm" }]);
  const started = Date.now();
  const bytes = buildXlsx({ sheets: [{ name: "Большой", columns: [{ width: 8 }], rows, autoFilter: { r: 0, c: 0, r2: 19999, c2: 3 } }] });
  assert.ok(Date.now() - started < 3000, "сборка 20 000 строк дольше 3 с");
  const sheet = readXlsx(bytes).sheets[0];
  assert.equal(sheet.dimension, "A1:D20000");
  assert.equal(sheet.cells.get("C20000").value, "строка 19999");
  assert.equal(sheet.cells.get("B20000").value, 19999 / 1440);
});
