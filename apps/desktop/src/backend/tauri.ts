import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Backend, LocalFile, Progress } from "./types";

type FileInfo = { path: string; name: string; size: number };

const toLocal = (f: FileInfo): LocalFile => ({ ...f, url: convertFileSrc(f.path) });

/** Tauri gives dropped files as paths; re-dispatch them to whichever drop zone is under the cursor. */
let dropBridgeInstalled = false;
function installDropBridge() {
  if (dropBridgeInstalled) return;
  dropBridgeInstalled = true;
  getCurrentWebview()
    .onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      const ratio = window.devicePixelRatio || 1;
      const x = e.payload.position.x / ratio;
      const y = e.payload.position.y / ratio;
      const files = (await invoke<FileInfo[]>("scan_paths", { paths: e.payload.paths })).map(toLocal);
      const target = document.elementFromPoint(x, y)?.closest("[data-dropzone]") ?? document.body;
      target.dispatchEvent(new CustomEvent("cf-native-drop", { bubbles: true, detail: { files, paths: e.payload.paths } }));
    })
    .catch(() => {});
}

export function createTauriBackend(): Backend {
  installDropBridge();
  return {
    kind: "tauri",
    listStores: () => invoke("list_stores"),
    addStore: (input) => invoke("add_store", { input }),
    removeStore: (id) => invoke("remove_store", { id }),
    localSites: () => invoke("local_sites"),
    startLocalSite: (siteId) => invoke("start_local_site", { siteId }),
    openStore: (id) => invoke("open_store", { id }),
    pull: (id, full) => invoke("pull", { id, full }),
    query: (id, q) => invoke("query", { id, q }),
    rows: (id, keys) => invoke("rows", { id, keys }),
    skus: (id) => invoke("skus", { id }),
    variations: (id, parentKey) => invoke("variations", { id, parentKey }),
    taxonomy: (id) => invoke("taxonomy", { id }),
    media: (id) => invoke("media", { id }),
    stage: (id, edits) => invoke("stage", { id, edits }),
    create: (id, items) => invoke("create", { id, items: items.map((i) => ({ entity: i.entity, key: i.key ?? null, fields: i.fields })) }),
    remove: (id, entity, keys) => invoke("remove", { id, entity, keys }),
    undo: (id) => invoke("undo", { id }),
    discard: (id, entity, key, field) => invoke("discard", { id, entity: entity ?? null, key: key ?? null, field: field ?? null }),
    summary: (id) => invoke("summary", { id }),
    changes: (id) => invoke("changes", { id }),
    resolveConflict: (id, entity, key, field, keepMine) => invoke("resolve_conflict", { id, entity, key, field, keepMine }),
    push: (id, label) => invoke("push", { id, label }),
    history: (id) => invoke("history", { id }),
    historyItems: (id, historyId) => invoke("history_items", { id, historyId }),
    revert: (id, historyId) => invoke("revert", { id, historyId }),
    preview: (id, productId, draft) => invoke("preview", { id, productId, draft }),
    cloneProducts: (src, dst, ids, opts) => invoke("clone_products", { src, dst, ids, opts }),
    async pickFiles({ directory, multiple, extensions }) {
      const picked = await open({ directory: !!directory, multiple: multiple ?? true, filters: extensions ? [{ name: "Files", extensions }] : undefined });
      if (!picked) return [];
      const paths = Array.isArray(picked) ? picked : [picked];
      return (await invoke<FileInfo[]>("scan_paths", { paths })).map(toLocal);
    },
    async saveFile({ defaultName, filterName, extension, bytes }) {
      const path = await save({ defaultPath: defaultName, filters: [{ name: filterName, extensions: [extension] }] });
      if (!path) return null;
      // Raw IPC body: no JSON encoding, so large exports stay fast.
      await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
      return path;
    },
    async filesFromDrop(files) {
      // Native drops arrive through the cf-native-drop bridge; HTML5 File objects have no path here.
      return files.map((f) => ({ path: (f as File & { path?: string }).path ?? f.name, name: f.name, url: URL.createObjectURL(f), size: f.size }));
    },
    getMediaSettings: () => invoke("get_media_settings"),
    setMediaSettings: (settings) => invoke("set_media_settings", { settings }),
    onProgress(cb) {
      let un: (() => void) | undefined;
      listen<{ store_id: string; progress: Progress }>("progress", (e) => cb(e.payload.store_id, e.payload.progress)).then((u) => (un = u));
      return () => un?.();
    },
  };
}

/** Reads a local file into a File object (for spreadsheets picked through the native dialog). */
export async function readLocalFile(path: string, name: string): Promise<File> {
  const bytes = await invoke<ArrayBuffer>("read_file", { path });
  return new File([bytes], name);
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
