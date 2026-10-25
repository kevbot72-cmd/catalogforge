import { Copy, Eye, EyeOff, Layers, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { META_PREFIX, type CustomField, type Edit, type Entity, type MediaValue, type ProductAttribute, type ProductRow } from "../backend/types";
import { useApp } from "../store/app";
import { BufferedInput, CategoryPicker, GalleryEditor, LibraryPicker, TagInput } from "./fields";
import { RichTextEditor } from "./RichTextEditor";
import { Badge, Button, CloseX, clsx, Field, mediaUrl, Modal, Select, Tabs, Thumb, Toggle } from "./ui";
import { VariationsPanel } from "./VariationsPanel";

type Tab = "general" | "description" | "media" | "variations" | "organisation" | "inventory" | "seo" | "custom";

export function useProductRow(key: string | null) {
  const { backend, storeId, version } = useApp();
  const [row, setRow] = useState<ProductRow | null>(null);
  useEffect(() => {
    if (!key || !storeId) return setRow(null);
    let cancelled = false;
    backend.rows(storeId, [key]).then((r) => !cancelled && setRow(r[0] ?? null));
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, key, version]);
  return row;
}

export function ProductDrawer() {
  const { drawerKey, openDrawer, stage, media, taxonomy, backend, info, remove, toast, openDialog } = useApp();
  const row = useProductRow(drawerKey);
  const [tab, setTab] = useState<Tab>("general");
  const [showPreview, setShowPreview] = useState(false);
  const [library, setLibrary] = useState(false);
  // Each product opens on General; the preview toggle is a preference and persists.
  useEffect(() => setTab("general"), [drawerKey]);
  useEffect(() => {
    if (row && tab === "variations" && row.type !== "variable") setTab("general");
  }, [row, tab]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector('[role="dialog"]') && openDrawer(null);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [openDrawer]);

  const entity: Entity = row?.type === "variation" ? "variation" : "product";
  const set = useCallback(
    (field: string, value: unknown) => {
      if (!row) return;
      stage([{ entity, key: row._state.key, field, value }]);
    },
    [row, entity, stage],
  );
  const setMany = useCallback((fields: Record<string, unknown>) => {
    if (!row) return;
    stage(Object.entries(fields).map(([field, value]) => ({ entity, key: row._state.key, field, value }) as Edit));
  }, [row, entity, stage]);

  if (!drawerKey) return null;
  const dirty = new Set(row?._state.dirty ?? []);
  const sym = info?.handshake?.currency_symbol ?? "$";
  const thumb = row ? mediaUrl(row.image_id, media) : null;

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[min(1180px,92vw)] border-l border-line bg-panel shadow-2xl" data-testid="product-drawer">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Thumb src={thumb} size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{row?.name || "Untitled product"}</div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>{row?.sku || "no SKU"}</span>·<span>{row?.type}</span>
              {row?._state.is_new && <Badge tone="added">New — not pushed</Badge>}
              {row && !row._state.is_new && row._state.dirty.length > 0 && <Badge tone="changed">{row._state.dirty.length} unsaved changes</Badge>}
              {row?._state.deleted && <Badge tone="removed">Will be deleted</Badge>}
            </div>
          </div>
          <Button size="sm" variant={showPreview ? "primary" : "secondary"} icon={showPreview ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShowPreview(!showPreview)} disabled={!info?.capabilities.preview} title={info?.capabilities.preview ? "Live preview in your store's theme" : "Preview needs the connector plugin"}>
            Preview
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy size={14} />} title="Duplicate" onClick={async () => {
            if (!row) return;
            const fields: Record<string, unknown> = {};
            for (const k of ["name", "type", "status", "regular_price", "sale_price", "description", "short_description", "category_ids", "tags", "attributes", "weight", "length", "width", "height", "shipping_class", "image_id", "gallery_ids", "manage_stock", "stock_quantity", "stock_status"]) fields[k] = (row as Record<string, unknown>)[k];
            fields.name = `${row.name} (copy)`;
            fields.sku = row.sku ? `${row.sku}-COPY` : "";
            fields.status = "draft";
            const [k] = await useApp.getState().create([{ entity: "product", fields }]);
            openDrawer(k);
            toast({ tone: "info", title: "Duplicated as a draft" });
          }} />
          {row && row.type !== "variation" && (
            <Button size="sm" variant="ghost" icon={<Layers size={14} />} title="Clone to another store" onClick={() => typeof row.id === "number" && row.id > 0 && openDialog("clone", [row.id])} />
          )}
          <Button size="sm" variant="close" icon={<Trash2 size={14} />} title="Delete" onClick={() => row && remove(entity, [row._state.key]).then(() => openDrawer(null))} />
          <CloseX onClick={() => openDrawer(null)} label="Close drawer" size={16} />
        </div>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "general", label: "General" },
            { id: "description", label: "Description" },
            { id: "media", label: "Media" },
            ...(row?.type === "variable" ? [{ id: "variations" as Tab, label: "Variations" }] : []),
            { id: "organisation", label: "Organisation" },
            { id: "inventory", label: "Inventory & shipping" },
            { id: "seo", label: "SEO" },
            ...(info?.profile.custom_fields?.length ? [{ id: "custom" as Tab, label: "Custom fields" }] : []),
          ]}
        />
        {!row ? (
          <div className="p-6 text-muted">Loading…</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {tab === "general" && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Name" className="col-span-2" changed={dirty.has("name")}>
                  <BufferedInput value={row.name} onCommit={(v) => set("name", v)} data-testid="drawer-name" className="h-9 text-[15px] font-medium" />
                </Field>
                <Field label="Type" changed={dirty.has("type")}>
                  <Select value={row.type} disabled={row.type === "variation"} onChange={(e) => set("type", e.target.value)} data-testid="drawer-type">
                    {["simple", "variable", "external", "grouped", ...(row.type === "variation" ? ["variation"] : [])].map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </Field>
                <Field label="Status" changed={dirty.has("status")}>
                  <Select value={row.status} onChange={(e) => set("status", e.target.value)}>
                    {["publish", "draft", "pending", "private"].map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </Field>
                {row.type !== "variable" && (
                  <>
                    <Field label={`Regular price (${sym})`} changed={dirty.has("regular_price")}>
                      <BufferedInput value={row.regular_price} inputMode="decimal" onCommit={(v) => set("regular_price", v === "" ? "" : Number(v).toFixed(2))} data-testid="drawer-price" />
                    </Field>
                    <Field label={`Sale price (${sym})`} changed={dirty.has("sale_price")} hint={row.sale_price && row.regular_price ? `${Math.round((1 - Number(row.sale_price) / Number(row.regular_price)) * 100)}% off` : undefined}>
                      <BufferedInput value={row.sale_price} inputMode="decimal" onCommit={(v) => set("sale_price", v === "" ? "" : Number(v).toFixed(2))} />
                    </Field>
                    <Field label="Sale from" changed={dirty.has("date_on_sale_from")}>
                      <input type="date" className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px]" value={(row.date_on_sale_from ?? "").slice(0, 10)} onChange={(e) => set("date_on_sale_from", e.target.value ? `${e.target.value}T00:00:00Z` : null)} />
                    </Field>
                    <Field label="Sale to" changed={dirty.has("date_on_sale_to")}>
                      <input type="date" className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px]" value={(row.date_on_sale_to ?? "").slice(0, 10)} onChange={(e) => set("date_on_sale_to", e.target.value ? `${e.target.value}T23:59:59Z` : null)} />
                    </Field>
                  </>
                )}
                {row.type === "external" && (
                  <>
                    <Field label="Product URL"><BufferedInput value={row.external_url} onCommit={(v) => set("external_url", v)} /></Field>
                    <Field label="Button text"><BufferedInput value={row.button_text} onCommit={(v) => set("button_text", v)} /></Field>
                  </>
                )}
                {row.type !== "variation" && (
                  <Field label="Short description" className="col-span-2" changed={dirty.has("short_description")}>
                    <RichTextEditor value={row.short_description} onChange={(h) => set("short_description", h)} minHeight={110} placeholder="A one-paragraph summary shown next to the price" />
                  </Field>
                )}
                {row.type === "variation" && (
                  <Field label="Variation description" className="col-span-2" changed={dirty.has("description")}>
                    <BufferedInput multiline value={row.description} onCommit={(v) => set("description", v)} />
                  </Field>
                )}
              </div>
            )}
            {tab === "description" && (
              <Field label="Description" changed={dirty.has("description")}>
                <RichTextEditor value={row.description} onChange={(h) => set("description", h)} minHeight={360} placeholder="Tell shoppers what makes this product great" testId="rte-description" />
              </Field>
            )}
            {tab === "media" && (
              <GalleryEditor
                image={row.image_id}
                gallery={row.type === "variation" ? [] : row.gallery_ids}
                media={media}
                onChange={(image, gallery) => (row.type === "variation" ? set("image_id", image) : setMany({ image_id: image, gallery_ids: gallery }))}
                toFiles={backend.filesFromDrop}
                pickFiles={() => backend.pickFiles({ multiple: true, extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] })}
                onPickLibrary={() => setLibrary(true)}
                onAltChange={(id, alt) => stage([{ entity: "media", key: String(id), field: "alt", value: alt }])}
              />
            )}
            {tab === "variations" && row.type === "variable" && <VariationsPanel parent={row} />}
            {tab === "organisation" && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Categories" className="col-span-2" changed={dirty.has("category_ids")}>
                  <CategoryPicker categories={taxonomy?.categories ?? []} value={row.category_ids} onChange={(v) => set("category_ids", v)} />
                </Field>
                <Field label="Tags" className="col-span-2" changed={dirty.has("tags")}>
                  <TagInput value={row.tags} onChange={(v) => set("tags", v)} suggestions={(taxonomy?.tags ?? []).map((t) => t.name)} placeholder="Add tags" />
                </Field>
                <Field label="Catalog visibility" changed={dirty.has("catalog_visibility")}>
                  <Select value={row.catalog_visibility} onChange={(e) => set("catalog_visibility", e.target.value)}>
                    <option value="visible">Shop and search</option>
                    <option value="catalog">Shop only</option>
                    <option value="search">Search only</option>
                    <option value="hidden">Hidden</option>
                  </Select>
                </Field>
                <Field label="Menu order" changed={dirty.has("menu_order")}>
                  <BufferedInput value={String(row.menu_order ?? 0)} onCommit={(v) => set("menu_order", Number(v) || 0)} />
                </Field>
                <div className="col-span-2"><Toggle checked={row.featured} onChange={(v) => set("featured", v)} label="Featured product" /></div>
                <AttributesEditor attrs={row.attributes ?? []} onChange={(a) => set("attributes", a)} changed={dirty.has("attributes")} />
              </div>
            )}
            {tab === "inventory" && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="SKU" changed={dirty.has("sku")}><BufferedInput value={row.sku} onCommit={(v) => set("sku", v)} /></Field>
                <Field label="GTIN / EAN / UPC" changed={dirty.has("global_unique_id")}><BufferedInput value={row.global_unique_id} onCommit={(v) => set("global_unique_id", v)} /></Field>
                <div className="col-span-2"><Toggle checked={row.manage_stock} onChange={(v) => set("manage_stock", v)} label="Track stock quantity" /></div>
                {row.manage_stock ? (
                  <Field label="Stock quantity" changed={dirty.has("stock_quantity")}>
                    <BufferedInput value={row.stock_quantity === null ? "" : String(row.stock_quantity)} inputMode="numeric" onCommit={(v) => setMany({ stock_quantity: v === "" ? null : Math.trunc(Number(v)), stock_status: Number(v) > 0 ? "instock" : row.backorders !== "no" ? "onbackorder" : "outofstock" })} />
                  </Field>
                ) : (
                  <Field label="Stock status" changed={dirty.has("stock_status")}>
                    <Select value={row.stock_status} onChange={(e) => set("stock_status", e.target.value)}>
                      <option value="instock">In stock</option><option value="outofstock">Out of stock</option><option value="onbackorder">On backorder</option>
                    </Select>
                  </Field>
                )}
                <Field label="Backorders" changed={dirty.has("backorders")}>
                  <Select value={row.backorders} onChange={(e) => set("backorders", e.target.value)}>
                    <option value="no">Do not allow</option><option value="notify">Allow, notify customer</option><option value="yes">Allow</option>
                  </Select>
                </Field>
                <Field label={`Weight (${info?.handshake?.weight_unit ?? "kg"})`} changed={dirty.has("weight")}><BufferedInput value={row.weight} onCommit={(v) => set("weight", v)} /></Field>
                <Field label={`Dimensions L × W × H (${info?.handshake?.dimension_unit ?? "cm"})`} changed={["length", "width", "height"].some((f) => dirty.has(f))}>
                  <div className="flex gap-1">
                    {(["length", "width", "height"] as const).map((f) => <BufferedInput key={f} value={row[f]} placeholder={f[0].toUpperCase()} onCommit={(v) => set(f, v)} />)}
                  </div>
                </Field>
                <Field label="Shipping class" changed={dirty.has("shipping_class")}>
                  <Select value={row.shipping_class} onChange={(e) => set("shipping_class", e.target.value)}>
                    <option value="">{row.type === "variation" ? "Same as parent" : "No shipping class"}</option>
                    {(taxonomy?.shipping_classes ?? []).map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label="Tax class" changed={dirty.has("tax_class")}>
                  <Select value={row.tax_class} onChange={(e) => set("tax_class", e.target.value)}>
                    {row.type === "variation" && <option value="parent">Same as parent</option>}
                    <option value="">Standard</option>
                    {(taxonomy?.tax_classes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            {tab === "custom" && <CustomFieldsPanel row={row} fields={info?.profile.custom_fields ?? []} set={set} dirty={dirty} />}
            {tab === "seo" && <SeoPanel row={row} set={set} dirty={dirty} home={info?.handshake?.home_url ?? ""} />}
          </div>
        )}
      </div>
      {showPreview && row && <PreviewPane row={row} />}
      <Modal open={library} onClose={() => setLibrary(false)} title="Media library" width={860}>
        <LibraryPicker
          media={[...media.values()]}
          onPick={(m) => {
            setLibrary(false);
            if (!row) return;
            if (!row.image_id) set("image_id", m.id);
            else if (row.type !== "variation") set("gallery_ids", [...row.gallery_ids, m.id]);
            else set("image_id", m.id);
          }}
        />
      </Modal>
    </div>
  );
}

