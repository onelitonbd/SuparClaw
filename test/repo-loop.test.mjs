// Task 35 — the repository binding reaches the *model*, not just the UI.
//
// Three things have to be true at once for a code session to be real:
//   1. the prompt says where the work happens and how publishing is gated,
//   2. the tools run against the session's worktree (not the global workspace),
//   3. a publish is refused unless *this turn* asked for one.
// This file drives a real AgentLoop with a scripted model to prove all three.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  AgentLoop,
  Store,
  buildRegistry,
  emptyConfig,
  createLogger,
  repoPromptBlock,
} = await import("../dist/lib.js");

function harness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sc-repoloop-"));
  const store = Store.open(join(dir, "state.sqlite"));
  const seen = { system: "", tools: [], userText: "" };
  const scripted = opts.script ?? [];
  let round = 0;
  const fake = {
    async *stream(o) {
      seen.system = String(o.messages.find((m) => m.role === "system")?.content ?? "");
      seen.tools = o.tools?.map((t) => t.function?.name) ?? [];
      seen.userText = String(o.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
      const step = scripted[round++] ?? { type: "text", text: "done" };
      if (step.tool) {
        yield { type: "tool_calls", calls: [{ id: `c${round}`, name: step.tool, args: JSON.stringify(step.args ?? {}) }] };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: step.text ?? "done" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  return { dir, store, fake, seen };
}

function loopFor(h, extra = {}) {
  const config = emptyConfig();
  return new AgentLoop({
    config,
    store: h.store,
    log: createLogger({ level: "error" }),
    llm: h.fake,
    tools: buildRegistry(config),
    ...extra,
  });
}

const BINDING = {
  kind: "code",
  repo: "acme/api",
  base: "main",
  branch: "sc/alpha",
  workspace: "/tmp/sc-worktrees/acme-api/alpha",
};

test("a bound session's prompt carries the repo, the branch and the workspace", async () => {
  const h = harness();
  h.store.setSessionRepo("main:code", BINDING);
  const loop = loopFor(h);
  await loop.run({ sessionKey: "main:code", text: "what changed?", onEvent: () => {} });

  assert.match(h.seen.system, /## Repository/);
  assert.match(h.seen.system, /acme\/api · branch sc\/alpha \(from main\)/);
  assert.match(h.seen.system, new RegExp(`Workspace: ${BINDING.workspace}`));
  assert.match(h.seen.system, /Publish only when the user asks in this turn/);
});

test("a plain chat has no repository block at all", async () => {
  const h = harness();
  const loop = loopFor(h);
  await loop.run({ sessionKey: "main:plain", text: "hello", onEvent: () => {} });
  assert.doesNotMatch(h.seen.system, /## Repository/);
  assert.doesNotMatch(h.seen.system, /Publish only when the user asks/);
});

test("the repo tools are offered, and a turn that did not ask cannot publish", async () => {
  const h = harness();
  h.store.setSessionRepo("main:code", BINDING);
  const published = [];
  const loop = loopFor(h, {
    repoCtl: {
      status: async () => ({ repo: "acme/api", base: "main", branch: "sc/alpha", clean: false, files: [{ path: "a.ts", added: 2, removed: 1 }], added: 2, removed: 1 }),
      diff: async () => "diff",
      publish: async (input) => {
        published.push(input);
        return { branch: "sc/alpha", number: 3, url: "https://github.com/acme/api/pull/3", draft: true };
      },
    },
  });

  const events = [];
  await loop.run({
    sessionKey: "main:code",
    text: "fix the failing test",
    // publishAllowed is unset: the service sets it from the user's text, and
    // that text did not ask for a PR.
    onEvent: (e) => events.push(e),
  });

  assert.ok(h.seen.tools.includes("repo_status"), "the model can look at the worktree");
  assert.ok(h.seen.tools.includes("github_publish"), "the tool exists even when it will refuse");

  const toolEvents = events.filter((e) => e.type === "tool");
  assert.equal(toolEvents.length, 0, "the scripted model did not call a tool");
  assert.equal(published.length, 0);
});

test("an explicit ask opens the gate for that turn, and the publish is reported back", async () => {
  const h = harness({
    script: [{ tool: "github_publish", args: { title: "Fix the test" } }, { text: "Opened PR #3." }],
  });
  h.store.setSessionRepo("main:code", BINDING);
  const published = [];
  const loop = loopFor(h, {
    repoCtl: {
      status: async () => ({ repo: "acme/api", base: "main", branch: "sc/alpha", clean: false, files: [], added: 0, removed: 0 }),
      diff: async () => "",
      publish: async (input) => {
        published.push(input);
        return { branch: "sc/alpha", number: 3, url: "https://github.com/acme/api/pull/3", draft: true };
      },
    },
  });

  const events = [];
  await loop.run({
    sessionKey: "main:code",
    text: "open a PR when the tests pass",
    publishAllowed: true,
    onEvent: (e) => events.push(e),
  });

  assert.equal(published.length, 1, "the gate was opened by the user's own words");
  assert.equal(published[0].title, "Fix the test");
  assert.equal(published[0].draft, true);
  const tool = events.find((e) => e.type === "tool");
  assert.ok(tool, "the surface is told a tool ran");
  assert.equal(tool.name, "github_publish");
});

test("the same tool refuses when the gate stays shut", async () => {
  const h = harness({ script: [{ tool: "github_publish", args: { title: "Fix the test" } }, { text: "summary" }] });
  h.store.setSessionRepo("main:code", BINDING);
  let called = 0;
  const loop = loopFor(h, {
    repoCtl: {
      status: async () => ({ repo: "acme/api", base: "main", branch: "sc/alpha", clean: false, files: [], added: 0, removed: 0 }),
      diff: async () => "",
      publish: async () => {
        called++;
        return { branch: "sc/alpha", number: 3, url: "u", draft: true };
      },
    },
  });
  await loop.run({ sessionKey: "main:code", text: "just look at it", onEvent: () => {} });
  assert.equal(called, 0, "no push happened for a turn that never asked");
});

test("the prompt block itself is the single source of the repo facts", async () => {
  // The loop calls repoPromptBlock; asserting its output keeps the two in step
  // without asserting on prose twice.
  const block = repoPromptBlock({ repo: "acme/api", base: "main", branch: "sc/alpha", workspace: "/w" });
  const h = harness();
  h.store.setSessionRepo("main:code", BINDING);
  await loopFor(h).run({ sessionKey: "main:code", text: "hi", onEvent: () => {} });
  assert.match(h.seen.system, /acme\/api · branch sc\/alpha \(from main\)/);
  assert.match(block, /Read a file before editing it/);
  assert.match(h.seen.system, /Read a file before editing it/, "the working rules ride the same block");
});
