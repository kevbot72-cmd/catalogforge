import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, PDFName, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { defaultDesign, THEMES, type CatalogueDesign } from "./design";
import { bundledFile } from "./fonts";
import { buildTree, geometry, paginate, type CatCategory, type CatProduct } from "./plan";
import { renderCatalogue } from "./render";
import { htmlToText, wrap } from "./text";

const cats: CatCategory[] = [
  { id: 1, parent: 0, name: "Apparel", description: "Clothing for every season.", image: null, menuOrder: 0 },
  { id: 2, parent: 1, name: "Tees", description: "", image: null, menuOrder: 0 },
  { id: 3, parent: 1, name: "Jackets", description: "", image: null, menuOrder: 1 },
  { id: 4, parent: 0, name: "Home", description: "", image: null, menuOrder: 1 },
  { id: 5, parent: 4, name: "Mugs", description: "", image: null, menuOrder: 0 },
];

const product = (id: number, cat: number, over: Partial<CatProduct> = {}): CatProduct => ({
  key: String(id), id, name: `Product ${id} — Ünïcode “quotes”`, sku: `SKU-${id}`, type: "simple", status: "publish", regular: 20 + id, sale: id % 5 === 0 ? 15 : null, min: null, max: null,
  description: "A long description that wraps across several lines so the clamp and ellipsis are exercised properly in the card.", shortDescription: "Short and sweet.",
  image: null, previewImage: null, stockStatus: id % 7 === 0 ? "outofstock" : "instock", attributes: [{ name: "Size", options: ["S", "M", "L"] }], categoryIds: [cat],
  permalink: `https://shop.example/p/${id}`, gtin: "", weight: "0.4", custom: { brand: "Acme" }, featured: id === 3, menuOrder: id, ...over,
});

const products = [
  ...Array.from({ length: 14 }, (_, i) => product(100 + i, 2)),
  ...Array.from({ length: 5 }, (_, i) => product(200 + i, 3)),
  ...Array.from({ length: 7 }, (_, i) => product(300 + i, 5)),
  product(400, 999), // only in an unknown category → left out
  product(401, 2, { status: "draft" }),
];

const fontLoader = async (family: string, weight: number, italic: boolean) => {
  const f = bundledFile(family, weight, italic)!;
  return new Uint8Array(readFileSync(`node_modules/@expo-google-fonts/${f.dir}/${f.folder}/${f.file}`));
};

describe("catalogue planning", () => {
  it("builds the tree with exclusions at every level", () => {
    const d: CatalogueDesign = { ...defaultDesign(), excludedCategories: [3], excludedProducts: [100, 101] };
    const tree = buildTree(cats, products, d);
    expect(tree.map((n) => n.name)).toEqual(["Apparel", "Home"]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["Tees"]);
    expect(tree[0].children[0].products).toHaveLength(12);
    expect(buildTree(cats, products, { ...d, excludedCategories: [1] }).map((n) => n.name)).toEqual(["Home"]);
    expect(buildTree(cats, products, { ...d, includeDrafts: true })[0].children[0].products).toHaveLength(13);
    expect(buildTree(cats, products, { ...d, hideOutOfStock: true })[0].children[0].products.some((p) => p.stockStatus === "outofstock")).toBe(false);
  });

  it("paginates with contents page numbers that point at the right pages", () => {
    const d = { ...defaultDesign(), columns: 3, rows: 3 };
    const plan = paginate(buildTree(cats, products, d), d, geometry(d));
    const kinds = plan.pages.map((p) => p.kind);
    expect(kinds[0]).toBe("cover");
    expect(kinds[1]).toBe("index");
    expect(kinds[kinds.length - 1]).toBe("back");
    // Tees: 14 products, 9 per page → 2 pages, then Jackets and Mugs each start a page.
    expect(kinds.filter((k) => k === "content")).toHaveLength(4);
    const tees = plan.toc.find((t) => t.node.name === "Tees")!;
    const apparel = plan.toc.find((t) => t.node.name === "Apparel")!;
    expect(apparel.page).toBe(tees.page);
    const page = plan.pages[tees.page];
    expect(page.kind === "content" && page.blocks[0].t === "heading" && page.blocks[0].node.name === "Tees").toBe(true);
    const second = plan.pages[tees.page + 1];
    expect(second.kind === "content" && second.blocks[0].t === "heading" && second.blocks[0].continued).toBe(true);
    // Every card sits inside the content area.
    for (const p of plan.pages) if (p.kind === "content") for (const b of p.blocks) expect(b.y + b.h).toBeLessThanOrEqual(plan.geometry.bottom + 0.01);
  });

  it("flows categories continuously and adds divider pages when asked", () => {
    const d = { ...defaultDesign(), newPagePerCategory: false, dividerPages: true, layout: "pricelist" as const };
    const plan = paginate(buildTree(cats, products, d), d, geometry(d));
    expect(plan.pages.filter((p) => p.kind === "divider")).toHaveLength(2);
    const home = plan.toc.find((t) => t.node.name === "Home")!;
    expect(plan.pages[home.page].kind).toBe("divider");
  });
});

