import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Some Android/proot images ship a TMPDIR that does not exist yet.
const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try {
      mkdirSync(base, { recursive: true });
      return base;
    } catch {
      /* try the next candidate */
    }
  }
  return process.cwd();
})();

const scratch = (prefix) => mkdtempSync(join(TEST_TMP, prefix));
import {
  parseConfig,
  validate,
  applyDefaults,
  emptyConfig,
  CONFIG_SCHEMA,
  parseFrontmatter,
  discoverSkills,
  matchSkills,
  skillsCatalog,
  Store,
  loadWorkspaceContext,
  writeWorkspaceTemplates,
  todayStamp,
  safePath,
  buildRegistry,
  resolveModel,
  canonicalModelRef,
  parseToolArgs,
  AgentLoop,
  createLogger,
} from "../dist/lib.js";

test("config defaults are applied and unknown keys rejected", () => {
  const { config, errors } = parseConfig({ gateway: { port: 19999 } });
  assert.equal(errors.length, 0);
  assert.equal(config.gateway.port, 19999);
  assert.equal(config.gateway.bind, "loopback");
  assert.equal(config.agents.defaults.maxToolIterations, 12);

  const bad = parseConfig({ gateway: { prot: 1 } });
  assert.ok(bad.errors.some((e) => e.includes("unknown key")));
});

test("config type errors carry a path", () => {
  const errors = validate(CONFIG_SCHEMA, { gateway: { port: "eighteen" } });
  assert.ok(errors.some((e) => e.includes("$.gateway.port") && e.includes("integer")));
  assert.deepEqual(applyDefaults(CONFIG_SCHEMA, {}), emptyConfig());
});

test("frontmatter parser handles scalars, lists and nested blocks", () => {
  const { meta, body } = parseFrontmatter(
    ["---", "name: demo", "description: A demo skill", "read_when:", "  - user asks for a demo", "---", "", "Body text"].join("\n"),
  );
  assert.equal(meta.name, "demo");
  assert.equal(meta.description, "A demo skill");
  assert.deepEqual(meta.read_when, ["user asks for a demo"]);
  assert.equal(body.trim(), "Body text");
});

