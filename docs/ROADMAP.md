# Status and roadmap

## Verified in this build

Tested against WordPress 6.8.3 + WooCommerce 9.9.5 on MariaDB (PHP built-in server):

- **Plugin smoke test (40 checks):** signing, replay protection, a variable product with global attributes plus categories created through references in one batch, idempotent SKU matching, conflict detection, media upload with client-made sizes and deduplication, category and media updates, export, preview (existing and unsaved products, coming-soon mode), delete.
- **Engine integration tests (6):**
  - the full cycle: pull → stage → push with images → conflict → resolve → revert from history → delta pull with remote deletion → category filter → preview;
  - the MySQL reader matching the plugin field-for-field on 1,000 products and every category;
  - the Local adapter auto-provisioning (re-activating the plugin and creating a key) and writing media directly to disk;
  - throughput;
  - custom fields: discovery over the connector and MySQL, reading, editing, pushing and conflict detection;
  - media deletion: the attachment is removed on the store and from the cache, and the product loses the image.
- **Unit tests:** 30 engine (cache, staging and undo, history, PHP serialization, signing, Local discovery, WordPress resize geometry, WebP pipeline, clone mapping) and 16 UI logic (formula engine, import planner, bulk edits).
- **Catalogue tests:** planning (exclusions at every level, pagination, contents page numbers, continuous flow and divider pages), text wrapping, and full PDF renders of every layout with a template, links, QR codes and bookmarks.
- **UI end-to-end (23 steps):** grid edit and paste, undo, palette, drawer and live preview, paste cleanup, bulk edit, import with validation, variation matrix, diff panel, push, history revert, category drag-nesting, Local discovery, export, custom fields, new-product tabs, catalogue (leave out a category, change layout, cover and header text, load a template PDF, create the full PDF), category tick boxes for selected products (sub-category only, with parents, untick a parent), media range select, select all, delete with undo, dark mode.
- **Real desktop app (Tauri on Linux):** loaded 6,695 products from the test store through the connector; switched to a Local site (MySQL pull and auto-provisioning); edited in the grid; pushed with ⌘S (verified in the database); live preview inside the app.

Measured on the test machine (PHP built-in server, untuned MariaDB, so real hosting will differ):

| Operation | Rate |
|---|---|
| Create via connector (full WooCommerce save path, 2,000 products) | ~50 products/s (was ~25/s before the writer optimisations) |
| Pull via connector | ~740 products/s |
| Pull via direct MySQL / Local | ~5,800 products/s (6,695 products in 1.2 s) |

## New in 0.2.1

- **Category tick boxes.** Select products in the grid and every parent and sub-category in the sidebar gets a tick box: ticked (all selected products are in it), a dash (only some are) or empty. Tick to add, untick to remove, so a product put in the wrong category is fixed in one click. *Also tick parent categories* (off by default, remembered) decides whether ticking a sub-category adds its parents too; unticking only ever removes that one category, so products can sit in a parent, a sub-category, or both. The product editor's category list follows the same rules, lists the chosen categories as full paths you can remove, and marks parents that have a ticked sub-category.
- **Media selection and bulk delete.** Click images to select them (Shift-click for a range), *Select all*, and *Delete selected*. Before deleting, CatalogForge shows which products and categories still use those images and takes the images off them in the same step, so nothing is left with a missing picture. Deletions are staged like any other change: review them, undo with ⌘Z, or Push to remove the files (and every resized copy) from the store. A *Not used* filter finds images no product or category uses.
- **Fixed:** clicking a row's tick box in the grid logged an error.

## New in 0.2.0

- **Custom fields.** Settings → Custom fields → *Find fields on this store* lists the fields other plugins add to products (built-in WooCommerce fields are hidden; ACF fields show their labels). Ticked fields are read with every product and are editable in the grid (view: *Custom fields*), a *Custom fields* tab in the product editor, bulk edit, import and export. Works over the connector, Local and MySQL; over the REST API only fields whose key doesn't start with `_` are visible (WooCommerce hides the rest). Connector 0.2.0 is required for field discovery on live stores.
- **Catalogue PDF.** A new *Catalogue PDF* page builds a print-ready catalogue indexed by category, with a live preview. See the README for the full feature list. A 474-page catalogue of 1,361 products with images renders in about 40 seconds in the browser preview build.
- **Fixed:** after a push, the app forgot custom field values it had just written (they were missing from the record the store returns), which also disabled conflict checks for them.

## Fixed in 0.1.2

- **Crash on a new product's Media, Organisation and SEO tabs.** A product created in the app had only the fields you'd set, so those tabs had nothing to show and the window went blank. New products now start with WooCommerce's defaults for every field. Any display error is now contained to the panel it happens in, with a "Try again" button, instead of blanking the window.
- **Import images from file locations.** Tick **Use file locations from the image column** to import from paths such as `C:\Images\shoe-1.jpg|C:\Images\shoe-2.jpg`, with no folder to pick. The extension may be left off, several images can share one cell (separated by `|`) or go in separate Image 1 / Image 2 columns, and the first becomes the featured image while the rest go to the gallery. Missing files are listed on the review step.

## Fixed in 0.1.1

- **Grey/blank product images on Windows + Local.** Images written directly into a Local site were registered with an absolute disk path, because WordPress on Windows spells its uploads folder with mixed slashes, so browsers couldn't load them. The connector now always stores uploads-relative paths and **automatically repairs** images pushed by 0.1.0 the first time the updated plugin runs. Pushes now also spot-check that the store serves uploaded images, and warn with the failing URL if it doesn't.
- **Phone photos appeared sideways.** EXIF orientation is now applied before resizing.
- **Export** now offers Excel (.xlsx) or CSV and a native Save As dialog (choose folder and name), with selected or all products and grid or all columns.

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
