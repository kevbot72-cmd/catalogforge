# CatalogForge

A desktop catalog manager for WooCommerce, built to get **large numbers of products, categories and images into a store as fast and safely as possible**. It works with live stores and with sites running in **Local** (formerly Local by Flywheel), and manages many stores from one window.

It replaces the workflow of tools like eMagicOne Store Manager with a modern, cross-platform app (macOS, Windows, Linux) built on Tauri + Rust + React.

![Product grid](docs/screenshots/grid.png)

## What it does

| Area | What you get |
|---|---|
| **Connections** | Four connection types behind one interface: **Local (Flywheel)** with zero setup, the **CatalogForge Connector** plugin (recommended for live stores), the stock **WooCommerce REST API** (no plugin), and **direct MySQL** for very fast reads. |
| **Spreadsheet grid** | Canvas-rendered grid that stays smooth at 100k+ rows. Edit inline, paste ranges from Excel or Google Sheets, drag-fill, multi-select, sort, saved column views (Pricing, Inventory, Shipping, SEO), and expandable variations. |
| **Safe by design** | Nothing touches the store until you **Push**. Every edit is staged as a diff (green = new, yellow = changed, red = deleted). There is one-step **Undo** for any edit or bulk operation, field-level **conflict detection** if someone edits the same field in wp-admin, and a **History** of every push with one-click **Revert**. |
| **Import** | Drop a CSV/XLSX/ODS/JSON file plus an image folder. Columns are auto-mapped (including Shopify exports). You can transform values with Excel-style formulas, group rows into variable products, create missing categories from paths like `Apparel > Tees`, match images by file name or by SKU, validate before anything is staged, and save mappings per supplier. |
| **Bulk edit** | Change prices by %, apply charm pricing (.99), set sales as % off, find and replace (with regex), change case, set categories and tags, or use any formula. A live before/after preview shows exactly which products change. |
| **WYSIWYG** | Rich-text editor for descriptions that cleans text pasted from Word or Google Docs. A **live preview renders the product in your store's real theme** with unsaved edits applied, including stores in WooCommerce "coming soon" mode. |
| **Media** | Images are resized, converted to WebP and given **every WordPress thumbnail size on your computer**, so the server does no image processing. Duplicates are detected by checksum, files are named from a template (`{sku}-{name}-{n}`), and you can drag to reorder galleries. For Local sites, files are written straight to `wp-content/uploads`. |
| **Categories** | Drag-to-nest tree, thumbnail and banner images, WYSIWYG descriptions, SEO fields, and assigning products to categories from the grid. |
| **Variations** | A matrix generator (pick sizes × colours, get every combination, existing ones detected), set-all price/stock/weight, and a command to group existing simple products as variations of one product. |
| **Multi-store** | Store switcher with colour-coded environments (Local / Staging / **LIVE**). **Clone products between stores** (for example, build on Local, then promote to live): categories are matched by path, images are re-uploaded, and existing SKUs are updated instead of duplicated. |
| **Speed** | ⌘K command palette for every action, keyboard shortcuts (⌘S push, ⌘Z undo), and CSV export of any view. |

## Repository layout

```
crates/forge-core/        Rust engine: drivers, SQLite cache + staging, sync, media pipeline
apps/desktop/             Tauri v2 desktop app (React + TypeScript UI)
  src/                    UI, formula engine, import pipeline, demo backend
  src-tauri/              Rust command layer (bundles the connector plugin)
  e2e/run.mjs             End-to-end UI test (Playwright)
plugin/catalogforge-connector/   WordPress plugin installed on the store
plugin/tests/smoke.php    Plugin end-to-end test against a real store
docs/                     Architecture, connector protocol, roadmap
```

## Running it

Prerequisites: Rust (stable), Node 20+, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (WebView2 on Windows, Xcode Command Line Tools on macOS, `libwebkit2gtk-4.1-dev` on Linux).

```bash
cd apps/desktop
npm install
npm run tauri dev        # desktop app with hot reload
npm run tauri build      # installers: .dmg/.app (macOS), .msi/.exe (Windows), .deb/.AppImage (Linux)
```

To try the UI without any store, run `npm run dev` and open http://localhost:1420 in a browser. It runs on generated demo stores.

### Connecting stores

- **Local (Flywheel):** *Add store → Local*. Running sites are listed automatically. Pick one and the app connects to its database, installs and activates the connector plugin, and creates its own access key. Nothing to copy or paste.
- **Live store (recommended):** install `plugin/catalogforge-connector` (zip the folder and upload it in *Plugins → Add New → Upload*). Then go to *Tools → CatalogForge → Create connection key* and paste the `cf1.…` string into *Add store → Connector plugin*. Secrets are stored in the OS keychain.
- **REST API:** WooCommerce → Settings → Advanced → REST API → add a key with Read/Write access, then enter the URL, key and secret.
- **Direct MySQL:** database host, port, credentials and table prefix. Add a connector string to enable writes; without one the connection is read-only by design.

## Tests

```bash
cargo test -p forge-core --lib                  # engine unit tests
cd apps/desktop && npm test                      # formula, import and bulk-edit tests
npm run build && npx vite preview --port 4173 &  # then:
npm run e2e                                      # 16-step UI test on demo data

# Against a real WordPress + WooCommerce with the plugin active:
php plugin/tests/smoke.php https://store.test KEY SECRET
CF_TEST_URL=… CF_TEST_KEY=… CF_TEST_SECRET=… CF_TEST_WP_ROOT=… \
  cargo test -p forge-core --test live_store -- --test-threads=1 --nocapture
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works, [docs/PROTOCOL.md](docs/PROTOCOL.md) for the connector API, and [docs/ROADMAP.md](docs/ROADMAP.md) for verified results, known limitations and what's next.
