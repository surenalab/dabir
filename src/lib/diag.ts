// Errors the UI cannot show go to a log file the owner can read: the release build has no devtools,
// so "nothing happened" reports need a trail. ~/Library/Logs/Dabir/ui.log on macOS.
import { invoke } from "@tauri-apps/api/core";

const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const seen = new Map<string, number>();

/** One line to the log; identical lines are counted and written at most once a minute. */
export function logUi(message: string): void {
  const now = Date.now();
  const last = seen.get(message) ?? 0;
  if (now - last < 60_000) return;
  seen.set(message, now);
  if (native) invoke("ui_log", { message }).catch(() => {});
  else console.warn("[ui]", message);
}

/** Forward script errors and unhandled rejections; call once at start-up. */
export function installDiagnostics(): void {
  window.addEventListener("error", (e) => logUi(`error: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => logUi(`unhandled rejection: ${describe(e.reason)}`));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => { original(...args); logUi(`console.error: ${args.map(describe).join(" ")}`); };
}

export function describe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split("\n").slice(1, 4).join("\n")}` : ""}`;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
