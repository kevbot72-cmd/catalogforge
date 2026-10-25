//! Tauri command layer: a thin bridge from the UI to forge-core.

use forge_core::cache::{Cache, Edit, ProductQuery, StagedSummary};
use forge_core::connection::{ConnectionKind, Environment, ProfileStore, SecretStore, StoreProfile};
use forge_core::drivers::connector::ConnectorDriver;
use forge_core::drivers::local::{LocalDriver, LocalKey};
use forge_core::drivers::mysql::{MysqlDriver, MysqlTarget};
use forge_core::drivers::rest::RestDriver;
use forge_core::drivers::{Capabilities, Driver};
use forge_core::media::MediaSettings;
use forge_core::model::{Entity, Handshake};
use forge_core::sync::{self, CloneOptions, Progress, ProgressFn};
use forge_core::{local, signing};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

struct OpenStore {
    driver: Arc<dyn Driver>,
    cache: Arc<Mutex<Cache>>,
}

struct AppState {
    data_dir: PathBuf,
    plugin_dir: Option<PathBuf>,
    profiles: ProfileStore,
    secrets: SecretStore,
    open: tokio::sync::Mutex<HashMap<String, Arc<OpenStore>>>,
    settings: Mutex<MediaSettings>,
}

impl AppState {
    fn cache_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("stores").join(id).join("catalog.db")
    }

    async fn build_driver(&self, p: &StoreProfile) -> anyhow::Result<Arc<dyn Driver>> {
        let secret = || self.secrets.get(&p.secret_ref());
        Ok(match &p.connection {
            ConnectionKind::Connector { base_url, key } => Arc::new(ConnectorDriver::new(base_url, key, &secret()?)?),
            ConnectionKind::Rest { base_url, consumer_key } => Arc::new(RestDriver::new(base_url, consumer_key, &secret()?)?),
            ConnectionKind::Mysql { host, port, database, user, table_prefix, socket, write_via } => {
                let writer: Option<Arc<dyn Driver>> = match write_via.as_deref() {
                    Some(ConnectionKind::Connector { base_url, key }) => Some(Arc::new(ConnectorDriver::new(base_url, key, &self.secrets.get(&format!("{}:writer", p.secret_ref()))?)?)),
                    _ => None,
                };
                let target = MysqlTarget { host: host.clone(), port: *port, socket: socket.clone(), user: user.clone(), password: secret()?, database: database.clone(), table_prefix: table_prefix.clone() };
                Arc::new(MysqlDriver::connect(&target, writer).await?)
            }
            ConnectionKind::Local { site_id } => {
                let dir = local::default_data_dir().ok_or_else(|| anyhow::anyhow!("Cannot locate Local's data directory"))?;
                let site = local::find_site(&dir, site_id)?;
                let known: Option<LocalKey> = secret().ok().and_then(|s| serde_json::from_str(&s).ok());
                let (driver, key) = LocalDriver::open(site, self.plugin_dir.as_deref(), known).await?;
                self.secrets.set(&p.secret_ref(), &serde_json::to_string(&key)?)?;
                Arc::new(driver)
            }
        })
    }

    async fn store(&self, id: &str) -> CmdResult<Arc<OpenStore>> {
        let mut open = self.open.lock().await;
        if let Some(s) = open.get(id) {
            return Ok(s.clone());
        }
        let profile = self.profiles.get(id).map_err(err)?;
        let driver = self.build_driver(&profile).await.map_err(err)?;
        driver.set_meta_keys(profile.custom_fields.iter().map(|f| f.key.clone()).collect());
        let cache = Cache::open(&self.cache_path(id)).map_err(err)?;
        let s = Arc::new(OpenStore { driver, cache: Arc::new(Mutex::new(cache)) });
        open.insert(id.to_string(), s.clone());
        Ok(s)
    }
}

