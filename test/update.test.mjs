// P2 #13 — sc update pure decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseRepoSlug, resolveRef, currentSha, computeUpdatePlan, fetchRemoteHead, INSTALL_REF_FILE } = await import("../dist/lib.js");

test("parseRepoSlug reads the three github shapes", () => {
  assert.deepEqual(parseRepoSlug("https://github.com/a/b.git"), { owner: "a", repo: "b" });
  assert.deepEqual(parseRepoSlug({ url: "git@github.com:onelitonbd/SuparClaw" }), { owner: "onelitonbd", repo: "SuparClaw" });
  assert.equal(parseRepoSlug({ url: "https://example.com/a/b" }), null);
  assert.equal(parseRepoSlug(undefined), null);
});

test("resolveRef: flag > .git HEAD branch > main; currentSha: branch ref, detached, stamp, unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-update-"));
  assert.equal(resolveRef(dir, "beta"), "beta");
  assert.equal(resolveRef(dir), "main", "no .git at all");
  assert.equal(currentSha(dir), "unknown");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/arena/16378222-suparclaw\n");
  mkdirSync(join(dir, ".git", "refs", "heads", "arena"), { recursive: true });
  writeFileSync(join(dir, ".git", "refs", "heads", "arena", "16378222-suparclaw"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  assert.equal(resolveRef(dir), "arena/16378222-suparclaw");
  assert.equal(currentSha(dir), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("an unpacked install updates the ref it was installed from (Task 37)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-ref-"));
  assert.equal(INSTALL_REF_FILE, ".suparclaw-ref", "the file install.sh writes");
  assert.equal(resolveRef(dir), "main", "an old install with no ref file is unchanged");

  writeFileSync(join(dir, INSTALL_REF_FILE), "arena/439621f4-suparclaw\n");
  assert.equal(resolveRef(dir), "arena/439621f4-suparclaw", "the recorded branch wins over the default");
  assert.equal(resolveRef(dir, "beta"), "beta", "an explicit --ref still wins over the file");
  assert.equal(resolveRef(dir, "  "), "arena/439621f4-suparclaw", "a blank flag is not a ref");

  // A blank/whitespace file is not a ref either — it must not become "".
  writeFileSync(join(dir, INSTALL_REF_FILE), "   \n");
  assert.equal(resolveRef(dir), "main");

  // A git checkout describes itself; the recorded file never overrides it.
  mkdirSync(join(dir, ".git", "refs", "heads", "arena"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/arena/other\n");
  writeFileSync(join(dir, INSTALL_REF_FILE), "arena/439621f4-suparclaw\n");
  assert.equal(resolveRef(dir), "arena/other", ".git/HEAD beats the file");

  // And install.sh must actually write it, or the whole thing is decoration.
  const installer = readFileSync(join(process.cwd(), "install.sh"), "utf8");
  assert.match(installer, /printf '%s\\n' "\$REF" > "\$PREFIX_DIR\/current\/\.suparclaw-ref"/, "install.sh records the ref it unpacked");
  assert.match(installer, /--ref <branch\|tag>   install another ref \(default: main\)/, "--ref is documented in the installer header");
});

test("computeUpdatePlan: prefix-tolerant sha compare", () => {
  const long = "b".repeat(40);
  assert.equal(computeUpdatePlan("bbbbbbb", long, "2026-10-22", "main").upToDate, true);
  assert.equal(computeUpdatePlan(long, "bbbbbbb", "2026-10-22", "main").upToDate, true);
  assert.equal(computeUpdatePlan("unknown", long, "2026-10-22", "main").upToDate, false);
  assert.equal(computeUpdatePlan("c".repeat(40), long, "2026-10-22", "main").upToDate, false);
});

test("fetchRemoteHead validates the api response shape (injected fetch)", async () => {
  const okFetch = async () => new Response(JSON.stringify([{ sha: "f".repeat(40), commit: { committer: { date: "2026-10-22T00:00:00Z" } } }]), { status: 200 });
  const head = await fetchRemoteHead({ owner: "onelitonbd", repo: "SuparClaw" }, "main", okFetch);
  assert.ok(head.sha.startsWith("f"));
  const badFetch = async () => new Response("rate limited", { status: 403 });
  await assert.rejects(fetchRemoteHead({ owner: "a", repo: "b" }, "main", badFetch), /HTTP 403/);
  await assert.rejects(fetchRemoteHead({ owner: "a", repo: "b" }, "main", async () => new Response("[]", { status: 200 })), /no commits/);
});
