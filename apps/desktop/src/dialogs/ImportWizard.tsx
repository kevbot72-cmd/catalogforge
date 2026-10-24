import { AlertCircle, AlertTriangle, CheckCircle2, FileSpreadsheet, FolderOpen, Images, Info, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { LocalFile, Product } from "../backend/types";
import { isTauri, readLocalFile } from "../backend/tauri";
import { Badge, Button, clsx, Dropzone, Field, Input, Modal, Select, Toggle } from "../components/ui";
import { autoMap, buildPlan, fieldDefs, imagePaths, parseCsv, parseFile, planToStaging, type ColumnMapping, type ImportConfig, type Plan, type Sheet } from "../lib/importer";
import { useApp } from "../store/app";

type Step = "source" | "map" | "review";
const SHEET_EXT = ["csv", "tsv", "txt", "xlsx", "xls", "ods", "json"];

function loadProfiles(): Record<string, ImportConfig & { signature: string }> {
  try {
    return JSON.parse(localStorage.getItem("cf.importProfiles") ?? "{}");
  } catch {
    return {};
  }
}

export function ImportWizard() {
  const { dialog, openDialog, backend, storeId, taxonomy, create, stage, setQuery, toast, info } = useApp();
  const customFields = info?.profile.custom_fields;
  const FIELDS = fieldDefs(customFields);
  const open = dialog === "import";
  const [step, setStep] = useState<Step>("source");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [fileName, setFileName] = useState("");
  const [images, setImages] = useState<LocalFile[]>([]);
  const [cfg, setCfg] = useState<ImportConfig | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [existing, setExisting] = useState<Map<string, Product>>(new Map());
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileApplied, setProfileApplied] = useState<string | null>(null);
  const sheet = sheets[sheetIdx];

  useEffect(() => {
    if (!open) {
      setStep("source");
      setSheets([]);
      setImages([]);
      setPlan(null);
      setCfg(null);
      setFileName("");
      setPaste("");
      setProfileApplied(null);
    }
  }, [open]);

  useEffect(() => {
    if (!sheet) return;
    const signature = sheet.columns.join("|").toLowerCase();
    const saved = Object.entries(loadProfiles()).find(([, p]) => p.signature === signature);
    if (saved) {
      const { signature: _s, ...rest } = saved[1];
      void _s;
      setCfg(rest);
      setProfileApplied(saved[0]);
      setProfileName(saved[0]);
    } else {
      setCfg(autoMap(sheet, customFields));
      setProfileApplied(null);
    }
  }, [sheet]);

  const loadSheetFile = async (f: LocalFile, raw?: File) => {
    setBusy(true);
    try {
      const file = raw ?? (f as LocalFile & { file?: File }).file ?? (isTauri() ? await readLocalFile(f.path, f.name) : null);
      if (!file) throw new Error("Could not read the file");
      const parsed = await parseFile(file);
      if (!parsed.length || !parsed[0].rows.length) throw new Error("No rows found in that file");
      setSheets(parsed);
      setSheetIdx(0);
      setFileName(f.name);
    } catch (e) {
      toast({ tone: "error", title: "Could not read spreadsheet", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (files: LocalFile[], raw: File[]) => {
    const sheetFile = files.findIndex((f) => SHEET_EXT.includes(f.name.split(".").pop()!.toLowerCase()));
    const imgs = files.filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name));
    if (imgs.length) setImages((cur) => [...cur, ...imgs.filter((i) => !cur.some((c) => c.path === i.path))]);
    if (sheetFile >= 0) loadSheetFile(files[sheetFile], raw[sheetFile]);
  };

  const buildReview = async () => {
    if (!sheet || !cfg || !storeId) return;
    setBusy(true);
    try {
      // Index existing SKUs so imports update instead of duplicating; load full rows only for matches.
      const index = await backend.skus(storeId);
      const skuToId = new Map(index.map(([sku, id, type]) => [sku, { id, type }]));
      const fileSkus = new Set<string>();
      const skuCols = cfg.mappings.filter((m) => m.kind === "field" && (m.field === "sku" || m.field === "parent_sku")).map((m) => m.column);
      if (cfg.groupBy) skuCols.push(cfg.groupBy);
      for (const r of sheet.rows) for (const c of skuCols) if (r[c]?.trim()) fileSkus.add(r[c].trim());
      const matchedKeys = [...fileSkus].map((s) => skuToId.get(s)).filter(Boolean).map((x) => String(x!.id));
      const rows = matchedKeys.length ? await backend.rows(storeId, matchedKeys) : [];
      const bySku = new Map<string, Product>();
      const byKey = new Map<string, Product>();
      for (const r of rows) {
        if (r.sku) bySku.set(r.sku, r);
        byKey.set(r._state.key, r);
      }
      setExisting(byKey);
      // Full file locations in the image column are checked on disk up front.
      const pathFiles = new Map<string, LocalFile | null>();
      if (cfg.imageMatch.byColumn && cfg.imageMatch.byPath) {
        const paths = imagePaths(sheet, cfg);
        const found = paths.length ? await backend.resolveImagePaths(paths) : [];
        paths.forEach((p, i) => pathFiles.set(p, found[i]));
      }
      let n = 0;
      const p = buildPlan(sheet, cfg, { categories: (taxonomy?.categories ?? []).filter((c) => !c._state.is_new), existingBySku: bySku, imageFiles: images, pathFiles, customFields, newKey: () => `new:imp${Date.now().toString(36)}${(n++).toString(36)}` });
      setPlan(p);
      setStep("review");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const { creates, edits } = planToStaging(plan, existing);
      if (creates.length) await create(creates);
      if (edits.length) await stage(edits);
      openDialog(null);
      setQuery({ only_changed: true });
      toast({ tone: "success", title: `Staged ${creates.filter((c) => c.entity !== "category").length} new and ${new Set(edits.map((e) => e.key)).size} updated products`, body: `${plan.stats.images} images will be optimised and uploaded on push. Review in the grid (filter: Changed), then Push.` });
    } catch (e) {
      toast({ tone: "error", title: "Import failed", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const errors = plan?.issues.filter((i) => i.level === "error") ?? [];
  const warnings = plan?.issues.filter((i) => i.level === "warning") ?? [];
  const blockedRows = new Set(errors.map((e) => e.row));

  return (
    <Modal open={open} onClose={() => openDialog(null)} title="Import products" width={1040} testId="import-wizard"
      footer={<>
        <div className="mr-auto flex items-center gap-2 text-xs text-muted">
          {(["source", "map", "review"] as Step[]).map((s, i) => <span key={s} className={clsx("flex items-center gap-1", step === s && "font-semibold text-fg")}><span className={clsx("flex h-4 w-4 items-center justify-center rounded-full text-2xs", step === s ? "bg-accent text-white" : "bg-sunken")}>{i + 1}</span>{s === "source" ? "Source" : s === "map" ? "Map fields" : "Review"}</span>)}
        </div>
        {step !== "source" && <Button onClick={() => setStep(step === "review" ? "map" : "source")}>Back</Button>}
        {step === "source" && <Button variant="primary" disabled={!sheet || busy} onClick={() => setStep("map")} data-testid="import-next">Next: map fields</Button>}
        {step === "map" && <Button variant="primary" disabled={busy} onClick={buildReview} data-testid="import-review">Validate &amp; review</Button>}
        {step === "review" && plan && <Button variant="primary" disabled={busy || plan.products.length === blockedRows.size} onClick={commit} data-testid="import-commit">Stage {plan.stats.create + plan.stats.variations + plan.stats.update - blockedRows.size} items</Button>}
      </>}>
      {step === "source" && (
        <div className="space-y-4">
          <Dropzone toFiles={backend.filesFromDrop} onFiles={onDrop} className="rounded-xl" testId="import-drop">
            <div className="grid grid-cols-2 gap-4">
              <div className={clsx("flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center", sheet ? "border-added/50 bg-added/5" : "border-line")}>
                <FileSpreadsheet size={28} className={sheet ? "text-added" : "text-muted"} />
                {sheet ? (
                  <>
                    <div className="font-medium">{fileName}</div>
                    <div className="text-xs text-muted">{sheet.rows.length.toLocaleString()} rows · {sheet.columns.length} columns</div>
                    {sheets.length > 1 && <Select value={sheetIdx} onChange={(e) => setSheetIdx(Number(e.target.value))} className="w-48">{sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}</Select>}
                  </>
                ) : (
                  <>
                    <div className="font-medium">Drop a spreadsheet</div>
                    <div className="text-xs text-muted">CSV, Excel (xlsx/xls), OpenDocument, JSON — supplier feeds, Shopify and WooCommerce exports</div>
                  </>
                )}
                <Button size="sm" onClick={async () => {
                  const [f] = await backend.pickFiles({ multiple: false, extensions: SHEET_EXT });
                  if (f) loadSheetFile(f);
                }}>Choose file…</Button>
              </div>
              <div className={clsx("flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center", images.length ? "border-added/50 bg-added/5" : "border-line")}>
                <Images size={28} className={images.length ? "text-added" : "text-muted"} />
                <div className="font-medium">{images.length ? `${images.length.toLocaleString()} images ready` : "Add product images (optional)"}</div>
                <div className="text-xs text-muted">Matched by file name in an image column, or automatically by SKU: <code>SKU.jpg</code>, <code>SKU-2.jpg</code>, <code>SKU_back.png</code>. Not needed if your sheet has full file locations like <code>C:\Images\shoe-1.jpg</code>.</div>
                <Button size="sm" icon={<FolderOpen size={13} />} onClick={async () => {
                  const files = await backend.pickFiles({ directory: true });
                  setImages((cur) => [...cur, ...files.filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name))]);
                }}>Choose folder…</Button>
              </div>
            </div>
          </Dropzone>
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-[13px] font-medium">…or paste rows from Excel / Google Sheets</summary>
            <textarea className="mt-2 h-28 w-full rounded border border-line bg-sunken p-2 font-mono text-xs" placeholder={"Name\tSKU\tPrice\nBlue Mug\tMUG-1\t12.99"} value={paste} onChange={(e) => setPaste(e.target.value)} data-testid="import-paste" />
            <Button size="sm" className="mt-2" disabled={!paste.trim()} onClick={() => {
              const s = parseCsv(paste, "Pasted rows");
              setSheets([s]);
              setSheetIdx(0);
              setFileName("Pasted rows");
            }} data-testid="import-use-paste">Use pasted rows</Button>
          </details>
        </div>
      )}

      {step === "map" && sheet && cfg && (
        <div className="space-y-4">
          {profileApplied && <div className="flex items-center gap-2 rounded-md bg-accent/10 px-3 py-2 text-xs text-accent"><Info size={13} /> Applied saved mapping “{profileApplied}” (same columns as last time).</div>}
          <div className="grid grid-cols-4 gap-3">
            <Field label="Mode">
              <Select value={cfg.mode} onChange={(e) => setCfg({ ...cfg, mode: e.target.value as ImportConfig["mode"] })}>
                <option value="create_and_update">Create new, update existing (by SKU)</option>
                <option value="create_only">Only create new products</option>
                <option value="update_only">Only update existing products</option>
              </Select>
            </Field>
            <Field label="Group rows into variable products by">
              <Select value={cfg.groupBy ?? ""} onChange={(e) => setCfg({ ...cfg, groupBy: e.target.value || null })}>
                <option value="">Don't group (or use Parent SKU column)</option>
                {sheet.columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Default status for new products">
              <Select value={cfg.defaultStatus} onChange={(e) => setCfg({ ...cfg, defaultStatus: e.target.value })}>
                <option value="publish">Published</option><option value="draft">Draft</option>
              </Select>
            </Field>
            <Field label="Category separators" hint="Between categories / between levels">
              <div className="flex gap-1">
                <Input value={cfg.categorySeparator} onChange={(e) => setCfg({ ...cfg, categorySeparator: e.target.value || "|" })} />
                <Input value={cfg.categoryPathSeparator} onChange={(e) => setCfg({ ...cfg, categoryPathSeparator: e.target.value || ">" })} />
              </div>
            </Field>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Toggle checked={cfg.imageMatch.byColumn} onChange={(v) => setCfg({ ...cfg, imageMatch: { ...cfg.imageMatch, byColumn: v } })} label="Images from image column (URLs or file names)" />
              <Toggle checked={cfg.imageMatch.bySku} onChange={(v) => setCfg({ ...cfg, imageMatch: { ...cfg.imageMatch, bySku: v } })} label={`Match images by SKU (${images.length} in folder)`} />
            </div>
            {cfg.imageMatch.byColumn && (
              <div data-testid="import-bypath">
                <Toggle checked={!!cfg.imageMatch.byPath} onChange={(v) => setCfg({ ...cfg, imageMatch: { ...cfg.imageMatch, byPath: v } })} label="Use file locations from the image column" />
                <div className="ml-10 mt-0.5 text-xs text-muted">
                  e.g. <code>C:\Images\shoe-1.jpg|C:\Images\shoe-2.jpg</code>. Separate several images with <code>|</code>, or use one column per image (Image 1, Image 2…). The first image becomes the featured image, the rest go to the gallery.
                </div>
              </div>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-sunken text-left text-xs text-muted"><tr><th className="px-3 py-2">Column in file</th><th className="px-3 py-2">Sample</th><th className="w-72 px-3 py-2">Import as</th></tr></thead>
              <tbody>
                {cfg.mappings.map((m, i) => {
                  const sample = sheet.rows.slice(0, 3).map((r) => r[m.column]).filter(Boolean).join(" · ");
                  const update = (patch: Partial<ColumnMapping>) => setCfg({ ...cfg, mappings: cfg.mappings.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                  const selectValue = m.kind === "field" ? `f:${m.field}` : m.kind === "attribute" ? (m.variation ? "attr:var" : "attr:info") : m.kind === "attribute_pair" ? "pair" : "";
                  return (
                    <tr key={m.column} className="border-t border-line">
                      <td className="px-3 py-1.5 font-medium">{m.column}{m.confidence >= 0.9 && <CheckCircle2 size={12} className="ml-1 inline text-added" />}</td>
                      <td className="max-w-[360px] truncate px-3 py-1.5 text-muted">{sample}</td>
                      <td className="px-3 py-1">
                        <Select value={selectValue} disabled={m.kind === "attribute_pair"} data-testid={`map-${m.column}`} onChange={(e) => {
                          const v = e.target.value;
                          if (!v) update({ kind: "ignore", field: undefined });
                          else if (v.startsWith("f:")) update({ kind: "field", field: v.slice(2) });
                          else update({ kind: "attribute", field: undefined, attribute: m.attribute ?? m.column, variation: v === "attr:var", global: true });
                        }}>
                          <option value="">— Ignore —</option>
                          {m.kind === "attribute_pair" && <option value="pair">Variation option (name/value pair)</option>}
                          <optgroup label="Attributes">
                            <option value="attr:var">Attribute → creates variations</option>
                            <option value="attr:info">Attribute → information only</option>
                          </optgroup>
                          {[...new Set(FIELDS.map((f) => f.group))].map((g) => (
                            <optgroup key={g} label={g}>{FIELDS.filter((f) => f.group === g).map((f) => <option key={f.key} value={`f:${f.key}`} disabled={f.key !== "images" && cfg.mappings.some((x, j) => j !== i && x.field === f.key)}>{f.label}</option>)}</optgroup>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details className="rounded-lg border border-line p-3" open={Object.keys(cfg.transforms).length > 0}>
            <summary className="cursor-pointer text-[13px] font-medium">Transform values with formulas</summary>
            <p className="mt-1 text-xs text-muted">Reference columns as <code>{"{Column name}"}</code> and mapped fields by name. E.g. price from cost: <code>=CHARM({"{Cost}"} * 2.2)</code>, tidy names: <code>=PROPER(TRIM(name))</code>.</p>
            <div className="mt-2 space-y-2">
              {FIELDS.filter((f) => ["name", "sku", "regular_price", "sale_price", "status", "stock_quantity", "categories", "tags", "description", "short_description", "seo_title", "seo_description", "images"].includes(f.key) || f.key.startsWith("meta:")).map((f) => {
                const t = cfg.transforms[f.key] ?? {};
                const sample = (() => {
                  try {
                    if (!t.formula) return "";
                    const p = buildPlan({ ...sheet, rows: sheet.rows.slice(0, 1) }, { ...cfg, transforms: { [f.key]: t } }, { categories: [], existingBySku: new Map(), imageFiles: [], customFields, newKey: () => "x" });
                    const err = p.issues.find((x) => x.level === "error" && x.field === f.key);
                    if (err) return `⚠ ${err.message}`;
                    return `→ ${String(p.products[0]?.fields[f.key === "categories" ? "category_ids" : f.key] ?? "")}`;
                  } catch (e) {
                    return `⚠ ${(e as Error).message}`;
                  }
                })();
                return (
                  <div key={f.key} className="grid grid-cols-[140px_1fr_160px_1fr] items-center gap-2">
                    <span className="text-xs font-medium">{f.label}</span>
                    <Input className="h-7 font-mono text-xs" placeholder="=formula" value={t.formula ?? ""} onChange={(e) => setCfg({ ...cfg, transforms: { ...cfg.transforms, [f.key]: { ...t, formula: e.target.value } } })} />
                    <Input className="h-7 text-xs" placeholder="Default if empty" value={t.fallback ?? ""} onChange={(e) => setCfg({ ...cfg, transforms: { ...cfg.transforms, [f.key]: { ...t, fallback: e.target.value } } })} />
                    <span className={clsx("truncate text-2xs", sample.startsWith("⚠") ? "text-removed" : "text-muted")}>{sample}</span>
                  </div>
                );
              })}
            </div>
          </details>
          <div className="flex items-center gap-2">
            <Input className="w-64" value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="Supplier name, e.g. Acme weekly feed" />
            <Button size="sm" icon={<Save size={13} />} disabled={!profileName} onClick={() => {
              const all = loadProfiles();
              all[profileName] = { ...cfg, signature: sheet.columns.join("|").toLowerCase() };
              try {
                localStorage.setItem("cf.importProfiles", JSON.stringify(all));
              } catch {
                /* ignore */
              }
              toast({ tone: "success", title: `Mapping saved as “${profileName}”`, body: "It is applied automatically next time a file with these columns is imported." });
            }}>Save mapping</Button>
          </div>
        </div>
      )}

      {step === "review" && plan && (
        <div className="space-y-4" data-testid="import-review-step">
          <div className="grid grid-cols-5 gap-2">
            {[["New products", plan.stats.create, "added"], ["Variations", plan.stats.variations, "added"], ["Updates", plan.stats.update, "changed"], ["New categories", plan.stats.categoriesCreated, "accent"], ["Images", plan.stats.images, "accent"]].map(([l, v, t]) => (
              <div key={l as string} className="rounded-lg border border-line p-3">
                <div className="text-2xl font-semibold tabular-nums">{(v as number).toLocaleString()}</div>
                <div className="text-xs text-muted">{l as string}</div>
                <div className={clsx("mt-1 h-1 rounded", t === "added" ? "bg-added/40" : t === "changed" ? "bg-changed/40" : "bg-accent/40")} />
              </div>
            ))}
          </div>
          {plan.stats.skipped > 0 && <div className="text-xs text-muted">{plan.stats.skipped} rows skipped by the selected mode.</div>}
          {(errors.length > 0 || warnings.length > 0) && (
            <div className="max-h-48 overflow-auto rounded-lg border border-line">
              {[...errors, ...warnings].slice(0, 200).map((i, n) => (
                <div key={n} className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0">
                  {i.level === "error" ? <AlertCircle size={13} className="mt-0.5 shrink-0 text-removed" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-changed" />}
                  <span className="w-14 shrink-0 text-muted">Row {i.row}</span>
                  <span>{i.message}</span>
                </div>
              ))}
            </div>
          )}
          {errors.length > 0 && <p className="text-xs text-removed">{blockedRows.size} rows with errors will be skipped (with their variations). Fix the file or mapping and re-import them later.</p>}
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-sunken text-left text-xs text-muted"><tr><th className="px-3 py-1.5">Row</th><th>Action</th><th>Name / variation</th><th>SKU</th><th>Price</th><th>Images</th></tr></thead>
              <tbody>
                {plan.products.slice(0, 60).map((p) => (
                  <tr key={p.key} className={clsx("border-t border-line", blockedRows.has(p.row) && "opacity-40")}>
                    <td className="px-3 py-1 text-muted">{p.row}</td>
                    <td>{p.existingId ? <Badge tone="changed">update</Badge> : <Badge tone="added">{p.entity === "variation" ? "variation" : (p.fields.type as string) ?? "create"}</Badge>}</td>
                    <td className="max-w-[320px] truncate">{p.entity === "variation" ? `↳ ${Object.values((p.fields.variation_attributes as Record<string, string>) ?? {}).join(" · ")}` : (p.fields.name as string) ?? ""}</td>
                    <td className="text-muted">{(p.fields.sku as string) ?? ""}</td>
                    <td className="tabular-nums">{(p.fields.regular_price as string) ?? ""}</td>
                    <td>{[p.fields.image_id, ...((p.fields.gallery_ids as unknown[]) ?? [])].filter(Boolean).length || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Nothing is sent to your store yet. Staged products appear in the grid in green; review or edit them, then Push.</p>
        </div>
      )}
    </Modal>
  );
}
