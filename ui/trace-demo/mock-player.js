// Mock event player for Agent Trace demo
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function replaySample(trace) {
  const now = Date.now();
  trace.pushEvent({ type: "run_start", runId: "demo-run", ts: now });
  await sleep(400);

  // thinking
  trace.pushEvent({ type: "thinking_start", stepId: "t1", ts: Date.now() });
  await sleep(300);
  trace.pushEvent({ type: "thinking_delta", stepId: "t1", text: "I need to understand the request and gather relevant files." });
  await sleep(400);
  trace.pushEvent({ type: "thinking_delta", stepId: "t1", text: " Let me start by reading the key documents." });
  await sleep(600);
  trace.pushEvent({ type: "thinking_end", stepId: "t1", ts: Date.now() });
  await sleep(200);

  // read file
  trace.pushEvent({ type: "tool_start", stepId: "tool1", groupId: "fs", tool: "fs_read", label: "Read q3-report.pdf", icon: "file", input: { path: "q3-report.pdf" }, ts: Date.now() });
  await sleep(800);
  trace.pushEvent({ type: "tool_end", stepId: "tool1", output: { pages: 12 }, summary: "12 pages", meta: "12 pages", ts: Date.now() });
  await sleep(300);

  // interim message
  trace.pushEvent({ type: "message_delta", stepId: "m1", text: "Found the file, now checking...", final: false });
  await sleep(500);
  trace.pushEvent({ type: "message_delta", stepId: "m1", text: " Found the file, now checking... Searching for related data.", final: true });
  await sleep(400);

  // parallel searches
  trace.pushEvent({ type: "tool_start", stepId: "s1", groupId: "search", tool: "web_search", label: "Search the web", icon: "search", input: { q: "q3 revenue" }, ts: Date.now() });
  trace.pushEvent({ type: "tool_start", stepId: "s2", groupId: "search", tool: "web_search", label: "Search the web", icon: "search", input: { q: "competitor pricing" }, ts: Date.now() });
  trace.pushEvent({ type: "tool_start", stepId: "s3", groupId: "search", tool: "web_search", label: "Search the web", icon: "search", input: { q: "market trends" }, ts: Date.now() });
  await sleep(600);
  trace.pushEvent({ type: "tool_end", stepId: "s1", output: { count: 5 }, summary: '"q3 revenue" — 5 results', ts: Date.now() });
  await sleep(300);
  trace.pushEvent({ type: "tool_end", stepId: "s2", output: { count: 3 }, summary: '"competitor pricing" — 3 results', ts: Date.now() });
  await sleep(400);
  trace.pushEvent({ type: "tool_end", stepId: "s3", output: { count: 7 }, summary: '"market trends" — 7 results', ts: Date.now() });
  await sleep(500);

  // thinking again
  trace.pushEvent({ type: "thinking_start", stepId: "t2", ts: Date.now() });
  await sleep(400);
  trace.pushEvent({ type: "thinking_delta", stepId: "t2", text: "I have enough information. Let me analyze and write the summary." });
  await sleep(800);
  trace.pushEvent({ type: "thinking_end", stepId: "t2", ts: Date.now() });
  await sleep(300);

  // tool with retry
  trace.pushEvent({ type: "tool_start", stepId: "w1", groupId: "write", tool: "fs_write", label: "Write board-summary.docx", icon: "file", input: { path: "board-summary.docx" }, ts: Date.now() });
  await sleep(400);
  trace.pushEvent({ type: "tool_error", stepId: "w1", message: "Timeout", willRetry: true });
  await sleep(700);
  trace.pushEvent({ type: "tool_end", stepId: "w1", output: { ok: true }, summary: "board-summary.docx", meta: "1 file", ts: Date.now(), retried: true, retryNote: "First attempt timed out after 20s. Retried automatically and succeeded." });
  await sleep(400);

  trace.pushEvent({ type: "run_end", ts: Date.now(), status: "done" });

  trace.setFinalAnswer('<p>Here is the board summary based on the Q3 report and market research.</p><ul><li>Revenue grew 12% quarter over quarter</li><li>Market share increased in key regions</li><li>Recommendations included in the attached document</li></ul>');
}
