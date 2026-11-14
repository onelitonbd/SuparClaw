// P2 #12 — sc logs helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseLogLine, filterLogLines, readLogTail, readLogDelta } = await import("../dist/lib.js");

test("parseLogLine reads the createLogger format, keeps陌生 lines raw", () => {
  assert.deepEqual(parseLogLine("03:41:02.750 ERROR [loop] run failed: boom"), {
    ts: "03:41:02.750", level: "ERROR", message: "[loop] run failed: boom", raw: "03:41:02.750 ERROR [loop] run failed: boom",
  });
  const plain = parseLogLine("plain line without format");
  assert.equal(plain.ts, null);
  assert.equal(plain.message, "plain line without format");
});

test("filterLogLines is a case-insensitive substring match", () => {
  const lines = ["INFO cron armed", "ERROR run failed: BOOM", "plain"];
  assert.deepEqual(filterLogLines(lines, "cron"), ["INFO cron armed"]);
  assert.deepEqual(filterLogLines(lines, "boom"), ["ERROR run failed: BOOM"]);
  assert.deepEqual(filterLogLines(lines, ""), lines, "empty search passes everything");
});

test("readLogTail bounds history; readLogDelta streams appended bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-logs-"));
  const p = join(dir, "service.log");
  writeFileSync(p, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  assert.deepEqual(readLogTail(p, 3), ["line 98", "line 99", "line 100"]);
  // Follow: new bytes since the end, cursor advances.
  const endBefore = 229 * 1 + 0; // size changes below; compute from delta directly
  const stat = readLogDelta(p, 0);
  assert.equal(stat.lines.length, 100, "delta from 0 reads the whole file");
  appendFileSync(p, "line 101\nline 102\n");
  const delta = readLogDelta(p, stat.offset);
  assert.deepEqual(delta.lines, ["line 101", "line 102"]);
  // Append a PARTIAL line (no trailing newline): it must be held for next time.
  appendFileSync(p, "line 103 (partial");
  const partial = readLogDelta(p, delta.offset);
  assert.deepEqual(partial.lines, [], "unfinished line not emitted yet");
  appendFileSync(p, " done)\n");
  const rest = readLogDelta(p, partial.offset);
  assert.deepEqual(rest.lines, ["line 103 (partial done)"], "the partial line completes on the next read");
  void endBefore;
});

test("readLogDelta after truncation restarts the cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-logs-"));
  const p = join(dir, "service.log");
  writeFileSync(p, "x".repeat(200) + "\n");
  const { offset } = readLogDelta(p, 0);
  writeFileSync(p, "short\n");
  const delta = readLogDelta(p, offset);
  assert.equal(delta.offset, 0, "reset on truncate");
});
