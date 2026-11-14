// Task 54b — "which GitHub account?" is a real question only if the answer is
// honest: one row per *distinct* token, and no row for a token GitHub rejects.
//
// The card is drawn from `Service.githubAccounts()`; everything here is about
// that list, not about the card (the card has its own test file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sc-gh-accounts-"));
process.env["SUPARCLAW_STATE_DIR"] = join(HOME, "state");
process.env["HOME"] = HOME;
delete process.env["GITHUB_TOKEN"];
delete process.env["GH_TOKEN"];

const { Service, saveGithubCreds, clearGithubCreds } = await import("../dist/lib.js");

/** Answers `/user` per token; anything else is a test bug, and says so. */
function stubGithub(logins) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const auth = String(init.headers?.Authorization ?? init.headers?.authorization ?? "");
    const token = auth.replace(/^Bearer /, "");
    calls.push({ url: String(url), token });
    const login = logins[token];
    const body = login ? JSON.stringify({ login, name: login }) : JSON.stringify({ message: "Bad credentials" });
    return {
      ok: Boolean(login),
      status: login ? 200 : 401,
      headers: { get: () => "repo, read:user" },
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("one row per distinct login, and a rejected token is not offered", async () => {
  const service = new Service();
  const ghDir = join(HOME, ".config", "gh");
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(ghDir, "hosts.yml"), "github.com:\n    oauth_token: gho-same-person\n    user: onelitonbd\n");
  // The stored login is the same person as `gh`: one button, not two.
  saveGithubCreds({ token: "gho-same-person", login: "onelitonbd", host: "github.com", scopes: [] });

  const stub = stubGithub({ "gho-same-person": "onelitonbd" });
  try {
    const rows = await service.githubAccounts({ refresh: true });
    assert.deepEqual(rows, [{ source: "gh", login: "onelitonbd", label: "gh CLI" }], "the same token twice is one account, and gh wins the priority");
  } finally {
    stub.restore();
  }

  // A token GitHub refuses is dropped rather than offered as a dead button.
  const bad = stubGithub({});
  try {
    const rows = await service.githubAccounts({ refresh: true });
    assert.deepEqual(rows, [], "no usable login means no card to choose from");
  } finally {
    bad.restore();
  }
});

test("the account list is cached for a minute, not re-fetched per page", async () => {
  const service = new Service();
  const ghDir = join(HOME, ".config", "gh");
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(ghDir, "hosts.yml"), "github.com:\n    oauth_token: gho-cached\n    user: onelitonbd\n");
  saveGithubCreds({ token: "gho-cached", login: "onelitonbd", host: "github.com", scopes: [] });
  const stub = stubGithub({ "gho-cached": "onelitonbd" });
  try {
    await service.githubAccounts({ refresh: true });
    const first = stub.calls.length;
    assert.equal(first, 2, "identity is two calls: the body and the scope header");
    const rows = await service.githubAccounts();
    assert.equal(stub.calls.length, first, "going back to the account card does not hit GitHub again");
    assert.equal(rows.length, 1);
    await service.githubAccounts({ refresh: true });
    assert.equal(stub.calls.length, first + 2, "but a refresh does");
  } finally {
    stub.restore();
    clearGithubCreds();
  }
});
