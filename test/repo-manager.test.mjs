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

const { RepoManager, branchSlug, repoSegments, isPlainBranchName, publishBranchFor } = await import("../dist/lib.js");

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

test("prepare continues the branch you picked — it does not invent sc/*", async () => {
  const git = fakeGit((args) => {
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "trunk\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run, host: "github.com" });
  const phases = [];
  const res = await m.prepare({
    repo: "acme/api",
    sessionKey: "main:alpha",
    // Task 36: the user picked this branch in the picker.
    branch: "feature/login",
    creds: { token: "gho_tok", login: "me", host: "github.com", source: "token", scopes: [] },
    onProgress: (p) => phases.push(p),
  });

  assert.equal(res.branch, "feature/login", "the branch the user chose is the branch the agent gets");
  assert.equal(res.localRef, "feature/login");
  assert.equal(res.base, "trunk", "the remote's default branch is discovered, not assumed to be main");
  assert.equal(res.workspace, m.worktreePath("acme/api", "main:alpha"));
  assert.deepEqual([...new Set(phases.map((p) => p.phase))], ["clone", "worktree", "done"]);

  const clone = git.calls[0].args;
  assert.ok(clone.includes("--filter=blob:none"), "a partial clone: this is a coding session, not a backup");
  assert.ok(clone.includes("--no-checkout"), "the worktree is the only checkout");
  assert.ok(clone.some((a) => a.endsWith("acme/api.git")));

  const add = git.calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
  assert.ok(add, "a worktree is added for the session");
  const all = add.args.join(" ");
  assert.ok(!all.includes("sc/alpha"), "no session branch is created any more");
  assert.ok(!add.args.includes("-B"), "-B would reset an existing branch — the point is to continue it");
  assert.ok(add.args.includes("feature/login"), "checked out under its own name");
  assert.ok(add.args.includes("origin/feature/login"), "starting from the remote's tip of that branch");

  // The credential rides `-c http.https://<host>/.extraheader`, one invocation
  // at a time — never the remote URL, never `.git/config`.
  const withToken = git.calls.flatMap((c) => c.args).filter((a) => a.includes("AUTHORIZATION"));
  assert.ok(withToken.length >= 1);
  assert.ok(withToken.every((a) => a.startsWith("http.https://github.com/.extraheader=")));
  assert.ok(!git.calls.some((c) => c.args.some((a) => a.includes("gho_tok") && a.startsWith("https://"))), "the token is never in a URL");
});

test("prepare with no branch continues the default branch, still without sc/*", async () => {
  const git = fakeGit((args) => {
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "trunk\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  const res = await m.prepare({ repo: "acme/default", sessionKey: "main:plain" });
  assert.equal(res.branch, "trunk");
  assert.equal(res.base, "trunk");
  const add = git.calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
  assert.ok(add.args.includes("trunk"), "the default branch is checked out as itself");
  assert.ok(!add.args.join(" ").includes("sc/"), "the session branch is a publish-time idea, not a checkout-time one");
});

test("a branch another worktree already holds gets a local alias, not a reset", async () => {
  const git = fakeGit((args) => {
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "main\n", stderr: "" };
    // The branch already has a local ref…
    if (args.includes("rev-parse") && args.includes("refs/heads/feature/x")) return { code: 0, stdout: "abc123\n", stderr: "" };
    // …and another worktree has it checked out.
    if (args.includes("worktree") && args.includes("list")) {
      return { code: 0, stdout: "worktree /tmp/other\nHEAD abc123\nbranch refs/heads/feature/x\n\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  const res = await m.prepare({ repo: "acme/alias", sessionKey: "main:beta", branch: "feature/x" });
  assert.equal(res.branch, "feature/x", "the session still reports the chosen branch");
  assert.equal(res.localRef, "feature/x-beta", "the local ref is aliased so two checkouts can share the branch name");
  const add = git.calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
  assert.ok(add.args.includes("-b") && add.args.includes("feature/x-beta"), "a new local ref that points at the branch's tip");
  assert.ok(!add.args.includes("-B"), "never reset the branch someone else is working on");
});

test("a branch that is missing on origin says which one and what to do", async () => {
  const git = fakeGit((args) => {
    const all = args.join(" ");
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "main\n", stderr: "" };
    if (all.includes("worktree") && args.includes("add")) {
      return { code: 128, stdout: "", stderr: "fatal: invalid reference: origin/feature/nope" };
    }
    if (args.includes("fetch")) return { code: 128, stdout: "", stderr: "fatal: couldn't find remote ref feature/nope" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  await assert.rejects(
    () => m.prepare({ repo: "acme/noref", sessionKey: "main:gone", branch: "feature/nope" }),
    /the branch "feature\/nope" was not found on origin — pick another branch, or push it first/,
  );
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

test("publish refuses: no token, an unsafe branch name, a clean tree", async () => {
  const m = new RepoManager({ root, run: fakeGit().run });
  const base = {
    workspace: "/tmp/wt",
    repo: "acme/api",
    branch: "feature/x",
    base: "main",
    title: "Fix",
    creds: { token: "t", login: "me", host: "github.com", source: "token", scopes: [] },
  };

  await assert.rejects(() => m.publish({ ...base, creds: null }), /not connected/i);
  // Task 36: any plain branch is publishable, but never a name git or a shell
  // could misread — those came from a picker, so one here means a bug upstream.
  await assert.rejects(() => m.publish({ ...base, branch: "feature/x y" }), /not a plain branch name/i);
  await assert.rejects(() => m.publish({ ...base, branch: "-evil" }), /not a plain branch name/i);

  const cleanRepo = new RepoManager({ root, run: fakeGit(() => ({ code: 0, stdout: "", stderr: "" })).run });
  await assert.rejects(() => cleanRepo.publish({ ...base, branch: "feature/x", base: "main" }), /nothing to publish/i);
});

test("the publish target is the continued branch, or sc/<slug> when that branch is the base", () => {
  // Task 36's table, read from the one function both `publish` and the UI use.
  assert.equal(publishBranchFor("feature/x", "main", "main:alpha"), "feature/x", "a feature branch is pushed as itself");
  assert.equal(publishBranchFor("main", "main", "main:alpha"), "sc/alpha", "working on main publishes to a session branch");
  assert.equal(publishBranchFor("main", "trunk", "main:alpha"), "main", "a non-default branch is never renamed");
  assert.notEqual(publishBranchFor("main", "main", "telegram:99:m1"), "main", "the base branch is never the push target");
});

test("isPlainBranchName rejects what git would choke on", () => {
  for (const ok of ["main", "feature/x", "release-1.2", "user/fix-thing_2"]) assert.equal(isPlainBranchName(ok), true, ok);
  for (const bad of ["", "has space", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "/lead", "trail/", "a//b", "a..b", "-lead", "x.lock", "x".repeat(201)]) {
    assert.equal(isPlainBranchName(bad), false, JSON.stringify(bad));
  }
});

test("publish on the default branch pushes sc/<slug>, never the base", async () => {
  const seen = [];
  const git = fakeGit((args) => {
    seen.push(args);
    if (args.includes("--numstat")) return { code: 0, stdout: "2\t0\tsrc/a.ts\n", stderr: "" };
    if (args.includes("rev-parse")) return { code: 0, stdout: "main\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  const originalFetch = globalThis.fetch;
  let prBody = null;
  globalThis.fetch = async (_url, init) => {
    prBody = JSON.parse(init.body);
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ number: 12, html_url: "https://github.com/acme/api/pull/12", draft: false }) };
  };
  try {
    const res = await m.publish({
      workspace: "/tmp/wt",
      repo: "acme/api",
      branch: "main",
      base: "main",
      sessionKey: "main:alpha",
      title: "Fix the thing",
      draft: false,
      creds: { token: "gho_tok", login: "me", host: "github.com", source: "token", scopes: [] },
    });
    assert.equal(res.branch, "sc/alpha", "the commits land on a session branch");
    assert.equal(prBody.head, "sc/alpha");
    assert.equal(prBody.base, "main");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const push = seen.find((args) => args.includes("push"));
  assert.ok(push.includes("HEAD:refs/heads/sc/alpha"), "the refspec names the session branch");
  assert.ok(!push.some((a) => a === "refs/heads/main"), "main is not a push target");
  assert.ok(!push.includes("--force") && !push.includes("-f"), "never rewrite published history");
});

test("publish on a feature branch pushes that branch, and a moved branch is refused loudly", async () => {
  const seen = [];
  let pushCode = 0;
  const git = fakeGit((args) => {
    seen.push(args);
    if (args.includes("--numstat")) return { code: 0, stdout: "1\t0\ta.ts\n", stderr: "" };
    if (args.includes("push")) return { code: pushCode, stdout: "", stderr: pushCode ? " ! [rejected] feature/x -> feature/x (non-fast-forward)\nerror: failed to push" : "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ number: 3, html_url: "u", draft: true }) });
  const args = {
    workspace: "/tmp/wt",
    repo: "acme/api",
    branch: "feature/x",
    base: "main",
    sessionKey: "main:alpha",
    title: "Fix",
    creds: { token: "gho_tok", login: "me", host: "github.com", source: "token", scopes: [] },
  };
  try {
    const res = await m.publish(args);
    assert.equal(res.branch, "feature/x", "the branch you picked is the branch the PR comes from");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const push = seen.find((a) => a.includes("push"));
  assert.ok(push.includes("HEAD:refs/heads/feature/x"));

  pushCode = 1;
  await assert.rejects(
    () => m.publish(args),
    /feature\/x moved on GitHub since this session started — pull it in and publish again. Nothing was overwritten\./,
  );
  assert.ok(!seen.filter((a) => a.includes("push")).some((a) => a.includes("--force")), "the refusal is never replaced by a force-push");
});

test("a protected branch refusal names the branch, not the git exit code", async () => {
  const git = fakeGit((args) => {
    if (args.includes("--numstat")) return { code: 0, stdout: "1\t0\ta.ts\n", stderr: "" };
    if (args.includes("push")) return { code: 1, stdout: "", stderr: "remote: error: GH006: Protected branch update failed\n" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const m = new RepoManager({ root, run: git.run });
  await assert.rejects(
    () => m.publish({
      workspace: "/tmp/wt",
      repo: "acme/api",
      branch: "main",
      base: "main",
      sessionKey: "main:alpha",
      title: "Fix",
      creds: { token: "gho_tok", login: "me", host: "github.com", source: "token", scopes: [] },
    }),
    /GitHub refused the push: sc\/alpha is protected/,
  );
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
