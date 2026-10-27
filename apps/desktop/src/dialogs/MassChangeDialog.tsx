import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Edit, ProductRow } from "../backend/types";
import { CategoryPicker, TagInput } from "../components/fields";
import { RichTextEditor } from "../components/RichTextEditor";
import { Badge, Button, clsx, Field, formatValue, Input, Modal, Select, Toggle } from "../components/ui";
import { FUNCTION_HELP } from "../lib/formula";
import { applyMany, massFieldsFor, OPS_BY_KIND, type MassField, type MassOp, type OpId } from "../lib/massChange";
import { useApp } from "../store/app";

/** One change in the list: which field, how, and with what. */
interface Spec {
  id: number;
  fieldKey: string;
  op: OpId;
  value: string;
  value2: string;
  regex: boolean;
  ci: boolean;
  caseMode: MassOp["caseMode"];
  items: (number | string)[];
}

let specSeq = 0;

/** A fresh change for a field, with that field's first operation and a sensible starting value. */
function specFor(field: MassField, keep?: Partial<Spec>): Spec {
  return {
    id: keep?.id ?? ++specSeq,
    fieldKey: field.key,
    // Prices usually go up or down by a percentage; everything else starts on its first operation.
    op: field.key.includes("price") ? "inc_pct" : OPS_BY_KIND[field.kind][0].id,
    value: field.kind === "bool" ? "true" : field.kind === "enum" ? field.options![0].value : "",
    value2: "",
    regex: false,
    ci: true,
    caseMode: "title",
    items: [],
  };
}

