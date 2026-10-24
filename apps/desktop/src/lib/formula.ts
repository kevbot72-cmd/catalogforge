// Excel-style formula language used by the Mass Changer and the import pipeline.
//
//   =ROUND(regular_price * 1.15, 2)
//   =CHARM(regular_price * 0.8)                 → 12.30 becomes 12.99
//   =IF(stock_quantity > 0, "instock", "outofstock")
//   =PROPER(TRIM({Product Title})) & " - " & {Colour}
//
// Field references are bare identifiers (product fields) or {Any Column Name} (import columns).

export type Value = number | string | boolean | null;

export class FormulaError extends Error {
  constructor(message: string, public pos = -1) {
    super(message);
  }
}

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; name: string }
  | { t: "call"; name: string; args: Node[] }
  | { t: "un"; op: string; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node };

type Tok = { k: "num" | "str" | "id" | "ref" | "op" | "(" | ")" | "," | "eof"; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9.]/.test(c)) {
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      if (src[i] === "e" || src[i] === "E") {
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      out.push({ k: "num", v: src.slice(start, i), pos: start });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let s = "";
      // Excel rules: a doubled quote is a literal quote; backslashes are kept as-is so regex
      // patterns like "\d+" work without double escaping.
      for (;;) {
        if (i >= src.length) break;
        if (src[i] === c) {
          if (src[i + 1] === c) {
            s += c;
            i += 2;
            continue;
          }
          break;
        }
        s += src[i++];
      }
      if (src[i] !== c) throw new FormulaError("Unterminated text", start);
      i++;
      out.push({ k: "str", v: s, pos: start });
      continue;
    }
    if (c === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) throw new FormulaError("Missing } in column reference", start);
      out.push({ k: "ref", v: src.slice(i + 1, end).trim(), pos: start });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) i++;
      out.push({ k: "id", v: src.slice(start, i), pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "=="].includes(two)) {
      out.push({ k: "op", v: two, pos: start });
      i += 2;
      continue;
    }
    if ("+-*/%^&<>=".includes(c)) {
      out.push({ k: "op", v: c, pos: start });
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      out.push({ k: c as "(" | ")" | ",", v: c, pos: start });
      i++;
      continue;
    }
    if (c === ";") {
      out.push({ k: ",", v: ",", pos: start });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`, start);
  }
  out.push({ k: "eof", v: "", pos: src.length });
  return out;
}

const PREC: Record<string, number> = { "=": 1, "==": 1, "<>": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "%": 4, "^": 6 };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek() {
    return this.toks[this.i];
  }
  next() {
    return this.toks[this.i++];
  }
  expect(k: Tok["k"]) {
    const t = this.next();
    if (t.k !== k) throw new FormulaError(k === ")" ? "Missing closing parenthesis" : `Expected ${k}`, t.pos);
    return t;
  }
  parse(): Node {
    const n = this.expr(0);
    const t = this.peek();
    if (t.k !== "eof") throw new FormulaError(`Unexpected "${t.v}"`, t.pos);
    return n;
  }
  expr(min: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k !== "op") break;
      const p = PREC[t.v];
      if (p === undefined || p < min) break;
      this.next();
      const right = this.expr(t.v === "^" ? p : p + 1);
      left = { t: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }
  unary(): Node {
    const t = this.peek();
    if (t.k === "op" && (t.v === "-" || t.v === "+")) {
      this.next();
      return { t: "un", op: t.v, a: this.expr(5) };
    }
    return this.primary();
  }
  primary(): Node {
    const t = this.next();
    switch (t.k) {
      case "num": {
        const v = Number(t.v);
        if (Number.isNaN(v)) throw new FormulaError(`Bad number "${t.v}"`, t.pos);
        return { t: "num", v };
      }
      case "str":
        return { t: "str", v: t.v };
      case "ref":
        return { t: "ref", name: t.v };
      case "(": {
        const e = this.expr(0);
        this.expect(")");
        return e;
      }
      case "id": {
        const up = t.v.toUpperCase();
        if (this.peek().k === "(") {
          this.next();
          const args: Node[] = [];
          if (this.peek().k !== ")") {
            for (;;) {
              args.push(this.expr(0));
              if (this.peek().k === ",") {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expect(")");
          if (!FUNCS[up]) throw new FormulaError(`Unknown function ${up}()`, t.pos);
          return { t: "call", name: up, args };
        }
        if (up === "TRUE" || up === "FALSE") return { t: "bool", v: up === "TRUE" };
        return { t: "ref", name: t.v };
      }
      default:
        throw new FormulaError(t.k === "eof" ? "Formula ends unexpectedly" : `Unexpected "${t.v}"`, t.pos);
    }
  }
}

export function isBlank(v: unknown) {
  return v === null || v === undefined || v === "";
}

export function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isBlank(v)) return 0;
  const n = Number(String(v).replace(/[,\s]/g, "").replace(/^[$€£¥]/, ""));
  if (Number.isNaN(n)) throw new FormulaError(`"${String(v).slice(0, 30)}" is not a number`);
  return n;
}

export function toStr(v: unknown): string {
  if (isBlank(v)) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toFixed(10));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return v.map(toStr).join(", ");
  return String(v);
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (isBlank(v)) return false;
  const s = String(v).toLowerCase();
  return !(s === "false" || s === "0" || s === "no");
}

function round(x: number, d = 0) {
  const f = Math.pow(10, d);
  return Math.round((x + Number.EPSILON) * f) / f;
}

function proper(s: string) {
  return s.toLowerCase().replace(/(^|[\s\-/(])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
}

function slug(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type Fn = (args: Value[]) => Value;
const n = toNum;
const s = toStr;

export const FUNCS: Record<string, Fn> = {
  ROUND: ([x, d]) => round(n(x), d === undefined ? 0 : n(d)),
  ROUNDUP: ([x, d]) => {
    const f = Math.pow(10, d === undefined ? 0 : n(d));
    return Math.ceil(round(n(x) * f, 8)) / f;
  },
  ROUNDDOWN: ([x, d]) => {
    const f = Math.pow(10, d === undefined ? 0 : n(d));
    return Math.floor(round(n(x) * f, 8)) / f;
  },
  CEIL: ([x, step]) => {
    const st = step === undefined ? 1 : n(step);
    return round(Math.ceil(round(n(x) / st, 8)) * st, 8);
  },
  FLOOR: ([x, step]) => {
    const st = step === undefined ? 1 : n(step);
    return round(Math.floor(round(n(x) / st, 8)) * st, 8);
  },
  /** Charm pricing: rounds up to the next price ending in `ending` (default .99). */
  CHARM: ([x, ending]) => {
    const e = ending === undefined ? 0.99 : n(ending);
    return round(Math.ceil(round(n(x) - e, 8)) + e, 2);
  },
  PERCENT_OFF: ([x, pct]) => round(n(x) * (1 - n(pct) / 100), 4),
  MARKUP: ([x, pct]) => round(n(x) * (1 + n(pct) / 100), 4),
  ABS: ([x]) => Math.abs(n(x)),
  MOD: ([a, b]) => n(a) % n(b),
  POW: ([a, b]) => Math.pow(n(a), n(b)),
  MIN: (a) => Math.min(...a.filter((x) => !isBlank(x)).map(n)),
  MAX: (a) => Math.max(...a.filter((x) => !isBlank(x)).map(n)),
  SUM: (a) => a.reduce<number>((t, x) => t + n(x), 0),
  AVERAGE: (a) => {
    const v = a.filter((x) => !isBlank(x)).map(n);
    return v.length ? v.reduce((t, x) => t + x, 0) / v.length : 0;
  },
  IF: ([c, a, b]) => (truthy(c) ? (a ?? "") : (b ?? "")),
  AND: (a) => a.every(truthy),
  OR: (a) => a.some(truthy),
  NOT: ([x]) => !truthy(x),
  ISBLANK: ([x]) => isBlank(x),
  COALESCE: (a) => a.find((x) => !isBlank(x)) ?? "",
  IFBLANK: ([x, alt]) => (isBlank(x) ? (alt ?? "") : x),
  CONCAT: (a) => a.map(s).join(""),
  LEN: ([x]) => s(x).length,
  UPPER: ([x]) => s(x).toUpperCase(),
  LOWER: ([x]) => s(x).toLowerCase(),
  PROPER: ([x]) => proper(s(x)),
  TRIM: ([x]) => s(x).replace(/\s+/g, " ").trim(),
  LEFT: ([x, k]) => s(x).slice(0, k === undefined ? 1 : n(k)),
  RIGHT: ([x, k]) => {
    const str = s(x);
    const c = k === undefined ? 1 : n(k);
    return c <= 0 ? "" : str.slice(-c);
  },
  MID: ([x, start, k]) => s(x).substr(Math.max(0, n(start) - 1), n(k)),
  SUBSTITUTE: ([x, find, rep]) => s(x).split(s(find)).join(s(rep)),
  REGEXREPLACE: ([x, pat, rep, flags]) => s(x).replace(new RegExp(s(pat), flags === undefined ? "g" : s(flags)), s(rep)),
  REGEXMATCH: ([x, pat, flags]) => new RegExp(s(pat), flags === undefined ? "i" : s(flags)).test(s(x)),
  REGEXEXTRACT: ([x, pat, group]) => {
    const m = s(x).match(new RegExp(s(pat), "i"));
    return m ? (m[group === undefined ? (m.length > 1 ? 1 : 0) : n(group)] ?? "") : "";
  },
  CONTAINS: ([x, sub]) => s(x).toLowerCase().includes(s(sub).toLowerCase()),
  STARTSWITH: ([x, sub]) => s(x).toLowerCase().startsWith(s(sub).toLowerCase()),
  SPLIT: ([x, sep, idx]) => {
    const parts = s(x).split(s(sep));
    const i = idx === undefined ? 1 : n(idx);
    return (i < 0 ? parts[parts.length + i] : parts[i - 1])?.trim() ?? "";
  },
  SLUG: ([x]) => slug(s(x)),
  STRIPHTML: ([x]) => s(x).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
  TEXT: ([x, d]) => n(x).toFixed(d === undefined ? 2 : n(d)),
  VALUE: ([x]) => n(x),
};

function evalNode(node: Node, get: (name: string) => unknown): Value {
  switch (node.t) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "ref": {
      const v = get(node.name);
      if (v === undefined) throw new FormulaError(`Unknown field "${node.name}"`);
      if (Array.isArray(v)) return v.map(toStr).join(", ");
      return v as Value;
    }
    case "un": {
      const v = n(evalNode(node.a, get));
      return node.op === "-" ? -v : v;
    }
    case "call": {
      // IF is lazy so the untaken branch cannot raise errors.
      if (node.name === "IF") {
        const c = truthy(evalNode(node.args[0], get));
        const branch = c ? node.args[1] : node.args[2];
        return branch ? evalNode(branch, get) : "";
      }
      return FUNCS[node.name](node.args.map((a) => evalNode(a, get)));
    }
    case "bin": {
      const a = evalNode(node.a, get);
      const b = evalNode(node.b, get);
      switch (node.op) {
        case "+":
          return round(n(a) + n(b), 10);
        case "-":
          return round(n(a) - n(b), 10);
        case "*":
          return round(n(a) * n(b), 10);
        case "/": {
          const d = n(b);
          if (d === 0) throw new FormulaError("Division by zero");
          return n(a) / d;
        }
        case "%":
          return n(a) % n(b);
        case "^":
          return Math.pow(n(a), n(b));
        case "&":
          return s(a) + s(b);
        default: {
          const numeric = !isBlank(a) && !isBlank(b) && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b));
          const x: number | string = numeric ? Number(a) : s(a).toLowerCase();
          const y: number | string = numeric ? Number(b) : s(b).toLowerCase();
          switch (node.op) {
            case "=":
            case "==":
              return x === y;
            case "<>":
            case "!=":
              return x !== y;
            case "<":
              return x < y;
            case ">":
              return x > y;
            case "<=":
              return x <= y;
            case ">=":
              return x >= y;
          }
        }
      }
    }
  }
  return null;
}

function collectRefs(node: Node, out: Set<string>) {
  if (node.t === "ref") out.add(node.name);
  else if (node.t === "call") node.args.forEach((a) => collectRefs(a, out));
  else if (node.t === "un") collectRefs(node.a, out);
  else if (node.t === "bin") {
    collectRefs(node.a, out);
    collectRefs(node.b, out);
  }
}

export interface Compiled {
  source: string;
  refs: string[];
  run(get: (name: string) => unknown): Value;
}

export function compile(source: string): Compiled {
  const src = source.trim().replace(/^=/, "");
  if (!src) throw new FormulaError("Formula is empty", 0);
  const ast = new Parser(tokenize(src)).parse();
  const refs = new Set<string>();
  collectRefs(ast, refs);
  return { source, refs: [...refs], run: (get) => evalNode(ast, get) };
}

/** Formats a numeric result for a WooCommerce price/decimal field. */
export function formatDecimal(v: Value, decimals = 2): string {
  if (isBlank(v)) return "";
  const num = toNum(v);
  return num.toFixed(decimals);
}

export const FUNCTION_HELP: { name: string; sig: string; doc: string }[] = [
  { name: "ROUND", sig: "ROUND(x, [digits])", doc: "Round to digits" },
  { name: "CHARM", sig: "CHARM(x, [ending=.99])", doc: "Round up to a price ending in .99" },
  { name: "CEIL", sig: "CEIL(x, [step])", doc: "Round up to a multiple of step" },
  { name: "FLOOR", sig: "FLOOR(x, [step])", doc: "Round down to a multiple of step" },
  { name: "PERCENT_OFF", sig: "PERCENT_OFF(x, pct)", doc: "x minus pct %" },
  { name: "MARKUP", sig: "MARKUP(x, pct)", doc: "x plus pct %" },
  { name: "MIN", sig: "MIN(a, b, …)", doc: "Smallest value" },
  { name: "MAX", sig: "MAX(a, b, …)", doc: "Largest value" },
  { name: "IF", sig: "IF(cond, then, [else])", doc: "Conditional" },
  { name: "AND", sig: "AND(a, b, …)", doc: "All true" },
  { name: "OR", sig: "OR(a, b, …)", doc: "Any true" },
  { name: "COALESCE", sig: "COALESCE(a, b, …)", doc: "First non-empty value" },
  { name: "CONCAT", sig: "CONCAT(a, b, …)", doc: "Join text (or use &)" },
  { name: "PROPER", sig: "PROPER(text)", doc: "Title Case" },
  { name: "UPPER", sig: "UPPER(text)", doc: "UPPERCASE" },
  { name: "LOWER", sig: "LOWER(text)", doc: "lowercase" },
  { name: "TRIM", sig: "TRIM(text)", doc: "Collapse whitespace" },
  { name: "SUBSTITUTE", sig: "SUBSTITUTE(text, find, replace)", doc: "Replace all occurrences" },
  { name: "REGEXREPLACE", sig: "REGEXREPLACE(text, pattern, replace)", doc: "Regex replace" },
  { name: "REGEXEXTRACT", sig: "REGEXEXTRACT(text, pattern, [group])", doc: "Regex capture" },
  { name: "CONTAINS", sig: "CONTAINS(text, part)", doc: "Case-insensitive contains" },
  { name: "SPLIT", sig: "SPLIT(text, sep, index)", doc: "Nth part (1-based, negative from end)" },
  { name: "LEFT", sig: "LEFT(text, n)", doc: "First n characters" },
  { name: "SLUG", sig: "SLUG(text)", doc: "url-friendly-slug" },
  { name: "STRIPHTML", sig: "STRIPHTML(html)", doc: "Plain text" },
];
