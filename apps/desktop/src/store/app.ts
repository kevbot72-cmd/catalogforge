import { create } from "zustand";
import { applyAppearance, isDark, loadAppearance, saveAppearance, type Appearance } from "../lib/theme";
import type { Backend, Edit, Entity, Media, ProductQuery, Progress, StagedSummary, StoreInfo, StoreProfile, TaxonomyData } from "../backend/types";

export type View = "products" | "batch" | "categories" | "media" | "catalogue" | "migration" | "history" | "settings";
export type Dialog = null | "add-store" | "import" | "export" | "mass-change" | "clone" | "variations" | "palette" | "push-confirm";

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  title: string;
  body?: string;
}

/** Bottom (or right-docked) edit panel on the Products page. */
export interface PanelPrefs {
  open: boolean;
  dock: "bottom" | "right";
  /** Height when docked at the bottom, width when docked on the right (px). */
  bottomSize: number;
  rightSize: number;
  section: string;
}

const DEFAULT_PANEL: PanelPrefs = { open: true, dock: "bottom", bottomSize: 340, rightSize: 460, section: "general" };

function loadPanel(): PanelPrefs {
  try {
    return { ...DEFAULT_PANEL, ...JSON.parse(localStorage.getItem("cf.panel") ?? "{}") };
  } catch {
    return DEFAULT_PANEL;
  }
}

const EMPTY_SUMMARY: StagedSummary = { created: 0, modified: 0, deleted: 0, fields: 0, conflicts: 0, can_undo: false };

interface AppState {
  backend: Backend;
  stores: StoreProfile[];
  storeId: string | null;
  info: StoreInfo | null;
  taxonomy: TaxonomyData | null;
  media: Map<number, Media>;
  summary: StagedSummary;
  view: View;
  dialog: Dialog;
  dialogArg: unknown;
  query: ProductQuery;
  selection: string[];
  drawerKey: string | null;
  changesOpen: boolean;
  progress: Progress | null;
  busy: string | null;
  /** Bumped whenever staged or server data changes, so views refetch. */
  version: number;
  toasts: Toast[];
  dark: boolean;
  appearance: Appearance;
  panel: PanelPrefs;
  /** Last row clicked in the grid; the edit panel shows it when nothing is ticked. */
  focusKey: string | null;
  /** Ticking a sub-category for a product also ticks its parent categories. */
  catWithParents: boolean;

  init(): Promise<void>;
  selectStore(id: string): Promise<void>;
  refreshStores(): Promise<void>;
  refreshMeta(): Promise<void>;
  setView(v: View): void;
  openDialog(d: Dialog, arg?: unknown): void;
  setQuery(q: Partial<ProductQuery>): void;
  setSelection(keys: string[]): void;
  openDrawer(key: string | null): void;
  toggleChanges(open?: boolean): void;
  stage(edits: Edit[]): Promise<void>;
  create(items: { entity: Entity; key?: string; fields: Record<string, unknown> }[]): Promise<string[]>;
  remove(entity: Entity, keys: string[]): Promise<void>;
  undo(): Promise<void>;
  discardAll(): Promise<void>;
  pull(full?: boolean, opts?: { auto?: boolean }): Promise<void>;
  /** Sync quietly when the window gets focus again (changes made in WordPress meanwhile). */
  autoSync: boolean;
  setAutoSync(v: boolean): void;
  /** Asks "Are you sure you want to push changes?" first; pushNow runs after Yes. */
  push(label?: string): Promise<void>;
  pushNow(label?: string): Promise<void>;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  setDark(d: boolean): void;
  setAppearance(a: Partial<Appearance>): void;
  setPanel(p: Partial<PanelPrefs>): void;
  setFocusKey(key: string | null): void;
  setCatWithParents(v: boolean): void;
}

let toastId = 0;
let autoSyncFailed = false;
let initStarted = false;

