import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ExternalLink, Info, PanelBottom, PanelRight, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { META_PREFIX, type CategoryRow, type Edit, type MediaRef, type MediaValue, type ProductAttribute, type ProductRow } from "../backend/types";
import { assignCategory, catKey } from "../lib/categoryAssign";
import { CHOICES, YES_NO, type Choice } from "../lib/fieldOptions";
import { appliesTo, common, isMaths, itemCounts, mapEdits, numberEdits, setEdits, type PanelKind } from "../lib/panelEdit";
import { useApp, type PanelPrefs } from "../store/app";
import { categoryTree, GalleryEditor, LibraryPicker, TagInput } from "./fields";
import { AttributesEditor } from "./ProductDrawer";
import { RichTextEditor } from "./RichTextEditor";
import { Button, clsx, mediaUrl, Modal, Thumb } from "./ui";

/* ------------------------------------------------------------------ fields */

interface FieldDef {
  field: string;
  label: string;
  kind: PanelKind | "readonly";
  choices?: Choice[];
  hint?: string;
  /** Unique per product (SKU, GTIN): editable only with one product. */
  single?: boolean;
  wide?: boolean;
}

interface SectionDef {
  id: string;
  label: string;
  fields?: FieldDef[];
  /** Fields a custom block edits (for the staged-change dots). */
  touches?: string[];
}

const MATHS_HINT = "Type a value, or change every product at once: +10%, -5%, +20, -5, *1.2 or =regular_price*0.8";

function sectionsFor(taxClasses: string[], shippingClasses: { slug: string; name: string }[], custom: { key: string; label: string; kind: string }[]): SectionDef[] {
  return [
    { id: "content", label: "Content", fields: [{ field: "name", label: "Name", kind: "text", wide: true }], touches: ["short_description", "description"] },
    {
      id: "general",
      label: "General",
      fields: [
        { field: "sku", label: "SKU", kind: "text", single: true },
        { field: "global_unique_id", label: "GTIN / UPC / EAN / ISBN", kind: "text", single: true },
        { field: "regular_price", label: "Regular price", kind: "decimal", hint: MATHS_HINT },
        { field: "sale_price", label: "Sale price", kind: "decimal", hint: MATHS_HINT },
        { field: "date_on_sale_from", label: "Sale price from", kind: "date" },
        { field: "date_on_sale_to", label: "Sale price to", kind: "date" },
        { field: "status", label: "Status", kind: "enum", choices: CHOICES.status },
        { field: "catalog_visibility", label: "Catalog visibility", kind: "enum", choices: CHOICES.catalog_visibility },
        { field: "tax_status", label: "Tax status", kind: "enum", choices: CHOICES.tax_status },
        { field: "tax_class", label: "Tax class", kind: "enum", choices: [{ value: "", label: "Standard" }, ...taxClasses.map((t) => ({ value: t, label: t }))] },
        { field: "external_url", label: "Product URL (external)", kind: "text" },
        { field: "button_text", label: "Button text (external)", kind: "text" },
        { field: "date_created_gmt", label: "Post date", kind: "readonly" },
        { field: "date_modified_gmt", label: "Last modified", kind: "readonly" },
      ],
    },
    {
      id: "inventory",
      label: "Inventory",
      fields: [
        { field: "manage_stock", label: "Track stock quantity", kind: "bool" },
        { field: "stock_quantity", label: "Stock quantity", kind: "int", hint: "Type a number, or +10 / -3 to adjust every product's stock" },
        { field: "stock_status", label: "Stock status", kind: "enum", choices: CHOICES.stock_status },
        { field: "backorders", label: "Allow backorders", kind: "enum", choices: CHOICES.backorders },
        { field: "sold_individually", label: "Limit one per order", kind: "bool" },
      ],
    },
    {
      id: "shipping",
      label: "Shipping",
      fields: [
        { field: "weight", label: "Weight", kind: "decimal", hint: MATHS_HINT },
        { field: "length", label: "Length", kind: "decimal" },
        { field: "width", label: "Width", kind: "decimal" },
        { field: "height", label: "Height", kind: "decimal" },
        { field: "shipping_class", label: "Shipping class", kind: "enum", choices: [{ value: "", label: "No shipping class" }, ...shippingClasses.map((s) => ({ value: s.slug, label: s.name }))] },
      ],
    },
    { id: "linked", label: "Linked products", touches: ["upsell_ids", "cross_sell_ids"] },
    { id: "attributes", label: "Attributes", touches: ["attributes"] },
    {
      id: "advanced",
      label: "Advanced",
      fields: [
        { field: "purchase_note", label: "Purchase note", kind: "longtext", wide: true, hint: "Sent to the customer after they buy" },
        { field: "menu_order", label: "Menu order", kind: "int" },
        { field: "reviews_allowed", label: "Enable reviews", kind: "bool" },
        { field: "slug", label: "Slug (URL)", kind: "text", single: true },
      ],
    },
    { id: "categories", label: "Categories", touches: ["category_ids"] },
    { id: "tags", label: "Product tags", touches: ["tags"] },
    { id: "gallery", label: "Gallery", touches: ["image_id", "gallery_ids"] },
    ...(custom.length
      ? [{
          id: "custom",
          label: "Custom fields",
          fields: custom.map((c): FieldDef => ({
            field: META_PREFIX + c.key,
            label: c.label || c.key,
            kind: c.kind === "number" ? "decimal" : c.kind === "yesno" ? "enum" : c.kind === "longtext" ? "longtext" : c.kind === "date" ? "date" : "text",
            choices: c.kind === "yesno" ? YES_NO : undefined,
            wide: c.kind === "longtext",
          })),
        }]
      : []),
    {
      id: "seo",
      label: "SEO",
      fields: [
        { field: "seo_title", label: "SEO title", kind: "text", wide: true, hint: "Up to about 60 characters" },
        { field: "seo_description", label: "Meta description", kind: "longtext", wide: true, hint: "Up to about 160 characters" },
        { field: "focus_keyword", label: "Focus keyword", kind: "text" },
      ],
    },
    { id: "brands", label: "Brands", touches: ["brand_ids"] },
  ];
}

