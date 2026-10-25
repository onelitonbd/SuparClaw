import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The model pipeline end to end: provider adding (with live discovery), model
// fetching (`sc models --refresh`, WS models.list refresh), model loading
// (resolve + per-run override), and model-ref strictness on config writes —
// the OpenClaw `config set` contract. Regression tests for the gaps found in
// the audit: dead post-add fetching, UI provider form skipping discovery, and
// config accepting unresolvable model refs.

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

// A mock provider whose /models listing is mutable and whose chat replies echo
// the model they were called with — so model loading is observable.
function startMockProvider(port, state) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? "").endsWith("/models")) {
        if (state.failModels) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: state.models.map((id) => ({ id, object: "model" })) }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let chosen = "?";
        try { chosen = JSON.parse(body).model ?? "?"; } catch { /* raw body */ }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `I am ${chosen}.` } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const makeEnv = (home) => ({ ...process.env, SUPARCLAW_HOME: home });

const run = (env, args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, ...args], { env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });

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
          () => reject(new Error(`timed out waiting for ws frame; saw: ${JSON.stringify(frames.slice(-10))}`)),
          ms,
        );
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
};

test("provider adding + model fetching: discovery, refresh, persistence", async (t) => {
  const state = { models: ["m1", "m2"], failModels: false };
  const mockPort = await freePort();
  const mock = await startMockProvider(mockPort, state);
  t.after(() => mock.close());

  const home = mkdtempSync(join(TEST_TMP, "sc-models-"));
  const env = makeEnv(home);
  const base = `http://127.0.0.1:${mockPort}/v1`;

  assert.equal((await run(env, ["init"])).code, 0);

  // ── 1. sc provider add discovers the live list (async harness — a sync
  //       spawn would starve the mock's event loop and fake a discovery fail)
  const add = await run(env, ["provider", "add", "mock", "--base-url", base, "--api-key", "x"]);
  assert.equal(add.code, 0, `provider add: ${add.out}`);
  assert.match(add.out, /discovered 2 models/, "provider add fetches and reports the model list");
  const saved = await run(env, ["config", "get", "providers.mock.models"]);
  assert.match(saved.stdout, /"m1"/, "discovered models are persisted");
  assert.match(saved.stdout, /"m2"/, "discovered models are persisted");

  // ── 2. model refs are validated on write (OpenClaw's config set contract).
  //       Two providers configured, so a bogus ref cannot fall through the
  //       "one provider = whole ref is a bare model id" rule.
  await run(env, ["config", "set", "providers.other", JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "", models: ["z1"] })]);
  const bogus = await run(env, ["config", "set", "agents.defaults.model", "totally/bogus"]);
  assert.equal(bogus.code, 1, `unresolvable model ref is rejected: ${bogus.out}`);
  assert.match(bogus.out, /invalid model reference/);
  const good = await run(env, ["config", "set", "agents.defaults.model", "mock/m1"]);
  assert.equal(good.code, 0, `resolvable ref accepted: ${good.out}`);
  const badFb = await run(env, ["config", "set", "agents.defaults.fallbacks", '["nope/x"]']);
  assert.equal(badFb.code, 1, "unresolvable fallback is rejected");
  const goodFb = await run(env, ["config", "set", "agents.defaults.fallbacks", '["mock/m2"]']);
  assert.equal(goodFb.code, 0, `resolvable fallback accepted: ${goodFb.out}`);

  // ── 3. sc models --refresh picks up provider-side additions and persists
  state.models = ["m1", "m2", "m3"];
  const stale = await run(env, ["models"]);
  assert.ok(stale.stdout.includes("mock/m1"), `sc models lists saved rows: ${stale.stdout}`);
  const refresh = await run(env, ["models", "--refresh"]);
  assert.match(refresh.stdout, /mock\/m3/, "refresh fetches the provider's current list");
  const persisted = await run(env, ["config", "get", "providers.mock.models"]);
  assert.match(persisted.stdout, /"m3"/, "fetched models are persisted for every surface");

  // ── 4. escape hatch: with zero providers, refs cannot be verified yet
  const home2 = mkdtempSync(join(TEST_TMP, "sc-models-empty-"));
  const env2 = makeEnv(home2);
  await run(env2, ["init"]);
  const early = await run(env2, ["config", "set", "agents.defaults.model", "later/provider-model"]);
  assert.equal(early.code, 0, "refs are allowed before any provider exists");
});

