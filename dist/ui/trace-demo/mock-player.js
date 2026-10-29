// Mock event player — no backend needed.
// Every player emits the same wire events the gateway would stream.

import { createFileChip, createResultTable } from "./agent-trace.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = 0;
export function stopReplay() {
  token += 1;
}

function player() {
  const my = ++token;
  const live = () => my === token;
  const wait = async (ms) => {
    await sleep(ms);
    return live();
  };
  return { live, wait };
}

/* ---------------------------------------------------------------- sample */

export async function replaySample(trace) {
  const p = player();
  const ts = () => Date.now();

  trace.push({ type: "run_start", runId: `demo-${token}`, ts: ts() });
  if (!(await p.wait(350))) return;

  trace.push({ type: "thinking_start", stepId: "t1", ts: ts() });
  if (!(await p.wait(250))) return;
  trace.push({
    type: "thinking_delta",
    stepId: "t1",
    text: "I should read the Q3 report first, then check how competitors positioned their numbers before writing the board summary.",
  });
  if (!(await p.wait(650))) return;
  trace.push({ type: "thinking_end", stepId: "t1", ts: ts() });
  if (!(await p.wait(150))) return;

  // 1. read a file
  trace.push({
    type: "tool_start",
    stepId: "read-1",
    tool: "fs_read",
    label: "Read q3-report.pdf",
    icon: "file",
    input: { path: "q3-report.pdf", pages: 12 },
    ts: ts(),
  });
  if (!(await p.wait(750))) return;
  trace.push({
    type: "tool_end",
    stepId: "read-1",
    output: { pages: 12, text: "Q3 revenue grew 12% quarter over quarter…" },
    summary: "12 pages",
    meta: "12 pages",
    ts: ts(),
  });
  if (!(await p.wait(250))) return;

  // 2. interim commentary
  trace.push({
    type: "message_delta",
    stepId: "m1",
    text: "Found the file. Checking how competitors described the same quarter…",
    ts: ts(),
  });
  if (!(await p.wait(600))) return;

  // 3. three parallel searches, one group
  for (const [id, q] of [
    ["s1", "q3 revenue growth"],
    ["s2", "competitor pricing changes"],
    ["s3", "enterprise market trends 2026"],
  ]) {
    trace.push({
      type: "tool_start",
      stepId: id,
      groupId: "research",
      tool: "web_search",
      label: `Search “${q}”`,
      icon: "search",
      input: { query: q },
      ts: ts(),
    });
  }
  if (!(await p.wait(650))) return;
  trace.push({
    type: "tool_end",
    stepId: "s1",
    output: { results: 5 },
    summary: "“q3 revenue growth” — 5 results",
    meta: "5 results",
    ts: ts(),
  });
  if (!(await p.wait(350))) return;
  trace.push({
    type: "tool_end",
    stepId: "s2",
    output: { results: 3 },
    summary: "“competitor pricing changes” — 3 results",
    meta: "3 results",
    ts: ts(),
  });
  if (!(await p.wait(420))) return;
  trace.push({
    type: "tool_end",
    stepId: "s3",
    output: { results: 7 },
    summary: "“enterprise market trends 2026” — 7 results",
    meta: "7 results",
    ts: ts(),
  });
  if (!(await p.wait(300))) return;

  // 4. thinking again
  trace.push({ type: "thinking_start", stepId: "t2", ts: ts() });
  if (!(await p.wait(500))) return;
  trace.push({
    type: "thinking_delta",
    stepId: "t2",
    text: "The numbers line up. I’ll write a short board summary and include the comparison table.",
  });
  if (!(await p.wait(900))) return;
  trace.push({ type: "thinking_end", stepId: "t2", ts: ts() });
  if (!(await p.wait(200))) return;

  // 5. analysis that fails once, then succeeds (one row + retried badge)
  trace.push({
    type: "tool_start",
    stepId: "analyze-1",
    tool: "exec",
    label: "Analyze revenue data",
    icon: "terminal",
    input: { command: "node scripts/analyze.mjs q3-report.pdf" },
    ts: ts(),
  });
  if (!(await p.wait(450))) return;
  trace.push({
    type: "tool_error",
    stepId: "analyze-1",
    message: "Timed out after 20s",
    willRetry: true,
    ts: ts(),
  });
  if (!(await p.wait(900))) return;
  trace.push({
    type: "tool_end",
    stepId: "analyze-1",
    output: { rows: 4, note: "12% QoQ revenue growth" },
    summary: "4 rows",
    meta: "4 rows",
    retried: true,
    retryNote: "First attempt timed out after 20s. Retried automatically and succeeded.",
    ts: ts(),
  });
  if (!(await p.wait(350))) return;

  // 6. write the deliverable
  trace.push({
    type: "tool_start",
    stepId: "write-1",
    tool: "fs_write",
    label: "Write board-summary.docx",
    icon: "write",
    input: { path: "board-summary.docx", format: "docx" },
    ts: ts(),
  });
  if (!(await p.wait(800))) return;
  trace.push({
    type: "tool_end",
    stepId: "write-1",
    output: { path: "board-summary.docx", bytes: 18432 },
    summary: "board-summary.docx",
    meta: "1 page",
    ts: ts(),
  });
  if (!(await p.wait(300))) return;

  // 7. final answer (streams in as one message with final:true)
  trace.push({
    type: "message_delta",
    stepId: "answer",
    text: "Q3 closed with revenue up 12% quarter over quarter. Enterprise demand held up and competitor pricing moved up-market, which gives us room to raise list prices without losing share.",
    final: true,
    ts: ts(),
  });
  if (!(await p.wait(200))) return;
  trace.push({ type: "run_end", ts: ts(), status: "done" });

  // Rich final answer: prose + compact table + attachment chip.
  const doc = trace.root.ownerDocument;
  const frag = doc.createDocumentFragment();
  const p1 = doc.createElement("p");
  p1.textContent =
    "Q3 closed with revenue up 12% quarter over quarter. Enterprise demand held up and competitor pricing moved up-market, which gives us room to raise list prices without losing share.";
  const table = createResultTable(
    doc,
    ["Metric", "Q3", "Change"],
    [
      ["Revenue", "48,200", 12],
      ["Gross margin", "71%", 3],
      ["Net new logos", "36", -4],
    ],
  );
  const p2 = doc.createElement("p");
  p2.textContent = "The full write-up is attached.";
  frag.append(p1, table, p2, createFileChip(doc, "board-summary.docx", "1 page · Word document", "write"));
  trace.setFinalAnswer(frag);
}

