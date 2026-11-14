// Task 28 — clearing the WHOLE token, not just the default scope.
//
// A bot's command list is a set of (scope, language) pairs, not one list, and a
// chat/member scope OVERRIDES the default one. Replacing `default` therefore
// leaves an old build's commands showing in exactly the chat where they were
// registered — the case Task 27 missed and the reason `sc telegram commands`
// exists.
//
// These cases pin the scope math (pure) and then run the CLI end to end against
// a fake Bot API, so "delete everything we could have inherited" is proven by
// what actually got called — not by reading the source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-tg-scope-"));
const { staleCommandScopes, menuDrift, buildCommandMenu, parseTelegramArgs, scopeLabel, SLASH_CATALOG, TELEGRAM_COMMANDS } =
  await import("../dist/lib.js");

const labels = (sources) => staleCommandScopes(sources).map((t) => scopeLabel(t.scope, t.language_code));

test("the four wildcard scopes lead, always", () => {
  assert.deepEqual(labels({}).slice(0, 4), ["default", "all_private_chats", "all_group_chats", "all_chat_administrators"]);
});

test("every chat id gets its own chat, administrators and member scope", () => {
  const got = labels({ chatIds: ["111", 222], userIds: [111] });
  assert.ok(got.includes("chat:111") && got.includes("chat:222"));
  assert.ok(got.includes("chat_administrators:111") && got.includes("chat_administrators:222"));
  // A chat_member scope needs a user id, and in a DM the chat id IS the user id.
  assert.ok(got.includes("chat_member:111:111"));
  assert.ok(!got.some((l) => l.startsWith("chat_member:222")), "222 is a group; no member scope is derivable");
});

test("ids dedupe and garbage is dropped", () => {
  const got = labels({ chatIds: ["111", 111, " 111 ", "", "abc", "0"], userIds: ["111"] });
  assert.equal(got.filter((l) => l === "chat:111").length, 1);
  assert.ok(!got.some((l) => l.includes("NaN") || l.includes(":0") || l.includes("chat:abc")));
});

test("a stale chat scope is a target — the exact hole in the first fix", () => {
  const wildcardsOnly = labels({});
  assert.ok(!wildcardsOnly.some((l) => l.startsWith("chat:")), "without chat ids there is nothing to target");
  const withChat = labels({ chatIds: ["42"] });
  assert.ok(withChat.includes("chat:42"), "a per-chat list is overridden, so it must be deleted by name");
});

test("language-specific lists are opt-in and repeat the wildcard scopes", () => {
  assert.ok(!labels({}).some((l) => l.includes("[")));
  const withLang = labels({ langs: ["en", "bn"] });
  assert.ok(withLang.includes("default [en]") && withLang.includes("default [bn]"));
  assert.ok(withLang.includes("all_group_chats [en]"));
  // Invalid codes never become API calls.
  assert.ok(!labels({ langs: ["english"] }).some((l) => l.includes("english")));
});

test("drift names exactly what a token holds that we do not publish", () => {
  const menu = buildCommandMenu({ catalog: SLASH_CATALOG, local: TELEGRAM_COMMANDS, skills: [] });
  const stale = [
    { command: "restart", description: "Restart OpenClaw." },
    { command: "acp", description: "Manage ACP sessions." },
    { command: "stop", description: "an older, different description" },
  ];
  const drift = menuDrift(stale, menu);
  assert.deepEqual(drift.extra.sort(), ["acp", "restart"], "OpenClaw's commands are the extras");
  assert.deepEqual(drift.stale, ["stop"], "a shared name with a different description is stale, not foreign");
  assert.ok(drift.missing.includes("help"), "everything else still has to be published");
});

test("the CLI parses every flag, and defaults to a read-only show", () => {
  assert.deepEqual(parseTelegramArgs(["commands"]).opts, { mode: "show", langs: [], json: false });
  assert.equal(parseTelegramArgs(["commands", "--replace"]).opts.mode, "replace");
  assert.equal(parseTelegramArgs(["commands", "--purge"]).opts.mode, "purge");
  assert.deepEqual(parseTelegramArgs(["commands", "--lang", "en,bn"]).opts.langs, ["en", "bn"]);
  assert.equal(parseTelegramArgs(["commands", "--token=123:abc"]).opts.token, "123:abc");
  assert.equal(parseTelegramArgs(["commands", "--json"]).opts.json, true);
  assert.equal(parseTelegramArgs(["commands", "--replace", "--token", "9:x"]).opts.token, "9:x");
});
