# Status and roadmap

## Verified in this build

Tested against WordPress 6.8.3 + WooCommerce 9.9.5 on MariaDB (PHP built-in server):

- **Plugin smoke test (40 checks):** signing, replay protection, a variable product with global attributes plus categories created through references in one batch, idempotent SKU matching, conflict detection, media upload with client-made sizes and deduplication, category and media updates, export, preview (existing and unsaved products, coming-soon mode), delete.
- **Engine integration tests (9):**
  - the full cycle: pull → stage → push with images → conflict → resolve → revert from history → delta pull with remote deletion → category filter → preview;
  - the MySQL reader matching the plugin field-for-field on 1,000 products and every category;
  - the Local adapter auto-provisioning (re-activating the plugin and creating a key) and writing media directly to disk;
  - throughput;
  - custom fields: discovery over the connector and MySQL, reading, editing, pushing and conflict detection;
  - media deletion: the attachment is removed on the store and from the cache, and the product loses the image;
  - formatted descriptions (lists, bold, colour, size) are stored by WooCommerce exactly as pushed;
  - migration of a whole store (11,742 products) into a second, empty WooCommerce store, verified product by product, with a second run creating nothing;
  - up-sells, cross-sells, brands, purchase note, "limit one per order" and reviews pushed and read back identically through the connector and direct MySQL.
- **Unit tests:** 30 engine (cache, staging and undo, history, PHP serialization, signing, Local discovery, WordPress resize geometry, WebP pipeline, clone mapping) and 54 UI logic (formula engine, import planner, bulk edits, edit-panel mixed values and quick maths).
- **Catalogue tests:** planning (exclusions at every level, pagination, contents page numbers, continuous flow and divider pages), text wrapping, and full PDF renders of every layout with a template, links, QR codes and bookmarks.
- **UI end-to-end (31 steps):** grid edit and paste, undo, palette, drawer and live preview, paste cleanup, bulk edit, import with validation, variation matrix, diff panel, push, history revert, category drag-nesting, Local discovery, export, custom fields, new-product tabs, catalogue (leave out a category, change layout, cover and header text, load a template PDF, create the full PDF), category tick boxes for selected products (sub-category only, with parents, untick a parent), media range select, select all, delete with undo, pasting Google Docs text into bulk edit, push confirmation (No keeps changes staged, Yes pushes), Batch Builder (images matched and swapped, CSV export, batch added to the store, numbering continues), products in a category with tick boxes (sub-category products, tick, untick, add from the store), migration into an empty store (pre-flight, prepare, push, verify, re-run skips everything), grid dropdown cells (keyboard choice, apply to all ticked rows), the ▸ in front of a variable product's name, the edit panel (tick three products, Mixed values, +10% on all, stock status, add a tag to all, discard), docking it on the right, folding and Ctrl+E, the version badge, themes and close-button styles, saved views (new, rename, drag a column header, kept after reopening, delete), dark mode.
- **Real desktop app (Tauri on Linux):** loaded 6,695 products from the test store through the connector; switched to a Local site (MySQL pull and auto-provisioning); edited in the grid; pushed with ⌘S (verified in the database); live preview inside the app.

Measured on the test machine (PHP built-in server, untuned MariaDB, so real hosting will differ):

| Operation | Rate |
|---|---|
| Create via connector (full WooCommerce save path, 2,000 products) | ~50 products/s (was ~25/s before the writer optimisations) |
| Pull via connector | ~740 products/s |
| Pull via direct MySQL / Local | ~5,800 products/s (6,695 products in 1.2 s) |

## New in 0.5.1

