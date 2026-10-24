// Fonts for catalogue PDFs: the three PDF standard families, open-licence families bundled with the
// app, and any TTF/OTF file the user picks ("file:<path>"). Embedded fonts are subset.

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { TextStyle } from "./design";

/** Loads font bytes for a bundled family at the nearest available weight. */
export type FontLoader = (family: string, weight: number, italic: boolean) => Promise<Uint8Array>;

const DIRS: Record<string, string> = { Inter: "inter", Montserrat: "montserrat", "Playfair Display": "playfair-display", Lora: "lora", Oswald: "oswald" };
export const BUNDLED = Object.keys(DIRS);

/** Weight folders shipped for each family (see the glob below). */
const WEIGHTS: Record<number, string> = { 300: "300Light", 400: "400Regular", 500: "500Medium", 600: "600SemiBold", 700: "700Bold" };

export function bundledFile(family: string, weight: number, italic: boolean): { dir: string; folder: string; file: string } | null {
  const dir = DIRS[family];
  if (!dir) return null;
  const available = family === "Oswald" ? [300, 400, 500, 600, 700] : family === "Playfair Display" || family === "Lora" ? [400, 500, 600, 700] : [300, 400, 500, 600, 700];
  let w = available.reduce((best, x) => (Math.abs(x - weight) < Math.abs(best - weight) ? x : best), available[0]);
  const hasItalic = family !== "Oswald";
  if (italic && hasItalic) w = w >= 600 ? 700 : 400;
  const folder = WEIGHTS[w] + (italic && hasItalic ? "_Italic" : "");
  const name = family.replace(/\s+/g, "");
  return { dir, folder, file: `${name}_${folder}.ttf` };
}

/** Default loader: fonts are bundled as static assets and fetched on first use. */
const URLS = import.meta.glob("/node_modules/@expo-google-fonts/{inter,montserrat,playfair-display,lora,oswald}/{300Light,400Regular,500Medium,600SemiBold,700Bold,400Regular_Italic,700Bold_Italic}/*.ttf", {
  query: "?url",
  import: "default",
}) as Record<string, () => Promise<string>>;

export const assetFontLoader: FontLoader = async (family, weight, italic) => {
  const f = bundledFile(family, weight, italic);
  if (!f) throw new Error(`Unknown font ${family}`);
  const load = URLS[`/node_modules/@expo-google-fonts/${f.dir}/${f.folder}/${f.file}`];
  if (!load) throw new Error(`Font file missing: ${f.file}`);
  const res = await fetch(await load());
  return new Uint8Array(await res.arrayBuffer());
};

const STANDARD: Record<string, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export interface PrintFont {
  font: PDFFont;
  /** Replaces characters the font cannot draw (accents are stripped first, then "?"). */
  clean: (s: string) => string;
}

const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "•": "*", " ": " ", "→": "->", "›": ">", "×": "x" };

/**
 * Families that pdf-lib can subset safely. Subsetting Inter (and some user fonts) drops glyphs, so
 * everything else is embedded whole: larger files, but every character prints.
 */
const SUBSET_SAFE = new Set(["Montserrat", "Playfair Display", "Lora", "Oswald"]);

export class FontBook {
  private cache = new Map<string, Promise<PrintFont>>();
  constructor(
    private doc: PDFDocument,
    private loader: FontLoader,
    private readFile: (path: string) => Promise<Uint8Array>,
  ) {
    doc.registerFontkit(fontkit);
  }

  get(s: Pick<TextStyle, "font" | "weight" | "italic">): Promise<PrintFont> {
    const key = `${s.font}|${s.weight}|${s.italic}`;
    let f = this.cache.get(key);
    if (!f) {
      f = this.load(s).catch(async (e) => {
        console.warn(`Font ${s.font} unavailable, using Helvetica`, e);
        return this.wrap(await this.doc.embedFont(STANDARD.Helvetica[s.weight >= 600 ? 1 : 0]));
      });
      this.cache.set(key, f);
    }
    return f;
  }

  private async load(s: Pick<TextStyle, "font" | "weight" | "italic">): Promise<PrintFont> {
    const std = STANDARD[s.font];
    if (std) return this.wrap(await this.doc.embedFont(std[(s.weight >= 600 ? 1 : 0) + (s.italic ? 2 : 0)]));
    const bytes = s.font.startsWith("file:") ? await this.readFile(s.font.slice(5)) : await this.loader(s.font, s.weight, s.italic);
    return this.wrap(await this.doc.embedFont(bytes, { subset: SUBSET_SAFE.has(s.font) }));
  }

  private wrap(font: PDFFont): PrintFont {
    const set = new Set(font.getCharacterSet());
    const ok = (c: string) => set.has(c.codePointAt(0)!);
    return {
      font,
      clean: (s: string) => {
        let out = "";
        for (const ch of s) {
          if (ok(ch) || ch === "\n") out += ch;
          else if (QUOTES[ch] && [...QUOTES[ch]].every(ok)) out += QUOTES[ch];
          else {
            const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
            out += base && [...base].every(ok) ? base : ok("?") ? "?" : "";
          }
        }
        return out;
      },
    };
  }
}
