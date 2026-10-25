// Partial #8 — exec approvals: the policy evaluator, safe-bin grid, durable
// allow-always ledger, no-shell direct execution, and the CLI surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-exec-"));
const {
  evaluateExec,
  splitChain,
  tokenizeArgv,
  globMatcher,
  inlineEvalCarrier,
  runDirectChain,
  loadApprovalsDoc,
  ledgerEntries,
  mintAlwaysEntry,
  addManualEntry,
  revokeEntry,
  emptyApprovalsDoc,
  execModeOf,
  emptyConfig,
  Store,
} = await import("../dist/lib.js");

const SC = join(process.cwd(), "dist", "sc.js");

// ---- fixtures ----
const BIN = mkdtempSync(join(tmpdir(), "sc-exec-bin-"));
const mkBin = (name, body = "#!/bin/sh\nexit 0\n") => {
  const p = join(BIN, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
};
for (const b of ["wc", "head", "tail", "tr", "cut", "uniq", "rg", "cat", "python3", "node", "bash", "awk", "find", "echo", "myfmt"]) mkBin(b);
// echo prints its argv so direct-route tests can see literal expansion
mkBin("echo", '#!/bin/sh\nprintf "%s\\n" "$*"\n');
mkBin("wcat", '#!/bin/sh\nprintf "from-stdin\\n"\n');

const baseConfig = (over = {}) => {
  const cfg = emptyConfig();
  cfg.tools.exec = {
    enabled: true,
    approvals: true,
    mode: "ask",
    askFallback: "deny",
    strictInlineEval: false,
    safeBins: ["cut", "uniq", "head", "tail", "tr", "wc"],
    safeBinTrustedDirs: [BIN],
    timeoutMs: 600_000,
    ...over,
  };
  return cfg;
};

const ev = (command, over = {}, doc = emptyApprovalsDoc(), cwd = BIN) =>
  evaluateExec({ config: baseConfig(over), doc, command, cwd, pathEnv: BIN });

// ---- splitter / tokenizer ----

test("splitChain: && || ; | segmentation with quote awareness", () => {
  const c = splitChain("rg foo && wc -l || echo 'a && b'; tr -s ' ;'");
  assert.equal(c.ok, true);
  assert.deepEqual(c.segments, ["rg foo ", " wc -l ", " echo 'a && b'", " tr -s ' ;'"]);
  assert.deepEqual(c.ops, ["&&", "||", ";"]);
  assert.ok(splitChain("echo a | wc").ops.includes("|"));
});

test("splitChain: substitution/subshell/redirection/background unparseable", () => {
  for (const bad of ["echo $(id)", "echo `id`", "cat < /etc/passwd", "echo x > f", "(echo x)", "longcmd &"]) {
    assert.equal(splitChain(bad).ok, false, bad);
  }
  assert.equal(splitChain("echo 2>&1 ok").ok, false, "2> redirection");
  assert.equal(splitChain("echo '$(id)'").ok, true, "single-quoted substitution stays literal");
  assert.equal(splitChain("rm -f x").ok, true, "plain flags parse fine");
});

test("tokenizeArgv: quotes, escapes, empty, control rejection", () => {
  assert.deepEqual(tokenizeArgv("wc -l"), ["wc", "-l"]);
  assert.deepEqual(tokenizeArgv("echo 'a b' \"c\\\"d\""), ["echo", "a b", 'c"d']);
  assert.deepEqual(tokenizeArgv(""), null === null ? [] : null, "empty ok");
  assert.equal(tokenizeArgv("echo a|b"), null);
  assert.equal(tokenizeArgv("cat /etc/passwd |"), null);
});

// ---- glob ----

test("globMatcher: *, **, ? semantics", () => {
  assert.ok(globMatcher("rg")("rg"));
  assert.ok(!globMatcher("rg")("/usr/bin/rg"));
  assert.ok(globMatcher("/opt/*/bin/rg")("/opt/homebrew/bin/rg"));
  assert.ok(!globMatcher("/opt/*/bin/rg")("/opt/a/b/bin/rg"), "* never crosses /");
  assert.ok(globMatcher("/opt/**/rg")("/opt/a/b/bin/rg"), "** crosses /");
  assert.ok(globMatcher("w?")("wc"));
});

// ---- mode matrix + legacy mapping ----

test("execModeOf: explicit mode wins; legacy bool maps", () => {
  assert.equal(execModeOf({ approvals: false }), "full");
  assert.equal(execModeOf({ approvals: true }), "ask");
  assert.equal(execModeOf({ approvals: false, mode: "deny" }), "deny");
  assert.equal(execModeOf({ approvals: true, mode: "allowlist" }), "allowlist");
});

test("verdict matrix: deny/full/legacy, disabled tool", () => {
  assert.equal(ev("rm -rf /", { mode: "deny" }).decision, "deny");
  const full = ev("rm -rf /", { mode: "full" });
  assert.equal(full.decision, "allow");
  assert.equal(full.route, "shell");
  const legacy = ev("id", { mode: undefined, approvals: false });
  assert.equal(legacy.decision, "allow", "legacy approvals:false ⇒ full");
  assert.equal(ev("id", { enabled: false }).decision, "deny");
});

// ---- allowlist matching ----

const docWith = (...entries) => {
  const doc = emptyApprovalsDoc();
  doc.agents.main.allowlist.push(...entries);
  return doc;
};

test("manual entries: bare-name matches PATH invocation, not ./ or /-paths", () => {
  const doc = docWith({ id: "e1", pattern: "rg" });
  assert.equal(ev("rg pattern", {}, doc).decision, "allow");
  assert.equal(ev("./rg pattern", {}, doc).decision, "ask", "relative path never matches a bare entry");
  assert.equal(ev(`${BIN}/rg pattern`, {}, doc).decision, "ask", "absolute path is not a PATH invocation");
});

test("manual entries: path globs match resolved locations; argPattern gates argv", () => {
  const doc = docWith({ id: "e2", pattern: `${BIN}/r*` });
  assert.equal(ev(`${BIN}/rg foo`, {}, doc).decision, "allow");
  assert.equal(ev("rg foo", {}, doc).decision, "allow", "PATH-resolved file hits the path glob too");
  const doc2 = docWith({ id: "e3", pattern: "python3", argPattern: "^safe\\.py$" });
  assert.equal(ev("python3 safe.py", {}, doc2).decision, "allow");
  assert.equal(ev("python3 other.py", {}, doc2).decision, "ask");
  assert.deepEqual(ev("python3 -c 'id'", {}, doc2).decision, "ask");
});

test("shell chains: every top-level segment must match", () => {
  const doc = docWith({ id: "e4", pattern: "rg" });
  // rg matched by entry; wc -l matched by safe bin; echo unmatched
  assert.equal(ev("rg foo && wc -l", {}, doc).decision, "allow");
  const ask = ev("rg foo && wc -l && echo hi", {}, doc);
  assert.equal(ask.decision, "ask");
  assert.match(ask.reason, /not on the allowlist/);
  // allowlist mode denies on any miss
  assert.equal(ev("rg foo && echo hi", { mode: "allowlist" }, doc).decision, "deny");
});

test("pipes/redirections ask forever unsupported in allowlist mode, never auto-allowed", () => {
  const doc = docWith({ id: "e5", pattern: "rg" }, { id: "e6", pattern: "wc" });
  const ask = ev("rg foo | wc -l", {}, doc);
  assert.equal(ask.decision, "ask");
  assert.match(ask.reason, /pipes/);
  assert.equal(ev("rg foo | wc -l", { mode: "allowlist" }, doc).decision, "deny");
  assert.equal(ev("rg foo > out", {}, doc).decision, "ask");
});

// ---- safe bins ----

test("safe bins: stdin shapes allowed, file access denied by profile", () => {
  assert.equal(ev("wc -l").decision, "allow", "pure stdin flag");
  assert.equal(ev("wc -lw").decision, "allow", "bundled known bools");
  assert.equal(ev("head -n 5").decision, "allow");
  assert.equal(ev("tr 'a' 'b'").decision, "allow", "literal operands");
  assert.equal(ev("wc --files0-from=z").decision, "ask", "denied flag");
  assert.equal(ev("tail -f x").decision, "ask", "tail follow is denied");
  assert.equal(ev("wc /etc/passwd").decision, "ask", "positional file operand");
  assert.equal(ev("wc somefile").decision, "ask", "positional name");
  assert.equal(ev("head --neatly=2").decision, "ask", "unknown long option");
  assert.equal(ev("wc -Z").decision, "ask", "unknown short flag");
  assert.equal(ev("cut -d, -f1").decision, "allow", "cut value flags");
  assert.equal(ev("cut -f /etc/x").decision, "ask", "unsafe value content");
});

test("safe bins: trusted dirs gate; awk/sed/jq can never be safe bins", () => {
  assert.equal(ev("wc -l", { safeBinTrustedDirs: ["/definitely/not/here"] }).decision, "ask", "untrusted dir");
  assert.equal(ev("awk '{print}'", { safeBins: ["awk"] }).decision, "ask", "awk refused even when listed");
  assert.equal(ev("sed s/a/b/", { safeBins: ["sed"] }).decision, "ask");
});

// ---- strict inline eval ----

test("inlineEvalCarrier detection grid", () => {
  assert.ok(inlineEvalCarrier("node", ["-e", "1"]));
  assert.ok(inlineEvalCarrier("node", ["--eval", "1"]));
  assert.ok(inlineEvalCarrier("python3", ["-c", "1"]));
  assert.ok(inlineEvalCarrier("perl", ["-e:", "1"]));
  assert.ok(inlineEvalCarrier("bash", ["-c", "rm x"]));
  assert.ok(inlineEvalCarrier("bash", ["-lc", "x"]));
  assert.ok(inlineEvalCarrier("awk", ["{}"]));
  assert.ok(inlineEvalCarrier("make", ["all"]));
  assert.ok(inlineEvalCarrier("find", ["/tmp", "-exec", "rm", "{}", ";"]));
  assert.ok(!inlineEvalCarrier("node", ["app.js"]));
  assert.ok(!inlineEvalCarrier("python3", ["tool.py"]));
  assert.ok(!inlineEvalCarrier("bash", ["script.sh"]));
});

test("strictInlineEval: never auto-allowed, never minted, even with a manual entry", () => {
  const doc = docWith({ id: "e7", pattern: "node" });
  assert.equal(ev("node -e 'process.exit(0)'", {}, doc).decision, "allow", "no strict eval: entry wins");
  const v = ev("node -e 'process.exit(0)'", { strictInlineEval: true }, doc);
  assert.equal(v.decision, "ask");
  assert.match(v.reason, /inline-eval/);
  assert.equal(v.mintable, false, "carriers are never minted");
  assert.equal(ev("bash -c 'id'", { strictInlineEval: true }, docWith({ id: "e8", pattern: "bash" })).decision, "ask", "bash -c is a carrier");
  assert.equal(ev("node app.js", { strictInlineEval: true }, doc).decision, "allow", "plain script invocation is fine");
});

// ---- allow-always minted grants (exact argv + cwd bound) ----

test("allow-always ledger: mint → hit only on identical argv+cwd; revoke removes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-exec-db-"));
  const store = Store.open(join(dir, "state.db"));
  const cwd = "/home/user/project";
  mintAlwaysEntry(store, { argv0: "rg", argv: ["rg", "TODO", "-n"], cwd, resolvedPath: `${BIN}/rg`, command: "rg TODO -n" });
  const doc = loadApprovalsDoc(store);
  assert.equal(doc.agents.main.allowlist.length, 1);

  const same = ev("rg TODO -n", {}, doc, cwd);
  assert.equal(same.decision, "allow");
  assert.equal(same.segments[0].matched, "generated");

  const otherArgv = ev("rg FIXME -n", {}, doc, cwd);
  assert.equal(otherArgv.decision, "ask", "argv differs by one word → miss");
  const otherCwd = ev("rg TODO -n", {}, doc, "/home/user/elsewhere");
  assert.equal(otherCwd.decision, "ask", "cwd bound (always allow HERE)");

  assert.equal(revokeEntry(store, doc.agents.main.allowlist[0].id), true);
  assert.equal(ledgerEntries(loadApprovalsDoc(store)).length, 0);
  assert.equal(ev("rg TODO -n", {}, loadApprovalsDoc(store), cwd).decision, "ask");
  assert.equal(revokeEntry(store, "ax-nope"), false);
});