export function AttributesEditor({ attrs, onChange, changed }: { attrs: ProductAttribute[]; onChange: (a: ProductAttribute[]) => void; changed: boolean }) {
  const { taxonomy } = useApp();
  return (
    <Field label="Attributes" className="col-span-2" changed={changed}>
      <div className="space-y-2">
        {attrs.map((a, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border border-line p-2">
            <div className="w-40 shrink-0">
              <div className="text-[13px] font-medium">{a.name}</div>
              <div className="text-2xs text-muted">{a.taxonomy ? `global · ${a.taxonomy}` : "custom"}</div>
            </div>
            <div className="flex-1">
              <TagInput value={a.options} onChange={(options) => onChange(attrs.map((x, j) => (j === i ? { ...x, options } : x)))} suggestions={(taxonomy?.attributes.find((t) => t.taxonomy === a.taxonomy)?.terms ?? []).map((t) => t.name)} />
              <div className="mt-1 flex gap-4 text-xs">
                <label className="flex items-center gap-1"><input type="checkbox" checked={a.visible} onChange={(e) => onChange(attrs.map((x, j) => (j === i ? { ...x, visible: e.target.checked } : x)))} /> Visible on product page</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={a.variation} onChange={(e) => onChange(attrs.map((x, j) => (j === i ? { ...x, variation: e.target.checked } : x)))} /> Used for variations</label>
              </div>
            </div>
            <button type="button" className="cf-close rounded p-0.5" onClick={() => onChange(attrs.filter((_, j) => j !== i))} aria-label="Remove attribute"><Trash2 size={14} /></button>
          </div>
        ))}
        <Select value="" onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const t = taxonomy?.attributes.find((x) => x.taxonomy === v);
          const name = t ? t.name : window.prompt("Custom attribute name") ?? "";
          if (!name) return;
          onChange([...attrs, { name, taxonomy: t ? t.taxonomy : "", options: [], visible: true, variation: false, position: attrs.length }]);
        }}>
          <option value="">+ Add attribute…</option>
          {(taxonomy?.attributes ?? []).filter((t) => !attrs.some((a) => a.taxonomy === t.taxonomy)).map((t) => <option key={t.taxonomy} value={t.taxonomy}>{t.name}</option>)}
          <option value="__custom">Custom attribute…</option>
        </Select>
      </div>
    </Field>
  );
}

