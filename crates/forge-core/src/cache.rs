//! Per-store local cache (SQLite) with a non-destructive staging layer.
//!
//! * `products`, `categories`, `media`, … hold the last known **server** state.
//! * `staged` holds edits as (entity, key, field) → new value, plus the base value the edit was
//!   made against (used for conflict detection on push). New records use keys like `new:<uuid>`;
//!   deletions are a `__delete` field.
//! * `undo_log` records every staging change, grouped by transaction, so any edit or bulk
//!   operation can be undone in one step before it is pushed.
//! * `history` records every push (before/after per field) so pushed changes can be reverted.
//!
//! Everything the grid shows is the server state with the staged overlay applied.

use crate::model::*;
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

pub const NEW_PREFIX: &str = "new:";
pub const DELETE_FIELD: &str = "__delete";
pub const NEW_FIELD: &str = "__new";

pub struct Cache {
    conn: Connection,
}

/// A row as the UI sees it: server data with staged values applied.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RowState {
    pub key: String,
    pub is_new: bool,
    pub deleted: bool,
    pub dirty: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductRow {
    #[serde(flatten)]
    pub product: Value,
    #[serde(rename = "_state")]
    pub state: RowState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SortSpec {
    pub field: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProductQuery {
    pub search: String,
    /// Includes products in descendant categories.
    pub category_id: Option<i64>,
    pub uncategorized: bool,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub stock_status: Option<String>,
    pub only_changed: bool,
    pub only_conflicts: bool,
    pub missing_image: bool,
    pub include_variations: bool,
    /// Parents whose variations should be listed (when include_variations is false).
    pub expanded: Vec<String>,
    pub sort: Vec<SortSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub keys: Vec<String>,
    pub total_products: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedChange {
    pub entity: Entity,
    pub key: String,
    pub label: String,
    pub field: String,
    pub base: Value,
    pub value: Value,
    pub conflict: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StagedSummary {
    pub created: usize,
    pub modified: usize,
    pub deleted: usize,
    pub fields: usize,
    pub conflicts: usize,
    pub can_undo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub at: i64,
    pub label: String,
    pub created: i64,
    pub updated: i64,
    pub deleted: i64,
    pub failed: i64,
    pub reverted_by: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub entity: Entity,
    pub id: i64,
    pub label: String,
    pub field: String,
    pub before: Value,
    pub after: Value,
    pub action: String,
}

/// One staging write. `value: None` removes the staged value for that field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    pub entity: Entity,
    pub key: String,
    pub field: String,
    pub value: Option<Value>,
}

fn j(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

fn pj(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::Null)
}

/// Loose equality so "19.9" == "19.90" and 5 == "5" don't create phantom changes.
pub fn same_value(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    let num = |v: &Value| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    if let (Some(x), Some(y)) = (num(a), num(b)) {
        return (x - y).abs() < 1e-9;
    }
    let empty = |v: &Value| matches!(v, Value::Null) || v.as_str() == Some("");
    empty(a) && empty(b)
}

impl Cache {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).with_context(|| format!("Opening cache {}", path.display()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = OFF;
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL DEFAULT 0, type TEXT, status TEXT,
                sku TEXT, name TEXT, modified TEXT, data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS products_parent ON products(parent_id);
            CREATE INDEX IF NOT EXISTS products_sku ON products(sku);
            CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS attributes (taxonomy TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, sha256 TEXT, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS media_sha ON media(sha256);
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS staged (
                entity TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL,
                value TEXT NOT NULL, base TEXT, conflict TEXT, updated_at INTEGER NOT NULL,
                PRIMARY KEY (entity, key, field)
            );
            CREATE TABLE IF NOT EXISTS undo_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, txn INTEGER NOT NULL,
                entity TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL,
                prev_value TEXT, prev_base TEXT, had_prev INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, label TEXT NOT NULL,
                created INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
                reverted_by INTEGER
            );
            CREATE TABLE IF NOT EXISTS history_items (
                history_id INTEGER NOT NULL, entity TEXT NOT NULL, id INTEGER NOT NULL, label TEXT,
                field TEXT NOT NULL, before TEXT, after TEXT, action TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS history_items_h ON history_items(history_id);
            CREATE TABLE IF NOT EXISTS identity (
                source_store TEXT NOT NULL, source_id INTEGER NOT NULL, local_id INTEGER NOT NULL,
                PRIMARY KEY (source_store, source_id)
            );
            "#,
        )?;
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /* ---------------------------------------------------------------- server state */

    pub fn upsert_products(&mut self, products: &[Product]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO products (id, parent_id, type, status, sku, name, modified, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, type=excluded.type, status=excluded.status,
                 sku=excluded.sku, name=excluded.name, modified=excluded.modified, data=excluded.data",
            )?;
            for p in products {
                stmt.execute(params![p.id, p.parent_id, p.kind, p.status, p.sku, p.name, p.date_modified_gmt, serde_json::to_string(p)?])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_products(&mut self, ids: &[i64]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM products WHERE id = ?1", [id])?;
            for entity in ["product", "variation"] {
                tx.execute("DELETE FROM staged WHERE entity = ?1 AND key = ?2", params![entity, id.to_string()])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn product_ids_with_modified(&self) -> Result<HashMap<i64, String>> {
        let mut stmt = self.conn.prepare("SELECT id, COALESCE(modified,'') FROM products")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn product_count(&self) -> Result<usize> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get::<_, i64>(0))? as usize)
    }

    pub fn replace_taxonomy(&mut self, tax: &Taxonomy) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM categories", [])?;
        tx.execute("DELETE FROM tags", [])?;
        tx.execute("DELETE FROM attributes", [])?;
        for c in &tax.categories {
            tx.execute("INSERT OR REPLACE INTO categories (id, parent, name, data) VALUES (?1,?2,?3,?4)", params![c.id, c.parent, c.name, serde_json::to_string(c)?])?;
        }
        for t in &tax.tags {
            tx.execute("INSERT OR REPLACE INTO tags (id, name, data) VALUES (?1,?2,?3)", params![t.id, t.name, serde_json::to_string(t)?])?;
        }
        for a in &tax.attributes {
            tx.execute("INSERT OR REPLACE INTO attributes (taxonomy, data) VALUES (?1,?2)", params![a.taxonomy, serde_json::to_string(a)?])?;
        }
        tx.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('shipping_classes', ?1)", [serde_json::to_string(&tax.shipping_classes)?])?;
        tx.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('tax_classes', ?1)", [serde_json::to_string(&tax.tax_classes)?])?;
        tx.commit()?;
        self.upsert_media(&tax.media)
    }

    pub fn upsert_category(&mut self, c: &Category) -> Result<()> {
        self.conn.execute(
            "INSERT INTO categories (id, parent, name, data) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent, name=excluded.name, data=excluded.data",
            params![c.id, c.parent, c.name, serde_json::to_string(c)?],
        )?;
        Ok(())
    }

    pub fn upsert_media(&mut self, media: &[Media]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for m in media.iter().filter(|m| m.id > 0) {
            tx.execute(
                "INSERT INTO media (id, sha256, data) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256, data=excluded.data",
                params![m.id, m.sha256, serde_json::to_string(m)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn media(&self, ids: &[i64]) -> Result<Vec<Media>> {
        let mut out = Vec::new();
        let mut stmt = self.conn.prepare_cached("SELECT data FROM media WHERE id = ?1")?;
        for id in ids {
            if let Some(d) = stmt.query_row([id], |r| r.get::<_, String>(0)).optional()? {
                out.push(serde_json::from_str(&d)?);
            }
        }
        Ok(out)
    }

    pub fn all_media(&self) -> Result<Vec<Media>> {
        let mut stmt = self.conn.prepare("SELECT data FROM media ORDER BY id DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn categories(&self) -> Result<Vec<Category>> {
        let mut stmt = self.conn.prepare("SELECT data FROM categories ORDER BY name")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn tags(&self) -> Result<Vec<Tag>> {
        let mut stmt = self.conn.prepare("SELECT data FROM tags ORDER BY name")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn attributes(&self) -> Result<Vec<AttributeTaxonomy>> {
        let mut stmt = self.conn.prepare("SELECT data FROM attributes ORDER BY taxonomy")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }

    pub fn product(&self, id: i64) -> Result<Option<Product>> {
        let d: Option<String> = self.conn.query_row("SELECT data FROM products WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        Ok(match d {
            Some(d) => Some(serde_json::from_str(&d)?),
            None => None,
        })
    }

    pub fn product_by_sku(&self, sku: &str) -> Result<Option<Product>> {
        if sku.is_empty() {
            return Ok(None);
        }
        let d: Option<String> = self.conn.query_row("SELECT data FROM products WHERE sku = ?1 LIMIT 1", [sku], |r| r.get(0)).optional()?;
        Ok(match d {
            Some(d) => Some(serde_json::from_str(&d)?),
            None => None,
        })
    }

    /// (sku, id, type) for every server product with a SKU — a light index for import matching.
    pub fn sku_index(&self) -> Result<Vec<(String, i64, String)>> {
        let mut stmt = self.conn.prepare("SELECT sku, id, COALESCE(type,'') FROM products WHERE sku IS NOT NULL AND sku <> ''")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn children(&self, parent: i64) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare_cached("SELECT id FROM products WHERE parent_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([parent], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Server-side JSON of a record (base for staging).
    fn base_record(&self, entity: Entity, key: &str) -> Result<Option<Value>> {
        let Ok(id) = key.parse::<i64>() else { return Ok(None) };
        let sql = match entity {
            Entity::Product | Entity::Variation => "SELECT data FROM products WHERE id = ?1",
            Entity::Category => "SELECT data FROM categories WHERE id = ?1",
            Entity::Media => "SELECT data FROM media WHERE id = ?1",
            Entity::Tag => "SELECT data FROM tags WHERE id = ?1",
        };
        let d: Option<String> = self.conn.query_row(sql, [id], |r| r.get(0)).optional()?;
        Ok(d.map(|d| pj(&d)))
    }

    /* ------------------------------------------------------------------- staging */

    fn next_txn(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COALESCE(MAX(txn), 0) + 1 FROM undo_log", [], |r| r.get(0))?)
    }

    /// Applies a group of edits as one undoable transaction. Returns the number of fields that
    /// actually changed.
    pub fn stage(&mut self, edits: &[Edit]) -> Result<usize> {
        let txn = self.next_txn()?;
        let now = chrono::Utc::now().timestamp();
        let mut base_cache: HashMap<(Entity, String), Option<Value>> = HashMap::new();
        for e in edits {
            if !base_cache.contains_key(&(e.entity, e.key.clone())) {
                let b = self.base_record(e.entity, &e.key)?;
                base_cache.insert((e.entity, e.key.clone()), b);
            }
        }
        let tx = self.conn.transaction()?;
        let mut changed = 0;
        for e in edits {
            let prev: Option<(String, Option<String>)> = tx
                .query_row("SELECT value, base FROM staged WHERE entity=?1 AND key=?2 AND field=?3", params![e.entity.as_str(), e.key, e.field], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let record = base_cache.get(&(e.entity, e.key.clone())).cloned().flatten();
            let is_new = e.key.starts_with(NEW_PREFIX);
            let server_value = record.as_ref().and_then(|r| r.get(&e.field).cloned());
            // Value identical to the server → drop the staged row instead of storing a no-op.
            let effective = match &e.value {
                Some(v) if !is_new && e.field != DELETE_FIELD && server_value.as_ref().map(|s| same_value(s, v)).unwrap_or(false) => None,
                other => other.clone(),
            };
            let unchanged = match (&prev, &effective) {
                (Some((pv, _)), Some(v)) => same_value(&pj(pv), v) && pj(pv) == *v,
                (None, None) => true,
                _ => false,
            };
            if unchanged {
                continue;
            }
            tx.execute(
                "INSERT INTO undo_log (txn, entity, key, field, prev_value, prev_base, had_prev) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![txn, e.entity.as_str(), e.key, e.field, prev.as_ref().map(|p| p.0.clone()), prev.as_ref().and_then(|p| p.1.clone()), prev.is_some() as i64],
            )?;
            match effective {
                Some(v) => {
                    let base = match &prev {
                        Some((_, b)) => b.clone(),
                        None => server_value.as_ref().map(j),
                    };
                    tx.execute(
                        "INSERT INTO staged (entity, key, field, value, base, conflict, updated_at) VALUES (?1,?2,?3,?4,?5,NULL,?6)
                         ON CONFLICT(entity, key, field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, conflict=NULL",
                        params![e.entity.as_str(), e.key, e.field, j(&v), base, now],
                    )?;
                }
                None => {
                    tx.execute("DELETE FROM staged WHERE entity=?1 AND key=?2 AND field=?3", params![e.entity.as_str(), e.key, e.field])?;
                }
            }
            changed += 1;
        }
        tx.commit()?;
        Ok(changed)
    }

    /// Stages a brand-new record and returns its key.
    pub fn create(&mut self, entity: Entity, fields: Map<String, Value>) -> Result<String> {
        let key = format!("{NEW_PREFIX}{}", uuid::Uuid::new_v4().simple());
        let mut edits = vec![Edit { entity, key: key.clone(), field: NEW_FIELD.into(), value: Some(json!(true)) }];
        for (f, v) in fields {
            edits.push(Edit { entity, key: key.clone(), field: f, value: Some(v) });
        }
        self.stage(&edits)?;
        Ok(key)
    }

    /// Creates many records in one undoable transaction.
    pub fn create_many(&mut self, items: Vec<(Entity, Option<String>, Map<String, Value>)>) -> Result<Vec<String>> {
        let mut edits = Vec::new();
        let mut keys = Vec::new();
        for (entity, key, fields) in items {
            let key = key.unwrap_or_else(|| format!("{NEW_PREFIX}{}", uuid::Uuid::new_v4().simple()));
            edits.push(Edit { entity, key: key.clone(), field: NEW_FIELD.into(), value: Some(json!(true)) });
            for (f, v) in fields {
                edits.push(Edit { entity, key: key.clone(), field: f, value: Some(v) });
            }
            keys.push(key);
        }
        self.stage(&edits)?;
        Ok(keys)
    }

    pub fn stage_delete(&mut self, entity: Entity, keys: &[String]) -> Result<()> {
        let mut edits = Vec::new();
        for key in keys {
            if key.starts_with(NEW_PREFIX) {
                for f in self.staged_fields(entity, key)? {
                    edits.push(Edit { entity, key: key.clone(), field: f, value: None });
                }
            } else {
                edits.push(Edit { entity, key: key.clone(), field: DELETE_FIELD.into(), value: Some(json!(true)) });
                if entity == Entity::Product {
                    if let Ok(id) = key.parse::<i64>() {
                        for child in self.children(id)? {
                            edits.push(Edit { entity: Entity::Variation, key: child.to_string(), field: DELETE_FIELD.into(), value: Some(json!(true)) });
                        }
                    }
                }
            }
        }
        self.stage(&edits)?;
        Ok(())
    }

    fn staged_fields(&self, entity: Entity, key: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached("SELECT field FROM staged WHERE entity=?1 AND key=?2")?;
        let rows = stmt.query_map(params![entity.as_str(), key], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Discards staged changes (all, one record, or one field) as an undoable step.
    pub fn discard(&mut self, entity: Option<Entity>, key: Option<&str>, field: Option<&str>) -> Result<usize> {
        let mut stmt = self.conn.prepare("SELECT entity, key, field FROM staged")?;
        let rows: Vec<(String, String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let edits: Vec<Edit> = rows
            .into_iter()
            .filter(|(e, k, f)| entity.map(|x| x.as_str() == e).unwrap_or(true) && key.map(|x| x == k).unwrap_or(true) && field.map(|x| x == f).unwrap_or(true))
            .filter_map(|(e, k, f)| Entity::parse(&e).map(|entity| Edit { entity, key: k, field: f, value: None }))
            .collect();
        self.stage(&edits)
    }

    /// Reverts the most recent staging transaction.
    pub fn undo(&mut self) -> Result<bool> {
        let txn: Option<i64> = self.conn.query_row("SELECT MAX(txn) FROM undo_log", [], |r| r.get(0))?;
        let Some(txn) = txn else { return Ok(false) };
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare("SELECT entity, key, field, prev_value, prev_base, had_prev FROM undo_log WHERE txn = ?1 ORDER BY seq DESC")?;
            let rows: Vec<(String, String, String, Option<String>, Option<String>, i64)> =
                stmt.query_map([txn], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?.collect::<rusqlite::Result<_>>()?;
            for (e, k, f, pv, pb, had) in rows {
                if had == 1 {
                    tx.execute(
                        "INSERT INTO staged (entity, key, field, value, base, conflict, updated_at) VALUES (?1,?2,?3,?4,?5,NULL,?6)
                         ON CONFLICT(entity, key, field) DO UPDATE SET value=excluded.value, base=excluded.base",
                        params![e, k, f, pv.unwrap_or_else(|| "null".into()), pb, chrono::Utc::now().timestamp()],
                    )?;
                } else {
                    tx.execute("DELETE FROM staged WHERE entity=?1 AND key=?2 AND field=?3", params![e, k, f])?;
                }
            }
        }
        tx.execute("DELETE FROM undo_log WHERE txn = ?1", [txn])?;
        tx.commit()?;
        Ok(true)
    }

    fn clear_undo(&self) -> Result<()> {
        self.conn.execute("DELETE FROM undo_log", [])?;
        Ok(())
    }

    /// All staged rows grouped by (entity, key).
    pub fn staged_map(&self) -> Result<BTreeMap<(Entity, String), BTreeMap<String, (Value, Option<Value>, Option<Value>)>>> {
        let mut stmt = self.conn.prepare("SELECT entity, key, field, value, base, conflict FROM staged")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?)))?;
        let mut out: BTreeMap<(Entity, String), BTreeMap<String, (Value, Option<Value>, Option<Value>)>> = BTreeMap::new();
        for row in rows {
            let (e, k, f, v, b, c) = row?;
            if let Some(entity) = Entity::parse(&e) {
                out.entry((entity, k)).or_default().insert(f, (pj(&v), b.as_deref().map(pj), c.as_deref().map(pj)));
            }
        }
        Ok(out)
    }

    pub fn summary(&self) -> Result<StagedSummary> {
        let mut s = StagedSummary::default();
        for (_, fields) in self.staged_map()? {
            if fields.contains_key(NEW_FIELD) {
                s.created += 1;
            } else if fields.contains_key(DELETE_FIELD) {
                s.deleted += 1;
            } else {
                s.modified += 1;
            }
            s.fields += fields.keys().filter(|f| !f.starts_with("__")).count();
            s.conflicts += fields.values().filter(|v| v.2.is_some()).count();
        }
        s.can_undo = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM undo_log)", [], |r| r.get::<_, bool>(0))?;
        Ok(s)
    }

    pub fn changes(&self) -> Result<Vec<StagedChange>> {
        let mut out = Vec::new();
        for ((entity, key), fields) in self.staged_map()? {
            let base = self.base_record(entity, &key)?.unwrap_or(Value::Null);
            let label = fields
                .get("name")
                .map(|v| v.0.clone())
                .or_else(|| base.get("name").cloned())
                .and_then(|v| v.as_str().map(String::from))
                .filter(|s| !s.is_empty())
                .or_else(|| base.get("sku").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from))
                .unwrap_or_else(|| key.clone());
            for (field, (value, b, conflict)) in fields {
                if field == NEW_FIELD && entity != Entity::Product {
                    continue;
                }
                out.push(StagedChange { entity, key: key.clone(), label: label.clone(), field, base: b.unwrap_or(Value::Null), value, conflict });
            }
        }
        Ok(out)
    }

    /// Server record with staged overlay applied.
    fn overlay(base: Option<Value>, key: &str, fields: Option<&BTreeMap<String, (Value, Option<Value>, Option<Value>)>>) -> (Value, RowState) {
        let mut v = base.unwrap_or_else(|| json!({}));
        let mut state = RowState { key: key.to_string(), is_new: key.starts_with(NEW_PREFIX), ..Default::default() };
        if let Some(fields) = fields {
            for (f, (val, _, conflict)) in fields {
                match f.as_str() {
                    DELETE_FIELD => state.deleted = true,
                    NEW_FIELD => {}
                    _ => {
                        v[f.as_str()] = val.clone();
                        state.dirty.push(f.clone());
                        if conflict.is_some() {
                            state.conflicts.push(f.clone());
                        }
                    }
                }
            }
        }
        if state.is_new && v.get("id").is_none() {
            v["id"] = json!(0);
        }
        (v, state)
    }

    pub fn rows(&self, keys: &[String]) -> Result<Vec<ProductRow>> {
        let staged = self.staged_map()?;
        let mut out = Vec::with_capacity(keys.len());
        let mut stmt = self.conn.prepare_cached("SELECT data FROM products WHERE id = ?1")?;
        for key in keys {
            let base = match key.parse::<i64>() {
                Ok(id) => stmt.query_row([id], |r| r.get::<_, String>(0)).optional()?.map(|d| pj(&d)),
                Err(_) => None,
            };
            let fields = staged.get(&(Entity::Product, key.clone())).or_else(|| staged.get(&(Entity::Variation, key.clone())));
            if base.is_none() && fields.is_none() {
                continue;
            }
            let (product, state) = Self::overlay(base, key, fields);
            out.push(ProductRow { product, state });
        }
        Ok(out)
    }

    /// Keys of a parent's variations: server children plus staged new variations pointing at it.
    pub fn variation_keys(&self, parent_key: &str) -> Result<Vec<String>> {
        let mut keys: Vec<String> = match parent_key.parse::<i64>() {
            Ok(id) => self.children(id)?.into_iter().map(|c| c.to_string()).collect(),
            Err(_) => vec![],
        };
        for ((entity, key), fields) in self.staged_map()? {
            if entity != Entity::Variation || !key.starts_with(NEW_PREFIX) {
                continue;
            }
            let parent = fields.get("parent_id").map(|v| match &v.0 {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
            if parent.as_deref() == Some(parent_key) {
                keys.push(key);
            }
        }
        Ok(keys)
    }

    pub fn category_rows(&self) -> Result<Vec<ProductRow>> {
        let staged = self.staged_map()?;
        let mut out = Vec::new();
        for c in self.categories()? {
            let key = c.id.to_string();
            let (product, state) = Self::overlay(Some(serde_json::to_value(&c)?), &key, staged.get(&(Entity::Category, key.clone())));
            out.push(ProductRow { product, state });
        }
        for ((entity, key), fields) in &staged {
            if *entity == Entity::Category && key.starts_with(NEW_PREFIX) {
                let (mut product, state) = Self::overlay(None, key, Some(fields));
                if product.get("parent").is_none() {
                    product["parent"] = json!(0);
                }
                out.push(ProductRow { product, state });
            }
        }
        Ok(out)
    }

    /// Filtered, sorted list of product keys in display order (variations follow their parent).
    pub fn query(&self, q: &ProductQuery) -> Result<QueryResult> {
        let staged = self.staged_map()?;
        let mut stmt = self.conn.prepare("SELECT id, data FROM products")?;
        let mut all: Vec<(String, Value, RowState)> = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .map(|(id, d)| {
                let key = id.to_string();
                let fields = staged.get(&(Entity::Product, key.clone())).or_else(|| staged.get(&(Entity::Variation, key.clone())));
                let (v, s) = Self::overlay(Some(pj(&d)), &key, fields);
                (key, v, s)
            })
            .collect();
        for ((entity, key), fields) in &staged {
            if matches!(entity, Entity::Product | Entity::Variation) && key.starts_with(NEW_PREFIX) {
                let (mut v, s) = Self::overlay(None, key, Some(fields));
                if *entity == Entity::Variation {
                    v["type"] = json!("variation");
                }
                all.push((key.clone(), v, s));
            }
        }

        let cat_filter: Option<HashSet<i64>> = q.category_id.map(|root| {
            let cats = self.categories().unwrap_or_default();
            let mut set = HashSet::from([root]);
            let mut changed = true;
            while changed {
                changed = false;
                for c in &cats {
                    if set.contains(&c.parent) && set.insert(c.id) {
                        changed = true;
                    }
                }
            }
            set
        });
        let search = q.search.trim().to_lowercase();
        let parent_key = |v: &Value| -> Option<String> {
            match &v["parent_id"] {
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                Value::Number(n) if n.as_i64().unwrap_or(0) > 0 => Some(n.to_string()),
                _ => None,
            }
        };
        let is_child = |v: &Value| v["type"] == "variation";

        let matches = |v: &Value, s: &RowState| -> bool {
            if !search.is_empty() {
                let hay = format!("{} {} {}", v["name"].as_str().unwrap_or(""), v["sku"].as_str().unwrap_or(""), v["id"]).to_lowercase();
                if !search.split_whitespace().all(|w| hay.contains(w)) {
                    return false;
                }
            }
            if let Some(set) = &cat_filter {
                let ids: Vec<i64> = v["category_ids"].as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
                if !ids.iter().any(|i| set.contains(i)) {
                    return false;
                }
            }
            if q.uncategorized && v["category_ids"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                return false;
            }
            if q.status.as_ref().map(|st| v["status"].as_str() != Some(st)).unwrap_or(false) {
                return false;
            }
            if q.kind.as_ref().map(|k| v["type"].as_str() != Some(k)).unwrap_or(false) {
                return false;
            }
            if q.stock_status.as_ref().map(|k| v["stock_status"].as_str() != Some(k)).unwrap_or(false) {
                return false;
            }
            if q.only_changed && s.dirty.is_empty() && !s.deleted && !s.is_new {
                return false;
            }
            if q.only_conflicts && s.conflicts.is_empty() {
                return false;
            }
            if q.missing_image && !matches!(&v["image_id"], Value::Number(n) if n.as_i64().unwrap_or(0) == 0) && !v["image_id"].is_null() {
                return false;
            }
            true
        };

        let mut children: HashMap<String, Vec<usize>> = HashMap::new();
        let mut parents: Vec<usize> = Vec::new();
        let mut matched_children: HashSet<String> = HashSet::new();
        for (i, (_, v, s)) in all.iter().enumerate() {
            if is_child(v) {
                if let Some(p) = parent_key(v) {
                    children.entry(p.clone()).or_default().push(i);
                    if q.include_variations && matches(v, s) {
                        matched_children.insert(p);
                    }
                }
            } else {
                parents.push(i);
            }
        }
        let total_products = parents.len();
        // A parent is listed if it matches, or (when variations are searched) any variation does.
        let mut listed: Vec<usize> = parents
            .into_iter()
            .filter(|&i| {
                let (k, v, s) = &all[i];
                // Variation-level filters (e.g. stock status) should not hide variable parents whose children match.
                matches(v, s) || matched_children.contains(k)
            })
            .collect();

        let sort = if q.sort.is_empty() { vec![SortSpec { field: "id".into(), desc: true }] } else { q.sort.clone() };
        let cmp_val = |a: &Value, b: &Value| -> std::cmp::Ordering {
            let num = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()));
            match (num(a), num(b)) {
                (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
                _ => a.as_str().unwrap_or("").to_lowercase().cmp(&b.as_str().unwrap_or("").to_lowercase()),
            }
        };
        listed.sort_by(|&a, &b| {
            // New rows first so freshly imported products are visible.
            let (na, nb) = (all[a].2.is_new, all[b].2.is_new);
            if na != nb {
                return nb.cmp(&na);
            }
            for s in &sort {
                let o = cmp_val(&all[a].1[s.field.as_str()], &all[b].1[s.field.as_str()]);
                let o = if s.desc { o.reverse() } else { o };
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            std::cmp::Ordering::Equal
        });

        let expanded: HashSet<&String> = q.expanded.iter().collect();
        let mut keys = Vec::with_capacity(listed.len());
        for i in listed {
            let key = all[i].0.clone();
            let show_children = q.include_variations || expanded.contains(&key);
            keys.push(key.clone());
            if show_children {
                if let Some(kids) = children.get(&key) {
                    let mut kids = kids.clone();
                    kids.sort_by_key(|&k| (all[k].1["menu_order"].as_i64().unwrap_or(0), all[k].1["id"].as_i64().unwrap_or(0)));
                    for k in kids {
                        if !q.include_variations || matches(&all[k].1, &all[k].2) || matches(&all[i].1, &all[i].2) {
                            keys.push(all[k].0.clone());
                        }
                    }
                }
            }
        }
        Ok(QueryResult { keys, total_products })
    }

    /* ------------------------------------------------------- conflicts & pushes */

    pub fn set_conflict(&self, entity: Entity, key: &str, field: &str, conflict: &Value) -> Result<()> {
        self.conn.execute("UPDATE staged SET conflict = ?4 WHERE entity=?1 AND key=?2 AND field=?3", params![entity.as_str(), key, field, j(conflict)])?;
        Ok(())
    }

    /// `keep_mine`: overwrite the store on next push (the remote value becomes the new base).
    /// Otherwise accept the store's value and drop the local edit.
    pub fn resolve_conflict(&mut self, entity: Entity, key: &str, field: &str, keep_mine: bool) -> Result<()> {
        let conflict: Option<String> = self
            .conn
            .query_row("SELECT conflict FROM staged WHERE entity=?1 AND key=?2 AND field=?3", params![entity.as_str(), key, field], |r| r.get(0))
            .optional()?
            .flatten();
        let remote = conflict.as_deref().map(pj).and_then(|c| c.get("remote").cloned()).unwrap_or(Value::Null);
        if keep_mine {
            self.conn.execute("UPDATE staged SET base = ?4, conflict = NULL WHERE entity=?1 AND key=?2 AND field=?3", params![entity.as_str(), key, field, j(&remote)])?;
        } else {
            self.conn.execute("DELETE FROM staged WHERE entity=?1 AND key=?2 AND field=?3", params![entity.as_str(), key, field])?;
            if let (Ok(id), Entity::Product | Entity::Variation) = (key.parse::<i64>(), entity) {
                if let Some(mut p) = self.base_record(entity, key)? {
                    p[field] = remote;
                    self.conn.execute("UPDATE products SET data = ?2 WHERE id = ?1", params![id, j(&p)])?;
                }
            }
        }
        Ok(())
    }

    /// Replaces `new:<x>` references inside staged values once `<x>` has a real id.
    pub fn rewrite_new_refs(&mut self, mapping: &HashMap<String, i64>) -> Result<()> {
        if mapping.is_empty() {
            return Ok(());
        }
        let mut stmt = self.conn.prepare("SELECT rowid, value FROM staged")?;
        let rows: Vec<(i64, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        fn walk(v: &mut Value, m: &HashMap<String, i64>) -> bool {
            match v {
                Value::String(s) if s.starts_with(NEW_PREFIX) => {
                    if let Some(id) = m.get(s.as_str()) {
                        *v = json!(id);
                        return true;
                    }
                    false
                }
                Value::Array(a) => a.iter_mut().fold(false, |acc, x| walk(x, m) || acc),
                Value::Object(o) => o.values_mut().fold(false, |acc, x| walk(x, m) || acc),
                _ => false,
            }
        }
        for (rowid, raw) in rows {
            let mut v = pj(&raw);
            if walk(&mut v, mapping) {
                self.conn.execute("UPDATE staged SET value = ?2 WHERE rowid = ?1", params![rowid, j(&v)])?;
            }
        }
        Ok(())
    }

    pub fn clear_staged(&self, entity: Entity, key: &str, fields: Option<&[String]>) -> Result<()> {
        match fields {
            None => {
                self.conn.execute("DELETE FROM staged WHERE entity=?1 AND key=?2", params![entity.as_str(), key])?;
            }
            Some(fs) => {
                for f in fs {
                    self.conn.execute("DELETE FROM staged WHERE entity=?1 AND key=?2 AND field=?3", params![entity.as_str(), key, f])?;
                }
                // Drop orphaned markers.
                let remaining: i64 = self.conn.query_row(
                    "SELECT COUNT(*) FROM staged WHERE entity=?1 AND key=?2 AND field NOT LIKE '\\_\\_%' ESCAPE '\\'",
                    params![entity.as_str(), key],
                    |r| r.get(0),
                )?;
                if remaining == 0 {
                    self.conn.execute("DELETE FROM staged WHERE entity=?1 AND key=?2 AND field = ?3", params![entity.as_str(), key, NEW_FIELD])?;
                }
            }
        }
        Ok(())
    }

    pub fn begin_history(&self, label: &str) -> Result<i64> {
        self.conn.execute("INSERT INTO history (at, label) VALUES (?1, ?2)", params![chrono::Utc::now().timestamp(), label])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn add_history_item(&self, history_id: i64, item: &HistoryItem) -> Result<()> {
        self.conn.execute(
            "INSERT INTO history_items (history_id, entity, id, label, field, before, after, action) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![history_id, item.entity.as_str(), item.id, item.label, item.field, j(&item.before), j(&item.after), item.action],
        )?;
        Ok(())
    }

    pub fn finish_history(&self, history_id: i64, created: i64, updated: i64, deleted: i64, failed: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE history SET created=?2, updated=?3, deleted=?4, failed=?5 WHERE id=?1",
            params![history_id, created, updated, deleted, failed],
        )?;
        // Pushed edits can no longer be undone locally; they are reverted through history instead.
        self.clear_undo()
    }

    pub fn history(&self, limit: usize) -> Result<Vec<HistoryEntry>> {
        let mut stmt = self.conn.prepare("SELECT id, at, label, created, updated, deleted, failed, reverted_by FROM history ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit as i64], |r| {
            Ok(HistoryEntry { id: r.get(0)?, at: r.get(1)?, label: r.get(2)?, created: r.get(3)?, updated: r.get(4)?, deleted: r.get(5)?, failed: r.get(6)?, reverted_by: r.get(7)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn history_items(&self, history_id: i64) -> Result<Vec<HistoryItem>> {
        let mut stmt = self.conn.prepare("SELECT entity, id, label, field, before, after, action FROM history_items WHERE history_id = ?1")?;
        let rows = stmt.query_map([history_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, String>(6)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (e, id, label, field, before, after, action) = row?;
            out.push(HistoryItem {
                entity: Entity::parse(&e).ok_or_else(|| anyhow!("bad entity"))?,
                id,
                label: label.unwrap_or_default(),
                field,
                before: before.as_deref().map(pj).unwrap_or(Value::Null),
                after: after.as_deref().map(pj).unwrap_or(Value::Null),
                action,
            });
        }
        Ok(out)
    }

    /// Stages the inverse of a past push. Created records are staged for deletion; field updates
    /// are staged back to their previous values. Returns the number of staged edits.
    pub fn stage_revert(&mut self, history_id: i64) -> Result<usize> {
        let items = self.history_items(history_id)?;
        let mut edits = Vec::new();
        for it in &items {
            match it.action.as_str() {
                "created" if it.field == NEW_FIELD => edits.push(Edit { entity: it.entity, key: it.id.to_string(), field: DELETE_FIELD.into(), value: Some(json!(true)) }),
                "updated" => edits.push(Edit { entity: it.entity, key: it.id.to_string(), field: it.field.clone(), value: Some(it.before.clone()) }),
                _ => {}
            }
        }
        let n = self.stage(&edits)?;
        self.conn.execute("UPDATE history SET reverted_by = -1 WHERE id = ?1", [history_id])?;
        Ok(n)
    }

    pub fn map_identity(&self, source_store: &str, source_id: i64, local_id: i64) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO identity (source_store, source_id, local_id) VALUES (?1,?2,?3)", params![source_store, source_id, local_id])?;
        Ok(())
    }

    pub fn identity(&self, source_store: &str, source_id: i64) -> Result<Option<i64>> {
        Ok(self.conn.query_row("SELECT local_id FROM identity WHERE source_store=?1 AND source_id=?2", params![source_store, source_id], |r| r.get(0)).optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product(id: i64, name: &str, price: &str) -> Product {
        Product { id, name: name.into(), kind: "simple".into(), status: "publish".into(), regular_price: price.into(), sku: format!("SKU-{id}"), ..Default::default() }
    }

    fn cache() -> Cache {
        let mut c = Cache::open_in_memory().unwrap();
        c.upsert_products(&[product(1, "Alpha", "10"), product(2, "Bravo", "20"), product(3, "Charlie", "30")]).unwrap();
        c
    }

    fn edit(key: &str, field: &str, v: Value) -> Edit {
        Edit { entity: Entity::Product, key: key.into(), field: field.into(), value: Some(v) }
    }

    #[test]
    fn staging_overlays_and_tracks_base() {
        let mut c = cache();
        c.stage(&[edit("1", "regular_price", json!("12"))]).unwrap();
        let rows = c.rows(&["1".into()]).unwrap();
        assert_eq!(rows[0].product["regular_price"], "12");
        assert_eq!(rows[0].state.dirty, vec!["regular_price"]);
        let ch = c.changes().unwrap();
        assert_eq!(ch[0].base, json!("10"));
        // second edit keeps the original base
        c.stage(&[edit("1", "regular_price", json!("13"))]).unwrap();
        assert_eq!(c.changes().unwrap()[0].base, json!("10"));
        // editing back to the server value removes the change
        c.stage(&[edit("1", "regular_price", json!("10.00"))]).unwrap();
        assert!(c.changes().unwrap().is_empty());
    }

    #[test]
    fn undo_reverts_whole_transaction() {
        let mut c = cache();
        c.stage(&[edit("1", "name", json!("A1"))]).unwrap();
        c.stage(&[edit("2", "name", json!("B1")), edit("3", "name", json!("C1"))]).unwrap();
        assert_eq!(c.summary().unwrap().modified, 3);
        assert!(c.undo().unwrap());
        let s = c.summary().unwrap();
        assert_eq!(s.modified, 1);
        assert!(c.undo().unwrap());
        assert_eq!(c.summary().unwrap().modified, 0);
        assert!(!c.undo().unwrap());
    }

    #[test]
    fn create_delete_and_query() {
        let mut c = cache();
        let key = c.create(Entity::Product, serde_json::from_value(json!({ "name": "Delta", "type": "simple", "sku": "D" })).unwrap()).unwrap();
        c.stage_delete(Entity::Product, &["2".into()]).unwrap();
        let s = c.summary().unwrap();
        assert_eq!((s.created, s.deleted), (1, 1));
        let r = c.query(&ProductQuery { search: "delta".into(), ..Default::default() }).unwrap();
        assert_eq!(r.keys, vec![key.clone()]);
        let r = c.query(&ProductQuery { only_changed: true, ..Default::default() }).unwrap();
        assert_eq!(r.keys.len(), 2);
        assert_eq!(r.keys[0], key, "new rows sort first");
        // deleting a new record just discards it
        c.stage_delete(Entity::Product, &[key]).unwrap();
        assert_eq!(c.summary().unwrap().created, 0);
    }

    #[test]
    fn query_sorts_and_nests_variations() {
        let mut c = cache();
        let mut parent = product(10, "Variable Tee", "");
        parent.kind = "variable".into();
        let mut v1 = product(11, "Variable Tee - S", "5");
        v1.kind = "variation".into();
        v1.parent_id = 10;
        c.upsert_products(&[parent, v1]).unwrap();
        let r = c.query(&ProductQuery { sort: vec![SortSpec { field: "regular_price".into(), desc: false }], ..Default::default() }).unwrap();
        assert_eq!(r.total_products, 4);
        assert!(!r.keys.contains(&"11".to_string()));
        let r = c.query(&ProductQuery { expanded: vec!["10".into()], sort: vec![SortSpec { field: "name".into(), desc: false }], ..Default::default() }).unwrap();
        let pos = r.keys.iter().position(|k| k == "10").unwrap();
        assert_eq!(r.keys[pos + 1], "11");
        // searching a variation SKU surfaces its parent
        let r = c.query(&ProductQuery { search: "SKU-11".into(), include_variations: true, ..Default::default() }).unwrap();
        assert_eq!(r.keys, vec!["10", "11"]);
    }

    #[test]
    fn conflicts_and_resolution() {
        let mut c = cache();
        c.stage(&[edit("1", "regular_price", json!("11"))]).unwrap();
        c.set_conflict(Entity::Product, "1", "regular_price", &json!({ "remote": "15" })).unwrap();
        assert_eq!(c.summary().unwrap().conflicts, 1);
        c.resolve_conflict(Entity::Product, "1", "regular_price", true).unwrap();
        let ch = c.changes().unwrap();
        assert_eq!(ch[0].base, json!("15"));
        assert!(ch[0].conflict.is_none());
        c.set_conflict(Entity::Product, "1", "regular_price", &json!({ "remote": "16" })).unwrap();
        c.resolve_conflict(Entity::Product, "1", "regular_price", false).unwrap();
        assert!(c.changes().unwrap().is_empty());
        assert_eq!(c.product(1).unwrap().unwrap().regular_price, "16");
    }

    #[test]
    fn history_revert_stages_inverse() {
        let mut c = cache();
        let h = c.begin_history("Push").unwrap();
        c.add_history_item(h, &HistoryItem { entity: Entity::Product, id: 1, label: "Alpha".into(), field: "regular_price".into(), before: json!("9"), after: json!("10"), action: "updated".into() }).unwrap();
        c.add_history_item(h, &HistoryItem { entity: Entity::Product, id: 3, label: "Charlie".into(), field: NEW_FIELD.into(), before: Value::Null, after: json!(true), action: "created".into() }).unwrap();
        c.finish_history(h, 1, 1, 0, 0).unwrap();
        assert_eq!(c.stage_revert(h).unwrap(), 2);
        let s = c.summary().unwrap();
        assert_eq!((s.modified, s.deleted), (1, 1));
        assert_eq!(c.rows(&["1".into()]).unwrap()[0].product["regular_price"], "9");
    }

    #[test]
    fn variation_keys_include_staged_children() {
        let mut c = cache();
        let mut v = product(20, "Alpha - S", "1");
        v.kind = "variation".into();
        v.parent_id = 1;
        c.upsert_products(&[v]).unwrap();
        let nv = c.create(Entity::Variation, serde_json::from_value(json!({ "parent_id": 1 })).unwrap()).unwrap();
        let other = c.create(Entity::Variation, serde_json::from_value(json!({ "parent_id": 2 })).unwrap()).unwrap();
        let keys = c.variation_keys("1").unwrap();
        assert_eq!(keys, vec!["20".to_string(), nv]);
        assert!(!keys.contains(&other));
    }

    #[test]
    fn rewrites_new_references() {
        let mut c = cache();
        let cat = c.create(Entity::Category, serde_json::from_value(json!({ "name": "New cat" })).unwrap()).unwrap();
        c.stage(&[edit("1", "category_ids", json!([5, cat.clone()]))]).unwrap();
        c.rewrite_new_refs(&HashMap::from([(cat, 77)])).unwrap();
        assert_eq!(c.rows(&["1".into()]).unwrap()[0].product["category_ids"], json!([5, 77]));
    }
}
