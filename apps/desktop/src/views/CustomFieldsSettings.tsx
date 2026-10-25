import { Loader2, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CustomField, CustomFieldKind, MetaKeyInfo } from "../backend/types";
import { Badge, Button, Input, Select } from "../components/ui";
import { useApp } from "../store/app";

const KINDS: [CustomFieldKind, string][] = [["text", "Text"], ["longtext", "Long text"], ["number", "Number"], ["yesno", "Yes / no"], ["date", "Date"]];

/** "country_of_origin" → "Country of origin" */
export function prettyKey(k: string) {
  const s = k.replace(/^_+/, "").replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Per-store choice of which plugin fields (product meta) CatalogForge manages. */
export function CustomFieldsSettings() {
  const { backend, storeId, info, pull, toast } = useApp();
  const [fields, setFields] = useState<CustomField[]>(info?.profile.custom_fields ?? []);
  const [found, setFound] = useState<MetaKeyInfo[] | null>(null);
  const [busy, setBusy] = useState<"scan" | "save" | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => setFields(info?.profile.custom_fields ?? []), [info?.profile.custom_fields]);
  const saved = JSON.stringify(info?.profile.custom_fields ?? []);
  const dirty = JSON.stringify(fields) !== saved;

  const scan = async () => {
    if (!storeId) return;
    setBusy("scan");
    try {
      setFound(await backend.metaKeys(storeId));
    } catch (e) {
      toast({ tone: "error", title: "Could not list fields", body: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const toggle = (m: MetaKeyInfo) =>
    setFields((cur) => (cur.some((f) => f.key === m.key) ? cur.filter((f) => f.key !== m.key) : [...cur, { key: m.key, label: m.label || prettyKey(m.key), kind: m.kind }]));
  const update = (key: string, patch: Partial<CustomField>) => setFields((cur) => cur.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const save = async () => {
    if (!storeId) return;
    setBusy("save");
    try {
      await backend.setCustomFields(storeId, fields);
      // A full sync loads the newly chosen fields for every product.
      await pull(true);
      toast({ tone: "success", title: "Custom fields saved", body: fields.length ? "They're now grid columns (view: Custom fields), a tab on each product, and import/export columns." : undefined });
    } catch (e) {
      toast({ tone: "error", title: "Could not save custom fields", body: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const visible = (found ?? []).filter((m) => !filter || `${m.key} ${m.label}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <section data-testid="custom-fields-settings">
      <h2 className="mb-1 text-sm font-semibold">Custom fields</h2>
      <p className="mb-3 text-xs text-muted">Fields added by other plugins (ACF, brands, barcodes, supplier codes…). Pick the ones you want to see and edit; they then work like any other field in the grid, product editor, bulk edit, import and export.</p>
      <div className="space-y-3 rounded-lg border border-line bg-panel p-4">
        {fields.length > 0 && (
          <table className="w-full text-[13px]">
            <thead className="text-left text-2xs uppercase text-muted"><tr><th className="pb-1">Label</th><th className="pb-1">Field key</th><th className="pb-1">Type</th><th /></tr></thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.key} className="border-t border-line">
                  <td className="py-1 pr-2"><Input value={f.label} onChange={(e) => update(f.key, { label: e.target.value })} aria-label={`Label for ${f.key}`} /></td>
                  <td className="py-1 pr-2"><code className="text-xs">{f.key}</code></td>
                  <td className="w-32 py-1 pr-2">
                    <Select value={f.kind} onChange={(e) => update(f.key, { kind: e.target.value as CustomFieldKind })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                  </td>
                  <td className="w-8"><button className="cf-close rounded p-0.5" onClick={() => setFields(fields.filter((x) => x.key !== f.key))} aria-label={`Stop managing ${f.key}`}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={busy === "scan" ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} onClick={scan} disabled={!!busy} data-testid="cf-scan">Find fields on this store</Button>
          <span className="flex-1" />
          {dirty && <Button size="sm" variant="close" onClick={() => setFields(info?.profile.custom_fields ?? [])} disabled={!!busy}>Cancel</Button>}
          <Button size="sm" variant="primary" disabled={!dirty || !!busy} onClick={save} icon={busy === "save" ? <Loader2 size={13} className="animate-spin" /> : undefined} data-testid="cf-save">Save and sync</Button>
        </div>
        {found && (
          <div className="rounded-md border border-line">
            <div className="flex items-center gap-2 border-b border-line p-2">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${found.length} fields`} className="h-7 max-w-xs" />
              <span className="text-xs text-muted">Tick the fields to manage. Fields WooCommerce already covers are hidden.</span>
            </div>
            {found.length === 0 ? (
              <div className="p-3 text-xs text-muted">No plugin fields were found on this store's products.</div>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-[13px]">
                  <tbody>
                    {visible.map((m) => (
                      <tr key={m.key} className="border-t border-line first:border-0 hover:bg-sunken">
                        <td className="w-8 p-2"><input type="checkbox" checked={fields.some((f) => f.key === m.key)} onChange={() => toggle(m)} aria-label={`Manage ${m.key}`} data-testid={`cf-pick-${m.key}`} /></td>
                        <td className="p-2">
                          <div className="font-medium">{m.label || prettyKey(m.key)} {m.source && <Badge tone="accent">{m.source}</Badge>}</div>
                          <code className="text-2xs text-muted">{m.key}</code>
                        </td>
                        <td className="max-w-[220px] truncate p-2 text-xs text-muted" title={m.sample}>{m.sample || "—"}</td>
                        <td className="whitespace-nowrap p-2 text-right text-xs text-muted">{m.count.toLocaleString()} products</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {info?.profile.connection.kind === "rest" && (
          <p className="text-2xs text-muted">Over the WooCommerce REST API, fields whose key starts with “_” are hidden by WooCommerce. Connect with the CatalogForge Connector to manage those too.</p>
        )}
      </div>
    </section>
  );
}
