//! CatalogForge core engine.
//!
//! * [`connection`] — multi-store profiles and secret storage
//! * [`local`] — Local (Flywheel) site discovery
//! * [`drivers`] — connector plugin, WooCommerce REST, direct MySQL and Local drivers
//! * [`cache`] — per-store SQLite cache with staging, undo and push history
//! * [`sync`] — pull/push orchestration, media resolution and cross-store cloning
//! * [`custom_fields`] — product meta from other plugins, exposed as `meta:<key>` fields
//! * [`media`] — client-side image processing (WordPress sub-sizes, WebP, naming)

pub mod cache;
pub mod connection;
pub mod custom_fields;
pub mod drivers;
pub mod local;
pub mod media;
pub mod model;
pub mod phpser;
pub mod signing;
pub mod sync;

pub use cache::Cache;
pub use drivers::Driver;
