// Live sessions: one Yjs document per open file, shared peer to peer (WebRTC, the room key in the
// link encrypts it), over a relay on the host's machine for one network, or straight between two
// machines with swapped codes. The paper's truth stays in the host's Git checkout.

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebrtcProvider } from "y-webrtc";
import { ManualProvider } from "./manual";
import type { Awareness } from "y-protocols/awareness";
import type { Change } from "./changes";

export interface Peer { clientId: number; name: string; color: string; file?: string; me: boolean }
export interface Reply { author: string; color: string; text: string; at: number }
export interface Comment { id: string; author: string; color: string; text: string; file: string; anchor: string; head: string; at: number; resolved: boolean; replies?: Reply[] }

export type Transport = "relay" | "p2p" | "direct";

export interface Session {
  url: string;
  room: string;
  host: boolean;
  transport: Transport;
  doc: Y.Doc;
  provider: WebsocketProvider | WebrtcProvider | ManualProvider;
  awareness: Awareness;
  texts: Map<string, Y.Text>;
  comments: Y.Array<Comment>;
  changes: Y.Array<Change>;
}

/** Dabir's meeting point (relay/signaling-worker.js on Cloudflare's free tier). It introduces peers and hands out
 *  ICE servers; the text never passes through it. Settings › Signalling server overrides it for a lab's own. */
export const DEFAULT_SIGNAL = "wss://signal.surenalab.com";
/** The address peers meet at: the one in Settings when set, Dabir's otherwise. */
export function signalUrl(fromSettings: string): string { return fromSettings.trim() || DEFAULT_SIGNAL; }

const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
/** ICE servers for a WebRTC session: STUN, plus TURN credentials from the signalling server when it has them, so peers
 *  behind firewalls that block direct traffic still connect. Falls back to STUN alone if the server does not answer. */
export async function iceServers(signal: string): Promise<RTCIceServer[]> {
  try {
    const http = signal.replace(/^ws/, "http").replace(/\/+$/, "") + "/ice";
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(http, { signal: ctl.signal }); clearTimeout(t);
    if (!r.ok) return STUN;
    const body = await r.json() as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) && body.iceServers.length ? body.iceServers : STUN;
  } catch { return STUN; }
}

const COLORS = ["#a8322d", "#2f6b3a", "#1f5fa8", "#8a6414", "#6b3fa0", "#0e7c7b"];

export function userName(): string {
  try { return localStorage.getItem("dabir.name") || ""; } catch { return ""; }
}
export function setUserName(n: string) { try { localStorage.setItem("dabir.name", n); } catch { /* private mode */ } }

export function colorFor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function randomRoom(prefix: string): string {
  const s = Math.random().toString(36).slice(2, 8);
  return `${prefix.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${s}`;
}

export function connect(url: string, room: string, name: string, host: boolean, transport: Transport = "relay", password?: string, ice: RTCIceServer[] = STUN): Session {
  const doc = new Y.Doc();
  const provider = transport === "direct" ? new ManualProvider(doc, ice)
    : transport === "p2p" ? new WebrtcProvider(room, doc, { signaling: [url], password: password || undefined, maxConns: 12, peerOpts: { config: { iceServers: ice } } })
    : new WebsocketProvider(url, room, doc, { connect: true });
  const awareness = provider.awareness;
  awareness.setLocalStateField("user", { name, color: colorFor(name) });
  return { url, room, host, transport, doc, provider, awareness, texts: new Map(), comments: doc.getArray<Comment>("comments"), changes: doc.getArray<Change>("changes") };
}

/** Resolves when the provider has exchanged state with someone (or, for a host, right away). */
export function whenSynced(s: Session, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (s.host) { resolve(); return; }
    const t = setTimeout(() => reject(new Error("Nobody answered. Check the link, and that the host still has the session open.")), timeoutMs);
    if (s.transport === "relay") (s.provider as WebsocketProvider).once("sync", () => { clearTimeout(t); resolve(); });
    else if (s.transport === "direct") (s.provider as ManualProvider).once("synced", () => { clearTimeout(t); resolve(); });
    else (s.provider as WebrtcProvider).once("synced", () => { clearTimeout(t); resolve(); });
  });
}

