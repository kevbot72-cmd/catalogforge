import type { BatchImage, BatchItem } from "../../lib/batch";
import { clsx } from "../ui";

export type SlotRef = { t: "slot"; i: number; j: number } | { t: "pool"; id: string };

function Slot({ file, label, selected, onClick, testId }: { file: BatchImage | null; label: string; selected: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} aria-label={`${file ? file.name : "Empty slot"} · ${label}`} className="flex w-[72px] flex-col items-center gap-0.5 text-2xs text-muted" data-testid={testId}>
      <span className={clsx("flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-md border bg-sunken", file ? "border-line" : "border-dashed border-line", selected && "outline outline-[3px] outline-offset-1 outline-accent")}>
        {file ? <img src={file.url} alt="" className="h-full w-full object-cover" draggable={false} /> : "Empty"}
      </span>
      <span className="max-w-[72px] truncate">{label}</span>
    </button>
  );
}

/**
 * Each product's featured + gallery slots. Click one image, then another (or an empty slot) to
 * swap them; click an unmatched image, then a slot, to place it.
 */
export function ImageSlots({ items, assign, files, selected, onPick, slots }: { items: BatchItem[]; assign: (string | null)[][]; files: Map<string, BatchImage>; selected: SlotRef | null; onPick: (r: SlotRef) => void; slots: number }) {
  const used = new Set(assign.flat().filter(Boolean));
  const free = [...files.values()].filter((f) => !used.has(f.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const isSel = (r: SlotRef) => !!selected && selected.t === r.t && (r.t === "pool" ? (selected as { id: string }).id === r.id : (selected as { i: number; j: number }).i === r.i && (selected as { i: number; j: number }).j === r.j);
  return (
    <div className="space-y-2" data-testid="image-slots">
      {free.length > 0 && (
        <div className="space-y-1.5 rounded-md bg-changed/10 p-2.5">
          <div className="text-xs font-medium text-changed">Not matched ({free.length}): click one, then a product slot to place it.</div>
          <div className="flex flex-wrap gap-2">{free.map((f) => <Slot key={f.id} file={f} label={f.name} selected={isSel({ t: "pool", id: f.id })} onClick={() => onPick({ t: "pool", id: f.id })} />)}</div>
        </div>
      )}
      <div className="max-h-[520px] space-y-1.5 overflow-auto pr-1">
        {items.slice(0, 300).map((it, i) => (
          <div key={it.index} className="flex flex-wrap items-center gap-2.5 rounded-md border border-line p-2">
            <div className="min-w-0 flex-1 basis-40 text-xs">
              <div className="truncate font-medium text-fg">{it.title}</div>
              <div className="truncate font-mono text-2xs text-muted">{it.sku}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: slots }, (_, j) => {
                const id = assign[i]?.[j] ?? null;
                return <Slot key={j} file={id ? files.get(id) ?? null : null} label={j === 0 ? "Featured" : `Gallery ${j}`} selected={isSel({ t: "slot", i, j })} onClick={() => onPick({ t: "slot", i, j })} testId={`slot-${i}-${j}`} />;
              })}
            </div>
          </div>
        ))}
        {items.length > 300 && <div className="p-2 text-xs text-muted">Showing the first 300 products; the rest are matched the same way.</div>}
      </div>
    </div>
  );
}
