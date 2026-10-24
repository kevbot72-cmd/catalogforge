//! Driver for the CatalogForge Connector plugin.

use super::{Capabilities, Driver, MediaText};
use crate::media::PreparedImage;
use crate::model::*;
use crate::signing;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use std::io::Write;
use std::time::Duration;

const NS: &str = "/catalogforge/v1";
const GZIP_THRESHOLD: usize = 32 * 1024;

#[derive(Clone)]
pub struct ConnectorDriver {
    client: reqwest::Client,
    /// REST root, e.g. `https://shop.com/wp-json/` or `https://shop.com/?rest_route=/`.
    rest_root: String,
    key: String,
    secret: String,
    /// Sent as the Host header when talking to a Local site's web server directly.
    host_override: Option<String>,
    batch_size: usize,
    custom: super::MetaKeys,
}

impl ConnectorDriver {
    fn meta_param(&self) -> Option<(String, String)> {
        let keys = self.custom.get();
        (!keys.is_empty()).then(|| ("meta_keys".to_string(), keys.join(",")))
    }

    pub fn new(rest_root: &str, key: &str, secret: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("CatalogForge/", env!("CARGO_PKG_VERSION")))
            .gzip(true)
            .build()?;
        Ok(Self {
            client,
            rest_root: normalise_rest_root(rest_root),
            key: key.into(),
            secret: secret.into(),
            host_override: None,
            batch_size: 250,
            custom: Default::default(),
        })
    }

    /// For local development sites: skip any system proxy and accept self-signed certificates.
    pub fn for_local(rest_root: &str, key: &str, secret: &str, host_override: Option<String>) -> Result<Self> {
        let mut d = Self::new(rest_root, key, secret)?;
        d.client = reqwest::Client::builder()
            .no_proxy()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(300))
            .user_agent(concat!("CatalogForge/", env!("CARGO_PKG_VERSION")))
            .gzip(true)
            .build()?;
        d.host_override = host_override;
        Ok(d)
    }

    pub fn with_batch_size(mut self, n: usize) -> Self {
        self.batch_size = n.clamp(1, 2000);
        self
    }

    fn url(&self, route: &str, query: &str) -> String {
        if self.rest_root.contains("rest_route=") {
            let mut u = format!("{}{}{}", self.rest_root, NS.trim_start_matches('/'), route);
            if !query.is_empty() {
                u.push('&');
                u.push_str(query);
            }
            u
        } else {
            let mut u = format!("{}{}{}", self.rest_root, NS.trim_start_matches('/'), route);
            if !query.is_empty() {
                u.push('?');
                u.push_str(query);
            }
            u
        }
    }

    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        route: &str,
        params: &[(String, String)],
        body: Vec<u8>,
        content_type: &str,
        manifest: Option<String>,
        gzip: bool,
    ) -> Result<T> {
        let query = signing::canonical_query(params);
        let manifest = manifest.unwrap_or_default();
        let mut attempt = 0;
        loop {
            attempt += 1;
            let ts = chrono::Utc::now().timestamp();
            let nonce = signing::nonce();
            let canonical = signing::canonical_string(ts, &nonce, method.as_str(), &format!("{NS}{route}"), &query, &body, &manifest);
            let sig = signing::sign(&self.secret, &canonical);
            let mut req = self
                .client
                .request(method.clone(), self.url(route, &query))
                .header("X-CF-Key", &self.key)
                .header("X-CF-Timestamp", ts.to_string())
                .header("X-CF-Nonce", &nonce)
                .header("X-CF-Signature", sig);
            if let Some(host) = &self.host_override {
                req = req.header(reqwest::header::HOST, host);
            }
            if !manifest.is_empty() {
                req = req.header("X-CF-Manifest", &manifest);
            }
            if gzip {
                req = req.header("X-CF-Encoding", "gzip");
            }
            if !body.is_empty() {
                req = req.header(reqwest::header::CONTENT_TYPE, content_type).body(body.clone());
            }
            let res = req.send().await;
            let retryable = match &res {
                Err(e) => e.is_timeout() || e.is_connect() || e.is_request(),
                Ok(r) => r.status().is_server_error() || r.status() == StatusCode::TOO_MANY_REQUESTS,
            };
            if retryable && attempt < 4 {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            let res = res.with_context(|| format!("Could not reach the store at {}", self.rest_root))?;
            let status = res.status();
            let text = res.text().await?;
            if !status.is_success() {
                let msg = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                    .unwrap_or_else(|| text.chars().take(300).collect());
                if status == StatusCode::NOT_FOUND && msg.contains("No route") {
                    bail!("The CatalogForge Connector plugin is not active on this store.");
                }
                bail!("Store returned {status}: {msg}");
            }
            return serde_json::from_str(&text).with_context(|| format!("Unexpected response from {route}: {}", text.chars().take(300).collect::<String>()));
        }
    }

    async fn get<T: DeserializeOwned>(&self, route: &str, params: &[(String, String)]) -> Result<T> {
        self.send(Method::GET, route, params, vec![], "", None, false).await
    }

    async fn post_json<T: DeserializeOwned>(&self, route: &str, value: &serde_json::Value) -> Result<T> {
        let raw = serde_json::to_vec(value)?;
        if raw.len() > GZIP_THRESHOLD {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            enc.write_all(&raw)?;
            self.send(Method::POST, route, &[], enc.finish()?, "application/octet-stream", None, true).await
        } else {
            self.send(Method::POST, route, &[], raw, "application/json", None, false).await
        }
    }

    /// Registers an image that was already written into the site's uploads directory.
    pub async fn register_media(&self, relative_path: &str, image: &PreparedImage, text: &MediaText) -> Result<MediaUploadResult> {
        let sizes: Vec<_> = image
            .sizes
            .iter()
            .map(|s| serde_json::json!({ "name": s.name, "file": s.filename, "width": s.width, "height": s.height, "mime": image.mime }))
            .collect();
        self.post_json(
            "/media/register",
            &serde_json::json!({
                "relative_path": relative_path,
                "sha256": image.sha256,
                "width": image.width,
                "height": image.height,
                "sizes": sizes,
                "alt": text.alt,
                "title": text.title,
                "caption": text.caption,
                "parent_id": text.parent_id,
            }),
        )
        .await
    }
}

