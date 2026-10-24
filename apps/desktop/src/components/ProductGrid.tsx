import DataEditor, {
  CompactSelection, GridCellKind, type DataEditorRef, type EditableGridCell, type GridCell, type GridColumn, type GridSelection, type Item, type Rectangle, type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { META_PREFIX, type CustomField, type Edit, type ProductRow } from "../backend/types";
import { useApp } from "../store/app";
import { mediaUrl } from "./ui";

export interface ColumnDef {
  id: string;
  title: string;
  width: number;
  kind: "text" | "price" | "int" | "bool" | "enum" | "image" | "tags" | "cats" | "expander" | "readonly" | "html";
  options?: string[];
  editable?: boolean;
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "_expand", title: "", width: 28, kind: "expander" },
  { id: "image_id", title: "", width: 44, kind: "image" },
  { id: "name", title: "Name", width: 300, kind: "text", editable: true },
  { id: "sku", title: "SKU", width: 140, kind: "text", editable: true },
  { id: "type", title: "Type", width: 84, kind: "readonly" },
  { id: "status", title: "Status", width: 84, kind: "enum", options: ["publish", "draft", "pending", "private"], editable: true },
  { id: "regular_price", title: "Price", width: 90, kind: "price", editable: true },
  { id: "sale_price", title: "Sale", width: 80, kind: "price", editable: true },
  { id: "stock_quantity", title: "Stock", width: 70, kind: "int", editable: true },
  { id: "stock_status", title: "Stock status", width: 104, kind: "enum", options: ["instock", "outofstock", "onbackorder"], editable: true },
  { id: "manage_stock", title: "Manage", width: 70, kind: "bool", editable: true },
  { id: "category_ids", title: "Categories", width: 200, kind: "cats" },
  { id: "tags", title: "Tags", width: 150, kind: "tags", editable: true },
  { id: "weight", title: "Weight", width: 70, kind: "price", editable: true },
  { id: "length", title: "L", width: 56, kind: "price", editable: true },
  { id: "width", title: "W", width: 56, kind: "price", editable: true },
  { id: "height", title: "H", width: 56, kind: "price", editable: true },
  { id: "shipping_class", title: "Shipping class", width: 120, kind: "text", editable: true },
  { id: "global_unique_id", title: "GTIN/EAN", width: 130, kind: "text", editable: true },
  { id: "featured", title: "Featured", width: 76, kind: "bool", editable: true },
  { id: "catalog_visibility", title: "Visibility", width: 96, kind: "enum", options: ["visible", "catalog", "search", "hidden"], editable: true },
  { id: "seo_title", title: "SEO title", width: 220, kind: "text", editable: true },
  { id: "seo_description", title: "SEO description", width: 280, kind: "text", editable: true },
  { id: "short_description", title: "Short description", width: 260, kind: "html" },
  { id: "description", title: "Description", width: 300, kind: "html" },
  { id: "menu_order", title: "Order", width: 64, kind: "int", editable: true },
  { id: "id", title: "ID", width: 70, kind: "readonly" },
  { id: "date_modified_gmt", title: "Modified", width: 150, kind: "readonly" },
];

export const VIEW_PRESETS: Record<string, string[]> = {
  Default: ["_expand", "image_id", "name", "sku", "type", "status", "regular_price", "sale_price", "stock_quantity", "stock_status", "category_ids", "tags", "id"],
  Pricing: ["_expand", "image_id", "name", "sku", "regular_price", "sale_price", "status", "category_ids"],
  Inventory: ["_expand", "image_id", "name", "sku", "manage_stock", "stock_quantity", "stock_status", "global_unique_id"],
  Shipping: ["_expand", "image_id", "name", "sku", "weight", "length", "width", "height", "shipping_class"],
  SEO: ["_expand", "image_id", "name", "sku", "seo_title", "seo_description", "short_description", "catalog_visibility", "featured"],
};

