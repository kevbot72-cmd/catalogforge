import { useEffect, useState } from "react";
import type { CloneOptions } from "../backend/types";
import { Button, Field, Modal, Select, Toggle } from "../components/ui";
import { useApp } from "../store/app";

export function CloneDialog() {
  const { dialog, dialogArg, openDialog, stores, storeId, backend, toast, selectStore } = useApp();
  const ids = (dialogArg as number[]) ?? [];
  const others = stores.filter((s) => s.id !== storeId);
  const [dst, setDst] = useState("");
  const [opts, setOpts] = useState<CloneOptions>({ match_sku: true, include_images: true, include_variations: true, status: "draft" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (dialog === "clone" && !dst && others[0]) setDst(others[0].id);
  }, [dialog, dst, others]);
  const run = async () => {
    if (!storeId || !dst) return;
    setBusy(true);
    try {
      await backend.openStore(dst);
      const r = await backend.cloneProducts(storeId, dst, ids, opts);
      openDialog(null);
      const target = stores.find((s) => s.id === dst);
      toast({ tone: "success", title: `Staged in ${target?.name}: ${r.created} new, ${r.updated} updated`, body: r.categories_created ? `${r.categories_created} missing categories will be created.` : "Switch to that store to review and push." });
      if (window.confirm(`Open ${target?.name} now to review and push?`)) await selectStore(dst);
    } catch (e) {
      toast({ tone: "error", title: "Clone failed", body: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={dialog === "clone"} onClose={() => openDialog(null)} title={`Clone ${ids.length} product${ids.length === 1 ? "" : "s"} to another store`} width={520}
      footer={<><Button onClick={() => openDialog(null)}>Cancel</Button><Button variant="primary" disabled={!dst || busy} onClick={run}>Stage in destination</Button></>}>
      {!others.length ? <p className="text-muted">Connect a second store first (e.g. your Local site and your live store).</p> : (
        <div className="space-y-4">
          <Field label="Destination">
            <Select value={dst} onChange={(e) => setDst(e.target.value)}>
              {others.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.environment})</option>)}
            </Select>
          </Field>
          <Toggle checked={opts.match_sku} onChange={(v) => setOpts({ ...opts, match_sku: v })} label="Update products with the same SKU instead of duplicating" />
          <Toggle checked={opts.include_variations} onChange={(v) => setOpts({ ...opts, include_variations: v })} label="Include variations" />
          <Toggle checked={opts.include_images} onChange={(v) => setOpts({ ...opts, include_images: v })} label="Copy images (downloaded and re-uploaded on push)" />
          <Field label="Status for new products">
            <Select value={opts.status ?? ""} onChange={(e) => setOpts({ ...opts, status: e.target.value || null })}>
              <option value="draft">Draft (review before publishing)</option><option value="">Same as source</option><option value="publish">Published</option>
            </Select>
          </Field>
          <p className="text-xs text-muted">Categories are matched by their full path (e.g. Apparel › Tees) and created when missing. Nothing is written until you push in the destination store.</p>
        </div>
      )}
    </Modal>
  );
}
