// Ticking and unticking categories on products, with optional parent categories.

import type { CategoryRow } from "../backend/types";

export const catKey = (c: CategoryRow) => (c._state.is_new ? c._state.key : String(c.id));
/** The value stored in a product's category_ids: the id, or the staging key of a new category. */
export const catValue = (c: CategoryRow): number | string => (c._state.is_new ? c._state.key : c.id);

/** Keys of a category's parents, nearest first. */
export function ancestorKeys(cats: CategoryRow[], key: string): string[] {
  const byKey = new Map(cats.map((c) => [catKey(c), c]));
  const out: string[] = [];
  let cur = byKey.get(key);
  while (cur && cur.parent && String(cur.parent) !== "0" && !out.includes(String(cur.parent))) {
    out.push(String(cur.parent));
    cur = byKey.get(String(cur.parent));
  }
  return out.filter((k) => byKey.has(k));
}

/** "Apparel › Tees" */
export function categoryPath(cats: CategoryRow[], key: string): string {
  const byKey = new Map(cats.map((c) => [catKey(c), c]));
  return [...ancestorKeys(cats, key).reverse(), key].map((k) => byKey.get(k)?.name ?? "?").join(" › ");
}

/**
 * A product's categories after ticking (on) or unticking (off) one category. With `withParents`,
 * ticking also adds every parent; unticking only ever removes the category itself, so a product can
 * deliberately sit in a parent, a sub-category, or both.
 */
export function assignCategory(current: (number | string)[], cats: CategoryRow[], cat: CategoryRow, on: boolean, withParents: boolean): (number | string)[] {
  const key = catKey(cat);
  const has = new Set(current.map(String));
  if (!on) return current.filter((v) => String(v) !== key);
  const byKey = new Map(cats.map((c) => [catKey(c), c]));
  const add = [key, ...(withParents ? ancestorKeys(cats, key) : [])].filter((k) => !has.has(k));
  return [...current, ...add.map((k) => catValue(byKey.get(k)!))];
}
