// Builds CSV / Excel exports of product rows. Multi-value cells (categories, tags, gallery) use "|",
// the same separator the importer reads, so an export can be edited and imported straight back.

import type { ProductRow } from "../backend/types";

export interface ExportColumn {
  id: string;
  title: string;
  numeric?: boolean;
}

export type ExportFormat = "csv" | "xlsx";

/** Cell value as exported. `names` resolves ids (e.g. category ids → names). */
export function cellValue(row: ProductRow, col: ExportColumn, names?: Map<string, string>): string | number {
  const v = (row as Record<string, unknown>)[col.id];
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x ? ((x as { file?: string; url?: string }).file ?? (x as { url?: string }).url ?? "") : names?.get(String(x)) ?? String(x))).join("|");
  if (typeof v === "object") return (v as { file?: string; url?: string }).file ?? (v as { url?: string }).url ?? JSON.stringify(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (col.numeric && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return String(v);
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ProductRow[], cols: ExportColumn[], names?: Map<string, string>): string {
  const lines = [cols.map((c) => csvEscape(c.title)).join(","), ...rows.map((r) => cols.map((c) => csvEscape(cellValue(r, c, names))).join(","))];
  // BOM so Excel on Windows opens accented characters correctly; CRLF for Excel compatibility.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function buildExport(rows: ProductRow[], cols: ExportColumn[], format: ExportFormat, names?: Map<string, string>): Promise<{ bytes: Uint8Array; mime: string; extension: string; filterName: string }> {
  if (format === "csv") {
    return { bytes: new TextEncoder().encode(toCsv(rows, cols, names)), mime: "text/csv", extension: "csv", filterName: "CSV" };
  }
  const XLSX = await import("xlsx");
  const aoa: (string | number)[][] = [cols.map((c) => c.title), ...rows.map((r) => cols.map((c) => cellValue(r, c, names)))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = cols.map((c) => ({ wch: Math.min(60, Math.max(8, c.title.length + 2, ...aoa.slice(1, 200).map((row) => String(row[cols.indexOf(c)] ?? "").length))) }));
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Products");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return { bytes: new Uint8Array(out), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx", filterName: "Excel workbook" };
}
