// Task 52 — persistent terminals (src/agent/terminals.ts).
//
// Everything here talks to a real /bin/bash: the point of the feature is that
// state survives between calls, so a mock would prove nothing. Only the parts
// that are pure (cleaning, escape splitting) are tested in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Terminal,
  TerminalManager,
  TERMINAL_DEFAULTS,
  cleanTerminalText,
  stripProtocol,
  findMarker,
  visibleBeforeMarker,
  descendants,
  findTerminalShell,
  splitIncompleteEscape,
} from "../dist/lib.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sc-term-"));

/** Wait for a condition without a fixed sleep where possible. */
async function until(fn, ms = 3000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("cleanTerminalText strips CSI, OSC titles and carriage-return overwrites", () => {
  assert.equal(cleanTerminalText("\u001b[32mgreen\u001b[0m"), "green");
  assert.equal(cleanTerminalText("\u001b]0;a title\u0007done"), "done");
  // A progress bar redraws the same line with \r: only the final state is text.
  assert.equal(cleanTerminalText("progress 10%\rprogress 100%\r\n"), "progress 100%\n");
  assert.equal(cleanTerminalText("a\u0008b"), "b");
});

test("splitIncompleteEscape holds back a sequence that has not finished arriving", () => {
  const [complete, tail] = splitIncompleteEscape("ok \u001b[3");
  assert.equal(complete, "ok ");
  assert.equal(tail, "\u001b[3");
  // A complete sequence is not held back.
  assert.deepEqual(splitIncompleteEscape("ok \u001b[31mred"), ["ok \u001b[31mred", ""]);
});

test("a shell keeps its cwd and its exported variables between commands", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    const start = term.cwd;
    const cd = await term.run("cd /tmp && pwd");
    assert.equal(cd.exitCode, 0);
    assert.equal(cd.output.trim(), "/tmp");
    assert.equal(cd.cwd, "/tmp", "the terminal reports where the shell now is");
    assert.equal(term.cwd, "/tmp");

    // Second call: no `cd`, still /tmp. This is the whole feature.
    assert.equal((await term.run("pwd")).output.trim(), "/tmp");

    await term.run("export SC_TEST_VAR=kept");
    assert.equal((await term.run("echo $SC_TEST_VAR")).output.trim(), "kept");
    assert.notEqual(term.cwd, start);
  } finally {
    term.kill();
  }
});

test("stdout and stderr arrive on one stream, in the order the shell printed them", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    const res = await term.run("echo one; echo two >&2; echo three");
    assert.equal(res.output, "one\ntwo\nthree\n");
    assert.equal(res.exitCode, 0);
  } finally {
    term.kill();
  }
});

test("our own sentinel never reaches the transcript, even when a program echoes it", () => {
  // `cat` echoes whatever it reads; the marker line must not be shown as output.
  const echoed = "printf '\\n__sc:%s:%d\\t%s\\n' 'abc123' \"$?\" \"$PWD\"\nreal output\n";
  assert.equal(stripProtocol(echoed), "real output\n");
  // A stale marker that nobody is waiting for is dropped too.
  assert.equal(stripProtocol("__sc:abc123def:0\t/tmp\nok\n"), "ok\n");
  assert.equal(stripProtocol("plain output\n"), "plain output\n");
});

test("the marker is found whether or not its leading newline arrived in the same chunk", () => {
  // The bug this pins: a chunk boundary between "\n" and "__sc:" lost the
  // sentinel, so the command answered "still running" for its whole wait.
  const whole = "out\n__sc:tok123:0\t/tmp\n";
  assert.deepEqual(findMarker(whole, "tok123"), { at: 4, bodyStart: 16, end: 22 });
  assert.deepEqual(findMarker("__sc:tok123:0\t/tmp\n", "tok123"), { at: 0, bodyStart: 12, end: 18 });
  // Incomplete ⇒ not a marker yet; it must stay hidden, not be printed.
  assert.equal(findMarker("__sc:tok123:0\t/tmp", "tok123"), null);
  assert.equal(findMarker("out\n__sc:tok1", "tok123"), null);
  // A different command's marker is not ours.
  assert.equal(findMarker("__sc:other:0\t/tmp\n", "tok123"), null);

  // The marker's own leading newline is not part of the transcript.
  assert.equal(visibleBeforeMarker("hello\n__sc:tok123:0", "tok123"), 5);
  assert.equal(visibleBeforeMarker("__sc:tok123:0", "tok123"), 0);
  assert.equal(visibleBeforeMarker("__s", "tok123"), 0, "a half-written marker is never printed");
  assert.equal(visibleBeforeMarker("hello\n", "tok123"), 6);
});