test("addManualEntry validates pattern/regex and rejects duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-exec-db2-"));
  const store = Store.open(join(dir, "state.db"));
  assert.equal(addManualEntry(store, "rg").ok, true);
  assert.equal(addManualEntry(store, "rg").ok, false, "duplicate");
  assert.equal(addManualEntry(store, "python3", "^safe\\.py$").ok, true);
  assert.equal(addManualEntry(store, "").ok, false);
  assert.equal(addManualEntry(store, "x", "(").ok, false, "broken regex");
  assert.equal(ledgerEntries(loadApprovalsDoc(store)).length, 2);
});

// ---- direct (no-shell) execution route ----

test("runDirectChain: literal argv (no globbing), && || ; semantics", async () => {
  const work = mkdtempSync(join(tmpdir(), "sc-exec-run-"));
  writeFileSync(join(work, "aaa"), "x");
  writeFileSync(join(work, "bbb"), "x");
  const seg = (argv, resolvedPath) => ({ argv, argv0: argv[0], resolvedPath, matched: "manual" });

  // literal globs: echo '*' must print '*' despite cwd containing files
  const lit = await runDirectChain([seg(["echo", "*"], `${BIN}/echo`)], [], { cwd: work, timeoutMs: 5000 });
  assert.equal(lit.output.trim(), "*", "no shell ⇒ no glob expansion");

  const both = await runDirectChain([seg(["echo", "a"], `${BIN}/echo`), seg(["echo", "b"], `${BIN}/echo`)], ["&&"], { cwd: work, timeoutMs: 5000 });
  assert.match(both.output, /a/);
  assert.match(both.output, /b/);

  const stop = await runDirectChain([seg(["false"], `${BIN}/false`), seg(["echo", "never"], `${BIN}/echo`)], ["&&"], { cwd: work, timeoutMs: 5000 });
  assert.doesNotMatch(stop.output, /never/);
  const or = await runDirectChain([seg(["false"], `${BIN}/false`), seg(["echo", "fallback"], `${BIN}/echo`)], ["||"], { cwd: work, timeoutMs: 5000 });
  assert.match(or.output, /fallback/);
});

