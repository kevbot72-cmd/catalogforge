//! Integration tests against a real WordPress + WooCommerce store with the connector active.
//! Skipped unless CF_TEST_URL is set:
//!
//!   CF_TEST_URL=http://127.0.0.1:8088 CF_TEST_KEY=… CF_TEST_SECRET=… \
//!   CF_TEST_DB_HOST=127.0.0.1 CF_TEST_DB_PORT=3306 CF_TEST_DB_USER=wp CF_TEST_DB_PASS=wp CF_TEST_DB_NAME=wpstore \
//!   CF_TEST_WP_ROOT=/path/to/wordpress cargo test -p forge-core --test live_store -- --test-threads=1 --nocapture

use forge_core::cache::{Cache, Edit, ProductQuery};
use forge_core::drivers::connector::ConnectorDriver;
use forge_core::drivers::local::LocalDriver;
use forge_core::drivers::mysql::{MysqlDriver, MysqlTarget};
use forge_core::drivers::Driver;
use forge_core::media::MediaSettings;
use forge_core::model::*;
use forge_core::sync::{self, no_progress};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

fn connector() -> Option<ConnectorDriver> {
    Some(ConnectorDriver::for_local(&env("CF_TEST_URL")?, &env("CF_TEST_KEY")?, &env("CF_TEST_SECRET")?, None).unwrap())
}

fn mysql_target() -> MysqlTarget {
    MysqlTarget {
        host: env("CF_TEST_DB_HOST").unwrap_or("127.0.0.1".into()),
        port: env("CF_TEST_DB_PORT").and_then(|p| p.parse().ok()).unwrap_or(3306),
        socket: None,
        user: env("CF_TEST_DB_USER").unwrap_or("wp".into()),
        password: env("CF_TEST_DB_PASS").unwrap_or("wp".into()),
        database: env("CF_TEST_DB_NAME").unwrap_or("wpstore".into()),
        table_prefix: "wp_".into(),
    }
}

fn sfx() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}

fn obj(v: Value) -> serde_json::Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn test_image(path: &std::path::Path, seed: u32) {
    let b = seed.to_le_bytes();
    let mut img = image::RgbImage::new(1400, 1000);
    for (x, y, p) in img.enumerate_pixels_mut() {
        *p = image::Rgb([b[0].wrapping_add((x / 7) as u8), b[1].wrapping_add((y / 5) as u8), b[2] ^ b[3]]);
    }
    img.save(path).unwrap();
}

