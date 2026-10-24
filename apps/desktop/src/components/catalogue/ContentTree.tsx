import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { CatCategory, CatProduct } from "../../lib/catalogue/plan";
import { descendants } from "../../lib/catalogue/plan";
import { clsx, Input } from "../ui";

interface Props {
  categories: CatCategory[];
  products: CatProduct[];
  excludedCategories: number[];
  excludedProducts: number[];
  onChange: (next: { excludedCategories: number[]; excludedProducts: number[] }) => void;
  formatPrice: (p: CatProduct) => string;
}

/**
 * Parent categories, sub-categories and products, each with a "leave out" tick box. Ticking a
 * category leaves out everything inside it.
 */
export function ContentTree({ categories, products, excludedCategories, excludedProducts, onChange, formatPrice }: Props) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const exCats = useMemo(() => new Set(excludedCategories), [excludedCategories]);
  const exProds = useMemo(() => new Set(excludedProducts), [excludedProducts]);
  const kids = useMemo(() => {
    const m = new Map<number, CatCategory[]>();
    const ids = new Set(categories.map((c) => c.id));
    for (const c of categories) {
      const parent = ids.has(c.parent) ? c.parent : 0;
      m.set(parent, [...(m.get(parent) ?? []), c]);
    }
    for (const list of m.values()) list.sort((a, b) => a.menuOrder - b.menuOrder || a.name.localeCompare(b.name));
    return m;
  }, [categories]);
  const byCat = useMemo(() => {
    const m = new Map<number, CatProduct[]>();
    for (const p of products) for (const c of p.categoryIds) m.set(c, [...(m.get(c) ?? []), p]);
    return m;
  }, [products]);
  // A category is out when it or any ancestor is ticked.
  const outCats = useMemo(() => {
    const s = new Set<number>();
    for (const id of excludedCategories) for (const x of descendants(categories, id)) s.add(x);
    return s;
  }, [excludedCategories, categories]);
  const subtree = useMemo(() => {
    const memo = new Map<number, { total: number; included: number }>();
    const walk = (c: CatCategory): { total: number; included: number } => {
      const own = byCat.get(c.id) ?? [];
      const r = { total: own.length, included: outCats.has(c.id) ? 0 : own.filter((p) => !exProds.has(p.id)).length };
      for (const k of kids.get(c.id) ?? []) {
        const x = walk(k);
        r.total += x.total;
        r.included += x.included;
      }
      memo.set(c.id, r);
      return r;
    };
    for (const c of kids.get(0) ?? []) walk(c);
    return memo;
  }, [kids, byCat, outCats, exProds]);

  const toggleCat = (id: number) => onChange({ excludedCategories: exCats.has(id) ? excludedCategories.filter((x) => x !== id) : [...excludedCategories, id], excludedProducts });
  const toggleProd = (id: number) => onChange({ excludedCategories, excludedProducts: exProds.has(id) ? excludedProducts.filter((x) => x !== id) : [...excludedProducts, id] });

  const productRow = (p: CatProduct, depth: number, inherited: boolean, path?: string) => {
    const out = inherited || exProds.has(p.id);
    return (
      <label key={`${p.id}-${depth}-${path ?? ""}`} className={clsx("flex items-center gap-2 py-1 pr-2 text-[12.5px] hover:bg-sunken", out && "text-muted")} style={{ paddingLeft: 8 + depth * 16 + 18 }}>
        <input type="checkbox" checked={out} disabled={inherited} onChange={() => toggleProd(p.id)} aria-label={`Leave out ${p.name}`} data-testid={`cat-ex-product-${p.id}`} />
        <span className={clsx("min-w-0 flex-1 truncate", out && "line-through")}>{p.name}</span>
        {path && <span className="max-w-[120px] truncate text-2xs text-muted">{path}</span>}
        <span className="text-2xs text-muted">{p.sku}</span>
        <span className="w-16 text-right text-2xs tabular-nums text-muted">{formatPrice(p)}</span>
      </label>
    );
  };

  const catRow = (c: CatCategory, depth: number): JSX.Element => {
    const inherited = outCats.has(c.id) && !exCats.has(c.id);
    const out = outCats.has(c.id);
    const isOpen = open.has(c.id);
    const counts = subtree.get(c.id) ?? { total: 0, included: 0 };
    const children = kids.get(c.id) ?? [];
    const own = byCat.get(c.id) ?? [];
    return (
      <div key={c.id}>
        <div className={clsx("flex items-center gap-1.5 py-1 pr-2 hover:bg-sunken", out && "text-muted")} style={{ paddingLeft: 4 + depth * 16 }}>
          <button type="button" className={clsx("rounded p-0.5 text-muted", !(children.length || own.length) && "invisible")} onClick={() => setOpen((s) => {
            const n = new Set(s);
            if (n.has(c.id)) n.delete(c.id);
            else n.add(c.id);
            return n;
          })} aria-label={isOpen ? `Collapse ${c.name}` : `Expand ${c.name}`}>
            <ChevronRight size={13} className={clsx("transition-transform", isOpen && "rotate-90")} />
          </button>
          <input type="checkbox" checked={out} disabled={inherited} onChange={() => toggleCat(c.id)} aria-label={`Leave out ${c.name}`} data-testid={`cat-ex-category-${c.id}`} />
          <span className={clsx("min-w-0 flex-1 truncate text-[13px]", depth === 0 && "font-medium", out && "line-through")}>{c.name}</span>
          <span className="text-2xs tabular-nums text-muted" title="Products included / in this category">{counts.included}/{counts.total}</span>
        </div>
        {isOpen && (
          <>
            {children.map((k) => catRow(k, depth + 1))}
            {own.map((p) => productRow(p, depth + 1, out))}
          </>
        )}
      </div>
    );
  };

  const q = search.trim().toLowerCase();
  const names = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const hits = q ? products.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(q)).slice(0, 200) : [];
  const leftOut = products.filter((p) => exProds.has(p.id) || (p.categoryIds.length > 0 && p.categoryIds.every((c) => outCats.has(c)))).length;

  return (
    <div className="space-y-2" data-testid="content-tree">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">Tick anything to <b>leave it out</b> of the catalogue.</span>
        {(excludedCategories.length > 0 || excludedProducts.length > 0) && (
          <button className="text-accent hover:underline" onClick={() => onChange({ excludedCategories: [], excludedProducts: [] })}>Include everything</button>
        )}
      </div>
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a product to leave out" className="pl-7" data-testid="cat-search" />
      </div>
      <div className="max-h-[52vh] overflow-auto rounded-md border border-line">
        {q ? (
          hits.length ? hits.map((p) => productRow(p, 0, p.categoryIds.length > 0 && p.categoryIds.every((c) => outCats.has(c)), p.categoryIds.map((c) => names.get(c)).filter(Boolean).join(", "))) : <div className="p-3 text-xs text-muted">No products match.</div>
        ) : (
          (kids.get(0) ?? []).map((c) => catRow(c, 0))
        )}
      </div>
      <div className="text-xs text-muted" data-testid="content-summary">{leftOut ? `${leftOut.toLocaleString()} product${leftOut === 1 ? "" : "s"} left out` : "Nothing left out"} · numbers show products included / total in each category</div>
    </div>
  );
}
