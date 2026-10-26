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

test("the bar says Name · branch and a small PR button — nothing else", () => {
  // Task 36 replaced nine states with five: the strip answers *where am I* and
  // offers *the one action*. Anything that was a status sentence is gone.
  for (const kind of ["preparing", "failed", "ready", "publishing", "warn"]) {
    assert.match(repo, new RegExp(`kind: \"${kind}\"`), `the ${kind} state is part of the union`);
  }
  const union = repo.slice(repo.indexOf("type BarState ="), repo.indexOf("type Handlers ="));
  assert.match(union, /reason: "stale" \| "gone"/, "a warning says which warning it is");
  for (const gone of ["clean", "working", "changed", "pushing", "pr"]) {
    assert.doesNotMatch(union, new RegExp(`kind: \"${gone}\"`), `${gone} is no longer a bar state`);
  }

  assert.match(repo, /function shortRepo\(repo: string\): string \{\n  return repo\.split\("\/"\)/, "the owner prefix is dropped in one place");
  assert.match(repo, /const label = \(text: string\) => \(name \? `\$\{name\} · \$\{text\}` : text\)/, "Name · branch, and the name is the short one");
  assert.match(repo, /paint\(label\(branch\)/, "the resting state is the branch, bare");
  assert.match(repo, /cloning\$\{bar\.pct !== undefined \? ` \$\{bar\.pct\}%` : "…"\}/, "a clone reports its percentage");
  assert.match(repo, /paint\(label\("publishing…"\)/, "publishing is the only other verb");
  assert.match(repo, /clone failed — retry/, "a failed clone says what happened and what to do");
  const renderer = repo.slice(repo.indexOf("function renderBar()"), repo.indexOf("export async function refreshRepo"));
  assert.doesNotMatch(renderer, /no changes|files, \+|working…/, "no change counts, no 'no changes', no 'working…'");

  // The PR button: always present, disabled rather than hidden, and it becomes
  // the PR itself once one exists.
  assert.match(repo, /const label = lastPr \? `PR\$\{lastPr\.number \? ` #\$\{lastPr\.number\}` : ""\} ↗` : "PR";/);
  assert.match(repo, /disabled: Boolean\(status\.clean\) && !lastPr/, "nothing to publish disables the button, it does not hide it");
  assert.match(repo, /window\.open\(lastPr\.url/, "an existing PR opens instead of pushing again");
  assert.match(repo, /const full = `\$\{status\.repo \?\? ""\} · \$\{branch\}`/, "the full owner/name survives only in the tooltip");
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
  assert.ok(/Pick a repo and a branch, then open a PR/.test(sheet), "code names the payoff");
  assert.match(sheet, /Connect GitHub to start/, "not connected is a route, not a dead end");
  assert.match(sheet, /new-session-overlay/, "it drives its own overlay");
  assert.match(sheet, /e\.key === "Tab"[\s\S]{0,120}focusAt/, "Tab cycles inside the sheet");
  assert.match(sheet, /e\.key === "Escape"[\s\S]{0,240}return close\(\)/, "Esc cancels");
  assert.match(sheet, /new-chat-btn"\) as HTMLElement \| null\)\?\.focus\(\)/, "focus returns to the control that opened it");
});

test("the + buttons open the sheet; the instant chat path still exists", () => {
  assert.match(main, /\$\("new-session"\)\.onclick = openSessionSheet;/);
  assert.match(main, /\$\("new-chat-btn"\)\.onclick = openSessionSheet;/);
  // Task 29's contract: a new chat is created by a timestamp key and never asks
  // for a name. The sheet changes *why* you press +, not what a chat is.
  assert.match(main, /function newSession\(\): void \{\n  const key = `main:\$\{Date\.now\(\)\.toString\(36\)\}`;\n  void switchSession\(key\);\n\}/);
});

test("choosing a repository asks for a branch, and the branch is what binds", () => {
  assert.match(repo, /type Phase = "choose" \| "repos" \| "branches"/, "three steps, one question each");
  const sheet = repo.slice(repo.indexOf("export function openSessionSheet"), repo.indexOf("/* ---------------- connect"));
  assert.match(sheet, /Pick a branch/, "the third step has a title");
  assert.match(sheet, /Filter branches…/, "a long branch list is filterable");
  assert.match(sheet, /Loading branches of \$\{pick\.repo\}…/);
  assert.match(sheet, /gateway\.request\("github\.branches", \{ repo: pick\.repo, \.\.\.\(pick\.base \? \{ base: pick\.base \} : \{\}\) \}\)/, "the list comes from the same RPC the TUI and Telegram use");
  assert.match(sheet, /b\.default \? "default branch · you will work on it directly" : "continues this branch"/, "the default branch says what publishing will do");
  assert.match(sheet, /handlers\.code\(pick\.repo, b\.name\)/, "the pick carries the branch");
  assert.match(sheet, /if \(phase === "branches"\) return void drawRepos\(\)/, "Esc walks back a step, it does not throw the choice away");
  // No repo ever reaches the handler without a branch: the repo row only opens
  // the branch step.
  const repoRows = sheet.slice(sheet.indexOf("const repoRow ="), sheet.indexOf("const drawRows ="));
  assert.match(repoRows, /drawBranches\(\{ repo: name, base \}\)/);
  assert.doesNotMatch(repoRows, /handlers\.code\(name\)/, "a repo tap never binds by itself");
  assert.match(main, /code: \(repo, branch\) => void startCodeSession\(repo, branch\)/, "main.ts forwards the branch");
  assert.match(main, /branch \? \{ branch \} : \{\}/, "and binds with it, or without it when the user skipped");
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

test("the publish sheet names the branch that will receive the commits", () => {
  assert.match(repo, /publishBranch\?: string;/, "the gateway tells the UI where publish will push");
  assert.match(repo, /const push = status\.publishBranch \|\| status\.branch;/, "the dialog prefers the real target");
  assert.match(repo, /`\$\{push\} → \$\{status\.base\}`/, "head → base, in the sheet");
  assert.match(repo, /This session continues \$\{status\.base\}, so the commits go to \$\{push\}\. \$\{status\.base\} is never pushed to\./, "the default-branch case explains itself");
  assert.match(repo, /publishes to \$\{push\} → \$\{status\.base\}/, "the changes dialog says the same thing before the sheet opens");
});

test("dialogs fit a phone", () => {
  // Task 36 moved the modal from a floating card to a bottom sheet on phones.
  const mobile = css.slice(css.indexOf("Task 36: dialogs, phone"));
  assert.match(mobile, /@media \(max-width: 640px\)/);
  assert.match(mobile, /\.modal \{[\s\S]{0,220}top: auto;[\s\S]{0,80}bottom: 0;/, "a modal is anchored to the bottom edge");
  assert.match(mobile, /max-height: 88dvh/, "dvh, so the address bar cannot push the buttons off-screen");
  assert.match(mobile, /border-radius: var\(--r-xl\) var\(--r-xl\) 0 0/, "one rounded edge, like the other sheets");
  assert.match(mobile, /env\(safe-area-inset-bottom, 0px\)/, "the home indicator never covers the actions");
  assert.match(mobile, /\.modal__body \{[\s\S]{0,160}min-height: 0/, "the body shrinks so the foot stays put");
  assert.match(mobile, /white-space: pre-wrap/, "the diff wraps instead of scrolling the dialog sideways");
  assert.match(mobile, /\.gh__diff \{[\s\S]{0,200}overflow-wrap: anywhere/);
  assert.match(css, /\.modal__head h2,\s*\n\.modal__body,/, "a long path or title wraps in every dialog width");
  assert.match(css, /\.sheet__row \.mono \{[\s\S]{0,140}text-overflow: ellipsis/, "a long repository name is clipped, not pushed");
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
  assert.match(repo, /case "preparing":\s*return paint\(label\([^;]{0,200}lock: true/, "preparing locks");
  assert.match(repo, /case "failed":\s*return paint\(label\("clone failed — retry"\), \{ warn: true, disabled: true, lock: false/, "and a failure releases it");
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
