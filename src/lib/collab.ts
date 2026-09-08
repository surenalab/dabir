// Live sessions: one Yjs document per open file, synced over a y-websocket relay.
// The relay only carries updates; the paper's truth stays in the host's Git checkout.

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";

export interface Peer { clientId: number; name: string; color: string; file?: string; me: boolean }
export interface Comment { id: string; author: string; color: string; text: string; file: string; anchor: string; head: string; at: number; resolved: boolean }

export type Transport = "relay" | "p2p";

/** Free public signalling servers used only to find peers; the document travels peer to peer over WebRTC. */
export const PUBLIC_SIGNALING = ["wss://signaling.yjs.dev", "wss://y-webrtc-signaling-eu.herokuapp.com", "wss://y-webrtc-signaling-us.herokuapp.com"];

export interface Session {
  url: string;
  room: string;
  host: boolean;
  transport: Transport;
  doc: Y.Doc;
  provider: WebsocketProvider | WebrtcProvider;
  awareness: Awareness;
  texts: Map<string, Y.Text>;
  comments: Y.Array<Comment>;
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

export function connect(url: string, room: string, name: string, host: boolean, transport: Transport = "relay", password?: string): Session {
  const doc = new Y.Doc();
  const provider = transport === "p2p"
    ? new WebrtcProvider(room, doc, { signaling: url ? [url] : PUBLIC_SIGNALING, password: password || undefined, maxConns: 12 })
    : new WebsocketProvider(url, room, doc, { connect: true });
  const awareness = provider.awareness;
  awareness.setLocalStateField("user", { name, color: colorFor(name) });
  return { url, room, host, transport, doc, provider, awareness, texts: new Map(), comments: doc.getArray<Comment>("comments") };
}

/** Resolves when the provider has exchanged state with someone (or, for a host, right away). */
export function whenSynced(s: Session, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (s.host) { resolve(); return; }
    const t = setTimeout(() => reject(new Error("Nobody answered. Check the link, and that the host still has the session open.")), timeoutMs);
    if (s.transport === "relay") (s.provider as WebsocketProvider).once("sync", () => { clearTimeout(t); resolve(); });
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

export function removeComment(s: Session, id: string) {
  const i = s.comments.toArray().findIndex((c) => c.id === id);
  if (i >= 0) s.comments.delete(i, 1);
}

/** Encode a range as Yjs relative positions so it survives concurrent edits. */
export function encodeRange(text: Y.Text, from: number, to: number): { anchor: string; head: string } {
  const enc = (i: number) => JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i)));
  return { anchor: enc(from), head: enc(to) };
}

export function decodeRange(doc: Y.Doc, c: Comment): { from: number; to: number } | null {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(JSON.parse(c.anchor)), doc);
    const h = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(JSON.parse(c.head)), doc);
    if (!a || !h) return null;
    return { from: Math.min(a.index, h.index), to: Math.max(a.index, h.index) };
  } catch { return null; }
}

/** A share link that Dabir understands and that also reads fine in a chat message. */
export function shareLink(url: string, room: string, transport: Transport = "relay", password?: string): string {
  const q = transport === "p2p" ? `p2p=1&room=${encodeURIComponent(room)}${password ? `&key=${encodeURIComponent(password)}` : ""}${url ? `&signal=${encodeURIComponent(url)}` : ""}` : `relay=${encodeURIComponent(url)}&room=${encodeURIComponent(room)}`;
  return `dabir://join?${q}`;
}
export function parseShareLink(s: string): { url: string; room: string; transport: Transport; password?: string } | null {
  try {
    const u = new URL(s.trim());
    if (u.protocol === "dabir:") {
      const room = u.searchParams.get("room");
      if (!room) return null;
      if (u.searchParams.get("p2p")) return { url: u.searchParams.get("signal") ?? "", room, transport: "p2p", password: u.searchParams.get("key") ?? undefined };
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
