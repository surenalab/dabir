// The files opened this session, as tabs above the editor, the way an IDE keeps them: click to switch,
// × or middle-click to close, ⇧⌘] and ⇧⌘[ to cycle. Two files with the same name show their folder.

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  root: string;
  files: string[];          // absolute paths, in the order they were opened
  active: string | null;
  dirty: boolean;           // the active file has unsaved edits
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

export function FileTabs({ root, files, active, dirty, onSelect, onClose }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => { strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" }); }, [active]);
  if (files.length < 2) return null;
  const names = files.map((f) => f.split("/").pop() ?? f);
  const dup = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  return (
    <div className="filetabs" role="tablist" aria-label="Open files" ref={strip}>
      {files.map((f, i) => {
        const rel = f.startsWith(root + "/") ? f.slice(root.length + 1) : f;
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const isActive = f === active;
        return (
          <div key={f} role="tab" aria-selected={isActive} tabIndex={isActive ? 0 : -1} className={`filetab ${isActive ? "active" : ""}`} title={rel}
            onClick={() => onSelect(f)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(f); } }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(f); }}>
            <span className="name">{names[i]}{dup.has(names[i]) && dir && <span className="dir"> {dir}</span>}</span>
            {isActive && dirty && <span className="dot" aria-label="Unsaved" />}
            <button className="close" aria-label={`Close ${names[i]}`} title="Close" onClick={(e) => { e.stopPropagation(); onClose(f); }} tabIndex={-1}><X aria-hidden /></button>
          </div>
        );
      })}
    </div>
  );
}
