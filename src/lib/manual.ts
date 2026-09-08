// Direct WebRTC sessions with no server: the host makes an invite code, the guest answers with a
// code, and from then on the document travels straight between the two machines. Only public STUN
// is used to discover addresses; nothing is relayed. Works for most home and office networks;
// networks that block peer traffic entirely need the relay or Tailscale instead.

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MSG_SYNC = 0, MSG_AWARENESS = 1;
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];

type Handler = () => void;

async function deflate(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") return btoa(String.fromCharCode(...bytes));
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = ""; buf.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function inflate(code: string): Promise<string> {
  const b64 = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (typeof DecompressionStream === "undefined") return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/** Wait until ICE gathering is complete so one code carries every candidate. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    const t = setTimeout(resolve, 7000);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
  });
}

class Link {
  pc = new RTCPeerConnection({ iceServers: STUN });
  channel: RTCDataChannel | null = null;
  constructor(readonly owner: ManualProvider) {
    this.pc.addEventListener("datachannel", (e) => this.attach(e.channel));
    this.pc.addEventListener("connectionstatechange", () => { if (["failed", "closed"].includes(this.pc.connectionState)) this.owner.drop(this); });
  }
  attach(ch: RTCDataChannel) {
    this.channel = ch;
    ch.binaryType = "arraybuffer";
    ch.onopen = () => this.owner.opened(this);
    ch.onmessage = (e) => this.owner.receive(this, new Uint8Array(e.data as ArrayBuffer));
    ch.onclose = () => this.owner.drop(this);
  }
  send(bytes: Uint8Array) { if (this.channel?.readyState === "open") this.channel.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); }
}

export class ManualProvider {
  readonly awareness: awarenessProtocol.Awareness;
  private links = new Set<Link>();
  private handlers: Record<string, Handler[]> = {};
  private syncedOnce = false;

  constructor(readonly doc: Y.Doc) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin instanceof Link ? origin : null);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)));
      this.broadcast(encoding.toUint8Array(enc), null);
    });
  }

  on(event: "synced" | "peers", h: Handler) { (this.handlers[event] ??= []).push(h); }
  once(event: "synced" | "peers", h: Handler) { const w = () => { h(); this.handlers[event] = (this.handlers[event] ?? []).filter((x) => x !== w); }; this.on(event, w); }
  private emit(event: string) { (this.handlers[event] ?? []).forEach((h) => h()); }
  get peerCount() { return this.links.size; }

  /** Host side: make an invite code. One code per guest. */
  async createInvite(): Promise<string> {
    const link = new Link(this);
    link.attach(link.pc.createDataChannel("dabir", { ordered: true }));
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    await gathered(link.pc);
    this.links.add(link);
    return deflate(JSON.stringify({ t: "o", sdp: link.pc.localDescription!.sdp }));
  }

  /** Guest side: take the host's invite, return the answer code to send back. */
  async answerInvite(invite: string): Promise<string> {
    const msg = JSON.parse(await inflate(invite)) as { t: string; sdp: string };
    if (msg.t !== "o") throw new Error("That is not an invite code.");
    const link = new Link(this);
    await link.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    await gathered(link.pc);
    this.links.add(link);
    return deflate(JSON.stringify({ t: "a", sdp: link.pc.localDescription!.sdp }));
  }

  /** Host side: finish the handshake with the guest's answer code. */
  async acceptAnswer(answer: string): Promise<void> {
    const msg = JSON.parse(await inflate(answer)) as { t: string; sdp: string };
    if (msg.t !== "a") throw new Error("That is not an answer code.");
    const waiting = [...this.links].find((l) => l.pc.signalingState === "have-local-offer");
    if (!waiting) throw new Error("Create a new invite first; this one was already used.");
    await waiting.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  }

  opened(link: Link) {
    // Initial sync: step 1 plus our awareness.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    link.send(encoding.toUint8Array(enc));
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MSG_AWARENESS);
    encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    link.send(encoding.toUint8Array(aw));
    this.emit("peers");
  }

  receive(link: Link, bytes: Uint8Array) {
    const dec = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(dec, enc, this.doc, link);
      if (encoding.length(enc) > 1) link.send(encoding.toUint8Array(enc));
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.syncedOnce) { this.syncedOnce = true; this.emit("synced"); }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), link);
    }
  }

  private broadcast(bytes: Uint8Array, except: Link | null) { for (const l of this.links) if (l !== except) l.send(bytes); }

  drop(link: Link) {
    if (!this.links.has(link)) return;
    this.links.delete(link);
    try { link.pc.close(); } catch { /* already closed */ }
    this.emit("peers");
  }

  destroy() {
    for (const l of [...this.links]) this.drop(l);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.awareness.destroy();
  }
}
