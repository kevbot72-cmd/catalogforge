import { ArrowRight, History, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { HistoryEntry, HistoryItem } from "../backend/types";
import { Badge, Button, Empty, formatValue, timeAgo } from "../components/ui";
import { PRODUCT_FIELD_LABELS, useApp } from "../store/app";

export function HistoryView() {
  const { backend, storeId, version, toast, toggleChanges } = useApp();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);
  useEffect(() => {
    if (storeId) backend.history(storeId).then(setEntries);
  }, [backend, storeId, version]);
  useEffect(() => {
    if (storeId && sel !== null) backend.historyItems(storeId, sel).then(setItems);
  }, [backend, storeId, sel]);
  if (!entries.length) return <Empty icon={<History size={22} />} title="No pushes yet">Every push is recorded here with before/after values for each field, so any batch can be reverted with one click.</Empty>;
  return (
    <div className="flex h-full">
      <div className="w-[360px] shrink-0 overflow-auto border-r border-line bg-panel">
        {entries.map((e) => (
          <button key={e.id} onClick={() => setSel(e.id)} data-testid="history-entry" className={`block w-full border-b border-line px-4 py-3 text-left hover:bg-sunken ${sel === e.id ? "bg-sunken" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-[13px] font-medium">{e.label}</span>
              {e.reverted_by && <Badge>reverted</Badge>}
            </div>
            <div className="mt-1 flex gap-1.5 text-2xs text-muted">
              <span>{timeAgo(e.at)}</span>
              {e.created > 0 && <Badge tone="added">+{e.created}</Badge>}
              {e.updated > 0 && <Badge tone="changed">{e.updated} updated</Badge>}
              {e.deleted > 0 && <Badge tone="removed">−{e.deleted}</Badge>}
              {e.failed > 0 && <Badge tone="removed">{e.failed} failed</Badge>}
            </div>
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {sel === null ? (
          <Empty title="Select a push">See exactly what changed, field by field.</Empty>
        ) : (
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="flex-1 text-sm font-semibold">{entries.find((e) => e.id === sel)?.label}</h2>
              <Button size="sm" icon={<RotateCcw size={14} />} onClick={async () => {
                const s = await backend.revert(storeId!, sel);
                useApp.setState({ summary: s, version: useApp.getState().version + 1 });
                toast({ tone: "info", title: "Revert staged", body: "Review it in Changes, then push to apply." });
                toggleChanges(true);
              }} data-testid="revert">Revert this push</Button>
            </div>
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1">Record</th><th>Field</th><th>Before</th><th /><th>After</th></tr></thead>
              <tbody>
                {items.filter((i) => i.action !== "created_field").map((i, n) => (
                  <tr key={n} className="border-t border-line">
                    <td className="max-w-[220px] truncate py-1.5 pr-2">{i.label} <span className="text-2xs text-muted">#{i.id}</span></td>
                    <td className="pr-2 text-muted">{i.action === "created" ? "Created" : i.action === "deleted" ? "Deleted" : PRODUCT_FIELD_LABELS[i.field] ?? i.field}</td>
                    <td className="max-w-[200px] truncate pr-2 text-removed">{i.action === "updated" ? formatValue(i.before) : ""}</td>
                    <td className="pr-2 text-muted">{i.action === "updated" && <ArrowRight size={12} />}</td>
                    <td className="max-w-[200px] truncate text-added">{i.action === "updated" ? formatValue(i.after) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
