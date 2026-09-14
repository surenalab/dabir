// Which language a file in the paper's folder is edited as. The manuscript is LaTeX or Typst; the code
// that made the figures is Python, Julia, R or shell; the rest is configuration and notes. One editor,
// one theme, one set of keys: only the grammar and the LaTeX-specific helpers change with the file.

import { StreamLanguage, Language, LanguageSupport, languageDataProp, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { typstParser, typstLanguageData, typstLezerHighlighting, typstLezerIndentation, typstLezerFolding, typstLezerIndentService, typstLezerListKeymap, typstLezerFoldService, typstLezerLinter, typstTags } from "codemirror-lang-typst/lezer";
import type { Extension } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { r } from "@codemirror/legacy-modes/mode/r";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { sql } from "@codemirror/legacy-modes/mode/sql";
import { javascript } from "@codemirror/lang-javascript";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";

export type FileKind = "tex" | "typst" | "bib" | "code" | "notebook" | "prose" | "data" | "text";

/** What kind of file a path names, by extension; null and unknown extensions are plain text. */
export function fileKind(path: string | null): FileKind {
  const ext = (path ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (["tex", "sty", "cls", "ltx", "dtx", "bbx", "cbx"].includes(ext)) return "tex";
  if (ext === "typ") return "typst";
  if (ext === "bib") return "bib";
  if (ext === "ipynb") return "notebook";
  if (["py", "pyi", "jl", "r", "sh", "bash", "zsh", "m", "js", "jsx", "mjs", "cjs", "ts", "tsx", "rs", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "cu", "cuh", "f", "f90", "f95", "lua", "sql", "css", "html", "htm", "svelte", "vue"].includes(ext)) return "code";
  if (["cmake", "dockerfile"].includes(ext) || /(^|\/)(CMakeLists\.txt|Dockerfile|Makefile)$/.test(path ?? "")) return "code";
  if (["md", "markdown", "txt", "rst"].includes(ext)) return "prose";
  if (["yml", "yaml", "json", "toml", "csv", "tsv", "cfg", "ini"].includes(ext)) return "data";
  return "text";
}

/** True when the file is manuscript, so LaTeX completion, `$` pairing and the paper linter apply. */
export const isManuscript = (path: string | null) => { const k = fileKind(path); return k === "tex" || k === "bib" || k === "typst"; };

/** True when the file carries prose worth spell-checking. */
export const hasProse = (path: string | null) => { const k = fileKind(path); return k === "tex" || k === "typst" || k === "prose"; };

/** The grammar for a non-LaTeX file; null when the file should keep the LaTeX language (tex, bib, sty). */
export function codeLanguage(path: string | null): LanguageSupport | Extension | null {
  const name = (path ?? "").split("/").pop() ?? "";
  if (name === "CMakeLists.txt") return StreamLanguage.define(cmake);
  if (name === "Dockerfile") return StreamLanguage.define(dockerFile);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "py": case "pyi": return python();
    case "js": case "mjs": case "cjs": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "ts": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "c": case "h": case "cc": case "cpp": case "cxx": case "hh": case "hpp": case "cu": case "cuh": return cpp();
    case "rs": return rust();
    case "css": return css();
    case "html": case "htm": case "svelte": case "vue": return html();
    case "m": return StreamLanguage.define(octave);
    case "f": case "f90": case "f95": return StreamLanguage.define(fortran);
    case "lua": return StreamLanguage.define(lua);
    case "sql": return StreamLanguage.define(sql({}));
    case "cmake": return StreamLanguage.define(cmake);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    case "md": case "markdown": return markdown();
    case "yml": case "yaml": return yaml();
    case "json": return json();
    case "jl": return StreamLanguage.define(julia);
    case "r": return StreamLanguage.define(r);
    case "sh": case "bash": case "zsh": return StreamLanguage.define(shell);
    case "toml": return StreamLanguage.define(toml);
    default: return null;
  }
}

// ---- Typst source grammar: the Lezer parser from codemirror-lang-typst without the package's own colours,
// so Typst source is set in the same palette as LaTeX and the code files.

/** Typst-specific tags mapped onto the manuscript palette. */
export const typstHighlight = HighlightStyle.define([
  { tag: tags.heading, class: "tok-env tok-heading" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.emphasis, class: "tok-em" },
  { tag: [typstTags.mathDelimiter, tags.escape], class: "tok-math" },
  { tag: [typstTags.listMarker, typstTags.interpolated, tags.propertyName], class: "tok-cmd" },
  { tag: [tags.bool, tags.null, tags.atom], class: "tok-num" },
  { tag: tags.labelName, class: "tok-env" },
  { tag: [tags.monospace], class: "tok-str" },
]);

export function typstLanguage(): LanguageSupport {
  const parser = typstParser.configure({ props: [languageDataProp.add((type) => (type.isTop ? typstLanguageData : undefined)), typstLezerHighlighting, typstLezerIndentation, typstLezerFolding] });
  return new LanguageSupport(new Language(typstLanguageData, parser, [], "typst"), [typstLezerIndentService, typstLezerListKeymap, typstLezerFoldService, typstLezerLinter]);
}
