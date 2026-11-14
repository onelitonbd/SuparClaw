// Task 58 — tools the agent writes for itself.
//
// "i want the ai to create tools for itself and load them into its context so
// that it can create a tool if it need and keep it for later uses."
//
// What has to be true for that to be a capability and not a party trick:
//
//   1. a made tool is a *real* tool — same registry, same schema, callable by
//      name after restart and (this is the part that makes "create, test, then
//      use" one motion) in the turn that made it;
//   2. it survives a restart, because it is a file plus a manifest, and the
//      manifest is derived from the code rather than hand-written;
//   3. a bad tool costs one worker and one error line — a throw, an infinite
//      loop and `process.exit()` are all survivable, and the daemon keeps
//      answering afterwards;
//   4. nothing arrives silently: a name that collides with a built-in, a module
//      that does not load, a second create, a delete without the exact name —
//      each is refused with the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sc-selftools-"));
process.env.SUPARCLAW_HOME = HOME;
const STATE = join(HOME, ".suparclaw");
const TOOLS = join(STATE, "tools");
mkdirSync(TOOLS, { recursive: true });

const lib = await import("../dist/lib.js");
const { Service, buildRegistry, emptyConfig, parseConfig, listSelfTools, selfToolFile, discoverSkills, matchSkills, readSkillBody } = lib;

/** A tool spec as source, so each test states exactly what it wrote. */
function source(name, body, extra = {}) {
  return `export default {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(extra.description ?? `${name} for the tests`)},
  parameters: ${JSON.stringify(extra.parameters ?? { type: "object", properties: { text: { type: "string", description: "input" } }, required: ["text"] })},
  async run(args, ctx) {
${body}
  },
};`;
}

function registryTool(name, config = emptyConfig()) {
  return buildRegistry(config).find((t) => t.name === name);
}

function ctxWith(overrides = {}) {
  const refreshes = [];
  return {
    refreshes,
    ctx: {
      workspace: join(STATE, "workspace"),
      stateDir: STATE,
      sessionKey: "test:58",
      config: emptyConfig(),
      skills: [],
      store: {},
      log: { info() {}, warn() {}, error() {}, debug() {} },
      approved: true,
      refreshTools: () => refreshes.push(Date.now()),
      ...overrides,
    },
  };
}

test("the registry offers toolsmith, and no made tools yet", () => {
  const names = buildRegistry(emptyConfig()).map((t) => t.name);
  assert.ok(names.includes("toolsmith"), "the tool that makes tools is registered");
  assert.equal(listSelfTools().tools.length, 0, "a fresh state dir has none");
});

