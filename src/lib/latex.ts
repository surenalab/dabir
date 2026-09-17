// A deliberately small LaTeX reader for the phase-0 visual view.
// It understands enough of a paper to lay it out like a document:
// title/authors/abstract, sectioning, paragraphs, display math, figures,
// citations and references. Everything else is shown as source inline.
// Phase 1 replaces this with a CodeMirror 6 decoration layer.

export type Block =
  | { kind: "title"; text: string }
  | { kind: "authors"; text: string }
  | { kind: "abstract"; inlines: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; number: string; text: string; line: number }
  | { kind: "para"; inlines: Inline[] }
  | { kind: "equation"; tex: string; tag: string }
  | { kind: "figure"; caption: Inline[]; label?: string; file?: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "raw"; tex: string };

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string }
  | { kind: "cite"; keys: string[] }
  | { kind: "ref"; key: string }
  | { kind: "em"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "cmd"; tex: string };

export interface OutlineItem { level: 1 | 2 | 3; number: string; text: string; line: number; /** Set when the outline spans the paper's files. */ file?: string; /** The row's tooltip, where a line number means nothing (a Word heading). */ hint?: string }

const stripComments = (s: string) => s.replace(/(^|[^\\])%.*$/gm, "$1");

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\$([^$]+)\$|\\cite[tp]?\*?\{([^}]*)\}|\\(?:ref|eqref|autoref|Cref|cref)\{([^}]*)\}|\\(emph|textit)\{([^}]*)\}|\\textbf\{([^}]*)\}|\\([a-zA-Z]+\*?)(?:\[[^\]]*\])?(?:\{[^}]*\})?|~|\\\\|---|--|``|''/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    const tok = m[0];
    if (m[1] !== undefined) out.push({ kind: "math", tex: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "cite", keys: m[2].split(",").map((k) => k.trim()) });
    else if (m[3] !== undefined) out.push({ kind: "ref", key: m[3] });
    else if (m[5] !== undefined) out.push({ kind: "em", text: m[5] });
    else if (m[6] !== undefined) out.push({ kind: "bold", text: m[6] });
    else if (tok === "~") out.push({ kind: "text", text: " " });
    else if (tok === "\\\\") out.push({ kind: "text", text: "\n" });
    else if (tok === "---") out.push({ kind: "text", text: "—" });
    else if (tok === "--") out.push({ kind: "text", text: "–" });
    else if (tok === "``") out.push({ kind: "text", text: "“" });
    else if (tok === "''") out.push({ kind: "text", text: "”" });
    else if (m[7] !== undefined) {
      const name = m[7];
      if (name === "label" || name === "vspace" || name === "noindent" || name === "centering") { /* silent */ }
      else if (name === "ldots" || name === "dots") out.push({ kind: "text", text: "…" });
      else out.push({ kind: "cmd", tex: tok });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out.filter((i) => !(i.kind === "text" && i.text === ""));
}

