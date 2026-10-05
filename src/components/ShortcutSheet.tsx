import { useEffect } from "react";
import { chord } from "../lib/keys";
import { isMac } from "../lib/backend";

const ROWS: [string, string[]][] = [
  ["New Paper…", ["⌘", "N"]],
  ["Open Paper…", ["⌘", "O"]],
  ["New Word Document…", ["⌥", "⌘", "N"]],
  ["Open File… (.tex, .typ, .docx)", ["⌥", "⌘", "O"]],
  ["Import Word Document…", ["⇧", "⌥", "⌘", "I"]],
  ["Share…", ["⇧", "⌘", "S"]],
  ["Export…", ["⌥", "⌘", "E"]],
  ["References…", ["⌥", "⌘", "R"]],
  ["Save", ["⌘", "S"]],
  ["Close Paper", ["⇧", "⌘", "W"]],
  ["Compile (Bold in a Word document)", ["⌘", "B"]],
  ["Show Compile Log", ["⇧", "⌘", "L"]],
  ["Show or Hide Terminal", ["⌃", "`"]],
  ["Run File in Terminal", isMac ? ["⌃", "↩"] : ["⌥", "⌘", "↩"]],
  ["Code: Run Selection or Line in Terminal", ["⇧", "↩"]],
  ["Next · Previous Open File", ["⇧⌘", "] ["]],
  ["Focus Mode", ["⌥", "⌘", "F"]],
  ["Show Line in PDF", ["⇧", "⌘", "J"]],
  ["Commit…", ["⌥", "⌘", "C"]],
  ["Clone from GitHub…", ["⇧", "⌘", "O"]],
  ["Visual · Source · PDF · Both", ["⌘", "1 2 3 4"]],
  ["Bold · Italic · Emphasis", ["⇧⌘", "B I E"]],
  ["Inline math · Citation · Cross-ref", ["⇧⌘", "M C R"]],
  ["Zoom in · out · fit", ["⌘", "= − 0"]],
  ["Show or Hide Sidebar", isMac ? ["⌃", "⌘", "S"] : ["⌥", "⌘", "S"]],
  ["Sidebar: Outline · Files · Changes", isMac ? ["⌃", "⌘", "1 2 3"] : ["⌥", "⌘", "1 2 3"]],
  ["Show or Hide Inspector", ["⌥", "⌘", "I"]],
  ["Ask the Agent", ["⌘", "J"]],
  ["Link", ["⌘", "K"]],
  ["Send to Agent", ["⌘", "↩"]],
  ["Continue Sentence with Agent", ["⇧", "⌘", "Space"]],
  ["Find in Source or in the Word document", ["⌘", "F"]],
  ["Word: Bold · Italic · Underline", ["⌘", "B I U"]],
  ["Go to Definition (label, key, file, macro; code with a language server)", ["F12"]],
  ["Code: Find References · Rename · Format Document", ["⇧F12", "F2", "⇧⌥F"]],
  ["Code: Select Next Occurrence (multi-cursor) · Add Cursor", ["⌘D", "⌥click"]],
  ["Fold · Unfold at Cursor", ["⌘⌥", "[ ]"]],
  ["Keyboard Shortcuts", ["⌘", "/"]],
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="sheet-title">Keyboard Shortcuts</h2>
        <dl>
          {ROWS.map(([what, keys]) => (
            <div key={what} style={{ display: "contents" }}>
              <dt>{what}</dt>
              <dd>{keys.map((k) => <kbd key={k}>{chord(k)}</kbd>)}</dd>
            </div>
          ))}
        </dl>
        <footer><button className="btn" onClick={onClose} autoFocus>Done</button></footer>
      </div>
    </div>
  );
}
