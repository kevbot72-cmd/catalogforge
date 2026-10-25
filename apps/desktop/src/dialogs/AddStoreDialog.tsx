import { CheckCircle2, Database, Globe, HardDrive, Laptop, Loader2, Play, Plug, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Environment, LocalSite, NewStoreInput } from "../backend/types";
import { Badge, Button, clsx, Field, Input, Modal, Select, TextArea } from "../components/ui";
import { useApp } from "../store/app";

type Kind = "local" | "connector" | "rest" | "mysql";
const COLORS = ["#e11d48", "#f59e0b", "#16a34a", "#0ea5e9", "#6366f1", "#a855f7"];

const KINDS: { id: Kind; title: string; icon: React.ReactNode; blurb: string }[] = [
  { id: "local", title: "Local (Flywheel)", icon: <Laptop size={16} />, blurb: "A site running in Local on this computer. Zero setup: we find it, connect to its database and install the connector for you." },
  { id: "connector", title: "Connector plugin", icon: <Plug size={16} />, blurb: "Recommended for live stores. Fast bulk writes, client-side image sizing, live theme preview and conflict protection." },
  { id: "rest", title: "WooCommerce REST API", icon: <Globe size={16} />, blurb: "No plugin needed. Slower, images by URL only, no theme preview." },
  { id: "mysql", title: "Direct MySQL", icon: <Database size={16} />, blurb: "Fastest reads for very large catalogs (direct or tunnelled DB access). Add a connector string to enable writes." },
];

