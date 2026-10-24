import { Plus, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Edit, ProductAttribute, ProductRow } from "../backend/types";
import { useApp } from "../store/app";
import { BufferedInput, TagInput } from "./fields";
import { Badge, Button, clsx, Field, Input, mediaUrl, Thumb } from "./ui";

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function cartesian(lists: { key: string; values: string[] }[]): Record<string, string>[] {
  return lists.reduce<Record<string, string>[]>((acc, l) => acc.flatMap((combo) => l.values.map((v) => ({ ...combo, [l.key]: v }))), [{}]);
}

/** Attribute key as stored on variations: pa_* for global attributes, the sanitized name otherwise. */
export const attrKey = (a: ProductAttribute) => a.taxonomy || slug(a.name);
const valueKey = (a: ProductAttribute, v: string) => (a.taxonomy ? slug(v) : v);

export function VariationsPanel({ parent }: { parent: ProductRow }) {
  const { backend, storeId, version, stage, remove, media, taxonomy } = useApp();
  const [vars, setVars] = useState<ProductRow[]>([]);
  const [showGen, setShowGen] = useState(false);
  useEffect(() => {
    if (!storeId) return;
    backend.variations(storeId, parent._state.key).then(setVars);
  }, [backend, storeId, parent._state.key, version]);

  const varAttrs = (parent.attributes ?? []).filter((a) => a.variation);
  const setVar = (v: ProductRow, field: string, value: unknown) => stage([{ entity: "variation", key: v._state.key, field, value }]);
  const setAll = (field: string, value: unknown) => stage(vars.filter((v) => !v._state.deleted).map((v) => ({ entity: "variation", key: v._state.key, field, value }) as Edit));

  return (
    <div className="space-y-4" data-testid="variations-panel">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">{vars.filter((v) => !v._state.deleted).length} variations</div>
        <span className="flex-1" />
        <Button size="sm" variant="primary" icon={<Wand2 size={14} />} onClick={() => setShowGen(!showGen)} data-testid="open-matrix">
          Generate variations
        </Button>
      </div>
      {showGen && <MatrixGenerator parent={parent} existing={vars} onDone={() => setShowGen(false)} />}
      {vars.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-sunken p-2 text-xs">
            <span className="text-muted">Set all:</span>
            <SetAll label="Price" onApply={(v) => setAll("regular_price", Number(v).toFixed(2))} />
            <SetAll label="Sale" onApply={(v) => setAll("sale_price", v === "" ? "" : Number(v).toFixed(2))} />
            <SetAll label="Stock" onApply={(v) => stage(vars.flatMap((x) => [{ entity: "variation", key: x._state.key, field: "stock_quantity", value: Math.trunc(Number(v)) }, { entity: "variation", key: x._state.key, field: "manage_stock", value: true }, { entity: "variation", key: x._state.key, field: "stock_status", value: Number(v) > 0 ? "instock" : "outofstock" }] as Edit[]))} />
            <SetAll label="Weight" onApply={(v) => setAll("weight", v)} />
          </div>
          <div className="overflow-hidden rounded-md border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="w-10 px-2 py-1.5" />
                  {varAttrs.map((a) => <th key={attrKey(a)} className="px-2 py-1.5 font-medium">{a.name}</th>)}
                  <th className="px-2 py-1.5 font-medium">SKU</th>
                  <th className="w-24 px-2 py-1.5 font-medium">Price</th>
                  <th className="w-24 px-2 py-1.5 font-medium">Sale</th>
                  <th className="w-20 px-2 py-1.5 font-medium">Stock</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {vars.map((v) => (
                  <tr key={v._state.key} className={clsx("border-t border-line", v._state.is_new && "bg-added/10", v._state.deleted && "bg-removed/10 line-through opacity-60")}>
                    <td className="px-2 py-1"><Thumb src={mediaUrl(v.image_id, media)} size={28} /></td>
                    {varAttrs.map((a) => {
                      const raw = v.variation_attributes?.[attrKey(a)] ?? "";
                      const label = a.options.find((o) => valueKey(a, o) === raw || o === raw) ?? (raw || "Any");
                      return <td key={attrKey(a)} className="px-2 py-1">{label}</td>;
                    })}
                    <td className="px-1 py-1"><BufferedInput className={clsx("h-7", v._state.dirty.includes("sku") && "border-changed")} value={v.sku} onCommit={(x) => setVar(v, "sku", x)} /></td>
                    <td className="px-1 py-1"><BufferedInput className={clsx("h-7", v._state.dirty.includes("regular_price") && "border-changed")} value={v.regular_price} onCommit={(x) => setVar(v, "regular_price", x === "" ? "" : Number(x).toFixed(2))} /></td>
                    <td className="px-1 py-1"><BufferedInput className={clsx("h-7", v._state.dirty.includes("sale_price") && "border-changed")} value={v.sale_price} onCommit={(x) => setVar(v, "sale_price", x === "" ? "" : Number(x).toFixed(2))} /></td>
                    <td className="px-1 py-1"><BufferedInput className={clsx("h-7", v._state.dirty.includes("stock_quantity") && "border-changed")} value={v.stock_quantity === null ? "" : String(v.stock_quantity)} onCommit={(x) => stage([{ entity: "variation", key: v._state.key, field: "stock_quantity", value: x === "" ? null : Math.trunc(Number(x)) }, { entity: "variation", key: v._state.key, field: "manage_stock", value: true }])} /></td>
                    <td className="px-1"><button className="text-muted hover:text-removed" aria-label="Delete variation" onClick={() => remove("variation", [v._state.key])}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!vars.length && !showGen && (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-muted">
          No variations yet. Use <b>Generate variations</b> to create every combination of sizes, colours and more in one step.
          {taxonomy && !taxonomy.attributes.length && <div className="mt-1 text-xs">Tip: you can type new attribute values; they are created on push.</div>}
        </div>
      )}
      <p className="text-2xs text-muted">Unlink/merge: delete a variation here and create it as a simple product from the grid, or select simple products and use “Group as variations” in the command palette (⌘K).</p>
    </div>
  );
}

function SetAll({ label, onApply }: { label: string; onApply: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <span className="inline-flex items-center gap-1">
      <Input className="h-7 w-20" placeholder={label} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && v && (onApply(v), setV(""))} />
      <Button size="sm" variant="ghost" disabled={!v} onClick={() => (onApply(v), setV(""))}>Apply</Button>
    </span>
  );
}

function MatrixGenerator({ parent, existing, onDone }: { parent: ProductRow; existing: ProductRow[]; onDone: () => void }) {
  const { taxonomy, stage, create, toast } = useApp();
  const initial = (parent.attributes ?? []).filter((a) => a.variation);
  const [attrs, setAttrs] = useState<ProductAttribute[]>(initial.length ? initial : []);
  const [price, setPrice] = useState(parent.regular_price || "");
  const [stock, setStock] = useState("");
  const [skuPattern, setSkuPattern] = useState("{parent}-{values}");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const combos = useMemo(() => cartesian(attrs.filter((a) => a.options.length).map((a) => ({ key: attrKey(a), values: a.options }))), [attrs]);
  const existingKeys = new Set(existing.filter((v) => !v._state.deleted).map((v) => JSON.stringify(Object.fromEntries(Object.entries(v.variation_attributes ?? {}).sort()))));
  const comboKey = (c: Record<string, string>) => {
    const norm: Record<string, string> = {};
    for (const a of attrs) if (c[attrKey(a)] !== undefined) norm[attrKey(a)] = valueKey(a, c[attrKey(a)]);
    return JSON.stringify(Object.fromEntries(Object.entries(norm).sort()));
  };
  const toCreate = combos.filter((c) => !existingKeys.has(comboKey(c)) && !excluded.has(comboKey(c)));

  const generate = async () => {
    const parentAttrs = [...(parent.attributes ?? []).filter((a) => !a.variation && !attrs.some((x) => attrKey(x) === attrKey(a))), ...attrs.map((a, i) => ({ ...a, variation: true, visible: true, position: i }))];
    await stage([
      { entity: "product", key: parent._state.key, field: "attributes", value: parentAttrs },
      { entity: "product", key: parent._state.key, field: "type", value: "variable" },
    ]);
    const items = toCreate.map((c) => {
      const values = attrs.map((a) => c[attrKey(a)]).filter(Boolean);
      const fields: Record<string, unknown> = {
        parent_id: typeof parent.id === "number" && parent.id > 0 ? parent.id : parent._state.key,
        variation_attributes: c,
        sku: parent.sku ? skuPattern.replace("{parent}", parent.sku).replace("{values}", values.map((v) => slug(v).toUpperCase()).join("-")) : "",
      };
      if (price) fields.regular_price = Number(price).toFixed(2);
      if (stock !== "") Object.assign(fields, { manage_stock: true, stock_quantity: Math.trunc(Number(stock)), stock_status: Number(stock) > 0 ? "instock" : "outofstock" });
      return { entity: "variation" as const, fields };
    });
    await create(items);
    toast({ tone: "success", title: `Created ${items.length} variations`, body: "They will be saved with your next push." });
    onDone();
  };

  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/5 p-3" data-testid="matrix">
      {attrs.map((a, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="w-36 shrink-0 pt-1.5 text-[13px] font-medium">{a.name}</div>
          <div className="flex-1">
            <TagInput value={a.options} onChange={(options) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, options } : x)))} suggestions={(taxonomy?.attributes.find((t) => t.taxonomy === a.taxonomy)?.terms ?? []).map((t) => t.name)} placeholder="Type values, press Enter" label={`${a.name} values`} />
          </div>
          <button className="pt-1.5 text-muted hover:text-removed" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {(taxonomy?.attributes ?? []).filter((t) => !attrs.some((a) => a.taxonomy === t.taxonomy)).map((t) => (
          <Button key={t.taxonomy} size="sm" icon={<Plus size={12} />} onClick={() => setAttrs([...attrs, { name: t.name, taxonomy: t.taxonomy, options: [], visible: true, variation: true, position: attrs.length }])}>
            {t.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => {
          const name = window.prompt("New attribute (e.g. Material)");
          if (name) setAttrs([...attrs, { name, taxonomy: "pa_" + slug(name), options: [], visible: true, variation: true, position: attrs.length }]);
        }}>
          New attribute
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Price for all"><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 29.99" data-testid="matrix-price" /></Field>
        <Field label="Stock for all"><Input value={stock} onChange={(e) => setStock(e.target.value)} placeholder="optional" /></Field>
        <Field label="SKU pattern"><Input value={skuPattern} onChange={(e) => setSkuPattern(e.target.value)} /></Field>
      </div>
      {combos.length > 0 && (
        <div className="max-h-48 overflow-auto rounded border border-line bg-panel">
          {combos.map((c) => {
            const k = comboKey(c);
            const exists = existingKeys.has(k);
            return (
              <label key={k} className={clsx("flex items-center gap-2 border-b border-line px-2 py-1 text-[13px] last:border-0", exists && "text-muted")}>
                <input type="checkbox" disabled={exists} checked={!exists && !excluded.has(k)} onChange={() => setExcluded((s) => new Set(s.has(k) ? [...s].filter((x) => x !== k) : [...s, k]))} />
                {Object.values(c).join(" / ")}
                {exists && <Badge>exists</Badge>}
              </label>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-muted">{combos.length} combinations · {toCreate.length} new</span>
        <Button size="sm" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!toCreate.length} onClick={generate} data-testid="matrix-create">Create {toCreate.length} variations</Button>
      </div>
    </div>
  );
}
