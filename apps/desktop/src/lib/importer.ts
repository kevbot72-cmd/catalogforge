// Import pipeline: parse → map → transform → group → match images → validate → stage.
// Pure functions (no UI, no backend) so it is unit-tested and reusable for scheduled feeds.

import Papa from "papaparse";
import { compile, formatDecimal, isBlank, toStr, type Compiled } from "./formula";
import { META_PREFIX, type Category, type CustomField, type Edit, type Entity, type LocalFile, type MediaRef, type Product } from "../backend/types";

export interface Sheet {
  name: string;
  columns: string[];
  rows: Record<string, string>[];
}

export type TargetKind = "field" | "attribute" | "attribute_pair" | "ignore";

export interface FieldDef {
  key: string;
  label: string;
  group: "Basics" | "Pricing" | "Inventory" | "Content" | "Organisation" | "Media" | "Shipping" | "SEO" | "Structure" | "Custom fields";
  kind: "text" | "decimal" | "int" | "bool" | "enum" | "html" | "list";
  options?: string[];
  synonyms: string[];
}

export const FIELDS: FieldDef[] = [
  { key: "name", label: "Name", group: "Basics", kind: "text", synonyms: ["name", "title", "product name", "product title", "item name", "description short"] },
  { key: "sku", label: "SKU", group: "Basics", kind: "text", synonyms: ["sku", "variant sku", "item code", "product code", "article", "article number", "part number", "mpn", "code", "ref", "reference"] },
  { key: "parent_sku", label: "Parent SKU", group: "Structure", kind: "text", synonyms: ["parent", "parent sku", "parent code", "master sku", "group sku"] },
  { key: "type", label: "Product type", group: "Structure", kind: "enum", options: ["simple", "variable", "external", "grouped"], synonyms: ["type", "product type"] },
  { key: "status", label: "Status", group: "Basics", kind: "enum", options: ["publish", "draft", "pending", "private"], synonyms: ["status", "published", "visibility status", "state"] },
  { key: "regular_price", label: "Regular price", group: "Pricing", kind: "decimal", synonyms: ["price", "regular price", "rrp", "msrp", "retail price", "variant price", "list price", "selling price", "unit price"] },
  { key: "sale_price", label: "Sale price", group: "Pricing", kind: "decimal", synonyms: ["sale price", "special price", "offer price", "discount price", "promo price"] },
  { key: "stock_quantity", label: "Stock quantity", group: "Inventory", kind: "int", synonyms: ["stock", "qty", "quantity", "inventory", "stock quantity", "variant inventory qty", "on hand", "available"] },
  { key: "stock_status", label: "Stock status", group: "Inventory", kind: "enum", options: ["instock", "outofstock", "onbackorder"], synonyms: ["stock status", "availability", "in stock"] },
  { key: "manage_stock", label: "Manage stock", group: "Inventory", kind: "bool", synonyms: ["manage stock", "track inventory", "variant inventory tracker"] },
  { key: "global_unique_id", label: "GTIN / EAN / UPC", group: "Inventory", kind: "text", synonyms: ["gtin", "ean", "upc", "barcode", "isbn", "variant barcode"] },
  { key: "description", label: "Description", group: "Content", kind: "html", synonyms: ["description", "long description", "body", "body (html)", "body html", "details", "product description"] },
  { key: "short_description", label: "Short description", group: "Content", kind: "html", synonyms: ["short description", "summary", "excerpt", "teaser", "intro"] },
  { key: "categories", label: "Categories", group: "Organisation", kind: "list", synonyms: ["category", "categories", "collection", "collections", "department", "product category", "category path"] },
  { key: "tags", label: "Tags", group: "Organisation", kind: "list", synonyms: ["tags", "tag", "keywords", "labels"] },
  { key: "featured", label: "Featured", group: "Organisation", kind: "bool", synonyms: ["featured", "is featured"] },
  { key: "images", label: "Images", group: "Media", kind: "list", synonyms: ["images", "image", "image url", "image urls", "image src", "photo", "photos", "picture", "pictures", "main image", "image file", "variant image", "gallery", "gallery images", "image path", "image paths", "image location", "file location", "file path"] },
  { key: "weight", label: "Weight", group: "Shipping", kind: "decimal", synonyms: ["weight", "variant grams", "weight kg", "weight (kg)", "mass"] },
  { key: "length", label: "Length", group: "Shipping", kind: "decimal", synonyms: ["length", "depth"] },
  { key: "width", label: "Width", group: "Shipping", kind: "decimal", synonyms: ["width"] },
  { key: "height", label: "Height", group: "Shipping", kind: "decimal", synonyms: ["height"] },
  { key: "shipping_class", label: "Shipping class", group: "Shipping", kind: "text", synonyms: ["shipping class"] },
  { key: "seo_title", label: "SEO title", group: "SEO", kind: "text", synonyms: ["seo title", "meta title", "page title"] },
  { key: "seo_description", label: "SEO description", group: "SEO", kind: "text", synonyms: ["seo description", "meta description"] },
  { key: "slug", label: "Slug", group: "SEO", kind: "text", synonyms: ["slug", "url key", "handle"] },
  { key: "menu_order", label: "Menu order", group: "Organisation", kind: "int", synonyms: ["position", "sort order", "menu order"] },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/** Built-in fields plus the store's custom fields (mapped as `meta:<key>`). */
export function fieldDefs(custom: CustomField[] = []): FieldDef[] {
  return [
    ...FIELDS,
    ...custom.map((c): FieldDef => {
      const label = c.label || c.key;
      const words = (s: string) => s.toLowerCase().replace(/^_+/, "").replace(/[_-]+/g, " ").trim();
      return { key: META_PREFIX + c.key, label, group: "Custom fields", kind: c.kind === "yesno" ? "bool" : c.kind === "longtext" ? "html" : "text", synonyms: [...new Set([words(label), words(c.key), c.key.toLowerCase()])] };
    }),
  ];
}

const ATTRIBUTE_HINTS = ["size", "colour", "color", "material", "style", "fit", "flavour", "flavor", "pack size", "capacity", "length", "finish", "pattern", "scent", "volume"];

export interface ColumnMapping {
  column: string;
  kind: TargetKind;
  /** Target field key for kind=field. */
  field?: string;
  /** Attribute name for kind=attribute (defaults to column name). */
  attribute?: string;
  /** For attribute kinds: whether values create variations. */
  variation?: boolean;
  /** Global (pa_*) attribute vs. a custom per-product one. */
  global?: boolean;
  confidence: number;
}

export interface FieldTransform {
  /** Formula producing the value; may reference {Column} and the mapped field names. */
  formula?: string;
  /** Used when the mapped value is blank. */
  fallback?: string;
}

export interface ImportConfig {
  mappings: ColumnMapping[];
  transforms: Record<string, FieldTransform>;
  /** Column whose equal values group rows into one variable product (e.g. Shopify "Handle"). */
  groupBy: string | null;
  categorySeparator: string;
  categoryPathSeparator: string;
  mode: "create_and_update" | "create_only" | "update_only";
  defaultStatus: string;
  /** byPath: the image column holds full file locations (C:\\Images\\shoe-1.jpg), so no folder is needed. */
  imageMatch: { byColumn: boolean; bySku: boolean; byPath?: boolean };
  /** Shopify-style "Option1 Name"/"Option1 Value" pairs. */
  optionPairs: { nameColumn: string; valueColumn: string }[];
}

/* -------------------------------------------------------------------- parse */

export async function parseFile(file: File): Promise<Sheet[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt")) {
    return [parseCsv(await file.text(), file.name)];
  }
  if (name.endsWith(".json")) {
    return [parseJson(await file.text(), file.name)];
  }
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, dense: true });
  return wb.SheetNames.map((sheetName) => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: "", raw: false });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { name: sheetName, columns, rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toStr(v)]))) };
  }).filter((s) => s.columns.length);
}