test("a program that reads stdin cannot wedge the terminal", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    // `cat` swallows the sentinel and waits for input: the call answers "running".
    const res = await term.run("cat", 700);
    assert.equal(res.running, true);
    assert.equal(term.busy, true);
    // Ctrl-C re-arms the sentinel, so the shell comes back instead of staying busy.
    const int = await term.interrupt();
    assert.equal(int.restarted, false);
    assert.equal(int.resynced, true);
    assert.equal(term.busy, false);
    assert.equal((await term.run("echo recovered")).output.trim(), "recovered");
    assert.doesNotMatch(term.output().text, /__sc:/, "the protocol never leaks into the transcript");
  } finally {
    term.kill();
  }
});

test("the exit code is the command's, not the shell's", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    assert.equal((await term.run("true")).exitCode, 0);
    assert.equal((await term.run("false")).exitCode, 1);
    assert.equal((await term.run("exit_code_42() { return 42; }; exit_code_42")).exitCode, 42);
    // A failing command does not take the shell down.
    assert.equal((await term.run("echo still-here")).output.trim(), "still-here");
  } finally {
    term.kill();
  }
});

test("output is cleaned server-side — the panel is text, never ANSI", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    const res = await term.run("printf '\\033[31mred\\033[0m\\n'; printf '\\033]0;title\\007after\\n'");
    assert.equal(res.output, "red\nafter\n");
  } finally {
    term.kill();
  }
});

test("output streams live: an `output` event carries what the command prints", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    const seen = [];
    term.on("output", (p) => seen.push(p.text));
    await term.run("echo live-line");
    await until(() => seen.join("").includes("live-line"));
    assert.match(seen.join(""), /live-line/);
  } finally {
    term.kill();
  }
});

test("a command that outlives waitMs answers `running` and can still be read and interrupted", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    const started = Date.now();
    const res = await term.run("echo begin; sleep 30; echo never", 600);
    assert.equal(res.running, true, "the caller stops waiting");
    assert.equal(res.exitCode, null);
    assert.ok(Date.now() - started < 5000, "it answered at the wait, not at the sleep");
    assert.match(res.output, /begin/);
    assert.equal(term.busy, true);
    assert.match(term.tail(20), /begin/);

    // A second command is refused rather than interleaving both outputs.
    const busy = await term.run("echo while-busy");
    assert.match(busy.output, /\[terminal\] busy/);

    const int = await term.interrupt();
    assert.ok(int.killed >= 1, "the sleep was signalled");
    assert.equal(int.restarted, false);
    // The shell itself survives: this is the difference from kill.
    await until(() => !term.busy);
    assert.equal((await term.run("echo alive")).output.trim(), "alive");
  } finally {
    term.kill();
  }
});

test("interrupt signals the command's children, never the shell's process group", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    await term.run("sleep 30", 400);
    const kids = descendants(term.pid);
    assert.ok(kids.length >= 1, "the sleep is a child of the shell");
    await term.interrupt();
    await until(() => !term.busy);
    assert.equal((await term.run("pwd")).exitCode, 0, "the shell is still answering");
    assert.equal(term.status, "idle");
  } finally {
    term.kill();
  }
});

test("`exit` in the shell is reported, and restart brings the same terminal back", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  try {
    const res = await term.run("exit 7");
    assert.equal(res.shellExited, true);
    assert.equal(res.exitCode, 7);
    assert.equal(term.status, "exited");
    // A dead shell is an answer, not a hang.
    const dead = await term.run("echo nope");
    assert.match(dead.output, /shell is gone/);
    term.restart();
    assert.equal(term.status, "idle");
    assert.equal((await term.run("echo back")).output.trim(), "back");
  } finally {
    term.kill();
  }
});

test("kill ends a running command and the shell; the terminal is inert afterwards", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp() });
  await term.run("sleep 30", 300);
  term.kill();
  assert.equal(term.status, "exited");
  assert.equal(term.busy, false);
  const after = await term.run("echo nope");
  assert.match(after.output, /shell is gone/);
});

