import { BookOpen, Columns2, FileDown, FileText, ImagePlus, LayoutGrid, Loader2, Plus, RefreshCw, Rows3, Square, Table2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Media, ProductRow } from "../backend/types";
import { Check, ColorInput, NumberInput, Section, TextStyleEditor, type FileFont } from "../components/catalogue/controls";
import { ContentTree } from "../components/catalogue/ContentTree";
import { PdfPreview } from "../components/catalogue/PdfPreview";
import { Badge, Button, clsx, Input, Select, Tabs, TextArea } from "../components/ui";
import { toCatalogue } from "../lib/catalogue/data";
import { defaultDesign, PAGE_SIZES, style, THEMES, TOKENS, type CatalogueDesign, type CoverText, type HeaderFooter, type Layout, type PageSize } from "../lib/catalogue/design";
import { assetFontLoader } from "../lib/catalogue/fonts";
import { buildTree, geometry, limitForPreview, paginate, type CatProduct } from "../lib/catalogue/plan";
import { renderCatalogue, templateInfo } from "../lib/catalogue/render";
import { formatPrice } from "../lib/catalogue/text";
import { useApp } from "../store/app";

type Tab = "content" | "layout" | "cover" | "headers" | "styles" | "template";

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: designs just aren't remembered */
  }
};

/** Older saved designs gain fields added since. */
const upgrade = (d: Partial<CatalogueDesign>, name: string): CatalogueDesign => {
  const base = defaultDesign(name);
  return { ...base, ...d, show: { ...base.show, ...d.show }, templatePages: { ...base.templatePages, ...d.templatePages }, header: { ...base.header, ...d.header }, footer: { ...base.footer, ...d.footer } };
};

const LAYOUTS: [Layout, string, typeof LayoutGrid][] = [["grid", "Grid", LayoutGrid], ["list", "List", Rows3], ["pricelist", "Price list", Table2], ["feature", "One per page", Square]];

