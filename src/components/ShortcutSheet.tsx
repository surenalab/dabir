import { useEffect } from "react";

const ROWS: [string, string[]][] = [
  ["Open Paper…", ["⌘", "O"]],
  ["Save", ["⌘", "S"]],
  ["Compile", ["⌘", "B"]],
  ["Show Compile Log", ["⇧", "⌘", "L"]],
  ["Show Line in PDF", ["⇧", "⌘", "J"]],
  ["Commit…", ["⇧", "⌘", "C"]],
  ["Clone from GitHub…", ["⇧", "⌘", "O"]],
  ["Visual · Source · PDF", ["⌘", "1 2 3"]],
  ["Show or Hide Sidebar", ["⌃", "⌘", "S"]],
  ["Show or Hide Inspector", ["⌥", "⌘", "I"]],
  ["Ask the Agent", ["⌘", "K"]],
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
