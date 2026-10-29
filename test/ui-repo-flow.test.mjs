// Task 38 — the web shell's repo state, driven for real.
//
// The bug reports were all "it shows the wrong thing": a brand-new chat wearing
// the previous session's repository bar, a branch filter from the last repo
// hiding this one's branches, a recent repo with no default branch. Those are
// ordering bugs in async code, so they are reproduced here by controlling when
// each `repo.status` / `repo.bind` answer lands — with linkedom as the DOM and
// the real `ui/src/repo.ts` bundled by esbuild.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();
const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return ROOT;
})();

const dom = parseHTML(readFileSync(join(ROOT, "ui/index.html"), "utf8"));
globalThis.document = dom.document;
globalThis.window = dom.window;
globalThis.HTMLElement = dom.HTMLElement;
globalThis.HTMLInputElement = dom.HTMLInputElement ?? dom.HTMLElement;
globalThis.CSS = { escape: (s) => s };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.WebSocket = class { static OPEN = 1; readyState = 1; };
globalThis.localStorage = { getItem: () => "", setItem: () => {}, removeItem: () => {} };
globalThis.location = { hash: "", search: "", pathname: "/" };
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-repo-flow-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/dom.ts"), join(ROOT, "ui/src/rpc.ts"), join(ROOT, "ui/src/repo.ts")],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
  logLevel: "error",
});
const rpc = await import(pathToFileURL(join(outDir, "rpc.mjs")).href);
const repo = await import(pathToFileURL(join(outDir, "repo.mjs")).href);

/** A promise whose resolution this test decides. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Every RPC in one place: the test supplies the answers. */
function stubGateway(handler) {
  const calls = [];
  rpc.gateway.request = async (method, params = {}) => {
    calls.push({ method, params });
    const answer = handler(method, params, calls);
    return answer === undefined ? {} : answer;
  };
  return calls;
}

const $ = (id) => globalThis.document.getElementById(id);
const bar = () => $("repo-bar");
const barText = () => String(bar().textContent ?? "");
const tick = (n = 3) => new Promise((r) => setTimeout(r, n));

const GITHUB = { connected: true, login: "onelitonbd", source: "gh", host: "github.com", scopes: ["repo"], configured: true, ghCli: true };

test("a new chat never wears the previous session's repository bar", async () => {
  // The exact report: switch from a code session to a new chat and the old
  // `owner/name · branch` stays in the strip. It was a late `repo.status`
  // answer painting itself into the session that replaced it.
  const old = deferred();
  stubGateway((method, params) => {
    if (method === "github.status") return GITHUB;
    if (method === "repo.status") {
      return params.sessionKey === "main:code-a"
        ? old.promise
        : { bound: false, running: false };
    }
    return {};
  });

  repo.initRepo({ chat: () => {}, code: () => {} });
  repo.mountRepoBar();

  repo.setRepoSession("main:code-a");
  repo.setRepoSession("main:new-chat");
  await tick();

  assert.equal(bar().hidden, true, "the new chat has no repository, so the strip hides");

  // Now the old session's answer finally arrives.
  old.resolve({ bound: true, repo: "onelitonbd/SuparClaw", base: "main", branch: "sc/mvp365mn", clean: true, files: [] });
  await tick();

  assert.equal(bar().hidden, true, "a stale answer for another session is dropped");
  assert.equal(barText().includes("SuparClaw"), false, `no leaked repo name, got ${JSON.stringify(barText())}`);
});

test("a clone that fails after you left does not paint into the session you opened", async () => {
  // Bind a second repository, change your mind and open the first one instead.
  // The abandoned clone then fails: its "clone failed — retry" must not land on
  // the healthy session that replaced it.
  const bind = deferred();
  stubGateway((method, params) => {
    if (method === "github.status") return GITHUB;
    if (method === "repo.bind") return bind.promise;
    if (method === "repo.status") {
      return {
        bound: true,
        repo: "acme/kept",
        base: "main",
        branch: "sc/kept-branch",
        clean: true,
        files: [],
      };
    }
    return {};
  });

  repo.initRepo({ chat: () => {}, code: () => {} });
  repo.mountRepoBar();

  const abandoned = repo.bindRepoSession("main:code-b", "acme/abandoned", { branch: "main" });
  await tick();
  repo.setRepoSession("main:code-c");
  await tick();
  assert.match(barText(), /kept · sc\/kept-branch/, "the session that is open paints its own bar");

  bind.reject(new Error("clone failed — repository not found"));
  assert.equal(await abandoned, false, "the bind reports its own failure");
  await tick();

  assert.match(barText(), /kept · sc\/kept-branch/, `the bar still describes the open session, got ${JSON.stringify(barText())}`);
  assert.equal(barText().includes("clone failed"), false, "no leaked failure from the abandoned session");
});

