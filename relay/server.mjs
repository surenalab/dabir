// Dabir live relay: a minimal y-websocket server. One process, one port, any number of
// rooms. Documents live in memory for the life of the process; the paper itself stays in Git.
// Run: node relay/dist/relay.cjs --port 1234 [--host 0.0.0.0]
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(arg("--port", "1234"));
const host = arg("--host", "0.0.0.0");
const MSG_SYNC = 0, MSG_AWARENESS = 1;

const rooms = new Map(); // name -> { doc, awareness, conns: Map<ws, Set<clientId>> }
function room(name) {
  let r = rooms.get(name);
  if (!r) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    r = { doc, awareness, conns: new Map() };
    doc.on("update", (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of r.conns.keys()) if (c !== origin) send(c, msg);
    });
    awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (origin && r.conns.has(origin)) { const ids = r.conns.get(origin); added.forEach((id) => ids.add(id)); removed.forEach((id) => ids.delete(id)); }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of r.conns.keys()) send(c, msg);
    });
    rooms.set(name, r);
  }
  return r;
}
function send(ws, msg) { try { if (ws.readyState === 1) ws.send(msg); else ws.close(); } catch { ws.close(); } }

const wss = new WebSocketServer({ port, host });
wss.on("connection", (ws, req) => {
  const name = decodeURIComponent((req.url || "/").slice(1).split("?")[0]) || "default";
  const r = room(name);
  r.conns.set(ws, new Set());
  ws.binaryType = "arraybuffer";
  ws.on("message", (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, r.doc, ws);
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(r.awareness, decoding.readVarUint8Array(dec), ws);
    }
  });
  ws.on("close", () => {
    const ids = r.conns.get(ws);
    r.conns.delete(ws);
    if (ids) awarenessProtocol.removeAwarenessStates(r.awareness, Array.from(ids), null);
    if (r.conns.size === 0) { setTimeout(() => { if (r.conns.size === 0) { r.doc.destroy(); rooms.delete(name); } }, 60_000); }
  });
  // Initial sync: step 1 and current awareness.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, r.doc);
  send(ws, encoding.toUint8Array(enc));
  const states = r.awareness.getStates();
  if (states.size > 0) {
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MSG_AWARENESS);
    encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(r.awareness, Array.from(states.keys())));
    send(ws, encoding.toUint8Array(aw));
  }
});
console.log(`dabir relay listening on ws://${host}:${port}`);
setInterval(() => {}, 1 << 30);
