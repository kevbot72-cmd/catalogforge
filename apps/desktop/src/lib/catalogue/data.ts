// Store data → catalogue entries (prices with the design's adjustment, image sources, plain text).

import { META_PREFIX, type CategoryRow, type Media, type MediaValue, type ProductRow } from "../../backend/types";
import type { CatCategory, CatProduct } from "./plan";
import { htmlToText } from "./text";

/** Full-size and preview sources for an image value (store id, staged local file or URL). */
export function imageSources(v: MediaValue | undefined, media: Map<number, Media>): { full: string | null; preview: string | null } {
  if (typeof v === "number") {
    const m = v > 0 ? media.get(v) : undefined;
    return { full: m?.url || null, preview: m?.medium_url || m?.url || null };
  }
  if (v && typeof v === "object") {
    const src = v.file ?? v.url ?? null;
    return { full: src, preview: src };
  }
  return { full: null, preview: null };
}

const num = (s: string | number | null | undefined) => {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function toCatalogue(rows: ProductRow[], categories: CategoryRow[], media: Map<number, Media>, priceAdjust: number, decimals = 2): { products: CatProduct[]; categories: CatCategory[] } {
  const factor = 1 + priceAdjust / 100;
  const round = (n: number | null) => (n === null ? null : Math.round(n * factor * 10 ** decimals) / 10 ** decimals);
  const variations = new Map<string, ProductRow[]>();
  for (const r of rows) if (r.type === "variation" && !r._state.deleted) variations.set(String(r.parent_id), [...(variations.get(String(r.parent_id)) ?? []), r]);

  const products: CatProduct[] = [];
  for (const r of rows) {
    if (r.type === "variation" || r._state.deleted) continue;
    const kids = variations.get(r._state.key) ?? variations.get(String(r.id)) ?? [];
    const effective = kids
      .map((v) => {
        const reg = num(v.regular_price);
        const sale = num(v.sale_price);
        return sale !== null && (reg === null || sale < reg) ? sale : reg;
      })
      .filter((n): n is number => n !== null);
    const img = imageSources(r.image_id, media);
    const custom: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (k.startsWith(META_PREFIX) && v !== null && v !== undefined && v !== "") custom[k.slice(META_PREFIX.length)] = String(v);
    products.push({
      key: r._state.key,
      id: typeof r.id === "number" && r.id > 0 ? r.id : -products.length - 1,
      name: r.name || "Untitled product",
      sku: r.sku ?? "",
      type: r.type,
      status: r.status,
      regular: r.type === "variable" ? null : round(num(r.regular_price)),
      sale: r.type === "variable" ? null : round(num(r.sale_price)),
      min: effective.length ? round(Math.min(...effective)) : null,
      max: effective.length ? round(Math.max(...effective)) : null,
      description: htmlToText(r.description ?? ""),
      shortDescription: htmlToText(r.short_description ?? ""),
      image: img.full,
      previewImage: img.preview,
      stockStatus: r.stock_status,
      attributes: (r.attributes ?? []).filter((a) => a.visible !== false && a.options?.length).map((a) => ({ name: a.name, options: a.options })),
      categoryIds: (r.category_ids ?? []).map(Number).filter((n) => Number.isFinite(n)),
      permalink: r.permalink ?? "",
      gtin: r.global_unique_id ?? "",
      weight: r.weight ?? "",
      custom,
      featured: !!r.featured,
      menuOrder: r.menu_order ?? 0,
    });
  }
  const cats: CatCategory[] = categories
    .filter((c) => !c._state.deleted && typeof c.id === "number" && c.id > 0)
    .map((c) => ({ id: c.id, parent: Number(c.parent) || 0, name: c.name, description: htmlToText(c.description ?? ""), image: imageSources(c.image_id, media).full, menuOrder: c.menu_order ?? 0 }));
  return { products, categories: cats };
}
