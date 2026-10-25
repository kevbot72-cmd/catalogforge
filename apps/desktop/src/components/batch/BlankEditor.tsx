import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { TOKENS, type Blank, type BlankOption } from "../../lib/batch";
import { useApp } from "../../store/app";
import { TagInput } from "../fields";
import { RichTextEditor } from "../RichTextEditor";
import { clsx, Field, Input, Select, Toggle } from "../ui";

export function Fold({ title, children, open: initial = false, hint, testId }: { title: string; children: ReactNode; open?: boolean; hint?: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="border-t border-line pt-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium" data-testid={testId}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
        {hint && <span className="ml-auto text-2xs font-normal text-muted">{hint}</span>}
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}

export const Tokens = () => (
  <div className="flex flex-wrap gap-1 text-2xs text-muted">
    {TOKENS.map((t) => <code key={t} className="rounded bg-sunken px-1.5 py-0.5">{t}</code>)}
  </div>
);

function OptionsEditor({ options, onChange, symbol }: { options: BlankOption[]; onChange: (o: BlankOption[]) => void; symbol: string }) {
  const set = (i: number, o: BlankOption) => onChange(options.map((x, j) => (j === i ? o : x)));
  return (
    <div className="space-y-3" data-testid="blank-options">
      {options.map((o, i) => (
        <div key={i} className="space-y-2 rounded-md border border-line p-2.5">
          <div className="flex items-center gap-2">
            <Input value={o.name} placeholder="Option name, e.g. Size" onChange={(e) => set(i, { ...o, name: e.target.value })} className="flex-1" aria-label="Option name" />
            <button type="button" className="cf-close rounded p-0.5" onClick={() => onChange(options.filter((_, j) => j !== i))} aria-label={`Remove ${o.name || "option"}`}><Trash2 size={14} /></button>
          </div>
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-2xs uppercase text-muted"><tr><th className="pb-1 font-medium">Value</th><th className="pb-1 font-medium">Price ({symbol}) if different</th><th className="pb-1 font-medium">SKU ending</th><th /></tr></thead>
            <tbody>
              {o.values.map((v, k) => (
                <tr key={k}>
                  <td className="pr-1.5 pb-1"><Input value={v.value} placeholder="e.g. Large" onChange={(e) => set(i, { ...o, values: o.values.map((x, m) => (m === k ? { ...x, value: e.target.value } : x)) })} aria-label="Option value" /></td>
                  <td className="pr-1.5 pb-1"><Input value={v.price} inputMode="decimal" placeholder="same" onChange={(e) => set(i, { ...o, values: o.values.map((x, m) => (m === k ? { ...x, price: e.target.value } : x)) })} aria-label="Option price" /></td>
                  <td className="pr-1.5 pb-1"><Input value={v.sku} placeholder={v.value ? v.value.toUpperCase().replace(/[^A-Z0-9]+/g, "-") : "auto"} onChange={(e) => set(i, { ...o, values: o.values.map((x, m) => (m === k ? { ...x, sku: e.target.value } : x)) })} aria-label="SKU ending" /></td>
                  <td className="pb-1"><button type="button" className="cf-close rounded p-0.5" onClick={() => set(i, { ...o, values: o.values.filter((_, m) => m !== k) })} aria-label="Remove value"><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => set(i, { ...o, values: [...o.values, { value: "", price: "", sku: "" }] })}>+ Add value</button>
        </div>
      ))}
      <button type="button" className="flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => onChange([...options, { name: "", values: [{ value: "", price: "", sku: "" }] }])} data-testid="add-option">
        <Plus size={12} /> Add an option (makes variable products)
      </button>
    </div>
  );
}

/** Everything a collection shares: prices, sizes, tags, descriptions, options and patterns. */
export function BlankEditor({ blank, onChange }: { blank: Blank; onChange: (b: Blank) => void }) {
  const { taxonomy, info } = useApp();
  const set = (p: Partial<Blank>) => onChange({ ...blank, ...p });
  const symbol = info?.handshake?.currency_symbol ?? "$";
  const fields = info?.profile.custom_fields ?? [];
  const input = (key: keyof Blank, label: string, props: { placeholder?: string; inputMode?: "decimal" | "numeric"; className?: string } = {}) => (
    <Field label={label} className={props.className}>
      <Input value={String(blank[key] ?? "")} placeholder={props.placeholder} inputMode={props.inputMode} onChange={(e) => set({ [key]: e.target.value } as Partial<Blank>)} data-testid={`blank-${String(key)}`} />
    </Field>
  );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {input("label", "Blank name (for you)")}
        {input("base", "Base title", { placeholder: "11oz Ceramic Coffee Mug" })}
        {input("prefix", "SKU prefix", { placeholder: "CERMUG" })}
        <div className="grid grid-cols-2 gap-2">
          {input("price", `Price (${symbol})`, { inputMode: "decimal" })}
          {input("sale", `Sale (${symbol})`, { inputMode: "decimal", placeholder: "none" })}
        </div>
        {input("stock", "Stock per product", { inputMode: "numeric" })}
        <div className="grid grid-cols-4 gap-1.5">
          {input("weight", "kg", { inputMode: "decimal" })}
          {input("height", "H cm", { inputMode: "decimal" })}
          {input("width", "W cm", { inputMode: "decimal" })}
          {input("length", "L cm", { inputMode: "decimal" })}
        </div>
      </div>
      <Field label="Tags">
        <TagInput value={blank.tags.split("|").map((t) => t.trim()).filter(Boolean)} onChange={(t) => set({ tags: t.join("|") })} suggestions={(taxonomy?.tags ?? []).map((t) => t.name)} placeholder="Add tags" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Shipping class">
          <Select value={blank.shipping} onChange={(e) => set({ shipping: e.target.value })}>
            <option value="">None</option>
            {(taxonomy?.shipping_classes ?? []).map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Tax class">
          <Select value={/^standard$/i.test(blank.taxClass) ? "" : blank.taxClass} onChange={(e) => set({ taxClass: e.target.value })}>
            <option value="">Standard</option>
            {(taxonomy?.tax_classes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <div className="flex items-end pb-1.5"><Toggle checked={blank.featured} onChange={(v) => set({ featured: v })} label="Featured" /></div>
      </div>
      <Fold title="Descriptions" hint="tokens like {price} are filled in per product" open testId="fold-descriptions">
        <Tokens />
        <Field label="Short description"><RichTextEditor value={blank.short} onChange={(short) => set({ short })} minHeight={120} testId="blank-short" /></Field>
        <Field label="Description"><RichTextEditor value={blank.desc} onChange={(desc) => set({ desc })} minHeight={160} testId="blank-desc" /></Field>
      </Fold>
      <Fold title={`Options${blank.options.length ? ` (${blank.options.map((o) => o.name || "?").join(", ")})` : ""}`} hint="sizes, colours… → variable products">
        <OptionsEditor options={blank.options} onChange={(options) => set({ options })} symbol={symbol} />
      </Fold>
      {fields.length > 0 && (
        <Fold title="Custom fields" hint="tokens work here too">
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <Field key={f.key} label={f.label || f.key}>
                <Input value={blank.custom[f.key] ?? ""} onChange={(e) => set({ custom: { ...blank.custom, [f.key]: e.target.value } })} />
              </Field>
            ))}
          </div>
        </Fold>
      )}
      <Fold title="Naming patterns">
        <Tokens />
        <div className="grid grid-cols-2 gap-3">
          {input("titlePattern", "Title", { className: "col-span-2" })}
          {input("skuPattern", "SKU")}
          <Field label="Gallery images per product">
            <Select value={String(blank.galleryCount)} onChange={(e) => set({ galleryCount: Number(e.target.value) })} data-testid="blank-gallery-count">
              {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </Field>
          {input("imagePattern", "Featured image file name (CSV/ZIP export)", { className: "col-span-2" })}
          {input("galleryPattern", "Gallery file names ({letter} = a, b, c…)", { className: "col-span-2" })}
        </div>
        <p className={clsx("text-2xs text-muted")}>When you add products straight to the store, images are named by Settings → File name template instead.</p>
      </Fold>
    </div>
  );
}
