import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots the real gateway against a mock OpenAI-compatible provider and walks the
// exact WebSocket contract the Control UI (ui/src/main.ts) depends on. If this
// passes, the web UI can render a full streamed turn without surprises.

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

const CHUNKS = ["Hello ", "from ", "the ", "mock ", "provider."];

function startMockProvider(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
        const tick = () => {
          if (i < CHUNKS.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: CHUNKS[i] } }] })}\n\n`);
            i += 1;
            setTimeout(tick, 8);
          } else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } })}\n\ndata: [DONE]\n\n`);
            res.end();
          }
        };
        tick();
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("gateway ws contract matches what the Control UI expects", async (t) => {
  const { WebSocket } = await import("ws");

  const port = await freePort();
  const mockPort = await freePort();
  const mock = await startMockProvider(mockPort);
  t.after(() => mock.close());

  const home = mkdtempSync(join(TEST_TMP, "sc-uicontract-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });

  assert.equal((await run(["init"])).code, 0, "sc init succeeds");
  await run(["config", "set", "gateway.port", String(port)]);
  await run(["config", "set", "agents.defaults.model", "mock/m1"]);
  await run([
    "config", "set", "providers.mock",
    JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", models: ["m1"] }),
  ]);

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let gwLog = "";
  gw.stdout.on("data", (c) => (gwLog += c));
  gw.stderr.on("data", (c) => (gwLog += c));

  let healthy = null;
  // Generous: the suite runs files in parallel and a cold spawn can be slow.
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); break; } catch { /* retry */ }
  }
  assert.ok(healthy, `gateway never became healthy:\n${gwLog}`);
  assert.equal(healthy.ok, true);

  // Static assets the UI needs are served from dist/ui
  for (const [path, type] of [
    ["/", "text/html"],
    ["/app.js", "text/javascript"],
    ["/styles.css", "text/css"],
    ["/interior/settings.html", "text/html"],
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200, `${path} served`);
    assert.match(res.headers.get("content-type") ?? "", new RegExp(type), `${path} content-type`);
    const body = await res.text();
    assert.ok(body.length > 100, `${path} has content`);
  }
  const shell = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(shell, /app\.js/, "index.html references the app bundle");
  const settingsInterior = await fetch(`http://127.0.0.1:${port}/interior/settings.html`).then((r) => r.text());
  for (const id of [
    "settings-menu", "settings-back", "settings-sidebar", "settings-search", "settings-nav",
    "settings-scrim", "settings-group", "settings-title", "settings-description", "settings-body",
    "settings-connection", "settings-connection-label",
  ]) {
    assert.match(settingsInterior, new RegExp(`id="${id}"`), `Settings interior includes #${id}`);
  }
  assert.match(settingsInterior, /aria-describedby="settings-description"/);
  assert.match(settingsInterior, /role="status" aria-live="polite"/);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "event") events.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.pred(frame)) { waiters.splice(i, 1); w.resolve(frame); }
    }
  });
  t.after(() => { try { ws.close(); } catch { /* already closed */ } });

  const waitFrame = (pred, ms = 60000) => // generous: the gateway may be cold-spawning under parallel test load
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for frame (after ${ms}ms)\n${new Error().stack}`)), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });

  const request = (method, params = {}) => {
    const id = "t" + Math.random().toString(36).slice(2);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return waitFrame((f) => f.type === "res" && f.id === id).then((f) => {
      if (!f.ok) throw new Error(f.error?.message ?? `${method} failed`);
      return f.payload;
    });
  };

  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  ws.send(JSON.stringify({ type: "connect", params: {} }));
  const hello = await waitFrame((f) => f.type === "hello-ok");
  assert.ok(hello.payload.version, "hello-ok carries a version");
  assert.ok(hello.payload.methods.includes("config.set"), "config.set is advertised");

  // metadata the header/sidebar render
  const status = await request("status");
  assert.equal(status.model, "mock/m1");
  assert.ok(Array.isArray(status.tools) && status.tools.length > 0, "tools listed");
  const modelList = await request("models.list");
  assert.deepEqual(modelList.models, ["mock/m1"]);
  const sessions = await request("sessions.list", { limit: 10 });
  assert.ok(Array.isArray(sessions.sessions), "sessions.list returns sessions");

  // config writes from the UI take effect live
  await request("config.set", { path: "agents.defaults.model", value: "mock/m1" });
  await request("config.set", {
    path: "providers.second",
    value: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "y", models: ["m2"] },
  });
  const models2 = await request("models.list");
  assert.ok(models2.models.includes("second/m2"), "provider added via config.set shows up in models.list");

  // one full streamed turn, on the envelope the UI listens for
  const sessionKey = "main:ui-contract";
  const sent = await request("chat.send", { sessionKey, text: "hi", isMainSession: true });
  assert.equal(sent.accepted, true);

  await waitFrame((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final");
  // idle arrives just after final; wait for it so the assertion is not a race
  await waitFrame((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "idle");
  const kinds = events.filter((e) => e.event === "chat").map((e) => e.payload.event.type);
  for (const want of ["start", "delta", "final", "idle"]) {
    assert.ok(kinds.includes(want), `"${want}" is broadcast`);
  }
  const final = events.find((e) => e.event === "chat" && e.payload.event.type === "final");
  assert.equal(final.payload.event.text, "Hello from the mock provider.");
  assert.equal(final.payload.sessionKey, sessionKey, "events carry the session key");
  const delta = events.find((e) => e.event === "chat" && e.payload.event.type === "delta");
  assert.equal(typeof delta.payload.event.text, "string", "delta carries text");
  // single stream contract: one final per run, zero legacy duplicate frames
  const finals = events.filter((e) => e.event === "chat" && e.payload.event.type === "final");
  assert.equal(finals.length, 1, "exactly one final per run (duplicate bubbles regression)");
  const legacy = events.filter((e) => ["chat.delta", "chat.reply", "chat.tool", "chat.approval"].includes(e.event));
  assert.equal(legacy.length, 0, `legacy per-event frames are gone: ${JSON.stringify(legacy.map((e) => e.event))}`);

  const history = await request("chat.history", { sessionKey, limit: 10 });
  const roles = history.messages.map((m) => m.role);
  assert.ok(roles.includes("user") && roles.includes("assistant"), "history holds both roles");

  // abort is available to the Esc key / Stop button
  const aborted = await request("chat.abort", { sessionKey });
  assert.equal(typeof aborted.aborted, "boolean", "chat.abort responds");
});
