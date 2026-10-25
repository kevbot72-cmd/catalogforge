// Multi-product editing for the edit panel: what the ticked products have in common, and how
// one typed value turns into an edit per product (including quick maths like +10%).

import type { Edit, ProductRow } from "../backend/types";
import { applyMass, type MassField, type OpId } from "./massChange";

export type PanelKind = "text" | "decimal" | "int" | "enum" | "bool" | "date" | "longtext";

/** Fields products have but variations don't (WooCommerce keeps these on the parent). */
const PARENT_ONLY = new Set([
  "name", "slug", "short_description", "category_ids", "tags", "featured", "catalog_visibility", "seo_title", "seo_description", "focus_keyword",
  "upsell_ids", "cross_sell_ids", "brand_ids", "purchase_note", "reviews_allowed", "attributes", "gallery_ids", "type", "status", "menu_order", "sold_individually",
  "external_url", "button_text",
]);

/** Whether `field` can be edited on this row. */
export function appliesTo(row: ProductRow, field: string): boolean {
  if (row._state.deleted) return false;
  if (row.type === "variation") return !PARENT_ONLY.has(field);
  // A variable product's price and stock live on its variations.
  if (row.type === "variable" && ["regular_price", "sale_price", "date_on_sale_from", "date_on_sale_to"].includes(field)) return false;
  if (["external_url", "button_text"].includes(field)) return row.type === "external";
  return true;
}

const norm = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export interface Common {
  /** Rows the field applies to. */
  rows: ProductRow[];
  /** True when every applicable row has the same value. */
  same: boolean;
  /** The shared value (or the first row's when mixed). */
  value: unknown;
  /** Distinct values, most common first. */
  values: { value: unknown; count: number }[];
  /** Short description of a mixed value, like "R95–R99" or "3 values". */
  summary: string;
  /** How many of the applicable rows have this field staged. */
  dirty: number;
}

export function common(rows: ProductRow[], field: string, kind?: PanelKind): Common {
  const applicable = rows.filter((r) => appliesTo(r, field));
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const r of applicable) {
    const v = (r as Record<string, unknown>)[field];
    const k = norm(v);
    const c = counts.get(k);
    if (c) c.count++;
    else counts.set(k, { value: v, count: 1 });
  }
  const values = [...counts.values()].sort((a, b) => b.count - a.count);
  const same = values.length <= 1;
  let summary = "";
  if (!same) {
    const nums = values.filter((v) => norm(v.value) !== "").map((v) => Number(v.value)).filter(Number.isFinite);
    const blanks = values.filter((v) => norm(v.value) === "").reduce((s, v) => s + v.count, 0);
    if ((kind === "decimal" || kind === "int") && nums.length > 1) {
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      summary = `${kind === "decimal" ? +lo.toFixed(2) : lo} – ${kind === "decimal" ? +hi.toFixed(2) : hi}${blanks ? ` · ${blanks} empty` : ""}`;
    } else summary = `${values.length} different values`;
  }
  return {
    rows: applicable,
    same,
    value: values[0]?.value,
    values,
    summary,
    dirty: applicable.filter((r) => r._state.dirty.includes(field)).length,
  };
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Turns what was typed into a number field into a bulk operation:
 * `99` sets, `+10%` / `-10%` change by a percentage, `+5` / `-5` add or subtract,
 * `*1.2` or `x1.2` multiply, `=regular_price*0.8` is a formula, empty clears.
 */
export function parseQuick(input: string): { op: OpId; value: string } {
  const t = input.trim().replace(",", ".");
  if (t === "") return { op: "clear", value: "" };
  if (t.startsWith("=")) return { op: "formula", value: t.slice(1) };
  let m = /^([+-])\s*(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (m) return { op: m[1] === "+" ? "inc_pct" : "dec_pct", value: m[2] };
  m = /^([+-])\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return { op: m[1] === "+" ? "add" : "sub", value: m[2] };
  m = /^[*x×]\s*(\d+(?:\.\d+)?)$/i.exec(t);
  if (m) return { op: "mul", value: m[1] };
  if (NUMERIC.test(t)) return { op: "set", value: t };
  throw new Error(`“${input}” isn't a number. Try 99, +10%, -5%, +5, -5, *1.2 or =regular_price*0.8`);
}

/** True when typed text is maths rather than a plain value (the result differs per product). */
export function isMaths(input: string): boolean {
  try {
    return !["set", "clear"].includes(parseQuick(input).op);
  } catch {
    return false;
  }
}

/** Edits that apply typed text to every applicable row. Rows whose value wouldn't change are skipped. */
export function numberEdits(rows: ProductRow[], field: string, kind: "decimal" | "int", input: string): Edit[] {
  const { op, value } = parseQuick(input);
  const f: MassField = { key: field, label: field, kind, variations: true };
  const out: Edit[] = [];
  for (const r of rows) {
    if (!appliesTo(r, field)) continue;
    const next = applyMass(r, { field: f, op, value });
    if (next === undefined || norm(next) === norm((r as Record<string, unknown>)[field])) continue;
    out.push({ entity: r.type === "variation" ? "variation" : "product", key: r._state.key, field, value: next });
  }
  return out;
}

/** Edits that set the same value on every applicable row (skipping rows that already have it). */
export function setEdits(rows: ProductRow[], field: string, value: unknown): Edit[] {
  return rows
    .filter((r) => appliesTo(r, field) && norm((r as Record<string, unknown>)[field]) !== norm(value))
    .map((r) => ({ entity: r.type === "variation" ? "variation" : "product", key: r._state.key, field, value }));
}

/** Edits from a per-row function (lists: add/remove an item for everyone). */
export function mapEdits(rows: ProductRow[], field: string, fn: (cur: unknown, row: ProductRow) => unknown): Edit[] {
  const out: Edit[] = [];
  for (const r of rows) {
    if (!appliesTo(r, field)) continue;
    const cur = (r as Record<string, unknown>)[field];
    const next = fn(cur, r);
    if (norm(next) !== norm(cur)) out.push({ entity: r.type === "variation" ? "variation" : "product", key: r._state.key, field, value: next });
  }
  return out;
}

/** For list fields (categories, tags, brands, linked products): how many rows hold each item. */
export function itemCounts(rows: ProductRow[], field: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!appliesTo(r, field)) continue;
    for (const it of ((r as Record<string, unknown>)[field] as unknown[]) ?? []) {
      const k = String(it);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}