/** ACF saves dates as Ymd (20250131); keep whichever format the store already uses. */
function dateIn(v: string) {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v.slice(0, 10);
}

function CustomFieldsPanel({ row, fields, set, dirty }: { row: ProductRow; fields: CustomField[]; set: (f: string, v: unknown) => void; dirty: Set<string> }) {
  return (
    <div className="grid grid-cols-2 gap-4" data-testid="custom-fields-panel">
      {fields.map((f) => {
        const id = META_PREFIX + f.key;
        const value = String((row as Record<string, unknown>)[id] ?? "");
        const label = f.label || f.key;
        return (
          <Field key={f.key} label={label} className={f.kind === "longtext" ? "col-span-2" : undefined} changed={dirty.has(id)} hint={f.label ? <code className="text-2xs">{f.key}</code> : undefined}>
            {f.kind === "yesno" ? (
              <Toggle checked={["yes", "1", "true", "on"].includes(value.toLowerCase())} onChange={(v) => set(id, v ? "yes" : "no")} label={label} />
            ) : f.kind === "date" ? (
              <input type="date" className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px]" value={dateIn(value)} onChange={(e) => set(id, /^\d{8}$/.test(value) ? e.target.value.replace(/-/g, "") : e.target.value)} />
            ) : (
              <BufferedInput value={value} multiline={f.kind === "longtext"} inputMode={f.kind === "number" ? "decimal" : undefined} onCommit={(v) => set(id, v)} data-testid={`cf-${f.key}`} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

function SeoPanel({ row, set, dirty, home }: { row: ProductRow; set: (f: string, v: unknown) => void; dirty: Set<string>; home: string }) {
  const title = row.seo_title || row.name;
  const desc = row.seo_description || row.short_description.replace(/<[^>]+>/g, "").slice(0, 160);
  const host = home.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="grid grid-cols-2 gap-4">
      <Field label="SEO title" className="col-span-2" changed={dirty.has("seo_title")} hint={<span className={clsx(row.seo_title.length > 60 && "text-removed")}>{row.seo_title.length}/60 characters</span>}>
        <BufferedInput value={row.seo_title} placeholder={row.name} onCommit={(v) => set("seo_title", v)} />
      </Field>
      <Field label="Meta description" className="col-span-2" changed={dirty.has("seo_description")} hint={<span className={clsx(row.seo_description.length > 160 && "text-removed")}>{row.seo_description.length}/160 characters</span>}>
        <BufferedInput multiline value={row.seo_description} onCommit={(v) => set("seo_description", v)} />
      </Field>
      <Field label="Focus keyword" changed={dirty.has("focus_keyword")}><BufferedInput value={row.focus_keyword} onCommit={(v) => set("focus_keyword", v)} /></Field>
      <Field label="Slug" changed={dirty.has("slug")}><BufferedInput value={row.slug} onCommit={(v) => set("slug", v)} /></Field>
      <div className="col-span-2 rounded-lg border border-line bg-white p-4 text-left dark:bg-[#202124]">
        <div className="text-xs text-[#202124] dark:text-[#bdc1c6]">{host || "yourstore.com"} › product › {row.slug || "…"}</div>
        <div className="truncate text-lg text-[#1a0dab] dark:text-[#8ab4f8]">{title}</div>
        <div className="line-clamp-2 text-[13px] text-[#4d5156] dark:text-[#bdc1c6]">{desc || "Add a meta description to control what shoppers see in search results."}</div>
      </div>
    </div>
  );
}

/** Live preview in the store's real theme. Re-renders shortly after each staged change. */
function PreviewPane({ row }: { row: ProductRow }) {
  const { backend, storeId, toast } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const draft = useMemo(() => {
    const d: Record<string, unknown> = {};
    const fields = row._state.is_new ? Object.keys(row).filter((k) => k !== "_state") : row._state.dirty;
    for (const f of fields) d[f] = (row as Record<string, unknown>)[f];
    // Image refs are not uploaded yet; the preview shows store images only.
    for (const f of ["image_id", "gallery_ids"]) if (d[f] !== undefined && JSON.stringify(d[f]).includes("{")) delete d[f];
    return d;
  }, [row]);
  const key = JSON.stringify(draft);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const load = useCallback(() => {
    if (!storeId) return;
    setLoading(true);
    backend
      .preview(storeId, typeof row.id === "number" && row.id > 0 ? row.id : null, draft)
      .then(setUrl)
      .catch((e) => toast({ tone: "error", title: "Preview failed", body: String(e) }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, storeId, row.id, key]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 500);
    return () => clearTimeout(timer.current);
  }, [load]);
  return (
    <div className="flex w-[46%] min-w-[380px] flex-col border-l border-line bg-sunken" data-testid="preview-pane">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted">
        <Eye size={13} /> Live preview — your store's theme, unsaved changes applied
        <span className="flex-1" />
        <button onClick={load} className="rounded p-1 hover:bg-panel" aria-label="Reload preview"><RefreshCw size={13} className={clsx(loading && "animate-spin")} /></button>
      </div>
      {url ? <iframe title="Product preview" src={url} className="min-h-0 flex-1 bg-white" sandbox="allow-same-origin allow-scripts" /> : <div className="p-6 text-muted">Rendering…</div>}
    </div>
  );
}

export function useMediaValue(v: MediaValue) {
  const { media } = useApp();
  return mediaUrl(v, media);
}
