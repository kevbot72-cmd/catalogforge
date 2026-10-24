import { ChevronDown, ChevronRight, Search, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type InputHTMLAttributes } from "react";
import type { CategoryRow, LocalFile, Media, MediaRef, MediaValue } from "../backend/types";
import { ancestorKeys, assignCategory, categoryPath } from "../lib/categoryAssign";
import { useApp } from "../store/app";
import { clsx, Dropzone, Input, mediaUrl, TextArea, Thumb } from "./ui";

/** Input that commits on blur/Enter instead of on every keystroke (one undo step per edit). */
export function BufferedInput({ value, onCommit, multiline, ...rest }: { value: string; onCommit: (v: string) => void; multiline?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  if (multiline)
    return <TextArea value={v} rows={3} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={rest.placeholder} className={rest.className} data-testid={(rest as Record<string, unknown>)["data-testid"] as string} />;
  return (
    <Input
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
    />
  );
}

export function TagInput({ value, onChange, suggestions = [], placeholder, label }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; placeholder?: string; label?: string }) {
  const [text, setText] = useState("");
  const add = (t: string) => {
    const tags = t.split(",").map((s) => s.trim()).filter(Boolean);
    const next = [...value];
    for (const x of tags) if (!next.some((y) => y.toLowerCase() === x.toLowerCase())) next.push(x);
    if (next.length !== value.length) onChange(next);
    setText("");
  };
  const matches = text ? suggestions.filter((s) => s.toLowerCase().includes(text.toLowerCase()) && !value.includes(s)).slice(0, 6) : [];
  return (
    <div className="relative">
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-1 focus-within:border-accent">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded bg-sunken px-1.5 py-0.5 text-xs">
            {t}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-muted hover:text-fg" aria-label={`Remove ${t}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className="min-w-[80px] flex-1 bg-transparent text-[13px] focus:outline-none"
          aria-label={label ?? placeholder}
          value={text}
          placeholder={value.length ? "" : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && text.trim()) {
              e.preventDefault();
              add(text);
            }
            if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {matches.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-line bg-panel py-1 shadow-lg">
          {matches.map((m) => (
            <button type="button" key={m} onMouseDown={(e) => e.preventDefault()} onClick={() => add(m)} className="block w-full px-2 py-1 text-left text-[13px] hover:bg-sunken">
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function categoryTree(cats: CategoryRow[]) {
  const keyOf = (c: CategoryRow) => (c._state.is_new ? c._state.key : String(c.id));
  const children = new Map<string, CategoryRow[]>();
  for (const c of cats) {
    const p = String(c.parent ?? 0);
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(c);
  }
  for (const list of children.values()) list.sort((a, b) => (a.menu_order ?? 0) - (b.menu_order ?? 0) || a.name.localeCompare(b.name));
  return { keyOf, children };
}

/**
 * Category checklist with search, used in the product drawer and the mass changer. Parents and
 * sub-categories each have their own box; chosen categories are listed as full paths above.
 */
export function CategoryPicker({ categories, value, onChange }: { categories: CategoryRow[]; value: (number | string)[]; onChange: (v: (number | string)[]) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const withParents = useApp((s) => s.catWithParents);
  const setWithParents = useApp((s) => s.setCatWithParents);
  const cats = useMemo(() => categories.filter((c) => !c._state.deleted), [categories]);
  const { keyOf, children } = useMemo(() => categoryTree(cats), [cats]);
  const selected = new Set(value.map(String));
  // Parents of ticked categories open automatically and show how many ticked categories they hold.
  const inside = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of value.map(String)) for (const a of ancestorKeys(cats, k)) m.set(a, (m.get(a) ?? 0) + 1);
    return m;
  }, [value, cats]);
  const toggle = (c: CategoryRow) => onChange(assignCategory(value, cats, c, !selected.has(keyOf(c)), withParents));
  const matches = q ? cats.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : null;
  const renderNode = (c: CategoryRow, depth: number): JSX.Element => {
    const k = keyOf(c);
    const kids = children.get(k) ?? [];
    const isOpen = open.has(k) ? true : open.has(`-${k}`) ? false : inside.has(k);
    return (
      <div key={k}>
        <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-sunken" style={{ paddingLeft: depth * 16 + 4 }}>
          {kids.length ? (
            <button type="button" className="text-muted" aria-label={isOpen ? `Collapse ${c.name}` : `Expand ${c.name}`} onClick={() => setOpen((s) => {
              const n = new Set([...s].filter((x) => x !== k && x !== `-${k}`));
              n.add(isOpen ? `-${k}` : k);
              return n;
            })}>
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="w-[13px]" />
          )}
          <label className="flex flex-1 cursor-pointer items-center gap-2 text-[13px]">
            <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(c)} className="accent-[rgb(var(--accent))]" aria-label={c.name} data-testid={`catpick-${c.name}`} />
            <span className={clsx(depth === 0 && "font-medium")}>{c.name}</span>
            {c._state.is_new && <span className="text-2xs text-added">new</span>}
            {!selected.has(k) && inside.has(k) && <span className="text-2xs text-accent" title="A sub-category is ticked, but not this category itself">{inside.get(k)} ticked inside</span>}
          </label>
        </div>
        {isOpen && kids.map((x) => renderNode(x, depth + 1))}
      </div>
    );
  };
  const byKey = new Map(cats.map((c) => [keyOf(c), c]));
  return (
    <div className="rounded-md border border-line" data-testid="category-picker">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-line p-2" data-testid="category-chips">
          {value.map((v) => {
            const c = byKey.get(String(v));
            return (
              <span key={String(v)} className="flex items-center gap-1 rounded-full bg-accent/10 py-0.5 pl-2 pr-1 text-xs text-accent">
                {c ? categoryPath(cats, String(v)) : `#${v}`}
                <button type="button" onClick={() => onChange(value.filter((x) => String(x) !== String(v)))} aria-label={`Remove ${c?.name ?? v}`} className="rounded-full p-0.5 hover:bg-accent/20"><X size={11} /></button>
              </span>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-line px-2">
        <Search size={13} className="text-muted" />
        <input className="h-8 flex-1 bg-transparent text-[13px] focus:outline-none" placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-64 overflow-auto p-1">
        {matches
          ? matches.map((c) => (
              <label key={keyOf(c)} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-sunken">
                <input type="checkbox" checked={selected.has(keyOf(c))} onChange={() => toggle(c)} />
                {categoryPath(cats, keyOf(c))}
              </label>
            ))
          : (children.get("0") ?? []).map((c) => renderNode(c, 0))}
      </div>
      <label className="flex items-center gap-2 border-t border-line px-2 py-1.5 text-xs text-muted">
        <input type="checkbox" checked={withParents} onChange={(e) => setWithParents(e.target.checked)} data-testid="cat-with-parents" />
        Ticking a sub-category also ticks its parent categories
      </label>
    </div>
  );
}

const refKey = (v: MediaValue) => (typeof v === "number" ? `id:${v}` : `ref:${v.file ?? v.url}`);

/** Featured image + gallery with drag-to-reorder, drop/pick files and library picks. */
export function GalleryEditor({ image, gallery, media, onChange, toFiles, pickFiles, onPickLibrary, onAltChange }: {
  image: MediaValue;
  gallery: MediaValue[];
  media: Map<number, Media>;
  onChange: (image: MediaValue, gallery: MediaValue[]) => void;
  toFiles: (f: File[]) => Promise<LocalFile[]>;
  pickFiles: () => Promise<LocalFile[]>;
  onPickLibrary: () => void;
  onAltChange: (id: number, alt: string) => void;
}) {
  const all: MediaValue[] = [...(image ? [image] : []), ...gallery];
  const [drag, setDrag] = useState<number | null>(null);
  const set = (list: MediaValue[]) => onChange(list[0] ?? 0, list.slice(1));
  const addFiles = (files: LocalFile[]) => {
    const imgs = files.filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name));
    const refs: MediaRef[] = imgs.map((f) => ({ file: f.path, preview: f.url }));
    const seen = new Set(all.map(refKey));
    set([...all, ...refs.filter((r) => !seen.has(refKey(r)))]);
  };
  return (
    <Dropzone toFiles={toFiles} onFiles={addFiles} className="rounded-lg" testId="gallery-drop">
      <div className="grid grid-cols-4 gap-2">
        {all.map((m, i) => {
          const url = mediaUrl(m, media, "medium");
          const lib = typeof m === "number" ? media.get(m) : undefined;
          return (
            <div
              key={refKey(m) + i}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                if (drag === null) return;
                e.preventDefault();
                const next = [...all];
                const [x] = next.splice(drag, 1);
                next.splice(i, 0, x);
                set(next);
                setDrag(null);
              }}
              className={clsx("group relative overflow-hidden rounded-lg border bg-sunken", i === 0 ? "col-span-2 row-span-2 border-accent" : "border-line", drag === i && "opacity-40")}
            >
              <div className="aspect-square">{url ? <img src={url} alt={lib?.alt ?? ""} className="h-full w-full object-cover" draggable={false} /> : null}</div>
              {i === 0 && <span className="absolute left-1.5 top-1.5 rounded bg-accent px-1.5 py-0.5 text-2xs font-medium text-white">Featured</span>}
              {typeof m !== "number" && <span className="absolute bottom-1.5 left-1.5 rounded bg-changed px-1.5 py-0.5 text-2xs font-medium text-black">Upload on push</span>}
              <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
                {i > 0 && (
                  <button type="button" title="Make featured" onClick={() => set([m, ...all.filter((_, j) => j !== i)])} className="rounded bg-black/60 p-1 text-white">
                    <Star size={12} />
                  </button>
                )}
                <button type="button" title="Remove" onClick={() => set(all.filter((_, j) => j !== i))} className="rounded bg-black/60 p-1 text-white">
                  <Trash2 size={12} />
                </button>
              </div>
              {lib && i === 0 && (
                <input
                  className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-2xs text-white placeholder:text-white/60 focus:outline-none"
                  defaultValue={lib.alt}
                  placeholder="Alt text"
                  onBlur={(e) => e.target.value !== lib.alt && onAltChange(lib.id, e.target.value)}
                />
              )}
            </div>
          );
        })}
        <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line p-2 text-center text-2xs text-muted">
          <span>Drop images</span>
          <button type="button" className="text-accent hover:underline" onClick={async () => addFiles(await pickFiles())}>
            Browse…
          </button>
          <button type="button" className="text-accent hover:underline" onClick={onPickLibrary}>
            Media library
          </button>
        </div>
      </div>
      <p className="mt-2 text-2xs text-muted">Drag to reorder — the first image is the featured image. New images are resized, converted to WebP and given every WordPress size on your computer when you push.</p>
    </Dropzone>
  );
}

export function LibraryPicker({ media, onPick }: { media: Media[]; onPick: (m: Media) => void }) {
  const [q, setQ] = useState("");
  const list = media.filter((m) => !q || `${m.filename} ${m.alt} ${m.title}`.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  return (
    <div>
      <Input placeholder="Search media" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <div className="grid grid-cols-6 gap-2">
        {list.map((m) => (
          <button key={m.id} type="button" onClick={() => onPick(m)} className="overflow-hidden rounded border border-line hover:border-accent" title={m.filename}>
            <Thumb src={m.thumb_url || m.url} size={96} className="h-auto w-full" />
          </button>
        ))}
      </div>
    </div>
  );
}
