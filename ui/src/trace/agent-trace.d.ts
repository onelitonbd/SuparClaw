// Agent Trace — TypeScript declarations for the JavaScript component
// (agent-trace.js stays runtime-only; this file is what type-checking sees).
//
// The shared wire/state model lives in ./types.ts.

import type { TraceEvent, TraceState, TraceStatus } from "./types";

export type { TraceEvent, TraceState, TraceStatus };

export interface AgentTraceOptions {
  /** Element to scroll to the bottom/keep follow behavior on. */
  scrollRoot?: HTMLElement | null;
  /** Show the component's own "Jump to latest" button (chat owns one already). */
  jump?: boolean;
  /** User clicked Retry on a failed/interrupted run. */
  onRetry?: (state: TraceState) => void;
  /** Fired whenever the run status changes (running → done | error | stopped). */
  onStatus?: (status: TraceStatus) => void;
  /** Custom substitute for the polite live-region announcements. */
  announce?: (text: string) => void;
}

export class AgentTrace {
  readonly el: HTMLElement;
  constructor(root: HTMLElement, opts?: AgentTraceOptions);
  /** Feed one wire event (run_start, thinking_*, message_delta, tool_*, run_end, subagent_*). */
  push(event: TraceEvent): void;
  /** Rebuild from a persisted event log (page reload mid-run). */
  replay(events: TraceEvent[]): void;
  /** Rebuild from a serialized TraceState snapshot. */
  restore(snapshot: TraceState): void;
  getState(): TraceState;
  setFinalAnswer(content: string | Node): void;
  setExpanded(on: boolean, manual?: boolean): void;
  destroy(): void;
  scrollToLatest(): void;
}

export function applyEvent(state: TraceState, event: TraceEvent): TraceState;
export function createState(runId?: string, ts?: number): TraceState;
export function formatDuration(ms: number): string;
export function countSteps(state: TraceState): number;
export function operationSummary(state: TraceState): string;
/** Human-readable INPUT/OUTPUT (key: value prose), never raw JSON by default. */
export function formatValue(value: unknown): string;
/** Compact result table (signed +/- numbers) for a final answer. */
export function createResultTable(doc: Document, columns: string[], rows: Array<Array<string | number>>): HTMLTableElement;
/** File / attachment chip for a final answer. */
export function createFileChip(doc: Document, name: string, subtitle?: string, icon?: string): HTMLAnchorElement;

export default AgentTrace;
