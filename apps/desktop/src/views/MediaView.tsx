import { Search, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Edit } from "../backend/types";
import { Badge, Button, Empty, Input, Thumb } from "../components/ui";
import { useApp } from "../store/app";

export function MediaView() {
  const { media, stage, backend, storeId, toast } = useApp();
  const [q, setQ] = useState("");
  const [missingAlt, setMissingAlt] = useState(false);
  const list = useMemo(
    () => [...media.values()].filter((m) => (!missingAlt || !m.alt) && (!q || `${m.filename} ${m.alt} ${m.title}`.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => b.id - a.id),
    [media, q, missingAlt],
  );
  const noAlt = useMemo(() => [...media.values()].filter((m) => !m.alt).length, [media]);

  const fillAlt = async () => {
    if (!storeId) return;
    const targets = [...media.values()].filter((m) => !m.alt && m.parent_id > 0);
    const parents = await backend.rows(storeId, [...new Set(targets.map((m) => String(m.parent_id)))]);
    const names = new Map(parents.map((p) => [p.id, p.name]));
    const edits: Edit[] = targets.filter((m) => names.get(m.parent_id)).map((m) => ({ entity: "media", key: String(m.id), field: "alt", value: names.get(m.parent_id) }));
    await stage(edits);
    toast({ tone: "success", title: `Alt text staged for ${edits.length} images`, body: "Generated from each image's product name." });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="relative w-72">
          <Search size={14} className="absolute left-2.5 top-2 text-muted" />
          <Input className="pl-8" placeholder="Search file name or alt text" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button onClick={() => setMissingAlt(!missingAlt)} className={`h-7 rounded-full border px-2.5 text-xs ${missingAlt ? "border-accent bg-accent/10 text-accent" : "border-line text-muted"}`}>Missing alt text ({noAlt})</button>
        <span className="flex-1" />
        <Button size="sm" icon={<Wand2 size={14} />} onClick={fillAlt} disabled={!noAlt}>Fill missing alt text from product names</Button>
      </div>
      {!list.length ? (
        <Empty title="No media">Images attached to products and categories appear here. Drop images onto a product's Media tab, a category, or use Import with an image folder.</Empty>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-auto p-4">
          {list.slice(0, 1500).map((m) => (
            <div key={m.id} className="overflow-hidden rounded-lg border border-line bg-panel">
              <Thumb src={m.thumb_url || m.url} size={150} className="aspect-square h-auto w-full rounded-none" alt={m.alt} />
              <div className="space-y-1 p-2">
                <div className="truncate text-xs font-medium" title={m.filename}>{m.filename}</div>
                <input
                  className="w-full rounded border border-transparent bg-transparent px-1 text-2xs text-muted hover:border-line focus:border-accent focus:text-fg focus:outline-none"
                  defaultValue={m.alt}
                  placeholder="Add alt text…"
                  onBlur={(e) => e.target.value !== m.alt && stage([{ entity: "media", key: String(m.id), field: "alt", value: e.target.value }])}
                />
                <div className="flex gap-1">{m.width > 0 && <Badge>{m.width}×{m.height}</Badge>}{m.mime && <Badge>{m.mime.replace("image/", "")}</Badge>}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