function ChangeEditor({ spec, n, fields, onChange, onRemove }: { spec: Spec; n: number; fields: MassField[]; onChange: (s: Spec) => void; onRemove?: () => void }) {
  const { taxonomy } = useApp();
  const field = fields.find((f) => f.key === spec.fieldKey) ?? fields[0];
  const set = (p: Partial<Spec>) => onChange({ ...spec, ...p });
  // The first change keeps the plain test ids; later ones get "-2", "-3"…
  const tid = (id: string) => (n === 1 ? id : `${id}-${n}`);
  const { op, value } = spec;
  const richValue = field.kind === "html" && ["set", "prepend", "append"].includes(op);
  const needsValue = !["clear", "case", "trim", "charm", "add_items", "remove_items", "set_items"].includes(op) && field.kind !== "bool" && field.kind !== "enum";
  return (
    <div className="rounded-lg border border-line p-3" data-testid={tid("mass-change-item")}>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/10 text-2xs font-semibold text-accent">{n}</span>
        <span className="text-xs font-medium text-muted">{n === 1 ? "Change" : "Then change"}</span>
        <span className="flex-1" />
        {onRemove && <Button size="sm" variant="close" icon={<Trash2 size={12} />} onClick={onRemove} aria-label={`Remove change ${n}`}>Remove</Button>}
      </div>
      <div className="grid grid-cols-[1fr_1.2fr] gap-3">
        <Field label="Field">
          <Select value={spec.fieldKey} onChange={(e) => onChange(specFor(fields.find((f) => f.key === e.target.value)!, { id: spec.id }))} data-testid={tid("mass-field")}>
            {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </Select>
        </Field>
        <Field label="Operation">
          <Select value={op} onChange={(e) => set({ op: e.target.value as OpId })} data-testid={tid("mass-op")}>
            {OPS_BY_KIND[field.kind].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3 space-y-3 empty:hidden">
        {field.kind === "enum" && (
          <Field label="New value"><Select value={value} onChange={(e) => set({ value: e.target.value })} data-testid={tid("mass-enum")}>{field.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        )}
        {field.kind === "bool" && <Toggle checked={value === "true"} onChange={(v) => set({ value: String(v) })} label={field.label} />}
        {needsValue && richValue && (
          <Field label={op === "prepend" ? "Add before the existing text" : op === "append" ? "Add after the existing text" : "New content"} hint="Paste from Word, Google Docs or a web page: bullets, bold, colours and sizes are kept. Use the </> button to edit the HTML.">
            <RichTextEditor value={value} onChange={(v) => set({ value: v })} minHeight={180} placeholder="Type or paste formatted text" testId={tid("mass-rich-value")} debounce={0} />
          </Field>
        )}
        {needsValue && !richValue && (
          <Field label={op === "formula" ? "Formula" : op === "replace" ? "Find" : op === "round" ? "Decimals" : "Value"} hint={op === "formula" ? <>Use field names and functions: {FUNCTION_HELP.slice(0, 8).map((f) => f.sig).join(", ")}…</> : undefined}>
            <Input value={value} onChange={(e) => set({ value: e.target.value })} placeholder={op === "formula" ? "=CHARM(regular_price * 1.1)" : op.includes("pct") ? "e.g. 10" : ""} className={op === "formula" ? "font-mono" : undefined} data-testid={tid("mass-value")} autoFocus={n === 1} />
          </Field>
        )}
        {op === "replace" && (
          <>
            <Field label="Replace with"><Input value={spec.value2} onChange={(e) => set({ value2: e.target.value })} /></Field>
            <div className="flex gap-4"><Toggle checked={spec.regex} onChange={(regex) => set({ regex })} label="Regular expression" /><Toggle checked={spec.ci} onChange={(ci) => set({ ci })} label="Ignore case" /></div>
          </>
        )}
        {op === "case" && (
          <Field label="Case"><Select value={spec.caseMode} onChange={(e) => set({ caseMode: e.target.value as MassOp["caseMode"] })}><option value="title">Title Case</option><option value="sentence">Sentence case</option><option value="upper">UPPERCASE</option><option value="lower">lowercase</option></Select></Field>
        )}
        {field.kind === "cats" && <CategoryPicker categories={taxonomy?.categories ?? []} value={spec.items} onChange={(items) => set({ items })} />}
        {field.kind === "tags" && <TagInput value={spec.items as string[]} onChange={(items) => set({ items })} suggestions={(taxonomy?.tags ?? []).map((t) => t.name)} placeholder="Tags" />}
      </div>
    </div>
  );
}

export function MassChangeDialog() {
  const { dialog, openDialog, selection, query, backend, storeId, stage, taxonomy, toast } = useApp();
  const open = dialog === "mass-change";
  const [scope, setScope] = useState<"selection" | "filtered">("filtered");
  const [withVariations, setWithVariations] = useState(true);
  const MASS_FIELDS = massFieldsFor(useApp((s) => s.info?.profile.custom_fields));
  const [specs, setSpecs] = useState<Spec[]>(() => [specFor(MASS_FIELDS[0])]);
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(false);
  const fieldOf = (s: Spec) => MASS_FIELDS.find((f) => f.key === s.fieldKey) ?? MASS_FIELDS[0];
  const anyVariations = specs.some((s) => fieldOf(s).variations);

  useEffect(() => {
    if (open) setScope(selection.length ? "selection" : "filtered");
  }, [open, selection.length]);

  // Load the target rows (including variations of variable products when relevant).
  useEffect(() => {
    if (!open || !storeId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      let keys: string[];
      if (scope === "selection") keys = selection;
      else keys = (await backend.query(storeId, { ...query, include_variations: false, expanded: [] })).keys;
      let rs = await backend.rows(storeId, keys);
      if (withVariations && anyVariations) {
        const parents = rs.filter((r) => r.type === "variable");
        const seen = new Set(rs.map((r) => r._state.key));
        for (const p of parents) for (const v of await backend.variations(storeId, p._state.key)) if (!seen.has(v._state.key)) rs.push(v);
        rs = rs.filter((r, i, a) => a.findIndex((x) => x._state.key === r._state.key) === i);
      }
      if (!cancelled) setRows(rs);
    })().finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, storeId, scope, selection, query, backend, withVariations, anyVariations]);

  const { changes, error, skipped } = useMemo(() => {
    const ops: MassOp[] = specs.map((s) => ({ field: fieldOf(s), op: s.op, value: s.value, value2: s.value2, regex: s.regex, caseInsensitive: s.ci, caseMode: s.caseMode, items: s.items }));
    try {
      return { ...applyMany(rows, ops), error: null as string | null };
    } catch (e) {
      return { changes: [], skipped: 0, error: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, specs, MASS_FIELDS.length]);

  const apply = async () => {
    const edits: Edit[] = [];
    for (const c of changes) {
      const entity = c.row.type === "variation" ? "variation" : "product";
      for (const d of c.diffs) {
        edits.push({ entity, key: c.row._state.key, field: d.field.key, value: d.after });
        // Stock quantity implies stock management and status, like wp-admin.
        if (d.field.key === "stock_quantity") {
          edits.push({ entity, key: c.row._state.key, field: "manage_stock", value: true });
          if (typeof d.after === "number") edits.push({ entity, key: c.row._state.key, field: "stock_status", value: d.after > 0 ? "instock" : "outofstock" });
        }
      }
    }
    await stage(edits);
    openDialog(null);
    setSpecs([specFor(MASS_FIELDS[0])]);
    toast({ tone: "success", title: `${changes.length} products updated locally`, body: `${specs.length > 1 ? `${specs.length} changes, one step` : "One step"} — press Undo to reverse it. Push when ready.` });
  };

  const catName = (id: unknown) => taxonomy?.categories.find((x) => String(x.id) === String(id) || x._state.key === String(id))?.name ?? String(id);
  const show = (d: { field: MassField }, v: unknown) => formatValue(d.field.kind === "cats" ? ((v as unknown[]) ?? []).map(catName) : v);

  return (
    <Modal open={open} onClose={() => openDialog(null)} title="Bulk edit" width={860} testId="mass-change"
      footer={<>
        <span className="mr-auto text-xs text-muted">{loading ? "Loading products…" : `${rows.length.toLocaleString()} in scope · ${changes.length.toLocaleString()} will change${skipped ? ` · ${skipped} not applicable` : ""}`}</span>
        <Button variant="close" onClick={() => openDialog(null)}>Cancel</Button>
        <Button variant="primary" disabled={!changes.length || !!error} onClick={apply} data-testid="mass-apply">Apply to {changes.length.toLocaleString()} products</Button>
      </>}>
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <Field label="Apply to" className="w-64">
          <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="selection" disabled={!selection.length}>Selected rows ({selection.length})</option>
            <option value="filtered">All products in current view</option>
          </Select>
        </Field>
        {anyVariations && <div className="pb-1.5"><Toggle checked={withVariations} onChange={setWithVariations} label="Include variations of variable products" /></div>}
      </div>
      <div className="space-y-2">
        {specs.map((s, i) => (
          <ChangeEditor
            key={s.id}
            spec={s}
            n={i + 1}
            fields={MASS_FIELDS}
            onChange={(next) => setSpecs((cur) => cur.map((x) => (x.id === s.id ? next : x)))}
            onRemove={specs.length > 1 ? () => setSpecs((cur) => cur.filter((x) => x.id !== s.id)) : undefined}
          />
        ))}
        <Button size="sm" icon={<Plus size={13} />} onClick={() => {
          // Suggest a field that isn't being changed yet.
          const used = new Set(specs.map((s) => s.fieldKey));
          setSpecs((cur) => [...cur, specFor(MASS_FIELDS.find((f) => !used.has(f.key)) ?? MASS_FIELDS[0])]);
        }} data-testid="mass-add">Add another change</Button>
        {specs.length > 1 && <p className="text-2xs text-muted">Changes run top to bottom, so a later one sees the earlier ones (e.g. a sale price worked out from the new regular price). They're applied together as one undo step.</p>}
      </div>
      <div className="mt-3 space-y-3">
        {error && <div className="rounded bg-removed/10 px-3 py-2 text-xs text-removed">{error}</div>}
        <div className="overflow-hidden rounded-md border border-line">
          <div className="flex items-center gap-2 bg-sunken px-3 py-1.5 text-xs font-medium text-muted">Preview <Badge>{Math.min(changes.length, 50)} of {changes.length}</Badge></div>
          <div className="max-h-64 overflow-auto" data-testid="mass-preview">
            {changes.slice(0, 50).map((c) => (
              <div key={c.row._state.key} className="flex items-start gap-2 border-t border-line px-3 py-1 text-[13px]">
                <span className="w-56 shrink-0 truncate">{c.row.type === "variation" ? `↳ ${Object.values(c.row.variation_attributes ?? {}).join(" · ")}` : c.row.name}</span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  {c.diffs.map((d) => (
                    <div key={d.field.key} className="flex items-center gap-2">
                      {(specs.length > 1 || c.diffs.length > 1) && <span className="w-28 shrink-0 truncate text-2xs text-muted">{d.field.label}</span>}
                      <span className={clsx("flex-1 truncate text-removed line-through decoration-removed/40")}>{show(d, d.before)}</span>
                      <ArrowRight size={12} className="shrink-0 text-muted" />
                      <span className="flex-1 truncate text-added">{show(d, d.after)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!changes.length && <div className="px-3 py-4 text-center text-xs text-muted">{loading ? "…" : "No changes with these settings."}</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
