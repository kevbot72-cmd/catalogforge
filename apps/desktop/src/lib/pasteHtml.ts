// Cleans HTML pasted from Word, Google Docs, web pages and supplier portals. Keeps what the
// person meant (paragraphs, headings, lists, bold, italic, underline, links, text colour and
// size) and drops what they didn't (fonts, classes, Office markup, the document's base colour
// and size that every span repeats).

const BLOCK_KEEP = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "BR", "HR", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"]);
const INLINE_KEEP = new Set(["STRONG", "EM", "U", "S", "A", "SUB", "SUP", "CODE"]);
const DROP = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "XML", "O:P", "IMG", "SVG", "IFRAME", "OBJECT"]);

const BLACKS = /^(#000(000)?|black|windowtext|rgb\(0,\s*0,\s*0\)|rgba\(0,\s*0,\s*0,\s*1\)|initial|inherit|currentcolor)$/i;

function styleOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (el.getAttribute("style") ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

const normSize = (v: string) => {
  const m = /^([\d.]+)\s*(pt|px|em|rem|%)?$/i.exec(v.trim());
  if (!m) return null;
  return `${+Number(m[1]).toFixed(2)}${(m[2] ?? "px").toLowerCase()}`;
};

/** Word's fake lists: paragraphs styled `mso-list` with a typed bullet or number at the start. */
function convertWordLists(doc: Document) {
  const paras = [...doc.body.querySelectorAll("p")].filter((p) => /mso-list/i.test(p.getAttribute("style") ?? "") || /MsoListParagraph/i.test(p.className));
  let list: HTMLElement | null = null;
  for (const p of paras) {
    // The marker is in a span styled mso-list:Ignore (or after an <![if !supportLists]> comment).
    let marker = "";
    for (const s of [...p.querySelectorAll("span")]) {
      if (/mso-list:\s*ignore/i.test(s.getAttribute("style") ?? "")) {
        marker = s.textContent ?? "";
        s.remove();
      }
    }
    const text = (p.textContent ?? "").replace(/^\s+/, "");
    if (!marker) {
      const m = /^([•·▪◦o§\-–*]|\d+[.)]|[a-z][.)])\s+/i.exec(text);
      if (m) {
        marker = m[1];
        // Strip the typed marker from the first text node.
        const walker = doc.createTreeWalker(p, 4);
        const first = walker.nextNode();
        if (first) first.textContent = (first.textContent ?? "").replace(/^\s*\S+\s+/, "");
      }
    }
    const ordered = /^\s*(\d+|[a-z])[.)]/i.test(marker);
    const tag = ordered ? "OL" : "UL";
    // Consecutive list paragraphs join one list (earlier ones were already moved into it).
    if (!list || p.previousElementSibling !== list || list.tagName !== tag) {
      list = doc.createElement(tag);
      p.before(list);
    }
    const li = doc.createElement("li");
    while (p.firstChild) li.appendChild(p.firstChild);
    list.appendChild(li);
    p.remove();
  }
}

export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->|<!\[if[^\]]*\]>|<!\[endif\]>/gi, ""), "text/html");
  convertWordLists(doc);

  // The document's base colour and size (what most text uses) is the theme's job, so only
  // colours and sizes that differ from it are kept.
  const tally = (key: "color" | "font-size") => {
    const counts = new Map<string, number>();
    for (const el of doc.body.querySelectorAll("[style]")) {
      const v = styleOf(el)[key];
      const n = v && (key === "font-size" ? normSize(v) : v.toLowerCase().replace(/\s+/g, ""));
      if (n) counts.set(n, (counts.get(n) ?? 0) + (el.textContent?.length ?? 0));
    }
    // Only a value covering most of the text is the base; a single red word is emphasis.
    const total = doc.body.textContent?.trim().length ?? 0;
    const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    return best && n >= total * 0.5 ? best : null;
  };
  const baseColor = tally("color");
  const baseSize = tally("font-size");

  const out = doc.createElement("div");
  const walk = (src: Node, dest: Node) => {
    for (const node of [...src.childNodes]) {
      if (node.nodeType === 3) {
        dest.appendChild(doc.createTextNode((node.textContent ?? "").replace(/ /g, " ")));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.tagName.toUpperCase();
      if (DROP.has(tag) || tag.includes(":")) continue;
      const st = styleOf(el);
      let target: Node = dest;
      // Wrap in inline formatting expressed through styles (Google Docs uses spans for bold).
      const wrap = (t: string) => {
        const w = doc.createElement(t);
        target.appendChild(w);
        target = w;
      };
      let kept: Element | null = null;
      if (BLOCK_KEEP.has(tag) || INLINE_KEEP.has(tag) || tag === "B" || tag === "I") {
        const name = tag === "B" ? "strong" : tag === "I" ? "em" : tag === "H1" ? "h2" : tag.toLowerCase();
        // Google Docs wraps the whole paste in <b style="font-weight:normal">.
        if (tag === "B" && /normal|400/.test(st["font-weight"] ?? "")) kept = null;
        else {
          kept = doc.createElement(name);
          if (tag === "A" && el.getAttribute("href") && !/^\s*javascript:/i.test(el.getAttribute("href")!)) kept.setAttribute("href", el.getAttribute("href")!);
          const align = st["text-align"] ?? el.getAttribute("align");
          if (align && /^(center|right|justify)$/i.test(align) && /^(P|H\d)$/.test(tag)) kept.setAttribute("style", `text-align: ${align.toLowerCase()}`);
          target.appendChild(kept);
          target = kept;
        }
      }
      if (/^(bold|bolder|[6-9]00)$/i.test(st["font-weight"] ?? "") && !/^(STRONG|B|H\d|TH)$/.test(tag)) wrap("strong");
      if (/italic/i.test(st["font-style"] ?? "") && !/^(EM|I)$/.test(tag)) wrap("em");
      if (/underline/i.test(st["text-decoration"] ?? st["text-decoration-line"] ?? "") && tag !== "U" && tag !== "A") wrap("u");
      if (/line-through/i.test(st["text-decoration"] ?? st["text-decoration-line"] ?? "") && tag !== "S") wrap("s");
      const color = st.color?.toLowerCase().replace(/\s+/g, "");
      const size = st["font-size"] ? normSize(st["font-size"]) : null;
      const keepColor = color && color !== baseColor && !BLACKS.test(color);
      const keepSize = size && size !== baseSize;
      if (keepColor || keepSize) {
        const span = doc.createElement("span");
        span.setAttribute("style", [keepColor ? `color: ${st.color}` : "", keepSize ? `font-size: ${size}` : ""].filter(Boolean).join("; "));
        target.appendChild(span);
        target = span;
      }
      walk(el, target);
    }
  };
  walk(doc.body, out);

  // Tidy: no empty inline wrappers or paragraphs, nested identical marks collapse.
  for (let pass = 0; pass < 3; pass++) {
    for (const el of [...out.querySelectorAll("span, strong, em, u, s, p")]) {
      if (!el.textContent?.trim() && !el.querySelector("br, img")) el.remove();
    }
  }
  for (const el of [...out.querySelectorAll("strong strong, em em, u u")]) el.replaceWith(...el.childNodes);
  return out.innerHTML.replace(/[ \t]{2,}/g, " ").replace(/\s*\n\s*/g, " ").trim();
}
