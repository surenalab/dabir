import { Fragment, useEffect, useMemo, useRef } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import { highlightLine, parseDocument, type Block, type Inline } from "../lib/latex";
import type { ViewMode } from "./Toolbar";

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((it, i) => {
        switch (it.kind) {
          case "text": return <Fragment key={i}>{it.text}</Fragment>;
          case "math": return <i key={i}>{it.tex}</i>;
          case "em": return <em key={i}>{it.text}</em>;
          case "bold": return <b key={i}>{it.text}</b>;
          case "cite": return <span key={i} className="cite" title={it.keys.join(", ")}>{it.keys.map((k) => k.split(/(?=\d)/)[0]).join(", ")}</span>;
          case "ref": return <span key={i} className="ref" title={it.key}>{it.key.replace(/^(fig|eq|sec|tab):/, "")}</span>;
          case "cmd": return <span key={i} className="unknown">{it.tex}</span>;
        }
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case "title": return <h1>{b.text}</h1>;
    case "authors": return <div className="authors">{b.text}</div>;
    case "abstract": return <div className="abstract"><b>Abstract. </b><Inlines items={b.inlines} /></div>;
    case "heading": {
      const Tag = b.level === 1 ? "h2" : "h3";
      return <Tag id={`line-${b.line}`}><span className="num">{b.number}</span>{b.text}</Tag>;
    }
    case "para": return <p><Inlines items={b.inlines} /></p>;
    case "equation": return <div className="eq"><span className="tex">{b.tex}</span><span className="tag">{b.tag}</span></div>;
    case "figure":
      return (
        <figure className="figure">
          <div className="placeholder">{b.file ?? "figure"}</div>
          <figcaption className="caption"><b>Figure.</b> <Inlines items={b.caption} /></figcaption>
        </figure>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return <Tag>{b.items.map((it, i) => <li key={i}><Inlines items={it} /></li>)}</Tag>;
    }
    case "raw": return <span className="doc-comment">{b.tex}</span>;
  }
}

interface Props {
  source: string | null;
  mode: ViewMode;
  jumpLine: number | null;
  onOpen: () => void;
  onOutline: (o: ReturnType<typeof parseDocument>["outline"]) => void;
}

export function Document({ source, mode, jumpLine, onOpen, onOutline }: Props) {
  const parsed = useMemo(() => (source ? parseDocument(source) : null), [source]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { onOutline(parsed?.outline ?? []); }, [parsed, onOutline]);

  useEffect(() => {
    if (jumpLine == null || !ref.current) return;
    const el = ref.current.querySelector(`#line-${jumpLine}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [jumpLine, mode]);

  if (!source || !parsed) {
    return (
      <main className="document">
        <div className="doc-empty">
          <div className="card">
            <h1>Open a paper to begin</h1>
            <p>Dabir works on a folder: your manuscript, its figures, and the code that made them. Nothing is uploaded, nothing is converted.</p>
            <div className="actions">
              <button className="btn primary" onClick={onOpen}><FolderOpen /> Open folder</button>
              <button className="btn" disabled title="Coming in phase 2"><GitBranch /> Clone from GitHub</button>
            </div>
            <div className="hint">Try the bundled sample at <code>examples/isgd-tci</code>.</div>
          </div>
        </div>
      </main>
    );
  }

  const lines = source.split("\n");
  const words = source.replace(/\\[a-zA-Z]+/g, "").split(/\s+/).filter(Boolean).length;

  return (
    <main className="document" ref={ref}>
      {mode === "visual" ? (
        <article className="page">
          {parsed.blocks.map((b, i) => <BlockView key={i} b={b} />)}
        </article>
      ) : (
        <pre className="source">
          {lines.map((l, i) => (
            <span className="ln" key={i} id={`line-${i + 1}`}>
              {highlightLine(l).map((t, j) => t.cls === "txt" ? t.text : <span key={j} className={t.cls}>{t.text}</span>)}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      <footer className="status">
        <span><span className="dot" />Compiled 2 min ago</span>
        <span>{lines.length} lines</span>
        <span>{words} words</span>
        <span>{parsed.outline.length} sections</span>
      </footer>
    </main>
  );
}
