# Connector protocol (v1)

All routes live under `/wp-json/catalogforge/v1` (or `?rest_route=/catalogforge/v1/…` without pretty permalinks).

## Authentication

Every request carries:

| Header | Value |
|---|---|
| `X-CF-Key` | key id (`cf_…`) |
| `X-CF-Timestamp` | Unix seconds; must be within ±300 s of server time |
| `X-CF-Nonce` | 8–64 chars `[A-Za-z0-9_-]`, single use for 10 min |
| `X-CF-Signature` | hex `HMAC-SHA256(secret, canonical)` |

`canonical` is these lines joined with `\n`:
1. timestamp,
2. nonce,
3. upper-case HTTP method,
4. route (e.g. `/catalogforge/v1/catalog`),
5. query string sorted by key, with `rawurlencode`d keys and values, excluding `rest_route`,
6. `sha256(body bytes as sent)`,
7. `sha256(X-CF-Manifest header or "")`.

Keys are bound to a WordPress user with `manage_woocommerce`, and requests run as that user, so capabilities, kses rules and authorship behave as in wp-admin. Keys are created in *Tools → CatalogForge*, or automatically for Local sites. The connection string is `cf1.` + base64url(JSON `{v,url,rest,key,secret}`).

A body sent with `X-CF-Encoding: gzip` is gunzipped after the signature check. The signature covers the compressed bytes.

## Routes

| Route | Purpose |
|---|---|
| `GET /handshake` | Versions, currency and units, registered image sizes, big-image threshold, upload limit, HPOS status, active integrations (Yoast, Rank Math, WPML, ACF, Brands) |
| `GET /index` | `[[id, parent, is_variation, modified_gmt], …]` for delta sync and deletion detection |
| `GET /catalog?after_id=&limit=` | Keyset-paged products and variations (≤1000), plus referenced media. `ids=` fetches specific records; `meta_keys=` adds custom meta |
| `GET /taxonomy` | Categories (raw counts, image/banner, display type, order, SEO), tags, global attributes with terms, shipping and tax classes |
| `POST /batch` | Ordered upserts and deletes; see below |
| `POST /media` | Binary body: original plus pre-generated sizes, described by `X-CF-Manifest` (base64url JSON `{filename, mime, sha256, alt, title, parts:[{name, offset, length, width, height, mime}]}`). Deduplicated by SHA-256 |
| `POST /media/register` | Registers files already written into `uploads/` (Local and SFTP) |
| `POST /media/sideload` | Server downloads a URL (fallback) |
| `GET /media` | Paged media library |
| `POST /preview` | Returns a short-lived URL that renders the product in the store's theme with draft fields applied (works for unsaved products and in coming-soon mode) |

## Batch

```json
{
  "ops": [
    { "op": "upsert", "entity": "category", "ref": "c1", "data": { "name": "Outdoor", "parent": 0 } },
    { "op": "upsert", "entity": "product", "ref": "p1", "match": { "sku": "JKT-1" },
      "data": { "type": "variable", "name": "Storm Jacket", "category_ids": ["ref:c1"],
                "attributes": [{ "name": "Size", "taxonomy": "pa_size", "options": ["S", "M"], "variation": true }] } },
    { "op": "upsert", "entity": "variation", "data": { "parent_id": "ref:p1", "sku": "JKT-1-S",
                "regular_price": "99", "variation_attributes": { "pa_size": "S" } } },
    { "op": "upsert", "entity": "product", "id": 42, "data": { "regular_price": "19.99" }, "base": { "regular_price": "17.99" } },
    { "op": "upsert", "entity": "media", "id": 77, "data": { "alt": "Red jacket" } },
    { "op": "delete", "entity": "product", "id": 99 }
  ],
  "options": { "conflicts": "check", "transaction": true, "return_records": true }
}
```

- Operations are reordered: categories (parents first), tags, media, products, variations, then deletes (children first).
- `match.sku` makes creates idempotent.
- Missing global attributes and terms are created, with new terms keeping the given order.
- `base` enables conflict detection. A conflict is reported only when the stored value changed **and** differs from the incoming value.
- Each result is `{ref, entity, ok, action: created|updated|deleted|conflict|missing|error, id, error, conflicts[], record}`. `record` is the saved state after parent sync.
- Up to 2000 operations per request.

Product fields match `crates/forge-core/src/model.rs` (`Product`). `seo_title`, `seo_description` and `focus_keyword` map to Yoast and/or Rank Math (or to private meta when neither is active).