#[tokio::test]
async fn full_cycle_pull_stage_push_conflict_revert() {
    let Some(driver) = connector() else { return eprintln!("CF_TEST_URL not set; skipping") };
    let tmp = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmp.path().join("c.db")).unwrap());

    let r = sync::pull(&driver, &cache, true, no_progress()).await.unwrap();
    println!("initial pull: {r:?}");
    assert_eq!(r.mode, "full");

    // --- stage: new category tree, a variable product with variations and local images, a simple product
    let s = sfx();
    let img1 = tmp.path().join("front.png");
    let img2 = tmp.path().join("back.png");
    test_image(&img1, rand::random());
    test_image(&img2, rand::random());
    let keys = {
        let mut c = cache.lock().unwrap();
        let parent_cat = c.create(Entity::Category, obj(json!({ "name": format!("Outdoor {s}"), "image_id": { "file": img1.to_string_lossy() } }))).unwrap();
        let child_cat = c.create(Entity::Category, obj(json!({ "name": format!("Jackets {s}"), "parent": parent_cat }))).unwrap();
        let jacket = c
            .create(
                Entity::Product,
                obj(json!({
                    "name": format!("Storm Jacket {s}"), "type": "variable", "sku": format!("JKT-{s}"), "status": "publish",
                    "category_ids": [child_cat], "description": "<p>Waterproof</p>",
                    "image_id": { "file": img1.to_string_lossy() }, "gallery_ids": [{ "file": img2.to_string_lossy() }],
                    "attributes": [{ "name": format!("Size {s}"), "taxonomy": format!("pa_sz{s}"), "options": ["S", "M", "L"], "variation": true, "visible": true }]
                })),
            )
            .unwrap();
        let mut vars = vec![];
        for (size, price) in [("S", "99"), ("M", "109"), ("L", "119")] {
            vars.push(
                c.create(
                    Entity::Variation,
                    obj(json!({ "parent_id": jacket, "sku": format!("JKT-{s}-{size}"), "regular_price": price, "variation_attributes": { format!("pa_sz{s}"): size }, "manage_stock": true, "stock_quantity": 10 })),
                )
                .unwrap(),
            );
        }
        let simple = c.create(Entity::Product, obj(json!({ "name": format!("Beanie {s}"), "type": "simple", "sku": format!("BEA-{s}"), "regular_price": "15", "status": "publish", "category_ids": [parent_cat] }))).unwrap();
        (jacket, vars, simple)
    };
    let summary = cache.lock().unwrap().summary().unwrap();
    assert_eq!(summary.created, 7);

    let t = Instant::now();
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Initial import", no_progress()).await.unwrap();
    println!("push: {report:?} in {:?}", t.elapsed());
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.created, 7);
    assert_eq!(report.media_uploaded, 2, "the same file used twice is uploaded once: {report:?}");
    assert!(report.warnings.is_empty(), "uploaded images must be served by the store: {:?}", report.warnings);
    assert_eq!(cache.lock().unwrap().summary().unwrap().created, 0);

    // --- the cache now holds server records with real ids
    let jacket = {
        let c = cache.lock().unwrap();
        let p = c.product_by_sku(&format!("JKT-{s}")).unwrap().expect("jacket in cache");
        assert_eq!(p.kind, "variable");
        assert!(p.image_id > 0 && p.gallery_ids.len() == 1);
        assert_eq!(c.children(p.id).unwrap().len(), 3);
        let m = c.media(&[p.image_id]).unwrap();
        assert!(m[0].filename.ends_with(".webp"), "{:?}", m[0]);
        assert!(m[0].filename.starts_with(&format!("jkt-{s}")), "named by template: {}", m[0].filename);
        let cats = c.categories().unwrap();
        let outdoor = cats.iter().find(|x| x.name == format!("Outdoor {s}")).unwrap();
        assert!(outdoor.image_id > 0, "category image uploaded");
        let jackets = cats.iter().find(|x| x.name == format!("Jackets {s}")).unwrap();
        assert_eq!(jackets.parent, outdoor.id);
        assert_eq!(p.category_ids, vec![jackets.id]);
        p
    };
    let _ = keys;

    // --- server agrees (fresh read, bypassing the cache)
    let fresh = driver.catalog_by_ids(&[jacket.id]).await.unwrap();
    // WooCommerce returns a product's attribute options alphabetically; storefront dropdowns use
    // the term order the connector records for newly created terms.
    let mut opts = fresh.products[0].attributes[0].options.clone();
    opts.sort();
    assert_eq!(opts, vec!["L", "M", "S"]);

    // --- edit in the app while someone edits the same field in wp-admin → conflict
    let beanie = cache.lock().unwrap().product_by_sku(&format!("BEA-{s}")).unwrap().unwrap();
    driver
        .batch(&[Op { op: OpKind::Upsert, entity: Entity::Product, r#ref: None, id: Some(beanie.id), r#match: None, data: obj(json!({ "regular_price": "17" })), base: Default::default(), force: false }], false)
        .await
        .unwrap();
    cache.lock().unwrap().stage(&[Edit { entity: Entity::Product, key: beanie.id.to_string(), field: "regular_price".into(), value: Some(json!("16")) }, Edit { entity: Entity::Product, key: beanie.id.to_string(), field: "name".into(), value: Some(json!(format!("Wool Beanie {s}"))) }]).unwrap();
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Edit beanie", no_progress()).await.unwrap();
    assert_eq!(report.conflicts, 1, "{report:?}");
    let ch = cache.lock().unwrap().changes().unwrap();
    assert!(ch.iter().any(|c| c.field == "regular_price" && c.conflict.is_some()));
    // keep mine → push overwrites
    cache.lock().unwrap().resolve_conflict(Entity::Product, &beanie.id.to_string(), "regular_price", true).unwrap();
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Resolve", no_progress()).await.unwrap();
    assert_eq!((report.updated, report.conflicts), (1, 0), "{report:?}");
    let fresh = driver.catalog_by_ids(&[beanie.id]).await.unwrap();
    assert_eq!(fresh.products[0].regular_price, "16");
    assert_eq!(fresh.products[0].name, format!("Wool Beanie {s}"));

    // --- revert the last push from history
    let h = report.history_id.unwrap();
    cache.lock().unwrap().stage_revert(h).unwrap();
    sync::push(&driver, &cache, &MediaSettings::default(), "Revert", no_progress()).await.unwrap();
    let fresh = driver.catalog_by_ids(&[beanie.id]).await.unwrap();
    assert_eq!(fresh.products[0].regular_price, "17", "reverted to the value before that push");

    // --- delta pull picks up remote changes and deletions
    driver
        .batch(&[Op { op: OpKind::Delete, entity: Entity::Product, r#ref: None, id: Some(beanie.id), r#match: None, data: Default::default(), base: Default::default(), force: true }], false)
        .await
        .unwrap();
    let r = sync::pull(&driver, &cache, false, no_progress()).await.unwrap();
    assert_eq!(r.mode, "delta");
    assert!(r.removed >= 1);
    assert!(cache.lock().unwrap().product(beanie.id).unwrap().is_none());

    // --- query by category includes descendants
    let outdoor = cache.lock().unwrap().categories().unwrap().into_iter().find(|x| x.name == format!("Outdoor {s}")).unwrap();
    let q = cache.lock().unwrap().query(&ProductQuery { category_id: Some(outdoor.id), ..Default::default() }).unwrap();
    assert_eq!(q.keys, vec![jacket.id.to_string()]);

    // --- preview
    let url = driver.preview(Some(jacket.id), &json!({ "name": "Preview title" })).await.unwrap();
    let html = reqwest::get(&url).await.unwrap().text().await.unwrap();
    assert!(html.contains("Preview title"));
}

#[tokio::test]
async fn mysql_reader_matches_connector() {
    let Some(driver) = connector() else { return };
    let my = MysqlDriver::connect(&mysql_target(), None).await.unwrap();
    let a = driver.catalog_page(0, 1000).await.unwrap();
    let ids: Vec<i64> = a.products.iter().map(|p| p.id).collect();
    let b = my.catalog_by_ids(&ids).await.unwrap();
    assert_eq!(a.products.len(), b.products.len());
    let mut mismatches = vec![];
    for (x, y) in a.products.iter().zip(b.products.iter()) {
        let (mut vx, mut vy) = (serde_json::to_value(x).unwrap(), serde_json::to_value(y).unwrap());
        for v in [&mut vx, &mut vy] {
            v["permalink"] = Value::Null;
            // options order for taxonomy attributes may differ (term order vs. stored order)
            if let Some(attrs) = v["attributes"].as_array_mut() {
                for at in attrs {
                    if let Some(o) = at["options"].as_array_mut() {
                        o.sort_by_key(|x| x.to_string());
                    }
                }
            }
            if let Some(t) = v["tags"].as_array_mut() {
                t.sort_by_key(|x| x.to_string());
            }
        }
        for (k, val) in vx.as_object().unwrap() {
            if vy.get(k) != Some(val) {
                mismatches.push(format!("#{} {k}: connector={val} mysql={}", x.id, vy.get(k).unwrap_or(&Value::Null)));
            }
        }
    }
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.join("\n"));
    let ta = driver.taxonomy().await.unwrap();
    let tb = my.taxonomy().await.unwrap();
    let mut ca = ta.categories.clone();
    let mut cb = tb.categories.clone();
    ca.sort_by_key(|c| c.id);
    cb.sort_by_key(|c| c.id);
    assert_eq!(ca, cb);
    println!("MySQL reader matched {} products and {} categories", a.products.len(), ca.len());
}

#[tokio::test]
async fn local_adapter_provisions_and_writes_media_to_disk() {
    let (Some(url), Some(wp_root)) = (env("CF_TEST_URL"), env("CF_TEST_WP_ROOT")) else { return };
    // Build a fake Local data directory whose site points at the test WordPress install.
    let tmp = tempfile::tempdir().unwrap();
    let site_path = tmp.path().join("Local Sites/test-store");
    std::fs::create_dir_all(site_path.join("app")).unwrap();
    std::os::unix::fs::symlink(&wp_root, site_path.join("app/public")).unwrap();
    let t = mysql_target();
    let host_port = url.trim_start_matches("http://").to_string();
    let http_port: u16 = host_port.rsplit(':').next().unwrap().parse().unwrap();
    std::fs::write(
        tmp.path().join("sites.json"),
        json!({ "lcl1": {
            "id": "lcl1", "name": "Test Store", "domain": host_port, "path": site_path.to_string_lossy(),
            "mysql": { "database": t.database, "user": t.user, "password": t.password },
            "services": { "nginx": { "ports": { "HTTP": [http_port] } }, "mysql": { "version": "10.11", "ports": { "MYSQL": [t.port] } }, "php": { "version": "8.3" } }
        }})
        .to_string(),
    )
    .unwrap();
    let site = forge_core::local::find_site(tmp.path(), "lcl1").unwrap();
    assert_eq!(site.status, forge_core::local::SiteStatus::Running);
    assert!(site.has_woocommerce && site.connector_installed);

    // Deactivate the plugin and forget keys so the adapter has to provision from scratch.
    let my = MysqlDriver::connect(&t, None).await.unwrap();
    let raw = my.option("active_plugins").await.unwrap().unwrap();
    let mut list = forge_core::phpser::parse_string_list(&raw).unwrap();
    list.retain(|p| !p.starts_with("catalogforge-connector/"));
    my.set_option("active_plugins", &forge_core::phpser::serialize_string_list(&list), true).await.unwrap();

    let (driver, key) = LocalDriver::open(site.clone(), None, None).await.unwrap();
    assert!(key.key.starts_with("cf_local_"));
    let raw = my.option("active_plugins").await.unwrap().unwrap();
    assert!(raw.contains("catalogforge-connector/catalogforge-connector.php"), "plugin re-activated");
    let hs = driver.handshake().await.expect("signed request with auto-provisioned key");
    assert!(hs.wc_version.is_some());

    // Reopening with the saved key reuses it.
    let (_, key2) = LocalDriver::open(site.clone(), None, Some(key.clone())).await.unwrap();
    assert_eq!(key2.key, key.key);

    // Media goes straight to disk and is only registered over HTTP.
    let img = tmp.path().join("local.png");
    test_image(&img, rand::random());
    let prepared = forge_core::media::prepare_file(&img, &format!("local-{}", sfx()), &hs.image_sizes, &MediaSettings::default()).unwrap();
    let up = driver.upload_media(&prepared, &Default::default()).await.unwrap();
    assert!(!up.deduplicated);
    let rel = up.media.url.split("/wp-content/uploads/").nth(1).unwrap().to_string();
    assert!(std::path::Path::new(&wp_root).join("wp-content/uploads").join(&rel).exists());
    // The stored path must be relative to uploads: WordPress builds every image URL from it, and an
    // absolute disk path (the Windows bug) yields a grey, unloadable image.
    let attached: String = sqlx::query_scalar("SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_wp_attached_file'")
        .bind(up.media.id)
        .fetch_one(my.pool())
        .await
        .unwrap();
    assert_eq!(attached, rel, "stored path must be uploads-relative");
    let via_db = my.media_for(&[up.media.id]).await.unwrap();
    assert_eq!(via_db[0].url, up.media.url);
    assert_eq!(via_db[0].thumb_url, up.media.thumb_url);
    let again = driver.upload_media(&prepared, &Default::default()).await.unwrap();
    assert!(again.deduplicated);
    assert_eq!(again.media.id, up.media.id);

    // Reads come from MySQL.
    let tmpc = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmpc.path().join("c.db")).unwrap());
    let r = sync::pull(&driver, &cache, true, no_progress()).await.unwrap();
    assert!(r.products > 0);
}

#[tokio::test]
async fn throughput_bulk_create_and_pull() {
    let Some(driver) = connector() else { return };
    let n: usize = env("CF_TEST_BULK").and_then(|s| s.parse().ok()).unwrap_or(1000);
    let tmp = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmp.path().join("c.db")).unwrap());
    sync::pull(&driver, &cache, true, no_progress()).await.unwrap();
    let s = sfx();
    {
        let mut c = cache.lock().unwrap();
        let items = (0..n)
            .map(|i| (Entity::Product, None, obj(json!({ "name": format!("Bulk {s} #{i}"), "type": "simple", "sku": format!("BULK-{s}-{i}"), "regular_price": format!("{}.99", 5 + i % 50), "status": "publish", "manage_stock": true, "stock_quantity": i % 20 }))))
            .collect();
        c.create_many(items).unwrap();
    }
    let t = Instant::now();
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Bulk", no_progress()).await.unwrap();
    let push_s = t.elapsed().as_secs_f64();
    assert_eq!(report.created, n, "{:?}", report.errors.first());
    let t = Instant::now();
    let tmpc = tempfile::tempdir().unwrap();
    let fresh = Mutex::new(Cache::open(&tmpc.path().join("c.db")).unwrap());
    let pr = sync::pull(&driver, &fresh, true, no_progress()).await.unwrap();
    let pull_s = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let my = Arc::new(MysqlDriver::connect(&mysql_target(), None).await.unwrap());
    let tmpm = tempfile::tempdir().unwrap();
    let fresh2 = Mutex::new(Cache::open(&tmpm.path().join("c.db")).unwrap());
    let mr = sync::pull(my.as_ref(), &fresh2, true, no_progress()).await.unwrap();
    let mysql_s = t.elapsed().as_secs_f64();
    println!(
        "BENCH created {n} products in {push_s:.1}s ({:.0}/s); connector pull {} products in {pull_s:.1}s ({:.0}/s); MySQL pull {} in {mysql_s:.2}s ({:.0}/s)",
        n as f64 / push_s,
        pr.products,
        pr.products as f64 / pull_s,
        mr.products,
        mr.products as f64 / mysql_s
    );
}

