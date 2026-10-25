import { ChevronDown, ChevronRight, FolderPlus, GripVertical, ImagePlus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { CategoryRow, Edit, LocalFile, MediaValue } from "../backend/types";
import { BufferedInput, categoryTree } from "../components/fields";
import { CategoryProducts } from "../components/CategoryProducts";
import { RichTextEditor } from "../components/RichTextEditor";
import { Badge, Button, clsx, Dropzone, Empty, Field, Input, mediaUrl, Select } from "../components/ui";
import { useApp } from "../store/app";

function ImageSlot({ label, value, onChange }: { label: string; value: MediaValue; onChange: (v: MediaValue) => void }) {
  const { backend, media } = useApp();
  const url = mediaUrl(value, media, "medium");
  const take = (files: LocalFile[]) => {
    const f = files.find((x) => /\.(jpe?g|png|webp|gif|avif)$/i.test(x.name));
    if (f) onChange({ file: f.path, preview: f.url });
  };
  return (
    <Field label={label}>
      <Dropzone toFiles={backend.filesFromDrop} onFiles={take} className="rounded-lg">
        <div className="group relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg border border-dashed border-line bg-sunken">
          {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : (
            <div className="flex flex-col items-center gap-1 text-xs text-muted"><ImagePlus size={18} /> Drop an image</div>
          )}
          <div className="absolute inset-x-0 bottom-0 hidden justify-center gap-2 bg-black/50 p-1.5 group-hover:flex">
            <button className="text-xs text-white" onClick={async () => take(await backend.pickFiles({ multiple: false, extensions: ["jpg", "jpeg", "png", "webp"] }))}>Browse…</button>
            {!!value && <button className="text-xs text-white" onClick={() => onChange(0)}>Remove</button>}
          </div>
          {!!value && typeof value !== "number" && <span className="absolute left-1.5 top-1.5 rounded bg-changed px-1.5 py-0.5 text-2xs font-medium text-black">Upload on push</span>}
        </div>
      </Dropzone>
    </Field>
  );
}

export function CategoriesView() {
  const { taxonomy, stage, create, remove, setView, setQuery } = useApp();
  const cats = useMemo(() => taxonomy?.categories ?? [], [taxonomy]);
  const { keyOf, children } = useMemo(() => categoryTree(cats), [cats]);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const byKey = useMemo(() => new Map(cats.map((c) => [keyOf(c), c])), [cats, keyOf]);
  const cat = selected ? byKey.get(selected) : undefined;

  const isDescendant = (maybeChild: string, ancestor: string): boolean => {
    let cur = byKey.get(maybeChild);
    let guard = 0;
    while (cur && guard++ < 64) {
      const p = String(cur.parent ?? 0);
      if (p === ancestor) return true;
      cur = byKey.get(p);
    }
    return false;
  };
  const move = (key: string, parent: string) => {
    if (key === parent || isDescendant(parent, key)) return;
    const target: number | string = parent === "0" ? 0 : byKey.get(parent)?._state.is_new ? parent : Number(parent);
    stage([{ entity: "category", key, field: "parent", value: target }]);
    if (parent !== "0") setOpen((s) => new Set([...s, parent]));
  };
  const reorder = (key: string, beforeKey: string) => {
    const before = byKey.get(beforeKey);
    if (!before) return;
    const parent = String(before.parent ?? 0);
    const siblings = (children.get(parent) ?? []).filter((c) => keyOf(c) !== key);
    const idx = siblings.findIndex((c) => keyOf(c) === beforeKey);
    siblings.splice(idx, 0, byKey.get(key)!);
    const edits: Edit[] = siblings.map((c, i) => ({ entity: "category", key: keyOf(c), field: "menu_order", value: i }));
    if (String(byKey.get(key)!.parent ?? 0) !== parent) edits.push({ entity: "category", key, field: "parent", value: parent === "0" ? 0 : Number(parent) });
    stage(edits);
  };
  const addCategory = async (parent: CategoryRow | null) => {
    const name = window.prompt(parent ? `New subcategory of ${parent.name}` : "New category name");
    if (!name) return;
    const [k] = await create([{ entity: "category", fields: { name, parent: parent ? (parent._state.is_new ? keyOf(parent) : parent.id) : 0 } }]);
    setSelected(k);
    if (parent) setOpen((s) => new Set([...s, keyOf(parent)]));
  };

  const set = (field: string, value: unknown) => cat && stage([{ entity: "category", key: keyOf(cat), field, value }]);

  // A render function (not a nested component) so re-renders never remount the dragged row.
  const renderNode = (c: CategoryRow, depth: number): JSX.Element => {
    const k = keyOf(c);
    const kids = children.get(k) ?? [];
    const isOpen = open.has(k) || !!q;
    return (
      <div key={k}>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", k);
            setDrag(k);
          }}
          onDragEnd={() => (setDrag(null), setOver(null))}
          onDragOver={(e) => {
            if (!drag || drag === k) return;
            e.preventDefault();
            setOver(k);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (drag) e.altKey ? reorder(drag, k) : move(drag, k);
            setDrag(null);
            setOver(null);
          }}
          onClick={() => setSelected(k)}
          className={clsx("group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-[13px]", selected === k ? "bg-accent/10 text-accent" : "hover:bg-sunken", over === k && "ring-1 ring-accent", c._state.deleted && "line-through opacity-50")}
          style={{ paddingLeft: depth * 18 + 4 }}
          data-testid={`cat-${c.name}`}
        >
          <GripVertical size={12} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
          <button className="w-4 text-muted" onClick={(e) => (e.stopPropagation(), setOpen((s) => new Set(s.has(k) ? [...s].filter((x) => x !== k) : [...s, k])))}>
            {kids.length ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
          </button>
          <span className="flex-1 truncate">{c.name}</span>
          {c._state.is_new && <Badge tone="added">new</Badge>}
          {!c._state.is_new && c._state.dirty.length > 0 && <Badge tone="changed">edited</Badge>}
          <span className="text-2xs text-muted">{c.count || ""}</span>
          <button className="hidden text-muted hover:text-accent group-hover:block" title="Add subcategory" onClick={(e) => (e.stopPropagation(), addCategory(c))}><FolderPlus size={13} /></button>
        </div>
        {isOpen && kids.map((x) => renderNode(x, depth + 1))}
      </div>
    );
  };

  const roots = q ? cats.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : children.get("0") ?? [];
  return (
    <div className="flex h-full min-w-0">
      <div className="flex w-[380px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line p-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2 top-2.5 text-muted" />
            <Input className="pl-7" placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button size="sm" variant="primary" icon={<FolderPlus size={14} />} onClick={() => addCategory(null)} data-testid="add-category">Add</Button>
        </div>
        <div
          className={clsx("min-h-0 flex-1 overflow-auto p-2", over === "0" && "bg-accent/5")}
          onDragOver={(e) => {
            if (drag) {
              e.preventDefault();
              if (e.target === e.currentTarget) setOver("0");
            }
          }}
          onDrop={(e) => {
            if (drag && e.target === e.currentTarget) move(drag, "0");
            setDrag(null);
            setOver(null);
          }}
        >
          {roots.map((c) => renderNode(c, 0))}
          <div className="mt-3 px-2 text-2xs text-muted">Drag a category onto another to nest it, onto empty space to make it top-level. Hold Alt while dropping to reorder instead.</div>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {!cat ? (
          <Empty title="Select a category">Edit names, hierarchy, descriptions, thumbnails, banners and SEO. Every change is staged and pushed together with your product edits.</Empty>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-6" data-testid="category-editor">
            <div className="flex items-center gap-2">
              <h2 className="flex-1 text-lg font-semibold">{cat.name}</h2>
              <Button size="sm" onClick={() => (setQuery({ category_id: typeof cat.id === "number" && cat.id > 0 ? cat.id : null }), setView("products"))}>View products</Button>
              <Button size="sm" variant="close" icon={<Trash2 size={14} />} onClick={() => (remove("category", [keyOf(cat)]), setSelected(null))}>Delete</Button>
            </div>
            <CategoryProducts cat={cat} />
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name" changed={cat._state.dirty.includes("name")}><BufferedInput value={cat.name} onCommit={(v) => set("name", v)} data-testid="category-name" /></Field>
              <Field label="Slug" changed={cat._state.dirty.includes("slug")}><BufferedInput value={cat.slug} onCommit={(v) => set("slug", v)} /></Field>
              <Field label="Parent" changed={cat._state.dirty.includes("parent")}>
                <Select value={String(cat.parent ?? 0)} onChange={(e) => move(keyOf(cat), e.target.value)}>
                  <option value="0">None (top level)</option>
                  {cats.filter((c) => keyOf(c) !== keyOf(cat) && !isDescendant(keyOf(c), keyOf(cat))).map((c) => <option key={keyOf(c)} value={keyOf(c)}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Display type" changed={cat._state.dirty.includes("display_type")}>
                <Select value={cat.display_type} onChange={(e) => set("display_type", e.target.value)}>
                  <option value="">Default</option><option value="products">Products</option><option value="subcategories">Subcategories</option><option value="both">Both</option>
                </Select>
              </Field>
              <ImageSlot label="Thumbnail" value={cat.image_id} onChange={(v) => set("image_id", v)} />
              <ImageSlot label="Banner" value={cat.banner_id} onChange={(v) => set("banner_id", v)} />
            </div>
            <Field label="Description" changed={cat._state.dirty.includes("description")}>
              <RichTextEditor value={cat.description} onChange={(h) => set("description", h)} minHeight={180} placeholder="Introduce this category to shoppers" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="SEO title" changed={cat._state.dirty.includes("seo_title")}><BufferedInput value={cat.seo_title} onCommit={(v) => set("seo_title", v)} /></Field>
              <Field label="Meta description" changed={cat._state.dirty.includes("seo_description")}><BufferedInput value={cat.seo_description} onCommit={(v) => set("seo_description", v)} /></Field>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