/* --------------------------------------------------------------- failure */

export function replayFailure(trace) {
  const ts = () => Date.now();
  trace.push({ type: "run_start", runId: `failure-${++token}`, ts: ts() });
  trace.push({ type: "thinking_start", stepId: "tf", ts: ts() });
  trace.push({ type: "thinking_delta", stepId: "tf", text: "Trying to fetch the pricing sheet." });
  trace.push({ type: "thinking_end", stepId: "tf", ts: ts() });
  trace.push({
    type: "tool_start",
    stepId: "fetch-fail",
    tool: "web_fetch",
    label: "Fetch pricing-sheet.xlsx",
    icon: "globe",
    input: { url: "https://internal.example/pricing-sheet.xlsx" },
    ts: ts(),
  });
  trace.push({
    type: "tool_error",
    stepId: "fetch-fail",
    message: "The host did not respond (connection timed out).",
    willRetry: false,
    ts: ts(),
  });
  trace.push({
    type: "run_end",
    ts: ts(),
    status: "error",
    message: "The host did not respond (connection timed out).",
  });
}

/* ---------------------------------------------------------------- long run */

export async function replayLongRun(trace) {
  const p = player();
  const ts = () => Date.now();
  trace.push({ type: "run_start", runId: `long-${token}`, ts: ts() });
  if (!(await p.wait(150))) return;
  trace.push({ type: "thinking_start", stepId: "tl", ts: ts() });
  trace.push({ type: "thinking_delta", stepId: "tl", text: "Sweeping the repository in three batches." });
  trace.push({ type: "thinking_end", stepId: "tl", ts: ts() });
  const tools = ["fs_read", "fs_read", "exec", "web_search", "fs_write", "fs_edit"];
  for (let i = 0; i < 60; i++) {
    const tool = tools[i % tools.length];
    const id = `long-${i}`;
    const groupId = `batch-${Math.floor(i / 3)}`;
    trace.push({
      type: "tool_start",
      stepId: id,
      groupId,
      tool,
      label:
        tool === "web_search"
          ? `Search “dependency advisory ${i}”`
          : tool === "exec"
            ? `Run check ${i}`
            : tool === "fs_write"
              ? `Write report-part-${i}.md`
              : tool === "fs_edit"
                ? `Edit report-part-${i}.md`
                : `Read module-${i}.ts`,
      icon: tool === "web_search" ? "search" : tool === "exec" ? "terminal" : tool === "fs_write" || tool === "fs_edit" ? "write" : "file",
      input: { step: i },
      ts: ts(),
    });
    if (!(await p.wait(45))) return;
    trace.push({
      type: "tool_end",
      stepId: id,
      output: { step: i },
      summary: `step ${i + 1} complete`,
      meta: tool === "web_search" ? "4 results" : "",
      ts: ts(),
    });
    if (!(await p.wait(25))) return;
  }
  trace.push({
    type: "message_delta",
    stepId: "answer-long",
    text: "Finished the sweep: 60 operations across 20 batches. No blocking issues found.",
    final: true,
    ts: ts(),
  });
  trace.push({ type: "run_end", ts: ts(), status: "done" });
}