test("skill discovery honours precedence and gating", () => {
  const dir = scratch("sc-skills-");
  const workspace = join(dir, "workspace");
  const state = join(dir, "state");
  mkdirSync(join(workspace, "skills", "shared"), { recursive: true });
  mkdirSync(join(state, "skills", "shared"), { recursive: true });
  mkdirSync(join(workspace, "skills", "gated"), { recursive: true });
  writeFileSync(join(workspace, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: workspace wins\n---\nworkspace body\n");
  writeFileSync(join(state, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: state copy\n---\nstate body\n");
  writeFileSync(
    join(workspace, "skills", "gated", "SKILL.md"),
    '---\nname: gated\ndescription: needs a binary\nmetadata:\n  openclaw:\n    requires:\n      bins: ["definitely-not-installed-xyz"]\n---\ngated body\n',
  );

  const skills = discoverSkills({
    roots: [
      { label: "workspace", dir: join(workspace, "skills") },
      { label: "state", dir: join(state, "skills") },
    ],
  });
  const shared = skills.find((s) => s.name === "shared");
  assert.equal(shared.root, "workspace", "workspace skills win over state skills");
  const gated = skills.find((s) => s.name === "gated");
  assert.equal(gated.eligible, false);
  assert.match(gated.reason, /missing binary/);

  const catalog = skillsCatalog(skills);
  assert.ok(catalog.includes("shared"));
  assert.ok(!catalog.includes("gated"), "ineligible skills stay out of the prompt");

  const hits = matchSkills(skills, "please run a shared demo for me");
  assert.ok(hits.some((s) => s.name === "shared"));
});

test("workspace context injects files with budgets and honours main-session rules", () => {
  const dir = scratch("sc-ws-");
  const written = writeWorkspaceTemplates(dir);
  assert.ok(written.includes("AGENTS.md"));
  const ctx = loadWorkspaceContext(dir, { isMainSession: true });
  assert.ok(ctx.text.startsWith("# Project Context"));
  assert.ok(ctx.included.includes("AGENTS.md"));
  assert.ok(ctx.text.includes("MEMORY.md"));

  const groupCtx = loadWorkspaceContext(dir, { isMainSession: false });
  assert.ok(!groupCtx.included.includes("MEMORY.md"), "groups must not load private memory");
  assert.ok(todayStamp().length === 10);
});

test("store round-trips sessions, messages and search", () => {
  const dir = scratch("sc-db-");
  const store = Store.open(join(dir, "state.sqlite"));
  const session = store.ensureSession("main:main");
  store.appendMessage(session.id, "user", "remember the milk");
  store.appendMessage(session.id, "assistant", "noted: milk");
  const rows = store.recentMessages(session.id, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, "remember the milk");
  const found = store.searchMessages(session.id, "milk", 5);
  assert.ok(found.length >= 1, store.fts ? "FTS search" : "LIKE fallback");

  store.upsertJob({ id: "morning", name: "Morning", schedule: "0 8 * * *", prompt: "hi", session_key: "cron:morning", enabled: 1 });
  assert.equal(store.listJobs().length, 1);
  store.recordJobRun("morning", "done", "ok");
  assert.equal(store.lastJobRuns(1)[0].status, "done");
  store.close();
});

test("tool registry respects config policy", () => {
  const config = emptyConfig();
  const names = buildRegistry(config).map((t) => t.name);
  assert.ok(names.includes("fs_read"));
  assert.ok(names.includes("memory_append"));
  assert.ok(!names.includes("exec"), "exec stays off until explicitly enabled");

  config.tools.exec.enabled = true;
  const execTool = buildRegistry(config).find((t) => t.name === "exec");
  assert.ok(execTool?.needsApproval, "exec requires approval");

  config.tools.fs = false;
  assert.ok(!buildRegistry(config).some((t) => t.name === "fs_read"));
});

test("tool paths cannot escape the workspace", () => {
  assert.equal(safePath("/ws", "notes/a.md"), "/ws/notes/a.md");
  assert.throws(() => safePath("/ws", "../escape.txt"));
  assert.throws(() => safePath("/ws", "/etc/passwd"));
});

test("model resolution and tool argument parsing", () => {
  const resolved = resolveModel("openai/gpt-4o-mini", { openai: { baseUrl: "https://api.openai.com/v1/", apiKey: "k" } });
  assert.equal(resolved.model, "gpt-4o-mini");
  assert.equal(resolved.baseUrl, "https://api.openai.com/v1");
  assert.throws(() => resolveModel("nope/x", {}));

  assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArgs(""), {});
  assert.ok("_parseError" in parseToolArgs("{oops"));
});

test("model refs with slashes in the model id resolve to the right provider", () => {
  // the case that broke: a bare model id whose id itself contains slashes
  const providers = {
    MultiRouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "k",
      models: ["kilo/nvidia/nemotron-3-super-120b-a12b:free", "gpt-4o-mini"],
    },
  };

  // bare id -> the provider that offers it
  const bare = resolveModel("kilo/nvidia/nemotron-3-super-120b-a12b:free", providers);
  assert.equal(bare.provider, "MultiRouter");
  assert.equal(bare.model, "kilo/nvidia/nemotron-3-super-120b-a12b:free");
  assert.equal(bare.baseUrl, "https://openrouter.ai/api/v1");

  // canonical form still wins
  const canonical = resolveModel("MultiRouter/gpt-4o-mini", providers);
  assert.equal(canonical.provider, "MultiRouter");
  assert.equal(canonical.model, "gpt-4o-mini");

  // one provider: any id is that provider's model (the cached list can be stale)
  const lenient = resolveModel("nope/x", providers);
  assert.equal(lenient.provider, "MultiRouter");
  assert.equal(lenient.model, "nope/x");

  // two providers offering the same id is ambiguous, not a crash
  const two = {
    a: { baseUrl: "http://a", apiKey: "", models: ["shared/model"] },
    b: { baseUrl: "http://b", apiKey: "", models: ["shared/model"] },
  };
  assert.throws(() => resolveModel("shared/model", two), /several providers/);

  // an unknown ref with several providers explains what to do
  const many = { a: { baseUrl: "http://a", apiKey: "", models: [] }, b: { baseUrl: "http://b", apiKey: "", models: [] } };
  assert.throws(() => resolveModel("nope/x", many), /does not match any configured provider/);
  assert.throws(() => resolveModel("nope/x", many), /a, b/);
});

test("a bare model id is stored canonically as <provider>/<model>", () => {
  const config = {
    providers: {
      MultiRouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", models: ["kilo/nvidia/x"] },
    },
  };
  assert.equal(
    canonicalModelRef(config, "kilo/nvidia/x"),
    "MultiRouter/kilo/nvidia/x",
  );
  assert.equal(
    canonicalModelRef(config, "MultiRouter/kilo/nvidia/x"),
    "MultiRouter/kilo/nvidia/x",
  );
  // one provider configured: any id belongs to it
  assert.equal(canonicalModelRef(config, "some/other-model"), "MultiRouter/some/other-model");
  // two providers offering the same id is ambiguous
  assert.equal(
    canonicalModelRef(
      { providers: { a: { baseUrl: "", apiKey: "", models: ["shared"] }, b: { baseUrl: "", apiKey: "", models: ["shared"] } } },
      "shared",
    ),
    null,
  );
  assert.equal(canonicalModelRef({ providers: {} }, "anything"), null);
});

// tiny fs helpers so the test file stays dependency-free
test("a run's model override reaches the LLM (so /model really changes the model)", async () => {
  const dir = scratch("sc-loop-");
  const store = Store.open(join(dir, "state.sqlite"));
  const { config, errors } = parseConfig({});
  assert.equal(errors.length, 0);

  const seen = [];
  const fakeLlm = {
    stream(opts) {
      seen.push(opts.model);
      return (async function* () {
        yield { type: "text", text: "hello" };
        yield { type: "done", finishReason: "stop" };
      })();
    },
  };

  const loop = new AgentLoop({
    config,
    store,
    log: createLogger({ level: "error" }),
    llm: fakeLlm,
  });

  const events = [];
  await loop.run({
    sessionKey: "test:main",
    text: "hi",
    model: "provider/chosen-model",
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(seen[0], "provider/chosen-model", "the override reaches llm.stream");

  await loop.run({ sessionKey: "test:main", text: "hi again", onEvent: () => {} });
  assert.equal(seen[1], undefined, "without an override the configured default is used");

  assert.ok(events.includes("start") && events.includes("final"), `run lifecycle events: ${events}`);
  store.close();
});