- **Saved views** (the views button on the products page, which shows the open view's name):
  - **New view from these columns** saves the current columns under a name you choose.
  - Your own views have **Rename** (pencil) and **Delete** (red bin) buttons; the old single "Custom" view becomes a named view you can rename.
  - Changing columns saves into the open view. A built-in view you've changed shows "changed" with a button to put it back.
  - The column list in the menu can be dragged into a new order, with a line showing where the column will go.
- **Move columns by dragging their header** in the grid. The column follows the mouse and the others slide aside to show where it will land; the new order is saved into the open view.
- Views, column order and the open view are kept when you close CatalogForge. Export's "current view" uses them too.

## New in 0.5.0

- **Edit panel** under the products grid (or docked on the right with one click), modelled on Store Manager's lower panel but built for editing many products at once:
  - Tick any number of products and edit them all; with nothing ticked it shows the row you clicked. Clicking a product's picture still opens the full editor.
  - Sections: Content, General, Inventory, Shipping, Linked products, Attributes, Advanced, Categories, Product tags, Gallery, Custom fields, SEO and Brands. A dot marks sections with staged changes.
  - The header has the product type, Virtual, Downloadable and Featured (a dash means only some of the ticked products have it), the number of staged changes, **Discard**, and **Full editor**.
  - Where the ticked products differ, a field says **Mixed** with the range (for example "80.49 – 100.49"); hover to see each value. Typing a value sets it on all of them.
  - Price, stock, weight and number fields accept quick maths: `+10%`, `-5%`, `+20`, `-5`, `*1.2` or a formula like `=regular_price*0.8`. While you type, it shows the result (one product) or how many products change.
  - Categories, tags, brands, up-sells, cross-sells and attributes show "2 of 3" for items only some products have; tick, add or remove for all of them at once.
  - **Find a field** searches every section; **Only show fields that differ** lists just the mixed ones. Each field has its own undo.
  - Drag the top edge to resize, double-click it or press **Ctrl+E** to fold it to a slim bar. Height, dock side and open section are remembered.
- **New product fields**, read and written through the connector (plugin 0.3.0), the REST API and direct MySQL: up-sells, cross-sells, brands (WooCommerce 9.6+), purchase note, "limit one per order" and reviews on/off. Stores synced with an older version re-download once on the next Sync to pick these up.
- **Grid:**
  - Status, Stock status, Visibility, Type, Manage stock, Featured and yes/no custom fields open a list right in the cell: one click opens it; click a choice or use the arrow keys and Enter (type a letter to jump). With several rows ticked, the choice goes to all of them.
  - The empty first column is gone; variable products have ▸ in front of the name (click it to show the variations).
  - Ticking rows no longer needs Ctrl, and clicking a cell keeps your ticks (untick, use the header box, or press Esc to clear them).
  - Double-clicking the categories or a description cell opens that section of the edit panel.
- **Close, cancel and discard buttons are red** everywhere (✕ on windows and panels, Cancel, Clear, Discard, Delete, No), so they're easy to find on a busy page. Three styles in Settings: red text, red outline (default) or soft red pill.
- **Settings → Appearance:** six themes (Indigo by default, Ocean, Forest, Plum, Copper, Graphite) plus your own colour; Light, Dark or Match computer; close-button style; Comfortable or Compact rows; Square, Soft or Round corners; Small, Normal or Large text. **Reset to theme** undoes the rest.
- **Version badge** next to CatalogForge in the sidebar; click it to open Settings.

## New in 0.4.0

- **Migration** (sidebar → Migration), for moving your catalogue into a new store:
  1. **From and to**: pick the two stores (or add the new one); both are read fresh.
  2. **What to move**: images, drafts and private products, custom fields (and set up the same custom fields on the new store), empty categories, the whole catalogue or only some categories; existing SKUs left alone or updated; keep each product's status, make everything a draft to check before going live, or publish everything.
  3. **Pre-flight check**: what will be created, updated and skipped (products, variations, categories, images, tags, attributes, custom fields), with warnings for different currencies or units, a destination that isn't empty, products without SKUs, duplicate SKUs, read-only connections and REST-only destinations.
  4. **Prepare and push**: stages everything in the new store as one undoable step, switches to it, and pushes with the usual confirmation and progress.
  5. **Check the result**: re-reads the new store and compares every product with a SKU (present, price, stock, name, main image), listing anything missing or different.
  - Images are downloaded by the app and uploaded to the new store, so a Local site on your computer can be migrated to a live host. Each migrated product records where it came from. Running it again is safe: products already there, or already staged by an earlier run, are skipped.
  - Not moved (yet): orders, customers, coupons, reviews, pages and posts, menus, theme and store settings; up-sells and cross-sells aren't linked.
- **Verified** against two real WooCommerce stores: 10,663 products, 69 variations, 54 categories and 38 images migrated into an empty store in under 3 minutes, with every product verified and a second run creating nothing.

## New in 0.3.1

- **Products in each category (Categories page).** Selecting a category shows its products with tick boxes: untick to take a product out of that category, tick to put it back, and *Add products…* to tick in products from anywhere in the store. Products that sit only in a sub-category are listed too (labelled “in Mugs”, for example), so you can see and fix products placed in a parent or a sub-category by mistake. A product's other categories are never touched, and *Ticking also ticks this category's parents* follows the same remembered setting as everywhere else.
- **Changes panel shows category names** instead of numbers for product categories and category parents.
- **Fixed:** a stray “0” in an empty category banner box.

## New in 0.3.0

- **Batch Builder** (sidebar → Batch Builder), the Product Batch Builder rebuilt inside CatalogForge:
  - **Blanks**: everything a collection shares, saved as you type. Make one from scratch, duplicate one, make one from **any product in your store** (prices, sizes, tags, descriptions and options are copied, prices in the text become `{price}`), import the old Store Manager CSV, or export/import all blanks as a file to use on another computer.
  - **Options → variable products**: add Size, Colour… with a price per option where it differs; every combination becomes a variation with its own SKU.
  - **Collections**: numbered (start, count, digits) or a list of names; category paths are picked from your store or typed (new levels are created); publish, draft or private; existing SKUs are left alone or updated.
  - **Continues numbering**: it finds products already in the store with the same SKU pattern and offers to continue from the next free number, and after adding a batch the next one starts where it ended.
  - **Images**: dropped or chosen from your PC, matched by the number in the file name or by file order, with featured + gallery slots per product. Click two images to swap them; place unmatched images by clicking. Shared gallery images (e.g. a size chart) go on every product and upload once.
  - **Checks** before anything is staged, including against the store: duplicate and existing SKUs, repeated titles, zero or invalid prices, price text that doesn't match the price (with a fix: use `{price}`), broken emojis, ChatGPT `data-start` markup (one-click removal), missing categories and new ones that will be created, products without a featured image, unused images.
  - **Add to store**: stages the whole batch (products, variations, categories, images) as one undoable step, then opens the grid on the new products. **Preview in your theme** shows the first product on your real site. **CSV** and **ZIP (CSV + renamed images)** export in the 56-column Store Manager / WP All Import layout remain for other workflows.
- **Push confirmation**: every way of pushing (the Push button, the Changes panel, ⌘S, the command palette) now asks *"Are you sure you want to push changes?"* with the store name, what will change and a warning for live stores. *No* leaves everything staged.

## New in 0.2.2

- **Formatted text in bulk edit.** Setting, prepending or appending a description in Bulk edit now uses the full rich-text editor (larger, with the toolbar) instead of a one-line box, so pasted formatting and line breaks are kept.
- **Pasting keeps your formatting.** Text pasted from Word, Google Docs or web pages keeps bullets and numbered lists, bold, italic, underline, links, text colour and text size, while fonts, Office markup and the document's base colour and size are dropped (so text still follows your theme). Word's typed bullets become real lists, and Google Docs bold (which it stores as styled spans) is recognised. WooCommerce stores the result unchanged (verified against a live store).
- **Colour and size in the editor.** The editor toolbar has a text colour menu and a size picker, in the product editor as well as bulk edit.

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

0. **Migration, next steps**: up-sells, cross-sells and brands (mapped by SKU), grouped products; customers and orders (with the connector on both stores); pages and menus.

1. **SSH tunnel and SFTP drivers**: direct MySQL over SSH, and SFTP media upload for hosts that block HTTP uploads.
2. **Scheduled supplier feeds**: saved import profiles run on a schedule from SFTP/HTTP/FTP, with a dry-run report before staging.
3. **AI copilot**: bulk SEO titles and descriptions, alt text from images, attribute extraction from supplier descriptions, and image-first product creation. All output is staged as diffs like any other edit.
4. **Cloud companion**: shared staging for teams with roles, presence, an audit log, plus always-on jobs such as cross-store inventory sync via webhooks.
5. **Translations**: WPML/Polylang awareness (edit and push translated fields).
6. **Orders**: bulk status updates and packing slips using HPOS tables. POS is out of scope until the catalog engine has shipped.
7. **Distribution**: auto-updater, code signing and notarization, and a WebDriver test of the packaged app on all three OSes.
