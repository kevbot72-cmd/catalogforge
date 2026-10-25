// In-browser demo backend. Mirrors forge-core's staging semantics (overlay, base values, grouped
// undo, push history, revert) over generated stores so the whole UI can be used — and tested —
// without a WooCommerce site.

import type {
  Backend, Category, CategoryRow, CloneOptions, Edit, Entity, HistoryEntry, HistoryItem, LocalFile, Media, MediaSettings, NewStoreInput,
  Product, ProductQuery, ProductRow, Progress, PushReport, StagedChange, StagedSummary, StoreInfo, StoreProfile, TaxonomyData, MetaKeyInfo, MediaValue, MigrateOptions, MigrationSummary, VerifyReport } from "./types";

const NEW = "new:";
const DEL = "__delete";
const NEWF = "__new";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

function same(a: unknown, b: unknown) {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null) return Math.abs(x - y) < 1e-9;
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  return empty(a) && empty(b);
}

function svgThumb(label: string, hue: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},70%,40%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><text x="200" y="232" font-family="Inter,Arial,sans-serif" font-size="120" font-weight="700" text-anchor="middle" fill="rgba(255,255,255,.92)">${label}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const CATS: [string, string[]][] = [
  ["Apparel", ["Tees", "Hoodies", "Jackets", "Pants"]],
  ["Footwear", ["Running", "Hiking", "Sandals"]],
  ["Accessories", ["Hats", "Bags", "Socks"]],
  ["Home", ["Mugs", "Candles"]],
];
const ADJ = ["Alpine", "Coastal", "Everyday", "Summit", "Trail", "Harbor", "Nordic", "Canyon", "Urban", "Meadow", "Granite", "Cedar", "Drift", "Ember", "Glacier"];
const NOUN: Record<string, string[]> = {
  Tees: ["Crew Tee", "Pocket Tee", "Long Sleeve Tee", "Henley"],
  Hoodies: ["Pullover Hoodie", "Zip Hoodie", "Fleece Crew"],
  Jackets: ["Rain Shell", "Puffer Jacket", "Softshell", "Windbreaker"],
  Pants: ["Hiking Pant", "Chino", "Jogger"],
  Running: ["Road Runner", "Tempo Trainer", "Racing Flat"],
  Hiking: ["Trail Boot", "Approach Shoe", "Mid Hiker"],
  Sandals: ["Slide", "Sport Sandal"],
  Hats: ["Beanie", "Cap", "Bucket Hat"],
  Bags: ["Daypack", "Tote", "Duffel", "Sling"],
  Socks: ["Merino Sock", "Crew Sock 3-Pack"],
  Mugs: ["Enamel Mug", "Travel Mug"],
  Candles: ["Soy Candle", "Campfire Candle"],
};
const SIZES = ["S", "M", "L", "XL"];
const COLORS = ["Black", "Navy", "Olive", "Sand", "Rust"];

interface StoreData {
  profile: StoreProfile;
  products: Map<number, Product>;
  categories: Map<number, Category>;
  media: Map<number, Media>;
  tags: Map<number, { id: number; name: string; slug: string; count: number }>;
  nextId: number;
  staged: Map<string, Map<string, { value: unknown; base: unknown; conflict: StagedChange["conflict"] }>>;
  undo: { entity: Entity; key: string; field: string; prev: { value: unknown; base: unknown } | null }[][];
  history: HistoryEntry[];
  historyItems: Map<number, HistoryItem[]>;
  lastPull: number | null;
}

const BRANDS = ["Northwind", "Fabrikam", "Contoso"];

function blankProduct(id: number): Product {
  return {
    id, parent_id: 0, type: "simple", status: "publish", name: "", slug: "", sku: "", global_unique_id: "", regular_price: "", sale_price: "",
    date_on_sale_from: null, date_on_sale_to: null, manage_stock: false, stock_quantity: null, stock_status: "instock", backorders: "no",
    weight: "", length: "", width: "", height: "", shipping_class: "", tax_status: "taxable", tax_class: "", description: "", short_description: "",
    menu_order: 0, featured: false, catalog_visibility: "visible", virtual: false, downloadable: false, sold_individually: false, reviews_allowed: true, purchase_note: "", upsell_ids: [], cross_sell_ids: [], brand_ids: [],
    category_ids: [], tags: [], attributes: [], variation_attributes: {}, image_id: 0, gallery_ids: [], external_url: "", button_text: "", permalink: "", seo_title: "", seo_description: "",
    focus_keyword: "", date_created_gmt: null, date_modified_gmt: null,
  };
}

