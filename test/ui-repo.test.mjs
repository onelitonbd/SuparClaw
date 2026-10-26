// Task 35 — the web surface, read as source. The app is DOM code with no test
// harness heavy enough to click through a clone, so these assertions pin the
// promises that are *visible in the code*: the bar's nine states, the sheet's
// focus trap, the publish gate, and the fact that the UI never touches a token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const repo = readFileSync(join(ROOT, "ui/src/repo.ts"), "utf8");
const main = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
const html = readFileSync(join(ROOT, "ui/index.html"), "utf8");
const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
const sessions = readFileSync(join(ROOT, "ui/src/sessions.ts"), "utf8");
const chat = readFileSync(join(ROOT, "ui/src/chat.ts"), "utf8");
const settings = readFileSync(join(ROOT, "ui/src/settings.ts"), "utf8");

test("the bar has one renderer with all nine states and its exact copy", () => {
  for (const kind of ["preparing", "failed", "clean", "working", "changed", "pushing", "pr", "stale", "gone"]) {
    assert.match(repo, new RegExp(`kind: "${kind}"`), `the ${kind} state is part of the union`);
  }
  assert.match(repo, /clone failed — retry/, "a failed clone says what happened and what to do");
  assert.match(repo, /GitHub reconnecting…/, "a stale token has its own sentence");
  assert.match(repo, /repository unavailable/, "a repo that vanished has its own sentence");
  assert.match(repo, /· no changes`, \{ action: "Publish PR", disabled: true \}/, "publish is disabled, never hidden");
  assert.match(repo, new RegExp("PR\\$\\{bar\\.number \\? ` #\\$\\{bar\\.number\\}` : \"\"\\} open ↗"), "an open PR links out");
  assert.match(repo, /working…/);
  assert.match(repo, /publishing…/);
});

test("the bar follows the open session, not a global current repo", () => {
  assert.match(main, /setRepoSession\(key\)/, "switching sessions re-derives the bar");
  assert.match(main, /mountRepoBar\(\)/);
  assert.match(main, /setRepoSession\(sessionKey\)/, "boot uses the restored session");
  assert.match(repo, /if \(!status\.bound\) \{\n    barNode\.hidden = true/, "a normal chat hides the bar entirely");
});

test("the repo lifecycle rides the chat stream", () => {
  assert.match(main, /case "repo":[\s\S]{0,200}handleRepoEvent\(e\)/, "clone/publish events reuse the one stream");
  for (const phase of ["clone", "worktree", "done", "published", "failed"]) {
    assert.match(repo, new RegExp(`"${phase}"`), `phase ${phase} is rendered`);
  }
});

test("the new-session sheet is a decision with a focus trap, chat first", () => {
  const sheet = repo.slice(repo.indexOf("export function openSessionSheet"), repo.indexOf("/* ---------------- connect"));
  assert.ok(sheet.includes("New session"), "the sheet has a title");
  assert.ok(sheet.includes("Chat") && sheet.includes("Code a repository"), "the two rows are the question");
  assert.ok(sheet.includes("Talk, research, files"), "chat explains itself in five words");
  assert.ok(/Pick a repo, work on a branch, open a PR/.test(sheet), "code names the payoff");
  assert.match(sheet, /Connect GitHub to start/, "not connected is a route, not a dead end");
  assert.match(sheet, /new-session-overlay/, "it drives its own overlay");
  assert.match(sheet, /e\.key === "Tab"[\s\S]{0,120}focusAt/, "Tab cycles inside the sheet");
  assert.match(sheet, /e\.key === "Escape"[\s\S]{0,120}close\(\)/, "Esc cancels");
  assert.match(sheet, /new-chat-btn"\) as HTMLElement \| null\)\?\.focus\(\)/, "focus returns to the control that opened it");
});

test("the + buttons open the sheet; the instant chat path still exists", () => {
  assert.match(main, /\$\("new-session"\)\.onclick = openSessionSheet;/);
  assert.match(main, /\$\("new-chat-btn"\)\.onclick = openSessionSheet;/);
  // Task 29's contract: a new chat is created by a timestamp key and never asks
  // for a name. The sheet changes *why* you press +, not what a chat is.
  assert.match(main, /function newSession\(\): void \{\n  const key = `main:\$\{Date\.now\(\)\.toString\(36\)\}`;\n  void switchSession\(key\);\n\}/);
});

test("the repo picker pages, filters, and offers Clone by URL + Refresh", () => {
  assert.match(repo, /Filter repos…/);
  assert.match(repo, /Clone by URL/);
  assert.match(repo, /⟳ Refresh/);
  assert.match(repo, /🔒 private/, "private repos are marked, so a missing repo is explained");
  assert.match(repo, /No repositories — an empty account, or a token without the repo scope/, "the empty state names both causes");
  assert.match(repo, /github\.repos/);
  assert.match(repo, /\.slice\(0, 60\)/, "scale: a page of results, never the whole org");
  assert.match(repo, /\[\"Recent"\]|"Recent"/, "recents come from our own sessions, newest first");
  assert.match(repo, /gateway\.request\("sessions\.list"/, "and are read from the store, not from GitHub's ordering");
});

test("publish is a dialog with a draft default and a secret speed bump", () => {
  assert.match(repo, /draft\.checked = true/, "draft by default");
  assert.match(repo, /Draft pull request/);
  assert.match(repo, /Publish anyway/, "a risky file needs a second tap");
  assert.match(repo, /may contain a secret/, "and the warning says why");
  assert.match(repo, /repo\.publish/);
  // Several PRs are allowed across a session, but only from this dialog.
  assert.match(repo, /PR\$\{res\.prNumber\}|PR #\$\{res\.prNumber\}/);
});

test("connect offers the gh login first and the device code second", () => {
  assert.match(repo, /Use this machine's gh login/);
  assert.match(repo, /Continue with GitHub/);
  assert.match(repo, /Enter this code on GitHub/);
  assert.match(repo, /github\.adoptGhCli/);
  assert.match(repo, /github\.connect/);
  assert.match(repo, /github\.code/, "the code arrives on its own frame, so it paints before polling ends");
  for (const state of ["expired", "cancelled", "device login turned off"]) {
    assert.match(repo, new RegExp(state, "i"), `terminal state: ${state}`);
  }
});

test("the UI never holds a token and never asks the gateway for one", () => {
  for (const src of [repo, main, settings]) {
    assert.doesNotMatch(src, /github\.(token|credential|secret)/i, "there is no such RPC, and there must be no such call");
    assert.doesNotMatch(src, /\btoken\s*[:=]\s*["'][A-Za-z0-9_]{10,}/, "no hard-coded credential");
  }
  assert.match(settings, /github\.status[\s\S]{0,600}scopes/, "Settings shows scopes, which is a redacted view");
  assert.match(settings, /Stored token \(0600\)|stored token \(0600\)/, "the credential source is described, not printed");
});

test("Settings → Integrations → GitHub is the home after onboarding", () => {
  assert.match(settings, /\{ id: "github", label: "GitHub", group: "Integrations" \}/);
  assert.match(settings, /#renderGitHub/);
  assert.match(settings, /gh-connect/);
  assert.match(settings, /gh-disconnect/);
  assert.match(settings, /connectDialog\(\(\) => void this\.render\(\)\)/, "Reconnect is the same dialog");
});

test("a cloning session locks the composer with copy, not a silent disable", () => {
  assert.match(chat, /setRepoLock\(locked: boolean, detail\?: string\)/);
  assert.match(chat, /Preparing the repository/);
  assert.match(repo, /composer\?\.setRepoLock\(/, "the bar drives the lock");
  assert.match(repo, /case "preparing":\s*return paint\([^;]{0,200}lock: true \}/, "preparing locks");
  assert.match(repo, /case "failed":\s*return paint\("clone failed — retry", \{ warn: true, lock: false \}\)/, "and a failure releases it");
});

test("a code session is recognisable in the sidebar before you open it", () => {
  assert.match(sessions, /repo\?: string \| null/);
  assert.match(sessions, /session__repo mono/);
  assert.match(css, /\.session__repo/);
  assert.match(css, /\.repo-bar \{[\s\S]{0,300}height: 32px/, "the bar is the 32px strip the design specifies");
  assert.match(css, /\.repo-bar\[hidden\] \{ display: none; \}/, "hidden is honest");
});

test("markup carries the bar and the sheet, so neither is built blind", () => {
  assert.match(html, /id="repo-bar"/);
  assert.match(html, /role="status"/, "the bar announces itself to a screen reader");
  assert.match(html, /id="new-session-overlay"/);
  assert.match(html, /id="new-session-list"/);
  assert.match(html, /id="new-session-title"/);
});
