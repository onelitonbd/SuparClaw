// Task 35 — `src/repo/github.ts`: credentials, redaction, the REST calls, and
// the device flow. Every assertion here is about a promise the design makes:
// a token never leaks, a missing client id says so plainly, and a revoked token
// reads as "not connected" instead of a stale name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sc-github-"));
process.env["SUPARCLAW_STATE_DIR"] = join(HOME, "state");
process.env["HOME"] = HOME;
// The sandbox itself exports a GITHUB_TOKEN; a credential test that inherits one
// would pass for the wrong reason. Every test here starts from "nothing set".
delete process.env["GITHUB_TOKEN"];
delete process.env["GH_TOKEN"];
delete process.env["GITHUB_HOST"];

const {
  githubCredsPath,
  redact,
  saveGithubCreds,
  readStoredGithub,
  clearGithubCreds,
  resolveGithubCreds,
  resolveGithubCredsFor,
  githubCredentialSources,
  accountLabel,
  githubApiBase,
  githubRequest,
  githubIdentity,
  githubListRepos,
  githubListBranches,
  orderBranches,
  githubCreatePull,
  connectGithub,
} = await import("../dist/lib.js");

/** A fetch stub that records calls and answers from a queue. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    const status = next.status ?? 200;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (next.headers ?? {})[k.toLowerCase()] ?? null },
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return { fn, calls };
}

test("credentials are stored 0600 and never in the config file", () => {
  const saved = saveGithubCreds({ token: "gho_secret_value", login: "onelitonbd", host: "github.com", scopes: ["repo"] });
  assert.equal(saved.token, "gho_secret_value");
  assert.equal(saved.source, "token");

  const path = githubCredsPath();
  assert.equal(statSync(path).mode & 0o777, 0o600, "a token on disk is readable by this user only");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.token, "gho_secret_value");

  // Reading it back gives the same credential, tagged by how it was found.
  const back = readStoredGithub();
  assert.equal(back?.login, "onelitonbd");
  assert.equal(back?.source, "token");

  assert.equal(clearGithubCreds(), true);
  assert.equal(readStoredGithub(), null);
  assert.equal(clearGithubCreds(), false, "clearing twice is a no-op, not a crash");
});

test("resolution order is env → gh CLI → stored token", () => {
  clearGithubCreds();
  assert.equal(resolveGithubCreds(), null, "nothing anywhere reads as not connected");

  saveGithubCreds({ token: "stored-token", login: "stored", host: "github.com", scopes: [] });
  assert.equal(resolveGithubCreds()?.source, "token");

  // A `gh` config in the fake HOME outranks the stored file.
  const ghDir = join(HOME, ".config", "gh");
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(ghDir, "hosts.yml"), "github.com:\n    oauth_token: gho_from_gh\n    user: ghuser\n");
  const fromGh = resolveGithubCreds();
  assert.equal(fromGh?.source, "gh");
  assert.equal(fromGh?.token, "gho_from_gh");

  process.env["GITHUB_TOKEN"] = "env-token";
  const fromEnv = resolveGithubCreds();
  assert.equal(fromEnv?.source, "env", "an explicit env var beats every on-disk credential");
  assert.equal(fromEnv?.token, "env-token");
  delete process.env["GITHUB_TOKEN"];
  clearGithubCreds();
});

test("each source can be named on its own, for the /code account step", () => {
  // Task 54b: the picker asks *which account*, so a source has to be
  // addressable — but naming one must never silently fall back to another, or
  // the card would say "gh CLI" while cloning with the stored token.
  clearGithubCreds();
  saveGithubCreds({ token: "stored-token-123", login: "stored", host: "github.com", scopes: [] });
  process.env["GITHUB_TOKEN"] = "env-token-123";

  const sources = githubCredentialSources("github.com");
  assert.deepEqual(sources.map((s) => s.source).slice(0, 1), ["env"], "same priority order the default resolver uses");
  assert.ok(sources.some((s) => s.source === "token"));

  assert.equal(resolveGithubCredsFor("token")?.token, "stored-token-123", "a named source resolves to itself");
  assert.equal(resolveGithubCredsFor("token")?.login, "stored", "and keeps the login the file remembers");
  assert.equal(resolveGithubCredsFor("env")?.token, "env-token-123");

  delete process.env["GITHUB_TOKEN"];
  assert.equal(resolveGithubCredsFor("env"), null, "a source that is gone resolves to nothing, not to another login");

  assert.equal(accountLabel("gh"), "gh CLI");
  assert.equal(accountLabel("token"), "this device");
  assert.equal(accountLabel("env"), "GITHUB_TOKEN");
  clearGithubCreds();
});

test("redact removes a token from any sentence it reaches", () => {
  const token = "gho_abcdefghijklmnop";
  const clean = redact(`fetch failed for ${token}`, token);
  assert.ok(!clean.includes(token), "the token itself is gone");
  assert.match(clean, /\*\*\*/);
  // Even when nobody told us the token, the shape is recognised — an error body
  // that echoes a credential must not print it.
  assert.ok(!redact("Authorization: token gho_1234567890abcdef").includes("gho_1234567890abcdef"));
  assert.ok(!redact("https://x-access-token:secret@github.com/a/b.git").includes("secret"));
  assert.equal(redact("nothing to hide"), "nothing to hide");
});

