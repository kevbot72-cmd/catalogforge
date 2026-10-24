import { CheckSquare, Search, Square, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Edit, MediaValue, ProductRow } from "../backend/types";
import { Badge, Button, clsx, Empty, Input, Modal, Thumb } from "../components/ui";
import { useApp } from "../store/app";

const SHOWN = 1500;
const idOf = (v: MediaValue | undefined) => (typeof v === "number" ? v : 0);

export function MediaView() {
  const { media, stage, backend, storeId, toast, taxonomy, version } = useApp();
  const [q, setQ] = useState("");
  const [missingAlt, setMissingAlt] = useState(false);
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const last = useRef<number | null>(null);

  // Which products and categories use each image (for the "Not used" filter and safe deletes).
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    (async () => {
      const { keys } = await backend.query(storeId, { include_variations: true, expanded: [] });
      const out: ProductRow[] = [];
      for (let i = 0; i < keys.length; i += 2000) out.push(...(await backend.rows(storeId, keys.slice(i, i + 2000))));
      if (!cancelled) setRows(out);
    })().catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, version]);
  const usage = useMemo(() => {
    const m = new Map<number, number>();
    const add = (id: number) => id > 0 && m.set(id, (m.get(id) ?? 0) + 1);
    for (const r of rows ?? []) {
      if (r._state.deleted) continue;
      add(idOf(r.image_id));
      for (const g of r.gallery_ids ?? []) add(idOf(g));
    }
    for (const c of taxonomy?.categories ?? []) {
      add(idOf(c.image_id));
      add(idOf(c.banner_id));
    }
    return m;
  }, [rows, taxonomy]);

  const list = useMemo(
    () =>
      [...media.values()]
        .filter((m) => (!missingAlt || !m.alt) && (!unusedOnly || (rows !== null && !usage.has(m.id))) && (!q || `${m.filename} ${m.alt} ${m.title}`.toLowerCase().includes(q.toLowerCase())))
        .sort((a, b) => b.id - a.id),
    [media, q, missingAlt, unusedOnly, usage, rows],
  );
  const shown = list.slice(0, SHOWN);
  const noAlt = useMemo(() => [...media.values()].filter((m) => !m.alt).length, [media]);
  const unused = rows ? [...media.values()].filter((m) => !usage.has(m.id)).length : null;
  // Drop selections that are no longer in the library (deleted, undone…).
  useEffect(() => setSelected((s) => new Set([...s].filter((id) => media.has(id)))), [media]);

  const click = (id: number, e: React.MouseEvent) => {
    const idx = shown.findIndex((m) => m.id === id);
    // Read the anchor now: the updater below runs after `last` has moved on.
    const anchor = last.current;
    setSelected((s) => {
      const n = new Set(s);
      if (e.shiftKey && anchor !== null) {
        const from = shown.findIndex((m) => m.id === anchor);
        if (from >= 0) {
          const on = !s.has(id);
          for (const m of shown.slice(Math.min(from, idx), Math.max(from, idx) + 1)) on ? n.add(m.id) : n.delete(m.id);
          return n;
        }
      }
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    last.current = id;
  };
  const allShownSelected = shown.length > 0 && shown.every((m) => selected.has(m.id));

  const fillAlt = async () => {
    if (!storeId) return;
    const targets = [...media.values()].filter((m) => !m.alt && m.parent_id > 0);
    const parents = await backend.rows(storeId, [...new Set(targets.map((m) => String(m.parent_id)))]);
    const names = new Map(parents.map((p) => [p.id, p.name]));
    const edits: Edit[] = targets.filter((m) => names.get(m.parent_id)).map((m) => ({ entity: "media", key: String(m.id), field: "alt", value: names.get(m.parent_id) }));
    await stage(edits);
    toast({ tone: "success", title: `Alt text staged for ${edits.length} images`, body: "Generated from each image's product name." });
  };

  // Products and categories that would lose an image.
  const affected = useMemo(() => {
    if (!confirm) return { products: [] as ProductRow[], categories: 0 };
    const products = (rows ?? []).filter((r) => !r._state.deleted && (selected.has(idOf(r.image_id)) || (r.gallery_ids ?? []).some((g) => selected.has(idOf(g)))));
    const categories = (taxonomy?.categories ?? []).filter((c) => selected.has(idOf(c.image_id)) || selected.has(idOf(c.banner_id))).length;
    return { products, categories };
  }, [confirm, rows, taxonomy, selected]);

  const deleteSelected = async () => {
    const ids = [...selected];
    // One staging call, so a single Undo restores the images and every product that used them.
    const edits: Edit[] = [];
    for (const r of affected.products) {
      const entity = r.type === "variation" ? "variation" : "product";
      if (selected.has(idOf(r.image_id))) edits.push({ entity, key: r._state.key, field: "image_id", value: 0 });
      const gallery = r.gallery_ids ?? [];
      if (gallery.some((g) => selected.has(idOf(g)))) edits.push({ entity, key: r._state.key, field: "gallery_ids", value: gallery.filter((g) => !selected.has(idOf(g))) });
    }
    for (const c of taxonomy?.categories ?? []) {
      const key = c._state.is_new ? c._state.key : String(c.id);
      if (selected.has(idOf(c.image_id))) edits.push({ entity: "category", key, field: "image_id", value: 0 });
      if (selected.has(idOf(c.banner_id))) edits.push({ entity: "category", key, field: "banner_id", value: 0 });
    }
    for (const id of ids) edits.push({ entity: "media", key: String(id), field: "__delete", value: true });
    await stage(edits);
    // Staged deletions are hidden from the library.
    useApp.setState({ media: new Map((await backend.media(storeId!)).map((m) => [m.id, m])) });
    setConfirm(false);
    setSelected(new Set());
    toast({ tone: "success", title: `${ids.length} image${ids.length === 1 ? "" : "s"} will be deleted when you push`, body: affected.products.length ? `Also removed from ${affected.products.length} product${affected.products.length === 1 ? "" : "s"}. Undo (⌘Z) brings everything back.` : "Undo (⌘Z) brings them back." });
  };

  const chip = (on: boolean) => clsx("h-7 rounded-full border px-2.5 text-xs", on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="relative w-72">
          <Search size={14} className="absolute left-2.5 top-2 text-muted" />
          <Input className="pl-8" placeholder="Search file name or alt text" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button onClick={() => setMissingAlt(!missingAlt)} className={chip(missingAlt)}>Missing alt text ({noAlt})</button>
        <button onClick={() => setUnusedOnly(!unusedOnly)} className={chip(unusedOnly)} disabled={unused === null} data-testid="media-unused" title="Images no product or category uses">Not used{unused !== null ? ` (${unused})` : "…"}</button>
        <span className="flex-1" />
        <Button size="sm" icon={<Wand2 size={14} />} onClick={fillAlt} disabled={!noAlt}>Fill missing alt text from product names</Button>
      </div>
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs" data-testid="media-selection-bar">
        <Button size="sm" variant="ghost" icon={allShownSelected ? <Square size={14} /> : <CheckSquare size={14} />} onClick={() => setSelected(allShownSelected ? new Set() : new Set([...selected, ...shown.map((m) => m.id)]))} disabled={!shown.length} data-testid="media-select-all">
          {allShownSelected ? "Clear selection" : `Select all${list.length > shown.length ? ` ${shown.length.toLocaleString()} shown` : ` (${shown.length.toLocaleString()})`}`}
        </Button>
        {selected.size > 0 && (
          <>
            <span className="text-muted" data-testid="media-selected-count">{selected.size.toLocaleString()} selected</span>
            <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => setSelected(new Set())}>Clear</Button>
            <span className="flex-1" />
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)} data-testid="media-delete">Delete selected ({selected.size.toLocaleString()})</Button>
          </>
        )}
        {selected.size === 0 && <span className="text-muted">Click images to select them · Shift-click to select a range</span>}
      </div>
      {!list.length ? (
        <Empty title="No media">{unusedOnly ? "Every image is used by a product or category." : "Images attached to products and categories appear here. Drop images onto a product's Media tab, a category, or use Import with an image folder."}</Empty>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-auto p-4" data-testid="media-grid">
          {shown.map((m) => {
            const on = selected.has(m.id);
            const uses = usage.get(m.id) ?? 0;
            return (
              <div key={m.id} className={clsx("group relative overflow-hidden rounded-lg border bg-panel", on ? "border-accent ring-2 ring-accent/40" : "border-line")} data-testid="media-tile">
                <button type="button" className="relative block w-full select-none" onClick={(e) => click(m.id, e)} aria-pressed={on} aria-label={`Select ${m.filename}`}>
                  <Thumb src={m.thumb_url || m.url} size={150} className="aspect-square h-auto w-full rounded-none" alt={m.alt} />
                  <span className={clsx("absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded border bg-panel/90 shadow-sm", on ? "border-accent bg-accent text-white" : "border-line opacity-0 group-hover:opacity-100", selected.size > 0 && "opacity-100")}>
                    {on && <svg viewBox="0 0 12 12" className="h-3 w-3"><path d="M2 6.5 5 9l5-6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}
                  </span>
                </button>
                <div className="space-y-1 p-2">
                  <div className="truncate text-xs font-medium" title={m.filename}>{m.filename}</div>
                  <input
                    className="w-full rounded border border-transparent bg-transparent px-1 text-2xs text-muted hover:border-line focus:border-accent focus:text-fg focus:outline-none"
                    defaultValue={m.alt}
                    placeholder="Add alt text…"
                    onBlur={(e) => e.target.value !== m.alt && stage([{ entity: "media", key: String(m.id), field: "alt", value: e.target.value }])}
                  />
                  <div className="flex flex-wrap gap-1">
                    {m.width > 0 && <Badge>{m.width}×{m.height}</Badge>}
                    {m.mime && <Badge>{m.mime.replace("image/", "")}</Badge>}
                    {rows && (uses ? <Badge tone="accent">used {uses}×</Badge> : <Badge tone="changed">not used</Badge>)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${selected.size.toLocaleString()} image${selected.size === 1 ? "" : "s"}?`}
        width={480}
        testId="media-delete-dialog"
        footer={<>
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 size={14} />} onClick={deleteSelected} data-testid="media-delete-confirm">Delete</Button>
        </>}
      >
        <div className="space-y-3 text-[13px]">
          <p>The images are removed from your store's media library, including every resized copy, when you <b>Push</b>. Until then you can review the change or Undo it.</p>
          {affected.products.length + affected.categories > 0 ? (
            <div className="rounded-md border border-changed/40 bg-changed/5 p-3">
              <b>Still in use.</b> {affected.products.length > 0 && <>{affected.products.length.toLocaleString()} product{affected.products.length === 1 ? "" : "s"}</>}
              {affected.products.length > 0 && affected.categories > 0 && " and "}
              {affected.categories > 0 && <>{affected.categories} categor{affected.categories === 1 ? "y" : "ies"}</>} use{affected.products.length + affected.categories === 1 ? "s" : ""} these images. They will be taken off those too, so nothing shows a missing picture.
              <div className="mt-1.5 max-h-24 overflow-auto text-xs text-muted">{affected.products.slice(0, 30).map((p) => p.name).join(" · ")}{affected.products.length > 30 ? " …" : ""}</div>
            </div>
          ) : (
            <p className="text-muted">None of them are used by a product or category.</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
