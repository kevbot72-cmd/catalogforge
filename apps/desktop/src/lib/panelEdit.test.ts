import { describe, expect, it } from "vitest";
import type { ProductRow } from "../backend/types";
import { appliesTo, common, isMaths, itemCounts, mapEdits, numberEdits, parseQuick, setEdits } from "./panelEdit";

const row = (key: string, o: Record<string, unknown> = {}): ProductRow =>
  ({ id: Number(key), type: "simple", regular_price: "", sale_price: "", tags: [], category_ids: [], _state: { key, is_new: false, deleted: false, dirty: [], conflicts: [] }, ...o }) as unknown as ProductRow;

describe("parseQuick", () => {
  it("understands plain values, percentages, amounts, multiplying and formulas", () => {
    expect(parseQuick("99")).toEqual({ op: "set", value: "99" });
    expect(parseQuick("99,50")).toEqual({ op: "set", value: "99.50" });
    expect(parseQuick("+10%")).toEqual({ op: "inc_pct", value: "10" });
    expect(parseQuick("-15 %")).toEqual({ op: "dec_pct", value: "15" });
    expect(parseQuick("+5")).toEqual({ op: "add", value: "5" });
    expect(parseQuick("-5")).toEqual({ op: "sub", value: "5" });
    expect(parseQuick("x1.2")).toEqual({ op: "mul", value: "1.2" });
    expect(parseQuick("=regular_price*0.8")).toEqual({ op: "formula", value: "regular_price*0.8" });
    expect(parseQuick("")).toEqual({ op: "clear", value: "" });
    expect(() => parseQuick("cheap")).toThrow(/isn't a number/);
    expect(isMaths("+10%")).toBe(true);
    expect(isMaths("99")).toBe(false);
  });
});

describe("common", () => {
  it("reports shared and mixed values with a numeric range", () => {
    const rows = [row("1", { regular_price: "95.00" }), row("2", { regular_price: "99.00" }), row("3", { regular_price: "" })];
    const c = common(rows, "regular_price", "decimal");
    expect(c.same).toBe(false);
    expect(c.summary).toBe("95 – 99 · 1 empty");
    expect(common([rows[0], row("4", { regular_price: "95.00" })], "regular_price").same).toBe(true);
  });
  it("leaves out rows the field doesn't apply to", () => {
    const rows = [row("1", { tags: ["a"] }), row("2", { type: "variation", tags: [] })];
    expect(common(rows, "tags").rows).toHaveLength(1);
    expect(appliesTo(row("5", { type: "variable" }), "regular_price")).toBe(false);
    expect(appliesTo(row("6"), "external_url")).toBe(false);
  });
});

describe("edits", () => {
  it("applies maths per product and skips unchanged rows", () => {
    const rows = [row("1", { regular_price: "100.00" }), row("2", { regular_price: "50.00" }), row("3", { regular_price: "" })];
    expect(numberEdits(rows, "regular_price", "decimal", "+10%").map((e) => e.value)).toEqual(["110.00", "55.00"]);
    expect(numberEdits(rows, "regular_price", "decimal", "100").map((e) => e.key)).toEqual(["2", "3"]);
    expect(numberEdits([row("4", { regular_price: "80.00", sale_price: "" })], "sale_price", "decimal", "=regular_price*0.5")[0].value).toBe("40.00");
  });
  it("sets one value for all and edits lists per row", () => {
    const rows = [row("1", { tags: ["a"] }), row("2", { tags: ["b"] })];
    expect(setEdits(rows, "status", "draft")).toHaveLength(2);
    const add = mapEdits(rows, "tags", (cur) => [...new Set([...(cur as string[]), "a"])]);
    expect(add).toEqual([{ entity: "product", key: "2", field: "tags", value: ["b", "a"] }]);
    expect(itemCounts(rows, "tags")).toEqual(new Map([["a", 1], ["b", 1]]));
  });
});
