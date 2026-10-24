// End-to-end UI test against the demo backend (vite preview). Usage: npm run build && npx vite preview --port 4173 & npm run e2e
import { createRequire } from "node:module";
// Uses the machine-wide Playwright install (resolved like require()).
const { chromium } = createRequire(import.meta.url)("playwright");
import { mkdirSync } from "node:fs";

const BASE = process.env.CF_E2E_URL ?? "http://localhost:4173";
const SHOTS = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failed = 0;
async function step(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("step timed out after 60s")), 60000))]);
    console.log("  ok  ", name);
  } catch (e) {
    failed++;
    console.log("  FAIL", name, "—", String(e).split("\n")[0]);
    await page.screenshot({ path: `${SHOTS}fail-${name.replace(/\W+/g, "-")}.png` });
  }
}
const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png` });
const pending = async () => Number((await page.getByTestId("push").innerText()).replace(/\D/g, "") || 0);
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.goto(BASE);

await step("grid loads demo catalog", async () => {
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="product-grid"]')?.getAttribute("data-rows")) > 100, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await shot("01-products-grid");
});

const grid = page.getByTestId("product-grid");
const box = await grid.boundingBox();
// Layout: row markers (~44px) | expand 28 | image 44 | name 300 | sku 140 …
const cell = (x, row) => ({ x: box.x + x, y: box.y + 34 + 18 + row * 36 });

await step("inline edit a cell (type + Enter) stages a change", async () => {
  const p = cell(44 + 28 + 44 + 100, 0);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
  await page.keyboard.type("Renamed via grid", { delay: 40 });
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  expect((await pending()) === 1, `expected 1 pending change, got ${await pending()}`);
});

await step("paste a range from Excel into the grid", async () => {
  // Price column x: markers 44 + 28 + 44 + 300 + 140 + 84 + 84 = 724
  const p = cell(724 + 40, 1);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
  await page.evaluate(() => navigator.clipboard.writeText("11.50\n12.50\n13.50"));
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(500);
  const n = await pending();
  expect(n >= 2, `paste should stage more rows, pending=${n}`);
});

await step("undo reverts the paste as one step", async () => {
  const before = await pending();
  await page.getByTestId("undo").click();
  await page.waitForTimeout(400);
  const after = await pending();
  expect(after < before, `undo should reduce pending (${before} -> ${after})`);
});

await step("command palette finds a product and opens the drawer", async () => {
  await page.getByTestId("open-palette").click();
  await page.getByTestId("palette").locator("input").fill("Trail");
  await page.waitForTimeout(400);
  await page.getByTestId("palette").locator('[cmdk-item][data-value^="product"]').first().click();
  await page.getByTestId("product-drawer").waitFor();
});

await step("edit name & price in drawer; live preview renders the draft", async () => {
  await page.getByTestId("drawer-name").fill("Drawer Edited Product");
  await page.getByTestId("drawer-name").press("Enter");
  const price = page.getByTestId("drawer-price");
  if (await price.count()) {
    await price.fill("49.99");
    await price.press("Enter");
  }
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByTestId("preview-pane").locator("iframe").waitFor();
  await page.waitForTimeout(1200);
  const frame = page.frameLocator('[data-testid="preview-pane"] iframe');
  await frame.locator("h1").filter({ hasText: "Drawer Edited Product" }).waitFor({ timeout: 5000 });
  await shot("02-drawer-live-preview");
});

await step("WYSIWYG description editing with paste cleanup", async () => {
  await page.getByRole("tab", { name: "Description" }).click();
  const ed = page.getByTestId("rte-description");
  await ed.click();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="rte-description"]');
    const dt = new DataTransfer();
    dt.setData("text/html", '<p class="MsoNormal" style="color:red"><span style="font-family:Calibri">Pasted <b>from Word</b></span><o:p></o:p></p>');
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await page.waitForTimeout(900);
  const html = await ed.innerHTML();
  expect(html.includes("<strong>from Word</strong>") && !html.includes("Calibri") && !html.includes("MsoNormal"), `paste not cleaned: ${html.slice(0, 200)}`);
  await shot("03-wysiwyg");
  await page.getByLabel("Close drawer").click();
});

await step("bulk edit: +10% price on current view with preview", async () => {
  await page.getByTestId("open-mass-change").click();
  await page.getByTestId("mass-change").waitFor();
  await page.getByTestId("mass-value").fill("10");
  await page.waitForTimeout(1200);
  await shot("04-bulk-edit-preview");
  const label = await page.getByTestId("mass-apply").innerText();
  const n = Number(label.replace(/\D/g, ""));
  expect(n > 50, `bulk edit should affect many products, got "${label}"`);
  const before = await pending();
  await page.getByTestId("mass-apply").click();
  await page.waitForTimeout(800);
  expect((await pending()) > before + 50, "bulk edit should stage many changes");
});

await step("import: paste rows, auto-map, create categories + variable product", async () => {
  await page.getByTestId("open-import").click();
  await page.getByTestId("import-wizard").waitFor();
  await page.locator("summary", { hasText: "paste rows" }).click();
  const tsv = [
    "Title\tSKU\tParent SKU\tPrice\tQty\tCategory\tSize",
    "Expedition Parka\tPARKA-1\t\t\t\tApparel > Outerwear\t",
    "\tPARKA-1-S\tPARKA-1\t199\t4\t\tS",
    "\tPARKA-1-M\tPARKA-1\t199\t0\t\tM",
    "Camp Mug\tMUG-9\t\t14.5\t30\tHome > Mugs\t",
    "Broken Row\tBRK\t\tnot-a-price\t1\t\t",
  ].join("\n");
  await page.getByTestId("import-paste").fill(tsv);
  await page.getByTestId("import-use-paste").click();
  await page.getByTestId("import-next").click();
  await shot("05-import-mapping");
  await page.getByTestId("import-review").click();
  await page.getByTestId("import-review-step").waitFor();
  await shot("06-import-review");
  const text = await page.getByTestId("import-review-step").innerText();
  expect(/not a number/.test(text), "validation should flag the bad price");
  const before = await pending();
  await page.getByTestId("import-commit").click();
  await page.waitForTimeout(800);
  const after = await pending();
  expect(after >= before + 4, `import should stage parent, 2 variations, mug and a category (pending ${before} -> ${after})`);
  await page.waitForTimeout(400);
  await shot("07-imported-rows-green");
});

await step("variation matrix generates combinations", async () => {
  await page.getByTestId("new-product").click();
  await page.getByTestId("product-drawer").waitFor();
  await page.getByTestId("drawer-name").fill("Matrix Tee");
  await page.getByTestId("drawer-name").press("Enter");
  await page.getByTestId("drawer-type").selectOption("variable");
  await page.getByRole("tab", { name: "Variations" }).click();
  await page.getByTestId("open-matrix").click();
  await page.getByTestId("matrix").getByRole("button", { name: "Size" }).click();
  await page.getByTestId("matrix").getByRole("button", { name: "Color" }).click();
  for (const [attr, values] of [["Size", ["S", "M", "L"]], ["Color", ["Black", "Sand"]]]) {
    const input = page.getByTestId("matrix").getByLabel(`${attr} values`);
    for (const v of values) {
      await input.fill(v);
      await input.press("Enter");
    }
  }
  await page.getByTestId("matrix-price").fill("25");
  await shot("08-variation-matrix");
  const label = await page.getByTestId("matrix-create").innerText();
  expect(label.includes("6"), `expected 6 combinations, got "${label}"`);
  await page.getByTestId("matrix-create").click();
  await page.waitForTimeout(600);
  const rows = await page.getByTestId("variations-panel").locator("tbody tr").count();
  expect(rows === 6, `expected 6 variation rows, got ${rows}`);
  await shot("09-variations");
  await page.getByLabel("Close drawer").click();
});

await step("changes panel shows a reviewable diff", async () => {
  await page.getByTestId("toggle-changes").click();
  await page.getByTestId("changes-panel").waitFor();
  await page.waitForTimeout(400);
  await shot("10-changes-diff");
});

await step("push applies everything and records history", async () => {
  await page.getByTestId("push-panel").click();
  await page.getByTestId("toast").filter({ hasText: "Pushed" }).first().waitFor({ timeout: 20000 });
  expect((await pending()) === 0, "nothing should remain pending");
  await page.getByTestId("toggle-changes").click();
});

await step("history shows the push and can stage a revert", async () => {
  await page.getByTestId("nav-history").click();
  await page.getByTestId("history-entry").first().click();
  await page.getByTestId("revert").click();
  await page.waitForTimeout(500);
  expect((await pending()) > 0, "revert should stage inverse changes");
  await shot("11-history");
  await page.getByTestId("changes-panel").getByRole("button", { name: "Discard all" }).click();
  await page.waitForTimeout(300);
});

await step("categories: create, nest and edit", async () => {
  await page.getByTestId("nav-categories").click();
  page.once("dialog", (d) => d.accept("Clearance"));
  await page.getByTestId("add-category").click();
  await page.getByTestId("category-editor").waitFor();
  await page.getByTestId("category-name").fill("Clearance Sale");
  await page.getByTestId("category-name").press("Enter");
  await page.waitForTimeout(300);
  await page.getByTestId("cat-Clearance Sale").dragTo(page.getByTestId("cat-Home"));
  await page.waitForTimeout(400);
  await shot("12-categories");
  expect((await pending()) >= 1, "category creation should be staged");
});

await step("add store: Local sites are discovered", async () => {
  await page.getByTestId("store-switcher").click();
  await page.getByTestId("add-store").click();
  await page.getByTestId("add-store-dialog").waitFor();
  await page.getByText("client-staging.local").waitFor();
  await shot("13-add-store-local");
  await page.getByTestId("kind-connector").click();
  await page.keyboard.press("Escape");
});

await step("export: dialog offers Excel/CSV and downloads a valid workbook", async () => {
  await page.getByTestId("nav-products").click();
  await page.getByTestId("open-export").click();
  await page.getByTestId("export-dialog").waitFor();
  await page.getByTestId("export-xlsx").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-save").click()]);
  expect(/\.xlsx$/.test(download.suggestedFilename()), `unexpected file name ${download.suggestedFilename()}`);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(path);
  expect(bytes[0] === 0x50 && bytes[1] === 0x4b, "xlsx should be a zip container");
  await shot("15-export");
});

await step("dark mode", async () => {
  await page.getByTestId("nav-products").click();
  await page.getByLabel("Toggle dark mode").click();
  await page.waitForTimeout(500);
  await shot("14-dark-mode");
});

const real = errors.filter((e) => !/ResizeObserver|favicon/.test(e));
if (real.length) {
  failed++;
  console.log("  FAIL console errors:\n   ", real.slice(0, 5).join("\n    "));
}
await browser.close();
console.log(failed ? `\n${failed} step(s) failed` : "\nall UI steps passed");
process.exit(failed ? 1 : 0);
