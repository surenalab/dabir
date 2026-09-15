/** Paths relative to a project root, the same on Windows (`C:\\paper\\main.tex`) and everywhere else (`/paper/main.tex`). */

export function slash(p: string): string {
  let s = p.replace(/\\/g, "/");
  // Windows extended path `\\?\C:\paper` → `C:/paper`, otherwise the prefix never matches the root.
  if (/^\/\/\?\/[a-zA-Z]:/.test(s)) s = s.slice(4);
  return s.replace(/\/+$/, "");
}

/** `path` as a project-relative posix path, or `path` unchanged when it is not under `root`. */
export function relTo(root: string, path: string): string {
  const r = slash(root);
  const p = slash(path);
  if (!r) return p;
  const fold = (s: string) => (/^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s);
  const R = fold(r), P = fold(p);
  if (P === R) return "";
  if (P.startsWith(R + "/")) return p.slice(r.length + 1);
  return p;
}
