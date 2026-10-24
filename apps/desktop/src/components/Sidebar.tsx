import { BookOpen, Boxes, Layers, ChevronDown, ChevronRight, FolderTree, History, Image as ImageIcon, Moon, Package, Plus, Settings, Sun, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CategoryRow, Edit, LocalFile, ProductRow } from "../backend/types";
import { ancestorKeys, assignCategory, catKey } from "../lib/categoryAssign";
import { useApp, type View } from "../store/app";
import { categoryTree } from "./fields";
import { Badge, clsx, Dropzone, mediaUrl, Thumb } from "./ui";

const ENV_LABEL = { local: "Local", staging: "Staging", production: "Live" } as const;

function StoreSwitcher() {
  const { stores, storeId, selectStore, openDialog, info } = useApp();
  const [open, setOpen] = useState(false);
  const current = stores.find((s) => s.id === storeId);
  return (
    <div className="relative px-2 pt-2">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken" data-testid="store-switcher">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: current?.color ?? "#999" }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{current?.name ?? "No store"}</span>
          <span className="block truncate text-2xs text-muted">{current ? `${ENV_LABEL[current.environment]} · ${info?.product_count?.toLocaleString() ?? "…"} products` : "Add a store to begin"}</span>
        </span>
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <div className="absolute left-2 right-2 z-40 mt-1 rounded-lg border border-line bg-panel py-1 shadow-xl" onMouseLeave={() => setOpen(false)}>
          {stores.map((s) => (
            <button key={s.id} onClick={() => (setOpen(false), selectStore(s.id))} className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-sunken", s.id === storeId && "font-semibold")}>
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="flex-1 truncate">{s.name}</span>
              <Badge tone={s.environment === "production" ? "removed" : s.environment === "local" ? "added" : "changed"}>{ENV_LABEL[s.environment]}</Badge>
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button onClick={() => (setOpen(false), openDialog("add-store"))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-accent hover:bg-sunken" data-testid="add-store">
            <Plus size={14} /> Add store…
          </button>
        </div>
      )}
    </div>
  );
}

function NavItem({ id, icon, label, count }: { id: View; icon: React.ReactNode; label: string; count?: number }) {
  const { view, setView } = useApp();
  return (
    <button onClick={() => setView(id)} className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]", view === id ? "bg-sunken font-medium text-fg" : "text-muted hover:bg-sunken hover:text-fg")} data-testid={`nav-${id}`}>
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && count > 0 && <span className="text-2xs text-muted">{count.toLocaleString()}</span>}
    </button>
  );
}

