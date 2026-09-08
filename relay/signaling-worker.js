// A y-webrtc signalling server as a Cloudflare Worker with one Durable Object.
// Free tier is enough: it only introduces peers; the paper itself travels peer to peer.
//
// Deploy:  npx wrangler deploy relay/signaling-worker.js --name dabir-signal
//          (add to wrangler.toml:  [[durable_objects.bindings]] name = "ROOMS" class_name = "Rooms"
//                                  [[migrations]] tag = "v1" new_classes = ["Rooms"])
// Then put wss://dabir-signal.<you>.workers.dev in Settings › Signalling server.

export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("dabir signalling", { status: 200 });
    const id = env.ROOMS.idFromName("global");
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Rooms {
  constructor(state) {
    this.state = state;
    this.topics = new Map(); // topic -> Set<WebSocket>
    this.subs = new Map();   // ws -> Set<topic>
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.subs.set(server, new Set());
    server.addEventListener("message", (e) => this.onMessage(server, e.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch { this.onClose(ws); } }
  onMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "subscribe":
        for (const t of msg.topics ?? []) {
          if (!this.topics.has(t)) this.topics.set(t, new Set());
          this.topics.get(t).add(ws); this.subs.get(ws)?.add(t);
        }
        break;
      case "unsubscribe":
        for (const t of msg.topics ?? []) { this.topics.get(t)?.delete(ws); this.subs.get(ws)?.delete(t); }
        break;
      case "publish": {
        const set = this.topics.get(msg.topic);
        if (set) { msg.clients = set.size; for (const peer of set) this.send(peer, msg); }
        break;
      }
      case "ping": this.send(ws, { type: "pong" }); break;
    }
  }
  onClose(ws) {
    for (const t of this.subs.get(ws) ?? []) { const set = this.topics.get(t); set?.delete(ws); if (set && set.size === 0) this.topics.delete(t); }
    this.subs.delete(ws);
  }
}
