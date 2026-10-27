// Task 56 — the `github` tool: the repo work the agent used to delegate.
//
// "gh auth status / gh repo list … run those on your phone and paste the output"
// was the answer to a request this daemon can serve itself over the REST API.
// The tool exists so a dead shell is no longer a dead end, and it is written
// defensively because two of its actions change the account: archive is
// reversible, delete is not.
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildRegistry, emptyConfig } = await import("../dist/lib.js");

function tool() {
  const spec = buildRegistry(emptyConfig()).find((t) => t.name === "github");
  assert.ok(spec, "the github tool is in every registry — discovery must not depend on a repo session");
  return spec;
}

/** A fake account API that records calls. */
function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    async whoami() {
      calls.push(["whoami"]);
      return { login: "onelitonbd", source: "gh", scopes: [] };
    },
    async repos(opts) {
      calls.push(["repos", opts]);
      return {
        login: "onelitonbd",
        hasMore: false,
        repos: [
          { fullName: "onelitonbd/SuparClaw", private: false, archived: false, defaultBranch: "main", pushedAt: Date.now() - 3 * 86_400_000 },
          { fullName: "onelitonbd/old-thing", private: true, archived: true, defaultBranch: "master", pushedAt: 0 },
        ],
      };
    },
    async setArchived(repo, archived) {
      calls.push(["setArchived", repo, archived]);
      return { fullName: repo, archived };
    },
    async remove(repo) {
      calls.push(["remove", repo]);
      return { fullName: repo };
    },
    ...overrides,
  };
  return api;
}

const ctx = (api) => ({ repoCtl: api ? { github: api } : undefined });

test("repos lists what the account can see, with the archive state", async () => {
  const api = fakeApi();
  const out = await tool().run({ action: "repos" }, ctx(api));

  assert.match(out, /onelitonbd · 2 repo\(s\)/);
  assert.match(out, /onelitonbd\/SuparClaw · public · active · pushed 3d ago · main/);
  assert.match(out, /onelitonbd\/old-thing · private · ARCHIVED · pushed never pushed · master/);
  assert.equal(api.calls[0][1].perPage, 30);
});

test("repos passes the filter and the page through", async () => {
  const api = fakeApi();
  await tool().run({ action: "repos", filter: "claw", page: 2 }, ctx(api));
  assert.deepEqual(api.calls[0][1], { filter: "claw", page: 2, perPage: 30 });
});

test("whoami answers the 'gh auth status' question", async () => {
  const out = await tool().run({ action: "whoami" }, ctx(fakeApi()));
  assert.match(out, /onelitonbd · via gh/);
});

test("archive flips the flag in the right direction", async () => {
  const api = fakeApi();
  assert.match(await tool().run({ action: "archive", repo: "onelitonbd/old-thing" }, ctx(api)), /now archived/);
  assert.match(await tool().run({ action: "unarchive", repo: "onelitonbd/old-thing" }, ctx(api)), /active again/);
  assert.deepEqual(api.calls, [
    ["setArchived", "onelitonbd/old-thing", true],
    ["setArchived", "onelitonbd/old-thing", false],
  ]);
});

test("delete needs the repository named twice — and refuses without it", async () => {
  const api = fakeApi();
  const tool1 = tool();

  const refused = await tool1.run({ action: "delete", repo: "onelitonbd/old-thing" }, ctx(api));
  assert.match(refused, /confirm="onelitonbd\/old-thing"/);
  assert.deepEqual(api.calls, [], "nothing was deleted on an unconfirmed call");

  const wrong = await tool1.run({ action: "delete", repo: "onelitonbd/old-thing", confirm: "onelitonbd/SuparClaw" }, ctx(api));
  assert.match(wrong, /needs confirm=/);
  assert.deepEqual(api.calls, []);

  const done = await tool1.run({ action: "delete", repo: "onelitonbd/old-thing", confirm: "onelitonbd/old-thing" }, ctx(api));
  assert.match(done, /deleted\. This cannot be undone/);
  assert.deepEqual(api.calls, [["remove", "onelitonbd/old-thing"]]);
});

test("errors are sentences: not connected, missing repo, unknown action, API failure", async () => {
  const t = tool();
  assert.match(await t.run({ action: "repos" }, {}), /GitHub is not connected/);
  assert.match(await t.run({ action: "archive" }, ctx(fakeApi())), /needs repo="owner\/name"/);
  assert.match(await t.run({ action: "rm-rf", repo: "a/b" }, ctx(fakeApi())), /unknown action "rm-rf"/);
  const failing = fakeApi({ async repos() { throw new Error("GitHub is unreachable (socket hang up)"); } });
  assert.match(await t.run({ action: "repos" }, ctx(failing)), /^error: GitHub is unreachable/);
});

test("the tool tells the model why it exists", () => {
  assert.match(tool().description, /instead of `gh` or any shell command/);
});
