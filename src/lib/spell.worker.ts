// The spelling engine, off the main thread: Hunspell compiled to WebAssembly, one instance per
// dictionary. Loading Italian or Portuguese here takes tens of milliseconds where the JavaScript
// port took a minute, and the editor never waits on a lookup.
/// <reference lib="webworker" />
import { createHunspellFromStrings, type Hunspell } from "hunspell-wasm";
import { acceptWord, rankSuggestions, type Checker } from "./spell-rules";

type Req =
  | { id: number; type: "load"; lang: string; base: string }
  | { id: number; type: "check"; lang: string; words: string[] }
  | { id: number; type: "suggest"; lang: string; word: string };

const engines = new Map<string, Promise<Hunspell>>();

function engine(lang: string, base: string): Promise<Hunspell> {
  let p = engines.get(lang);
  if (!p) {
    p = (async () => {
      const file = async (ext: string) => { const r = await fetch(`${base}/dict/${lang}.${ext}`); if (!r.ok) throw new Error(`No ${lang} dictionary`); return r.text(); };
      const [aff, dic] = await Promise.all([file("aff"), file("dic")]);
      return createHunspellFromStrings(aff, dic);
    })();
    engines.set(lang, p);
    p.catch(() => engines.delete(lang));
  }
  return p;
}

const asChecker = (h: Hunspell): Checker => ({ correct: (w) => h.testSpelling(w), suggest: (w) => h.getSpellingSuggestions(w) });

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      await engine(m.lang, m.base);
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === "check") {
      const h = asChecker(await engines.get(m.lang)!);
      self.postMessage({ id: m.id, ok: true, result: m.words.map((w) => acceptWord(h, w)) });
    } else {
      const h = asChecker(await engines.get(m.lang)!);
      self.postMessage({ id: m.id, ok: true, result: rankSuggestions(m.word, h) });
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err) });
  }
};
