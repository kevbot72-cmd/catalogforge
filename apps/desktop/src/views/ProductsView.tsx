import { Copy, Download, FileUp, Plus, RefreshCw, Search, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CategoryFilter } from "../components/CategoryFilter";
import { EditPanel } from "../components/EditPanel";
import { columnsFor, presetsFor, ProductGrid } from "../components/ProductGrid";
import { Button, clsx, Input, Select } from "../components/ui";
import { ViewsMenu } from "../components/ViewsMenu";
import { loadViews, moveColumn, saveViews, setViewColumns, viewColumns, type ViewState } from "../lib/views";
import { useApp } from "../store/app";

function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button onClick={onClick} data-testid={testId} className={clsx("h-7 whitespace-nowrap rounded-full border px-2.5 text-xs", active ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
      {children}
    </button>
  );
}

export function ProductsView() {
  const { query, setQuery, selection, openDialog, create, openDrawer, remove, summary, undo, pull, info } = useApp();
  const panelDock = useApp((s) => s.panel.dock);
  const [search, setSearch] = useState(query.search ?? "");
  useEffect(() => {
    const t = setTimeout(() => search !== (query.search ?? "") && setQuery({ search }), 200);
    return () => clearTimeout(t);
  }, [search, query.search, setQuery]);
  const fields = info?.profile.custom_fields;
  const allColumns = useMemo(() => columnsFor(fields), [fields]);
  const presets = useMemo(() => presetsFor(fields), [fields]);
  const [views, setViews] = useState<ViewState>(() => loadViews(presetsFor(fields)));
  const changeViews = (next: ViewState) => {
    setViews(next);
    saveViews(next);
  };
  const columnIds = useMemo(() => viewColumns(views, presets).filter((id) => allColumns.some((c) => c.id === id)), [views, presets, allColumns]);
  const columns = useMemo(() => columnIds.map((id) => allColumns.find((c) => c.id === id)!), [columnIds, allColumns]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Filters, then actions. Selection-dependent buttons are always there (disabled when nothing is
          ticked) so the toolbar keeps its height and the grid doesn't jump. */}
      <div className="flex flex-wrap items-center gap-2 bg-panel px-3 pt-2">
        <div className="relative w-72">
          <Search size={14} className="absolute left-2.5 top-2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, SKU or ID" className="pl-8" data-testid="search" />
        </div>
        <CategoryFilter />
        <Select value={query.status ?? ""} onChange={(e) => setQuery({ status: e.target.value || null })} className="w-28" aria-label="Status filter">
          <option value="">Any status</option>
          {["publish", "draft", "pending", "private"].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Select value={query.kind ?? ""} onChange={(e) => setQuery({ kind: e.target.value || null })} className="w-28" aria-label="Type filter">
          <option value="">Any type</option>
          {["simple", "variable", "external", "grouped"].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Select value={query.stock_status ?? ""} onChange={(e) => setQuery({ stock_status: e.target.value || null })} className="w-32" aria-label="Stock filter">
          <option value="">Any stock</option>
          <option value="instock">In stock</option>
          <option value="outofstock">Out of stock</option>
          <option value="onbackorder">Backorder</option>
        </Select>
        <Chip active={!!query.only_changed} onClick={() => setQuery({ only_changed: !query.only_changed })} testId="filter-changed">Changed</Chip>
        <Chip active={!!query.missing_image} onClick={() => setQuery({ missing_image: !query.missing_image })}>No image</Chip>
        <Chip active={!!query.include_variations} onClick={() => setQuery({ include_variations: !query.include_variations })}>Show variations</Chip>
        {summary.conflicts > 0 && <Chip active={!!query.only_conflicts} onClick={() => setQuery({ only_conflicts: !query.only_conflicts })}>Conflicts ({summary.conflicts})</Chip>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <ViewsMenu state={views} onChange={changeViews} builtIns={presets} allColumns={allColumns} columnIds={columnIds} />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => pull(false)} title={`Sync from store · last ${info?.last_pull ? new Date(info.last_pull * 1000).toLocaleTimeString() : "never"}`}>Sync</Button>
        <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} disabled={!summary.can_undo} onClick={undo} title="Undo last change (⌘Z)" data-testid="undo">Undo</Button>
        <span className="flex-1" />
        <Button size="sm" icon={<Download size={14} />} onClick={() => openDialog("export")} title="Export to Excel or CSV" data-testid="open-export">Export{selection.length ? ` (${selection.length})` : ""}</Button>
        <Button size="sm" icon={<FileUp size={14} />} onClick={() => openDialog("import")} data-testid="open-import">Import</Button>
        <Button size="sm" icon={<Sparkles size={14} />} onClick={() => openDialog("mass-change")} data-testid="open-mass-change">Bulk edit{selection.length ? ` (${selection.length})` : ""}</Button>
        <Button size="sm" icon={<Copy size={14} />} disabled={!selection.length} title={selection.length ? "Copy the ticked products to another store" : "Tick products to clone them"} onClick={async () => {
          const ids = selection.map(Number).filter((n) => n > 0);
          if (ids.length) openDialog("clone", ids);
        }}>Clone to…</Button>
        <Button size="sm" variant="close" icon={<Trash2 size={14} />} disabled={!selection.length} title={selection.length ? "Delete the ticked products (on your next push)" : "Tick products to delete them"} onClick={() => remove("product", selection)} data-testid="delete-selected">Delete</Button>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} data-testid="new-product" onClick={async () => {
          const [k] = await create([{ entity: "product", fields: { name: "New product", type: "simple", status: "draft" } }]);
          openDrawer(k);
        }}>New</Button>
      </div>
      <div className={clsx("flex min-h-0 flex-1", panelDock === "bottom" && "flex-col")}>
        <div className="min-h-0 min-w-0 flex-1">
          <ProductGrid columns={columns} onColumnMoved={(from, to) => changeViews(setViewColumns(views, moveColumn(columnIds, from, to)))} />
        </div>
        <EditPanel />
      </div>
    </div>
  );
}