export function AddStoreDialog() {
  const { dialog, openDialog, backend, refreshStores, selectStore, toast } = useApp();
  const [kind, setKind] = useState<Kind>("local");
  const [name, setName] = useState("");
  const [env, setEnv] = useState<Environment>("local");
  const [color, setColor] = useState(COLORS[2]);
  const [sites, setSites] = useState<LocalSite[] | null>(null);
  const [siteErr, setSiteErr] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [conn, setConn] = useState("");
  const [rest, setRest] = useState({ base_url: "", consumer_key: "", consumer_secret: "" });
  const [my, setMy] = useState({ host: "127.0.0.1", port: 3306, database: "", user: "", password: "", table_prefix: "wp_", connection_string: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = dialog === "add-store";

  const loadSites = () => backend.localSites().then((s) => (setSites(s), setSiteErr(null))).catch((e) => (setSites([]), setSiteErr(String(e))));
  useEffect(() => {
    if (open && kind === "local" && sites === null) loadSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);
  useEffect(() => {
    setEnv(kind === "local" ? "local" : "production");
    setColor(kind === "local" ? COLORS[2] : COLORS[0]);
  }, [kind]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    let connection: NewStoreInput["connection"];
    if (kind === "local") connection = { kind: "local", site_id: siteId! };
    else if (kind === "connector") connection = { kind: "connector", connection_string: conn.trim() };
    else if (kind === "rest") connection = { kind: "rest", ...rest };
    else connection = { kind: "mysql", ...my, connection_string: my.connection_string || undefined };
    try {
      const site = sites?.find((s) => s.id === siteId);
      const p = await backend.addStore({ name: name || site?.name || "", environment: env, color, connection });
      await refreshStores();
      openDialog(null);
      toast({ tone: "success", title: `Connected to ${p.name}` });
      await selectStore(p.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const valid = kind === "local" ? !!siteId : kind === "connector" ? conn.trim().startsWith("cf1.") : kind === "rest" ? !!(rest.base_url && rest.consumer_key && rest.consumer_secret) : !!(my.host && my.database && my.user);

  return (
    <Modal open={open} onClose={() => openDialog(null)} title="Add a store" width={760} testId="add-store-dialog"
      footer={<>
        {error && <span className="mr-auto max-w-[460px] truncate text-xs text-removed" title={error}>{error}</span>}
        <Button variant="close" onClick={() => openDialog(null)}>Cancel</Button>
        <Button variant="primary" disabled={!valid || busy} onClick={submit} icon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined} data-testid="connect-store">Connect</Button>
      </>}>
      <div className="grid grid-cols-4 gap-2">
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => setKind(k.id)} className={clsx("rounded-lg border p-3 text-left", kind === k.id ? "border-accent bg-accent/5" : "border-line hover:bg-sunken")} data-testid={`kind-${k.id}`}>
            <div className="flex items-center gap-2 text-[13px] font-medium">{k.icon}{k.title}</div>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{KINDS.find((k) => k.id === kind)!.blurb}</p>

      <div className="mt-4 space-y-3">
        {kind === "local" && (
          <div className="rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-muted">
              <span><HardDrive size={12} className="mr-1 inline" />Sites found in Local</span>
              <button className="text-accent" onClick={loadSites}>Refresh</button>
            </div>
            {siteErr && <div className="p-3 text-xs text-removed">{siteErr}</div>}
            {sites?.length === 0 && !siteErr && <div className="p-3 text-xs text-muted">No sites found. Create one in Local first.</div>}
            {sites?.map((s) => (
              <label key={s.id} className={clsx("flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-0", !s.has_woocommerce && "opacity-50", siteId === s.id && "bg-accent/5")}>
                <input type="radio" name="site" disabled={!s.has_woocommerce} checked={siteId === s.id} onChange={() => setSiteId(s.id)} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{s.name} <span className="font-normal text-muted">· {s.domain}</span></div>
                  <div className="text-2xs text-muted">PHP {s.php_version ?? "?"} · MySQL {s.mysql_version ?? "?"}{s.mysql_port ? ` on :${s.mysql_port}` : ""} · {s.path}</div>
                </div>
                {!s.has_woocommerce && <Badge>No WooCommerce</Badge>}
                {s.has_woocommerce && (s.connector_installed ? <Badge tone="added"><CheckCircle2 size={10} />connector</Badge> : <Badge tone="accent">connector auto-installs</Badge>)}
                {s.status === "running" ? <Badge tone="added">running</Badge> : (
                  <Button size="sm" icon={<Play size={12} />} onClick={async (e) => {
                    e.preventDefault();
                    try {
                      await backend.startLocalSite(s.id);
                      await loadSites();
                    } catch (err) {
                      toast({ tone: "error", title: "Could not start the site", body: String(err) });
                    }
                  }}>Start</Button>
                )}
              </label>
            ))}
          </div>
        )}
        {kind === "connector" && (
          <Field label="Connection string" hint={<>In wp-admin: install <b>CatalogForge Connector</b>, then Tools → CatalogForge → Create connection key. Paste the <code>cf1.…</code> string here. It is stored in your OS keychain.</>}>
            <TextArea rows={3} value={conn} onChange={(e) => setConn(e.target.value)} placeholder="cf1.eyJ2Ijox…" className="font-mono text-xs" data-testid="connection-string" />
          </Field>
        )}
        {kind === "rest" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Store URL" className="col-span-2"><Input value={rest.base_url} onChange={(e) => setRest({ ...rest, base_url: e.target.value })} placeholder="https://shop.example.com" /></Field>
            <Field label="Consumer key"><Input value={rest.consumer_key} onChange={(e) => setRest({ ...rest, consumer_key: e.target.value })} placeholder="ck_…" /></Field>
            <Field label="Consumer secret"><Input type="password" value={rest.consumer_secret} onChange={(e) => setRest({ ...rest, consumer_secret: e.target.value })} placeholder="cs_…" /></Field>
          </div>
        )}
        {kind === "mysql" && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Host" className="col-span-2"><Input value={my.host} onChange={(e) => setMy({ ...my, host: e.target.value })} /></Field>
            <Field label="Port"><Input type="number" value={my.port} onChange={(e) => setMy({ ...my, port: Number(e.target.value) })} /></Field>
            <Field label="Database"><Input value={my.database} onChange={(e) => setMy({ ...my, database: e.target.value })} /></Field>
            <Field label="User"><Input value={my.user} onChange={(e) => setMy({ ...my, user: e.target.value })} /></Field>
            <Field label="Password"><Input type="password" value={my.password} onChange={(e) => setMy({ ...my, password: e.target.value })} /></Field>
            <Field label="Table prefix"><Input value={my.table_prefix} onChange={(e) => setMy({ ...my, table_prefix: e.target.value })} /></Field>
            <Field label="Connector string for writes (optional)" className="col-span-2" hint="Without it the store is read-only: writes always go through WooCommerce so lookup tables and caches stay correct.">
              <Input value={my.connection_string} onChange={(e) => setMy({ ...my, connection_string: e.target.value })} placeholder="cf1.…" />
            </Field>
          </div>
        )}
        <div className="grid grid-cols-3 gap-3 border-t border-line pt-3">
          <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the site name" /></Field>
          <Field label="Environment">
            <Select value={env} onChange={(e) => setEnv(e.target.value as Environment)}>
              <option value="local">Local</option><option value="staging">Staging</option><option value="production">Production (live)</option>
            </Select>
          </Field>
          <Field label="Colour">
            <div className="flex h-8 items-center gap-1.5">
              {COLORS.map((c) => <button key={c} onClick={() => setColor(c)} className={clsx("h-5 w-5 rounded-full", color === c && "ring-2 ring-offset-2 ring-offset-panel")} style={{ background: c, ["--tw-ring-color" as string]: c }} aria-label={`Colour ${c}`} />)}
            </div>
          </Field>
        </div>
        {kind !== "local" && env === "production" && <p className="flex items-center gap-1 text-2xs text-muted"><XCircle size={11} /> Production stores are marked in red everywhere so they are never mistaken for staging.</p>}
      </div>
    </Modal>
  );
}
