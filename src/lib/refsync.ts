import { useCallback, useEffect, useRef, useState } from "react";
import { refsLinkedSync, zoteroStatus, zoteroSync, type SyncReport, type ZoteroStatus } from "./backend";

/**
 * How a paper keeps its .bib in step with a reference manager. Per paper and per machine (the linked
 * file is a local path, the Zotero collection belongs to this user's library), so it lives in
 * localStorage under the paper's root rather than in the repository.
 */
export interface RefSync {
  zotero: { collection: string | null; name: string | null; auto: boolean; last: number | null; summary: string | null };
  linked: { path: string | null; mtime: number; last: number | null; summary: string | null };
}

const EMPTY: RefSync = { zotero: { collection: null, name: null, auto: false, last: null, summary: null }, linked: { path: null, mtime: 0, last: null, summary: null } };
const key = (root: string) => `dabir.refs.${root}`;

export function loadRefSync(root: string): RefSync {
  try {
    const raw = localStorage.getItem(key(root));
    if (!raw) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw) as Partial<RefSync>;
    return { zotero: { ...EMPTY.zotero, ...parsed.zotero }, linked: { ...EMPTY.linked, ...parsed.linked } };
  } catch { return structuredClone(EMPTY); }
}
export function saveRefSync(root: string, cfg: RefSync) { localStorage.setItem(key(root), JSON.stringify(cfg)); }

export function describe(r: SyncReport): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.updated) parts.push(`${r.updated} updated`);
  return parts.length ? `${parts.join(", ")} in ${r.file} (${r.total} entries)` : `${r.file} already up to date (${r.total} entries)`;
}

export function ago(t: number | null, now = Date.now()): string {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

const ZOTERO_EVERY = 10 * 60 * 1000;
const LINKED_EVERY = 5 * 1000;

/**
 * Runs the paper's reference sync while it is open: Zotero on open and every ten minutes when the
 * paper asks for it, the linked .bib whenever its modification time moves. `onChanged` fires when
 * entries landed so the app can reload its bibliography and tell the author.
 */
export function useRefSync(root: string | null, onChanged: (summary: string) => void) {
  // State is keyed by root so a change of paper derives fresh values in render, without an effect.
  const [store, setStore] = useState<{ root: string | null; cfg: RefSync }>(() => ({ root, cfg: root ? loadRefSync(root) : structuredClone(EMPTY) }));
  const cfg = store.root === root ? store.cfg : root ? loadRefSync(root) : structuredClone(EMPTY);
  const [zoteroStore, setZoteroStore] = useState<{ root: string | null; status: ZoteroStatus | undefined }>({ root, status: undefined });
  const zotero = zoteroStore.root === root ? zoteroStore.status : undefined;
  const setZotero = useCallback((status: ZoteroStatus | undefined) => setZoteroStore({ root, status }), [root]);
  const [busy, setBusy] = useState<"zotero" | "probe" | null>(null);
  const cfgRef = useRef(cfg);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { cfgRef.current = cfg; onChangedRef.current = onChanged; });

  const setCfg = useCallback((update: (c: RefSync) => RefSync) => {
    setStore((s) => { const base = s.root === root ? s.cfg : root ? loadRefSync(root) : structuredClone(EMPTY); const n = update(base); if (root) saveRefSync(root, n); cfgRef.current = n; return { root, cfg: n }; });
  }, [root]);

  const probe = useCallback(async () => {
    setBusy("probe");
    try { setZotero(await zoteroStatus()); } catch { setZotero({ reachable: false, betterBibtex: false, collections: [] }); } finally { setBusy(null); }
  }, [setZotero]);

  const syncZotero = useCallback(async (quiet = false): Promise<SyncReport | null> => {
    if (!root) return null;
    const c = cfgRef.current;
    setBusy("zotero");
    try {
      const status = zotero ?? await zoteroStatus();
      if (!status.reachable) { if (!quiet) throw new Error("Zotero is not reachable. Start Zotero 7 and turn on Settings → Advanced → Allow other applications on this computer to communicate with Zotero."); return null; }
      const r = await zoteroSync(root, c.zotero.collection, status.betterBibtex);
      const summary = describe(r);
      setCfg((x) => ({ ...x, zotero: { ...x.zotero, last: Date.now(), summary } }));
      if (r.added || r.updated) onChangedRef.current(`Zotero: ${summary}`);
      return r;
    } finally { setBusy(null); }
  }, [root, zotero, setCfg]);

  const syncLinked = useCallback(async (force = false): Promise<SyncReport | null> => {
    if (!root) return null;
    const c = cfgRef.current;
    if (!c.linked.path) return null;
    const r = await refsLinkedSync(root, c.linked.path, force ? 0 : c.linked.mtime);
    if (r.report) {
      const summary = describe(r.report);
      setCfg((x) => ({ ...x, linked: { ...x.linked, mtime: r.mtime, last: Date.now(), summary } }));
      if (r.report.added || r.report.updated) onChangedRef.current(`Linked .bib: ${summary}`);
    } else if (r.mtime !== c.linked.mtime) {
      setCfg((x) => ({ ...x, linked: { ...x.linked, mtime: r.mtime } }));
    }
    return r.report;
  }, [root, setCfg]);

  // Zotero: on open and on a slow clock, only when the paper asked for it.
  useEffect(() => {
    if (!root || !cfg.zotero.auto) return;
    let stop = false;
    const run = () => { if (!stop) syncZotero(true).catch(() => {}); };
    const t0 = setTimeout(run, 1500);
    const t = setInterval(run, ZOTERO_EVERY);
    return () => { stop = true; clearTimeout(t0); clearInterval(t); };
  }, [root, cfg.zotero.auto, cfg.zotero.collection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Linked file: a cheap modification-time check on a fast clock.
  useEffect(() => {
    if (!root || !cfg.linked.path) return;
    let stop = false;
    let failures = 0;
    const run = async () => {
      if (stop) return;
      try { await syncLinked(); failures = 0; } catch { failures += 1; if (failures > 12) stop = true; }
    };
    const t0 = setTimeout(run, 800);
    const t = setInterval(run, LINKED_EVERY);
    return () => { stop = true; clearTimeout(t0); clearInterval(t); };
  }, [root, cfg.linked.path]); // eslint-disable-line react-hooks/exhaustive-deps

  return { cfg, setCfg, zotero, probe, syncZotero, syncLinked, busy };
}
