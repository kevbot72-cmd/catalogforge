import { useEffect, useState } from "react";
import pkg from "../../package.json";
import type { MediaSettings } from "../backend/types";
import { Badge, Button, Field, Input, Select, Toggle } from "../components/ui";
import { useApp } from "../store/app";
import { AppearanceSettings } from "./AppearanceSettings";
import { CustomFieldsSettings } from "./CustomFieldsSettings";

export function SettingsView() {
  const { backend, info, stores, storeId, refreshStores, selectStore, toast, autoSync, setAutoSync } = useApp();
  const [ms, setMs] = useState<MediaSettings | null>(null);
  useEffect(() => {
    backend.getMediaSettings().then(setMs);
  }, [backend]);
  const save = async (next: MediaSettings) => {
    setMs(next);
    await backend.setMediaSettings(next);
  };
  const hs = info?.handshake;
  const caps = info?.capabilities;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <AppearanceSettings />
        <section>
          <h2 className="mb-3 text-sm font-semibold">Syncing</h2>
          <div className="rounded-lg border border-line bg-panel p-4">
            <Toggle checked={autoSync} onChange={setAutoSync} label="Check the store for changes when I come back to CatalogForge" />
            <p className="mt-1.5 pl-9 text-2xs text-muted">Changes made in WordPress meanwhile are pulled in automatically (at most every 20 seconds). Your unpushed edits are kept, and anything edited on both sides shows as a conflict as usual.</p>
          </div>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-semibold">Image processing</h2>
          {ms && (
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-panel p-4">
              <Field label="Format" hint="WebP is ~30% smaller than JPEG and supported by WordPress 5.8+.">
                <Select value={ms.format} onChange={(e) => save({ ...ms, format: e.target.value as MediaSettings["format"] })}>
                  <option value="webp">WebP</option><option value="jpeg">JPEG</option><option value="original">Keep original format</option>
                </Select>
              </Field>
              <Field label={`Quality (${ms.quality})`}>
                <input type="range" min={50} max={100} value={ms.quality} onChange={(e) => save({ ...ms, quality: Number(e.target.value) })} className="w-full" />
              </Field>
              <Field label="Longest edge (px)" hint="Larger originals are scaled down before upload.">
                <Input type="number" value={ms.max_dimension} onChange={(e) => save({ ...ms, max_dimension: Number(e.target.value) || 2560 })} />
              </Field>
              <Field label="File name template" hint="{sku}, {name}, {n} — e.g. AB-12-red-shoe-2.webp">
                <Input value={ms.name_template} onChange={(e) => save({ ...ms, name_template: e.target.value })} />
              </Field>
              <div className="col-span-2">
                <Toggle checked={ms.generate_sizes} onChange={(v) => save({ ...ms, generate_sizes: v })} label="Generate every WordPress image size on this computer (no server CPU, much faster uploads)" />
              </div>
            </div>
          )}
        </section>
        {info && <CustomFieldsSettings />}
        {info && (
          <section>
            <h2 className="mb-3 text-sm font-semibold">This store</h2>
            <div className="space-y-2 rounded-lg border border-line bg-panel p-4 text-[13px]">
              <div className="flex gap-2"><span className="w-40 text-muted">Connection</span>{info.profile.connection.kind}</div>
              {hs && <div className="flex gap-2"><span className="w-40 text-muted">Site</span>{hs.site_name} · {hs.home_url}</div>}
              {hs && <div className="flex gap-2"><span className="w-40 text-muted">Versions</span>WordPress {hs.wp_version || "?"} · WooCommerce {hs.wc_version ?? "?"} · PHP {hs.php_version || "?"}</div>}
              {hs && <div className="flex gap-2"><span className="w-40 text-muted">Orders storage</span>{hs.hpos ? "HPOS (custom tables)" : "Posts table"}</div>}
              {caps && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge tone={caps.write ? "added" : "removed"}>{caps.write ? "Read & write" : "Read-only"}</Badge>
                  {caps.presized_media && <Badge tone="accent">Client-side image sizes</Badge>}
                  {caps.media_by_url_only && <Badge tone="changed">Images by URL only</Badge>}
                  {caps.preview && <Badge tone="accent">Live theme preview</Badge>}
                  {caps.server_conflict_check && <Badge tone="accent">Server conflict detection</Badge>}
                  <Badge>{caps.batch_size} per batch × {caps.write_concurrency}</Badge>
                </div>
              )}
              <div className="pt-2">
                <Button size="sm" variant="danger" onClick={async () => {
                  if (!storeId || !window.confirm(`Remove “${info.profile.name}” from CatalogForge? Nothing on the store is changed, but unpushed edits are lost.`)) return;
                  await backend.removeStore(storeId);
                  await refreshStores();
                  const next = useApp.getState().stores[0];
                  if (next) await selectStore(next.id);
                  else useApp.setState({ storeId: null, info: null });
                  toast({ tone: "info", title: "Store removed" });
                }}>Remove store from app</Button>
              </div>
            </div>
          </section>
        )}
        <section className="text-xs text-muted" data-testid="app-version">CatalogForge {pkg.version} · {stores.length} store{stores.length === 1 ? "" : "s"} connected · running in {backend.kind === "demo" ? "demo mode (sample data in your browser)" : "desktop mode"}</section>
      </div>
    </div>
  );
}