// verdicts carry spawn-ready plans
test("full-allow verdicts expose direct segments w/ wrappers unwrapped", () => {
  const doc = docWith({ id: "e9", pattern: "rg" });
  const v = ev("rg foo && nohup wc -l", {}, doc);
  assert.equal(v.decision, "allow");
  assert.equal(v.route, "direct");
  assert.equal(v.segments.length, 2);
  assert.equal(v.segments[1].argv0, "wc", "nohup unwrapped");
  assert.equal(v.segments[1].matched, "safe-bin");
  assert.ok(v.segments.every((s) => s.resolvedPath.startsWith(BIN)));
});

// ---- CLI surface ----

const runCli = (home, args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, ...args], { env: { ...process.env, SUPARCLAW_HOME: home } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
const parseJsonBlock = (out) => JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));

test("CLI: approvals get/mode/list/allow/revoke/preset round trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-exec-cli-"));
  await runCli(home, ["init"]);

  const get0 = await runCli(home, ["approvals", "get", "--json"]);
  const body0 = parseJsonBlock(get0.out);
  assert.equal(body0.mode, "full", "approved by default; sc approvals mode takes it back");
  assert.equal(body0.entries.length, 0);

  assert.equal((await runCli(home, ["approvals", "mode", "allowlist"])).code, 0);
  const get1 = parseJsonBlock((await runCli(home, ["approvals", "get", "--json"])).out);
  assert.equal(get1.mode, "allowlist");
  assert.equal((await runCli(home, ["approvals", "mode", "nope"])).code, 1);

  assert.equal((await runCli(home, ["approvals", "allow", "rg", "--arg-regex", "^safe"])).code, 0);
  assert.equal((await runCli(home, ["approvals", "allow", "rg", "--arg-regex", "^safe"])).code, 1, "duplicate rejected");
  const list = JSON.parse((await runCli(home, ["approvals", "list", "--json"])).out.trim());
  assert.equal(list.length, 1);
  assert.equal(list[0].pattern, "rg");
  assert.equal(list[0].argPattern, "^safe");

  assert.equal((await runCli(home, ["approvals", "revoke", list[0].id])).code, 0);
  assert.equal((await runCli(home, ["approvals", "revoke", "ax-nope"])).code, 1);

  const preset = await runCli(home, ["approvals", "preset", "yolo"]);
  assert.equal(preset.code, 0);
  const get2 = parseJsonBlock((await runCli(home, ["approvals", "get", "--json"])).out);
  assert.equal(get2.mode, "full");
  assert.equal(get2.askFallback, "full");
  assert.equal((await runCli(home, ["approvals", "preset", "cautious"])).code, 0);
});
