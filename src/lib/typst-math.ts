// Typst math to LaTeX, for the visual layer. Typst's math syntax is small and
// regular: single letters are variables, words are symbols or functions,
// `_` and `^` take one atom or a parenthesised group, `/` is a fraction,
// `"..."` is text, `f(a, b)` is a call. This translates the common subset
// into what KaTeX renders; anything it cannot follow returns null and the
// caller keeps the source.

const GREEK = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split(" ");
const FUNCS = "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp det dim ker gcd max min sup inf lim liminf limsup arg deg hom Pr".split(" ");
const BIG = "sum prod".split(" ");

/** Words with a different LaTeX name. Dotted variants come before their base. */
const SYMBOLS: Record<string, string> = {
  "epsilon.alt": "\\varepsilon", "phi.alt": "\\varphi", "theta.alt": "\\vartheta", "rho.alt": "\\varrho", "pi.alt": "\\varpi", "sigma.alt": "\\varsigma",
  "arrow.r": "\\to", "arrow.l": "\\leftarrow", "arrow.l.r": "\\leftrightarrow", "arrow.r.double": "\\Rightarrow", "arrow.l.double": "\\Leftarrow", "arrow.l.r.double": "\\Leftrightarrow",
  "arrow.r.long": "\\longrightarrow", "arrow.l.long": "\\longleftarrow", "arrow.t": "\\uparrow", "arrow.b": "\\downarrow", "arrow.r.bar": "\\mapsto", "arrow.squiggly": "\\rightsquigarrow",
  "arrow.r.hook": "\\hookrightarrow", "arrow.l.hook": "\\hookleftarrow", "harpoon.rt": "\\rightharpoonup",
  "dots": "\\dots", "dots.h": "\\dots", "dots.h.c": "\\cdots", "dots.c": "\\cdots", "dots.v": "\\vdots", "dots.down": "\\ddots", "dots.up": "\\iddots",
  "eq.not": "\\ne", "eq.triple": "\\equiv", "eq.def": "\\triangleq", "lt.eq": "\\le", "gt.eq": "\\ge", "lt.eq.not": "\\nleq", "gt.eq.not": "\\ngeq", "lt.lt": "\\ll", "gt.gt": "\\gg",
  "approx": "\\approx", "approx.not": "\\not\\approx", "tilde.op": "\\sim", "tilde.eq": "\\simeq", "equiv": "\\equiv", "prop": "\\propto", "ident": "\\equiv",
  "plus.minus": "\\pm", "minus.plus": "\\mp", "times": "\\times", "div": "\\div", "dot": "\\cdot", "dot.op": "\\cdot", "dot.c": "\\cdot", "ast": "\\ast", "ast.op": "\\ast", "star": "\\star", "star.op": "\\star",
  "circle": "\\circ", "compose": "\\circ", "convolve": "\\ast", "times.circle": "\\otimes", "plus.circle": "\\oplus", "minus.circle": "\\ominus", "dot.circle": "\\odot",
  "in": "\\in", "in.not": "\\notin", "in.rev": "\\ni", "subset": "\\subset", "subset.eq": "\\subseteq", "subset.neq": "\\subsetneq", "supset": "\\supset", "supset.eq": "\\supseteq",
  "union": "\\cup", "union.big": "\\bigcup", "sect": "\\cap", "sect.big": "\\bigcap", "inter": "\\cap", "inter.big": "\\bigcap", "emptyset": "\\emptyset", "nothing": "\\varnothing", "diff": "\\partial", "partial": "\\partial", "nabla": "\\nabla", "gradient": "\\nabla",
  "forall": "\\forall", "exists": "\\exists", "exists.not": "\\nexists", "not": "\\neg", "and": "\\land", "and.big": "\\bigwedge", "or": "\\lor", "or.big": "\\bigvee", "xor": "\\oplus",
  "tack.r": "\\vdash", "tack.l": "\\dashv", "tack.b": "\\bot", "tack.t": "\\top", "models": "\\models", "therefore": "\\therefore", "because": "\\because", "top": "\\top", "bot": "\\bot",
  "angle.l": "\\langle", "angle.r": "\\rangle", "bracket.l": "[", "bracket.r": "]", "brace.l": "\\{", "brace.r": "\\}", "paren.l": "(", "paren.r": ")", "bar.v": "|", "bar.v.double": "\\|",
  "floor.l": "\\lfloor", "floor.r": "\\rfloor", "ceil.l": "\\lceil", "ceil.r": "\\rceil",
  "oo": "\\infty", "infinity": "\\infty", "infty": "\\infty", "hbar": "\\hbar", "planck.reduce": "\\hbar", "ell": "\\ell", "degree": "^\\circ", "prime": "'", "prime.double": "''",
  "RR": "\\mathbb{R}", "NN": "\\mathbb{N}", "ZZ": "\\mathbb{Z}", "QQ": "\\mathbb{Q}", "CC": "\\mathbb{C}", "PP": "\\mathbb{P}", "EE": "\\mathbb{E}", "AA": "\\mathbb{A}", "FF": "\\mathbb{F}", "KK": "\\mathbb{K}",
  "integral": "\\int", "integral.double": "\\iint", "integral.triple": "\\iiint", "integral.cont": "\\oint", "sum.big": "\\sum", "product": "\\prod",
  "dif": "\\mathrm{d}", "space": "\\ ", "thin": "\\,", "med": "\\:", "thick": "\\;", "quad": "\\quad", "wide": "\\qquad", "zws": "", "colon": ":", "comma": ",", "semi": ";", "amp": "\\&", "hash": "\\#", "percent": "\\%", "dollar": "\\$", "underscore": "\\_",
  "lt": "<", "gt": ">", "eq": "=", "plus": "+", "minus": "-", "slash": "/", "backslash": "\\backslash", "excl": "!", "quest": "?", "checkmark": "\\checkmark", "suit.heart": "\\heartsuit", "qed": "\\blacksquare",
  "triangle": "\\triangle", "square": "\\square", "diamond": "\\diamond", "bullet": "\\bullet", "perp": "\\perp", "parallel": "\\parallel", "angle": "\\angle", "wreath": "\\wr", "aleph": "\\aleph", "beth": "\\beth",
  "ohm": "\\Omega", "kelvin": "K", "arrow": "\\rightarrow",
};