function generate(profile: StoreProfile, seed: number, count: number): StoreData {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const d: StoreData = { profile, products: new Map(), categories: new Map(), media: new Map(), tags: new Map(), nextId: 10, staged: new Map(), undo: [], history: [], historyItems: new Map(), lastPull: Date.now() / 1000 };
  const id = () => d.nextId++;
  const leafIds: [number, string][] = [];
  CATS.forEach(([parent, kids], pi) => {
    const pid = id();
    const img = id();
    d.media.set(img, { id: img, url: svgThumb(parent.slice(0, 2), pi * 80), thumb_url: svgThumb(parent.slice(0, 2), pi * 80), medium_url: svgThumb(parent.slice(0, 2), pi * 80), alt: parent, title: parent, filename: `${parent.toLowerCase()}.webp`, mime: "image/webp", width: 1200, height: 1200, sha256: "", parent_id: 0 });
    d.categories.set(pid, { id: pid, parent: 0, name: parent, slug: parent.toLowerCase(), description: `<p>Shop our ${parent.toLowerCase()} range.</p>`, count: 0, display_type: "", image_id: img, banner_id: 0, menu_order: pi, seo_title: "", seo_description: "" });
    kids.forEach((k, ki) => {
      const cid = id();
      d.categories.set(cid, { id: cid, parent: pid, name: k, slug: k.toLowerCase(), description: "", count: 0, display_type: "", image_id: 0, banner_id: 0, menu_order: ki, seo_title: "", seo_description: "" });
      leafIds.push([cid, k]);
    });
  });
  ["new", "bestseller", "organic", "recycled", "gift"].forEach((t) => {
    const tid = id();
    d.tags.set(tid, { id: tid, name: t, slug: t, count: 0 });
  });
  const now = new Date().toISOString().slice(0, 19) + "Z";
  for (let i = 0; i < count; i++) {
    const [cid, leaf] = pick(leafIds);
    const name = `${pick(ADJ)} ${pick(NOUN[leaf])}`;
    const pid = id();
    const sku = `${leaf.slice(0, 3).toUpperCase()}-${1000 + i}`;
    const variable = ["Tees", "Hoodies", "Jackets", "Pants", "Running", "Hiking"].includes(leaf) && r() < 0.35;
    const price = (Math.round((12 + r() * 160) * 2) / 2 - 0.01).toFixed(2);
    const hue = Math.floor(r() * 360);
    const hasImage = r() > 0.08;
    let image = 0;
    if (hasImage) {
      image = id();
      const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2);
      const url = svgThumb(initials, hue);
      d.media.set(image, { id: image, url, thumb_url: url, medium_url: url, alt: name, title: name, filename: `${sku.toLowerCase()}.webp`, mime: "image/webp", width: 1200, height: 1200, sha256: "", parent_id: pid });
    }
    const p: Product = {
      ...blankProduct(pid),
      type: variable ? "variable" : "simple",
      status: r() < 0.9 ? "publish" : "draft",
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + i,
      sku,
      regular_price: variable ? "" : price,
      sale_price: !variable && r() < 0.15 ? (Number(price) * 0.8).toFixed(2) : "",
      manage_stock: !variable,
      stock_quantity: variable ? null : Math.floor(r() * 80),
      weight: (0.2 + r() * 2).toFixed(2),
      description: `<p>The ${name} is built for everyday adventures.</p><ul><li>Durable materials</li><li>Lifetime warranty</li></ul>`,
      short_description: `<p>${name} — ${leaf.toLowerCase()} essential.</p>`,
      category_ids: [cid],
      tags: r() < 0.3 ? [pick(["new", "bestseller", "organic", "recycled", "gift"])] : [],
      image_id: image,
      permalink: `https://northwind.example/product/${pid}`,
      date_created_gmt: now,
      date_modified_gmt: now,
      featured: r() < 0.05,
    };
    // Fields a brands/specs plugin would add (custom fields, see Settings → Custom fields).
    Object.assign(p, {
      "meta:brand": pick(["Northwind", "Summit Co.", "Trailhead", "Kestrel"]),
      "meta:country_of_origin": pick(["Portugal", "Vietnam", "USA", "Italy"]),
      "meta:warranty_years": String(pick([1, 2, 3, 5])),
      "meta:eco_certified": r() < 0.4 ? "yes" : "no",
    });
    if (!variable) p.stock_status = (p.stock_quantity ?? 0) > 0 ? "instock" : "outofstock";
    if (variable) {
      const sizes = SIZES.slice(0, 2 + Math.floor(r() * 3));
      const colors = COLORS.slice(0, 1 + Math.floor(r() * 2));
      p.attributes = [
        { name: "Size", taxonomy: "pa_size", options: sizes, visible: true, variation: true, position: 0 },
        { name: "Color", taxonomy: "pa_color", options: colors, visible: true, variation: true, position: 1 },
      ];
      for (const s of sizes)
        for (const c of colors) {
          const vid = id();
          const q = Math.floor(r() * 30);
          d.products.set(vid, {
            ...blankProduct(vid), type: "variation", parent_id: pid, name: `${name} - ${s}, ${c}`, sku: `${sku}-${s}-${c.slice(0, 3).toUpperCase()}`,
            regular_price: price, manage_stock: true, stock_quantity: q, stock_status: q > 0 ? "instock" : "outofstock",
            variation_attributes: { pa_size: s.toLowerCase(), pa_color: c.toLowerCase() }, date_created_gmt: now, date_modified_gmt: now,
          });
        }
    }
    d.products.set(pid, p);
  }
  for (const p of d.products.values()) for (const c of p.category_ids) {
    const cat = d.categories.get(c as number);
    if (cat) cat.count++;
  }
  return d;
}

const DEFAULT_SETTINGS: MediaSettings = { format: "webp", quality: 82, max_dimension: 2560, generate_sizes: true, name_template: "{sku}-{name}-{n}" };

