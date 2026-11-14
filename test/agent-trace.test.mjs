import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

import {
  AgentTrace,
  applyEvent,
  countSteps,
  createState,
  formatDuration,
  operationSummary,
} from "../ui/src/trace/agent-trace.js";

const run = (events) => events.reduce(applyEvent, createState("r1", 1000));

const tool = (id, name, extra = {}) => ({
  type: "tool_start",
  stepId: id,
  tool: name,
  label: `Do ${name}`,
  icon: name,
  input: {},
  ts: 1000,
  ...extra,
});

test("formatDuration matches the transcript format", () => {
  assert.equal(formatDuration(800), "0.8s");
  assert.equal(formatDuration(4100), "4.1s");
  assert.equal(formatDuration(34_000), "34s");
  assert.equal(formatDuration(72_000), "1m 12s");
  assert.equal(formatDuration(120_000), "2m");
});

test("consecutive same-tool calls group; an interleaved step splits the group", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("a", "web_search"),
    tool("b", "web_search"),
    { type: "thinking_start", stepId: "t", ts: 2000 },
    { type: "thinking_end", stepId: "t", ts: 2500 },
    tool("c", "web_search"),
  ]);
  const tools = state.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].calls.length, 2);
  assert.equal(tools[1].calls.length, 1);
});

test("explicit groupId groups different tools; a different groupId splits", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("a", "web_search", { groupId: "research" }),
    tool("b", "web_fetch", { groupId: "research" }),
    tool("c", "web_fetch", { groupId: "other" }),
  ]);
  const tools = state.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].calls.length, 2);
  assert.equal(tools[1].calls.length, 1);
});

test("a retried call is one row with the retry note, not two steps", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("x", "exec"),
    { type: "tool_error", stepId: "x", message: "timeout", willRetry: true, ts: 2000 },
    { type: "tool_end", stepId: "x", output: { ok: true }, ts: 5000, retried: true, retryNote: "timed out after 20s" },
  ]);
  const tools = state.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].calls.length, 1);
  assert.equal(tools[0].status, "done");
  assert.equal(tools[0].retried, true);
  assert.equal(tools[0].retryNote, "timed out after 20s");
  assert.equal(countSteps(state), 1);
});

test("a failed-then-succeeded call is retried even without the explicit flag", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("x", "exec"),
    { type: "tool_error", stepId: "x", message: "timeout", willRetry: true, ts: 2000 },
    { type: "tool_end", stepId: "x", output: { ok: true }, ts: 5000 },
  ]);
  const [item] = state.items.filter((i) => i.kind === "tool");
  assert.equal(item.retried, true);
  assert.equal(item.status, "done");
});

test("tool_end without an outcome is called out, not assumed successful", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("x", "fs_read"),
    { type: "tool_end", stepId: "x", output: { partial: true }, outcome: "unknown", ts: 2000 },
  ]);
  const [item] = state.items.filter((i) => i.kind === "tool");
  assert.equal(item.calls[0].outcome, "unknown");
});

test("final message becomes the answer, not a trace step", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    { type: "message_delta", stepId: "m", text: "Found the file. ", ts: 1500 },
    { type: "message_delta", stepId: "m", text: "Revenue grew 12%.", final: true, ts: 2000 },
  ]);
  assert.equal(state.finalAnswer, "Found the file. Revenue grew 12%.");
  assert.equal(state.items.some((i) => i.kind === "message"), false);
});

test("operation summary is kind-aware, not a file claim", () => {
  const state = run([
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("a", "fs_read"),
    tool("b", "fs_read"),
    tool("c", "web_search"),
    tool("d", "web_search"),
    tool("e", "web_search"),
    tool("f", "fs_write"),
  ]);
  assert.equal(operationSummary(state), "3 searches · 2 reads · 1 write");
});

test("completed run renders a Worked for header, collapses, and expands from the header", async () => {
  const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const root = document.getElementById("root");
  const trace = new AgentTrace(root);
  trace.push({ type: "run_start", runId: "r1", ts: 1000 });
  trace.push(tool("a", "fs_read", { icon: "file", label: "Read q3-report.pdf" }));
  trace.push({ type: "tool_end", stepId: "a", output: { pages: 12 }, meta: "12 pages", ts: 4000 });
  trace.push({ type: "message_delta", stepId: "answer", text: "Done.", final: true, ts: 8000 });
  trace.push({ type: "run_end", ts: 39_000, status: "done" });

  assert.equal(trace.el.querySelector("[data-title]").textContent, "Worked for 38s");
  assert.match(trace.el.querySelector("[data-sub]").textContent, /1 step · 1 read/);
  assert.equal(trace.header.getAttribute("aria-expanded"), "true");

  await new Promise((r) => setTimeout(r, 460));
  assert.equal(trace.expanded, false);
  assert.equal(trace.header.getAttribute("aria-expanded"), "false");
  // Interim messages fold away in the collapsed view (CSS rule, class state).
  assert.equal(trace.el.classList.contains("agent-trace--expanded"), false);

  trace.header.dispatchEvent(new document.defaultView.Event("click"));
  assert.equal(trace.expanded, true);
  assert.equal(trace.header.getAttribute("aria-expanded"), "true");
  trace.destroy();
});

