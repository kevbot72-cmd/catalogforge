import { AlertTriangle, ArrowRight, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StagedChange } from "../backend/types";
import { PRODUCT_FIELD_LABELS, useApp } from "../store/app";
import { Badge, Button, clsx, formatValue } from "./ui";

export function ChangesPanel() {
  const { backend, storeId, version, changesOpen, toggleChanges, summary, push, discardAll, openDrawer, busy } = useApp();
  const [changes, setChanges] = useState<StagedChange[]>([]);
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (!storeId || !changesOpen) return;
    backend.changes(storeId).then(setChanges);
  }, [backend, storeId, version, changesOpen]);
  const groups = useMemo(() => {
    const m = new Map<string, StagedChange[]>();
    for (const c of changes) {
      const k = `${c.entity}|${c.key}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    return [...m.values()].sort((a, b) => Number(!!b.find((c) => c.conflict)) - Number(!!a.find((c) => c.conflict)));
  }, [changes]);
  if (!changesOpen) return null;
  const discard = async (c: StagedChange) => {
    await backend.discard(storeId!, c.entity, c.key, c.field);
    useApp.setState({ summary: await backend.summary(storeId!), version: useApp.getState().version + 1 });
  };
  const resolve = async (c: StagedChange, keepMine: boolean) => {
    const s = await backend.resolveConflict(storeId!, c.entity, c.key, c.field, keepMine);
    useApp.setState({ summary: s, version: useApp.getState().version + 1 });
  };
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-panel" data-testid="changes-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="text-sm font-semibold">Changes</div>
        {summary.created > 0 && <Badge tone="added">+{summary.created} new</Badge>}
        {summary.modified > 0 && <Badge tone="changed">{summary.modified} edited</Badge>}
        {summary.deleted > 0 && <Badge tone="removed">−{summary.deleted}</Badge>}
        <span className="flex-1" />
        <button onClick={() => toggleChanges(false)} className="rounded p-1 text-muted hover:bg-sunken" aria-label="Close changes"><X size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 && <div className="p-6 text-center text-muted">Nothing to push. Edits you make anywhere appear here as a reviewable diff before anything touches your store.</div>}
        {groups.map((g) => {
          const head = g[0];
          const isNew = g.some((c) => c.field === "__new");
          const isDel = g.some((c) => c.field === "__delete");
          const fields = g.filter((c) => !c.field.startsWith("__"));
          return (
            <div key={head.entity + head.key} className="border-b border-line px-3 py-2">
              <button className="flex w-full items-center gap-2 text-left" onClick={() => (head.entity === "product" || head.entity === "variation") && openDrawer(head.key)}>
                <span className={clsx("h-2 w-2 rounded-full", isNew ? "bg-added" : isDel ? "bg-removed" : "bg-changed")} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{head.label}</span>
                <span className="text-2xs text-muted">{head.entity}</span>
              </button>
              {!isNew && !isDel && fields.map((c) => (
                <div key={c.field} className={clsx("group mt-1 rounded px-2 py-1 text-xs", c.conflict ? "bg-removed/10" : "bg-sunken/60")}>
                  <div className="flex items-center gap-1">
                    <span className="w-24 shrink-0 text-muted">{PRODUCT_FIELD_LABELS[c.field] ?? c.field}</span>
                    <span className="min-w-0 truncate text-removed line-through decoration-removed/50">{formatValue(c.base)}</span>
                    <ArrowRight size={11} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-added">{formatValue(c.value)}</span>
                    <button className="hidden text-muted hover:text-fg group-hover:block" title="Discard this change" onClick={() => discard(c)}><RotateCcw size={12} /></button>
                  </div>
                  {c.conflict && (
                    <div className="mt-1 flex items-center gap-1.5 text-removed">
                      <AlertTriangle size={12} /> Changed on the store to “{formatValue(c.conflict.remote)}”
                      <span className="flex-1" />
                      <button className="rounded border border-line bg-panel px-1.5 text-fg" onClick={() => resolve(c, true)}>Keep mine</button>
                      <button className="rounded border border-line bg-panel px-1.5 text-fg" onClick={() => resolve(c, false)}>Use store's</button>
                    </div>
                  )}
                </div>
              ))}
              {isNew && <div className="mt-1 text-xs text-added">New {head.entity} · {fields.length} fields</div>}
              {isDel && <div className="mt-1 text-xs text-removed">Will be deleted</div>}
            </div>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-line p-3">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Describe this change (optional)" className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] focus:outline-none" />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={discardAll} disabled={!groups.length || !!busy}>Discard all</Button>
          <span className="flex-1" />
          <Button variant="primary" onClick={() => push(label).then(() => setLabel(""))} disabled={!groups.length || !!busy} data-testid="push-panel">
            Push {summary.created + summary.modified + summary.deleted} changes
          </Button>
        </div>
      </div>
    </aside>
  );
}