#[tokio::test]
async fn custom_fields_discover_edit_push_and_conflict() {
    let Some(driver) = connector() else { return eprintln!("CF_TEST_URL not set; skipping") };
    let s = sfx();
    let (brand, qty) = (format!("cf_brand_{s}"), format!("cf_pack_qty_{s}"));
    let tmp = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmp.path().join("c.db")).unwrap());

    // A product carrying two plugin fields, created through the app itself.
    let key = cache
        .lock()
        .unwrap()
        .create(Entity::Product, obj(json!({ "name": format!("Meta Mug {s}"), "type": "simple", "sku": format!("META-{s}"), "status": "publish", format!("meta:{brand}"): "Acme", format!("meta:{qty}"): 6 })))
        .unwrap();
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Custom fields", no_progress()).await.unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let id = cache.lock().unwrap().query(&ProductQuery { search: format!("META-{s}"), ..Default::default() }).unwrap().keys[0].parse::<i64>().unwrap();
    assert_ne!(key, id.to_string());

    // Discovery: both the connector and the direct database reader find the fields.
    let found = driver.meta_keys().await.unwrap();
    let b = found.iter().find(|m| m.key == brand).expect("brand discovered");
    assert_eq!((b.sample.as_str(), b.kind.as_str()), ("Acme", "text"));
    assert_eq!(found.iter().find(|m| m.key == qty).unwrap().kind, "number");
    assert!(!found.iter().any(|m| m.key == "_sku" || m.key == "_price"), "built-in keys are hidden");
    let reader = MysqlDriver::connect(&mysql_target(), None).await.unwrap();
    assert!(reader.meta_keys().await.unwrap().iter().any(|m| m.key == brand));

    // Reading: with the keys selected, products carry them as meta:<key> fields.
    for d in [&driver as &dyn Driver, &reader] {
        d.set_meta_keys(vec![brand.clone(), qty.clone()]);
    }
    sync::pull(&driver, &cache, true, no_progress()).await.unwrap();
    let row = cache.lock().unwrap().rows(&[id.to_string()]).unwrap().remove(0);
    assert_eq!(row.product[format!("meta:{brand}")], "Acme");
    assert_eq!(row.product[format!("meta:{qty}")], "6");
    let from_db = reader.catalog_by_ids(&[id]).await.unwrap().products.remove(0);
    assert_eq!(from_db.meta.get(&brand), Some(&json!("Acme")), "MySQL reader matches the connector");

    // Editing and pushing a custom field.
    cache.lock().unwrap().stage(&[Edit { entity: Entity::Product, key: id.to_string(), field: format!("meta:{brand}"), value: Some(json!("Zenith")) }]).unwrap();
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Brand", no_progress()).await.unwrap();
    assert_eq!((report.updated, report.conflicts), (1, 0), "{report:?}");
    assert_eq!(reader.catalog_by_ids(&[id]).await.unwrap().products[0].meta.get(&brand), Some(&json!("Zenith")));

    // Conflict: someone else changes the field after our pull.
    let other = Mutex::new(Cache::open(&tmp.path().join("other.db")).unwrap());
    sync::pull(&driver, &other, true, no_progress()).await.unwrap();
    cache.lock().unwrap().stage(&[Edit { entity: Entity::Product, key: id.to_string(), field: format!("meta:{brand}"), value: Some(json!("Mine")) }]).unwrap();
    other.lock().unwrap().stage(&[Edit { entity: Entity::Product, key: id.to_string(), field: format!("meta:{brand}"), value: Some(json!("Theirs")) }]).unwrap();
    sync::push(&driver, &other, &MediaSettings::default(), "Theirs", no_progress()).await.unwrap();
    assert_eq!(cache.lock().unwrap().changes().unwrap()[0].base, json!("Zenith"), "the pushed value is the new base");
    let report = sync::push(&driver, &cache, &MediaSettings::default(), "Mine", no_progress()).await.unwrap();
    assert_eq!(report.conflicts, 1, "{report:?}");
    assert_eq!(reader.catalog_by_ids(&[id]).await.unwrap().products[0].meta.get(&brand), Some(&json!("Theirs")));
}

