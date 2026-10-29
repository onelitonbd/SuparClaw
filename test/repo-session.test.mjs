// Task 35 — session binding (`src/repo/session.ts`) and the repository tool contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["SUPARCLAW_STATE_DIR"] = mkdtempSync(join(tmpdir(), "sc-session-state-"));
process.env["SUPARCLAW_DB"] = join(process.env["SUPARCLAW_STATE_DIR"], "test.db");
delete process.env["GITHUB_TOKEN"];
delete process.env["GH_TOKEN"];

const { Store, bindSessionRepo, unbindSessionRepo, repoPromptBlock } = await import("../dist/lib.js");

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

test("the prompt block gives repo facts without a current-turn publishing gate", () => {
  const prompt = repoPromptBlock({ repo: "acme/api", base: "main", branch: "sc/x", workspace: "/w/x" });
  assert.match(prompt, /acme\/api · branch sc\/x \(from main\)/);
  assert.match(prompt, /Workspace: \/w\/x/);
  assert.match(prompt, /github_publish commits the session branch, pushes it, and opens a pull request/);
  assert.match(prompt, /Never force-push or push to the default branch/);
  assert.doesNotMatch(prompt, /only when the user asks|asked for a pull request in this turn/i);
});

test("a chosen branch is continued, and the prompt says which branch that is", async () => {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-branch-")), "s.db"));
  store.ensureSession("main:keep");
  const manager = managerFor({ workspace: "/tmp/wt/keep", branch: "feature/login", base: "main", localRef: "feature/login" });

  // Task 36: the user picked this branch in the picker.
  const res = await bindSessionRepo({ store, manager, sessionKey: "main:keep", repo: "acme/api", branch: "feature/login" });
  assert.equal(res.ok, true);
  assert.equal(manager.calls[0].branch, "feature/login", "the picker's branch reaches prepare");
  assert.ok(!String(manager.calls[0].branch).startsWith("sc/"), "no session branch is manufactured");
  assert.deepEqual(store.getSessionRepo("main:keep"), {
    kind: "code",
    repo: "acme/api",
    base: "main",
    branch: "feature/login",
    workspace: "/tmp/wt/keep",
  });

  const prompt = repoPromptBlock({ repo: "acme/api", base: "main", branch: "feature/login", workspace: "/tmp/wt/keep" });
  assert.match(prompt, /acme\/api · branch feature\/login \(from main\)/, "the prompt names the continued branch and its base");
  assert.match(prompt, /Work on the branch you are given \(feature\/login\)\. Do not switch branches or create one; that is the user's choice\./);

  // Working on the default branch reads differently, because publishing does.
  const onBase = repoPromptBlock({ repo: "acme/api", base: "main", branch: "main", workspace: "/tmp/wt/keep" });
  assert.match(onBase, /branch main \(the default branch\)/);
  assert.match(repoPromptBlock({ repo: "a/b", base: "main", branch: "main", workspace: "/w" }), /Never force-push/);
});

test("github_publish runs for a bound repo without current-turn intent metadata", async () => {
  const { buildRegistry, emptyConfig } = await import("../dist/lib.js");
  const calls = [];
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "sc-publish-")), "s.db"));
  store.ensureSession("main:repo");
  store.setSessionRepo("main:repo", { kind: "code", repo: "acme/api", base: "main", branch: "sc/repo", workspace: "/tmp/wt/repo" });
  const repoCtl = {
    status: async () => ({ repo: "acme/api", base: "main", branch: "sc/repo", clean: false, files: [{ path: "a.ts", added: 1, removed: 0 }], added: 1, removed: 0 }),
    diff: async () => "diff --git a/a.ts b/a.ts",
    publish: async (input) => { calls.push(input); return { branch: "sc/repo", number: 9, url: "https://github.com/acme/api/pull/9", draft: true }; },
  };
  const ctx = { workspace: "/tmp/wt/repo", store, sessionKey: "main:repo", config: emptyConfig(),
    repo: { kind: "code", repo: "acme/api", base: "main", branch: "sc/repo", workspace: "/tmp/wt/repo" }, repoCtl };
  const tools = buildRegistry(emptyConfig());
  const publishTool = tools.find((tool) => tool.name === "github_publish");
  assert.ok(publishTool);
  assert.match(String(await publishTool.run({ title: "Fix" }, ctx)), /pull\/9/);
  assert.equal(calls.length, 1);
  const statusTool = tools.find((tool) => tool.name === "repo_status");
  assert.match(String(await statusTool.run({}, ctx)), /a\.ts/);
  assert.match(String(await publishTool.run({ title: "Fix" }, { ...ctx, repo: undefined })), /not bound to a repository/);
  assert.equal(calls.length, 1, "repository binding remains a technical prerequisite");
});
