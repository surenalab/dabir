// Project-aware completions: citation keys, labels, and file paths inside the
// commands that take them. The LaTeX language package covers commands and snippets.

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { BibEntry } from "./latex";
import type { Entry } from "./backend";

export interface CompletionSources {
  bib: () => Record<string, BibEntry>;
  labels: () => { label: string; line: number }[];
  files: () => Entry[];
}

const CITE = /\\(?:cite[tp]?\*?|citeauthor|citeyear|parencite|textcite|autocite)\{([^}]*?)$/;
const REF = /\\(?:ref|eqref|autoref|cref|Cref|pageref)\{([^}]*?)$/;
const FILE = /\\(?:input|include|includegraphics(?:\[[^\]]*\])?|bibliography|lstinputlisting)\{([^}]*?)$/;

export function collectLabels(source: string): { label: string; line: number }[] {
  const out: { label: string; line: number }[] = [];
  source.split("\n").forEach((l, i) => {
    const re = /\\label\{([^}]+)\}/g; let m: RegExpExecArray | null;
    while ((m = re.exec(l))) out.push({ label: m[1], line: i + 1 });
  });
  return out;
}

function flatten(entries: Entry[], acc: string[] = [], root?: string): string[] {
  for (const e of entries) {
    if (e.kind === "dir") flatten(e.children, acc, root ?? e.path.slice(0, e.path.length - e.name.length));
    else acc.push(root ? e.path.replace(root, "") : e.name);
  }
  return acc;
}

export function projectCompletions(src: CompletionSources) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 200), ctx.pos);
    let m: RegExpExecArray | null;
    if ((m = CITE.exec(before))) {
      const typed = m[1].split(",").pop()!.trim();
      const from = ctx.pos - typed.length;
      const bib = src.bib();
      const options = Object.values(bib).map((e) => ({ label: e.key, detail: e.label, info: e.title, type: "constant" as const }));
      return { from, options, validFor: /^[\w:\-.]*$/ };
    }
    if ((m = REF.exec(before))) {
      const typed = m[1];
      const from = ctx.pos - typed.length;
      const options = src.labels().map((l) => ({ label: l.label, detail: `line ${l.line}`, type: "variable" as const }));
      return { from, options, validFor: /^[\w:\-.]*$/ };
    }
    if ((m = FILE.exec(before))) {
      const typed = m[1];
      const from = ctx.pos - typed.length;
      const wantsGraphics = /includegraphics/.test(m[0]);
      const files = flatten(src.files()).filter((f) => (wantsGraphics ? /\.(pdf|png|jpe?g|eps|svg)$/i.test(f) : /\.(tex|bib|txt|py)$/i.test(f)));
      const options = files.map((f) => ({ label: f.replace(/\.tex$/, ""), detail: f.split("/").pop(), type: "text" as const }));
      return { from, options, validFor: /^[\w/.\-]*$/ };
    }
    return null;
  };
}
