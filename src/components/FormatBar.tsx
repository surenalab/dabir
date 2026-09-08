import { Bold, Italic, Code2, List, ListOrdered, Sigma, Image, Table2, Quote, Link2, MessageSquare, Undo2, Redo2, Search, Hash, Heading1, Heading2, Heading3, Pilcrow } from "lucide-react";
import type { EditorApi } from "./SourceEditor";

/** Word-style formatting bar. Every action edits the LaTeX source through the editor API. */
export function FormatBar({ api, onFind, onComment, canComment }: { api: EditorApi | null; onFind: () => void; onComment: () => void; canComment: boolean }) {
  const off = !api;
  const b = (label: string, icon: React.ReactNode, run: () => void, key?: string, extra?: string) => (
    <button className={`fb ${extra ?? ""}`} onClick={run} disabled={off} title={key ? `${label} (${key})` : label} aria-label={label}>{icon}</button>
  );
  return (
    <div className="formatbar" role="toolbar" aria-label="Formatting">
      <div className="group">
        {b("Undo", <Undo2 />, () => api?.undo(), "⌘Z")}
        {b("Redo", <Redo2 />, () => api?.redo(), "⇧⌘Z")}
      </div>
      <div className="group">
        <select className="fb-select" disabled={off} value="" onChange={(e) => { const v = e.target.value; if (v) api?.heading(v); e.target.value = ""; }} aria-label="Paragraph style" title="Paragraph style">
          <option value="">Style</option>
          <option value="section">Section</option>
          <option value="subsection">Subsection</option>
          <option value="subsubsection">Subsubsection</option>
          <option value="paragraph">Run-in heading</option>
          <option value="plain">Plain paragraph</option>
        </select>
      </div>
      <div className="group">
        {b("Bold", <Bold />, () => api?.wrap("\\textbf{", "}"), "⇧⌘B")}
        {b("Italic", <Italic />, () => api?.wrap("\\textit{", "}"), "⇧⌘I")}
        {b("Emphasis", <Pilcrow />, () => api?.wrap("\\emph{", "}"), "⇧⌘E")}
        {b("Code", <Code2 />, () => api?.wrap("\\texttt{", "}"))}
      </div>
      <div className="group">
        {b("Bulleted list", <List />, () => api?.list("itemize"))}
        {b("Numbered list", <ListOrdered />, () => api?.list("enumerate"))}
      </div>
      <div className="group">
        {b("Inline math", <Sigma />, () => api?.wrap("$", "$"), "⇧⌘M")}
        {b("Equation", <Hash />, () => api?.block("\\begin{equation}\n  ", "\n  \\label{eq:}\n\\end{equation}"))}
        {b("Figure", <Image />, () => api?.block("\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{", "}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}"))}
        {b("Table", <Table2 />, () => api?.block("\\begin{table}[t]\n  \\caption{}\n  \\label{tab:}\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    ", " & & \\\\\n    \\midrule\n     & & \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}"))}
      </div>
      <div className="group">
        {b("Citation", <Quote />, () => api?.complete("\\cite{", "}"), "⇧⌘C")}
        {b("Cross-reference", <Heading2 />, () => api?.complete("\\ref{", "}"), "⇧⌘R")}
        {b("Link", <Link2 />, () => api?.wrap("\\href{https://}{", "}"), "⌘K")}
        {b("Footnote", <Heading3 />, () => api?.wrap("\\footnote{", "}"))}
      </div>
      <div className="group">
        {b("Find", <Search />, onFind, "⌘F")}
        <button className="fb" onClick={onComment} disabled={!canComment} title="Comment on the selection" aria-label="Comment on the selection"><MessageSquare /></button>
      </div>
      <span className="fb-spacer" />
      <span className="fb-hint" title="Headings, math, figures and citations render in place in the Visual view; the source stays plain LaTeX."><Heading1 /> Writes LaTeX</span>
    </div>
  );
}
