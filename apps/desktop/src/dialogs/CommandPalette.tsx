import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Edit, ProductRow } from "../backend/types";
import { Thumb, mediaUrl } from "../components/ui";
import { applyMass, isApplicable, MASS_FIELDS } from "../lib/massChange";
import { useApp } from "../store/app";

export function CommandPalette() {
  const app = useApp();
  const { dialog, openDialog } = app;
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ProductRow[]>([]);
  const open = dialog === "palette";

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openDialog(open ? null : "palette");
      }
      const typing = /INPUT|TEXTAREA/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if (mod && e.key.toLowerCase() === "s" && !typing) {
        e.preventDefault();
        useApp.getState().push();
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && !typing && !document.querySelector(".gdg-overlay-editor")) {
        e.preventDefault();
        useApp.getState().undo();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, openDialog]);

  // Always open with an empty query.
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  useEffect(() => {
    if (!open || q.length < 2 || !app.storeId) return setHits([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await app.backend.query(app.storeId!, { search: q });
      const rows = await app.backend.rows(app.storeId!, r.keys.slice(0, 8));
      if (!cancelled) setHits(rows);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, app.backend, app.storeId]);

  if (!open) return null;
  const run = (fn: () => unknown) => () => {
    openDialog(null);
    setQ("");
    fn();
  };
  const bulk = (fieldKey: string, op: Parameters<typeof applyMass>[1]["op"], value: string, label: string) => async () => {
    const { selection, backend, storeId, stage, toast } = useApp.getState();
    if (!storeId) return;
    const keys = selection.length ? selection : (await backend.query(storeId, useApp.getState().query)).keys;
    const rows = await backend.rows(storeId, keys);
    const field = MASS_FIELDS.find((f) => f.key === fieldKey)!;
    const edits: Edit[] = [];
    for (const r of rows) {
      if (!isApplicable(r, field)) continue;
      const after = applyMass(r, { field, op, value });
      if (after !== undefined) edits.push({ entity: r.type === "variation" ? "variation" : "product", key: r._state.key, field: fieldKey, value: after });
    }
    await stage(edits);
    toast({ tone: "success", title: `${label}: ${edits.length} products`, body: selection.length ? "Applied to the selection." : "Applied to all products in the current view." });
  };
  const groupAsVariations = async () => {
    const { selection, backend, storeId, stage, create, toast, openDrawer } = useApp.getState();
    if (!storeId || selection.length < 2) return toast({ tone: "error", title: "Select at least two simple products to group" });
    const rows = (await backend.rows(storeId, selection)).filter((r) => r.type === "simple");
    const attrName = window.prompt("These products differ by which attribute? (e.g. Size, Colour)", "Size");
    if (!attrName) return;
    const values = rows.map((r) => window.prompt(`${attrName} value for “${r.name}”`, r.name.split(/[\s-]+/).pop() ?? "") ?? "");
    const taxonomy = "pa_" + attrName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const base = rows[0];
    const [parent] = await create([{ entity: "product", fields: { name: base.name.replace(new RegExp(`\\s*[-–]?\\s*${values[0]}$`, "i"), ""), type: "variable", status: base.status, category_ids: base.category_ids, description: base.description, short_description: base.short_description, image_id: base.image_id, attributes: [{ name: attrName, taxonomy, options: values, visible: true, variation: true, position: 0 }] } }]);
    await create(rows.map((r, i) => ({ entity: "variation" as const, fields: { parent_id: parent, sku: r.sku ? `${r.sku}-V` : "", regular_price: r.regular_price, sale_price: r.sale_price, manage_stock: r.manage_stock, stock_quantity: r.stock_quantity, stock_status: r.stock_status, image_id: r.image_id, variation_attributes: { [taxonomy]: values[i] } } })));
    await stage(rows.map((r) => ({ entity: "product", key: r._state.key, field: "status", value: "draft" })));
    toast({ tone: "success", title: `Grouped ${rows.length} products into one variable product`, body: "The originals are set to draft; delete them after checking the result." });
    openDrawer(parent);
  };

  const item = "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-[13px] aria-selected:bg-accent/10 aria-selected:text-accent";
  const group = "px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted";
  return createPortal(
    <div className="fixed inset-0 flex items-start justify-center bg-black/30 pt-[14vh]" onMouseDown={(e) => e.target === e.currentTarget && openDialog(null)}>
      <Command label="Command palette" className="w-[620px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" data-testid="palette" onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          openDialog(null);
        }
      }}>
        <Command.Input value={q} onValueChange={setQ} autoFocus placeholder="Type a command or search products…" className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] focus:outline-none" />
        <Command.List className="max-h-[420px] overflow-auto p-1">
          <Command.Empty className="p-4 text-center text-muted">No results</Command.Empty>
          {hits.length > 0 && (
            <Command.Group heading="Products" className={group}>
              {hits.map((h) => (
                <Command.Item key={h._state.key} value={`product ${h.name} ${h.sku} ${h._state.key}`} onSelect={run(() => (app.setView("products"), app.openDrawer(h._state.key)))} className={item}>
                  <Thumb src={mediaUrl(h.image_id, app.media)} size={22} /> {h.name} <span className="text-2xs text-muted">{h.sku}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Actions" className={group}>
            <Command.Item onSelect={run(() => app.push())} className={item}>Push changes to store <span className="kbd ml-auto">⌘S</span></Command.Item>
            <Command.Item onSelect={run(() => app.pull(false))} className={item}>Sync from store</Command.Item>
            <Command.Item onSelect={run(() => app.undo())} className={item}>Undo <span className="kbd ml-auto">⌘Z</span></Command.Item>
            <Command.Item onSelect={run(() => app.openDialog("import"))} className={item}>Import products from spreadsheet…</Command.Item>
            <Command.Item onSelect={run(() => app.openDialog("mass-change"))} className={item}>Bulk edit…</Command.Item>
            <Command.Item onSelect={run(() => app.openDialog("export"))} className={item}>Export to Excel or CSV…</Command.Item>
            <Command.Item onSelect={run(() => app.setView("catalogue"))} className={item}>Create a catalogue PDF…</Command.Item>
            <Command.Item onSelect={run(() => app.setView("batch"))} className={item}>Build a batch of products from a blank…</Command.Item>
            <Command.Item onSelect={run(() => app.setView("migration"))} className={item}>Migrate this store to another store…</Command.Item>
            <Command.Item onSelect={run(async () => app.openDrawer((await app.create([{ entity: "product", fields: { name: "New product", type: "simple", status: "draft" } }]))[0]))} className={item}>New product</Command.Item>
            <Command.Item onSelect={run(() => app.toggleChanges(true))} className={item}>Review changes</Command.Item>
            <Command.Item onSelect={run(groupAsVariations)} className={item}>Group selected simple products as variations</Command.Item>
          </Command.Group>
          <Command.Group heading="Quick bulk edits (selection, or the current view)" className={group}>
            <Command.Item onSelect={run(bulk("regular_price", "inc_pct", "10", "Prices +10%"))} className={item}>Increase prices by 10%</Command.Item>
            <Command.Item onSelect={run(bulk("regular_price", "dec_pct", "10", "Prices −10%"))} className={item}>Decrease prices by 10%</Command.Item>
            <Command.Item onSelect={run(bulk("regular_price", "charm", "", "Charm pricing"))} className={item}>Round prices to .99</Command.Item>
            <Command.Item onSelect={run(bulk("sale_price", "pct_off_regular", "20", "20% sale"))} className={item}>Put on sale: 20% off</Command.Item>
            <Command.Item onSelect={run(bulk("sale_price", "clear", "", "Sale ended"))} className={item}>End sale (clear sale prices)</Command.Item>
            <Command.Item onSelect={run(bulk("status", "set", "draft", "Set to draft"))} className={item}>Set status to draft</Command.Item>
            <Command.Item onSelect={run(bulk("status", "set", "publish", "Published"))} className={item}>Publish</Command.Item>
            <Command.Item onSelect={run(bulk("name", "case", "", "Title Case names"))} className={item}>Title Case product names</Command.Item>
          </Command.Group>
          <Command.Group heading="Filters" className={group}>
            <Command.Item onSelect={run(() => app.setQuery({ only_changed: true }))} className={item}>Show only changed products</Command.Item>
            <Command.Item onSelect={run(() => app.setQuery({ missing_image: true }))} className={item}>Show products without an image</Command.Item>
            <Command.Item onSelect={run(() => app.setQuery({ stock_status: "outofstock" }))} className={item}>Show out-of-stock products</Command.Item>
            <Command.Item onSelect={run(() => app.setQuery({ only_changed: false, missing_image: false, stock_status: null, status: null, kind: null, category_id: null, uncategorized: false, search: "" }))} className={item}>Clear all filters</Command.Item>
          </Command.Group>
          <Command.Group heading="Go to" className={group}>
            {(["products", "categories", "media", "history", "settings"] as const).map((v) => (
              <Command.Item key={v} onSelect={run(() => app.setView(v))} className={item}>Go to {v}</Command.Item>
            ))}
            {app.stores.filter((s) => s.id !== app.storeId).map((s) => (
              <Command.Item key={s.id} value={`switch store ${s.name}`} onSelect={run(() => app.selectStore(s.id))} className={item}>
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} /> Switch to {s.name}
              </Command.Item>
            ))}
            <Command.Item onSelect={run(() => app.setDark(!app.dark))} className={item}>Toggle dark mode</Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>,
    document.getElementById("portal") ?? document.body,
  );
}
