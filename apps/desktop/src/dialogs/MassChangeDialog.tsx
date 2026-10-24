import { ArrowRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Edit, ProductRow } from "../backend/types";
import { CategoryPicker, TagInput } from "../components/fields";
import { Badge, Button, Field, formatValue, Input, Modal, Select, Toggle } from "../components/ui";
import { FUNCTION_HELP } from "../lib/formula";
import { applyMass, isApplicable, MASS_FIELDS, OPS_BY_KIND, type MassOp, type OpId } from "../lib/massChange";
import { useApp } from "../store/app";

export function MassChangeDialog() {
  const { dialog, openDialog, selection, query, backend, storeId, stage, taxonomy, toast } = useApp();
  const open = dialog === "mass-change";
  const [scope, setScope] = useState<"selection" | "filtered">("filtered");
  const [withVariations, setWithVariations] = useState(true);
  const [fieldKey, setFieldKey] = useState("regular_price");
  const field = MASS_FIELDS.find((f) => f.key === fieldKey)!;
  const [op, setOp] = useState<OpId>("inc_pct");
  const [value, setValue] = useState("");
  const [value2, setValue2] = useState("");
  const [regex, setRegex] = useState(false);
  const [ci, setCi] = useState(true);
  const [caseMode, setCaseMode] = useState<MassOp["caseMode"]>("title");
  const [items, setItems] = useState<(number | string)[]>([]);
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setScope(selection.length ? "selection" : "filtered");
  }, [open, selection.length]);
  useEffect(() => {
    const ops = OPS_BY_KIND[field.kind];
    if (!ops.some((o) => o.id === op)) setOp(ops[0].id);
    setValue(field.kind === "bool" ? "true" : field.kind === "enum" ? field.options![0].value : "");
    setItems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey]);

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
      if (withVariations && field.variations) {
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
  }, [open, storeId, scope, selection, query, backend, withVariations, field.variations]);

  const m: MassOp = { field, op, value, value2, regex, caseInsensitive: ci, caseMode, items };
  const { changes, error, skipped } = useMemo(() => {
    const out: { row: ProductRow; before: unknown; after: unknown }[] = [];
    let skipped = 0;
    try {
      for (const r of rows) {
        if (!isApplicable(r, field)) {
          skipped++;
          continue;
        }
        const after = applyMass(r, m);
        const before = (r as Record<string, unknown>)[field.key];
        if (after === undefined || JSON.stringify(after) === JSON.stringify(before)) continue;
        out.push({ row: r, before, after });
      }
      return { changes: out, error: null as string | null, skipped };
    } catch (e) {
      return { changes: [], error: (e as Error).message, skipped };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, fieldKey, op, value, value2, regex, ci, caseMode, items]);

  const apply = async () => {
    const edits: Edit[] = changes.map((c) => ({ entity: c.row.type === "variation" ? "variation" : "product", key: c.row._state.key, field: field.key, value: c.after }));
    if (field.key === "stock_quantity")
      for (const c of changes) {
        const entity = c.row.type === "variation" ? "variation" : "product";
        edits.push({ entity, key: c.row._state.key, field: "manage_stock", value: true });
        if (typeof c.after === "number") edits.push({ entity, key: c.row._state.key, field: "stock_status", value: c.after > 0 ? "instock" : "outofstock" });
      }
    await stage(edits);
    openDialog(null);
    toast({ tone: "success", title: `${changes.length} products updated locally`, body: "One step — press Undo to reverse it. Push when ready." });
  };

  const needsValue = !["clear", "case", "trim", "charm", "add_items", "remove_items", "set_items"].includes(op) && field.kind !== "bool" && field.kind !== "enum";
  return (
    <Modal open={open} onClose={() => openDialog(null)} title="Bulk edit" width={860} testId="mass-change"
      footer={<>
        <span className="mr-auto text-xs text-muted">{loading ? "Loading products…" : `${rows.length.toLocaleString()} in scope · ${changes.length.toLocaleString()} will change${skipped ? ` · ${skipped} not applicable` : ""}`}</span>
        <Button onClick={() => openDialog(null)}>Cancel</Button>
        <Button variant="primary" disabled={!changes.length || !!error} onClick={apply} data-testid="mass-apply">Apply to {changes.length.toLocaleString()} products</Button>
      </>}>
      <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-3">
        <Field label="Apply to">
          <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="selection" disabled={!selection.length}>Selected rows ({selection.length})</option>
            <option value="filtered">All products in current view</option>
          </Select>
        </Field>
        <Field label="Field">
          <Select value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} data-testid="mass-field">
            {MASS_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </Select>
        </Field>
        <Field label="Operation">
          <Select value={op} onChange={(e) => setOp(e.target.value as OpId)} data-testid="mass-op">
            {OPS_BY_KIND[field.kind].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3 space-y-3">
        {field.kind === "enum" && (
          <Field label="New value"><Select value={value} onChange={(e) => setValue(e.target.value)}>{field.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        )}
        {field.kind === "bool" && <Toggle checked={value === "true"} onChange={(v) => setValue(String(v))} label={field.label} />}
        {needsValue && (
          <Field label={op === "formula" ? "Formula" : op === "replace" ? "Find" : op === "round" ? "Decimals" : "Value"} hint={op === "formula" ? <>Use field names and functions: {FUNCTION_HELP.slice(0, 8).map((f) => f.sig).join(", ")}…</> : undefined}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={op === "formula" ? "=CHARM(regular_price * 1.1)" : op.includes("pct") ? "e.g. 10" : ""} className={op === "formula" ? "font-mono" : undefined} data-testid="mass-value" autoFocus />
          </Field>
        )}
        {op === "replace" && (
          <>
            <Field label="Replace with"><Input value={value2} onChange={(e) => setValue2(e.target.value)} /></Field>
            <div className="flex gap-4"><Toggle checked={regex} onChange={setRegex} label="Regular expression" /><Toggle checked={ci} onChange={setCi} label="Ignore case" /></div>
          </>
        )}
        {op === "case" && (
          <Field label="Case"><Select value={caseMode} onChange={(e) => setCaseMode(e.target.value as MassOp["caseMode"])}><option value="title">Title Case</option><option value="sentence">Sentence case</option><option value="upper">UPPERCASE</option><option value="lower">lowercase</option></Select></Field>
        )}
        {field.kind === "cats" && <CategoryPicker categories={taxonomy?.categories ?? []} value={items} onChange={setItems} />}
        {field.kind === "tags" && <TagInput value={items as string[]} onChange={setItems} suggestions={(taxonomy?.tags ?? []).map((t) => t.name)} placeholder="Tags" />}
        {field.variations && <Toggle checked={withVariations} onChange={setWithVariations} label="Include variations of variable products" />}
        {error && <div className="rounded bg-removed/10 px-3 py-2 text-xs text-removed">{error}</div>}
        <div className="overflow-hidden rounded-md border border-line">
          <div className="flex items-center gap-2 bg-sunken px-3 py-1.5 text-xs font-medium text-muted">Preview <Badge>{Math.min(changes.length, 50)} of {changes.length}</Badge></div>
          <div className="max-h-64 overflow-auto">
            {changes.slice(0, 50).map((c) => (
              <div key={c.row._state.key} className="flex items-center gap-2 border-t border-line px-3 py-1 text-[13px]">
                <span className="w-64 truncate">{c.row.type === "variation" ? `↳ ${Object.values(c.row.variation_attributes ?? {}).join(" · ")}` : c.row.name}</span>
                <span className="flex-1 truncate text-removed line-through decoration-removed/40">{formatValue(field.kind === "cats" ? (c.before as number[]).map((id) => taxonomy?.categories.find((x) => String(x.id) === String(id))?.name ?? id) : c.before)}</span>
                <ArrowRight size={12} className="text-muted" />
                <span className="flex-1 truncate text-added">{formatValue(field.kind === "cats" ? (c.after as number[]).map((id) => taxonomy?.categories.find((x) => String(x.id) === String(id) || x._state.key === String(id))?.name ?? id) : c.after)}</span>
              </div>
            ))}
            {!changes.length && <div className="px-3 py-4 text-center text-xs text-muted">{loading ? "…" : "No changes with these settings."}</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
