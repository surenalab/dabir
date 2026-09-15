// Dabir's meeting point for live sessions, as a Cloudflare Worker with one Durable Object.
//
// It does two small things and never sees a paper:
//   wss://<host>/          y-webrtc signalling: peers in the same room find each other here, then the
//                          text travels between their machines, encrypted with the key in the link.
//   https://<host>/ice     the ICE servers a peer should use: public STUN, plus short-lived TURN
//                          credentials from Cloudflare when the worker has a TURN key, so machines
//                          behind university and corporate firewalls that block peer traffic still
//                          connect (TURN carries the encrypted packets and cannot read them).
//
// The free tier is enough: a join is a handful of messages, editing costs the worker nothing.
//
// Deploy (from the repository root, once `npx wrangler login` has run):
//   npx wrangler deploy --config relay/wrangler.toml
// TURN, optional: create a TURN key at dash.cloudflare.com › Realtime › TURN, then
//   npx wrangler secret put TURN_KEY_ID  --config relay/wrangler.toml
//   npx wrangler secret put TURN_API_TOKEN --config relay/wrangler.toml
// Dabir's default is wss://signal.surenalab.com (a custom domain on this worker; the workers.dev address is
// off). A lab running its own puts the address in Settings › Meeting point.

const STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/ice") return ice(env);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("dabir signalling: wss:// for peers, /ice for ICE servers", { status: 200, headers: { ...CORS, "Content-Type": "text/plain" } });
    }
    const id = env.ROOMS.idFromName("global");
    return env.ROOMS.get(id).fetch(request);
  },
};

/** ICE servers for one peer: STUN always; TURN with credentials good for a day when a key is configured. */
async function ice(env) {
  const servers = [{ urls: STUN }];
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (r.ok) {
        const body = await r.json();
        for (const s of body.iceServers ?? []) servers.push(s);
      }
    } catch { /* STUN only */ }
  }
  return new Response(JSON.stringify({ iceServers: servers }), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

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
