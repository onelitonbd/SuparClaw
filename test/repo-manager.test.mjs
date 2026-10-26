// Task 35 — `src/repo/manager.ts`: where the clone lives, what a worktree is
// called, and the three refusals that make publishing safe.
//
// Every git invocation is injected, so these tests describe the *commands* the
// manager builds. That is the part that could quietly hurt someone: a token in
// an argument, a force-push, a push to main.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["SUPARCLAW_STATE_DIR"] = mkdtempSync(join(tmpdir(), "sc-repo-state-"));
delete process.env["GITHUB_TOKEN"];
delete process.env["GH_TOKEN"];

const { RepoManager, branchSlug, repoSegments } = await import("../dist/lib.js");

/** A git that pretends: records argv, answers from a handler table. */
function fakeGit(handler = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, opts });
    return handler(args, opts) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const root = mkdtempSync(join(tmpdir(), "sc-repos-"));

test("a repo name is split, and a session key becomes one branch slug", () => {
  assert.deepEqual(repoSegments("onelitonbd/SuparClaw"), { owner: "onelitonbd", name: "SuparClaw" });
  assert.equal(branchSlug("main:swift-otter"), "swift-otter");
  assert.equal(branchSlug("telegram:12345:m3x9"), "telegram-12345-m3x9", "lowercase and hyphen-joined: readable in a PR list");
  assert.equal(branchSlug("main:Swift_Otter"), "swift-otter");
  assert.equal(branchSlug("main:!!! weird key !!!"), "weird-key", "a slug is safe for git in every shell");
  assert.ok(branchSlug("main:" + "x".repeat(200)).length <= 60, "never long enough to break a ref");
});

test("the cache is shared and the worktree is per session", () => {
  const m = new RepoManager({ root, run: fakeGit().run });
  assert.equal(m.cachePath("acme/api"), join(root, "cache", "acme", "api.git"));
  assert.equal(m.worktreePath("acme/api", "main:one"), join(root, "worktrees", "acme-api", "one"));
  // Two sessions, two checkouts, one object store: a second session on the same
  // repo does not clone again.
  assert.notEqual(m.worktreePath("acme/api", "main:one"), m.worktreePath("acme/api", "main:two"));
});

