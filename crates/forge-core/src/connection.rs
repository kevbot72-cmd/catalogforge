//! Store profiles (multi-store workspace) and secret storage.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    Local,
    Staging,
    #[default]
    Production,
}

/// How the app talks to a store. Secrets (connector secret, REST consumer secret, DB password)
/// never live in the profile; they are stored under `secret_ref` in the [`SecretStore`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionKind {
    /// Companion plugin over HTTPS (recommended for live stores).
    Connector { base_url: String, key: String },
    /// Stock WooCommerce REST API with consumer key/secret. No plugin required.
    Rest { base_url: String, consumer_key: String },
    /// Direct MySQL/MariaDB for fast reads; writes go through `write_via` (connector) when set.
    Mysql {
        host: String,
        port: u16,
        database: String,
        user: String,
        table_prefix: String,
        #[serde(default)]
        socket: Option<String>,
        #[serde(default)]
        write_via: Option<Box<ConnectionKind>>,
    },
    /// A site running in Local (formerly Local by Flywheel) on this computer.
    Local { site_id: String },
}

impl ConnectionKind {
    pub fn label(&self) -> &'static str {
        match self {
            ConnectionKind::Connector { .. } => "Connector plugin",
            ConnectionKind::Rest { .. } => "WooCommerce REST API",
            ConnectionKind::Mysql { .. } => "Direct MySQL",
            ConnectionKind::Local { .. } => "Local (Flywheel)",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub environment: Environment,
    /// Accent colour shown in the store switcher so production is never mistaken for staging.
    #[serde(default)]
    pub color: String,
    pub connection: ConnectionKind,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    /// Product meta from other plugins that this store manages (see `custom_fields`).
    #[serde(default)]
    pub custom_fields: Vec<crate::custom_fields::CustomField>,
}

impl StoreProfile {
    pub fn secret_ref(&self) -> String {
        format!("store:{}", self.id)
    }
}

/// Persists store profiles as JSON in the app data directory.
pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("stores.json") }
    }

    pub fn list(&self) -> Result<Vec<StoreProfile>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let raw = std::fs::read_to_string(&self.path)?;
        Ok(serde_json::from_str(&raw).with_context(|| format!("reading {}", self.path.display()))?)
    }

    pub fn get(&self, id: &str) -> Result<StoreProfile> {
        self.list()?.into_iter().find(|p| p.id == id).ok_or_else(|| anyhow::anyhow!("Unknown store {id}"))
    }

    pub fn upsert(&self, profile: StoreProfile) -> Result<()> {
        let mut all = self.list()?;
        match all.iter_mut().find(|p| p.id == profile.id) {
            Some(p) => *p = profile,
            None => all.push(profile),
        }
        self.write(&all)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut all = self.list()?;
        all.retain(|p| p.id != id);
        self.write(&all)
    }

    fn write(&self, all: &[StoreProfile]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(all)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

/// Secret storage: the OS keychain when built with `os-keychain`, otherwise a 0600 JSON file in
/// the app data directory (also the fallback when no keychain service is running, e.g. headless Linux).
pub struct SecretStore {
    file: PathBuf,
}

const KEYCHAIN_SERVICE: &str = "com.catalogforge.desktop";

impl SecretStore {
    pub fn new(dir: &Path) -> Self {
        Self { file: dir.join("secrets.json") }
    }

    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        #[cfg(feature = "os-keychain")]
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, name) {
            if entry.set_password(value).is_ok() {
                return Ok(());
            }
        }
        let mut all = self.read_file();
        all.insert(name.to_string(), value.to_string());
        self.write_file(&all)
    }

    pub fn get(&self, name: &str) -> Result<String> {
        #[cfg(feature = "os-keychain")]
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, name) {
            if let Ok(v) = entry.get_password() {
                return Ok(v);
            }
        }
        self.read_file().remove(name).ok_or_else(|| anyhow::anyhow!("No saved secret for {name}; reconnect the store."))
    }

    pub fn delete(&self, name: &str) -> Result<()> {
        #[cfg(feature = "os-keychain")]
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, name) {
            let _ = entry.delete_credential();
        }
        let mut all = self.read_file();
        all.remove(name);
        self.write_file(&all)
    }

    fn read_file(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write_file(&self, all: &BTreeMap<String, String>) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.file, serde_json::to_vec(all)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

#[allow(dead_code)]
const _: &str = KEYCHAIN_SERVICE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path());
        let p = StoreProfile {
            id: "s1".into(),
            name: "Live".into(),
            environment: Environment::Production,
            color: "#e11d48".into(),
            connection: ConnectionKind::Local { site_id: "abc".into() },
            created_at: 1,
            last_synced_at: None,
            custom_fields: Vec::new(),
        };
        store.upsert(p.clone()).unwrap();
        assert_eq!(store.get("s1").unwrap(), p);
        store.remove("s1").unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn secrets_file_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let s = SecretStore::new(dir.path());
        s.set("store:x", "hunter2").unwrap();
        assert_eq!(s.get("store:x").unwrap(), "hunter2");
        s.delete("store:x").unwrap();
        assert!(s.get("store:x").is_err());
    }
}
