import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Bold, Italic, Code2, List, ListOrdered, Sigma, Image, Table2, Quote, Link2, MessageSquare, Undo2, Redo2, Search, Hash, Heading1, Heading2, Heading3, Pilcrow, MoreHorizontal, Type, AlignLeft } from "lucide-react";
import type { EditorApi } from "./SourceEditor";

interface Item { id: string; label: string; icon: ReactNode; run: () => void; key?: string; disabled?: boolean }
interface Group { id: string; drop: number; items: Item[] } // higher `drop` leaves the bar first when space runs out

const STYLES: [string, string, ReactNode][] = [["section", "Section", <Heading1 />], ["subsection", "Subsection", <Heading2 />], ["subsubsection", "Subsubsection", <Heading3 />], ["paragraph", "Run-in heading", <Type />], ["plain", "Plain paragraph", <AlignLeft />]];

/** Word-style formatting bar. Every action edits the LaTeX source through the editor API.
 *  When the window is squeezed, whole groups move into a More menu instead of clipping or scrolling. */
export function FormatBar({ api, onFind, onComment, canComment }: { api: EditorApi | null; onFind: () => void; onComment: () => void; canComment: boolean }) {
  const off = !api;
  const groups: Group[] = [
    { id: "history", drop: 0, items: [
      { id: "undo", label: "Undo", icon: <Undo2 />, run: () => api?.undo(), key: "⌘Z" },
      { id: "redo", label: "Redo", icon: <Redo2 />, run: () => api?.redo(), key: "⇧⌘Z" },
    ] },
    { id: "style", drop: 3, items: STYLES.map(([v, label, icon]) => ({ id: `style-${v}`, label, icon, run: () => api?.heading(v) })) },
    { id: "inline", drop: 1, items: [
      { id: "bold", label: "Bold", icon: <Bold />, run: () => api?.wrap("\\textbf{", "}"), key: "⇧⌘B" },
      { id: "italic", label: "Italic", icon: <Italic />, run: () => api?.wrap("\\textit{", "}"), key: "⇧⌘I" },
      { id: "emph", label: "Emphasis", icon: <Pilcrow />, run: () => api?.wrap("\\emph{", "}"), key: "⇧⌘E" },
      { id: "code", label: "Code", icon: <Code2 />, run: () => api?.wrap("\\texttt{", "}") },
    ] },
    { id: "lists", drop: 4, items: [
      { id: "itemize", label: "Bulleted list", icon: <List />, run: () => api?.list("itemize") },
      { id: "enumerate", label: "Numbered list", icon: <ListOrdered />, run: () => api?.list("enumerate") },
    ] },
    { id: "blocks", drop: 2, items: [
      { id: "math", label: "Inline math", icon: <Sigma />, run: () => api?.wrap("$", "$"), key: "⇧⌘M" },
      { id: "equation", label: "Equation", icon: <Hash />, run: () => api?.block("\\begin{equation}\n  ", "\n  \\label{eq:}\n\\end{equation}") },
      { id: "figure", label: "Figure", icon: <Image />, run: () => api?.block("\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{", "}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}") },
      { id: "table", label: "Table", icon: <Table2 />, run: () => api?.block("\\begin{table}[t]\n  \\caption{}\n  \\label{tab:}\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    ", " & & \\\\\n    \\midrule\n     & & \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}") },
    ] },
    { id: "refs", drop: 5, items: [
      { id: "cite", label: "Citation", icon: <Quote />, run: () => api?.complete("\\cite{", "}"), key: "⇧⌘C" },
      { id: "ref", label: "Cross-reference", icon: <Hash />, run: () => api?.complete("\\ref{", "}"), key: "⇧⌘R" },
      { id: "link", label: "Link", icon: <Link2 />, run: () => api?.wrap("\\href{https://}{", "}"), key: "⌘K" },
      { id: "footnote", label: "Footnote", icon: <Type />, run: () => api?.wrap("\\footnote{", "}") },
    ] },
    { id: "tools", drop: 6, items: [
      { id: "find", label: "Find", icon: <Search />, run: onFind, key: "⌘F" },
      { id: "comment", label: "Comment on the selection", icon: <MessageSquare />, run: onComment, disabled: !canComment },
    ] },
  ];

  const bar = useRef<HTMLDivElement>(null);
  const widths = useRef<Record<string, number>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    const measure = () => {
      el.querySelectorAll<HTMLElement>("[data-group]").forEach((g) => { widths.current[g.dataset.group!] = g.offsetWidth + 2; });
      const avail = el.clientWidth - 24 - 36;
      let total = groups.reduce((s, g) => s + (widths.current[g.id] ?? 0), 0);
      const drop: string[] = [];
      for (const g of [...groups].sort((a, b) => b.drop - a.drop)) {
        if (total <= avail || g.drop === 0) continue;
        drop.push(g.id); total -= widths.current[g.id] ?? 0;
      }
      setHidden((prev) => (prev.length === drop.length && prev.every((x) => drop.includes(x)) ? prev : drop));
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [open]);

  const button = (it: Item) => (
    <button key={it.id} className="fb" onClick={it.run} disabled={off || it.disabled} title={it.key ? `${it.label} (${it.key})` : it.label} aria-label={it.label}>{it.icon}</button>
  );
  const visible = groups.filter((g) => !hidden.includes(g.id));
  const overflow = groups.filter((g) => hidden.includes(g.id));

  return (
    <div className={`formatbar ${hidden.length ? "compact" : ""}`} role="toolbar" aria-label="Formatting" ref={bar}>
      {visible.map((g) => (
        <div className="group" data-group={g.id} key={g.id}>
          {g.id === "style" ? (
            <select className="fb-select" disabled={off} value="" onChange={(e) => { const v = e.target.value; if (v) api?.heading(v); e.target.value = ""; }} aria-label="Paragraph style" title="Paragraph style">
              <option value="">Style</option>
              {STYLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          ) : g.items.map(button)}
        </div>
      ))}
      {overflow.length > 0 && (
        <div className="group more">
          <button className="fb" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="More formatting" aria-label="More formatting"><MoreHorizontal /></button>
          {open && (
            <div className="fb-menu" role="menu">
              {overflow.map((g, i) => (
                <div key={g.id} className="fb-menu-group" role="group" aria-label={g.id}>
                  {i > 0 && <div className="fb-menu-sep" />}
                  {g.items.map((it) => (
                    <button key={it.id} role="menuitem" className="fb-menu-item" disabled={off || it.disabled} onClick={() => { setOpen(false); it.run(); }}>
                      <span className="fb-menu-icon">{it.icon}</span><span>{it.label}</span>{it.key && <kbd>{it.key}</kbd>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <span className="fb-spacer" />
      <span className="fb-hint" title="Headings, math, figures and citations render in place in the Visual view; the source stays plain LaTeX.">Writes LaTeX</span>
    </div>
  );
}