test("API base follows the host, so Enterprise works with the same code", () => {
  assert.equal(githubApiBase(), "https://api.github.com");
  assert.equal(githubApiBase("github.com"), "https://api.github.com");
  assert.equal(githubApiBase("ghe.acme.test"), "https://ghe.acme.test/api/v3");
});

test("a 401 explains what to do instead of surfacing 'Bad credentials'", async () => {
  const { fn } = fakeFetch([{ status: 401, body: { message: "Bad credentials" } }]);
  await assert.rejects(
    () => githubRequest("/user", { token: "t", fetchFn: fn }),
    /token was rejected|revoked|expired/i,
  );
});

test("a 403 rate limit and a 404 read as instructions", async () => {
  const limited = fakeFetch([{ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }]);
  await assert.rejects(() => githubRequest("/user", { token: "t", fetchFn: limited.fn }), /rate limit/i);

  const missing = fakeFetch([{ status: 404, body: { message: "Not Found" } }]);
  await assert.rejects(() => githubRequest("/repos/a/b", { token: "t", fetchFn: missing.fn }), /not found|can see/i);
});

test("the token rides a header, never the URL", async () => {
  const { fn, calls } = fakeFetch([{ body: { login: "onelitonbd", name: "One" } }, { body: { login: "onelitonbd" } }]);
  const who = await githubIdentity("gho_tok", { fetchFn: fn });
  assert.equal(who.login, "onelitonbd");
  assert.ok(!calls[0].url.includes("gho_tok"), "a token in a URL ends up in logs, referrers and crash reports");
  assert.equal(calls[0].headers["Authorization"], "Bearer gho_tok");
});

test("identity reads the granted scopes from the response header", async () => {
  const { fn } = fakeFetch([
    { body: { login: "onelitonbd" } },
    { body: { login: "onelitonbd" }, headers: { "x-oauth-scopes": "repo, read:user, workflow" } },
  ]);
  const who = await githubIdentity("tok", { fetchFn: fn });
  assert.deepEqual(who.scopes, ["repo", "read:user", "workflow"], "the design's scopes are visible, so Settings can show them");
  // (identity costs two calls: the JSON body, then the same URL for headers)
});

test("the repo list marks private repos and pages by pushed date", async () => {
  const { fn, calls } = fakeFetch([
    {
      body: [
        { full_name: "onelitonbd/SuparClaw", private: false, default_branch: "main", pushed_at: "2026-10-01T00:00:00Z", owner: { login: "onelitonbd" } },
        { full_name: "onelitonbd/secret", private: true, default_branch: "trunk", pushed_at: "2026-09-01T00:00:00Z", owner: { login: "onelitonbd" } },
      ],
    },
  ]);
  const repos = await githubListRepos("tok", { fetchFn: fn });
  assert.equal(repos.length, 2);
  assert.equal(repos[0].fullName, "onelitonbd/SuparClaw");
  assert.equal(repos[1].private, true, "private repos are listed, not hidden — the repo scope is why we asked for it");
  assert.match(calls[0].url, /\/user\/repos\?/);
  assert.match(calls[0].url, /sort=pushed/);
  assert.match(calls[0].url, /direction=desc/);
});

test("a filter switches to the search endpoint", async () => {
  const { fn, calls } = fakeFetch([{ body: { items: [{ full_name: "acme/api", private: true, default_branch: "main", owner: { login: "acme" } }] } }]);
  const repos = await githubListRepos("tok", { filter: "api", fetchFn: fn });
  assert.equal(repos[0].fullName, "acme/api");
  assert.match(calls[0].url, /search\/repositories/);
  assert.match(calls[0].url, /q=api/);
});

test("the branch list is names with a protected flag, and nothing else", async () => {
  const { fn, calls } = fakeFetch([
    {
      body: [
        { name: "main", protected: true, commit: { sha: "abc" } },
        { name: "feature/login", protected: false },
        { nope: "no name at all" },
      ],
    },
  ]);
  const branches = await githubListBranches("tok", { repo: "acme/api", fetchFn: fn });
  assert.deepEqual(branches, [
    { name: "main", protected: true },
    { name: "feature/login", protected: false },
  ]);
  assert.match(calls[0].url, /\/repos\/acme\/api\/branches\?per_page=100&page=1/);
  assert.equal(calls[0].method, "GET");
});

