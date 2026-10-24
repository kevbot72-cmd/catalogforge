// Draws a planned catalogue with pdf-lib: template backgrounds, cover, contents, product pages,
// A–Z index and back cover, plus clickable links, QR codes and PDF bookmarks.

import { clip, endPath, PDFDocument, PDFHexString, PDFName, PDFString, popGraphicsState, pushGraphicsState, rectangle, rgb, degrees, type PDFEmbeddedPage, type PDFImage, type PDFPage, type PDFRef, type RGB } from "pdf-lib";
import QRCode from "qrcode";
import type { CatalogueDesign, CoverText, HeaderFooter, TextStyle } from "./design";
import { fillTokens } from "./design";
import { FontBook, type FontLoader, type PrintFont } from "./fonts";
import type { Block, CataloguePlan, CatNode, CatProduct, PagePlan } from "./plan";
import { AZ_LINE, INDEX_LINE, isLeftPage } from "./plan";
import { fit, formatPrice, wrap } from "./text";

export interface RenderInput {
  design: CatalogueDesign;
  plan: CataloguePlan;
  meta: { store: string; website: string; currencySymbol: string; decimals: number };
  /** Custom field key → label, for fields shown on cards. */
  customLabels: Record<string, string>;
  /** An upright JPEG of `src` at most `maxPx` wide/high, or null. */
  image: (src: string, maxPx: number) => Promise<Uint8Array | null>;
  readFile: (path: string) => Promise<Uint8Array>;
  fontLoader: FontLoader;
  /** Quick preview: smaller images. */
  preview?: boolean;
  onProgress?: (done: number, total: number, message: string) => void;
  signal?: AbortSignal;
}

export function hex(c: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim()) ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c.trim());
  if (!m) return rgb(0, 0, 0);
  const h = m.length === 2 ? m[1] : m.slice(1).map((x) => x + x).join("");
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

const mix = (c: string, white: number) => {
  const { red, green, blue } = hex(c) as unknown as { red: number; green: number; blue: number };
  return rgb(red + (1 - red) * white, green + (1 - green) * white, blue + (1 - blue) * white);
};

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

export async function templateInfo(bytes: Uint8Array): Promise<{ pages: number; size: [number, number] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const p = doc.getPage(0);
  return { pages: doc.getPageCount(), size: [p.getWidth(), p.getHeight()] };
}

