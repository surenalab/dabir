// The signalling worker, tested as plain JavaScript: rooms fan messages out to their subscribers and
// forget sockets that close; /ice answers with STUN alone when no TURN key is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { Rooms } from "../relay/signaling-worker.js";

class FakeSocket {
  sent = [];
  send(s) { this.sent.push(JSON.parse(s)); }
}

test("publish reaches every subscriber of the topic and counts them", () => {
  const rooms = new Rooms({});
  const a = new FakeSocket(), b = new FakeSocket(), c = new FakeSocket();
  for (const ws of [a, b, c]) rooms.subs.set(ws, new Set());
  rooms.onMessage(a, JSON.stringify({ type: "subscribe", topics: ["paper-1"] }));
  rooms.onMessage(b, JSON.stringify({ type: "subscribe", topics: ["paper-1"] }));
  rooms.onMessage(c, JSON.stringify({ type: "subscribe", topics: ["paper-2"] }));
  rooms.onMessage(a, JSON.stringify({ type: "publish", topic: "paper-1", data: "hello" }));
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(c.sent.length, 0);
  assert.equal(b.sent[0].clients, 2);
  assert.equal(b.sent[0].data, "hello");
});

test("a closed socket leaves its topics, and an empty topic is dropped", () => {
  const rooms = new Rooms({});
  const a = new FakeSocket();
  rooms.subs.set(a, new Set());
  rooms.onMessage(a, JSON.stringify({ type: "subscribe", topics: ["t"] }));
  assert.equal(rooms.topics.get("t").size, 1);
  rooms.onClose(a);
  assert.equal(rooms.topics.has("t"), false);
  assert.equal(rooms.subs.has(a), false);
});

test("ping answers pong; garbage is ignored", () => {
  const rooms = new Rooms({});
  const a = new FakeSocket();
  rooms.subs.set(a, new Set());
  rooms.onMessage(a, "not json");
  rooms.onMessage(a, JSON.stringify({ type: "ping" }));
  assert.deepEqual(a.sent, [{ type: "pong" }]);
});

test("/ice is STUN only without a TURN key, with CORS for the app", async () => {
  const r = await worker.fetch(new Request("https://signal.example/ice"), {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await r.json();
  assert.equal(body.iceServers.length, 1);
  assert.ok(body.iceServers[0].urls.every((u) => u.startsWith("stun:")));
});

test("a plain GET explains itself instead of upgrading", async () => {
  const r = await worker.fetch(new Request("https://signal.example/"), {});
  assert.equal(r.status, 200);
  assert.match(await r.text(), /signalling/);
});
