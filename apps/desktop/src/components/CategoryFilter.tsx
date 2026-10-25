import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CategoryRow } from "../backend/types";
import { useApp } from "../store/app";
import { categoryTree } from "./fields";
import { clsx } from "./ui";

/**
 * "Select categories" box in the products toolbar. Shows the category tree with product counts,
 * filters as you type, and filters the grid (a parent includes its sub-categories). It shares
 * its choice with the category tree in the sidebar.
 */
export function CategoryFilter() {
  const { taxonomy, query, setQuery } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cats = useMemo(() => (taxonomy?.categories ?? []).filter((c) => !c._state.deleted && !c._state.is_new), [taxonomy]);
  const { keyOf, children } = useMemo(() => categoryTree(cats), [cats]);

  // Flattened tree (depth-first) with totals that include sub-categories.
  const flat = useMemo(() => {
    const out: { c: CategoryRow; depth: number; total: number; path: string }[] = [];
    const walk = (c: CategoryRow, depth: number, path: string): number => {
      const i = out.length;
      out.push({ c, depth, total: 0, path: path ? `${path} › ${c.name}` : c.name });
      const sum = (c.count ?? 0) + (children.get(keyOf(c)) ?? []).reduce((s, x) => s + walk(x, depth + 1, out[i].path), 0);
      out[i].total = sum;
      return sum;
    };
    (children.get("0") ?? []).forEach((c) => walk(c, 0, ""));
    return out;
  }, [children, keyOf]);

  const term = q.trim().toLowerCase();
  const options = [
    ...(term ? [] : [{ id: "all", label: "All categories", depth: 0, total: undefined as number | undefined }, { id: "none", label: "Uncategorized", depth: 0, total: undefined }]),
    ...flat.filter((x) => !term || x.c.name.toLowerCase().includes(term)).map((x) => ({ id: String(x.c.id), label: term ? x.path : x.c.name, depth: term ? 0 : x.depth, total: x.total as number | undefined })),
  ];
  const current = query.uncategorized ? "none" : query.category_id ? String(query.category_id) : "all";
  const currentLabel = current === "all" ? "All categories" : current === "none" ? "Uncategorized" : flat.find((x) => String(x.c.id) === current)?.c.name ?? "Category";

  const pick = (id: string) => {
    setQuery(id === "all" ? { category_id: null, uncategorized: false } : id === "none" ? { category_id: null, uncategorized: true } : { category_id: Number(id), uncategorized: false });
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return setQ("");
    setActive(Math.max(0, options.findIndex((o) => o.id === current)));
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={clsx("flex h-8 w-48 items-center gap-1.5 rounded-md border bg-panel px-2 text-left text-[13px]", current !== "all" ? "border-accent text-accent" : "border-line")}
        aria-label="Category filter"
        aria-expanded={open}
        data-testid="category-filter"
      >
        <span className="min-w-0 flex-1 truncate">{current === "all" ? "Select categories" : currentLabel}</span>
        {current !== "all" ? (
          <span role="button" tabIndex={-1} onClick={(e) => (e.stopPropagation(), pick("all"))} className="rounded p-0.5 hover:bg-accent/10" aria-label="Clear category filter"><X size={13} /></span>
        ) : (
          <ChevronDown size={14} className="text-muted" />
        )}
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-80 rounded-lg border border-line bg-panel shadow-xl" data-testid="category-filter-menu">
          <div className="flex items-center gap-2 border-b border-line px-2">
            <Search size={13} className="text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setActive((a) => Math.min(options.length - 1, a + 1));
                else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
                else if (e.key === "Enter" && options[active]) pick(options[active].id);
                else if (e.key === "Escape") setOpen(false);
                else return;
                e.preventDefault();
              }}
              placeholder="Find a category"
              className="h-9 flex-1 bg-transparent text-[13px] focus:outline-none"
              aria-label="Find a category"
            />
          </div>
          <div ref={listRef} className="max-h-80 overflow-auto p-1" role="listbox">
            {options.map((o, i) => (
              <button
                key={o.id}
                data-index={i}
                role="option"
                aria-selected={o.id === current}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.id)}
                className={clsx("flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px]", i === active && "bg-sunken", o.id === current && "font-semibold text-accent", o.depth === 0 && o.total !== undefined && !term && "font-medium")}
                style={{ paddingLeft: 8 + o.depth * 14 }}
              >
                <span className="w-3.5 shrink-0">{o.id === current && <Check size={13} />}</span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.total !== undefined && <span className="text-2xs tabular-nums text-muted">{o.total.toLocaleString()}</span>}
              </button>
            ))}
            {options.length === 0 && <div className="px-3 py-2 text-[13px] text-muted">No category matches “{q}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
