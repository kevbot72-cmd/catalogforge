//! Custom fields: product meta added by other plugins (ACF, brands, barcodes, supplier codes…).
//!
//! The user picks which meta keys to manage per store. Drivers then read those keys into
//! `Product::meta`, and the cache exposes each one as a flat field named `meta:<key>` so the grid,
//! staging, undo, conflict checks and import/export treat it like any built-in field. On push the
//! `meta:<key>` fields are folded back into `data.meta`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const META_PREFIX: &str = "meta:";

/// A meta key the user chose to manage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct CustomField {
    pub key: String,
    pub label: String,
    /// text | longtext | number | yesno | date
    pub kind: String,
}

/// A meta key found on the store's products.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct MetaKeyInfo {
    pub key: String,
    /// Products carrying the key.
    pub count: i64,
    pub sample: String,
    /// Field label when a plugin such as ACF names it; empty otherwise.
    pub label: String,
    /// Guessed from the sample values.
    pub kind: String,
    /// Which plugin probably owns it (ACF, Yoast…), when recognisable.
    pub source: String,
}

/// Keys WooCommerce, WordPress or CatalogForge already handle as built-in fields.
pub fn is_internal_key(k: &str) -> bool {
    const EXACT: &[&str] = &[
        "_sku", "_global_unique_id", "_price", "_regular_price", "_sale_price", "_sale_price_dates_from", "_sale_price_dates_to",
        "_manage_stock", "_stock", "_stock_status", "_backorders", "_low_stock_amount", "_sold_individually", "_weight", "_length",
        "_width", "_height", "_tax_status", "_tax_class", "_virtual", "_downloadable", "_downloadable_files", "_download_limit",
        "_download_expiry", "_thumbnail_id", "_product_image_gallery", "_product_attributes", "_default_attributes", "_product_url",
        "_button_text", "_variation_description", "_purchase_note", "_upsell_ids", "_crosssell_ids", "_children", "_featured",
        "_visibility", "_edit_lock", "_edit_last", "_wc_average_rating", "_wc_rating_count", "_wc_review_count", "total_sales",
        "_product_version", "_menu_order", "_wp_old_slug", "_wp_old_date", "_wp_page_template", "_wp_trash_meta_status",
        "_wp_trash_meta_time", "_wp_desired_post_slug", "_encloseme", "_pingme", "_has_variations",
    ];
    const PREFIXES: &[&str] = &["_cf_", "_yoast_wpseo_", "rank_math_", "attribute_", "_wp_", "_oembed_", "_transient", "_wc_", "_woocommerce_"];
    EXACT.contains(&k) || PREFIXES.iter().any(|p| k.starts_with(p))
}

/// PHP-serialized arrays/objects are structured data, not a single editable value.
pub fn is_structured(v: &str) -> bool {
    let v = v.trim_start();
    (v.starts_with("a:") || v.starts_with("O:")) && v.contains('{')
}

pub fn guess_kind(samples: &[&str]) -> String {
    let vals: Vec<&str> = samples.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if vals.is_empty() {
        return "text".into();
    }
    let all = |f: &dyn Fn(&str) -> bool| vals.iter().all(|v| f(v));
    if all(&|v| matches!(v.to_ascii_lowercase().as_str(), "yes" | "no" | "true" | "false" | "on" | "off")) {
        return "yesno".into();
    }
    if all(&|v| v.parse::<f64>().is_ok()) {
        return "number".into();
    }
    if all(&|v| v.len() >= 8 && (chrono::NaiveDate::parse_from_str(&v[..v.len().min(10)], "%Y-%m-%d").is_ok() || (v.len() == 8 && chrono::NaiveDate::parse_from_str(v, "%Y%m%d").is_ok()))) {
        return "date".into();
    }
    if vals.iter().any(|v| v.len() > 120 || v.contains('<') || v.contains('\n')) {
        return "longtext".into();
    }
    "text".into()
}

