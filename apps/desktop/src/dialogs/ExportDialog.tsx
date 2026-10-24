import { FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { useState } from "react";
import { ALL_COLUMNS, VIEW_PRESETS, type ColumnDef } from "../components/ProductGrid";
import { Button, clsx, Field, Modal, Select, Toggle } from "../components/ui";
import { buildExport, type ExportColumn, type ExportFormat } from "../lib/exporter";
import { useApp } from "../store/app";

const NUMERIC = new Set(["price", "int"]);
const EXTRA: ExportColumn[] = [
  { id: "id", title: "ID", numeric: true },
  { id: "parent_id", title: "Parent ID" },
  { id: "image_id", title: "Image ID" },
  { id: "gallery_ids", title: "Gallery IDs" },
];

function currentColumns(): ColumnDef[] {
  let ids: string[] = VIEW_PRESETS.Default;
  try {
    const preset = localStorage.getItem("cf.preset") ?? "Default";
    ids = preset === "Custom" ? JSON.parse(localStorage.getItem("cf.columns") ?? "null") ?? ids : VIEW_PRESETS[preset] ?? ids;
  } catch {
    /* defaults */
  }
  return ids.map((id) => ALL_COLUMNS.find((c) => c.id === id)!).filter(Boolean);
}

export function ExportDialog() {
  const { dialog, openDialog, selection, query, backend, storeId, taxonomy, info, toast } = useApp();
  const open = dialog === "export";
  const [format, setFormat] = useState<ExportFormat>("xlsx");
  const [scope, setScope] = useState<"selection" | "view">("selection");
  const [columns, setColumns] = useState<"view" | "all">("view");
  const [variations, setVariations] = useState(false);
  const [busy, setBusy] = useState(false);
  const effectiveScope = selection.length ? scope : "view";

  const run = async () => {
    if (!storeId) return;
    setBusy(true);
    try {
      const keys = effectiveScope === "selection" ? selection : (await backend.query(storeId, { ...query, include_variations: variations, expanded: [] })).keys;
      let rows = await backend.rows(storeId, keys);
      if (effectiveScope === "selection" && variations) {
        const extra = [];
        for (const r of rows) if (r.type === "variable") extra.push(...(await backend.variations(storeId, r._state.key)));
        const seen = new Set(rows.map((r) => r._state.key));
        rows = [...rows, ...extra.filter((v) => !seen.has(v._state.key))];
      }
      const defs = (columns === "view" ? currentColumns() : ALL_COLUMNS).filter((c) => c.title && c.kind !== "expander" && c.kind !== "image");
      const cols: ExportColumn[] = [
        ...defs.map((c) => ({ id: c.id, title: c.title === "L" ? "Length" : c.title === "W" ? "Width" : c.title === "H" ? "Height" : c.title, numeric: NUMERIC.has(c.kind) || c.id === "id" })),
        ...(columns === "all" ? EXTRA.filter((e) => !defs.some((d) => d.id === e.id)) : []),
      ];
      const names = new Map((taxonomy?.categories ?? []).map((c) => [String(c.id), c.name]));
      const out = await buildExport(rows, cols, format, names);
      const store = (info?.profile.name ?? "products").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const saved = await backend.saveFile({ defaultName: `${store}-products-${new Date().toISOString().slice(0, 10)}.${out.extension}`, filterName: out.filterName, extension: out.extension, bytes: out.bytes, mime: out.mime });
      if (saved) {
        openDialog(null);
        toast({ tone: "success", title: `Exported ${rows.length.toLocaleString()} products`, body: backend.kind === "tauri" ? `Saved to ${saved}` : `${saved} — check your browser's downloads.` });
      }
    } catch (e) {
      toast({ tone: "error", title: "Export failed", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const Choice = ({ value, icon, title, sub }: { value: ExportFormat; icon: React.ReactNode; title: string; sub: string }) => (
    <button type="button" onClick={() => setFormat(value)} className={clsx("flex flex-1 items-center gap-3 rounded-lg border p-3 text-left", format === value ? "border-accent bg-accent/5" : "border-line hover:bg-sunken")} data-testid={`export-${value}`}>
      {icon}
      <span>
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-2xs text-muted">{sub}</span>
      </span>
    </button>
  );

  return (
    <Modal open={open} onClose={() => openDialog(null)} title="Export products" width={560} testId="export-dialog"
      footer={<>
        <Button onClick={() => openDialog(null)}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={run} icon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined} data-testid="export-save">{backend.kind === "tauri" ? "Save as…" : "Download"}</Button>
      </>}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <Choice value="xlsx" icon={<FileSpreadsheet size={20} className="text-added" />} title="Excel (.xlsx)" sub="Numbers stay numbers; opens directly in Excel" />
          <Choice value="csv" icon={<FileText size={20} className="text-accent" />} title="CSV (.csv)" sub="Universal; Google Sheets, supplier systems" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Products">
            <Select value={effectiveScope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="selection" disabled={!selection.length}>Selected ({selection.length})</option>
              <option value="view">Everything in the current view</option>
            </Select>
          </Field>
          <Field label="Columns">
            <Select value={columns} onChange={(e) => setColumns(e.target.value as typeof columns)}>
              <option value="view">Columns shown in the grid</option>
              <option value="all">All columns</option>
            </Select>
          </Field>
        </div>
        <Toggle checked={variations} onChange={setVariations} label="Include variations of variable products" />
        <p className="text-xs text-muted">
          Categories and tags are separated with <code>|</code>, the same format Import reads, so you can edit the file in Excel and import it back to update products by SKU.
          {backend.kind === "tauri" ? " You'll choose the folder and file name next." : " Your browser saves it to its downloads folder."}
        </p>
      </div>
    </Modal>
  );
}
