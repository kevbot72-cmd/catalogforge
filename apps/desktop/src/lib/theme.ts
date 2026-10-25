// Appearance: accent theme, light/dark, close-button style, density, corners and text size.
// Everything is applied through CSS variables and attributes on <html>, so components only
// ever use the Tailwind tokens (accent, side, close…) and pick changes up instantly.

export interface ThemeDef {
  id: string;
  name: string;
  note: string;
  /** Accent on light backgrounds. */
  light: string;
  /** Accent on dark backgrounds (lighter, so it keeps contrast). */
  dark: string;
}

export const THEMES: ThemeDef[] = [
  { id: "indigo", name: "Indigo", note: "the classic look", light: "#4f46e5", dark: "#818cf8" },
  { id: "ocean", name: "Ocean", note: "calm teal", light: "#0e7490", dark: "#22d3ee" },
  { id: "forest", name: "Forest", note: "fresh green", light: "#15803d", dark: "#4ade80" },
  { id: "plum", name: "Plum", note: "soft purple", light: "#7e22ce", dark: "#c084fc" },
  { id: "copper", name: "Copper", note: "warm orange", light: "#c2410c", dark: "#fb923c" },
  { id: "graphite", name: "Graphite", note: "no colour, all business", light: "#3f3f46", dark: "#a1a1aa" },
];

export type Mode = "light" | "dark" | "system";
export type CloseStyle = "a" | "b" | "c";
export type Density = "comfortable" | "compact";
export type Corners = "square" | "soft" | "round";
export type TextSize = "small" | "normal" | "large";

export interface Appearance {
  theme: string;
  /** Hex accent when theme is "custom". */
  custom: string;
  mode: Mode;
  close: CloseStyle;
  density: Density;
  corners: Corners;
  text: TextSize;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "indigo", custom: "#db2777", mode: "system", close: "b", density: "comfortable", corners: "soft", text: "normal" };

const KEY = "cf.appearance";

export function loadAppearance(): Appearance {
  let saved: Partial<Appearance> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // Before 0.5.0 only dark mode was remembered.
    const dark = localStorage.getItem("cf.dark");
    if (!saved.mode && dark !== null) saved.mode = dark === "1" ? "dark" : "light";
  } catch {
    /* storage unavailable: defaults */
  }
  return { ...DEFAULT_APPEARANCE, ...saved };
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* preference only */
  }
}

export function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function isDark(a: Appearance): boolean {
  return a.mode === "dark" || (a.mode === "system" && systemDark());
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  const n = parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [79, 70, 229];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as [number, number, number];
}

const hex = (c: [number, number, number]) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");

/** The accent colour actually in use, as hex (the grid canvas needs real colours). */
export function accentHex(a: Appearance, dark: boolean): string {
  const t = THEMES.find((x) => x.id === a.theme);
  if (t) return dark ? t.dark : t.light;
  const base = rgb(a.custom);
  return hex(dark ? mix(base, [255, 255, 255], 0.35) : base);
}

const RADIUS: Record<Corners, string> = { square: "2px", soft: "6px", round: "10px" };
const ZOOM: Record<TextSize, number> = { small: 0.92, normal: 1, large: 1.1 };
let lastZoom = 1;

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  const dark = isDark(a);
  root.classList.toggle("dark", dark);
  const accent = rgb(accentHex(a, dark));
  root.style.setProperty("--accent", accent.join(" "));
  // The sidebar takes a hint of the accent; barely there, but it ties the theme together.
  const side = dark ? mix([22, 22, 26], accent, 0.04) : mix([255, 255, 255], accent, 0.025);
  root.style.setProperty("--side", side.join(" "));
  root.style.setProperty("--r", RADIUS[a.corners]);
  root.dataset.close = a.close;
  root.dataset.density = a.density;
  const zoom = ZOOM[a.text];
  if (zoom !== lastZoom) {
    lastZoom = zoom;
    if ("__TAURI_INTERNALS__" in window) {
      // Real page zoom in the desktop app: crisp text and correct grid hit-testing.
      import("@tauri-apps/api/webview").then((m) => m.getCurrentWebview().setZoom(zoom)).catch(() => {
        (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
      });
    } else {
      (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
    }
  }
}
