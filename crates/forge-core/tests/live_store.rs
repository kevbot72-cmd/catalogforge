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