test("gateway model pipeline: UI provider parity, strictness, loading, fetch warnings", async (t) => {
  const state = { models: ["m1", "m2", "m3"], failModels: false };
  const mockPort = await freePort();
  const mock = await startMockProvider(mockPort, state);
  t.after(() => mock.close());

  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-models-gw-"));
  const env = makeEnv(home);
  const base = `http://127.0.0.1:${mockPort}/v1`;

  assert.equal((await run(env, ["init"])).code, 0);
  await run(env, ["config", "set", "gateway.port", String(port)]);
  await run(env, ["provider", "add", "mock", "--base-url", base, "--api-key", "x"]);
  await run(env, ["config", "set", "agents.defaults.model", "mock/m1"]);

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let gwLog = "";
  gw.stdout.on("data", (c) => (gwLog += c));
  gw.stderr.on("data", (c) => (gwLog += c));

  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await fetch(`http://127.0.0.1:${port}/health`); up = true; } catch { /* retry */ }
  }
  assert.ok(up, `gateway never came up:\n${gwLog}`);

  const ws = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.ws.close());
  ws.send({ type: "connect", params: { token: "" } });
  await ws.wait((f) => f.type === "hello-ok");

  // ── 1. models.list serves the configured/discovered inventory
  let f = await ws.request("models.list");
  for (const m of ["mock/m1", "mock/m2", "mock/m3"]) {
    assert.ok((f.payload.models ?? []).includes(m), `models.list serves ${m}: ${JSON.stringify(f.payload.models)}`);
  }

  // ── 2. UI-parity: providers.add with an EMPTY models field discovers them
  //       (the web UI form used to save an empty list and show an empty picker)
  f = await ws.request("providers.add", { name: "uiprov", baseUrl: base, apiKey: "y", models: [] });
  assert.equal(f.ok, true, `providers.add: ${JSON.stringify(f)}`);
  assert.match(String(f.payload.message ?? ""), /discovered 3 models/, "gateway-side add discovers models");
  f = await ws.request("models.list");
  for (const m of ["uiprov/m1", "uiprov/m2", "uiprov/m3"]) {
    assert.ok((f.payload.models ?? []).includes(m), `picker shows ${m} after UI-style add`);
  }

  // ── 3. strictness over the wire (res frames carry ok:false + error.code)
  f = await ws.request("config.set", { path: "agents.defaults.model", value: "nonsense/xyz" });
  assert.equal(f.ok, false, "WS config.set rejects unresolvable model refs");
  assert.equal(f.error?.code, "bad_model", `error code is bad_model: ${JSON.stringify(f)}`);
  f = await ws.request("config.set", { path: "agents.defaults.model", value: "uiprov/m2" });
  assert.equal(f.ok, true, `resolvable ref accepted: ${JSON.stringify(f)}`);

  // ── 4. model loading: per-run override routes to the right provider/model
  f = await ws.request("chat.send", { sessionKey: "main:main", text: "hi", model: "mock/m3", key: `ml-${Date.now()}` });
  assert.equal(f.ok, true, `chat.send: ${JSON.stringify(f)}`);
  const reply = await ws.wait((x) => x.type === "event" && x.event === "chat" && x.payload?.event?.type === "final");
  assert.equal(String(reply.payload.event.text ?? ""), "I am m3.", "per-run model override is honored");

  // ── 5. providers.test + providers.remove (shared implementation)
  f = await ws.request("providers.test", { name: "uiprov" });
  assert.equal(f.payload.ok, true, `providers.test: ${JSON.stringify(f.payload)}`);
  f = await ws.request("providers.remove", { name: "uiprov" });
  assert.equal(f.ok, true, `providers.remove: ${JSON.stringify(f)}`);
  f = await ws.request("models.list");
  assert.ok(!(f.payload.models ?? []).some((m) => m.startsWith("uiprov/")), "removed provider leaves the picker");

  // ── 5b. Remove is a delete, not a hide: the provider's stored credentials go
  //        too (they live in the state DB, so config alone would not touch
  //        them — and re-adding the provider used to resurrect them silently).
  f = await ws.request("models.auth.addKey", { provider: "openrouter", key: "sk-test-1234", method: "api-key" });
  assert.equal(f.ok, true, `models.auth.addKey: ${JSON.stringify(f)}`);
  const boundKey = String(f.payload.profile ?? "");
  f = await ws.request("models.auth.list", { provider: "openrouter" });
  assert.ok((f.payload.profiles ?? []).some((x) => x.id === boundKey), "the credential is stored");

  f = await ws.request("providers.remove", { name: "openrouter", purgeAuth: true });
  assert.equal(f.ok, true, `providers.remove purgeAuth: ${JSON.stringify(f)}`);
  assert.match(String(f.payload.message ?? ""), /credential/, "the delete reports what it removed");
  f = await ws.request("models.auth.list", { provider: "openrouter" });
  assert.deepEqual(f.payload.profiles ?? [], [], "the credential does not outlive the provider");

  // ── 5c. A rename drops the old record through the same call, so it must NOT
  //        take the credentials with it.
  f = await ws.request("models.auth.addKey", { provider: "openrouter", key: "sk-test-1234", method: "api-key" });
  const renameKey = String(f.payload.profile ?? "");
  f = await ws.request("providers.add", { name: "or2", previousName: "openrouter", baseUrl: base, apiKey: "" });
  assert.equal(f.ok, true, `rename via providers.add: ${JSON.stringify(f)}`);
  f = await ws.request("providers.remove", { name: "openrouter" });
  assert.equal(f.ok, true);
  f = await ws.request("models.auth.list", { provider: "openrouter" });
  assert.ok((f.payload.profiles ?? []).some((x) => x.id === renameKey), "a rename keeps the stored credential");

  // ── 6. failed refresh keeps saved rows and reports a warning
  state.failModels = true;
  f = await ws.request("models.list", { refresh: true });
  assert.ok((f.payload.models ?? []).some((m) => m.startsWith("mock/")), "failed refresh preserves saved rows");
  assert.match(String(f.payload.warning ?? ""), /saved rows shown/, "failed refresh reports a warning");
  state.failModels = false;
});