test("create saves code + a manifest derived from the code, not from the request", async () => {
  const config = emptyConfig();
  const toolsmith = registryTool("toolsmith");
  const { ctx, refreshes } = ctxWith();
  const out = await toolsmith.run(
    {
      action: "create",
      name: "shout",
      code: source("shout", '    return String(args.text).toUpperCase() + "!";', {
        description: "Uppercase text and add an exclamation mark. Use for emphasis.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }),
    },
    ctx,
  );

  assert.match(out, /Created self-tool shout/);
  assert.equal(refreshes.length, 1, "the tool list is refreshed immediately");
  assert.ok(existsSync(selfToolFile("shout")), "the module is on disk");
  assert.ok(existsSync(join(TOOLS, "shout.json")), "the manifest is on disk");

  const manifest = JSON.parse(readFileSync(join(TOOLS, "shout.json"), "utf8"));
  assert.equal(manifest.name, "shout");
  assert.equal(manifest.description, "Uppercase text and add an exclamation mark. Use for emphasis.");
  assert.deepEqual(Object.keys(manifest.parameters.properties), ["text"]);
  assert.deepEqual(manifest.parameters.required, ["text"]);
  assert.ok(manifest.created && manifest.updated);
  assert.equal(manifest.testedAt, undefined, "not tested yet — and the manifest says so by omission");
  void config;
});

test("T58 manifests without a vault field remain valid and declare no injected entries", () => {
  const file = join(TOOLS, "shout.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  delete saved.vault;
  writeFileSync(file, JSON.stringify(saved, null, 2) + String.fromCharCode(10));
  const legacy = listSelfTools().tools.find((tool) => tool.manifest.name === "shout");
  assert.ok(legacy, "existing self-tool remains available after upgrade");
  assert.deepEqual(legacy.manifest.vault, [], "legacy code receives no vault variables by default");
  writeFileSync(file, JSON.stringify({ ...saved, vault: [] }, null, 2) + String.fromCharCode(10));
});

test("the manager and made tools stay visible when Code Mode owns the exec surface", () => {
  const config = parseConfig({ tools: { codeMode: { enabled: "true" } } }).config;
  const tools = buildRegistry(config);
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("exec"), "Code Mode execution remains available");
  assert.ok(names.includes("toolsmith"), "the agent can still create its own tools");
  assert.ok(names.includes("shout"), "saved tools remain in the model's tool list");
  assert.equal(names.length, new Set(names).size, "no duplicate provider function names");
});

test("a made tool is a real tool: in the registry, with its schema, callable by name", async () => {
  const tool = registryTool("shout");
  assert.ok(tool, "the next registry build carries it (a restart is enough)");
  assert.equal(tool.parameters.required?.[0], "text", "the schema reaches the model");
  const { ctx } = ctxWith();
  const out = await tool.run({ text: "hello claw" }, ctx);
  assert.equal(out, "HELLO CLAW!");
});

test("console.log inside a tool comes back in the result, not the daemon's stdout", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  await toolsmith.run(
    {
      action: "create",
      name: "noisy",
      code: source("noisy", '    console.log("debugging", args.text);\n    return "quiet result";'),
    },
    ctx,
  );
  const out = await registryTool("noisy").run({ text: "x" }, ctx);
  assert.match(out, /quiet result/);
  assert.match(out, /\[console\]/);
  assert.match(out, /log: debugging x/);
});

test("create refuses a name it cannot use, a built-in collision, and a mismatch with the module", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();

  const badName = await toolsmith.run({ action: "create", name: "Bad-Name", code: source("Bad-Name", '    return "x";') }, ctx);
  assert.match(badName, /^error: name must be 3-32 characters/);

  const reserved = await toolsmith.run({ action: "create", name: "exec", code: source("exec", '    return "x";') }, ctx);
  assert.match(reserved, /is a built-in tool/);
  const managerCollision = await toolsmith.run({ action: "create", name: "toolsmith", code: source("toolsmith", '    return "x";') }, ctx);
  assert.match(managerCollision, /is a built-in tool/);

  // The module's `name` is what the file and the tool list must agree on.
  const mismatch = await toolsmith.run({ action: "create", name: "alpha", code: source("beta", '    return "x";') }, ctx);
  assert.match(mismatch, /exports name "beta" but you asked for "alpha"/);
  assert.ok(!existsSync(selfToolFile("alpha")), "nothing was saved");
});

test("a module that does not load is refused, with the real error, and nothing is written", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx, refreshes } = ctxWith();
  const out = await toolsmith.run({ action: "create", name: "broken", code: "export default {{{" }, ctx);
  assert.match(out, /^error: the tool does not load/);
  assert.ok(!existsSync(selfToolFile("broken")));
  assert.equal(refreshes.length, 0);

  // Missing `run` is a contract failure, not a syntax one.
  const noRun = await toolsmith.run(
    { action: "create", name: "inert", code: 'export default { name: "inert", description: "does nothing", parameters: { type: "object", properties: {} } };' },
    ctx,
  );
  assert.match(noRun, /`run` must be a function/);
});

test("create twice is refused; update replaces the code and keeps the creation date", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  const again = await toolsmith.run({ action: "create", name: "shout", code: source("shout", '    return "x";') }, ctx);
  assert.match(again, /already exists — use action "update"/);

  const before = JSON.parse(readFileSync(join(TOOLS, "shout.json"), "utf8"));
  const updated = await toolsmith.run(
    {
      action: "update",
      name: "shout",
      code: source("shout", '    return String(args.text).toUpperCase() + "!!!";', { description: "Uppercase text and add three exclamation marks." }),
    },
    ctx,
  );
  assert.match(updated, /Updated self-tool shout/);
  const after = JSON.parse(readFileSync(join(TOOLS, "shout.json"), "utf8"));
  assert.equal(after.created, before.created, "the creation date survives an update");
  assert.notEqual(after.updated, before.updated);
  assert.equal(after.description, "Uppercase text and add three exclamation marks.", "the manifest follows the code");
  assert.equal(await registryTool("shout").run({ text: "hi" }, ctx), "HI!!!");
});

test("a throwing tool reports its own error and the stack — the daemon keeps going", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  await toolsmith.run(
    { action: "create", name: "boom", code: source("boom", '    throw new Error("kaboom from the tool");') },
    ctx,
  );
  const out = await registryTool("boom").run({ text: "x" }, ctx);
  assert.match(out, /^error: boom failed — kaboom from the tool/);
  assert.match(out, /boom\.mjs/, "the stack names the file to edit");
  // Still alive and answering:
  assert.equal(await registryTool("shout").run({ text: "ok" }, ctx), "OK!!!");
});

