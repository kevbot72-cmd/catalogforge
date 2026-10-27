// Batch Builder: a product "blank" (everything a collection shares) × a design collection
// (numbered designs or a list of names) → many products, ready to stage in the store or to export.
//
// The planner turns a batch into an import sheet and hands it to the importer, so categories,
// SKU matching, variations and validation behave exactly as they do for spreadsheet imports.

import type { LocalFile, MediaRef, ProductRow } from "../backend/types";
import type { ImportConfig, Sheet } from "./importer";
import { htmlToText } from "./catalogue/text";

export interface BlankOptionValue {
  value: string;
  /** Price for this option; blank uses the blank's price. */
  price: string;
  /** Appended to the product SKU, e.g. "-L". Blank uses the value itself. */
  sku: string;
}

/** A variation attribute, e.g. Size: S, M, L. A blank with options makes variable products. */
export interface BlankOption {
  name: string;
  values: BlankOptionValue[];
}

export interface Blank {
  id: string;
  label: string;
  base: string;
  prefix: string;
  price: string;
  sale: string;
  stock: string;
  weight: string;
  height: string;
  width: string;
  length: string;
  tags: string;
  shipping: string;
  taxClass: string;
  featured: boolean;
  desc: string;
  short: string;
  titlePattern: string;
  skuPattern: string;
  /** File-name patterns, used only when exporting a CSV/ZIP for WP All Import. */
  imagePattern: string;
  galleryPattern: string;
  /** Per-product gallery images (after the featured image). */
  galleryCount: number;
  options: BlankOption[];
  custom: Record<string, string>;
}

export interface Collection {
  design: string;
  code: string;
  /** Category paths: levels separated by > (or \), several categories by |. */
  categories: string;
  tags: string;
  mode: "num" | "list";
  start: number;
  count: number;
  pad: number;
  list: string;
  status: "publish" | "draft" | "private";
  /** What to do when a SKU already exists in the store. */
  existing: "skip" | "update";
}

export interface BatchItem {
  index: number;
  n: number;
  item: string;
  title: string;
  sku: string;
  slug: string;
  tokens: Record<string, string>;
  variations: { sku: string; attrs: Record<string, string>; price: string }[];
}

export type Check = { level: "ok" | "info" | "warn" | "error"; message: string; fix?: "strip-chat" };

export const TOKENS = ["{base}", "{design}", "{item}", "{n}", "{nn}", "{prefix}", "{code}", "{price}", "{sale}"];

export const blankDefaults = (over: Partial<Blank> = {}): Blank => ({
  id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  label: "New blank",
  base: "",
  prefix: "",
  price: "",
  sale: "",
  stock: "",
  weight: "",
  height: "",
  width: "",
  length: "",
  tags: "",
  shipping: "",
  taxClass: "",
  featured: false,
  desc: "",
  short: "",
  titlePattern: "{base} - {design} {nn}",
  skuPattern: "{prefix}-{code}{nn}",
  imagePattern: "{base} - {design} {nn}.webp",
  galleryPattern: "{base} - {design} {nn}{letter}.webp",
  galleryCount: 1,
  options: [],
  custom: {},
  ...over,
});

/** The 11oz mug blank from the original Product Batch Builder. */
export const MUG_BLANK: Blank = blankDefaults({
  id: "mug11",
  label: "11oz Ceramic Mug",
  base: "11oz Ceramic Coffee Mug",
  prefix: "CERMUG",
  price: "90",
  stock: "4",
  weight: "0.34",
  height: "9.5",
  width: "8",
  tags: "Mugs|Ceramic Mug|Coffee|Customizable|Cute",
  taxClass: "",
  desc: "<p><strong>11oz Ceramic Coffee Mug</strong><br>Enjoy your favourite drink in a durable 11oz (approx. <strong>325ml</strong>) ceramic mug. Designed for everyday use, this mug measures <strong>9.5cm high</strong> and <strong>8cm in diameter</strong>, with a sturdy feel and a weight of approximately <strong>320–340g</strong>. Perfect for home, office, or gifting!</p><p><strong>Make Every Sip Special</strong><br>Start your day with a mug that’s as unique as you are! Our premium ceramic mugs feature eye-catching, modern designs and can be personalised with any name, phrase, or message you choose.</p><p>At just <strong>R{price}</strong>, these mugs are perfect for gifting, collecting, or brightening up your daily coffee routine.</p>",
  short: "<p><strong>Add Some Fun to Your Coffee Routine</strong><br>Why settle for an ordinary mug when you can enjoy your coffee in something full of personality?</p><p>✔ <strong>Budget-Friendly &amp; Great Quality</strong> – Only <strong>R{price}</strong> each.<br>✔ <strong>Customisable Your Way</strong> – Add a name, quote, or special message.<br>✔ <strong>A Gift Everyone Loves</strong> – Ideal for birthdays, office swaps, holidays, or just because.<br>✔ <strong>Proudly Local</strong> – Designed and made with care right here in South Africa.</p>",
  galleryCount: 1,
});

