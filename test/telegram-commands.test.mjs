// Task 27 — the Telegram `/` menu must only advertise what this build answers.
//
// The menu is stored on the bot token, not in this process. A token that ran
// another build (OpenClaw's registry: /restart "Restart OpenClaw.", /acp, /goal,
// /tts …) keeps showing those commands until something replaces them, and the
// user taps them and gets "unknown command". Two invariants keep that from
// happening again:
//
//   menu  ⊆  shared router ∪ telegram-local ∪ installed skills
//   telegram-local  ∩  shared router  =  ∅        (one command, one owner)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { SLASH_CATALOG, SHARED_COMMANDS, TELEGRAM_COMMANDS, buildCommandMenu, menuName, MENU_LIMIT, telegramSessionKey } =
  await import("../dist/lib.js");

const ROOT = process.cwd();
const TG_SRC = readFileSync(join(ROOT, "src/channels/telegram.ts"), "utf8");

const SKILLS = [
  { name: "web-digest", description: "summarise pages and feeds", eligible: true, userInvocable: true },
  { name: "skill-creator", description: "author a SKILL.md", eligible: true, userInvocable: true },
  { name: "device-status", description: "battery and storage", eligible: true, userInvocable: true },
  { name: "broken-skill", description: "missing a binary", eligible: false, userInvocable: true },
  { name: "internal-only", description: "model-invocable only", eligible: true, userInvocable: false },
];

const menu = buildCommandMenu({ catalog: SLASH_CATALOG, local: TELEGRAM_COMMANDS, skills: SKILLS });
const local = new Set(TELEGRAM_COMMANDS.map((c) => menuName(c.cmd)));
const shared = new Set(SHARED_COMMANDS.map((c) => menuName(c)));

test("every published command is answered by this build", () => {
  const answerable = new Set([...shared, ...local, ...SKILLS.filter((s) => s.eligible && s.userInvocable).map((s) => menuName(s.name))]);
  const orphans = menu.filter((m) => !answerable.has(m.command));
  assert.deepEqual(
    orphans,
    [],
    "a menu entry nobody answers is the bug: the user taps it and gets 'unknown command'",
  );
});

test("every command in the catalog is published (no hidden commands)", () => {
  const published = new Set(menu.map((m) => m.command));
  const missing = SLASH_CATALOG.map((c) => menuName(c.cmd)).filter((n) => !published.has(n));
  assert.deepEqual(missing, [], "/help, /commands and the menu must agree");
});

test("Telegram's own limits are respected", () => {
  assert.ok(menu.length > 0);
  assert.ok(menu.length <= MENU_LIMIT, `Bot API allows ${MENU_LIMIT}`);
  for (const entry of menu) {
    assert.match(entry.command, /^[a-z0-9_]{1,32}$/, `${entry.command} is not a legal Bot API command name`);
    assert.ok(entry.description.length >= 3 && entry.description.length <= 256, `${entry.command}: description ${entry.description.length} chars`);
  }
  const names = menu.map((m) => m.command);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], "a duplicate hides a real entry");
});

test("one command has exactly one owner", () => {
  const overlap = [...local].filter((n) => shared.has(n));
  assert.deepEqual(overlap, [], "Telegram-local commands must not also be in the shared router");
  for (const name of ["help", "status", "stop", "usage", "compact", "title"]) {
    assert.ok(shared.has(name), `${name} is answered by the shared router`);
    assert.ok(!local.has(name), `${name} must fall through to it`);
  }
});

test("a skill can never shadow a built-in", () => {
  const withClash = buildCommandMenu({
    catalog: SLASH_CATALOG,
    local: TELEGRAM_COMMANDS,
    skills: [{ name: "status", description: "a skill that would steal /status", eligible: true, userInvocable: true }],
  });
  const hits = withClash.filter((m) => m.command === "status");
  assert.equal(hits.length, 1);
  assert.match(hits[0].description, /model, tools, dreaming/, "the built-in keeps the name");
});

test("the Bot API cap truncates instead of throwing", () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ cmd: `/cmd${i}`, summary: `command ${i}` }));
  const capped = buildCommandMenu({ catalog: many, local: [], skills: [] });
  assert.equal(capped.length, MENU_LIMIT);
  assert.equal(capped.at(-1).command, "cmd99", "first 100 win, in catalog order");
});

test("spellings normalise both ways: export_session ⇄ export-session, skill_creator ⇄ skill-creator", () => {
  assert.equal(menuName("/export-session"), "export_session");
  assert.equal(menuName("/skill-creator"), "skill_creator");
  assert.equal(menuName("/Status"), "status");
  assert.equal(menuName("/a.b c"), "a_b", "only the first token is the name");
  assert.equal(menuName("/usage [off|tokens|full|cost]"), "usage", "syntax in the catalog never leaks into the menu");
  assert.equal(menuName("/" + "x".repeat(40)).length, 32);
  // The shared router normalises the other way, so both spellings reach a case.
  const svc = readFileSync(join(ROOT, "src/agent/service.ts"), "utf8");
  assert.match(svc, /toLowerCase\(\)\.replace\(\/_\/g, "-"\)/, "the router folds _ to - for the command token");
});

test("/new rotates the session key instead of deleting anything", () => {
  assert.equal(telegramSessionKey(12345), "telegram:12345");
  assert.equal(telegramSessionKey(12345, "m3x9"), "telegram:12345:m3x9");
  // Task 54b: the rotation moved into `#startNew` (the sessions card's button
  // runs the same code), so the key is the chat id rather than the scope object.
  assert.match(TG_SRC, /setMeta\(`telegram:sess:\$\{chatId\}`, Date\.now\(\)\.toString\(36\)\)/);
});

test("Telegram falls through instead of refusing unknown commands", () => {
  assert.doesNotMatch(TG_SRC, /unknown command \/\$\{cmd\.name\}/, "the old 'unknown command' reply must be gone");
  assert.match(TG_SRC, /async #onCommand\([\s\S]{0,400}?\): Promise<boolean>/, "the switch reports whether it handled the command");
  assert.match(TG_SRC, /if \(handled\) return;/, "#onMessage keeps going when it did not");
});

test("the menu is claimed on start, for every scope a stale list can live in", () => {
  assert.match(TG_SRC, /await this\.#registerCommandMenu\(bot\)/, "start() registers it");
  // The scope list is shared with `sc telegram commands`, so the two cannot
  // drift. Exactness of the list lives in telegram-scopes.test.mjs.
  assert.match(TG_SRC, /staleCommandScopes\(\{/, "inherited scopes come from the shared helper");
  assert.match(TG_SRC, /#knownChatIds\(\)/, "and it is fed the chats this device has seen");
  assert.match(TG_SRC, /deleteMyCommands\(args\)/, "inherited lists are removed first");
  assert.match(TG_SRC, /setMyCommands\(/, "then ours is published");
  assert.match(TG_SRC, /commandsMenu === false/, "the operator can opt out");
});
