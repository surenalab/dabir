// Editor settings, persisted per machine. Everything here has an off switch.

export interface Settings {
  spellcheck: boolean;          // spelling in the editor
  spellLanguage: string;                        // a dictionary id from public/dict/index.json, or "system" for the OS checker
  grammar: "off" | "languagetool";
  languageToolUrl: string;      // a server you trust; the public one has limits and sees your text
  grammarLanguage: string;      // e.g. en-GB, en-US, auto
  autocomplete: boolean;        // LaTeX commands, environments, snippets
  citeComplete: boolean;        // \cite and \ref keys, \input paths
  prediction: boolean;          // grey predictive text learned from the paper; Tab accepts
  fontSize: number;             // document view, px
  monoSize: number;             // source view, px
  lineWrap: boolean;
  revealOnClick: boolean;       // visual view: click a widget to reveal its source
  compileOnSave: boolean;
  autosave: boolean;            // write the file a moment after you stop typing; snapshots every few minutes
  suggesting: boolean;          // track changes: edits become suggestions a coauthor accepts or rejects
  signalingUrl: string;         // for the "signalling server" live mode; empty means none configured
  agentModel: Record<string, string>;   // per provider: model id, "" for the CLI's default
  agentEffort: Record<string, string>;  // per provider: reasoning effort level, "" for the CLI's default
}

export const DEFAULTS: Settings = {
  spellcheck: true,
  spellLanguage: "en-GB",
  grammar: "off",
  languageToolUrl: "https://api.languagetool.org",
  grammarLanguage: "en-GB",
  autocomplete: true,
  citeComplete: true,
  prediction: true,
  fontSize: 16.5,
  monoSize: 13,
  lineWrap: true,
  revealOnClick: true,
  compileOnSave: false,
  autosave: true,
  suggesting: false,
  signalingUrl: "",
  agentModel: {},
  agentEffort: {},
};

const KEY = "dabir.settings";
const listeners = new Set<(s: Settings) => void>();
let current: Settings = load();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    const legacy = localStorage.getItem("dabir.compileOnSave");
    return { ...DEFAULTS, compileOnSave: legacy === "1" };
  } catch { return { ...DEFAULTS }; }
}

export function getSettings(): Settings { return current; }

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
  listeners.forEach((l) => l(current));
}

export function resetSettings() { updateSettings({ ...DEFAULTS }); }

export function onSettings(l: (s: Settings) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

import { useEffect, useState } from "react";
export function useSettings(): Settings {
  const [s, setS] = useState(current);
  useEffect(() => onSettings(setS), []);
  return s;
}
