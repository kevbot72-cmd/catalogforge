import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CategoryRow, ProductRow } from "../backend/types";
import { ancestorKeys, assignCategory, catKey } from "../lib/categoryAssign";
import { useApp } from "../store/app";
import { Button, clsx, Input, mediaUrl, Modal, Thumb } from "./ui";

/**
 * The products in one category, each with a tick box: untick to take a product out of this
 * category, tick to put it back, or add more from the whole store.
 */
export function CategoryProducts({ cat }: { cat: CategoryRow }) {
  const { backend, storeId, version, stage, taxonomy, media, catWithParents, setCatWithParents } = useApp();
  const cats = useMemo(() => (taxonomy?.categories ?? []).filter((c) => !c._state.deleted), [taxonomy]);
  const key = catKey(cat);
  const names = useMemo(() => new Map(cats.map((c) => [catKey(c), c.name])), [cats]);
  // Sub-categories of this one, so products that sit only in a child are visible too.
  const below = useMemo(() => new Set(cats.filter((c) => ancestorKeys(cats, catKey(c)).includes(key)).map(catKey)), [cats, key]);
  const [open, setOpen] = useState(true);
  const [withSub, setWithSub] = useState(true);
  const [q, setQ] = useState("");
  const [listed, setListed] = useState<string[]>([]);
  const [rows, setRows] = useState<Map<string, ProductRow>>(new Map());
  const [picker, setPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  // Ticks show at once; the staged value takes over when the rows refresh.
  const [optimistic, setOptimistic] = useState<Map<string, boolean>>(new Map());

  // The list is fixed per category, so unticking leaves the product in view to tick back.
  useEffect(() => {
    setListed([]);
    setRows(new Map());
    if (!storeId || cat._state.is_new || typeof cat.id !== "number") return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { keys } = await backend.query(storeId, { category_id: cat.id, expanded: [] });
      const r = keys.length ? await backend.rows(storeId, keys) : [];
      if (cancelled) return;
      setListed(r.filter((x) => x.type !== "variation").map((x) => x._state.key));
      setRows(new Map(r.map((x) => [x._state.key, x])));
    })().finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, cat.id, cat._state.is_new]);
  // Refresh the rows (not the list) after every change.
  useEffect(() => {
    if (!storeId || !listed.length) return;
    let cancelled = false;
    backend.rows(storeId, listed).then((r) => {
      if (cancelled) return;
      setRows(new Map(r.map((x) => [x._state.key, x])));
      setOptimistic(new Map());
    });
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, version, listed]);

  const isIn = (r: ProductRow) => optimistic.get(r._state.key) ?? r.category_ids.map(String).includes(key);
  const inChild = (r: ProductRow) => r.category_ids.map(String).filter((c) => below.has(c));
  const toggle = async (r: ProductRow, on: boolean) => {
    setOptimistic((m) => new Map(m).set(r._state.key, on));
    await stage([{ entity: "product", key: r._state.key, field: "category_ids", value: assignCategory(r.category_ids, cats, cat, on, catWithParents) }]);
  };
  const all = listed.map((k) => rows.get(k)).filter((r): r is ProductRow => !!r && !r._state.deleted);
  const shown = all.filter((r) => (withSub || isIn(r) || !inChild(r).length) && (!q || `${r.name} ${r.sku}`.toLowerCase().includes(q.toLowerCase())));
  const direct = all.filter(isIn).length;
  const viaChild = all.filter((r) => !isIn(r) && inChild(r).length).length;

  if (cat._state.is_new) return null;
  return (
    <div className="rounded-lg border border-line" data-testid="category-products">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-[13px] font-semibold">Products in this category</span>
        <span className="text-xs text-muted">{loading ? "loading…" : `${direct} directly${viaChild ? ` · ${viaChild} only in sub-categories` : ""}`}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-56">
              <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
              <Input className="pl-7" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {below.size > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} /> Show products from sub-categories</label>
            )}
            <span className="flex-1" />
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setPicker(true)} data-testid="category-add-products">Add products…</Button>
          </div>
          <p className="text-2xs text-muted">Untick a product to take it out of <b>{cat.name}</b>; tick to put it in. Its other categories are left as they are. Changes are staged: Undo or Push as usual.</p>
          <div className="max-h-80 overflow-auto rounded-md border border-line">
            {shown.map((r) => {
              const on = isIn(r);
              const kids = inChild(r);
              const others = r.category_ids.map(String).filter((c) => c !== key && !below.has(c));
              return (
                <label key={r._state.key} className={clsx("flex items-center gap-2 border-t border-line px-2.5 py-1.5 text-[13px] first:border-0 hover:bg-sunken", !on && "text-muted")}>
                  <input type="checkbox" checked={on} onChange={(e) => toggle(r, e.target.checked)} aria-label={`${r.name} in ${cat.name}`} data-testid={`catprod-${r.sku || r._state.key}`} />
                  <Thumb src={mediaUrl(r.image_id, media)} size={24} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {kids.length > 0 && <span className="shrink-0 rounded bg-accent/10 px-1.5 text-2xs text-accent" title="Also (or only) in these sub-categories">in {kids.map((c) => names.get(c)).join(", ")}</span>}
                  {others.length > 0 && <span className="max-w-[140px] shrink-0 truncate text-2xs text-muted" title={others.map((c) => names.get(c) ?? c).join(", ")}>+ {others.map((c) => names.get(c) ?? c).join(", ")}</span>}
                  <span className="w-24 shrink-0 truncate text-right font-mono text-2xs text-muted">{r.sku}</span>
                </label>
              );
            })}
            {!shown.length && !loading && <div className="p-3 text-xs text-muted">{all.length ? "No products match the filter." : "No products in this category yet. Use Add products… to put some in."}</div>}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={catWithParents} onChange={(e) => setCatWithParents(e.target.checked)} /> Ticking also ticks this category's parents
          </label>
        </div>
      )}
      <AddProducts open={picker} onClose={() => setPicker(false)} cat={cat} onAdded={(k) => setListed((cur) => (cur.includes(k) ? cur : [k, ...cur]))} />
    </div>
  );
}