#[tokio::test]
async fn media_delete_removes_attachment_and_cache_entry() {
    let Some(driver) = connector() else { return eprintln!("CF_TEST_URL not set; skipping") };
    let tmp = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmp.path().join("c.db")).unwrap());
    let img = tmp.path().join("doomed.png");
    test_image(&img, rand::random());
    let s = sfx();
    cache.lock().unwrap().create(Entity::Product, obj(json!({ "name": format!("Doomed {s}"), "type": "simple", "sku": format!("DOOM-{s}"), "image_id": { "file": img.to_string_lossy() } }))).unwrap();
    let r = sync::push(&driver, &cache, &MediaSettings::default(), "With image", no_progress()).await.unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let key = cache.lock().unwrap().query(&ProductQuery { search: format!("DOOM-{s}"), ..Default::default() }).unwrap().keys[0].clone();
    let media_id = cache.lock().unwrap().rows(&[key.clone()]).unwrap()[0].product["image_id"].as_i64().unwrap();
    assert!(media_id > 0);

    // What the Media page stages: take the image off the product, then delete it.
    cache
        .lock()
        .unwrap()
        .stage(&[
            Edit { entity: Entity::Product, key: key.clone(), field: "image_id".into(), value: Some(json!(0)) },
            Edit { entity: Entity::Media, key: media_id.to_string(), field: "__delete".into(), value: Some(json!(true)) },
        ])
        .unwrap();
    assert!(!cache.lock().unwrap().all_media().unwrap().iter().any(|m| m.id == media_id), "hidden while staged");
    let r = sync::push(&driver, &cache, &MediaSettings::default(), "Delete image", no_progress()).await.unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.deleted, 1);
    assert!(cache.lock().unwrap().media(&[media_id]).unwrap().is_empty(), "removed from the cache");
    let server = MysqlDriver::connect(&mysql_target(), None).await.unwrap();
    assert!(server.media_for(&[media_id]).await.unwrap().is_empty(), "attachment deleted on the store");
    assert_eq!(server.catalog_by_ids(&[key.parse().unwrap()]).await.unwrap().products[0].image_id, 0);
}

