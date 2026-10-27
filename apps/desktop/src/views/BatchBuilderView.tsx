import { ArrowRight, Download, Eye, FileArchive, Hash, ImagePlus, Layers, ListOrdered, Loader2, PackagePlus, Plus, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalFile, Product } from "../backend/types";
import { BlankEditor, Fold } from "../components/batch/BlankEditor";
import { ImageSlots, type SlotRef } from "../components/batch/ImageSlots";
import { Badge, Button, clsx, Dropzone, Field, Input, Modal, Select, TextArea } from "../components/ui";
import { blankDefaults, blankFromProduct, buildItems, checks as runChecks, collectionDefaults, exportImageNames, imagesFor, matchImages, MUG_BLANK, nextNumber, storeManagerCsv, stripChatAttrs, toImport, type BatchImage, type Blank, type Collection } from "../lib/batch";
import { buildPlan, parseCsv, planToStaging } from "../lib/importer";
import { cleanPastedHtml } from "../lib/pasteHtml";
import { useApp } from "../store/app";

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: settings just aren't remembered */
  }
};

interface HistoryEntry {
  at: number;
  store: string;
  blank: string;
  design: string;
  first: string;
  last: string;
  count: number;
}

function Step({ n, title, children, right, testId }: { n: number; title: string; children: React.ReactNode; right?: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-panel p-4" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-2xs font-medium text-white">{n}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </section>
  );
}

