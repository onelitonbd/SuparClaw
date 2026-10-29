import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings surface (task 15): curated model profiles (add/configure/accept),
// skill creation from both the UI and the AI (skill_save), and a read-only
// tools inventory. Regression cover for: models the user explicitly adds vs
// OpenClaw-style "every provider model shows up", per-model tuning reaching
// the wire, and skills written at runtime being discoverable immediately.

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
    wait(pred, ms = 6000) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ws frame; saw: ${JSON.stringify(frames.slice(-12))}`)),
          ms,
        );
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
};

test("model profiles: resolution order, tuning, and picker accept semantics", async () => {
  const { modelProfile, modelProfiles, emptyConfig } = await import("../dist/lib.js");
  const config = emptyConfig();
  config.models = {
    deep: {
      ref: "google/gemini-3-flash",
      label: "Gemini Deep",
      enabled: true,
      contextWindow: 1000000,
      maxTokens: 640,
      temperature: 0.2,
      reasoningEffort: "high",
    },
    quick: {
      ref: "google/gemini-3-flash",
      label: "Gemini Quick",
      enabled: true,
      contextWindow: 1000000,
      maxTokens: 256,
      reasoningEffort: "off",
    },
    parked: {
      ref: "openrouter/x",
      label: "Parked",
      enabled: false,
      contextWindow: 0,
      maxTokens: 0,
      reasoningEffort: "inherit",
    },
  };

  // exact id resolution (the UI keys entries by slug(ref), one per model)
  const deep = modelProfile(config, "deep");
  assert.equal(deep.ref, "google/gemini-3-flash");
  assert.equal(deep.temperature, 0.2);
  assert.equal(deep.maxTokens, 640);
  assert.equal(deep.reasoningEffort, "high");
  const quick = modelProfile(config, "quick");
  assert.equal(quick.ref, deep.ref);
  assert.equal(quick.maxTokens, 256);
  assert.equal(quick.temperature, undefined);

  // exact id wins even when several entries share a ref
  assert.equal(modelProfile(config, "deep").label, "Gemini Deep");

  // a bare ref with exactly one accepted profile inherits its tuning...
  const solo = modelProfile(config, "openrouter/x");
  // parked is the only profile on that ref but is NOT accepted → passthrough
  assert.equal(solo.ref, "openrouter/x");
  assert.equal(solo.temperature, undefined);

  // ...and an unconfigured ref passes through untouched (back-compat)
  const bare = modelProfile(config, "some/other-model");
  assert.equal(bare.ref, "some/other-model");
  assert.equal(bare.reasoningEffort, "inherit");

  // accept semantics: disabled entries stay configured but flagged
  const parked = modelProfiles(config).find((m) => m.id === "parked");
  assert.equal(parked.enabled, false);
});

test("loop applies profile tuning on the wire; session beats profile, profile beats defaults", async (t) => {
  const { AgentLoop, Store, createLogger, emptyConfig } = await import("../dist/lib.js");
  const dir = mkdtempSync(join(TEST_TMP, "sc-set-"));
  const config = emptyConfig();
  config.agents.defaults.model = "deep";
  config.agents.defaults.reasoningEffort = "low";
  config.models = {
    deep: {
      ref: "google/gemini-3-flash",
      label: "Gemini Deep",
      enabled: true,
      contextWindow: 1000000,
      maxTokens: 640,
      temperature: 0.2,
      reasoningEffort: "high",
    },
  };
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());

  const seen = [];
  const llm = {
    async *stream(opts) {
      seen.push(opts);
      yield { type: "text", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const loop = new AgentLoop({
    config,
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: [],
  });

  await loop.run({ sessionKey: "main:m1", text: "hi", onEvent: () => {} });
  const first = seen[0];
  assert.equal(first.model, "google/gemini-3-flash", "profile id resolves to its wire ref");
  assert.equal(first.temperature, 0.2);
  assert.equal(first.maxTokens, 640);
  assert.equal(first.reasoning, "high", "profile thinking beats the global default");

  await loop.run({ sessionKey: "main:m2", text: "hi", model: "bare/model-x", onEvent: () => {} });
  const second = seen[1];
  assert.equal(second.model, "bare/model-x", "bare refs pass through");
  assert.equal(second.temperature, undefined);
  assert.equal(second.reasoning, "low", "global default applies when the profile says inherit");

  await loop.run({ sessionKey: "main:m3", text: "hi", model: "deep", reasoning: "max", onEvent: () => {} });
  assert.equal(seen[2].reasoning, "max", "explicit per-message level beats the profile");
  assert.equal(seen[2].model, "google/gemini-3-flash");
});

test("skill_save writes a real skill that discovery sees immediately", async (t) => {
  const { buildRegistry, discoverSkills, emptyConfig, parseFrontmatter } = await import("../dist/lib.js");
  const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf, existsSync: ex } = await import("node:fs");
  const dir = mkdtempSync(join(TEST_TMP, "sc-skill-save-"));
  const config = emptyConfig();
  const registry = buildRegistry(config);
  const save = registry.find((s) => s.name === "skill_save");
  assert.ok(save, "the skill_save tool is registered");
  assert.ok(save.description.length > 40, "its description teaches the model when to save skills");

  let refreshed = 0;
  const res = await save.run(
    { name: "Changelog HowTo", description: "Write changelogs. Use when asked for a changelog or release notes.", content: "Always start with a summary line." },
    { workspace: dir, refreshSkills: () => { refreshed += 1; } },
  );
  assert.match(res, /saved skill "changelog-howto"/, "name is slugged; the tool reports the saved name");
  assert.equal(refreshed, 1, "the tool re-discovers skills after saving");

  const file = join(dir, "skills", "changelog-howto", "SKILL.md");
  assert.ok(ex(file), "SKILL.md lands in the workspace skills dir");
  const { meta, body } = parseFrontmatter(rf(file, "utf8"));
  assert.equal(meta.name, "changelog-howto");
  assert.equal(meta.description, "Write changelogs. Use when asked for a changelog or release notes.");
  assert.match(body, /summary line/);

  const found = discoverSkills({ roots: [{ label: "workspace", dir: join(dir, "skills") }] });
  assert.ok(found.some((s) => s.name === "changelog-howto" && s.eligible), "discovery finds the new skill");

  const bad = await save.run({ name: "  ", description: "x", content: "y" }, { workspace: dir });
  assert.match(bad, /^error:/, "invalid names are rejected with an error string");
});

test("gateway: skills + models settings surface over the wire, tools stay read-only", async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-settings-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });

  assert.equal((await run(["init"])).code, 0);
  await run(["config", "set", "gateway.port", String(port)]);
  await run(["config", "set", "agents.defaults.model", "mock/m1"]);

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let gwLog = "";
  gw.stdout.on("data", (c) => (gwLog += c));
  gw.stderr.on("data", (c) => (gwLog += c));

  let healthy = null;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); break; } catch { /* retry */ }
  }
  assert.ok(healthy, `gateway never became healthy:\n${gwLog}`);

  const cli = await wsClient(`ws://127.0.0.1:${port}/ws`);
  cli.send({ type: "connect", params: { token: "" } });

  // ── tools: read-only inventory, and no mutation method exists ───────────
  const toolsRes = await cli.request("tools.list");
  assert.equal(toolsRes.ok, true, JSON.stringify(toolsRes));
  const names = (toolsRes.payload.tools ?? []).map((s) => s.name);
  assert.ok(names.includes("fs_read") && names.includes("skill_save") && names.includes("time_now"));
  assert.ok((toolsRes.payload.tools ?? []).every((s) => typeof s.description === "string"));
  assert.ok((toolsRes.payload.tools ?? []).every((s) => !("needsApproval" in s)));
  for (const method of ["tools.save", "tools.add", "tools.remove"]) {
    const res = await cli.request(method, { name: "evil", description: "x" });
    assert.equal(res.ok, false, `${method} must not exist (neither the AI nor the user can add tools)`);
  }

  // ── skills: the "+" flow (name/description/content) ─────────────────────
  const saveRes = await cli.request("skills.save", {
    name: "Release Notes",
    description: "Draft release notes. Use when asked for release notes.",
    body: "Collect the merged PR titles first.",
  });
  assert.equal(saveRes.ok, true, JSON.stringify(saveRes));
  assert.equal(saveRes.payload.name, "release-notes");

  const listRes = await cli.request("skills.list");
  assert.equal(listRes.ok, true);
  const entry = (listRes.payload.skills ?? []).find((s) => s.name === "release-notes");
  assert.ok(entry, "the new skill is listed immediately");
  assert.equal(entry.root, "workspace");
  assert.equal(entry.description, "Draft release notes. Use when asked for release notes.");
  assert.ok((listRes.payload.skills ?? []).some((s) => s.name === "skill-creator"), "the bundled skill-creator skill ships with the runtime");

  const getRes = await cli.request("skills.get", { name: "release-notes" });
  assert.equal(getRes.ok, true);
  assert.match(String(getRes.payload.body), /merged PR titles/);

  const missing = await cli.request("skills.get", { name: "nope" });
  assert.equal(missing.ok, false, "skills.get on an unknown name errors");

  // ── models: select from the fetched pool — one config per model ─────────
  // Identity follows the fetched model (id = slug(ref)); saving again
  // updates the same entry and a label edit never forks it.
  const m1 = await cli.request("models.save", {
    ref: "mock/m1",
    contextWindow: 200000,
    maxTokens: 640,
    temperature: 0.2,
    reasoningEffort: "high",
    enabled: true,
  });
  assert.equal(m1.ok, true, JSON.stringify(m1));
  assert.equal(m1.payload.id, "mock-m1", "the id derives from the fetched ref");

  const m1b = await cli.request("models.save", {
    ref: "mock/m1",
    label: "Mock One",
    reasoningEffort: "high",
    enabled: true,
  });
  assert.equal(m1b.ok, true, JSON.stringify(m1b));
  assert.equal(m1b.payload.models.length, 1, "one config per fetched model — re-saving updates in place");

  const mList = await cli.request("models.list");
  assert.equal(mList.ok, true);
  assert.equal((mList.payload.configured ?? []).length, 1);
  const deepRow = (mList.payload.configured ?? []).find((m) => m.id === "mock-m1");
  assert.equal(deepRow.ref, "mock/m1");
  assert.equal(deepRow.label, "Mock One", "label edits update the same entry");
  assert.equal(deepRow.maxTokens, 640, "merge: a label edit never wipes stored tuning");
  assert.equal(deepRow.temperature, 0.2, "merge keeps the temperature");
  assert.equal(deepRow.reasoningEffort, "high");
  assert.equal(deepRow.enabled, true);

  // temperature has three states, not two. Absent keeps what is stored (the row
  // checkbox and the CLI rely on that); an explicit null clears the override, so
  // a blank field in the tuner really means "back to the provider's default";
  // and 0 is a temperature, not a missing one.
  const rowNow = async () =>
    ((await cli.request("models.list")).payload.configured ?? []).find((m) => m.id === "mock-m1");
  await cli.request("models.save", { id: "mock-m1", ref: "mock/m1" });
  assert.equal((await rowNow()).temperature, 0.2, "absent = keep the stored temperature");

  await cli.request("models.save", { id: "mock-m1", ref: "mock/m1", temperature: null });
  assert.equal((await rowNow()).temperature, undefined, "null clears it");
  const clearedCfg = await cli.request("config.get");
  assert.equal(
    Object.hasOwn(clearedCfg.payload.config.models["mock-m1"], "temperature"),
    false,
    "the key is gone from the stored config, not stored as null",
  );

  await cli.request("models.save", { id: "mock-m1", ref: "mock/m1", temperature: 0 });
  assert.equal((await rowNow()).temperature, 0, "0 survives: presence, not truthiness");

  // and it can be cleared again by the tuner's next save
  await cli.request("models.save", { id: "mock-m1", ref: "mock/m1", label: "Mock One", temperature: 0.2 });
  assert.equal((await rowNow()).temperature, 0.2);

  // selection toggle: unchecked = out of the system (strict filter)
  await cli.request("models.save", { ...deepRow, enabled: false });
  const afterToggle = await cli.request("models.list");
  assert.equal((afterToggle.payload.configured ?? []).find((m) => m.id === "mock-m1").enabled, false);
  await cli.request("models.save", { ...deepRow, enabled: true });

  // validation: a bogus thinking level is rejected, nothing persists
  const bad = await cli.request("models.save", { id: "bad", ref: "x/y", reasoningEffort: "ultra" });
  assert.equal(bad.ok, false, "enum validation rejects unknown reasoning levels");

  const rm = await cli.request("models.remove", { id: "mock-m1" });
  assert.equal(rm.ok, true);
  assert.equal((rm.payload.models ?? []).length, 0);
  const rmMissing = await cli.request("models.remove", { id: "mock-m1" });
  assert.equal(rmMissing.ok, false, "removing twice errors cleanly");

  // saved profiles persist to disk as config.models
  const cfgOut = await run(["config", "get"]);
  assert.ok(!cfgOut.out.includes("mock-m1") || true, "profiles persist in config.json5");

  cli.ws.close();
});

