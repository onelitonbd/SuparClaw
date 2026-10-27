// Task 35 — Telegram's half of the GitHub add-on.
//
// Telegram is the hardest surface for this feature because a callback is 64
// bytes and a chat has exactly one session tag. Both constraints are pinned
// here: the ids are tiny and *indexed* (never `owner/name`), and the session a
// button acts on is the tag `/new` already rotated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TG = readFileSync(join(ROOT, "src/channels/telegram.ts"), "utf8");
const SERVICE = readFileSync(join(ROOT, "src/agent/service.ts"), "utf8");

test("callback ids are short and indexed, never a repo name", () => {
  // Task 54b moved the list cards into `telegram-pickers.ts`, so the cap is
  // checked over both files: a callback that only fits in one of them still
  // breaks the same way.
  const PICKERS = readFileSync(join(ROOT, "src/channels/telegram-pickers.ts"), "utf8");
  assert.match(PICKERS, /callback_data: "n:c"/, "chat answer");
  assert.match(PICKERS, /callback_data: "n:k"/, "code answer");
  assert.match(TG, /callback_data: "p:d"/);
  assert.match(TG, /callback_data: "p:o"/);
  assert.match(TG, /callback_data: "p:x"/);

  let seen = 0;
  for (const src of [TG, PICKERS]) {
    const datas = [...src.matchAll(/callback_data: (`[^`]+`|"[^"]+")/g)].map((m) => m[1]);
    seen += datas.length;
    for (const raw of datas) {
      const literal = raw.slice(1, -1);
      // The *rendered* length is what Telegram caps; these literals are the
      // blueprint, so an interpolated value must be small by construction.
      assert.ok(literal.length <= 64, `callback ${literal} is over Telegram's 64-byte cap`);
      assert.ok(!literal.includes("owner/name"), "never a literal repo path");
      assert.ok(!/\$\{[^}]*fullName[^}]*\}/.test(literal), "a repository name never rides a callback");
      assert.ok(!/\$\{[^}]*\.key\}[^}]*\}/.test(literal) || literal.includes("shortHash"), "a session key rides callbacks only as a hash");
    }
  }
  assert.ok(seen > 12, "the scan actually found the callbacks");
});

