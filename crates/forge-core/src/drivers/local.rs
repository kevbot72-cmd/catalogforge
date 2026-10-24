//! Local (Flywheel) driver: zero-configuration access to a site running in Local on this machine.
//!
//! * Reads: straight from the site's MySQL (socket or dynamic port) — no HTTP at all.
//! * Writes: through the connector plugin, which this driver installs, activates and keys by
//!   itself (it has the site's files and database, so the user never copies a key).
//! * Media: files are written directly into `wp-content/uploads/YYYY/MM` and only *registered*
//!   over HTTP, so image imports run at disk speed.

use super::connector::ConnectorDriver;
use super::mysql::{MysqlDriver, MysqlTarget};
use super::{Capabilities, Driver, MediaText};
use crate::local::{install_connector_files, LocalSite, SiteStatus};
use crate::media::PreparedImage;
use crate::model::*;
use crate::phpser;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const PLUGIN_FILE: &str = "catalogforge-connector/catalogforge-connector.php";

/// Credentials the app keeps for a provisioned Local site.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalKey {
    pub key: String,
    pub secret: String,
}

pub struct LocalDriver {
    site: LocalSite,
    reader: MysqlDriver,
    connector: Arc<ConnectorDriver>,
}

impl LocalDriver {
    /// Opens the site, provisioning the connector when needed. `known_key` is the key saved from a
    /// previous session; the returned key must be persisted by the caller.
    pub async fn open(site: LocalSite, plugin_src: Option<&Path>, known_key: Option<LocalKey>) -> Result<(Self, LocalKey)> {
        if site.status == SiteStatus::Halted {
            bail!("\"{}\" is stopped. Start it in Local (or click Start site) and try again.", site.name);
        }
        if !site.has_woocommerce {
            bail!("\"{}\" does not have WooCommerce installed.", site.name);
        }
        let target = MysqlTarget {
            host: "127.0.0.1".into(),
            port: site.mysql_port.unwrap_or(3306),
            socket: site.mysql_socket.as_ref().map(|p| p.to_string_lossy().into_owned()),
            user: site.db.user.clone(),
            password: site.db.password.clone(),
            database: site.db.database.clone(),
            table_prefix: site.table_prefix.clone(),
        };
        let bootstrap = MysqlDriver::connect(&target, None).await.context("Connecting to the Local site's database")?;

        if let Some(src) = plugin_src {
            install_connector_files(&site, src).context("Installing the connector plugin into the site")?;
        } else if !site.connector_installed {
            bail!("The connector plugin is not installed in this site and no bundled copy was provided.");
        }
        activate_plugin(&bootstrap).await?;
        let key = ensure_key(&bootstrap, known_key).await?;

        let (rest_root, host) = match site.direct_url() {
            Some(direct) => (format!("{direct}/?rest_route=/"), Some(site.domain.clone())),
            None => (format!("{}/?rest_route=/", site.url()), None),
        };
        let connector = Arc::new(ConnectorDriver::for_local(&rest_root, &key.key, &key.secret, host)?.with_batch_size(500));
        let reader = MysqlDriver::connect(&target, Some(connector.clone() as Arc<dyn Driver>)).await?;
        Ok((Self { site, reader, connector }, key))
    }

    pub fn site(&self) -> &LocalSite {
        &self.site
    }

    /// Writes the prepared files into uploads/YYYY/MM with WordPress-style unique names.
    fn write_files(&self, image: &PreparedImage) -> Result<(String, PreparedImage)> {
        let now = chrono::Utc::now();
        let sub = format!("{}/{}", now.format("%Y"), now.format("%m"));
        let dir = self.site.uploads_dir().join(&sub);
        std::fs::create_dir_all(&dir).with_context(|| format!("Creating {}", dir.display()))?;
        let (stem, ext) = image.filename.rsplit_once('.').unwrap_or((&image.filename, "jpg"));
        let mut unique = stem.to_string();
        let mut n = 1;
        while dir.join(format!("{unique}.{ext}")).exists() {
            unique = format!("{stem}-{n}");
            n += 1;
        }
        let mut out = image.clone();
        out.filename = format!("{unique}.{ext}");
        std::fs::write(dir.join(&out.filename), &image.bytes)?;
        for s in out.sizes.iter_mut() {
            s.filename = format!("{unique}-{}x{}.{ext}", s.width, s.height);
            std::fs::write(dir.join(&s.filename), &s.bytes)?;
        }
        Ok((format!("{sub}/{}", out.filename), out))
    }
}

