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
  // The three new namespaces, read straight out of the source.
  assert.match(TG, /callback_data: "n:c"/, "chat answer");
  assert.match(TG, /callback_data: "n:k"/, "code answer");
  assert.match(TG, /callback_data: `r:\$\{page\}:\$\{i\}`/, "repo slot, indexed");
  assert.match(TG, /callback_data: `r:\$\{page \+ 1\}:p`/, "next page");
  assert.match(TG, /callback_data: `r:\$\{page - 1\}:p`/, "previous page");
  assert.match(TG, /callback_data: `b:\$\{start \+ i\}`/, "branch slot, indexed");
  assert.match(TG, /callback_data: `b:p:\$\{page - 1\}`/, "branch back");
  assert.match(TG, /callback_data: `b:p:\$\{page \+ 1\}`/, "branch more");
  assert.match(TG, /callback_data: "p:d"/);
  assert.match(TG, /callback_data: "p:o"/);
  assert.match(TG, /callback_data: "p:x"/);

  // No callback in the file may carry a repository path — an org/repo pair of
  // 40 characters would leave no room for the verb.
  const datas = [...TG.matchAll(/callback_data: (`[^`]+`|"[^"]+")/g)].map((m) => m[1]);
  assert.ok(datas.length > 8);
  for (const raw of datas) {
    const literal = raw.slice(1, -1);
    assert.ok(literal.length <= 64, `callback ${literal} is over Telegram's 64-byte cap`);
    assert.ok(!literal.includes("owner/name"), "never a literal repo path");
  }
});

test("the picker stores the page in memory and expires instead of guessing", () => {
  // Task 36: the row now carries the default branch, because the next question
  // is which branch to continue and the answer needs a base.
  assert.match(TG, /#repoPages = new Map<number, \{ fullName: string; defaultBranch: string \}\[\]>\(\)/);
  assert.match(TG, /this\.#repoPages\.set\(chatId, repos\.map\(\(r\) => \(\{ fullName: r\.fullName, defaultBranch: r\.defaultBranch \?\? "main" \}\)\)\)/);
  assert.match(TG, /#branchPages = new Map<number, string\[\]>\(\)/);
  assert.match(TG, /#pickedRepo = new Map<number, \{ repo: string; base: string \}>\(\)/);
  assert.match(TG, /if \(!repo\) \{[\s\S]{0,160}This picker expired — send \/code again/);
  assert.match(TG, /if \(!branch\) \{[\s\S]{0,160}This picker expired — send \/code again/);
  assert.ok(TG.includes("show_alert: true"), "a stale tap explains itself in a modal, not a silent no-op");
});

test("/new asks chat-or-code and keeps its rotation semantics", () => {
  assert.match(TG, /New session \$\{key\}/);
  assert.match(TG, /Chat, or code a repository\?/);
  assert.match(TG, /The previous one is kept/);
  // The rotation is still this exact call — the test that pinned it in Task 27
  // must keep passing, because /new is still non-destructive.
  assert.match(TG, /setMeta\(`telegram:sess:\$\{scope\.chatId\}`, Date\.now\(\)\.toString\(36\)\)/);
});

test("a repo tap asks for a branch, and the branch tap binds the session", () => {
  const repo = TG.slice(TG.indexOf('if (kind === "r")'), TG.indexOf('if (kind === "b")'));
  assert.match(repo, /which branch should the agent continue\?/, "one more question before anything is cloned");
  assert.match(repo, /this\.#pickedRepo\.set\(fromId, \{ repo: repo\.fullName, base: repo\.defaultBranch \}\)/);
  assert.match(repo, /this\.#sendBranchPicker\(fromId, 0\)/);

  const handler = TG.slice(TG.indexOf('if (kind === "b")'), TG.indexOf('if (kind === "p")'));
  assert.match(handler, /this\.#sessionKeyFor\(fromId\)/, "the tag is read at tap time");
  assert.match(handler, /this\.service\.bindRepo\(\{ sessionKey: key, repo: pick\.repo, base: pick\.base, branch \}\)/, "the branch the user tapped is the branch that is continued");
  assert.match(handler, /this\.#pickedRepo\.delete\(fromId\)/, "the pick is consumed, so a double tap cannot bind twice");
  assert.match(TG, /Ask for a change, then \/diff to review and \/pr to publish/, "the confirmation names the next two commands");
});

test("/code binds directly or opens the picker; a busy run is refused", () => {
  const block = TG.slice(TG.indexOf('case "code":'), TG.indexOf('case "pr":'));
  assert.match(block, /if \(target\)/, "an argument binds immediately");
  assert.match(block, /usage: \/code owner\/name \[branch\]/, "a malformed argument says the shape, branch included");
  assert.match(block, /isBusy\(/, "never rebind under a running turn");
  assert.match(block, /#sendRepoPicker\(scope\.chatId, 0\)/, "no argument opens the picker");
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
