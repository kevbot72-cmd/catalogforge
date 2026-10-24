//! Store drivers. Every connection type implements [`Driver`]; the sync engine never needs to know
//! which one it is talking to, only what it [`Capabilities`] says it can do.

use crate::media::PreparedImage;
use crate::model::*;
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod connector;
pub mod local;
pub mod mysql;
pub mod rest;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Capabilities {
    /// Can write products, categories and media.
    pub write: bool,
    /// Server enforces field-level optimistic concurrency (`base` values).
    pub server_conflict_check: bool,
    /// Accepts pre-generated image sizes (no server-side image processing).
    pub presized_media: bool,
    /// Can only reference images by public URL (stock REST API).
    pub media_by_url_only: bool,
    /// Theme-accurate preview URLs.
    pub preview: bool,
    /// Operations per write request.
    pub batch_size: usize,
    /// Parallel write requests that are safe to run.
    pub write_concurrency: usize,
}

/// Text fields sent alongside an image upload.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MediaText {
    pub alt: String,
    pub title: String,
    pub caption: String,
    pub parent_id: i64,
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    async fn handshake(&self) -> Result<Handshake>;
    /// Compact id/modified index of all products and variations.
    async fn index(&self) -> Result<Vec<IndexEntry>>;
    /// Products and variations with `id > after_id`, ascending, at most `limit`.
    async fn catalog_page(&self, after_id: i64, limit: usize) -> Result<CatalogPage>;
    async fn catalog_by_ids(&self, ids: &[i64]) -> Result<CatalogPage>;
    async fn taxonomy(&self) -> Result<Taxonomy>;
    async fn batch(&self, ops: &[Op], check_conflicts: bool) -> Result<BatchResponse>;
    async fn upload_media(&self, image: &PreparedImage, text: &MediaText) -> Result<MediaUploadResult>;
    /// Asks the server to download and register a remote image.
    async fn sideload_media(&self, url: &str, text: &MediaText) -> Result<MediaUploadResult>;
    async fn preview(&self, product_id: Option<i64>, draft: &serde_json::Value) -> Result<String>;
}

pub(crate) fn unsupported(what: &str, kind: &str) -> anyhow::Error {
    anyhow::anyhow!("{what} is not available over a {kind} connection. Install the CatalogForge Connector plugin to enable it.")
}
