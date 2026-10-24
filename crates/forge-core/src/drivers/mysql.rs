//! Direct MySQL/MariaDB driver.
//!
//! Reads are raw SQL against the WordPress tables (posts, postmeta, terms) and produce exactly
//! the same records as the connector plugin — this is the fastest way to pull a 100k+ SKU catalog.
//! Writes are deliberately *not* raw SQL: they are delegated to a write-capable driver
//! (normally the connector plugin) so WooCommerce's lookup tables, caches and SEO/translation
//! plugins stay consistent.

use super::{unsupported, Capabilities, Driver, MediaText};
use crate::media::PreparedImage;
use crate::model::*;
use crate::phpser;
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde_json::Value;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions};
use sqlx::Row;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct MysqlTarget {
    pub host: String,
    pub port: u16,
    pub socket: Option<String>,
    pub user: String,
    pub password: String,
    pub database: String,
    pub table_prefix: String,
}

pub struct MysqlDriver {
    pool: MySqlPool,
    p: String,
    write_via: Option<Arc<dyn Driver>>,
    placeholder: i64,
    home: String,
    uploads_url: String,
    attr_labels: HashMap<String, String>,
}

const META_KEYS: &[&str] = &[
    "_sku", "_global_unique_id", "_regular_price", "_sale_price", "_sale_price_dates_from", "_sale_price_dates_to",
    "_manage_stock", "_stock", "_stock_status", "_backorders", "_weight", "_length", "_width", "_height",
    "_tax_status", "_tax_class", "_virtual", "_downloadable", "_thumbnail_id", "_product_image_gallery",
    "_product_attributes", "_product_url", "_button_text", "_variation_description",
    "_yoast_wpseo_title", "_yoast_wpseo_metadesc", "_yoast_wpseo_focuskw",
    "rank_math_title", "rank_math_description", "rank_math_focus_keyword",
    "_cf_seo_title", "_cf_seo_description", "_cf_focus_keyword",
];

fn iso(mysql_dt: &str) -> Option<String> {
    if mysql_dt.is_empty() || mysql_dt.starts_with("0000") {
        return None;
    }
    Some(format!("{}Z", mysql_dt.replacen(' ', "T", 1)))
}

