// Task 27 — the commands Telegram now publishes must actually answer.
//
// Before this task Telegram replied "unknown command" to everything its own
// switch did not own, so /stop, /usage, /compact, /title, /dream … were
// unreachable from the one surface a phone user has. The fix is a fall-through
// to the shared router; these cases pin the router's side of that bargain,
// plus the five commands added for the phone (/think, /name, /models,
// /context, /skill).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-slash-"));
const { Service, SLASH_CATALOG, SHARED_COMMANDS } = await import("../dist/lib.js");

const svc = new Service();

/** Send a command and collect the reply text the surface would render. */
async function replyOf(text, sessionKey = "main:cmd") {
  let out = "";
  await svc.send({ sessionKey, text, source: "cli", reply: (t) => { out += t; } });
  return out;
}

test("the catalog documents every command the router answers", () => {
  const documented = new Set(SLASH_CATALOG.map((c) => c.cmd.replace(/^\//, "").split(" ")[0]));
  for (const name of ["usage", "question"]) {
    assert.ok(documented.has(name), `${name} works but was missing from the catalog, so /help never showed it`);
  }
  for (const name of ["think", "models", "context", "skill"]) {
    assert.ok(documented.has(name), `${name} is new in Task 27 and must be discoverable`);
    assert.ok(SHARED_COMMANDS.includes(name));
  }
});

test("/think reads, writes and clears the session's thinking level", async () => {
  const key = "main:think";
  assert.match(await replyOf("/think", key), /thinking for this session: inherit \(config: /);

  assert.match(await replyOf("/think medium", key), /thinking for this session: medium/);
  assert.equal(svc.store.getSessionByKey(key).thinking, "medium", "the column the loop already consults");

  assert.match(await replyOf("/think loud", key), /unknown thinking level "loud"/);
  assert.equal(svc.store.getSessionByKey(key).thinking, "medium", "a bad level changes nothing");

  assert.match(await replyOf("/think default", key), /thinking reset/);
  assert.equal(svc.store.getSessionByKey(key).thinking ?? null, null, "back to the config default");
});

test("/name is /title", async () => {
  const key = "main:name";
  assert.match(await replyOf("/name Groceries run", key), /renamed to: Groceries run/);
  assert.equal(svc.store.getSessionByKey(key).name, "Groceries run");
});

test("/models lists providers without a network call", async () => {
  svc.config.providers.demo = { baseUrl: "https://example.test/v1", apiKey: "", models: ["a-model", "b-model"] };
  const out = await replyOf("/models");
  assert.match(out, /default model: /);
  assert.match(out, /demo — 2 model\(s\) · key missing/);
  assert.match(await replyOf("/models demo"), /demo \(2\):\n {2}a-model/);
  assert.match(await replyOf("/models nope"), /no provider "nope"/);
});

test("/context reports the transcript against the budget", async () => {
  const out = await replyOf("/context", "main:ctx");
  assert.match(out, /transcript: \d+ message\(s\) · [\d,]+ chars \(\d+% of the budget\)/);
  assert.match(out, /budget:\s+[\d,]+ chars/);
  assert.match(out, /compaction: /);
});

test("/usage and /question answer, and underscore spellings fold to the canonical one", async () => {
  assert.match(await replyOf("/usage cost", "main:u"), /Reply usage for this session: cost/);
  assert.match(await replyOf("/question", "main:q"), /no pending question/);
  // `export_session` is the Bot API spelling of `/export-session`.
  const row = svc.store.ensureSession("main:e");
  svc.store.appendMessage(row.id, "user", "hello");
  assert.match(await replyOf("/export_session", "main:e"), /exported \d+ message\(s\) → /, "the underscore spelling reaches the export handler");
});

test("/skill names what is installed instead of silently ignoring an unknown name", async () => {
  const out = await replyOf("/skill definitely-not-a-skill", "main:s");
  assert.match(out, /no skill named "definitely-not-a-skill"/);
  assert.match(out, /installed: /);
});

test("a bare skill name becomes a turn with the canonical spelling", async (t) => {
  const skill = svc.loop.skills.find((s) => s.eligible !== false && s.userInvocable !== false);
  if (!skill) return t.skip("no user-invocable skill is installed in this sandbox");

  const key = "main:bare";
  let out = "";
  try {
    await svc.send({ sessionKey: key, text: `/${skill.name} summarise this`, source: "cli", reply: (x) => { out += x; } });
  } catch (err) {
    out = String(err);
  }
  assert.doesNotMatch(out, /unknown command/, "a skill command must never be refused as unknown");
  assert.doesNotMatch(out, /no skill named/);

  const row = svc.store.getSessionByKey(key);
  const stored = row ? svc.store.recentMessages(row.id, 10).filter((m) => m.role === "user") : [];
  assert.ok(
    stored.some((m) => m.content.startsWith(`/${skill.name}`)),
    `the turn reaches the model as /${skill.name}, which matchSkills scores as an explicit hit`,
  );
});
