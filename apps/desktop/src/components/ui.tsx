import clsx from "clsx";
import { X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { LocalFile, MediaValue, Media } from "../backend/types";

export { clsx };

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; icon?: ReactNode }>(
  ({ variant = "secondary", size = "md", icon, className, children, ...rest }, ref) => (
    <button
      ref={ref}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-accent text-white shadow-sm hover:bg-accent/90",
        variant === "secondary" && "border border-line bg-panel hover:bg-sunken",
        variant === "ghost" && "text-muted hover:bg-sunken hover:text-fg",
        variant === "danger" && "bg-removed text-white hover:bg-removed/90",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  ),
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={clsx("h-8 rounded-md border border-line bg-panel px-2.5 text-[13px] placeholder:text-muted focus:border-accent focus:outline-none", !/\bw-/.test(className ?? "") && "w-full", className)} {...rest} />
));

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={clsx("w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[13px] placeholder:text-muted focus:border-accent focus:outline-none", className)} {...rest} />
));

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx("h-8 rounded-md border border-line bg-panel px-2 text-[13px] focus:border-accent focus:outline-none", !/\bw-/.test(className ?? "") && "w-full", className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className, changed }: { label: string; hint?: ReactNode; children: ReactNode; className?: string; changed?: boolean }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
        {label}
        {changed && <span className="h-1.5 w-1.5 rounded-full bg-changed" title="Changed, not pushed yet" />}
      </span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-[13px]">
      <span className={clsx("relative h-4 w-7 rounded-full transition-colors", checked ? "bg-accent" : "bg-line")}>
        <span className={clsx("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all", checked ? "left-3.5" : "left-0.5")} />
      </span>
      {label}
    </button>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "added" | "changed" | "removed" | "accent"; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium",
        tone === "neutral" && "bg-sunken text-muted",
        tone === "added" && "bg-added/15 text-added",
        tone === "changed" && "bg-changed/15 text-changed",
        tone === "removed" && "bg-removed/15 text-removed",
        tone === "accent" && "bg-accent/15 text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 640, testId }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; testId?: string }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 flex items-start justify-center bg-black/40 p-6 pt-[8vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div data-testid={testId} role="dialog" aria-label={typeof title === "string" ? title : undefined} className="flex max-h-[84vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-sunken" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-sunken/50 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.getElementById("portal") ?? document.body,
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="flex gap-1 border-b border-line px-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx("-mb-px border-b-2 px-2.5 py-2 text-[13px] font-medium", value === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-sunken", className)}>
      {total > 0 ? <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} /> : <div className="cf-indeterminate h-full w-1/3 rounded-full bg-accent" />}
    </div>
  );
}

/** Drop target for files: HTML5 drops (browser) and native drops with real paths (desktop). */
export function Dropzone({ onFiles, toFiles, children, className, activeClassName = "ring-2 ring-accent ring-inset bg-accent/5", testId }: {
  onFiles: (files: LocalFile[], raw: File[]) => void;
  toFiles: (files: File[]) => Promise<LocalFile[]>;
  children: ReactNode;
  className?: string;
  activeClassName?: string;
  testId?: string;
}) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: Event) => {
      e.stopPropagation();
      onFiles((e as CustomEvent).detail.files, []);
    };
    el.addEventListener("cf-native-drop", h);
    return () => el.removeEventListener("cf-native-drop", h);
  }, [onFiles]);
  return (
    <div
      ref={ref}
      data-dropzone
      data-testid={testId}
      className={clsx(className, over && activeClassName)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const raw = [...e.dataTransfer.files];
        onFiles(await toFiles(raw), raw);
      }}
    >
      {children}
    </div>
  );
}

export function mediaUrl(v: MediaValue | undefined | null, media: Map<number, Media>, size: "thumb" | "medium" | "full" = "thumb"): string | null {
  if (!v) return null;
  if (typeof v === "number") {
    const m = media.get(v);
    if (!m) return null;
    return size === "thumb" ? m.thumb_url || m.url : size === "medium" ? m.medium_url || m.url : m.url;
  }
  return v.preview ?? v.url ?? null;
}

export function Thumb({ src, size = 32, className, alt = "" }: { src: string | null; size?: number; className?: string; alt?: string }) {
  return src ? (
    <img src={src} alt={alt} width={size} height={size} className={clsx("shrink-0 rounded object-cover", className)} style={{ width: size, height: size }} loading="lazy" draggable={false} />
  ) : (
    <div className={clsx("shrink-0 rounded border border-dashed border-line bg-sunken", className)} style={{ width: size, height: size }} />
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted">
      {icon}
      <div className="text-sm font-medium text-fg">{title}</div>
      <div className="max-w-sm text-[13px]">{children}</div>
    </div>
  );
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" && x ? ((x as { name?: string; file?: string; url?: string }).name ?? (x as { file?: string }).file?.split(/[\\/]/).pop() ?? (x as { url?: string }).url ?? "…") : String(x))).join(", ") : "—";
  if (typeof v === "object") {
    const o = v as { file?: string; url?: string };
    if (o.file) return "📷 " + o.file.split(/[\\/]/).pop();
    if (o.url) return "🔗 " + o.url.split("/").pop();
    return JSON.stringify(v);
  }
  const s = String(v).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
