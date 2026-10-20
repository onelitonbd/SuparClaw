import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "After refresh the messages vanish" — the storage/history/refresh chain.
// The root cause was a rename contract mismatch: the UI sent {sessionKey,
// newKey} and the server read {id, name}, so every rename was a silent no-op
// and the UI's localStorage then pointed at a brand-new empty session. These
// tests pin the whole chain: persist → rename key → history follows the rows.

const SC = join(process.cwd(), "dist", "sc.js");

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next candidate */ }
  }
  return process.cwd();
})();

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

function startMockProvider(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1", object: "model" }] }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "remembered answer" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const wsClient = async (url) => {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const frames = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.pred(frame)) { waiters.splice(i, 1); w.resolve(frame); }
    }
  });
  return {
    ws,
    frames,
    send(obj) { ws.send(JSON.stringify(obj)); },
    request(method, params = {}) {
      const id = `r${Math.random().toString(36).slice(2)}`;
      this.send({ type: "req", id, method, params });
      return this.wait((f) => f.type === "res" && f.id === id);
    },
    wait(pred, ms = 8000) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ws frame; saw: ${JSON.stringify(frames.slice(-8))}`)),
          ms,
        );
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
};

test("history survives rename and refresh — the messages-vanish regression", async (t) => {
  const mockPort = await freePort();
  const mock = await startMockProvider(mockPort);
  t.after(() => mock.close());

  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-history-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };

  assert.equal((await new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, "init"], { env });
    p.on("close", resolve);
  })), 0);

  const set = (path, value) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, "config", "set", path, String(value)], { env });
      p.on("close", resolve);
    });
  await set("gateway.port", String(port));
  await set("providers.mock", JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", models: ["m1"] }));
  await set("agents.defaults.model", "mock/m1");

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await fetch(`http://127.0.0.1:${port}/health`); up = true; } catch { /* retry */ }
  }
  assert.ok(up, "gateway up");

  const ws = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.ws.close());
  ws.send({ type: "connect", params: { token: "" } });
  await ws.wait((f) => f.type === "hello-ok");

  // ── 1. persist a turn under a named session
  const sessionKey = "main:old-name";
  await ws.request("chat.send", { sessionKey, text: "remember me", isMainSession: true, key: "h1" });
  await ws.wait((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final");

  let hist = await ws.request("chat.history", { sessionKey, limit: 60 });
  assert.equal(hist.payload.messages.length, 2, "turn persisted (user + assistant)");

  // ── 2. rename the session KEY the way the web UI does
  const renamed = await ws.request("sessions.rename", { sessionKey, newKey: "main:new-name" });
  assert.equal(renamed.ok, true, `rename succeeds: ${JSON.stringify(renamed)}`);
  assert.equal(renamed.payload.sessionKey, "main:new-name");

  // ── 3. THE VANISH BUG: history must follow the renamed session. This is
  //       exactly what the UI fetches after a refresh (localStorage holds the
  //       NEW key) — it used to come back empty because the rename no-op'd.
  hist = await ws.request("chat.history", { sessionKey: "main:new-name", limit: 60 });
  assert.equal(hist.payload.messages.length, 2, "messages follow the renamed session — nothing vanishes");
  assert.match(String(hist.payload.messages[0].content), /remember me/);

  // the old key is gone (no orphaned empty session pretending to be it)
  hist = await ws.request("chat.history", { sessionKey: "main:old-name", limit: 60 });
  assert.equal(hist.payload.messages.length, 0, "old key no longer holds the thread");

  const list = await ws.request("sessions.list", { limit: 20 });
  const keys = (list.payload.sessions ?? []).map((s) => s.key);
  assert.ok(keys.includes("main:new-name"), `sidebar sees the renamed session: ${JSON.stringify(keys)}`);
  assert.ok(!keys.includes("main:old-name"), "old key is not in the sidebar");

  // ── 4. renames are honest: collisions and unknown sessions error out
  await ws.request("chat.send", { sessionKey: "main:other", text: "x", key: "h2" });
  const collision = await ws.request("sessions.rename", { sessionKey: "main:other", newKey: "main:new-name" });
  assert.equal(collision.ok, false, "renaming onto an existing key is rejected");
  assert.match(String(collision.error?.message ?? ""), /already exists/);
  const missing = await ws.request("sessions.rename", { sessionKey: "main:nope", newKey: "main:whatever" });
  assert.equal(missing.ok, false, "renaming an unknown session is rejected");

  // ── 5. a fresh connection (browser refresh) still sees the full thread
  const ws2 = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws2.ws.close());
  ws2.send({ type: "connect", params: { token: "" } });
  await ws2.wait((f) => f.type === "hello-ok");
  hist = await ws2.request("chat.history", { sessionKey: "main:new-name", limit: 60 });
  assert.equal(hist.payload.messages.length, 2, "a refreshed page gets the same thread back");
});