export function parseCsv(text: string, name = "data.csv"): Sheet {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const columns = (res.meta.fields ?? []).filter((c) => c !== "");
  return { name, columns, rows: res.data.map((r) => Object.fromEntries(columns.map((c) => [c, (r[c] ?? "").toString()]))) };
}

export function parseJson(text: string, name = "data.json"): Sheet {
  let data = JSON.parse(text);
  if (!Array.isArray(data)) data = data.products ?? data.items ?? data.data ?? [];
  const flat = (data as Record<string, unknown>[]).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.map(toStr).join("|") : typeof v === "object" && v ? JSON.stringify(v) : toStr(v)])),
  );
  const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  return { name, columns, rows: flat.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? ""]))) };
}

/* --------------------------------------------------------------- auto-map */

function norm(s: string) {
  return s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

export function autoMap(sheet: Sheet, custom: CustomField[] = []): ImportConfig {
  const defs = fieldDefs(custom);
  const used = new Set<string>();
  const mappings: ColumnMapping[] = sheet.columns.map((column) => {
    const n = norm(column);
    let best: { field: string; score: number } | null = null;
    for (const f of defs) {
      for (const syn of f.synonyms) {
        const score = n === syn ? 1 : n.replace(/\s/g, "") === syn.replace(/\s/g, "") ? 0.95 : n.startsWith(syn + " ") || n.endsWith(" " + syn) ? 0.7 : 0;
        if (score > (best?.score ?? 0)) best = { field: f.key, score };
      }
    }
    // Images may span several columns (Image 1, Image 2, …); every other field maps once.
    if (best && (!used.has(best.field) || best.field === "images") && best.score >= 0.7) {
      used.add(best.field);
      return { column, kind: "field", field: best.field, confidence: best.score };
    }
    if (ATTRIBUTE_HINTS.includes(n) || /^attribute[: ]/.test(n) || /^pa /.test(n)) {
      const attribute = column.replace(/^attribute[: ]\s*/i, "").replace(/^pa_/i, "");
      return { column, kind: "attribute", attribute: attribute.charAt(0).toUpperCase() + attribute.slice(1), variation: true, global: true, confidence: 0.6 };
    }
    return { column, kind: "ignore", confidence: 0 };
  });

  // Shopify-style option pairs.
  const optionPairs: ImportConfig["optionPairs"] = [];
  for (const c of sheet.columns) {
    const m = c.match(/^option\s*(\d+)\s*name$/i);
    if (m) {
      const value = sheet.columns.find((v) => new RegExp(`^option\\s*${m[1]}\\s*value$`, "i").test(v));
      if (value) {
        optionPairs.push({ nameColumn: c, valueColumn: value });
        for (const mp of mappings) if (mp.column === c || mp.column === value) Object.assign(mp, { kind: "attribute_pair", confidence: 0.9, field: undefined });
      }
    }
  }
  const handle = sheet.columns.find((c) => /^(handle|group|parent handle|style|style number|model)$/i.test(c.trim()));
  // A "handle" is a grouping key, not a slug, when it repeats across rows.
  let groupBy: string | null = null;
  if (handle) {
    const values = sheet.rows.map((r) => r[handle]).filter(Boolean);
    if (new Set(values).size < values.length) {
      groupBy = handle;
      const mp = mappings.find((m) => m.column === handle);
      if (mp && mp.field === "slug") Object.assign(mp, { kind: "ignore", field: undefined, confidence: 0 });
    }
  }
  return {
    mappings,
    transforms: {},
    groupBy,
    categorySeparator: "|",
    categoryPathSeparator: ">",
    mode: "create_and_update",
    defaultStatus: "publish",
    imageMatch: { byColumn: true, bySku: true, byPath: imageColumnsHavePaths(sheet, mappings) },
    optionPairs,
  };
}

/* ---------------------------------------------------------------- transform */

export interface PlannedProduct {
  key: string;
  row: number;
  entity: Entity;
  existingId: number | null;
  parentKey: string | null;
  fields: Record<string, unknown>;
  images: MediaRef[];
  issues: Issue[];
}

export interface Issue {
  level: "error" | "warning" | "info";
  row: number;
  field?: string;
  message: string;
}

export interface Plan {
  products: PlannedProduct[];
  newCategories: { key: string; name: string; parent: number | string }[];
  issues: Issue[];
  stats: { create: number; update: number; variations: number; skipped: number; images: number; categoriesCreated: number };
}

export interface PlanContext {
  categories: Category[];
  /** SKU → existing product (from the store cache). */
  existingBySku: Map<string, Product>;
  imageFiles: LocalFile[];
  /** The store's custom fields, mappable as `meta:<key>`. */
  customFields?: CustomField[];
  /** Full file locations from the image column, resolved on disk (see imagePaths); null when missing. */
  pathFiles?: Map<string, LocalFile | null>;
  newKey: () => string;
}

const STATUS_ALIASES: Record<string, string> = { published: "publish", active: "publish", live: "publish", enabled: "publish", "1": "publish", true: "publish", yes: "publish", draft: "draft", inactive: "draft", disabled: "draft", "0": "draft", false: "draft", no: "draft", hidden: "private", archived: "draft", pending: "pending", private: "private", publish: "publish" };
const STOCK_ALIASES: Record<string, string> = { "in stock": "instock", instock: "instock", available: "instock", yes: "instock", "1": "instock", true: "instock", "out of stock": "outofstock", outofstock: "outofstock", "sold out": "outofstock", no: "outofstock", "0": "outofstock", false: "outofstock", backorder: "onbackorder", onbackorder: "onbackorder", "on backorder": "onbackorder", preorder: "onbackorder" };

function parseBool(v: string) {
  return /^(1|yes|true|y|on|x)$/i.test(v.trim());
}

function splitList(v: string, sep: string): string[] {
  const s = v.trim();
  if (!s) return [];
  const primary = s.includes(sep) ? s.split(sep) : sep === "|" && !s.includes(">") && s.includes(",") ? s.split(",") : [s];
  return primary.map((x) => x.trim()).filter(Boolean);
}

/** C:\\…, \\\\server\\…, /… or ~/… — a location on this computer rather than a bare file name. */
export function isFilePath(v: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\|\/|~\/)/i.test(v.trim());
}

