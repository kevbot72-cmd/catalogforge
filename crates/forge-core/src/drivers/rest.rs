//! Stock WooCommerce REST API (wc/v3) driver — works on any store with no plugin installed.
//!
//! Limitations versus the connector (surfaced through [`Capabilities`]): batches are capped by
//! WooCommerce (100 by default), conflict detection is done client-side with an extra read,
//! images can only be attached by public URL (WooCommerce downloads them and generates sizes on
//! the server), and there is no theme preview.

use super::{unsupported, Capabilities, Driver, MediaText};
use crate::media::PreparedImage;
use crate::model::*;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;
use tokio::sync::RwLock;

pub struct RestDriver {
    client: reqwest::Client,
    base: String,
    ck: String,
    cs: String,
    /// taxonomy (pa_x) → global attribute id, and term name → slug per taxonomy.
    attrs: RwLock<Option<(HashMap<String, i64>, HashMap<i64, String>, HashMap<String, HashMap<String, String>>)>>,
    custom: super::MetaKeys,
}

fn s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl RestDriver {
    pub fn new(base_url: &str, consumer_key: &str, consumer_secret: &str) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder().timeout(Duration::from_secs(180)).gzip(true).build()?,
            base: base_url.trim_end_matches('/').to_string(),
            ck: consumer_key.into(),
            cs: consumer_secret.into(),
            attrs: RwLock::new(None),
            custom: Default::default(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/wp-json/wc/v3{}", self.base, path)
    }

    async fn req(&self, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<(Value, reqwest::header::HeaderMap)> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let mut r = self.client.request(method.clone(), self.url(path)).query(query);
            r = if self.base.starts_with("https://") {
                r.basic_auth(&self.ck, Some(&self.cs))
            } else {
                // WooCommerce only accepts keys in the query string over plain HTTP.
                r.query(&[("consumer_key", &self.ck), ("consumer_secret", &self.cs)])
            };
            if let Some(b) = body {
                r = r.json(b);
            }
            let res = r.send().await;
            let retry = match &res {
                Err(e) => e.is_timeout() || e.is_connect(),
                Ok(x) => x.status().is_server_error() || x.status().as_u16() == 429,
            };
            if retry && attempt < 4 {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            let res = res.with_context(|| format!("Could not reach {}", self.base))?;
            let status = res.status();
            let headers = res.headers().clone();
            let v: Value = res.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                bail!("WooCommerce REST {status}: {}", v.get("message").and_then(Value::as_str).unwrap_or("request failed"));
            }
            return Ok((v, headers));
        }
    }

    async fn get_all(&self, path: &str, extra: &[(&str, String)]) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut page = 1;
        loop {
            let mut q: Vec<(&str, String)> = vec![("per_page", "100".into()), ("page", page.to_string())];
            q.extend(extra.iter().cloned());
            let (v, h) = self.req(reqwest::Method::GET, path, &q, None).await?;
            let items = v.as_array().cloned().unwrap_or_default();
            let n = items.len();
            out.extend(items);
            let total_pages: usize = h.get("x-wp-totalpages").and_then(|x| x.to_str().ok()).and_then(|x| x.parse().ok()).unwrap_or(1);
            if n < 100 || page >= total_pages {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    async fn attr_maps(&self) -> Result<()> {
        if self.attrs.read().await.is_some() {
            return Ok(());
        }
        let attrs = self.get_all("/products/attributes", &[]).await?;
        let mut by_tax = HashMap::new();
        let mut by_id = HashMap::new();
        let mut slugs = HashMap::new();
        for a in attrs {
            let id = a["id"].as_i64().unwrap_or(0);
            let tax = s(&a["slug"]);
            by_tax.insert(tax.clone(), id);
            by_id.insert(id, tax.clone());
            let terms = self.get_all(&format!("/products/attributes/{id}/terms"), &[]).await?;
            slugs.insert(tax, terms.iter().map(|t| (s(&t["name"]), s(&t["slug"]))).collect());
        }
        *self.attrs.write().await = Some((by_tax, by_id, slugs));
        Ok(())
    }

    async fn to_product(&self, v: &Value, parent: Option<i64>) -> Product {
        let guard = self.attrs.read().await;
        let (_, by_id, slugs) = guard.as_ref().map(|(a, b, c)| (a, b, c)).unzip3();
        let tax_of = |id: i64| by_id.and_then(|m| m.get(&id)).cloned().unwrap_or_default();
        let meta = |k: &str| v["meta_data"].as_array().and_then(|a| a.iter().find(|m| m["key"] == k)).map(|m| s(&m["value"])).unwrap_or_default();
        let is_var = parent.is_some();
        let images: Vec<i64> = if is_var {
            v["image"]["id"].as_i64().into_iter().filter(|i| *i > 0).collect()
        } else {
            v["images"].as_array().map(|a| a.iter().filter_map(|i| i["id"].as_i64()).collect()).unwrap_or_default()
        };
        let attributes = if is_var {
            vec![]
        } else {
            v["attributes"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|x| ProductAttribute {
                            name: s(&x["name"]),
                            taxonomy: x["id"].as_i64().filter(|i| *i > 0).map(tax_of).unwrap_or_default(),
                            options: x["options"].as_array().map(|o| o.iter().map(s).collect()).unwrap_or_default(),
                            visible: x["visible"].as_bool().unwrap_or(true),
                            variation: x["variation"].as_bool().unwrap_or(false),
                            position: x["position"].as_i64().unwrap_or(0),
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let variation_attributes: BTreeMap<String, String> = if is_var {
            v["attributes"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|x| {
                            let id = x["id"].as_i64().unwrap_or(0);
                            let option = s(&x["option"]);
                            if id > 0 {
                                let tax = tax_of(id);
                                let slug = slugs.and_then(|m| m.get(&tax)).and_then(|m| m.get(&option)).cloned().unwrap_or_else(|| crate::media::slugify(&option));
                                (tax, slug)
                            } else {
                                (crate::media::slugify(&s(&x["name"])), option)
                            }
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            BTreeMap::new()
        };
        Product {
            id: v["id"].as_i64().unwrap_or(0),
            parent_id: parent.unwrap_or_else(|| v["parent_id"].as_i64().unwrap_or(0)),
            kind: if is_var { "variation".into() } else { s(&v["type"]) },
            status: s(&v["status"]),
            name: if is_var { s(&v["name"]) } else { s(&v["name"]) },
            slug: if is_var { String::new() } else { s(&v["slug"]) },
            sku: s(&v["sku"]),
            global_unique_id: s(&v["global_unique_id"]),
            regular_price: s(&v["regular_price"]),
            sale_price: s(&v["sale_price"]),
            date_on_sale_from: v["date_on_sale_from_gmt"].as_str().map(|d| format!("{d}Z")),
            date_on_sale_to: v["date_on_sale_to_gmt"].as_str().map(|d| format!("{d}Z")),
            manage_stock: v["manage_stock"].as_bool().unwrap_or(false),
            stock_quantity: v["stock_quantity"].as_i64(),
            stock_status: s(&v["stock_status"]),
            backorders: s(&v["backorders"]),
            weight: s(&v["weight"]),
            length: s(&v["dimensions"]["length"]),
            width: s(&v["dimensions"]["width"]),
            height: s(&v["dimensions"]["height"]),
            shipping_class: s(&v["shipping_class"]),
            tax_status: s(&v["tax_status"]),
            tax_class: s(&v["tax_class"]),
            description: s(&v["description"]),
            short_description: s(&v["short_description"]),
            menu_order: v["menu_order"].as_i64().unwrap_or(0),
            featured: v["featured"].as_bool().unwrap_or(false),
            catalog_visibility: if is_var { "visible".into() } else { s(&v["catalog_visibility"]) },
            is_virtual: v["virtual"].as_bool().unwrap_or(false),
            downloadable: v["downloadable"].as_bool().unwrap_or(false),
            category_ids: v["categories"].as_array().map(|a| a.iter().filter_map(|c| c["id"].as_i64()).collect()).unwrap_or_default(),
            tags: v["tags"].as_array().map(|a| a.iter().map(|t| s(&t["name"])).collect()).unwrap_or_default(),
            attributes,
            variation_attributes,
            image_id: images.first().copied().unwrap_or(0),
            gallery_ids: images.iter().skip(1).copied().collect(),
            external_url: s(&v["external_url"]),
            button_text: s(&v["button_text"]),
            permalink: s(&v["permalink"]),
            seo_title: [meta("_yoast_wpseo_title"), meta("rank_math_title")].into_iter().find(|x| !x.is_empty()).unwrap_or_default(),
            seo_description: [meta("_yoast_wpseo_metadesc"), meta("rank_math_description")].into_iter().find(|x| !x.is_empty()).unwrap_or_default(),
            focus_keyword: [meta("_yoast_wpseo_focuskw"), meta("rank_math_focus_keyword")].into_iter().find(|x| !x.is_empty()).unwrap_or_default(),
            date_created_gmt: v["date_created_gmt"].as_str().map(|d| format!("{d}Z")),
            date_modified_gmt: v["date_modified_gmt"].as_str().map(|d| format!("{d}Z")),
            meta: {
                let md = v["meta_data"].as_array();
                self.custom.get().into_iter().filter_map(|k| md.and_then(|a| a.iter().find(|m| m["key"] == k.as_str())).map(|m| (k, crate::custom_fields::wire_value(&m["value"])))).collect()
            },
        }
    }

    /// Converts our partial product data into a wc/v3 payload.
    async fn to_payload(&self, data: &Map<String, Value>, is_var: bool, refs: &HashMap<String, i64>) -> Result<Value> {
        let resolve = |v: &Value| -> Option<i64> {
            match v {
                Value::String(s) if s.starts_with("ref:") => refs.get(&s[4..]).copied(),
                other => other.as_i64(),
            }
        };
        let mut out = Map::new();
        for (k, v) in data {
            match k.as_str() {
                "name" | "slug" | "status" | "sku" | "global_unique_id" | "regular_price" | "sale_price" | "manage_stock" | "stock_quantity" | "stock_status"
                | "backorders" | "weight" | "shipping_class" | "tax_status" | "tax_class" | "description" | "short_description" | "menu_order" | "featured"
                | "catalog_visibility" | "virtual" | "downloadable" | "external_url" | "button_text" | "type" => {
                    out.insert(k.clone(), v.clone());
                }
                "date_on_sale_from" => {
                    out.insert("date_on_sale_from_gmt".into(), v.as_str().map(|d| json!(d.trim_end_matches('Z'))).unwrap_or(Value::Null));
                }
                "date_on_sale_to" => {
                    out.insert("date_on_sale_to_gmt".into(), v.as_str().map(|d| json!(d.trim_end_matches('Z'))).unwrap_or(Value::Null));
                }
                "length" | "width" | "height" => {
                    let dims = out.entry("dimensions").or_insert_with(|| json!({}));
                    dims[k.as_str()] = v.clone();
                }
                "category_ids" => {
                    let ids: Vec<Value> = v.as_array().into_iter().flatten().filter_map(resolve).map(|id| json!({ "id": id })).collect();
                    out.insert("categories".into(), Value::Array(ids));
                }
                "tags" => {
                    out.insert("tags".into(), Value::Array(v.as_array().into_iter().flatten().map(|n| json!({ "name": n })).collect()));
                }
                "meta" => {
                    let md = out.entry("meta_data").or_insert_with(|| json!([]));
                    for (key, value) in v.as_object().into_iter().flatten() {
                        let value = if value.is_null() { json!("") } else { value.clone() };
                        md.as_array_mut().unwrap().push(json!({ "key": key, "value": value }));
                    }
                }
                "seo_title" | "seo_description" | "focus_keyword" => {
                    let key = match k.as_str() {
                        "seo_title" => "_yoast_wpseo_title",
                        "seo_description" => "_yoast_wpseo_metadesc",
                        _ => "_yoast_wpseo_focuskw",
                    };
                    let md = out.entry("meta_data").or_insert_with(|| json!([]));
                    md.as_array_mut().unwrap().push(json!({ "key": key, "value": v }));
                }
                "attributes" => {
                    self.attr_maps().await?;
                    let guard = self.attrs.read().await;
                    let by_tax = &guard.as_ref().unwrap().0;
                    let arr: Vec<Value> = v
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|a| {
                            let tax = s(&a["taxonomy"]);
                            let mut o = json!({
                                "name": a["name"], "options": a["options"], "visible": a["visible"].as_bool().unwrap_or(true),
                                "variation": a["variation"].as_bool().unwrap_or(false), "position": a["position"].as_i64().unwrap_or(0)
                            });
                            if let Some(id) = by_tax.get(&tax) {
                                o["id"] = json!(id);
                            }
                            o
                        })
                        .collect();
                    out.insert("attributes".into(), Value::Array(arr));
                }
                "variation_attributes" => {
                    self.attr_maps().await?;
                    let guard = self.attrs.read().await;
                    let (by_tax, _, slugs) = guard.as_ref().unwrap();
                    let arr: Vec<Value> = v
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(key, val)| match by_tax.get(key) {
                            Some(id) => {
                                let option = slugs.get(key).and_then(|m| m.iter().find(|(_, slug)| slug.as_str() == s(val)).map(|(n, _)| n.clone())).unwrap_or_else(|| s(val));
                                json!({ "id": id, "option": option })
                            }
                            None => json!({ "name": key, "option": val }),
                        })
                        .collect();
                    out.insert("attributes".into(), Value::Array(arr));
                }
                "image_id" if is_var => {
                    if let Some(id) = resolve(v).filter(|i| *i > 0) {
                        out.insert("image".into(), json!({ "id": id }));
                    }
                }
                "image_url" if is_var => {
                    out.insert("image".into(), json!({ "src": v }));
                }
                _ => {}
            }
        }
        if !is_var && (data.contains_key("image_id") || data.contains_key("gallery_ids") || data.contains_key("image_urls")) {
            let mut imgs = Vec::new();
            if let Some(id) = data.get("image_id").and_then(resolve).filter(|i| *i > 0) {
                imgs.push(json!({ "id": id }));
            }
            for g in data.get("gallery_ids").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = resolve(g) {
                    imgs.push(json!({ "id": id }));
                }
            }
            for u in data.get("image_urls").and_then(Value::as_array).into_iter().flatten() {
                imgs.push(json!({ "src": u }));
            }
            out.insert("images".into(), Value::Array(imgs));
        }
        Ok(Value::Object(out))
    }
}

trait Unzip3<'a, A, B, C> {
    fn unzip3(self) -> (Option<&'a A>, Option<&'a B>, Option<&'a C>);
}
impl<'a, A, B, C> Unzip3<'a, A, B, C> for Option<(&'a A, &'a B, &'a C)> {
    fn unzip3(self) -> (Option<&'a A>, Option<&'a B>, Option<&'a C>) {
        match self {
            Some((a, b, c)) => (Some(a), Some(b), Some(c)),
            None => (None, None, None),
        }
    }
}

#[async_trait]
impl Driver for RestDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities { write: true, media_by_url_only: true, batch_size: 100, write_concurrency: 2, ..Default::default() }
    }

    async fn handshake(&self) -> Result<Handshake> {
        let (sys, _) = self.req(reqwest::Method::GET, "/system_status", &[], None).await?;
        let env = &sys["environment"];
        let settings = &sys["settings"];
        Ok(Handshake {
            home_url: s(&env["home_url"]),
            wp_version: s(&env["wp_version"]),
            wc_version: Some(s(&env["version"])),
            php_version: s(&env["php_version"]),
            site_name: s(&env["site_title"]),
            currency: s(&settings["currency"]),
            currency_symbol: s(&settings["currency_symbol"]),
            price_decimals: settings["number_of_decimals"].as_i64().unwrap_or(2),
            server_time: chrono::Utc::now().timestamp(),
            recommended_batch: 100,
            ..Default::default()
        })
    }

    async fn index(&self) -> Result<Vec<IndexEntry>> {
        // REST has no compact index; fetch ids + modified dates with _fields to keep it light.
        let fields = ("_fields", "id,parent_id,type,date_modified_gmt,variations".to_string());
        let products = self.get_all("/products", &[fields, ("status", "any".into()), ("orderby", "id".into()), ("order", "asc".into())]).await?;
        let mut out = Vec::new();
        for p in products {
            let id = p["id"].as_i64().unwrap_or(0);
            out.push(IndexEntry(id, 0, 0, s(&p["date_modified_gmt"]).replace('T', " ")));
            if p["type"] == "variable" {
                let vars = self.get_all(&format!("/products/{id}/variations"), &[("_fields", "id,date_modified_gmt".into())]).await?;
                for v in vars {
                    out.push(IndexEntry(v["id"].as_i64().unwrap_or(0), id, 1, s(&v["date_modified_gmt"]).replace('T', " ")));
                }
            }
        }
        out.sort_by_key(|e| e.0);
        Ok(out)
    }

    async fn catalog_page(&self, after_id: i64, limit: usize) -> Result<CatalogPage> {
        self.attr_maps().await?;
        // wc/v3 has no keyset pagination, so the cursor is a page number (0 = start). The sync
        // engine treats `next_after` as opaque.
        let per_page = limit.clamp(1, 100);
        let page_no = after_id.max(0) + 1;
        let (v, _) = self
            .req(
                reqwest::Method::GET,
                "/products",
                &[("per_page", per_page.to_string()), ("page", page_no.to_string()), ("orderby", "id".into()), ("order", "asc".into()), ("status", "any".into())],
                None,
            )
            .await?;
        let items: Vec<Value> = v.as_array().cloned().unwrap_or_default();
        let mut page = CatalogPage { server_time: chrono::Utc::now().timestamp(), ..Default::default() };
        for p in &items {
            let prod = self.to_product(p, None).await;
            if prod.kind == "variable" {
                for var in self.get_all(&format!("/products/{}/variations", prod.id), &[]).await? {
                    page.products.push(self.to_product(&var, Some(prod.id)).await);
                }
            }
            for img in p["images"].as_array().into_iter().flatten() {
                page.media.push(Media {
                    id: img["id"].as_i64().unwrap_or(0),
                    url: s(&img["src"]),
                    thumb_url: s(&img["src"]),
                    medium_url: s(&img["src"]),
                    alt: s(&img["alt"]),
                    title: s(&img["name"]),
                    ..Default::default()
                });
            }
            page.products.push(prod);
        }
        page.next_after = if items.len() == per_page { Some(page_no) } else { None };
        page.products.sort_by_key(|p| p.id);
        Ok(page)
    }

    async fn catalog_by_ids(&self, ids: &[i64]) -> Result<CatalogPage> {
        self.attr_maps().await?;
        let mut page = CatalogPage::default();
        for id in ids {
            let (v, _) = self.req(reqwest::Method::GET, &format!("/products/{id}"), &[], None).await?;
            let parent = v["parent_id"].as_i64().filter(|p| *p > 0 && v["type"] == "variation");
            page.products.push(self.to_product(&v, parent).await);
        }
        Ok(page)
    }

    async fn taxonomy(&self) -> Result<Taxonomy> {
        self.attr_maps().await?;
        let cats = self.get_all("/products/categories", &[]).await?;
        let tags = self.get_all("/products/tags", &[]).await?;
        let ship = self.get_all("/products/shipping_classes", &[]).await?;
        let attrs = self.get_all("/products/attributes", &[]).await?;
        let mut tax = Taxonomy::default();
        for c in cats {
            if let Some(img) = c["image"].as_object() {
                tax.media.push(Media { id: img["id"].as_i64().unwrap_or(0), url: s(&img["src"]), thumb_url: s(&img["src"]), medium_url: s(&img["src"]), alt: s(&img["alt"]), ..Default::default() });
            }
            tax.categories.push(Category {
                id: c["id"].as_i64().unwrap_or(0),
                parent: c["parent"].as_i64().unwrap_or(0),
                name: s(&c["name"]),
                slug: s(&c["slug"]),
                description: s(&c["description"]),
                count: c["count"].as_i64().unwrap_or(0),
                display_type: s(&c["display"]),
                image_id: c["image"]["id"].as_i64().unwrap_or(0),
                menu_order: c["menu_order"].as_i64().unwrap_or(0),
                ..Default::default()
            });
        }
        tax.tags = tags.iter().map(|t| Tag { id: t["id"].as_i64().unwrap_or(0), name: s(&t["name"]), slug: s(&t["slug"]), count: t["count"].as_i64().unwrap_or(0) }).collect();
        tax.shipping_classes = ship.iter().map(|t| Term { id: t["id"].as_i64().unwrap_or(0), name: s(&t["name"]), slug: s(&t["slug"]) }).collect();
        for a in attrs {
            let id = a["id"].as_i64().unwrap_or(0);
            let terms = self.get_all(&format!("/products/attributes/{id}/terms"), &[]).await?;
            tax.attributes.push(AttributeTaxonomy {
                id,
                name: s(&a["name"]),
                taxonomy: s(&a["slug"]),
                kind: s(&a["type"]),
                terms: terms.iter().map(|t| Term { id: t["id"].as_i64().unwrap_or(0), name: s(&t["name"]), slug: s(&t["slug"]) }).collect(),
            });
        }
        Ok(tax)
    }

    async fn batch(&self, ops: &[Op], check_conflicts: bool) -> Result<BatchResponse> {
        let mut refs: HashMap<String, i64> = HashMap::new();
        let mut results: Vec<Option<OpResult>> = vec![None; ops.len()];

        // Client-side optimistic concurrency: re-read records that carry a base.
        let mut remote: HashMap<i64, Product> = HashMap::new();
        if check_conflicts {
            let ids: Vec<i64> = ops.iter().filter(|o| !o.base.is_empty() && matches!(o.entity, Entity::Product | Entity::Variation)).filter_map(|o| o.id).collect();
            if !ids.is_empty() {
                for p in self.catalog_by_ids(&ids).await?.products {
                    remote.insert(p.id, p);
                }
            }
        }

        // Categories first (parents before children), one request per depth level.
        let mut pending: Vec<usize> = ops.iter().enumerate().filter(|(_, o)| o.entity == Entity::Category && o.op == OpKind::Upsert).map(|(i, _)| i).collect();
        while !pending.is_empty() {
            let (ready, wait): (Vec<usize>, Vec<usize>) = pending.iter().partition(|&&i| match ops[i].data.get("parent") {
                Some(Value::String(s)) if s.starts_with("ref:") => refs.contains_key(&s[4..]),
                _ => true,
            });
            if ready.is_empty() {
                for i in wait {
                    results[i] = Some(OpResult { r#ref: ops[i].r#ref.clone(), entity: Some(Entity::Category), action: "error".into(), error: Some("Unresolvable parent reference".into()), ..Default::default() });
                }
                break;
            }
            let mut create = vec![];
            let mut update = vec![];
            for &i in &ready {
                let o = &ops[i];
                let mut body = Map::new();
                for (k, v) in &o.data {
                    match k.as_str() {
                        "parent" => {
                            let id = match v {
                                Value::String(s) if s.starts_with("ref:") => refs[&s[4..]],
                                other => other.as_i64().unwrap_or(0),
                            };
                            body.insert("parent".into(), json!(id));
                        }
                        "display_type" => {
                            body.insert("display".into(), v.clone());
                        }
                        "image_id" => {
                            body.insert("image".into(), if v.as_i64().unwrap_or(0) > 0 { json!({ "id": v }) } else { Value::Null });
                        }
                        "name" | "slug" | "description" | "menu_order" => {
                            body.insert(k.clone(), v.clone());
                        }
                        _ => {}
                    }
                }
                match o.id {
                    Some(id) => {
                        body.insert("id".into(), json!(id));
                        update.push((i, Value::Object(body)));
                    }
                    None => create.push((i, Value::Object(body))),
                }
            }
            let payload = json!({ "create": create.iter().map(|x| &x.1).collect::<Vec<_>>(), "update": update.iter().map(|x| &x.1).collect::<Vec<_>>() });
            let (res, _) = self.req(reqwest::Method::POST, "/products/categories/batch", &[], Some(&payload)).await?;
            for (list, key, action) in [(&create, "create", "created"), (&update, "update", "updated")] {
                for (n, (i, _)) in list.iter().enumerate() {
                    let r = &res[key][n];
                    let id = r["id"].as_i64();
                    let err = r["error"]["message"].as_str().map(String::from);
                    if let (Some(rf), Some(id)) = (&ops[*i].r#ref, id) {
                        refs.insert(rf.clone(), id);
                    }
                    results[*i] = Some(OpResult { r#ref: ops[*i].r#ref.clone(), entity: Some(Entity::Category), ok: err.is_none() && id.is_some(), action: if err.is_some() { "error".into() } else { action.into() }, id, error: err, ..Default::default() });
                }
            }
            pending = wait;
        }

        // Products, then variations grouped by parent.
        for entity in [Entity::Product, Entity::Variation] {
            let mut groups: BTreeMap<i64, (Vec<(usize, Value)>, Vec<(usize, Value)>, Vec<(usize, i64)>)> = BTreeMap::new();
            for (i, o) in ops.iter().enumerate().filter(|(_, o)| o.entity == entity) {
                let parent = if entity == Entity::Variation {
                    match o.data.get("parent_id") {
                        Some(Value::String(s)) if s.starts_with("ref:") => refs.get(&s[4..]).copied().unwrap_or(0),
                        Some(v) => v.as_i64().unwrap_or(0),
                        None => remote.get(&o.id.unwrap_or(0)).map(|p| p.parent_id).unwrap_or(0),
                    }
                } else {
                    0
                };
                if entity == Entity::Variation && parent == 0 {
                    results[i] = Some(OpResult { r#ref: o.r#ref.clone(), entity: Some(entity), action: "error".into(), error: Some("Variation has no resolvable parent".into()), ..Default::default() });
                    continue;
                }
                let g = groups.entry(parent).or_default();
                if o.op == OpKind::Delete {
                    if let Some(id) = o.id {
                        g.2.push((i, id));
                    }
                    continue;
                }
                if let (Some(id), true) = (o.id, check_conflicts && !o.base.is_empty()) {
                    if let Some(r) = remote.get(&id) {
                        let rv = serde_json::to_value(r)?;
                        let conflicts: Vec<Conflict> = o
                            .base
                            .iter()
                            .filter(|(f, b)| rv.get(f.as_str()).map(|x| x != *b && Some(x) != o.data.get(f.as_str())).unwrap_or(false))
                            .map(|(f, b)| Conflict { field: f.clone(), base: b.clone(), remote: rv[f.as_str()].clone(), incoming: o.data.get(f).cloned().unwrap_or(Value::Null) })
                            .collect();
                        if !conflicts.is_empty() {
                            results[i] = Some(OpResult { r#ref: o.r#ref.clone(), entity: Some(entity), action: "conflict".into(), id: Some(id), conflicts, ..Default::default() });
                            continue;
                        }
                    }
                }
                let mut id = o.id;
                if id.is_none() {
                    if let Some(sku) = o.r#match.as_ref().and_then(|m| m.get("sku")).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        let (found, _) = self.req(reqwest::Method::GET, "/products", &[("sku", sku.to_string()), ("_fields", "id".into())], None).await?;
                        id = found.as_array().and_then(|a| a.first()).and_then(|p| p["id"].as_i64());
                    }
                }
                let mut payload = self.to_payload(&o.data, entity == Entity::Variation, &refs).await?;
                match id {
                    Some(id) => {
                        payload["id"] = json!(id);
                        g.1.push((i, payload));
                    }
                    None => g.0.push((i, payload)),
                }
            }
            for (parent, (create, update, delete)) in groups {
                let path = if entity == Entity::Variation { format!("/products/{parent}/variations/batch") } else { "/products/batch".into() };
                for chunk_start in (0..create.len().max(update.len()).max(delete.len()).max(1)).step_by(100) {
                    let c: Vec<_> = create.iter().skip(chunk_start).take(100).collect();
                    let u: Vec<_> = update.iter().skip(chunk_start).take(100).collect();
                    let d: Vec<_> = delete.iter().skip(chunk_start).take(100).collect();
                    if c.is_empty() && u.is_empty() && d.is_empty() {
                        continue;
                    }
                    let payload = json!({
                        "create": c.iter().map(|x| &x.1).collect::<Vec<_>>(),
                        "update": u.iter().map(|x| &x.1).collect::<Vec<_>>(),
                        "delete": d.iter().map(|x| x.1).collect::<Vec<_>>(),
                    });
                    let (res, _) = self.req(reqwest::Method::POST, &path, &[], Some(&payload)).await?;
                    for (list, key, action) in [(c.iter().map(|x| x.0).collect::<Vec<_>>(), "create", "created"), (u.iter().map(|x| x.0).collect(), "update", "updated"), (d.iter().map(|x| x.0).collect(), "delete", "deleted")] {
                        for (n, i) in list.into_iter().enumerate() {
                            let r = &res[key][n];
                            let err = r["error"]["message"].as_str().map(String::from);
                            let id = r["id"].as_i64();
                            if let (Some(rf), Some(id)) = (&ops[i].r#ref, id) {
                                refs.insert(rf.clone(), id);
                            }
                            let record = if err.is_none() && action != "deleted" {
                                Some(serde_json::to_value(self.to_product(r, (entity == Entity::Variation).then_some(parent)).await)?)
                            } else {
                                None
                            };
                            results[i] = Some(OpResult { r#ref: ops[i].r#ref.clone(), entity: Some(entity), ok: err.is_none(), action: if err.is_some() { "error".into() } else { action.into() }, id, error: err, record, ..Default::default() });
                        }
                    }
                }
            }
        }

        for (i, o) in ops.iter().enumerate() {
            if results[i].is_none() {
                results[i] = Some(OpResult { r#ref: o.r#ref.clone(), entity: Some(o.entity), action: "error".into(), error: Some(format!("{} operations on {} are not supported over the REST API", if o.op == OpKind::Delete { "Delete" } else { "Upsert" }, o.entity.as_str())), ..Default::default() });
            }
        }
        Ok(BatchResponse { results: results.into_iter().map(Option::unwrap).collect(), refs: refs.into_iter().collect(), elapsed_ms: 0 })
    }

    async fn upload_media(&self, _image: &PreparedImage, _text: &MediaText) -> Result<MediaUploadResult> {
        Err(unsupported("Uploading local images", "REST API"))
    }

    async fn sideload_media(&self, _url: &str, _text: &MediaText) -> Result<MediaUploadResult> {
        Err(unsupported("Server-side image download outside a product save", "REST API"))
    }

    async fn preview(&self, _product_id: Option<i64>, _draft: &Value) -> Result<String> {
        Err(unsupported("Live theme preview", "REST API"))
    }

    fn set_meta_keys(&self, keys: Vec<String>) {
        self.custom.set(keys);
    }

    /// Samples the newest products. wc/v3 hides "protected" keys (starting with `_`), so only
    /// public plugin fields are visible over REST.
    async fn meta_keys(&self) -> Result<Vec<crate::custom_fields::MetaKeyInfo>> {
        let (v, _) = self.req(reqwest::Method::GET, "/products", &[("per_page", "100".into()), ("status", "any".into())], None).await?;
        let mut seen: BTreeMap<String, (i64, Vec<String>)> = BTreeMap::new();
        for p in v.as_array().into_iter().flatten() {
            for m in p["meta_data"].as_array().into_iter().flatten() {
                let e = seen.entry(s(&m["key"])).or_default();
                e.0 += 1;
                let val = if m["value"].is_object() || m["value"].is_array() { "a:0:{}".to_string() } else { s(&m["value"]) };
                if e.1.len() < 6 && !e.1.contains(&val) {
                    e.1.push(val);
                }
            }
        }
        Ok(crate::custom_fields::summarize(seen.into_iter().map(|(k, (c, s))| (k, c, s)).collect(), &HashMap::new()))
    }
}
