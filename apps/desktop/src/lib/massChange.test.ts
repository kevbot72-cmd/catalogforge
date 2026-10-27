import { describe, expect, it } from "vitest";
import { applyMany, applyMass, isApplicable, MASS_FIELDS, type MassOp } from "./massChange";
import type { ProductRow } from "../backend/types";

const F = (k: string) => MASS_FIELDS.find((f) => f.key === k)!;
const row = (over: Partial<ProductRow> = {}) =>
  ({ type: "simple", regular_price: "20.00", sale_price: "", stock_quantity: 5, name: "red  shoe ", sku: "RS-1", category_ids: [1, 2], tags: ["a"], _state: { key: "1", is_new: false, deleted: false, dirty: [], conflicts: [] }, ...over }) as unknown as ProductRow;
const run = (m: Partial<Omit<MassOp, "field">> & { field: string }, r = row()) => applyMass(r, { value: "", ...m, field: F(m.field) } as MassOp);

describe("mass change", () => {
  it("price operations", () => {
    expect(run({ field: "regular_price", op: "inc_pct", value: "15" })).toBe("23.00");
    expect(run({ field: "regular_price", op: "dec_pct", value: "10" })).toBe("18.00");
    expect(run({ field: "regular_price", op: "add", value: "2.5" })).toBe("22.50");
    expect(run({ field: "regular_price", op: "charm" }, row({ regular_price: "21.30" }))).toBe("21.99");
    expect(run({ field: "sale_price", op: "pct_off_regular", value: "25" })).toBe("15.00");
    expect(run({ field: "regular_price", op: "formula", value: "=ROUND(regular_price * 1.2, 0) - 0.01" })).toBe("23.99");
    expect(run({ field: "sale_price", op: "inc_pct", value: "10" })).toBeUndefined();
    expect(() => run({ field: "regular_price", op: "add", value: "abc" })).toThrow();
  });
  it("text operations", () => {
    expect(run({ field: "name", op: "trim" })).toBe("red shoe");
    expect(run({ field: "name", op: "case", caseMode: "title" })).toBe("Red  Shoe ");
    expect(run({ field: "sku", op: "prepend", value: "NW-" })).toBe("NW-RS-1");
    expect(run({ field: "name", op: "replace", value: "RED", value2: "blue", caseInsensitive: true })).toBe("blue  shoe ");
    expect(run({ field: "sku", op: "replace", value: "^RS-(\\d)", value2: "X$1", regex: true })).toBe("X1");
  });
  it("lists and applicability", () => {
    expect(run({ field: "category_ids", op: "add_items", items: [2, 3] })).toEqual([1, 2, 3]);
    expect(run({ field: "category_ids", op: "remove_items", items: [1] })).toEqual([2]);
    expect(run({ field: "tags", op: "set_items", items: ["x"] })).toEqual(["x"]);
    expect(run({ field: "stock_quantity", op: "sub", value: "2" })).toBe(3);
    expect(isApplicable(row({ type: "variable" }), F("regular_price"))).toBe(false);
    expect(isApplicable(row({ type: "variation" }), F("regular_price"))).toBe(true);
    expect(isApplicable(row({ type: "variation" }), F("category_ids"))).toBe(false);
  });
});

describe("several changes in one bulk edit", () => {
  const f = (key: string) => MASS_FIELDS.find((x) => x.key === key)!;
  const p = (o: Record<string, unknown>) => ({ type: "simple", regular_price: "100.00", sale_price: "", status: "publish", tags: [], _state: { key: String(o.id), is_new: false, deleted: false, dirty: [], conflicts: [] }, ...o }) as unknown as ProductRow;
  it("applies changes in order, each seeing the one before", () => {
    const rows = [p({ id: 1 }), p({ id: 2, regular_price: "50.00" })];
    const { changes } = applyMany(rows, [
      { field: f("regular_price"), op: "inc_pct", value: "10" },
      { field: f("sale_price"), op: "pct_off_regular", value: "20" },
      { field: f("status"), op: "set", value: "draft" },
    ]);
    expect(changes[0].diffs.map((d) => [d.field.key, d.after])).toEqual([["regular_price", "110.00"], ["sale_price", "88.00"], ["status", "draft"]]);
    expect(changes[1].diffs[1].after).toBe("44.00");
  });
  it("names the change that has a bad value and leaves untouched fields out", () => {
    expect(() => applyMany([p({ id: 1 })], [{ field: f("status"), op: "set", value: "draft" }, { field: f("regular_price"), op: "add", value: "abc" }])).toThrow(/^Change 2: /);
    const { changes } = applyMany([p({ id: 1, status: "draft" })], [{ field: f("status"), op: "set", value: "draft" }, { field: f("tags"), op: "add_items", value: "", items: ["sale"] }]);
    expect(changes[0].diffs.map((d) => d.field.key)).toEqual(["tags"]);
  });
});
