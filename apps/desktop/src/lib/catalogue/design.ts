// Catalogue design: every choice the PDF generator makes is stored here, so a design can be saved,
// reused across stores and regenerated whenever the catalogue changes.

export type FontFamily = "Helvetica" | "Times" | "Courier" | "Inter" | "Montserrat" | "Playfair Display" | "Lora" | "Oswald" | string; // or "file:<path>"

export interface TextStyle {
  font: FontFamily;
  weight: number; // 300–700
  italic: boolean;
  size: number; // pt
  color: string; // #rrggbb
  align: "left" | "center" | "right";
  uppercase: boolean;
}

export interface CoverText {
  id: string;
  label: string;
  text: string;
  style: TextStyle;
  /** Vertical position of the text's top edge, % of page height. */
  y: number;
}

export type Layout = "grid" | "list" | "pricelist" | "feature";
export type PageSize = "A4" | "Letter" | "A5" | "Legal" | "Square";

/** A page of the template PDF to draw behind a page role (0-based), or null for none. */
export interface TemplatePages {
  cover: number | null;
  index: number | null;
  left: number | null;
  right: number | null;
  back: number | null;
}

export interface HeaderFooter {
  enabled: boolean;
  left: string;
  center: string;
  right: string;
  style: TextStyle;
  line: boolean;
  lineColor: string;
  /** Mirror left/right on left-hand (even) pages, for printed booklets. */
  mirror: boolean;
}

export interface CatalogueDesign {
  name: string;
  /* page */
  pageSize: PageSize;
  landscape: boolean;
  margin: number; // mm
  /* template */
  templateFile: { path: string; name: string } | null;
  templatePages: TemplatePages;
  /* content */
  excludedCategories: number[];
  excludedProducts: number[];
  includeDrafts: boolean;
  hideOutOfStock: boolean;
  includeUncategorised: boolean;
  multiCategory: "first" | "all";
  sort: "menu_order" | "name" | "price_asc" | "price_desc" | "sku";
  /* sections */
  newPagePerCategory: boolean;
  dividerPages: boolean;
  showIndex: boolean;
  indexTitle: string;
  indexDepth: number;
  azIndex: boolean;
  backCover: boolean;
  /* layout */
  layout: Layout;
  columns: number;
  rows: number;
  gap: number; // mm
  imageFit: "contain" | "cover";
  cardBackground: string;
  cardBorder: boolean;
  rounded: boolean;
  /* card fields */
  show: {
    image: boolean;
    sku: boolean;
    price: boolean;
    description: boolean;
    stock: boolean;
    attributes: boolean;
    qr: boolean;
    badges: boolean;
    gtin: boolean;
    weight: boolean;
  };
  customFields: string[];
  descriptionLines: number;
  priceLabel: string;
  priceAdjust: number; // % (e.g. -30 for a trade catalogue)
  /* styles */
  accent: string;
  pageBackground: string;
  productName: TextStyle;
  body: TextStyle;
  price: TextStyle;
  categoryHeading: TextStyle;
  header: HeaderFooter;
  footer: HeaderFooter;
  /* cover */
  coverBackground: string;
  coverImage: { path: string; name: string } | null;
  coverImageOpacity: number;
  coverOverlay: boolean;
  logo: { path: string; name: string } | null;
  logoWidth: number; // % of page width
  logoY: number;
  coverTexts: CoverText[];
  backTexts: CoverText[];
  /* output */
  imageQuality: "screen" | "print";
  watermark: string;
  links: boolean;
}

export const style = (s: Partial<TextStyle> = {}): TextStyle => ({ font: "Inter", weight: 400, italic: false, size: 10, color: "#1f2937", align: "left", uppercase: false, ...s });

export const PAGE_SIZES: Record<PageSize, [number, number]> = {
  // points (1/72 in)
  A4: [595.28, 841.89],
  Letter: [612, 792],
  A5: [419.53, 595.28],
  Legal: [612, 1008],
  Square: [595.28, 595.28],
};

export const MM = 72 / 25.4;