export async function renderCatalogue(input: RenderInput): Promise<Uint8Array> {
  const { design: d, plan, meta } = input;
  const g = plan.geometry;
  const W = g.width;
  const H = g.height;
  const doc = await PDFDocument.create();
  const fonts = new FontBook(doc, input.fontLoader, input.readFile);
  const progress = input.onProgress ?? (() => {});
  const tokens = (page: number, section = "") => ({
    store: meta.store,
    website: meta.website.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    category: section,
    page: String(page + 1),
    pages: String(plan.totalPages ?? plan.pages.length),
    date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
    title: d.coverTexts.find((t) => t.id === "title")?.text ?? meta.store,
  });

  /* ---------------------------------------------------------- template pages */
  const template: Partial<Record<keyof CatalogueDesign["templatePages"], PDFEmbeddedPage>> = {};
  if (d.templateFile) {
    const tpl = await PDFDocument.load(await input.readFile(d.templateFile.path), { ignoreEncryption: true });
    const embedded = new Map<number, PDFEmbeddedPage>();
    for (const [role, idx] of Object.entries(d.templatePages) as [keyof CatalogueDesign["templatePages"], number | null][]) {
      if (idx === null || idx < 0 || idx >= tpl.getPageCount()) continue;
      if (!embedded.has(idx)) embedded.set(idx, await doc.embedPage(tpl.getPage(idx)));
      template[role] = embedded.get(idx)!;
    }
  }

  /* ------------------------------------------------------------------ images */
  const dpi = input.preview || d.imageQuality === "screen" ? 110 : 220;
  const px = (pt: number) => Math.round(Math.min(2400, Math.max(240, (pt / 72) * dpi)));
  const wanted = new Map<string, number>(); // src → max px
  const want = (src: string | null, pt: number) => src && wanted.set(src, Math.max(wanted.get(src) ?? 0, px(pt)));
  for (const p of plan.pages) {
    if (p.kind === "content") for (const b of p.blocks) if ("product" in b && d.show.image) want(input.preview ? b.product.previewImage ?? b.product.image : b.product.image, b.t === "table-row" ? 30 : Math.max(b.w, b.h));
    if (p.kind === "divider") want(p.node.image, W);
  }
  const images = new Map<string, PDFImage>();
  const srcs = [...wanted.keys()];
  let fetched = 0;
  await pool(
    srcs,
    6,
    async (src) => {
      const bytes = await input.image(src, wanted.get(src)!).catch(() => null);
      if (bytes) images.set(src, await doc.embedJpg(bytes).catch(async () => doc.embedPng(bytes)));
      progress(++fetched, srcs.length, "Preparing product images");
    },
    input.signal,
  );
  const rawImage = async (file: { path: string } | null): Promise<PDFImage | null> => {
    if (!file) return null;
    try {
      const b = await input.readFile(file.path);
      if (isPng(b)) return await doc.embedPng(b);
      if (isJpg(b)) return await doc.embedJpg(b);
      const jpg = await input.image(file.path, 2400);
      return jpg ? await doc.embedJpg(jpg) : null;
    } catch {
      return null;
    }
  };
  const coverImage = await rawImage(d.coverImage);
  const logo = await rawImage(d.logo);

  /* ------------------------------------------------------------ drawing kit */
  const pages: PDFPage[] = plan.pages.map(() => doc.addPage([W, H]));
  // Page numbers in the full catalogue (a quick preview leaves some pages out).
  const numbers = plan.pageNumbers ?? plan.pages.map((_, i) => i);
  const byNumber = new Map(numbers.map((n, i) => [n, pages[i]]));
  const font = (s: TextStyle) => fonts.get(s);
  const prep = (f: PrintFont, s: TextStyle, t: string) => f.clean(s.uppercase ? t.toUpperCase() : t);
  const measure = (f: PrintFont, size: number) => (t: string) => f.font.widthOfTextAtSize(t, size);
  const ascent = (f: PrintFont, size: number) => f.font.heightAtSize(size, { descender: false });

  /** One line of text whose top is at `top` (from the page top), aligned in [x, x + w]. Returns its right edge. */
  const line = (page: PDFPage, f: PrintFont, s: TextStyle, t: string, x: number, top: number, w: number, opts: { color?: RGB; size?: number; align?: TextStyle["align"]; opacity?: number } = {}) => {
    const size = opts.size ?? s.size;
    const text = fit(t, w, measure(f, size));
    const tw = f.font.widthOfTextAtSize(text, size);
    const align = opts.align ?? s.align;
    const tx = align === "center" ? x + (w - tw) / 2 : align === "right" ? x + w - tw : x;
    page.drawText(text, { x: tx, y: H - top - ascent(f, size), size, font: f.font, color: opts.color ?? hex(s.color), opacity: opts.opacity });
    return { x: tx, width: tw };
  };
  const lh = (s: TextStyle) => s.size * 1.28;
  /** Wrapped text; returns the height used. */
  const para = async (page: PDFPage, s: TextStyle, t: string, x: number, top: number, w: number, maxLines: number, color?: RGB) => {
    const f = await font(s);
    const lines = wrap(prep(f, s, t), w, measure(f, s.size), maxLines);
    lines.forEach((l, i) => line(page, f, s, l, x, top + i * lh(s), w, { color }));
    return lines.length * lh(s);
  };
  const rect = (page: PDFPage, x: number, top: number, w: number, h: number, o: { fill?: RGB; border?: RGB; radius?: number; opacity?: number; borderWidth?: number }) => {
    if (o.radius) {
      const r = Math.min(o.radius, w / 2, h / 2);
      page.drawSvgPath(`M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`, { x, y: H - top, color: o.fill, borderColor: o.border, borderWidth: o.border ? o.borderWidth ?? 0.6 : 0, opacity: o.opacity, borderOpacity: o.opacity });
    } else page.drawRectangle({ x, y: H - top - h, width: w, height: h, color: o.fill, borderColor: o.border, borderWidth: o.border ? o.borderWidth ?? 0.6 : 0, opacity: o.opacity });
  };
  /** Draws an image fitted into a box; "cover" crops to the box. */
  const picture = (page: PDFPage, img: PDFImage, x: number, top: number, w: number, h: number, mode: "contain" | "cover", opacity = 1) => {
    const scale = mode === "cover" ? Math.max(w / img.width, h / img.height) : Math.min(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    const ix = x + (w - iw) / 2;
    const iy = H - top - h + (h - ih) / 2;
    if (mode === "cover") page.pushOperators(pushGraphicsState(), rectangle(x, H - top - h, w, h), clip(), endPath());
    page.drawImage(img, { x: ix, y: iy, width: iw, height: ih, opacity });
    if (mode === "cover") page.pushOperators(popGraphicsState());
  };
  const link = (page: PDFPage, x: number, top: number, w: number, h: number, target: { uri: string } | { page: PDFPage | undefined }) => {
    if (!d.links || ("page" in target && !target.page)) return;
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, H - top - h, x + w, H - top],
      Border: [0, 0, 0],
      ...("uri" in target ? { A: { Type: "Action", S: "URI", URI: PDFString.of(target.uri) } } : { Dest: [target.page!.ref, "XYZ", null, null, null] }),
    });
    page.node.addAnnot(ctx.register(annot));
  };
  const qr = (page: PDFPage, text: string, x: number, top: number, size: number, color: RGB) => {
    const code = QRCode.create(text, { errorCorrectionLevel: "M" });
    const n = code.modules.size;
    const cell = size / n;
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!code.modules.get(r, c)) {
          c++;
          continue;
        }
        let run = 1;
        while (c + run < n && code.modules.get(r, c + run)) run++;
        page.drawRectangle({ x: x + c * cell, y: H - top - (r + 1) * cell, width: run * cell + 0.05, height: cell + 0.05, color });
        c += run;
      }
    }
  };
  const background = (page: PDFPage, role: keyof CatalogueDesign["templatePages"], color: string) => {
    // The colour goes underneath, so templates with transparent areas still show it.
    if (color.toLowerCase() !== "#ffffff") page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(color) });
    const tpl = template[role];
    if (tpl) page.drawPage(tpl, { x: 0, y: 0, width: W, height: H });
  };
  const price = (p: CatProduct) => {
    const f = (n: number | null) => formatPrice(n, meta.currencySymbol, meta.decimals);
    if (p.type === "variable" || p.regular === null) {
      if (p.min === null) return { now: "", was: "" };
      return { now: p.max !== null && p.max !== p.min ? `${f(p.min)} – ${f(p.max)}` : f(p.min), was: "" };
    }
    return p.sale !== null && p.sale < (p.regular ?? Infinity) ? { now: f(p.sale), was: f(p.regular) } : { now: f(p.regular), was: "" };
  };
  const muted = mix(d.body.color, 0.35);
  const hairline = mix(d.body.color, 0.85);

  /* -------------------------------------------------------------- headers */
  const band = async (page: PDFPage, idx: number, hf: HeaderFooter, top: number, section: string, isHeader: boolean) => {
    if (!hf.enabled) return;
    const f = await font(hf.style);
    const t = tokens(idx, section);
    const left = isLeftPage(idx) && hf.mirror;
    const slots: [string, TextStyle["align"]][] = [
      [left ? hf.right : hf.left, "left"],
      [hf.center, "center"],
      [left ? hf.left : hf.right, "right"],
    ];
    const w = W - 2 * g.margin;
    for (const [text, align] of slots) if (text.trim()) line(page, f, hf.style, prep(f, hf.style, fillTokens(text, t)), g.margin, top, w, { align });
    if (hf.line) {
      const y = isHeader ? top + hf.style.size * 1.3 + 4 : top - 5;
      page.drawLine({ start: { x: g.margin, y: H - y }, end: { x: W - g.margin, y: H - y }, thickness: 0.6, color: hex(hf.lineColor) });
    }
  };

  /* --------------------------------------------------------------- blocks */
  const headingBlock = async (page: PDFPage, b: Extract<Block, { t: "heading" }>) => {
    const s = d.categoryHeading;
    let top = b.y;
    if (b.node.depth > 0) {
      const crumb = { ...d.body, size: 7.5, weight: 600, uppercase: true, color: d.accent };
      const f = await font(crumb);
      line(page, f, crumb, prep(f, crumb, b.node.path.join("  ›  ")), b.x, top, b.w);
      top += 13;
    }
    const f = await font(s);
    const name = prep(f, s, b.node.name);
    const r = line(page, f, s, name, b.x, top, b.w);
    if (b.continued) {
      const cf = await font(d.body);
      const cs = { ...d.body, size: Math.max(7, s.size * 0.4) };
      const after = s.align === "left" ? r.x + r.width + 6 : b.x;
      line(page, cf, cs, cf.clean("(continued)"), after, top + s.size * 0.45, b.w - (after - b.x), { color: muted, align: s.align === "left" ? "left" : s.align });
    }
    const barY = top + s.size * 1.08 + 2;
    const barX = s.align === "center" ? b.x + b.w / 2 - 14 : s.align === "right" ? b.x + b.w - 28 : b.x;
    page.drawRectangle({ x: barX, y: H - barY - 2, width: 28, height: 2, color: hex(d.accent) });
  };

  const badges = async (page: PDFPage, p: CatProduct, x: number, top: number) => {
    if (!d.show.badges) return;
    const s = { ...d.body, size: 6.5, weight: 700, uppercase: true, color: "#ffffff" };
    const f = await font(s);
    let bx = x;
    const pr = price(p);
    for (const [label, color] of [pr.was ? ["Sale", d.accent] : null, p.featured ? ["Featured", "#111827"] : null].filter(Boolean) as [string, string][]) {
      const t = prep(f, s, label);
      const w = f.font.widthOfTextAtSize(t, s.size) + 8;
      rect(page, bx, top, w, 11, { fill: hex(color), radius: 5.5 });
      line(page, f, s, t, bx + 4, top + 2.4, w);
      bx += w + 3;
    }
  };

  const stockLabel = (p: CatProduct) => (p.stockStatus === "outofstock" ? ["Out of stock", "#b91c1c"] : p.stockStatus === "onbackorder" ? ["On backorder", "#b45309"] : ["In stock", "#15803d"]);

  /** Text lines for SKU, attributes and custom fields. */
  const details = (p: CatProduct): string[] => {
    const out: string[] = [];
    const ids = [d.show.sku && p.sku ? `SKU ${p.sku}` : "", d.show.gtin && p.gtin ? `GTIN ${p.gtin}` : "", d.show.weight && p.weight ? `${p.weight} kg` : ""].filter(Boolean);
    if (ids.length) out.push(ids.join("  ·  "));
    if (d.show.attributes) for (const a of p.attributes.slice(0, 3)) if (a.options.length) out.push(`${a.name}: ${a.options.join(", ")}`);
    for (const k of d.customFields) if (p.custom[k]) out.push(`${input.customLabels[k] ?? k}: ${p.custom[k]}`);
    return out;
  };

  const priceLine = async (page: PDFPage, p: CatProduct, x: number, top: number, w: number, align: TextStyle["align"] = "left") => {
    if (!d.show.price) return;
    const pr = price(p);
    if (!pr.now) return;
    const f = await font(d.price);
    const label = d.priceLabel ? `${d.priceLabel} ` : "";
    const fb = await font(d.body);
    const lw = label ? fb.font.widthOfTextAtSize(fb.clean(label), d.body.size) : 0;
    const now = prep(f, d.price, pr.now);
    const nw = f.font.widthOfTextAtSize(now, d.price.size);
    const was = pr.was ? fb.clean(pr.was) : "";
    const ww = was ? fb.font.widthOfTextAtSize(was, d.body.size) + 5 : 0;
    const total = lw + nw + ww;
    let cx = align === "right" ? x + w - total : align === "center" ? x + (w - total) / 2 : x;
    const base = top + d.price.size - d.body.size;
    if (label) {
      line(page, fb, d.body, fb.clean(label), cx, base, lw + 1, { color: muted, align: "left" });
      cx += lw;
    }
    line(page, f, d.price, now, cx, top, nw + 1, { align: "left" });
    cx += nw + 5;
    if (was) {
      line(page, fb, d.body, was, cx, base, ww, { color: muted, align: "left" });
      const sy = H - base - ascent(fb, d.body.size) * 0.35;
      page.drawLine({ start: { x: cx, y: sy }, end: { x: cx + ww - 5, y: sy }, thickness: 0.6, color: muted });
    }
  };

  const productImage = (p: CatProduct) => {
    const src = input.preview ? p.previewImage ?? p.image : p.image;
    return src ? images.get(src) ?? null : null;
  };
  const noImage = async (page: PDFPage, x: number, top: number, w: number, h: number) => {
    rect(page, x, top, w, h, { fill: mix(d.body.color, 0.94) });
    const s = { ...d.body, size: 7, align: "center" as const };
    const f = await font(s);
    line(page, f, s, f.clean("No image"), x, top + h / 2 - 4, w, { color: muted });
  };

  const card = async (page: PDFPage, b: Extract<Block, { t: "card" }>) => {
    const p = b.product;
    const framed = d.cardBorder || d.cardBackground.toLowerCase() !== d.pageBackground.toLowerCase();
    if (framed) rect(page, b.x, b.y, b.w, b.h, { fill: hex(d.cardBackground), border: d.cardBorder ? hairline : undefined, radius: d.rounded ? 6 : 0 });
    const pad = framed ? 7 : 0;
    const x = b.x + pad;
    const w = b.w - 2 * pad;
    const qrSize = d.show.qr && p.permalink ? Math.min(40, w * 0.28) : 0;
    const textW = w - (qrSize ? qrSize + 6 : 0);
    const nf = await font(d.productName);
    const nameLines = wrap(prep(nf, d.productName, p.name), textW, measure(nf, d.productName.size), 2);
    const det = details(p);
    const descLines = d.show.description ? d.descriptionLines : 0;
    const textH = nameLines.length * lh(d.productName) + 3 + det.length * lh(d.body) + (descLines ? descLines * lh(d.body) + 3 : 0) + (d.show.price ? lh(d.price) + 3 : 0) + (d.show.stock ? lh(d.body) : 0);
    const imgH = d.show.image ? Math.max(30, b.h - 2 * pad - Math.max(textH, qrSize) - 6) : 0;
    let top = b.y + pad;
    if (d.show.image) {
      const img = productImage(p);
      if (img) picture(page, img, x, top, w, imgH, d.imageFit);
      else await noImage(page, x, top, w, imgH);
      await badges(page, p, x + 4, top + 4);
      top += imgH + 6;
    } else await badges(page, p, x, top - 1);
    const textTop = top;
    nameLines.forEach((l, i) => line(page, nf, d.productName, l, x, top + i * lh(d.productName), textW));
    if (p.permalink) link(page, x, top, textW, nameLines.length * lh(d.productName), { uri: p.permalink });
    top += nameLines.length * lh(d.productName) + 3;
    const bf = await font(d.body);
    for (const t of det) {
      line(page, bf, d.body, prep(bf, d.body, t), x, top, textW, { color: muted });
      top += lh(d.body);
    }
    if (descLines) top += (await para(page, d.body, p.shortDescription || p.description, x, top, textW, descLines)) + 3;
    const bottom = b.y + b.h - pad;
    if (d.show.stock) {
      const [label, color] = stockLabel(p);
      line(page, bf, d.body, bf.clean(label), x, bottom - lh(d.price) - lh(d.body) - 1, textW, { color: hex(color) });
    }
    await priceLine(page, p, x, bottom - lh(d.price), textW);
    if (qrSize) {
      qr(page, p.permalink, x + w - qrSize, Math.max(textTop, bottom - qrSize), qrSize, hex(d.productName.color));
      link(page, x + w - qrSize, Math.max(textTop, bottom - qrSize), qrSize, qrSize, { uri: p.permalink });
    }
  };

  const row = async (page: PDFPage, b: Extract<Block, { t: "row" }>) => {
    const p = b.product;
    const framed = d.cardBorder || d.cardBackground.toLowerCase() !== d.pageBackground.toLowerCase();
    if (framed) rect(page, b.x, b.y, b.w, b.h, { fill: hex(d.cardBackground), border: d.cardBorder ? hairline : undefined, radius: d.rounded ? 6 : 0 });
    const pad = framed ? 8 : 0;
    const imgW = d.show.image ? Math.min(b.h - 2 * pad, b.w * 0.34) : 0;
    if (d.show.image) {
      const img = productImage(p);
      if (img) picture(page, img, b.x + pad, b.y + pad, imgW, b.h - 2 * pad, d.imageFit);
      else await noImage(page, b.x + pad, b.y + pad, imgW, b.h - 2 * pad);
      await badges(page, p, b.x + pad + 4, b.y + pad + 4);
    }
    const x = b.x + pad + (imgW ? imgW + 12 : 0);
    const qrSize = d.show.qr && p.permalink ? Math.min(52, b.h * 0.42) : 0;
    const w = b.x + b.w - pad - x;
    let top = b.y + pad;
    const nf = await font(d.productName);
    const priceW = d.show.price ? Math.min(140, w * 0.35) : 0;
    const nameLines = wrap(prep(nf, d.productName, p.name), w - priceW - 8, measure(nf, d.productName.size), 2);
    nameLines.forEach((l, i) => line(page, nf, d.productName, l, x, top + i * lh(d.productName), w - priceW - 8));
    if (p.permalink) link(page, x, top, w - priceW, nameLines.length * lh(d.productName), { uri: p.permalink });
    await priceLine(page, p, x + w - priceW, top, priceW, "right");
    top += nameLines.length * lh(d.productName) + 4;
    const bf = await font(d.body);
    const textW = w - (qrSize ? qrSize + 8 : 0);
    for (const t of details(p)) {
      line(page, bf, d.body, prep(bf, d.body, t), x, top, textW, { color: muted });
      top += lh(d.body);
    }
    if (d.show.stock) {
      const [label, color] = stockLabel(p);
      line(page, bf, d.body, bf.clean(label), x, top, textW, { color: hex(color) });
      top += lh(d.body);
    }
    if (d.show.description) {
      const lines = Math.max(1, Math.floor((b.y + b.h - pad - top - 3) / lh(d.body)));
      await para(page, d.body, p.shortDescription || p.description, x, top + 3, textW, lines);
    }
    if (qrSize) {
      qr(page, p.permalink, x + w - qrSize, b.y + b.h - pad - qrSize, qrSize, hex(d.productName.color));
      link(page, x + w - qrSize, b.y + b.h - pad - qrSize, qrSize, qrSize, { uri: p.permalink });
    }
  };

  const feature = async (page: PDFPage, b: Extract<Block, { t: "feature" }>) => {
    const p = b.product;
    const imgH = d.show.image ? b.h * 0.52 : 0;
    if (d.show.image) {
      const img = productImage(p);
      if (img) picture(page, img, b.x, b.y, b.w, imgH, d.imageFit);
      else await noImage(page, b.x, b.y, b.w, imgH);
      await badges(page, p, b.x + 6, b.y + 6);
    }
    let top = b.y + imgH + 14;
    const big = { ...d.productName, size: d.productName.size * 1.8 };
    const qrSize = d.show.qr && p.permalink ? 70 : 0;
    const w = b.w - (qrSize ? qrSize + 14 : 0);
    top += await para(page, big, p.name, b.x, top, w, 2);
    if (p.permalink) link(page, b.x, top - lh(big) * 2, w, lh(big) * 2, { uri: p.permalink });
    top += 4;
    if (d.show.price) {
      await priceLine(page, p, b.x, top, w);
      top += lh(d.price) + 8;
    }
    if (d.show.description) {
      const body = { ...d.body, size: d.body.size * 1.2 };
      const facts = details(p);
      const room = b.y + b.h - top - facts.length * lh(d.body) * 1.2 - 10;
      top += (await para(page, body, p.description || p.shortDescription, b.x, top, w, Math.max(2, Math.floor(room / lh(body))))) + 8;
    }
    const bf = await font(d.body);
    for (const t of details(p)) {
      const [k, ...v] = t.split(": ");
      if (v.length) {
        line(page, bf, { ...d.body, weight: 600 }, prep(bf, d.body, k), b.x, top, 120, { color: muted });
        line(page, bf, d.body, prep(bf, d.body, v.join(": ")), b.x + 124, top, w - 124);
      } else line(page, bf, d.body, prep(bf, d.body, t), b.x, top, w, { color: muted });
      top += lh(d.body) * 1.2;
    }
    if (qrSize) {
      qr(page, p.permalink, b.x + b.w - qrSize, b.y + imgH + 14, qrSize, hex(d.productName.color));
      link(page, b.x + b.w - qrSize, b.y + imgH + 14, qrSize, qrSize, { uri: p.permalink });
    }
  };

  const tableCols = () => {
    const w = g.width - 2 * g.margin;
    const cols: { id: string; label: string; w: number; align: TextStyle["align"] }[] = [];
    if (d.show.image) cols.push({ id: "img", label: "", w: 34, align: "left" });
    if (d.show.sku) cols.push({ id: "sku", label: "SKU", w: 78, align: "left" });
    for (const k of d.customFields) cols.push({ id: `cf:${k}`, label: input.customLabels[k] ?? k, w: 80, align: "left" });
    if (d.show.stock) cols.push({ id: "stock", label: "Stock", w: 62, align: "left" });
    if (d.show.price) cols.push({ id: "price", label: d.priceLabel || "Price", w: 84, align: "right" });
    const fixed = cols.reduce((s, c) => s + c.w, 0);
    cols.splice(d.show.image ? 1 : 0, 0, { id: "name", label: "Product", w: Math.max(120, w - fixed), align: "left" });
    return cols;
  };
  const tableHead = async (page: PDFPage, b: Extract<Block, { t: "table-head" }>) => {
    const s = { ...d.body, weight: 700, uppercase: true, size: Math.max(6.5, d.body.size - 0.5) };
    const f = await font(s);
    let x = b.x;
    for (const c of tableCols()) {
      if (c.label) line(page, f, s, prep(f, s, c.label), x + 3, b.y + b.h / 2 - s.size / 2, c.w - 6, { color: muted, align: c.align });
      x += c.w;
    }
    page.drawLine({ start: { x: b.x, y: H - b.y - b.h }, end: { x: b.x + b.w, y: H - b.y - b.h }, thickness: 1, color: hex(d.accent) });
  };
  const tableRow = async (page: PDFPage, b: Extract<Block, { t: "table-row" }>) => {
    const p = b.product;
    if (b.odd) rect(page, b.x, b.y, b.w, b.h, { fill: mix(d.accent, 0.95) });
    const bf = await font(d.body);
    const nf = await font({ ...d.productName, size: d.body.size + 1 });
    const mid = b.y + b.h / 2 - d.body.size / 2;
    let x = b.x;
    for (const c of tableCols()) {
      if (c.id === "img") {
        const img = productImage(p);
        if (img) picture(page, img, x + 2, b.y + 2, c.w - 4, b.h - 4, "contain");
      } else if (c.id === "name") {
        const s = { ...d.productName, size: d.body.size + 1 };
        line(page, nf, s, prep(nf, s, p.name), x + 3, mid - 0.5, c.w - 6);
        if (p.permalink) link(page, x, b.y, c.w, b.h, { uri: p.permalink });
      } else if (c.id === "price") {
        const pr = price(p);
        if (pr.now) {
          const pf = await font(d.price);
          const s = { ...d.price, size: Math.min(d.price.size, d.body.size + 2) };
          line(page, pf, s, prep(pf, s, pr.now), x + 3, mid - 1, c.w - 6, { align: "right" });
        }
      } else {
        const v = c.id === "sku" ? p.sku : c.id === "stock" ? stockLabel(p)[0] : p.custom[c.id.slice(3)] ?? "";
        line(page, bf, d.body, prep(bf, d.body, v), x + 3, mid, c.w - 6, { color: c.id === "stock" ? hex(stockLabel(p)[1]) : undefined, align: c.align });
      }
      x += c.w;
    }
  };

  /* ---------------------------------------------------------------- pages */
  const coverTexts = async (page: PDFPage, idx: number, texts: CoverText[]) => {
    for (const t of texts) {
      if (!t.text.trim()) continue;
      const f = await font(t.style);
      const lines = prep(f, t.style, fillTokens(t.text, tokens(idx))).split("\n");
      const w = W - 2 * g.margin;
      let top = (t.y / 100) * H;
      for (const l of lines) for (const wl of wrap(l, w, measure(f, t.style.size))) {
        line(page, f, t.style, wl, g.margin, top, w);
        top += lh(t.style);
      }
    }
  };
  const cover = async (page: PDFPage, idx: number) => {
    background(page, "cover", d.coverBackground);
    if (coverImage) {
      picture(page, coverImage, 0, 0, W, H, "cover", d.coverImageOpacity);
      if (d.coverOverlay) page.drawRectangle({ x: 0, y: 0, width: W, height: H * 0.5, color: hex(d.coverBackground), opacity: 0.35 });
    }
    if (logo) {
      const lw = (d.logoWidth / 100) * W;
      const lhgt = (logo.height / logo.width) * lw;
      page.drawImage(logo, { x: (W - lw) / 2, y: H - (d.logoY / 100) * H - lhgt, width: lw, height: lhgt });
    }
    await coverTexts(page, idx, d.coverTexts);
    if (meta.website) link(page, 0, H * 0.85, W, H * 0.15, { uri: meta.website });
  };
  const back = async (page: PDFPage, idx: number) => {
    background(page, "back", d.coverBackground);
    if (logo) {
      const lw = (d.logoWidth / 100) * W * 0.7;
      const lhgt = (logo.height / logo.width) * lw;
      page.drawImage(logo, { x: (W - lw) / 2, y: H - 0.2 * H - lhgt, width: lw, height: lhgt });
    }
    await coverTexts(page, idx, d.backTexts);
    if (meta.website) {
      const size = 84;
      rect(page, (W - size) / 2 - 8, H * 0.66 - 8, size + 16, size + 16, { fill: rgb(1, 1, 1), radius: 6 });
      qr(page, meta.website, (W - size) / 2, H * 0.66, size, rgb(0.07, 0.09, 0.15));
      link(page, (W - size) / 2, H * 0.66, size, size, { uri: meta.website });
    }
  };
  const divider = async (page: PDFPage, node: CatNode) => {
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(d.accent) });
    const img = node.image ? images.get(node.image) : null;
    if (img) picture(page, img, 0, 0, W, H * 0.58, "cover");
    const s = { ...d.categoryHeading, size: d.categoryHeading.size * 2, color: "#ffffff", align: "left" as const };
    let top = H * (img ? 0.64 : 0.4);
    top += await para(page, s, node.name, g.margin, top, W - 2 * g.margin, 2);
    const count = (n: CatNode): number => n.products.length + n.children.reduce((a, c) => a + count(c), 0);
    const sub = { ...d.body, size: 11, color: "#ffffff", weight: 500 };
    const sf = await font(sub);
    line(page, sf, sub, sf.clean(`${count(node)} products`), g.margin, top + 6, W - 2 * g.margin, { opacity: 0.85 });
    if (node.description) await para(page, { ...d.body, size: 10.5, color: "#ffffff" }, node.description, g.margin, top + 28, Math.min(W - 2 * g.margin, 380), 8);
  };
  const index = async (page: PDFPage, p: Extract<PagePlan, { kind: "index" }>) => {
    let top = g.top;
    if (p.first) {
      const s = { ...d.categoryHeading, size: d.categoryHeading.size * 1.4 };
      top += await para(page, s, d.indexTitle, g.margin, top, W - 2 * g.margin, 1);
      page.drawRectangle({ x: g.margin, y: H - top - 6, width: 36, height: 2.5, color: hex(d.accent) });
      top += 70 - lh(s);
    }
    const w = W - 2 * g.margin;
    for (const e of p.entries) {
      const s = e.depth === 0 ? { ...d.productName, size: d.productName.size + 1.5, weight: 700 } : { ...d.body, size: d.body.size + 2, color: d.productName.color };
      const f = await font(s);
      const indent = e.depth * 16;
      const num = String(e.page + 1);
      const nw = f.font.widthOfTextAtSize(num, s.size);
      const r = line(page, f, s, prep(f, s, e.node.name), g.margin + indent, top + 3, w - indent - nw - 30, { align: "left" });
      line(page, f, s, num, g.margin, top + 3, w, { align: "right", color: e.depth === 0 ? hex(d.accent) : undefined });
      // Dotted leader between the name and the page number.
      const ly = H - top - 3 - ascent(f, s.size);
      for (let x = r.x + r.width + 6; x < g.margin + w - nw - 6; x += 4) page.drawCircle({ x, y: ly, size: 0.5, color: hairline });
      link(page, g.margin, top, w, INDEX_LINE, { page: byNumber.get(e.page) });
      top += INDEX_LINE;
    }
  };
  const az = async (page: PDFPage, p: Extract<PagePlan, { kind: "az" }>) => {
    let top = g.top;
    if (p.first) {
      const s = { ...d.categoryHeading, size: d.categoryHeading.size * 1.4 };
      top += await para(page, s, "Product index", g.margin, top, W - 2 * g.margin, 1);
      page.drawRectangle({ x: g.margin, y: H - top - 6, width: 36, height: 2.5, color: hex(d.accent) });
      top += 70 - lh(s);
    }
    const colW = (W - 2 * g.margin - 18) / 2;
    const per = Math.ceil(p.entries.length / 2);
    const s = { ...d.body, size: Math.min(8.5, d.body.size + 0.5), color: d.productName.color };
    const f = await font(s);
    let letter = "";
    p.entries.forEach((e, i) => {
      const col = i < per ? 0 : 1;
      const x = g.margin + col * (colW + 18);
      const y = top + (i % per) * AZ_LINE;
      const first = e.product.name.charAt(0).toUpperCase();
      const num = String(e.page + 1);
      const nw = f.font.widthOfTextAtSize(num, s.size);
      const skuW = d.show.sku && e.product.sku ? Math.min(70, colW * 0.3) : 0;
      if (first !== letter) {
        letter = first;
        line(page, f, { ...s, color: d.accent }, f.clean(first), x - 10, y, 8, { color: hex(d.accent) });
      }
      line(page, f, s, prep(f, s, e.product.name), x, y, colW - nw - skuW - 8, { align: "left" });
      if (skuW) line(page, f, s, prep(f, s, e.product.sku), x + colW - nw - skuW - 4, y, skuW, { color: muted, align: "right" });
      line(page, f, s, num, x, y, colW, { align: "right", color: hex(d.accent) });
      link(page, x, y, colW, AZ_LINE, { page: byNumber.get(e.page) });
    });
  };

  /* ------------------------------------------------------------------ draw */
  for (let i = 0; i < plan.pages.length; i++) {
    if (input.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const pp = plan.pages[i];
    const page = pages[i];
    const n = numbers[i];
    progress(i, plan.pages.length, "Laying out pages");
    if (pp.kind === "cover") await cover(page, n);
    else if (pp.kind === "back") await back(page, n);
    else if (pp.kind === "divider") await divider(page, pp.node);
    else {
      background(page, pp.kind === "index" ? "index" : isLeftPage(n) ? "left" : "right", d.pageBackground);
      if (pp.kind === "index") await index(page, pp);
      else if (pp.kind === "az") await az(page, pp);
      else
        for (const b of pp.blocks) {
          if (b.t === "heading") await headingBlock(page, b);
          else if (b.t === "card") await card(page, b);
          else if (b.t === "row") await row(page, b);
          else if (b.t === "feature") await feature(page, b);
          else if (b.t === "table-head") await tableHead(page, b);
          else await tableRow(page, b);
        }
      const section = pp.kind === "content" ? pp.section : pp.kind === "index" ? d.indexTitle : "Product index";
      await band(page, n, d.header, g.margin, section, true);
      await band(page, n, d.footer, H - g.margin - d.footer.style.size * 1.1, section, false);
      if (d.watermark.trim()) {
        const s = { ...d.body, size: Math.min(W, H) / 7, weight: 700 };
        const f = await font(s);
        const t = prep(f, s, d.watermark);
        const tw = f.font.widthOfTextAtSize(t, s.size);
        const a = Math.atan2(H, W);
        page.drawText(t, { x: W / 2 - (Math.cos(a) * tw) / 2, y: H / 2 - (Math.sin(a) * tw) / 2, size: s.size, font: f.font, color: rgb(0.5, 0.5, 0.5), opacity: 0.12, rotate: degrees((a * 180) / Math.PI) });
      }
    }
  }

  /* ------------------------------------------------------- bookmarks, info */
  type Outline = { title: string; page: PDFPage; children: Outline[] };
  const outline: Outline[] = [];
  const indexPage = plan.pages.findIndex((p) => p.kind === "index");
  if (indexPage >= 0) outline.push({ title: d.indexTitle, page: pages[indexPage], children: [] });
  const stack: Outline[] = [];
  for (const e of plan.toc) {
    const target = byNumber.get(e.page);
    if (!target) continue;
    const item = { title: e.node.name, page: target, children: [] };
    stack.length = e.depth;
    (e.depth === 0 ? outline : stack[e.depth - 1]?.children ?? outline).push(item);
    stack[e.depth] = item;
  }
  const azPage = plan.pages.findIndex((p) => p.kind === "az");
  if (azPage >= 0) outline.push({ title: "Product index", page: pages[azPage], children: [] });
  if (outline.length) addOutline(doc, outline);

  const title = tokens(0).title;
  doc.setTitle(title, { showInWindowTitleBar: true });
  doc.setAuthor(meta.store);
  doc.setSubject(`${plan.productCount} products`);
  doc.setCreator("CatalogForge");
  doc.setProducer("CatalogForge");
  doc.setKeywords(plan.toc.filter((t) => t.depth === 0).map((t) => t.node.name));
  progress(plan.pages.length, plan.pages.length, "Saving PDF");
  return doc.save({ useObjectStreams: true });
}

function addOutline(doc: PDFDocument, items: { title: string; page: PDFPage; children: { title: string; page: PDFPage; children: unknown[] }[] }[]) {
  const ctx = doc.context;
  const root = ctx.nextRef();
  type Item = { title: string; page: PDFPage; children: Item[] };
  const build = (list: Item[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((it, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parent, Dest: [it.page.ref, "Fit"] });
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      if (it.children.length) {
        const kids = build(it.children, refs[i]);
        dict.set(PDFName.of("First"), kids.first);
        dict.set(PDFName.of("Last"), kids.last);
        // Negative count: sub-levels start collapsed.
        dict.set(PDFName.of("Count"), ctx.obj(-kids.count));
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const top = build(items as Item[], root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}