test("the scrollback ring is capped and `output(since)` answers with the sequence", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp(), scrollbackKb: 8 });
  try {
    const before = term.output().seq;
    await term.run("yes 0123456789 | head -c 40000 > /dev/null; echo done");
    assert.ok(term.bytes <= 8 * 1024 + 64, `ring stayed around 8 KB (was ${term.bytes})`);
    const all = term.output();
    assert.ok(all.seq > before);
    // Nothing new since the last sequence: an empty answer, not a re-send.
    assert.deepEqual(term.output(all.seq), { text: "", seq: all.seq });
  } finally {
    term.kill();
  }
});

test("resizeRing keeps the newest bytes after a config change", async () => {
  const term = new Terminal({ id: "t1", cwd: tmp(), scrollbackKb: 64 });
  try {
    await term.run("seq 1 4000");
    assert.ok(term.bytes > 8 * 1024);
    term.resizeRing(8);
    assert.ok(term.bytes <= 8 * 1024 + 64);
    assert.match(term.tail(2), /4000/, "the newest lines survive");
  } finally {
    term.kill();
  }
});

test("TerminalManager: create/list/get/require/max/default-per-session/kill/stop", async () => {
  const mgr = new TerminalManager({ max: 3, scrollbackKb: 16, waitMs: 5000 });
  try {
    const a = mgr.create({ name: "build", cwd: tmp() });
    const b = mgr.create({ cwd: tmp() });
    assert.equal(mgr.size, 2);
    assert.equal(a.name, "build");
    assert.equal(b.name, b.id, "an unnamed terminal is named after its id");
    assert.equal(mgr.get(a.id), a);
    assert.throws(() => mgr.require("nope"), /no terminal "nope"/);

    const list = mgr.list();
    assert.deepEqual(list.map((t) => t.id), [a.id, b.id]);
    assert.ok(list.every((t) => typeof t.cwd === "string" && t.status === "idle"));

    // A session gets the same terminal back until it is killed.
    const d1 = mgr.defaultFor("main:main", tmp());
    assert.equal(mgr.defaultFor("main:main", tmp()), d1);
    assert.equal(mgr.defaultId("main:main"), d1.id);

    // The limit is an answer with the way out, not a crash.
    assert.throws(() => mgr.create({ cwd: tmp() }), /terminal limit reached \(3 open\) — kill one first: t1, t2, t3/);

    assert.equal(mgr.kill(b.id), true);
    assert.equal(mgr.get(b.id), undefined);
    assert.equal(mgr.kill(b.id), false);
  } finally {
    mgr.stop();
  }
  assert.equal(mgr.size, 0, "stop() reaps every shell");
});

test("TerminalManager emits created/state/output/removed for the UI bus", async () => {
  const mgr = new TerminalManager({ max: 2, scrollbackKb: 16, waitMs: 5000 });
  const events = [];
  mgr.onEvent((p) => events.push(p));
  try {
    const term = mgr.create({ cwd: tmp() });
    await term.run("echo hello-panel");
    await until(() => events.some((e) => e.kind === "output" && e.id === term.id && /hello-panel/.test(e.text)));
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("created"));
    assert.ok(kinds.includes("state"));
    assert.ok(kinds.includes("output"));
    const out = events.find((e) => e.kind === "output");
    assert.equal(typeof out.seq, "number");
    assert.equal(out.cwd, term.cwd);
    mgr.kill(term.id);
    assert.ok(events.some((e) => e.kind === "removed" && e.id === term.id));
  } finally {
    mgr.stop();
  }
});

test("configure() moves the limits without killing open shells", async () => {
  const mgr = new TerminalManager({ max: 3, scrollbackKb: 64, waitMs: 5000 });
  try {
    const term = mgr.create({ cwd: tmp() });
    mgr.configure({ max: 1, waitMs: 2000, scrollbackKb: 8 });
    assert.equal(mgr.max, 1);
    assert.equal(mgr.defaultWaitMs, 2000);
    // Shrinking below what is open never closes a terminal in use…
    assert.equal((await term.run("echo kept")).output.trim(), "kept");
    // …it only refuses new ones.
    assert.throws(() => mgr.create({ cwd: tmp() }), /terminal limit reached \(1 open\)/);
  } finally {
    mgr.stop();
  }
});

test("the module's defaults match the documented contract", () => {
  assert.equal(TERMINAL_DEFAULTS.max, 8);
  assert.equal(TERMINAL_DEFAULTS.scrollbackKb, 200);
  assert.equal(TERMINAL_DEFAULTS.waitMs, 60_000);
  assert.equal(TERMINAL_DEFAULTS.maxWaitMs, 1_800_000);
  assert.match(findTerminalShell(), /\/(ba|z|da)?sh$/, "a real POSIX shell is found");
});
