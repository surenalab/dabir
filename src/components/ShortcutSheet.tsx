import { useEffect } from "react";

const ROWS: [string, string[]][] = [
  ["New Paper…", ["⌘", "N"]],
  ["Open Paper…", ["⌘", "O"]],
  ["Share…", ["⇧", "⌘", "S"]],
  ["Save", ["⌘", "S"]],
  ["Compile", ["⌘", "B"]],
  ["Show Compile Log", ["⇧", "⌘", "L"]],
  ["Show Line in PDF", ["⇧", "⌘", "J"]],
  ["Commit…", ["⌥", "⌘", "C"]],
  ["Clone from GitHub…", ["⇧", "⌘", "O"]],
  ["Visual · Source · PDF · Both", ["⌘", "1 2 3 4"]],
  ["Bold · Italic · Emphasis", ["⇧⌘", "B I E"]],
  ["Inline math · Citation · Cross-ref", ["⇧⌘", "M C R"]],
  ["Zoom in · out · fit", ["⌘", "= − 0"]],
  ["Show or Hide Sidebar", ["⌃", "⌘", "S"]],
  ["Show or Hide Inspector", ["⌥", "⌘", "I"]],
  ["Ask the Agent", ["⌘", "J"]],
  ["Link", ["⌘", "K"]],
  ["Send to Agent", ["⌘", "↩"]],
  ["Find in Source", ["⌘", "F"]],
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
              <dd>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</dd>
            </div>
          ))}
        </dl>
        <footer><button className="btn" onClick={onClose} autoFocus>Done</button></footer>
      </div>
    </div>
  );
}