#[tokio::test]
async fn formatted_descriptions_survive_a_push() {
    let Some(driver) = connector() else { return eprintln!("CF_TEST_URL not set; skipping") };
    let tmp = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmp.path().join("c.db")).unwrap());
    let s = sfx();
    let html = r#"<p><strong>Warm</strong> and <span style="color: #dc2626">limited</span>, <span style="font-size: 20px">big</span> <em>news</em>.</p><ul><li>Wool</li><li><u>Zip</u></li></ul>"#;
    cache.lock().unwrap().create(Entity::Product, obj(json!({ "name": format!("Rich {s}"), "type": "simple", "sku": format!("RICH-{s}"), "short_description": html }))).unwrap();
    let r = sync::push(&driver, &cache, &MediaSettings::default(), "Rich text", no_progress()).await.unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let id: i64 = cache.lock().unwrap().query(&ProductQuery { search: format!("RICH-{s}"), ..Default::default() }).unwrap().keys[0].parse().unwrap();
    let stored = MysqlDriver::connect(&mysql_target(), None).await.unwrap().catalog_by_ids(&[id]).await.unwrap().products.remove(0).short_description;
    assert_eq!(stored, html, "WooCommerce keeps bullets, bold, colour and size");
}

/// The edit panel's extra fields: linked products, brands, purchase note, one-per-order, reviews.
#[tokio::test]
async fn linked_products_brands_and_advanced_fields_round_trip() {
    let Some(driver) = connector() else { return eprintln!("CF_TEST_URL not set; skipping") };
    let Some(root) = env("CF_TEST_WP_ROOT") else { return };
    let s = sfx();
    // A brand to tick (WooCommerce 9.6+ ships Brands).
    let out = std::process::Command::new("php")
        .current_dir(&root)
        .args(["-r", &format!("require 'wp-load.php'; $t = wp_insert_term('Brand {s}', 'product_brand'); echo is_wp_error($t) ? 0 : $t['term_id'];")])
        .output()
        .unwrap();
    let brand: i64 = String::from_utf8_lossy(&out.stdout).trim().rsplit('\n').next().unwrap_or("0").parse().unwrap_or(0);
    assert!(brand > 0, "brand created: {}", String::from_utf8_lossy(&out.stderr));

    let tmp = tempfile::tempdir().unwrap();
    let cache = Mutex::new(Cache::open(&tmp.path().join("c.db")).unwrap());
    for n in ["A", "B", "C"] {
        cache.lock().unwrap().create(Entity::Product, obj(json!({ "name": format!("Link {n} {s}"), "type": "simple", "sku": format!("LNK-{n}-{s}"), "regular_price": "10" }))).unwrap();
    }
    let r = sync::push(&driver, &cache, &MediaSettings::default(), "Linked setup", no_progress()).await.unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let id = |n: &str| -> i64 { cache.lock().unwrap().query(&ProductQuery { search: format!("LNK-{n}-{s}"), ..Default::default() }).unwrap().keys[0].parse().unwrap() };
    let (a, b, c) = (id("A"), id("B"), id("C"));
    let key = a.to_string();
    let edit = |field: &str, value: Value| Edit { entity: Entity::Product, key: key.clone(), field: field.into(), value: Some(value) };
    cache
        .lock()
        .unwrap()
        .stage(&[
            edit("upsell_ids", json!([b, c])),
            edit("cross_sell_ids", json!([c])),
            edit("brand_ids", json!([brand])),
            edit("purchase_note", json!("Thanks for buying!")),
            edit("sold_individually", json!(true)),
            edit("reviews_allowed", json!(false)),
        ])
        .unwrap();
    let r = sync::push(&driver, &cache, &MediaSettings::default(), "Linked fields", no_progress()).await.unwrap();
    assert!(r.errors.is_empty() && r.conflicts == 0, "{:?}", r.errors);

    let via_connector = driver.catalog_by_ids(&[a]).await.unwrap().products.remove(0);
    let via_mysql = MysqlDriver::connect(&mysql_target(), None).await.unwrap().catalog_by_ids(&[a]).await.unwrap().products.remove(0);
    for p in [&via_connector, &via_mysql] {
        assert_eq!(p.upsell_ids, vec![b, c]);
        assert_eq!(p.cross_sell_ids, vec![c]);
        assert_eq!(p.brand_ids, vec![brand]);
        assert_eq!(p.purchase_note, "Thanks for buying!");
        assert!(p.sold_individually);
        assert!(!p.reviews_allowed);
    }
    let tax = driver.taxonomy().await.unwrap();
    assert!(tax.brands.iter().any(|t| t.id == brand), "brand listed in taxonomy");
}

