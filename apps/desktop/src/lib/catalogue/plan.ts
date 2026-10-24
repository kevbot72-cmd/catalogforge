// Catalogue planning: which products go where, and on which page. Pure and deterministic (fixed
// card sizes), so the contents and A–Z index know every page number before anything is drawn.

import type { CatalogueDesign } from "./design";
import { MM, PAGE_SIZES } from "./design";

export interface CatProduct {
  key: string;
  id: number;
  name: string;
  sku: string;
  type: string;
  status: string;
  /** Prices after the design's adjustment; for variable products the variation range. */
  regular: number | null;
  sale: number | null;
  min: number | null;
  max: number | null;
  description: string;
  shortDescription: string;
  image: string | null;
  previewImage: string | null;
  stockStatus: string;
  attributes: { name: string; options: string[] }[];
  categoryIds: number[];
  permalink: string;
  gtin: string;
  weight: string;
  custom: Record<string, string>;
  featured: boolean;
  menuOrder: number;
}

export interface CatCategory {
  id: number;
  parent: number;
  name: string;
  description: string;
  image: string | null;
  menuOrder: number;
}

export interface CatNode {
  id: number;
  name: string;
  description: string;
  image: string | null;
  depth: number;
  path: string[];
  products: CatProduct[];
  children: CatNode[];
}

export const UNCATEGORISED = -1;

const sorters: Record<CatalogueDesign["sort"], (a: CatProduct, b: CatProduct) => number> = {
  menu_order: (a, b) => a.menuOrder - b.menuOrder || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  sku: (a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }),
  price_asc: (a, b) => (a.sale ?? a.regular ?? a.min ?? Infinity) - (b.sale ?? b.regular ?? b.min ?? Infinity),
  price_desc: (a, b) => (b.sale ?? b.regular ?? b.max ?? -Infinity) - (a.sale ?? a.regular ?? a.max ?? -Infinity),
};

/** Every category id below `root` (inclusive). */
export function descendants(categories: CatCategory[], root: number): Set<number> {
  const kids = new Map<number, number[]>();
  for (const c of categories) kids.set(c.parent, [...(kids.get(c.parent) ?? []), c.id]);
  const out = new Set<number>();
  const walk = (id: number) => {
    out.add(id);
    for (const k of kids.get(id) ?? []) if (!out.has(k)) walk(k);
  };
  walk(root);
  return out;
}

/** Products a design includes, before category placement. */
export function includedProducts(products: CatProduct[], d: CatalogueDesign): CatProduct[] {
  const ex = new Set(d.excludedProducts);
  return products.filter((p) => !ex.has(p.id) && (p.status === "publish" || (d.includeDrafts && p.status !== "trash")) && !(d.hideOutOfStock && p.stockStatus === "outofstock"));
}

/** The category tree the catalogue follows, pruned to categories that end up with products. */
export function buildTree(categories: CatCategory[], products: CatProduct[], d: CatalogueDesign): CatNode[] {
  const excluded = new Set<number>();
  for (const id of d.excludedCategories) for (const x of descendants(categories, id)) excluded.add(x);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const order = (a: CatCategory, b: CatCategory) => a.menuOrder - b.menuOrder || a.name.localeCompare(b.name);
  const nodes = new Map<number, CatNode>();
  const make = (c: CatCategory, depth: number, path: string[]): CatNode => {
    const n: CatNode = { id: c.id, name: c.name, description: c.description, image: c.image, depth, path, products: [], children: [] };
    nodes.set(c.id, n);
    n.children = categories.filter((k) => k.parent === c.id && !excluded.has(k.id)).sort(order).map((k) => make(k, depth + 1, [...path, c.name]));
    return n;
  };
  const roots = categories.filter((c) => (!c.parent || !byId.has(c.parent)) && !excluded.has(c.id)).sort(order).map((c) => make(c, 0, []));

  const other: CatNode = { id: UNCATEGORISED, name: "Other products", description: "", image: null, depth: 0, path: [], products: [], children: [] };
  for (const p of includedProducts(products, d)) {
    const homes = p.categoryIds.filter((id) => nodes.has(id));
    if (!homes.length) {
      // Products only in excluded categories are left out; truly uncategorised ones are optional.
      if (d.includeUncategorised && !p.categoryIds.some((id) => byId.has(id))) other.products.push(p);
      continue;
    }
    for (const id of d.multiCategory === "all" ? homes : homes.slice(0, 1)) nodes.get(id)!.products.push(p);
  }
  if (other.products.length) roots.push(other);

  const prune = (list: CatNode[]): CatNode[] =>
    list
      .map((n) => {
        n.children = prune(n.children);
        n.products.sort(sorters[d.sort]);
        return n;
      })
      .filter((n) => n.products.length || n.children.length);
  return prune(roots);
}

