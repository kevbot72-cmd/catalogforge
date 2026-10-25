import { beforeEach, describe, expect, it } from "vitest";
import { addView, deleteView, loadViews, moveColumn, renameView, resetBuiltIn, setViewColumns, viewColumns, viewName } from "./views";

const BUILT = { Default: ["image_id", "name", "sku"], Pricing: ["image_id", "name", "regular_price"] };

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
});

describe("saved views", () => {
  it("brings the old single Custom view over as a named view", () => {
    store.set("cf.columns", JSON.stringify(["name", "sku"]));
    store.set("cf.preset", "Custom");
    const s = loadViews(BUILT);
    expect(viewName(s)).toBe("Custom");
    expect(viewColumns(s, BUILT)).toEqual(["name", "sku"]);
  });

  it("adds, renames (keeping names unique) and deletes views", () => {
    let s = loadViews(BUILT);
    s = addView(s, BUILT, "Stocktake", ["name", "stock_quantity"]);
    expect(viewName(s)).toBe("Stocktake");
    s = addView(s, BUILT, "Stocktake", ["name"]);
    expect(viewName(s)).toBe("Stocktake 2");
    const id = s.active;
    s = renameView(s, BUILT, id, "Pricing");
    expect(viewName(s, id)).toBe("Pricing 2");
    s = renameView(s, BUILT, id, "Weekly prices");
    expect(viewName(s, id)).toBe("Weekly prices");
    s = deleteView(s, id);
    expect(s.active).toBe("Default");
    expect(s.views).toHaveLength(1);
  });

  it("saves column changes into the open view and can reset a built-in", () => {
    let s = loadViews(BUILT);
    s = setViewColumns(s, moveColumn(viewColumns(s, BUILT), 2, 0));
    expect(viewColumns(s, BUILT)).toEqual(["sku", "image_id", "name"]);
    expect(BUILT.Default).toEqual(["image_id", "name", "sku"]);
    s = resetBuiltIn(s, "Default");
    expect(viewColumns(s, BUILT)).toEqual(["image_id", "name", "sku"]);
    expect(moveColumn(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveColumn(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});