/// Migrates the whole test catalogue into a second, empty store (CF_TEST2_*), then verifies it and
/// checks that running it again creates nothing.
#[tokio::test]
async fn migrate_whole_store_into_empty_store() {
    let (Some(src), Some(url2), Some(key2), Some(secret2)) = (connector(), env("CF_TEST2_URL"), env("CF_TEST2_KEY"), env("CF_TEST2_SECRET")) else {
        return eprintln!("CF_TEST2_URL not set; skipping");
    };
    use forge_core::migrate::{self, MigrateOptions};
    let dst = ConnectorDriver::for_local(&url2, &key2, &secret2, None).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let a = Mutex::new(Cache::open(&tmp.path().join("a.db")).unwrap());
    let b = Mutex::new(Cache::open(&tmp.path().join("b.db")).unwrap());
    sync::pull(&src, &a, true, no_progress()).await.unwrap();
    sync::pull(&dst, &b, true, no_progress()).await.unwrap();

    let opts = MigrateOptions { include_images: true, include_drafts: true, include_custom_fields: true, include_empty_categories: true, ..Default::default() };
    let t = Instant::now();
    let s = migrate::stage(&a.lock().unwrap(), "src", &mut b.lock().unwrap(), &opts).unwrap();
    println!("plan in {:?}: {s:?}", t.elapsed());
    assert!(s.products_create > 100, "{s:?}");
    assert!(s.warnings.iter().any(|w| w.contains("currencies")), "currency difference noticed: {:?}", s.warnings);

    let t = Instant::now();
    let r = sync::push(&dst, &b, &MediaSettings::default(), "Migration", no_progress()).await.unwrap();
    println!("push in {:?}: created {} updated {} failed {} media {} errors {:?}", t.elapsed(), r.created, r.updated, r.failed, r.media_uploaded, r.errors.iter().take(5).collect::<Vec<_>>());
    // Duplicate source SKUs (left by other tests) can only save once.
    assert!(r.failed <= s.duplicate_skus.len() * 2, "unexpected failures: {:?}", r.errors.iter().take(10).collect::<Vec<_>>());

    sync::pull(&dst, &b, true, no_progress()).await.unwrap();
    let v = migrate::verify(&a.lock().unwrap(), &b.lock().unwrap(), &opts).unwrap();
    println!("verify: checked {} matched {} missing {} differences {} images missing {}", v.checked, v.matched, v.missing.len(), v.differences.len(), v.images_missing);
    assert!(v.missing.len() <= s.duplicate_skus.len(), "missing: {:?}", v.missing.iter().take(10).collect::<Vec<_>>());
    assert_eq!(v.images_missing, 0);
    let dst_cats = b.lock().unwrap().categories().unwrap().len();
    assert!(dst_cats >= a.lock().unwrap().categories().unwrap().len() - 1, "categories copied");

    // Running it again (skip existing) stages nothing new for products with SKUs.
    let (again, _) = migrate::plan(&a.lock().unwrap(), "src", &b.lock().unwrap(), &opts).unwrap();
    assert_eq!(again.products_create, again.no_sku, "{again:?}");
    assert_eq!(again.categories_create, 0);
}