function AddProducts({ open, onClose, cat, onAdded }: { open: boolean; onClose: () => void; cat: CategoryRow; onAdded: (key: string) => void }) {
  const { backend, storeId, version, stage, taxonomy, media, catWithParents } = useApp();
  const cats = useMemo(() => (taxonomy?.categories ?? []).filter((c) => !c._state.deleted), [taxonomy]);
  const key = catKey(cat);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [optimistic, setOptimistic] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!open || !storeId) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const { keys } = await backend.query(storeId, { search: q, expanded: [] });
      const r = await backend.rows(storeId, keys.slice(0, 100));
      if (cancelled) return;
      setRows(r.filter((x) => x.type !== "variation" && !x._state.deleted));
      setOptimistic(new Map());
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, q, backend, storeId, version]);
  return (
    <Modal open={open} onClose={onClose} title={`Add products to ${cat.name}`} width={620} testId="category-add-dialog" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
          <Input autoFocus className="pl-7" placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} data-testid="category-add-search" />
        </div>
        <div className="max-h-96 overflow-auto rounded-md border border-line">
          {rows.map((r) => {
            const on = optimistic.get(r._state.key) ?? r.category_ids.map(String).includes(key);
            return (
              <label key={r._state.key} className="flex items-center gap-2 border-t border-line px-2.5 py-1.5 text-[13px] first:border-0 hover:bg-sunken">
                <input type="checkbox" checked={on} onChange={async (e) => {
                  const checked = e.target.checked;
                  setOptimistic((m) => new Map(m).set(r._state.key, checked));
                  await stage([{ entity: "product", key: r._state.key, field: "category_ids", value: assignCategory(r.category_ids, cats, cat, checked, catWithParents) }]);
                  if (checked) onAdded(r._state.key);
                }} aria-label={`Add ${r.name}`} data-testid={`catadd-${r.sku || r._state.key}`} />
                <Thumb src={mediaUrl(r.image_id, media)} size={24} />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="font-mono text-2xs text-muted">{r.sku}</span>
              </label>
            );
          })}
          {!rows.length && <div className="p-3 text-xs text-muted">No products match.</div>}
        </div>
        <p className="text-2xs text-muted">Showing up to 100 matches; search to narrow down. Ticked products are in {cat.name}.</p>
      </div>
    </Modal>
  );
}
