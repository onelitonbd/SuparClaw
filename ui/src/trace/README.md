# Agent Trace Component

A calm, premium UI for rendering agent execution traces (thinking, tool calls, messages, approvals, final answer).

## Files
- `trace.css` - CSS tokens and styles
- `agent-trace.js` - Vanilla JS component (state/reducer/render/handlers)
- `types.ts` - TypeScript event model (shared with backend)

## Usage
```js
import { AgentTrace } from './ui/src/trace/agent-trace.js';

const trace = new AgentTrace(document.getElementById('root'));
trace.pushEvent({ type: 'run_start', runId: 'r1', ts: Date.now() });
// ... push events as they stream in
trace.pushEvent({ type: 'run_end', ts: Date.now(), status: 'done' });
trace.setFinalAnswer('<p>...</p>');
```

## Theming
Override CSS custom properties on `:root`:
```css
:root {
  --trace-accent: #2f5bea;
  --trace-surface: #ffffff;
  --trace-ink: #14161a;
  /* ... see trace.css for all tokens */
}
```

## Event model
See `types.ts` for the full event shape. Events can come from SSE/WebSocket.

## Demo
Open `ui/trace-demo/index.html` in a browser (or serve the repo) and click "Replay sample run".