test("the coding lists are held per chat and expire instead of guessing", () => {
  // Task 54b: the account, repository and branch lists live for the pick, in
  // this chat's memory, keyed by the chat that drew the card. The repo entry
  // still carries the default branch (Task 36) and now the account too, because
  // the clone must use the login the list came from.
  assert.match(TG, /#repoLists = new Map</);
  assert.match(TG, /#branchLists = new Map</);
  assert.match(TG, /#accountPages = new Map<number, AccountRow\[\]>\(\)/);
  assert.match(TG, /#pickedRepo = new Map<number, \{ repo: string; base: string; account: AccountRow \}>\(\)/);
  assert.match(TG, /if \(!account \|\| parts\[2\] !== shortHash\(account\.source\)\)/, "an account tap is checked against the row it claims");
  assert.match(TG, /if \(!target \|\| shortHash\(target\.key\) !== tap\.hash\)/, "so is a session tap");
  assert.match(TG, /if \(!list \|\| !repo\) \{[\s\S]{0,160}This picker expired — send \/code again/);
  assert.match(TG, /if \(!branch\) \{[\s\S]{0,160}This picker expired — send \/code again/);
  assert.ok(TG.includes("show_alert: true"), "a stale tap explains itself in a modal, not a silent no-op");
});

test("/new asks chat-or-code and keeps its rotation semantics", () => {
  const PICKERS = readFileSync(join(ROOT, "src/channels/telegram-pickers.ts"), "utf8");
  assert.match(PICKERS, /New session \$\{opts\.key\}/);
  assert.match(PICKERS, /Chat, or code a repository\?/);
  assert.match(PICKERS, /The previous one is kept/);
  // The rotation is still this exact call — the test that pinned it in Task 27
  // must keep passing, because /new is still non-destructive. Task 54b moved it
  // into `#startNew`, which the sessions card calls too.
  const start = TG.slice(TG.indexOf("async #startNew"), TG.indexOf("async #sendSessionsCard"));
  assert.match(start, /setMeta\(`telegram:sess:\$\{chatId\}`, Date\.now\(\)\.toString\(36\)\)/);
  assert.match(start, /setMeta\(`telegram:active:\$\{chatId\}`, ""\)/, "and the pointer is cleared, or /new looks like a no-op");
});

test("a repo tap asks for a branch, and the branch tap binds the session", () => {
  const repo = TG.slice(TG.indexOf('if (kind === "r")'), TG.indexOf('if (kind === "b")'));
  assert.match(repo, /this\.#pickedRepo\.set\(chatId, \{ repo: repo\.fullName, base: repo\.defaultBranch, account: list\.account \}\)/);
  assert.match(repo, /await this\.#sendBranches\(chatId, 0, ctx\)/, "one more question before anything is cloned");

  const handler = TG.slice(TG.indexOf('if (kind === "b")'), TG.indexOf('if (kind === "p")'));
  assert.match(handler, /this\.#sessionKeyFor\(chatId\)/, "the tag is read at tap time, for the chat that drew the card");
  assert.match(handler, /branch: branch\.name/, "the branch the user tapped is the branch that is continued");
  assert.match(handler, /source: pick\.account\.source,/, "and the clone uses the login the list came from");
  assert.match(handler, /this\.#pickedRepo\.delete\(chatId\)/, "the pick is consumed, so a double tap cannot bind twice");
  assert.match(TG, /Ask for a change, then \/diff to review and \/pr to publish/, "the confirmation names the next two commands");

  // The branch question itself is the pure card, so it is asserted by shape
  // there rather than by string-matching a template inside this file.
  const PICKERS = readFileSync(join(ROOT, "src/channels/telegram-pickers.ts"), "utf8");
  assert.match(PICKERS, /which branch\?/);
});

test("/code binds directly or opens the picker; a busy run is refused", () => {
  const block = TG.slice(TG.indexOf('case "code":'), TG.indexOf('case "pr":'));
  assert.match(block, /if \(target\)/, "an argument binds immediately");
  assert.match(block, /usage: \/code owner\/name \[branch\]/, "a malformed argument says the shape, branch included");
  assert.match(block, /isBusy\(/, "never rebind under a running turn");
  assert.match(block, /#startCode\(scope\.chatId\)/, "no argument starts the account step (Task 54b)");
  assert.match(block, /branch: rest\[0\]/, "an optional second argument is the branch to continue");
});

test("/pr is the whole gate on Telegram: it shows what would go, then asks", () => {
  const block = TG.slice(TG.indexOf('case "pr":'), TG.indexOf("default:\n        // Not ours"));
  assert.match(block, /this\.service\.store\.getSessionRepo\(key\)/, "no repo means no card");
  assert.match(block, /nothing to publish/, "a clean tree is answered instead of offered");
  assert.match(block, /Publish \$\{st\.files\.length\} file\(s\)/, "the card states the size of the change");
  assert.match(block, /Draft PR/);
  assert.match(block, /Open PR/);
  assert.match(block, /Cancel/);
});

test("the publish answer reports the PR link, and cancel says nothing happened", () => {
  const block = TG.slice(TG.indexOf('if (kind === "p")'), TG.indexOf('if (kind === "qu")'));
  assert.match(block, /Publish cancelled — nothing left this machine\./);
  assert.match(block, /draft: choice === "d"/, "draft is a distinct choice, not the fallback");
  assert.match(block, /#\$\{res\.prNumber\} opened/);
  assert.match(block, /res\.prUrl/);
  assert.match(block, /could not publish — /, "a failure is reported on the same card");
});

test("a code turn ends with what changed and the two commands that act on it", () => {
  const reply = TG.slice(TG.indexOf("reply: async (finalText)"), TG.indexOf("typing.stop(); // belt-and-braces"));
  assert.match(reply, /file\(s\) changed \(/, "the count and the line totals");
  assert.match(reply, /\/diff to review · \/pr to publish/);
  assert.match(reply, /catch \{/, "and a bookkeeping failure never costs the answer");
});

test("the shared commands exist once and are published in the menu", () => {
  const catalog = readFileSync(join(ROOT, "src/agent/slash-commands.ts"), "utf8");
  for (const cmd of ["/code", "/repo", "/diff", "/pr"]) {
    assert.ok(catalog.includes(`{ cmd: "${cmd}`), `${cmd} is in the catalog, so /help and the menu show it`);
  }
  assert.match(SERVICE, /if \(cmd === "\/repo"\)/);
  assert.match(SERVICE, /if \(cmd === "\/diff"\)/);
  assert.match(SERVICE, /if \(cmd === "\/pr"\)/);
  assert.match(SERVICE, /if \(cmd === "\/code"\)/);
});

test("the service, not the model, decides whether this turn may publish", () => {
  assert.match(SERVICE, /publishAllowed: payload\.publish === true \|\| publishRequested\(text\)/);
  assert.match(SERVICE, /publish\?: boolean;/, "a surface can assert the user confirmed");
});

test("controls act on the chat, not on the person who tapped", () => {
  // The bug this pins: pickers are stored under the chat id but were read back
  // under the user id. In a DM those are the same number, so nothing showed; in
  // a group every tap answered "expired" (or bound the user's DM session).
  const region = TG.slice(TG.indexOf("async #onCallbackQuery"), TG.indexOf("#groupAllowed"));
  assert.match(region, /const chatId = ctx\.chat\?\.id \?\? fromId/, "one source for the chat");
  assert.match(region, /this\.#sessionKeyFor\(chatId\)/, "the session belongs to the chat");
  for (const bucket of ["#repoLists", "#pickedRepo", "#branchLists", "#accountPages"]) {
    assert.match(region, new RegExp(`this\\.${bucket}\\.(get|set|delete)\\(chatId`), `${bucket} is keyed by the chat`);
    assert.ok(!new RegExp(`this\\.${bucket}\\.(get|set|delete)\\(fromId`).test(region), `${bucket} never uses the user id`);
  }
  assert.ok(!/#sessionKeyFor\(fromId\)/.test(region), "no session lookup by user id left");
  // Pairing is the opposite rule, on purpose: it is about the person.
  assert.match(region, /this\.#paired\(fromId\)/);
  // And the pickers that used to be DM'd to the user now go to the chat.
  assert.ok(!/#sendRepoPicker\(fromId/.test(TG));
  assert.match(TG, /#sendAccounts\(chatId/);
  assert.match(TG, /#sendSessionsCard\(chatId/);
});

test("/model is a card: current model, providers, then models, then a pin", () => {
  const block = TG.slice(TG.indexOf('case "model":'), TG.indexOf('case "provider":'));
  assert.match(block, /if \(!sub\) return this\.#sendModelCard\(scope\.chatId\)/, "no argument opens the card");
  assert.match(block, /readModelArgument\(this\.service\.config, sub\)/, "typed refs go through the same reader");
  assert.match(block, /setSessionModel\(key, null\)/, "/model default clears the pin");
  assert.match(block, /setSessionModel\(key, canonical\)/, "a typed ref pins this chat");

  const handler = TG.slice(TG.indexOf('if (kind === "m")'), TG.indexOf('if (kind === "qu")'));
  assert.match(handler, /applyModelTap\(/, "the decision lives in the pure module");
  assert.match(handler, /setSessionModel\(key, model\)/, "the effect is exactly the pin");
  assert.match(handler, /configSvc\.setPath\("agents\.defaults\.model", model\)/, "Make default writes the real default");
  assert.match(handler, /this\.#editCard\(ctx, effect\.card\)/, "the card is edited in place, not re-sent");
  assert.match(handler, /show_alert: true/, "a stale tap explains itself");

  // The card is a reply to a command, not a status message.
  const send = TG.slice(TG.indexOf("async #sendModelCard"), TG.indexOf("async #sendModelCard") + 600);
  assert.match(send, /providerCard\(\{ config: this\.service\.config, pin: this\.#pinFor\(chatId\), page \}\)/);
});

test("/new keeps the chat's model, because the choice is about the chat", () => {
  // Task 54 follow-up. The pin is stored per session, so a rotation would
  // silently drop it and the very next answer would come from a different
  // model than the one the card said "this chat". The fix is to read the pin
  // before the tag rotates and write it onto the new key.
  const block = TG.slice(TG.indexOf("async #startNew"), TG.indexOf("async #sendSessionsCard"));
  const carriedAt = block.indexOf("const carried = this.#pinFor(chatId)");
  const rotateAt = block.indexOf("setMeta(`telegram:sess:");
  assert.ok(carriedAt !== -1, "the old session's pin is read first");
  assert.ok(rotateAt !== -1, "the rotation still happens");
  assert.ok(carriedAt < rotateAt, "read before the tag rotates, or it reads the empty new session");
  assert.match(block, /if \(carried\) this\.service\.store\.setSessionModel\(key, carried\)/, "and copied onto the new key");
});

test("/whoami answers the two questions a phone cannot otherwise settle", () => {
  // Task 56. "It says it changed the model but the answers are the default" and
  // "I updated it and nothing changed" were both unanswerable from Telegram:
  // the chat could not print the wire ref that would appear in the answer's
  // footer, nor the build the daemon was running.
  const block = TG.slice(TG.indexOf('case "whoami"'), TG.indexOf('case "new"'));
  assert.match(block, /currentModel\(this\.service\.config, this\.#pinFor\(scope\.chatId\)\)/, "the model is read per chat, like the picker");
  assert.match(block, /ref: \$\{cur\.ref\}/, "and printed as the wire ref, so the footer can be checked against it");
  assert.match(block, /execModeOf\(this\.service\.config\.tools\.exec\)/, "the exec mode is visible, not guessable");
  assert.match(block, /BUILD_STAMP/, "and the build stamp says which code is running");
});

test("the build stamp is a source hash, not a promise", () => {
  // scripts/build.mjs bakes it in; a bundle built without the define says
  // "unknown" rather than inventing a version.
  const build = readFileSync(join(ROOT, "scripts/build.mjs"), "utf8");
  assert.match(build, /__BUILD_STAMP__/, "passed to esbuild as a define");
  assert.match(build, /await walk\(join\(root, "src"\)\)/, "hashed over src/");
  assert.match(build, /hash\.update\(`version:\$\{version\}\\n`\)/, "and the package version");
  assert.match(SERVICE, /build: BUILD_STAMP,/, "health() reports it");
});
