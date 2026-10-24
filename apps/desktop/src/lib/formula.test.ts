import { describe, expect, it } from "vitest";
import { compile, FormulaError, formatDecimal } from "./formula";

const row: Record<string, unknown> = {
  regular_price: "12.30",
  sale_price: "",
  stock_quantity: 4,
  name: "  red   running SHOE ",
  sku: "RS-42-RED",
  status: "draft",
  "Supplier Title": "Crème Brûlée & Co",
  tags: ["a", "b"],
};
const get = (k: string) => row[k];
const run = (f: string) => compile(f).run(get);

describe("formula", () => {
  it("does arithmetic with numeric strings and precedence", () => {
    expect(run("=regular_price * 1.15")).toBeCloseTo(14.145);
    expect(run("1 + 2 * 3 ^ 2")).toBe(19);
    expect(run("-(2 + 3) * 2")).toBe(-10);
    expect(run("(regular_price - 0.3) / 2")).toBe(6);
  });

  it("pricing helpers", () => {
    expect(run("CHARM(regular_price)")).toBe(12.99);
    expect(run("CHARM(12.99)")).toBe(12.99);
    expect(run("CHARM(13)")).toBe(13.99);
    expect(run("CHARM(20.10, 0.95)")).toBe(20.95);
    expect(run("ROUND(regular_price * 1.075, 2)")).toBe(13.22);
    expect(run("CEIL(12.01, 0.5)")).toBe(12.5);
    expect(run("FLOOR(12.99, 5)")).toBe(10);
    expect(run("PERCENT_OFF(100, 15)")).toBe(85);
    expect(formatDecimal(run("regular_price * 2"))).toBe("24.60");
  });

  it("logic and comparisons", () => {
    expect(run('IF(stock_quantity > 0, "instock", "outofstock")')).toBe("instock");
    expect(run('IF(status = "DRAFT", regular_price * 2, regular_price)')).toBe(24.6);
    expect(run("IF(ISBLANK(sale_price), regular_price, sale_price)")).toBe("12.30");
    expect(run("AND(stock_quantity >= 4, stock_quantity <> 5)")).toBe(true);
    expect(run('COALESCE(sale_price, "", regular_price)')).toBe("12.30");
    // lazy IF: the untaken branch would divide by zero
    expect(run("IF(TRUE, 1, 1/0)")).toBe(1);
  });

  it("text functions and column references", () => {
    expect(run("PROPER(TRIM(name))")).toBe("Red Running Shoe");
    expect(run('SPLIT(sku, "-", 2)')).toBe("42");
    expect(run('SPLIT(sku, "-", -1)')).toBe("RED");
    expect(run("UPPER(LEFT(name, 6))")).toBe("  RED ");
    expect(run('"say ""hi"""')).toBe('say "hi"');
    expect(run('SLUG({Supplier Title})')).toBe("creme-brulee-and-co");
    expect(run('REGEXREPLACE(sku, "-\\d+-", "-")')).toBe("RS-RED");
    expect(run('REGEXEXTRACT(sku, "(\\d+)")')).toBe("42");
    expect(run('"SKU: " & sku & " (" & stock_quantity & ")"')).toBe("SKU: RS-42-RED (4)");
    expect(run('CONTAINS(name, "shoe")')).toBe(true);
    expect(run('STRIPHTML("<p>Hi <b>there</b></p>")')).toBe("Hi there");
    expect(run("tags")).toBe("a, b");
  });

  it("reports errors with positions", () => {
    expect(() => compile("ROUND(1, ")).toThrow(FormulaError);
    expect(() => compile("NOPE(1)")).toThrow(/Unknown function/);
    expect(() => run("missing_field + 1")).toThrow(/Unknown field/);
    expect(() => run("name * 2")).toThrow(/not a number/);
    expect(() => run("1/0")).toThrow(/Division by zero/);
    try {
      compile("1 + $");
    } catch (e) {
      expect((e as FormulaError).pos).toBe(4);
    }
  });

  it("lists referenced fields", () => {
    expect(compile("=IF(a > 1, {Col B}, c)").refs.sort()).toEqual(["Col B", "a", "c"]);
  });
});