/// Builds the discovery list from raw (key, count, sample values) rows. ACF stores a hidden
/// `_<key>` → `field_…` reference next to each value; those references give the field's label.
pub fn summarize(rows: Vec<(String, i64, Vec<String>)>, acf_labels: &std::collections::HashMap<String, String>) -> Vec<MetaKeyInfo> {
    let acf_refs: std::collections::HashMap<String, String> = rows
        .iter()
        .filter(|(k, _, s)| k.starts_with('_') && s.iter().any(|v| v.starts_with("field_")))
        .map(|(k, _, s)| (k[1..].to_string(), s.iter().find(|v| v.starts_with("field_")).cloned().unwrap_or_default()))
        .collect();
    let mut out: Vec<MetaKeyInfo> = rows
        .into_iter()
        // Drop ACF's hidden `_key` references, internal keys and structured (array) values.
        .filter(|(k, _, _)| !(k.starts_with('_') && acf_refs.contains_key(&k[1..])))
        .filter(|(k, _, s)| !is_internal_key(k) && !s.iter().any(|v| is_structured(v)))
        .map(|(key, count, samples)| {
            let refs: Vec<&str> = samples.iter().map(String::as_str).collect();
            let acf = acf_refs.get(&key);
            MetaKeyInfo {
                label: acf.and_then(|f| acf_labels.get(f)).cloned().unwrap_or_default(),
                source: if acf.is_some() { "ACF".into() } else { String::new() },
                kind: guess_kind(&refs),
                sample: samples.iter().find(|s| !s.trim().is_empty()).cloned().unwrap_or_default().chars().take(120).collect(),
                key,
                count,
            }
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    out
}

/// Turns `{"meta": {"k": v}}` into top-level `meta:k` fields (cache view of a record).
pub fn flatten_meta(v: &mut Value) {
    if let Some(Value::Object(meta)) = v.as_object_mut().and_then(|o| o.remove("meta")) {
        for (k, val) in meta {
            v[format!("{META_PREFIX}{k}")] = val;
        }
    }
}

/// Moves `meta:k` entries of a write payload into `data.meta.k`.
pub fn fold_meta(data: &mut Map<String, Value>) {
    let keys: Vec<String> = data.keys().filter(|k| k.starts_with(META_PREFIX)).cloned().collect();
    if keys.is_empty() {
        return;
    }
    let mut meta = match data.remove("meta") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    for k in keys {
        if let Some(v) = data.remove(&k) {
            meta.insert(k[META_PREFIX.len()..].to_string(), v);
        }
    }
    data.insert("meta".into(), Value::Object(meta));
}

/// Meta values as WordPress stores them: strings (null deletes the key).
pub fn wire_value(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        Value::String(_) => v.clone(),
        Value::Bool(b) => Value::String(if *b { "yes" } else { "no" }.into()),
        Value::Number(n) => Value::String(n.to_string()),
        other => Value::String(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovers_plugin_fields_and_acf_labels() {
        let rows = vec![
            ("_sku".into(), 10, vec!["A".into()]),
            ("brand".into(), 8, vec!["Acme".into(), "Zed".into()]),
            ("_brand".into(), 8, vec!["field_abc".into()]),
            ("supplier_code".into(), 5, vec!["S-1".into()]),
            ("in_box".into(), 3, vec!["yes".into(), "no".into()]),
            ("pack_qty".into(), 3, vec!["6".into(), "12".into()]),
            ("specs".into(), 2, vec!["a:1:{i:0;s:1:\"x\";}".into()]),
            ("_yoast_wpseo_title".into(), 4, vec!["T".into()]),
        ];
        let labels = std::collections::HashMap::from([("field_abc".to_string(), "Brand".to_string())]);
        let out = summarize(rows, &labels);
        let keys: Vec<&str> = out.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, vec!["brand", "supplier_code", "in_box", "pack_qty"]);
        assert_eq!((out[0].label.as_str(), out[0].source.as_str()), ("Brand", "ACF"));
        assert_eq!(out[2].kind, "yesno");
        assert_eq!(out[3].kind, "number");
    }

    #[test]
    fn flattens_and_folds() {
        let mut v = json!({ "name": "Mug", "meta": { "brand": "Acme" } });
        flatten_meta(&mut v);
        assert_eq!(v, json!({ "name": "Mug", "meta:brand": "Acme" }));
        let mut data = json!({ "name": "Mug", "meta:brand": "Zed", "meta:old": null }).as_object().unwrap().clone();
        fold_meta(&mut data);
        assert_eq!(Value::Object(data), json!({ "name": "Mug", "meta": { "brand": "Zed", "old": null } }));
    }
}
