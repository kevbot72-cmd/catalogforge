import { AlertCircle, CheckCircle2, Command as CmdIcon, GitCompare, Info, Loader2, Upload, X } from "lucide-react";
import { useEffect } from "react";
import { ChangesPanel } from "./components/ChangesPanel";
import { ProductDrawer } from "./components/ProductDrawer";
import { Sidebar } from "./components/Sidebar";
import { Badge, Button, clsx, Empty, ProgressBar, timeAgo } from "./components/ui";
import { AddStoreDialog } from "./dialogs/AddStoreDialog";
import { CloneDialog } from "./dialogs/CloneDialog";
import { CommandPalette } from "./dialogs/CommandPalette";
import { ImportWizard } from "./dialogs/ImportWizard";
import { MassChangeDialog } from "./dialogs/MassChangeDialog";
import { useApp } from "./store/app";
import { CategoriesView } from "./views/CategoriesView";
import { HistoryView } from "./views/HistoryView";
import { MediaView } from "./views/MediaView";
import { ProductsView } from "./views/ProductsView";
import { SettingsView } from "./views/SettingsView";

function TopBar() {
  const { info, summary, busy, progress, push, toggleChanges, changesOpen, openDialog, backend } = useApp();
  const pending = summary.created + summary.modified + summary.deleted;
  const env = info?.profile.environment;
  return (
    <div className="relative flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
      {info && (
        <>
          <span className="h-2 w-2 rounded-full" style={{ background: info.profile.color }} />
          <span className="text-[13px] font-medium">{info.profile.name}</span>
          <Badge tone={env === "production" ? "removed" : env === "local" ? "added" : "changed"}>{env === "production" ? "LIVE" : env?.toUpperCase()}</Badge>
          <span className="text-2xs text-muted">synced {timeAgo(info.last_pull)}</span>
        </>
      )}
      {backend.kind === "demo" && <Badge tone="accent">Demo data</Badge>}
      <span className="flex-1" />
      {busy && (
        <div className="flex w-72 items-center gap-2 text-xs text-muted" data-testid="busy">
          <Loader2 size={13} className="animate-spin" />
          <div className="min-w-0 flex-1">
            <div className="truncate">{progress?.message || busy}</div>
            <ProgressBar value={progress?.done ?? 0} total={progress?.total ?? 0} className="mt-0.5" />
          </div>
        </div>
      )}
      <button onClick={() => openDialog("palette")} className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted hover:bg-sunken" data-testid="open-palette">
        <CmdIcon size={12} /> Commands <span className="kbd">⌘K</span>
      </button>
      <Button size="sm" variant={changesOpen ? "secondary" : "ghost"} icon={<GitCompare size={14} />} onClick={() => toggleChanges()} data-testid="toggle-changes">
        Changes {pending > 0 && <Badge tone={summary.conflicts ? "removed" : "changed"}>{pending}</Badge>}
      </Button>
      <Button size="sm" variant="primary" icon={<Upload size={14} />} disabled={!pending || !!busy} onClick={() => push()} data-testid="push" title={env === "production" ? "Push to your LIVE store" : "Push changes"}>
        Push{pending ? ` ${pending}` : ""}
      </Button>
    </div>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[200] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={clsx("pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border bg-panel px-3 py-2 shadow-xl", t.tone === "error" ? "border-removed/40" : "border-line")} data-testid="toast">
          {t.tone === "success" ? <CheckCircle2 size={16} className="mt-0.5 text-added" /> : t.tone === "error" ? <AlertCircle size={16} className="mt-0.5 text-removed" /> : <Info size={16} className="mt-0.5 text-accent" />}
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t.title}</div>
            {t.body && <div className="text-xs text-muted">{t.body}</div>}
          </div>
          <button onClick={() => dismissToast(t.id)} className="text-muted" aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { view, storeId, stores, openDialog, init, setDark } = useApp();
  useEffect(() => {
    let dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    try {
      const saved = localStorage.getItem("cf.dark");
      if (saved !== null) dark = saved === "1";
    } catch {
      /* ignore */
    }
    setDark(dark);
    init();
  }, [init, setDark]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1 overflow-hidden">
            {!storeId ? (
              <Empty title={stores.length ? "Choose a store" : "Connect your first store"}>
                <p className="mb-3">Sites running in Local are detected automatically. Live stores connect with the CatalogForge Connector plugin or the WooCommerce REST API.</p>
                <Button variant="primary" onClick={() => openDialog("add-store")}>Add store</Button>
              </Empty>
            ) : view === "products" ? <ProductsView /> : view === "categories" ? <CategoriesView /> : view === "media" ? <MediaView /> : view === "history" ? <HistoryView /> : <SettingsView />}
            {view === "products" && <ProductDrawer />}
          </main>
          <ChangesPanel />
        </div>
      </div>
      <AddStoreDialog />
      <ImportWizard />
      <MassChangeDialog />
      <CloneDialog />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
