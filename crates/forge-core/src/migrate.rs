//! Store migration: copies a whole catalogue (categories with their images and descriptions,
//! products, variations, tags, global attributes, images, SEO and custom fields) from one store
//! into another, usually a new, empty one.
//!
//! Like everything else in CatalogForge, a migration is *staged* in the destination store as one
//! undoable step, so it can be reviewed before it is pushed. Images are referenced by their source
//! URL; on push the app downloads them itself and uploads them to the destination, which works even
//! when the source is a Local site on this computer that the new host could never reach.

use crate::cache::{Cache, Edit, NEW_FIELD, NEW_PREFIX};
use crate::custom_fields::META_PREFIX;
use crate::model::*;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExistingMode {
    /// Leave products whose SKU is already in the destination alone (safe to re-run).
    #[default]
    Skip,
    /// Overwrite them with the source values.
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MigrateOptions {
    pub existing: ExistingMode,
    /// Force a status on every migrated product (e.g. "draft" to check the new store first).
    pub status: Option<String>,
    pub include_images: bool,
    pub include_drafts: bool,
    pub include_custom_fields: bool,
    /// Also create categories that have no products.
    pub include_empty_categories: bool,
    /// Limit to these source categories (and their sub-categories); empty = everything.
    pub category_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MigrationSummary {
    pub categories_create: usize,
    pub categories_existing: usize,
    pub products_create: usize,
    pub products_update: usize,
    pub products_skip: usize,
    pub variations: usize,
    pub images: usize,
    pub tags: usize,
    pub attributes: Vec<String>,
    pub custom_fields: Vec<String>,
    pub no_sku: usize,
    pub duplicate_skus: Vec<String>,
    pub source_products: usize,
    pub target_products: usize,
    /// Already staged in the destination by an earlier run that hasn't been pushed yet.
    pub already_staged: usize,
    pub already_staged_categories: usize,
    /// Plain-language notes and risks (currency, units, non-empty target…).
    pub warnings: Vec<String>,
}

const PRODUCT_FIELDS: &[&str] = &[
    "name", "slug", "status", "sku", "global_unique_id", "regular_price", "sale_price", "date_on_sale_from", "date_on_sale_to", "manage_stock", "stock_quantity",
    "stock_status", "backorders", "weight", "length", "width", "height", "shipping_class", "tax_status", "tax_class", "description", "short_description", "menu_order",
    "featured", "catalog_visibility", "virtual", "downloadable", "tags", "attributes", "variation_attributes", "external_url", "button_text", "seo_title",
    "seo_description", "focus_keyword",
];

fn empty(v: &Value) -> bool {
    v.is_null() || v.as_str() == Some("") || v.as_array().map(|a| a.is_empty()).unwrap_or(false) || v.as_object().map(|o| o.is_empty()).unwrap_or(false)
}

fn path_of(cats: &HashMap<i64, Category>, id: i64) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = cats.get(&id);
    let mut guard = 0;
    while let Some(c) = cur {
        out.push(c.name.trim().to_lowercase());
        cur = cats.get(&c.parent);
        guard += 1;
        if guard > 50 {
            break;
        }
    }
    out.reverse();
    out
}

fn handshake(c: &Cache) -> Handshake {
    c.kv_get("handshake").ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Works out the migration and returns the summary plus the edits that stage it.
pub fn plan(src: &Cache, src_store: &str, dst: &Cache, opts: &MigrateOptions) -> Result<(MigrationSummary, Vec<Edit>)> {
    let mut s = MigrationSummary::default();
    let src_cats: HashMap<i64, Category> = src.categories()?.into_iter().map(|c| (c.id, c)).collect();
    let dst_cats: HashMap<i64, Category> = dst.categories()?.into_iter().map(|c| (c.id, c)).collect();
    let dst_by_path: HashMap<Vec<String>, i64> = dst_cats.keys().map(|id| (path_of(&dst_cats, *id), *id)).collect();
    let src_media: HashMap<i64, Media> = src.all_media()?.into_iter().map(|m| (m.id, m)).collect();
    let all = src.all_products()?;
    s.target_products = dst.product_count()?;
    // SKUs and category paths already staged in the destination (an earlier, unpushed run).
    let staged = dst.staged_map()?;
    let staged_skus: HashSet<String> = staged
        .iter()
        .filter(|((e, k), _)| matches!(e, Entity::Product | Entity::Variation) && k.starts_with(NEW_PREFIX))
        .filter_map(|(_, f)| f.get("sku").and_then(|v| v.0.as_str()).map(String::from))
        .filter(|s| !s.is_empty())
        .collect();
    // (name, parent) → staging key of categories an earlier run created.
    let staged_cats: HashMap<(String, String), String> = staged
        .iter()
        .filter(|((e, k), _)| *e == Entity::Category && k.starts_with(NEW_PREFIX))
        .filter_map(|((_, k), f)| {
            let name = f.get("name").and_then(|v| v.0.as_str())?.trim().to_lowercase();
            let parent = f.get("parent").map(|v| v.0.to_string()).unwrap_or_else(|| "0".into());
            Some(((name, parent), k.clone()))
        })
        .collect();

    // Which source categories are in scope.
    let in_scope: Option<HashSet<i64>> = (!opts.category_ids.is_empty()).then(|| {
        let mut set: HashSet<i64> = opts.category_ids.iter().copied().collect();
        loop {
            let before = set.len();
            for c in src_cats.values() {
                if set.contains(&c.parent) {
                    set.insert(c.id);
                }
            }
            if set.len() == before {
                break;
            }
        }
        set
    });
    let cat_ok = |id: i64| in_scope.as_ref().map(|s| s.contains(&id)).unwrap_or(true);

    // Products (parents) to migrate.
    let parents: Vec<&Product> = all
        .iter()
        .filter(|p| p.kind != "variation")
        .filter(|p| opts.include_drafts || p.status == "publish")
        .filter(|p| in_scope.is_none() || p.category_ids.iter().any(|c| cat_ok(*c)))
        .collect();
    s.source_products = parents.len();
    let children: HashMap<i64, Vec<&Product>> = all.iter().filter(|p| p.kind == "variation").fold(HashMap::new(), |mut m, v| {
        m.entry(v.parent_id).or_default().push(v);
        m
    });

    let mut edits: Vec<Edit> = Vec::new();
    let create = |entity: Entity, fields: Map<String, Value>, edits: &mut Vec<Edit>| -> String {
        let key = format!("{NEW_PREFIX}{}", uuid::Uuid::new_v4().simple());
        edits.push(Edit { entity, key: key.clone(), field: NEW_FIELD.into(), value: Some(json!(true)) });
        for (f, v) in fields {
            edits.push(Edit { entity, key: key.clone(), field: f, value: Some(v) });
        }
        key
    };
    let image = |id: i64| -> Option<Value> {
        if !opts.include_images || id <= 0 {
            return None;
        }
        src_media.get(&id).filter(|m| !m.url.is_empty()).map(|m| json!({ "url": m.url, "alt": m.alt }))
    };
    let mut images: BTreeSet<String> = BTreeSet::new();
    let mut count_image = |v: &Option<Value>| {
        if let Some(u) = v.as_ref().and_then(|v| v["url"].as_str()) {
            images.insert(u.to_string());
        }
    };

    /* ----------------------------------------------------------- categories */
    let used: HashSet<i64> = parents.iter().flat_map(|p| p.category_ids.iter().copied()).collect();
    let mut wanted: Vec<i64> = src_cats.keys().copied().filter(|id| cat_ok(*id) && (opts.include_empty_categories || used.contains(id))).collect();
    // Ancestors of every wanted category come along, so paths stay intact.
    let mut i = 0;
    while i < wanted.len() {
        if let Some(c) = src_cats.get(&wanted[i]) {
            if c.parent > 0 && src_cats.contains_key(&c.parent) && !wanted.contains(&c.parent) {
                wanted.push(c.parent);
            }
        }
        i += 1;
    }
    // Parents first.
    wanted.sort_by_key(|id| (path_of(&src_cats, *id).len(), src_cats.get(id).map(|c| c.menu_order).unwrap_or(0)));
    let mut cat_map: HashMap<i64, Value> = HashMap::new();
    for id in wanted {
        let c = &src_cats[&id];
        let path = path_of(&src_cats, id);
        if let Some(existing) = dst_by_path.get(&path) {
            s.categories_existing += 1;
            cat_map.insert(id, json!(existing));
            continue;
        }
        let parent = if c.parent > 0 { cat_map.get(&c.parent).cloned().unwrap_or(json!(0)) } else { json!(0) };
        if let Some(key) = staged_cats.get(&(c.name.trim().to_lowercase(), parent.to_string())) {
            // Created by an earlier, unpushed run: reuse it instead of staging it twice.
            s.already_staged_categories += 1;
            cat_map.insert(id, json!(key));
            continue;
        }
        let mut f = Map::new();
        f.insert("name".into(), json!(c.name));
        f.insert("parent".into(), parent);
        for (k, v) in [("slug", json!(c.slug)), ("description", json!(c.description)), ("display_type", json!(c.display_type)), ("menu_order", json!(c.menu_order)), ("seo_title", json!(c.seo_title)), ("seo_description", json!(c.seo_description))] {
            if !empty(&v) {
                f.insert(k.into(), v);
            }
        }
        for (k, mid) in [("image_id", c.image_id), ("banner_id", c.banner_id)] {
            let img = image(mid);
            count_image(&img);
            if let Some(img) = img {
                f.insert(k.into(), img);
            }
        }
        s.categories_create += 1;
        let key = create(Entity::Category, f, &mut edits);
        cat_map.insert(id, json!(key));
    }

    /* ------------------------------------------------------------- products */
    let mut skus: HashMap<String, usize> = HashMap::new();
    let mut tags: BTreeSet<String> = BTreeSet::new();
    let mut attrs: BTreeSet<String> = BTreeSet::new();
    let mut custom: BTreeSet<String> = BTreeSet::new();
    let fields_of = |p: &Product, custom: &mut BTreeSet<String>| -> Result<Map<String, Value>> {
        let v = serde_json::to_value(p)?;
        let mut f = Map::new();
        for k in PRODUCT_FIELDS {
            if let Some(x) = v.get(*k).filter(|x| !empty(x)) {
                f.insert((*k).to_string(), x.clone());
            }
        }
        if opts.include_custom_fields {
            for (k, val) in &p.meta {
                if !empty(val) {
                    custom.insert(k.clone());
                    f.insert(format!("{META_PREFIX}{k}"), val.clone());
                }
            }
        }
        f.insert(format!("{META_PREFIX}_cf_source"), json!(format!("{src_store}:{}", p.id)));
        Ok(f)
    };
    for p in &parents {
        if !p.sku.is_empty() {
            *skus.entry(p.sku.clone()).or_default() += 1;
        } else {
            s.no_sku += 1;
        }
        tags.extend(p.tags.iter().cloned());
        attrs.extend(p.attributes.iter().map(|a| a.name.clone()));
        if !p.sku.is_empty() && staged_skus.contains(&p.sku) {
            s.already_staged += 1;
            continue;
        }
        let existing = dst.product_by_sku(&p.sku)?;
        if existing.is_some() && opts.existing == ExistingMode::Skip {
            s.products_skip += 1;
            continue;
        }
        let mut f = fields_of(p, &mut custom)?;
        f.insert("type".into(), json!(p.kind));
        if let Some(st) = &opts.status {
            f.insert("status".into(), json!(st));
        }
        let cats: Vec<Value> = p.category_ids.iter().filter_map(|c| cat_map.get(c).cloned()).collect();
        if !cats.is_empty() {
            f.insert("category_ids".into(), Value::Array(cats));
        }
        let main = image(p.image_id);
        count_image(&main);
        if let Some(m) = main {
            f.insert("image_id".into(), m);
        }
        let gallery: Vec<Value> = p.gallery_ids.iter().filter_map(|g| image(*g)).collect();
        gallery.iter().for_each(|g| count_image(&Some(g.clone())));
        if !gallery.is_empty() {
            f.insert("gallery_ids".into(), Value::Array(gallery));
        }
        let parent_ref: Value = match &existing {
            Some(e) => {
                s.products_update += 1;
                for (field, value) in f {
                    if field != "type" {
                        edits.push(Edit { entity: Entity::Product, key: e.id.to_string(), field, value: Some(value) });
                    }
                }
                json!(e.id)
            }
            None => {
                s.products_create += 1;
                json!(create(Entity::Product, f, &mut edits))
            }
        };
        for v in children.get(&p.id).into_iter().flatten() {
            s.variations += 1;
            let mut vf = fields_of(v, &mut custom)?;
            if let Some(st) = &opts.status {
                vf.insert("status".into(), json!(if st == "draft" { "publish" } else { st.as_str() }));
            }
            vf.remove("name");
            let img = image(v.image_id);
            count_image(&img);
            if let Some(m) = img {
                vf.insert("image_id".into(), m);
            }
            match dst.product_by_sku(&v.sku)?.filter(|_| !v.sku.is_empty() && existing.is_some()) {
                Some(ev) => {
                    for (field, value) in vf {
                        edits.push(Edit { entity: Entity::Variation, key: ev.id.to_string(), field, value: Some(value) });
                    }
                }
                None => {
                    vf.insert("parent_id".into(), parent_ref.clone());
                    create(Entity::Variation, vf, &mut edits);
                }
            }
        }
    }
    s.duplicate_skus = skus.into_iter().filter(|(_, n)| *n > 1).map(|(k, _)| k).collect();
    s.duplicate_skus.sort();
    s.tags = tags.len();
    s.attributes = attrs.into_iter().collect();
    s.custom_fields = custom.into_iter().filter(|k| k != "_cf_source").collect();
    s.images = images.len();

    /* ------------------------------------------------------------- warnings */
    let (a, b) = (handshake(src), handshake(dst));
    if !a.currency.is_empty() && !b.currency.is_empty() && a.currency != b.currency {
        s.warnings.push(format!("The stores use different currencies ({} → {}). Prices are copied as numbers, not converted.", a.currency, b.currency));
    }
    if !a.weight_unit.is_empty() && !b.weight_unit.is_empty() && a.weight_unit != b.weight_unit {
        s.warnings.push(format!("Weight units differ ({} → {}). Weights are copied as numbers, not converted.", a.weight_unit, b.weight_unit));
    }
    if !a.dimension_unit.is_empty() && !b.dimension_unit.is_empty() && a.dimension_unit != b.dimension_unit {
        s.warnings.push(format!("Dimension units differ ({} → {}). Sizes are copied as numbers, not converted.", a.dimension_unit, b.dimension_unit));
    }
    if s.target_products > 0 {
        s.warnings.push(format!("The destination already has {} products. Matching SKUs are {}; everything else is added alongside them.", s.target_products, if opts.existing == ExistingMode::Skip { "left alone" } else { "updated" }));
    }
    if s.already_staged > 0 {
        s.warnings.push(format!("{} products are already staged in the destination from an earlier run that hasn't been pushed. They are left out; push or undo that run first.", s.already_staged));
    }
    if s.no_sku > 0 {
        s.warnings.push(format!("{} products have no SKU. They can't be matched, so running the migration again would create them twice.", s.no_sku));
    }
    if !s.duplicate_skus.is_empty() {
        s.warnings.push(format!("{} SKUs are used by more than one source product ({}…). WooCommerce allows each SKU once, so only the first of each will save.", s.duplicate_skus.len(), s.duplicate_skus.iter().take(3).cloned().collect::<Vec<_>>().join(", ")));
    }
    Ok((s, edits))
}

/// Stages the migration in `dst` as one undoable step.
pub fn stage(src: &Cache, src_store: &str, dst: &mut Cache, opts: &MigrateOptions) -> Result<MigrationSummary> {
    let (s, edits) = plan(src, src_store, dst, opts)?;
    dst.stage(&edits)?;
    Ok(s)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VerifyReport {
    pub checked: usize,
    pub matched: usize,
    /// Source products (by SKU) not found in the destination: (sku, name).
    pub missing: Vec<(String, String)>,
    /// (sku, field, source value, destination value)
    pub differences: Vec<(String, String, String, String)>,
    pub images_missing: usize,
}

/// After a migration has been pushed (and the destination re-synced): what made it across.
pub fn verify(src: &Cache, dst: &Cache, opts: &MigrateOptions) -> Result<VerifyReport> {
    let mut r = VerifyReport::default();
    let dst_by_sku: HashMap<String, Product> = dst.all_products()?.into_iter().filter(|p| !p.sku.is_empty()).map(|p| (p.sku.clone(), p)).collect();
    for p in src.all_products()?.into_iter().filter(|p| !p.sku.is_empty() && (opts.include_drafts || p.status == "publish" || p.kind == "variation")) {
        r.checked += 1;
        let Some(d) = dst_by_sku.get(&p.sku) else {
            r.missing.push((p.sku.clone(), p.name.clone()));
            continue;
        };
        r.matched += 1;
        let num = |s: &str| s.parse::<f64>().ok();
        for (field, a, b) in [
            ("regular_price", p.regular_price.clone(), d.regular_price.clone()),
            ("sale_price", p.sale_price.clone(), d.sale_price.clone()),
            ("stock_quantity", p.stock_quantity.map(|n| n.to_string()).unwrap_or_default(), d.stock_quantity.map(|n| n.to_string()).unwrap_or_default()),
            ("name", if p.kind == "variation" { String::new() } else { p.name.clone() }, if p.kind == "variation" { String::new() } else { d.name.clone() }),
        ] {
            let same = a == b || (num(&a).is_some() && num(&a) == num(&b));
            if !same && r.differences.len() < 200 {
                r.differences.push((p.sku.clone(), field.into(), a, b));
            }
        }
        if opts.include_images && p.image_id > 0 && d.image_id <= 0 {
            r.images_missing += 1;
        }
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> (tempfile::TempDir, Cache) {
        let dir = tempfile::tempdir().unwrap();
        let c = Cache::open(&dir.path().join("c.db")).unwrap();
        (dir, c)
    }

    fn cat(id: i64, parent: i64, name: &str) -> Category {
        Category { id, parent, name: name.into(), slug: name.to_lowercase(), description: format!("<p>{name}</p>"), image_id: if id == 1 { 50 } else { 0 }, ..Default::default() }
    }

    fn source() -> (tempfile::TempDir, Cache) {
        let (d, mut c) = cache();
        let tax = Taxonomy { categories: vec![cat(1, 0, "Mugs"), cat(2, 1, "Funny"), cat(3, 0, "Empty")], ..Default::default() };
        c.replace_taxonomy(&tax).unwrap();
        c.upsert_media(&[Media { id: 50, url: "http://src.local/wp-content/uploads/mugs.webp".into(), ..Default::default() }, Media { id: 51, url: "http://src.local/wp-content/uploads/a.webp".into(), alt: "A".into(), ..Default::default() }])
            .unwrap();
        let mut a = Product { id: 10, name: "Mug A".into(), sku: "MUG-A".into(), kind: "simple".into(), status: "publish".into(), regular_price: "90".into(), category_ids: vec![2], image_id: 51, tags: vec!["gift".into()], ..Default::default() };
        a.meta.insert("brand".into(), json!("Acme"));
        let tee = Product {
            id: 20, name: "Tee".into(), sku: "TEE".into(), kind: "variable".into(), status: "publish".into(), category_ids: vec![1],
            attributes: vec![ProductAttribute { name: "Size".into(), taxonomy: "pa_size".into(), options: vec!["S".into(), "M".into()], variation: true, visible: true, position: 0 }],
            ..Default::default()
        };
        let v1 = Product { id: 21, parent_id: 20, kind: "variation".into(), sku: "TEE-S".into(), regular_price: "100".into(), status: "publish".into(), variation_attributes: [("pa_size".to_string(), "s".to_string())].into(), ..Default::default() };
        let v2 = Product { id: 22, parent_id: 20, kind: "variation".into(), sku: "TEE-M".into(), regular_price: "110".into(), status: "publish".into(), variation_attributes: [("pa_size".to_string(), "m".to_string())].into(), ..Default::default() };
        let draft = Product { id: 30, name: "Secret".into(), sku: "SEC".into(), kind: "simple".into(), status: "draft".into(), ..Default::default() };
        c.upsert_products(&[a, tee, v1, v2, draft]).unwrap();
        (d, c)
    }

    fn opts() -> MigrateOptions {
        MigrateOptions { include_images: true, include_custom_fields: true, ..Default::default() }
    }

    #[test]
    fn migrates_a_catalogue_into_an_empty_store() {
        let (_a, src) = source();
        let (_b, mut dst) = cache();
        let s = stage(&src, "s1", &mut dst, &opts()).unwrap();
        assert_eq!((s.categories_create, s.products_create, s.variations, s.products_skip), (2, 2, 2, 0), "{s:?}");
        assert_eq!(s.images, 2, "category image + product image");
        assert_eq!(s.custom_fields, vec!["brand".to_string()]);
        assert_eq!(s.attributes, vec!["Size".to_string()]);
        let sum = dst.summary().unwrap();
        assert_eq!(sum.created, 2 + 2 + 2);
        // The sub-category's parent is the new top-level category.
        let q = dst.query(&crate::cache::ProductQuery { search: "MUG-A".into(), ..Default::default() }).unwrap();
        let row = &dst.rows(&q.keys).unwrap()[0].product;
        assert_eq!(row["image_id"]["url"], "http://src.local/wp-content/uploads/a.webp");
        assert_eq!(row["meta:brand"], "Acme");
        assert_eq!(row["tags"], json!(["gift"]));
        assert!(row["category_ids"][0].as_str().unwrap().starts_with(NEW_PREFIX));
        // A second run before pushing stages nothing twice.
        let (again, more) = plan(&src, "s1", &dst, &opts()).unwrap();
        assert_eq!((again.products_create, again.already_staged, again.categories_create, again.already_staged_categories), (0, 2, 0, 2), "{again:?}");
        assert!(more.is_empty());
        // One undo removes it all.
        dst.undo().unwrap();
        assert_eq!(dst.summary().unwrap().created, 0);
    }

    #[test]
    fn skips_or_updates_existing_skus_and_scopes_by_category() {
        let (_a, src) = source();
        let (_b, mut dst) = cache();
        dst.replace_taxonomy(&Taxonomy { categories: vec![cat(7, 0, "Mugs")], ..Default::default() }).unwrap();
        dst.upsert_products(&[Product { id: 99, name: "Old".into(), sku: "MUG-A".into(), kind: "simple".into(), status: "publish".into(), ..Default::default() }]).unwrap();
        let (s, _) = plan(&src, "s1", &dst, &opts()).unwrap();
        assert_eq!((s.products_skip, s.products_create, s.categories_existing), (1, 1, 1));
        assert!(s.warnings.iter().any(|w| w.contains("already has 1 products")));
        let (s, edits) = plan(&src, "s1", &dst, &MigrateOptions { existing: ExistingMode::Update, ..opts() }).unwrap();
        assert_eq!(s.products_update, 1);
        assert!(edits.iter().any(|e| e.key == "99" && e.field == "name" && e.value == Some(json!("Mug A"))));
        let (s, _) = plan(&src, "s1", &dst, &MigrateOptions { category_ids: vec![2], ..opts() }).unwrap();
        assert_eq!((s.products_create + s.products_skip, s.variations), (1, 0), "only Funny");
        let (s, _) = plan(&src, "s1", &dst, &MigrateOptions { include_drafts: true, include_empty_categories: true, ..opts() }).unwrap();
        assert_eq!(s.source_products, 3);
        assert_eq!(s.categories_create, 2, "Funny and Empty (Mugs exists)");
    }

    #[test]
    fn verify_reports_missing_and_different_products() {
        let (_a, src) = source();
        let (_b, mut dst) = cache();
        dst.upsert_products(&[Product { id: 1, name: "Mug A".into(), sku: "MUG-A".into(), kind: "simple".into(), regular_price: "95".into(), ..Default::default() }]).unwrap();
        let r = verify(&src, &dst, &opts()).unwrap();
        assert_eq!(r.matched, 1);
        assert_eq!(r.missing.len(), 3, "TEE, TEE-S, TEE-M");
        assert_eq!(r.differences, vec![("MUG-A".to_string(), "regular_price".to_string(), "90".to_string(), "95".to_string())]);
        assert_eq!(r.images_missing, 1);
    }
}