test("branch paging is honoured and clamped, and a bad answer is an empty list", async () => {
  const { fn, calls } = fakeFetch([{ body: { message: "Not Found" } }]);
  assert.deepEqual(await githubListBranches("tok", { repo: "acme/api", page: 2, perPage: 20, fetchFn: fn }), []);
  assert.match(calls[0].url, /per_page=20&page=2/);

  // GitHub rejects per_page above 100; the clamp is the difference between an
  // empty picker and a 422 the user cannot act on.
  const big = fakeFetch([{ body: [] }]);
  await githubListBranches("tok", { repo: "acme/api", perPage: 5000, page: 0, fetchFn: big.fn });
  assert.match(big.calls[0].url, /per_page=100&page=1/);
});

test("the picker puts the default branch first and marks it", () => {
  // GitHub returns newest-committed first, which buries `main` in a busy repo.
  const rows = [
    { name: "zebra", protected: false },
    { name: "main", protected: true },
    { name: "feature/login", protected: false },
  ];
  assert.deepEqual(orderBranches(rows, "main").map((b) => [b.name, b.default]), [
    ["main", true],
    ["feature/login", false],
    ["zebra", false],
  ]);
  // A page that does not contain the base still offers it: it is the one branch
  // every caller has an answer about.
  assert.deepEqual(orderBranches([{ name: "only" }], "trunk").map((b) => b.name), ["trunk", "only"]);
  // No base known (a repo chosen by URL before we know its default) keeps the
  // alphabetical order and marks nothing.
  assert.deepEqual(orderBranches([{ name: "b" }, { name: "a" }], "").map((b) => b.default), [false, false]);
});

test("a pull request is a draft unless the caller says otherwise", async () => {
  const { fn, calls } = fakeFetch([
    { body: { number: 12, html_url: "https://github.com/onelitonbd/SuparClaw/pull/12", draft: true } },
  ]);
  const pr = await githubCreatePull({ token: "t", repo: "onelitonbd/SuparClaw", head: "sc/abc", base: "main", title: "Fix", fetchFn: fn });
  assert.equal(pr.number, 12);
  assert.equal(pr.draft, true);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.draft, true, "draft-by-default is the design's rule, enforced at the lowest layer");
  assert.equal(body.head, "sc/abc");
});

test("connect without a client id refuses with the exact next step", async () => {
  await assert.rejects(
    () => connectGithub({ clientId: "", scope: "repo" }),
    /clientId|client id/i,
    "silently starting a flow that cannot finish is worse than refusing",
  );
});

test("the device flow polls through pending, slow_down and success", async () => {
  const { fn, calls } = fakeFetch([
    // POST /login/device/code
    { body: { device_code: "dev-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } },
    // POST /login/oauth/access_token — first poll: still pending
    { body: { error: "authorization_pending" } },
    // second: slow down (GitHub returns a new interval)
    { body: { error: "slow_down", interval: 10 } },
    // third: the token
    { body: { access_token: "gho_device_token", scope: "repo,read:user" } },
    // then identity — the JSON body, then the same URL read for its headers
    { body: { login: "onelitonbd" } },
    { body: { login: "onelitonbd" }, headers: { "x-oauth-scopes": "repo, read:user" } },
  ]);
  const seen = [];
  const waits = [];
  const res = await connectGithub({
    clientId: "Iv1.abc",
    scope: "repo read:user",
    fetchFn: fn,
    onCode: (info) => seen.push(info),
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userCode, "WDJB-MJHT");
  assert.equal(res.identity.login, "onelitonbd");
  assert.equal(res.creds.token, "gho_device_token");
  // slow_down raises the interval for the *next* poll ("add five seconds to the
  // interval each time"), so the seen sequence is base, base, base+5s.
  assert.deepEqual(waits, [5000, 5000, 10000], "slow_down adds five seconds from then on and honours the interval GitHub sent back");
  assert.match(calls[0].body, /client_id=Iv1\.abc/);
  assert.ok(!calls[0].body.includes("client_secret"), "device flow needs no secret — that is why it is the default");
});

test("denied, expired and disabled each get their own sentence", async () => {
  const denied = fakeFetch([
    { body: { device_code: "d", user_code: "A-B", verification_uri: "u", expires_in: 900, interval: 1 } },
    { body: { error: "access_denied" } },
  ]);
  await assert.rejects(() => connectGithub({ clientId: "x", scope: "repo", fetchFn: denied.fn, sleep: async () => {} }), /cancel|denied/i);

  const expired = fakeFetch([
    { body: { device_code: "d", user_code: "A-B", verification_uri: "u", expires_in: 900, interval: 1 } },
    { body: { error: "expired_token" } },
  ]);
  await assert.rejects(() => connectGithub({ clientId: "x", scope: "repo", fetchFn: expired.fn, sleep: async () => {} }), /expired/i);

  const disabled = fakeFetch([{ status: 404, body: { error: "device_flow_disabled" } }]);
  await assert.rejects(() => connectGithub({ clientId: "x", scope: "repo", fetchFn: disabled.fn, sleep: async () => {} }), /device login|device_flow/i);
});
