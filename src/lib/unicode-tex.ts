// Text pasted from a word processor or a web page arrives with curly quotes, real dashes, an
// ellipsis, × and ≤ and Greek letters. LaTeX wants its own spellings for those. This converts
// them, in maths or out of it: α becomes \alpha inside $…$ and $\alpha$ in prose. Accented
// letters stay, since every current engine reads UTF-8 and \'e is harder to read than é.

/** Symbols that are maths: bare inside maths, wrapped in `$…$` in prose. */
const MATH: Record<string, string> = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\varepsilon", "ϵ": "\\epsilon", "ζ": "\\zeta", "η": "\\eta", "θ": "\\theta", "ϑ": "\\vartheta",
  "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu", "ν": "\\nu", "ξ": "\\xi", "π": "\\pi", "ρ": "\\rho", "σ": "\\sigma", "ς": "\\varsigma", "τ": "\\tau",
  "υ": "\\upsilon", "φ": "\\varphi", "ϕ": "\\phi", "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega",
  "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda", "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Υ": "\\Upsilon", "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
  "×": "\\times", "÷": "\\div", "±": "\\pm", "∓": "\\mp", "·": "\\cdot", "∘": "\\circ", "√": "\\sqrt", "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "≃": "\\simeq", "≅": "\\cong", "∝": "\\propto", "≪": "\\ll", "≫": "\\gg",
  "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↦": "\\mapsto",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊆": "\\subseteq", "⊃": "\\supset", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset",
  "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee", "⊕": "\\oplus", "⊗": "\\otimes", "⊥": "\\perp", "∥": "\\parallel", "∠": "\\angle",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∮": "\\oint", "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}",
  "ℓ": "\\ell", "ℏ": "\\hbar", "°": "^\\circ", "′": "'", "″": "''",
  "½": "\\tfrac{1}{2}", "⅓": "\\tfrac{1}{3}", "¼": "\\tfrac{1}{4}", "¾": "\\tfrac{3}{4}",
};

/** Typography that is text: the same in and out of maths, except the quotes which maths never wants changed. */
const TEXT: Record<string, string> = {
  "\u201c": "``", "\u201d": "''", "\u2018": "`", "\u2019": "'", "\u201e": ",,", "\u00ab": "\\guillemotleft{}", "\u00bb": "\\guillemotright{}",
  "\u2013": "--", "\u2014": "---", "\u2026": "\\ldots{}", "\u00a0": "~", "\u202f": "\\,", "\u2009": "\\,", "\u2212": "-",
  "\u00a7": "\\S{}", "\u00b6": "\\P{}", "\u2020": "\\dag{}", "\u2021": "\\ddag{}", "\u2022": "\\textbullet{}", "\u00a9": "\\copyright{}", "\u00ae": "\\textregistered{}", "\u2122": "\\texttrademark{}",
  "\u20ac": "\\euro{}", "\u00a3": "\\pounds{}", "\u00a5": "\\textyen{}", "\u00b5": "\\textmu{}", "\u2030": "\\textperthousand{}", "\u00bf": "?`", "\u00a1": "!`",
};
/** Superscript and subscript characters: the script they belong to and the plain character. */
const SCRIPTS: Record<string, [string, string]> = {};
for (const [i, ch] of [..."⁰¹²³⁴⁵⁶⁷⁸⁹"].entries()) SCRIPTS[ch] = ["^", String(i)];
for (const [i, ch] of [..."₀₁₂₃₄₅₆₇₈₉"].entries()) SCRIPTS[ch] = ["_", String(i)];
Object.assign(SCRIPTS, { "⁺": ["^", "+"], "⁻": ["^", "-"], "₊": ["_", "+"], "₋": ["_", "-"], "ⁿ": ["^", "n"], "ᵢ": ["_", "i"], "ⱼ": ["_", "j"] });
const QUOTES = new Set(["\u201c", "\u201d", "\u2018", "\u2019", "\u201e"]);
const MATH_ENVS = /^(equation|align|alignat|gather|multline|eqnarray|displaymath|math|flalign|split|cases|array|matrix|pmatrix|bmatrix|IEEEeqnarray)\*?$/;

export interface Conversion { text: string; count: number }

/** `text` with every symbol LaTeX has a name for rewritten; `count` says how many. Maths mode is tracked
 *  across `$…$`, `\(…\)`, `\[…\]` and the maths environments, so a Greek letter in an equation stays bare. */
export function unicodeToTex(text: string): Conversion {
  let out = "", count = 0, math = false, display = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === "\\") {
      const rest = text.slice(i, i + 40);
      const env = /^\\(begin|end)\{([^}]*)\}/.exec(rest);
      if (env) { if (MATH_ENVS.test(env[2])) math = env[1] === "begin"; out += env[0]; i += env[0].length - 1; continue; }
      if (rest.startsWith("\\(") || rest.startsWith("\\[")) { math = true; out += rest.slice(0, 2); i++; continue; }
      if (rest.startsWith("\\)") || rest.startsWith("\\]")) { math = false; out += rest.slice(0, 2); i++; continue; }
      out += c + (text[i + 1] ?? ""); i++; continue;   // an escaped character, never converted
    }
    if (c === "%") { const j = text.indexOf("\n", i); const end = j < 0 ? n : j; out += text.slice(i, end); i = end - 1; continue; }
    if (c === "$") {
      if (text[i + 1] === "$") { display = !display; math = display; out += "$$"; i++; continue; }
      if (!display) math = !math;
      out += c; continue;
    }
    // Runs of superscript or subscript characters become one script: 10⁻³ is 10^{-3}.
    const script = SCRIPTS[c];
    if (script) {
      let j = i, body = "";
      while (j < n && SCRIPTS[text[j]]?.[0] === script[0]) { body += SCRIPTS[text[j]][1]; j++; }
      count += j - i; i = j - 1;
      const tex = `${script[0]}{${body}}`;
      out += math ? tex : `$${tex}$`;
      continue;
    }
    const m = MATH[c];
    if (m !== undefined) {
      count++;
      const next = text[i + 1] ?? "";
      const spaced = /^\\[a-zA-Z]+$/.test(m) && /[a-zA-Z]/.test(next) ? " " : "";   // \alpha x, not \alphax
      out += math ? m + spaced : `$${m}$`;
      continue;
    }
    const t = TEXT[c];
    if (t !== undefined && !(math && QUOTES.has(c))) {
      count++;
      const next = text[i + 1] ?? "";
      // `` before another quote needs a break so TeX does not read ``` as a triple
      if (t === "``" && next === "\u201c") out += "``{}";
      else if (t === "''" && next === "\u201d") out += "''{}";
      else out += t;
      continue;
    }
    out += c;
  }
  return { text: out, count };
}
