import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildExport, toCsv, type ExportColumn } from "./exporter";
import { autoMap, parseCsv } from "./importer";
import type { ProductRow } from "../backend/types";

const rows = [
  { name: 'Mug, "Large"', sku: "M-1", regular_price: "12.50", stock_quantity: 4, category_ids: [10, 11], tags: ["kitchen", "gift"], featured: true, description: "<p>Line 1\nLine 2</p>" },
  { name: "Crème brûlée set", sku: "C-2", regular_price: "", stock_quantity: null, category_ids: [], tags: [], featured: false, description: "" },
] as unknown as ProductRow[];
const cols: ExportColumn[] = [
  { id: "name", title: "Name" },
  { id: "sku", title: "SKU" },
  { id: "regular_price", title: "Price", numeric: true },
  { id: "stock_quantity", title: "Stock", numeric: true },
  { id: "category_ids", title: "Categories" },
  { id: "tags", title: "Tags" },
  { id: "featured", title: "Featured" },
  { id: "description", title: "Description" },
];
const names = new Map([["10", "Home"], ["11", "Mugs"]]);

describe("export", () => {
  it("writes Excel-friendly CSV that the importer reads back", () => {
    const csv = toCsv(rows, cols, names);
    expect(csv.startsWith("﻿Name,SKU,Price")).toBe(true);
    expect(csv).toContain('"Mug, ""Large"""');
    expect(csv).toContain("Home|Mugs");
    const sheet = parseCsv(csv);
    expect(sheet.rows[0]).toMatchObject({ Name: 'Mug, "Large"', SKU: "M-1", Price: "12.5", Categories: "Home|Mugs", Tags: "kitchen|gift" });
    expect(sheet.rows[0].Description).toBe("<p>Line 1\nLine 2</p>");
    expect(sheet.rows[1].Name).toBe("Crème brûlée set");
    const mapped = Object.fromEntries(autoMap(sheet).mappings.map((m) => [m.column, m.field]));
    expect(mapped).toMatchObject({ Name: "name", SKU: "sku", Price: "regular_price", Stock: "stock_quantity", Categories: "categories", Tags: "tags" });
  });

  it("writes a real xlsx workbook with numeric cells", async () => {
    const out = await buildExport(rows, cols, "xlsx", names);
    expect(out.extension).toBe("xlsx");
    const wb = XLSX.read(out.bytes, { type: "array" });
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Products);
    expect(data[0]).toMatchObject({ Name: 'Mug, "Large"', Price: 12.5, Stock: 4, Categories: "Home|Mugs", Featured: "yes" });
    expect(data[1].Name).toBe("Crème brûlée set");
  });
});
