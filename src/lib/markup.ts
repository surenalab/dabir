// What the formatting actions write, per manuscript language. The bar and the Format menu name the
// intent (bold, figure, citation); the open file decides between LaTeX and Typst markup.

export type FormatAction = "bold" | "italic" | "emph" | "code" | "math" | "equation" | "figure" | "table" | "cite" | "ref" | "link" | "footnote";
export type ManuscriptLang = "tex" | "typst";

/** `wrap` surrounds the selection; `block` goes on its own lines; `complete` inserts and opens completion inside. */
export interface MarkupOp { kind: "wrap" | "block" | "complete"; pre: string; post: string }

const TEX: Record<FormatAction, MarkupOp> = {
  bold: { kind: "wrap", pre: "\\textbf{", post: "}" },
  italic: { kind: "wrap", pre: "\\textit{", post: "}" },
  emph: { kind: "wrap", pre: "\\emph{", post: "}" },
  code: { kind: "wrap", pre: "\\texttt{", post: "}" },
  math: { kind: "wrap", pre: "$", post: "$" },
  equation: { kind: "block", pre: "\\begin{equation}\n  ", post: "\n  \\label{eq:}\n\\end{equation}" },
  figure: { kind: "block", pre: "\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{", post: "}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}" },
  table: { kind: "block", pre: "\\begin{table}[t]\n  \\caption{}\n  \\label{tab:}\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    ", post: " & & \\\\\n    \\midrule\n     & & \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}" },
  cite: { kind: "complete", pre: "\\cite{", post: "}" },
  ref: { kind: "complete", pre: "\\ref{", post: "}" },
  link: { kind: "wrap", pre: "\\href{https://}{", post: "}" },
  footnote: { kind: "wrap", pre: "\\footnote{", post: "}" },
};

const TYPST: Record<FormatAction, MarkupOp> = {
  bold: { kind: "wrap", pre: "*", post: "*" },
  italic: { kind: "wrap", pre: "_", post: "_" },
  emph: { kind: "wrap", pre: "_", post: "_" },
  code: { kind: "wrap", pre: "`", post: "`" },
  math: { kind: "wrap", pre: "$", post: "$" },
  equation: { kind: "block", pre: "$ ", post: " $ <eq:>" },
  figure: { kind: "block", pre: "#figure(\n  image(\"", post: "\", width: 80%),\n  caption: [],\n) <fig:>" },
  table: { kind: "block", pre: "#figure(\n  table(\n    columns: 3,\n    table.header([], [], []),\n    [", post: "], [], [],\n  ),\n  caption: [],\n) <tab:>" },
  cite: { kind: "complete", pre: "@", post: "" },
  ref: { kind: "complete", pre: "@", post: "" },
  link: { kind: "wrap", pre: "#link(\"https://\")[", post: "]" },
  footnote: { kind: "wrap", pre: "#footnote[", post: "]" },
};

export function markup(lang: ManuscriptLang, action: FormatAction): MarkupOp {
  return (lang === "typst" ? TYPST : TEX)[action];
}

/** A heading line for `kind` (section, subsection, subsubsection, paragraph, plain) around `body`. */
export function headingLine(lang: ManuscriptLang, kind: string, body: string): { text: string; caret: number } {
  if (lang === "typst") {
    const marks: Record<string, string> = { section: "= ", subsection: "== ", subsubsection: "=== ", paragraph: "*" };
    if (kind === "plain") return { text: body, caret: body.length };
    if (kind === "paragraph") { const t = `*${body}.*`; return { text: t, caret: t.length - 2 }; }
    const t = `${marks[kind] ?? "= "}${body}`;
    return { text: t, caret: t.length };
  }
  if (kind === "plain") return { text: body, caret: body.length };
  const t = `\\${kind}{${body}}`;
  return { text: t, caret: t.length - 1 };
}

/** The plain title of a heading line, whichever markup it carries. */
export function headingBody(lang: ManuscriptLang, line: string): string {
  if (lang === "typst") {
    const m = /^\s*=+\s*(.*?)\s*(<[^>]*>)?\s*$/.exec(line);
    if (m) return m[1];
    const run = /^\s*\*(.*?)\.?\*\s*$/.exec(line);
    return run ? run[1] : line.trim();
  }
  const m = /^\s*\\(section|subsection|subsubsection|paragraph)\*?\{(.*)\}\s*$/.exec(line);
  return m ? m[2] : line.trim();
}

/** A list from the selected lines (or an empty first item); returns the text and where the caret goes. */
export function listBlock(lang: ManuscriptLang, env: "itemize" | "enumerate", selection: string): { text: string; caret: number } {
  const lines = selection.split("\n").filter((l) => l.trim());
  if (lang === "typst") {
    const mark = env === "itemize" ? "- " : "+ ";
    const items = lines.length ? lines.map((l) => `${mark}${l.trim()}`).join("\n") : mark;
    return { text: `${items}\n`, caret: mark.length };
  }
  const items = lines.length ? lines.map((l) => `  \\item ${l.trim()}`).join("\n") : "  \\item ";
  const head = `\\begin{${env}}\n`;
  return { text: `${head}${items}\n\\end{${env}}\n`, caret: head.length + "  \\item ".length };
}
