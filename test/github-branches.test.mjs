// Task 36 — the branch choice on the three non-web surfaces, read as source.
//
// The behavioural half of this feature lives in repo-manager/repo-session (the
// checkout) and ui-repo (the sheet). What is left is *wiring*: four places that
// must forward one optional string, each of which is invisible until the day it
// is missing — a session that silently starts on the wrong branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const gateway = readFileSync(join(ROOT, "src/gateway/server.ts"), "utf8");
const cli = readFileSync(join(ROOT, "src/cli/github.ts"), "utf8");
const tui = readFileSync(join(ROOT, "src/tui/app.ts"), "utf8");
const tuiCommands = readFileSync(join(ROOT, "src/cli/tui-commands.ts"), "utf8");
const manager = readFileSync(join(ROOT, "src/repo/manager.ts"), "utf8");

test("the gateway exposes github.branches and forwards an optional branch", () => {
  assert.match(gateway, /case "github\.branches": \{/, "the RPC exists");
  assert.match(gateway, /"github\.branches",/, "and is listed in #methods(), so clients can discover it");
  const block = gateway.slice(gateway.indexOf('case "github.branches": {'), gateway.indexOf('case "github.repos": {'));
  assert.match(block, /const branches = await service\.githubBranches\(\{/);
  assert.match(block, /repo: String\(params\["repo"\] \?\? ""\)/);
  assert.match(block, /base: params\["base"\] \? String\(params\["base"\]\) : undefined/, "the base is optional, so an unknown default still lists");
  assert.match(block, /send\(okFrame\(id, \{ branches \}\)\)/);
  assert.match(block, /catch \(err\) \{[\s\S]{0,120}errFrame\(id, "bad_request"/, "a failed list is an answer, not a hang");

  // sessions.create and repo.bind both accept it; the UI's repo.bind sends it.
  assert.match(gateway, /branch: params\["branch"\] \? String\(params\["branch"\]\) : undefined/, "sessions.create keeps the branch");
  const bind = gateway.slice(gateway.indexOf('case "repo.bind": {'), gateway.indexOf('case "repo.unbind": {'));
  assert.match(bind, /branch: params\["branch"\] \? String\(params\["branch"\]\) : undefined/);
  assert.match(bind, /base: params\["base"\] \? String\(params\["base"\]\) : undefined/);
});

test("repo.status names the branch publish would push, from the one rule", () => {
  assert.match(gateway, /import \{ publishBranchFor \} from "\.\.\/repo\/manager\.js"/);
  assert.match(gateway, /publishBranch: publishBranchFor\(branch, binding\.base, sessionKey, binding\.workspace\)/);
  assert.match(manager, /export function publishBranchFor\(/, "the rule is exported, not copied");
  const st = gateway.slice(gateway.indexOf('case "repo.status": {'), gateway.indexOf('case "repo.diff": {'));
  assert.match(st, /const branch = binding\.branch \|\| st\.branch/, "the binding is the source of truth, the worktree is the fallback");
});

test("sc github branches lists what could be continued", () => {
  assert.match(cli, /if \(sub === "branches"\) \{/);
  assert.match(cli, /out\("  branches <owner\/name>   the branches this account could continue"\);/, "it is in the help");
  const block = cli.slice(cli.indexOf('if (sub === "branches") {'), cli.indexOf('if (sub === "code") {'));
  assert.match(block, /usage: sc github branches <owner\/name>/, "no argument says the shape");
  assert.match(block, /svc\.githubBranches\(\{ repo, base: defaultBranch \}\)/, "--base marks the default");
  assert.match(block, /b\.default \? "\*" : " "/, "the default is marked, not just first");
  assert.match(block, /continue one: {2}sc github code/, "and it prints the next command");
  // `code` takes the branch as its second positional and passes it to prepare.
  assert.match(cli, /out\("  code <owner\/name> \[branch\] \[--session key\]"\);/);
});

test("the TUI asks for a repository, then a branch, and starts the session with both", () => {
  assert.match(tui, /branches\?\(repo: string\): Promise<string\[\]>/, "the dependency is optional, so a TUI without GitHub still runs");
  assert.match(tui, /newSession\?\(spec: \{ kind: "chat" \| "code"; repo\?: string; branch\?: string \}\): void/);
  assert.match(tui, /code — pick a repository, work on a branch, open a PR/, "the overlay says what code means");
  assert.match(tui, /void this\.#pick\("branch", branches, \(line\) => \{/, "the second overlay is the branch");
  assert.match(tui, /this\.deps\.newSession\?\.\(\{ kind: "code", repo: name, branch: branch \|\| undefined \}\)/, "the branch reaches the session");
  assert.match(tui, /branches\.length === 0/, "a repo with no branch list still starts, rather than dead-ending");

  // Both TUI drivers implement it: local service and remote client.
  assert.match(tuiCommands, /branches: async \(repo\) => \{\n\s+try \{\n\s+const rows = await service\.githubBranches\(\{ repo \}\)/, "local");
  assert.match(tuiCommands, /branches: async \(repo\) => \{[\s\S]{0,200}client\.request\("github\.branches", \{ repo \}\)/, "remote");
  assert.match(tuiCommands, /`\$\{b\.default \? "●" : " "\} \$\{b\.name\}/, "the default branch is marked in the list");
  assert.match(tuiCommands, /repo\.bind", \{ sessionKey, repo: spec\.repo, \.\.\.\(spec\.branch \? \{ branch: spec\.branch \} : \{\}\) \}/, "the remote driver binds with the branch");
});
