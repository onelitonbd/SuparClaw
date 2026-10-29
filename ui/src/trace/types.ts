// Agent Trace — shared event + state model.
//
// The same shapes are consumed by the browser component (agent-trace.js) and
// can be produced by the gateway when it streams a run. Events are the wire
// format; TraceState is the derived, render-ready snapshot (also serializable
// for reload recovery — replay the event log with `replay(events)` instead).

export type TraceStatus = "running" | "done" | "error" | "stopped";

export type TraceEvent =
  | { type: "run_start"; runId: string; ts: number }
  | { type: "thinking_start"; stepId: string; ts: number }
  | { type: "thinking_delta"; stepId: string; text: string }
  | { type: "thinking_end"; stepId: string; ts: number }
  | { type: "message_delta"; stepId: string; text: string; final?: boolean; ts?: number }
  | {
      type: "tool_start";
      stepId: string;
      groupId?: string;
      tool: string;
      label: string;
      icon: "file" | "search" | "code" | "doc" | string;
      input: unknown;
      ts: number;
    }
  | {
      type: "tool_end";
      stepId: string;
      output: unknown;
      summary?: string;
      meta?: string;
      ts: number;
      retried?: boolean;
      retryNote?: string;
      outcome?: "ok" | "error" | "unknown";
    }
  | { type: "tool_error"; stepId: string; message: string; willRetry: boolean; ts?: number }
  | { type: "run_end"; ts: number; status: "done" | "error" | "stopped"; message?: string }
  // Optional sub-agent / skill progress (the spec's nested group).
  | {
      type: "subagent_start";
      stepId: string;
      groupId?: string;
      label: string;
      icon?: string;
      ts: number;
    }
  | { type: "subagent_update"; stepId: string; label?: string; progress?: string; ts?: number }
  | { type: "subagent_end"; stepId: string; status: "done" | "error" | "stopped"; ts: number };

export type ToolCall = {
  id: string;
  tool: string;
  icon: string;
  label: string;
  input: unknown;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt: number | null;
  output?: unknown;
  summary?: string;
  meta?: string;
  retried?: boolean;
  retryNote?: string;
  error?: string | null;
  /** Set when an attempt failed; the next successful tool_end marks the call
   *  `retried` even if the backend omits the flag. */
  hadError?: boolean;
  outcome?: "ok" | "error" | "unknown";
  progress?: string;
};

type BaseItem = { id: string; startedAt: number; endedAt: number | null };

export type ThinkingItem = BaseItem & {
  kind: "thinking";
  status: "running" | "done";
  text: string;
};

export type MessageItem = BaseItem & {
  kind: "message";
  text: string;
};

export type ToolItem = BaseItem & {
  kind: "tool";
  groupId?: string;
  tool: string;
  icon: string;
  label: string;
  status: "running" | "done" | "error";
  calls: ToolCall[];
  retried?: boolean;
  retryNote?: string;
};

export type SubagentItem = BaseItem & {
  kind: "subagent";
  groupId?: string;
  label: string;
  icon: string;
  status: "running" | "done" | "error" | "stopped";
  progress?: string;
};

export type TraceItem = ThinkingItem | MessageItem | ToolItem | SubagentItem;

export type TraceState = {
  runId: string;
  status: TraceStatus;
  startedAt: number | null;
  endedAt: number | null;
  items: TraceItem[];
  finalAnswer: string | null;
  error: string | null;
};

/** What the demo / adapter hands the component. */
export type TraceFeed = {
  push(event: TraceEvent): void;
  replay(events: TraceEvent[]): void;
};
