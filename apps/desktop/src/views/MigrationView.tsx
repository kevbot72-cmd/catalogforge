import { AlertTriangle, ArrowLeftRight, ArrowRight, CheckCircle2, ClipboardCheck, Loader2, MoveRight, PackageCheck, Plus, RefreshCw, Truck, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CategoryRow, MigrateOptions, MigrationSummary, StoreInfo, VerifyReport } from "../backend/types";
import { CategoryPicker } from "../components/fields";
import { Badge, Button, clsx, Select, Toggle } from "../components/ui";
import { useApp } from "../store/app";

const DEFAULTS: MigrateOptions = { existing: "skip", status: null, include_images: true, include_drafts: true, include_custom_fields: true, include_empty_categories: true, category_ids: [] };

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...(JSON.parse(v) as T) } : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* not remembered */
  }
};

function Step({ n, title, done, children, testId }: { n: number; title: string; done?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-panel p-4" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className={clsx("flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-2xs font-medium text-white", done ? "bg-added" : "bg-accent")}>{done ? "✓" : n}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function StoreCard({ info, role }: { info: StoreInfo | null; role: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line p-3">
      <div className="text-2xs font-semibold uppercase tracking-wide text-muted">{role}</div>
      {info ? (
        <>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: info.profile.color || "#888" }} />
            <span className="truncate text-[15px] font-semibold">{info.profile.name}</span>
            <Badge tone={info.profile.environment === "production" ? "removed" : "accent"}>{info.profile.environment === "production" ? "LIVE" : info.profile.environment}</Badge>
          </div>
          <div className="mt-1 text-xs text-muted">
            {info.product_count.toLocaleString()} products · {info.profile.connection.kind}
            {info.handshake?.currency ? ` · ${info.handshake.currency}` : ""}
            {info.handshake?.home_url ? ` · ${info.handshake.home_url.replace(/^https?:\/\//, "")}` : ""}
          </div>
        </>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted"><Loader2 size={12} className="animate-spin" /> Opening…</div>
      )}
    </div>
  );
}