export function disconnect(s: Session) {
  s.provider.destroy();
  s.doc.destroy();
}

/** The shared text for a file, keyed by its path relative to the project root. */
export function textFor(s: Session, relPath: string): Y.Text {
  let t = s.texts.get(relPath);
  if (!t) { t = s.doc.getText(`file:${relPath}`); s.texts.set(relPath, t); }
  return t;
}

export function peers(s: Session): Peer[] {
  const out: Peer[] = [];
  s.awareness.getStates().forEach((state, clientId) => {
    const u = (state as { user?: { name: string; color: string }; file?: string }).user;
    if (!u) return;
    out.push({ clientId, name: u.name, color: u.color, file: (state as { file?: string }).file, me: clientId === s.awareness.clientID });
  });
  return out.sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name));
}

export function setCurrentFile(s: Session, relPath: string | null) {
  s.awareness.setLocalStateField("file", relPath ?? undefined);
}

export function addComment(s: Session, c: Omit<Comment, "id" | "at" | "resolved">) {
  s.comments.push([{ ...c, id: Math.random().toString(36).slice(2, 10), at: Date.now(), resolved: false }]);
}

export function resolveComment(s: Session, id: string, resolved = true) {
  const i = s.comments.toArray().findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = s.comments.get(i);
  s.doc.transact(() => { s.comments.delete(i, 1); s.comments.insert(i, [{ ...c, resolved }]); });
}

export function replyComment(s: Session, id: string, reply: Omit<Reply, "at">) {
  const i = s.comments.toArray().findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = s.comments.get(i);
  s.doc.transact(() => { s.comments.delete(i, 1); s.comments.insert(i, [{ ...c, replies: [...(c.replies ?? []), { ...reply, at: Date.now() }] }]); });
}

export function removeComment(s: Session, id: string) {
  const i = s.comments.toArray().findIndex((c) => c.id === id);
  if (i >= 0) s.comments.delete(i, 1);
}

/** Encode a range as Yjs relative positions so it survives concurrent edits. */
export function encodeRange(text: Y.Text, from: number, to: number): { anchor: string; head: string } {
  const enc = (i: number) => JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i)));
  return { anchor: enc(from), head: enc(to) };
}

/** Bring the shared suggestions for one file in line with the editor's current set.
 *  Records are matched by id: new ones are added, moved ones updated, and a record is removed only
 *  when this client had already seen it (`known`), so a coauthor's suggestion that arrived after the
 *  editor last synced is left alone instead of being wiped by a stale list. */
export function setFileChanges(s: Session, file: string, next: Change[], known: Set<string>) {
  const pending = new Map(next.map((c) => [c.id, c]));
  const updates: { i: number; c: Change }[] = [];
  const removals: number[] = [];
  s.changes.toArray().forEach((c, i) => {
    if (c.file !== file) return;
    const n = pending.get(c.id);
    if (n) {
      if (n.anchor !== c.anchor || n.head !== c.head || n.kind !== c.kind) updates.push({ i, c: n });
      pending.delete(c.id);
    } else if (known.has(c.id)) removals.push(i);
  });
  if (!updates.length && !removals.length && !pending.size) return;
  s.doc.transact(() => {
    for (const u of updates) { s.changes.delete(u.i, 1); s.changes.insert(u.i, [u.c]); }
    for (const i of removals.sort((a, b) => b - a)) s.changes.delete(i, 1);
    if (pending.size) s.changes.push([...pending.values()]);
  });
}

export function decodeRange(doc: Y.Doc, c: { anchor: string; head: string }): { from: number; to: number } | null {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(JSON.parse(c.anchor)), doc);
    const h = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(JSON.parse(c.head)), doc);
    if (!a || !h) return null;
    return { from: Math.min(a.index, h.index), to: Math.max(a.index, h.index) };
  } catch { return null; }
}

/** A share link that Dabir understands and that also reads fine in a chat message. The signalling address is
 *  left out when it is Dabir's own, so the usual link is short. */
