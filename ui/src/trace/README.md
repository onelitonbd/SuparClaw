# Agent Trace

A stream-driven trace card for one assistant turn: thinking, tool calls,
commentary, sub-agents, and the final answer.

The visual model follows the "timeline rail" spec, and the behaviour follows
OpenClaw's chat transcript:

- **Live runs stay expanded.** The header shimmers the current step's
  human-readable label and ticks an elapsed timer.
- **Completed runs collapse** into one `Worked for 38s` disclosure with a step
  count and kind-aware operation counts (`2 reads · 3 searches · 1 write`).
  Commentary and thinking fold into the disclosure; the final answer stays
  visible below the card.
- **Tool rows are purpose-first**: `Read q3-report.pdf`, never
  `fs_read({...})`. The exact tool name is the row's `title`/screen-reader name.
- **A retried call is one row** with an amber `retried` badge and an explanatory
  note in its detail panel — the failed attempt is not a separate step.
- **Interrupted and failed runs stay expanded** so the partial trace remains
  inspectable. A failed run gets a calm Retry action.
- **`Outcome unknown`** is shown when a tool ended without a success/failure
  outcome (OpenClaw's rule: partial output alone does not finish a tool).

## Files

| File | Purpose |
| --- | --- |
| `agent-trace.js` | Reducer (`applyEvent`), state helpers, `AgentTrace` component, final-answer builders |
| `agent-trace.css` | Tokens + timeline-rail styles, dark-mode map, reduced motion |
| `types.ts` | Wire events + derived state, shared with the backend |
| `adapter.js` | Bridges the current gateway `chat` events to trace events |
| `../../trace-demo/index.html` | Standalone demo with a mock event player |

## Feed events

```js
import { AgentTrace } from "./agent-trace.js";

const trace = new AgentTrace(document.getElementById("turn"), {
  scrollRoot: document.getElementById("thread"), // enables follow + Jump to latest
  onRetry: () => gateway.request("chat.send", { sessionKey, text: "Retry" }),
  onStatus: (status) => composer.setBusy(status === "running" || status === "waiting"),
});

trace.push({ type: "run_start", runId: "r1", ts: Date.now() });
trace.push({ type: "thinking_start", stepId: "t1", ts: Date.now() });
trace.push({ type: "thinking_delta", stepId: "t1", text: "Reading the report first." });
trace.push({ type: "thinking_end", stepId: "t1", ts: Date.now() });
trace.push({
  type: "tool_start", stepId: "s1", groupId: "research",
  tool: "web_search", label: "Search “q3 revenue”", icon: "search",
  input: { query: "q3 revenue" }, ts: Date.now(),
});
trace.push({
  type: "tool_end", stepId: "s1", output: { results: 5 },
  summary: "“q3 revenue” — 5 results", meta: "5 results", ts: Date.now(),
});
trace.push({ type: "message_delta", stepId: "answer", text: "Revenue grew 12% QoQ.", final: true, ts: Date.now() });
trace.push({ type: "run_end", ts: Date.now(), status: "done" });
```

`message_delta { final: true }` becomes the final answer (it is not counted as a
step). Without `final`, it is interim commentary and folds away in the collapsed
view.

### Replay after reload

The reducer is DOM-free, so a persisted event log rebuilds the exact card:

```js
trace.replay(savedEvents);       // from the raw event log
trace.restore(savedTraceState);  // or from a serialized TraceState snapshot
```

The demo persists its log in `localStorage`: run a scenario, reload, and the
card is rebuilt mid-stream or completed.

## Themes

All tokens are CSS custom properties on `.agent-trace`, so theming does not
touch the host app and a single override restyles the whole card:

```css
.agent-trace {
  --accent: #2f5bea;
  --surface: #ffffff;
  --border: #e3e6eb;
  --rail: #dde0e6;
  --ink: #14161a;
  --muted: #5b6270;      /* 5.7:1 on #f6f7f9 */
  --success: #0f7b4f;    /* 5.0:1 on #e4f4ec */
  --warning: #7a4e00;    /* 7.2:1 on #fff1cc */
  --error: #b42318;
}
```

`html[data-theme-mode="dark"] .agent-trace` maps the same tokens to the app's
dark palette, so the component follows the existing theme switch.

## Accessibility

- Header and expandable rows are real `<button>` elements with `aria-expanded`;
  the header owns the body via `aria-controls`.
- A visually hidden `role="status" aria-live="polite"` region announces the
  current step (throttled), not every text delta.
- Status is never colour-only: icon + text (`retried`, `Outcome unknown`,
  `Run failed`, `Stopped after …`).
- Visible `:focus-visible` ring (2px accent, 2px offset).
- `prefers-reduced-motion` disables the shimmer, spinner rotation, slide-in,
  and height transition.
- Raw JSON is never shown by default; it sits behind “Show raw JSON” inside an
  expanded tool row.

## Demo

The demo is copied into the built UI by `npm run build`:

```
npm run build
# open http://127.0.0.1:<gateway-port>/trace-demo/index.html
```

It includes the required sample run (thinking → read file → interim commentary →
3 parallel searches → thinking → analysis that retries once → write file →
final answer), plus failure + retry, 60-step, and stop-mid-run
scenarios. Everything is driven by the same `push(event)` API; the mock player
lives in `ui/trace-demo/mock-player.js`.

To try it without a gateway:

```
npm run build && npx --yes http-server dist/ui -p 8799
# http://127.0.0.1:8799/trace-demo/index.html
```

### Wiring it into the chat

The existing socket already streams `start / reasoning / tool /
final / error`. `adapter.js` maps that stream onto trace events:

```js
import { createGatewayTrace } from "./trace/adapter.js";
const { trace, onChatEvent } = createGatewayTrace(turnEl, { scrollRoot: threadEl });
socket.on("chat", onChatEvent);   // one AgentTrace per turn, replayable after reload
```

Link `agent-trace.css` next to `styles.css` (the demo page does this directly).
