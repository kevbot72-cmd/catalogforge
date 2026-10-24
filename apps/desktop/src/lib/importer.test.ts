import { describe, expect, it } from "vitest";
import { autoMap, buildPlan, matchImagesBySku, parseCsv, planToStaging, type PlanContext } from "./importer";
import type { Category, LocalFile, Product } from "../backend/types";

let n = 0;
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  categories: [
    { id: 10, parent: 0, name: "Apparel" } as Category,
    { id: 11, parent: 10, name: "Tees" } as Category,
  ],
  existingBySku: new Map(),
  imageFiles: [],
  newKey: () => `new:k${++n}`,
  ...over,
});
const file = (name: string): LocalFile => ({ path: `/imgs/${name}`, name, url: `blob:${name}`, size: 1 });

describe("auto-mapping", () => {
  it("maps common supplier headers", () => {
    const sheet = parseCsv("Product Title,Item Code,RRP,Qty,Category Path,Image URL,EAN,Colour\nA,B,1,2,C,D,E,F");
    const cfg = autoMap(sheet);
    const m = Object.fromEntries(cfg.mappings.map((x) => [x.column, x.field ?? x.kind]));
    expect(m).toMatchObject({ "Product Title": "name", "Item Code": "sku", RRP: "regular_price", Qty: "stock_quantity", "Category Path": "categories", "Image URL": "images", EAN: "global_unique_id", Colour: "attribute" });
  });

  it("detects Shopify exports (handle grouping + option pairs)", () => {
    const sheet = parseCsv("Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Inventory Qty\ntee,Tee,Size,S,T-S,10,5\ntee,,Size,M,T-M,11,0");
    const cfg = autoMap(sheet);
    expect(cfg.groupBy).toBe("Handle");
    expect(cfg.optionPairs).toEqual([{ nameColumn: "Option1 Name", valueColumn: "Option1 Value" }]);
    const plan = buildPlan(sheet, cfg, ctx());
    const parent = plan.products.find((p) => p.entity === "product")!;
    expect(parent.fields.type).toBe("variable");
    expect(parent.fields.sku).toBe("tee");
    expect(parent.fields.attributes).toEqual([{ name: "Size", taxonomy: "pa_size", options: ["S", "M"], visible: true, variation: true, position: 0 }]);
    const vars = plan.products.filter((p) => p.entity === "variation");
    expect(vars.map((v) => [v.fields.sku, v.fields.regular_price, v.fields.stock_quantity, v.fields.stock_status, v.fields.variation_attributes])).toEqual([
      ["T-S", "10.00", 5, "instock", { pa_size: "S" }],
      ["T-M", "11.00", 0, "outofstock", { pa_size: "M" }],
    ]);
    expect(vars[0].fields.parent_id).toBe(parent.key);
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("plan", () => {
  it("creates simple products, resolves and creates categories, normalises values", () => {
    const sheet = parseCsv("name,sku,price,status,categories,tags\nMug,M1,\"1,299.5\",Published,Apparel > Tees | Kitchen > Mugs,\"a, b\"\nCup,C1,abc,live,Tees,");
    const plan = buildPlan(sheet, autoMap(sheet), ctx());
    const [mug, cup] = plan.products;
    expect(mug.fields).toMatchObject({ name: "Mug", sku: "M1", regular_price: "1299.50", status: "publish", type: "simple", tags: ["a", "b"] });
    expect(mug.fields.category_ids).toEqual([11, plan.newCategories[1].key]);
    expect(plan.newCategories.map((c) => c.name)).toEqual(["Kitchen", "Mugs"]);
    expect(plan.newCategories[1].parent).toBe(plan.newCategories[0].key);
    expect(cup.fields.category_ids).toEqual([11]);
    expect(plan.issues).toEqual([expect.objectContaining({ level: "error", row: 3, field: "regular_price" })]);
    const staged = planToStaging(plan, new Map());
    expect(staged.creates.map((c) => c.entity)).toEqual(["category", "category", "product"]);
  });

  it("variations via Parent SKU column, including parents already in the store", () => {
    const sheet = parseCsv("sku,parent sku,name,price,size,color\nP1,,Hoodie,,,\nP1-S,P1,,30,S,Red\nP1-M,P1,,32,M,Red\nX-L,OLD,,40,L,Blue");
    const cfg = autoMap(sheet);
    const plan = buildPlan(sheet, cfg, ctx({ existingBySku: new Map([["OLD", { id: 99, sku: "OLD" } as Product]]) }));
    const parent = plan.products[0];
    expect(parent.fields.type).toBe("variable");
    expect((parent.fields.attributes as { taxonomy: string; options: string[] }[]).map((a) => [a.taxonomy, a.options])).toEqual([["pa_size", ["S", "M"]], ["pa_color", ["Red"]]]);
    const vars = plan.products.filter((p) => p.entity === "variation");
    expect(vars.map((v) => v.fields.parent_id)).toEqual([parent.key, parent.key, 99]);
    expect(vars[2].fields.variation_attributes).toEqual({ pa_size: "L", pa_color: "Blue" });
  });

  it("updates existing products by SKU with only changed fields and never blanks data", () => {
    const sheet = parseCsv("sku,price,name\nA1,12,\nNEW,5,New one");
    const existing = { id: 7, sku: "A1", regular_price: "10.00", name: "Keep me" } as Product;
    const plan = buildPlan(sheet, autoMap(sheet), ctx({ existingBySku: new Map([["A1", existing]]) }));
    expect(plan.stats).toMatchObject({ create: 1, update: 1 });
    const staged = planToStaging(plan, new Map([["7", existing]]));
    expect(staged.edits).toEqual([{ entity: "product", key: "7", field: "regular_price", value: "12.00" }]);
    const updateOnly = buildPlan(sheet, { ...autoMap(sheet), mode: "update_only" }, ctx({ existingBySku: new Map([["A1", existing]]) }));
    expect(updateOnly.products.length).toBe(1);
  });

  it("matches images by column and by SKU prefix", () => {
    const files = [file("AB-1.jpg"), file("ab-1_2.JPG"), file("AB-1-1.png"), file("AB-10.jpg"), file("hero.webp")];
    expect(matchImagesBySku("AB-1", files).map((f) => f.name)).toEqual(["AB-1.jpg", "AB-1-1.png", "ab-1_2.JPG"]);
    const sheet = parseCsv("sku,name,images\nAB-1,One,\nZZ,Two,hero.webp|https://cdn.x/a.jpg|missing.jpg");
    const plan = buildPlan(sheet, autoMap(sheet), ctx({ imageFiles: files }));
    expect(plan.products[0].fields.image_id).toMatchObject({ file: "/imgs/AB-1.jpg" });
    expect((plan.products[0].fields.gallery_ids as unknown[]).length).toBe(2);
    expect(plan.products[1].fields.image_id).toMatchObject({ file: "/imgs/hero.webp" });
    expect(plan.products[1].fields.gallery_ids).toEqual([{ url: "https://cdn.x/a.jpg" }]);
    expect(plan.issues.some((i) => i.level === "warning" && /missing.jpg/.test(i.message))).toBe(true);
  });

  it("applies formulas and fallbacks, and flags duplicate SKUs", () => {
    const sheet = parseCsv("sku,name,cost\nD1,  shoe red ,10\nD1,boot,20");
    const cfg = autoMap(sheet);
    cfg.transforms = { name: { formula: "PROPER(TRIM(name))" }, regular_price: { formula: "CHARM({cost} * 2.2)" }, status: { fallback: "draft" } };
    const plan = buildPlan(sheet, cfg, ctx());
    expect(plan.products[0].fields).toMatchObject({ name: "Shoe Red", regular_price: "22.99", status: "draft" });
    expect(plan.issues.some((i) => i.level === "error" && /Duplicate SKU/.test(i.message))).toBe(true);
    const staged = planToStaging(plan, new Map());
    expect(staged.creates.length).toBe(1);
  });
});
