import { ArrowRight, Plus, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import pkg from "../../package.json";
import { greetingName, initials } from "../lib/profile";
import { useApp } from "../store/app";
import { Button, clsx } from "./ui";

const ENV = { local: "Local", staging: "Staging", production: "Live" } as const;

/** Welcome screen at launch: greets the user and asks which store to open. */
export function Splash() {
  const { splash, stores, user, enterStore, openDialog } = useApp();
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (!splash || pick) return;
    let last = "";
    try {
      last = localStorage.getItem("cf.store") ?? "";
    } catch {
      /* no memory of the last store */
    }
    setPick(stores.find((s) => s.id === last)?.id ?? stores[0]?.id ?? "");
  }, [splash, stores, pick]);
  if (!splash) return null;

  const who = greetingName(user);
  const current = stores.find((s) => s.id === pick);
  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-gradient-to-br from-accent/15 via-bg to-bg p-6" data-testid="splash">
      <div
        className="w-full max-w-[520px] rounded-2xl border border-line bg-panel p-8 shadow-2xl"
        onKeyDown={(e) => e.key === "Enter" && pick && (e.target as HTMLElement).tagName !== "BUTTON" && enterStore(pick)}
      >
        <div className="mb-6 flex justify-center">
          {/* The logo's dark lettering needs a light backing in dark mode. */}
          <div className="rounded-xl px-4 py-2 dark:bg-white">
            <img src="/brand/logo.png" alt="StoreGenie Pro" className="h-24 w-auto" draggable={false} />
          </div>
        </div>
        <div className="mb-5 flex items-center gap-3">
          {user.avatar ? (
            <img src={user.avatar} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover ring-2 ring-accent/30" />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">{initials(user) || "👋"}</div>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-semibold" data-testid="splash-greeting">{who ? `Welcome back, ${who}!` : "Welcome to StoreGenie Pro"}</h1>
            <p className="text-[13px] text-muted">
              {stores.length ? "Which store do you want to work on?" : "Let's connect your first store."}
              {!who && (
                <>
                  {" "}
                  <button className="text-accent hover:underline" onClick={() => enterStore(pick, "settings")}>Add your name</button>
                </>
              )}
            </p>
          </div>
        </div>

        {stores.length > 0 ? (
          <>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="splash-store">Store</label>
            <div className="relative mb-5">
              <span className="pointer-events-none absolute left-3 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full" style={{ background: current?.color ?? "#999" }} />
              <select
                id="splash-store"
                autoFocus
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                className="h-10 w-full rounded-lg border border-line bg-panel pl-8 pr-3 text-[14px] focus:border-accent focus:outline-none"
                data-testid="splash-store"
              >
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name} · {ENV[s.environment]}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" className="h-10 flex-1 text-[14px]" icon={<ArrowRight size={16} />} disabled={!pick} onClick={() => enterStore(pick)} data-testid="splash-enter">Enter store</Button>
              <Button className="h-10 text-[14px]" icon={<Settings size={15} />} disabled={!pick} onClick={() => enterStore(pick, "settings")} data-testid="splash-settings">Take me to settings</Button>
            </div>
            {current?.environment === "production" && <p className="mt-2 text-2xs text-removed">This is a LIVE store: pushes change your shop straight away (you're always asked first).</p>}
          </>
        ) : (
          <Button variant="primary" className="h-10 w-full text-[14px]" icon={<Plus size={16} />} onClick={() => (useApp.setState({ splash: false }), openDialog("add-store"))} data-testid="splash-add">Add a store</Button>
        )}

        <div className="mt-6 flex items-center justify-between border-t border-line pt-4 text-2xs text-muted">
          <span>{user.storeName || "StoreGenie Pro"}</span>
          <span className={clsx("rounded-full bg-accent/10 px-2 py-px font-semibold text-accent")}>{pkg.version}</span>
          {stores.length > 0 && <button className="text-accent hover:underline" onClick={() => (useApp.setState({ splash: false }), openDialog("add-store"))}>Add another store</button>}
        </div>
      </div>
    </div>
  );
}