export const collectionDefaults = (): Collection => ({
  design: "Cat Funny",
  code: "CF",
  categories: "11oz Mugs > Funny > Cats Funny",
  tags: "cats",
  mode: "num",
  start: 1,
  count: 10,
  pad: 2,
  list: "",
  status: "publish",
  existing: "skip",
});

export function fill(tpl: string, v: Record<string, string>): string {
  return String(tpl ?? "").replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m));
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const num = (x: string) => {
  const n = parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const splitTags = (s: string) => s.split("|").map((t) => t.trim().replace(/^"|"$/g, "")).filter(Boolean);

/** Category paths with ">" between levels (the old app used "\"). */
export const normalisePaths = (s: string) => s.split("|").map((p) => p.split(/\s*[>\\]\s*/).map((x) => x.trim()).filter(Boolean).join(" > ")).filter(Boolean);

export function buildItems(b: Blank, c: Collection): BatchItem[] {
  const items: { n: number; item: string }[] = [];
  if (c.mode === "list") {
    c.list.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((item, i) => items.push({ n: c.start + i, item }));
  } else {
    for (let i = 0; i < Math.max(0, Math.min(2000, c.count)); i++) items.push({ n: c.start + i, item: "" });
  }
  return items.map(({ n, item }, index) => {
    const tokens: Record<string, string> = { base: b.base, design: c.design, item: item || c.design, n: String(n), nn: String(n).padStart(c.pad, "0"), prefix: b.prefix, code: c.code, price: b.price, sale: b.sale };
    // A list of names reads better as "Base - Name" unless the pattern was customised.
    const titleTpl = c.mode === "list" && b.titlePattern === "{base} - {design} {nn}" ? "{base} - {item}" : b.titlePattern;
    const title = fill(titleTpl, tokens).replace(/\s+/g, " ").trim();
    const sku = fill(b.skuPattern, tokens).trim();
    const variations: BatchItem["variations"] = [];
    const opts = b.options.filter((o) => o.name.trim() && o.values.some((v) => v.value.trim()));
    if (opts.length) {
      // Every combination of option values.
      let combos: { attrs: Record<string, string>; suffix: string; price: string }[] = [{ attrs: {}, suffix: "", price: "" }];
      for (const o of opts) {
        combos = combos.flatMap((cmb) =>
          o.values.filter((v) => v.value.trim()).map((v) => ({ attrs: { ...cmb.attrs, [o.name.trim()]: v.value.trim() }, suffix: `${cmb.suffix}-${(v.sku || slugify(v.value)).toUpperCase().replace(/^-/, "")}`, price: v.price.trim() || cmb.price })),
        );
      }
      for (const cmb of combos) variations.push({ sku: `${sku}${cmb.suffix}`, attrs: cmb.attrs, price: cmb.price || b.price });
    }
    return { index, n, item, title, sku, slug: slugify(title), tokens, variations };
  });
}

/**
 * The next free number for this SKU pattern in the store, e.g. CERMUG-CF01…CF41 exist → 42.
 * Returns null when the pattern has no number token.
 */
export function nextNumber(b: Blank, c: Collection, storeSkus: string[]): { next: number; highest: number; found: number } | null {
  if (!/\{(n|nn)\}/.test(b.skuPattern)) return null;
  const marker = "\u0000N\u0000";
  const t = fill(b.skuPattern.replace(/\{nn?\}/, marker), { base: b.base, design: c.design, item: c.design, prefix: b.prefix, code: c.code, price: b.price, sale: b.sale, n: "", nn: "" });
  const [pre, post] = t.split(marker);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(pre)}(\\d+)${esc(post ?? "")}$`, "i");
  let highest = 0;
  let found = 0;
  for (const s of storeSkus) {
    const m = re.exec(s);
    if (m) {
      found++;
      highest = Math.max(highest, Number(m[1]));
    }
  }
  return { next: highest + 1, highest, found };
}

/* ------------------------------------------------------------------ images */

export interface BatchImage extends LocalFile {
  id: string;
  /** Loaded as gallery images (often a second folder with the same file names as the featured images). */
  role?: "gallery";
}

export function fileNumber(name: string): number | null {
  const m = name.replace(/\.[^.]+$/, "").match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}

const natural = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/**
 * Assigns images to products: slot 0 is the featured image, then the gallery. "number" matches
 * the last number in each file name to the product number (cat-05.png, cat-05a.png…); "order"
 * hands files out in name order.
 *
 * Gallery images (role "gallery") never become featured images. Each one goes to the product
 * whose featured image has the same file name (folder A/Xmas-01.webp → folder B/Xmas-01.webp),
 * otherwise to the product with the same number, otherwise (in "order" mode) in name order.
 */
export function matchImages(items: BatchItem[], files: BatchImage[], mode: "number" | "order", slots: number): (string | null)[][] {
  const sorted = [...files].sort(natural);
  const main = sorted.filter((f) => f.role !== "gallery");
  const gallery = sorted.filter((f) => f.role === "gallery");
  const out = items.map(() => Array<string | null>(slots).fill(null));
  if (mode === "number") {
    const groups = new Map<number, string[]>();
    for (const f of main) {
      const n = fileNumber(f.name);
      if (n !== null) groups.set(n, [...(groups.get(n) ?? []), f.id]);
    }
    items.forEach((it, i) => (groups.get(it.n) ?? []).slice(0, slots).forEach((id, j) => (out[i][j] = id)));
  } else {
    // With a separate gallery folder, the main files are featured images only: one per product.
    const per = gallery.length ? 1 : slots;
    main.forEach((f, k) => {
      const i = Math.floor(k / per);
      if (i < items.length) out[i][k % per] = f.id;
    });
  }
  if (!gallery.length) return out;

  const byId = new Map(files.map((f) => [f.id, f]));
  const stem = (n: string) => n.replace(/\.[^.]+$/, "").toLowerCase();
  const used = new Set<string>();
  const place = (i: number, id: string) => {
    const j = out[i].findIndex((x, k) => k > 0 && x === null);
    if (j < 0) return false;
    out[i][j] = id;
    used.add(id);
    return true;
  };
  // 1. Same file name as the product's featured image (the extension may differ).
  items.forEach((_, i) => {
    const featured = out[i][0] ? byId.get(out[i][0]!) : undefined;
    if (!featured) return;
    for (const g of gallery) if (!used.has(g.id) && stem(g.name) === stem(featured.name)) place(i, g.id);
  });
  // 2. Same number as the product (Xmas-01-back.webp → product 1).
  items.forEach((it, i) => {
    for (const g of gallery) if (!used.has(g.id) && fileNumber(g.name) === it.n) place(i, g.id);
  });
  // 3. "File order": whatever is left goes in name order to products that still have room.
  if (mode === "order") {
    const left = gallery.filter((g) => !used.has(g.id));
    let k = 0;
    items.forEach((_, i) => {
      if (k < left.length && out[i].slice(1).every((x) => x === null)) place(i, left[k++].id);
    });
  }
  return out;
}

/* ------------------------------------------------------------------ checks */

export function checks(items: BatchItem[], b: Blank, c: Collection, ctx: { storeSkus: Set<string>; assign: (string | null)[][]; images: BatchImage[]; knownPaths: Set<string>; symbol: string }): Check[] {
  const out: Check[] = [];
  if (!items.length) return [{ level: "warn", message: "Add a count or a list of names to create products." }];
  const skus = items.flatMap((i) => [i.sku, ...i.variations.map((v) => v.sku)]);
  const dupes = [...new Set(skus.filter((s, i) => skus.indexOf(s) !== i))];
  if (dupes.length) out.push({ level: "error", message: `Duplicate SKUs in this batch: ${dupes.slice(0, 5).join(", ")}. Add {nn} or {item} to the SKU pattern, or change the design code.` });
  const inStore = items.filter((i) => ctx.storeSkus.has(i.sku));
  if (inStore.length)
    out.push({ level: c.existing === "update" ? "info" : "warn", message: `${inStore.length} SKU${inStore.length === 1 ? " is" : "s are"} already in the store (${inStore.slice(0, 3).map((i) => i.sku).join(", ")}${inStore.length > 3 ? "…" : ""}). ${c.existing === "update" ? "They will be updated." : "They will be skipped; choose “Update them” to change them instead."}` });
  const titles = items.map((i) => i.title);
  if (new Set(titles).size < titles.length) out.push({ level: "warn", message: "Some titles repeat. Include {nn} or {item} in the title pattern." });
  if (!b.price || num(b.price) <= 0) out.push({ level: "warn", message: "Regular price is empty or zero, so these products would show as free." });
  if (b.sale !== "" && num(b.sale) <= 0) out.push({ level: "warn", message: `Sale price is 0. WooCommerce treats that as a ${ctx.symbol}0 sale. Leave it blank instead.` });
  if (b.sale !== "" && num(b.sale) >= num(b.price)) out.push({ level: "warn", message: "Sale price is not lower than the regular price." });
  const text = `${b.desc} ${b.short}`;
  const mentioned = [...htmlToText(text).matchAll(/(?:R|\$|£|€)\s?(\d+(?:[.,]\d+)?)/g)].map((m) => m[1]).filter((x) => num(x) !== num(b.price) && num(x) !== num(b.sale));
  if (mentioned.length) out.push({ level: "warn", message: `The description mentions ${[...new Set(mentioned)].map((m) => ctx.symbol + m).join(", ")} but the price is ${ctx.symbol}${b.price}. Use {price} in the text so it always matches.` });
  if (/\?\s*<strong/.test(text)) out.push({ level: "warn", message: "A “?” sits before bold text in a description. That is usually an emoji that broke during copy-paste." });
  if (/data-(start|end|is-only-node)=/.test(text)) out.push({ level: "warn", message: "The descriptions contain hidden data-start / data-end attributes from ChatGPT. They bloat the page.", fix: "strip-chat" });
  const paths = normalisePaths(c.categories);
  if (!paths.length) out.push({ level: "warn", message: "No category set, so these products would land in Uncategorised." });
  // Each missing level of each path is one new category.
  const fresh = [...new Set(paths.flatMap((p) => p.split(" > ").map((_, i, parts) => parts.slice(0, i + 1).join(" > "))))].filter((p) => !ctx.knownPaths.has(p.toLowerCase()));
  if (fresh.length) out.push({ level: "info", message: `${fresh.length} new categor${fresh.length === 1 ? "y" : "ies"} will be created: ${fresh.map((p) => p.split(" > ").pop()).join(", ")}.` });
  if (b.featured) out.push({ level: "info", message: "Featured is on: every product in this batch will appear in your Featured products." });
  if (ctx.images.length) {
    const noFeat = ctx.assign.filter((a, i) => i < items.length && !a[0]).length;
    if (noFeat) out.push({ level: "warn", message: `${noFeat} product${noFeat === 1 ? " has" : "s have"} no featured image yet. Add the missing files or move images into the empty slots.` });
    const used = new Set(ctx.assign.flat().filter(Boolean));
    const unused = ctx.images.filter((f) => !used.has(f.id)).length;
    if (unused) out.push({ level: "warn", message: `${unused} image${unused === 1 ? " was" : "s were"} not matched to a product and won’t be used.` });
  } else out.push({ level: "info", message: "No images added. Products will be created without pictures; you can add them later." });
  if (!out.some((o) => o.level === "warn" || o.level === "error")) out.unshift({ level: "ok", message: "No problems found. Ready to add to the store." });
  return out;
}

export const stripChatAttrs = (h: string) => h.replace(/\s+data-(start|end|is-only-node)(="[^"]*")?/g, "");

/* ------------------------------------------------------------------ to store */

const STANDARD_TAX = /^standard$/i;

/** The batch as an import sheet + config (see importer.buildPlan). */
export function toImport(items: BatchItem[], b: Blank, c: Collection, customKeys: string[]): { sheet: Sheet; cfg: ImportConfig; firstRow: number[] } {
  const attrNames = b.options.filter((o) => o.name.trim()).map((o) => o.name.trim());
  const variable = items.some((i) => i.variations.length);
  const tags = [...new Set([...splitTags(b.tags), ...splitTags(c.tags)])].join("|");
  const categories = normalisePaths(c.categories).join("|");
  const columns = ["__group", "name", "sku", "parent_sku", "regular_price", "sale_price", "stock_quantity", "weight", "length", "width", "height", "tags", "shipping_class", "tax_class", "featured", "status", "categories", "description", "short_description", ...customKeys.map((k) => `meta:${k}`), ...attrNames.map((a) => `attr:${a}`)];
  const rows: Record<string, string>[] = [];
  const firstRow: number[] = [];
  for (const it of items) {
    const shared: Record<string, string> = {
      name: it.title,
      sale_price: b.sale,
      stock_quantity: b.stock,
      weight: b.weight,
      length: b.length,
      width: b.width,
      height: b.height,
      tags,
      shipping_class: b.shipping,
      tax_class: STANDARD_TAX.test(b.taxClass) ? "" : b.taxClass,
      featured: b.featured ? "yes" : "no",
      status: c.status,
      categories,
      description: fill(b.desc, it.tokens),
      short_description: fill(b.short, it.tokens),
      ...Object.fromEntries(customKeys.map((k) => [`meta:${k}`, fill(b.custom[k] ?? "", it.tokens)])),
    };
    firstRow.push(rows.length);
    if (it.variations.length) {
      for (const v of it.variations) rows.push({ __group: it.sku, sku: v.sku, parent_sku: it.sku, regular_price: v.price, ...shared, ...Object.fromEntries(Object.entries(v.attrs).map(([k, val]) => [`attr:${k}`, val])) });
    } else rows.push({ __group: it.sku, sku: it.sku, parent_sku: "", regular_price: b.price, ...shared });
  }
  const field = (column: string, f = column) => ({ column, kind: "field" as const, field: f, confidence: 1 });
  const cfg: ImportConfig = {
    mappings: [
      ...columns.filter((col) => col !== "__group" && !col.startsWith("attr:")).map((col) => field(col)),
      ...attrNames.map((a) => ({ column: `attr:${a}`, kind: "attribute" as const, attribute: a, variation: true, global: true, confidence: 1 })),
    ],
    transforms: {},
    groupBy: variable ? "__group" : null,
    categorySeparator: "|",
    categoryPathSeparator: ">",
    mode: c.existing === "update" ? "create_and_update" : "create_only",
    defaultStatus: c.status,
    imageMatch: { byColumn: false, bySku: false },
    optionPairs: [],
  };
  return { sheet: { name: "Batch", columns, rows }, cfg, firstRow };
}

/** Image values for one product's slots (featured first), plus the shared gallery images. */
export function imagesFor(slots: (string | null)[], files: Map<string, BatchImage>, shared: BatchImage[]): { image: MediaRef | null; gallery: MediaRef[] } {
  const refs = slots.map((id) => (id ? files.get(id) : undefined)).map((f) => (f ? ({ file: f.path, preview: f.url } as MediaRef) : null));
  return { image: refs[0] ?? null, gallery: [...refs.slice(1).filter((r): r is MediaRef => !!r), ...shared.map((f) => ({ file: f.path, preview: f.url }))] };
}

/* --------------------------------------------------------- blanks from data */

/** A blank from an existing store product: prices, sizes, tags, descriptions and options. */
export function blankFromProduct(p: ProductRow, variations: ProductRow[]): Blank {
  const base = p.name.split(" - ")[0].trim() || p.name;
  const skuPrefix = (p.sku || "").split("-")[0] || "SKU";
  const price = p.type === "variable" ? variations[0]?.regular_price ?? "" : p.regular_price;
  const tokenise = (html: string) => (price ? html.split(price).join("{price}") : html);
  return blankDefaults({
    label: base,
    base,
    prefix: skuPrefix,
    price,
    sale: p.type === "variable" ? "" : p.sale_price,
    stock: p.stock_quantity === null ? "" : String(p.stock_quantity),
    weight: p.weight,
    height: p.height,
    width: p.width,
    length: p.length,
    tags: p.tags.join("|"),
    shipping: p.shipping_class,
    taxClass: p.tax_class,
    featured: p.featured,
    desc: tokenise(stripChatAttrs(p.description)),
    short: tokenise(stripChatAttrs(p.short_description)),
    options: (p.attributes ?? [])
      .filter((a) => a.variation && a.options.length)
      .map((a) => ({
        name: a.name,
        values: a.options.map((value) => {
          const v = variations.find((x) => Object.values(x.variation_attributes ?? {}).some((val) => val.toLowerCase() === value.toLowerCase() || slugify(val) === slugify(value)));
          return { value, price: v && v.regular_price !== price ? v.regular_price : "", sku: "" };
        }),
      })),
  });
}

/** The 56-column Store Manager / WP All Import layout the original Batch Builder exported. */
export const STORE_MANAGER_HEADERS = ["ID", "SKU", "Product Type", "Categories", "Description", "Title", "Short Description", "Post Password", "Slug", "Post Modified Gmt", "Tags", "Parent", "Menu Order", "Comment Count", "Back Orders", "Button Text", "Featured", "Height", "Weight", "Length", "Width", "Manage Stock", "Enable Reviews", "Product URL", "Price (transient)", "Regular Price", "Sale Price", "Sold Individually", "Stock", "Stock Status", "Purchase Note", "Featured Image", "Product Image Gallery", "Tax Class", "Tax Status", "Virtual", "Catalog Visibility", "Post Modified", "Up-Sells", "Cross-Sells", "Grouped Products", "Shipping Class", "Post Author", "Post Status", "Guid", "Download Limit", "Download Expiry", "Downloadable", "Downloadable Files", "Attribute Name", "Attribute Values", "Attribute Slug", "Attribute Position", "Attribute Is Visible", "Attribute Is Variation", "Attribute Is Taxonomy"];

/** File names each product's images get in an export (featured, then gallery a, b, c…). */
export function exportImageNames(b: Blank, it: BatchItem, ext: (slot: number) => string): string[] {
  const names = [fill(b.imagePattern, it.tokens)];
  for (let k = 0; k < b.galleryCount; k++) names.push(fill(b.galleryPattern, { ...it.tokens, letter: "abcdefghij"[k] }));
  return names.map((n, i) => n.replace(/\.[a-z0-9]+$/i, "") + "." + ext(i));
}

export function storeManagerCsv(items: BatchItem[], b: Blank, c: Collection, imageNames: string[][], sharedNames: string[]): string {
  const tags = [...new Set([...splitTags(b.tags), ...splitTags(c.tags)])].map((t) => (/\s/.test(t) ? `"${t}"` : t)).join("|");
  const cats = normalisePaths(c.categories).map((p) => p.split(" > ").join("\\")).join("|");
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = items.map((it, i) => {
    const r: Record<string, string> = {
      SKU: it.sku, "Product Type": it.variations.length ? "variable" : "simple", Categories: cats, Description: fill(b.desc, it.tokens), Title: it.title, "Short Description": fill(b.short, it.tokens), Slug: it.slug, Tags: tags,
      "Menu Order": "0", "Comment Count": "0", "Back Orders": "no", Featured: b.featured ? "yes" : "no", Height: b.height, Weight: b.weight, Length: b.length, Width: b.width, "Manage Stock": "yes", "Enable Reviews": "open",
      "Price (transient)": b.sale || b.price, "Regular Price": b.price, "Sale Price": b.sale, "Sold Individually": "no", Stock: b.stock, "Stock Status": num(b.stock) > 0 ? "instock" : "outofstock",
      "Featured Image": imageNames[i]?.[0] ?? "", "Product Image Gallery": [...(imageNames[i]?.slice(1) ?? []), ...sharedNames].join(","), "Tax Class": b.taxClass || "Standard", Virtual: "no",
      "Catalog Visibility": "Shop and search results", "Shipping Class": b.shipping, "Post Author": "0", "Post Status": c.status, "Download Limit": "-1", "Download Expiry": "-1", Downloadable: "no",
    };
    return STORE_MANAGER_HEADERS.map((h) => cell(r[h] ?? "")).join(",");
  });
  return "﻿" + [STORE_MANAGER_HEADERS.join(","), ...rows].join("\r\n") + "\r\n";
}