export const useApp = create<AppState>((set, get) => ({
  backend: null as unknown as Backend,
  stores: [],
  storeId: null,
  info: null,
  taxonomy: null,
  media: new Map(),
  summary: EMPTY_SUMMARY,
  view: "products",
  dialog: null,
  dialogArg: null,
  query: { sort: [{ field: "id", desc: true }], expanded: [] },
  selection: [],
  drawerKey: null,
  changesOpen: false,
  progress: null,
  busy: null,
  version: 0,
  toasts: [],
  catWithParents: (() => {
    try {
      return localStorage.getItem("cf.cat.withParents") === "1";
    } catch {
      return false;
    }
  })(),
  dark: false,
  autoSync: (() => {
    try {
      return localStorage.getItem("cf.autoSync") !== "0";
    } catch {
      return true;
    }
  })(),
  appearance: loadAppearance(),
  panel: loadPanel(),
  focusKey: null,

  async init() {
    // Idempotent: React StrictMode runs mount effects twice in development.
    if (initStarted) return;
    initStarted = true;
    const { backend } = get();
    backend.onProgress((id, p) => {
      if (id === get().storeId) set({ progress: p.phase === "done" ? null : p });
    });
    await get().refreshStores();
    let last: string | null = null;
    try {
      last = localStorage.getItem("cf.store");
    } catch {
      /* storage unavailable */
    }
    const stores = get().stores;
    const target = stores.find((s) => s.id === last) ?? stores[0];
    if (target) await get().selectStore(target.id);
  },

  async refreshStores() {
    set({ stores: await get().backend.listStores() });
  },

  async selectStore(id) {
    const { backend } = get();
    set({ storeId: id, busy: "Opening store", info: null, taxonomy: null, selection: [], focusKey: null, drawerKey: null, query: { sort: [{ field: "id", desc: true }], expanded: [] } });
    try {
      localStorage.setItem("cf.store", id);
    } catch {
      /* ignore */
    }
    try {
      let info = await backend.openStore(id);
      set({ info });
      if (!info.product_count && !info.last_pull) {
        set({ busy: "Downloading catalog" });
        const r = await backend.pull(id, true);
        info = await backend.openStore(id);
        set({ info });
        get().toast({ tone: "success", title: `Loaded ${r.products.toLocaleString()} products`, body: `${r.categories} categories in ${(r.elapsed_ms / 1000).toFixed(1)}s` });
      }
      await get().refreshMeta();
    } catch (e) {
      get().toast({ tone: "error", title: "Could not open store", body: String(e) });
    } finally {
      set({ busy: null, progress: null, version: get().version + 1 });
    }
  },

  async refreshMeta() {
    const { backend, storeId } = get();
    if (!storeId) return;
    const [taxonomy, media, summary] = await Promise.all([backend.taxonomy(storeId), backend.media(storeId), backend.summary(storeId)]);
    set({ taxonomy, media: new Map(media.map((m) => [m.id, m])), summary });
  },

  setView: (view) => set({ view, drawerKey: null }),
  openDialog: (dialog, dialogArg = null) => set({ dialog, dialogArg }),
  setQuery: (q) => set({ query: { ...get().query, ...q }, version: get().version + 1 }),
  setSelection: (selection) => set({ selection }),
  openDrawer: (drawerKey) => set({ drawerKey }),
  toggleChanges: (open) => set({ changesOpen: open ?? !get().changesOpen }),

  async stage(edits) {
    const { backend, storeId } = get();
    if (!storeId || !edits.length) return;
    const summary = await backend.stage(storeId, edits);
    set({ summary, version: get().version + 1 });
    if (edits.some((e) => e.entity === "category")) set({ taxonomy: await backend.taxonomy(storeId) });
  },

  async create(items) {
    const { backend, storeId } = get();
    if (!storeId) return [];
    const keys = await backend.create(storeId, items);
    const summary = await backend.summary(storeId);
    set({ summary, version: get().version + 1 });
    if (items.some((i) => i.entity === "category")) set({ taxonomy: await backend.taxonomy(storeId) });
    return keys;
  },

  async remove(entity, keys) {
    const { backend, storeId } = get();
    if (!storeId) return;
    const summary = await backend.remove(storeId, entity, keys);
    set({ summary, version: get().version + 1 });
    if (entity === "category") set({ taxonomy: await backend.taxonomy(storeId) });
    if (entity === "media") set({ media: new Map((await backend.media(storeId)).map((m) => [m.id, m])) });
  },

  async undo() {
    const { backend, storeId } = get();
    if (!storeId) return;
    const summary = await backend.undo(storeId);
    set({ summary, version: get().version + 1, taxonomy: await backend.taxonomy(storeId), media: new Map((await backend.media(storeId)).map((m) => [m.id, m])) });
  },

  async discardAll() {
    const { backend, storeId } = get();
    if (!storeId) return;
    const summary = await backend.discard(storeId);
    set({ summary, version: get().version + 1, taxonomy: await backend.taxonomy(storeId), media: new Map((await backend.media(storeId)).map((m) => [m.id, m])) });
  },

  async pull(full = false, opts = {}) {
    const { backend, storeId } = get();
    if (!storeId) return;
    set({ busy: opts.auto ? "Checking the store for changes" : "Syncing with store" });
    try {
      const r = await backend.pull(storeId, full);
      set({ info: await backend.openStore(storeId) });
      await get().refreshMeta();
      autoSyncFailed = false;
      // An automatic sync only speaks up when something actually changed on the store.
      if (!opts.auto) get().toast({ tone: "success", title: r.mode === "delta" ? `Synced — ${r.fetched} changed, ${r.removed} removed` : `Downloaded ${r.products.toLocaleString()} products` });
      else if (r.mode !== "delta" || r.fetched || r.removed) get().toast({ tone: "info", title: "Updated from your store", body: r.mode === "delta" ? `${r.fetched} changed, ${r.removed} removed in WordPress since the last sync.` : `${r.products.toLocaleString()} products re-read.` });
    } catch (e) {
      // Don't repeat the same error every time the window gets focus (e.g. while offline).
      if (!opts.auto || !autoSyncFailed) get().toast({ tone: "error", title: opts.auto ? "Couldn't check the store for changes" : "Sync failed", body: String(e) });
      if (opts.auto) autoSyncFailed = true;
    } finally {
      set({ busy: null, progress: null, version: get().version + 1 });
    }
  },
  setAutoSync(v) {
    try {
      localStorage.setItem("cf.autoSync", v ? "1" : "0");
    } catch {
      /* preference only */
    }
    set({ autoSync: v });
  },

  async push(label) {
    const { summary, storeId } = get();
    if (!storeId || summary.created + summary.modified + summary.deleted === 0) return;
    set({ dialog: "push-confirm", dialogArg: label ?? "" });
  },

  async pushNow(label) {
    const { backend, storeId, summary } = get();
    if (!storeId) return;
    const parts = [summary.created && `${summary.created} new`, summary.modified && `${summary.modified} edited`, summary.deleted && `${summary.deleted} deleted`].filter(Boolean).join(", ");
    set({ busy: "Pushing changes", progress: { phase: "start", done: 0, total: 0, message: "Preparing" } });
    try {
      const r = await backend.push(storeId, label || parts || "Push");
      await get().refreshMeta();
      set({ info: await backend.openStore(storeId) });
      const ok = r.failed === 0 && r.conflicts === 0;
      const media = r.media_uploaded ? ` · ${r.media_uploaded} images (${(r.media_bytes / 1024 / 1024).toFixed(1)} MB)` : "";
      get().toast({
        tone: ok ? "success" : "error",
        title: ok ? `Pushed ${r.created + r.updated + r.deleted} changes` : `Pushed with ${r.conflicts} conflicts, ${r.failed} errors`,
        body: `${r.created} created · ${r.updated} updated · ${r.deleted} deleted${media} · ${(r.elapsed_ms / 1000).toFixed(1)}s${r.errors[0] ? ` — ${r.errors[0].label}: ${r.errors[0].message}` : ""}`,
      });
      if (!ok) set({ changesOpen: true });
      for (const w of (r.warnings ?? []).slice(0, 2)) get().toast({ tone: "error", title: "Images may not display on the store", body: w });
    } catch (e) {
      get().toast({ tone: "error", title: "Push failed", body: String(e) });
    } finally {
      set({ busy: null, progress: null, version: get().version + 1 });
    }
  },

  toast(t) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.tone === "error" ? 9000 : 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setCatWithParents(v) {
    try {
      localStorage.setItem("cf.cat.withParents", v ? "1" : "0");
    } catch {
      /* preference only */
    }
    set({ catWithParents: v });
  },
  setDark(dark) {
    get().setAppearance({ mode: dark ? "dark" : "light" });
  },
  setAppearance(patch) {
    const appearance = { ...get().appearance, ...patch };
    saveAppearance(appearance);
    applyAppearance(appearance);
    set({ appearance, dark: isDark(appearance) });
  },
  setPanel(patch) {
    const panel = { ...get().panel, ...patch };
    try {
      localStorage.setItem("cf.panel", JSON.stringify(panel));
    } catch {
      /* preference only */
    }
    set({ panel });
  },
  setFocusKey: (focusKey) => set({ focusKey }),
}));