function Seg<T extends string>({ value, options, onChange, testId }: { value: T; options: [T, string, React.ReactNode?][]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-line" role="group" data-testid={testId}>
      {options.map(([v, label, icon]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={clsx("flex h-8 items-center gap-1.5 px-3 text-xs", value === v ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-sunken")}>
          {icon}{label}
        </button>
      ))}
    </div>
  );
}

/**
 * Batch Builder: a product blank × a design collection → dozens or hundreds of finished products,
 * with images matched automatically, checked against the store, and staged in one step.
 */
export function BatchBuilderView() {
  const { backend, storeId, info, taxonomy, create, stage, setQuery, setView, toast } = useApp();
  const symbol = info?.handshake?.currency_symbol ?? "$";
  const [blanks, setBlanks] = useState<Blank[]>(() => load("cf.batch.blanks", [MUG_BLANK]));
  const [currentId, setCurrentId] = useState<string>(() => load("cf.batch.current", MUG_BLANK.id));
  const [col, setColState] = useState<Collection>(() => ({ ...collectionDefaults(), ...load<Partial<Collection>>("cf.batch.collection", {}) }));
  const [history, setHistory] = useState<HistoryEntry[]>(() => load("cf.batch.history", []));
  const [files, setFiles] = useState<BatchImage[]>([]);
  const [shared, setShared] = useState<BatchImage[]>([]);
  const [matchMode, setMatchMode] = useState<"number" | "order">("number");
  const [assign, setAssign] = useState<(string | null)[][]>([]);
  const [sel, setSel] = useState<SlotRef | null>(null);
  const [storeSkus, setStoreSkus] = useState<[string, number, string][]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const seq = useRef(0);

  const blank = blanks.find((b) => b.id === currentId) ?? blanks[0];
  const setBlank = (b: Blank) => {
    const next = blanks.map((x) => (x.id === b.id ? b : x));
    setBlanks(next);
    save("cf.batch.blanks", next);
  };
  const addBlank = (b: Blank) => {
    const next = [...blanks, b];
    setBlanks(next);
    setCurrentId(b.id);
    save("cf.batch.blanks", next);
    save("cf.batch.current", b.id);
  };
  // Saved straight away, so it sticks even when the page closes right after (e.g. after Add).
  const setCol = (p: Partial<Collection>) => {
    const next = { ...col, ...p };
    save("cf.batch.collection", next);
    setColState(next);
  };

  // SKUs already in the store: duplicates, "continue numbering", update vs skip.
  const refreshSkus = useCallback(() => {
    if (storeId) backend.skus(storeId).then(setStoreSkus).catch(() => setStoreSkus([]));
  }, [backend, storeId]);
  useEffect(refreshSkus, [refreshSkus]);
  const skuSet = useMemo(() => new Set(storeSkus.map(([s]) => s)), [storeSkus]);

  const items = useMemo(() => buildItems(blank, col), [blank, col]);
  const slots = 1 + blank.galleryCount;
  const fileMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  // Re-match automatically when the products, files, mode or slot count change.
  const sig = `${matchMode}|${files.map((f) => f.id).join(".")}|${slots}|${items.map((i) => i.n).join(".")}`;
  const lastSig = useRef("");
  useEffect(() => {
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    setAssign(matchImages(items, files, matchMode, slots));
    setSel(null);
  }, [sig, items, files, matchMode, slots]);

  const paths = useMemo(() => {
    const cats = taxonomy?.categories ?? [];
    const byId = new Map(cats.map((c) => [String(c._state.is_new ? c._state.key : c.id), c]));
    const pathOf = (id: string, guard = 0): string => {
      const c = byId.get(id);
      if (!c || guard > 20) return "";
      const parent = String(c.parent ?? 0);
      return parent !== "0" && byId.has(parent) ? `${pathOf(parent, guard + 1)} > ${c.name}` : c.name;
    };
    return [...byId.keys()].map((k) => pathOf(k)).sort();
  }, [taxonomy]);
  const knownPaths = useMemo(() => new Set(paths.map((p) => p.toLowerCase())), [paths]);
  const next = useMemo(() => nextNumber(blank, col, storeSkus.map(([s]) => s)), [blank, col, storeSkus]);
  const checkList = useMemo(() => runChecks(items, blank, col, { storeSkus: skuSet, assign, images: files, knownPaths, symbol }), [items, blank, col, skuSet, assign, files, knownPaths, symbol]);
  const blocked = checkList.some((c) => c.level === "error");
  const variations = items.reduce((s, i) => s + i.variations.length, 0);
  const willCreate = items.filter((i) => !skuSet.has(i.sku)).length;
  const willUpdate = col.existing === "update" ? items.length - willCreate : 0;
  const imageCount = new Set([...assign.flat().filter(Boolean), ...(items.length ? shared.map((s) => s.id) : [])]).size;
  const stockValue = items.length * (parseFloat(blank.stock) || 0) * (parseFloat(blank.sale || blank.price) || 0) * Math.max(1, variations / Math.max(1, items.length));

  /* -------------------------------------------------------------- images */
  const toImages = (list: LocalFile[]) => list.filter((f) => IMG.test(f.name)).map((f) => ({ ...f, id: `i${++seq.current}` }));
  const addFiles = (list: LocalFile[], role?: "gallery") =>
    setFiles((cur) => [...cur, ...toImages(list).map((f) => ({ ...f, role })).filter((f) => !cur.some((c) => c.path === f.path && c.name === f.name && c.role === f.role))]);
  const productFiles = files.filter((f) => f.role !== "gallery").length;
  const galleryFiles = files.length - productFiles;
  const galleryPlaced = useMemo(() => {
    const placed = new Set(assign.flat());
    return files.filter((f) => f.role === "gallery" && placed.has(f.id)).length;
  }, [assign, files]);
  const pick = (r: SlotRef) => {
    if (!sel) return setSel(r);
    const a = sel;
    setSel(null);
    if (a.t === "pool" && r.t === "pool") return setSel(r);
    const get = (x: SlotRef) => (x.t === "pool" ? x.id : assign[x.i]?.[x.j] ?? null);
    const nextAssign = assign.map((row) => [...row]);
    const put = (x: SlotRef, id: string | null) => x.t === "slot" && (nextAssign[x.i][x.j] = id);
    const va = get(a);
    const vb = get(r);
    if (a.t === "slot" && r.t === "slot") {
      put(a, vb);
      put(r, va);
    } else if (a.t === "pool") put(r, va);
    else put(a, vb);
    setAssign(nextAssign);
  };

  /* --------------------------------------------------------------- blanks */
  const importBlank = async () => {
    const [f] = await backend.pickFiles({ multiple: false, extensions: ["csv", "json"] });
    if (!f) return;
    try {
      const text = new TextDecoder().decode(await backend.readFile(f.path));
      if (/\.json$/i.test(f.name)) {
        const list = (JSON.parse(text) as Blank[]).map((b) => blankDefaults({ ...b, id: blankDefaults().id }));
        list.forEach(addBlank);
        return toast({ tone: "success", title: `Imported ${list.length} blank${list.length === 1 ? "" : "s"}` });
      }
      // A product exported in the Store Manager layout.
      const sheet = parseCsv(text);
      const r = sheet.rows[0];
      if (!r?.Title) throw new Error("No product rows in that file");
      const base = r.Title.split(" - ")[0].trim() || r.Title;
      const price = r["Regular Price"] ?? "";
      const tok = (h: string) => (price ? stripChatAttrs(h).split(`R${price}`).join("R{price}") : stripChatAttrs(h));
      addBlank(blankDefaults({ label: base, base, prefix: (r.SKU ?? "").split("-")[0] || "SKU", price, sale: Number(r["Sale Price"]) > 0 ? r["Sale Price"] : "", stock: r.Stock ?? "", weight: r.Weight ?? "", height: r.Height ?? "", width: r.Width ?? "", length: r.Length ?? "", tags: (r.Tags ?? "").replace(/"/g, ""), shipping: r["Shipping Class"] ?? "", taxClass: /standard/i.test(r["Tax Class"] ?? "") ? "" : r["Tax Class"] ?? "", featured: r.Featured === "yes", desc: tok(r.Description ?? ""), short: tok(r["Short Description"] ?? "") }));
      toast({ tone: "success", title: `Created a blank from “${r.Title}”`, body: "Check the price and patterns." });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't read that file", body: String(e) });
    }
  };
  const exportBlanks = async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(blanks, null, 2));
    const path = await backend.saveFile({ defaultName: "catalogforge-blanks.json", filterName: "Blanks", extension: "json", bytes, mime: "application/json" });
    if (path) toast({ tone: "success", title: `${blanks.length} blanks saved`, body: "Import them on another computer from the Blank menu." });
  };

  /* ----------------------------------------------------------- add to store */
  const addToStore = async () => {
    if (!storeId || !items.length) return;
    setBusy("Planning products");
    try {
      const index = await backend.skus(storeId);
      const ids = new Map(index.map(([sku, id]) => [sku, id]));
      const keys = items.flatMap((i) => [i.sku, ...i.variations.map((v) => v.sku)]).map((s) => ids.get(s)).filter((x): x is number => !!x).map(String);
      const rows = keys.length ? await backend.rows(storeId, keys) : [];
      const bySku = new Map<string, Product>(rows.filter((r) => r.sku).map((r) => [r.sku, r]));
      const byKey = new Map<string, Product>(rows.map((r) => [r._state.key, r]));
      const fields = info?.profile.custom_fields ?? [];
      const { sheet, cfg, firstRow } = toImport(items, blank, col, fields.filter((f) => (blank.custom[f.key] ?? "").trim()).map((f) => f.key));
      let n = 0;
      const plan = buildPlan(sheet, cfg, { categories: (taxonomy?.categories ?? []).filter((c) => !c._state.is_new), existingBySku: bySku, imageFiles: [], customFields: fields, newKey: () => `new:bat${Date.now().toString(36)}${(n++).toString(36)}` });
      // Images: the planner knows rows, we know which product each row is.
      const itemOfRow = new Map(firstRow.map((r, i) => [r + 2, i]));
      let images = 0;
      for (const p of plan.products) {
        if (p.entity !== "product") continue;
        const i = itemOfRow.get(p.row);
        if (i === undefined) continue;
        const { image, gallery } = imagesFor(assign[i] ?? [], fileMap, shared);
        if (image) p.fields.image_id = image;
        if (gallery.length) p.fields.gallery_ids = gallery;
        images += (image ? 1 : 0) + gallery.length;
      }
      const errors = plan.issues.filter((x) => x.level === "error");
      if (errors.length) throw new Error(errors.slice(0, 3).map((e) => e.message).join(" · "));
      setBusy("Adding to the store");
      const { creates, edits } = planToStaging(plan, byKey);
      if (creates.length) await create(creates);
      if (edits.length) await stage(edits);
      const entry: HistoryEntry = { at: Date.now(), store: info?.profile.name ?? "", blank: blank.label, design: col.design, first: items[0].sku, last: items[items.length - 1].sku, count: items.length };
      const h = [entry, ...history].slice(0, 20);
      setHistory(h);
      save("cf.batch.history", h);
      const made = plan.stats.create;
      toast({ tone: "success", title: `${made} product${made === 1 ? "" : "s"} added${plan.stats.update ? `, ${plan.stats.update} updated` : ""}${plan.stats.variations ? ` with ${plan.stats.variations} variations` : ""}`, body: `${images ? `${images} images upload on push. ` : ""}Review them in the grid, then Push.` });
      // The next batch carries on numbering from here.
      if (col.mode === "num") setCol({ start: col.start + col.count });
      refreshSkus();
      setQuery({ only_changed: true, search: "" });
      setView("products");
    } catch (e) {
      toast({ tone: "error", title: "Couldn't add the batch", body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  /* ---------------------------------------------------------------- export */
  const extOf = (f?: BatchImage) => (f?.name.split(".").pop() ?? "webp").toLowerCase().replace("jpeg", "jpg");
  const exportNames = () => items.map((it, i) => exportImageNames(blank, it, (slot) => extOf(assign[i]?.[slot] ? fileMap.get(assign[i][slot]!) : undefined) || "webp"));
  const fileBase = `${(blank.base + " " + col.design).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "products"}-${new Date().toISOString().slice(0, 10)}`;
  const exportCsv = async () => {
    const csv = storeManagerCsv(items, blank, col, exportNames(), shared.map((s) => s.name));
    const path = await backend.saveFile({ defaultName: `${fileBase}.csv`, filterName: "CSV", extension: "csv", bytes: new TextEncoder().encode(csv), mime: "text/csv" });
    if (path) toast({ tone: "success", title: `CSV saved · ${items.length} products`, body: "Same 56-column layout as your Store Manager export, ready for WP All Import." });
  };
  const exportZip = async () => {
    setBusy("Building ZIP");
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const names = exportNames();
      zip.file(`${fileBase}.csv`, storeManagerCsv(items, blank, col, names, shared.map((s) => s.name)));
      let done = 0;
      for (let i = 0; i < items.length; i++)
        for (let j = 0; j < slots; j++) {
          const f = assign[i]?.[j] ? fileMap.get(assign[i][j]!) : undefined;
          if (!f) continue;
          zip.file(names[i][j], await backend.readFile(f.path));
          setBusy(`Building ZIP (${++done} images)`);
        }
      for (const s of shared) zip.file(s.name, await backend.readFile(s.path));
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
      const path = await backend.saveFile({ defaultName: `${fileBase}.zip`, filterName: "ZIP", extension: "zip", bytes, mime: "application/zip" });
      if (path) toast({ tone: "success", title: `ZIP saved · CSV + ${done + shared.length} images`, body: "Images are renamed to match the CSV." });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't build the ZIP", body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const showInTheme = async () => {
    if (!storeId || !items[0]) return;
    const it = items[0];
    try {
      setPreview(await backend.preview(storeId, null, { name: it.title, sku: it.sku, type: "simple", status: "publish", regular_price: blank.price, sale_price: blank.sale, description: cleanPastedHtml(blank.desc.replace(/\{(\w+)\}/g, (m, k: string) => it.tokens[k] ?? m)), short_description: blank.short.replace(/\{(\w+)\}/g, (m, k: string) => it.tokens[k] ?? m) }));
    } catch (e) {
      toast({ tone: "error", title: "Preview failed", body: String(e) });
    }
  };

  const first = items[0];
  const firstImg = assign[0]?.[0] ? fileMap.get(assign[0][0]!) : undefined;

  return (
    <div className="h-full overflow-auto bg-sunken" data-testid="batch-builder">
      <div className="mx-auto max-w-[1500px] space-y-4 p-4">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold"><Layers size={20} className="text-accent" /> Batch Builder</h1>
            <p className="text-[13px] text-muted">Pick a product blank, describe the collection, drop in the images, and add the whole batch to your store in one step, checked against what's already there.</p>
          </div>
        </header>

        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-[1_1_480px] space-y-4">
            <Step n={1} title="Product blank" testId="step-blank"
              right={
                <div className="flex items-center gap-1.5">
                  <Select value={blank.id} onChange={(e) => { setCurrentId(e.target.value); save("cf.batch.current", e.target.value); }} className="w-52" aria-label="Saved blank" data-testid="blank-select">
                    {blanks.map((b) => <option key={b.id} value={b.id}>{b.label || b.base || "Untitled blank"}</option>)}
                  </Select>
                  <Select value="" className="w-10 px-1" aria-label="Blank actions" data-testid="blank-actions" onChange={async (e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    if (v === "new") addBlank(blankDefaults());
                    else if (v === "dup") addBlank({ ...blank, id: blankDefaults().id, label: `${blank.label} copy` });
                    else if (v === "product") setPicker(true);
                    else if (v === "import") await importBlank();
                    else if (v === "export") await exportBlanks();
                    else if (v === "delete") {
                      if (blanks.length < 2) return toast({ tone: "info", title: "Keep at least one blank" });
                      if (!window.confirm(`Delete the blank “${blank.label}”?`)) return;
                      const rest = blanks.filter((b) => b.id !== blank.id);
                      setBlanks(rest);
                      save("cf.batch.blanks", rest);
                      setCurrentId(rest[0].id);
                    }
                  }}>
                    <option value="">⋯</option>
                    <option value="new">New blank</option>
                    <option value="dup">Duplicate this blank</option>
                    <option value="product">Make a blank from a store product…</option>
                    <option value="import">Import blanks (.json) or a Store Manager CSV…</option>
                    <option value="export">Export all blanks (.json)…</option>
                    <option value="delete">Delete this blank</option>
                  </Select>
                </div>
              }>
              <p className="text-xs text-muted">Everything that stays the same across a collection. Changes are saved as you type.</p>
              <BlankEditor blank={blank} onChange={setBlank} />
            </Step>

            <Step n={2} title="Design collection" testId="step-collection">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Design name"><Input value={col.design} onChange={(e) => setCol({ design: e.target.value })} data-testid="col-design" /></Field>
                <Field label="Design code (for SKUs)"><Input value={col.code} onChange={(e) => setCol({ code: e.target.value })} data-testid="col-code" /></Field>
                <Field label="Categories" className="col-span-2" hint="Pick one or type a new path; levels with >, several categories with |. New ones are created.">
                  <Input value={col.categories} list="cf-cat-paths" onChange={(e) => setCol({ categories: e.target.value })} placeholder="11oz Mugs > Funny > Cats Funny" data-testid="col-categories" />
                  <datalist id="cf-cat-paths">{paths.map((p) => <option key={p} value={p} />)}</datalist>
                </Field>
                <Field label="Extra tags for this collection (|)" className="col-span-2"><Input value={col.tags} onChange={(e) => setCol({ tags: e.target.value })} /></Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Products are</span>
                <Seg value={col.mode} onChange={(mode) => setCol({ mode })} options={[["num", "Numbered", <Hash size={12} key="h" />], ["list", "A list of names", <ListOrdered size={12} key="l" />]]} testId="col-mode" />
              </div>
              {col.mode === "num" ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="First number"><Input inputMode="numeric" value={String(col.start)} onChange={(e) => setCol({ start: Math.max(0, parseInt(e.target.value) || 0) })} data-testid="col-start" /></Field>
                    <Field label="How many"><Input inputMode="numeric" value={String(col.count)} onChange={(e) => setCol({ count: Math.max(0, Math.min(2000, parseInt(e.target.value) || 0)) })} data-testid="col-count" /></Field>
                    <Field label="Digits">
                      <Select value={String(col.pad)} onChange={(e) => setCol({ pad: Number(e.target.value) })}><option value="1">1</option><option value="2">2 (01)</option><option value="3">3 (001)</option><option value="4">4 (0001)</option></Select>
                    </Field>
                  </div>
                  {next && next.found > 0 && next.next !== col.start && (
                    <div className="flex items-center gap-2 rounded-md bg-accent/5 px-3 py-2 text-xs" data-testid="next-number">
                      <Sparkles size={13} className="text-accent" />
                      <span>{next.found} product{next.found === 1 ? "" : "s"} with this SKU pattern {next.found === 1 ? "is" : "are"} already in the store (highest {next.highest}).</span>
                      <button className="ml-auto font-medium text-accent hover:underline" onClick={() => setCol({ start: next.next })}>Continue from {next.next}</button>
                    </div>
                  )}
                </div>
              ) : (
                <Field label="One name per line"><TextArea rows={6} value={col.list} onChange={(e) => setCol({ list: e.target.value })} placeholder={"Best Mom Ever\nWorld's Okayest Dad\nCoffee First"} data-testid="col-list" /></Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Publish as">
                  <Select value={col.status} onChange={(e) => setCol({ status: e.target.value as Collection["status"] })}><option value="publish">Published</option><option value="draft">Draft (check first, publish later)</option><option value="private">Private</option></Select>
                </Field>
                <Field label="If a SKU already exists">
                  <Select value={col.existing} onChange={(e) => setCol({ existing: e.target.value as Collection["existing"] })} data-testid="col-existing"><option value="skip">Leave it alone</option><option value="update">Update it with this blank</option></Select>
                </Field>
              </div>
            </Step>
          </div>

          <div className="min-w-0 flex-[999_1_560px] space-y-4">
            <Step n={3} title="Images" testId="step-images" right={(files.length > 0 || shared.length > 0) && <Button size="sm" variant="close" icon={<X size={13} />} onClick={() => { setFiles([]); setShared([]); }}>Clear</Button>}>
              <Dropzone toFiles={backend.filesFromDrop} onFiles={(f) => addFiles(f)} className="rounded-lg" testId="batch-drop">
                <div className="flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-line p-5 text-center">
                  <ImagePlus size={24} className={files.length ? "text-added" : "text-muted"} />
                  <div className="text-[13px] font-medium">{productFiles ? `${productFiles} product images loaded · drop more to add` : "Drop product images here"}</div>
                  <Button size="sm" onClick={async () => addFiles(await backend.pickFiles({ multiple: true, extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] }))} data-testid="batch-pick-images">Choose images…</Button>
                </div>
              </Dropzone>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Match images by</span>
                <Seg value={matchMode} onChange={setMatchMode} options={[["number", "Number in file name"], ["order", "File order"]]} testId="match-mode" />
                <span className="text-xs text-muted">· {blank.galleryCount} gallery image{blank.galleryCount === 1 ? "" : "s"} per product (change under Naming patterns)</span>
              </div>
              <p className="text-xs text-muted">
                {matchMode === "number"
                  ? "The last number in each file name picks the product: cat-05.png becomes product 5's featured image, cat-05a.png, cat-05b.png… its gallery."
                  : `Files are sorted by name and handed out ${slots} per product: featured image first, then the gallery.`}
              </p>
              <Dropzone toFiles={backend.filesFromDrop} onFiles={(f) => addFiles(f, "gallery")} className="rounded-lg" testId="batch-gallery-drop">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2">
                  <Button size="sm" icon={<Plus size={13} />} onClick={async () => addFiles(await backend.pickFiles({ multiple: true, extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] }), "gallery")} data-testid="batch-gallery">Gallery images…</Button>
                  <span className="min-w-0 flex-1 text-xs text-muted" data-testid="batch-gallery-note">
                    {galleryFiles
                      ? `${galleryFiles} gallery images · ${galleryPlaced} matched to a product${galleryPlaced < galleryFiles ? ` · ${galleryFiles - galleryPlaced} without a match or a free gallery slot` : ""}`
                      : "Drop or choose a second folder (e.g. lifestyle shots). Each product gets the gallery image with the same file name as its featured image, or the same number."}
                  </span>
                </div>
              </Dropzone>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<Plus size={13} />} onClick={async () => { const picked = toImages(await backend.pickFiles({ multiple: true, extensions: ["jpg", "jpeg", "png", "webp", "gif"] })); setShared((cur) => [...cur.filter((c) => !picked.some((p) => p.name === c.name)), ...picked]); }} data-testid="batch-shared">Shared gallery images…</Button>
                <span className="text-xs text-muted">{shared.length ? `Added to every product: ${shared.map((s) => s.name).join(", ")}` : "The same image for every product, e.g. a size chart (uploaded once)."}</span>
              </div>
              {files.length > 0 && <ImageSlots items={items} assign={assign} files={fileMap} selected={sel} onPick={pick} slots={slots} />}
            </Step>

            <Step n={4} title="Check and add" testId="step-review">
              <div className="flex flex-wrap gap-2" data-testid="batch-stats">
                {[[items.length, "products"], [variations, "variations"], [imageCount, "images"], [`${symbol}${Math.round(stockValue).toLocaleString()}`, "stock value at retail"]].map(([v, l]) => (
                  <div key={String(l)} className="min-w-[110px] rounded-lg bg-sunken px-3 py-2">
                    <div className="text-lg font-semibold tabular-nums">{v}</div>
                    <div className="text-2xs text-muted">{l}</div>
                  </div>
                ))}
              </div>
              <ul className="space-y-1.5" data-testid="batch-checks">
                {checkList.map((c, i) => (
                  <li key={i} className={clsx("flex items-start gap-2.5 rounded-md px-3 py-2 text-[13px]", c.level === "ok" ? "bg-added/10 text-added" : c.level === "error" ? "bg-removed/10 text-removed" : c.level === "warn" ? "bg-changed/10 text-changed" : "bg-sunken text-muted")}>
                    <b className="pt-0.5 font-mono text-2xs tracking-wide">{c.level === "ok" ? "READY" : c.level === "error" ? "FIX" : c.level === "warn" ? "CHECK" : "NOTE"}</b>
                    <span className="flex-1">{c.message}</span>
                    {c.fix === "strip-chat" && <button className="shrink-0 text-xs font-medium underline" onClick={() => setBlank({ ...blank, desc: stripChatAttrs(blank.desc), short: stripChatAttrs(blank.short) })}>Remove them</button>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={busy ? <Loader2 size={14} className="animate-spin" /> : <PackagePlus size={15} />} disabled={!items.length || blocked || !!busy || (willCreate === 0 && willUpdate === 0)} onClick={addToStore} data-testid="batch-add">
                  {busy ?? `Add ${willCreate} product${willCreate === 1 ? "" : "s"}${willUpdate ? ` + update ${willUpdate}` : ""} to the store`}
                </Button>
                <Button icon={<Download size={14} />} onClick={exportCsv} disabled={!items.length} data-testid="batch-csv">CSV</Button>
                <Button icon={<FileArchive size={14} />} onClick={exportZip} disabled={!items.length || !!busy} data-testid="batch-zip">ZIP (CSV + images)</Button>
                {info?.capabilities.preview && <Button variant="ghost" icon={<Eye size={14} />} onClick={showInTheme} disabled={!first}>Preview in your theme</Button>}
              </div>
              <p className="text-2xs text-muted">Nothing is written to the store until you Push. Adding stages the batch so you can review it in the grid, undo it, or push it with your other changes.</p>

              <div className="overflow-hidden rounded-lg border border-line">
                <table className="w-full text-[12.5px]" data-testid="batch-table">
                  <thead className="bg-sunken text-left text-2xs uppercase tracking-wide text-muted">
                    <tr><th className="px-2 py-1.5">#</th><th className="px-2 py-1.5" /><th className="px-2 py-1.5">SKU</th><th className="px-2 py-1.5">Title</th><th className="px-2 py-1.5 text-right">Price</th><th className="px-2 py-1.5 text-right">Stock</th><th className="px-2 py-1.5">In store</th></tr>
                  </thead>
                  <tbody>
                    {items.slice(0, 200).map((it, i) => {
                      const img = assign[i]?.[0] ? fileMap.get(assign[i][0]!) : undefined;
                      const exists = skuSet.has(it.sku);
                      return (
                        <tr key={it.index} className="border-t border-line">
                          <td className="px-2 py-1 tabular-nums text-muted">{i + 1}</td>
                          <td className="px-2 py-1">{img ? <img src={img.url} alt="" className="h-7 w-7 rounded object-cover" /> : <span className="block h-7 w-7 rounded bg-sunken" />}</td>
                          <td className="px-2 py-1 font-mono text-2xs">{it.sku}{it.variations.length > 0 && <span className="text-muted"> +{it.variations.length}</span>}</td>
                          <td className="px-2 py-1">{it.title}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{blank.sale ? <><s className="text-muted">{blank.price}</s> {blank.sale}</> : blank.price}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{blank.stock}</td>
                          <td className="px-2 py-1">{exists ? <Badge tone={col.existing === "update" ? "changed" : "removed"}>{col.existing === "update" ? "update" : "skip"}</Badge> : <Badge tone="added">new</Badge>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Step>

            {first && (
              <section className="space-y-2 rounded-xl border border-line bg-panel p-4">
                <h2 className="text-[13px] font-semibold">Product page preview <span className="font-normal text-muted">· {first.title}</span></h2>
                <div className="flex gap-4">
                  {firstImg && <img src={firstImg.url} alt="" className="h-40 w-40 shrink-0 rounded-lg object-cover" />}
                  <div className="min-w-0 space-y-2">
                    <div className="text-lg font-semibold">{first.title}</div>
                    <div className="font-semibold text-accent">{blank.sale ? <><s className="mr-1 font-normal text-muted">{symbol}{blank.price}</s>{symbol}{blank.sale}</> : `${symbol}${blank.price}`}</div>
                    <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: cleanPastedHtml(blank.short.replace(/\{(\w+)\}/g, (m, k: string) => first.tokens[k] ?? m)) }} />
                  </div>
                </div>
              </section>
            )}

            {history.length > 0 && (
              <Fold title={`Recent batches (${history.length})`}>
                <ul className="space-y-1 text-xs text-muted">
                  {history.slice(0, 8).map((h) => (
                    <li key={h.at} className="flex gap-2"><span className="w-32 shrink-0">{new Date(h.at).toLocaleString()}</span><span className="flex-1">{h.count} × {h.blank} · {h.design} · {h.first}{h.count > 1 ? ` → ${h.last}` : ""}</span><span>{h.store}</span></li>
                  ))}
                </ul>
              </Fold>
            )}
          </div>
        </div>
      </div>

      <ProductPicker open={picker} onClose={() => setPicker(false)} onPick={async (key) => {
        if (!storeId) return;
        const [row] = await backend.rows(storeId, [key]);
        const vars = row?.type === "variable" ? await backend.variations(storeId, key) : [];
        if (!row) return;
        const b = blankFromProduct(row, vars);
        addBlank(b);
        setPicker(false);
        toast({ tone: "success", title: `Blank made from “${row.name}”`, body: "Prices, sizes, tags, descriptions and options were copied. Check the SKU prefix and patterns." });
      }} />
      <Modal open={!!preview} onClose={() => setPreview(null)} title="Preview in your store's theme" width={1000}>
        {preview && <iframe title="Theme preview" src={preview} className="h-[70vh] w-full rounded border border-line bg-white" sandbox="allow-same-origin allow-scripts" />}
      </Modal>
    </div>
  );
}

function ProductPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (key: string) => void }) {
  const { backend, storeId } = useApp();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ key: string; name: string; sku: string; type: string }[]>([]);
  useEffect(() => {
    if (!open || !storeId) return;
    const t = setTimeout(async () => {
      const { keys } = await backend.query(storeId, { search: q, expanded: [] });
      const r = await backend.rows(storeId, keys.slice(0, 40));
      setRows(r.filter((x) => x.type !== "variation").map((x) => ({ key: x._state.key, name: x.name, sku: x.sku, type: x.type })));
    }, 200);
    return () => clearTimeout(t);
  }, [open, q, backend, storeId]);
  return (
    <Modal open={open} onClose={onClose} title="Make a blank from a store product" width={560} testId="blank-from-product">
      <div className="space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
          <Input autoFocus className="pl-7" placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="max-h-80 overflow-auto rounded-md border border-line">
          {rows.map((r) => (
            <button key={r.key} onClick={() => onPick(r.key)} className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-[13px] first:border-0 hover:bg-sunken">
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="font-mono text-2xs text-muted">{r.sku}</span>
              <Badge>{r.type}</Badge>
              <ArrowRight size={13} className="text-muted" />
            </button>
          ))}
          {!rows.length && <div className="p-3 text-xs text-muted">No products match.</div>}
        </div>
        <p className="text-2xs text-muted">The product's price, stock, sizes, tags, descriptions and options (with option prices) become the blank. Prices in the text become {"{price}"}.</p>
      </div>
    </Modal>
  );
}