const ACCENTS: Record<string, string> = { hat: "\\hat", tilde: "\\tilde", bar: "\\bar", dot: "\\dot", ddot: "\\ddot", arrow: "\\vec", overline: "\\overline", underline: "\\underline", acute: "\\acute", grave: "\\grave", breve: "\\breve", check: "\\check", macron: "\\bar", dash: "\\bar", circle: "\\mathring", caron: "\\check" };
const STYLES: Record<string, string> = { upright: "\\mathrm", bold: "\\mathbf", italic: "\\mathit", cal: "\\mathcal", bb: "\\mathbb", frak: "\\mathfrak", sans: "\\mathsf", mono: "\\mathtt", serif: "\\mathrm", display: "\\displaystyle", inline: "\\textstyle", script: "\\scriptstyle", sscript: "\\scriptscriptstyle" };
const WRAPS: Record<string, [string, string]> = { abs: ["\\left|", "\\right|"], norm: ["\\left\\|", "\\right\\|"], floor: ["\\left\\lfloor", "\\right\\rfloor"], ceil: ["\\left\\lceil", "\\right\\rceil"], round: ["\\left\\lfloor", "\\right\\rceil"], lr: ["\\left.", "\\right."] };

type Tok = { t: "word" | "num" | "str" | "op" | "ws"; v: string };

