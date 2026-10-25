import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import {
  ConfigService,
  createLogger,
  addProvider,
  removeProvider,
  testProvider,
  formatProviders,
  parseProviderAddArgs,
  maskKey,
  parseBotCommand,
} from "../dist/lib.js";

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return process.cwd();
})();

const log = createLogger({ level: "error" });
const scratchConfig = () => new ConfigService(log, join(mkdtempSync(join(TEST_TMP, "sc-prov-")), "config.json5"));

const serve = (t, handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((r) => server.close(r)));
      resolve(server.address().port);
    });
  });

// --- command parsing (Telegram + wherever else) ---------------------------

test("parseBotCommand accepts group suffixes and rejects ordinary text", () => {
  assert.deepEqual(parseBotCommand("/provider list"), { name: "provider", args: "list" });
  assert.deepEqual(parseCommand_safe("/Model gpt-4o"), { name: "model", args: "gpt-4o" });
  assert.deepEqual(parseBotCommand("/model@my_bot  provider/model"), { name: "model", args: "provider/model" });
  assert.deepEqual(parseBotCommand("/provider add openrouter sk-1  "), { name: "provider", args: "add openrouter sk-1" });
  assert.equal(parseBotCommand("hello"), null);
  assert.equal(parseBotCommand("/"), null);
  assert.equal(parseBotCommand("not /a command"), null);
});

function parseCommand_safe(text) {
  // keeps the assertion readable when the export is renamed
  return parseBotCommand(text);
}

// --- argument parsing shared by TUI and Telegram ---------------------------

test("parseProviderAddArgs lets a preset stand in for the url", () => {
  const presetStyle = parseProviderAddArgs(["openrouter", "sk-or-abc"]);
  assert.equal(presetStyle.name, "openrouter");
  assert.equal(presetStyle.baseUrl, undefined, "no url given: the preset supplies it");
  assert.equal(presetStyle.apiKey, "sk-or-abc");
  assert.equal(parseProviderAddArgs(["openrouter", "sk-or-abc", "m1,m2"]).models.join(","), "m1,m2");
});

test("parseProviderAddArgs recognises an explicit url", () => {
  const explicit = parseProviderAddArgs(["local", "http://127.0.0.1:11434/v1", "key", "a,b"]);
  assert.equal(explicit.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(explicit.apiKey, "key");
  assert.deepEqual(explicit.models, ["a", "b"]);
});

// --- masking --------------------------------------------------------------

test("maskKey never leaks the whole key", () => {
  const long = "sk-or-abcdefghijklmnopqrstuvwxyz0123456789";
  const masked = maskKey(long);
  assert.ok(masked.length < long.length, "output is shorter than the input");
  assert.ok(!masked.includes("abcdefghijklmnopqrstuvwxyz"), "middle of the key is hidden");
  assert.equal(maskKey(""), "(none)");
  assert.equal(maskKey(undefined), "(none)");
  assert.equal(maskKey("shortkey"), "••••");
});

// --- listing --------------------------------------------------------------

test("formatProviders shows the default model and masks keys", () => {
  const cfg = scratchConfig();
  cfg.setPath("providers.mock", { baseUrl: "http://x/v1", apiKey: "super-secret-key-123", models: ["m1"] });
  cfg.setPath("agents.defaults.model", "mock/m1");

  const out = formatProviders(cfg.current);
  assert.match(out, /default model: mock\/m1/);
  assert.match(out, /http:\/\/x\/v1/);
  assert.match(out, /m1/);
  assert.ok(!out.includes("super-secret-key-123"), "the key is masked in listings");

  const empty = scratchConfig();
  assert.match(formatProviders(empty.current), /none yet/);
});

// --- add / remove ---------------------------------------------------------

test("addProvider writes the file, discovers models, and validates the name", async (t) => {
  const port = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
  });

  const cfg = scratchConfig();
  const added = await addProvider(cfg, "Mock", { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" });
  assert.equal(added.ok, true, added.message);
  assert.match(added.message, /discovered 2 models/);

  // written to disk, not just in memory
  assert.ok(existsSync(cfg.path), "config file was created");
  const onDisk = JSON5.parse(readFileSync(cfg.path, "utf8"));
  assert.equal(onDisk.providers.mock.baseUrl, `http://127.0.0.1:${port}/v1`);
  assert.deepEqual(onDisk.providers.mock.models, ["alpha", "beta"], "name is normalised to lowercase");

  const noName = await addProvider(cfg, "  ", { baseUrl: "http://x/v1" });
  assert.equal(noName.ok, false);
  assert.match(noName.message, /name is required/);

  const injection = await addProvider(cfg, "bad name!", { baseUrl: "http://x/v1" });
  assert.equal(injection.ok, false);
  assert.match(injection.message, /only contain/);

  const noUrl = await addProvider(cfg, "unknownpreset", {});
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.message, /base url/);
});

