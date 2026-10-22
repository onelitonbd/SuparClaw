// P2 #10 — unattended exec policy.
import { test } from "node:test";
import assert from "node:assert/strict";

const { unattendedDecision, emptyConfig } = await import("../dist/lib.js");

function askVerdict(overrides = {}) {
  return {
    decision: "ask",
    route: "direct",
    reason: "no policy entry",
    mode: "ask",
    askFallback: "deny",
    segments: [{ argv: ["cut", "-d:", "-f1", "/etc/passwd"], argv0: "cut", resolvedPath: "/usr/bin/cut", matched: "safe-bin" }],
    ops: [],
    mintable: false,
    command: "cut -d: -f1 /etc/passwd",
    ...overrides,
  };
}

test("deny: every ask auto-declines, loudly (default)", () => {
  const v = askVerdict();
  const d = unattendedDecision("deny", v);
  assert.equal(d.allowed, false);
  assert.match(d.audit, /unattended-policy=deny/);
});

test("allowlist: ALL segments safe-bin + direct route → auto-allow", () => {
  const d = unattendedDecision("allowlist", askVerdict());
  assert.equal(d.allowed, true);
  assert.match(d.audit, /auto-allowed \(1 safe-bin/);
});

test("allowlist: any non-safe segment declines the whole command", () => {
  const v = askVerdict({
    segments: [
      { argv: ["cut", "-c1"], argv0: "cut", resolvedPath: "/usr/bin/cut", matched: "safe-bin" },
      { argv: ["curl", "https://x"], argv0: "curl", resolvedPath: "/usr/bin/curl", matched: null },
    ],
    route: "shell",
    command: "cut -c1 file | curl https://x",
  });
  const d = unattendedDecision("allowlist", v);
  assert.equal(d.allowed, false);
  assert.match(d.audit, /not all segments are safe bins/);
});

test("all: auto-allows anything (audit names the trade)", () => {
  const d = unattendedDecision("all", askVerdict({ route: "shell", segments: [{ argv: ["bash", "-c", "rm -rf x"], argv0: "bash", resolvedPath: "", matched: null }] }));
  assert.equal(d.allowed, true);
  assert.match(d.audit, /unattended-policy=all → auto-allowed/);
});

test("schema default is deny (unattended never loosens silently)", () => {
  assert.equal(emptyConfig().tools.exec.unattended, "deny");
});