fn progress_fn(app: &AppHandle, store_id: &str) -> ProgressFn {
    let app = app.clone();
    let id = store_id.to_string();
    Arc::new(move |p: Progress| {
        let _ = app.emit("progress", json!({ "store_id": id, "progress": p }));
    })
}

/* ------------------------------------------------------------------ stores */

#[tauri::command]
fn list_stores(state: State<'_, AppState>) -> CmdResult<Vec<StoreProfile>> {
    state.profiles.list().map_err(err)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum NewConnection {
    Connector { connection_string: String },
    Rest { base_url: String, consumer_key: String, consumer_secret: String },
    Mysql { host: String, port: u16, database: String, user: String, password: String, table_prefix: String, connection_string: Option<String> },
    Local { site_id: String },
}

#[derive(Deserialize)]
struct NewStore {
    name: String,
    environment: Environment,
    color: String,
    connection: NewConnection,
}

#[tauri::command]
async fn add_store(state: State<'_, AppState>, input: NewStore) -> CmdResult<StoreProfile> {
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let mut profile = StoreProfile {
        id: id.clone(),
        name: input.name.clone(),
        environment: input.environment,
        color: input.color.clone(),
        connection: ConnectionKind::Local { site_id: String::new() },
        created_at: chrono::Utc::now().timestamp(),
        last_synced_at: None,
        custom_fields: Vec::new(),
    };
    let secret_ref = profile.secret_ref();
    match input.connection {
        NewConnection::Connector { connection_string } => {
            let c = signing::parse_connection_string(&connection_string).map_err(err)?;
            profile.connection = ConnectionKind::Connector { base_url: c.rest.clone(), key: c.key.clone() };
            state.secrets.set(&secret_ref, &c.secret).map_err(err)?;
        }
        NewConnection::Rest { base_url, consumer_key, consumer_secret } => {
            profile.connection = ConnectionKind::Rest { base_url, consumer_key };
            state.secrets.set(&secret_ref, &consumer_secret).map_err(err)?;
        }
        NewConnection::Mysql { host, port, database, user, password, table_prefix, connection_string } => {
            let write_via = match connection_string.filter(|s| !s.trim().is_empty()) {
                Some(cs) => {
                    let c = signing::parse_connection_string(&cs).map_err(err)?;
                    state.secrets.set(&format!("{secret_ref}:writer"), &c.secret).map_err(err)?;
                    Some(Box::new(ConnectionKind::Connector { base_url: c.rest, key: c.key }))
                }
                None => None,
            };
            profile.connection = ConnectionKind::Mysql { host, port, database, user, table_prefix, socket: None, write_via };
            state.secrets.set(&secret_ref, &password).map_err(err)?;
        }
        NewConnection::Local { site_id } => {
            profile.connection = ConnectionKind::Local { site_id };
        }
    }
    // Verify before saving so a typo never leaves a broken store in the switcher.
    let driver = state.build_driver(&profile).await.map_err(|e| {
        let _ = state.secrets.delete(&secret_ref);
        err(e)
    })?;
    let hs = driver.handshake().await.map_err(err)?;
    if profile.name.trim().is_empty() {
        profile.name = hs.site_name.clone();
    }
    state.profiles.upsert(profile.clone()).map_err(err)?;
    Ok(profile)
}

#[tauri::command]
async fn remove_store(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.open.lock().await.remove(&id);
    if let Ok(p) = state.profiles.get(&id) {
        let _ = state.secrets.delete(&p.secret_ref());
        let _ = state.secrets.delete(&format!("{}:writer", p.secret_ref()));
    }
    state.profiles.remove(&id).map_err(err)?;
    let _ = std::fs::remove_dir_all(state.data_dir.join("stores").join(&id));
    Ok(())
}

#[tauri::command]
fn local_sites() -> CmdResult<Vec<local::LocalSite>> {
    let dir = local::default_data_dir().ok_or("Cannot locate Local's data directory")?;
    local::discover(&dir).map_err(err)
}

#[tauri::command]
async fn start_local_site(site_id: String) -> CmdResult<()> {
    let dir = local::default_data_dir().ok_or("Cannot locate Local's data directory")?;
    local::start_site(&dir, &site_id).await.map_err(err)
}

#[derive(Serialize)]
struct StoreInfo {
    profile: StoreProfile,
    handshake: Option<Handshake>,
    capabilities: Capabilities,
    product_count: usize,
    last_pull: Option<i64>,
}

#[tauri::command]
async fn open_store(state: State<'_, AppState>, id: String) -> CmdResult<StoreInfo> {
    let s = state.store(&id).await?;
    let profile = state.profiles.get(&id).map_err(err)?;
    let c = s.cache.lock().unwrap();
    Ok(StoreInfo {
        profile,
        handshake: c.kv_get("handshake").map_err(err)?.and_then(|h| serde_json::from_str(&h).ok()),
        capabilities: s.driver.capabilities(),
        product_count: c.product_count().map_err(err)?,
        last_pull: c.kv_get("last_pull").map_err(err)?.and_then(|v| v.parse().ok()),
    })
}

#[tauri::command]
async fn pull(app: AppHandle, state: State<'_, AppState>, id: String, full: bool) -> CmdResult<sync::PullReport> {
    let s = state.store(&id).await?;
    let report = sync::pull(s.driver.as_ref(), &s.cache, full, progress_fn(&app, &id)).await.map_err(err)?;
    if let Ok(mut p) = state.profiles.get(&id) {
        p.last_synced_at = Some(chrono::Utc::now().timestamp());
        let _ = state.profiles.upsert(p);
    }
    Ok(report)
}

/* ---------------------------------------------------------- custom fields */

#[tauri::command]
async fn meta_keys(state: State<'_, AppState>, id: String) -> CmdResult<Vec<forge_core::custom_fields::MetaKeyInfo>> {
    let s = state.store(&id).await?;
    s.driver.meta_keys().await.map_err(err)
}

/// Saves the store's custom fields. The caller re-pulls so products pick up the new fields.
#[tauri::command]
async fn set_custom_fields(state: State<'_, AppState>, id: String, fields: Vec<forge_core::custom_fields::CustomField>) -> CmdResult<StoreProfile> {
    let s = state.store(&id).await?;
    let mut p = state.profiles.get(&id).map_err(err)?;
    s.driver.set_meta_keys(fields.iter().map(|f| f.key.clone()).collect());
    p.custom_fields = fields;
    state.profiles.upsert(p.clone()).map_err(err)?;
    Ok(p)
}

/* ---------------------------------------------------------------- catalog */

#[tauri::command]
async fn query(state: State<'_, AppState>, id: String, q: ProductQuery) -> CmdResult<forge_core::cache::QueryResult> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.query(&q).map_err(err)
}

#[tauri::command]
async fn rows(state: State<'_, AppState>, id: String, keys: Vec<String>) -> CmdResult<Vec<forge_core::cache::ProductRow>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.rows(&keys).map_err(err)
}

#[tauri::command]
async fn skus(state: State<'_, AppState>, id: String) -> CmdResult<Vec<(String, i64, String)>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.sku_index().map_err(err)
}

#[tauri::command]
async fn variations(state: State<'_, AppState>, id: String, parent_key: String) -> CmdResult<Vec<forge_core::cache::ProductRow>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    let keys = c.variation_keys(&parent_key).map_err(err)?;
    c.rows(&keys).map_err(err)
}

#[tauri::command]
async fn taxonomy(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    let shipping: Value = c.kv_get("shipping_classes").map_err(err)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(json!([]));
    let tax: Value = c.kv_get("tax_classes").map_err(err)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(json!([]));
    let brands: Value = c.kv_get("brands").map_err(err)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(json!([]));
    Ok(json!({
        "brands": brands,
        "categories": c.category_rows().map_err(err)?,
        "tags": c.tags().map_err(err)?,
        "attributes": c.attributes().map_err(err)?,
        "shipping_classes": shipping,
        "tax_classes": tax,
    }))
}

#[tauri::command]
async fn media(state: State<'_, AppState>, id: String) -> CmdResult<Vec<forge_core::model::Media>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.all_media().map_err(err)
}

/* ---------------------------------------------------------------- staging */

#[tauri::command]
async fn stage(state: State<'_, AppState>, id: String, edits: Vec<Edit>) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.stage(&edits).map_err(err)?;
    c.summary().map_err(err)
}

#[derive(Deserialize)]
struct CreateItem {
    entity: Entity,
    key: Option<String>,
    fields: Map<String, Value>,
}

#[tauri::command]
async fn create(state: State<'_, AppState>, id: String, items: Vec<CreateItem>) -> CmdResult<Vec<String>> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.create_many(items.into_iter().map(|i| (i.entity, i.key, i.fields)).collect()).map_err(err)
}

#[tauri::command]
async fn remove(state: State<'_, AppState>, id: String, entity: Entity, keys: Vec<String>) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.stage_delete(entity, &keys).map_err(err)?;
    c.summary().map_err(err)
}

#[tauri::command]
async fn undo(state: State<'_, AppState>, id: String) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.undo().map_err(err)?;
    c.summary().map_err(err)
}

#[tauri::command]
async fn discard(state: State<'_, AppState>, id: String, entity: Option<Entity>, key: Option<String>, field: Option<String>) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.discard(entity, key.as_deref(), field.as_deref()).map_err(err)?;
    c.summary().map_err(err)
}

#[tauri::command]
async fn summary(state: State<'_, AppState>, id: String) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.summary().map_err(err)
}

#[tauri::command]
async fn changes(state: State<'_, AppState>, id: String) -> CmdResult<Vec<forge_core::cache::StagedChange>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.changes().map_err(err)
}

#[tauri::command]
async fn resolve_conflict(state: State<'_, AppState>, id: String, entity: Entity, key: String, field: String, keep_mine: bool) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.resolve_conflict(entity, &key, &field, keep_mine).map_err(err)?;
    c.summary().map_err(err)
}

#[tauri::command]
async fn push(app: AppHandle, state: State<'_, AppState>, id: String, label: String) -> CmdResult<sync::PushReport> {
    let s = state.store(&id).await?;
    let settings = state.settings.lock().unwrap().clone();
    sync::push(s.driver.as_ref(), &s.cache, &settings, &label, progress_fn(&app, &id)).await.map_err(err)
}

#[tauri::command]
async fn history(state: State<'_, AppState>, id: String) -> CmdResult<Vec<forge_core::cache::HistoryEntry>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.history(200).map_err(err)
}

#[tauri::command]
async fn history_items(state: State<'_, AppState>, id: String, history_id: i64) -> CmdResult<Vec<forge_core::cache::HistoryItem>> {
    let s = state.store(&id).await?;
    let c = s.cache.lock().unwrap();
    c.history_items(history_id).map_err(err)
}

#[tauri::command]
async fn revert(state: State<'_, AppState>, id: String, history_id: i64) -> CmdResult<StagedSummary> {
    let s = state.store(&id).await?;
    let mut c = s.cache.lock().unwrap();
    c.stage_revert(history_id).map_err(err)?;
    c.summary().map_err(err)
}

#[tauri::command]
async fn preview(state: State<'_, AppState>, id: String, product_id: Option<i64>, draft: Value) -> CmdResult<String> {
    let s = state.store(&id).await?;
    s.driver.preview(product_id, &draft).await.map_err(err)
}

/* -------------------------------------------------------------- migration */

/// Both stores' caches, refusing the same store twice.
async fn two_stores(state: &AppState, src: &str, dst: &str) -> CmdResult<(Arc<OpenStore>, Arc<OpenStore>)> {
    let a = state.store(src).await?;
    let b = state.store(dst).await?;
    if Arc::ptr_eq(&a.cache, &b.cache) {
        return Err("Choose two different stores".into());
    }
    Ok((a, b))
}

#[tauri::command]
async fn migration_preview(state: State<'_, AppState>, src: String, dst: String, opts: forge_core::migrate::MigrateOptions) -> CmdResult<forge_core::migrate::MigrationSummary> {
    let (a, b) = two_stores(&state, &src, &dst).await?;
    let (ac, bc) = (a.cache.lock().unwrap(), b.cache.lock().unwrap());
    forge_core::migrate::plan(&ac, &src, &bc, &opts).map(|(s, _)| s).map_err(err)
}

#[tauri::command]
async fn migration_stage(state: State<'_, AppState>, src: String, dst: String, opts: forge_core::migrate::MigrateOptions) -> CmdResult<forge_core::migrate::MigrationSummary> {
    let (a, b) = two_stores(&state, &src, &dst).await?;
    let ac = a.cache.lock().unwrap();
    let mut bc = b.cache.lock().unwrap();
    forge_core::migrate::stage(&ac, &src, &mut bc, &opts).map_err(err)
}

#[tauri::command]
async fn migration_verify(state: State<'_, AppState>, src: String, dst: String, opts: forge_core::migrate::MigrateOptions) -> CmdResult<forge_core::migrate::VerifyReport> {
    let (a, b) = two_stores(&state, &src, &dst).await?;
    let (ac, bc) = (a.cache.lock().unwrap(), b.cache.lock().unwrap());
    forge_core::migrate::verify(&ac, &bc, &opts).map_err(err)
}

#[tauri::command]
async fn clone_products(state: State<'_, AppState>, src: String, dst: String, ids: Vec<i64>, opts: CloneOptions) -> CmdResult<sync::CloneReport> {
    let a = state.store(&src).await?;
    let b = state.store(&dst).await?;
    if Arc::ptr_eq(&a.cache, &b.cache) {
        return Err("Choose a different destination store".into());
    }
    let src_cache = a.cache.lock().unwrap();
    let mut dst_cache = b.cache.lock().unwrap();
    sync::clone_products(&src_cache, &src, &mut dst_cache, &ids, &opts).map_err(err)
}

/* ------------------------------------------------------------------ files */

#[derive(Serialize)]
struct LocalFileInfo {
    path: String,
    name: String,
    size: u64,
}

#[tauri::command]
fn scan_paths(paths: Vec<String>) -> Vec<LocalFileInfo> {
    let mut out = Vec::new();
    for p in paths {
        let path = PathBuf::from(&p);
        let files = if path.is_dir() { forge_core::media::scan_folder(&path) } else { vec![path] };
        for f in files {
            let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            out.push(LocalFileInfo { name: f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: f.to_string_lossy().into_owned(), size });
        }
    }
    out
}

/// Image locations typed in a spreadsheet. Accepts a missing extension (C:\\Images\\shoe-1 finds shoe-1.jpg).
#[tauri::command]
fn resolve_image_paths(paths: Vec<String>) -> Vec<Option<LocalFileInfo>> {
    const EXTS: [&str; 7] = ["jpg", "jpeg", "png", "webp", "gif", "avif", "JPG"];
    paths
        .iter()
        .map(|p| {
            let raw = p.trim();
            let expanded = match raw.strip_prefix("~/") {
                Some(rest) => std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| PathBuf::from(h).join(rest))?,
                None => PathBuf::from(raw),
            };
            let found = if expanded.is_file() {
                Some(expanded.clone())
            } else {
                EXTS.iter().map(|e| PathBuf::from(format!("{}.{e}", expanded.display()))).find(|c| c.is_file())
            }?;
            let size = std::fs::metadata(&found).map(|m| m.len()).unwrap_or(0);
            Some(LocalFileInfo { name: found.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: found.to_string_lossy().into_owned(), size })
        })
        .collect()
}