test("prepare clones once, then adds an sc/* worktree from the base branch", async () => {
  const git = fakeGit((args) => {
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "trunk\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run, host: "github.com" });
  const phases = [];
  const res = await m.prepare({
    repo: "acme/api",
    sessionKey: "main:alpha",
    creds: { token: "gho_tok", login: "me", host: "github.com", source: "token", scopes: [] },
    onProgress: (p) => phases.push(p),
  });

  assert.equal(res.branch, "sc/alpha");
  assert.equal(res.base, "trunk", "the remote's default branch is discovered, not assumed to be main");
  assert.equal(res.workspace, m.worktreePath("acme/api", "main:alpha"));
  assert.deepEqual([...new Set(phases.map((p) => p.phase))], ["clone", "worktree", "done"]);

  const clone = git.calls[0].args;
  assert.ok(clone.includes("--filter=blob:none"), "a partial clone: this is a coding session, not a backup");
  assert.ok(clone.includes("--no-checkout"), "the worktree is the only checkout");
  assert.ok(clone.some((a) => a.endsWith("acme/api.git")));

  const add = git.calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
  assert.ok(add, "a worktree is added for the session");
  assert.ok(add.args.includes("-B") && add.args.includes("sc/alpha"), "on this session's own branch");
  assert.ok(add.args.includes("origin/trunk"), "from the base branch");

  // The credential rides `-c http.https://<host>/.extraheader`, one invocation
  // at a time — never the remote URL, never `.git/config`.
  const withToken = git.calls.flatMap((c) => c.args).filter((a) => a.includes("AUTHORIZATION"));
  assert.ok(withToken.length >= 1);
  assert.ok(withToken.every((a) => a.startsWith("http.https://github.com/.extraheader=")));
  assert.ok(!git.calls.some((c) => c.args.some((a) => a.includes("gho_tok") && a.startsWith("https://"))), "the token is never in a URL");
});

test("a clone failure explains itself and keeps the cache path for a retry", async () => {
  const git = fakeGit((args) => {
    if (args.includes("clone")) return { code: 128, stdout: "", stderr: "remote: Repository not found.\nfatal: repository 'x' not found" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  await assert.rejects(
    () => m.prepare({ repo: "acme/missing", sessionKey: "main:beta" }),
    /repository was not found/i,
  );
});

test("an auth failure says to connect GitHub, not that git exited 128", async () => {
  const git = fakeGit((args) => {
    if (args.includes("clone")) return { code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  await assert.rejects(() => m.prepare({ repo: "acme/private", sessionKey: "main:gamma" }), /needs GitHub credentials/i);
});

test("status reads numstat and untracked files into one list", async () => {
  const git = fakeGit((args) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: "sc/alpha\n", stderr: "" };
    if (args.includes("--numstat")) return { code: 0, stdout: "12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n", stderr: "" };
    if (args.includes("ls-files")) return { code: 0, stdout: "notes.md\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  const st = await m.status("/tmp/wt");
  assert.equal(st.branch, "sc/alpha");
  assert.equal(st.clean, false);
  assert.deepEqual(st.files.map((f) => f.path), ["assets/logo.png", "notes.md", "src/a.ts"]);
  assert.equal(st.added, 12);
  assert.equal(st.removed, 3);
  assert.equal(st.files[0].added, 0, "a binary file counts as 0/0 instead of NaN");
});

test("an empty numstat and no untracked files is a clean tree", async () => {
  const git = fakeGit((args) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: "sc/alpha\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const st = await new RepoManager({ root, run: git.run }).status("/tmp/wt");
  assert.equal(st.clean, true);
  assert.equal(st.added, 0);
});

test("publish refuses: no token, a non-sc branch, the base branch, a clean tree", async () => {
  const m = new RepoManager({ root, run: fakeGit().run });
  const base = {
    workspace: "/tmp/wt",
    repo: "acme/api",
    branch: "sc/alpha",
    base: "main",
    title: "Fix",
    creds: { token: "t", login: "me", host: "github.com", source: "token", scopes: [] },
  };

  await assert.rejects(() => m.publish({ ...base, creds: null }), /not connected/i);
  await assert.rejects(() => m.publish({ ...base, branch: "main" }), /only sc\/\* branches/i);
  await assert.rejects(() => m.publish({ ...base, branch: "feature/x" }), /only sc\/\* branches/i);

  const cleanRepo = new RepoManager({ root, run: fakeGit(() => ({ code: 0, stdout: "", stderr: "" })).run });
  await assert.rejects(() => cleanRepo.publish({ ...base, branch: "sc/x", base: "sc/x" }), /base branch/i);
  await assert.rejects(() => cleanRepo.publish({ ...base, branch: "sc/x", base: "main" }), /nothing to publish/i);
});

test("publish commits, pushes without force, and opens a draft PR by default", async () => {
  const seen = [];
  const git = fakeGit((args) => {
    seen.push(args);
    if (args.includes("--numstat")) return { code: 0, stdout: "2\t0\tsrc/a.ts\n", stderr: "" };
    if (args.includes("rev-parse")) return { code: 0, stdout: "sc/alpha\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  // The PR call is the only network step; stub it through the global fetch.
  const originalFetch = globalThis.fetch;
  let prBody = null;
  globalThis.fetch = async (url, init) => {
    prBody = JSON.parse(init.body);
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ number: 7, html_url: "https://github.com/acme/api/pull/7", draft: true }) };
  };
  try {
    const res = await m.publish({
      workspace: "/tmp/wt",
      repo: "acme/api",
      branch: "sc/alpha",
      base: "main",
      title: "Fix the thing",
      creds: { token: "gho_tok", login: "me", host: "github.com", source: "token", scopes: [] },
    });
    assert.equal(res.prNumber, 7);
    assert.equal(res.draft, true);
    assert.equal(prBody.draft, true);
    assert.equal(prBody.head, "sc/alpha");
    assert.equal(prBody.base, "main");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const push = seen.find((args) => args.includes("push"));
  assert.ok(push, "it pushes");
  assert.ok(!push.includes("--force") && !push.includes("-f"), "publishing never rewrites published history");
  assert.ok(!push.includes("main") || push.includes("sc/alpha"), "it pushes the session branch, never the base");
  const args = push.join(" ");
  assert.ok(!args.includes("gho_tok "), "the token is not a bare argument");
});

test("remove refuses a dirty worktree unless forced", async () => {
  const dir = join(root, "worktrees", "acme-api", "dirty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "file.txt"), "x");
  const git = fakeGit((args) => {
    if (args.includes("--numstat")) return { code: 0, stdout: "1\t0\tfile.txt\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });

  const refused = await m.remove({ repo: "acme/api", sessionKey: "main:dirty" });
  assert.equal(refused.removed, false);
  assert.equal(refused.dirty, true, "unpushed work is never deleted on a whim");
  assert.ok(existsSync(dir));

  const forced = await m.remove({ repo: "acme/api", sessionKey: "main:dirty", force: true });
  assert.equal(forced.removed, true);
});

test("a missing worktree is not an error to remove", async () => {
  const m = new RepoManager({ root, run: fakeGit().run });
  assert.deepEqual(await m.remove({ repo: "acme/api", sessionKey: "main:never" }), { removed: false, dirty: false });
});