pub(crate) fn normalise_rest_root(root: &str) -> String {
    let root = root.trim();
    if root.contains("rest_route=") {
        let base = root.split("rest_route=").next().unwrap_or(root);
        return format!("{base}rest_route=/");
    }
    let mut r = root.trim_end_matches('/').to_string();
    if !r.ends_with("/wp-json") {
        r.push_str("/wp-json");
    }
    r.push('/');
    r
}

#[async_trait]
impl Driver for ConnectorDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            write: true,
            server_conflict_check: true,
            presized_media: true,
            media_by_url_only: false,
            preview: true,
            batch_size: self.batch_size,
            write_concurrency: 2,
        }
    }

    async fn handshake(&self) -> Result<Handshake> {
        self.get("/handshake", &[]).await
    }

    async fn index(&self) -> Result<Vec<IndexEntry>> {
        #[derive(serde::Deserialize)]
        struct R {
            items: Vec<IndexEntry>,
        }
        Ok(self.get::<R>("/index", &[]).await?.items)
    }

    async fn catalog_page(&self, after_id: i64, limit: usize) -> Result<CatalogPage> {
        let mut params = vec![("after_id".into(), after_id.to_string()), ("limit".into(), limit.to_string())];
        params.extend(self.meta_param());
        self.get("/catalog", &params).await
    }

    async fn catalog_by_ids(&self, ids: &[i64]) -> Result<CatalogPage> {
        let mut out = CatalogPage::default();
        for chunk in ids.chunks(500) {
            let csv = chunk.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let mut params = vec![("ids".into(), csv), ("limit".into(), "1000".into())];
            params.extend(self.meta_param());
            let page: CatalogPage = self.get("/catalog", &params).await?;
            out.products.extend(page.products);
            out.media.extend(page.media);
            out.server_time = page.server_time;
        }
        Ok(out)
    }

    async fn taxonomy(&self) -> Result<Taxonomy> {
        self.get("/taxonomy", &[]).await
    }

    async fn batch(&self, ops: &[Op], check_conflicts: bool) -> Result<BatchResponse> {
        self.post_json(
            "/batch",
            &serde_json::json!({
                "ops": ops,
                "options": { "conflicts": if check_conflicts { "check" } else { "overwrite" }, "transaction": true, "return_records": true }
            }),
        )
        .await
    }

    async fn upload_media(&self, image: &PreparedImage, text: &MediaText) -> Result<MediaUploadResult> {
        let mut body = Vec::with_capacity(image.total_bytes());
        let mut parts = vec![serde_json::json!({
            "name": "full", "offset": 0, "length": image.bytes.len(), "width": image.width, "height": image.height, "mime": image.mime
        })];
        body.extend_from_slice(&image.bytes);
        for s in &image.sizes {
            parts.push(serde_json::json!({
                "name": s.name, "offset": body.len(), "length": s.bytes.len(), "width": s.width, "height": s.height, "mime": image.mime
            }));
            body.extend_from_slice(&s.bytes);
        }
        let manifest = serde_json::json!({
            "filename": image.filename,
            "mime": image.mime,
            "sha256": image.sha256,
            "alt": text.alt,
            "title": text.title,
            "caption": text.caption,
            "parent_id": text.parent_id,
            "skip_server_sizes": true,
            "parts": parts,
        });
        let manifest = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&manifest)?);
        self.send(Method::POST, "/media", &[], body, "application/octet-stream", Some(manifest), false).await
    }

    async fn sideload_media(&self, url: &str, text: &MediaText) -> Result<MediaUploadResult> {
        self.post_json("/media/sideload", &serde_json::json!({ "url": url, "alt": text.alt, "title": text.title, "parent_id": text.parent_id })).await
    }

    async fn preview(&self, product_id: Option<i64>, draft: &serde_json::Value) -> Result<String> {
        #[derive(serde::Deserialize)]
        struct R {
            url: String,
        }
        let r: R = self.post_json("/preview", &serde_json::json!({ "product_id": product_id, "data": draft })).await?;
        if r.url.is_empty() {
            return Err(anyhow!("Store did not return a preview URL"));
        }
        Ok(r.url)
    }

    fn set_meta_keys(&self, keys: Vec<String>) {
        self.custom.set(keys);
    }

    async fn meta_keys(&self) -> Result<Vec<crate::custom_fields::MetaKeyInfo>> {
        #[derive(serde::Deserialize)]
        struct R {
            keys: Vec<(String, i64, Vec<String>)>,
            #[serde(default)]
            acf_labels: std::collections::HashMap<String, String>,
        }
        let r: R = self.get("/meta-keys", &[]).await.map_err(|e| anyhow!("{e}. Update the CatalogForge Connector plugin to 0.2 or later to use custom fields."))?;
        Ok(crate::custom_fields::summarize(r.keys, &r.acf_labels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rest_roots() {
        assert_eq!(normalise_rest_root("https://a.com"), "https://a.com/wp-json/");
        assert_eq!(normalise_rest_root("https://a.com/wp-json/"), "https://a.com/wp-json/");
        assert_eq!(normalise_rest_root("https://a.com/?rest_route=/"), "https://a.com/?rest_route=/");
        let d = ConnectorDriver::new("https://a.com/?rest_route=/", "k", "s").unwrap();
        assert_eq!(d.url("/catalog", "limit=5"), "https://a.com/?rest_route=/catalogforge/v1/catalog&limit=5");
        let d = ConnectorDriver::new("https://a.com/shop", "k", "s").unwrap();
        assert_eq!(d.url("/catalog", "limit=5"), "https://a.com/shop/wp-json/catalogforge/v1/catalog?limit=5");
    }
}