export function parseDocument(source: string): { blocks: Block[]; outline: OutlineItem[] } {
  const text = stripComments(source);
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const outline: OutlineItem[] = [];
  const counters = [0, 0, 0];
  let eqCount = 0;
  let para: string[] = [];
  let inBody = /\\begin\{document\}/.test(text) ? false : true;

  const flush = () => {
    const joined = para.join(" ").trim();
    if (joined) blocks.push({ kind: "para", inlines: parseInline(joined) });
    para = [];
  };

  const meta: { title?: string; authors?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!inBody) {
      const t = /\\title\{(.*)\}/.exec(line);
      const a = /\\author\{(.*)\}/.exec(line);
      if (t) meta.title = t[1];
      if (a) meta.authors = a[1].replace(/\\thanks\{[^}]*\}/g, "").split(/\\and/).map((x) => x.trim()).filter(Boolean).join(", ");
      if (/\\begin\{document\}/.test(line)) {
        inBody = true;
        if (meta.title) blocks.push({ kind: "title", text: meta.title });
        if (meta.authors) blocks.push({ kind: "authors", text: meta.authors });
      }
      continue;
    }
    if (/\\end\{document\}/.test(line)) { flush(); break; }
    if (/\\maketitle/.test(line)) continue;

    if (line === "") { flush(); continue; }

    const sec = /^\\(section|subsection|subsubsection)\*?\{(.*)\}/.exec(line);
    if (sec) {
      flush();
      const level = (sec[1] === "section" ? 1 : sec[1] === "subsection" ? 2 : 3) as 1 | 2 | 3;
      counters[level - 1] += 1;
      for (let l = level; l < 3; l++) counters[l] = 0;
      const number = counters.slice(0, level).join(".");
      blocks.push({ kind: "heading", level, number, text: sec[2], line: i + 1 });
      outline.push({ level, number, text: sec[2], line: i + 1 });
      continue;
    }

    if (/^\\begin\{abstract\}/.test(line)) {
      flush();
      const buf: string[] = [];
      while (++i < lines.length && !/\\end\{abstract\}/.test(lines[i])) buf.push(lines[i]);
      blocks.push({ kind: "abstract", inlines: parseInline(buf.join(" ")) });
      continue;
    }

    const eq = /^\\begin\{(equation|align|gather|multline)\*?\}/.exec(line) || (line === "\\[" ? ["", "display"] : null);
    if (eq) {
      flush();
      const buf: string[] = [];
      const end = eq[1] === "display" ? /^\\\]/ : new RegExp(`\\\\end\\{${eq[1]}\\*?\\}`);
      const starred = /\*\}/.test(line);
      while (++i < lines.length && !end.test(lines[i].trim())) buf.push(lines[i].trim());
      const tag = starred || eq[1] === "display" ? "" : `(${++eqCount})`;
      blocks.push({ kind: "equation", tex: buf.join("\n").replace(/\\label\{[^}]*\}/g, "").trim(), tag });
      continue;
    }

    if (/^\\begin\{figure\*?\}/.test(line)) {
      flush();
      let caption = "", label: string | undefined, file: string | undefined;
      while (++i < lines.length && !/\\end\{figure\*?\}/.test(lines[i])) {
        const c = /\\caption\{(.*)\}/.exec(lines[i]); if (c) caption = c[1];
        const l = /\\label\{([^}]*)\}/.exec(lines[i]); if (l) label = l[1];
        const g = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/.exec(lines[i]); if (g) file = g[1];
      }
      blocks.push({ kind: "figure", caption: parseInline(caption), label, file });
      continue;
    }

    const list = /^\\begin\{(itemize|enumerate)\}/.exec(line);
    if (list) {
      flush();
      const items: Inline[][] = [];
      let cur: string[] | null = null;
      while (++i < lines.length && !new RegExp(`\\\\end\\{${list[1]}\\}`).test(lines[i])) {
        const it = /^\s*\\item\s*(.*)$/.exec(lines[i]);
        if (it) { if (cur) items.push(parseInline(cur.join(" "))); cur = [it[1]]; }
        else if (cur) cur.push(lines[i].trim());
      }
      if (cur) items.push(parseInline(cur.join(" ")));
      blocks.push({ kind: "list", ordered: list[1] === "enumerate", items });
      continue;
    }

    if (/^\\begin\{/.test(line)) {
      flush();
      const env = /^\\begin\{([^}]*)\}/.exec(line)![1];
      const buf = [raw];
      while (++i < lines.length) { buf.push(lines[i]); if (new RegExp(`\\\\end\\{${env.replace("*", "\\*")}\\}`).test(lines[i])) break; }
      blocks.push({ kind: "raw", tex: buf.join("\n") });
      continue;
    }

    if (/^\\(input|include|bibliography|bibliographystyle|newpage|clearpage|appendix|tableofcontents)\b/.test(line)) {
      flush();
      blocks.push({ kind: "raw", tex: line });
      continue;
    }

    para.push(line);
  }
  flush();
  return { blocks, outline };
}

/** Very small tokenizer for the source view: commands, comments, math. */
export function highlightLine(line: string): { cls: "cmd" | "cmt" | "math" | "txt"; text: string }[] {
  const out: { cls: "cmd" | "cmt" | "math" | "txt"; text: string }[] = [];
  const re = /(%.*$)|(\$[^$]*\$)|(\\[a-zA-Z@]+\*?|\\[^a-zA-Z])/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ cls: "txt", text: line.slice(last, m.index) });
    out.push({ cls: m[1] ? "cmt" : m[2] ? "math" : "cmd", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ cls: "txt", text: line.slice(last) });
  return out;
}

/** Minimal BibTeX reader: key → { author surname(s), year }. Enough for "Candès et al. 2006" chips. */
export interface BibEntry { key: string; label: string; title?: string; file?: string; line?: number }
/** Entries of a .bib file by key; `file` (relative to the paper) lets go-to-definition open the entry. */
export function parseBib(src: string, file?: string): Record<string, BibEntry> {
  const out: Record<string, BibEntry> = {};
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  const field = (body: string, name: string) => {
    const f = new RegExp(name + "\\s*=\\s*(\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|\"([^\"]*)\"|(\\d+))", "i").exec(body);
    return f ? (f[2] ?? f[3] ?? f[4] ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim() : undefined;
  };
  while ((m = re.exec(src))) {
    const key = m[2], body = m[3];
    const author = field(body, "author") ?? "";
    const year = field(body, "year") ?? "";
    const names = author.split(/\s+and\s+/).map((n) => {
      const cleaned = n.replace(/\\['`^"~=.]/g, "").replace(/\\[a-z]+/g, "");
      return cleaned.includes(",") ? cleaned.split(",")[0].trim() : cleaned.trim().split(/\s+/).pop() ?? "";
    }).filter(Boolean);
    const etAl = names.length > 2 || names.some((n) => n.toLowerCase() === "others");
    const real = names.filter((n) => n.toLowerCase() !== "others");
    const who = real.length === 0 ? key : etAl ? `${real[0]} et al.` : real.length === 1 ? real[0] : `${real[0]} and ${real[1]}`;
    const line = src.slice(0, m.index).split("\n").length;
    out[key] = { key, label: year ? `${who} ${year}` : who, title: field(body, "title"), file, line };
  }
  return out;
}
