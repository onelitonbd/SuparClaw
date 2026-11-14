// Task 26 (audit 3) — the agent must know its own configuration and be able to
// change it when the user asks.
//
// Two failures this pins down:
//   1. The prompt said what the agent *can do* but not what it is *set to*.
//   2. There was no way to change a setting from chat: `exec` + `fs_write` would
//      hand-edit config.json5, unvalidated, without hot-applying, and while
//      reading secrets on the way.
//
// The contract below is the whole loop: prompt facts → tool call → validated
// write → live apply → the next turn states the new value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-self-home-"));
const {
  AgentLoop,
  Service,
  Store,
  buildRegistry,
  createLogger,
  emptyConfig,
  ConfigService,
  writeConfigFile,
  selfPromptLine,
  selfFactsFrom,
  describeSettings,
  coerceSetting,
  isSecretPath,
  settingSpec,
  settingsCtlFrom,
  MUTABLE_SETTINGS,
} = await import("../dist/lib.js");

const waitFor = async (fn, ms = 4000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

const FACTS = {
  model: "kilo/nvidia/nemotron-3.5-super-vl:free",
  profile: "kilo-free",
  fallbacks: ["gpt-4o-mini"],
  reasoning: "medium",
  usage: "cost",
  queue: "steer",
  execEnabled: true,
  execTimeoutMs: 1800000,
  maxIterations: 20,
  contextBudget: 200000,
  skills: 12,
  cronEnabled: true,
  timezone: "Asia/Dhaka",
  dreaming: true,
  workspace: "/home/op/.suparclaw/workspace",
  configPath: "/home/op/.suparclaw/config.json5",
};

test("the prompt states the live configuration as facts, not defaults", () => {
  const line = selfPromptLine(FACTS);
  assert.match(line, /^## Your configuration/);
  assert.match(line, /facts, not defaults/, "the block must say these are live values");
  assert.match(line, /Model: `kilo\/nvidia\/nemotron-3\.5-super-vl:free` \(profile `kilo-free`\)/);
  assert.match(line, /fallbacks: `gpt-4o-mini`/);
  assert.match(line, /Reasoning: `medium`/);
  assert.match(line, /reply usage footer: `cost`/, "the /usage mode this session is on");
  assert.match(line, /queue: `steer`/);
  assert.match(line, /Exec: on · timeout cap 1,800,000 ms/);
  assert.match(line, /20 tool iterations/);
  assert.match(line, /context budget 200,000 chars/);
  assert.match(line, /skills: 12 enabled/);
  assert.match(line, /Cron: on, timezone `Asia\/Dhaka`/);
  assert.match(line, /Workspace: `\/home\/op\/\.suparclaw\/workspace`/);
  assert.match(line, /config: `\/home\/op\/\.suparclaw\/config\.json5`/);
  // It must name the way to change them, and the things it may not touch.
  assert.match(line, /`settings` tool/);
  assert.match(line, /Writable from chat: [^\n]*agents\.defaults\.model/);
  assert.match(line, /Operator-only: API keys/);
  assert.match(line, /Settings → Models/);
});

test("the block reflects the config it is built from, including empty states", () => {
  const config = emptyConfig();
  const facts = selfFactsFrom(config, { sessionKey: "main:main", workspace: "/w", configPath: "/c.json5", skills: 3 });
  assert.match(selfPromptLine(facts), /Model: \(unset\)/, "an unset model says so instead of inventing a default");
  assert.equal(facts.usage, config.agents.defaults.usage, "no session override → the config default");
  assert.equal(facts.execEnabled, config.tools.exec.enabled);
  assert.equal(facts.execTimeoutMs, config.tools.exec.timeoutMs);

  const changed = emptyConfig();
  changed.agents.defaults.usage = "off";
  changed.agents.defaults.model = "openai/gpt-4.1";
  const line = selfPromptLine(selfFactsFrom(changed, { sessionKey: "main:x", workspace: "/w", configPath: "/c" }));
  assert.match(line, /reply usage footer: `off`/);
  assert.match(line, /Model: `openai\/gpt-4\.1`/);
});

test("selfFactsFrom prefers this session's overrides over the config defaults", () => {
  const config = emptyConfig();
  config.agents.defaults.usage = "full";
  const facts = selfFactsFrom(config, {
    sessionKey: "main:main",
    workspace: "/w",
    configPath: "/c",
    runtime: { usage: "tokens", queue: "collect" },
  });
  assert.equal(facts.usage, "tokens");
  assert.equal(facts.queue, "collect");
  const line = selfPromptLine(facts);
  assert.match(line, /reply usage footer: `tokens`/);
  assert.match(line, /queue: `collect`/);
});

test("the writable list is exact, typed and complete", () => {
  const text = describeSettings();
  for (const spec of MUTABLE_SETTINGS) assert.ok(text.includes(spec.path), `${spec.path} is listed`);
  assert.ok(settingSpec("agents.defaults.usage"), "known path");
  assert.equal(settingSpec("gateway.port"), undefined, "operator-only paths are not writable");
  assert.equal(settingSpec("providers.kilo.apiKey"), undefined, "secrets are not writable");
  assert.deepEqual(MUTABLE_SETTINGS.filter((s) => s.type === "enum").map((s) => s.path).sort(), [
    "agents.defaults.queueMode",
    "agents.defaults.reasoningEffort",
    "agents.defaults.reasoningView",
    "agents.defaults.usage",
  ]);
});

test("values are coerced by type and refused when they do not fit", () => {
  assert.deepEqual(coerceSetting(settingSpec("agents.defaults.usage"), "cost"), { ok: true, value: "cost" });
  assert.match(coerceSetting(settingSpec("agents.defaults.usage"), "loud").error, /must be one of off, tokens, full, cost/);
  assert.deepEqual(coerceSetting(settingSpec("agents.defaults.maxToolIterations"), "20"), { ok: true, value: 20 });
  assert.match(coerceSetting(settingSpec("agents.defaults.maxToolIterations"), "lots").error, /number/);
  assert.deepEqual(coerceSetting(settingSpec("tools.exec.enabled"), false), { ok: true, value: false });
  assert.match(coerceSetting(settingSpec("tools.exec.enabled"), "maybe").error, /true or false/);
  assert.deepEqual(coerceSetting(settingSpec("agents.defaults.fallbacks"), ["a/b"]), { ok: true, value: ["a/b"] });
  assert.match(coerceSetting(settingSpec("agents.defaults.fallbacks"), "a/b").error, /list of strings/);
});

test("secret paths are recognised before anything is serialized", () => {
  assert.equal(isSecretPath("providers.kilo.apiKey"), true);
  assert.equal(isSecretPath("gateway.auth.token"), true);
  assert.equal(isSecretPath("channels.telegram.token"), true);
  assert.equal(isSecretPath("tools.web.search.brave.apiKey"), true);
  assert.equal(isSecretPath("agents.defaults.model"), false);
});

test("settingsCtl writes, validates and applies — and says what it cannot touch", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-self-ctl-"));
  const path = join(dir, "config.json5");
  // Two providers so a bad model ref is actually verifiable (with none, or one,
  // the canonicalizer cannot check ownership and accepts anything).
  const seeded = emptyConfig();
  seeded.providers["openai"] = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    headers: {},
    models: ["gpt-4.1"],
    authProfiles: [],
    api: "openai-completions",
  };
  seeded.providers["kilo"] = {
    baseUrl: "https://api.kilo.ai/v1",
    apiKey: "",
    headers: {},
    models: ["kilo/nvidia/nemotron-3.5-super-vl:free"],
    authProfiles: [],
    api: "openai-completions",
  };
  writeConfigFile(seeded, path);
  const cfg = new ConfigService(createLogger({ level: "error" }), path);
  let applied = 0;
  const ctl = settingsCtlFrom(cfg, () => { applied += 1; });

  const ok = ctl.set("agents.defaults.usage", "cost");
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(applied, 1, "a successful write applies live");
  assert.equal(cfg.current.agents.defaults.usage, "cost", "in memory");
  assert.match(readFileSync(path, "utf8"), /usage:\s*['"]cost['"]/, "and on disk");
  assert.equal(ctl.get("agents.defaults.usage").value, "cost", "read-back");

  const before = readFileSync(path, "utf8");
  const port = ctl.set("gateway.port", 1234);
  assert.equal(port.ok, false);
  assert.match(port.error, /not changeable from chat/);
  assert.match(port.error, /Settings → Gateway/);
  assert.equal(readFileSync(path, "utf8"), before, "a refusal writes nothing");
  assert.equal(applied, 1, "and applies nothing");

  const secret = ctl.set("providers.kilo.apiKey", "sk-nope");
  assert.equal(secret.ok, false);
  assert.match(secret.error, /operator-only \(secrets\)/);
  const read = ctl.get("providers.kilo.apiKey");
  assert.equal(read.ok, false);
  assert.match(read.error, /secrets/);

  const badEnum = ctl.set("agents.defaults.usage", "loud");
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.error, /off, tokens, full, cost/);

  const badModel = ctl.set("agents.defaults.model", "not-a-model");
  assert.equal(badModel.ok, false);
  assert.match(badModel.error, /model/i);
  assert.equal(cfg.current.agents.defaults.model, "", "and the old model stands");
});

test("the naming model is writable from chat, and empty means inherit", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-self-naming-"));
  const path = join(dir, "config.json5");
  const seeded = emptyConfig();
  for (const [name, model] of [["openai", "gpt-4.1"], ["kilo", "gpt-4.1"]]) {
    seeded.providers[name] = {
      baseUrl: "https://example.test/v1",
      apiKey: "",
      headers: {},
      models: [model],
      authProfiles: [],
      api: "openai-completions",
    };
  }
  writeConfigFile(seeded, path);
  const cfg = new ConfigService(createLogger({ level: "error" }), path);
  let applied = 0;
  const ctl = settingsCtlFrom(cfg, () => { applied += 1; });

  // Two providers carry the same model name, so an unqualified ref is ambiguous
  // and must be refused rather than silently guessed.
  const vague = ctl.set("agents.defaults.utilityModel", "gpt-4.1");
  assert.equal(vague.ok, false);
  assert.match(vague.error, /several providers/);

  const ok = ctl.set("agents.defaults.utilityModel", "kilo/gpt-4.1");
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(applied, 1, "the write applies live");
  assert.equal(cfg.current.agents.defaults.utilityModel, "kilo/gpt-4.1");
  assert.match(readFileSync(path, "utf8"), /utilityModel:\s*['"]kilo\/gpt-4\.1['"]/, "and lands on disk");

  const bad = ctl.set("agents.defaults.utilityModel", "not-a-model");
  assert.equal(bad.ok, false, "a nonsense ref is refused, not stored");
  assert.match(bad.error, /model/i);

  const cleared = ctl.set("agents.defaults.utilityModel", "");
  assert.equal(cleared.ok, true, "clearing back to inherit is allowed");
  assert.equal(cfg.current.agents.defaults.utilityModel, "", "and it means the default model");
});

test("the facts line says which model names chats", () => {
  const opts = { sessionKey: "main:main", workspace: "/w", configPath: "/c" };
  const facts = selfFactsFrom(emptyConfig(), opts);
  assert.equal(facts.utilityModel, "", "unset is stated as such");
  assert.match(selfPromptLine(facts), /Naming new chats: this model/);

  const named = emptyConfig();
  named.agents.defaults.utilityModel = "kilo/gpt-4.1";
  assert.match(selfPromptLine(selfFactsFrom(named, opts)), /Naming new chats: `kilo\/gpt-4\.1`/);
});

test("a curated model profile id is accepted as the default model", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-self-model-"));
  const path = join(dir, "config.json5");
  const seeded = emptyConfig();
  seeded.models["kilo-free"] = {
    ref: "kilo/nvidia/nemotron-3.5-super-vl:free",
    label: "Nemotron free",
    enabled: true,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoningEffort: "inherit",
    pricing: { input: 0, cachedIn: 0, output: 0 },
  };
  writeConfigFile(seeded, path);
  const cfg = new ConfigService(createLogger({ level: "error" }), path);
  const ctl = settingsCtlFrom(cfg, () => {});
  const res = ctl.set("agents.defaults.model", "kilo-free");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(cfg.current.agents.defaults.model, "kilo-free");
});

test("the settings tool is main-session-only and speaks in results, not exceptions", async () => {
  const config = emptyConfig();
  const tool = buildRegistry(config).find((t) => t.name === "settings");
  assert.ok(tool, "the tool exists");
  assert.match(tool.description, /setting/i);
  const sub = await tool.run({ action: "set", path: "agents.defaults.usage", value: "off" }, { config });
  assert.match(sub, /^error: .*main session/);

  const dir = mkdtempSync(join(tmpdir(), "sc-self-tool-"));
  const path = join(dir, "config.json5");
  writeConfigFile(emptyConfig(), path);
  const cfg = new ConfigService(createLogger({ level: "error" }), path);
  const ctx = { config: cfg.current, settings: settingsCtlFrom(cfg, () => {}) };

  const list = await tool.run({ action: "list" }, ctx);
  assert.match(list, /agents\.defaults\.model/);
  assert.match(list, /—/);

  const get = await tool.run({ action: "get", path: "agents.defaults.usage" }, ctx);
  assert.equal(get, 'agents.defaults.usage = "tokens"');

  const set = await tool.run({ action: "set", path: "agents.defaults.usage", value: "cost" }, ctx);
  assert.match(set, /^ok: agents\.defaults\.usage = "cost" \(applied live/);

  const refused = await tool.run({ action: "set", path: "gateway.auth.token", value: "nope" }, ctx);
  assert.match(refused, /^error: .*operator-only/);

  const unknown = await tool.run({ action: "set", path: "agents.defaults.nonsense", value: 1 }, ctx);
  assert.match(unknown, /^error: .*not changeable/);
});

test("a model that changes a setting gets a real change and a readable result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-self-loop-"));
  const path = join(dir, "config.json5");
  writeConfigFile(emptyConfig(), path);
  const cfg = new ConfigService(createLogger({ level: "error" }), path);
  const store = Store.open(join(dir, "state.sqlite"));
  const config = cfg.current;
  let round = 0;
  let systemSeen = "";
  const llm = {
    async *stream(opts) {
      const sys = opts.messages.find((m) => m.role === "system");
      if (sys) systemSeen = String(sys.content);
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [{ id: "c1", name: "settings", args: JSON.stringify({ action: "set", path: "agents.defaults.usage", value: "cost" }) }],
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: "done" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({
    config,
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: buildRegistry(config),
    settings: settingsCtlFrom(cfg, () => {
      loop.setConfig(cfg.current);
    }),
    surfaces: () => ({ telegram: { enabled: false, hasToken: false, running: false, username: "", error: "" }, telegramChats: [] }),
  });
  await loop.run({ sessionKey: "main:self", text: "turn the usage footer to cost", isMainSession: true, onEvent: () => {} });

  assert.match(systemSeen, /## Your configuration/, "the prompt carries the block");
  assert.match(systemSeen, /reply usage footer: `tokens`/, "the value before the change");
  assert.equal(cfg.current.agents.defaults.usage, "cost", "the tool wrote the config");
  const rows = store.recentMessages(store.getSessionByKey("main:self").id, 20);
  const toolRow = rows.find((r) => r.role === "tool" && r.content.includes("settings"));
  assert.ok(toolRow, "the call is in the transcript");
  assert.match(toolRow.content, /applied live/, "and its result is legible on replay");
  store.close();
});

test("end to end on a real Service: change it, then the next turn states it", async () => {
  const svc = new Service();
  const key = "main:self-e2e";
  const seen = [];
  let round = 0;
  svc.loop.llm = {
    async *stream(opts) {
      const sys = opts.messages.find((m) => m.role === "system");
      if (sys) seen.push(String(sys.content));
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [{ id: "c1", name: "settings", args: JSON.stringify({ action: "set", path: "agents.defaults.usage", value: "cost" }) }],
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: "usage footer is now cost" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };

  let reply = "";
  await svc.send({
    sessionKey: key,
    text: "switch my usage footer to cost, please",
    isMainSession: true,
    source: "gateway",
    reply: async (t) => { reply = t; },
  });
  assert.ok(await waitFor(() => !svc.loop.isBusy(key)), "the turn finished");
  assert.equal(svc.config.agents.defaults.usage, "cost", "the running config changed");
  assert.equal(svc.usageModeFor(key), "cost", "and this session's footer mode follows it");
  assert.match(reply, /cost|done|usage/i);

  // A fresh turn sees the new value in its own prompt.
  round = 10;
  await svc.send({ sessionKey: key, text: "what is my usage footer set to?", isMainSession: true, source: "gateway", reply: async () => {} });
  assert.ok(await waitFor(() => !svc.loop.isBusy(key)));
  await waitFor(() => seen.some((s) => /reply usage footer: `cost`/.test(s)), 2000);
  assert.ok(seen.some((s) => /reply usage footer: `cost`/.test(s)), "the next prompt states the changed value");
  await svc.stop();
});