test("a run with no tools or thinking renders no trace card", () => {
  const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const root = document.getElementById("root");
  const trace = new AgentTrace(root);
  trace.push({ type: "run_start", runId: "r1", ts: 1000 });
  trace.push({ type: "message_delta", stepId: "answer", text: "Just an answer.", final: true, ts: 2000 });
  trace.push({ type: "run_end", ts: 3000, status: "done" });
  assert.equal(trace.card.hidden, true);
  assert.equal(trace.finalEl.textContent, "Just an answer.");
  trace.destroy();
});

test("raw JSON stays hidden until explicitly opened; tool label is human", () => {
  const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const root = document.getElementById("root");
  const trace = new AgentTrace(root);
  trace.push({ type: "run_start", runId: "r1", ts: 1000 });
  trace.push(tool("a", "fs_read", { label: "Read q3-report.pdf", icon: "file" }));
  trace.push({ type: "tool_end", stepId: "a", output: { pages: 12 }, ts: 2000 });

  let row = trace.el.querySelector(".agent-trace__row--tool");
  assert.equal(row.textContent.includes("Read q3-report.pdf"), true);
  assert.equal(row.getAttribute("title"), "fs_read");
  row.dispatchEvent(new document.defaultView.Event("click"));
  assert.equal(trace.el.querySelector(".agent-trace__row--tool").getAttribute("aria-expanded"), "true");
  const raw = trace.el.querySelector(".agent-trace__raw");
  assert.ok(raw);
  assert.equal(raw.hidden, true);
  assert.equal(raw.textContent.includes('"pages": 12'), true);
  const toggle = trace.el.querySelector(".agent-trace__raw-toggle");
  toggle.dispatchEvent(new document.defaultView.Event("click"));
  assert.equal(trace.el.querySelector(".agent-trace__raw").hidden, false);
  trace.destroy();
});

test("interrupted runs stay expanded with a Stopped after header", () => {
  const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const trace = new AgentTrace(document.getElementById("root"));
  trace.push({ type: "run_start", runId: "r1", ts: 1000 });
  trace.push(tool("a", "exec"));
  trace.push({ type: "run_end", ts: 22_000, status: "stopped" });
  assert.equal(trace.expanded, true);
  assert.match(trace.el.querySelector("[data-title]").textContent, /Stopped after 21s · 1 step/);
  assert.equal(trace.el.classList.contains("agent-trace--stopped"), true);
  trace.destroy();
});

test("replay rebuilds the same state from a persisted log", () => {
  const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const events = [
    { type: "run_start", runId: "r1", ts: 1000 },
    tool("a", "web_search"),
    { type: "tool_end", stepId: "a", output: { results: 5 }, meta: "5 results", ts: 5100 },
    { type: "message_delta", stepId: "answer", text: "Answer.", final: true, ts: 6000 },
    { type: "run_end", ts: 7000, status: "done" },
  ];
  const live = run(events);
  const trace = new AgentTrace(document.getElementById("root"));
  trace.replay(events);
  assert.deepEqual(
    { status: trace.state.status, items: countSteps(trace.state), final: trace.state.finalAnswer },
    { status: live.status, items: countSteps(live), final: live.finalAnswer },
  );
  assert.equal(trace.expanded, false);
  trace.destroy();
});

test("concurrent groups keep independent state (multiple runs use separate instances)", () => {
  const { document } = parseHTML("<html><body><div id='r1'></div><div id='r2'></div></body></html>");
  const a = new AgentTrace(document.getElementById("r1"));
  const b = new AgentTrace(document.getElementById("r2"));
  a.push({ type: "run_start", runId: "a", ts: 1000 });
  b.push({ type: "run_start", runId: "b", ts: 1100 });
  a.push(tool("x", "fs_read"));
  b.push(tool("y", "web_search"));
  assert.equal(a.state.items.length, 1);
  assert.equal(b.state.items.length, 1);
  assert.notEqual(a.state.items[0].tool, b.state.items[0].tool);
  a.destroy();
  b.destroy();
});
