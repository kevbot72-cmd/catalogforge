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
async function step(name, fn, timeout = 60000) {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`step timed out after ${timeout / 1000}s`)), timeout))]);
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
  // The safety question: No leaves everything staged, Yes pushes.
  await page.getByTestId("push-panel").click();
  await page.getByTestId("push-confirm").waitFor();
  expect((await page.getByTestId("push-confirm").innerText()).includes("Are you sure you want to push changes?"), "asks first");
  await shot("07b-push-confirm");
  await page.getByTestId("push-confirm-no").click();
  expect((await pending()) > 0, "No keeps the changes staged");
  await page.getByTestId("push").click();
  await page.getByTestId("push-confirm-yes").click();
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

await step("custom fields: discover, pick, then edit in grid view and product tab", async () => {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("cf-scan").click();
  await page.getByTestId("cf-pick-brand").check();
  await page.getByTestId("cf-pick-warranty_years").check();
  await shot("16-custom-fields-settings");
  await page.getByTestId("cf-save").click();
  await page.getByText("Custom fields saved").waitFor();
  await page.getByTestId("nav-products").click();
  if ((await page.getByTestId("filter-changed").getAttribute("class")).includes("text-accent")) await page.getByTestId("filter-changed").click();
  await page.getByRole("button", { name: /^(Default|Custom|Pricing|Inventory|Shipping|SEO)$/ }).click();
  await page.getByRole("button", { name: "Custom fields", exact: true }).click();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  await shot("17-custom-fields-grid");
  await page.getByTestId("open-palette").click();
  await page.getByTestId("palette").locator("input").fill("Trail");
  await page.waitForTimeout(400);
  await page.getByTestId("palette").locator('[cmdk-item][data-value^="product"]').first().click();
  await page.getByRole("tab", { name: "Custom fields" }).click();
  const brand = page.getByTestId("cf-brand");
  await brand.fill("Acme Outdoor");
  await brand.press("Enter");
  await page.waitForTimeout(300);
  expect((await page.getByTestId("custom-fields-panel").innerText()).includes("Brand"), "panel shows the label");
  await shot("18-custom-fields-drawer");
  await page.getByLabel("Close drawer").click();
});

await step("a new product's Media, Organisation and SEO tabs render", async () => {
  await page.getByTestId("open-palette").click();
  await page.getByTestId("palette").locator("input").fill("New product");
  await page.waitForTimeout(300);
  await page.getByTestId("palette").getByText("New product", { exact: true }).click();
  await page.getByTestId("product-drawer").waitFor();
  for (const t of ["Media", "Organisation", "SEO", "Custom fields"]) {
    await page.getByRole("tab", { name: t }).click();
    await page.waitForTimeout(150);
    expect(!(await page.getByTestId("error-boundary").count()), `${t} tab crashed`);
  }
  await page.getByLabel("Close drawer").click();
});

