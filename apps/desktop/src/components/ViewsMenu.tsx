import { Check, Columns3, GripVertical, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { addView, deleteView, isUserView, moveColumn, renameView, resetBuiltIn, setViewColumns, viewName, type ViewState } from "../lib/views";
import type { ColumnDef } from "./ProductGrid";
import { Button, clsx } from "./ui";

/** Name box used for both "New view" and "Rename": Enter saves, Esc cancels. */
function NameInput({ initial, onSave, onCancel, testId }: { initial: string; onSave: (name: string) => void; onCancel: () => void; testId?: string }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="flex items-center gap-1">
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) onSave(v.trim());
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        className="h-7 min-w-0 flex-1 rounded-md border border-accent bg-panel px-2 text-[13px] focus:outline-none"
        aria-label="View name"
        data-testid={testId}
      />
      <button onClick={() => v.trim() && onSave(v.trim())} className="rounded-md bg-accent p-1.5 text-white disabled:opacity-50" disabled={!v.trim()} aria-label="Save name"><Check size={13} /></button>
    </div>
  );
}

/**
 * The views button on the products page: pick a saved view, add a new one from the current
 * columns, rename or delete your own views, reset a changed built-in view, and choose or
 * reorder columns. Everything is saved straight away and kept when CatalogForge closes.
 */
export function ViewsMenu({ state, onChange, builtIns, allColumns, columnIds }: {
  state: ViewState;
  onChange: (s: ViewState) => void;
  builtIns: Record<string, string[]>;
  allColumns: ColumnDef[];
  columnIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      setAdding(false);
      setRenaming(null);
    }
  }, [open]);

  const rows = [...Object.keys(builtIns).map((id) => ({ id, name: id, own: false })), ...state.views.map((v) => ({ id: v.id, name: v.name, own: true }))];
  const shown = columnIds.map((id) => allColumns.find((c) => c.id === id)).filter((c): c is ColumnDef => !!c);
  const hidden = allColumns.filter((c) => !columnIds.includes(c.id));
  const label = (c: ColumnDef) => c.title || (c.id === "image_id" ? "Picture" : c.id);

  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="ghost" icon={<Columns3 size={14} />} onClick={() => setOpen(!open)} data-testid="views-button" title="Saved views and columns">
        {viewName(state)}
      </Button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-80 rounded-lg border border-line bg-panel p-2 shadow-xl" data-testid="views-menu">
          <div className="mb-1 px-1 text-2xs font-semibold uppercase text-muted">Views</div>
          <div className="space-y-px">
            {rows.map((r) =>
              renaming === r.id ? (
                <NameInput key={r.id} initial={r.name} testId="view-rename-input" onCancel={() => setRenaming(null)} onSave={(n) => (onChange(renameView(state, builtIns, r.id, n)), setRenaming(null))} />
              ) : (
                <div key={r.id} className={clsx("group flex items-center gap-1 rounded-md pr-1", state.active === r.id ? "bg-accent/10" : "hover:bg-sunken")}>
                  <button onClick={() => onChange({ ...state, active: r.id })} className={clsx("min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[13px]", state.active === r.id && "font-semibold text-accent")}>
                    {r.name}
                  </button>
                  {!r.own && state.overrides[r.id] && (
                    <>
                      <span className="text-2xs text-muted">changed</span>
                      <button onClick={() => onChange(resetBuiltIn(state, r.id))} className="rounded p-1 text-muted hover:bg-panel hover:text-fg" title={`Put ${r.name} back how it was`} aria-label={`Reset ${r.name}`}><RotateCcw size={12} /></button>
                    </>
                  )}
                  {r.own && (
                    <>
                      <button onClick={() => setRenaming(r.id)} className="rounded p-1 text-muted opacity-60 hover:bg-panel hover:text-fg group-hover:opacity-100" title="Rename" aria-label={`Rename ${r.name}`}><Pencil size={12} /></button>
                      <button onClick={() => window.confirm(`Delete the view “${r.name}”? Your products aren't affected.`) && onChange(deleteView(state, r.id))} className="cf-close rounded p-1 opacity-60 group-hover:opacity-100" title="Delete view" aria-label={`Delete ${r.name}`}><Trash2 size={12} /></button>
                    </>
                  )}
                </div>
              ),
            )}
          </div>
          <div className="mt-1 border-t border-line pt-1">
            {adding ? (
              <NameInput initial="My view" testId="view-new-input" onCancel={() => setAdding(false)} onSave={(n) => (onChange(addView(state, builtIns, n, columnIds)), setAdding(false))} />
            ) : (
              <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-accent hover:bg-sunken" data-testid="view-new">
                <Plus size={13} /> New view from these columns
              </button>
            )}
          </div>

          <div className="mb-1 mt-2 flex items-baseline justify-between px-1">
            <span className="text-2xs font-semibold uppercase text-muted">Columns in {viewName(state)}</span>
            <span className="text-2xs text-muted">drag to reorder</span>
          </div>
          <div className="max-h-72 overflow-auto" data-testid="views-columns">
            {shown.map((c, i) => (
              <div key={c.id}>
                {drag && drag.over === i && drag.from > i && <div className="mx-1 h-0.5 rounded bg-accent" />}
                <label
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDrag({ from: i, over: i });
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (drag && drag.over !== i) setDrag({ ...drag, over: i });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag) onChange(setViewColumns(state, moveColumn(columnIds, columnIds.indexOf(shown[drag.from].id), columnIds.indexOf(c.id))));
                    setDrag(null);
                  }}
                  onDragEnd={() => setDrag(null)}
                  className={clsx("flex cursor-grab items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-sunken", drag?.from === i && "opacity-40")}
                >
                  <GripVertical size={12} className="text-muted" />
                  <input type="checkbox" checked onChange={() => onChange(setViewColumns(state, columnIds.filter((x) => x !== c.id)))} />
                  {label(c)}
                </label>
                {drag && drag.over === i && drag.from < i && <div className="mx-1 h-0.5 rounded bg-accent" />}
              </div>
            ))}
            {hidden.length > 0 && <div className="mt-1 border-t border-line pt-1" />}
            {hidden.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-1 py-0.5 pl-6 text-[13px] text-muted hover:bg-sunken">
                <input type="checkbox" checked={false} onChange={() => onChange(setViewColumns(state, [...columnIds, c.id]))} />
                {label(c)}
              </label>
            ))}
          </div>
          <p className="mt-1.5 px-1 text-2xs text-muted">Changes save into the open view{isUserView(state.active) ? "" : " (Reset puts a built-in view back)"}. You can also drag a column's header in the grid.</p>
        </div>
      )}
    </div>
  );
}
