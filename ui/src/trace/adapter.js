// Maps the gateway's existing chat events onto Agent Trace wire events.
//
// The chat socket (see ui/src/main.ts → handleChatEvent) already streams:
//   start · delta · reasoning · tool · approval · question · final · error · idle
// This adapter turns the subset the trace card owns into the shared model, so
// the component can be dropped next to the existing transcript without a new
// server protocol. A backend that can emit TraceEvent directly should do that
// instead — this bridge is for the current gateway.

import { AgentTrace, formatValue } from "./agent-trace.js";

const TOOL_LABELS = {
  ask_user: "Asking you",
  config: "Updating config",
  cron: "Scheduling",
  exec: "Running command",
  fs_edit: "Editing file",
  fs_list: "Listing files",
  fs_read: "Reading file",
  fs_write: "Writing file",
  hooks: "Managing hooks",
  memory_append: "Saving memory",
  memory_search: "Searching memory",
  model: "Switching model",
  pdf: "Reading PDF",
  session_send: "Sending to session",
  sessions_spawn: "Spawning sub-agent",
  skill_list: "Listing skills",
  skill_read: "Reading skill",
  skill_save: "Saving skill",
  telegram: "Telegram action",
  web_fetch: "Fetching page",
  web_search: "Searching the web",
  workspace: "Workspace action",
};

/** Human label for a gateway tool call: purpose-first, tool-name fallback. */
export function toolLabel(name, detail) {
  const hint = typeof detail === "string" ? detail.trim() : "";
  if (hint) return hint.length > 90 ? `${hint.slice(0, 87)}…` : hint;
  return TOOL_LABELS[name] || String(name || "Tool");
}

/**
 * Create a trace bound to a conversation. Returns the component plus the
 * per-event handler; feed it the same `chat` payload main.ts receives.
 */
export function createGatewayTrace(root, opts = {}) {
  const trace = new AgentTrace(root, opts);
  let runId = null;
  let reasoningId = null;
  let answerStarted = false;
  let seq = 0;

  const ensureRun = () => {
    if (runId) return;
    runId = `run-${Date.now().toString(36)}-${++seq}`;
    trace.push({ type: "run_start", runId, ts: Date.now() });
  };

  const endReasoning = () => {
    if (!reasoningId) return;
    trace.push({ type: "thinking_end", stepId: reasoningId, ts: Date.now() });
    reasoningId = null;
  };

  return {
    trace,
    /**
     * @param {{type: string, [k: string]: unknown}} event gateway chat event
     */
    onChatEvent(event) {
      const ts = Date.now();
      switch (event.type) {
        case "start":
          runId = null;
          answerStarted = false;
          ensureRun();
          break;

        case "reasoning": {
          ensureRun();
          if (!reasoningId) {
            reasoningId = `reason-${ts}`;
            trace.push({ type: "thinking_start", stepId: reasoningId, ts });
          }
          trace.push({ type: "thinking_delta", stepId: reasoningId, text: String(event.text ?? "") });
          break;
        }

        case "tool": {
          ensureRun();
          endReasoning();
          const id = String(event.callId ?? `tool-${ts}-${++seq}`);
          const status = String(event.status ?? "running");
          const name = String(event.name ?? "tool");
          if (status === "running" || status === "pending") {
            trace.push({
              type: "tool_start",
              stepId: id,
              tool: name,
              label: toolLabel(name, event.detail),
              icon: name,
              input: event.detail ?? null,
              ts,
            });
          } else if (status === "error") {
            trace.push({ type: "tool_error", stepId: id, message: String(event.detail ?? "Tool failed"), willRetry: false, ts });
          } else {
            trace.push({
              type: "tool_end",
              stepId: id,
              output: event.detail ?? null,
              summary: typeof event.detail === "string" ? event.detail : undefined,
              meta: event.ms ? `${event.ms}ms` : undefined,
              ts,
            });
          }
          break;
        }

        case "approval":
          ensureRun();
          trace.push({
            type: "approval_request",
            stepId: String(event.callId ?? `approval-${++seq}`),
            description: `${toolLabel(String(event.tool ?? "tool"), undefined)}: ${formatValue(event.args)}`,
            ts,
          });
          break;

        case "final":
          endReasoning();
          ensureRun();
          trace.push({
            type: "message_delta",
            stepId: `answer-${runId}`,
            text: String(event.text ?? ""),
            final: true,
            ts,
          });
          trace.push({ type: "run_end", ts, status: "done" });
          answerStarted = true;
          runId = null;
          break;

        case "error":
          endReasoning();
          ensureRun();
          trace.push({ type: "run_end", ts, status: "error", message: String(event.message ?? "Run failed") });
          runId = null;
          break;

        case "idle":
          endReasoning();
          if (runId && !answerStarted) {
            trace.push({ type: "run_end", ts, status: "stopped" });
          }
          runId = null;
          break;

        default:
          break;
      }
    },
  };
}
