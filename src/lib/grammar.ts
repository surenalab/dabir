// Grammar checking through a LanguageTool server. Off by default: the text leaves the
// machine. LaTeX markup is stripped before sending and every match is mapped back to
// source positions through an offset table, so underlines land on the right words.

export interface GrammarMatch { from: number; to: number; message: string; short: string; replacements: string[]; rule: string; category: string }

interface Plain { text: string; map: number[] } // map[i] = source offset of plain char i

/** Turn a LaTeX slice into prose with a char-by-char map back to the source. */
export function toPlain(src: string): Plain {
  const text: string[] = [];
  const map: number[] = [];
  let i = 0;
  const push = (ch: string, at: number) => { text.push(ch); map.push(at); };
  while (i < src.length) {
    const c = src[i];
    if (c === "%") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "$") {
      const j = src.indexOf("$", i + 1);
      if (j < 0) break;
      push("X", i); i = j + 1; continue;
    }
    if (c === "\\") {
      const m = /^\\([a-zA-Z]+\*?)(\[[^\]]*\])?/.exec(src.slice(i));
      if (!m) { i += 2; continue; }
      const name = m[1];
      i += m[0].length;
      const keepArg = ["emph", "textbf", "textit", "texttt", "section", "subsection", "subsubsection", "caption", "title", "footnote", "paragraph"].includes(name);
      const dropArg = ["cite", "citep", "citet", "ref", "eqref", "label", "includegraphics", "input", "include", "usepackage", "documentclass", "bibliography", "bibliographystyle", "begin", "end", "autoref", "cref"].includes(name);
      if (src[i] === "{") {
        if (keepArg) { i++; continue; } // fall through: the content is prose
        { // every other argument is dropped: it is a key, a path or a length, not prose
          let depth = 0; const start = i;
          while (i < src.length) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } i++; }
          if (dropArg && /cite|ref/.test(name)) push("X", start);
          continue;
        }
      }
      continue;
    }
    if (c === "{" || c === "}") { i++; continue; }
    if (c === "~") { push(" ", i); i++; continue; }
    if (c === "\n" && src[i + 1] === "\n") { push("\n", i); push("\n", i + 1); i += 2; continue; }
    if (c === "\n") { push(" ", i); i++; continue; }
    push(c, i); i++;
  }
  return { text: text.join(""), map };
}

export async function checkGrammar(server: string, language: string, src: string, baseOffset: number): Promise<GrammarMatch[]> {
  const plain = toPlain(src);
  if (!plain.text.trim()) return [];
  const body = new URLSearchParams({ text: plain.text, language: language || "auto", enabledOnly: "false" });
  const res = await fetch(`${server.replace(/\/$/, "")}/v2/check`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`LanguageTool answered ${res.status}. Check the server URL in Settings.`);
  const json = await res.json() as { matches: { offset: number; length: number; message: string; shortMessage: string; replacements: { value: string }[]; rule: { id: string; category: { id: string } } }[] };
  const out: GrammarMatch[] = [];
  for (const m of json.matches) {
    const a = plain.map[m.offset], b = plain.map[Math.min(plain.map.length - 1, m.offset + m.length - 1)];
    if (a == null || b == null) continue;
    out.push({ from: baseOffset + a, to: baseOffset + b + 1, message: m.message, short: m.shortMessage || m.rule.category.id, replacements: m.replacements.slice(0, 5).map((r) => r.value), rule: m.rule.id, category: m.rule.category.id });
  }
  return out;
}