/// A product photo for a catalogue PDF: downloaded (http/https) or read from disk, then shrunk to
/// an upright JPEG of at most `max` px.
#[tauri::command]
async fn catalogue_image(src: String, max: u32, quality: u8) -> CmdResult<tauri::ipc::Response> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let bytes = if src.starts_with("http://") || src.starts_with("https://") {
        let client = CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(45))
                // Local sites use self-signed certificates; these are public product images.
                .danger_accept_invalid_certs(true)
                .user_agent(concat!("CatalogForge/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client")
        });
        let res = client.get(&src).send().await.map_err(err)?;
        if !res.status().is_success() {
            return Err(format!("{} returned {}", src, res.status()));
        }
        res.bytes().await.map_err(err)?.to_vec()
    } else {
        tokio::fs::read(&src).await.map_err(err)?
    };
    let jpeg = tokio::task::spawn_blocking(move || forge_core::media::print_jpeg(&bytes, max.clamp(64, 4000), quality)).await.map_err(err)?.map_err(err)?;
    Ok(tauri::ipc::Response::new(jpeg))
}

#[tauri::command]
fn read_file(path: String) -> CmdResult<tauri::ipc::Response> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(err)
}

/// Writes an export chosen through the Save dialog. The file bytes arrive as the raw request body
/// and the destination path in the `x-path` header.
#[tauri::command]
fn write_file(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|p| percent_decode(p))
        .ok_or("Missing destination path")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw file bytes".into());
    };
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {path}: {e}"))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn get_media_settings(state: State<'_, AppState>) -> MediaSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_media_settings(state: State<'_, AppState>, settings: MediaSettings) -> CmdResult<()> {
    std::fs::write(state.data_dir.join("media-settings.json"), serde_json::to_vec_pretty(&settings).map_err(err)?).map_err(err)?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn resolves_image_locations_with_or_without_extension() {
        let dir = std::env::temp_dir().join(format!("cf-resolve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shoe-1.jpg"), b"x").unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        let out = super::resolve_image_paths(vec![p("shoe-1.jpg"), p("shoe-1"), p("missing.jpg")]);
        assert_eq!(out[0].as_ref().unwrap().name, "shoe-1.jpg");
        assert_eq!(out[1].as_ref().unwrap().path, p("shoe-1.jpg"));
        assert!(out[2].is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decodes_encoded_paths() {
        // encodeURIComponent("C:\\Users\\kevbo\\Documents\\products é.xlsx")
        assert_eq!(super::percent_decode("C%3A%5CUsers%5Ckevbo%5CDocuments%5Cproducts%20%C3%A9.xlsx"), "C:\\Users\\kevbo\\Documents\\products é.xlsx");
        assert_eq!(super::percent_decode("/Users/kev/a%2Bb.csv"), "/Users/kev/a+b.csv");
        assert_eq!(super::percent_decode(""), "");
        assert_eq!(super::percent_decode("50%"), "50%");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let plugin_dir = app
                .path()
                .resource_dir()
                .ok()
                .map(|r| forge_core::drivers::local::bundled_plugin_dir(&r))
                .filter(|p| p.join("catalogforge-connector.php").exists());
            let settings = std::fs::read(data_dir.join("media-settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            app.manage(AppState {
                profiles: ProfileStore::new(&data_dir),
                secrets: SecretStore::new(&data_dir),
                open: tokio::sync::Mutex::new(HashMap::new()),
                settings: Mutex::new(settings),
                plugin_dir,
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_stores, add_store, remove_store, local_sites, start_local_site, open_store, pull, query, rows, skus, variations, taxonomy, media, stage, create,
            remove, undo, discard, summary, changes, resolve_conflict, push, history, history_items, revert, preview, clone_products, migration_preview, migration_stage, migration_verify, scan_paths, resolve_image_paths, meta_keys, set_custom_fields, catalogue_image,
            read_file, write_file, get_media_settings, set_media_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running CatalogForge");
}