function CategoryFilterTree() {
  const { taxonomy, query, setQuery, media, stage, selection, toast, backend, storeId, version, catWithParents, setCatWithParents } = useApp();
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Selected products (not variations), for ticking categories on them.
  const [picked, setPicked] = useState<ProductRow[]>([]);
  useEffect(() => {
    if (!storeId || !selection.length) return setPicked([]);
    let cancelled = false;
    backend.rows(storeId, selection).then((r) => !cancelled && setPicked(r.filter((x) => x.type !== "variation" && !x._state.deleted)));
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, selection, version]);
  const cats = useMemo(() => (taxonomy?.categories ?? []).filter((c) => !c._state.deleted), [taxonomy]);
  const { keyOf, children } = useMemo(() => categoryTree(cats), [cats]);
  const totals = useMemo(() => {
    const t = new Map<string, number>();
    const walk = (c: CategoryRow): number => {
      const k = keyOf(c);
      const sum = (c.count ?? 0) + (children.get(k) ?? []).reduce((s, x) => s + walk(x), 0);
      t.set(k, sum);
      return sum;
    };
    (children.get("0") ?? []).forEach(walk);
    return t;
  }, [children, keyOf]);

  const setImage = (c: CategoryRow, files: LocalFile[]) => {
    const img = files.find((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name));
    if (!img) return;
    stage([{ entity: "category", key: keyOf(c), field: "image_id", value: { file: img.path, preview: img.url } }]);
    toast({ tone: "success", title: `Thumbnail set for “${c.name}”`, body: "Uploaded with your next push." });
  };

  // Parents of categories the selected products are in open automatically.
  const holds = useMemo(() => new Set(picked.flatMap((r) => r.category_ids.flatMap((id) => ancestorKeys(cats, String(id))))), [picked, cats]);
  /** all / some / none of the selected products are in the category. */
  const tick = (k: string): "all" | "some" | "none" => {
    const n = picked.filter((r) => r.category_ids.map(String).includes(k)).length;
    return n === 0 ? "none" : n === picked.length ? "all" : "some";
  };
  const toggleFor = async (c: CategoryRow) => {
    const on = tick(catKey(c)) !== "all";
    const edits: Edit[] = [];
    for (const r of picked) {
      const next = assignCategory(r.category_ids, cats, c, on, catWithParents);
      if (next.length !== r.category_ids.length || next.some((v, i) => String(v) !== String(r.category_ids[i]))) edits.push({ entity: "product", key: r._state.key, field: "category_ids", value: next });
    }
    if (!edits.length) return;
    await stage(edits);
    toast({ tone: "success", title: on ? `Added ${edits.length} product${edits.length === 1 ? "" : "s"} to ${c.name}${catWithParents && c.parent && String(c.parent) !== "0" ? " and its parents" : ""}` : `Removed ${edits.length} product${edits.length === 1 ? "" : "s"} from ${c.name}`, body: "Undo with ⌘Z." });
  };

  const renderNode = (c: CategoryRow, depth: number): JSX.Element => {
    const k = keyOf(c);
    const kids = children.get(k) ?? [];
    const isOpen = open.has(k) || (!open.has(`-${k}`) && holds.has(k));
    const active = query.category_id !== undefined && query.category_id !== null && String(query.category_id) === k;
    return (
      <div key={k}>
        <Dropzone toFiles={useApp.getState().backend.filesFromDrop} onFiles={(f) => setImage(c, f)} className="rounded-md" activeClassName="ring-1 ring-accent bg-accent/10">
          <div className={clsx("group flex items-center gap-1 rounded-md py-1 pr-1 text-[13px]", active ? "bg-accent/10 text-accent" : "text-muted hover:bg-sunken hover:text-fg")} style={{ paddingLeft: depth * 12 + 4 }}>
            <button className="w-4 shrink-0 text-muted" onClick={() => setOpen((s) => new Set([...[...s].filter((x) => x !== k && x !== `-${k}`), isOpen ? `-${k}` : k]))} aria-label={isOpen ? `Collapse ${c.name}` : `Expand ${c.name}`}>
              {kids.length ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
            </button>
            <Thumb src={mediaUrl(c.image_id, media)} size={18} />
            {picked.length > 0 && <TriCheckbox state={tick(k)} onChange={() => toggleFor(c)} label={`${c.name} for the selected products`} testId={`cat-tick-${c.name}`} />}
            <button className="min-w-0 flex-1 truncate text-left" onClick={() => setQuery({ category_id: active ? null : (c._state.is_new ? null : c.id), uncategorized: false })} title="Filter products · drop an image here to set the category thumbnail">
              {c.name}
            </button>
            <span className="text-2xs tabular-nums">{totals.get(k) || ""}</span>
          </div>
        </Dropzone>
        {isOpen && kids.map((x) => renderNode(x, depth + 1))}
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" data-testid="category-tree">
      <div className="px-2 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wide text-muted">Categories</div>
      {picked.length > 0 ? (
        <div className="mx-1 mb-1 space-y-1 rounded-md bg-accent/5 p-2 text-2xs text-muted" data-testid="cat-assign-bar">
          <div><b className="text-fg">{picked.length} selected product{picked.length === 1 ? "" : "s"}</b>: tick or untick categories. A dash means only some of them are in it.</div>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={catWithParents} onChange={(e) => setCatWithParents(e.target.checked)} /> Also tick parent categories</label>
        </div>
      ) : (
        <div className="px-2 pb-1 text-2xs text-muted">Select products in the grid to tick their categories here.</div>
      )}
      <button onClick={() => setQuery({ category_id: null, uncategorized: false })} className={clsx("w-full rounded-md px-2 py-1 text-left text-[13px]", !query.category_id && !query.uncategorized ? "bg-sunken text-fg" : "text-muted hover:bg-sunken")}>
        All products
      </button>
      <button onClick={() => setQuery({ category_id: null, uncategorized: true })} className={clsx("w-full rounded-md px-2 py-1 text-left text-[13px]", query.uncategorized ? "bg-sunken text-fg" : "text-muted hover:bg-sunken")}>
        Uncategorized
      </button>
      {(children.get("0") ?? []).map((c) => renderNode(c, 0))}
    </div>
  );
}

export function Sidebar() {
  const { view, info, summary, dark, setDark, taxonomy, media } = useApp();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-4 pt-3 text-[13px] font-semibold">
        <Boxes size={16} className="text-accent" /> CatalogForge
        <span className="flex-1" />
        <button onClick={() => setDark(!dark)} className="rounded p-1 text-muted hover:bg-sunken" aria-label="Toggle dark mode">
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
      <StoreSwitcher />
      <nav className="space-y-0.5 px-2 pt-2">
        <NavItem id="products" icon={<Package size={15} />} label="Products" count={info?.product_count} />
        <NavItem id="batch" icon={<Layers size={15} />} label="Batch Builder" />
        <NavItem id="categories" icon={<FolderTree size={15} />} label="Categories" count={taxonomy?.categories.length} />
        <NavItem id="media" icon={<ImageIcon size={15} />} label="Media" count={media.size} />
        <NavItem id="catalogue" icon={<BookOpen size={15} />} label="Catalogue PDF" />
        <NavItem id="history" icon={<History size={15} />} label="History" />
        <NavItem id="settings" icon={<Settings size={15} />} label="Settings" />
      </nav>
      {view === "products" ? <CategoryFilterTree /> : <div className="flex-1" />}
      <div className="border-t border-line px-4 py-2 text-2xs text-muted">
        <Tag size={11} className="mr-1 inline" />
        {summary.fields + summary.created + summary.deleted > 0 ? `${summary.created + summary.modified + summary.deleted} records changed locally` : "All changes pushed"}
      </div>
    </aside>
  );
}

function TriCheckbox({ state, onChange, label, testId }: { state: "all" | "some" | "none"; onChange: () => void; label: string; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === "all"} onChange={onChange} aria-label={label} title={state === "some" ? "Some of the selected products are in this category" : undefined} className="shrink-0 accent-[rgb(var(--accent))]" data-testid={testId} />;
}
