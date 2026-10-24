import { compile, formatDecimal, toStr } from "./formula";
import { META_PREFIX, type CustomField, type ProductRow } from "../backend/types";

export type FieldKind = "decimal" | "int" | "text" | "html" | "enum" | "bool" | "cats" | "tags";

export interface MassField {
  key: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  variations?: boolean;
}

export const MASS_FIELDS: MassField[] = [
  { key: "regular_price", label: "Regular price", kind: "decimal", variations: true },
  { key: "sale_price", label: "Sale price", kind: "decimal", variations: true },
  { key: "stock_quantity", label: "Stock quantity", kind: "int", variations: true },
  { key: "stock_status", label: "Stock status", kind: "enum", variations: true, options: [{ value: "instock", label: "In stock" }, { value: "outofstock", label: "Out of stock" }, { value: "onbackorder", label: "On backorder" }] },
  { key: "manage_stock", label: "Manage stock", kind: "bool", variations: true },
  { key: "status", label: "Status", kind: "enum", options: ["publish", "draft", "pending", "private"].map((v) => ({ value: v, label: v })) },
  { key: "name", label: "Name", kind: "text" },
  { key: "sku", label: "SKU", kind: "text", variations: true },
  { key: "category_ids", label: "Categories", kind: "cats" },
  { key: "tags", label: "Tags", kind: "tags" },
  { key: "short_description", label: "Short description", kind: "html" },
  { key: "description", label: "Description", kind: "html" },
  { key: "seo_title", label: "SEO title", kind: "text" },
  { key: "seo_description", label: "SEO description", kind: "text" },
  { key: "weight", label: "Weight", kind: "decimal", variations: true },
  { key: "length", label: "Length", kind: "decimal", variations: true },
  { key: "width", label: "Width", kind: "decimal", variations: true },
  { key: "height", label: "Height", kind: "decimal", variations: true },
  { key: "shipping_class", label: "Shipping class", kind: "text", variations: true },
  { key: "featured", label: "Featured", kind: "bool" },
  { key: "catalog_visibility", label: "Catalog visibility", kind: "enum", options: [{ value: "visible", label: "Shop and search" }, { value: "catalog", label: "Shop only" }, { value: "search", label: "Search only" }, { value: "hidden", label: "Hidden" }] },
  { key: "backorders", label: "Backorders", kind: "enum", variations: true, options: [{ value: "no", label: "Do not allow" }, { value: "notify", label: "Allow, notify" }, { value: "yes", label: "Allow" }] },
  { key: "menu_order", label: "Menu order", kind: "int" },
];

/** Built-in bulk-edit fields plus the store's custom fields. */
export function massFieldsFor(custom: CustomField[] = []): MassField[] {
  return [
    ...MASS_FIELDS,
    ...custom.map((c): MassField => ({
      key: META_PREFIX + c.key,
      label: c.label || c.key,
      kind: c.kind === "number" ? "decimal" : c.kind === "yesno" ? "enum" : c.kind === "longtext" ? "html" : "text",
      options: c.kind === "yesno" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : undefined,
      variations: true,
    })),
  ];
}

export type OpId =
  | "set" | "clear" | "formula" | "inc_pct" | "dec_pct" | "add" | "sub" | "mul" | "round" | "charm" | "pct_off_regular"
  | "prepend" | "append" | "replace" | "case" | "trim" | "add_items" | "remove_items" | "set_items";

export const OPS_BY_KIND: Record<FieldKind, { id: OpId; label: string }[]> = {
  decimal: [
    { id: "set", label: "Set to" }, { id: "inc_pct", label: "Increase by %" }, { id: "dec_pct", label: "Decrease by %" }, { id: "add", label: "Add amount" },
    { id: "sub", label: "Subtract amount" }, { id: "mul", label: "Multiply by" }, { id: "round", label: "Round to decimals" }, { id: "charm", label: "Charm price (.99)" },
    { id: "pct_off_regular", label: "% off regular price" }, { id: "formula", label: "Formula" }, { id: "clear", label: "Clear" },
  ],
  int: [{ id: "set", label: "Set to" }, { id: "add", label: "Add" }, { id: "sub", label: "Subtract" }, { id: "formula", label: "Formula" }, { id: "clear", label: "Clear" }],
  text: [
    { id: "set", label: "Set to" }, { id: "prepend", label: "Prepend" }, { id: "append", label: "Append" }, { id: "replace", label: "Find & replace" },
    { id: "case", label: "Change case" }, { id: "trim", label: "Tidy whitespace" }, { id: "formula", label: "Formula" }, { id: "clear", label: "Clear" },
  ],
  html: [{ id: "set", label: "Set to" }, { id: "prepend", label: "Prepend" }, { id: "append", label: "Append" }, { id: "replace", label: "Find & replace" }, { id: "formula", label: "Formula" }, { id: "clear", label: "Clear" }],
  enum: [{ id: "set", label: "Set to" }],
  bool: [{ id: "set", label: "Set to" }],
  cats: [{ id: "add_items", label: "Add to categories" }, { id: "remove_items", label: "Remove from categories" }, { id: "set_items", label: "Replace categories with" }],
  tags: [{ id: "add_items", label: "Add tags" }, { id: "remove_items", label: "Remove tags" }, { id: "set_items", label: "Replace tags with" }],
};