/** The demo's version of forge-core's migrate::plan (same rules, simpler bookkeeping). */
function migrationPlan(src: StoreData, dst: StoreData, opts: MigrateOptions): { summary: MigrationSummary; edits: Edit[] } {
  const sum: MigrationSummary = { categories_create: 0, categories_existing: 0, products_create: 0, products_update: 0, products_skip: 0, variations: 0, images: 0, tags: 0, attributes: [], custom_fields: [], no_sku: 0, duplicate_skus: [], already_staged: 0, already_staged_categories: 0, source_products: 0, target_products: [...dst.products.values()].filter((p) => p.type !== "variation").length, warnings: [] };
  const edits: Edit[] = [];
  const pathOf = (cats: Map<number, Category>, id: number): string => {
    const c = cats.get(id);
    return c ? (c.parent && cats.has(Number(c.parent)) ? `${pathOf(cats, Number(c.parent))} > ` : "") + c.name.toLowerCase() : "";
  };
  const dstPaths = new Map([...dst.categories.keys()].map((id) => [pathOf(dst.categories, id), id]));
  const scope = new Set<number>(opts.category_ids);
  if (scope.size) for (let grew = true; grew; ) {
    grew = false;
    for (const c of src.categories.values()) if (scope.has(Number(c.parent)) && !scope.has(c.id)) (scope.add(c.id), (grew = true));
  }
  const parents = [...src.products.values()].filter((p) => p.type !== "variation" && (opts.include_drafts || p.status === "publish") && (!scope.size || p.category_ids.some((c) => scope.has(Number(c)))));
  sum.source_products = parents.length;
  const used = new Set(parents.flatMap((p) => p.category_ids.map(Number)));
  const wanted = [...src.categories.values()].filter((c) => (!scope.size || scope.has(c.id)) && (opts.include_empty_categories || used.has(c.id)));
  for (const c of [...wanted]) for (let p = src.categories.get(Number(c.parent)); p; p = src.categories.get(Number(p.parent))) if (!wanted.includes(p)) wanted.push(p);
  wanted.sort((a, b) => pathOf(src.categories, a.id).split(" > ").length - pathOf(src.categories, b.id).split(" > ").length);
  const catMap = new Map<number, number | string>();
  const img = (id: MediaValue) => (opts.include_images && typeof id === "number" && id > 0 && src.media.get(id) ? { url: src.media.get(id)!.url, alt: src.media.get(id)!.alt } : null);
  const images = new Set<string>();
  const create = (entity: Entity, fields: Record<string, unknown>) => {
    const key = `${NEW}mig${uid()}`;
    edits.push({ entity, key, field: NEWF, value: true });
    for (const [f, v] of Object.entries(fields)) edits.push({ entity, key, field: f, value: v });
    return key;
  };
  for (const c of wanted) {
    const existing = dstPaths.get(pathOf(src.categories, c.id));
    if (existing !== undefined) {
      sum.categories_existing++;
      catMap.set(c.id, existing);
      continue;
    }
    const f: Record<string, unknown> = { name: c.name, parent: catMap.get(Number(c.parent)) ?? 0, description: c.description, menu_order: c.menu_order };
    const i = img(c.image_id);
    if (i) (f.image_id = i, images.add(i.url));
    sum.categories_create++;
    catMap.set(c.id, create("category", f));
  }
  const skus = new Map<string, number>();
  const stagedSkus = new Set([...dst.staged].filter(([k, f]) => k.split("|")[1].startsWith(NEW) && f.has(NEWF)).map(([, f]) => String(f.get("sku")?.value ?? "")).filter(Boolean));
  for (const p of parents) {
    if (p.sku && stagedSkus.has(p.sku)) {
      sum.already_staged++;
      continue;
    }
    if (p.sku) skus.set(p.sku, (skus.get(p.sku) ?? 0) + 1);
    else sum.no_sku++;
    const existing = p.sku ? [...dst.products.values()].find((x) => x.sku === p.sku) : undefined;
    if (existing && opts.existing === "skip") {
      sum.products_skip++;
      continue;
    }
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) if (!["id", "parent_id", "image_id", "gallery_ids", "category_ids", "permalink", "date_created_gmt", "date_modified_gmt"].includes(k) && (opts.include_custom_fields || !k.startsWith("meta:")) && v !== "" && v !== null) f[k] = v;
    if (opts.status) f.status = opts.status;
    f.category_ids = p.category_ids.map((c) => catMap.get(Number(c))).filter((x) => x !== undefined);
    const i = img(p.image_id);
    if (i) (f.image_id = i, images.add(i.url));
    let parentKey: number | string;
    if (existing) {
      sum.products_update++;
      for (const [k, v] of Object.entries(f)) if (k !== "type") edits.push({ entity: "product", key: String(existing.id), field: k, value: v });
      parentKey = existing.id;
    } else {
      sum.products_create++;
      parentKey = create("product", f);
    }
    for (const v of src.products.values()) {
      if (v.type !== "variation" || v.parent_id !== p.id) continue;
      sum.variations++;
      create("variation", { sku: v.sku, regular_price: v.regular_price, manage_stock: v.manage_stock, stock_quantity: v.stock_quantity, stock_status: v.stock_status, variation_attributes: v.variation_attributes, parent_id: parentKey });
    }
  }
  sum.duplicate_skus = [...skus].filter(([, n]) => n > 1).map(([k]) => k);
  sum.images = images.size;
  sum.tags = new Set(parents.flatMap((p) => p.tags)).size;
  sum.attributes = [...new Set(parents.flatMap((p) => p.attributes.map((a) => a.name)))];
  sum.custom_fields = opts.include_custom_fields ? [...new Set(parents.flatMap((p) => Object.keys(p).filter((k) => k.startsWith("meta:")).map((k) => k.slice(5))))] : [];
  if (sum.target_products) sum.warnings.push(`The destination already has ${sum.target_products} products. Matching SKUs are ${opts.existing === "skip" ? "left alone" : "updated"}; everything else is added alongside them.`);
  if (sum.already_staged) sum.warnings.push(`${sum.already_staged} products are already staged in the destination from an earlier run that hasn't been pushed. They are left out; push or undo that run first.`);
  if (sum.no_sku) sum.warnings.push(`${sum.no_sku} products have no SKU. They can't be matched, so running the migration again would create them twice.`);
  return { summary: sum, edits };
}

