import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { clsx } from "../ui";

/** pdf.js is large; it loads the first time a preview is shown. */
let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
export function loadPdfJs() {
  pdfjs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

function PageCanvas({ doc, index, width, onClick, label }: { doc: PDFDocumentProxy; index: number; width: number; onClick?: () => void; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(1.414);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    doc.getPage(index + 1).then((page) => {
      if (cancelled || !ref.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const canvas = ref.current;
      canvas.width = vp.width;
      canvas.height = vp.height;
      const t = page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp });
      task = t;
      t.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, width, visible]);
  return (
    <div ref={box} className="flex flex-col items-center gap-1">
      <div className={clsx("bg-white shadow-md ring-1 ring-black/10", onClick && "cursor-zoom-in")} style={{ width, height: width * ratio }} onClick={onClick}>
        <canvas ref={ref} style={{ width, height: width * ratio }} />
      </div>
      {label && <div className="text-2xs text-muted">{label}</div>}
    </div>
  );
}

/** Scrollable preview of a PDF, as single pages or printed spreads (cover alone, then pairs). */
export function PdfPreview({ bytes, spread, width, onOpen, testId = "pdf-preview", numbers }: { bytes: Uint8Array | null; spread: boolean; width: number; onOpen?: (page: number) => void; testId?: string; numbers?: number[] }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    loadPdfJs()
      .then((lib) => lib.getDocument({ data: bytes.slice() }).promise)
      .then((d) => {
        loaded = d;
        if (cancelled) d.destroy();
        else {
          setDoc((old) => {
            old?.destroy();
            return d;
          });
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
      void loaded;
    };
  }, [bytes]);
  if (error) return <div className="p-6 text-sm text-removed">Preview failed: {error}</div>;
  if (!doc) return null;
  const n = doc.numPages;
  // Page numbers in the full document (quick previews skip pages); spreads pair them as printed:
  // page 1 alone on the right, then 2–3, 4–5…
  const num = (i: number) => numbers?.[i] ?? i;
  const groups: { left: number | null; right: number | null; key: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!spread) groups.push({ left: null, right: i, key: i });
    else {
      const key = Math.ceil(num(i) / 2);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) groups.push((g = { left: null, right: null, key }));
      if (num(i) % 2 === 1) g.left = i;
      else g.right = i;
    }
  }
  return (
    <div className="flex flex-col items-center gap-6 py-6" data-testid={testId} data-pages={n}>
      {groups.map((g, gi) => (
        <div key={g.key}>
          {spread && gi > 0 && num(g.left ?? g.right ?? 0) - 1 > num(groups[gi - 1].right ?? groups[gi - 1].left ?? 0) && (
            <div className="mb-4 text-center text-2xs text-muted">… pages not drawn in the quick preview …</div>
          )}
          <div className="flex">
            {spread && (g.left !== null ? <PageCanvas doc={doc} index={g.left} width={width} onClick={onOpen ? () => onOpen(g.left!) : undefined} /> : <div style={{ width }} />)}
            {g.right !== null ? <PageCanvas doc={doc} index={g.right} width={width} onClick={onOpen ? () => onOpen(g.right!) : undefined} label={spread ? undefined : `Page ${num(g.right) + 1}`} /> : spread && <div style={{ width }} />}
          </div>
        </div>
      ))}
    </div>
  );
}
