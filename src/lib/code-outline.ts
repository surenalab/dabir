// The outline of a code file for the sidebar: functions, classes, modules and their nesting, read from the
// text with per-language patterns. No language server needed, so it is there the moment a file opens; the
// same shape as the LaTeX outline, so the sidebar shows one or the other without knowing which.

import type { OutlineItem } from "./latex";

interface Rule { re: RegExp; kind: string; name: number; byIndent?: boolean; flags?: string }

// `kind` is the glyph in the outline's number column: ƒ function, C class/struct, M module, I interface/trait, c constant, # heading.
const RULES: Record<string, Rule[]> = {
  py: [
    { re: /^(\s*)(?:async\s+)?def\s+(\w+)/, kind: "ƒ", name: 2, byIndent: true },
    { re: /^(\s*)class\s+(\w+)/, kind: "C", name: 2, byIndent: true },
  ],
  jl: [
    { re: /^(\s*)(?:function|macro)\s+([\w.!]+)/, kind: "ƒ", name: 2, byIndent: true },
    { re: /^(\s*)(?:mutable\s+)?struct\s+(\w+)/, kind: "C", name: 2, byIndent: true },
    { re: /^(\s*)(?:abstract|primitive)\s+type\s+(\w+)/, kind: "C", name: 2, byIndent: true },
    { re: /^(\s*)(?:module|baremodule)\s+(\w+)/, kind: "M", name: 2, byIndent: true },
    { re: /^(\s*)([A-Za-z_][\w!]*)\([^)]*\)\s*(?:::\s*\S+\s*)?=(?!=)/, kind: "ƒ", name: 2, byIndent: true },
  ],
  r: [
    { re: /^(\s*)([\w.]+)\s*(?:<-|=)\s*function\b/, kind: "ƒ", name: 2, byIndent: true },
    { re: /^(\s*)([\w.]+)\s*(?:<-|=)\s*\\\(/, kind: "ƒ", name: 2, byIndent: true },
  ],
  js: [
    { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/, kind: "ƒ", name: 2, byIndent: true },
    { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "C", name: 2, byIndent: true },
    { re: /^(\s*)(?:export\s+)?(?:interface|enum)\s+(\w+)/, kind: "I", name: 2, byIndent: true },
    { re: /^(\s*)(?:export\s+)?type\s+(\w+)\s*(?:<[^=]*)?=/, kind: "I", name: 2, byIndent: true },
    { re: /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::\s*[^=]+)?=>|function\b|\w+\s*=>)/, kind: "ƒ", name: 2, byIndent: true },
    { re: /^(\s{2,})(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, kind: "ƒ", name: 2, byIndent: true },
  ],
  rs: [
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: "ƒ", name: 2, byIndent: true },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+(\w+)/, kind: "C", name: 2, byIndent: true },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: "I", name: 2, byIndent: true },
    { re: /^(\s*)impl(?:<[^>]*>)?\s+(.+?)\s*(?:where\b|\{)/, kind: "C", name: 2, byIndent: true },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, kind: "M", name: 2, byIndent: true },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/, kind: "c", name: 2, byIndent: true },
  ],
  c: [
    { re: /^(\s*)(?:class|struct|union|enum|namespace)\s+(\w+)\s*(?::[^{]*)?\{?\s*$/, kind: "C", name: 2, byIndent: true },
    { re: /^(\s*)(?:template\s*<[^>]*>\s*)?(?:[\w:<>,*&\s]+?)\s+\**(~?\w+(?:::\w+)?)\s*\([^;]*\)?\s*(?:const\s*)?(?:override\s*)?(?:noexcept\s*)?\{?\s*$/, kind: "ƒ", name: 2, byIndent: true },
  ],
  sh: [{ re: /^(\s*)(?:function\s+)?([\w-]+)\s*\(\)\s*\{?/, kind: "ƒ", name: 2, byIndent: true }, { re: /^(\s*)function\s+([\w-]+)/, kind: "ƒ", name: 2, byIndent: true }],
  lua: [{ re: /^(\s*)(?:local\s+)?function\s+([\w.:]+)/, kind: "ƒ", name: 2, byIndent: true }, { re: /^(\s*)(?:local\s+)?([\w.]+)\s*=\s*function\b/, kind: "ƒ", name: 2, byIndent: true }],
  m: [{ re: /^(\s*)function\s+(?:[\w[\],\s]+\s*=\s*)?(\w+)/, kind: "ƒ", name: 2, byIndent: true }, { re: /^(\s*)classdef\s+(\w+)/, kind: "C", name: 2 }],
  f90: [{ re: /^(\s*)(?:(?:pure|elemental|recursive)\s+)*(?:subroutine|function|module|program)\s+(\w+)/i, kind: "ƒ", name: 2, byIndent: true }],
  md: [{ re: /^(#{1,3})\s+(.+?)\s*#*\s*$/, kind: "#", name: 2 }],
  sql: [{ re: /^(\s*)create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, kind: "C", name: 2 }],
};
const ALIAS: Record<string, string> = { pyi: "py", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", h: "c", cc: "c", cpp: "c", cxx: "c", hh: "c", hpp: "c", cu: "c", cuh: "c", bash: "sh", zsh: "sh", f: "f90", f95: "f90", markdown: "md" };

const C_KEYWORDS = /^(if|else|for|while|switch|return|do|case|sizeof|typedef|using|namespace|template|catch|new|delete|throw)$/;

/** Functions, classes and the like in `text`, in file order, nested by indentation (level 1 to 3). */
export function codeOutline(path: string | null, text: string): OutlineItem[] {
  const ext = (path ?? "").split(".").pop()?.toLowerCase() ?? "";
  const lang = ALIAS[ext] ?? ext;
  const rules = RULES[lang];
  if (!rules) return [];
  const commentOpener = lang === "md" ? null : lang === "m" ? /^\s*%/ : lang === "lua" || lang === "sql" ? /^\s*--/ : lang === "f90" ? /^\s*!/ : lang === "js" || lang === "rs" || lang === "c" ? /^\s*\/\// : /^\s*#/;
  const out: OutlineItem[] = [];
  const lines = text.split("\n");
  const stack: number[] = [];   // indentation widths of the enclosing definitions
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || (commentOpener && commentOpener.test(line))) continue;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (!m) continue;
      const name = (m[r.name] ?? "").trim();
      if (!name || (lang === "c" && (C_KEYWORDS.test(name) || /^\s*(return|else)\b/.test(line)))) continue;
      let level: 1 | 2 | 3 = 1;
      if (r.kind === "#") level = Math.min(3, m[1].length) as 1 | 2 | 3;
      else if (r.byIndent) {
        const indent = m[1].replace(/\t/g, "    ").length;
        while (stack.length && stack[stack.length - 1] >= indent) stack.pop();
        level = Math.min(3, stack.length + 1) as 1 | 2 | 3;
        stack.push(indent);
      }
      out.push({ level, number: r.kind, text: name.length > 60 ? name.slice(0, 57) + "…" : name, line: i + 1 });
      break;
    }
  }
  return out;
}
