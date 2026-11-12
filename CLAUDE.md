# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

StoreGenie Pro (formerly CatalogForge) is a desktop bulk catalog manager for WooCommerce: a Tauri v2 app (Rust engine + React UI) plus a WordPress connector plugin. The GitHub repo and local checkout are still named `catalogforge`. The owner works on Windows/PowerShell and builds installers with `npm run tauri build`; give them step-by-step commands.

## Layout

- `crates/storegenie-core/`: the engine (cache, staging/undo, sync, media pipeline, drivers, migration). Library only.
- `apps/desktop/src-tauri/`: Tauri shell. `src/lib.rs` holds every `#[tauri::command]` and app setup. The plugin folder is bundled as a resource for Local sites.
- `apps/desktop/src/`: React UI (Vite, Tailwind, zustand store in `store/app.ts`, Glide data grid).
- `plugin/storegenie-connector/`: WordPress plugin (PHP, classes `SG_*` in `includes/class-sg-*.php`).
- `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md` (signed connector API) and `docs/ROADMAP.md` (verified results, "New in X" notes, limitations).

## Commands

```bash
# Engine
cargo test -p storegenie-core --lib                       # unit tests
cargo test -p storegenie-core --lib signing::             # one module / test name filter
(cd apps/desktop/src-tauri && cargo check)                # desktop shell compiles

# UI (from apps/desktop)
npm install
npm run dev                  # browser on demo data at :1420 (no Rust needed)
npm run tauri dev            # real desktop app
npx tsc --noEmit -p .        # typecheck
npm test                     # vitest (src/lib/*.test.ts)
npx vitest run src/lib/batch.test.ts   # one file
npm run build && npx vite preview --port 4173 &   # then:
npm run e2e                  # Playwright click-through on demo data (e2e/run.mjs, screenshots in e2e/screenshots/)

# Against a real WordPress + WooCommerce with the plugin active
php plugin/tests/smoke.php <base_url> <key> <secret>
SG_TEST_URL=… SG_TEST_KEY=… SG_TEST_SECRET=… SG_TEST_WP_ROOT=… [SG_TEST_DB_HOST/PORT/USER/PASS/NAME=…] \
  cargo test -p storegenie-core --test live_store -- --test-threads=1 --nocapture
# The migration live test also needs SG_TEST2_URL/KEY/SECRET pointing at an EMPTY second store.
```

The live tests skip silently when `SG_TEST_URL` is unset. There is no linter configured beyond `tsc` and `cargo`'s warnings.

## Architecture essentials

**Two backends, one interface.** `apps/desktop/src/backend/types.ts` defines `Backend`. `tauri.ts` calls Rust commands via `invoke` (camelCase args). `demo.ts` is a full in-browser implementation with generated stores, used by `npm run dev` and all e2e tests. Any new backend method or product field must be added to **both**, or the demo/e2e breaks. Demo data lives in memory, so a page reload resets it (localStorage survives).

**Staging is the source of truth.** Each store has a SQLite cache (`<app data>/stores/<id>/catalog.db`). The UI shows `server record ⊕ staged overlay`. One `stage(edits)` call is one undo step. An `Edit` with `value: null` *unstages* that field (it does not set null). New records use `new:<uuid>` keys and are referenced as `ref:new:<uuid>` on the wire. Each staged field keeps its base value, and the server reports conflicts instead of overwriting. Push order is media → categories (parents first) → products → variations → deletes.

**Adding a product field touches many places:** `model.rs` `Product` (serde default), every driver's read and write (`drivers/rest.rs`, `drivers/mysql.rs` read-only, plugin `class-sg-serializer.php` + `class-sg-writer.php`), `cache.rs` `blank_product`, field lists in `sync.rs` (`CLONE_FIELDS`) and `migrate.rs` (`PRODUCT_FIELDS`), `backend/types.ts` `Product`, and `demo.ts` `blankProduct`. If old caches would lack it, bump `MODEL_VERSION` in `sync.rs`, which forces one full re-pull. Custom fields (plugin meta) are flattened to `meta:<key>` fields and folded back on push.

**Drivers** (`drivers/mod.rs` `Driver` trait): Connector (HMAC-signed HTTP, the only full-featured writer), WooCommerce REST, MySQL (reads only; writes go via a connector), and Local (MySQL reads + connector writes + direct-to-disk media; auto-installs and activates the bundled plugin by editing `active_plugins`, and writes its own key).

**Media:** images are resized and converted to WebP with every WordPress sub-size generated in Rust (`media.rs` ports WordPress's resize geometry), then uploaded as one binary body. Deduplication is by SHA-256 stored in `_sg_sha256` attachment meta.

**UI patterns:** zustand `useApp` holds the store, view, dialog, selection, `version` (bump to refetch), appearance and panel prefs. Preferences live in `localStorage` under `sg.*` keys (`lib/migrateStorage.ts` must stay the first import in `main.tsx`). Theming uses CSS variables set by `lib/theme.ts`, read through Tailwind tokens (`accent`, `side`, `close`, radius via `--r`). Close/cancel/discard buttons use `Button variant="close"` / `CloseX` (class `sg-close`). Pure logic sits in `src/lib/*.ts` with vitest tests next to it (importer, bulk edit/`massChange`, formula engine, batch builder, edit-panel `panelEdit`, saved `views`, catalogue PDF).

**e2e** (`apps/desktop/e2e/run.mjs`) clicks on grid coordinates computed from column widths, re-measuring the grid box per step (`onProducts()`). It starts by passing the welcome splash (`splash-enter`). Changing column order/widths or toolbar height can break it; steps share state and run in order.

## Rename compatibility (do not remove)

Everything was renamed from CatalogForge in 0.7.0. Legacy handling is deliberate:
- the plugin also serves `/catalogforge/v1` and accepts `X-CF-*` headers;
- `SG_Migrate` copies `catalogforge_*` options, renames `_cf_*` meta to `_sg_*` and deactivates the old plugin;
- the connector driver falls back to the old namespace;
- `cf1.` connection strings are accepted;
- the MySQL reader also reads `_cf_*` meta;
- the keychain falls back to the old service name;
- `migrate_old_app_folders()` in `src-tauri/src/lib.rs` moves `com.catalogforge.desktop` app folders;
- `cf.*` localStorage keys are copied to `sg.*`.

## Conventions and gotchas

- Versions are bumped together in `Cargo.toml` (workspace), `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`. The plugin has its own version (header + `STOREGENIE_VERSION` in `storegenie-connector.php`). Each release adds a "New in X" section to `docs/ROADMAP.md` and updates its test counts.
- Writes must go through WooCommerce CRUD in the plugin (never raw SQL inserts). The plugin defers term recounts and transients per batch.
- Plugin zips for Linux hosts must use forward slashes. On Windows use `tar -a -c -f storegenie-connector.zip storegenie-connector`, not `Compress-Archive` (WordPress then reports "Plugin file does not exist").
- UI copy is plain, non-technical English aimed at a shop owner.
