//! Wire and cache model. Field names match the connector plugin's JSON so records round-trip
//! without translation; the REST and MySQL drivers map into the same shapes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Product {
    pub id: i64,
    pub parent_id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub name: String,
    pub slug: String,
    pub sku: String,
    pub global_unique_id: String,
    pub regular_price: String,
    pub sale_price: String,
    pub date_on_sale_from: Option<String>,
    pub date_on_sale_to: Option<String>,
    pub manage_stock: bool,
    pub stock_quantity: Option<i64>,
    pub stock_status: String,
    pub backorders: String,
    pub weight: String,
    pub length: String,
    pub width: String,
    pub height: String,
    pub shipping_class: String,
    pub tax_status: String,
    pub tax_class: String,
    pub description: String,
    pub short_description: String,
    pub menu_order: i64,
    pub featured: bool,
    pub catalog_visibility: String,
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
    pub downloadable: bool,
    pub category_ids: Vec<i64>,
    pub tags: Vec<String>,
    pub attributes: Vec<ProductAttribute>,
    pub variation_attributes: BTreeMap<String, String>,
    pub image_id: i64,
    pub gallery_ids: Vec<i64>,
    pub external_url: String,
    pub button_text: String,
    pub permalink: String,
    pub seo_title: String,
    pub seo_description: String,
    pub focus_keyword: String,
    pub date_created_gmt: Option<String>,
    pub date_modified_gmt: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub meta: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct ProductAttribute {
    pub name: String,
    /// `pa_*` for global attributes, empty for custom (per-product) attributes.
    pub taxonomy: String,
    pub options: Vec<String>,
    pub visible: bool,
    pub variation: bool,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Category {
    pub id: i64,
    pub parent: i64,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub count: i64,
    pub display_type: String,
    pub image_id: i64,
    pub banner_id: i64,
    pub menu_order: i64,
    pub seo_title: String,
    pub seo_description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Media {
    pub id: i64,
    pub url: String,
    pub thumb_url: String,
    pub medium_url: String,
    pub alt: String,
    pub title: String,
    pub filename: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub sha256: String,
    pub parent_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct AttributeTaxonomy {
    pub id: i64,
    pub name: String,
    pub taxonomy: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub terms: Vec<Term>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Term {
    pub id: i64,
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Taxonomy {
    pub categories: Vec<Category>,
    pub tags: Vec<Tag>,
    pub attributes: Vec<AttributeTaxonomy>,
    pub shipping_classes: Vec<Term>,
    pub tax_classes: Vec<String>,
    pub media: Vec<Media>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct ImageSize {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub crop: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Integrations {
    pub yoast: bool,
    pub rankmath: bool,
    pub wpml: bool,
    pub polylang: bool,
    pub acf: bool,
    pub brands: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Handshake {
    pub protocol: i64,
    pub plugin_version: String,
    pub wp_version: String,
    pub wc_version: Option<String>,
    pub php_version: String,
    pub site_name: String,
    pub home_url: String,
    pub server_time: i64,
    pub hpos: bool,
    pub currency: String,
    pub currency_symbol: String,
    pub price_decimals: i64,
    pub weight_unit: String,
    pub dimension_unit: String,
    pub image_sizes: Vec<ImageSize>,
    pub big_image_threshold: u32,
    pub max_upload_bytes: u64,
    pub recommended_batch: usize,
    pub image_formats: Vec<String>,
    pub integrations: Integrations,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CatalogPage {
    pub products: Vec<Product>,
    pub media: Vec<Media>,
    pub next_after: Option<i64>,
    pub server_time: i64,
}

/// One row of the compact index: id, parent, is_variation, modified (GMT, "Y-m-d H:i:s").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexEntry(pub i64, pub i64, pub u8, pub String);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Entity {
    Category,
    Tag,
    Media,
    Product,
    Variation,
}

impl Entity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Entity::Category => "category",
            Entity::Tag => "tag",
            Entity::Media => "media",
            Entity::Product => "product",
            Entity::Variation => "variation",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "category" => Entity::Category,
            "tag" => Entity::Tag,
            "media" => Entity::Media,
            "product" => Entity::Product,
            "variation" => Entity::Variation,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Upsert,
    Delete,
}

/// A single write operation sent to a driver.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Op {
    pub op: OpKind,
    pub entity: Entity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#match: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub data: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub base: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Conflict {
    pub field: String,
    pub base: Value,
    pub remote: Value,
    pub incoming: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct OpResult {
    pub r#ref: Option<String>,
    pub entity: Option<Entity>,
    pub ok: bool,
    pub action: String,
    pub id: Option<i64>,
    pub error: Option<String>,
    pub conflicts: Vec<Conflict>,
    pub record: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BatchResponse {
    pub results: Vec<OpResult>,
    pub refs: BTreeMap<String, i64>,
    pub elapsed_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MediaUploadResult {
    pub deduplicated: bool,
    pub media: Media,
}
