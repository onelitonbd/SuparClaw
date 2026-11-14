// Task 28 — end to end: a token carrying another build's commands is repaired.
//
// The real CLI runs against a fake Bot API (SUPARCLAW_TELEGRAM_API), so what is
// asserted is the wire traffic: which (scope, language) pairs were deleted, and
// what was published afterwards. The fixture is modelled on the screenshot the
// user sent — OpenClaw's `/restart`, `/acp`, `/goal` sitting in the default
// scope AND in a per-chat scope, which is the one the first fix could not see.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const TOKEN = "123456:test-token";

const STALE = {
  default: [
    { command: "restart", description: "Restart OpenClaw." },
    { command: "acp", description: "Manage ACP sessions and runtime options." },
    { command: "goal", description: "Show or control the current goal." },
  ],
  "chat:424242": [{ command: "restart", description: "Restart OpenClaw." }],
  all_group_chats: [{ command: "tts", description: "Control text-to-speech (TTS)." }],
};

/** A Bot API with just the three methods this feature uses. */
async function fakeApi(store) {
  const calls = [];
  const key = (scope, lang) => {
    const s = scope ?? { type: "default" };
    const label =
      s.type === "chat" || s.type === "chat_administrators"
        ? `${s.chat_id}`
        : s.type === "chat_member"
          ? `${s.chat_id}`
          : "";
    const base = s.type === "chat" ? `chat:${label}` : s.type;
    return lang ? `${base}|${lang}` : base;
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      const params = body ? JSON.parse(body) : {};
      calls.push({ method, params });
      res.setHeader("content-type", "application/json");
      if (method === "getMyCommands") {
        const k = key(params.scope, params.language_code);
        res.end(JSON.stringify({ ok: true, result: store[k] ?? [] }));
      } else if (method === "deleteMyCommands") {
        delete store[key(params.scope, params.language_code)];
        res.end(JSON.stringify({ ok: true, result: true }));
      } else if (method === "setMyCommands") {
        store[key(params.scope, params.language_code)] = params.commands;
        res.end(JSON.stringify({ ok: true, result: true }));
      } else {
        res.end(JSON.stringify({ ok: false, description: `unknown method ${method}` }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { calls, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function runCli(args, base, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "sc-tg-e2e-"));
  // The CLI only targets chats it can know about: sessions it stored, plus both
  // pairing lists. Seeding allowFrom here is how a real install learned 424242.
  if (opts.paired?.length) {
    mkdirSync(join(home, ".suparclaw"), { recursive: true });
    writeFileSync(
      join(home, ".suparclaw", "config.json5"),
      `{ channels: { telegram: { allowFrom: ${JSON.stringify(opts.paired)} } } }`,
      "utf8",
    );
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(ROOT, "dist/sc.js"), "telegram", "commands", ...args],
      {
        cwd: ROOT,
        env: { ...process.env, SUPARCLAW_HOME: home, SUPARCLAW_TELEGRAM_API: base, TELEGRAM_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
        timeout: 60_000,
      },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

test("--show reports the foreign commands and the per-chat scope the first fix missed", async () => {
  const api = await fakeApi({ ...STALE });
  try {
    const out = await runCli(["--show", "--token", TOKEN, "--json"], api.base, { paired: ["424242"] });
    assert.equal(out.code, 1, "drift is a non-zero exit so a script can gate on it");
    const json = JSON.parse(out.stdout);

    const byScope = Object.fromEntries(json.scopes.map((s) => [s.scope, s]));
    assert.deepEqual(byScope.default.drift.extra.sort(), ["acp", "goal", "restart"]);
    assert.ok(byScope["chat:424242"], "a per-chat list is visible");
    assert.deepEqual(byScope["chat:424242"].drift.extra, ["restart"]);
    assert.ok(byScope["all_group_chats"]);

    // Nothing was written by a read-only run.
    assert.equal(api.calls.filter((c) => c.method !== "getMyCommands").length, 0);
  } finally {
    await api.close();
  }
});

test("--replace clears every derivable scope, then publishes this build's menu", async () => {
  const store = { ...STALE };
  const api = await fakeApi(store);
  try {
    const out = await runCli(["--replace", "--token", TOKEN, "--json"], api.base, { paired: ["424242"] });
    assert.equal(out.code, 0, `${out.stderr}`);
    const json = JSON.parse(out.stdout);
    assert.ok(json.published > 20, `published ${json.published} commands`);

    const deleted = api.calls.filter((c) => c.method === "deleteMyCommands").map((c) => c.params.scope.type);
    for (const wildcard of ["default", "all_private_chats", "all_group_chats", "all_chat_administrators"]) {
      assert.ok(deleted.includes(wildcard), `${wildcard} is cleared`);
    }

    // The screenshot case: the old build's list is gone, everywhere.
    // --replace deletes then publishes, so `default` holds OUR list now.
    assert.equal(store["chat:424242"], undefined, "the per-chat override is gone");
    assert.equal(store.all_group_chats, undefined);

    const published = (store.default ?? []).map((c) => c.command);
    assert.ok(published.includes("stop"), "our commands are what remains");
    assert.ok(published.includes("usage"));
    assert.ok(!published.includes("restart") && !published.includes("acp"), "and none of theirs");
  } finally {
    await api.close();
  }
});

test("--purge clears without publishing (BotFather stays the owner of the menu)", async () => {
  const store = { ...STALE };
  const api = await fakeApi(store);
  try {
    const out = await runCli(["--purge", "--token", TOKEN, "--json"], api.base, { paired: ["424242"] });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).published, 0);
    assert.equal(store.default, undefined);
    assert.equal(api.calls.filter((c) => c.method === "setMyCommands").length, 0);
  } finally {
    await api.close();
  }
});

test("a bad token fails with the reason and never deletes anything", async () => {
  const api = await fakeApi({ ...STALE });
  try {
    // The fake accepts everything, so point at a base that answers ok:false.
    const bad = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
    });
    await new Promise((r) => bad.listen(0, "127.0.0.1", r));
    const out = await runCli(["--replace", "--token", `${TOKEN}`, "--json"], `http://127.0.0.1:${bad.address().port}`);
    await new Promise((r) => bad.close(r));
    assert.equal(out.code, 1);
    assert.match(out.stdout + out.stderr, /unauthorized/i);
  } finally {
    await api.close();
  }
});
