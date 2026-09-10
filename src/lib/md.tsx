// The small subset of Markdown agents write in their replies, rendered as the app's own text:
// paragraphs, headings, bullet and numbered lists, fenced code, and inline bold, italic and code.
// No HTML is interpreted; everything is text nodes, so a reply cannot inject markup.
import type { ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) out.push(<code key={`${key}-${n++}`}>{s.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<b key={`${key}-${n++}`}>{s.slice(2, -2)}</b>);
    else out.push(<i key={`${key}-${n++}`}>{s.slice(1, -1)}</i>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0, k = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push(<p key={k++}>{inline(para.join(" ").trim(), `p${k}`)}</p>); para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(<pre key={k++}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(l);
    if (h) { flush(); out.push(<p key={k++} className="h">{inline(h[1].trim(), `h${k}`)}</p>); i++; continue; }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(l);
    if (li) {
      flush();
      const ordered = /^\s*\d/.test(l);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push(m[1]);
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;  // wrapped item
        else break;
        i++;
      }
      const nodes = items.map((t, j) => <li key={j}>{inline(t, `l${k}${j}`)}</li>);
      out.push(ordered ? <ol key={k++}>{nodes}</ol> : <ul key={k++}>{nodes}</ul>);
      continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim());
    i++;
  }
  flush();
  return out;
}