export function shareLink(url: string, room: string, transport: Transport = "relay", password?: string): string {
  if (transport === "direct") return "";
  const signal = url && url !== DEFAULT_SIGNAL ? `&signal=${encodeURIComponent(url)}` : "";
  const q = transport === "p2p" ? `p2p=1&room=${encodeURIComponent(room)}${password ? `&key=${encodeURIComponent(password)}` : ""}${signal}` : `relay=${encodeURIComponent(url)}&room=${encodeURIComponent(room)}`;
  return `dabir://join?${q}`;
}

export const DOWNLOAD_URL = "https://github.com/surenalab/dabir/releases/latest";

/** The invitation as a message: who, which paper, the link, and where to get Dabir. Plain text, so it reads the same
 *  in Mail, Messages, WhatsApp or Slack. */
export function inviteMessage(from: string, paper: string, link: string): { subject: string; body: string } {
  const who = from.trim() ? from.trim() : "A coauthor";
  return {
    subject: `Join me on "${paper}" in Dabir`,
    body: `${who} is editing "${paper}" live in Dabir and invites you to work on it together.\n\nOpen this link with Dabir running:\n${link}\n\nIf you do not have Dabir yet (free, macOS, Windows, Linux): ${DOWNLOAD_URL}\nThen paste the link into File › Share › Join.\n\nThe paper travels straight between our machines, encrypted with the key in the link; nothing is stored on a server.`,
  };
}
export function parseShareLink(s: string): { url: string; room: string; transport: Transport; password?: string } | null {
  try {
    const u = new URL(s.trim());
    if (u.protocol === "dabir:") {
      const room = u.searchParams.get("room");
      if (!room) return null;
      if (u.searchParams.get("p2p")) return { url: u.searchParams.get("signal") || DEFAULT_SIGNAL, room, transport: "p2p", password: u.searchParams.get("key") ?? undefined };
      const relay = u.searchParams.get("relay");
      return relay ? { url: relay, room, transport: "relay" } : null;
    }
    if (u.protocol === "ws:" || u.protocol === "wss:") {
      const room = u.pathname.replace(/^\//, "");
      return room ? { url: `${u.protocol}//${u.host}`, room, transport: "relay" } : null;
    }
  } catch { /* not a URL */ }
  return null;
}

// ---------------------------------------------------------------- project mirror
//
// The host publishes its working tree into the shared document so every joiner can rebuild it
// locally: figures, tables, the .bib, everything the compile needs. Text files travel as text;
// other files as base64 in chunks small enough for any transport. Files the host has open are
// also live Y.Text entries, which win over the snapshot.

export interface SnapFile { path: string; text: string | null; base64: string | null; size: number }
const CHUNK = 96 * 1024;

export function markHost(s: Session) { s.awareness.setLocalStateField("host", true); }
export function hostPresent(s: Session): boolean {
  let present = false;
  s.awareness.getStates().forEach((st) => { if ((st as { host?: boolean }).host) present = true; });
  return present;
}

/** Host side. Writes the snapshot in many small transactions so no single message is large. */
export async function publishProject(s: Session, files: SnapFile[], skipped: string[]): Promise<void> {
  const texts = s.doc.getMap<string>("snap:text");
  const chunks = s.doc.getMap<string>("snap:chunk");
  const meta = s.doc.getMap<unknown>("snap:meta");
  const manifest: Record<string, { size: number; chunks: number; text: boolean }> = {};
  for (const f of files) {
    if (f.text != null) { s.doc.transact(() => texts.set(f.path, f.text!)); manifest[f.path] = { size: f.size, chunks: 0, text: true }; continue; }
    const b = f.base64 ?? "";
    const n = Math.ceil(b.length / CHUNK);
    for (let i = 0; i < n; i++) { s.doc.transact(() => chunks.set(`${f.path}#${i}`, b.slice(i * CHUNK, (i + 1) * CHUNK))); await new Promise((r) => setTimeout(r, 0)); }
    manifest[f.path] = { size: f.size, chunks: n, text: false };
  }
  s.doc.transact(() => { meta.set("manifest", manifest); meta.set("skipped", skipped); meta.set("stamp", Date.now()); });
}

/** Host side: republish only the files whose content changed (after a compile regenerated a figure, say). */
export async function republishChanged(s: Session, files: SnapFile[]): Promise<number> {
  const texts = s.doc.getMap<string>("snap:text");
  const chunks = s.doc.getMap<string>("snap:chunk");
  const meta = s.doc.getMap<unknown>("snap:meta");
  const manifest = { ...((meta.get("manifest") as Record<string, { size: number; chunks: number; text: boolean }> | undefined) ?? {}) };
  let changed = 0;
  for (const f of files) {
    if (f.text != null) { if (texts.get(f.path) !== f.text) { s.doc.transact(() => texts.set(f.path, f.text!)); manifest[f.path] = { size: f.size, chunks: 0, text: true }; changed++; } continue; }
    const b = f.base64 ?? "";
    const n = Math.ceil(b.length / CHUNK);
    let same = manifest[f.path]?.chunks === n;
    for (let i = 0; same && i < n; i++) if (chunks.get(`${f.path}#${i}`) !== b.slice(i * CHUNK, (i + 1) * CHUNK)) same = false;
    if (same) continue;
    for (let i = 0; i < n; i++) { s.doc.transact(() => chunks.set(`${f.path}#${i}`, b.slice(i * CHUNK, (i + 1) * CHUNK))); await new Promise((r) => setTimeout(r, 0)); }
    manifest[f.path] = { size: f.size, chunks: n, text: false }; changed++;
  }
  if (changed) s.doc.transact(() => { meta.set("manifest", manifest); meta.set("stamp", Date.now()); });
  return changed;
}

/** Joiner side: wait for the manifest and every chunk it names, then assemble the files. */
export function awaitSnapshot(s: Session, timeoutMs: number): Promise<{ files: SnapFile[]; skipped: string[] }> {
  const texts = s.doc.getMap<string>("snap:text");
  const chunks = s.doc.getMap<string>("snap:chunk");
  const meta = s.doc.getMap<unknown>("snap:meta");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { meta.unobserve(check); chunks.unobserve(check); reject(new Error("The host's files did not arrive. Ask them to keep Dabir open and try again.")); }, timeoutMs);
    const check = () => {
      const manifest = meta.get("manifest") as Record<string, { size: number; chunks: number; text: boolean }> | undefined;
      if (!manifest) return;
      const files: SnapFile[] = [];
      for (const [path, m] of Object.entries(manifest)) {
        if (m.text) { const txt = texts.get(path); if (txt == null) return; const live = s.doc.share.has(`file:${path}`) ? s.doc.getText(`file:${path}`).toString() : ""; files.push({ path, text: live || txt, base64: null, size: m.size }); continue; }
        let b = "";
        for (let i = 0; i < m.chunks; i++) { const c = chunks.get(`${path}#${i}`); if (c == null) return; b += c; }
        files.push({ path, text: null, base64: b, size: m.size });
      }
      clearTimeout(t); meta.unobserve(check); chunks.unobserve(check);
      resolve({ files, skipped: (meta.get("skipped") as string[] | undefined) ?? [] });
    };
    meta.observe(check); chunks.observe(check); texts.observe(check);
    check();
  });
}

/** Every shared file text, so a client can write files it does not have open. */
export function sharedTexts(s: Session): { rel: string; text: Y.Text }[] {
  const out: { rel: string; text: Y.Text }[] = [];
  s.doc.share.forEach((_, key) => { if (key.startsWith("file:")) out.push({ rel: key.slice(5), text: s.doc.getText(key) }); });
  return out;
}

/** Local persistence so a dropped connection or a restart resumes with the same edits. */
export async function persist(s: Session): Promise<() => void> {
  if (typeof indexedDB === "undefined") return () => {};
  const { IndexeddbPersistence } = await import("y-indexeddb");
  const p = new IndexeddbPersistence(`dabir-session-${s.room}`, s.doc);
  return () => { p.destroy(); };
}
