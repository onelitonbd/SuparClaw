export type TraceEvent =
  | { type: "run_start"; runId: string; ts: number }
  | { type: "thinking_start"; stepId: string; ts: number }
  | { type: "thinking_delta"; stepId: string; text: string }
  | { type: "thinking_end"; stepId: string; ts: number }
  | { type: "message_delta"; stepId: string; text: string; final?: boolean }
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
    }
  | { type: "tool_error"; stepId: string; message: string; willRetry: boolean }
  | { type: "approval_request"; stepId: string; description: string }
  | { type: "run_end"; ts: number; status: "done" | "error" | "stopped" };