function imageColumns(mappings: ColumnMapping[]): string[] {
  return mappings.filter((m) => m.kind === "field" && m.field === "images").map((m) => m.column);
}

function imageColumnsHavePaths(sheet: Sheet, mappings: ColumnMapping[]): boolean {
  const cols = imageColumns(mappings);
  return sheet.rows.slice(0, 20).some((r) => cols.some((c) => imageTokens(r[c] ?? "").some(isFilePath)));
}

/** Every file location in the image column(s), for the backend to look up before planning. */
export function imagePaths(sheet: Sheet, cfg: ImportConfig): string[] {
  const out = new Set<string>();
  const cols = imageColumns(cfg.mappings);
  for (const r of sheet.rows) for (const c of cols) for (const t of imageTokens(r[c] ?? "")) if (isFilePath(t)) out.add(t);
  return [...out];
}

function imageTokens(v: string): string[] {
  return v
    .split(/[|,\n;]+|\s+(?=https?:\/\/)/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function stem(name: string) {
  return name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
}

/** Files whose stem equals the SKU or starts with it followed by a separator, ordered by suffix. */
export function matchImagesBySku(sku: string, files: LocalFile[]): LocalFile[] {
  if (!sku) return [];
  const s = sku.toLowerCase();
  const hits = files
    .map((f) => ({ f, st: stem(f.name) }))
    .filter(({ st }) => st === s || (st.startsWith(s) && /^[\s_\-.(]/.test(st.slice(s.length))));
  const order = (st: string) => {
    if (st === s) return -1;
    const m = st.slice(s.length).match(/(\d+)/);
    return m ? Number(m[1]) : 999;
  };
  return hits.sort((a, b) => order(a.st) - order(b.st) || a.st.localeCompare(b.st)).map((h) => h.f);
}

export function categoryPathIndex(categories: Category[]): Map<string, number> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<string, number>();
  for (const c of categories) {
    const parts: string[] = [];
    let cur: Category | undefined = c;
    let guard = 0;
    while (cur && guard++ < 32) {
      parts.unshift(cur.name.trim().toLowerCase());
      cur = typeof cur.parent === "number" && cur.parent > 0 ? byId.get(cur.parent) : undefined;
    }
    out.set(parts.join(" > "), c.id);
    // Also index by bare name when unambiguous.
    const bare = c.name.trim().toLowerCase();
    if (!out.has(bare)) out.set(bare, c.id);
  }
  return out;
}

export function buildPlan(sheet: Sheet, cfg: ImportConfig, ctx: PlanContext): Plan {
  const issues: Issue[] = [];
  const fieldCols = new Map<string, string>(); // field → column
  const attrCols: ColumnMapping[] = [];
  for (const m of cfg.mappings) {
    if (m.kind === "field" && m.field) fieldCols.set(m.field, m.column);
    if (m.kind === "attribute") attrCols.push(m);
  }
  const compiled: Record<string, Compiled> = {};
  for (const [field, t] of Object.entries(cfg.transforms)) {
    if (t.formula?.trim()) {
      try {
        compiled[field] = compile(t.formula);
      } catch (e) {
        issues.push({ level: "error", row: 0, field, message: `Formula for ${FIELD_BY_KEY[field]?.label ?? field}: ${(e as Error).message}` });
      }
    }
  }

  const catIndex = categoryPathIndex(ctx.categories);
  const newCats = new Map<string, { key: string; name: string; parent: number | string }>();
  const resolveCategory = (path: string): number | string => {
    const parts = path.split(cfg.categoryPathSeparator).map((p) => p.trim()).filter(Boolean);
    let parent: number | string = 0;
    for (let i = 0; i < parts.length; i++) {
      const sub = parts.slice(0, i + 1).map((p) => p.toLowerCase()).join(" > ");
      const existing = catIndex.get(sub) ?? (i === 0 && parts.length === 1 ? catIndex.get(parts[0].toLowerCase()) : undefined);
      if (existing !== undefined) {
        parent = existing;
        continue;
      }
      let nc = newCats.get(sub);
      if (!nc) {
        nc = { key: ctx.newKey(), name: parts[i], parent };
        newCats.set(sub, nc);
      }
      parent = nc.key;
    }
    return parent;
  };

  const valueOf = (row: Record<string, string>, field: string): string => {
    const col = fieldCols.get(field);
    let raw = col ? (row[col] ?? "") : "";
    const t = cfg.transforms[field];
    if (compiled[field]) {
      const get = (name: string) => {
        if (name in row) return row[name];
        if (fieldCols.has(name)) return row[fieldCols.get(name)!] ?? "";
        if (name === "value") return raw;
        return undefined;
      };
      raw = toStr(compiled[field].run(get));
    }
    if (isBlank(raw) && t?.fallback) raw = t.fallback;
    return raw.trim();
  };

  // Group rows: explicit parent SKU column, a group-by column, or one product per row.
  type Group = { rows: number[]; parentSku: string | null };
  const groups: Group[] = [];
  const hasParentCol = fieldCols.has("parent_sku");
  if (cfg.groupBy) {
    const byKey = new Map<string, Group>();
    sheet.rows.forEach((r, i) => {
      const k = (r[cfg.groupBy!] ?? "").trim() || `__row${i}`;
      let g = byKey.get(k);
      if (!g) {
        g = { rows: [], parentSku: null };
        byKey.set(k, g);
        groups.push(g);
      }
      g.rows.push(i);
    });
  } else {
    sheet.rows.forEach((_, i) => groups.push({ rows: [i], parentSku: null }));
  }

  const products: PlannedProduct[] = [];
  const skuSeen = new Map<string, number>();
  const parentBySku = new Map<string, PlannedProduct>();
  const varAttrNames = (row: Record<string, string>) => {
    const out: { name: string; value: string; variation: boolean; global: boolean }[] = [];
    for (const m of attrCols) {
      const v = (row[m.column] ?? "").trim();
      if (v) out.push({ name: m.attribute || m.column, value: v, variation: m.variation !== false, global: m.global !== false });
    }
    for (const p of cfg.optionPairs) {
      const name = (row[p.nameColumn] ?? "").trim();
      const v = (row[p.valueColumn] ?? "").trim();
      if (name && v && !/^title$/i.test(name) && !/^default title$/i.test(v)) out.push({ name, value: v, variation: true, global: true });
    }
    return out;
  };
  const taxonomyOf = (name: string) => "pa_" + name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
  let imageCount = 0;

  const defs = fieldDefs(ctx.customFields);
  const baseFields = (row: Record<string, string>, rowNo: number, forVariation: boolean, it: PlannedProduct) => {
    const f: Record<string, unknown> = {};
    for (const def of defs) {
      if (["parent_sku", "categories", "tags", "images", "type"].includes(def.key)) continue;
      if (!fieldCols.has(def.key) && !compiled[def.key] && !cfg.transforms[def.key]?.fallback) continue;
      if (forVariation && ["short_description", "featured", "slug", "menu_order", "seo_title", "seo_description"].includes(def.key)) continue;
      const v = valueOf(row, def.key);
      if (v === "" && it.existingId) continue; // blank cells never wipe existing data
      switch (def.kind) {
        case "decimal": {
          if (v === "") {
            f[def.key] = "";
            break;
          }
          const n = Number(v.replace(/[^0-9.\-]/g, ""));
          if (Number.isNaN(n) || !/\d/.test(v)) it.issues.push({ level: "error", row: rowNo, field: def.key, message: `${def.label} "${v}" is not a number` });
          else f[def.key] = formatDecimal(n, def.key === "weight" || ["length", "width", "height"].includes(def.key) ? Math.min(4, (String(n).split(".")[1] ?? "").length) : 2);
          break;
        }
        case "int": {
          if (v === "") break;
          const n = Number(v.replace(/[,\s]/g, ""));
          if (!Number.isFinite(n)) it.issues.push({ level: "error", row: rowNo, field: def.key, message: `${def.label} "${v}" is not a whole number` });
          else f[def.key] = Math.trunc(n);
          break;
        }
        case "bool":
          // Custom yes/no fields are stored the way WordPress plugins expect: "yes" / "no".
          if (v !== "") f[def.key] = def.key.startsWith(META_PREFIX) ? (parseBool(v) ? "yes" : "no") : parseBool(v);
          break;
        case "enum": {
          if (v === "") break;
          const key = v.toLowerCase();
          const mapped = def.key === "status" ? STATUS_ALIASES[key] : def.key === "stock_status" ? STOCK_ALIASES[key] : def.options?.includes(key) ? key : undefined;
          if (!mapped) it.issues.push({ level: "error", row: rowNo, field: def.key, message: `${def.label} "${v}" is not one of ${def.options?.join(", ")}` });
          else f[def.key] = mapped;
          break;
        }
        default:
          f[def.key] = v;
      }
    }
    if ("stock_quantity" in f && !("manage_stock" in f)) f.manage_stock = true;
    if ("stock_quantity" in f && !("stock_status" in f) && typeof f.stock_quantity === "number") f.stock_status = (f.stock_quantity as number) > 0 ? "instock" : "outofstock";
    if (f.regular_price && f.sale_price && Number(f.sale_price) >= Number(f.regular_price)) it.issues.push({ level: "warning", row: rowNo, field: "sale_price", message: "Sale price is not lower than the regular price" });
    if (typeof f.seo_title === "string" && f.seo_title.length > 60) it.issues.push({ level: "warning", row: rowNo, field: "seo_title", message: `SEO title is ${f.seo_title.length} characters (60 recommended)` });
    return f;
  };

  // Several columns may be mapped to Images (Image 1, Image 2, …); they are read in order.
  const imageCols = imageColumns(cfg.mappings);
  const resolveImages = (row: Record<string, string>, rowNo: number, sku: string, it: PlannedProduct) => {
    const out: MediaRef[] = [];
    if (cfg.imageMatch.byColumn && fieldCols.has("images")) {
      const raw = imageCols.length > 1 ? imageCols.map((c) => row[c] ?? "").join("|") : valueOf(row, "images");
      for (const tok of imageTokens(raw)) {
        if (/^https?:\/\//i.test(tok)) out.push({ url: tok });
        else if (cfg.imageMatch.byPath && isFilePath(tok)) {
          const file = ctx.pathFiles?.get(tok);
          if (file) out.push({ file: file.path, preview: file.url });
          else it.issues.push({ level: "warning", row: rowNo, field: "images", message: `Image file not found: ${tok}` });
        } else {
          const want = tok.split(/[\\/]/).pop()!.toLowerCase();
          const file = ctx.imageFiles.find((f) => f.name.toLowerCase() === want) ?? ctx.imageFiles.find((f) => stem(f.name) === stem(want));
          if (file) out.push({ file: file.path, preview: file.url });
          else it.issues.push({ level: "warning", row: rowNo, field: "images", message: `Image "${tok}" not found in the selected folder` });
        }
      }
    }
    if (cfg.imageMatch.bySku && !out.length && sku) {
      for (const f of matchImagesBySku(sku, ctx.imageFiles)) out.push({ file: f.path, preview: f.url });
    }
    imageCount += out.length;
    return out;
  };

  for (const g of groups) {
    const first = sheet.rows[g.rows[0]];
    const rowNo = g.rows[0] + 2; // header is row 1
    const attrsFirst = varAttrNames(first);
    const isVariableGroup = g.rows.length > 1 || (cfg.groupBy !== null && attrsFirst.some((a) => a.variation));
    const parentSkuCol = hasParentCol ? (valueOf(first, "parent_sku") || "") : "";

    // Rows that reference a parent SKU are handled in the second pass.
    if (!cfg.groupBy && parentSkuCol) {
      products.push({ key: ctx.newKey(), row: rowNo, entity: "variation", existingId: null, parentKey: null, fields: { __parent_sku: parentSkuCol }, images: [], issues: [] });
      continue;
    }

    const sku = isVariableGroup && cfg.groupBy ? (valueOf(first, "parent_sku") || (first[cfg.groupBy] ?? "").trim()) : valueOf(first, "sku");
    const existing = sku ? ctx.existingBySku.get(sku) : undefined;
    const it: PlannedProduct = { key: existing ? String(existing.id) : ctx.newKey(), row: rowNo, entity: "product", existingId: existing?.id ?? null, parentKey: null, fields: {}, images: [], issues: [] };
    it.fields = baseFields(first, rowNo, false, it);
    if (isVariableGroup) {
      for (const k of ["regular_price", "sale_price", "stock_quantity", "manage_stock", "stock_status", "global_unique_id", "weight"]) delete it.fields[k];
      it.fields.type = "variable";
      it.fields.sku = sku;
    } else {
      const typeCol = fieldCols.has("type") ? valueOf(first, "type").toLowerCase() : "";
      if (!existing) it.fields.type = ["simple", "variable", "external", "grouped"].includes(typeCol) ? typeCol : "simple";
    }
    if (!existing && !it.fields.status) it.fields.status = cfg.defaultStatus;
    if (!existing && !it.fields.name) it.issues.push({ level: "error", row: rowNo, field: "name", message: "New products need a name" });

    if (fieldCols.has("categories") || compiled.categories) {
      const raw = valueOf(first, "categories");
      if (raw) it.fields.category_ids = splitList(raw, cfg.categorySeparator).map(resolveCategory);
    }
    if (fieldCols.has("tags") || compiled.tags) {
      const raw = valueOf(first, "tags");
      if (raw) it.fields.tags = splitList(raw, raw.includes("|") ? "|" : ",");
    }
    // Images: parent gets the group's images (deduplicated); each variation gets its own first image.
    const parentImages: MediaRef[] = [];
    const seenImg = new Set<string>();
    const addImgs = (imgs: MediaRef[]) => imgs.forEach((m) => {
      const id = m.file ?? m.url ?? "";
      if (!seenImg.has(id)) {
        seenImg.add(id);
        parentImages.push(m);
      }
    });

    if (sku) {
      if (skuSeen.has(sku)) it.issues.push({ level: "error", row: rowNo, field: "sku", message: `Duplicate SKU "${sku}" (also row ${skuSeen.get(sku)})` });
      skuSeen.set(sku, rowNo);
    }
    products.push(it);
    if (sku) parentBySku.set(sku, it);

    if (isVariableGroup) {
      const attrMap = new Map<string, { name: string; options: string[]; variation: boolean; global: boolean }>();
      const variations: PlannedProduct[] = [];
      for (const idx of g.rows) {
        const row = sheet.rows[idx];
        const vRowNo = idx + 2;
        const vSku = valueOf(row, "sku");
        const vExisting = vSku ? ctx.existingBySku.get(vSku) : undefined;
        const v: PlannedProduct = { key: vExisting ? String(vExisting.id) : ctx.newKey(), row: vRowNo, entity: "variation", existingId: vExisting?.id ?? null, parentKey: it.key, fields: {}, images: [], issues: [] };
        v.fields = baseFields(row, vRowNo, true, v);
        delete v.fields.name;
        delete v.fields.description;
        delete v.fields.status;
        if (!vExisting) v.fields.parent_id = it.existingId ?? it.key;
        const va: Record<string, string> = {};
        for (const a of varAttrNames(row)) {
          const tax = a.global ? taxonomyOf(a.name) : a.name;
          let e = attrMap.get(tax);
          if (!e) {
            e = { name: a.name, options: [], variation: a.variation, global: a.global };
            attrMap.set(tax, e);
          }
          if (!e.options.includes(a.value)) e.options.push(a.value);
          if (a.variation) va[a.global ? tax : a.name.toLowerCase()] = a.value;
        }
        if (!Object.keys(va).length) v.issues.push({ level: "error", row: vRowNo, message: "Variation row has no attribute values (map a Size/Colour column)" });
        v.fields.variation_attributes = va;
        if (vSku) {
          if (skuSeen.has(vSku)) v.issues.push({ level: "error", row: vRowNo, field: "sku", message: `Duplicate SKU "${vSku}" (also row ${skuSeen.get(vSku)})` });
          skuSeen.set(vSku, vRowNo);
        }
        const imgs = resolveImages(row, vRowNo, vSku, v);
        if (imgs[0]) v.fields.image_id = imgs[0];
        addImgs(imgs);
        variations.push(v);
      }
      // Combinations must be unique.
      const combos = new Map<string, number>();
      for (const v of variations) {
        const k = JSON.stringify(v.fields.variation_attributes);
        if (combos.has(k)) v.issues.push({ level: "error", row: v.row, message: `Same attribute combination as row ${combos.get(k)}` });
        combos.set(k, v.row);
      }
      it.fields.attributes = [...attrMap.entries()].map(([tax, a], position) => ({ name: a.name, taxonomy: a.global ? tax : "", options: a.options, visible: true, variation: a.variation, position }));
      if (cfg.imageMatch.bySku) addImgs(matchImagesBySku(sku, ctx.imageFiles).map((f) => ({ file: f.path, preview: f.url })));
      if (parentImages.length) {
        it.fields.image_id = parentImages[0];
        it.fields.gallery_ids = parentImages.slice(1);
      }
      products.push(...variations);
    } else {
      const attrs = attrsFirst.map((a, position) => ({ name: a.name, taxonomy: a.global ? taxonomyOf(a.name) : "", options: [a.value], visible: true, variation: false, position }));
      if (attrs.length) it.fields.attributes = attrs;
      const imgs = resolveImages(first, rowNo, sku, it);
      if (imgs.length) {
        it.fields.image_id = imgs[0];
        it.fields.gallery_ids = imgs.slice(1);
      }
    }
  }

  // Second pass: rows with a Parent SKU column become variations of that parent.
  for (const p of products) {
    const parentSku = p.fields.__parent_sku as string | undefined;
    if (!parentSku) continue;
    const idx = p.row - 2;
    const row = sheet.rows[idx];
    delete p.fields.__parent_sku;
    const parent = parentBySku.get(parentSku);
    const existingParent = ctx.existingBySku.get(parentSku);
    const vSku = valueOf(row, "sku");
    const vExisting = vSku ? ctx.existingBySku.get(vSku) : undefined;
    p.existingId = vExisting?.id ?? null;
    if (vExisting) p.key = String(vExisting.id);
    p.fields = baseFields(row, p.row, true, p);
    delete p.fields.name;
    delete p.fields.status;
    if (!parent && !existingParent) {
      p.issues.push({ level: "error", row: p.row, field: "parent_sku", message: `Parent SKU "${parentSku}" not found in the file or the store` });
      continue;
    }
    p.parentKey = parent?.key ?? String(existingParent!.id);
    if (!vExisting) p.fields.parent_id = parent ? (parent.existingId ?? parent.key) : existingParent!.id;
    const va: Record<string, string> = {};
    const parentAttrs = parent ? ((parent.fields.attributes as Product["attributes"]) ?? []) : [];
    for (const a of varAttrNames(row)) {
      const tax = a.global ? taxonomyOf(a.name) : a.name;
      va[a.global ? tax : a.name.toLowerCase()] = a.value;
      if (parent) {
        let pa = parentAttrs.find((x) => (x.taxonomy || x.name) === tax);
        if (!pa) {
          pa = { name: a.name, taxonomy: a.global ? tax : "", options: [], visible: true, variation: true, position: parentAttrs.length };
          parentAttrs.push(pa);
        }
        pa.variation = true;
        if (!pa.options.includes(a.value)) pa.options.push(a.value);
      }
    }
    if (parent) {
      parent.fields.attributes = parentAttrs;
      parent.fields.type = "variable";
    }
    p.fields.variation_attributes = va;
    if (vSku) {
      if (skuSeen.has(vSku)) p.issues.push({ level: "error", row: p.row, field: "sku", message: `Duplicate SKU "${vSku}" (also row ${skuSeen.get(vSku)})` });
      skuSeen.set(vSku, p.row);
    }
    const imgs = resolveImages(row, p.row, vSku, p);
    if (imgs[0]) p.fields.image_id = imgs[0];
  }

  // Mode filter.
  const kept = products.filter((p) => (cfg.mode === "create_only" ? !p.existingId : cfg.mode === "update_only" ? !!p.existingId : true));
  const skipped = products.length - kept.length;
  for (const p of kept) issues.push(...p.issues);
  return {
    products: kept,
    newCategories: [...newCats.values()],
    issues: issues.sort((a, b) => a.row - b.row),
    stats: {
      create: kept.filter((p) => !p.existingId && p.entity === "product").length,
      update: kept.filter((p) => p.existingId).length,
      variations: kept.filter((p) => p.entity === "variation" && !p.existingId).length,
      skipped,
      images: imageCount,
      categoriesCreated: newCats.size,
    },
  };
}

/** Converts a plan into backend calls: creates (with pre-assigned keys) and edits for existing products. */
export function planToStaging(plan: Plan, existing: Map<string, Product>): { creates: { entity: Entity; key: string; fields: Record<string, unknown> }[]; edits: Edit[] } {
  const creates: { entity: Entity; key: string; fields: Record<string, unknown> }[] = plan.newCategories.map((c) => ({ entity: "category", key: c.key, fields: { name: c.name, parent: c.parent } }));
  const edits: Edit[] = [];
  const blocked = new Set(plan.issues.filter((i) => i.level === "error").map((i) => i.row));
  // A product with errors is skipped together with its variations.
  const blockedKeys = new Set(plan.products.filter((p) => blocked.has(p.row) && p.entity === "product").map((p) => p.key));
  for (const p of plan.products) {
    if (blocked.has(p.row) || (p.parentKey && blockedKeys.has(p.parentKey))) continue;
    if (p.existingId) {
      const cur = existing.get(String(p.existingId)) as Record<string, unknown> | undefined;
      for (const [field, value] of Object.entries(p.fields)) {
        if (field === "type" || field === "parent_id") continue;
        if (cur && JSON.stringify(cur[field]) === JSON.stringify(value)) continue;
        edits.push({ entity: p.entity, key: String(p.existingId), field, value });
      }
    } else {
      creates.push({ entity: p.entity, key: p.key, fields: p.fields });
    }
  }
  return { creates, edits };
}
