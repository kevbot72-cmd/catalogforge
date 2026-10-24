// Mirrors forge-core's serde types. Keep field names identical to the Rust/PHP wire format.

export type Entity = "category" | "tag" | "media" | "product" | "variation";
export type Environment = "local" | "staging" | "production";

export interface ProductAttribute {
  name: string;
  taxonomy: string;
  options: string[];
  visible: boolean;
  variation: boolean;
  position: number;
}

/** A media reference staged before upload: a local file or a remote URL. */
export interface MediaRef {
  file?: string;
  url?: string;
  alt?: string;
  /** UI-only preview URL (object URL / asset URL). Ignored by the engine. */
  preview?: string;
}
export type MediaValue = number | MediaRef;

export interface Product {
  id: number;
  parent_id: number | string;
  type: string;
  status: string;
  name: string;
  slug: string;
  sku: string;
  global_unique_id: string;
  regular_price: string;
  sale_price: string;
  date_on_sale_from: string | null;
  date_on_sale_to: string | null;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  backorders: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  shipping_class: string;
  tax_status: string;
  tax_class: string;
  description: string;
  short_description: string;
  menu_order: number;
  featured: boolean;
  catalog_visibility: string;
  virtual: boolean;
  downloadable: boolean;
  category_ids: (number | string)[];
  tags: string[];
  attributes: ProductAttribute[];
  variation_attributes: Record<string, string>;
  image_id: MediaValue;
  gallery_ids: MediaValue[];
  external_url: string;
  button_text: string;
  permalink: string;
  seo_title: string;
  seo_description: string;
  focus_keyword: string;
  date_created_gmt: string | null;
  date_modified_gmt: string | null;
  [extra: string]: unknown;
}

export interface RowState {
  key: string;
  is_new: boolean;
  deleted: boolean;
  dirty: string[];
  conflicts: string[];
}

export type ProductRow = Product & { _state: RowState };

export interface Category {
  id: number;
  parent: number | string;
  name: string;
  slug: string;
  description: string;
  count: number;
  display_type: string;
  image_id: MediaValue;
  banner_id: MediaValue;
  menu_order: number;
  seo_title: string;
  seo_description: string;
}
export type CategoryRow = Category & { _state: RowState };

export interface Media {
  id: number;
  url: string;
  thumb_url: string;
  medium_url: string;
  alt: string;
  title: string;
  filename: string;
  mime: string;
  width: number;
  height: number;
  sha256: string;
  parent_id: number;
}

export interface Term {
  id: number;
  name: string;
  slug: string;
}
export interface Tag extends Term {
  count: number;
}
export interface AttributeTaxonomy {
  id: number;
  name: string;
  taxonomy: string;
  type: string;
  terms: Term[];
}

export interface ImageSize {
  name: string;
  width: number;
  height: number;
  crop: boolean;
}

export interface Handshake {
  protocol: number;
  plugin_version: string;
  wp_version: string;
  wc_version: string | null;
  php_version: string;
  site_name: string;
  home_url: string;
  hpos: boolean;
  currency: string;
  currency_symbol: string;
  price_decimals: number;
  weight_unit: string;
  dimension_unit: string;
  image_sizes: ImageSize[];
  integrations: Record<string, boolean>;
}

export interface Capabilities {
  write: boolean;
  server_conflict_check: boolean;
  presized_media: boolean;
  media_by_url_only: boolean;
  preview: boolean;
  batch_size: number;
  write_concurrency: number;
}

export type ConnectionKind =
  | { kind: "connector"; base_url: string; key: string }
  | { kind: "rest"; base_url: string; consumer_key: string }
  | { kind: "mysql"; host: string; port: number; database: string; user: string; table_prefix: string; socket?: string | null; write_via?: ConnectionKind | null }
  | { kind: "local"; site_id: string }
  | { kind: "demo"; seed: number };

export interface StoreProfile {
  id: string;
  name: string;
  environment: Environment;
  color: string;
  connection: ConnectionKind;
  created_at: number;
  last_synced_at: number | null;
  /** Product meta from other plugins managed in this store; shown as `meta:<key>` fields. */
  custom_fields?: CustomField[];
}

export type CustomFieldKind = "text" | "longtext" | "number" | "yesno" | "date";

export interface CustomField {
  key: string;
  label: string;
  kind: CustomFieldKind;
}

/** A meta key found on the store's products. */
export interface MetaKeyInfo {
  key: string;
  count: number;
  sample: string;
  label: string;
  kind: CustomFieldKind;
  source: string;
}

export const META_PREFIX = "meta:";

export interface LocalSite {
  id: string;
  name: string;
  domain: string;
  path: string;
  wp_root: string;
  php_version: string | null;
  mysql_version: string | null;
  mysql_port: number | null;
  status: "running" | "halted" | "unknown";
  table_prefix: string;
  has_woocommerce: boolean;
  connector_installed: boolean;
  multisite: boolean;
}

export interface SortSpec {
  field: string;
  desc: boolean;
}

export interface ProductQuery {
  search?: string;
  category_id?: number | null;
  uncategorized?: boolean;
  status?: string | null;
  kind?: string | null;
  stock_status?: string | null;
  only_changed?: boolean;
  only_conflicts?: boolean;
  missing_image?: boolean;
  include_variations?: boolean;
  expanded?: string[];
  sort?: SortSpec[];
}

export interface QueryResult {
  keys: string[];
  total_products: number;
}

export interface Edit {
  entity: Entity;
  key: string;
  field: string;
  value: unknown | null;
}

export interface StagedChange {
  entity: Entity;
  key: string;
  label: string;
  field: string;
  base: unknown;
  value: unknown;
  conflict: { field: string; base: unknown; remote: unknown; incoming: unknown } | null;
}