export interface MassOp {
  field: MassField;
  op: OpId;
  value: string;
  value2?: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  caseMode?: "upper" | "lower" | "title" | "sentence";
  items?: (number | string)[];
  decimals?: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-/(])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());

/** Computes the new value for one row, or `undefined` when the row is unaffected. Throws on bad input. */
export function applyMass(row: ProductRow, m: MassOp): unknown {
  const cur = (row as Record<string, unknown>)[m.field.key];
  const k = m.field.kind;
  const dec = m.decimals ?? (m.field.key.includes("price") ? 2 : undefined);
  const outNum = (n: number) => (k === "int" ? Math.round(n) : dec !== undefined ? formatDecimal(n, dec) : String(+n.toFixed(4)));
  const arg = () => {
    const n = Number(m.value);
    if (!Number.isFinite(n) || m.value.trim() === "") throw new Error(`"${m.value}" is not a number`);
    return n;
  };
  switch (m.op) {
    case "clear":
      return k === "int" ? null : "";
    case "set":
      if (k === "bool") return m.value === "true";
      if (k === "decimal") return m.value.trim() === "" ? "" : outNum(arg());
      if (k === "int") return m.value.trim() === "" ? null : outNum(arg());
      return m.value;
    case "formula": {
      const f = compile(m.value);
      const r = f.run((name) => (name in row ? (row as Record<string, unknown>)[name] : undefined));
      if (k === "decimal" || k === "int") return r === "" || r === null ? (k === "int" ? null : "") : outNum(Number(r));
      return toStr(r);
    }
    case "inc_pct":
    case "dec_pct":
    case "add":
    case "sub":
    case "mul":
    case "round":
    case "charm": {
      const c = num(cur);
      if (c === null) return undefined; // blank prices stay blank
      const a = m.op === "round" || m.op === "charm" ? 0 : arg();
      const n = m.op === "inc_pct" ? c * (1 + a / 100) : m.op === "dec_pct" ? c * (1 - a / 100) : m.op === "add" ? c + a : m.op === "sub" ? c - a : m.op === "mul" ? c * a : m.op === "round" ? c : Math.ceil(+(c - 0.99).toFixed(8)) + 0.99;
      return outNum(m.op === "round" ? Number(n.toFixed(Number(m.value || 0))) : n);
    }
    case "pct_off_regular": {
      const r = num(row.regular_price);
      if (r === null) return undefined;
      return outNum(r * (1 - arg() / 100));
    }
    case "prepend":
      return m.value + toStr(cur);
    case "append":
      return toStr(cur) + m.value;
    case "replace": {
      const s = toStr(cur);
      if (m.regex) return s.replace(new RegExp(m.value, m.caseInsensitive ? "gi" : "g"), m.value2 ?? "");
      if (m.caseInsensitive) return s.replace(new RegExp(m.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m.value2 ?? "");
      return s.split(m.value).join(m.value2 ?? "");
    }
    case "case": {
      const s = toStr(cur);
      return m.caseMode === "upper" ? s.toUpperCase() : m.caseMode === "lower" ? s.toLowerCase() : m.caseMode === "title" ? titleCase(s) : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    }
    case "trim":
      return toStr(cur).replace(/\s+/g, " ").trim();
    case "add_items": {
      const list = [...((cur as unknown[]) ?? [])];
      for (const it of m.items ?? []) if (!list.map(String).includes(String(it))) list.push(it);
      return list;
    }
    case "remove_items": {
      const rm = new Set((m.items ?? []).map(String));
      return ((cur as unknown[]) ?? []).filter((x) => !rm.has(String(x)));
    }
    case "set_items":
      return [...(m.items ?? [])];
  }
}

export function isApplicable(row: ProductRow, field: MassField): boolean {
  if (row._state.deleted) return false;
  if (row.type === "variation") return !!field.variations;
  if (row.type === "variable" && ["regular_price", "sale_price"].includes(field.key)) return false;
  return true;
}