// Delimiters `lr(...)` may open or close with. Typst matches them in the parser, so `lr(] a, b ])` is legal and
// means "a bracket on both sides"; each side is read on its own (`\left]` is fine in KaTeX) and `.` stands
// in for a missing one. Ops are the raw characters; words are Typst's named symbols.
const LR_OP: Record<string, string> = { "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", "<": "\\langle", ">": "\\rangle" };
const LR_WORD: Record<string, string> = {
  "paren.l": "(", "paren.r": ")", "bracket.l": "[", "bracket.r": "]", "brace.l": "\\{", "brace.r": "\\}", "bar.v": "|", "bar.v.double": "\\|",
  "angle.l": "\\langle", "angle.r": "\\rangle", "floor.l": "\\lfloor", "floor.r": "\\rfloor", "ceil.l": "\\lceil", "ceil.r": "\\rceil",
};

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s+|"(?:[^"\\]|\\.)*"|[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*|\d+(?:\.\d+)?|->|<-|=>|<=|>=|!=|:=|\.\.\.|\\\\|\\[^\sA-Za-z]|[^\sA-Za-z0-9"]/gu;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src))) {
    if (m.index !== last) throw new Error("gap");
    last = re.lastIndex;
    const v = m[0];
    if (/^\s/.test(v)) out.push({ t: "ws", v: " " });
    else if (v[0] === '"') out.push({ t: "str", v: v.slice(1, -1) });
    else if (/^[A-Za-z]/.test(v)) out.push({ t: "word", v });
    else if (/^\d/.test(v)) out.push({ t: "num", v });
    else out.push({ t: "op", v });
  }
  if (last !== src.length) throw new Error("gap");
  return out;
}

const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "|": "|" };
const OPS: Record<string, string> = { "->": "\\to", "<-": "\\leftarrow", "=>": "\\Rightarrow", "<=": "\\le", ">=": "\\ge", "!=": "\\ne", ":=": "\\coloneqq", "...": "\\dots", "\\\\": "\\\\", "*": "\\ast", "{": "\\{", "}": "\\}", "&": "&", "%": "\\%", "#": "\\#", "~": "\\sim" };

class Parser {
  i = 0;
  /** Lenient: a closer with no opener is a symbol, not an error (inside `lr`, where Typst allows it). */
  constructor(readonly toks: Tok[], readonly lenient = false) {}
  peek(k = 0): Tok | undefined { return this.toks[this.i + k]; }
  next(): Tok { const t = this.toks[this.i++]; if (!t) throw new Error("eof"); return t; }
  skipWs() { while (this.peek()?.t === "ws") this.i++; }

  /** A sequence up to a closer or top-level separator. */
  seq(stop: (t: Tok) => boolean): string {
    let out = "";
    while (this.peek() && !stop(this.peek()!)) {
      const t = this.peek()!;
      if (t.t === "ws") { this.i++; out += " "; continue; }
      out += this.scripted();
    }
    return out;
  }

