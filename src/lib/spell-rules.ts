// The rules around a dictionary lookup, shared by the worker and the tests: which spellings of a
// word count as right, and how suggestions are ordered. No DOM, no editor.

export interface Checker { correct(word: string): boolean; suggest(word: string): string[] }

/** A word passes when the dictionary knows it, or its lowercase form at a sentence start, or, for elisions
 *  such as l'image and dell'acqua, both halves around the apostrophe. */
export function acceptWord(sp: Checker, word: string): boolean {
  if (sp.correct(word)) return true;
  if (word[0] === word[0].toUpperCase() && sp.correct(word.toLowerCase())) return true;
  const cut = word.indexOf("'");
  if (cut > 0 && cut < word.length - 1) {
    const a = word.slice(0, cut + 1), b = word.slice(cut + 1);
    return (sp.correct(a) || sp.correct(a.toLowerCase()) || sp.correct(a.slice(0, -1)) || sp.correct(a.slice(0, -1).toLowerCase())) && (sp.correct(b) || sp.correct(b.toLowerCase()));
  }
  return false;
}

/** Damerau–Levenshtein distance: one swap of adjacent letters counts as a single edit. */
export function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}

/** Hunspell's list misses simple letter swaps (teh → the); add them and order everything by how small the edit is. */
export function rankSuggestions(word: string, engine: Checker): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const push = (s: string) => { if (s && s !== word && !seen.has(s)) { seen.add(s); out.push(s); } };
  const lower = word.toLowerCase(), cap = word[0] === word[0].toUpperCase();
  const cased = (s: string) => (cap ? s[0].toUpperCase() + s.slice(1) : s);
  for (let i = 0; i + 1 < lower.length; i++) {
    const swapped = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
    if (engine.correct(swapped) || engine.correct(cased(swapped))) push(cased(swapped));
  }
  for (const s of engine.suggest(word)) push(s);
  return out
    .map((s, i) => ({ s, i, d: distance(lower, s.toLowerCase()) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .map((x) => x.s);
}