export const PRODUCT_FIELD_LABELS: Record<string, string> = {
  name: "Name", sku: "SKU", type: "Type", status: "Status", regular_price: "Regular price", sale_price: "Sale price", stock_quantity: "Stock",
  stock_status: "Stock status", manage_stock: "Manage stock", backorders: "Backorders", weight: "Weight", length: "Length", width: "Width", height: "Height",
  shipping_class: "Shipping class", tax_status: "Tax status", tax_class: "Tax class", description: "Description", short_description: "Short description",
  category_ids: "Categories", tags: "Tags", image_id: "Image", gallery_ids: "Gallery", attributes: "Attributes", variation_attributes: "Variation",
  seo_title: "SEO title", seo_description: "SEO description", focus_keyword: "Focus keyword", featured: "Featured", catalog_visibility: "Visibility",
  global_unique_id: "GTIN/EAN", menu_order: "Menu order", slug: "Slug", parent_id: "Parent", date_on_sale_from: "Sale from", date_on_sale_to: "Sale to",
  __new: "Created", __delete: "Deleted", parent: "Parent", display_type: "Display", banner_id: "Banner", alt: "Alt text",
};

/** Human label for a field, including custom fields (`meta:<key>`). */
export function fieldLabel(field: string): string {
  if (field.startsWith("meta:")) {
    const key = field.slice(5);
    return useApp.getState().info?.profile.custom_fields?.find((f) => f.key === key)?.label || key;
  }
  return PRODUCT_FIELD_LABELS[field] ?? field;
}