test("a tool that calls process.exit() is contained", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  await toolsmith.run(
    { action: "create", name: "quitter", code: source("quitter", '    process.exit(7);\n    return "unreachable";') },
    ctx,
  );
  const out = await registryTool("quitter").run({ text: "x" }, ctx);
  assert.match(out, /the tool ended the worker \(exit 7\) before answering/);
  assert.equal(await registryTool("shout").run({ text: "alive" }, ctx), "ALIVE!!!");
});

test("an infinite loop is stopped at the timeout, and the daemon is unaffected", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  await toolsmith.run(
    { action: "create", name: "spinner", code: source("spinner", "    while (true) { /* spin */ }") },
    ctx,
  );
  const started = Date.now();
  const out = await toolsmith.run({ action: "run", name: "spinner", timeoutMs: 1000 }, ctx);
  const elapsed = Date.now() - started;
  assert.match(out, /timed out after 1s/);
  assert.match(out, /the daemon is unaffected/);
  assert.ok(elapsed < 15_000, `it returned promptly (${elapsed} ms)`);
});

test("test records the result; list shows tested, untested and broken files", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  const tested = await toolsmith.run({ action: "test", name: "shout", args: { text: "hey" } }, ctx);
  assert.match(tested, /HEY!!!/);
  assert.match(tested, /\[test\] shout ran in \d+ ms/);

  const manifest = JSON.parse(readFileSync(join(TOOLS, "shout.json"), "utf8"));
  assert.ok(manifest.testedAt, "the manifest remembers it was tested");
  assert.equal(manifest.lastError, undefined);

  const list = await toolsmith.run({ action: "list" }, ctx);
  assert.match(list, /- shout \(text\) · .* · tested \d{4}-\d{2}-\d{2}/);
  assert.match(list, /- boom \(text\) · .* · never tested — run `test` before you rely on it/);

  // A half-written file is reported, and does not take the list with it.
  writeFileSync(join(TOOLS, "junk.json"), "{ not json");
  writeFileSync(join(TOOLS, "orphan.mjs"), 'export default { name: "orphan" };');
  const withProblem = await toolsmith.run({ action: "list" }, ctx);
  assert.match(withProblem, /files that could not be loaded:/);
  assert.match(withProblem, /junk\.json/);
  assert.match(withProblem, /orphan\.mjs: module has no manifest/);
  assert.ok(buildRegistry(emptyConfig()).some((t) => t.name === "shout"), "the registry still builds");
});

test("a failing test is recorded as a failure, not as a pass", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx } = ctxWith();
  await toolsmith.run(
    { action: "create", name: "picky", code: source("picky", '    if (args.text !== "right") throw new Error("needs the right input");\n    return "ok";') },
    ctx,
  );
  const failed = await toolsmith.run({ action: "test", name: "picky", args: { text: "wrong" } }, ctx);
  assert.match(failed, /needs the right input/);
  assert.match(failed, /\[test\] picky FAILED/);
  const manifest = JSON.parse(readFileSync(join(TOOLS, "picky.json"), "utf8"));
  assert.match(manifest.lastError, /needs the right input/);
  assert.match(await toolsmith.run({ action: "list" }, ctx), /picky .* last run FAILED/);
});

test("delete removes a self-tool without exact confirmation", async () => {
  const toolsmith = registryTool("toolsmith");
  const { ctx, refreshes } = ctxWith();
  const gone = await toolsmith.run({ action: "delete", name: "quitter" }, ctx);
  assert.match(gone, /Deleted quitter/);
  assert.ok(!existsSync(selfToolFile("quitter")));
  assert.ok(!existsSync(join(TOOLS, "quitter.json")));
  assert.ok(refreshes.length >= 1);
  assert.equal(registryTool("quitter"), undefined, "gone from the next registry build");
});

test("self-tools keep their feature switch, independent of exec policy keys", async () => {
  const off = parseConfig({ tools: { selfTools: { enabled: false } } }).config;
  assert.ok(!buildRegistry(off).some((t) => t.name === "toolsmith"), "off means gone");
  const offCfg = { ...emptyConfig(), tools: { ...emptyConfig().tools, selfTools: { enabled: false, maxTools: 40, timeoutMs: 5000 } } };
  const refused = await lib.toolsmithSpec(offCfg, () => new Set()).run(
    { action: "create", name: "nope2", code: source("nope2", '    return "x";') }, ctxWith().ctx);
  assert.match(refused, /self-tools are switched off/);
  assert.ok(!existsSync(selfToolFile("nope2")));

  const legacy = parseConfig({ tools: { exec: { mode: "deny" } } }).config;
  assert.ok(!("mode" in legacy.tools.exec));
  assert.ok(buildRegistry(legacy).some((tool) => tool.name === "shout"), "legacy policy does not hide self-tools");
});