async fn activate_plugin(db: &MysqlDriver) -> Result<()> {
    let raw = db.option("active_plugins").await?.unwrap_or_default();
    let mut list = phpser::parse_string_list(&raw).context("Reading active_plugins")?;
    if !list.iter().any(|p| p == PLUGIN_FILE) {
        list.push(PLUGIN_FILE.to_string());
        list.sort();
        db.set_option("active_plugins", &phpser::serialize_string_list(&list), true).await?;
    }
    Ok(())
}

async fn ensure_key(db: &MysqlDriver, known: Option<LocalKey>) -> Result<LocalKey> {
    let raw = db.option("catalogforge_keys").await?.unwrap_or_else(|| "{}".into());
    let mut keys: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw).unwrap_or_default();
    if let Some(k) = known {
        if keys.get(&k.key).and_then(|v| v.get("secret")).and_then(|s| s.as_str()) == Some(k.secret.as_str()) {
            return Ok(k);
        }
    }
    // Bind the key to the lowest-ID administrator.
    let p = db.prefix();
    let admin: Option<u64> = sqlx::query(&format!(
        "SELECT user_id FROM {p}usermeta WHERE meta_key = '{p}capabilities' AND meta_value LIKE '%\"administrator\"%' ORDER BY user_id LIMIT 1"
    ))
    .fetch_optional(db.pool())
    .await?
    .map(|r| r.get::<u64, _>(0));
    let admin = admin.context("No administrator account found in this site")?;
    let key = LocalKey { key: format!("cf_local_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]), secret: hex::encode(rand::random::<[u8; 32]>()) };
    keys.insert(
        key.key.clone(),
        serde_json::json!({ "secret": key.secret, "user_id": admin, "label": "CatalogForge (Local)", "created": chrono::Utc::now().timestamp() }),
    );
    db.set_option("catalogforge_keys", &serde_json::Value::Object(keys).to_string(), false).await?;
    Ok(key)
}

#[async_trait]
impl Driver for LocalDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities { write_concurrency: 4, ..self.connector.capabilities() }
    }
    async fn handshake(&self) -> Result<Handshake> {
        self.connector.handshake().await
    }
    async fn index(&self) -> Result<Vec<IndexEntry>> {
        self.reader.index().await
    }
    async fn catalog_page(&self, after_id: i64, limit: usize) -> Result<CatalogPage> {
        self.reader.catalog_page(after_id, limit).await
    }
    async fn catalog_by_ids(&self, ids: &[i64]) -> Result<CatalogPage> {
        self.reader.catalog_by_ids(ids).await
    }
    async fn taxonomy(&self) -> Result<Taxonomy> {
        self.reader.taxonomy().await
    }
    async fn batch(&self, ops: &[Op], check_conflicts: bool) -> Result<BatchResponse> {
        self.connector.batch(ops, check_conflicts).await
    }
    async fn upload_media(&self, image: &PreparedImage, text: &MediaText) -> Result<MediaUploadResult> {
        let (relative, written) = self.write_files(image)?;
        let res = self.connector.register_media(&relative, &written, text).await;
        if matches!(&res, Ok(r) if r.deduplicated) {
            // The store already had this image; remove the copies we just wrote.
            let dir = self.site.uploads_dir().join(relative.rsplit_once('/').map(|(d, _)| d).unwrap_or(""));
            let _ = std::fs::remove_file(dir.join(&written.filename));
            for s in &written.sizes {
                let _ = std::fs::remove_file(dir.join(&s.filename));
            }
        }
        res
    }
    async fn sideload_media(&self, url: &str, text: &MediaText) -> Result<MediaUploadResult> {
        self.connector.sideload_media(url, text).await
    }
    async fn preview(&self, product_id: Option<i64>, draft: &serde_json::Value) -> Result<String> {
        self.connector.preview(product_id, draft).await
    }
}

/// Location of the connector plugin bundled with the app.
pub fn bundled_plugin_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join("catalogforge-connector")
}