export function countProducts(nodes: CatNode[]): number {
  return nodes.reduce((s, n) => s + n.products.length + countProducts(n.children), 0);
}

/* --------------------------------------------------------------- pagination */

export interface Box {
  x: number;
  y: number; // from the top of the page
  w: number;
  h: number;
}

export type Block =
  | ({ t: "heading"; node: CatNode; continued: boolean } & Box)
  | ({ t: "card"; product: CatProduct } & Box)
  | ({ t: "row"; product: CatProduct } & Box)
  | ({ t: "feature"; product: CatProduct } & Box)
  | ({ t: "table-head" } & Box)
  | ({ t: "table-row"; product: CatProduct; odd: boolean } & Box);

export interface TocEntry {
  node: CatNode;
  depth: number;
  page: number; // 0-based physical page
}

export interface AzEntry {
  product: CatProduct;
  page: number;
}

export type PagePlan =
  | { kind: "cover" }
  | { kind: "index"; entries: TocEntry[]; first: boolean }
  | { kind: "divider"; node: CatNode }
  | { kind: "content"; blocks: Block[]; section: string }
  | { kind: "az"; entries: AzEntry[]; first: boolean }
  | { kind: "back" };

export interface Geometry {
  width: number;
  height: number;
  margin: number;
  top: number;
  bottom: number;
  gap: number;
}

export function geometry(d: CatalogueDesign, templateSize?: [number, number] | null): Geometry {
  let [w, h] = templateSize ?? PAGE_SIZES[d.pageSize];
  if (!templateSize && d.landscape) [w, h] = [h, w];
  const margin = d.margin * MM;
  const band = (on: boolean, size: number) => (on ? size * 1.3 + 12 : 0);
  return { width: w, height: h, margin, top: margin + band(d.header.enabled, d.header.style.size), bottom: h - margin - band(d.footer.enabled, d.footer.style.size), gap: d.gap * MM };
}

export const headingHeight = (d: CatalogueDesign, node: CatNode) => d.categoryHeading.size * 1.25 + (node.depth > 0 ? 13 : 0) + 10;
export const tableRowHeight = (d: CatalogueDesign) => Math.max(d.show.image ? 30 : 0, d.body.size * 2.4);
export const INDEX_LINE = 18;
export const AZ_LINE = 13;

export interface CataloguePlan {
  pages: PagePlan[];
  /** Page index in the full catalogue for each page (quick previews leave pages out). */
  pageNumbers?: number[];
  totalPages?: number;
  toc: TocEntry[];
  geometry: Geometry;
  productCount: number;
}

