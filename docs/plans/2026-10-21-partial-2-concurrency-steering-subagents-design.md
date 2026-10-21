# Task 20 design — concurrency, queue steering & sub-agents (Partial #2 + Missing #2)

Goal: close the gap-tracker row **Partial #2 "Concurrency & steering infrastructure"**
(their: "queue steering + subagent lanes"; ours, before: "serialized runs +
fenced writes only") and **Missing #2 "Mid-run queue steering"** (ours, before:
"abort-then-rerun only"), with the full sub-agent delegation surface the user
chose in the scope question.

Sources: `docs/openclaw/concepts/{queue,queue-steering,parallel-specialist-lanes,subagent-yield-handoff}.md`,
`docs/openclaw/tools/{steer,subagents/**}.md`, `docs/openclaw/gateway/config-tools/sessions-and-subagents.md`.

## 1. Queue infrastructure (theirs: command queue + steering queue)

Per session the loop owns a **mailbox**: an active run + an ordered queue of
identified items `{runId, text, at, source, exclusive}`. Cross-session it owns a
**main lane** (global FIFO, capped concurrency) and a **background lane**
(cron / dream / subagent completions, capped by `subagents.maxConcurrent`).

Modes — what a message does while its session has an active run:

| mode | active-run behavior | later behavior |
|---|---|---|
| `steer` (default) | enters the run's steer inbox; drained at tool boundaries | n/a — ours always accepts steering |
| `followup` | nothing | runs as its own turn after the active turn |
| `collect` | nothing | non-exclusive queued items merge into ONE turn after the quiet window |
| `interrupt` | aborts the active run | newest message starts immediately |

Resolution order: per-session `/queue` override → `messages.queue.byChannel.<ch>`
→ `messages.queue.mode` → `steer`. Abandonment etc. from their durable-ingress
spec doesn't apply (our Telegram channel is fire-and-forget, not durable).

Steering boundary rules (adapted from queue-steering.md):

- A **running** tool call is never interrupted. Unstarted calls from the same
  assistant message wait one boundary check.
- When steers are waiting between calls of the same assistant message, the
  unstarted sequential tail is **skipped**: every skipped call receives a paired
  synthetic result `Skipped to process an incoming message.` plus paired
  start/end tool events (`status: "skipped"`), so the transcript stays
  structurally valid and the model sees the steer at the next model call.
- After a batch settles, steers are appended as `user` messages after the tool
  results, before the next LLM call; each steer is persisted in the transcript
  and emitted to the UI as a normal user row.
- `interrupt` keeps its own path (abort) — stopping work ≠ steering future work.

Options and overflow: `messages.queue.cap` (default 20), `cap` overflow governed
by `messages.queue.drop`: `summarize` (default — drop oldest, inject the compact
summary as a synthetic followup), `old` (drop oldest silently), `new` (reject
the newest, immediate refusal notice). Collect debounce `debounceMs` default 500.

Chat parity commands handled by the service command router (any surface):
`/queue <mode> [debounce:x cap:n drop:y]`, `/queue default|reset`,
`/followup <msg>`, `/steer <msg>` (alias `/tell`), `/stop`, `/subagents`.

Cancellation: `chat.abort{sessionKey, runId}` removes that queued item only
(terminal event); without `runId` it cancels queued work first, then aborts the
active run — their order.

## 2. Sub-agents (theirs: sessions_spawn / sessions_yield / subagents)

New tools registered by the loop (never handed to children at max depth):

- `sessions_spawn { task, label?, taskName?, model?, thinking?, context?:
  "isolated"|"fork", visible?: false, runTimeoutSeconds?: 0 }`
  → creates child session `subagent:<parentKey>:<8hex>`; depth = parent depth+1
  (hard cap `agents.defaults.subagents.maxDepth`, default 1 — orchestrators set
  it higher); returns `{accepted, childSessionKey, runId, taskName, context,
  resolvedModel}` immediately (push-based, never blocks the parent turn).
  `isolated` (default): fresh transcript. `fork`: copies the parent's recent
  user/assistant transcript into the child before the task (token cost note).
- `sessions_yield { message? }` → ends the parent turn without answering; when
  all announced children complete, the parent is woken with the completion
  batch as its next turn.
- `subagents { action?: "list", target? }` / `{ action: "cancel", target }` —
  list (or stop, incl. descendants) native children of this session tree.
- `session_send { sessionKey, text, mode?: steer|followup|notify }` — compact
  inter-session send (steer injects at the next boundary; followup queues a
  turn; notify queues context for the target's next turn).

Completion announce: a finished child persists its result (last assistant text,
≤12k chars, plus a stats line with tokens/duration) and its parent receives a
**wake turn** whose input text carries the completion. If the parent is active,
the completion goes through the same steering boundary as user input. The
transcript records the announcement with role `system`, rendered in the UI as a
muted center card (never sent to the model as history — the wake input text is
what the model actually reads).

Prompt support (subagents-yield-handoff parity, compact): parent turns get an
`Active Subagents` block (key, label, task, status, runId) plus
`Recently Completed Subagents` (last 8 within 30 min) in their system prompt.
Their hidden-vs-visible / ACP / cloud-placement / worktree / multi-agent-id /
thread-binding surfaces don't exist for us (single device, single agent,
no external harnesses) and are documented here as consciously out of scope;
`visible: true` spawns are accepted as ordinary labeled sessions.

Concurrency: per-spawning-session budget `agents.defaults.subagents.maxConcurrent`
(8) for children; the global background lane (cron, dream, announces) uses the
same budget; `agents.defaults.maxConcurrent` (default `max(8, cpu*4)`) caps the
main lane across sessions. All waits are FIFO, forever — no time limits.

Restart recovery (operations.md parity, compact): on boot, children still marked
`running` become `interrupted`; their undelivered results remain in the
`Child results awaiting delivery` prompt block for the parent's next turn. No
automatic model wake on boot (no surprise spend).

## 3. RPC + UI (Control UI parity)

WS methods: `queue.set`, `queue.status`, `subagents.list`, `subagents.cancel`;
`chat.send` gains optional `queueMode`; `chat.abort` gains optional `runId`.
Events: run events grow `queued`, `dequeued`, `steered`, `collect`, and tool
`status: "skipped"`, all broadcast on the session event stream.

Web UI (chat page): a **queued row** above the composer (each item with ✕,
parity with their "messages waiting appear above the composer"), a
**Subagents** chip in the chat header opening the Running/Finished panel with
Stop + Open, `system`-role center cards for announces, and a muted **skipped**
pill on skipped tool calls.

## 4. Config (new, all optional)

```json5
messages: { queue: { mode: "steer", cap: 20, drop: "summarize", debounceMs: 500, byChannel: {} } }
agents: { defaults: {
  maxConcurrent: 0,            // 0 → max(8, cpu parallelism * 4) like theirs
  subagents: { maxConcurrent: 8, model: "", thinking: "", maxDepth: 1,
               delegationMode: "inherit" }, // inherit → prefer in :main, suggest elsewhere
} }
```

`agents.defaults.queueMode` (legacy) keeps validating but is superseded by
`messages.queue.mode`; sessions may still override via `/queue`.

## 5. Tests

`test/queue.test.mjs`: followup order, steer injection mid-tool with synthetic
skipped results, collect batching (short debounce override), interrupt, cap
drop modes, queued-cancel semantics, byChannel resolution.
`test/subagents.test.mjs`: registry CRUD, spawn → child run → announce wake,
per-session budget, depth cap, yield wake batch, boot recovery marks
interrupted. Loop tested with a stub `LlmClient` and a real tmp sqlite store.
