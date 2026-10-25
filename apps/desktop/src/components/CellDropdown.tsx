import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Choice } from "../lib/fieldOptions";
import { clsx } from "./ui";

export interface CellDropdownState {
  /** Viewport rectangle of the cell the list hangs from. */
  bounds: { x: number; y: number; width: number; height: number };
  title: string;
  choices: Choice[];
  current: string | null;
  /** How many rows the choice applies to (several when the clicked row is among the ticked ones). */
  count: number;
  onPick: (value: string) => void;
}

/** The options list that opens on a Status, Stock status, Visibility, Type or yes/no cell. */
export function CellDropdown({ state, onClose }: { state: CellDropdownState; onClose: () => void }) {
  const start = Math.max(0, state.choices.findIndex((c) => c.value === state.current));
  const [active, setActive] = useState(start);
  const activeRef = useRef(active);
  activeRef.current = active;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const n = state.choices.length;
      if (e.key === "ArrowDown") setActive((a) => (a + 1) % n);
      else if (e.key === "ArrowUp") setActive((a) => (a - 1 + n) % n);
      else if (e.key === "Home") setActive(0);
      else if (e.key === "End") setActive(n - 1);
      else if (e.key === "Enter" || e.key === " ") {
        state.onPick(state.choices[activeRef.current].value);
        onClose();
      } else if (e.key === "Escape" || e.key === "Tab") onClose();
      else if (e.key.length === 1) {
        // Type a letter to jump to the first choice starting with it.
        const i = state.choices.findIndex((c) => c.label.toLowerCase().startsWith(e.key.toLowerCase()));
        if (i >= 0) setActive(i);
        else return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("keydown", key, true);
    // On the next tick, so the click that opened the list doesn't close it.
    const t = setTimeout(() => window.addEventListener("mousedown", down, true));
    window.addEventListener("resize", onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("resize", onClose);
    };
  }, [state, onClose]);

  const { bounds } = state;
  const width = Math.max(bounds.width, 180);
  const below = bounds.y + bounds.height + state.choices.length * 32 + 48 < window.innerHeight;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(bounds.x, window.innerWidth - width - 8),
    width,
    ...(below ? { top: bounds.y + bounds.height + 2 } : { bottom: window.innerHeight - bounds.y + 2 }),
  };

  return createPortal(
    <div ref={ref} style={style} role="listbox" aria-label={state.title} className="z-[150] rounded-lg border border-line bg-panel p-1 shadow-xl" data-testid="cell-dropdown">
      {state.choices.map((c, i) => (
        <button
          key={c.value}
          role="option"
          aria-selected={c.value === state.current}
          onMouseEnter={() => setActive(i)}
          onClick={() => {
            state.onPick(c.value);
            onClose();
          }}
          className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", i === active && "bg-sunken", c.value === state.current && "font-semibold text-accent")}
        >
          <span className="w-3.5">{c.value === state.current && <Check size={13} />}</span>
          {c.label}
        </button>
      ))}
      {state.count > 1 && <div className="mt-1 border-t border-line px-2 pb-0.5 pt-1.5 text-2xs text-muted">Applies to all {state.count} ticked rows</div>}
    </div>,
    document.getElementById("portal") ?? document.body,
  );
}