test("the branch picker forgets the previous repository's filter", async () => {
  // Type a filter for repo A, walk back, pick repo B: B's branches must be
  // listed, not filtered by text that was never meant for it.
  const branches = {
    "acme/alpha": [{ name: "main", default: true }, { name: "zebra" }],
    "acme/beta": [{ name: "trunk", default: true }, { name: "feature/login" }],
  };
  stubGateway((method, params) => {
    if (method === "github.status") return GITHUB;
    if (method === "repo.status") return { bound: false };
    if (method === "github.repos") {
      return { repos: [
        { fullName: "acme/alpha", private: false, defaultBranch: "main" },
        { fullName: "acme/beta", private: false, defaultBranch: "trunk" },
      ] };
    }
    if (method === "sessions.list") return { sessions: [] };
    if (method === "github.branches") return { branches: branches[params.repo] ?? [] };
    return {};
  });

  repo.initRepo({ chat: () => {}, code: () => {} });
  repo.mountRepoBar();
  repo.openSessionSheet();
  await tick();

  $("new-code-row").click();
  await tick();
  const rows = () => [...$("new-session-list").querySelectorAll(".sheet__row")];

  rows().find((r) => r.textContent.includes("acme/alpha")).click();
  await tick();
  assert.equal($("new-session-title").textContent, "Pick a branch");
  const filter = $("new-session-list").querySelector("input");
  filter.value = "zeb";
  filter.oninput();
  assert.deepEqual(rows().map((r) => r.querySelector(".mono")?.textContent), ["zebra"], "filter applies to alpha");

  // Back to the repositories, then into another one.
  [...$("new-session-list").querySelectorAll("button")].find((b) => b.textContent.includes("Repositories")).click();
  await tick();
  rows().find((r) => r.textContent.includes("acme/beta")).click();
  await tick();

  assert.equal($("new-session-list").querySelector("input").value, "", "the filter was cleared for the new repository");
  assert.deepEqual(
    rows().map((r) => r.querySelector(".mono")?.textContent),
    ["trunk", "feature/login"],
    "beta's branches are all visible",
  );
});

test("a recent repository carries its default branch, and never prints undefined", async () => {
  // `acme/legacy` is not on the current page of github.repos, so the only thing
  // that knows its default branch is the session row that worked there.
  const seen = [];
  stubGateway((method, params) => {
    if (method === "github.status") return GITHUB;
    if (method === "repo.status") return { bound: false };
    if (method === "github.repos") return { repos: [] };
    if (method === "sessions.list") {
      return { sessions: [
        { repo: "acme/legacy", base: "trunk", branch: "sc/old", last_msg_at: 9 },
        { repo: "acme/legacy", base: "trunk", branch: "sc/older", last_msg_at: 8 },
      ] };
    }
    if (method === "github.branches") { seen.push(params); return { branches: [{ name: "trunk", default: true }] }; }
    return {};
  });

  repo.initRepo({ chat: () => {}, code: () => {} });
  repo.mountRepoBar();
  repo.openSessionSheet();
  await tick();
  $("new-code-row").click();
  await tick();

  const rows = [...$("new-session-list").querySelectorAll(".sheet__row")];
  assert.equal(rows.length, 1, "the same repo twice is still one row");
  const text = String(rows[0].textContent);
  assert.match(text, /acme\/legacy/);
  assert.match(text, /worked here before · trunk/, "the base comes from the session row");
  assert.equal(text.includes("undefined"), false, "no undefined in the row");

  rows[0].click();
  await tick();
  assert.equal(seen.at(-1).base, "trunk", "the branch step is asked with that base, so the default is marked");
});