fn ts_to_iso(ts: &str) -> Option<String> {
    let n: i64 = ts.trim().parse().ok()?;
    chrono::DateTime::from_timestamp(n, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

impl MysqlDriver {
    pub async fn connect(t: &MysqlTarget, write_via: Option<Arc<dyn Driver>>) -> Result<Self> {
        if !t.table_prefix.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            bail!("Invalid table prefix");
        }
        let mut opts = MySqlConnectOptions::new().username(&t.user).password(&t.password).database(&t.database).charset("utf8mb4");
        opts = match &t.socket {
            Some(sock) => opts.socket(sock),
            None => opts.host(&t.host).port(t.port),
        };
        let pool = MySqlPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(opts)
            .await
            .map_err(|e| anyhow!("Could not connect to MySQL at {}: {e}", t.socket.clone().unwrap_or_else(|| format!("{}:{}", t.host, t.port))))?;
        let mut d = Self {
            pool,
            p: t.table_prefix.clone(),
            write_via,
            placeholder: 0,
            home: String::new(),
            uploads_url: String::new(),
            attr_labels: HashMap::new(),
        };
        d.home = d.option("home").await?.unwrap_or_default().trim_end_matches('/').to_string();
        let siteurl = d.option("siteurl").await?.unwrap_or_else(|| d.home.clone());
        d.uploads_url = match d.option("upload_url_path").await?.filter(|s| !s.is_empty()) {
            Some(u) => u.trim_end_matches('/').to_string(),
            None => format!("{}/wp-content/uploads", siteurl.trim_end_matches('/')),
        };
        d.placeholder = d.option("catalogforge_preview_placeholder").await?.and_then(|v| v.parse().ok()).unwrap_or(0);
        let rows = sqlx::query(&format!("SELECT attribute_name, attribute_label FROM {}woocommerce_attribute_taxonomies", d.p))
            .fetch_all(&d.pool)
            .await
            .map_err(|e| anyhow!("This database does not look like a WooCommerce store ({e})"))?;
        for r in rows {
            let name: String = r.try_get(0)?;
            let label: String = r.try_get(1)?;
            d.attr_labels.insert(format!("pa_{name}"), label);
        }
        Ok(d)
    }

    pub fn pool(&self) -> &MySqlPool {
        &self.pool
    }

    pub fn prefix(&self) -> &str {
        &self.p
    }

    pub async fn option(&self, name: &str) -> Result<Option<String>> {
        let row = sqlx::query(&format!("SELECT option_value FROM {}options WHERE option_name = ? LIMIT 1", self.p))
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            Some(r) => Some(r.try_get::<String, _>(0)?),
            None => None,
        })
    }

    pub async fn set_option(&self, name: &str, value: &str, autoload: bool) -> Result<()> {
        let autoload = if autoload { "yes" } else { "no" };
        sqlx::query(&format!(
            "INSERT INTO {}options (option_name, option_value, autoload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)",
            self.p
        ))
        .bind(name)
        .bind(value)
        .bind(autoload)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    fn id_list(ids: &[i64]) -> String {
        if ids.is_empty() {
            "0".into()
        } else {
            ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
        }
    }

    async fn products_for(&self, where_sql: &str) -> Result<CatalogPage> {
        let p = &self.p;
        let rows = sqlx::query(&format!(
            "SELECT ID, post_parent, post_type, post_status, post_title, post_name, post_content, post_excerpt, menu_order,
                    CAST(post_date_gmt AS CHAR), CAST(post_modified_gmt AS CHAR)
             FROM {p}posts WHERE post_type IN ('product','product_variation') AND post_status NOT IN ('trash','auto-draft')
               AND ID <> {} AND {where_sql}",
            self.placeholder
        ))
        .fetch_all(&self.pool)
        .await?;
        if rows.is_empty() {
            return Ok(CatalogPage { server_time: chrono::Utc::now().timestamp(), ..Default::default() });
        }
        let ids: Vec<i64> = rows.iter().map(|r| r.get::<u64, _>(0) as i64).collect();
        let list = Self::id_list(&ids);

        // postmeta
        let keys = META_KEYS.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(",");
        let meta_rows = sqlx::query(&format!(
            "SELECT post_id, meta_key, meta_value FROM {p}postmeta WHERE post_id IN ({list}) AND (meta_key IN ({keys}) OR meta_key LIKE 'attribute\\_%')"
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut meta: HashMap<i64, HashMap<String, String>> = HashMap::new();
        for r in meta_rows {
            let id = r.get::<u64, _>(0) as i64;
            let k: String = r.get(1);
            let v: Option<String> = r.try_get(2).ok();
            meta.entry(id).or_default().insert(k, v.unwrap_or_default());
        }

        // terms
        let term_rows = sqlx::query(&format!(
            "SELECT tr.object_id, tt.taxonomy, t.term_id, t.name, t.slug FROM {p}term_relationships tr
             JOIN {p}term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
             JOIN {p}terms t ON t.term_id = tt.term_id
             WHERE tr.object_id IN ({list}) ORDER BY tr.object_id, tr.term_order, t.term_id"
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut terms: HashMap<i64, Vec<(String, i64, String, String)>> = HashMap::new();
        for r in term_rows {
            terms.entry(r.get::<u64, _>(0) as i64).or_default().push((r.get(1), r.get::<u64, _>(2) as i64, r.get(3), r.get(4)));
        }

        let mut products = Vec::with_capacity(rows.len());
        let mut media_ids = Vec::new();
        for r in &rows {
            let id = r.get::<u64, _>(0) as i64;
            let post_type: String = r.get(2);
            let is_var = post_type == "product_variation";
            let m = meta.remove(&id).unwrap_or_default();
            let t = terms.remove(&id).unwrap_or_default();
            let get = |k: &str| m.get(k).cloned().unwrap_or_default();
            let first_nonempty = |ks: &[&str]| ks.iter().map(|k| get(k)).find(|v| !v.is_empty()).unwrap_or_default();
            let tax_slugs = |tax: &str| t.iter().filter(|x| x.0 == tax).map(|x| x.3.clone()).collect::<Vec<_>>();
            let visibility = tax_slugs("product_visibility");

            let kind = if is_var { "variation".to_string() } else { tax_slugs("product_type").into_iter().next().unwrap_or_else(|| "simple".into()) };
            let catalog_visibility = match (visibility.contains(&"exclude-from-catalog".into()), visibility.contains(&"exclude-from-search".into())) {
                (true, true) => "hidden",
                (true, false) => "search",
                (false, true) => "catalog",
                _ => "visible",
            };

            let mut attributes = Vec::new();
            if !is_var {
                if let Ok(Value::Object(attrs)) = phpser::unserialize(&get("_product_attributes")) {
                    for (_, a) in attrs {
                        let truthy = |v: &Value| matches!(v, Value::Bool(true)) || v.as_i64() == Some(1) || v.as_str() == Some("1");
                        let is_tax = truthy(&a["is_taxonomy"]);
                        let name = a["name"].as_str().unwrap_or_default().to_string();
                        let options = if is_tax {
                            t.iter().filter(|x| x.0 == name).map(|x| x.2.clone()).collect()
                        } else {
                            a["value"].as_str().unwrap_or_default().split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
                        };
                        attributes.push(ProductAttribute {
                            name: if is_tax { self.attr_labels.get(&name).cloned().unwrap_or_else(|| name.trim_start_matches("pa_").to_string()) } else { name.clone() },
                            taxonomy: if is_tax { name } else { String::new() },
                            options,
                            visible: truthy(&a["is_visible"]),
                            variation: truthy(&a["is_variation"]),
                            position: a["position"].as_i64().or_else(|| a["position"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0),
                        });
                    }
                    attributes.sort_by_key(|a| a.position);
                }
            }
            let variation_attributes: BTreeMap<String, String> = if is_var {
                m.iter().filter_map(|(k, v)| k.strip_prefix("attribute_").map(|k| (k.to_string(), v.clone()))).collect()
            } else {
                BTreeMap::new()
            };

            let image_id: i64 = get("_thumbnail_id").parse().unwrap_or(0);
            let gallery_ids: Vec<i64> = if is_var { vec![] } else { get("_product_image_gallery").split(',').filter_map(|s| s.trim().parse().ok()).collect() };
            if image_id > 0 {
                media_ids.push(image_id);
            }
            media_ids.extend(&gallery_ids);
            let stock = get("_stock");
            let post_date: Option<String> = r.try_get(9).ok();
            let modified: Option<String> = r.try_get(10).ok();

            products.push(Product {
                id,
                parent_id: r.get::<u64, _>(1) as i64,
                kind,
                status: r.get(3),
                name: r.get(4),
                slug: if is_var { String::new() } else { r.get(5) },
                sku: get("_sku"),
                global_unique_id: get("_global_unique_id"),
                regular_price: get("_regular_price"),
                sale_price: get("_sale_price"),
                date_on_sale_from: ts_to_iso(&get("_sale_price_dates_from")),
                date_on_sale_to: ts_to_iso(&get("_sale_price_dates_to")),
                manage_stock: get("_manage_stock") == "yes",
                stock_quantity: if stock.is_empty() { None } else { stock.parse::<f64>().ok().map(|f| f as i64) },
                stock_status: { let s = get("_stock_status"); if s.is_empty() { "instock".into() } else { s } },
                backorders: { let s = get("_backorders"); if s.is_empty() { "no".into() } else { s } },
                weight: get("_weight"),
                length: get("_length"),
                width: get("_width"),
                height: get("_height"),
                shipping_class: tax_slugs("product_shipping_class").into_iter().next().unwrap_or_default(),
                tax_status: { let s = get("_tax_status"); if s.is_empty() { "taxable".into() } else { s } },
                tax_class: { let s = get("_tax_class"); if is_var && s.is_empty() { "parent".into() } else { s } },
                description: if is_var { get("_variation_description") } else { r.get(6) },
                short_description: if is_var { String::new() } else { r.get(7) },
                menu_order: r.get::<i32, _>(8) as i64,
                featured: !is_var && visibility.contains(&"featured".to_string()),
                catalog_visibility: catalog_visibility.into(),
                is_virtual: get("_virtual") == "yes",
                downloadable: get("_downloadable") == "yes",
                category_ids: if is_var { vec![] } else { t.iter().filter(|x| x.0 == "product_cat").map(|x| x.1).collect() },
                tags: if is_var { vec![] } else { t.iter().filter(|x| x.0 == "product_tag").map(|x| x.2.clone()).collect() },
                attributes,
                variation_attributes,
                image_id,
                gallery_ids,
                external_url: get("_product_url"),
                button_text: get("_button_text"),
                permalink: if is_var { String::new() } else { format!("{}/?p={id}", self.home) },
                seo_title: if is_var { String::new() } else { first_nonempty(&["_yoast_wpseo_title", "rank_math_title", "_cf_seo_title"]) },
                seo_description: if is_var { String::new() } else { first_nonempty(&["_yoast_wpseo_metadesc", "rank_math_description", "_cf_seo_description"]) },
                focus_keyword: if is_var { String::new() } else { first_nonempty(&["_yoast_wpseo_focuskw", "rank_math_focus_keyword", "_cf_focus_keyword"]) },
                date_created_gmt: post_date.as_deref().and_then(iso),
                date_modified_gmt: modified.as_deref().and_then(iso),
                meta: BTreeMap::new(),
            });
        }
        products.sort_by_key(|p| p.id);
        media_ids.sort_unstable();
        media_ids.dedup();
        let media = self.media_for(&media_ids).await?;
        Ok(CatalogPage { products, media, next_after: None, server_time: chrono::Utc::now().timestamp() })
    }

    pub async fn media_for(&self, ids: &[i64]) -> Result<Vec<Media>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let p = &self.p;
        let list = Self::id_list(ids);
        let rows = sqlx::query(&format!("SELECT ID, post_title, post_mime_type, post_parent FROM {p}posts WHERE ID IN ({list}) AND post_type = 'attachment'"))
            .fetch_all(&self.pool)
            .await?;
        let meta_rows = sqlx::query(&format!(
            "SELECT post_id, meta_key, meta_value FROM {p}postmeta WHERE post_id IN ({list})
             AND meta_key IN ('_wp_attached_file','_wp_attachment_metadata','_wp_attachment_image_alt','_cf_sha256')"
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut meta: HashMap<i64, HashMap<String, String>> = HashMap::new();
        for r in meta_rows {
            meta.entry(r.get::<u64, _>(0) as i64).or_default().insert(r.get(1), r.try_get::<String, _>(2).unwrap_or_default());
        }
        let mut out = Vec::new();
        for r in rows {
            let id = r.get::<u64, _>(0) as i64;
            let m = meta.remove(&id).unwrap_or_default();
            let file = m.get("_wp_attached_file").cloned().unwrap_or_default();
            let dir = file.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
            let md = m.get("_wp_attachment_metadata").and_then(|s| phpser::unserialize(s).ok()).unwrap_or(Value::Null);
            let url = format!("{}/{}", self.uploads_url, file);
            let size_url = |name: &str| md["sizes"][name]["file"].as_str().map(|f| format!("{}/{}{}", self.uploads_url, dir, f));
            out.push(Media {
                id,
                thumb_url: size_url("thumbnail").unwrap_or_else(|| url.clone()),
                medium_url: size_url("medium").unwrap_or_else(|| url.clone()),
                url,
                alt: m.get("_wp_attachment_image_alt").cloned().unwrap_or_default(),
                title: r.get(1),
                filename: file.rsplit('/').next().unwrap_or_default().to_string(),
                mime: r.get(2),
                width: md["width"].as_i64().unwrap_or(0),
                height: md["height"].as_i64().unwrap_or(0),
                sha256: m.get("_cf_sha256").cloned().unwrap_or_default(),
                parent_id: r.get::<u64, _>(3) as i64,
            });
        }
        out.sort_by_key(|m| m.id);
        Ok(out)
    }

    fn writer(&self) -> Result<&Arc<dyn Driver>> {
        self.write_via.as_ref().ok_or_else(|| unsupported("Writing", "read-only MySQL"))
    }
}

#[async_trait]
impl Driver for MysqlDriver {
    fn capabilities(&self) -> Capabilities {
        match &self.write_via {
            Some(w) => Capabilities { batch_size: w.capabilities().batch_size, ..w.capabilities() },
            None => Capabilities { write: false, batch_size: 0, ..Default::default() },
        }
    }

    async fn handshake(&self) -> Result<Handshake> {
        if let Some(w) = &self.write_via {
            if let Ok(h) = w.handshake().await {
                return Ok(h);
            }
        }
        let opt = |k: &'static str| async move { self.option(k).await.ok().flatten().unwrap_or_default() };
        let num = |s: String, d: u32| s.parse::<u32>().unwrap_or(d);
        let mut sizes = vec![
            ImageSize { name: "thumbnail".into(), width: num(opt("thumbnail_size_w").await, 150), height: num(opt("thumbnail_size_h").await, 150), crop: opt("thumbnail_crop").await != "0" },
            ImageSize { name: "medium".into(), width: num(opt("medium_size_w").await, 300), height: num(opt("medium_size_h").await, 300), crop: false },
            ImageSize { name: "medium_large".into(), width: num(opt("medium_large_size_w").await, 768), height: 0, crop: false },
            ImageSize { name: "large".into(), width: num(opt("large_size_w").await, 1024), height: num(opt("large_size_h").await, 1024), crop: false },
            ImageSize { name: "1536x1536".into(), width: 1536, height: 1536, crop: false },
            ImageSize { name: "2048x2048".into(), width: 2048, height: 2048, crop: false },
        ];
        let wc_thumb = num(opt("woocommerce_thumbnail_image_width").await, 300);
        sizes.push(ImageSize { name: "woocommerce_thumbnail".into(), width: wc_thumb, height: wc_thumb, crop: true });
        sizes.push(ImageSize { name: "woocommerce_single".into(), width: num(opt("woocommerce_single_image_width").await, 600), height: 0, crop: false });
        sizes.push(ImageSize { name: "woocommerce_gallery_thumbnail".into(), width: 100, height: 100, crop: true });
        Ok(Handshake {
            protocol: 0,
            site_name: opt("blogname").await,
            home_url: self.home.clone(),
            wc_version: Some(opt("woocommerce_version").await).filter(|s| !s.is_empty()),
            currency: opt("woocommerce_currency").await,
            weight_unit: opt("woocommerce_weight_unit").await,
            dimension_unit: opt("woocommerce_dimension_unit").await,
            price_decimals: opt("woocommerce_price_num_decimals").await.parse().unwrap_or(2),
            server_time: chrono::Utc::now().timestamp(),
            image_sizes: sizes,
            big_image_threshold: 2560,
            recommended_batch: 0,
            ..Default::default()
        })
    }

    async fn index(&self) -> Result<Vec<IndexEntry>> {
        let rows = sqlx::query(&format!(
            "SELECT ID, post_parent, post_type, CAST(post_modified_gmt AS CHAR) FROM {}posts
             WHERE post_type IN ('product','product_variation') AND post_status NOT IN ('trash','auto-draft') AND ID <> {} ORDER BY ID",
            self.p, self.placeholder
        ))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let t: String = r.get(2);
                IndexEntry(r.get::<u64, _>(0) as i64, r.get::<u64, _>(1) as i64, (t == "product_variation") as u8, r.get(3))
            })
            .collect())
    }

    async fn catalog_page(&self, after_id: i64, limit: usize) -> Result<CatalogPage> {
        let limit = limit.clamp(1, 5000);
        let mut page = self.products_for(&format!("ID > {} ORDER BY ID LIMIT {limit}", after_id.max(0))).await?;
        page.next_after = if page.products.len() == limit { page.products.last().map(|p| p.id) } else { None };
        Ok(page)
    }

    async fn catalog_by_ids(&self, ids: &[i64]) -> Result<CatalogPage> {
        let mut out = CatalogPage::default();
        for chunk in ids.chunks(2000) {
            let page = self.products_for(&format!("ID IN ({})", Self::id_list(chunk))).await?;
            out.products.extend(page.products);
            out.media.extend(page.media);
            out.server_time = page.server_time;
        }
        Ok(out)
    }

    async fn taxonomy(&self) -> Result<Taxonomy> {
        let p = &self.p;
        let term_rows = sqlx::query(&format!(
            "SELECT t.term_id, t.name, t.slug, tt.taxonomy, tt.parent, tt.description, tt.count
             FROM {p}terms t JOIN {p}term_taxonomy tt ON tt.term_id = t.term_id
             WHERE tt.taxonomy IN ('product_cat','product_tag','product_shipping_class') OR tt.taxonomy LIKE 'pa\\_%'
             ORDER BY t.name"
        ))
        .fetch_all(&self.pool)
        .await?;
        let cat_ids: Vec<i64> = term_rows.iter().filter(|r| r.get::<String, _>(3) == "product_cat").map(|r| r.get::<u64, _>(0) as i64).collect();
        let tm_rows = sqlx::query(&format!(
            "SELECT term_id, meta_key, meta_value FROM {p}termmeta WHERE term_id IN ({}) AND meta_key IN
             ('display_type','thumbnail_id','_cf_banner_id','order','rank_math_title','rank_math_description','_cf_seo_title','_cf_seo_description')",
            Self::id_list(&cat_ids)
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut tm: HashMap<i64, HashMap<String, String>> = HashMap::new();
        for r in tm_rows {
            tm.entry(r.get::<u64, _>(0) as i64).or_default().insert(r.get(1), r.try_get::<String, _>(2).unwrap_or_default());
        }
        let mut tax = Taxonomy::default();
        let mut attr_terms: HashMap<String, Vec<Term>> = HashMap::new();
        let mut media_ids = Vec::new();
        for r in &term_rows {
            let id = r.get::<u64, _>(0) as i64;
            let taxonomy: String = r.get(3);
            match taxonomy.as_str() {
                "product_cat" => {
                    let m = tm.remove(&id).unwrap_or_default();
                    let g = |k: &str| m.get(k).cloned().unwrap_or_default();
                    let c = Category {
                        id,
                        parent: r.get::<u64, _>(4) as i64,
                        name: r.get(1),
                        slug: r.get(2),
                        description: r.get(5),
                        count: r.get::<i64, _>(6),
                        display_type: g("display_type"),
                        image_id: g("thumbnail_id").parse().unwrap_or(0),
                        banner_id: g("_cf_banner_id").parse().unwrap_or(0),
                        menu_order: g("order").parse().unwrap_or(0),
                        seo_title: [g("rank_math_title"), g("_cf_seo_title")].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
                        seo_description: [g("rank_math_description"), g("_cf_seo_description")].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
                    };
                    media_ids.extend([c.image_id, c.banner_id].into_iter().filter(|i| *i > 0));
                    tax.categories.push(c);
                }
                "product_tag" => tax.tags.push(Tag { id, name: r.get(1), slug: r.get(2), count: r.get::<i64, _>(6) }),
                "product_shipping_class" => tax.shipping_classes.push(Term { id, name: r.get(1), slug: r.get(2) }),
                _ => attr_terms.entry(taxonomy).or_default().push(Term { id, name: r.get(1), slug: r.get(2) }),
            }
        }
        let attrs = sqlx::query(&format!("SELECT attribute_id, attribute_name, attribute_label, attribute_type FROM {p}woocommerce_attribute_taxonomies ORDER BY attribute_name"))
            .fetch_all(&self.pool)
            .await?;
        for r in attrs {
            let taxonomy = format!("pa_{}", r.get::<String, _>(1));
            tax.attributes.push(AttributeTaxonomy {
                id: r.get::<u64, _>(0) as i64,
                name: r.get(2),
                terms: attr_terms.remove(&taxonomy).unwrap_or_default(),
                taxonomy,
                kind: r.get(3),
            });
        }
        if let Ok(rows) = sqlx::query(&format!("SELECT slug FROM {p}wc_tax_rate_classes ORDER BY tax_rate_class_id")).fetch_all(&self.pool).await {
            tax.tax_classes = rows.into_iter().map(|r| r.get(0)).collect();
        }
        media_ids.sort_unstable();
        media_ids.dedup();
        tax.media = self.media_for(&media_ids).await?;
        Ok(tax)
    }

    async fn batch(&self, ops: &[Op], check_conflicts: bool) -> Result<BatchResponse> {
        self.writer()?.batch(ops, check_conflicts).await
    }

    async fn upload_media(&self, image: &PreparedImage, text: &MediaText) -> Result<MediaUploadResult> {
        self.writer()?.upload_media(image, text).await
    }

    async fn sideload_media(&self, url: &str, text: &MediaText) -> Result<MediaUploadResult> {
        self.writer()?.sideload_media(url, text).await
    }

    async fn preview(&self, product_id: Option<i64>, draft: &Value) -> Result<String> {
        self.writer()?.preview(product_id, draft).await
    }
}
