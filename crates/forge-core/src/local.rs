//! Local (formerly Local by Flywheel) integration.
//!
//! Local keeps its site registry in `sites.json` inside its data directory:
//!   macOS   ~/Library/Application Support/Local
//!   Windows %APPDATA%\Local
//!   Linux   ~/.config/Local
//! Each site runs its own MySQL on a dynamic port (and, on macOS/Linux, a socket under
//! `run/<site-id>/mysql/mysqld.sock`). We read the catalog straight from that database, write
//! files straight into `app/public/wp-content/uploads`, and send product writes through the
//! connector plugin, which we install and key automatically.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteStatus {
    Running,
    Halted,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocalDb {
    pub database: String,
    pub user: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocalSite {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub path: PathBuf,
    pub wp_root: PathBuf,
    pub php_version: Option<String>,
    pub mysql_version: Option<String>,
    pub mysql_port: Option<u16>,
    pub mysql_socket: Option<PathBuf>,
    pub http_port: Option<u16>,
    pub db: LocalDb,
    pub status: SiteStatus,
    pub table_prefix: String,
    pub has_woocommerce: bool,
    pub connector_installed: bool,
    pub multisite: bool,
}

impl LocalSite {
    /// Front-end URL. Local maps `<domain>` to 127.0.0.1 in the hosts file and routes it on :80.
    pub fn url(&self) -> String {
        format!("http://{}", self.domain)
    }
    /// Direct URL to the site's own web server, bypassing Local's router (used when the hosts entry
    /// is missing). Requests must send `Host: <domain>`.
    pub fn direct_url(&self) -> Option<String> {
        self.http_port.map(|p| format!("http://127.0.0.1:{p}"))
    }
    pub fn uploads_dir(&self) -> PathBuf {
        self.wp_root.join("wp-content").join("uploads")
    }
    pub fn plugins_dir(&self) -> PathBuf {
        self.wp_root.join("wp-content").join("plugins")
    }
}

pub fn default_data_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CATALOGFORGE_LOCAL_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Application Support/Local"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Local"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs::config_dir().map(|c| c.join("Local"))
    }
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

fn first_port(service: &Value, key: &str) -> Option<u16> {
    service.get("ports")?.get(key)?.as_array()?.first()?.as_u64().map(|p| p as u16)
}