export function createDemoBackend(): Backend {
  const stores = new Map<string, StoreData>();
  /** Files picked in this session, by the name used as their path. */
  const picked = new Map<string, File>();
  const listeners = new Set<(id: string, p: Progress) => void>();
  let settings = { ...DEFAULT_SETTINGS };
  const emit = (id: string, p: Progress) => listeners.forEach((l) => l(id, p));

  const seedProfiles: [StoreProfile, number, number][] = [
    [{ id: "demo-live", name: "Northwind Outfitters", environment: "production", color: "#e11d48", connection: { kind: "demo", seed: 1 }, created_at: 0, last_synced_at: null }, 1, 1800],
    [{ id: "demo-local", name: "northwind.local", environment: "local", color: "#16a34a", connection: { kind: "demo", seed: 2 }, created_at: 0, last_synced_at: null }, 2, 120],
  ];
  for (const [p, seed, n] of seedProfiles) stores.set(p.id, generate(p, seed, n));
  // A brand-new, empty store to try Migration with.
  const empty = generate({ id: "demo-new", name: "New Store", environment: "staging", color: "#7c3aed", connection: { kind: "demo", seed: 3 }, created_at: 0, last_synced_at: null }, 3, 0);
  empty.categories.clear();
  empty.media.clear();
  empty.tags.clear();
  stores.set("demo-new", empty);

  const S = (id: string) => {
    const s = stores.get(id);
    if (!s) throw new Error(`Unknown store ${id}`);
    return s;
  };
  const skey = (e: Entity, k: string) => `${e}|${k}`;
  const baseRecord = (s: StoreData, e: Entity, key: string): Record<string, unknown> | undefined => {
    const id = Number(key);
    if (!Number.isFinite(id)) return undefined;
    if (e === "product" || e === "variation") return s.products.get(id) as unknown as Record<string, unknown>;
    if (e === "category") return s.categories.get(id) as unknown as Record<string, unknown>;
    if (e === "media") return s.media.get(id) as unknown as Record<string, unknown>;
    return undefined;
  };
  const entityOfKey = (s: StoreData, key: string): Entity => {
    if (s.staged.has(skey("variation", key))) return "variation";
    const p = s.products.get(Number(key));
    return p?.type === "variation" ? "variation" : "product";
  };

  function stage(s: StoreData, edits: Edit[]) {
    const txn: StoreData["undo"][number] = [];
    for (const e of edits) {
      const k = skey(e.entity, e.key);
      const rec = s.staged.get(k);
      const prev = rec?.get(e.field);
      const base = baseRecord(s, e.entity, e.key);
      const serverVal = base?.[e.field];
      let value = e.value;
      if (value !== null && value !== undefined && !e.key.startsWith(NEW) && e.field !== DEL && base && same(serverVal, value)) value = null;
      if ((value === null || value === undefined) && !prev) continue;
      if (prev && value !== null && value !== undefined && JSON.stringify(prev.value) === JSON.stringify(value)) continue;
      txn.push({ entity: e.entity, key: e.key, field: e.field, prev: prev ? { value: prev.value, base: prev.base } : null });
      if (value === null || value === undefined) {
        rec!.delete(e.field);
        if (!rec!.size) s.staged.delete(k);
      } else {
        const m = rec ?? new Map();
        m.set(e.field, { value: clone(value), base: prev ? prev.base : clone(serverVal ?? null), conflict: null });
        s.staged.set(k, m);
      }
    }
    if (txn.length) s.undo.push(txn);
    return txn.length;
  }

  function summary(s: StoreData): StagedSummary {
    const out: StagedSummary = { created: 0, modified: 0, deleted: 0, fields: 0, conflicts: 0, can_undo: s.undo.length > 0 };
    for (const fields of s.staged.values()) {
      if (fields.has(NEWF)) out.created++;
      else if (fields.has(DEL)) out.deleted++;
      else out.modified++;
      for (const [f, v] of fields) {
        if (!f.startsWith("__")) out.fields++;
        if (v.conflict) out.conflicts++;
      }
    }
    return out;
  }

  function overlay(s: StoreData, entity: Entity, key: string, base: Record<string, unknown> | undefined) {
    const fields = s.staged.get(skey(entity, key));
    const v: Record<string, unknown> = base ? clone(base) : {};
    const st = { key, is_new: key.startsWith(NEW), deleted: false, dirty: [] as string[], conflicts: [] as string[] };
    if (fields)
      for (const [f, x] of fields) {
        if (f === DEL) st.deleted = true;
        else if (f !== NEWF) {
          v[f] = clone(x.value);
          st.dirty.push(f);
          if (x.conflict) st.conflicts.push(f);
        }
      }
    if (st.is_new) {
      const blank = entity === "category" ? { id: 0, parent: 0, name: "", slug: "", description: "", count: 0, display_type: "", image_id: 0, banner_id: 0, menu_order: 0, seo_title: "", seo_description: "" } : blankProduct(0);
      for (const [k2, val] of Object.entries(blank)) if (!(k2 in v)) v[k2] = val;
      if (entity === "variation") v.type = "variation";
    }
    return { ...v, _state: st };
  }

  function allRows(s: StoreData): ProductRow[] {
    const out: ProductRow[] = [];
    for (const p of s.products.values()) out.push(overlay(s, p.type === "variation" ? "variation" : "product", String(p.id), p as unknown as Record<string, unknown>) as unknown as ProductRow);
    for (const [k, fields] of s.staged) {
      const [entity, key] = k.split("|") as [Entity, string];
      if ((entity === "product" || entity === "variation") && key.startsWith(NEW) && fields.has(NEWF)) out.push(overlay(s, entity, key, undefined) as unknown as ProductRow);
    }
    return out;
  }

  function descendants(s: StoreData, root: number) {
    const set = new Set([root]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of s.categories.values()) if (set.has(c.parent as number) && !set.has(c.id)) {
        set.add(c.id);
        changed = true;
      }
    }
    return set;
  }

  async function mediaFromRef(s: StoreData, v: unknown, alt: string): Promise<unknown> {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ref = v as { file?: string; url?: string; preview?: string; alt?: string };
      const id = s.nextId++;
      const url = ref.preview || ref.url || "";
      s.media.set(id, { id, url, thumb_url: url, medium_url: url, alt: ref.alt ?? alt, title: alt, filename: (ref.file ?? ref.url ?? "image").split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ".webp"), mime: "image/webp", width: 1200, height: 1200, sha256: "", parent_id: 0 });
      return id;
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => mediaFromRef(s, x, alt)));
    return v;
  }

  const api: Backend = {
    kind: "demo",
    async listStores() {
      return [...stores.values()].map((s) => s.profile);
    },
    async addStore(input: NewStoreInput) {
      await sleep(400);
      const id = "demo-" + uid().slice(0, 6);
      const profile: StoreProfile = { id, name: input.name || "New store", environment: input.environment, color: input.color, connection: { kind: "demo", seed: Math.floor(Math.random() * 1000) }, created_at: Date.now() / 1000, last_synced_at: null };
      stores.set(id, generate(profile, Math.floor(Math.random() * 1000), 60));
      return profile;
    },
    async removeStore(id) {
      stores.delete(id);
    },
    async localSites() {
      return [
        { id: "lcl-1", name: "northwind", domain: "northwind.local", path: "~/Local Sites/northwind", wp_root: "~/Local Sites/northwind/app/public", php_version: "8.2.23", mysql_version: "8.0.35", mysql_port: 10005, status: "running", table_prefix: "wp_", has_woocommerce: true, connector_installed: true, multisite: false },
        { id: "lcl-2", name: "client-staging", domain: "client-staging.local", path: "~/Local Sites/client-staging", wp_root: "", php_version: "8.1.29", mysql_version: "8.0.35", mysql_port: 10021, status: "halted", table_prefix: "wp_", has_woocommerce: true, connector_installed: false, multisite: false },
        { id: "lcl-3", name: "blog", domain: "blog.local", path: "~/Local Sites/blog", wp_root: "", php_version: "8.2.23", mysql_version: "8.0.35", mysql_port: 10030, status: "running", table_prefix: "wp_", has_woocommerce: false, connector_installed: false, multisite: false },
      ];
    },
    async startLocalSite() {
      await sleep(800);
    },
    async openStore(id): Promise<StoreInfo> {
      const s = S(id);
      return {
        profile: s.profile,
        handshake: { protocol: 1, plugin_version: "0.1.0", wp_version: "6.8.3", wc_version: "9.9.5", php_version: "8.3", site_name: s.profile.name, home_url: "https://northwind.example", hpos: true, currency: "USD", currency_symbol: "$", price_decimals: 2, weight_unit: "kg", dimension_unit: "cm", image_sizes: [], integrations: { yoast: true } },
        capabilities: { write: true, server_conflict_check: true, presized_media: true, media_by_url_only: false, preview: true, batch_size: 250, write_concurrency: 2 },
        product_count: s.products.size,
        last_pull: s.lastPull,
      };
    },
    async pull(id) {
      const s = S(id);
      for (let i = 0; i <= 4; i++) {
        emit(id, { phase: "pull", done: Math.round((s.products.size * i) / 4), total: s.products.size, message: "Downloading catalog" });
        await sleep(120);
      }
      s.lastPull = Date.now() / 1000;
      return { mode: "delta", products: s.products.size, fetched: 0, removed: 0, categories: s.categories.size, elapsed_ms: 600 };
    },
    async query(id, q: ProductQuery) {
      const s = S(id);
      const rows = allRows(s);
      const search = (q.search ?? "").trim().toLowerCase();
      const cats = q.category_id ? descendants(s, q.category_id) : null;
      const match = (r: ProductRow) => {
        if (search && !search.split(/\s+/).every((w) => `${r.name} ${r.sku} ${r.id}`.toLowerCase().includes(w))) return false;
        if (cats && !r.category_ids.some((c) => cats.has(c as number))) return false;
        if (q.uncategorized && r.category_ids.length) return false;
        if (q.status && r.status !== q.status) return false;
        if (q.kind && r.type !== q.kind) return false;
        if (q.stock_status && r.stock_status !== q.stock_status) return false;
        if (q.only_changed && !r._state.dirty.length && !r._state.is_new && !r._state.deleted) return false;
        if (q.only_conflicts && !r._state.conflicts.length) return false;
        if (q.missing_image && r.image_id) return false;
        return true;
      };
      const parents = rows.filter((r) => r.type !== "variation");
      const kids = new Map<string, ProductRow[]>();
      const matchedKids = new Set<string>();
      for (const r of rows) if (r.type === "variation") {
        const pk = String(r.parent_id);
        if (!kids.has(pk)) kids.set(pk, []);
        kids.get(pk)!.push(r);
        if (q.include_variations && match(r)) matchedKids.add(pk);
      }
      const listed = parents.filter((r) => match(r) || matchedKids.has(r._state.key));
      const sort = q.sort?.length ? q.sort : [{ field: "id", desc: true }];
      const cmp = (a: unknown, b: unknown) => {
        const na = typeof a === "number" ? a : a !== "" && a != null && !Number.isNaN(Number(a)) ? Number(a) : null;
        const nb = typeof b === "number" ? b : b !== "" && b != null && !Number.isNaN(Number(b)) ? Number(b) : null;
        if (na !== null && nb !== null) return na - nb;
        return String(a ?? "").toLowerCase().localeCompare(String(b ?? "").toLowerCase());
      };
      listed.sort((a, b) => {
        if (a._state.is_new !== b._state.is_new) return a._state.is_new ? -1 : 1;
        for (const sp of sort) {
          const o = cmp(a[sp.field], b[sp.field]);
          if (o) return sp.desc ? -o : o;
        }
        return 0;
      });
      const expanded = new Set(q.expanded ?? []);
      const keys: string[] = [];
      for (const r of listed) {
        keys.push(r._state.key);
        if (q.include_variations || expanded.has(r._state.key)) for (const k of (kids.get(r._state.key) ?? []).sort((a, b) => a.id - b.id)) keys.push(k._state.key);
      }
      return { keys, total_products: parents.length };
    },
    async rows(id, keys) {
      const s = S(id);
      return keys
        .map((k) => {
          const base = s.products.get(Number(k));
          const entity = base ? (base.type === "variation" ? "variation" : "product") : s.staged.has(skey("variation", k)) ? "variation" : "product";
          if (!base && !s.staged.has(skey(entity, k))) return null;
          return overlay(s, entity, k, base as unknown as Record<string, unknown>) as unknown as ProductRow;
        })
        .filter(Boolean) as ProductRow[];
    },
    async skus(id) {
      return [...S(id).products.values()].filter((p) => p.sku).map((p) => [p.sku, p.id, p.type] as [string, number, string]);
    },
    async variations(id, parentKey) {
      const s = S(id);
      const keys: string[] = [];
      for (const p of s.products.values()) if (p.type === "variation" && String(p.parent_id) === parentKey) keys.push(String(p.id));
      for (const [k, f] of s.staged) {
        const [e, key] = k.split("|");
        if (e === "variation" && key.startsWith(NEW) && String(f.get("parent_id")?.value) === parentKey) keys.push(key);
      }
      return api.rows(id, keys);
    },
    async taxonomy(id): Promise<TaxonomyData> {
      const s = S(id);
      const cats: CategoryRow[] = [...s.categories.values()].map((c) => overlay(s, "category", String(c.id), c as unknown as Record<string, unknown>) as unknown as CategoryRow);
      for (const [k, f] of s.staged) {
        const [e, key] = k.split("|");
        if (e === "category" && key.startsWith(NEW) && f.has(NEWF)) cats.push(overlay(s, "category", key, undefined) as unknown as CategoryRow);
      }
      return {
        categories: cats,
        tags: [...s.tags.values()],
        attributes: [
          { id: 1, name: "Size", taxonomy: "pa_size", type: "select", terms: SIZES.map((x, i) => ({ id: 100 + i, name: x, slug: x.toLowerCase() })) },
          { id: 2, name: "Color", taxonomy: "pa_color", type: "select", terms: COLORS.map((x, i) => ({ id: 200 + i, name: x, slug: x.toLowerCase() })) },
        ],
        shipping_classes: [{ id: 1, name: "Bulky", slug: "bulky" }, { id: 2, name: "Letter", slug: "letter" }],
        tax_classes: ["reduced-rate", "zero-rate"],
        brands: BRANDS.map((name, i) => ({ id: 900 + i, name, slug: name.toLowerCase(), count: 0 })),
      };
    },
    async media(id) {
      const s = S(id);
      return [...s.media.values()].filter((m) => !s.staged.get(skey("media", String(m.id)))?.has(DEL)).sort((a, b) => b.id - a.id);
    },
    async stage(id, edits) {
      const s = S(id);
      stage(s, edits);
      return summary(s);
    },
    async create(id, items) {
      const s = S(id);
      const keys: string[] = [];
      const edits: Edit[] = [];
      for (const it of items) {
        const key = it.key ?? NEW + uid();
        keys.push(key);
        edits.push({ entity: it.entity, key, field: NEWF, value: true });
        for (const [f, v] of Object.entries(it.fields)) edits.push({ entity: it.entity, key, field: f, value: v });
      }
      stage(s, edits);
      return keys;
    },
    async remove(id, entity, keys) {
      const s = S(id);
      const edits: Edit[] = [];
      for (const key of keys) {
        const e = entity === "product" ? entityOfKey(s, key) : entity;
        if (key.startsWith(NEW)) {
          for (const f of s.staged.get(skey(e, key))?.keys() ?? []) edits.push({ entity: e, key, field: f, value: null });
        } else {
          edits.push({ entity: e, key, field: DEL, value: true });
          if (e === "product") for (const p of s.products.values()) if (String(p.parent_id) === key) edits.push({ entity: "variation", key: String(p.id), field: DEL, value: true });
        }
      }
      stage(s, edits);
      return summary(s);
    },
    async undo(id) {
      const s = S(id);
      const txn = s.undo.pop();
      if (txn)
        for (const u of [...txn].reverse()) {
          const k = skey(u.entity, u.key);
          if (u.prev) {
            const m = s.staged.get(k) ?? new Map();
            m.set(u.field, { value: u.prev.value, base: u.prev.base, conflict: null });
            s.staged.set(k, m);
          } else {
            s.staged.get(k)?.delete(u.field);
            if (!s.staged.get(k)?.size) s.staged.delete(k);
          }
        }
      return summary(s);
    },
    async discard(id, entity, key, field) {
      const s = S(id);
      const edits: Edit[] = [];
      for (const [k, fields] of s.staged) {
        const [e, kk] = k.split("|") as [Entity, string];
        if (entity && e !== entity) continue;
        if (key && kk !== key) continue;
        for (const f of fields.keys()) if (!field || f === field) edits.push({ entity: e, key: kk, field: f, value: null });
      }
      stage(s, edits);
      return summary(s);
    },
    async summary(id) {
      return summary(S(id));
    },
    async changes(id) {
      const s = S(id);
      const out: StagedChange[] = [];
      for (const [k, fields] of s.staged) {
        const [entity, key] = k.split("|") as [Entity, string];
        const base = baseRecord(s, entity, key);
        const label = String((fields.get("name")?.value as string) || base?.name || base?.sku || key);
        for (const [field, v] of fields) {
          if (field === NEWF && entity !== "product") continue;
          out.push({ entity, key, label, field, base: v.base, value: v.value, conflict: v.conflict });
        }
      }
      return out;
    },
    async resolveConflict(id, entity, key, field, keepMine) {
      const s = S(id);
      const rec = s.staged.get(skey(entity, key))?.get(field);
      if (rec?.conflict) {
        if (keepMine) {
          rec.base = rec.conflict.remote;
          rec.conflict = null;
        } else {
          const base = baseRecord(s, entity, key);
          if (base) base[field] = rec.conflict.remote;
          s.staged.get(skey(entity, key))!.delete(field);
        }
      }
      return summary(s);
    },
    async push(id, label): Promise<PushReport> {
      const s = S(id);
      const t0 = performance.now();
      const report: PushReport = { created: 0, updated: 0, deleted: 0, conflicts: 0, failed: 0, media_uploaded: 0, media_deduplicated: 0, media_bytes: 0, errors: [], history_id: null, elapsed_ms: 0 };
      const hid = s.history.length + 1;
      const items: HistoryItem[] = [];
      const entries = [...s.staged.entries()].sort(([a], [b]) => {
        const order = (k: string) => ({ category: 0, tag: 1, media: 2, product: 3, variation: 4 })[k.split("|")[0] as Entity];
        return order(a) - order(b);
      });
      const idMap = new Map<string, number>();
      const resolve = (v: unknown): unknown => (typeof v === "string" && v.startsWith(NEW) ? (idMap.get(v) ?? v) : Array.isArray(v) ? v.map(resolve) : v);
      const total = entries.length;
      let done = 0;
      for (const [k, fields] of entries) {
        const [entity, key] = k.split("|") as [Entity, string];
        const labelOf = String((fields.get("name")?.value as string) || baseRecord(s, entity, key)?.name || key);
        for (const mf of ["image_id", "gallery_ids", "banner_id"]) {
          const f = fields.get(mf);
          if (f && typeof f.value === "object" && f.value !== null && (!Array.isArray(f.value) || f.value.some((x) => typeof x === "object"))) {
            const before = s.media.size;
            f.value = await mediaFromRef(s, f.value, labelOf);
            report.media_uploaded += s.media.size - before;
          }
        }
        if (fields.has(DEL)) {
          const nid = Number(key);
          if (entity === "category") s.categories.delete(nid);
          else if (entity === "media") s.media.delete(nid);
          else s.products.delete(nid);
          report.deleted++;
          items.push({ entity, id: nid, label: labelOf, field: DEL, before: null, after: true, action: "deleted" });
        } else if (key.startsWith(NEW)) {
          const nid = s.nextId++;
          idMap.set(key, nid);
          const data: Record<string, unknown> = {};
          for (const [f, v] of fields) if (!f.startsWith("__")) data[f] = resolve(v.value);
          if (entity === "category") {
            s.categories.set(nid, { id: nid, parent: 0, name: "", slug: String(data.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: "", count: 0, display_type: "", image_id: 0, banner_id: 0, menu_order: 0, seo_title: "", seo_description: "", ...data } as Category);
          } else {
            const p = { ...blankProduct(nid), ...data, id: nid, date_modified_gmt: new Date().toISOString().slice(0, 19) + "Z" } as Product;
            if (entity === "variation") p.type = "variation";
            if (!p.slug && p.name) p.slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            s.products.set(nid, p);
          }
          report.created++;
          items.push({ entity, id: nid, label: labelOf, field: NEWF, before: null, after: true, action: "created" });
        } else {
          const rec = baseRecord(s, entity, key);
          if (rec) {
            for (const [f, v] of fields) {
              if (f.startsWith("__")) continue;
              items.push({ entity, id: Number(key), label: labelOf, field: f, before: v.base, after: v.value, action: "updated" });
              rec[f] = resolve(v.value);
            }
            rec.date_modified_gmt = new Date().toISOString().slice(0, 19) + "Z";
            report.updated++;
          }
        }
        s.staged.delete(k);
        done++;
        if (done % 25 === 0 || done === total) {
          emit(id, { phase: "write", done, total, message: `Saving to store (${done}/${total})` });
          await sleep(30);
        }
      }
      // Re-point any remaining staged references to newly created ids.
      for (const fields of s.staged.values()) for (const v of fields.values()) v.value = resolve(v.value);
      for (const c of s.categories.values()) c.count = 0;
      for (const p of s.products.values()) for (const c of p.category_ids) {
        const cat = s.categories.get(c as number);
        if (cat) cat.count++;
      }
      s.undo = [];
      const entry: HistoryEntry = { id: hid, at: Math.floor(Date.now() / 1000), label, created: report.created, updated: report.updated, deleted: report.deleted, failed: 0, reverted_by: null };
      s.history.unshift(entry);
      s.historyItems.set(hid, items);
      report.history_id = hid;
      report.elapsed_ms = Math.round(performance.now() - t0);
      emit(id, { phase: "done", done: total, total, message: "Saved" });
      return report;
    },
    async history(id) {
      return S(id).history;
    },
    async historyItems(id, hid) {
      return S(id).historyItems.get(hid) ?? [];
    },
    async revert(id, hid) {
      const s = S(id);
      const edits: Edit[] = [];
      for (const it of s.historyItems.get(hid) ?? []) {
        if (it.action === "created" && it.field === NEWF) edits.push({ entity: it.entity, key: String(it.id), field: DEL, value: true });
        if (it.action === "updated") edits.push({ entity: it.entity, key: String(it.id), field: it.field, value: it.before });
      }
      stage(s, edits);
      const h = s.history.find((x) => x.id === hid);
      if (h) h.reverted_by = -1;
      return summary(s);
    },
    async preview(id, productId, draft) {
      const s = S(id);
      const base = productId ? s.products.get(productId) : undefined;
      const p = { ...(base ?? blankProduct(0)), ...draft } as Product;
      const img = typeof p.image_id === "number" ? s.media.get(p.image_id)?.url : (p.image_id as { preview?: string; url?: string })?.preview ?? (p.image_id as { url?: string })?.url;
      const price = p.sale_price ? `<del>$${p.regular_price}</del> <ins>$${p.sale_price}</ins>` : p.regular_price ? `$${p.regular_price}` : "";
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif;margin:0;color:#1f2937}header{padding:18px 40px;border-bottom:1px solid #e5e7eb;font:600 18px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:48px;padding:40px;max-width:1100px;margin:auto}img{width:100%;border-radius:8px;background:#f3f4f6;aspect-ratio:1}h1{font-size:34px;margin:0 0 12px}.price{font:600 22px system-ui;color:#065f46;margin-bottom:16px}del{color:#9ca3af;font-weight:400}ins{text-decoration:none}.btn{display:inline-block;background:#111827;color:#fff;padding:12px 22px;border-radius:6px;font:600 14px system-ui;margin:16px 0}.desc{line-height:1.7}.badge{position:fixed;bottom:12px;right:12px;background:#111827;color:#fff;font:600 12px system-ui;padding:6px 10px;border-radius:6px;opacity:.85}</style></head><body><header>${s.profile.name}</header><main><div>${img ? `<img src="${img}">` : `<div style="aspect-ratio:1;background:#f3f4f6;border-radius:8px"></div>`}</div><div><h1>${p.name || "Untitled product"}</h1><div class="price">${price}</div><div class="desc">${p.short_description || ""}</div><span class="btn">Add to cart</span><div style="font:13px system-ui;color:#6b7280">SKU: ${p.sku || "—"}</div></div></main><section style="max-width:1100px;margin:auto;padding:0 40px 60px" class="desc"><h2>Description</h2>${p.description || ""}</section><div class="badge">Preview · unsaved changes</div></body></html>`;
      return "data:text/html;charset=utf-8," + encodeURIComponent(html);
    },
    async cloneProducts(src, dst, ids, opts: CloneOptions) {
      const a = S(src);
      const b = S(dst);
      const path = (cats: Map<number, Category>, cid: number) => {
        const out: string[] = [];
        let c = cats.get(cid);
        let g = 0;
        while (c && g++ < 20) {
          out.unshift(c.name);
          c = cats.get(c.parent as number);
        }
        return out.join(" > ");
      };
      const dstPaths = new Map([...b.categories.values()].map((c) => [path(b.categories, c.id), c.id]));
      const report = { created: 0, updated: 0, categories_created: 0 };
      const edits: Edit[] = [];
      const newCat = new Map<string, string>();
      const resolveCat = (cid: number): number | string => {
        const full = path(a.categories, cid);
        const parts = full.split(" > ");
        let parent: number | string = 0;
        for (let i = 0; i < parts.length; i++) {
          const sub = parts.slice(0, i + 1).join(" > ");
          const ex = dstPaths.get(sub);
          if (ex !== undefined) {
            parent = ex;
            continue;
          }
          let key = newCat.get(sub);
          if (!key) {
            key = NEW + uid();
            newCat.set(sub, key);
            edits.push({ entity: "category", key, field: NEWF, value: true }, { entity: "category", key, field: "name", value: parts[i] }, { entity: "category", key, field: "parent", value: parent });
            report.categories_created++;
          }
          parent = key;
        }
        return parent;
      };
      const parentKeys = new Map<number, number | string>();
      const queue = [...ids];
      if (opts.include_variations) for (const i of ids) for (const p of a.products.values()) if (p.parent_id === i) queue.push(p.id);
      for (const pid of queue) {
        const p = a.products.get(pid);
        if (!p) continue;
        const fields: Record<string, unknown> = {};
        for (const f of ["name", "sku", "regular_price", "sale_price", "manage_stock", "stock_quantity", "stock_status", "weight", "description", "short_description", "attributes", "variation_attributes", "tags", "type"]) fields[f] = clone((p as unknown as Record<string, unknown>)[f]);
        if (p.type !== "variation") {
          fields.category_ids = p.category_ids.map((c) => resolveCat(c as number));
          if (opts.status) fields.status = opts.status;
        } else {
          const parent = parentKeys.get(p.parent_id as number);
          if (parent === undefined) continue;
          fields.parent_id = parent;
        }
        if (opts.include_images && typeof p.image_id === "number" && p.image_id) {
          const m = a.media.get(p.image_id);
          if (m) fields.image_id = { url: m.url, preview: m.url, alt: m.alt };
        }
        const entity: Entity = p.type === "variation" ? "variation" : "product";
        const existing = opts.match_sku && p.sku ? [...b.products.values()].find((x) => x.sku === p.sku) : undefined;
        if (existing) {
          report.updated++;
          parentKeys.set(p.id, existing.id);
          for (const [f, v] of Object.entries(fields)) if (f !== "type" && f !== "parent_id") edits.push({ entity, key: String(existing.id), field: f, value: v });
        } else {
          report.created++;
          const key = NEW + uid();
          parentKeys.set(p.id, key);
          edits.push({ entity, key, field: NEWF, value: true });
          for (const [f, v] of Object.entries(fields)) edits.push({ entity, key, field: f, value: v });
        }
      }
      stage(b, edits);
      return report;
    },
    async pickFiles({ directory, multiple, extensions }) {
      return new Promise<LocalFile[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple ?? true;
        if (directory) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
        if (extensions) input.accept = extensions.map((e) => "." + e).join(",");
        input.onchange = () => resolve(api.filesFromDrop([...(input.files ?? [])]));
        input.click();
      });
    },
    async saveFile({ defaultName, bytes, mime }) {
      // Browsers decide the folder themselves (usually Downloads).
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return defaultName;
    },
    async filesFromDrop(files) {
      for (const f of files) picked.set((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, f);
      return files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, name: f.name, url: URL.createObjectURL(f), size: f.size, file: f }) as LocalFile);
    },
    async resolveImagePaths(paths) {
      // A browser cannot read arbitrary locations on disk; the desktop app does.
      return paths.map(() => null);
    },
    async printImage(src, max, quality) {
      // Browsers can only rasterise what they can load (data:, blob: and same-origin URLs).
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = picked.get(src) ? URL.createObjectURL(picked.get(src)!) : src;
        await img.decode();
        const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((img.naturalWidth || max) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || max) * scale));
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality / 100));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
    async readFile(path) {
      const f = picked.get(path);
      if (!f) throw new Error(`File not available: ${path}`);
      return new Uint8Array(await f.arrayBuffer());
    },
    async migrationPreview(src, dst, opts) {
      return migrationPlan(S(src), S(dst), opts).summary;
    },
    async migrationStage(src, dst, opts) {
      const { summary: sum, edits } = migrationPlan(S(src), S(dst), opts);
      stage(S(dst), edits);
      return sum;
    },
    async migrationVerify(src, dst, opts) {
      const d = new Map([...S(dst).products.values()].filter((p) => p.sku).map((p) => [p.sku, p]));
      const r: VerifyReport = { checked: 0, matched: 0, missing: [], differences: [], images_missing: 0 };
      for (const p of S(src).products.values()) {
        if (!p.sku || (!opts.include_drafts && p.status !== "publish" && p.type !== "variation")) continue;
        r.checked++;
        const t = d.get(p.sku);
        if (!t) r.missing.push([p.sku, p.name]);
        else {
          r.matched++;
          if (Number(p.regular_price || 0) !== Number(t.regular_price || 0)) r.differences.push([p.sku, "regular_price", p.regular_price, t.regular_price]);
          if (opts.include_images && p.image_id && !t.image_id) r.images_missing++;
        }
      }
      return r;
    },
    async metaKeys(id) {
      const s = S(id);
      const all = [...s.products.values()] as unknown as Record<string, unknown>[];
      const count = (k: string) => all.filter((p) => p[k] !== undefined).length;
      const info = (key: string, label: string, kind: MetaKeyInfo["kind"], source = "") => ({ key, label, kind, source, count: count(`meta:${key}`), sample: String(all.find((p) => p[`meta:${key}`])?.[`meta:${key}`] ?? "") });
      return [info("brand", "Brand", "text", "ACF"), info("country_of_origin", "Country of origin", "text", "ACF"), info("warranty_years", "", "number"), info("eco_certified", "", "yesno")];
    },
    async setCustomFields(id, fields) {
      const s = S(id);
      s.profile = { ...s.profile, custom_fields: fields };
      return s.profile;
    },
    async getMediaSettings() {
      return settings;
    },
    async setMediaSettings(s2) {
      settings = s2;
    },
    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return api;
}