const entityOf = (r: ProductRow) => (r.type === "variation" ? "variation" : "product") as Edit["entity"];
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const show = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/* ------------------------------------------------------------------ data */

function usePanelRows(keys: string[]) {
  const { backend, storeId, version } = useApp();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const sig = keys.join("|");
  useEffect(() => {
    if (!storeId || !keys.length) return setRows([]);
    let cancelled = false;
    backend.rows(storeId, keys).then((r) => !cancelled && setRows(r));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, storeId, sig, version]);
  return rows;
}

/* ------------------------------------------------------------------ controls */

function Tri({ state, onChange, label, testId }: { state: "all" | "some" | "none"; onChange: () => void; label: ReactNode; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
      <input ref={ref} type="checkbox" checked={state === "all"} onChange={onChange} className="accent-[rgb(var(--accent))]" data-testid={testId} />
      {label}
    </label>
  );
}

function triOf(rows: ProductRow[], field: string): "all" | "some" | "none" {
  const c = common(rows, field);
  const on = c.rows.filter((r) => !!(r as Record<string, unknown>)[field]).length;
  return on === 0 ? "none" : on === c.rows.length ? "all" : "some";
}

/** One property row: label, editor, and a per-field undo when it has staged changes. */
function PropRow({ def, rows, stage }: { def: FieldDef; rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const kind = def.kind === "readonly" ? "text" : def.kind;
  const c = useMemo(() => common(rows, def.field, kind), [rows, def.field, kind]);
  const multi = rows.length > 1;
  const na = c.rows.length === 0;
  const partial = !na && c.rows.length < rows.length;
  const tip = !c.same ? c.values.slice(0, 8).map((v) => `${show(v.value) || "(empty)"} — ${plural(v.count, "product")}`).join("\n") : undefined;
  const discard = () => stage(c.rows.filter((r) => r._state.dirty.includes(def.field) && !r._state.is_new).map((r) => ({ entity: entityOf(r), key: r._state.key, field: def.field, value: null })), "Undone");

  let editor: ReactNode;
  if (na) editor = <span className="px-2 text-xs text-muted">Doesn't apply to {multi ? "these products" : "this product"}</span>;
  else if (def.kind === "readonly") editor = <span className="truncate px-2 text-[13px] text-muted">{c.same ? show(c.value).replace("T", " ").replace("Z", "") || "—" : `Mixed · ${c.summary}`}</span>;
  else if (def.single && multi) editor = <span className="px-2 text-xs italic text-muted" title="Each product needs its own. Tick one product to edit it.">Unique per product</span>;
  else if (def.kind === "enum" || def.kind === "bool") {
    const choices = def.kind === "bool" ? YES_NO : def.choices ?? [];
    const cur = def.kind === "bool" ? (c.value ? "yes" : "no") : show(c.value);
    editor = (
      <select
        className={clsx("h-7 w-full rounded-md border bg-panel px-1.5 text-[13px] focus:border-accent focus:outline-none", c.same ? "border-line" : "border-dashed border-line italic text-muted", c.dirty && "border-changed/60 bg-changed/10")}
        value={c.same ? cur : "__mixed"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__mixed") return;
          stage(setEdits(c.rows, def.field, def.kind === "bool" ? v === "yes" : v), `${def.label}: ${choices.find((x) => x.value === v)?.label ?? v}`);
        }}
        title={tip}
        data-testid={`panel-${def.field}`}
      >
        {!c.same && <option value="__mixed">Mixed · {c.values.length} values</option>}
        {choices.map((o) => <option key={o.value} value={o.value} className="not-italic text-fg">{o.label}</option>)}
        {c.same && !choices.some((o) => o.value === cur) && cur && <option value={cur}>{cur}</option>}
      </select>
    );
  } else if (def.kind === "date") {
    const end = def.field.endsWith("_to");
    const acf = def.field.startsWith(META_PREFIX);
    const val = c.same ? show(c.value) : "";
    editor = (
      <input
        type="date"
        className={clsx("h-7 w-full rounded-md border bg-panel px-1.5 text-[13px] focus:border-accent focus:outline-none", c.same ? "border-line" : "border-dashed border-line", c.dirty && "border-changed/60 bg-changed/10")}
        value={/^\d{8}$/.test(val) ? `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}` : val.slice(0, 10)}
        title={tip ?? (c.same ? undefined : "Mixed: pick a date to give every product the same one")}
        onChange={(e) => {
          const d = e.target.value;
          // ACF keeps Ymd; WooCommerce sale dates are full timestamps (empty clears them).
          const v = acf ? (/^\d{8}$/.test(val) ? d.replace(/-/g, "") : d) : d ? `${d}T${end ? "23:59:59" : "00:00:00"}Z` : null;
          stage(setEdits(c.rows, def.field, v), def.label);
        }}
        data-testid={`panel-${def.field}`}
      />
    );
  } else editor = <TextCell def={def} c={c} tip={tip} stage={stage} />;

  return (
    <div className={clsx("cf-prop grid grid-cols-[minmax(110px,38%)_minmax(0,1fr)_22px] items-center gap-2 border-b border-line/60", def.wide && "col-span-full")}>
      <span className="flex min-w-0 items-center gap-1 text-[12.5px] text-muted" title={def.hint}>
        <span className="truncate">{def.label}</span>
        {def.hint && <Info size={11} className="shrink-0 opacity-60" />}
        {partial && <span className="shrink-0 rounded bg-sunken px-1 text-2xs" title="Variations and variable products don't all have this field">{c.rows.length}/{rows.length}</span>}
      </span>
      <div className="min-w-0 py-1">{editor}</div>
      <span className="flex justify-end">
        {c.dirty > 0 && (
          <button onClick={discard} className="rounded p-0.5 text-changed hover:bg-changed/15" title={`Undo ${def.label} (${plural(c.dirty, "product")})`} aria-label={`Undo ${def.label}`}>
            <RotateCcw size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

function TextCell({ def, c, tip, stage }: { def: FieldDef; c: ReturnType<typeof common>; tip?: string; stage: (e: Edit[], what?: string) => void }) {
  const base = c.same ? show(c.value) : "";
  const [v, setV] = useState(base);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setV(base);
  }, [base, focus]);
  const numeric = def.kind === "decimal" || def.kind === "int";
  const maths = numeric && isMaths(v);
  let preview = "";
  let error = "";
  if (numeric && focus && v !== base) {
    try {
      const edits = numberEdits(c.rows, def.field, def.kind as "decimal" | "int", v);
      if (maths) preview = c.rows.length === 1 ? (edits[0] ? `→ ${show(edits[0].value)}` : "no change") : `${plural(edits.length, "product")} change`;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const commit = () => {
    setFocus(false);
    if (v === base && c.same) return;
    if (!c.same && v === "") return;
    try {
      const edits = numeric ? numberEdits(c.rows, def.field, def.kind as "decimal" | "int", v) : setEdits(c.rows, def.field, v);
      stage(edits, `${def.label} ${maths ? `(${v.trim()})` : ""}`.trim());
      if (maths) setV(base);
    } catch (e) {
      useApp.getState().toast({ tone: "error", title: (e as Error).message });
      setV(base);
    }
  };
  const cls = clsx(
    "w-full rounded-md border bg-panel px-2 text-[13px] placeholder:italic placeholder:text-muted focus:border-accent focus:outline-none",
    c.same ? "border-line" : "border-dashed border-line",
    c.dirty && !focus && "border-changed/60 bg-changed/10",
    error && "border-removed",
  );
  const placeholder = c.same ? "" : `Mixed · ${c.summary}`;
  const common_ = {
    value: v,
    placeholder,
    title: error || tip || def.hint,
    onFocus: () => setFocus(true),
    onBlur: commit,
    "data-testid": `panel-${def.field}`,
  };
  if (def.kind === "longtext")
    return <textarea {...common_} rows={2} className={clsx(cls, "py-1")} onChange={(e) => setV(e.target.value)} />;
  return (
    <div className="relative">
      <input
        {...common_}
        className={clsx(cls, "h-7", preview && "pr-28")}
        inputMode={numeric && !maths ? "decimal" : undefined}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setV(base);
            setTimeout(() => (e.target as HTMLInputElement).blur());
          }
        }}
      />
      {preview && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs font-medium text-accent">{preview}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ blocks */

function Block({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="col-span-full space-y-1.5 py-1">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
        {title}
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

function RichBlock({ field, label, rows, stage, minHeight }: { field: string; label: string; rows: ProductRow[]; stage: (e: Edit[], what?: string) => void; minHeight: number }) {
  const c = common(rows, field);
  const [force, setForce] = useState(false);
  const sig = rows.map((r) => r._state.key).join("|");
  useEffect(() => setForce(false), [sig]);
  if (!c.rows.length) return null;
  return (
    <Block title={label} right={c.dirty > 0 ? <span className="text-2xs text-changed">● {plural(c.dirty, "change")}</span> : null}>
      {c.same || force ? (
        <RichTextEditor key={sig + field + force} value={c.same ? show(c.value) : ""} onChange={(h) => stage(setEdits(c.rows, field, h))} minHeight={minHeight} placeholder={force ? `One ${label.toLowerCase()} for all ${c.rows.length} products` : undefined} testId={`panel-${field}`} />
      ) : (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-line px-3 py-3 text-[13px] text-muted">
          The {c.rows.length} products each have their own {label.toLowerCase()}.
          <Button size="sm" onClick={() => setForce(true)}>Write one for all</Button>
        </div>
      )}
    </Block>
  );
}

function ListChips({ items, total, onRemove, label }: { items: { key: string; name: string; count: number }[]; total: number; onRemove: (k: string) => void; label: string }) {
  if (!items.length) return <div className="text-xs text-muted">No {label} yet.</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span key={it.key} className={clsx("flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs", it.count === total ? "bg-accent/10 text-accent" : "border border-dashed border-accent/40 text-accent")}>
          {it.name}
          {total > 1 && <span className={clsx("text-2xs", it.count === total ? "opacity-70" : "text-changed")}>{it.count === total ? "all" : `${it.count} of ${total}`}</span>}
          <button onClick={() => onRemove(it.key)} className="rounded-full p-0.5 hover:bg-accent/20" aria-label={`Remove ${it.name}${total > 1 ? " from all" : ""}`} title={total > 1 ? "Remove from all" : "Remove"}><X size={11} /></button>
        </span>
      ))}
    </div>
  );
}

function CategoriesBlock({ rows, stage }: { rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const { taxonomy, catWithParents, setCatWithParents } = useApp();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const cats = useMemo(() => (taxonomy?.categories ?? []).filter((c) => !c._state.deleted), [taxonomy]);
  const { keyOf, children } = useMemo(() => categoryTree(cats), [cats]);
  const applicable = rows.filter((r) => appliesTo(r, "category_ids"));
  const counts = itemCounts(applicable, "category_ids");
  const n = applicable.length;
  if (!n) return <div className="col-span-full text-xs text-muted">Variations use their parent's categories.</div>;
  const state = (k: string) => (counts.get(k) ?? 0) === 0 ? "none" : counts.get(k) === n ? "all" : "some";
  const toggle = (c: CategoryRow) => {
    const on = state(catKey(c)) !== "all";
    stage(mapEdits(applicable, "category_ids", (cur) => assignCategory((cur as (number | string)[]) ?? [], cats, c, on, catWithParents)), `${on ? "Added to" : "Removed from"} ${c.name}`);
  };
  const holds = (k: string): boolean => (children.get(k) ?? []).some((x) => counts.has(keyOf(x)) || holds(keyOf(x)));
  const node = (c: CategoryRow, depth: number): JSX.Element => {
    const k = keyOf(c);
    const kids = children.get(k) ?? [];
    const isOpen = open.has(k) || (!open.has(`-${k}`) && holds(k));
    return (
      <div key={k}>
        <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-sunken" style={{ paddingLeft: depth * 16 + 2 }}>
          <button type="button" className="w-4 text-muted" onClick={() => setOpen((s) => new Set([...[...s].filter((x) => x !== k && x !== `-${k}`), isOpen ? `-${k}` : k]))} aria-label={isOpen ? `Collapse ${c.name}` : `Expand ${c.name}`}>
            {kids.length ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
          </button>
          <Tri state={state(k)} onChange={() => toggle(c)} label={<span className={clsx(depth === 0 && "font-medium")}>{c.name}{n > 1 && state(k) === "some" && <span className="ml-1.5 text-2xs text-changed">{counts.get(k)} of {n}</span>}</span>} testId={`panel-cat-${c.name}`} />
        </div>
        {isOpen && kids.map((x) => node(x, depth + 1))}
      </div>
    );
  };
  const matches = q ? cats.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : null;
  return (
    <div className="col-span-full space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-64 items-center gap-1.5 rounded-md border border-line px-2">
          <Search size={12} className="text-muted" />
          <input className="flex-1 bg-transparent text-[13px] focus:outline-none" placeholder="Find a category" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={catWithParents} onChange={(e) => setCatWithParents(e.target.checked)} /> Also tick parent categories</label>
        {n > 1 && <span className="text-2xs text-muted">A dash means only some of the {n} products are in it; tick to add all.</span>}
      </div>
      <div className="columns-1 gap-6 md:columns-2 xl:columns-3">
        {matches ? matches.map((c) => <div key={keyOf(c)} className="break-inside-avoid px-1 py-0.5"><Tri state={state(keyOf(c))} onChange={() => toggle(c)} label={c.name} /></div>) : (children.get("0") ?? []).map((c) => <div key={keyOf(c)} className="break-inside-avoid">{node(c, 0)}</div>)}
      </div>
    </div>
  );
}

function TagsBlock({ rows, stage }: { rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const { taxonomy } = useApp();
  const applicable = rows.filter((r) => appliesTo(r, "tags"));
  const counts = itemCounts(applicable, "tags");
  if (!applicable.length) return <div className="col-span-full text-xs text-muted">Variations use their parent's tags.</div>;
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, count]) => ({ key: k, name: k, count }));
  return (
    <div className="col-span-full space-y-2">
      <ListChips items={items} total={applicable.length} label="tags" onRemove={(t) => stage(mapEdits(applicable, "tags", (cur) => ((cur as string[]) ?? []).filter((x) => x !== t)), `Removed tag ${t}`)} />
      <div className="max-w-md">
        <TagInput value={[]} onChange={(add) => stage(mapEdits(applicable, "tags", (cur) => [...new Set([...((cur as string[]) ?? []), ...add])]), `Tagged ${add.join(", ")}`)} suggestions={(taxonomy?.tags ?? []).map((t) => t.name)} placeholder={applicable.length > 1 ? `Add a tag to all ${applicable.length}` : "Add a tag"} label="Add tag" />
      </div>
    </div>
  );
}

function BrandsBlock({ rows, stage }: { rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const brands = useApp((s) => s.taxonomy?.brands ?? []);
  const applicable = rows.filter((r) => appliesTo(r, "brand_ids"));
  if (!brands.length) return <div className="col-span-full text-[13px] text-muted">This store has no brands yet. WooCommerce 9.6 and later include Brands (Products → Brands in WordPress); once you add some there, press Sync and they appear here.</div>;
  if (!applicable.length) return <div className="col-span-full text-xs text-muted">Variations use their parent's brand.</div>;
  const counts = itemCounts(applicable, "brand_ids");
  const n = applicable.length;
  return (
    <div className="col-span-full flex flex-wrap gap-x-6 gap-y-1.5">
      {brands.map((b) => {
        const k = String(b.id);
        const st = (counts.get(k) ?? 0) === 0 ? "none" : counts.get(k) === n ? "all" : "some";
        return <Tri key={b.id} state={st} label={<>{b.name}{n > 1 && st === "some" && <span className="ml-1 text-2xs text-changed">{counts.get(k)} of {n}</span>}</>} onChange={() => stage(mapEdits(applicable, "brand_ids", (cur) => (st === "all" ? ((cur as number[]) ?? []).filter((x) => String(x) !== k) : [...new Set([...((cur as number[]) ?? []), b.id])])), b.name)} testId={`panel-brand-${b.name}`} />;
      })}
    </div>
  );
}

function LinkedBlock({ rows, stage }: { rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const applicable = rows.filter((r) => appliesTo(r, "upsell_ids"));
  if (!applicable.length) return <div className="col-span-full text-xs text-muted">Variations use their parent's linked products.</div>;
  return (
    <>
      <LinkedList field="upsell_ids" title="Upsells" hint="Shown on the product page: “You may also like…”" rows={applicable} stage={stage} />
      <LinkedList field="cross_sell_ids" title="Cross-sells" hint="Shown in the cart" rows={applicable} stage={stage} />
    </>
  );
}

function LinkedList({ field, title, hint, rows, stage }: { field: string; title: string; hint: string; rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const { backend, storeId } = useApp();
  const counts = itemCounts(rows, field);
  const ids = [...counts.keys()];
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ProductRow[]>([]);
  const idSig = ids.join(",");
  useEffect(() => {
    if (!storeId || !ids.length) return;
    backend.rows(storeId, ids).then((r) => setNames(new Map(r.map((x) => [String(x.id), x.name]))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, storeId, idSig]);
  useEffect(() => {
    if (!storeId || q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const res = await backend.query(storeId, { search: q.trim(), sort: [{ field: "name", desc: false }] });
      const r = await backend.rows(storeId, res.keys.slice(0, 8));
      setFound(r.filter((x) => typeof x.id === "number" && x.id > 0 && x.type !== "variation"));
    }, 200);
    return () => clearTimeout(t);
  }, [backend, storeId, q]);
  const items = ids.map((k) => ({ key: k, name: names.get(k) ?? `#${k}`, count: counts.get(k) ?? 0 }));
  const add = (p: ProductRow) => {
    setQ("");
    stage(mapEdits(rows, field, (cur, r) => (r.id === p.id ? cur : [...new Set([...((cur as number[]) ?? []), p.id])])), `${title}: ${p.name}`);
  };
  return (
    <Block title={title} right={<span className="text-2xs font-normal">{hint}</span>}>
      <ListChips items={items} total={rows.length} label={title.toLowerCase()} onRemove={(k) => stage(mapEdits(rows, field, (cur) => ((cur as number[]) ?? []).filter((x) => String(x) !== k)), `${title}: removed`)} />
      <div className="relative max-w-md">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2">
          <Plus size={12} className="text-muted" />
          <input className="flex-1 bg-transparent text-[13px] focus:outline-none" placeholder={`Find a product by name or SKU to add${rows.length > 1 ? " to all" : ""}`} value={q} onChange={(e) => setQ(e.target.value)} data-testid={`panel-${field}-search`} />
        </div>
        {found.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-line bg-panel py-1 shadow-lg">
            {found.map((p) => (
              <button key={p.id} onClick={() => add(p)} className="flex w-full items-center gap-2 px-2 py-1 text-left text-[13px] hover:bg-sunken">
                <span className="flex-1 truncate">{p.name}</span>
                <span className="font-mono text-2xs text-muted">{p.sku}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Block>
  );
}

function AttributesBlock({ rows, stage }: { rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const { taxonomy } = useApp();
  const applicable = rows.filter((r) => appliesTo(r, "attributes"));
  const [tax, setTax] = useState("");
  if (!applicable.length) return <div className="col-span-full text-xs text-muted">A variation's attribute values are set under Variations in the full editor.</div>;
  if (applicable.length === 1) {
    const r = applicable[0];
    return (
      <div className="col-span-full">
        <AttributesEditor attrs={r.attributes ?? []} onChange={(a) => stage([{ entity: "product", key: r._state.key, field: "attributes", value: a }], "Attributes")} changed={r._state.dirty.includes("attributes")} />
      </div>
    );
  }
  const n = applicable.length;
  const byName = new Map<string, { attr: ProductAttribute; count: number; values: Set<string> }>();
  for (const r of applicable)
    for (const a of r.attributes ?? []) {
      const k = a.taxonomy || a.name.toLowerCase();
      const e = byName.get(k) ?? { attr: a, count: 0, values: new Set<string>() };
      e.count++;
      a.options.forEach((o) => e.values.add(o));
      byName.set(k, e);
    }
  const keyOf = (a: ProductAttribute) => a.taxonomy || a.name.toLowerCase();
  const addValues = (base: ProductAttribute, values: string[]) =>
    stage(
      mapEdits(applicable, "attributes", (cur) => {
        const list = [...((cur as ProductAttribute[]) ?? [])];
        const i = list.findIndex((x) => keyOf(x) === keyOf(base));
        if (i >= 0) list[i] = { ...list[i], options: [...new Set([...list[i].options, ...values])] };
        else list.push({ ...base, options: values, position: list.length });
        return list;
      }),
      `${base.name}: ${values.join(", ")}`,
    );
  return (
    <div className="col-span-full space-y-2">
      <table className="w-full text-[13px]">
        <tbody>
          {[...byName.values()].map(({ attr, count, values }) => (
            <tr key={keyOf(attr)} className="border-b border-line/60">
              <td className="w-44 py-1.5 font-medium">{attr.name}<div className="text-2xs font-normal text-muted">{count === n ? `on all ${n}` : `on ${count} of ${n}`}</div></td>
              <td className="py-1.5 text-muted">{[...values].join(", ") || "—"}</td>
              <td className="w-64 py-1.5"><TagInput value={[]} onChange={(v) => addValues(attr, v)} suggestions={(taxonomy?.attributes.find((t) => t.taxonomy === attr.taxonomy)?.terms ?? []).map((t) => t.name)} placeholder="Add values to all" label={`Add ${attr.name} values`} /></td>
              <td className="w-8 py-1.5 text-right">
                <button className="cf-close rounded p-0.5" title="Remove from all" aria-label={`Remove ${attr.name} from all`} onClick={() => stage(mapEdits(applicable, "attributes", (cur) => ((cur as ProductAttribute[]) ?? []).filter((x) => keyOf(x) !== keyOf(attr))), `Removed ${attr.name}`)}><Trash2 size={13} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <select className="h-7 rounded-md border border-line bg-panel px-1.5 text-[13px]" value={tax} onChange={(e) => setTax(e.target.value)}>
          <option value="">+ Add an attribute to all {n}…</option>
          {(taxonomy?.attributes ?? []).filter((t) => !byName.has(t.taxonomy)).map((t) => <option key={t.taxonomy} value={t.taxonomy}>{t.name}</option>)}
        </select>
        {tax && (
          <div className="w-72">
            <TagInput value={[]} onChange={(v) => {
              const t = taxonomy?.attributes.find((x) => x.taxonomy === tax);
              if (t) addValues({ name: t.name, taxonomy: t.taxonomy, options: [], visible: true, variation: false, position: 0 }, v);
              setTax("");
            }} suggestions={(taxonomy?.attributes.find((t) => t.taxonomy === tax)?.terms ?? []).map((t) => t.name)} placeholder="Values, then Enter" label="Attribute values" />
          </div>
        )}
      </div>
    </div>
  );
}

function GalleryBlock({ rows, stage }: { rows: ProductRow[]; stage: (e: Edit[], what?: string) => void }) {
  const { media, backend } = useApp();
  const [library, setLibrary] = useState(false);
  if (rows.length === 1) {
    const r = rows[0];
    const isVar = r.type === "variation";
    const set = (image: MediaValue, gallery: MediaValue[]) =>
      stage(isVar ? [{ entity: "variation", key: r._state.key, field: "image_id", value: image }] : [{ entity: "product", key: r._state.key, field: "image_id", value: image }, { entity: "product", key: r._state.key, field: "gallery_ids", value: gallery }], "Images");
    return (
      <div className="col-span-full max-w-3xl">
        <GalleryEditor image={r.image_id} gallery={isVar ? [] : r.gallery_ids} media={media} onChange={set} toFiles={backend.filesFromDrop} pickFiles={() => backend.pickFiles({ multiple: true, extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] })} onPickLibrary={() => setLibrary(true)} onAltChange={(id, alt) => stage([{ entity: "media", key: String(id), field: "alt", value: alt }])} />
        <Modal open={library} onClose={() => setLibrary(false)} title="Media library" width={860}>
          <LibraryPicker media={[...media.values()]} onPick={(m) => {
            setLibrary(false);
            if (!r.image_id) set(m.id, isVar ? [] : r.gallery_ids);
            else if (!isVar) set(r.image_id, [...r.gallery_ids, m.id]);
            else set(m.id, []);
          }} />
        </Modal>
      </div>
    );
  }
  const products = rows.filter((r) => appliesTo(r, "gallery_ids"));
  const addToAll = async () => {
    const files = (await backend.pickFiles({ multiple: true, extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] })).filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name));
    if (!files.length) return;
    const refs: MediaRef[] = files.map((f) => ({ file: f.path, preview: f.url }));
    stage(mapEdits(products, "gallery_ids", (cur) => [...((cur as MediaValue[]) ?? []), ...refs]), `Added ${plural(refs.length, "image")} to ${plural(products.length, "gallery")}`);
  };
  return (
    <div className="col-span-full space-y-2">
      <div className="flex flex-wrap gap-3">
        {rows.slice(0, 24).map((r) => (
          <button key={r._state.key} onClick={() => useApp.getState().openDrawer(r.type === "variation" ? String(r.parent_id) : r._state.key)} className="flex w-20 flex-col items-center gap-1 text-center" title={`${r.name} · open in the full editor`}>
            <Thumb src={mediaUrl(r.image_id, media, "medium")} size={64} className="rounded-md" />
            <span className="line-clamp-2 text-2xs text-muted">{r.name}</span>
            <span className="text-2xs text-muted">{(r.gallery_ids?.length ?? 0) + (r.image_id ? 1 : 0)} images</span>
          </button>
        ))}
        {rows.length > 24 && <span className="self-center text-xs text-muted">and {rows.length - 24} more</span>}
      </div>
      {products.length > 0 && <Button size="sm" icon={<Plus size={13} />} onClick={addToAll}>Add images to every gallery…</Button>}
      <p className="text-2xs text-muted">Click a product to arrange its own pictures in the full editor.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

function clampSize(dock: PanelPrefs["dock"], n: number) {
  return dock === "bottom" ? Math.max(150, Math.min(n, window.innerHeight - 220)) : Math.max(340, Math.min(n, window.innerWidth - 520));
}

/** The edit panel under (or beside) the products grid. Edits every ticked product at once. */
export function EditPanel() {
  const { selection, focusKey, panel, setPanel, stage: stageRaw, toast, media, info, taxonomy, openDrawer, appearance } = useApp();
  const keys = selection.length ? selection : focusKey ? [focusKey] : [];
  const rows = usePanelRows(keys);
  const [size, setSize] = useState(panel.dock === "bottom" ? panel.bottomSize : panel.rightSize);
  const [find, setFind] = useState("");
  const [onlyMixed, setOnlyMixed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => setSize(panel.dock === "bottom" ? panel.bottomSize : panel.rightSize), [panel.dock, panel.bottomSize, panel.rightSize]);

  // Ctrl/⌘ + E opens or folds the panel.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setPanel({ open: !useApp.getState().panel.open });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setPanel]);

  const stage = useCallback(
    // The description argument names the change for callers; no toast on success, since the
    // yellow cells and the "changes staged" count already show it.
    (edits: Edit[], _what?: string) => {
      if (!edits.length) return;
      stageRaw(edits).catch((e) => toast({ tone: "error", title: "Could not stage edit", body: String(e) }));
    },
    [stageRaw, toast],
  );

  const sections = useMemo(
    () => sectionsFor(taxonomy?.tax_classes ?? [], taxonomy?.shipping_classes ?? [], info?.profile.custom_fields ?? []),
    [taxonomy, info],
  );
  const section = sections.find((s) => s.id === panel.section) ?? sections[1];
  const dirtyBy = useMemo(() => {
    const all = new Set(rows.flatMap((r) => r._state.dirty));
    const m = new Map<string, number>();
    for (const s of sections) {
      const fields = [...(s.fields ?? []).map((f) => f.field), ...(s.touches ?? [])];
      m.set(s.id, fields.filter((f) => all.has(f)).length);
    }
    return m;
  }, [rows, sections]);
  const staged = rows.reduce((n, r) => n + r._state.dirty.length, 0);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = panel.dock === "bottom" ? e.clientY : e.clientX;
    const from = size;
    let last = from;
    const move = (ev: PointerEvent) => {
      const d = (panel.dock === "bottom" ? ev.clientY : ev.clientX) - start;
      last = clampSize(panel.dock, from - d);
      setSize(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanel(panel.dock === "bottom" ? { bottomSize: last, open: true } : { rightSize: last, open: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const discardAll = () => {
    const edits: Edit[] = [];
    let kept = 0;
    for (const r of rows) {
      if (r._state.is_new) {
        kept++;
        continue;
      }
      for (const f of r._state.dirty) edits.push({ entity: entityOf(r), key: r._state.key, field: f, value: null });
    }
    if (edits.length) stage(edits, "Changes discarded");
    if (kept) toast({ tone: "info", title: `${plural(kept, "new product")} kept`, body: "New products aren't on the store yet; delete them to drop them." });
  };

  const bottom = panel.dock === "bottom";
  const first = rows[0];
  const multi = rows.length > 1;
  const typeC = rows.length ? common(rows, "type") : null;
  const hasVariation = rows.some((r) => r.type === "variation");
  const title = !rows.length ? "Edit panel" : multi ? `Editing ${plural(rows.length, "product")}` : first.name || "Untitled product";
  const subtitle = !rows.length ? "" : multi ? rows.slice(0, 4).map((r) => r.name).join(", ") + (rows.length > 4 ? ` +${rows.length - 4} more` : "") : [first.sku || "no SKU", first.type].join(" · ");

  // Field search and "only mixed" look through every section's fields at once.
  const searching = find.trim().length > 0 || onlyMixed;
  const visibleFields: FieldDef[] = useMemo(() => {
    // Fields that fit none of these products (like external-product links) stay out of the way.
    const fits = (f: FieldDef) => f.kind === "readonly" || common(rows, f.field).rows.length > 0;
    if (!searching) return (section.fields ?? []).filter(fits);
    const q = find.trim().toLowerCase();
    return sections.flatMap((s) => s.fields ?? []).filter(fits).filter((f) => (!q || f.label.toLowerCase().includes(q) || f.field.includes(q)) && (!onlyMixed || (rows.length > 1 && !common(rows, f.field).same && common(rows, f.field).rows.length > 0)));
  }, [searching, find, onlyMixed, section, sections, rows]);

  const header = (
    <div className="flex min-h-[42px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5" data-testid="edit-panel-header">
      <button onClick={() => setPanel({ open: !panel.open })} className="rounded p-1 text-muted hover:bg-sunken" title={panel.open ? "Fold the panel (Ctrl+E)" : "Open the panel (Ctrl+E)"} aria-label={panel.open ? "Collapse edit panel" : "Expand edit panel"} data-testid="edit-panel-toggle">
        {bottom ? panel.open ? <ChevronDown size={15} /> : <ChevronUp size={15} /> : <ChevronRight size={15} />}
      </button>
      {rows.length > 0 && (
        <span className="flex">
          {rows.slice(0, 3).map((r, i) => (
            <button key={r._state.key} onClick={() => openDrawer(r.type === "variation" ? String(r.parent_id) : r._state.key)} className={clsx("rounded-md ring-2 ring-panel", i > 0 && "-ml-2")} title={`Open ${r.name} in the full editor`}>
              <Thumb src={mediaUrl(r.image_id, media)} size={26} className="rounded-md" />
            </button>
          ))}
        </span>
      )}
      <div className="min-w-0 max-w-[340px]">
        <div className="truncate text-[13.5px] font-semibold" data-testid="edit-panel-title">{title}</div>
        {subtitle && <div className="truncate text-2xs text-muted">{subtitle}</div>}
      </div>
      {rows.length > 0 && panel.open && (
        <>
          <span className="h-5 w-px bg-line" />
          <select
            className={clsx("h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px]", typeC && !typeC.same && "italic text-muted")}
            value={hasVariation ? "variation" : typeC?.same ? show(typeC.value) : "__mixed"}
            disabled={hasVariation}
            onChange={(e) => e.target.value !== "__mixed" && stage(setEdits(rows, "type", e.target.value), `Type: ${e.target.value}`)}
            aria-label="Product type"
            data-testid="panel-type"
          >
            {hasVariation && <option value="variation">Variation</option>}
            {typeC && !typeC.same && !hasVariation && <option value="__mixed">Mixed types</option>}
            {CHOICES.type.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {(["virtual", "downloadable", "featured"] as const).map((f) => {
            const c = common(rows, f);
            if (!c.rows.length) return null;
            const st = triOf(rows, f);
            const label = f === "virtual" ? "Virtual" : f === "downloadable" ? "Downloadable" : "Featured";
            return <Tri key={f} state={st} onChange={() => stage(setEdits(c.rows, f, st !== "all"), `${label} ${st !== "all" ? "on" : "off"}`)} label={<>{label}{multi && st === "some" && <span className="text-2xs text-changed">{c.rows.filter((r) => !!(r as Record<string, unknown>)[f]).length} of {c.rows.length}</span>}</>} testId={`panel-${f}`} />;
          })}
        </>
      )}
      <span className="flex-1" />
      {staged > 0 && <span className="rounded-full border border-changed/40 bg-changed/10 px-2 py-0.5 text-2xs font-medium text-changed" data-testid="panel-staged">{plural(staged, "change")} staged</span>}
      {staged > 0 && <Button size="sm" variant="close" icon={<X size={13} />} onClick={discardAll} title="Undo every staged change on these products" data-testid="panel-discard">Discard</Button>}
      {rows.length > 0 && (
        <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => openDrawer(first.type === "variation" ? String(first.parent_id) : first._state.key)} title="Open the full product editor (or click the picture in the grid)">
          Full editor
        </Button>
      )}
      <button onClick={() => setPanel({ dock: bottom ? "right" : "bottom", open: true })} className="rounded p-1 text-muted hover:bg-sunken" title={bottom ? "Dock on the right" : "Dock at the bottom"} aria-label={bottom ? "Dock on the right" : "Dock at the bottom"} data-testid="panel-dock">
        {bottom ? <PanelRight size={15} /> : <PanelBottom size={15} />}
      </button>
    </div>
  );

  const nav = (
    <nav className={clsx(bottom ? "w-44 shrink-0 space-y-px overflow-auto border-r border-line p-1.5" : "flex flex-wrap gap-1 border-b border-line px-2 py-1.5")} aria-label="Edit panel sections">
      {sections.map((s) => (
        <button
          key={s.id}
          onClick={() => {
            setPanel({ section: s.id });
            setFind("");
            setOnlyMixed(false);
            bodyRef.current?.scrollTo({ top: 0 });
          }}
          className={clsx(
            "flex items-center justify-between gap-2 rounded-md text-left text-[12.5px]",
            bottom ? "w-full px-2.5 py-1.5" : "px-2 py-1",
            s.id === section.id && !searching ? "bg-accent/10 font-semibold text-accent" : "text-fg hover:bg-sunken",
          )}
          data-testid={`panel-section-${s.id}`}
        >
          {s.label}
          {(dirtyBy.get(s.id) ?? 0) > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-changed" title="Has staged changes" />}
        </button>
      ))}
    </nav>
  );

  const blocks = !searching && (
    <>
      {section.id === "content" && (
        <>
          <RichBlock field="short_description" label="Short description" rows={rows} stage={stage} minHeight={90} />
          <RichBlock field="description" label="Description" rows={rows} stage={stage} minHeight={160} />
        </>
      )}
      {section.id === "categories" && <CategoriesBlock rows={rows} stage={stage} />}
      {section.id === "tags" && <TagsBlock rows={rows} stage={stage} />}
      {section.id === "brands" && <BrandsBlock rows={rows} stage={stage} />}
      {section.id === "linked" && <LinkedBlock rows={rows} stage={stage} />}
      {section.id === "attributes" && <AttributesBlock rows={rows} stage={stage} />}
      {section.id === "gallery" && <GalleryBlock rows={rows} stage={stage} />}
      {section.id === "seo" && rows.length === 1 && <SeoPreview row={rows[0]} />}
    </>
  );

  const body = !rows.length ? (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">
      <div>
        <div className="font-medium text-fg">Nothing to edit yet</div>
        Click a product in the grid to edit it here, or tick several to change them all at once.
        <div className="mt-1 text-2xs">Clicking a product's picture still opens the full editor.</div>
      </div>
    </div>
  ) : (
    <div className={clsx("flex min-h-0 flex-1", !bottom && "flex-col")}>
      {nav}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 px-4 pb-1 pt-2">
          <span className="text-[13px] font-semibold">{searching ? (find ? `Fields matching “${find}”` : "Fields that differ") : section.label}</span>
          <div className="flex h-7 w-52 items-center gap-1.5 rounded-md border border-line px-2">
            <Search size={12} className="text-muted" />
            <input className="w-full bg-transparent text-[12.5px] focus:outline-none" placeholder="Find a field…" value={find} onChange={(e) => setFind(e.target.value)} data-testid="panel-find" />
            {find && <button onClick={() => setFind("")} className="text-muted" aria-label="Clear search"><X size={12} /></button>}
          </div>
          {multi && <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={onlyMixed} onChange={(e) => setOnlyMixed(e.target.checked)} data-testid="panel-only-mixed" /> Only show fields that differ</label>}
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <div className={clsx("grid gap-x-8", bottom ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1", appearance.density === "compact" ? "[&_.cf-prop]:min-h-[30px]" : "[&_.cf-prop]:min-h-[36px]")}>
            {visibleFields.map((f) => <PropRow key={f.field} def={f} rows={rows} stage={stage} />)}
            {searching && !visibleFields.length && <div className="col-span-full py-4 text-[13px] text-muted">{onlyMixed && !find ? "Every field is the same on all the ticked products." : "No field matches."}</div>}
            {blocks}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={clsx("relative flex shrink-0 flex-col bg-panel", bottom ? "border-t border-line shadow-[0_-6px_16px_rgba(0,0,0,0.05)]" : "border-l border-line")}
      style={panel.open ? (bottom ? { height: size } : { width: size }) : bottom ? undefined : { width: 52 }}
      data-testid="edit-panel"
      data-dock={panel.dock}
      data-open={panel.open}
    >
      {panel.open && (
        <div
          onPointerDown={startDrag}
          onDoubleClick={() => setPanel({ open: false })}
          className={clsx("group absolute z-10 flex items-center justify-center", bottom ? "inset-x-0 -top-1 h-2 cursor-row-resize" : "inset-y-0 -left-1 w-2 cursor-col-resize")}
          title="Drag to resize · double-click to fold"
          data-testid="panel-resize"
        >
          <span className={clsx("rounded-full bg-line group-hover:bg-accent/60", bottom ? "mt-1.5 h-1 w-11" : "ml-1.5 h-11 w-1")} />
        </div>
      )}
      {panel.open || bottom ? header : (
        <button onClick={() => setPanel({ open: true })} className="flex h-full flex-col items-center gap-3 pt-3 text-muted hover:bg-sunken" title="Open the edit panel (Ctrl+E)" data-testid="edit-panel-toggle">
          <ChevronLeft size={15} />
          <span className="text-[12.5px] font-medium [writing-mode:vertical-rl]">{rows.length ? title : "Edit panel"}</span>
        </button>
      )}
      {panel.open && <div className="flex min-h-0 flex-1 flex-col border-t border-line">{body}</div>}
    </div>
  );
}

function SeoPreview({ row }: { row: ProductRow }) {
  const home = useApp((s) => s.info?.handshake?.home_url ?? "");
  const host = home.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const title = row.seo_title || row.name;
  const desc = row.seo_description || row.short_description.replace(/<[^>]+>/g, "").slice(0, 160);
  return (
    <div className="col-span-full mt-2 max-w-2xl rounded-lg border border-line bg-white p-3 dark:bg-[#202124]">
      <div className="text-xs text-[#202124] dark:text-[#bdc1c6]">{host || "yourstore.com"} › product › {row.slug || "…"}</div>
      <div className="truncate text-base text-[#1a0dab] dark:text-[#8ab4f8]">{title}</div>
      <div className="line-clamp-2 text-[13px] text-[#4d5156] dark:text-[#bdc1c6]">{desc || "Add a meta description to control what shoppers see in search results."}</div>
    </div>
  );
}