/// Reads `$table_prefix` from wp-config.php.
pub fn table_prefix_from_config(wp_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(wp_root.join("wp-config.php")).ok()?;
    let re = regex::Regex::new(r#"\$table_prefix\s*=\s*['"]([A-Za-z0-9_]+)['"]"#).ok()?;
    re.captures(&raw).map(|c| c[1].to_string())
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok()
}

/// Parses Local's `sites.json` (and the optional `site-statuses.json`) from `data_dir`.
pub fn discover(data_dir: &Path) -> Result<Vec<LocalSite>> {
    let sites_path = data_dir.join("sites.json");
    let raw = std::fs::read_to_string(&sites_path)
        .with_context(|| format!("Local does not appear to be installed (no {})", sites_path.display()))?;
    let sites: serde_json::Map<String, Value> = serde_json::from_str(&raw).context("sites.json is not valid JSON")?;
    let statuses: serde_json::Map<String, Value> = std::fs::read_to_string(data_dir.join("site-statuses.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let mut out = Vec::new();
    for (key, site) in sites {
        let id = site.get("id").and_then(Value::as_str).unwrap_or(&key).to_string();
        let path = expand_home(site.get("path").and_then(Value::as_str).unwrap_or_default());
        let wp_root = path.join("app").join("public");
        let services = site.get("services").cloned().unwrap_or(Value::Null);
        let mysql_svc = services.get("mysql").or_else(|| services.get("mariadb")).cloned().unwrap_or(Value::Null);
        let http_svc = services.get("nginx").or_else(|| services.get("apache")).cloned().unwrap_or(Value::Null);
        let mysql_port = first_port(&mysql_svc, "MYSQL");
        let http_port = first_port(&http_svc, "HTTP");
        let socket = data_dir.join("run").join(&id).join("mysql").join("mysqld.sock");
        let db = site.get("mysql").cloned().unwrap_or(Value::Null);

        let status = match statuses.get(&id).and_then(Value::as_str) {
            Some("running") => SiteStatus::Running,
            Some("halted") | Some("stopped") => SiteStatus::Halted,
            _ => match mysql_port {
                Some(p) if port_open(p) => SiteStatus::Running,
                Some(_) => SiteStatus::Halted,
                None => SiteStatus::Unknown,
            },
        };

        out.push(LocalSite {
            name: site.get("name").and_then(Value::as_str).unwrap_or(&id).to_string(),
            domain: site.get("domain").and_then(Value::as_str).unwrap_or_default().to_string(),
            php_version: services.get("php").and_then(|p| p.get("version")).and_then(Value::as_str).map(String::from),
            mysql_version: mysql_svc.get("version").and_then(Value::as_str).map(String::from),
            mysql_port,
            mysql_socket: if cfg!(unix) && socket.exists() { Some(socket) } else { None },
            http_port,
            db: LocalDb {
                database: db.get("database").and_then(Value::as_str).unwrap_or("local").to_string(),
                user: db.get("user").and_then(Value::as_str).unwrap_or("root").to_string(),
                password: db.get("password").and_then(Value::as_str).unwrap_or("root").to_string(),
            },
            status,
            table_prefix: table_prefix_from_config(&wp_root).unwrap_or_else(|| "wp_".into()),
            has_woocommerce: wp_root.join("wp-content/plugins/woocommerce/woocommerce.php").exists(),
            connector_installed: wp_root.join("wp-content/plugins/catalogforge-connector/catalogforge-connector.php").exists(),
            multisite: site.get("multiSite").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false),
            path,
            wp_root,
            id,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn find_site(data_dir: &Path, id: &str) -> Result<LocalSite> {
    discover(data_dir)?.into_iter().find(|s| s.id == id).ok_or_else(|| anyhow!("Local site {id} no longer exists in Local"))
}

/// Starts a halted site through Local's local GraphQL API (`graphql-connection-info.json`).
pub async fn start_site(data_dir: &Path, id: &str) -> Result<()> {
    let info: Value = serde_json::from_str(
        &std::fs::read_to_string(data_dir.join("graphql-connection-info.json")).context("Local is not running — open the Local app and start the site.")?,
    )?;
    let port = info.get("port").and_then(Value::as_u64).ok_or_else(|| anyhow!("graphql-connection-info.json has no port"))?;
    let token = info.get("authToken").and_then(Value::as_str).unwrap_or_default();
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(90)).build()?;
    let res: Value = client
        .post(format!("http://127.0.0.1:{port}/graphql"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "query": "mutation($id: ID!) { startSite(id: $id) { id status } }",
            "variables": { "id": id }
        }))
        .send()
        .await?
        .json()
        .await?;
    if let Some(errors) = res.get("errors") {
        return Err(anyhow!("Local refused to start the site: {errors}"));
    }
    Ok(())
}

/// Copies the bundled connector plugin into the site.
pub fn install_connector_files(site: &LocalSite, plugin_src: &Path) -> Result<()> {
    let dest = site.plugins_dir().join("catalogforge-connector");
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(&dest), std::fs::canonicalize(plugin_src)) {
        if a == b {
            return Ok(()); // Already the same directory (e.g. a development symlink).
        }
    }
    for entry in walkdir::WalkDir::new(plugin_src) {
        let entry = entry?;
        let rel = entry.path().strip_prefix(plugin_src)?;
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(dir: &Path) {
        let site_root = dir.join("Local Sites/shop");
        std::fs::create_dir_all(site_root.join("app/public/wp-content/plugins/woocommerce")).unwrap();
        std::fs::write(site_root.join("app/public/wp-content/plugins/woocommerce/woocommerce.php"), "<?php").unwrap();
        std::fs::write(site_root.join("app/public/wp-config.php"), "<?php\n$table_prefix = 'wpx_';\n").unwrap();
        let sites = serde_json::json!({
            "aB3dE": {
                "id": "aB3dE", "name": "Shop", "domain": "shop.local",
                "path": site_root.to_string_lossy(),
                "mysql": { "database": "local", "user": "root", "password": "root" },
                "services": {
                    "nginx": { "name": "nginx", "version": "1.26.1", "ports": { "HTTP": [10003] } },
                    "php": { "name": "php", "version": "8.2.23", "ports": { "PHP": [10004] } },
                    "mysql": { "name": "mysql", "version": "8.0.35", "ports": { "MYSQL": [10005] } }
                }
            },
            "zz": { "id": "zz", "name": "another", "domain": "another.local", "path": "~/Local Sites/another", "services": {} }
        });
        std::fs::write(dir.join("sites.json"), sites.to_string()).unwrap();
        std::fs::write(dir.join("site-statuses.json"), r#"{"aB3dE":"running","zz":"halted"}"#).unwrap();
    }

    #[test]
    fn discovers_sites() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let sites = discover(dir.path()).unwrap();
        assert_eq!(sites.len(), 2);
        assert_eq!(sites[0].name, "another");
        let shop = &sites[1];
        assert_eq!(shop.domain, "shop.local");
        assert_eq!(shop.mysql_port, Some(10005));
        assert_eq!(shop.http_port, Some(10003));
        assert_eq!(shop.status, SiteStatus::Running);
        assert_eq!(shop.table_prefix, "wpx_");
        assert!(shop.has_woocommerce);
        assert!(!shop.connector_installed);
        assert_eq!(shop.php_version.as_deref(), Some("8.2.23"));
        assert_eq!(sites[0].status, SiteStatus::Halted);
        assert!(sites[0].path.is_absolute());
    }

    #[test]
    fn missing_local_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = discover(dir.path()).unwrap_err().to_string();
        assert!(err.contains("Local does not appear to be installed"));
    }

    #[test]
    fn installs_connector_files() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let site = find_site(dir.path(), "aB3dE").unwrap();
        let src = dir.path().join("plugin");
        std::fs::create_dir_all(src.join("includes")).unwrap();
        std::fs::write(src.join("catalogforge-connector.php"), "<?php").unwrap();
        std::fs::write(src.join("includes/a.php"), "<?php").unwrap();
        install_connector_files(&site, &src).unwrap();
        assert!(find_site(dir.path(), "aB3dE").unwrap().connector_installed);
    }
}