export function CatalogueView() {
  const { backend, storeId, info, taxonomy, toast } = useApp();
  const storeName = info?.handshake?.site_name || info?.profile.name || "Our store";
  const designKey = `cf.catalogue.design.${storeId}`;
  const [design, setDesignState] = useState<CatalogueDesign>(() => upgrade(load(designKey, defaultDesign(storeName)), storeName));
  const [saved, setSaved] = useState<Record<string, CatalogueDesign>>(() => load("cf.catalogue.designs", {}));
  const [fonts, setFonts] = useState<FileFont[]>(() => load("cf.catalogue.fonts", []));
  const [tab, setTab] = useState<Tab>("content");
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [media, setMedia] = useState<Map<number, Media>>(new Map());
  const [loading, setLoading] = useState<string | null>("Loading products");
  const [pdf, setPdf] = useState<{ bytes: Uint8Array; numbers?: number[] } | null>(null);
  const [rendering, setRendering] = useState<{ done: number; total: number; message: string } | null>(null);
  const [quick, setQuick] = useState(true);
  const [spread, setSpread] = useState(true);
  const [zoom, setZoom] = useState(260);
  const [tpl, setTpl] = useState<{ pages: number; size: [number, number]; bytes: Uint8Array } | null>(null);
  const [exporting, setExporting] = useState<{ done: number; total: number; message: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const imageCache = useRef(new Map<string, Promise<Uint8Array | null>>());

  const setDesign = useCallback((patch: Partial<CatalogueDesign> | ((d: CatalogueDesign) => CatalogueDesign)) => {
    setDesignState((d) => {
      const next = typeof patch === "function" ? patch(d) : { ...d, ...patch };
      store(designKey, next);
      return next;
    });
  }, [designKey]);

  /* ----------------------------------------------------------- store data */
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    (async () => {
      setLoading("Loading products");
      const { keys } = await backend.query(storeId, { include_variations: true, expanded: [], sort: [{ field: "id", desc: false }] });
      const out: ProductRow[] = [];
      for (let i = 0; i < keys.length; i += 1000) {
        out.push(...(await backend.rows(storeId, keys.slice(i, i + 1000))));
        if (cancelled) return;
        setLoading(`Loading products (${out.length.toLocaleString()} of ${keys.length.toLocaleString()})`);
      }
      const m = await backend.media(storeId);
      if (cancelled) return;
      setMedia(new Map(m.map((x) => [x.id, x])));
      setRows(out);
      setLoading(null);
    })().catch((e) => {
      setLoading(null);
      toast({ tone: "error", title: "Could not load products", body: String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, toast]);

  const decimals = info?.handshake?.price_decimals ?? 2;
  const symbol = info?.handshake?.currency_symbol ?? "$";
  const data = useMemo(() => (rows ? toCatalogue(rows, taxonomy?.categories ?? [], media, design.priceAdjust, decimals) : null), [rows, taxonomy, media, design.priceAdjust, decimals]);

  /* -------------------------------------------------------------- template */
  useEffect(() => {
    if (!design.templateFile) return setTpl(null);
    let cancelled = false;
    backend
      .readFile(design.templateFile.path)
      .then(async (bytes) => {
        const i = await templateInfo(bytes);
        if (!cancelled) setTpl({ ...i, bytes });
      })
      .catch((e) => {
        if (cancelled) return;
        setTpl(null);
        toast({ tone: "error", title: "Template PDF unavailable", body: `${design.templateFile?.name}: ${String(e)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [backend, design.templateFile, toast]);

  const plan = useMemo(() => {
    if (!data) return null;
    const tree = buildTree(data.categories, data.products, design);
    return paginate(tree, design, geometry(design, design.templateFile ? tpl?.size ?? null : null));
  }, [data, design, tpl]);

  const customLabels = useMemo(() => Object.fromEntries((info?.profile.custom_fields ?? []).map((f) => [f.key, f.label || f.key])), [info]);
  const meta = useMemo(() => ({ store: storeName, website: info?.handshake?.home_url ?? "", currencySymbol: symbol, decimals }), [storeName, info, symbol, decimals]);

  const render = useCallback(
    (preview: boolean, signal: AbortSignal, onProgress: (done: number, total: number, message: string) => void) => {
      if (!plan) throw new Error("Nothing to render yet");
      const quality = preview || design.imageQuality === "screen" ? 72 : 85;
      const p = preview ? limitForPreview(plan, 8) : plan;
      return renderCatalogue({
        design,
        plan: p,
        meta,
        customLabels,
        preview,
        image: (src, max) => {
          const key = `${src}|${max}|${quality}`;
          let p = imageCache.current.get(key);
          if (!p) {
            p = backend.printImage(src, max, quality);
            imageCache.current.set(key, p);
          }
          return p;
        },
        readFile: (path) => (design.templateFile?.path === path && tpl ? Promise.resolve(tpl.bytes) : backend.readFile(path)),
        fontLoader: assetFontLoader,
        onProgress,
        signal,
      }).then((bytes) => ({ bytes, numbers: p.pageNumbers }));
    },
    [plan, design, meta, customLabels, backend, tpl],
  );

  // Live preview: re-render shortly after each change.
  useEffect(() => {
    if (!plan || (design.templateFile && !tpl)) return;
    const ctl = new AbortController();
    abort.current?.abort();
    abort.current = ctl;
    const t = setTimeout(() => {
      setRendering({ done: 0, total: 1, message: "Rendering preview" });
      render(quick, ctl.signal, (done, total, message) => !ctl.signal.aborted && setRendering({ done, total, message }))
        .then((b) => !ctl.signal.aborted && setPdf(b))
        .catch((e) => {
          if (!ctl.signal.aborted && e?.name !== "AbortError") toast({ tone: "error", title: "Preview failed", body: String(e) });
        })
        .finally(() => !ctl.signal.aborted && setRendering(null));
    }, 500);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [render, quick, plan, design.templateFile, tpl, toast]);

  const exportPdf = async () => {
    const ctl = new AbortController();
    abort.current?.abort();
    abort.current = ctl;
    setExporting({ done: 0, total: 1, message: "Starting" });
    try {
      const { bytes } = await render(false, ctl.signal, (done, total, message) => setExporting({ done, total, message }));
      const name = `${storeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "catalogue"}-catalogue-${new Date().toISOString().slice(0, 10)}.pdf`;
      setExporting({ done: 1, total: 1, message: "Choose where to save" });
      const path = await backend.saveFile({ defaultName: name, filterName: "PDF document", extension: "pdf", bytes, mime: "application/pdf" });
      if (path) toast({ tone: "success", title: `Catalogue saved · ${plan?.pages.length} pages, ${(bytes.length / 1048576).toFixed(1)} MB`, body: backend.kind === "tauri" ? path : `${path} — check your browser's downloads.` });
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") toast({ tone: "error", title: "Could not create the PDF", body: String(e) });
    } finally {
      setExporting(null);
    }
  };

  /* ---------------------------------------------------------------- files */
  const pick = async (extensions: string[]) => {
    const [f] = await backend.pickFiles({ multiple: false, extensions });
    return f ? { path: f.path, name: f.name } : null;
  };
  const addFont = async () => {
    const f = await pick(["ttf", "otf"]);
    if (!f) return null;
    const next = [...fonts.filter((x) => x.path !== f.path), f];
    setFonts(next);
    store("cf.catalogue.fonts", next);
    return f;
  };
  const chooseTemplate = async () => {
    const f = await pick(["pdf"]);
    if (!f) return;
    try {
      const i = await templateInfo(await backend.readFile(f.path));
      const n = i.pages;
      const pages = n >= 4 ? { cover: 0, index: 1, left: 2, right: 3, back: n >= 5 ? 4 : null } : n === 3 ? { cover: 0, index: 1, left: 2, right: 2, back: null } : n === 2 ? { cover: 0, index: 1, left: 1, right: 1, back: null } : { cover: null, index: 0, left: 0, right: 0, back: null };
      setDesign({ templateFile: f, templatePages: pages });
      toast({ tone: "success", title: `Template loaded · ${n} page${n === 1 ? "" : "s"}`, body: `Pages are ${Math.round(i.size[0] / 2.835)} × ${Math.round(i.size[1] / 2.835)} mm; the catalogue uses that size.` });
    } catch (e) {
      toast({ tone: "error", title: "That PDF can't be used as a template", body: String(e) });
    }
  };

  /* ------------------------------------------------------------- designs */
  const saveDesign = (asNew: boolean) => {
    const name = asNew ? window.prompt("Name this design", `${design.name} copy`)?.trim() : design.name;
    if (!name) return;
    const next = { ...saved, [name]: { ...design, name } };
    setSaved(next);
    store("cf.catalogue.designs", next);
    setDesign({ name });
    toast({ tone: "success", title: `Design “${name}” saved`, body: "Use it again for any store from the design menu." });
  };

  const price = (p: CatProduct) => {
    const f = (n: number | null) => formatPrice(n, symbol, decimals);
    return p.type === "variable" ? (p.min !== null ? `${f(p.min)}+` : "") : f(p.sale ?? p.regular);
  };
  const storeFields = info?.profile.custom_fields ?? [];
  const contentPages = plan?.pages.filter((p) => p.kind === "content").length ?? 0;

  /* ---------------------------------------------------------------- render */
  return (
    <div className="flex h-full min-w-0" data-testid="catalogue-view">
      <aside className="flex w-[452px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <BookOpen size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Catalogue</div>
            <div className="truncate text-xs text-muted">Print-ready PDF of your products, indexed by category</div>
          </div>
          <Select
            value=""
            className="w-36"
            aria-label="Designs"
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__save") saveDesign(false);
              else if (v === "__saveas") saveDesign(true);
              else if (v === "__reset") setDesign(() => ({ ...defaultDesign(storeName), excludedCategories: design.excludedCategories, excludedProducts: design.excludedProducts }));
              else if (v.startsWith("del:")) {
                const name = v.slice(4);
                if (!window.confirm(`Delete the design “${name}”?`)) return;
                const next = { ...saved };
                delete next[name];
                setSaved(next);
                store("cf.catalogue.designs", next);
              } else if (saved[v]) setDesign(() => upgrade(saved[v], storeName));
            }}
          >
            <option value="">{design.name}</option>
            {Object.keys(saved).length > 0 && <optgroup label="Open a saved design">{Object.keys(saved).map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>}
            <optgroup label="Design">
              <option value="__save">Save “{design.name}”</option>
              <option value="__saveas">Save as new design…</option>
              <option value="__reset">Start from defaults</option>
            </optgroup>
            {Object.keys(saved).length > 0 && <optgroup label="Delete">{Object.keys(saved).map((n) => <option key={n} value={`del:${n}`}>Delete “{n}”</option>)}</optgroup>}
          </Select>
        </div>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "content", label: "Products" },
            { id: "layout", label: "Layout" },
            { id: "cover", label: "Cover" },
            { id: "headers", label: "Headers" },
            { id: "styles", label: "Styles" },
            { id: "template", label: "Template" },
          ]}
        />
        <div className="min-h-0 flex-1 overflow-auto" data-testid="catalogue-settings">
          {tab === "content" && (
            <>
              <Section title="What's in the catalogue" hint="Categories become the contents (index). Untick nothing to include everything that's published.">
                {data ? (
                  <ContentTree categories={data.categories} products={data.products} excludedCategories={design.excludedCategories} excludedProducts={design.excludedProducts} onChange={(x) => setDesign(x)} formatPrice={price} />
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{loading}</div>
                )}
              </Section>
              <Section title="Which products">
                <Check checked={design.includeDrafts} onChange={(v) => setDesign({ includeDrafts: v })}>Include drafts and private products</Check>
                <Check checked={design.hideOutOfStock} onChange={(v) => setDesign({ hideOutOfStock: v })}>Leave out products that are out of stock</Check>
                <Check checked={design.includeUncategorised} onChange={(v) => setDesign({ includeUncategorised: v })}>Add uncategorised products under “Other products”</Check>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted">Products in several categories
                    <Select value={design.multiCategory} onChange={(e) => setDesign({ multiCategory: e.target.value as CatalogueDesign["multiCategory"] })}><option value="first">Show once (first category)</option><option value="all">Show in each category</option></Select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted">Order within a category
                    <Select value={design.sort} onChange={(e) => setDesign({ sort: e.target.value as CatalogueDesign["sort"] })}>
                      <option value="menu_order">Store order</option><option value="name">Name A–Z</option><option value="sku">SKU</option><option value="price_asc">Price, low to high</option><option value="price_desc">Price, high to low</option>
                    </Select>
                  </label>
                </div>
              </Section>
              <Section title="Prices" hint="Adjust every price for a trade or wholesale edition, without changing your store.">
                <div className="grid grid-cols-2 gap-3">
                  <NumberInput label="Adjust prices by" suffix="%" value={design.priceAdjust} step={1} min={-95} max={500} onChange={(n) => setDesign({ priceAdjust: n })} />
                  <label className="flex flex-col gap-1 text-xs text-muted">Price label<Input value={design.priceLabel} placeholder="e.g. RRP, Trade" onChange={(e) => setDesign({ priceLabel: e.target.value })} /></label>
                </div>
              </Section>
            </>
          )}

          {tab === "layout" && (
            <>
              <Section title="Product layout">
                <div className="grid grid-cols-4 gap-2">
                  {LAYOUTS.map(([id, label, Icon]) => (
                    <button key={id} onClick={() => setDesign({ layout: id })} data-testid={`layout-${id}`} className={clsx("flex flex-col items-center gap-1 rounded-lg border p-2 text-xs", design.layout === id ? "border-accent bg-accent/5 text-accent" : "border-line text-muted hover:text-fg")}>
                      <Icon size={18} />{label}
                    </button>
                  ))}
                </div>
                {design.layout !== "feature" && design.layout !== "pricelist" && (
                  <div className="grid grid-cols-3 gap-3">
                    {design.layout === "grid" && <NumberInput label="Columns" value={design.columns} min={1} max={6} onChange={(n) => setDesign({ columns: n })} />}
                    <NumberInput label="Rows per page" value={design.rows} min={1} max={8} onChange={(n) => setDesign({ rows: n })} />
                    <NumberInput label="Spacing" suffix="mm" value={design.gap} min={0} max={30} onChange={(n) => setDesign({ gap: n })} />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted">Images
                    <Select value={design.imageFit} onChange={(e) => setDesign({ imageFit: e.target.value as "contain" | "cover" })}><option value="contain">Show whole image</option><option value="cover">Fill the frame (crop)</option></Select>
                  </label>
                  <NumberInput label="Description lines" value={design.descriptionLines} min={0} max={12} onChange={(n) => setDesign({ descriptionLines: n })} />
                </div>
              </Section>
              <Section title="On each product">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {([["image", "Image"], ["price", "Price"], ["sku", "SKU"], ["description", "Short description"], ["attributes", "Attributes (sizes, colours…)"], ["stock", "Stock status"], ["badges", "Sale / featured badges"], ["qr", "QR code to the product page"], ["gtin", "GTIN / barcode number"], ["weight", "Weight"]] as const).map(([k, l]) => (
                    <Check key={k} checked={design.show[k]} onChange={(v) => setDesign((d) => ({ ...d, show: { ...d.show, [k]: v } }))} testId={`show-${k}`}>{l}</Check>
                  ))}
                </div>
                {storeFields.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-muted">Custom fields</div>
                    <div className="flex flex-wrap gap-1.5">
                      {storeFields.map((f) => {
                        const on = design.customFields.includes(f.key);
                        return (
                          <button key={f.key} onClick={() => setDesign((d) => ({ ...d, customFields: on ? d.customFields.filter((k) => k !== f.key) : [...d.customFields, f.key] }))} className={clsx("rounded-full border px-2.5 py-1 text-xs", on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted")}>{f.label || f.key}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Section>
              <Section title="Sections">
                <Check checked={design.newPagePerCategory} onChange={(v) => setDesign({ newPagePerCategory: v })}>Start each category on a new page</Check>
                <Check checked={design.dividerPages} onChange={(v) => setDesign({ dividerPages: v })}>Full-page divider before each main category</Check>
                <Check checked={design.showIndex} onChange={(v) => setDesign({ showIndex: v })} testId="opt-index">Contents page (categories with page numbers)</Check>
                {design.showIndex && (
                  <div className="grid grid-cols-2 gap-3 pl-6">
                    <label className="flex flex-col gap-1 text-xs text-muted">Contents title<Input value={design.indexTitle} onChange={(e) => setDesign({ indexTitle: e.target.value })} /></label>
                    <label className="flex flex-col gap-1 text-xs text-muted">Show levels
                      <Select value={String(design.indexDepth)} onChange={(e) => setDesign({ indexDepth: Number(e.target.value) })}><option value="1">Main categories</option><option value="2">+ sub-categories</option><option value="3">All levels</option></Select>
                    </label>
                  </div>
                )}
                <Check checked={design.azIndex} onChange={(v) => setDesign({ azIndex: v })}>A–Z product index at the back</Check>
                <Check checked={design.backCover} onChange={(v) => setDesign({ backCover: v })}>Back cover</Check>
              </Section>
              <Section title="Page">
                <div className="grid grid-cols-3 gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted">Size
                    <Select value={design.pageSize} disabled={!!design.templateFile} onChange={(e) => setDesign({ pageSize: e.target.value as PageSize })}>{Object.keys(PAGE_SIZES).map((s) => <option key={s}>{s}</option>)}</Select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted">Orientation
                    <Select value={design.landscape ? "l" : "p"} disabled={!!design.templateFile} onChange={(e) => setDesign({ landscape: e.target.value === "l" })}><option value="p">Portrait</option><option value="l">Landscape</option></Select>
                  </label>
                  <NumberInput label="Margins" suffix="mm" value={design.margin} min={3} max={40} onChange={(n) => setDesign({ margin: n })} />
                </div>
                {design.templateFile && <p className="text-2xs text-muted">Page size comes from your template PDF.</p>}
              </Section>
            </>
          )}

          {tab === "cover" && (
            <>
              <Section title="Cover" hint={<>All cover text is editable. Use {TOKENS.filter((t) => !["{page}", "{pages}", "{category}"].includes(t)).map((t) => <code key={t} className="mx-0.5">{t}</code>)} to fill in store details.</>}>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted">Background <ColorInput value={design.coverBackground} onChange={(v) => setDesign({ coverBackground: v })} /></label>
                  <FilePickButton label="Cover image" file={design.coverImage} onPick={async () => setDesign({ coverImage: await pick(["jpg", "jpeg", "png", "webp"]) ?? design.coverImage })} onClear={() => setDesign({ coverImage: null })} />
                  <FilePickButton label="Logo" file={design.logo} onPick={async () => setDesign({ logo: await pick(["png", "jpg", "jpeg", "webp"]) ?? design.logo })} onClear={() => setDesign({ logo: null })} />
                </div>
                {design.coverImage && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs text-muted">Image strength ({Math.round(design.coverImageOpacity * 100)}%)<input type="range" min={10} max={100} value={design.coverImageOpacity * 100} onChange={(e) => setDesign({ coverImageOpacity: Number(e.target.value) / 100 })} /></label>
                    <Check checked={design.coverOverlay} onChange={(v) => setDesign({ coverOverlay: v })}>Tint the top half for readable text</Check>
                  </div>
                )}
                {design.logo && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs text-muted">Logo width ({design.logoWidth}% of page)<input type="range" min={5} max={90} value={design.logoWidth} onChange={(e) => setDesign({ logoWidth: Number(e.target.value) })} /></label>
                    <label className="flex flex-col gap-1 text-xs text-muted">Logo position ({design.logoY}% from top)<input type="range" min={0} max={90} value={design.logoY} onChange={(e) => setDesign({ logoY: Number(e.target.value) })} /></label>
                  </div>
                )}
              </Section>
              <TextBlocks title="Cover text" texts={design.coverTexts} onChange={(coverTexts) => setDesign({ coverTexts })} fonts={fonts} addFont={addFont} testId="cover-texts" />
              {design.backCover && <TextBlocks title="Back cover text" texts={design.backTexts} onChange={(backTexts) => setDesign({ backTexts })} fonts={fonts} addFont={addFont} hint="A QR code to your website is added automatically." />}
            </>
          )}

          {tab === "headers" && (
            <>
              <HeaderFooterEditor title="Header" value={design.header} onChange={(header) => setDesign({ header })} fonts={fonts} addFont={addFont} />
              <HeaderFooterEditor title="Footer" value={design.footer} onChange={(footer) => setDesign({ footer })} fonts={fonts} addFont={addFont} />
            </>
          )}

          {tab === "styles" && (
            <>
              <Section title="Theme" hint="Starting points; every colour and font below stays editable.">
                <div className="grid grid-cols-4 gap-2">
                  {Object.keys(THEMES).map((t) => (
                    <button key={t} onClick={() => setDesign((d) => THEMES[t](d))} className="rounded-lg border border-line px-2 py-2 text-xs hover:border-accent hover:text-accent" data-testid={`theme-${t}`}>{t}</button>
                  ))}
                </div>
              </Section>
              <Section title="Colours">
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted">Accent <ColorInput value={design.accent} onChange={(v) => setDesign({ accent: v })} /></label>
                  <label className="flex items-center gap-2 text-xs text-muted">Page <ColorInput value={design.pageBackground} onChange={(v) => setDesign({ pageBackground: v })} /></label>
                  <label className="flex items-center gap-2 text-xs text-muted">Product cards <ColorInput value={design.cardBackground} onChange={(v) => setDesign({ cardBackground: v })} /></label>
                </div>
                <div className="flex gap-4">
                  <Check checked={design.cardBorder} onChange={(v) => setDesign({ cardBorder: v })}>Card outline</Check>
                  <Check checked={design.rounded} onChange={(v) => setDesign({ rounded: v })}>Rounded corners</Check>
                </div>
              </Section>
              <Section title="Text">
                <TextStyleEditor label="Category headings" value={design.categoryHeading} onChange={(categoryHeading) => setDesign({ categoryHeading })} fonts={fonts} onAddFont={addFont} />
                <TextStyleEditor label="Product names" value={design.productName} onChange={(productName) => setDesign({ productName })} fonts={fonts} onAddFont={addFont} align={false} />
                <TextStyleEditor label="Prices" value={design.price} onChange={(price) => setDesign({ price })} fonts={fonts} onAddFont={addFont} align={false} />
                <TextStyleEditor label="Descriptions and details" value={design.body} onChange={(body) => setDesign({ body })} fonts={fonts} onAddFont={addFont} align={false} />
              </Section>
              <Section title="Finishing">
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted">Watermark<Input value={design.watermark} placeholder="e.g. DRAFT, Trade only" onChange={(e) => setDesign({ watermark: e.target.value })} /></label>
                  <label className="flex flex-col gap-1 text-xs text-muted">Image quality
                    <Select value={design.imageQuality} onChange={(e) => setDesign({ imageQuality: e.target.value as "screen" | "print" })}><option value="print">Print (sharp, larger file)</option><option value="screen">Screen and email (small file)</option></Select>
                  </label>
                </div>
                <Check checked={design.links} onChange={(v) => setDesign({ links: v })}>Clickable links: products open on your store, contents jump to pages</Check>
              </Section>
            </>
          )}

          {tab === "template" && (
            <Section title="PDF template" hint="Design pages in Canva, InDesign, Word or any tool and export them as one PDF. Each page is used as the background for one kind of page; your products are laid over it.">
              <div className="flex items-center gap-2">
                <Button size="sm" icon={<FileText size={13} />} onClick={chooseTemplate} data-testid="template-pick">{design.templateFile ? "Choose another PDF…" : "Choose template PDF…"}</Button>
                {design.templateFile && (
                  <>
                    <span className="min-w-0 flex-1 truncate text-xs">{design.templateFile.name}{tpl && ` · ${tpl.pages} pages`}</span>
                    <Button size="sm" variant="close" icon={<X size={13} />} onClick={() => setDesign({ templateFile: null })}>Remove</Button>
                  </>
                )}
              </div>
              {design.templateFile && tpl && (
                <>
                  <div className="space-y-2">
                    {([["cover", "Cover"], ["index", "Contents and index pages"], ["left", "Left-hand product pages"], ["right", "Right-hand product pages"], ["back", "Back cover"]] as const).map(([role, label]) => (
                      <label key={role} className="flex items-center justify-between gap-2 text-[13px]">
                        {label}
                        <Select className="w-40" value={design.templatePages[role] === null ? "" : String(design.templatePages[role])} onChange={(e) => setDesign((d) => ({ ...d, templatePages: { ...d.templatePages, [role]: e.target.value === "" ? null : Number(e.target.value) } }))} data-testid={`template-role-${role}`}>
                          <option value="">No template page</option>
                          {Array.from({ length: tpl.pages }, (_, i) => <option key={i} value={i}>Template page {i + 1}</option>)}
                        </Select>
                      </label>
                    ))}
                  </div>
                  <p className="text-2xs text-muted">Tip: keep the areas where products go plain. Set Layout → Margins so products clear your design's borders, and turn off the header or footer if your template has its own.</p>
                  <div className="rounded-md bg-sunken"><PdfPreview bytes={tpl.bytes} spread={false} width={120} testId="template-preview" /></div>
                </>
              )}
              {!design.templateFile && (
                <div className="rounded-md border border-dashed border-line p-3 text-xs text-muted">
                  A four-page template works best: <b>1</b> cover, <b>2</b> contents, <b>3</b> left-hand page, <b>4</b> right-hand page (and optionally <b>5</b> back cover). Single pages are reused where needed.
                </div>
              )}
            </Section>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-sunken">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
          {plan ? (
            <div className="flex items-center gap-1.5 text-xs text-muted" data-testid="catalogue-stats">
              <Badge tone="accent">{plan.productCount.toLocaleString()} products</Badge>
              <Badge>{plan.toc.filter((t) => t.depth === 0).length} categories</Badge>
              <Badge>{plan.pages.length} pages</Badge>
              {quick && contentPages > 8 && <span>· preview draws the first 8 product pages</span>}
            </div>
          ) : (
            <span className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{loading}</span>
          )}
          <span className="flex-1" />
          {rendering && <span className="flex items-center gap-1.5 text-xs text-muted"><Loader2 size={12} className="animate-spin" />{rendering.message}{rendering.total > 1 && ` ${Math.round((rendering.done / rendering.total) * 100)}%`}</span>}
          <label className="flex items-center gap-1.5 text-xs text-muted" title="Draw only the first product pages while you design">
            <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} /> Quick preview
          </label>
          <Button size="sm" variant={spread ? "primary" : "ghost"} icon={<Columns2 size={14} />} onClick={() => setSpread(!spread)} title="Show facing pages as printed">Spreads</Button>
          <input type="range" min={160} max={560} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24" aria-label="Zoom" />
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => setDesign((d) => ({ ...d }))} title="Render the preview again">Refresh</Button>
          <Button size="sm" variant="primary" icon={exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} disabled={!plan || !!exporting || plan.productCount === 0} onClick={exportPdf} data-testid="catalogue-export">
            {exporting ? `${exporting.message}${exporting.total > 1 ? ` ${Math.round((exporting.done / exporting.total) * 100)}%` : ""}` : "Create PDF…"}
          </Button>
          {exporting && <Button size="sm" variant="close" onClick={() => abort.current?.abort()}>Cancel</Button>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {plan && plan.productCount === 0 ? (
            <div className="p-10 text-center text-sm text-muted">No products are included. Check the Products tab: everything may be left out, or only drafts exist.</div>
          ) : (
            <PdfPreview bytes={pdf?.bytes ?? null} numbers={pdf?.numbers} spread={spread} width={zoom} />
          )}
        </div>
      </section>
    </div>
  );
}

function FilePickButton({ label, file, onPick, onClear }: { label: string; file: { name: string } | null; onPick: () => void; onClear: () => void }) {
  return file ? (
    <span className="flex h-8 items-center gap-1 rounded-md border border-line px-2 text-xs">
      <ImagePlus size={13} className="text-muted" /><span className="max-w-[110px] truncate">{file.name}</span>
      <button onClick={onClear} className="cf-close rounded p-0.5" aria-label={`Remove ${label}`}><X size={12} /></button>
    </span>
  ) : (
    <Button size="sm" icon={<ImagePlus size={13} />} onClick={onPick}>{label}…</Button>
  );
}

function TextBlocks({ title, texts, onChange, fonts, addFont, hint, testId }: { title: string; texts: CoverText[]; onChange: (t: CoverText[]) => void; fonts: FileFont[]; addFont: () => Promise<FileFont | null>; hint?: string; testId?: string }) {
  const update = (i: number, p: Partial<CoverText>) => onChange(texts.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return (
    <Section title={title} hint={hint}>
      <div className="space-y-4" data-testid={testId}>
        {texts.map((t, i) => (
          <div key={t.id} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <input value={t.label} onChange={(e) => update(i, { label: e.target.value })} className="min-w-0 flex-1 bg-transparent text-xs font-semibold uppercase tracking-wide text-muted outline-none" aria-label="Text name" />
              <label className="flex items-center gap-1.5 text-2xs text-muted">Position {Math.round(t.y)}%
                <input type="range" min={0} max={97} value={t.y} onChange={(e) => update(i, { y: Number(e.target.value) })} className="w-24" aria-label={`${t.label} position`} />
              </label>
              <button onClick={() => onChange(texts.filter((_, j) => j !== i))} className="cf-close rounded p-0.5" aria-label={`Remove ${t.label}`}><Trash2 size={13} /></button>
            </div>
            <TextArea value={t.text} rows={Math.min(4, t.text.split("\n").length + 1)} onChange={(e) => update(i, { text: e.target.value })} data-testid={`${testId ?? "texts"}-${t.id}`} />
            <TextStyleEditor value={t.style} onChange={(s) => update(i, { style: s })} fonts={fonts} onAddFont={addFont} />
          </div>
        ))}
        <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...texts, { id: `t${Date.now().toString(36)}`, label: "Text", text: "", style: style({ size: 14, color: "#ffffff", align: "center" }), y: Math.min(95, (texts[texts.length - 1]?.y ?? 50) + 8) }])}>Add text</Button>
      </div>
    </Section>
  );
}

function HeaderFooterEditor({ title, value, onChange, fonts, addFont }: { title: string; value: HeaderFooter; onChange: (v: HeaderFooter) => void; fonts: FileFont[]; addFont: () => Promise<FileFont | null> }) {
  const set = (p: Partial<HeaderFooter>) => onChange({ ...value, ...p });
  return (
    <Section title={title} hint={<>Shown on product, contents and index pages. Tokens: {TOKENS.map((t) => <code key={t} className="mx-0.5">{t}</code>)}</>}>
      <Check checked={value.enabled} onChange={(v) => set({ enabled: v })} testId={`${title.toLowerCase()}-enabled`}>Show {title.toLowerCase()}</Check>
      {value.enabled && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {(["left", "center", "right"] as const).map((slot) => (
              <label key={slot} className="flex flex-col gap-1 text-xs capitalize text-muted">{slot}<Input value={value[slot]} onChange={(e) => set({ [slot]: e.target.value })} data-testid={`${title.toLowerCase()}-${slot}`} /></label>
            ))}
          </div>
          <TextStyleEditor value={value.style} onChange={(s) => set({ style: s })} fonts={fonts} onAddFont={addFont} align={false} />
          <div className="flex flex-wrap items-center gap-4">
            <Check checked={value.line} onChange={(v) => set({ line: v })}>Divider line</Check>
            {value.line && <ColorInput value={value.lineColor} onChange={(lineColor) => set({ lineColor })} label="Line colour" />}
            <Check checked={value.mirror} onChange={(v) => set({ mirror: v })}>Mirror on left-hand pages</Check>
          </div>
        </>
      )}
    </Section>
  );
}