export function paginate(nodes: CatNode[], d: CatalogueDesign, g: Geometry): CataloguePlan {
  const content: PagePlan[] = [];
  const firstPage = new Map<CatNode, number>(); // content-relative
  const contentW = g.width - 2 * g.margin;
  const layout = d.layout;
  const cols = layout === "grid" ? Math.max(1, Math.min(6, d.columns)) : 1;
  const rowsWanted = layout === "feature" ? 1 : Math.max(1, Math.min(8, d.rows));
  const minHeading = Math.max(...[0, ...flatten(nodes).map((n) => headingHeight(d, n))]);
  const usable = g.bottom - g.top;
  const itemH = layout === "pricelist" ? tableRowHeight(d) : Math.max(60, (usable - minHeading - g.gap * (rowsWanted - 1)) / rowsWanted);
  const itemW = (contentW - g.gap * (cols - 1)) / cols;

  let page: Extract<PagePlan, { kind: "content" }> | null = null;
  let y = 0;
  let section = "";
  const newPage = () => {
    page = { kind: "content", blocks: [], section };
    content.push(page);
    y = g.top;
  };
  const room = (h: number) => page !== null && y + h <= g.bottom + 0.01;

  const place = (node: CatNode) => {
    if (node.depth === 0) section = node.name;
    if (d.dividerPages && node.depth === 0) {
      content.push({ kind: "divider", node });
      firstPage.set(node, content.length - 1);
      page = null;
    }
    if (node.products.length) {
      const hh = headingHeight(d, node);
      const firstRow = layout === "pricelist" ? itemH * 2 : itemH;
      if (d.newPagePerCategory || !room(hh + firstRow)) newPage();
      if (!firstPage.has(node)) firstPage.set(node, content.length - 1);
      const heading = (continued: boolean) => {
        page!.blocks.push({ t: "heading", node, continued, x: g.margin, y, w: contentW, h: hh });
        y += hh;
        if (layout === "pricelist") {
          page!.blocks.push({ t: "table-head", x: g.margin, y, w: contentW, h: itemH });
          y += itemH;
        }
      };
      heading(false);
      const items = node.products;
      for (let i = 0; i < items.length; i += cols) {
        if (!room(itemH)) {
          newPage();
          heading(true);
        }
        items.slice(i, i + cols).forEach((product, c) => {
          const box = { x: g.margin + c * (itemW + g.gap), y, w: itemW, h: itemH };
          if (layout === "grid") page!.blocks.push({ t: "card", product, ...box });
          else if (layout === "list") page!.blocks.push({ t: "row", product, ...box });
          else if (layout === "feature") page!.blocks.push({ t: "feature", product, ...box });
          else page!.blocks.push({ t: "table-row", product, odd: i % 2 === 1, ...box });
        });
        y += itemH + (layout === "pricelist" ? 0 : g.gap);
      }
      y += layout === "pricelist" ? g.gap * 2 : g.gap;
    }
    for (const c of node.children) place(c);
  };
  for (const n of nodes) place(n);
  // A parent with only sub-categories starts where its first child does.
  const startOf = (n: CatNode): number => firstPage.get(n) ?? Math.min(...n.children.map(startOf));
  for (const n of flatten(nodes)) firstPage.set(n, startOf(n));

  // Contents: entries down to the chosen depth.
  const tocNodes = flatten(nodes).filter((n) => n.depth < Math.max(1, d.indexDepth));
  const linesFirst = Math.max(1, Math.floor((g.bottom - g.top - 70) / INDEX_LINE));
  const linesNext = Math.max(1, Math.floor((g.bottom - g.top) / INDEX_LINE));
  const indexPages = d.showIndex && tocNodes.length ? 1 + Math.ceil(Math.max(0, tocNodes.length - linesFirst) / linesNext) : 0;
  const offset = 1 + indexPages; // cover first
  const toc: TocEntry[] = tocNodes.map((node) => ({ node, depth: node.depth, page: offset + Math.max(0, firstPage.get(node) ?? 0) }));

  // A–Z product index: page of each product's first appearance.
  const az: AzEntry[] = [];
  if (d.azIndex) {
    const seen = new Set<number>();
    content.forEach((p, i) => {
      if (p.kind !== "content") return;
      for (const b of p.blocks) if ("product" in b && !seen.has(b.product.id)) {
        seen.add(b.product.id);
        az.push({ product: b.product, page: offset + i });
      }
    });
    az.sort((a, b) => a.product.name.localeCompare(b.product.name));
  }

  const pages: PagePlan[] = [{ kind: "cover" }];
  for (let i = 0, n = 0; i < indexPages; i++) {
    const take = i === 0 ? linesFirst : linesNext;
    pages.push({ kind: "index", entries: toc.slice(n, n + take), first: i === 0 });
    n += take;
  }
  pages.push(...content);
  if (az.length) {
    const perPage = (first: boolean) => 2 * Math.max(1, Math.floor((g.bottom - g.top - (first ? 70 : 0)) / AZ_LINE));
    for (let n = 0, first = true; n < az.length; first = false) {
      const take = perPage(first);
      pages.push({ kind: "az", entries: az.slice(n, n + take), first });
      n += take;
    }
  }
  if (d.backCover) pages.push({ kind: "back" });
  return { pages, toc, geometry: g, productCount: countProducts(nodes) };
}

export function flatten(nodes: CatNode[]): CatNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Left-hand (even) page in a printed spread; the cover is page 1, a right-hand page. */
export const isLeftPage = (pageIndex: number) => pageIndex % 2 === 1;

/**
 * Quick preview: just the cover, contents, the first `maxContentPages` product pages, the first
 * index page and the back cover. `pageNumbers` keeps each page's number in the full catalogue, so
 * numbering, left/right pages and contents read exactly as they will in the full PDF.
 */
export function limitForPreview(plan: CataloguePlan, maxContentPages: number): CataloguePlan {
  let seen = 0;
  let firstAz = true;
  const keep: number[] = [];
  plan.pages.forEach((p, i) => {
    if (p.kind === "content" || p.kind === "divider") {
      if (seen++ < maxContentPages) keep.push(i);
    } else if (p.kind === "az") {
      if (firstAz) keep.push(i);
      firstAz = false;
    } else keep.push(i);
  });
  if (keep.length === plan.pages.length) return plan;
  return { ...plan, pages: keep.map((i) => plan.pages[i]), pageNumbers: keep, totalPages: plan.pages.length };
}