export function defaultDesign(storeName = "Our store"): CatalogueDesign {
  const year = new Date().getFullYear();
  return {
    name: "Classic catalogue",
    pageSize: "A4",
    landscape: false,
    margin: 14,
    templateFile: null,
    templatePages: { cover: 0, index: 1, left: 2, right: 3, back: null },
    excludedCategories: [],
    excludedProducts: [],
    includeDrafts: false,
    hideOutOfStock: false,
    includeUncategorised: false,
    multiCategory: "first",
    sort: "menu_order",
    newPagePerCategory: true,
    dividerPages: false,
    showIndex: true,
    indexTitle: "Contents",
    indexDepth: 3,
    azIndex: true,
    backCover: true,
    layout: "grid",
    columns: 3,
    rows: 3,
    gap: 5,
    imageFit: "contain",
    cardBackground: "#ffffff",
    cardBorder: true,
    rounded: true,
    show: { image: true, sku: true, price: true, description: true, stock: false, attributes: true, qr: false, badges: true, gtin: false, weight: false },
    customFields: [],
    descriptionLines: 2,
    priceLabel: "",
    priceAdjust: 0,
    accent: "#4f46e5",
    pageBackground: "#ffffff",
    productName: style({ weight: 600, size: 10.5, color: "#111827" }),
    body: style({ size: 8, color: "#4b5563" }),
    price: style({ weight: 700, size: 11, color: "#4f46e5" }),
    categoryHeading: style({ font: "Playfair Display", weight: 700, size: 20, color: "#111827" }),
    header: { enabled: true, left: "{store}", center: "", right: "{category}", style: style({ size: 8, color: "#6b7280" }), line: true, lineColor: "#e5e7eb", mirror: true },
    footer: { enabled: true, left: "{website}", center: "", right: "Page {page} of {pages}", style: style({ size: 8, color: "#6b7280" }), line: false, lineColor: "#e5e7eb", mirror: true },
    coverBackground: "#111827",
    coverImage: null,
    coverImageOpacity: 0.55,
    coverOverlay: true,
    logo: null,
    logoWidth: 28,
    logoY: 10,
    coverTexts: [
      { id: "eyebrow", label: "Edition", text: `Product catalogue ${year}`, style: style({ weight: 600, size: 11, color: "#c7d2fe", align: "center", uppercase: true }), y: 36 },
      { id: "title", label: "Title", text: storeName, style: style({ font: "Playfair Display", weight: 700, size: 46, color: "#ffffff", align: "center" }), y: 40 },
      { id: "subtitle", label: "Subtitle", text: "Everything we make, in one place", style: style({ weight: 300, size: 16, color: "#e5e7eb", align: "center" }), y: 54 },
      { id: "contact", label: "Contact", text: "{website}", style: style({ weight: 500, size: 10, color: "#e5e7eb", align: "center" }), y: 90 },
    ],
    backTexts: [
      { id: "thanks", label: "Heading", text: "Thank you", style: style({ font: "Playfair Display", weight: 700, size: 28, color: "#ffffff", align: "center" }), y: 38 },
      { id: "contact", label: "Contact details", text: "{website}\nPrices valid {date}", style: style({ size: 11, color: "#e5e7eb", align: "center" }), y: 48 },
    ],
    imageQuality: "print",
    watermark: "",
    links: true,
  };
}

/** Ready-made looks; each only overrides styling so content choices are kept. */
export const THEMES: Record<string, (d: CatalogueDesign) => CatalogueDesign> = {
  Classic: (d) => ({ ...d, accent: "#4f46e5", coverBackground: "#111827", pageBackground: "#ffffff", cardBackground: "#ffffff", cardBorder: true, rounded: true, categoryHeading: { ...d.categoryHeading, font: "Playfair Display", color: "#111827" }, productName: { ...d.productName, font: "Inter" }, body: { ...d.body, font: "Inter" }, price: { ...d.price, font: "Inter", color: "#4f46e5" } }),
  Minimal: (d) => ({ ...d, accent: "#111111", coverBackground: "#f5f5f4", pageBackground: "#ffffff", cardBackground: "#ffffff", cardBorder: false, rounded: false, categoryHeading: { ...d.categoryHeading, font: "Inter", weight: 300, color: "#111111" }, productName: { ...d.productName, font: "Inter", weight: 500 }, body: { ...d.body, font: "Inter" }, price: { ...d.price, font: "Inter", weight: 600, color: "#111111" }, coverTexts: d.coverTexts.map((t) => ({ ...t, style: { ...t.style, color: t.id === "title" ? "#111111" : "#57534e", font: t.id === "title" ? "Inter" : t.style.font, weight: t.id === "title" ? 300 : t.style.weight } })), backTexts: d.backTexts.map((t) => ({ ...t, style: { ...t.style, color: "#44403c" } })) }),
  Bold: (d) => ({ ...d, accent: "#ea580c", coverBackground: "#ea580c", pageBackground: "#fffbf5", cardBackground: "#ffffff", cardBorder: false, rounded: true, categoryHeading: { ...d.categoryHeading, font: "Oswald", weight: 600, uppercase: true, color: "#9a3412" }, productName: { ...d.productName, font: "Montserrat", weight: 700 }, body: { ...d.body, font: "Montserrat" }, price: { ...d.price, font: "Oswald", weight: 600, color: "#ea580c" }, coverTexts: d.coverTexts.map((t) => ({ ...t, style: { ...t.style, color: "#ffffff", font: t.id === "title" ? "Oswald" : "Montserrat", uppercase: t.id === "title" || t.style.uppercase } })) }),
  Boutique: (d) => ({ ...d, accent: "#9f1239", coverBackground: "#1c1917", pageBackground: "#faf7f2", cardBackground: "#faf7f2", cardBorder: false, rounded: false, categoryHeading: { ...d.categoryHeading, font: "Playfair Display", weight: 400, italic: true, color: "#1c1917" }, productName: { ...d.productName, font: "Lora", weight: 600 }, body: { ...d.body, font: "Lora" }, price: { ...d.price, font: "Lora", weight: 600, color: "#9f1239" }, coverTexts: d.coverTexts.map((t) => ({ ...t, style: { ...t.style, font: t.id === "title" ? "Playfair Display" : "Lora", color: t.id === "eyebrow" ? "#fda4af" : t.style.color } })) }),
};

export const FONT_FAMILIES = ["Inter", "Montserrat", "Playfair Display", "Lora", "Oswald", "Helvetica", "Times", "Courier"];

export const TOKENS = ["{store}", "{website}", "{category}", "{page}", "{pages}", "{date}", "{title}"];

/** Fills header, footer and cover tokens. */
export function fillTokens(text: string, t: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in t ? t[k] : m));
}
