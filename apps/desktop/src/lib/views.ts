// Saved column views for the products grid: the built-in ones (Default, Pricing…) and views the
// user creates, renames and deletes. Column order and visibility changes are saved into the view
// that is open; a changed built-in view can be reset to how it shipped.

export interface UserView {
  id: string;
  name: string;
  columns: string[];
}

export interface ViewState {
  /** Id of the open view: a built-in's name, or a user view's id ("v-…"). */
  active: string;
  views: UserView[];
  /** Column lists for built-in views the user has changed (by built-in name). */
  overrides: Record<string, string[]>;
}

const KEY = "cf.views";

export function loadViews(builtIns: Record<string, string[]>): ViewState {
  const fallback: ViewState = { active: "Default", views: [], overrides: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as ViewState | null;
    if (saved) return { ...fallback, ...saved };
    // Before 0.5.1 there was one unnamed "Custom" view and the open preset's name.
    const legacy = JSON.parse(localStorage.getItem("cf.columns") ?? "null") as string[] | null;
    const preset = localStorage.getItem("cf.preset") ?? "Default";
    const views = legacy?.length ? [{ id: "v-custom", name: "Custom", columns: legacy }] : [];
    const active = preset === "Custom" && views.length ? "v-custom" : builtIns[preset] ? preset : "Default";
    return { active, views, overrides: {} };
  } catch {
    return fallback;
  }
}

export function saveViews(s: ViewState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* preference only */
  }
}

export const isUserView = (id: string) => id.startsWith("v-");

/** The column ids the open view shows. */
export function viewColumns(s: ViewState, builtIns: Record<string, string[]>): string[] {
  if (isUserView(s.active)) return s.views.find((v) => v.id === s.active)?.columns ?? builtIns.Default;
  return s.overrides[s.active] ?? builtIns[s.active] ?? builtIns.Default;
}

export function viewName(s: ViewState, id = s.active): string {
  return isUserView(id) ? s.views.find((v) => v.id === id)?.name ?? "View" : id;
}

/** Saves a new column list into the open view. */
export function setViewColumns(s: ViewState, columns: string[]): ViewState {
  if (isUserView(s.active)) return { ...s, views: s.views.map((v) => (v.id === s.active ? { ...v, columns } : v)) };
  return { ...s, overrides: { ...s.overrides, [s.active]: columns } };
}

/** A name nobody else uses: "My view", "My view 2"… */
export function uniqueName(s: ViewState, builtIns: Record<string, string[]>, wanted: string, except?: string): string {
  const taken = new Set([...Object.keys(builtIns), ...s.views.filter((v) => v.id !== except).map((v) => v.name)].map((n) => n.toLowerCase()));
  const base = wanted.trim() || "My view";
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Creates a view from the current columns and opens it. */
export function addView(s: ViewState, builtIns: Record<string, string[]>, name: string, columns: string[]): ViewState {
  const id = `v-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { ...s, active: id, views: [...s.views, { id, name: uniqueName(s, builtIns, name), columns: [...columns] }] };
}

export function renameView(s: ViewState, builtIns: Record<string, string[]>, id: string, name: string): ViewState {
  return { ...s, views: s.views.map((v) => (v.id === id ? { ...v, name: uniqueName(s, builtIns, name, id) } : v)) };
}

export function deleteView(s: ViewState, id: string): ViewState {
  return { ...s, active: s.active === id ? "Default" : s.active, views: s.views.filter((v) => v.id !== id) };
}

export function resetBuiltIn(s: ViewState, name: string): ViewState {
  const overrides = { ...s.overrides };
  delete overrides[name];
  return { ...s, overrides };
}

/** Moves a column within the list (grid drag and drop). */
export function moveColumn(columns: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= columns.length || to >= columns.length) return columns;
  const next = [...columns];
  const [c] = next.splice(from, 1);
  next.splice(to, 0, c);
  return next;
}