test("the cap is enforced with a number the operator can act on", async () => {
  const small = parseConfig({ tools: { selfTools: { maxTools: 1 } } }).config;
  // One tool already exists (shout), so a second create is over the cap.
  const toolsmith = buildRegistry(small).find((t) => t.name === "toolsmith");
  const out = await toolsmith.run({ action: "create", name: "overflow", code: source("overflow", '    return "x";') }, ctxWith().ctx);
  assert.match(out, /is the cap \(tools\.selfTools\.maxTools=1\)/);
  assert.ok(!existsSync(selfToolFile("overflow")));
});

test("a tool made in this turn is callable in this turn (real Service, scripted model)", async (t) => {
  // The whole promise, end to end: the model makes a tool, the next model call
  // already sees it in its tool list, and calls it by name — no second user
  // message, no restart.
  const svc = new Service();
  t.after(() => svc.stop());
  const seen = [];
  let round = 0;
  svc.loop.llm = {
    async *stream(input) {
      seen.push((input.tools ?? []).map((tool) => tool.function?.name));
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              id: "c1",
              name: "toolsmith",
              args: JSON.stringify({
                action: "create",
                name: "e2e_shout",
                code: source("e2e_shout", '    return String(args.text).toUpperCase() + "!!!";'),
              }),
            },
          ],
        };
      } else if (round === 2) {
        yield { type: "tool_calls", calls: [{ id: "c2", name: "e2e_shout", args: JSON.stringify({ text: "made here" }) }] };
      } else {
        yield { type: "text", text: "done" };
      }
      yield { type: "usage", usage: { prompt_tokens: 10, completion_tokens: 2 } };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };

  const toolEvents = [];
  await svc.send({
    sessionKey: "telegram:58",
    text: "make yourself a tool that shouts",
    source: "telegram",
    onTool: (event) => {
      if (event.status === "done" || event.status === "error") toolEvents.push(`${event.name}:${event.status}`);
    },
    reply: async () => {},
  });

  assert.ok(!seen[0].includes("e2e_shout"), "round 1: the tool does not exist yet");
  assert.ok(seen[1].includes("e2e_shout"), "round 2: it is in the tool list, in the same turn");
  assert.deepEqual(toolEvents, ["toolsmith:done", "e2e_shout:done"]);
  const row = svc.store.getSessionByKey("telegram:58");
  const transcript = svc.store.recentMessages(row.id, 20).map((m) => m.content).join("\n");
  assert.match(transcript, /MADE HERE!!!/, "the made tool's answer is in the transcript");
  assert.ok(svc.loop.tools.some((tool) => tool.name === "e2e_shout"), "and it is in the live registry");
});

test("live config changes remove and restore the self-tool capability", async (t) => {
  const svc = new Service();
  t.after(() => svc.stop());
  assert.ok(svc.loop.tools.some((tool) => tool.name === "toolsmith"));
  assert.ok(svc.loop.tools.some((tool) => tool.selfAuthored && tool.name === "shout"));

  svc.loop.setConfig(parseConfig({ tools: { selfTools: { enabled: false } } }).config);
  assert.ok(!svc.loop.tools.some((tool) => tool.name === "toolsmith"));
  assert.ok(!svc.loop.tools.some((tool) => tool.selfAuthored));

  svc.loop.setConfig(emptyConfig());
  assert.ok(svc.loop.tools.some((tool) => tool.name === "toolsmith"));
  assert.ok(svc.loop.tools.some((tool) => tool.selfAuthored && tool.name === "shout"));

});

test("the skill exists and is written to trigger", () => {
  const skill = readFileSync(join(process.cwd(), "skills/self-tools/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: self-tools\n/, "frontmatter names it");
  assert.match(skill, /description: .*tool for yourself/i);
  assert.match(skill, /toolsmith create/);
  assert.match(skill, /toolsmith test/);
  assert.match(skill, /read_when:/, "so it also triggers off keywords, not only the catalog");
  const discovered = discoverSkills({ roots: [{ label: "bundled", dir: join(process.cwd(), "skills") }] });
  const meta = discovered.find((s) => s.name === "self-tools");
  assert.ok(meta?.eligible, "the skill is eligible on this runtime");
  assert.ok(matchSkills(discovered, "create tools for yourself and keep them for later").some((s) => s.name === "self-tools"));
  assert.ok(matchSkills(discovered, "test the tool you just created").some((s) => s.name === "self-tools"));
  assert.match(readSkillBody(meta), /write → create → test → read → update/);
});