test("addProvider without models and without a reachable endpoint still saves", async (t) => {
  const dead = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const cfg = scratchConfig();
  const result = await addProvider(cfg, "ghost", { baseUrl: `http://127.0.0.1:${dead}/v1`, apiKey: "k" });
  assert.equal(result.ok, true, "a provider is saved even when discovery fails");
  assert.match(result.message, /no models found/);
});

test("removeProvider warns when the default model pointed at it", () => {
  const cfg = scratchConfig();
  cfg.setPath("providers.gone", { baseUrl: "http://x/v1", apiKey: "k", models: ["m"] });
  cfg.setPath("agents.defaults.model", "gone/m");

  const removed = removeProvider(cfg, "gone");
  assert.equal(removed.ok, true);
  assert.match(removed.message, /removed "gone"/);
  assert.match(removed.message, /warning: default model "gone\/m"/);
  assert.equal(cfg.current.providers.gone, undefined);

  const again = removeProvider(cfg, "gone");
  assert.equal(again.ok, false);
  assert.match(again.message, /no such provider/);
});

// --- test -----------------------------------------------------------------

test("testProvider reports both the happy and the unreachable path", async (t) => {
  const port = await serve(t, (req, res) => {
    if (req.headers.authorization !== "Bearer right") {
      res.writeHead(401).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
  });

  const cfg = scratchConfig();
  cfg.setPath("providers.good", { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "right", models: [] });

  const ok = await testProvider(cfg.current, "good");
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /ok — 3 models/);
  assert.match(ok.message, /m1/);

  cfg.setPath("providers.good.apiKey", "wrong");
  const bad = await testProvider(cfg.current, "good");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /401/);

  const missing = await testProvider(cfg.current, "nope");
  assert.equal(missing.ok, false);
  assert.match(missing.message, /no such provider/);
});

// --- delete removes the provider's dependents, not just the record ----------

test("removeProvider takes its saved models, fallbacks and auth order with it", () => {
  const cfg = scratchConfig();
  const profile = (ref) => ({ ref, label: "", enabled: true, contextWindow: 0, maxTokens: 0, reasoningEffort: "inherit" });
  cfg.setPath("providers.mock", { baseUrl: "http://x/v1", apiKey: "k", models: ["m1"] });
  cfg.setPath("providers.other", { baseUrl: "http://y/v1", apiKey: "k", models: ["m2"] });
  cfg.setPath("models.mock-m1", profile("mock/m1"));
  cfg.setPath("models.other-m2", profile("other/m2"));
  // A bare model id has no provider segment: it may belong to anyone, so it stays.
  cfg.setPath("models.bare", profile("m1"));
  cfg.setPath("agents.defaults.fallbacks", ["mock/m1", "other/m2"]);
  cfg.setPath("auth.order", { mock: ["mock:key:1"], other: ["other:key:1"] });

  const removed = removeProvider(cfg, "mock");
  assert.equal(removed.ok, true);
  assert.match(removed.message, /removed "mock" — and 1 saved model and 1 fallback/);
  assert.equal(cfg.current.models["mock-m1"], undefined, "the picker must not keep offering a dead model");
  assert.ok(cfg.current.models["other-m2"], "another provider's profile is untouched");
  assert.ok(cfg.current.models["bare"], "a bare-id profile is not ours to delete");
  assert.deepEqual(cfg.current.agents.defaults.fallbacks, ["other/m2"]);
  assert.equal(cfg.current.auth.order.mock, undefined);
  assert.deepEqual(cfg.current.auth.order.other, ["other:key:1"]);
});

test("renaming a provider brings its saved models, default and fallbacks along", async () => {
  const cfg = scratchConfig();
  cfg.setPath("providers.old", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", models: ["m1"] });
  cfg.setPath("models.old-m1", { ref: "old/m1", label: "Mine", enabled: true, contextWindow: 128000, maxTokens: 0, reasoningEffort: "inherit" });
  cfg.setPath("agents.defaults.model", "old/m1");
  cfg.setPath("agents.defaults.fallbacks", ["old/m1"]);
  cfg.setPath("auth.order", { old: ["old:key:1"] });

  const res = await addProvider(cfg, "new", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
    models: ["m1"],
    renameFrom: "old",
  });
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /renamed from "old" — moved 1 saved model, 1 fallback, the default model/);
  assert.equal(cfg.current.models["old-m1"].ref, "new/m1", "the saved model follows the rename");
  assert.equal(cfg.current.agents.defaults.model, "new/m1");
  assert.deepEqual(cfg.current.agents.defaults.fallbacks, ["new/m1"]);
  assert.deepEqual(cfg.current.auth.order.new, ["old:key:1"], "the auth order moves with the name");
  assert.equal(cfg.current.auth.order.old, undefined);
  assert.ok(cfg.current.providers.new, "the new record exists");
  assert.ok(cfg.current.providers.old, "the old record is the caller's to remove");
});