await step("catalogue: leave out a category, restyle, use a PDF template and create the PDF", async () => {
  const pages = async () => Number(await page.getByTestId("pdf-preview").getAttribute("data-pages"));
  const stats = () => page.getByTestId("catalogue-stats").innerText();
  await page.getByTestId("nav-catalogue").click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="pdf-preview"]')?.getAttribute("data-pages")) > 3, null, { timeout: 60000 });
  const before = await stats();
  await page.getByLabel("Leave out Home").check();
  await page.waitForFunction((b) => document.querySelector('[data-testid="catalogue-stats"]')?.textContent !== b, before.replace(/\n/g, ""), { timeout: 10000 }).catch(() => {});
  expect((await stats()) !== before, "leaving out a category changes the catalogue");
  expect((await stats()).includes("3 categories"), `expected 3 categories, got ${await stats()}`);
  await page.getByRole("tab", { name: "Layout" }).click();
  await page.getByTestId("layout-list").click();
  await page.getByRole("tab", { name: "Cover" }).click();
  await page.getByTestId("cover-texts-title").fill("Spring Collection");
  await page.getByRole("tab", { name: "Headers" }).click();
  await page.getByTestId("header-left").fill("{store} · {category}");
  // A 4-page template PDF made on the fly.
  const { PDFDocument, rgb } = await import("pdf-lib");
  const tpl = await PDFDocument.create();
  for (const c of [rgb(0.1, 0.2, 0.4), rgb(0.9, 0.9, 1), rgb(1, 0.95, 0.9), rgb(0.9, 1, 0.95)]) tpl.addPage([595.28, 841.89]).drawRectangle({ x: 0, y: 0, width: 595.28, height: 40, color: c });
  const { writeFileSync, readFileSync } = await import("node:fs");
  const tplPath = `${SHOTS}template.pdf`;
  writeFileSync(tplPath, await tpl.save());
  await page.getByRole("tab", { name: "Template" }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("template-pick").click()]);
  await chooser.setFiles(tplPath);
  await page.getByText("Template loaded · 4 pages").waitFor();
  await page.waitForTimeout(2500);
  expect((await pages()) > 3, "preview re-rendered with the template");
  await shot("19-catalogue");
  const t0 = Date.now();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 240000 }), page.getByTestId("catalogue-export").click()]);
  console.log(`        full catalogue PDF in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  expect(/\.pdf$/.test(download.suggestedFilename()), `unexpected name ${download.suggestedFilename()}`);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString() === "%PDF-", "a PDF file");
  const out = await PDFDocument.load(bytes);
  expect(out.getPageCount() > 20, `full PDF has every page (${out.getPageCount()})`);
  expect(out.getTitle() === "Spring Collection", `title from the cover (${out.getTitle()})`);
  console.log(`        ${out.getPageCount()} pages, ${(bytes.length / 1048576).toFixed(1)} MB`);
}, 300000);

await step("categories: tick and untick parent and sub-categories for selected products", async () => {
  await page.getByTestId("nav-products").click();
  await page.getByTestId("search").fill("Trail");
  await page.waitForTimeout(600);
  await page.mouse.click(cell(22, 0).x, cell(22, 0).y);
  await page.keyboard.down("Shift");
  await page.mouse.click(cell(22, 1).x, cell(22, 1).y);
  await page.keyboard.up("Shift");
  await page.getByTestId("cat-assign-bar").waitFor();
  expect((await page.getByTestId("cat-assign-bar").innerText()).includes("2 selected products"), "two products selected");
  // Sub-category only.
  await page.getByLabel("Expand Home").click();
  await page.getByTestId("cat-tick-Mugs").check();
  await page.getByText(/Added 2 products to Mugs$/).waitFor();
  expect(!(await page.getByTestId("cat-tick-Home").isChecked()), "parent stays unticked");
  // Sub-category with its parent.
  await page.getByLabel("Also tick parent categories").check();
  await page.getByTestId("cat-tick-Candles").check();
  await page.getByText("Added 2 products to Candles and its parents").waitFor();
  expect(await page.getByTestId("cat-tick-Home").isChecked(), "parent ticked too");
  // Fix a mistake: untick the parent only.
  await page.getByTestId("cat-tick-Home").uncheck();
  await page.getByText("Removed 2 products from Home").waitFor();
  expect(await page.getByTestId("cat-tick-Candles").isChecked(), "sub-category kept");
  await shot("20-category-ticks");
  await page.getByLabel("Also tick parent categories").uncheck();
  // The product editor shows the same choice as full paths.
  await page.getByTestId("open-palette").click();
  await page.getByTestId("palette").locator("input").fill("Trail");
  await page.waitForTimeout(400);
  await page.getByTestId("palette").locator('[cmdk-item][data-value^="product"]').first().click();
  await page.getByRole("tab", { name: "Organisation" }).click();
  const chips = await page.getByTestId("category-chips").innerText();
  expect(chips.includes("Home › Candles") && chips.includes("Home › Mugs"), `chips show paths: ${chips}`);
  await shot("21-category-picker");
  await page.getByLabel("Close drawer").click();
  await page.getByTestId("search").fill("");
});

await step("media: select, select all, and delete selected (with undo)", async () => {
  await page.getByTestId("nav-media").click();
  const tiles = page.getByTestId("media-tile");
  await tiles.first().waitFor();
  const before = await tiles.count();
  await tiles.nth(0).locator("button").first().click();
  await tiles.nth(3).locator("button").first().click({ modifiers: ["Shift"] });
  expect((await page.getByTestId("media-selected-count").innerText()).startsWith("4 selected"), "shift-click selects a range");
  await page.getByTestId("media-select-all").click();
  expect((await page.getByTestId("media-selected-count").innerText()).startsWith(`${before.toLocaleString("en-US")} selected`), "select all");
  await page.getByTestId("media-select-all").click();
  await tiles.nth(0).locator("button").first().click();
  await tiles.nth(1).locator("button").first().click();
  const gone = [await tiles.nth(0).locator(".truncate").first().innerText(), await tiles.nth(1).locator(".truncate").first().innerText()];
  const present = async () => (await page.getByTestId("media-grid").innerText()).split("\n").filter((l) => gone.includes(l)).length;
  await page.getByTestId("media-delete").click();
  await page.getByTestId("media-delete-dialog").waitFor();
  await shot("22-media-delete");
  await page.getByTestId("media-delete-confirm").click();
  await page.getByText(/2 images will be deleted when you push/).waitFor();
  await page.waitForTimeout(300);
  expect((await present()) === 0, `deleted images are gone (${gone.join(", ")})`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);
  expect((await present()) === 2, "undo restores them");
});

await step("bulk edit: paste formatted text into the short description", async () => {
  await page.getByTestId("nav-products").click();
  await page.getByTestId("search").fill("Trail");
  await page.waitForTimeout(600);
  await page.getByTestId("open-mass-change").click();
  await page.getByTestId("mass-field").selectOption("short_description");
  await page.getByTestId("mass-op").selectOption("set");
  const ed = page.getByTestId("mass-rich-value");
  await ed.click();
  // What Google Docs puts on the clipboard: bold in spans, a base size and colour on everything.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/html", '<b style="font-weight:normal" id="docs-internal-guid-x"><p dir="ltr"><span style="font-size:11pt;color:#000000;font-weight:700">Built to last.</span><span style="font-size:11pt;color:#000000"> Now in </span><span style="font-size:11pt;color:#dc2626">red</span><span style="font-size:11pt;color:#000000"> and </span><span style="font-size:18pt;color:#000000">bigger</span></p><ul><li dir="ltr"><p dir="ltr"><span style="font-size:11pt;color:#000000">Waterproof</span></p></li><li dir="ltr"><p dir="ltr"><span style="font-size:11pt;color:#000000">Recycled</span></p></li></ul></b>');
    dt.setData("text/plain", "Built to last. Now in red and bigger\nWaterproof\nRecycled");
    document.querySelector('[data-testid="mass-rich-value"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await page.waitForTimeout(600);
  const html = await ed.innerHTML();
  expect(/<strong>Built to last\.<\/strong>/.test(html), `bold kept: ${html}`);
  expect(/color: (rgb\(220, 38, 38\)|#dc2626)/.test(html), `colour kept: ${html}`);
  expect(/font-size: 18pt/.test(html), `size kept: ${html}`);
  expect(/<ul><li><p>Waterproof<\/p><\/li><li><p>Recycled<\/p><\/li><\/ul>/.test(html), `bullets kept: ${html}`);
  expect(!/11pt|#000000|docs-internal/.test(html), `base styling dropped: ${html}`);
  await shot("23-bulk-rich-paste");
  const label = await page.getByTestId("mass-apply").innerText();
  expect(Number(label.replace(/\D/g, "")) > 0, `applies to products: ${label}`);
  await page.getByTestId("mass-apply").click();
  await page.getByTestId("mass-change").waitFor({ state: "hidden" });
  // The product editor shows the formatted text.
  await page.getByTestId("open-palette").click();
  await page.getByTestId("palette").locator("input").fill("Trail");
  await page.waitForTimeout(400);
  await page.getByTestId("palette").locator('[cmdk-item][data-value^="product"]').first().click();
  await page.getByRole("tab", { name: "General" }).click();
  const short = await page.getByTestId("product-drawer").locator(".ProseMirror").first().innerHTML();
  expect(short.includes("<strong>Built to last.</strong>") && short.includes("<ul>"), `drawer shows the formatting: ${short.slice(0, 200)}`);
  await page.getByLabel("Close drawer").click();
  await page.getByTestId("search").fill("");
});

await step("batch builder: blank × collection, matched images, add to store, continue numbering, export", async () => {
  const { writeFileSync, readFileSync, mkdirSync: mk } = await import("node:fs");
  const dir = `${SHOTS}batch-images/`;
  mk(dir, { recursive: true });
  // Tiny PNGs: three featured images and one gallery image.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const names = ["cat-01.png", "cat-01a.png", "cat-02.png", "cat-03.png"];
  for (const n of names) writeFileSync(dir + n, png);
  await page.getByTestId("nav-batch").click();
  await page.getByTestId("batch-builder").waitFor();
  await page.getByTestId("col-start").fill("1");
  await page.getByTestId("col-count").fill("3");
  expect((await page.getByTestId("batch-stats").innerText()).startsWith("3"), "three products planned");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("batch-pick-images").click()]);
  await chooser.setFiles(names.map((n) => dir + n));
  await page.getByTestId("image-slots").waitFor();
  expect((await page.getByTestId("slot-0-0").getAttribute("aria-label")).startsWith("cat-01.png"), "matched by number");
  expect((await page.getByTestId("slot-0-1").getAttribute("aria-label")).startsWith("cat-01a.png"), "gallery by letter");
  // Swap products 2 and 3's featured images, then back.
  await page.getByTestId("slot-1-0").click();
  await page.getByTestId("slot-2-0").click();
  expect((await page.getByTestId("slot-1-0").getAttribute("aria-label")).startsWith("cat-03.png"), "swapped");
  await page.getByTestId("slot-1-0").click();
  await page.getByTestId("slot-2-0").click();
  expect((await page.getByTestId("batch-checks").innerText()).includes("3 new categories will be created: 11oz Mugs, Funny, Cats Funny"), "category path is new");
  await shot("24-batch-builder");
  // Export the Store Manager CSV.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("batch-csv").click()]);
  const csv = readFileSync(await download.path(), "utf8");
  expect(csv.includes("CERMUG-CF01") && csv.split("\r\n")[0].includes("Product Image Gallery"), "CSV in Store Manager layout");
  // Add to the store.
  await page.getByTestId("batch-add").click();
  await page.getByText(/3 products added/).waitFor();
  await page.getByTestId("product-grid").waitFor();
  await page.getByTestId("search").fill("CERMUG");
  await page.waitForTimeout(700);
  expect(Number(await page.getByTestId("product-grid").getAttribute("data-rows")) === 3, "three new products in the grid");
  await shot("25-batch-in-grid");
  await page.getByTestId("search").fill("");
  // The next batch continues the numbering.
  await page.getByTestId("nav-batch").click();
  expect((await page.getByTestId("col-start").inputValue()) === "4", "next batch starts at 4");
});

await step("categories page: products in a category with tick boxes", async () => {
  await page.getByTestId("nav-categories").click();
  await page.getByTestId("cat-Home").click();
  const box = page.getByTestId("category-products");
  await box.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="category-products"]')?.textContent?.includes("loading"));
  const head = async () => (await box.locator("button").first().innerText());
  expect((await head()).includes("0 directly") && (await head()).includes("only in sub-categories"), `parent shows sub-category products: ${await head()}`);
  expect((await box.innerText()).includes("in Mugs"), "rows say which sub-category");
  const first = box.locator('input[type="checkbox"][data-testid^="catprod-"]').first();
  await first.check();
  await page.waitForTimeout(400);
  expect((await head()).startsWith("Products in this category") && (await head()).includes("1 directly"), `ticked into the parent: ${await head()}`);
  await first.uncheck();
  await page.waitForTimeout(400);
  expect((await head()).includes("0 directly"), "unticked again");
  // Add a product from elsewhere in the store.
  await page.getByTestId("category-add-products").click();
  await page.getByTestId("category-add-search").fill("Alpine");
  await page.waitForTimeout(600);
  await page.getByTestId("category-add-dialog").locator('input[type="checkbox"]:not(:checked)').first().check();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(400);
  expect((await head()).includes("1 directly"), `added from the store: ${await head()}`);
  await shot("26-category-products");
});

await step("migration: pre-flight, prepare, push and verify into an empty store", async () => {
  await page.getByTestId("nav-migration").click();
  await page.getByTestId("migration-view").waitFor();
  await page.getByTestId("migration-src").selectOption("demo-local");
  await page.getByTestId("migration-dst").selectOption("demo-new");
  await page.getByTestId("migration-stats").waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  const stats = await page.getByTestId("migration-stats").innerText();
  expect(/\d+\s*products to create/.test(stats) && !stats.includes("\n0\nproducts to create"), `products to create: ${stats}`);
  await page.getByTestId("migration-status").selectOption("draft");
  await page.waitForTimeout(500);
  await shot("27-migration-preflight");
  await page.getByTestId("migration-prepare").click();
  await page.getByText(/Migration ready in New Store/).waitFor({ timeout: 30000 });
  await page.getByTestId("migration-push").click();
  await page.getByTestId("push-confirm-yes").click();
  await page.getByTestId("toast").filter({ hasText: "Pushed" }).first().waitFor({ timeout: 60000 });
  await page.getByTestId("migration-check").click();
  await page.getByTestId("migration-report").waitFor({ timeout: 30000 });
  const report = await page.getByTestId("migration-report").innerText();
  expect(report.includes("Everything matches"), `verify: ${report.slice(0, 200)}`);
  await shot("28-migration-verified");
  // Running it again finds nothing new.
  await page.getByTestId("migration-dst").selectOption("demo-new");
  await page.waitForTimeout(800);
  expect((await page.getByTestId("migration-prepare").innerText()).includes("Nothing to move") || (await page.getByTestId("migration-stats").innerText()).includes("already there"), "second run skips everything");
}, 120000);

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
