import { AlignCenter, AlignLeft, AlignRight, CaseUpper, Italic } from "lucide-react";
import type { ReactNode } from "react";
import { FONT_FAMILIES, type TextStyle } from "../../lib/catalogue/design";
import { clsx, Input, Select } from "../ui";

export const WEIGHTS: [number, string][] = [[300, "Light"], [400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"]];

/** Fonts loaded from files this design can use ("file:<path>"). */
export type FileFont = { path: string; name: string };

export function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-1.5" title={label}>
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0" aria-label={label ?? "Colour"} />
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-[62px] bg-transparent font-mono text-xs outline-none" spellCheck={false} />
    </label>
  );
}

function IconToggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-pressed={on} onClick={onClick} className={clsx("flex h-8 w-8 items-center justify-center rounded-md border", on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
      {children}
    </button>
  );
}

/** Font, weight, italic, size, colour, alignment and capitals for one text element. */
export function TextStyleEditor({ value, onChange, fonts, onAddFont, align = true, label, testId }: { value: TextStyle; onChange: (s: TextStyle) => void; fonts: FileFont[]; onAddFont: () => Promise<FileFont | null>; align?: boolean; label?: string; testId?: string }) {
  const set = (p: Partial<TextStyle>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-1.5" data-testid={testId}>
      {label && <div className="text-xs font-medium text-muted">{label}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={value.font}
          className="w-40"
          aria-label="Font"
          onChange={async (e) => {
            if (e.target.value === "__add") {
              const f = await onAddFont();
              if (f) set({ font: `file:${f.path}` });
            } else set({ font: e.target.value });
          }}
          style={{ fontFamily: value.font.startsWith("file:") ? undefined : value.font }}
        >
          <optgroup label="Built in">{FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>
          {fonts.length > 0 && <optgroup label="Your fonts">{fonts.map((f) => <option key={f.path} value={`file:${f.path}`}>{f.name.replace(/\.(ttf|otf)$/i, "")}</option>)}</optgroup>}
          <option value="__add">Load a font file (TTF/OTF)…</option>
        </Select>
        <Select value={String(value.weight)} className="w-28" aria-label="Weight" onChange={(e) => set({ weight: Number(e.target.value) })}>
          {WEIGHTS.map(([w, l]) => <option key={w} value={w}>{l}</option>)}
        </Select>
        <div className="flex h-8 items-center rounded-md border border-line bg-panel px-1.5">
          <input type="number" min={4} max={160} step={0.5} value={value.size} onChange={(e) => set({ size: Math.max(4, Number(e.target.value) || value.size) })} className="w-11 bg-transparent text-[13px] outline-none" aria-label="Size" />
          <span className="text-2xs text-muted">pt</span>
        </div>
        <ColorInput value={value.color} onChange={(color) => set({ color })} label="Text colour" />
        <IconToggle on={value.italic} onClick={() => set({ italic: !value.italic })} title="Italic"><Italic size={14} /></IconToggle>
        <IconToggle on={value.uppercase} onClick={() => set({ uppercase: !value.uppercase })} title="Capitals"><CaseUpper size={15} /></IconToggle>
        {align && (
          <div className="flex">
            {([["left", AlignLeft], ["center", AlignCenter], ["right", AlignRight]] as const).map(([a, Icon]) => (
              <IconToggle key={a} on={value.align === a} onClick={() => set({ align: a })} title={`Align ${a}`}><Icon size={14} /></IconToggle>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-line px-4 py-4 last:border-0">
      <div>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, suffix, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string; label: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <div className="flex h-8 items-center rounded-md border border-line bg-panel px-2">
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(e.target.value))))} className="w-full bg-transparent text-[13px] text-fg outline-none" aria-label={label} />
        {suffix && <span className="text-2xs">{suffix}</span>}
      </div>
    </label>
  );
}

export function Check({ checked, onChange, children, testId }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testId?: string }) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} /> {children}
    </label>
  );
}

export { Input };