describe("text", () => {
  it("turns description HTML into readable text", () => {
    expect(htmlToText("<p>Warm &amp; dry</p><ul><li>Wool</li><li>Zip</li></ul>[gallery]")).toBe("Warm & dry\n• Wool\n• Zip");
  });
  it("wraps and clamps with an ellipsis", () => {
    const m = (s: string) => s.length;
    expect(wrap("one two three four five", 9, m)).toEqual(["one two", "three", "four five"]);
    expect(wrap("one two three four five", 9, m, 2)).toEqual(["one two", "three…"]);
  });
});

describe("catalogue rendering", () => {
  it("renders a complete PDF with template pages, links, QR codes and bookmarks", async () => {
    // A 4-page template: cover, index, left, right.
    const tpl = await PDFDocument.create();
    for (const c of [rgb(0.1, 0.1, 0.3), rgb(0.95, 0.95, 1), rgb(1, 0.97, 0.94), rgb(0.94, 0.97, 1)]) tpl.addPage([595.28, 841.89]).drawRectangle({ x: 0, y: 0, width: 595.28, height: 30, color: c });
    const tplBytes = await tpl.save();
    const d: CatalogueDesign = { ...THEMES.Bold(defaultDesign("Northwind")), templateFile: { path: "tpl.pdf", name: "tpl.pdf" }, customFields: ["brand"], show: { ...defaultDesign().show, qr: true, stock: true }, watermark: "Proof", dividerPages: true };
    const plan = paginate(buildTree(cats, products, d), d, geometry(d, [595.28, 841.89]));
    const progress: string[] = [];
    const bytes = await renderCatalogue({
      design: d,
      plan,
      meta: { store: "Northwind", website: "https://northwind.example", currencySymbol: "£", decimals: 2 },
      customLabels: { brand: "Brand" },
      image: async () => null,
      readFile: async (p) => (p === "tpl.pdf" ? tplBytes : new Uint8Array()),
      fontLoader,
      onProgress: (_, __, m) => progress.push(m),
    });
    if (process.env.CF_CATALOGUE_OUT) writeFileSync(process.env.CF_CATALOGUE_OUT, bytes);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(plan.pages.length);
    expect(out.getTitle()).toBe("Northwind");
    expect(out.catalog.get(PDFName.of("Outlines"))).toBeTruthy();
    const annots = out.getPages().reduce((n, p) => n + (p.node.Annots()?.size() ?? 0), 0);
    expect(annots).toBeGreaterThan(products.length);
    expect(progress).toContain("Saving PDF");
  }, 60000);

  it.each(["grid", "list", "pricelist", "feature"] as const)("renders the %s layout", async (layout) => {
    const d: CatalogueDesign = { ...(layout === "list" ? THEMES.Boutique(defaultDesign()) : defaultDesign()), layout, columns: 2, rows: 4, azIndex: false, backCover: false, header: { ...defaultDesign().header, style: { ...defaultDesign().header.style, font: "Helvetica" } } };
    const plan = paginate(buildTree(cats, products, d), d, geometry(d));
    const bytes = await renderCatalogue({ design: d, plan, meta: { store: "S", website: "", currencySymbol: "$", decimals: 2 }, customLabels: {}, image: async () => null, readFile: async () => new Uint8Array(), fontLoader });
    if (process.env.CF_CATALOGUE_OUT) writeFileSync(process.env.CF_CATALOGUE_OUT.replace(".pdf", `-${layout}.pdf`), bytes);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(plan.pages.length);
  }, 60000);
});