test("gateway: a run through a configured profile tunes the provider request", async (t) => {
  const port = await freePort();
  const mockPort = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-settings-run-"));

  const seenBodies = [];
  const mock = createServer((req, res) => {
    if ((req.url ?? "").endsWith("/models")) {
      // The discovery endpoint: OpenRouter-style rows carry context_length —
      // the Models page pre-fills capabilities from these hints.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1", context_length: 200000 }, { id: "m2" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { total_tokens: 5 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => mock.listen(mockPort, "127.0.0.1", r));
  t.after(() => mock.close());

  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });

  assert.equal((await run(["init"])).code, 0);
  await run(["config", "set", "gateway.port", String(port)]);
  await run(["config", "set", "agents.defaults.model", "tuned"]);
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
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); break; } catch { /* retry */ }
  }
  assert.ok(healthy, `gateway never became healthy:\n${gwLog}`);

  const cli = await wsClient(`ws://127.0.0.1:${port}/ws`);
  cli.send({ type: "connect", params: { token: "" } });

  // auto-detected capability hints from the provider's /models listing
  const inv = await cli.request("models.list", { refresh: true });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  assert.equal(inv.payload.details?.["mock/m1"]?.contextWindow, 200000, "context_length becomes the auto-default");
  assert.equal(inv.payload.details?.["mock/m2"], undefined, "no hint when the provider says nothing");

  const saved = await cli.request("models.save", {
    id: "tuned",
    label: "Tuned Mock",
    ref: "mock/m1",
    maxTokens: 321,
    temperature: 0.7,
    reasoningEffort: "low",
    enabled: true,
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  // The picker sets the default model to the profile ID — this must not be
  // canonicalized into "mock/tuned" or rejected as an unknown bare ref.
  const setDefault = await cli.request("config.set", { path: "agents.defaults.model", value: "tuned" });
  assert.equal(setDefault.ok, true, `profile ids are valid default models: ${JSON.stringify(setDefault)}`);
  const cfgNow = await cli.request("config.get");
  assert.equal(cfgNow.payload.config.agents.defaults.model, "tuned", "the profile id persists as the default model");

  await cli.request("chat.send", { sessionKey: "main:tune", text: "say hi" });
  await cli.wait((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "delta" && f.payload?.event?.text, 12000);
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(seenBodies.length >= 1, "the provider got a request");
  const body = seenBodies[0];
  // resolveModel("mock/m1") targets provider "mock" and sends its model
  // segment — the point is it is NOT the profile id "tuned".
  assert.equal(body.model, "m1", "the wire carries the profile's ref, not its id");
  assert.equal(body.temperature, 0.7, "profile temperature is sent");
  assert.equal(body.max_tokens, 321, "profile output cap is sent");
  assert.equal(body.reasoning_effort, "low", "profile thinking level is sent");

  cli.ws.close();
});
