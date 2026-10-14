import { useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Download,
  FileUp,
  FileDown,
  CheckCircle2,
  AlertTriangle,
  Boxes,
  ShoppingBag,
  ReceiptText,
  Clock,
  X,
} from "lucide-react";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";

// ============================================================================
// PURE-JS XLSX PARSER & MULTI-SHEET WORKBOOK BUILDER (Zero Extra Dependencies)
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(compressedBytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream not supported");
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const res = new Response(ds.readable);
  return new Uint8Array(await res.arrayBuffer());
}

async function unzipXlsxEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  let eocdOffset = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Not a valid ZIP/XLSX archive");

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder("utf-8");
  const files = new Map();

  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = bytes.subarray(dataStart, dataStart + compSize);

    let contentBytes;
    if (method === 0) {
      contentBytes = rawSlice;
    } else if (method === 8) {
      contentBytes = await inflateRaw(rawSlice);
    }
    if (contentBytes) {
      files.set(name.replace(/^\//, ""), decoder.decode(contentBytes));
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

function colLettersToIndex(cellRef) {
  const match = String(cellRef || "").match(/^[A-Za-z]+/);
  if (!match) return -1;
  const letters = match[0].toUpperCase();
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function indexToColLetters(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function parseXlsxBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const files = await unzipXlsxEntries(buffer);
  const parser = new DOMParser();

  const sharedStrings = [];
  const sstXml = files.get("xl/sharedStrings.xml");
  if (sstXml) {
    const doc = parser.parseFromString(sstXml, "application/xml");
    const siNodes = Array.from(doc.getElementsByTagName("si"));
    for (const si of siNodes) {
      const tNodes = Array.from(si.getElementsByTagName("t"));
      sharedStrings.push(tNodes.map((t) => t.textContent ?? "").join(""));
    }
  }

  const relMap = new Map();
  const relsXml = files.get("xl/_rels/workbook.xml.rels");
  if (relsXml) {
    const doc = parser.parseFromString(relsXml, "application/xml");
    const rels = Array.from(doc.getElementsByTagName("Relationship"));
    for (const r of rels) {
      const id = r.getAttribute("Id");
      let target = r.getAttribute("Target") || "";
      target = target.replace(/^\/+/, "");
      if (!target.startsWith("xl/")) target = `xl/${target.replace(/^\.\//, "")}`;
      if (id) relMap.set(id, target);
    }
  }

  const sheetEntries = [];
  const wbXml = files.get("xl/workbook.xml");
  if (wbXml) {
    const doc = parser.parseFromString(wbXml, "application/xml");
    const sheets = Array.from(doc.getElementsByTagName("sheet"));
    sheets.forEach((s, idx) => {
      const name = s.getAttribute("name") || `Sheet${idx + 1}`;
      const rId =
        s.getAttribute("r:id") ||
        s.getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "id"
        );
      const target = relMap.get(rId) || `xl/worksheets/sheet${idx + 1}.xml`;
      sheetEntries.push({ name, target });
    });
  }

  if (sheetEntries.length === 0) {
    for (const key of files.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(key)) {
        sheetEntries.push({ name: `Sheet${sheetEntries.length + 1}`, target: key });
      }
    }
  }

  const parsedSheets = [];
  for (const entry of sheetEntries) {
    const xml = files.get(entry.target);
    if (!xml) continue;
    const doc = parser.parseFromString(xml, "application/xml");
    const rowNodes = Array.from(doc.getElementsByTagName("row"));
    const rows = [];
    let maxCols = 0;

    for (const rowNode of rowNodes) {
      const cellNodes = Array.from(rowNode.getElementsByTagName("c"));
      const rowValues = [];
      let fallbackCol = 0;

      for (const c of cellNodes) {
        const ref = c.getAttribute("r");
        const colIdx = ref ? colLettersToIndex(ref) : fallbackCol;
        const targetIdx = colIdx >= 0 ? colIdx : fallbackCol;
        fallbackCol = targetIdx + 1;

        const type = c.getAttribute("t") || "";
        const vNode = c.getElementsByTagName("v")[0];
        const isNode = c.getElementsByTagName("is")[0];
        let val = "";

        if (type === "s") {
          const sstIdx = Number(vNode?.textContent ?? -1);
          val = sharedStrings[sstIdx] ?? "";
        } else if (type === "inlineStr" && isNode) {
          const tNodes = Array.from(isNode.getElementsByTagName("t"));
          val = tNodes.map((t) => t.textContent ?? "").join("");
        } else if (type === "b") {
          val = vNode?.textContent === "1" ? "TRUE" : "FALSE";
        } else if (vNode) {
          const rawText = vNode.textContent ?? "";
          if (type === "" || type === "n") {
            const num = Number(rawText);
            val = rawText !== "" && Number.isFinite(num) ? num : rawText;
          } else {
            val = rawText;
          }
        }

        while (rowValues.length < targetIdx) rowValues.push("");
        rowValues[targetIdx] = val;
      }

      if (rowValues.length > maxCols) maxCols = rowValues.length;
      if (rowValues.some((cell) => String(cell ?? "").trim() !== "")) {
        rows.push(rowValues);
      }
    }

    for (const r of rows) {
      while (r.length < maxCols) r.push("");
    }

    parsedSheets.push({ name: entry.name, rows });
  }

  return parsedSheets;
}

function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function sanitizeSheetName(rawName, usedNames) {
  let clean = String(rawName ?? "Sheet")
    .replace(/[:\\/?*[\]]/g, "-")
    .replace(/^'+|'+$/g, "")
    .trim();
  if (!clean) clean = "Uncategorized";
  if (clean.length > 31) clean = clean.slice(0, 31).trim();

  let candidate = clean;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` (${counter++})`;
    candidate = `${clean.slice(0, 31 - suffix.length)}${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function isMoneyHeader(headerText) {
  return /amount|total|sales|price|revenue|cost|profit|markup|spend|ticket/i.test(
    String(headerText ?? "")
  );
}

function isIdOrPhoneHeader(headerText) {
  return /\b(id|code|phone|ref|order\s*#|shift\s*#)\b/i.test(
    String(headerText ?? "")
  );
}

function buildWorksheetXml(rows, options = {}) {
  const {
    freezeHeader = true,
    moneyCols = new Set(),
    totalRowIndices = new Set(),
  } = options;
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);

  if (colCount === 0 || rows.length === 0) {
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>No records found for this period</t></is></c></row></sheetData>` +
      `</worksheet>`
    );
  }

  const colWidths = new Array(colCount).fill(12);
  rows.forEach((row, rIdx) => {
    row.forEach((cell, cIdx) => {
      const text = cell == null ? "" : String(cell);
      const len = text.length + (rIdx === 0 ? 4 : 2);
      if (len > colWidths[cIdx]) {
        colWidths[cIdx] = Math.min(44, Math.max(12, len));
      }
    });
  });

  const colsXml =
    `<cols>` +
    colWidths
      .map(
        (w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
      )
      .join("") +
    `</cols>`;

  const sheetViewsXml = freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";

  const rowsXml = rows
    .map((row, rIdx) => {
      const rowNum = rIdx + 1;
      const isHeader = rIdx === 0;
      const isTotalRow = totalRowIndices.has(rIdx);
      const rowHeightAttr = isHeader
        ? ` ht="24" customHeight="1"`
        : isTotalRow
          ? ` ht="20" customHeight="1"`
          : "";

      const cellsXml = row
        .map((cell, cIdx) => {
          const ref = `${indexToColLetters(cIdx)}${rowNum}`;
          const raw = cell ?? "";
          const str = String(raw).trim();

          if (isHeader) {
            return `<c r="${ref}" s="1" t="inlineStr"><is><t>${escapeXml(str)}</t></is></c>`;
          }

          const numericCandidate =
            typeof raw === "number"
              ? raw
              : /^[-+]?\d+(\.\d+)?$/.test(
                    str.replace(/^[₱P]\s*/i, "").replace(/,/g, "")
                  )
                ? Number(str.replace(/^[₱P]\s*/i, "").replace(/,/g, ""))
                : NaN;

          const isNumericCell =
            !isIdOrPhoneHeader(rows[0]?.[cIdx]) &&
            str !== "" &&
            Number.isFinite(numericCandidate) &&
            (typeof raw === "number" ||
              isMoneyHeader(rows[0]?.[cIdx]) ||
              /^\d+(\.\d+)?$/.test(str));

          if (isNumericCell) {
            const isMoney = moneyCols.has(cIdx);
            const styleIdx = isTotalRow
              ? isMoney
                ? 5
                : 4
              : isMoney
                ? 2
                : 3;
            return `<c r="${ref}" s="${styleIdx}"><v>${numericCandidate}</v></c>`;
          }

          const styleIdx = isTotalRow ? 4 : 0;
          return `<c r="${ref}" s="${styleIdx}" t="inlineStr"><is><t>${escapeXml(raw)}</t></is></c>`;
        })
        .join("");

      return `<row r="${rowNum}"${rowHeightAttr}>${cellsXml}</row>`;
    })
    .join("");

  const lastCellRef = `${indexToColLetters(colCount - 1)}${rows.length}`;
  const autoFilterXml =
    rows.length > 1 ? `<autoFilter ref="A1:${lastCellRef}"/>` : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    sheetViewsXml +
    colsXml +
    `<sheetData>${rowsXml}</sheetData>` +
    autoFilterXml +
    `</worksheet>`
  );
}