/** Grid columns for the store's custom fields (plugin meta), editable like built-in fields. */
export function customColumns(fields: CustomField[] = []): ColumnDef[] {
  return fields.map((f) => ({
    id: META_PREFIX + f.key,
    title: f.label || f.key,
    width: f.kind === "longtext" ? 260 : f.kind === "yesno" || f.kind === "number" ? 90 : 150,
    kind: f.kind === "number" ? "price" : f.kind === "yesno" ? "enum" : f.kind === "longtext" ? "html" : "text",
    options: f.kind === "yesno" ? ["yes", "no"] : undefined,
    editable: f.kind !== "longtext",
  }));
}

export function columnsFor(fields?: CustomField[]): ColumnDef[] {
  return [...ALL_COLUMNS, ...customColumns(fields)];
}

export function presetsFor(fields?: CustomField[]): Record<string, string[]> {
  if (!fields?.length) return VIEW_PRESETS;
  return { ...VIEW_PRESETS, "Custom fields": ["_expand", "image_id", "name", "sku", ...fields.map((f) => META_PREFIX + f.key)] };
}

const PAGE = 200;

function useGridTheme(dark: boolean): Partial<Theme> {
  return useMemo(
    () =>
      dark
        ? { accentColor: "#818cf8", accentLight: "rgba(129,140,248,0.18)", textDark: "#ececf0", textMedium: "#a1a1aa", textLight: "#71717a", bgCell: "#16161a", bgCellMedium: "#1c1c21", bgHeader: "#111114", bgHeaderHasFocus: "#1c1c21", bgHeaderHovered: "#1c1c21", borderColor: "#27272d", horizontalBorderColor: "#1f1f24", textHeader: "#a1a1aa", bgBubble: "#27272d", bgBubbleSelected: "#3f3f46", textBubble: "#d4d4d8", linkColor: "#818cf8", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseFontStyle: "13px", headerFontStyle: "600 12px", editorFontSize: "13px" }
        : { accentColor: "#4f46e5", accentLight: "rgba(79,70,229,0.10)", textDark: "#18181b", textMedium: "#52525b", textLight: "#a1a1aa", bgCell: "#ffffff", bgCellMedium: "#fafafa", bgHeader: "#fafafa", bgHeaderHasFocus: "#f4f4f5", bgHeaderHovered: "#f4f4f5", borderColor: "#e4e4e7", horizontalBorderColor: "#f0f0f2", textHeader: "#71717a", bgBubble: "#f4f4f5", bgBubbleSelected: "#e4e4e7", textBubble: "#3f3f46", linkColor: "#4f46e5", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseFontStyle: "13px", headerFontStyle: "600 12px", editorFontSize: "13px" },
    [dark],
  );
}

const DIFF = {
  light: { added: "#ecfdf3", changed: "#fef9c3", removed: "#fee2e2", conflict: "#fecaca" },
  dark: { added: "#0f2a1a", changed: "#33290a", removed: "#3a1414", conflict: "#4c1616" },
};

