import { describe, expect, it } from "vitest";
import type { Category, Product } from "../backend/types";
import { blankDefaults, buildItems, checks, collectionDefaults, matchImages, MUG_BLANK, nextNumber, normalisePaths, storeManagerCsv, STORE_MANAGER_HEADERS, toImport, type BatchImage } from "./batch";
import { buildPlan, parseCsv, planToStaging } from "./importer";

const col = { ...collectionDefaults(), start: 32, count: 3 };
const ctx = (existing: Product[] = [], categories: Category[] = []) => {
  let n = 0;
  return { categories, existingBySku: new Map(existing.map((p) => [p.sku, p])), imageFiles: [], newKey: () => `new:t${n++}` };
};

describe("batch builder", () => {
  it("builds numbered and listed products from a blank", () => {
    const items = buildItems(MUG_BLANK, col);
    expect(items.map((i) => [i.title, i.sku, i.slug])).toEqual([
      ["11oz Ceramic Coffee Mug - Cat Funny 32", "CERMUG-CF32", "11oz-ceramic-coffee-mug-cat-funny-32"],
      ["11oz Ceramic Coffee Mug - Cat Funny 33", "CERMUG-CF33", "11oz-ceramic-coffee-mug-cat-funny-33"],
      ["11oz Ceramic Coffee Mug - Cat Funny 34", "CERMUG-CF34", "11oz-ceramic-coffee-mug-cat-funny-34"],
    ]);
    const listed = buildItems(MUG_BLANK, { ...col, mode: "list", start: 1, list: "Best Mom Ever\nCoffee First" });
    expect(listed.map((i) => i.title)).toEqual(["11oz Ceramic Coffee Mug - Best Mom Ever", "11oz Ceramic Coffee Mug - Coffee First"]);
  });

  it("continues numbering after the store's highest SKU", () => {
    expect(nextNumber(MUG_BLANK, col, ["CERMUG-CF01", "CERMUG-CF41", "CERMUG-XY99", "OTHER-CF50"])).toEqual({ next: 42, highest: 41, found: 2 });
    expect(nextNumber({ ...MUG_BLANK, skuPattern: "{prefix}-{code}" }, col, [])).toBeNull();
  });

  it("matches images by the number in the file name, or by order", () => {
    const f = (name: string): BatchImage => ({ id: name, name, path: `/imgs/${name}`, url: "", size: 1 });
    const items = buildItems(MUG_BLANK, col);
    const files = [f("cat-33.png"), f("cat-32a.png"), f("cat-32.png"), f("cat-34.png"), f("logo.png")];
    expect(matchImages(items, files, "number", 2)).toEqual([["cat-32.png", "cat-32a.png"], ["cat-33.png", null], ["cat-34.png", null]]);
    expect(matchImages(items, files, "order", 1)).toEqual([["cat-32.png"], ["cat-32a.png"], ["cat-33.png"]]);
  });

  it("plans simple products with categories, tags and {price} filled in", () => {
    const items = buildItems(MUG_BLANK, col);
    const { sheet, cfg } = toImport(items, MUG_BLANK, col, []);
    const plan = buildPlan(sheet, cfg, ctx());
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.stats.create).toBe(3);
    expect(plan.newCategories.map((c) => c.name)).toEqual(["11oz Mugs", "Funny", "Cats Funny"]);
    const p = plan.products[0].fields;
    expect(p).toMatchObject({ name: "11oz Ceramic Coffee Mug - Cat Funny 32", sku: "CERMUG-CF32", regular_price: "90.00", stock_quantity: 4, manage_stock: true, status: "publish", type: "simple", tags: ["Mugs", "Ceramic Mug", "Coffee", "Customizable", "Cute", "cats"] });
    expect(String(p.short_description)).toContain("R90");
    const { creates } = planToStaging(plan, new Map());
    expect(creates.filter((c) => c.entity === "product")).toHaveLength(3);
  });

  it("skips or updates SKUs that already exist", () => {
    const items = buildItems(MUG_BLANK, col);
    const existing = [{ id: 7, sku: "CERMUG-CF33", name: "old" } as Product];
    const skip = buildPlan(...(Object.values(toImport(items, MUG_BLANK, col, [])).slice(0, 2) as [never, never]), ctx(existing));
    expect(skip.stats).toMatchObject({ create: 2, update: 0 });
    const upd = toImport(items, MUG_BLANK, { ...col, existing: "update" }, []);
    expect(buildPlan(upd.sheet, upd.cfg, ctx(existing)).stats).toMatchObject({ create: 2, update: 1 });
  });

  it("makes variable products from blank options, with per-option prices", () => {
    const tee = blankDefaults({ base: "Tee", prefix: "TEE", price: "200", stock: "5", options: [{ name: "Size", values: [{ value: "S", price: "", sku: "" }, { value: "XL", price: "230", sku: "" }] }] });
    const items = buildItems(tee, { ...col, count: 2 });
    expect(items[0].variations).toEqual([{ sku: "TEE-CF32-S", attrs: { Size: "S" }, price: "200" }, { sku: "TEE-CF32-XL", attrs: { Size: "XL" }, price: "230" }]);
    const { sheet, cfg } = toImport(items, tee, col, []);
    const plan = buildPlan(sheet, cfg, ctx());
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.stats).toMatchObject({ create: 2, variations: 4 });
    const parent = plan.products.find((p) => p.entity === "product")!;
    expect(parent.fields).toMatchObject({ type: "variable", sku: "TEE-CF32" });
    expect(parent.fields.attributes).toMatchObject([{ name: "Size", options: ["S", "XL"], variation: true }]);
    const xl = plan.products.find((p) => p.fields.sku === "TEE-CF32-XL")!;
    expect(xl.fields).toMatchObject({ regular_price: "230.00", stock_quantity: 5 });
  });

  it("flags problems before anything is staged", () => {
    const b = { ...MUG_BLANK, price: "95", sale: "0", desc: '<p data-start="1">R90 only</p>' };
    const items = buildItems(b, col);
    const out = checks(items, b, { ...col, categories: "" }, { storeSkus: new Set(["CERMUG-CF32"]), assign: [], images: [], knownPaths: new Set(), symbol: "R" });
    const text = out.map((c) => c.message).join("\n");
    expect(text).toContain("already in the store");
    expect(text).toContain("Sale price is 0");
    expect(text).toContain("mentions R90");
    expect(text).toContain("data-start");
    expect(text).toContain("No category set");
    expect(out.find((c) => c.fix === "strip-chat")).toBeTruthy();
  });

  it("exports the Store Manager layout", () => {
    const items = buildItems(MUG_BLANK, col);
    const csv = storeManagerCsv(items, MUG_BLANK, col, items.map((i) => [`${i.title}.webp`, `${i.title}a.webp`]), ["size-chart.webp"]);
    const sheet = parseCsv(csv);
    expect(sheet.columns).toEqual(STORE_MANAGER_HEADERS);
    expect(sheet.rows[0]).toMatchObject({ SKU: "CERMUG-CF32", Categories: "11oz Mugs\\Funny\\Cats Funny", "Featured Image": "11oz Ceramic Coffee Mug - Cat Funny 32.webp", "Product Image Gallery": "11oz Ceramic Coffee Mug - Cat Funny 32a.webp,size-chart.webp" });
    expect(normalisePaths("A\\B|C > D")).toEqual(["A > B", "C > D"]);
  });
});
