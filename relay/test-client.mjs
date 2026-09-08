// Two y-websocket clients against a relay: client A writes, client B must see it.
// Usage: node relay/test-client.mjs ws://127.0.0.1:1240 roomname
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const [url, room] = process.argv.slice(2);
const mk = () => { const doc = new Y.Doc(); const p = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: WebSocket }); return { doc, p }; };
const a = mk(), b = mk();
const synced = (p) => new Promise((res) => p.once("sync", res));
await Promise.all([synced(a.p), synced(b.p)]);
a.doc.getText("file:main.tex").insert(0, "hello from A");
a.p.awareness.setLocalStateField("user", { name: "A" });
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  if (b.doc.getText("file:main.tex").toString() === "hello from A" && b.p.awareness.getStates().size >= 2) break;
  await new Promise((r) => setTimeout(r, 50));
}
const ok = b.doc.getText("file:main.tex").toString() === "hello from A" && b.p.awareness.getStates().size >= 2;
console.log(ok ? "SYNC_OK" : `SYNC_FAIL text=${JSON.stringify(b.doc.getText("file:main.tex").toString())} peers=${b.p.awareness.getStates().size}`);
a.p.destroy(); b.p.destroy();
process.exit(ok ? 0 : 1);
