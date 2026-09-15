// Shortcuts are written the Mac way in the source ("⇧⌘B", "⌘↩"); on Windows and Linux the same chord is
// Ctrl, Alt, Shift and Enter, and every label, tooltip, tour stop and the shortcut sheet says so.
import { isMac } from "./backend";

const NAMES: Record<string, string> = { "⌘": "Ctrl", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const CHORD = /[⌘⌃⌥⇧]+[^⌘⌃⌥⇧↩⏎\s()]*[↩⏎]?|[↩⏎]/gu;

/** "⇧⌘B" → "Shift+Ctrl+B", "⌘↩" → "Ctrl+Enter", "⌃`" → "Ctrl+`" on Windows and Linux; unchanged on the Mac. Works on a
 *  whole sentence too: "Compile first (⌘B)" → "Compile first (Ctrl+B)". */
export function chord(text: string): string {
  if (isMac) return text;
  return text.replace(CHORD, (m) => {
    const parts: string[] = [];
    let rest = "";
    for (const c of m) {
      if (c in NAMES) { if (!parts.includes(NAMES[c])) parts.push(NAMES[c]); }
      else if (c === "↩" || c === "⏎") rest += "Enter";
      else rest += c;
    }
    if (rest) parts.push(rest);
    return parts.join("+");
  });
}
