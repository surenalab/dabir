// Live sessions: one Yjs document per open file, synced over a y-websocket relay.
// The relay only carries updates; the paper's truth stays in the host's Git checkout.

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";

export interface Peer { clientId: number; name: string; color: string; file?: string; me: boolean }
export interface Comment { id: string; author: string; color: string; text: string; file: string; anchor: string; head: string; at: number; resolved: boolean }

export interface Session {
  url: string;
  room: string;
  host: boolean;
  doc: Y.Doc;
  provider: WebsocketProvider;
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

export function connect(url: string, room: string, name: string, host: boolean): Session {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, { connect: true });
  const awareness = provider.awareness;
  awareness.setLocalStateField("user", { name, color: colorFor(name) });
  return { url, room, host, doc, provider, awareness, texts: new Map(), comments: doc.getArray<Comment>("comments") };
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
export function shareLink(url: string, room: string): string {
  return `dabir://join?relay=${encodeURIComponent(url)}&room=${encodeURIComponent(room)}`;
}
export function parseShareLink(s: string): { url: string; room: string } | null {
  try {
    const u = new URL(s.trim());
    if (u.protocol === "dabir:") {
      const relay = u.searchParams.get("relay"), room = u.searchParams.get("room");
      return relay && room ? { url: relay, room } : null;
    }
    if (u.protocol === "ws:" || u.protocol === "wss:") {
      const room = u.pathname.replace(/^\//, "");
      return room ? { url: `${u.protocol}//${u.host}`, room } : null;
    }
  } catch { /* not a URL */ }
  return null;
}