function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const fileRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes =
      entry.data instanceof Uint8Array
        ? entry.data
        : encoder.encode(entry.data);
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x5421, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    fileRecords.push({
      nameBytes,
      dataBytes,
      crc,
      localHeader,
      offset,
    });

    offset += localHeader.length + dataBytes.length;
  }

  const centralParts = [];
  let centralSize = 0;

  for (const rec of fileRecords) {
    const cd = new Uint8Array(46 + rec.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x5421, true);
    cv.setUint32(16, rec.crc, true);
    cv.setUint32(20, rec.dataBytes.length, true);
    cv.setUint32(24, rec.dataBytes.length, true);
    cv.setUint16(28, rec.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, rec.offset, true);
    cd.set(rec.nameBytes, 46);

    centralParts.push(cd);
    centralSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, fileRecords.length, true);
  ev.setUint16(10, fileRecords.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const blobParts = [];
  for (const rec of fileRecords) {
    blobParts.push(rec.localHeader, rec.dataBytes);
  }
  for (const cd of centralParts) {
    blobParts.push(cd);
  }
  blobParts.push(eocd);

  return new Blob(blobParts, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function buildMultiSheetXlsxBlob(sheets) {
  const usedNames = new Set();
  const normalizedSheets = sheets.map((s) => ({
    name: sanitizeSheetName(s.name, usedNames),
    rows: s.rows ?? [],
    options: s.options ?? {},
  }));

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="2">` +
    `<numFmt numFmtId="164" formatCode="#,##0.00"/>` +
    `<numFmt numFmtId="165" formatCode="#,##0.##"/>` +
    `</numFmts>` +
    `<fonts count="3">` +
    `<font><sz val="11"/><color rgb="FF0A0908"/><name val="Segoe UI"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Segoe UI"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FF0A0908"/><name val="Segoe UI"/></font>` +
    `</fonts>` +
    `<fills count="4">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFE73631"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F5"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="2">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border>` +
    `<top style="thin"><color rgb="FFD1D5DB"/></top>` +
    `<bottom style="double"><color rgb="FF0A0908"/></bottom>` +
    `</border>` +
    `</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
    `<xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    normalizedSheets
      .map(
        (_, idx) =>
          `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join("") +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    normalizedSheets
      .map(
        (s, idx) =>
          `<sheet name="${escapeXml(s.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
      )
      .join("") +
    `</sheets>` +
    `</workbook>`;

  const workbookRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    normalizedSheets
      .map(
        (_, idx) =>
          `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
      )
      .join("") +
    `<Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const entries = [
    { name: "[Content_Types].xml", data: contentTypesXml },
    { name: "_rels/.rels", data: rootRelsXml },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelsXml },
    { name: "xl/styles.xml", data: stylesXml },
  ];

  normalizedSheets.forEach((s, idx) => {
    entries.push({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: buildWorksheetXml(s.rows, s.options),
    });
  });

  return createZipBlob(entries);
}

const GROUP_CANDIDATES = {
  expenses: ["category", "cart", "location", "location_code", "locationcode", "source"],
  inventory: ["category", "cart", "location", "location_code", "locationcode", "status"],
  products: ["category"],
  sales: ["category", "cart", "location", "location_code", "locationcode", "payment", "paymentmethod", "payment_method"],
  shifts: ["cart", "location", "location_code", "locationcode", "location_name", "role", "status"],
};

function detectMoneyColumns(headerRow) {
  const set = new Set();
  (headerRow ?? []).forEach((h, idx) => {
    if (isMoneyHeader(h)) set.add(idx);
  });
  return set;
}

function appendTotalRowIfApplicable(rows, moneyCols) {
  if (!rows || rows.length <= 1 || moneyCols.size === 0) {
    return { rows, totalRowIndices: new Set() };
  }
  const header = rows[0];
  const dataRows = rows.slice(1);
  const totalRow = new Array(header.length).fill("");
  totalRow[0] = `TOTAL (${dataRows.length} records)`;

  for (const colIdx of moneyCols) {
    let sum = 0;
    let hasNum = false;
    for (const r of dataRows) {
      const raw = r[colIdx];
      const num =
        typeof raw === "number"
          ? raw
          : Number(String(raw ?? "").replace(/^[₱P]\s*/i, "").replace(/,/g, ""));
      if (String(raw ?? "").trim() !== "" && Number.isFinite(num)) {
        sum += num;
        hasNum = true;
      }
    }
    if (hasNum) {
      totalRow[colIdx] = Math.round(sum * 100) / 100;
    }
  }

  const nextRows = [...rows, totalRow];
  return { rows: nextRows, totalRowIndices: new Set([nextRows.length - 1]) };
}

function organizeDatasetIntoCategorySheets(dataset, parsedSheets) {
  if (!parsedSheets || parsedSheets.length === 0) return parsedSheets;

  const primary = parsedSheets[0];
  const rows = primary.rows ?? [];
  if (rows.length <= 1) {
    return parsedSheets.map((s) => ({
      ...s,
      options: { moneyCols: detectMoneyColumns(s.rows?.[0]) },
    }));
  }

  const header = rows[0];
  const dataRows = rows.slice(1);
  const moneyCols = detectMoneyColumns(header);
  const normHeaders = header.map((h) =>
    String(h ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "")
  );

  const candidates = GROUP_CANDIDATES[dataset] ?? ["category", "cart", "location"];
  let primaryGroupCol = -1;
  for (const cand of candidates) {
    const cleanCand = cand.replace(/[\s_-]+/g, "");
    const idx = normHeaders.findIndex((h) => h === cleanCand || h.includes(cleanCand));
    if (idx >= 0) {
      primaryGroupCol = idx;
      break;
    }
  }

  const secondaryCartCol =
    dataset === "inventory"
      ? normHeaders.findIndex(
          (h, idx) =>
            idx !== primaryGroupCol &&
            (h === "cart" || h === "location" || h === "locationcode")
        )
      : -1;

  const organized = [];
  const datasetTitle = dataset.charAt(0).toUpperCase() + dataset.slice(1);

  if (dataset === "products") {
    organized.push({
      name: `All ${datasetTitle}`,
      rows,
      options: { moneyCols },
    });
  } else {
    const withTotals = appendTotalRowIfApplicable(rows, moneyCols);
    organized.push({
      name: `All ${datasetTitle}`,
      rows: withTotals.rows,
      options: { moneyCols, totalRowIndices: withTotals.totalRowIndices },
    });
  }

  for (let i = 1; i < parsedSheets.length; i++) {
    const extra = parsedSheets[i];
    const extraMoney = detectMoneyColumns(extra.rows?.[0]);
    organized.push({
      name: extra.name,
      rows: extra.rows,
      options: { moneyCols: extraMoney },
    });
  }

  if (primaryGroupCol >= 0) {
    const groups = new Map();
    for (const row of dataRows) {
      const rawGroup = String(row[primaryGroupCol] ?? "").trim();
      const groupName = rawGroup || "Uncategorized";
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(row);
    }

    const groupHeaderLabel = String(header[primaryGroupCol] || "Category");
    const firstMoneyCol = moneyCols.size > 0 ? [...moneyCols][0] : -1;
    const summaryHeader = [
      groupHeaderLabel,
      "Records Count",
      "% Share of Records",
      ...(firstMoneyCol >= 0 ? [`Total ${header[firstMoneyCol]}`] : []),
    ];

    const summaryRows = [summaryHeader];
    let grandTotalMoney = 0;

    const sortedGroups = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    for (const [groupName, groupRows] of sortedGroups) {
      const share =
        dataRows.length > 0
          ? `${((groupRows.length / dataRows.length) * 100).toFixed(1)}%`
          : "0.0%";

      if (firstMoneyCol >= 0) {
        const sum = groupRows.reduce((acc, r) => {
          const val = Number(
            String(r[firstMoneyCol] ?? "")
              .replace(/^[₱P]\s*/i, "")
              .replace(/,/g, "")
          );
          return acc + (Number.isFinite(val) ? val : 0);
        }, 0);
        const rounded = Math.round(sum * 100) / 100;
        grandTotalMoney += rounded;
        summaryRows.push([groupName, groupRows.length, share, rounded]);
      } else {
        summaryRows.push([groupName, groupRows.length, share]);
      }
    }

    summaryRows.push([
      "GRAND TOTAL",
      dataRows.length,
      "100.0%",
      ...(firstMoneyCol >= 0 ? [Math.round(grandTotalMoney * 100) / 100] : []),
    ]);

    organized.push({
      name: `${groupHeaderLabel} Summary`,
      rows: summaryRows,
      options: {
        moneyCols: firstMoneyCol >= 0 ? new Set([3]) : new Set(),
        totalRowIndices: new Set([summaryRows.length - 1]),
      },
    });

    for (const [groupName, groupRows] of sortedGroups) {
      const sheetRows = [header, ...groupRows];
      const withTotals = appendTotalRowIfApplicable(sheetRows, moneyCols);
      organized.push({
        name: groupName,
        rows: withTotals.rows,
        options: {
          moneyCols,
          totalRowIndices: withTotals.totalRowIndices,
        },
      });
    }
  }

  if (secondaryCartCol >= 0) {
    const byCart = new Map();
    for (const row of dataRows) {
      const cartCode = String(row[secondaryCartCol] ?? "").trim() || "Unassigned";
      if (!byCart.has(cartCode)) byCart.set(cartCode, []);
      byCart.get(cartCode).push(row);
    }
    if (byCart.size > 1) {
      for (const [cartCode, cartRows] of [...byCart.entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      )) {
        organized.push({
          name: `Cart - ${cartCode}`,
          rows: [header, ...cartRows],
          options: { moneyCols },
        });
      }
    }
  }

  return organized;
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatExportSuffix(params = {}) {
  if (params.month) return `-${params.month}`;
  if (params.startDate && params.endDate) {
    return `-${params.startDate}-to-${params.endDate}`;
  }
  return `-all`;
}

async function downloadExport(dataset, params = {}) {
  const res = await api.get(`/export/${dataset}`, {
    params,
    responseType: "blob",
  });

  let finalBlob = res.data;
  if (res.data instanceof Blob) {
    try {
      const parsedSheets = await parseXlsxBlob(res.data);
      if (parsedSheets.length > 0) {
        const organizedSheets = organizeDatasetIntoCategorySheets(
          dataset,
          parsedSheets
        );
        finalBlob = buildMultiSheetXlsxBlob(organizedSheets);
      }
    } catch {
      finalBlob = res.data;
    }
  }

  const filename = `cartiq-${dataset}${formatExportSuffix(params)}.xlsx`;
  triggerBlobDownload(finalBlob, filename);
}

async function downloadMasterWorkbook(params = {}) {
  const datasets = [
    { key: "sales", label: "Sales" },
    { key: "inventory", label: "Inventory" },
    { key: "expenses", label: "Expenses" },
    { key: "shifts", label: "Shifts" },
    { key: "products", label: "Products", noDateParams: true },
  ];

  const responses = await Promise.all(
    datasets.map((ds) =>
      api.get(`/export/${ds.key}`, {
        params: ds.noDateParams ? {} : params,
        responseType: "blob",
      })
    )
  );

  const masterSheets = [];
  const overviewRows = [
    ["Dataset", "Sheet Tab", "Total Records", "Period"],
  ];
  const periodLabel = params.month
    ? params.month
    : params.startDate && params.endDate
      ? `${params.startDate} to ${params.endDate}`
      : "All Time";

  for (let i = 0; i < datasets.length; i++) {
    const ds = datasets[i];
    const blob = responses[i].data;
    const parsed = await parseXlsxBlob(blob);

    for (let sIdx = 0; sIdx < parsed.length; sIdx++) {
      const sheet = parsed[sIdx];
      const rows = sheet.rows ?? [];
      const moneyCols = detectMoneyColumns(rows[0]);
      const tabName = sIdx === 0 ? ds.label : `${ds.label} - ${sheet.name}`;
      const recordCount = Math.max(0, rows.length - 1);

      overviewRows.push([
        ds.label,
        tabName,
        recordCount,
        ds.noDateParams ? "Current Catalog" : periodLabel,
      ]);

      const withTotals =
        ds.key === "products"
          ? { rows, totalRowIndices: new Set() }
          : appendTotalRowIfApplicable(rows, moneyCols);

      masterSheets.push({
        name: tabName,
        rows: withTotals.rows,
        options: {
          moneyCols,
          totalRowIndices: withTotals.totalRowIndices,
        },
      });
    }
  }

  const allSheets = [
    {
      name: "Summary",
      rows: overviewRows,
      options: { moneyCols: new Set() },
    },
    ...masterSheets,
  ];

  const masterBlob = buildMultiSheetXlsxBlob(allSheets);
  const filename = `cartiq-workbook${formatExportSuffix(params)}.xlsx`;
  triggerBlobDownload(masterBlob, filename);
}

// Failures arrive as a Blob (responseType) hiding the server's JSON
// {error} - parse it back out so users see the real reason.
async function blobErrorMessage(err, fallback) {
  try {
    const blob = err?.response?.data;
    if (blob instanceof Blob) {
      const parsed = JSON.parse(await blob.text());
      if (parsed?.error) return parsed.error;
    }
  } catch {
    /* fall through to generic message */
  }
  return getErrorMessage(err, fallback);
}

const EXPORT_DATASETS = [
  {
    key: "sales",
    label: "sales",
    sub: "Line items & per-cart sheets",
    icon: ShoppingBag,
  },
  {
    key: "inventory",
    label: "inventory",
    sub: "By category & per-cart sheets",
    icon: Boxes,
  },
  {
    key: "expenses",
    label: "expenses",
    sub: "By expense category + totals",
    icon: ReceiptText,
  },
  {
    key: "shifts",
    label: "shifts",
    sub: "Staff logs grouped by cart",
    icon: Clock,
  },
];

export default function DataPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  const nowMonth = new Date().toISOString().slice(0, 7);

  const [exportType, setExportType] = useState("month"); // "month", "custom", "all"
  const [month, setMonth] = useState(nowMonth);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const [busyExport, setBusyExport] = useState(null);
  const [busyImport, setBusyImport] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const rangeError =
    exportType === "custom"
      ? !customStart || !customEnd
        ? "Pick both start and end dates for a custom export."
        : customStart > customEnd
          ? "Start date must not be after end date."
          : ""
      : "";

  const fileRef = useRef(null);
  const pendingFile = useRef(null);

  function buildExportParams() {
    const params = {};
    if (exportType === "month" && month) {
      params.month = month;
    } else if (exportType === "custom" && customStart && customEnd) {
      params.startDate = customStart;
      params.endDate = customEnd;
    }
    return params;
  }

  async function doExport(dataset) {
    if (exportType === "custom" && rangeError) {
      toast(rangeError, "error");
      return;
    }
    setBusyExport(dataset);
    try {
      await downloadExport(dataset, buildExportParams());
      toast(`Exported ${dataset} successfully`, "success");
    } catch (err) {
      toast(await blobErrorMessage(err, "Export failed"), "error");
    } finally {
      setBusyExport(null);
    }
  }

  async function doExportMasterWorkbook() {
    if (exportType === "custom" && rangeError) {
      toast(rangeError, "error");
      return;
    }
    setBusyExport("all");
    try {
      await downloadMasterWorkbook(buildExportParams());
      toast("Exported combined workbook successfully", "success");
    } catch (err) {
      toast(await blobErrorMessage(err, "Export failed"), "error");
    } finally {
      setBusyExport(null);
    }
  }

  async function doExportCatalog() {
    setBusyExport("products");
    try {
      await downloadExport("products", {});
      toast("Exported current catalog successfully", "success");
    } catch (err) {
      toast(await blobErrorMessage(err, "Export failed"), "error");
    } finally {
      setBusyExport(null);
    }
  }

  async function processSelectedFile(file) {
    if (!file) return;
    setBusyImport(true);
    setUploadedFileName(file.name);
    try {
      pendingFile.current = file;
      const form = new FormData();
      form.append("file", file);
      const res = await api.post("/import/products?dry_run=true", form);
      const errors = res.data?.errors ?? [];
      const validCount = res.data?.valid_count ?? 0;
      setPreview({ errors, valid_count: validCount, ...(res.data ?? {}) });
      if (errors.length > 0) {
        toast(`${errors.length} row(s) need fixing before commit`, "warn");
      } else {
        toast(`${validCount} valid row(s) - ready to commit`, "success");
      }
    } catch (err) {
      toast(getErrorMessage(err, "Import preview failed"), "error");
      setPreview(null);
      setUploadedFileName("");
    } finally {
      setBusyImport(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (file) processSelectedFile(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (busyImport) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) processSelectedFile(file);
  }

  async function commit() {
    if (!pendingFile.current || busyImport) return;
    setBusyImport(true);
    try {
      const form = new FormData();
      form.append("file", pendingFile.current);
      await api.post("/import/products?dry_run=false", form);
      toast(
        `Committed ${preview?.valid_count ?? 0} product(s) to the catalog`,
        "success"
      );
      setPreview(null);
      setUploadedFileName("");
      pendingFile.current = null;
    } catch (err) {
      toast(getErrorMessage(err, "Commit failed"), "error");
    } finally {
      setBusyImport(false);
      setConfirmOpen(false);
    }
  }

  function clearPreview() {
    setPreview(null);
    setUploadedFileName("");
    pendingFile.current = null;
    if (fileRef.current) fileRef.current.value = "";
  }

  function downloadTemplate() {
    const link = document.createElement("a");
    link.href = "/templates/products-template.xlsx";
    link.download = "products-template.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="Data Hub"
          sub="Excel out, product workbooks in - previewed before anything commits."
        />

        <div
          className="settings-grid"
          style={{
            gap: "var(--space-4)",
            gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
            alignItems: "stretch",
          }}
        >
          {/* EXPORT PANEL (owner-only: financial datasets) */}
          {isOwner && (
            <section
              className="panel"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-4)",
                padding: "var(--space-5)",
              }}
            >
              <div>
                <h3
                  className="section-title"
                  style={{
                    borderBottom: "none",
                    padding: 0,
                    margin: "0 0 var(--space-1) 0",
                  }}
                >
                  Export workbooks
                </h3>
                <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                  Download real Excel files for the selected period. Workbooks
                  are organized into separate sheets by category with summary
                  totals.
                </p>
              </div>

              {/* Tinted Filter Box (Stacked para hindi mag-wrap at hindi tabingi ang From/To) */}
              <div
                style={{
                  background: "var(--surface-alt)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "var(--space-4)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                }}
              >
                <label className="field">
                  Export Period
                  <Select
                    value={exportType}
                    onChange={setExportType}
                    options={[
                      { value: "month", label: "Specific Month" },
                      { value: "custom", label: "Custom Date Range" },
                      { value: "all", label: "All Time" },
                    ]}
                  />
                </label>

                {exportType === "month" && (
                  <label
                    className="field"
                    style={{ animation: "rise-in 0.2s ease" }}
                  >
                    Month
                    <input
                      type="month"
                      value={month}
                      onChange={(e) => setMonth(e.target.value)}
                      style={{
                        width: "100%",
                        background: "var(--surface)",
                      }}
                    />
                  </label>
                )}

                {exportType === "custom" && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "12px",
                      animation: "rise-in 0.2s ease",
                    }}
                  >
                    <label className="field">
                      From
                      <input
                        type="date"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                        style={{
                          width: "100%",
                          background: "var(--surface)",
                        }}
                      />
                    </label>
                    <label className="field">
                      To
                      <input
                        type="date"
                        value={customEnd}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        style={{
                          width: "100%",
                          background: "var(--surface)",
                        }}
                      />
                    </label>
                  </div>
                )}

                {rangeError && (
                  <p className="error-box" role="alert" style={{ margin: 0 }}>
                    {rangeError}
                  </p>
                )}
              </div>

              {/* 2x2 Dataset Cards + Combined Workbook Button */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  marginTop: "auto",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "10px",
                  }}
                >
                  {EXPORT_DATASETS.map((ds) => {
                    const Icon = ds.icon;
                    const isBusy = busyExport === ds.key;
                    return (
                      <button
                        key={ds.key}
                        type="button"
                        className="ghost"
                        disabled={busyExport !== null || Boolean(rangeError)}
                        aria-busy={isBusy}
                        onClick={() => doExport(ds.key)}
                        style={{
                          padding: "12px 14px",
                          borderRadius: "var(--radius)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "10px",
                          textAlign: "left",
                        }}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Icon
                            size={18}
                            style={{
                              color: "var(--primary)",
                              flexShrink: 0,
                            }}
                          />
                          <div className="min-w-0">
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: "var(--fs-md)",
                                color: "var(--text)",
                                textTransform: "capitalize",
                              }}
                            >
                              {isBusy ? "Exporting..." : ds.label}
                            </div>
                            <div
                              className="muted small truncate"
                              style={{ fontWeight: 500, fontSize: "11px" }}
                            >
                              {ds.sub}
                            </div>
                          </div>
                        </div>
                        <Download
                          size={14}
                          className="muted"
                          style={{ flexShrink: 0 }}
                        />
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="small-btn"
                  disabled={busyExport !== null || Boolean(rangeError)}
                  aria-busy={busyExport === "all"}
                  onClick={doExportMasterWorkbook}
                  style={{ width: "100%", justifyContent: "center" }}
                  title="Download 1 Excel workbook containing all datasets as separate sheet tabs"
                >
                  <Download size={14} />{" "}
                  {busyExport === "all"
                    ? "Exporting workbook..."
                    : "Export all datasets (1 workbook)"}
                </button>
              </div>
            </section>
          )}

          {/* IMPORT PANEL */}
          <section
            className="panel"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
              padding: "var(--space-5)",
            }}
          >
            <div>
              <h3
                className="section-title"
                style={{
                  borderBottom: "none",
                  padding: 0,
                  margin: "0 0 var(--space-1) 0",
                }}
              >
                Bulk import products
              </h3>
              <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                Columns required:{" "}
                <strong style={{ color: "var(--text)" }}>
                  name, category, basePrice, flavors
                </strong>
                . Preview validates every row first; commit stays blocked until
                the file is error-free.
              </p>
            </div>

            {/* Drag and Drop Zone using CartIQ's native .empty-state-card */}
            <div
              className="empty-state-card compact"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!dragActive) setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
              }}
              onDrop={handleDrop}
              onClick={() => !busyImport && fileRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !busyImport) {
                  e.preventDefault();
                  fileRef.current?.click();
                }
              }}
              style={{
                cursor: busyImport ? "wait" : "pointer",
                borderColor: dragActive ? "var(--primary)" : "var(--border)",
                background: dragActive
                  ? "var(--primary-tint)"
                  : "var(--surface-alt)",
                transition: "all 0.2s ease",
                flex: preview ? "0 0 auto" : 1,
                justifyContent: "center",
              }}
            >
              <div className="empty-state-icon">
                <FileUp size={20} />
              </div>
              <div className="empty-state-body">
                <strong style={{ fontSize: "var(--fs-md)" }}>
                  {busyImport
                    ? "Validating workbook..."
                    : uploadedFileName
                      ? uploadedFileName
                      : "Drop .xlsx file here or click to upload"}
                </strong>
                <span className="muted small">
                  Validates product rows before adding to the catalog.
                </span>
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".xlsx"
              onChange={handleFile}
              className="hidden"
            />

            {/* Bottom Actions Row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: "8px",
                marginTop: preview ? 0 : "auto",
              }}
            >
              <button
                type="button"
                className="ghost small-btn"
                onClick={downloadTemplate}
                style={{ height: "38px", justifyContent: "center" }}
                title="Download Blank Template"
              >
                <FileDown size={14} /> Template
              </button>
              <button
                type="button"
                className="ghost small-btn"
                onClick={doExportCatalog}
                disabled={busyExport !== null}
                style={{ height: "38px", justifyContent: "center" }}
                title="Export Current Product Database"
              >
                <Download size={14} />{" "}
                {busyExport === "products" ? "..." : "Current"}
              </button>
              <button
                type="button"
                className="small-btn"
                disabled={busyImport}
                onClick={() => fileRef.current?.click()}
                style={{ height: "38px", justifyContent: "center" }}
                title="Upload Excel File"
              >
                <FileUp size={14} /> {busyImport ? "..." : "Upload"}
              </button>
            </div>

            {/* PREVIEW TABLE */}
            {preview && (
              <div
                style={{
                  paddingTop: "var(--space-3)",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <div
                  className="flex items-center justify-between"
                  style={{ marginBottom: "var(--space-2)" }}
                >
                  <div className="flex items-center gap-2">
                    <h4
                      style={{
                        fontSize: "var(--fs-sm)",
                        margin: 0,
                        color: "var(--accent)",
                        fontWeight: "var(--fw-bold)",
                      }}
                    >
                      Validation Preview
                    </h4>
                    <Badge
                      variant={
                        (preview.errors ?? []).length > 0 ? "danger" : "ok"
                      }
                    >
                      {(preview.errors ?? []).length > 0
                        ? `${(preview.errors ?? []).length} Errors`
                        : "Valid"}
                    </Badge>
                  </div>

                  <button
                    type="button"
                    className="ghost small-btn"
                    onClick={clearPreview}
                    style={{ padding: "4px 10px", fontSize: "var(--fs-xs)" }}
                    title="Clear preview"
                  >
                    <X size={12} /> Clear
                  </button>
                </div>

                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Import preview"
                  style={{
                    maxHeight: "220px",
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <table className="data table-fixed">
                    <thead>
                      <tr>
                        <th style={{ width: 90, padding: "6px 12px" }}>Row</th>
                        <th style={{ padding: "6px 12px" }}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(preview.errors ?? []).map((e, i) => (
                        <tr key={`e${i}`}>
                          <td style={{ padding: "8px 12px" }}>
                            <Badge variant="danger">#{e.row}</Badge>
                          </td>
                          <td
                            style={{
                              color: "var(--danger)",
                              padding: "8px 12px",
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <AlertTriangle
                                size={13}
                                style={{ flexShrink: 0 }}
                              />
                              <span style={{ fontSize: "var(--fs-xs)" }}>
                                {e.reason}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {(preview.errors ?? []).length === 0 && (
                        <tr>
                          <td style={{ padding: "8px 12px" }}>
                            <Badge variant="ok">READY</Badge>
                          </td>
                          <td
                            style={{
                              color: "var(--success)",
                              padding: "8px 12px",
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <CheckCircle2
                                size={13}
                                style={{ flexShrink: 0 }}
                              />
                              <span style={{ fontSize: "var(--fs-xs)" }}>
                                {preview.valid_count ?? 0} valid row(s), no
                                conflicts found.
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <button
                  style={{ marginTop: "var(--space-3)", width: "100%" }}
                  onClick={() => setConfirmOpen(true)}
                  disabled={
                    busyImport ||
                    (preview.errors ?? []).length > 0 ||
                    (preview.valid_count ?? 0) === 0
                  }
                >
                  Commit {preview.valid_count ?? 0} product(s)
                </button>
              </div>
            )}
          </section>

          <ConfirmDialog
            open={confirmOpen}
            title="Commit products?"
            message={`${preview?.valid_count ?? 0} new product(s) will be added to the catalog. This action cannot be undone here.`}
            confirmLabel="Commit Data"
            pending={busyImport}
            pendingLabel="Committing..."
            onConfirm={commit}
            onCancel={() => setConfirmOpen(false)}
          />
        </div>
      </div>
    </PageErrorBoundary>
  );
}