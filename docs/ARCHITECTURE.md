# Architecture

```
┌──────────────────────────── Desktop app (Tauri v2) ─────────────────────────────┐
│ React UI: canvas grid · drawer + WYSIWYG + live preview · import · bulk edit ·    │
│ categories · media · history · ⌘K                                                │
│        │ invoke() / events                                                       │
│ Rust command layer (apps/desktop/src-tauri) ── OS keychain for secrets           │
│        │                                                                         │
│ forge-core ─┬─ Cache (SQLite per store): server state + staged diffs + undo log  │
│             │                          + push history + identity map            │
│             ├─ Sync: pull (full / delta), push (media → ordered batches),        │
│             │        conflict handling, cross-store clone                       │
│             ├─ Media: decode → resize → WebP → all WP sub-sizes → SHA-256        │
│             └─ Drivers (one trait, four implementations)                         │
└──────┬──────────────┬─────────────────┬────────────────────────┬────────────────┘
       │              │                 │                        │
  Connector HTTP   WooCommerce REST   MySQL (TCP/socket)    Local adapter
  (HMAC-signed)    (consumer keys)    reads; writes via     = MySQL reads + connector
       │              │               connector             writes + direct-to-disk media
       ▼              ▼                 ▼                        ▼
  ┌──────────────────── WordPress + WooCommerce ───────────────────────────────────┐
  │ CatalogForge Connector plugin: bulk CRUD writer · media ingest · preview ·     │
  │ catalog/index/taxonomy export                                                  │
  └────────────────────────────────────────────────────────────────────────────────┘
```

## Design decisions

**Desktop first.** A cloud service cannot reach a Local site on your laptop or write into its uploads folder, so the engine runs locally. Team sync and always-on jobs belong in an optional cloud companion (see the roadmap).

**Writes always go through WooCommerce CRUD.** Raw SQL inserts skip WooCommerce's lookup tables, transients, term counts and SEO/translation plugin hooks, and quietly corrupt stores. The connector instead calls `WC_Product::save()` but removes the per-product overhead:
- term recounts are deferred and run once per batch,
- transients are held in memory and purged in bulk at the end,
- WooCommerce's SKU lock is skipped (the writer checks SKU uniqueness itself),
- variable parents are synced once per batch.

Each operation runs in **its own transaction**. A deadlock or lock timeout (detected via WordPress's SQL error log) is retried from scratch, and a failed operation is rolled back, so a product is never left half-written and a batch never reports success for rolled-back work.

**Reads can bypass WordPress.** The MySQL reader produces byte-identical records to the plugin (tested on 1,000 products) and is about 8× faster. It is used for Local sites and for direct-database stores.

**Staging is the source of truth for the UI.** The grid shows `server record ⊕ staged overlay`. Each staged field stores the **base** value it was edited from. On push the server compares base with its current value and reports a conflict instead of overwriting a change someone made in wp-admin. New records use `new:<uuid>` keys. References between them (a variation's parent, a product's new category) are sent as `ref:new:<uuid>` and resolved on the server within a batch, or client-side across batches.

**Push order.** Media first (prepared in parallel, uploaded concurrently, deduplicated by SHA-256), then categories (parents before children), tags/media metadata, products, variations, then deletes (children first). Batches inside a phase run concurrently; a batch is 250 operations (500 for Local).

**Images never hit server CPU.** WordPress's `image_resize_dimensions()` / `wp_constrain_dimensions()` geometry is ported to Rust (unit-tested against WordPress's results). The app uploads the original plus every registered size as one binary body, and the plugin only writes files and attachment metadata. Over REST, where uploads aren't possible, images go by URL.

**Local (Flywheel) adapter.** It reads `sites.json` and `site-statuses.json` from Local's data folder, connects to each site's MySQL via socket or dynamic port, copies the bundled plugin into the site, activates it by editing `active_plugins` (a PHP-serialized array; the app includes a small serializer), and writes a key bound to the first administrator. Requests go to the site's own web server with a `Host:` header, so they work even when hosts-file routing is missing. Stopped sites can be started through Local's GraphQL API.

## Data the app keeps

Per store, `<app data>/stores/<id>/catalog.db` (SQLite, WAL) holds:
- `products`, `categories`, `media`, `tags` and `attributes`: last known server state,
- `staged`: entity, key, field, value, base and conflict for each edit,
- `undo_log`: grouped by transaction,
- `history` / `history_items`: before and after values for every pushed field,
- `identity`: cross-store mapping.

Profiles live in `stores.json`; secrets live in the OS keychain, falling back to a `0600` file where no keychain service exists.
