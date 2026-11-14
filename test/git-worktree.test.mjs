// Task 39 — `.git` is a *file* in a code session's checkout.
//
// Every code session works in a linked git worktree
// (`repos/worktrees/<owner>-<repo>/<slug>`), where `git worktree add` writes a
// one-line `.git` pointer instead of a directory. Two things broke on that:
//
//   * `fs_read .git/HEAD` — the obvious "which branch am I on?" — opened
//     `<worktree>/.git/HEAD` and got `ENOTDIR: not a directory`, which the loop
//     duly printed as `error: ENOTDIR: …`.
//   * `sc update` swallowed the same ENOTDIR in a catch meant for unpacked
//     installs and silently reported `main` / `unknown`.
//
// These tests build a real repository with a real `git worktree add`, so the
// fixture is whatever git actually writes — not a hand-made approximation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lib = await import("../dist/lib.js");
const { gitDirOf, gitHead, gitRefSha, gitIsFile, gitCommonDir, resolveRef, currentSha, emptyConfig, buildRegistry } = lib;

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return process.cwd();
})();

/** A repo with one commit, a linked worktree on `sc/feature`, and a plain clone. */
function fixture() {
  const base = mkdtempSync(join(TEST_TMP, "sc-worktree-"));
  const main = join(base, "main");
  mkdirSync(main);
  const at = (dir) => (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = at(main);
  git("init", "-q", "-b", "trunk");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "Task 39");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(main, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  const first = git("rev-parse", "HEAD").trim();

  // The layout RepoManager uses: repos/cache/<owner>/<name>.git + repos/worktrees/…
  mkdirSync(join(base, "cache"), { recursive: true });
  const worktree = join(base, "cache", "onelitonbd-SuparClaw");
  git("worktree", "add", "-q", "-b", "sc/feature", worktree);
  writeFileSync(join(worktree, "b.txt"), "second\n");
  at(worktree)("add", "-A");
  at(worktree)("commit", "-qm", "two");
  const tip = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { base, main, worktree, first, tip, git };
}

const hub = fixture();

test(".git is a file in the worktree and a directory in the clone", () => {
  assert.equal(gitIsFile(hub.worktree), true, "the fixture really is a linked worktree");
  assert.equal(gitIsFile(hub.main), false);
  assert.match(readFileSync(join(hub.worktree, ".git"), "utf8"), /^gitdir: /);
  assert.equal(gitDirOf(hub.main), join(hub.main, ".git"), "a clone resolves to itself");
  assert.match(gitDirOf(hub.worktree) ?? "", /worktrees[\\/]/, "a worktree resolves to its git dir");
  assert.equal(gitCommonDir(gitDirOf(hub.worktree)), join(hub.main, ".git"), "branch refs live in the shared common dir");
});

test("gitHead reads the branch and the commit, exactly as git does", () => {
  const head = gitHead(hub.worktree);
  assert.equal(head?.ref, "sc/feature", "the branch, not main");
  assert.equal(head?.sha, hub.tip);
  assert.equal(head?.text, "ref: refs/heads/sc/feature", "byte-for-byte what a clone's .git/HEAD holds");
  assert.equal(gitHead(hub.main)?.ref, "trunk");
  assert.equal(gitHead(join(hub.base, "nope")), null, "no .git, no answer");
});

test("sc update follows the branch a worktree is on (was: silently main/unknown)", () => {
  assert.equal(resolveRef(hub.worktree), "sc/feature");
  assert.equal(currentSha(hub.worktree), hub.tip);
  assert.equal(resolveRef(hub.worktree, "zeta"), "zeta", "--ref still wins");
  // Unchanged contracts: a clone, and a plain directory with a recorded ref.
  assert.equal(resolveRef(hub.main), "trunk");
  assert.equal(currentSha(hub.main), execFileSync("git", ["-C", hub.main, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  const bare = join(hub.base, "unpacked");
  mkdirSync(bare);
  writeFileSync(join(bare, lib.INSTALL_REF_FILE), "arena/439621f4-suparclaw\n");
  assert.equal(resolveRef(bare), "arena/439621f4-suparclaw", "Task 37: the recorded ref still decides");
  assert.equal(resolveRef(join(hub.base, "nothing")), "main");
});

test("a packed branch ref still resolves", () => {
  const { worktree, main } = hub;
  execFileSync("git", ["-C", main, "pack-refs", "--all"], { stdio: "ignore" });
  // The loose ref file is gone; the value now lives in the common dir's packed-refs.
  assert.equal(gitHead(worktree)?.ref, "sc/feature", "HEAD still names the branch");
  assert.equal(gitRefSha(worktree, "refs/heads/sc/feature"), hub.tip);
  assert.equal(currentSha(worktree), hub.tip);
});

test("a detached HEAD reports its commit and no branch", () => {
  const detached = join(hub.base, "cache", "detached");
  execFileSync("git", ["-C", hub.main, "worktree", "add", "-q", "--detach", detached, hub.tip], { stdio: "ignore" });
  const head = gitHead(detached);
  assert.equal(head?.ref, null, "detached: no branch to update");
  assert.equal(head?.sha, hub.tip);
  assert.equal(currentSha(detached), hub.tip);
  assert.equal(resolveRef(detached), "main", "no branch and no record ⇒ the old fallback, unchanged");
});

/* ---------------- the tools an agent actually calls ---------------- */

const tools = buildRegistry(emptyConfig());
const tool = (name) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} is registered`);
  return t;
};
const ctxFor = (workspace) => ({ workspace, stateDir: workspace, skills: [], approved: true, config: emptyConfig() });

test("fs_read .git/HEAD answers in a worktree instead of ENOTDIR", async () => {
  const ctx = ctxFor(hub.worktree);
  const head = await tool("fs_read").run({ path: ".git/HEAD" }, ctx);
  assert.equal(head.trim(), "ref: refs/heads/sc/feature");
  // A loose ref written now, so this does not depend on what an earlier test packed.
  execFileSync("git", ["-C", hub.main, "update-ref", "refs/heads/sc/loose", hub.first], { stdio: "ignore" });
  const refs = await tool("fs_read").run({ path: ".git/refs/heads/sc/loose" }, ctx);
  assert.equal(refs.trim(), hub.first, "a loose ref reads through the pointer too");
  const missing = await tool("fs_read").run({ path: ".git/refs/heads/nope" }, ctx);
  assert.equal(missing, "error: no such ref: nope");
  const packed = await tool("fs_read").run({ path: ".git/packed-refs" }, ctx);
  assert.match(packed, /refs\/heads\/sc\/feature|no packed refs/, "packed-refs is readable or says it is empty");
});

test("everything else inside .git is refused with words, never a bare ENOTDIR", async () => {
  const ctx = ctxFor(hub.worktree);
  const config = await tool("fs_read").run({ path: ".git/config" }, ctx);
  assert.match(config, /^error: /);
  assert.match(config, /linked git worktree/);
  assert.match(config, /sc\/feature/, "the refusal already answers the branch question");
  assert.match(config, /outside the workspace sandbox/);
  const whole = await tool("fs_read").run({ path: ".git" }, ctx);
  assert.match(whole, /\.git is a file here/);
  const list = await tool("fs_list").run({ path: "." }, ctx);
  const listed = await tool("fs_list").run({ path: ".git" }, ctx);
  assert.match(listed, /linked git worktree/, "listing .git explains it");
  assert.ok(!list.includes("ENOTDIR"));
});

test("writing or editing git metadata is refused — git owns it", async () => {
  const ctx = ctxFor(hub.worktree);
  const wrote = await tool("fs_write").run({ path: ".git/HEAD", content: "ref: refs/heads/main\n" }, ctx);
  assert.match(wrote, /^error: git owns \.git/);
  assert.equal(readFileSync(join(hub.worktree, ".git"), "utf8").includes("worktrees"), true, "the pointer is untouched");
  const edited = await tool("fs_edit").run({ path: ".git/HEAD", old: "sc/feature", new: "main" }, ctx);
  assert.match(edited, /^error: git owns \.git/);
  assert.equal(gitHead(hub.worktree)?.ref, "sc/feature");
});

test("a clone keeps reading its .git directory the ordinary way", async () => {
  const ctx = ctxFor(hub.main);
  const head = await tool("fs_read").run({ path: ".git/HEAD" }, ctx);
  assert.equal(head.trim(), "ref: refs/heads/trunk");
  const list = await tool("fs_list").run({ path: ".git" }, ctx);
  assert.match(list, /HEAD|refs\//, "a real .git directory still lists");
});
