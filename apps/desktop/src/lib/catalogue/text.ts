// Text for print: product HTML → plain paragraphs, and line wrapping against a font's measurements.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", trade: "™", reg: "®", copy: "©", deg: "°", times: "×", euro: "€", pound: "£" };

/** Converts description HTML to text: paragraphs become line breaks and list items get bullets. */
export function htmlToText(html: string): string {
  return (html ?? "")
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|tr|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\[[^\]]+\]/g, "") // shortcodes
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Wraps text into at most `maxLines` lines no wider than `width`. The last line gets an ellipsis
 * when text is cut. `measure` returns the width of a string in the target font and size.
 */
export function wrap(text: string, width: number, measure: (s: string) => number, maxLines = Infinity): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      // A single word wider than the line is broken by characters.
      let w = word;
      while (measure(w) > width && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && measure(w.slice(0, cut)) > width) cut--;
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
      if (out.length > maxLines) break;
    }
    if (line) out.push(line);
    if (out.length > maxLines) break;
  }
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]}…`, width, measure);
  return kept;
}

/** Shortens a single line to fit, with an ellipsis. */
export function fit(text: string, width: number, measure: (s: string) => number): string {
  if (measure(text) <= width) return text;
  let t = text;
  while (t && measure(`${t}…`) > width) t = t.slice(0, -1);
  return t ? `${t.trimEnd()}…` : "";
}

export function formatPrice(n: number | null, symbol: string, decimals: number): string {
  if (n === null || !Number.isFinite(n)) return "";
  const s = n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${symbol}${s}`;
}