function plain(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function ProductGrid({ columns }: { columns: ColumnDef[] }) {
  const { backend, storeId, query, version, media, taxonomy, dark, stage, setQuery, setSelection, openDrawer, toast } = useApp();
  const ref = useRef<DataEditorRef>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const rowsRef = useRef<Map<number, ProductRow>>(new Map());
  const loading = useRef<Set<number>>(new Set());
  // Bumped whenever the row cache is replaced so Glide repaints every visible cell.
  const [dataVersion, setTick] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("cf.widths") ?? "{}");
    } catch {
      return {};
    }
  });
  const [selection, setGridSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  const visible = useRef<Rectangle>({ x: 0, y: 0, width: 10, height: 50 });
  const theme = useGridTheme(dark);
  const diff = dark ? DIFF.dark : DIFF.light;
  const catNames = useMemo(() => new Map((taxonomy?.categories ?? []).map((c) => [String(c._state.is_new ? c._state.key : c.id), c.name])), [taxonomy]);
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const loadPage = useCallback(
    async (page: number, ks: string[], target: Map<number, ProductRow>) => {
      if (!storeId) return;
      const slice = ks.slice(page * PAGE, page * PAGE + PAGE);
      if (!slice.length) return;
      const rows = await backend.rows(storeId, slice);
      const byKey = new Map(rows.map((r) => [r._state.key, r]));
      slice.forEach((k, i) => {
        const r = byKey.get(k);
        if (r) target.set(page * PAGE + i, r);
      });
    },
    [backend, storeId],
  );

  // Re-run the query whenever the filter/sort or data version changes.
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    (async () => {
      const res = await backend.query(storeId, query);
      if (cancelled) return;
      const next = new Map<number, ProductRow>();
      const first = Math.floor(visible.current.y / PAGE);
      const last = Math.floor((visible.current.y + visible.current.height) / PAGE);
      for (let p = first; p <= last; p++) await loadPage(p, res.keys, next);
      if (cancelled) return;
      rowsRef.current = next;
      loading.current.clear();
      setKeys(res.keys);
      setTick((t) => t + 1);
    })().catch((e) => toast({ tone: "error", title: "Query failed", body: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [backend, storeId, query, version, loadPage, toast]);

  const ensureRows = useCallback(
    (r: Rectangle) => {
      visible.current = r;
      const first = Math.floor(r.y / PAGE);
      const last = Math.floor((r.y + r.height) / PAGE);
      for (let p = first; p <= last; p++) {
        if (rowsRef.current.has(p * PAGE) || loading.current.has(p)) continue;
        loading.current.add(p);
        const ks = keysRef.current;
        loadPage(p, ks, rowsRef.current).then(() => {
          if (ks !== keysRef.current) return;
          const cells: { cell: Item }[] = [];
          for (let row = p * PAGE; row < Math.min(ks.length, p * PAGE + PAGE); row++) for (let c = 0; c < columns.length; c++) cells.push({ cell: [c, row] });
          ref.current?.updateCells(cells);
        });
      }
    },
    [columns.length, loadPage],
  );

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((c) => {
        const sort = query.sort?.[0];
        const arrow = sort?.field === c.id ? (sort.desc ? " ↓" : " ↑") : "";
        return { id: c.id, title: c.title + arrow, width: widths[c.id] ?? c.width };
      }),
    [columns, widths, query.sort],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const c = columns[col];
      const r = rowsRef.current.get(row);
      if (!r) return { kind: GridCellKind.Loading, allowOverlay: false };
      const st = r._state;
      const isVar = r.type === "variation";
      const dirty = st.dirty.includes(c.id);
      const conflict = st.conflicts.includes(c.id);
      const bg = st.deleted ? diff.removed : conflict ? diff.conflict : st.is_new ? diff.added : dirty ? diff.changed : undefined;
      const themeOverride = bg ? { bgCell: bg, ...(st.deleted ? { textDark: dark ? "#71717a" : "#a1a1aa" } : {}) } : undefined;
      const value = (r as Record<string, unknown>)[c.id];
      const readonly = !c.editable || st.deleted || (isVar && ["tags", "featured", "catalog_visibility", "seo_title", "seo_description", "short_description", "status"].includes(c.id)) || (r.type === "variable" && ["regular_price", "sale_price", "stock_quantity"].includes(c.id) && !r.manage_stock && c.id !== "stock_quantity");
      switch (c.kind) {
        case "expander": {
          const expanded = query.expanded?.includes(st.key);
          const d = r.type === "variable" ? (expanded ? "▾" : "▸") : "";
          return { kind: GridCellKind.Text, data: d, displayData: d, allowOverlay: false, readonly: true, contentAlign: "center", themeOverride };
        }
        case "image": {
          const url = mediaUrl(r.image_id, media);
          return { kind: GridCellKind.Image, data: url ? [url] : [], allowOverlay: false, readonly: true, themeOverride };
        }
        case "bool":
          return { kind: GridCellKind.Boolean, data: !!value, allowOverlay: false, readonly, themeOverride };
        case "cats": {
          const names = ((value as (number | string)[]) ?? []).map((id) => catNames.get(String(id)) ?? `#${id}`);
          return { kind: GridCellKind.Bubble, data: names, allowOverlay: true, themeOverride };
        }
        case "tags":
          return { kind: GridCellKind.Text, data: ((value as string[]) ?? []).join(", "), displayData: ((value as string[]) ?? []).join(", "), allowOverlay: !readonly, readonly, themeOverride };
        case "html": {
          const text = plain(String(value ?? ""));
          return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, themeOverride };
        }
        default: {
          let display = value === null || value === undefined ? "" : String(value);
          if (c.id === "name" && isVar) {
            const va = Object.values(r.variation_attributes ?? {}).join(" · ");
            display = `   ↳ ${va || display}`;
          }
          if (c.id === "type" && r.type === "variable") display = "variable";
          if (c.id === "date_modified_gmt" && display) display = display.replace("T", " ").replace("Z", "");
          if (c.id === "id" && st.is_new) display = "new";
          return {
            kind: GridCellKind.Text,
            data: value === null || value === undefined ? "" : String(value),
            displayData: display,
            allowOverlay: !readonly,
            readonly,
            contentAlign: c.kind === "price" || c.kind === "int" || c.id === "id" ? "right" : undefined,
            themeOverride: c.id === "name" && isVar ? { ...themeOverride, textDark: dark ? "#a1a1aa" : "#52525b" } : themeOverride,
          };
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, media, catNames, diff, dark, query.expanded, dataVersion],
  );

  const toEdit = useCallback(
    (col: number, row: number, cell: EditableGridCell): Edit | string | null => {
      const c = columns[col];
      const r = rowsRef.current.get(row);
      if (!r || !c.editable) return null;
      const entity = r.type === "variation" ? "variation" : "product";
      const key = r._state.key;
      let value: unknown;
      if (cell.kind === GridCellKind.Boolean) value = !!cell.data;
      else {
        const raw = String((cell as { data?: unknown }).data ?? "").trim();
        switch (c.kind) {
          case "price": {
            if (raw === "") value = "";
            else {
              const n = Number(raw.replace(/[^0-9.\-]/g, ""));
              if (!Number.isFinite(n) || !/\d/.test(raw)) return `${c.title}: "${raw}" is not a number`;
              value = c.id === "regular_price" || c.id === "sale_price" ? n.toFixed(2) : String(n);
            }
            break;
          }
          case "int": {
            if (raw === "") value = null;
            else {
              const n = Number(raw.replace(/[,\s]/g, ""));
              if (!Number.isInteger(n)) return `${c.title}: "${raw}" is not a whole number`;
              value = n;
            }
            break;
          }
          case "enum": {
            const v = raw.toLowerCase().replace(/\s+/g, "");
            const alias: Record<string, string> = { published: "publish", live: "publish", active: "publish", "in": "instock", out: "outofstock", backorder: "onbackorder", true: "yes", y: "yes", "1": "yes", false: "no", n: "no", "0": "no" };
            const val = c.options?.includes(v) ? v : c.options?.includes(alias[v]) ? alias[v] : undefined;
            if (!val) return `${c.title} must be one of: ${c.options?.join(", ")}`;
            value = val;
            break;
          }
          case "tags":
            value = raw.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
            break;
          default:
            value = raw;
        }
      }
      const edits: Edit = { entity, key, field: c.id, value };
      return edits;
    },
    [columns],
  );

  const onCellsEdited = useCallback(
    (items: readonly { location: Item; value: EditableGridCell }[]) => {
      const edits: Edit[] = [];
      const errors: string[] = [];
      for (const { location, value } of items) {
        const e = toEdit(location[0], location[1], value);
        if (typeof e === "string") errors.push(e);
        else if (e) edits.push(e);
      }
      // Stock quantity implies stock management and status, like wp-admin.
      for (const e of [...edits]) {
        if (e.field === "stock_quantity" && typeof e.value === "number") {
          edits.push({ ...e, field: "manage_stock", value: true });
          const r = [...rowsRef.current.values()].find((x) => x._state.key === e.key);
          if (r && r.stock_status !== "onbackorder") edits.push({ ...e, field: "stock_status", value: (e.value as number) > 0 ? "instock" : "outofstock" });
        }
      }
      if (errors.length) toast({ tone: "error", title: errors.length === 1 ? errors[0] : `${errors.length} values were rejected`, body: errors.length > 1 ? errors.slice(0, 3).join(" · ") : undefined });
      if (edits.length) stage(edits).catch((e) => toast({ tone: "error", title: "Could not stage edit", body: String(e) }));
      return true;
    },
    [stage, toEdit, toast],
  );

  const onSelection = useCallback(
    (s: GridSelection) => {
      setGridSelection(s);
      // Checked rows, or a multi-row range; a single focused cell is not a "selection".
      const rowsSel = s.rows.toArray();
      const range = s.current?.range;
      const fromRange = range && range.height > 1 ? Array.from({ length: range.height }, (_, i) => range.y + i) : [];
      const keysSel = (rowsSel.length ? rowsSel : fromRange).map((i) => keysRef.current[i]).filter(Boolean);
      setSelection(keysSel);
    },
    [setSelection],
  );

  return (
    <div className="relative h-full w-full" data-testid="product-grid" data-rows={keys.length}>
      <DataEditor
        ref={ref}
        columns={gridColumns}
        rows={keys.length}
        getCellContent={getCellContent}
        onCellsEdited={onCellsEdited}
        getCellsForSelection
        onPaste
        fillHandle
        rowMarkers="checkbox-visible"
        smoothScrollX
        smoothScrollY
        freezeColumns={3}
        rowHeight={36}
        headerHeight={34}
        width="100%"
        height="100%"
        theme={theme}
        gridSelection={selection}
        onGridSelectionChange={onSelection}
        onVisibleRegionChanged={ensureRows}
        keybindings={{ search: true, copy: true, paste: true, downFill: true, rightFill: true, selectAll: true }}
        onColumnResize={(col, w) => {
          const next = { ...widths, [col.id as string]: w };
          setWidths(next);
          try {
            localStorage.setItem("cf.widths", JSON.stringify(next));
          } catch {
            /* ignore */
          }
        }}
        onHeaderClicked={(col) => {
          const c = columns[col];
          if (["_expand", "image_id", "cats", "category_ids"].includes(c.id) || c.kind === "html") return;
          const cur = query.sort?.[0];
          setQuery({ sort: [{ field: c.id, desc: cur?.field === c.id ? !cur.desc : c.kind === "price" || c.kind === "int" }] });
        }}
        onCellClicked={([col, row]) => {
          const c = columns[col];
          const r = rowsRef.current.get(row);
          if (!r) return;
          if (c.id === "_expand" && r.type === "variable") {
            const exp = new Set(query.expanded ?? []);
            if (exp.has(r._state.key)) exp.delete(r._state.key);
            else exp.add(r._state.key);
            setQuery({ expanded: [...exp] });
          }
          if (c.id === "image_id") openDrawer(r.type === "variation" ? String(r.parent_id) : r._state.key);
        }}
        onCellActivated={([col, row]) => {
          const c = columns[col];
          const r = rowsRef.current.get(row);
          if (!r) return;
          if (c.kind === "cats" || c.kind === "html" || c.kind === "image" || c.id === "type" || c.id === "id") openDrawer(r.type === "variation" ? String(r.parent_id) : r._state.key);
        }}
        getRowThemeOverride={(row) => {
          const r = rowsRef.current.get(row);
          if (!r) return undefined;
          if (r._state.deleted) return { bgCell: diff.removed };
          if (r._state.is_new) return { bgCell: diff.added };
          return undefined;
        }}
      />
    </div>
  );
}
