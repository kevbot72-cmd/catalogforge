import { describe, expect, it } from "vitest";
import type { CategoryRow } from "../backend/types";
import { ancestorKeys, assignCategory, categoryPath } from "./categoryAssign";

const cat = (id: number, parent: number, name: string): CategoryRow => ({ id, parent, name, slug: "", description: "", count: 0, display_type: "", image_id: 0, banner_id: 0, menu_order: 0, seo_title: "", seo_description: "", _state: { key: String(id), is_new: false, deleted: false, dirty: [], conflicts: [] } });
const cats = [cat(1, 0, "Apparel"), cat(2, 1, "Tops"), cat(3, 2, "Tees"), cat(9, 0, "Home")];

describe("category assignment", () => {
  it("knows parents and paths", () => {
    expect(ancestorKeys(cats, "3")).toEqual(["2", "1"]);
    expect(categoryPath(cats, "3")).toBe("Apparel › Tops › Tees");
  });
  it("ticks only the category, or the category and its parents", () => {
    expect(assignCategory([9], cats, cats[2], true, false)).toEqual([9, 3]);
    expect(assignCategory([9], cats, cats[2], true, true)).toEqual([9, 3, 2, 1]);
    expect(assignCategory([1, 3], cats, cats[2], true, true)).toEqual([1, 3, 2]);
  });
  it("unticking removes just that category, so parent-only and child-only both work", () => {
    expect(assignCategory([1, 2, 3], cats, cats[2], false, true)).toEqual([1, 2]);
    expect(assignCategory([1, 3], cats, cats[0], false, false)).toEqual([3]);
  });
});