export interface StagedSummary {
  created: number;
  modified: number;
  deleted: number;
  fields: number;
  conflicts: number;
  can_undo: boolean;
}

export interface PushError {
  entity: Entity | null;
  key: string;
  label: string;
  message: string;
}

export interface PushReport {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
  failed: number;
  media_uploaded: number;
  media_deduplicated: number;
  media_bytes: number;
  errors: PushError[];
  warnings?: string[];
  history_id: number | null;
  elapsed_ms: number;
}

export interface PullReport {
  mode: string;
  products: number;
  fetched: number;
  removed: number;
  categories: number;
  elapsed_ms: number;
}

export interface Progress {
  phase: string;
  done: number;
  total: number;
  message: string;
}

export interface HistoryEntry {
  id: number;
  at: number;
  label: string;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  reverted_by: number | null;
}

export interface HistoryItem {
  entity: Entity;
  id: number;
  label: string;
  field: string;
  before: unknown;
  after: unknown;
  action: string;
}

export interface StoreInfo {
  profile: StoreProfile;
  handshake: Handshake | null;
  capabilities: Capabilities;
  product_count: number;
  last_pull: number | null;
}

export interface TaxonomyData {
  categories: CategoryRow[];
  tags: Tag[];
  attributes: AttributeTaxonomy[];
  shipping_classes: Term[];
  tax_classes: string[];
}

export interface LocalFile {
  path: string;
  name: string;
  /** Preview URL usable in <img>. */
  url: string;
  size: number;
}

export interface MediaSettings {
  format: "webp" | "jpeg" | "original";
  quality: number;
  max_dimension: number;
  generate_sizes: boolean;
  name_template: string;
}

export interface CloneOptions {
  match_sku: boolean;
  include_images: boolean;
  include_variations: boolean;
  status: string | null;
}

export interface CloneReport {
  created: number;
  updated: number;
  categories_created: number;
}

export interface NewStoreInput {
  name: string;
  environment: Environment;
  color: string;
  connection:
    | { kind: "connector"; connection_string: string }
    | { kind: "rest"; base_url: string; consumer_key: string; consumer_secret: string }
    | { kind: "mysql"; host: string; port: number; database: string; user: string; password: string; table_prefix: string; connection_string?: string }
    | { kind: "local"; site_id: string }
    | { kind: "demo"; seed: number };
}

/** Everything the UI needs from the engine. Implemented by the Tauri bridge and by the in-browser demo. */
export interface Backend {
  readonly kind: "tauri" | "demo";
  listStores(): Promise<StoreProfile[]>;
  addStore(input: NewStoreInput): Promise<StoreProfile>;
  removeStore(id: string): Promise<void>;
  localSites(): Promise<LocalSite[]>;
  startLocalSite(siteId: string): Promise<void>;
  openStore(id: string): Promise<StoreInfo>;
  pull(id: string, full: boolean): Promise<PullReport>;
  query(id: string, q: ProductQuery): Promise<QueryResult>;
  rows(id: string, keys: string[]): Promise<ProductRow[]>;
  /** [sku, id, type] for every product on the store (light index for import matching). */
  skus(id: string): Promise<[string, number, string][]>;
  /** A parent's variations, including staged new ones. */
  variations(id: string, parentKey: string): Promise<ProductRow[]>;
  taxonomy(id: string): Promise<TaxonomyData>;
  media(id: string): Promise<Media[]>;
  stage(id: string, edits: Edit[]): Promise<StagedSummary>;
  create(id: string, items: { entity: Entity; key?: string; fields: Record<string, unknown> }[]): Promise<string[]>;
  remove(id: string, entity: Entity, keys: string[]): Promise<StagedSummary>;
  undo(id: string): Promise<StagedSummary>;
  discard(id: string, entity?: Entity, key?: string, field?: string): Promise<StagedSummary>;
  summary(id: string): Promise<StagedSummary>;
  changes(id: string): Promise<StagedChange[]>;
  resolveConflict(id: string, entity: Entity, key: string, field: string, keepMine: boolean): Promise<StagedSummary>;
  push(id: string, label: string): Promise<PushReport>;
  history(id: string): Promise<HistoryEntry[]>;
  historyItems(id: string, historyId: number): Promise<HistoryItem[]>;
  revert(id: string, historyId: number): Promise<StagedSummary>;
  preview(id: string, productId: number | null, draft: Record<string, unknown>): Promise<string>;
  cloneProducts(src: string, dst: string, ids: number[], opts: CloneOptions): Promise<CloneReport>;
  pickFiles(opts: { directory?: boolean; multiple?: boolean; extensions?: string[] }): Promise<LocalFile[]>;
  /** Asks where to save, then writes the bytes. Resolves to the saved path/name, or null if cancelled. */
  saveFile(opts: { defaultName: string; filterName: string; extension: string; bytes: Uint8Array; mime: string }): Promise<string | null>;
  /** Turns files dropped on the window into LocalFiles (paths on desktop, object URLs in the browser). */
  filesFromDrop(files: File[]): Promise<LocalFile[]>;
  /** Looks up image file locations from a spreadsheet; a location without an extension finds name.jpg/.png/…. Null where missing. */
  resolveImagePaths(paths: string[]): Promise<(LocalFile | null)[]>;
  getMediaSettings(): Promise<MediaSettings>;
  setMediaSettings(s: MediaSettings): Promise<void>;
  onProgress(cb: (storeId: string, p: Progress) => void): () => void;
  /** Plugin fields found on the store's products. */
  metaKeys(id: string): Promise<MetaKeyInfo[]>;
  /** Saves which plugin fields this store manages (then pull with full=true to load them). */
  setCustomFields(id: string, fields: CustomField[]): Promise<StoreProfile>;
}
