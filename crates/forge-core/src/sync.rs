//! Pull, push and cross-store clone orchestration.

use crate::cache::{Cache, Edit, HistoryItem, DELETE_FIELD, NEW_FIELD, NEW_PREFIX};
use crate::drivers::{Driver, MediaText};
use crate::media::{self, MediaSettings};
use crate::model::*;
use anyhow::{anyhow, Result};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Progress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub message: String,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

pub fn no_progress() -> ProgressFn {
    Arc::new(|_| {})
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PullReport {
    pub mode: String,
    pub products: usize,
    pub fetched: usize,
    pub removed: usize,
    pub categories: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PushError {
    pub entity: Option<Entity>,
    pub key: String,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PushReport {
    pub created: usize,
    pub updated: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub failed: usize,
    pub media_uploaded: usize,
    pub media_deduplicated: usize,
    pub media_bytes: usize,
    pub errors: Vec<PushError>,
    pub history_id: Option<i64>,
    pub elapsed_ms: u128,
}

/* ===================================================================== pull */

pub async fn pull(driver: &dyn Driver, cache: &Mutex<Cache>, force_full: bool, progress: ProgressFn) -> Result<PullReport> {
    let start = Instant::now();
    progress(Progress { phase: "pull".into(), message: "Connecting".into(), ..Default::default() });
    let hs = driver.handshake().await?;
    cache.lock().unwrap().kv_set("handshake", &serde_json::to_string(&hs)?)?;

    progress(Progress { phase: "pull".into(), message: "Categories, tags and attributes".into(), ..Default::default() });
    let tax = driver.taxonomy().await?;
    let categories = tax.categories.len();
    cache.lock().unwrap().replace_taxonomy(&tax)?;

    let empty = cache.lock().unwrap().product_count()? == 0;
    let index = if force_full && empty { None } else { driver.index().await.ok() };
    let mut report = PullReport { categories, ..Default::default() };

    match index {
        Some(index) if !empty && !force_full => {
            report.mode = "delta".into();
            let local = cache.lock().unwrap().product_ids_with_modified()?;
            let remote: HashMap<i64, String> = index.iter().map(|e| (e.0, crate_iso(&e.3))).collect();
            let changed: Vec<i64> = index.iter().filter(|e| local.get(&e.0).map(|m| m != &crate_iso(&e.3)).unwrap_or(true)).map(|e| e.0).collect();
            let removed: Vec<i64> = local.keys().filter(|id| !remote.contains_key(id)).copied().collect();
            let total = changed.len();
            for (n, chunk) in changed.chunks(500).enumerate() {
                progress(Progress { phase: "pull".into(), done: n * 500, total, message: format!("Updating {total} changed products") });
                let page = driver.catalog_by_ids(chunk).await?;
                let mut c = cache.lock().unwrap();
                c.upsert_products(&page.products)?;
                c.upsert_media(&page.media)?;
            }
            cache.lock().unwrap().delete_products(&removed)?;
            report.fetched = total;
            report.removed = removed.len();
        }
        index => {
            report.mode = "full".into();
            let total = index.as_ref().map(|i| i.len()).unwrap_or(0);
            let mut seen = HashSet::new();
            let mut after = 0i64;
            let limit = 500;
            loop {
                progress(Progress { phase: "pull".into(), done: seen.len(), total, message: "Downloading catalog".into() });
                let page = driver.catalog_page(after, limit).await?;
                for p in &page.products {
                    seen.insert(p.id);
                }
                {
                    let mut c = cache.lock().unwrap();
                    c.upsert_products(&page.products)?;
                    c.upsert_media(&page.media)?;
                }
                match page.next_after {
                    Some(n) if n != after => after = n,
                    _ => break,
                }
            }
            let local = cache.lock().unwrap().product_ids_with_modified()?;
            let removed: Vec<i64> = local.keys().filter(|id| !seen.contains(id)).copied().collect();
            cache.lock().unwrap().delete_products(&removed)?;
            report.fetched = seen.len();
            report.removed = removed.len();
        }
    }
    let c = cache.lock().unwrap();
    report.products = c.product_count()?;
    c.kv_set("last_pull", &chrono::Utc::now().timestamp().to_string())?;
    report.elapsed_ms = start.elapsed().as_millis();
    progress(Progress { phase: "pull".into(), done: report.fetched, total: report.fetched, message: "Up to date".into() });
    Ok(report)
}

/// Index timestamps are MySQL "Y-m-d H:i:s"; cached records carry ISO "Y-m-dTH:i:sZ".
fn crate_iso(mysql: &str) -> String {
    if mysql.contains('T') {
        return if mysql.ends_with('Z') { mysql.to_string() } else { format!("{mysql}Z") };
    }
    format!("{}Z", mysql.replacen(' ', "T", 1))
}

/* ===================================================================== push */

const MEDIA_FIELDS: &[&str] = &["image_id", "gallery_ids", "banner_id"];

/// A media reference staged by the UI: `{"file": "/abs/a.jpg"}` or `{"url": "https://…"}`.
fn media_ref(v: &Value) -> Option<(String, String)> {
    let o = v.as_object()?;
    if let Some(f) = o.get("file").and_then(Value::as_str) {
        return Some(("file".into(), f.to_string()));
    }
    o.get("url").and_then(Value::as_str).map(|u| ("url".into(), u.to_string()))
}

fn ref_id(r: &(String, String)) -> String {
    format!("{}:{}", r.0, r.1)
}

/// Converts staged values for transport: `new:x` → `ref:new:x`.
fn to_wire(v: &Value) -> Value {
    match v {
        Value::String(s) if s.starts_with(NEW_PREFIX) => json!(format!("ref:{s}")),
        Value::Array(a) => Value::Array(a.iter().map(to_wire).collect()),
        other => other.clone(),
    }
}

fn substitute_refs(v: &mut Value, ids: &HashMap<String, i64>) {
    match v {
        Value::String(s) if s.starts_with("ref:") => {
            if let Some(id) = ids.get(&s[4..]) {
                *v = json!(id);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| substitute_refs(x, ids)),
        Value::Object(o) => o.values_mut().for_each(|x| substitute_refs(x, ids)),
        _ => {}
    }
}

struct PreparedOp {
    op: Op,
    key: String,
    label: String,
    base: Map<String, Value>,
    fields: Vec<String>,
}

/// Uploads every `{file}`/`{url}` media reference in the staging area and swaps it for a media id.
async fn resolve_media(driver: &dyn Driver, cache: &Mutex<Cache>, settings: &MediaSettings, report: &mut PushReport, progress: &ProgressFn) -> Result<()> {
    let caps = driver.capabilities();
    let staged = cache.lock().unwrap().staged_map()?;
    let hs: Handshake = cache.lock().unwrap().kv_get("handshake")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();

    // ref → (name variables, alt text)
    let mut refs: BTreeMap<String, ((String, String), String, String, usize)> = BTreeMap::new();
    // When one file is used by several records, name it after a product first.
    let mut ordered: Vec<_> = staged.iter().collect();
    ordered.sort_by_key(|((entity, _), _)| match entity {
        Entity::Product => 0,
        Entity::Variation => 1,
        _ => 2,
    });
    for ((_, key), fields) in ordered {
        let get = |f: &str| fields.get(f).map(|v| v.0.clone());
        let base = key.parse::<i64>().ok().and_then(|id| cache.lock().unwrap().product(id).ok().flatten());
        let name = get("name").and_then(|v| v.as_str().map(String::from)).or_else(|| base.as_ref().map(|b| b.name.clone())).unwrap_or_default();
        let sku = get("sku").and_then(|v| v.as_str().map(String::from)).or_else(|| base.as_ref().map(|b| b.sku.clone())).unwrap_or_default();
        let mut n = 0;
        for f in MEDIA_FIELDS {
            let Some((v, _, _)) = fields.get(*f) else { continue };
            let items: Vec<&Value> = match v {
                Value::Array(a) => a.iter().collect(),
                other => vec![other],
            };
            for item in items {
                if let Some(r) = media_ref(item) {
                    n += 1;
                    let alt = item.get("alt").and_then(Value::as_str).map(String::from).unwrap_or_else(|| name.clone());
                    refs.entry(ref_id(&r)).or_insert((r, format!("{sku}\u{1}{name}"), alt, n));
                }
            }
        }
    }
    if refs.is_empty() {
        return Ok(());
    }
    if caps.media_by_url_only {
        if let Some((_, (r, ..))) = refs.iter().find(|(_, (r, ..))| r.0 == "file") {
            return Err(anyhow!("Local image files ({}) need the CatalogForge Connector plugin; the stock REST API only accepts public image URLs.", r.1));
        }
        return Ok(()); // URL refs are sent as image_urls in the payload.
    }

    let total = refs.len();
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build()?;
    let sizes = hs.image_sizes.clone();
    let mut settings = settings.clone();
    if hs.big_image_threshold > 0 {
        settings.max_dimension = settings.max_dimension.min(hs.big_image_threshold).max(1);
    }
    let done = Arc::new(Mutex::new(0usize));
    let results: Vec<(String, Result<MediaUploadResult>, usize)> = stream::iter(refs.into_iter())
        .map(|(id, ((kind, src), vars, alt, n))| {
            let client = client.clone();
            let sizes = sizes.clone();
            let settings = settings.clone();
            let done = done.clone();
            let progress = progress.clone();
            async move {
                let (sku, name) = vars.split_once('\u{1}').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or_default();
                let res: Result<(MediaUploadResult, usize)> = async {
                    let bytes = if kind == "file" { tokio::fs::read(&src).await.map_err(|e| anyhow!("{src}: {e}"))? } else { media::fetch_url(&client, &src).await? };
                    let fallback = std::path::Path::new(&src).file_stem().and_then(|s| s.to_str()).unwrap_or("image").to_string();
                    let stem = media::render_name(&settings.name_template, &[("sku", &sku), ("name", &name), ("n", &n.to_string())], &fallback);
                    let prepared = tokio::task::spawn_blocking(move || media::prepare(&bytes, &stem, &sizes, &settings)).await??;
                    let size = prepared.total_bytes();
                    let up = driver.upload_media(&prepared, &MediaText { alt: alt.clone(), title: name.clone(), ..Default::default() }).await?;
                    Ok((up, size))
                }
                .await;
                let mut d = done.lock().unwrap();
                *d += 1;
                progress(Progress { phase: "media".into(), done: *d, total, message: format!("Optimising and uploading images ({}/{total})", *d) });
                match res {
                    Ok((up, size)) => (id, Ok(up), size),
                    Err(e) => (id, Err(e), 0),
                }
            }
        })
        .buffer_unordered(caps.write_concurrency.max(2) * 2)
        .collect()
        .await;

    let mut map: HashMap<String, i64> = HashMap::new();
    for (id, res, size) in results {
        match res {
            Ok(up) => {
                if up.deduplicated {
                    report.media_deduplicated += 1;
                } else {
                    report.media_uploaded += 1;
                    report.media_bytes += size;
                }
                cache.lock().unwrap().upsert_media(std::slice::from_ref(&up.media))?;
                map.insert(id, up.media.id);
            }
            Err(e) => report.errors.push(PushError { entity: Some(Entity::Media), key: id.clone(), label: id.split_once(':').map(|x| x.1.to_string()).unwrap_or(id), message: e.to_string() }),
        }
    }
    // Swap references for ids directly in the staging table (not an undoable user edit).
    let c = cache.lock().unwrap();
    let mut stmt = c.conn().prepare("SELECT rowid, field, value FROM staged")?;
    let rows: Vec<(i64, String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for (rowid, field, raw) in rows {
        if !MEDIA_FIELDS.contains(&field.as_str()) {
            continue;
        }
        let mut v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let mut touched = false;
        let mut swap = |x: &mut Value| {
            if let Some(r) = media_ref(x) {
                if let Some(id) = map.get(&ref_id(&r)) {
                    *x = json!(id);
                    touched = true;
                }
            }
        };
        match &mut v {
            Value::Array(a) => a.iter_mut().for_each(&mut swap),
            other => swap(other),
        }
        if touched {
            c.conn().execute("UPDATE staged SET value = ?2 WHERE rowid = ?1", rusqlite::params![rowid, serde_json::to_string(&v)?])?;
        }
    }
    Ok(())
}

fn build_ops(cache: &Cache, url_media: bool) -> Result<Vec<PreparedOp>> {
    let staged = cache.staged_map()?;
    let mut ops = Vec::new();
    for ((entity, key), fields) in staged {
        let label = fields
            .get("name")
            .and_then(|v| v.0.as_str().map(String::from))
            .or_else(|| key.parse::<i64>().ok().and_then(|id| cache.product(id).ok().flatten()).map(|p| if p.name.is_empty() { p.sku } else { p.name }))
            .unwrap_or_else(|| key.clone());
        if fields.contains_key(DELETE_FIELD) {
            let id = key.parse::<i64>().ok();
            ops.push(PreparedOp {
                op: Op { op: OpKind::Delete, entity, r#ref: Some(key.clone()), id, r#match: None, data: Map::new(), base: Map::new(), force: entity == Entity::Variation },
                key,
                label,
                base: Map::new(),
                fields: vec![DELETE_FIELD.into()],
            });
            continue;
        }
        let is_new = key.starts_with(NEW_PREFIX);
        let mut data = Map::new();
        let mut base = Map::new();
        let mut names = Vec::new();
        let mut image_urls: Vec<Value> = Vec::new();
        for (f, (v, b, _)) in &fields {
            if f.starts_with("__") {
                continue;
            }
            names.push(f.clone());
            if url_media && MEDIA_FIELDS.contains(&f.as_str()) {
                // Stock REST: images by URL are attached on save.
                let items: Vec<Value> = match v {
                    Value::Array(a) => a.clone(),
                    other => vec![other.clone()],
                };
                let mut ids = Vec::new();
                for it in items {
                    match media_ref(&it) {
                        Some((_, url)) => image_urls.push(json!(url)),
                        None => ids.push(it),
                    }
                }
                if f == "gallery_ids" {
                    data.insert(f.clone(), Value::Array(ids));
                } else if let Some(first) = ids.into_iter().next() {
                    data.insert(f.clone(), first);
                } else if entity == Entity::Variation {
                    if let Some(u) = image_urls.pop() {
                        data.insert("image_url".into(), u);
                    }
                }
                continue;
            }
            data.insert(f.clone(), to_wire(v));
            if !is_new {
                if let Some(b) = b {
                    base.insert(f.clone(), b.clone());
                }
            }
        }
        if !image_urls.is_empty() {
            data.insert("image_urls".into(), Value::Array(image_urls));
        }
        if data.is_empty() && !is_new {
            continue;
        }
        let r#match = if is_new {
            data.get("sku").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| {
                let mut m = Map::new();
                m.insert("sku".into(), json!(s));
                m
            })
        } else {
            None
        };
        ops.push(PreparedOp {
            op: Op { op: OpKind::Upsert, entity, r#ref: Some(key.clone()), id: key.parse().ok(), r#match, data, base: base.clone(), force: false },
            key,
            label,
            base,
            fields: names,
        });
    }
    Ok(ops)
}

fn phase_of(op: &Op) -> usize {
    match (&op.op, op.entity) {
        (OpKind::Upsert, Entity::Category) => 0,
        (OpKind::Upsert, Entity::Tag) | (OpKind::Upsert, Entity::Media) => 1,
        (OpKind::Upsert, Entity::Product) => 2,
        (OpKind::Upsert, Entity::Variation) => 3,
        (OpKind::Delete, Entity::Variation) => 4,
        (OpKind::Delete, Entity::Product) => 5,
        (OpKind::Delete, _) => 6,
    }
}

/// Orders new categories so parents come before children.
fn sort_categories(ops: &mut [PreparedOp]) {
    let mut depth: HashMap<String, usize> = HashMap::new();
    let parents: HashMap<String, String> = ops
        .iter()
        .filter_map(|p| p.op.data.get("parent").and_then(Value::as_str).and_then(|s| s.strip_prefix("ref:")).map(|parent| (p.key.clone(), parent.to_string())))
        .collect();
    fn d(k: &str, parents: &HashMap<String, String>, memo: &mut HashMap<String, usize>, guard: usize) -> usize {
        if guard > 64 {
            return 0;
        }
        if let Some(v) = memo.get(k) {
            return *v;
        }
        let v = parents.get(k).map(|p| 1 + d(p, parents, memo, guard + 1)).unwrap_or(0);
        memo.insert(k.to_string(), v);
        v
    }
    for p in ops.iter() {
        d(&p.key, &parents, &mut depth, 0);
    }
    ops.sort_by_key(|p| depth.get(&p.key).copied().unwrap_or(0));
}

pub async fn push(driver: &dyn Driver, cache: &Mutex<Cache>, settings: &MediaSettings, label: &str, progress: ProgressFn) -> Result<PushReport> {
    let start = Instant::now();
    let caps = driver.capabilities();
    if !caps.write {
        return Err(anyhow!("This connection is read-only. Add the CatalogForge Connector plugin to push changes."));
    }
    let mut report = PushReport::default();
    if cache.lock().unwrap().kv_get("handshake")?.is_none() {
        let hs = driver.handshake().await?;
        cache.lock().unwrap().kv_set("handshake", &serde_json::to_string(&hs)?)?;
    }
    resolve_media(driver, cache, settings, &mut report, &progress).await?;

    let mut ops = build_ops(&cache.lock().unwrap(), caps.media_by_url_only)?;
    if ops.is_empty() {
        report.elapsed_ms = start.elapsed().as_millis();
        return Ok(report);
    }
    ops.sort_by_key(|p| phase_of(&p.op));
    let history_id = cache.lock().unwrap().begin_history(label)?;
    report.history_id = Some(history_id);

    let total = ops.len();
    let mut done = 0usize;
    let mut ids: HashMap<String, i64> = HashMap::new();
    let mut phases: BTreeMap<usize, Vec<PreparedOp>> = BTreeMap::new();
    for p in ops {
        phases.entry(phase_of(&p.op)).or_default().push(p);
    }
    let batch = caps.batch_size.max(1);

    for (phase, mut list) in phases {
        if phase == 0 {
            sort_categories(&mut list);
        }
        // Categories depend on each other, so they go strictly in order; other phases are independent.
        let concurrency = if phase == 0 { 1 } else { caps.write_concurrency.max(1) };
        let mut chunks: Vec<Vec<PreparedOp>> = Vec::new();
        let mut it = list.into_iter().peekable();
        while it.peek().is_some() {
            chunks.push(it.by_ref().take(batch).collect());
        }
        let mut waves: Vec<Vec<Vec<PreparedOp>>> = Vec::new();
        let mut cur = Vec::new();
        for c in chunks {
            cur.push(c);
            if cur.len() == concurrency {
                waves.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            waves.push(cur);
        }
        for wave in waves {
            let ids_snapshot = ids.clone();
            let futures = wave.into_iter().map(|mut chunk| {
                let ids = ids_snapshot.clone();
                async move {
                    for p in chunk.iter_mut() {
                        for v in p.op.data.values_mut() {
                            substitute_refs(v, &ids);
                        }
                    }
                    let wire: Vec<Op> = chunk.iter().map(|p| p.op.clone()).collect();
                    let res = driver.batch(&wire, true).await;
                    (chunk, res)
                }
            });
            let results = futures::future::join_all(futures).await;
            for (chunk, res) in results {
                done += chunk.len();
                progress(Progress { phase: "write".into(), done, total, message: format!("Saving to store ({done}/{total})") });
                match res {
                    Ok(resp) => apply_results(cache, history_id, &chunk, &resp, &mut ids, &mut report)?,
                    Err(e) => {
                        for p in &chunk {
                            report.failed += 1;
                            report.errors.push(PushError { entity: Some(p.op.entity), key: p.key.clone(), label: p.label.clone(), message: e.to_string() });
                        }
                    }
                }
            }
        }
    }
    let new_ids: HashMap<String, i64> = ids.iter().filter(|(k, _)| k.starts_with(NEW_PREFIX)).map(|(k, v)| (k.clone(), *v)).collect();
    {
        let mut c = cache.lock().unwrap();
        c.rewrite_new_refs(&new_ids)?;
        c.finish_history(history_id, report.created as i64, report.updated as i64, report.deleted as i64, report.failed as i64)?;
    }
    report.elapsed_ms = start.elapsed().as_millis();
    progress(Progress { phase: "done".into(), done: total, total, message: "Saved".into() });
    Ok(report)
}

fn apply_results(cache: &Mutex<Cache>, history_id: i64, chunk: &[PreparedOp], resp: &BatchResponse, ids: &mut HashMap<String, i64>, report: &mut PushReport) -> Result<()> {
    let mut c = cache.lock().unwrap();
    for (i, p) in chunk.iter().enumerate() {
        let r = resp.results.get(i).cloned().or_else(|| resp.results.iter().find(|r| r.r#ref.as_deref() == Some(p.key.as_str())).cloned()).unwrap_or_default();
        if let Some(id) = r.id {
            ids.insert(p.key.clone(), id);
        }
        if r.ok {
            let id = r.id.unwrap_or(0);
            match r.action.as_str() {
                "deleted" => {
                    report.deleted += 1;
                    match p.op.entity {
                        Entity::Product | Entity::Variation => c.delete_products(&[id])?,
                        Entity::Category => {
                            c.conn().execute("DELETE FROM categories WHERE id = ?1", [id])?;
                        }
                        _ => {}
                    }
                    c.clear_staged(p.op.entity, &p.key, None)?;
                    c.add_history_item(history_id, &HistoryItem { entity: p.op.entity, id, label: p.label.clone(), field: DELETE_FIELD.into(), before: Value::Null, after: json!(true), action: "deleted".into() })?;
                }
                action => {
                    let created = action == "created" || p.key.starts_with(NEW_PREFIX);
                    if created {
                        report.created += 1;
                        c.add_history_item(history_id, &HistoryItem { entity: p.op.entity, id, label: p.label.clone(), field: NEW_FIELD.into(), before: Value::Null, after: json!(true), action: "created".into() })?;
                    } else {
                        report.updated += 1;
                    }
                    for f in &p.fields {
                        c.add_history_item(
                            history_id,
                            &HistoryItem {
                                entity: p.op.entity,
                                id,
                                label: p.label.clone(),
                                field: f.clone(),
                                before: p.base.get(f).cloned().unwrap_or(Value::Null),
                                after: p.op.data.get(f).cloned().unwrap_or(Value::Null),
                                action: if created { "created_field".into() } else { "updated".into() },
                            },
                        )?;
                    }
                    if let Some(record) = &r.record {
                        match p.op.entity {
                            Entity::Product | Entity::Variation => {
                                if let Ok(prod) = serde_json::from_value::<Product>(record.clone()) {
                                    c.upsert_products(&[prod])?;
                                }
                            }
                            Entity::Category => {
                                if let Ok(cat) = serde_json::from_value::<Category>(record.clone()) {
                                    c.upsert_category(&cat)?;
                                }
                            }
                            Entity::Media => {
                                if let Ok(m) = serde_json::from_value::<Media>(record.clone()) {
                                    c.upsert_media(&[m])?;
                                }
                            }
                            Entity::Tag => {}
                        }
                    }
                    c.clear_staged(p.op.entity, &p.key, None)?;
                }
            }
        } else if r.action == "conflict" {
            report.conflicts += 1;
            for cf in &r.conflicts {
                c.set_conflict(p.op.entity, &p.key, &cf.field, &serde_json::to_value(cf)?)?;
            }
        } else {
            report.failed += 1;
            report.errors.push(PushError { entity: Some(p.op.entity), key: p.key.clone(), label: p.label.clone(), message: r.error.clone().unwrap_or_else(|| format!("Store reported '{}'", r.action)) });
        }
    }
    Ok(())
}

/* ============================================================ cross-store clone */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CloneOptions {
    /// Update products in the target that share a SKU instead of creating duplicates.
    pub match_sku: bool,
    pub include_images: bool,
    pub include_variations: bool,
    /// Status for created products (e.g. "draft" when promoting to production).
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CloneReport {
    pub created: usize,
    pub updated: usize,
    pub categories_created: usize,
}

fn category_path(cats: &HashMap<i64, Category>, id: i64) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = cats.get(&id);
    let mut guard = 0;
    while let Some(c) = cur {
        out.push(c.name.clone());
        cur = cats.get(&c.parent);
        guard += 1;
        if guard > 32 {
            break;
        }
    }
    out.reverse();
    out
}

const CLONE_FIELDS: &[&str] = &[
    "name", "slug", "status", "sku", "global_unique_id", "regular_price", "sale_price", "date_on_sale_from", "date_on_sale_to", "manage_stock", "stock_quantity",
    "stock_status", "backorders", "weight", "length", "width", "height", "shipping_class", "tax_status", "tax_class", "description", "short_description", "menu_order",
    "featured", "catalog_visibility", "virtual", "downloadable", "tags", "attributes", "variation_attributes", "external_url", "button_text", "seo_title", "seo_description",
    "focus_keyword",
];

/// Stages copies of `src` products in `dst`, mapping categories by path, matching existing
/// products by SKU and carrying images by URL (downloaded and re-uploaded on push).
pub fn clone_products(src: &Cache, src_store: &str, dst: &mut Cache, ids: &[i64], opts: &CloneOptions) -> Result<CloneReport> {
    let mut report = CloneReport::default();
    let src_cats: HashMap<i64, Category> = src.categories()?.into_iter().map(|c| (c.id, c)).collect();
    let dst_cats = dst.categories()?;
    let dst_by_path: HashMap<Vec<String>, i64> = {
        let m: HashMap<i64, Category> = dst_cats.iter().map(|c| (c.id, c.clone())).collect();
        dst_cats.iter().map(|c| (category_path(&m, c.id), c.id)).collect()
    };
    let mut new_cat_keys: HashMap<Vec<String>, String> = HashMap::new();
    let mut creates: Vec<(Entity, Option<String>, Map<String, Value>)> = Vec::new();
    let mut edits: Vec<Edit> = Vec::new();

    let mut resolve_cat = |path: Vec<String>, creates: &mut Vec<(Entity, Option<String>, Map<String, Value>)>, report: &mut CloneReport| -> Value {
        if let Some(id) = dst_by_path.get(&path) {
            return json!(id);
        }
        let mut parent = json!(0);
        for depth in 1..=path.len() {
            let prefix = path[..depth].to_vec();
            if let Some(id) = dst_by_path.get(&prefix) {
                parent = json!(id);
                continue;
            }
            let key = new_cat_keys.entry(prefix.clone()).or_insert_with(|| {
                let key = format!("{NEW_PREFIX}{}", uuid::Uuid::new_v4().simple());
                let mut f = Map::new();
                f.insert("name".into(), json!(prefix.last().unwrap()));
                f.insert("parent".into(), parent.clone());
                creates.push((Entity::Category, Some(key.clone()), f));
                report.categories_created += 1;
                key
            });
            parent = json!(key.clone());
        }
        parent
    };

    let src_media = |id: i64| -> Option<Value> { src.media(&[id]).ok()?.into_iter().next().map(|m| json!({ "url": m.url, "alt": m.alt })) };

    let mut queue: Vec<i64> = ids.to_vec();
    if opts.include_variations {
        for id in ids {
            queue.extend(src.children(*id)?);
        }
    }
    let mut new_keys: HashMap<i64, Value> = HashMap::new();
    for id in queue {
        let Some(p) = src.product(id)? else { continue };
        let pv = serde_json::to_value(&p)?;
        let mut fields = Map::new();
        for f in CLONE_FIELDS {
            if let Some(v) = pv.get(*f) {
                if !(v.is_null() || v.as_str() == Some("") || v.as_array().map(|a| a.is_empty()).unwrap_or(false) || v.as_object().map(|o| o.is_empty()).unwrap_or(false)) {
                    fields.insert((*f).to_string(), v.clone());
                }
            }
        }
        fields.insert("type".into(), json!(p.kind));
        if p.kind != "variation" {
            let cats: Vec<Value> = p.category_ids.iter().map(|cid| resolve_cat(category_path(&src_cats, *cid), &mut creates, &mut report)).collect();
            fields.insert("category_ids".into(), Value::Array(cats));
            if let Some(s) = &opts.status {
                fields.insert("status".into(), json!(s));
            }
        } else {
            match new_keys.get(&p.parent_id) {
                Some(parent) => {
                    fields.insert("parent_id".into(), parent.clone());
                }
                None => continue,
            }
        }
        if opts.include_images {
            if p.image_id > 0 {
                if let Some(m) = src_media(p.image_id) {
                    fields.insert("image_id".into(), m);
                }
            }
            if !p.gallery_ids.is_empty() {
                fields.insert("gallery_ids".into(), Value::Array(p.gallery_ids.iter().filter_map(|g| src_media(*g)).collect()));
            }
        }
        fields.insert("meta".into(), json!({ "_cf_source": format!("{src_store}:{}", p.id) }));
        let entity = if p.kind == "variation" { Entity::Variation } else { Entity::Product };
        let existing = if opts.match_sku { dst.product_by_sku(&p.sku)? } else { None };
        match existing {
            Some(e) => {
                report.updated += 1;
                new_keys.insert(p.id, json!(e.id));
                for (f, v) in fields {
                    if f != "type" && f != "parent_id" {
                        edits.push(Edit { entity, key: e.id.to_string(), field: f, value: Some(v) });
                    }
                }
            }
            None => {
                report.created += 1;
                let key = format!("{NEW_PREFIX}{}", uuid::Uuid::new_v4().simple());
                new_keys.insert(p.id, json!(key.clone()));
                creates.push((entity, Some(key), fields));
            }
        }
    }
    // One undoable step for the whole clone.
    let mut all_edits = Vec::new();
    for (entity, key, fields) in creates {
        let key = key.unwrap();
        all_edits.push(Edit { entity, key: key.clone(), field: NEW_FIELD.into(), value: Some(json!(true)) });
        for (f, v) in fields {
            all_edits.push(Edit { entity, key: key.clone(), field: f, value: Some(v) });
        }
    }
    all_edits.extend(edits);
    dst.stage(&all_edits)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_refs() {
        assert_eq!(to_wire(&json!(["new:a", 5])), json!(["ref:new:a", 5]));
        let mut v = json!({ "p": "ref:new:a", "c": ["ref:new:b", 3] });
        substitute_refs(&mut v, &HashMap::from([("new:a".to_string(), 10)]));
        assert_eq!(v, json!({ "p": 10, "c": ["ref:new:b", 3] }));
    }

    #[test]
    fn iso_normalisation() {
        assert_eq!(crate_iso("2026-01-02 03:04:05"), "2026-01-02T03:04:05Z");
        assert_eq!(crate_iso("2026-01-02T03:04:05"), "2026-01-02T03:04:05Z");
    }

    #[test]
    fn builds_ops_with_bases_and_refs() {
        let mut c = Cache::open_in_memory().unwrap();
        c.upsert_products(&[Product { id: 1, name: "A".into(), kind: "variable".into(), regular_price: "5".into(), ..Default::default() }]).unwrap();
        let cat = c.create(Entity::Category, serde_json::from_value(json!({ "name": "C" })).unwrap()).unwrap();
        c.stage(&[Edit { entity: Entity::Product, key: "1".into(), field: "category_ids".into(), value: Some(json!([cat.clone()])) }]).unwrap();
        c.stage(&[Edit { entity: Entity::Product, key: "1".into(), field: "regular_price".into(), value: Some(json!("6")) }]).unwrap();
        let v = c.create(Entity::Variation, serde_json::from_value(json!({ "parent_id": 1, "sku": "A-1" })).unwrap()).unwrap();
        let ops = build_ops(&c, false).unwrap();
        let prod = ops.iter().find(|o| o.key == "1").unwrap();
        assert_eq!(prod.op.data["category_ids"], json!([format!("ref:{cat}")]));
        assert_eq!(prod.op.base["regular_price"], json!("5"));
        let var = ops.iter().find(|o| o.key == v).unwrap();
        assert_eq!(var.op.r#match.as_ref().unwrap()["sku"], "A-1");
        assert!(var.op.base.is_empty());
        let mut sorted: Vec<_> = ops.iter().map(|o| phase_of(&o.op)).collect();
        sorted.sort();
        assert_eq!(sorted, vec![0, 2, 3]);
    }

    #[test]
    fn clone_maps_categories_by_path_and_matches_sku() {
        let mut src = Cache::open_in_memory().unwrap();
        src.replace_taxonomy(&Taxonomy {
            categories: vec![Category { id: 1, name: "Apparel".into(), ..Default::default() }, Category { id: 2, parent: 1, name: "Tees".into(), ..Default::default() }],
            ..Default::default()
        })
        .unwrap();
        src.upsert_products(&[
            Product { id: 10, name: "Tee".into(), sku: "T1".into(), kind: "simple".into(), category_ids: vec![2], regular_price: "9".into(), ..Default::default() },
            Product { id: 11, name: "Cap".into(), sku: "C1".into(), kind: "simple".into(), category_ids: vec![1], regular_price: "5".into(), ..Default::default() },
        ])
        .unwrap();
        let mut dst = Cache::open_in_memory().unwrap();
        dst.replace_taxonomy(&Taxonomy { categories: vec![Category { id: 100, name: "Apparel".into(), ..Default::default() }], ..Default::default() }).unwrap();
        dst.upsert_products(&[Product { id: 500, name: "Cap old".into(), sku: "C1".into(), kind: "simple".into(), regular_price: "4".into(), ..Default::default() }]).unwrap();
        let r = clone_products(&src, "local", &mut dst, &[10, 11], &CloneOptions { match_sku: true, status: Some("draft".into()), ..Default::default() }).unwrap();
        assert_eq!((r.created, r.updated, r.categories_created), (1, 1, 1));
        let ops = build_ops(&dst, false).unwrap();
        let cat = ops.iter().find(|o| o.op.entity == Entity::Category).unwrap();
        assert_eq!(cat.op.data["parent"], json!(100));
        let tee = ops.iter().find(|o| o.op.data.get("sku") == Some(&json!("T1"))).unwrap();
        assert_eq!(tee.op.data["category_ids"], json!([format!("ref:{}", cat.key)]));
        assert_eq!(tee.op.data["status"], "draft");
        let cap = ops.iter().find(|o| o.key == "500").unwrap();
        assert_eq!(cap.op.data["regular_price"], "5");
        assert_eq!(cap.op.data["category_ids"], json!([100]));
    }
}
