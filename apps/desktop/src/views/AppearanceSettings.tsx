import { RotateCcw } from "lucide-react";
import { Button, clsx } from "../components/ui";
import { accentHex, DEFAULT_APPEARANCE, THEMES, type Appearance } from "../lib/theme";
import { useApp } from "../store/app";

function Segmented<T extends string>({ value, onChange, options, testId }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; style?: React.CSSProperties }[]; testId?: string }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-line" role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          style={o.style}
          className={clsx("whitespace-nowrap px-3 py-1.5 text-[12.5px]", value === o.id ? "bg-accent/10 font-semibold text-accent" : "text-fg hover:bg-sunken")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted">{label}</span>
      {children}
      {hint && <span className="text-2xs text-muted">{hint}</span>}
    </div>
  );
}

/** Settings → Appearance: small, subtle personalisation on top of the chosen theme. */
export function AppearanceSettings() {
  const { appearance: a, setAppearance, dark } = useApp();
  const set = (p: Partial<Appearance>) => setAppearance(p);
  return (
    <section data-testid="appearance">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Appearance</h2>
        <span className="text-xs text-muted">Small touches only. Layout and the green/amber/red change colours never move.</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => set({ ...DEFAULT_APPEARANCE, theme: a.theme, custom: a.custom, mode: a.mode })} title="Keep the theme, reset everything else">Reset to theme</Button>
      </div>
      <div className="space-y-5 rounded-lg border border-line bg-panel p-4">
        <Row label="Theme">
          <div className="flex flex-wrap items-center gap-3">
            {THEMES.map((t) => (
              <button key={t.id} onClick={() => set({ theme: t.id })} className={clsx("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12.5px]", a.theme === t.id ? "border-accent bg-accent/5" : "border-line hover:bg-sunken")} data-testid={`theme-${t.id}`} aria-pressed={a.theme === t.id}>
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: dark ? t.dark : t.light }} />
                <span className="font-medium">{t.name}</span>
                <span className="text-2xs text-muted">{t.note}</span>
              </button>
            ))}
            <label className={clsx("flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12.5px]", a.theme === "custom" ? "border-accent bg-accent/5" : "border-dashed border-line hover:bg-sunken")} title="Pick any accent colour">
              <span className="h-3.5 w-3.5 rounded-full" style={{ background: a.theme === "custom" ? accentHex(a, dark) : a.custom }} />
              <span className="font-medium">Your colour</span>
              <input type="color" value={a.custom} onChange={(e) => set({ theme: "custom", custom: e.target.value })} className="h-0 w-0 opacity-0" data-testid="theme-custom" />
            </label>
          </div>
        </Row>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Row label="Mode">
            <Segmented value={a.mode} onChange={(mode) => set({ mode })} options={[{ id: "light", label: "Light" }, { id: "system", label: "Match computer" }, { id: "dark", label: "Dark" }]} testId="appearance-mode" />
          </Row>
          <Row label="Close and cancel buttons" hint="How ✕, Cancel, Discard and Delete look everywhere.">
            <div className="flex items-center gap-3">
              <Segmented value={a.close} onChange={(close) => set({ close })} options={[{ id: "a", label: "A · Red text" }, { id: "b", label: "B · Outline" }, { id: "c", label: "C · Pill" }]} testId="appearance-close" />
              <Button size="sm" variant="close" tabIndex={-1}>✕ Close</Button>
            </div>
          </Row>
          <Row label="Density" hint="Compact fits more rows in the grid and edit panel.">
            <Segmented value={a.density} onChange={(density) => set({ density })} options={[{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }]} testId="appearance-density" />
          </Row>
          <Row label="Corners">
            <Segmented value={a.corners} onChange={(corners) => set({ corners })} options={[{ id: "square", label: "Square" }, { id: "soft", label: "Soft" }, { id: "round", label: "Round" }]} />
          </Row>
          <Row label="Text size">
            <Segmented value={a.text} onChange={(text) => set({ text })} options={[{ id: "small", label: "Small", style: { fontSize: 12 } }, { id: "normal", label: "Normal", style: { fontSize: 13 } }, { id: "large", label: "Large", style: { fontSize: 14.5 } }]} testId="appearance-text" />
          </Row>
        </div>
      </div>
    </section>
  );
}