  /** An atom with any `_`, `^` and `/` that follow it. */
  scripted(): string {
    let base = this.atom();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== "op") break;
      if (t.v === "_" || t.v === "^") { this.i++; base += `${t.v}{${this.argument()}}`; continue; }
      if (t.v === "/") { this.i++; this.skipWs(); base = `\\frac{${this.stripGroup(base)}}{${this.stripGroup(this.atomWithScripts())}}`; continue; }
      break;
    }
    // `a / b` is a fraction too; the slash may sit after spaces.
    let k = 0;
    while (this.peek(k)?.t === "ws") k++;
    const slash = this.peek(k);
    if (k > 0 && slash && slash.t === "op" && slash.v === "/") {
      this.i += k + 1; this.skipWs();
      return `\\frac{${this.stripGroup(base)}}{${this.stripGroup(this.atomWithScripts())}}`;
    }
    return base;
  }
  atomWithScripts(): string {
    let base = this.atom();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "_" || t.v === "^")) { this.i++; base += `${t.v}{${this.argument()}}`; continue; }
      break;
    }
    return base;
  }
  /** Argument of a script: one atom, a parenthesised group losing its parentheses. */
  argument(): string { return this.stripGroup(this.atom()); }
  /** The last parenthesised group parsed, as [with parentheses, without]; lets a script or fraction drop them. */
  lastGroup: [string, string] | null = null;
  stripGroup(s: string): string { return this.lastGroup && this.lastGroup[0] === s ? this.lastGroup[1] : s; }

  group(open: string): string {
    const close = CLOSE[open];
    this.next();
    const inner = this.seq((t) => t.t === "op" && t.v === close);
    if (!this.peek()) throw new Error("unclosed");
    this.next();
    if (open === "(") { const out = `\\left(${inner}\\right)`; this.lastGroup = [out, inner]; return out; }
    if (open === "[") return `\\left[${inner}\\right]`;
    if (open === "{") return `\\left\\{${inner}\\right\\}`;
    return `\\left|${inner}\\right|`;
  }

  /**
   * `lr(...)`: the argument's raw tokens, with the delimiter at each end (if any) taken as the `\left` and
   * `\right` and the body between them translated on its own. Parens nest; brackets and bars do not, so
   * `lr(] a, b ])` and `lr(( a, b ])` both read. A trailing `size:` argument is dropped.
   */
  lr(): string {
    this.next(); // (
    // Any opener pairs with any closer, as in Typst's own parser; a closer with nothing open is a symbol.
    const toks: Tok[] = [];
    for (let d = 0; ;) {
      const t = this.next();
      if (t.t === "op" && /^[([{]$/.test(t.v)) d++;
      else if (t.t === "op" && /^[)\]}]$/.test(t.v)) { if (d === 0) { if (t.v === ")") break; } else d--; }
      toks.push(t);
    }
    // Named arguments come after the body: cut at the top-level comma that a `word :` follows.
    for (let i = 0, d = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === "op" && /^[([{]$/.test(t.v)) d++;
      else if (t.t === "op" && /^[)\]}]$/.test(t.v)) d = Math.max(0, d - 1);
      else if (d === 0 && t.t === "op" && t.v === ",") {
        let k = i + 1;
        while (toks[k]?.t === "ws") k++;
        if (toks[k]?.t === "word" && toks[k + 1]?.t === "op" && toks[k + 1].v === ":") { toks.length = i; break; }
      }
    }
    const trim = () => { while (toks.length && toks[0].t === "ws") toks.shift(); while (toks.length && toks[toks.length - 1].t === "ws") toks.pop(); };
    const delim = (t: Tok | undefined) => (t ? (t.t === "op" ? LR_OP[t.v] : t.t === "word" ? LR_WORD[t.v] : undefined) ?? null : null);
    trim();
    let open = ".", close = ".";
    if (toks.length > 1 && delim(toks[0])) { open = delim(toks.shift())!; trim(); }
    if (toks.length > 0 && delim(toks[toks.length - 1])) { close = delim(toks.pop())!; trim(); }
    const inner = new Parser(toks, true).seq(() => false).trim();
    return `\\left${open} ${inner} \\right${close}`;
  }

  /** Call arguments split on top-level commas (and semicolons into rows). Named arguments are dropped. */
  args(): string[][] {
    this.next(); // (
    const rows: string[][] = [[]];
    let cur = "";
    for (;;) {
      const t = this.peek();
      if (!t) throw new Error("unclosed");
      if (t.t === "op" && (t.v === "," || t.v === ";" || t.v === ")")) {
        this.i++;
        if (cur.trim()) rows[rows.length - 1].push(cur.trim());
        cur = "";
        if (t.v === ")") break;
        if (t.v === ";") rows.push([]);
        continue;
      }
      // Named argument: word followed by ':' at depth 0 is dropped with its value.
      if (t.t === "word" && this.peek(1)?.t === "op" && this.peek(1)!.v === ":" && !cur.trim()) {
        this.i += 2;
        let d = 0;
        while (this.peek() && !(d === 0 && this.peek()!.t === "op" && /^[,;)]$/.test(this.peek()!.v))) {
          const x = this.next();
          if (x.t === "op" && /^[([{]$/.test(x.v)) d++;
          if (x.t === "op" && /^[)\]}]$/.test(x.v)) d--;
        }
        continue;
      }
      if (t.t === "ws") { this.i++; cur += " "; continue; }
      cur += this.scripted();
    }
    if (!rows[rows.length - 1].length) rows.pop();
    return rows;
  }

  atom(): string {
    const t = this.next();
    if (t.t === "ws") return " ";
    if (t.t === "num") return t.v;
    if (t.t === "str") return `\\text{${t.v.replace(/[\\{}]/g, (c) => `\\${c}`)}}`;
    if (t.t === "op") {
      if (t.v in CLOSE && t.v !== "|") { this.i--; return this.group(t.v); }
      if (t.v === "|") return "|";
      if (t.v in OPS) return OPS[t.v];
      if (t.v === "\\") return "\\\\"; // a lone backslash is Typst's line break
      if (t.v[0] === "\\" && t.v.length === 2) return t.v === "\\$" ? "\\$" : t.v[1] === "\\" ? "\\backslash" : `\\${t.v[1]}`;
      if (t.v === ")" || t.v === "]" || t.v === "}") { if (this.lenient) return t.v === "}" ? "\\}" : t.v; throw new Error("stray closer"); }
      return t.v;
    }
    // word
    const w = t.v;
    const call = this.peek()?.t === "op" && this.peek()!.v === "(";
    if (call) {
      if (w === "frac") { const [a] = this.args(); return `\\frac{${a[0] ?? ""}}{${a[1] ?? ""}}`; }
      if (w === "sqrt") { const [a] = this.args(); return `\\sqrt{${a[0] ?? ""}}`; }
      if (w === "root") { const [a] = this.args(); return `\\sqrt[${a[0] ?? ""}]{${a[1] ?? ""}}`; }
      if (w === "binom") { const [a] = this.args(); return `\\binom{${a[0] ?? ""}}{${a[1] ?? ""}}`; }
      if (w === "text") { const [a] = this.args(); return `\\text{${a.join(", ")}}`; }
      if (w === "op") { const [a] = this.args(); return `\\operatorname{${a.join(", ").replace(/\\text\{([^}]*)\}/g, "$1")}}`; }
      if (w === "limits" || w === "scripts") { const [a] = this.args(); return a[0] ?? ""; }
      if (w in ACCENTS) { const [a] = this.args(); return `${ACCENTS[w]}{${a[0] ?? ""}}`; }
      if (w in STYLES) { const [a] = this.args(); return `${STYLES[w]}{${a.join(" ")}}`; }
      if (w === "lr") return this.lr();
      if (w in WRAPS) { const [a] = this.args(); return `${WRAPS[w][0]} ${a.join(", ")} ${WRAPS[w][1]}`; }
      if (w === "mat") { const rows = this.args(); return `\\begin{pmatrix}${rows.map((r) => r.join(" & ")).join(" \\\\ ")}\\end{pmatrix}`; }
      if (w === "vec") { const [a] = this.args(); return `\\begin{pmatrix}${a.join(" \\\\ ")}\\end{pmatrix}`; }
      if (w === "cases") { const [a] = this.args(); return `\\begin{cases}${a.join(" \\\\ ")}\\end{cases}`; }
      if (w === "underbrace" || w === "overbrace") { const [a] = this.args(); return `\\${w}{${a[0] ?? ""}}${w === "underbrace" ? "_" : "^"}{${a[1] ?? ""}}`; }
      if (w === "attach") { const [a] = this.args(); return a[0] ?? ""; }
      if (FUNCS.includes(w)) { const [a] = this.args(); return `\\${w}\\left(${a.join(", ")}\\right)`; }
      // Unknown function: name in roman, arguments in parentheses.
      const [a] = this.args();
      return `${this.word(w)}\\left(${a.join(", ")}\\right)`;
    }
    return this.word(w);
  }

  word(w: string): string {
    if (w.length === 1) return w;
    if (w in SYMBOLS) return SYMBOLS[w];
    if (GREEK.includes(w)) return `\\${w}`;
    if (FUNCS.includes(w) || BIG.includes(w)) return `\\${w}`;
    if (w === "dot") return "\\cdot";
    // Dotted name we do not know: try the base word.
    const base = w.split(".")[0];
    if (base !== w) return this.word(base);
    return `\\mathrm{${w}}`;
  }
}

/** Translates Typst math to LaTeX, or returns null when the source does not parse. */
export function typstMathToTex(src: string): string | null {
  try {
    const p = new Parser(lex(src.trim()));
    const out = p.seq(() => false);
    if (p.i < p.toks.length) return null;
    return out.replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}
