# Status and roadmap

## Verified in this build

Tested against WordPress 6.8.3 + WooCommerce 9.9.5 on MariaDB (PHP built-in server):

- **Plugin smoke test (40 checks):** signing, replay protection, a variable product with global attributes plus categories created through references in one batch, idempotent SKU matching, conflict detection, media upload with client-made sizes and deduplication, category and media updates, export, preview (existing and unsaved products, coming-soon mode), delete.
- **Engine integration tests (4):**
  - the full cycle: pull → stage → push with images → conflict → resolve → revert from history → delta pull with remote deletion → category filter → preview;
  - the MySQL reader matching the plugin field-for-field on 1,000 products and every category;
  - the Local adapter auto-provisioning (re-activating the plugin and creating a key) and writing media directly to disk;
  - throughput.
- **Unit tests:** 30 engine (cache, staging and undo, history, PHP serialization, signing, Local discovery, WordPress resize geometry, WebP pipeline, clone mapping) and 16 UI logic (formula engine, import planner, bulk edits).
- **UI end-to-end (16 steps):** grid edit and paste, undo, palette, drawer and live preview, paste cleanup, bulk edit, import with validation, variation matrix, diff panel, push, history revert, category drag-nesting, Local discovery, dark mode.
- **Real desktop app (Tauri on Linux):** loaded 6,695 products from the test store through the connector; switched to a Local site (MySQL pull and auto-provisioning); edited in the grid; pushed with ⌘S (verified in the database); live preview inside the app.

Measured on the test machine (PHP built-in server, untuned MariaDB, so real hosting will differ):

| Operation | Rate |
|---|---|
| Create via connector (full WooCommerce save path, 2,000 products) | ~50 products/s (was ~25/s before the writer optimisations) |
| Pull via connector | ~740 products/s |
| Pull via direct MySQL / Local | ~5,800 products/s (6,695 products in 1.2 s) |

## Known limitations

- **Typing into a cell at machine speed** (e.g. a barcode scanner) can drop the first characters before the cell editor opens. Press Enter to open the editor first, or scan into the drawer's SKU/GTIN fields.
- **REST API connections** cannot upload local image files (WooCommerce only accepts public URLs there) and have no theme preview. Use the connector for live stores.
- **Starting a stopped Local site** uses Local's GraphQL API. The mutation name follows Local's current schema and was not verifiable without Local installed. If it fails, start the site in Local.
- **macOS and Windows builds** are configured but were built and run only on Linux here. Signed installers need your Apple and Windows signing certificates.
- **Very large imports** stage everything in one undo step. For 50k+ rows, import in chunks of ~10k.

## Next

1. **SSH tunnel and SFTP drivers**: direct MySQL over SSH, and SFTP media upload for hosts that block HTTP uploads.
2. **Scheduled supplier feeds**: saved import profiles run on a schedule from SFTP/HTTP/FTP, with a dry-run report before staging.
3. **AI copilot**: bulk SEO titles and descriptions, alt text from images, attribute extraction from supplier descriptions, and image-first product creation. All output is staged as diffs like any other edit.
4. **Cloud companion**: shared staging for teams with roles, presence, an audit log, plus always-on jobs such as cross-store inventory sync via webhooks.
5. **Translations**: WPML/Polylang awareness (edit and push translated fields).
6. **Orders**: bulk status updates and packing slips using HPOS tables. POS is out of scope until the catalog engine has shipped.
7. **Distribution**: auto-updater, code signing and notarization, and a WebDriver test of the packaged app on all three OSes.
