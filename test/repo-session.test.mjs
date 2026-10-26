// Task 35 — session binding (`src/repo/session.ts`) and the two enforcement
// layers of the publish rule.
//
// The product decision this file protects: *a pull request happens only when
// the user asks for one in that turn*. Layer 1 is the surface (a button or a
// command), layer 2 is the tool refusing when the turn did not ask, and the
// system prompt is layer 3 (a rule the model reads). A prompt alone is not a
// gate, so both code layers are tested here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["SUPARCLAW_STATE_DIR"] = mkdtempSync(join(tmpdir(), "sc-session-state-"));
process.env["SUPARCLAW_DB"] = join(process.env["SUPARCLAW_STATE_DIR"], "test.db");
delete process.env["GITHUB_TOKEN"];
delete process.env["GH_TOKEN"];

const { Store, bindSessionRepo, unbindSessionRepo, repoPromptBlock, publishRequested } = await import("../dist/lib.js");

function managerFor(result) {
  const calls = [];
  return {
    calls,
    prepare: async (input) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("binding writes the five columns and reads them back", async () => {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-bind-")), "s.db"));
  store.ensureSession("main:code-one");
  const manager = managerFor({ workspace: "/tmp/wt/one", branch: "sc/code-one", base: "main" });

  const res = await bindSessionRepo({ store, manager, sessionKey: "main:code-one", repo: "acme/api" });
  assert.equal(res.ok, true);
  assert.deepEqual(store.getSessionRepo("main:code-one"), {
    kind: "code",
    repo: "acme/api",
    base: "main",
    branch: "sc/code-one",
    workspace: "/tmp/wt/one",
  });
  assert.equal(manager.calls[0].repo, "acme/api");

  // `sessions.list` is SELECT *, so the UI gets these for free.
  const row = store.listSessions(10).find((s) => s.key === "main:code-one");
  assert.equal(row.repo, "acme/api");
  assert.equal(row.kind, "code");

  unbindSessionRepo(store, "main:code-one");
  assert.equal(store.getSessionRepo("main:code-one"), null);
});

test("rebinding to the same repo is a no-op; another repo is refused with a sentence", async () => {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-bind-")), "s.db"));
  store.ensureSession("main:code-two");
  const manager = managerFor({ workspace: "/tmp/wt/two", branch: "sc/code-two", base: "main" });
  await bindSessionRepo({ store, manager, sessionKey: "main:code-two", repo: "acme/api" });

  const again = await bindSessionRepo({ store, manager, sessionKey: "main:code-two", repo: "acme/api" });
  assert.equal(again.ok, true);
  assert.equal(manager.calls.length, 1, "the worktree is not prepared twice");

  const other = await bindSessionRepo({ store, manager, sessionKey: "main:code-two", repo: "acme/other" });
  assert.equal(other.ok, false);
  assert.match(other.error, /working in acme\/api/);
  assert.match(other.error, /Start a new session for another repository/);
  assert.equal(store.getSessionRepo("main:code-two").repo, "acme/api", "the first binding survives");
});

test("a prepare failure leaves the session unbound and says why", async () => {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-bind-")), "s.db"));
  store.ensureSession("main:code-three");
  const manager = managerFor(new Error("clone failed: the repository was not found"));
  const res = await bindSessionRepo({ store, manager, sessionKey: "main:code-three", repo: "acme/missing" });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
  assert.equal(store.getSessionRepo("main:code-three"), null, "a half-bound session would be worse than an unbound one");
});

test("the progress callback is passed straight through, so surfaces share one stream", async () => {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-prog-")), "s.db"));
  store.ensureSession("main:code-four");
  const seen = [];
  const manager = {
    prepare: async (input) => {
      input.onProgress?.({ phase: "clone", pct: 5, detail: "acme/api" });
      input.onProgress?.({ phase: "worktree", pct: 70, detail: "main" });
      input.onProgress?.({ phase: "done", pct: 100 });
      return { workspace: "/tmp/wt/four", branch: "sc/code-four", base: "main" };
    },
  };
  await bindSessionRepo({ store, manager, sessionKey: "main:code-four", repo: "acme/api", onProgress: (p) => seen.push(p) });
  assert.deepEqual(seen.map((p) => p.phase), ["clone", "worktree", "done"], "the caller's callback is the one the manager calls");
});

test("the prompt block carries the branch, the workspace and the publish rule", () => {
  const off = repoPromptBlock({ repo: "acme/api", base: "main", branch: "sc/x", workspace: "/w/x" });
  assert.match(off, /acme\/api · branch sc\/x \(from main\)/);
  assert.match(off, /Workspace: \/w\/x/);
  assert.match(off, /Publish only when the user asks in this turn/);
  assert.match(off, /Never force-push/);
  assert.doesNotMatch(off, /asked for a pull request in this turn/);

  const on = repoPromptBlock({ repo: "acme/api", base: "main", branch: "sc/x", workspace: "/w/x", publishAllowed: true });
  assert.match(on, /asked for a pull request in this turn/);
});

test("publishRequested recognises an ask and ignores ordinary work", () => {
  const yes = [
    "open a PR when you're done",
    "please create a pull request",
    "can you raise a PR for this",
    "publish this branch",
    "/pr",
    "make a PR with the fix",
    "submit a pull request now",
  ];
  for (const text of yes) assert.equal(publishRequested(text), true, `should publish: ${text}`);

  const no = [
    "fix the failing test",
    "what does the PR template say?",
    "review the pull request my colleague opened",
    "summarise the diff",
    "",
  ];
  for (const text of no) assert.equal(publishRequested(text), false, `must not publish: ${text}`);
});

test("the tool refuses when the turn did not ask — layer 2 of the gate", async () => {
  const { buildRegistry, emptyConfig } = await import("../dist/lib.js");
  const calls = [];
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-gate-")), "s.db"));
  store.ensureSession("main:gate");
  store.setSessionRepo("main:gate", { kind: "code", repo: "acme/api", base: "main", branch: "sc/gate", workspace: "/tmp/wt/gate" });

  const repoCtl = {
    status: async () => ({
      repo: "acme/api",
      base: "main",
      branch: "sc/gate",
      clean: false,
      files: [{ path: "a.ts", added: 1, removed: 0 }],
      added: 1,
      removed: 0,
    }),
    diff: async () => "diff --git a/a.ts b/a.ts",
    publish: async (input) => {
      calls.push(input);
      return { branch: "sc/gate", number: 9, url: "https://github.com/acme/api/pull/9", draft: true };
    },
  };
  const ctx = (publishAllowed) => ({
    workspace: "/tmp/wt/gate",
    store,
    sessionKey: "main:gate",
    config: emptyConfig(),
    repo: { kind: "code", repo: "acme/api", base: "main", branch: "sc/gate", workspace: "/tmp/wt/gate" },
    repoCtl,
    publishAllowed,
  });

  const tools = buildRegistry(emptyConfig());
  const publishTool = tools.find((t) => t.name === "github_publish");
  assert.ok(publishTool, "the tool exists");

  const refused = await publishTool.run({ title: "Fix" }, ctx(false));
  assert.match(String(refused), /did not ask for a pull request/i);
  assert.equal(calls.length, 0, "nothing was pushed");

  const statusTool = tools.find((t) => t.name === "repo_status");
  const status = await statusTool.run({}, ctx(false));
  assert.match(String(status), /a\.ts/, "repo_status reads the worktree, which is allowed any time");

  // The same tool, with the gate open, publishes exactly once.
  const done = await publishTool.run({ title: "Fix" }, ctx(true));
  assert.match(String(done), /pull\/9/);
  assert.equal(calls.length, 1);

  // And it still refuses outside a repository, whatever the flag says.
  const unbound = await publishTool.run({ title: "Fix" }, { ...ctx(true), repo: undefined });
  assert.match(String(unbound), /not bound to a repository/);
  assert.equal(calls.length, 1);
});