function Stat({ value, label, tone }: { value: number | string; label: string; tone?: "added" | "changed" | "muted" }) {
  return (
    <div className="min-w-[120px] rounded-lg bg-sunken px-3 py-2">
      <div className={clsx("text-lg font-semibold tabular-nums", tone === "added" && "text-added", tone === "changed" && "text-changed", tone === "muted" && "text-muted")}>{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="text-2xs text-muted">{label}</div>
    </div>
  );
}

/** Move a whole catalogue from one store into another (usually a new, empty one). */
export function MigrationView() {
  const { backend, stores, storeId, selectStore, push, summary, busy, openDialog, toast, version } = useApp();
  const [src, setSrc] = useState<string>(() => load("cf.migration.stores", { src: storeId ?? "", dst: "" }).src || storeId || "");
  const [dst, setDst] = useState<string>(() => load("cf.migration.stores", { src: "", dst: "" }).dst);
  const [opts, setOptsState] = useState<MigrateOptions>(() => load("cf.migration.options", DEFAULTS));
  const [infos, setInfos] = useState<Record<string, StoreInfo | null>>({});
  const [srcCats, setSrcCats] = useState<CategoryRow[]>([]);
  const [preview, setPreview] = useState<MigrationSummary | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [staged, setStaged] = useState<MigrationSummary | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [copyFields, setCopyFields] = useState(true);
  const [scope, setScope] = useState<"all" | "some">(opts.category_ids.length ? "some" : "all");

  const setOpts = (p: Partial<MigrateOptions>) => {
    const next = { ...opts, ...p };
    setOptsState(next);
    save("cf.migration.options", next);
  };
  useEffect(() => save("cf.migration.stores", { src, dst }), [src, dst]);
  // A sensible destination: the first other store.
  useEffect(() => {
    if (!dst || dst === src) setDst(stores.find((s) => s.id !== src)?.id ?? "");
  }, [src, dst, stores]);

  /** Opens a store (downloading its catalogue the first time) and returns its info. */
  const ready = useCallback(async (id: string, refresh = false) => {
    let info = await backend.openStore(id);
    if (refresh || (!info.product_count && !info.last_pull)) {
      await backend.pull(id, !info.last_pull);
      info = await backend.openStore(id);
    }
    setInfos((m) => ({ ...m, [id]: info }));
    return info;
  }, [backend]);

  useEffect(() => {
    if (!src || !dst || src === dst) return;
    let cancelled = false;
    setInfos((m) => ({ ...m, [src]: m[src] ?? null, [dst]: m[dst] ?? null }));
    (async () => {
      await Promise.all([ready(src), ready(dst)]);
      const tax = await backend.taxonomy(src);
      if (!cancelled) setSrcCats(tax.categories);
    })().catch((e) => toast({ tone: "error", title: "Couldn't open a store", body: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [src, dst, ready, backend, toast]);

  const effective = useMemo(() => ({ ...opts, category_ids: scope === "all" ? [] : opts.category_ids }), [opts, scope]);
  const bothReady = !!(src && dst && src !== dst && infos[src] && infos[dst]);
  // Pre-flight runs whenever the stores or options change.
  useEffect(() => {
    if (!bothReady) return;
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      backend
        .migrationPreview(src, dst, effective)
        .then((p) => !cancelled && setPreview(p))
        .catch((e) => !cancelled && toast({ tone: "error", title: "Pre-flight check failed", body: String(e) }))
        .finally(() => !cancelled && setPreviewing(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bothReady, src, dst, effective, backend, toast, staged, version]);

  const srcInfo = infos[src] ?? null;
  const dstInfo = infos[dst] ?? null;
  const dstWritable = dstInfo?.capabilities.write ?? true;
  const urlOnly = dstInfo?.capabilities.media_by_url_only;
  const srcIsLocal = srcInfo?.profile.connection.kind === "local" || /\.(local|test)\b|localhost|127\.0\.0\.1/.test(srcInfo?.handshake?.home_url ?? "");
  const blockers = [!dstWritable && `${dstInfo?.profile.name} is connected read-only. Connect it with the CatalogForge Connector to write to it.`].filter(Boolean) as string[];
  const notes = [
    urlOnly && opts.include_images && `${dstInfo?.profile.name} uses the WooCommerce REST API, which can only fetch images from public web addresses${srcIsLocal ? ", and this source is on your computer, so its images can't be copied that way" : ""}. Connect it with the CatalogForge Connector to copy images reliably.`,
  ].filter(Boolean) as string[];
  const nothing = preview && preview.products_create + preview.products_update + preview.categories_create === 0;

  const refresh = async () => {
    setWorking("Refreshing both stores");
    try {
      await Promise.all([ready(src, true), ready(dst, true)]);
    } finally {
      setWorking(null);
    }
  };

  const prepare = async () => {
    setWorking("Preparing the migration");
    try {
      const s = await backend.migrationStage(src, dst, effective);
      if (copyFields && opts.include_custom_fields && srcInfo?.profile.custom_fields?.length) {
        const have = new Set((dstInfo?.profile.custom_fields ?? []).map((f) => f.key));
        const merged = [...(dstInfo?.profile.custom_fields ?? []), ...srcInfo.profile.custom_fields.filter((f) => !have.has(f.key))];
        await backend.setCustomFields(dst, merged);
      }
      setStaged(s);
      setReport(null);
      // Work in the destination from here: its Changes and Push show the migration.
      if (storeId !== dst) await selectStore(dst);
      useApp.setState({ view: "migration" });
      toast({ tone: "success", title: `Migration ready in ${dstInfo?.profile.name}`, body: `${s.products_create.toLocaleString()} products, ${s.variations.toLocaleString()} variations and ${s.categories_create} categories are staged. Review them, then Push.` });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't prepare the migration", body: String(e) });
    } finally {
      setWorking(null);
    }
  };

  const verify = async () => {
    setWorking("Checking the result");
    try {
      await ready(dst, true);
      setReport(await backend.migrationVerify(src, dst, effective));
    } catch (e) {
      toast({ tone: "error", title: "Check failed", body: String(e) });
    } finally {
      setWorking(null);
    }
  };

  const pending = storeId === dst ? summary.created + summary.modified + summary.deleted : 0;
  const pushed = !!staged && storeId === dst && pending === 0 && !busy;

  if (stores.length < 2) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md space-y-3 text-center">
          <Truck size={28} className="mx-auto text-accent" />
          <h1 className="text-lg font-semibold">Migration needs two stores</h1>
          <p className="text-[13px] text-muted">Connect the store you're moving to (a new, empty WooCommerce store) as a second store. Then come back here to move your categories, products, variations, images and custom fields across.</p>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => openDialog("add-store")}>Add a store</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-sunken" data-testid="migration-view">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Truck size={20} className="text-accent" /> Migration</h1>
          <p className="text-[13px] text-muted">Move your catalogue from one store into another, usually a new, empty store. Everything is staged first, so you can review it before pushing, undo it, and run it again safely.</p>
        </header>

        <Step n={1} title="From and to" done={bothReady} testId="migration-stores">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-muted">Move from
              <Select value={src} onChange={(e) => { setSrc(e.target.value); setStaged(null); setReport(null); }} data-testid="migration-src">
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </label>
            <Button variant="ghost" icon={<ArrowLeftRight size={14} />} onClick={() => { setSrc(dst); setDst(src); setStaged(null); setReport(null); }} title="Swap">Swap</Button>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-muted">Move to
              <Select value={dst} onChange={(e) => { setDst(e.target.value); setStaged(null); setReport(null); }} data-testid="migration-dst">
                {stores.filter((s) => s.id !== src).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </label>
            <Button variant="ghost" icon={<Plus size={14} />} onClick={() => openDialog("add-store")}>Add a store</Button>
          </div>
          <div className="flex flex-wrap items-stretch gap-3">
            <StoreCard info={srcInfo} role="From" />
            <div className="flex items-center text-muted"><MoveRight size={20} /></div>
            <StoreCard info={dstInfo} role="To" />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={clsx(working === "Refreshing both stores" && "animate-spin")} />} onClick={refresh} disabled={!bothReady || !!working}>Refresh both stores</Button>
            Re-reads both catalogues so the check below is up to date.
          </div>
        </Step>

        <Step n={2} title="What to move" testId="migration-options">
          <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
            <Toggle checked={opts.include_images} onChange={(v) => setOpts({ include_images: v })} label="Images (product, gallery and category images)" />
            <Toggle checked={opts.include_drafts} onChange={(v) => setOpts({ include_drafts: v })} label="Draft and private products too" />
            <Toggle checked={opts.include_custom_fields} onChange={(v) => setOpts({ include_custom_fields: v })} label="Custom fields (from Settings → Custom fields)" />
            <Toggle checked={opts.include_empty_categories} onChange={(v) => setOpts({ include_empty_categories: v })} label="Categories that have no products" />
            {opts.include_custom_fields && (srcInfo?.profile.custom_fields?.length ?? 0) > 0 && (
              <Toggle checked={copyFields} onChange={setCopyFields} label="Set up the same custom fields on the destination" />
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted">Products whose SKU is already in the destination
              <Select value={opts.existing} onChange={(e) => setOpts({ existing: e.target.value as MigrateOptions["existing"] })} data-testid="migration-existing">
                <option value="skip">Leave them alone (safe to run again)</option>
                <option value="update">Update them from the source</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">Product status in the destination
              <Select value={opts.status ?? ""} onChange={(e) => setOpts({ status: e.target.value || null })} data-testid="migration-status">
                <option value="">Keep each product's status</option>
                <option value="draft">Make everything a draft (check before going live)</option>
                <option value="publish">Publish everything</option>
              </Select>
            </label>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5"><input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> The whole catalogue</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={scope === "some"} onChange={() => setScope("some")} data-testid="migration-scope-some" /> Only some categories</label>
            </div>
            {scope === "some" && (
              <div className="max-w-lg">
                <CategoryPicker categories={srcCats} value={opts.category_ids} onChange={(v) => setOpts({ category_ids: v.map(Number).filter((n) => Number.isFinite(n)) })} />
                <p className="mt-1 text-2xs text-muted">Ticked categories move with all their sub-categories and products.</p>
              </div>
            )}
          </div>
        </Step>

        <Step n={3} title="Pre-flight check" done={!!preview && !blockers.length} testId="migration-preview">
          {!preview || !bothReady ? (
            <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> Reading both stores…</div>
          ) : (
            <>
              <div className={clsx("flex flex-wrap gap-2 transition-opacity", previewing && "opacity-60")} data-testid="migration-stats">
                <Stat value={preview.products_create} label="products to create" tone="added" />
                {preview.products_update > 0 && <Stat value={preview.products_update} label="products to update" tone="changed" />}
                {preview.products_skip > 0 && <Stat value={preview.products_skip} label="already there (skipped)" tone="muted" />}
                {preview.already_staged > 0 && <Stat value={preview.already_staged} label="already staged, not pushed" tone="changed" />}
                <Stat value={preview.variations} label="variations" />
                <Stat value={preview.categories_create} label={`categories to create${preview.categories_existing ? ` (${preview.categories_existing} exist)` : ""}`} />
                <Stat value={preview.images} label="images to copy" />
                <Stat value={preview.tags} label="tags" />
              </div>
              {(preview.attributes.length > 0 || preview.custom_fields.length > 0) && (
                <div className="space-y-1 text-xs text-muted">
                  {preview.attributes.length > 0 && <div><b className="text-fg">Attributes:</b> {preview.attributes.join(", ")}</div>}
                  {preview.custom_fields.length > 0 && <div><b className="text-fg">Custom fields:</b> {preview.custom_fields.join(", ")}</div>}
                </div>
              )}
              <ul className="space-y-1.5" data-testid="migration-warnings">
                {blockers.map((w) => <li key={w} className="flex gap-2 rounded-md bg-removed/10 px-3 py-2 text-[13px] text-removed"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{w}</li>)}
                {[...preview.warnings, ...notes].map((w) => <li key={w} className="flex gap-2 rounded-md bg-changed/10 px-3 py-2 text-[13px] text-changed"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{w}</li>)}
                {!blockers.length && !preview.warnings.length && !notes.length && <li className="flex gap-2 rounded-md bg-added/10 px-3 py-2 text-[13px] text-added"><CheckCircle2 size={15} className="mt-0.5 shrink-0" />No problems found.</li>}
              </ul>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">What is and isn't moved</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div><b className="text-fg">Moved:</b> categories (hierarchy, descriptions, images, order, SEO), products (prices, sale dates, stock, sizes, tax and shipping classes, descriptions, SEO, featured, visibility), variations, global and custom attributes, tags, product and gallery images (downloaded by this app and uploaded fresh, so they work even from a Local site), custom fields. Each product remembers where it came from.</div>
                  <div><b className="text-fg">Not moved:</b> orders, customers, coupons, reviews, pages and posts, menus, theme and store settings (shipping zones, tax rates, payment methods). Up-sells and cross-sells are not linked yet.</div>
                </div>
              </details>
            </>
          )}
        </Step>

        <Step n={4} title="Prepare and push" done={pushed} testId="migration-run">
          {!staged ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={working === "Preparing the migration" ? <Loader2 size={14} className="animate-spin" /> : <PackageCheck size={15} />} disabled={!preview || !!blockers.length || !!working || !!nothing} onClick={prepare} data-testid="migration-prepare">
                  {nothing ? "Nothing to move" : `Prepare: ${preview ? (preview.products_create + preview.products_update).toLocaleString() : "…"} products into ${dstInfo?.profile.name ?? "…"}`}
                </Button>
              </div>
              <p className="text-xs text-muted">This stages the whole migration in {dstInfo?.profile.name ?? "the destination"} as one step. Nothing is written until you push, and one Undo removes it all.</p>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md bg-accent/5 px-3 py-2 text-[13px]">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
                <div>
                  <b>Staged in {dstInfo?.profile.name}:</b> {staged.products_create.toLocaleString()} new products{staged.products_update ? `, ${staged.products_update.toLocaleString()} updates` : ""}, {staged.variations.toLocaleString()} variations, {staged.categories_create} categories and {staged.images} images.
                  {storeId === dst && pending > 0 && <> Review them in Products or the Changes panel, or push now. Large catalogues take a while: about 50 products a second plus images, with progress at the top.</>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {storeId === dst && pending > 0 && <Button variant="primary" icon={<Upload size={14} />} onClick={() => push(`Migration from ${srcInfo?.profile.name}`)} disabled={!!busy} data-testid="migration-push">Push {pending.toLocaleString()} changes to {dstInfo?.profile.name}</Button>}
                {busy && <span className="flex items-center gap-1.5 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{busy}</span>}
                <Button variant="ghost" icon={<ArrowRight size={14} />} onClick={() => useApp.getState().setView("products")}>Review in Products</Button>
              </div>
            </div>
          )}
        </Step>

        <Step n={5} title="Check the result" done={!!report && report.missing.length === 0 && report.differences.length === 0 && report.images_missing === 0} testId="migration-verify">
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={working === "Checking the result" ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={15} />} onClick={verify} disabled={!bothReady || !!working || (storeId === dst && pending > 0)} data-testid="migration-check">Compare the two stores</Button>
            <span className="text-xs text-muted">{storeId === dst && pending > 0 ? "Push first, then compare." : "Re-reads the destination and checks every product with a SKU arrived, with the same price and stock."}</span>
          </div>
          {report && (
            <div className="space-y-2" data-testid="migration-report">
              <div className="h-2 overflow-hidden rounded-full bg-sunken">
                <div className="h-full bg-added" style={{ width: `${report.checked ? (report.matched / report.checked) * 100 : 0}%` }} />
              </div>
              <div className="text-[13px]"><b>{report.matched.toLocaleString()}</b> of {report.checked.toLocaleString()} products and variations are in {dstInfo?.profile.name}.{report.missing.length === 0 && report.differences.length === 0 && report.images_missing === 0 && <span className="text-added"> Everything matches.</span>}</div>
              {report.missing.length > 0 && (
                <details open className="text-xs">
                  <summary className="cursor-pointer font-medium text-changed">{report.missing.length.toLocaleString()} not found in the destination</summary>
                  <div className="mt-1 max-h-40 overflow-auto rounded border border-line p-2 font-mono text-2xs text-muted">{report.missing.slice(0, 300).map(([sku, name]) => `${sku}  ${name}`).join("\n")}</div>
                  <p className="mt-1 text-muted">Run the migration again (with “Leave them alone”) to add just these.</p>
                </details>
              )}
              {report.differences.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-changed">{report.differences.length.toLocaleString()} differences</summary>
                  <table className="mt-1 w-full text-2xs">
                    <tbody>{report.differences.slice(0, 100).map(([sku, f, a, b], i) => <tr key={i} className="border-t border-line"><td className="py-0.5 pr-2 font-mono">{sku}</td><td className="pr-2">{f}</td><td className="pr-2 text-removed">{a || "—"}</td><td className="text-added">{b || "—"}</td></tr>)}</tbody>
                  </table>
                </details>
              )}
              {report.images_missing > 0 && <div className="text-xs text-changed">{report.images_missing} products arrived without their main image. Check the push report in History for image errors.</div>}
            </div>
          )}
        </Step>
      </div>
    </div>
  );
}
