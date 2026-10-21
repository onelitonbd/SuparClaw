import { randomBytes } from "node:crypto";
import type { Store, SubagentRow } from "../state/db.js";
import type { Logger } from "../util/log.js";
import type { SuparClawConfig } from "../config/schema.js";
import type { AgentLoop, RunEvent, RunInput } from "./loop.js";
import type { SubagentCtl } from "./tools.js";

/**
 * Sub-agent lifecycle owner (OpenClaw's native subagent registry, adapted):
 * sessions_spawn / sessions_yield / subagents / session_send sit on top of this.
 *
 * - Children run in their own session (`subagent:<parent>:<rand>`), isolated by
 *   default; context "fork" copies the parent transcript in first.
 * - Completion is push-based: the result announces back into the parent session
 *   through the normal queue machinery (steers at boundaries if the parent is
 *   busy), so the requester reviews and continues.
 * - Concurrency is budgeted per spawning session (subagents.maxConcurrent),
 *   nesting is capped (subagents.maxDepth, default 1).
 */
export class Subagents implements SubagentCtl {
  /** Private notes from sessions_yield, delivered with the wake batch. */
  #yieldNotes = new Map<string, string>();

  constructor(
    private readonly deps: {
      store: Store;
      log: Logger;
      loop: AgentLoop;
      config: () => SuparClawConfig;
      /** Child run events for the Service to fan out to event subscribers. */
      emitChild: (sessionKey: string, event: RunEvent) => void;
    },
  ) {}

  #parentDepth(parentKey: string): number {
    if (!parentKey.startsWith("subagent:")) return 0;
    return this.deps.store.getSubagent(parentKey)?.depth ?? 1;
  }

  async spawn(
    parentKey: string,
    opts: {
      task: string;
      label?: string;
      taskName?: string;
      model?: string;
      thinking?: string;
      context?: "isolated" | "fork";
    },
  ): Promise<
    | { accepted: true; childSessionKey: string; runId: string; taskName: string; context: string; resolvedModel?: string }
    | { accepted: false; error: string }
  > {
    const cfg = this.deps.config().agents?.defaults?.subagents;
    const task = (opts.task ?? "").trim();
    if (!task) return { accepted: false, error: "task is required" };

    const taskName = opts.taskName?.trim() || `task_${randomBytes(3).toString("hex")}`;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(taskName)) {
      return { accepted: false, error: "taskName must match [a-z][a-z0-9_-]{0,63}" };
    }
    if (taskName === "last" || taskName === "all") {
      return { accepted: false, error: `"${taskName}" is a reserved target name` };
    }

    // Nesting cap: a child's children count one deeper than it.
    const maxDepth = cfg?.maxDepth ?? 1;
    const depth = this.#parentDepth(parentKey) + 1;
    if (depth > maxDepth) {
      return { accepted: false, error: `nesting cap reached (subagents.maxDepth ${maxDepth}); this child cannot spawn children` };
    }

    // Per-spawning-session concurrency budget.
    const maxConcurrent = cfg?.maxConcurrent ?? 8;
    const inUse = this.deps.loop.childSlotsInUse(parentKey);
    if (inUse >= maxConcurrent) {
      return { accepted: false, error: `sub-agent budget full for this session (${inUse}/${maxConcurrent} running)` };
    }

    const childSessionKey = `subagent:${parentKey}:${randomBytes(4).toString("hex")}`;
    const label = (opts.label ?? "").trim() || taskName;
    const runId = `sub-${randomBytes(6).toString("hex")}`;
    const context = opts.context === "fork" ? "fork" : "isolated";

    this.deps.store.ensureSession(childSessionKey);
    this.deps.store.registerSubagent({
      child_session_key: childSessionKey,
      parent_session_key: parentKey,
      run_id: runId,
      label,
      task,
      task_name: taskName,
      depth,
      status: "running",
      outcome: null,
      result_stats: null,
      delivery: "pending",
      spawned_at: Date.now(),
      ended_at: null,
    });

    // fork: branch the requester's transcript into the child BEFORE the task.
    if (context === "fork") {
      const parent = this.deps.store.getSessionByKey(parentKey);
      const child = this.deps.store.getSessionByKey(childSessionKey);
      if (parent && child) {
        let used = 0;
        const budget = 24_000;
        const rows = this.deps.store.recentMessages(parent.id, 40)
          .filter((r) => r.role === "user" || r.role === "assistant")
          .slice(-20);
        for (const row of rows) {
          if (used + row.content.length > budget) continue;
          this.deps.store.appendMessage(child.id, row.role, row.content, undefined);
          used += row.content.length;
        }
      }
    }

    const resolvedModel = opts.model?.trim() || cfg?.model?.trim() || undefined;
    const resolvedThinking = opts.thinking?.trim() || cfg?.thinking?.trim() || undefined;

    // Push-based start: never awaits the child turn — the completion announces
    // back through onRunFinished.
    void this.deps.loop
      .run({
        sessionKey: childSessionKey,
        text: task,
        runId,
        source: "subagent",
        model: resolvedModel,
        reasoning: resolvedThinking,
        subagent: { parentKey, label, taskName, depth },
        onEvent: (ev) => this.deps.emitChild(childSessionKey, ev),
      })
      .catch((err) => this.deps.log.error(`subagent run failed: ${(err as Error).message}`));

    this.deps.log.info(`subagent spawned: ${label} (${childSessionKey}) parent=${parentKey}`);
    return { accepted: true, childSessionKey, runId, taskName, context, resolvedModel };
  }

  /** Loop hook: a child turn settled — finish the registry row and announce. */
  onRunFinished(
    childSessionKey: string,
    info: {
      runId: string;
      status: "done" | "error" | "aborted";
      finalText: string;
      usage?: Record<string, number>;
      parentKey?: string;
      yieldedWait?: boolean;
    },
  ): void {
    const row = this.deps.store.getSubagent(childSessionKey);
    if (!row) return; // a non-registry session that merely shares the prefix
    const secs = Math.max(0, (Date.now() - row.spawned_at) / 1000);
    const toks = info.usage
      ? `~${Number(info.usage["total_tokens"] ?? Object.values(info.usage).reduce((a, b) => a + Number(b ?? 0), 0)).toLocaleString("en-US")} tok`
      : "";
    const stats = [info.status === "done" ? "ok" : info.status, `${secs.toFixed(1)}s`, toks].filter(Boolean).join(", ");
    this.deps.store.finishSubagent(childSessionKey, {
      status: info.status,
      outcome: (info.finalText ?? "").slice(0, 12_000),
      resultStats: stats,
    });

    const parentKey = info.parentKey ?? row.parent_session_key;
    this.#announce(parentKey, { ...row, status: info.status, outcome: (info.finalText ?? "").slice(0, 12_000), result_stats: stats });
  }

  /**
   * Announce the completion into the parent session through the normal queue
   * machinery (steers at boundaries while the parent is active). A parent that
   * yielded gets ONE wake with the whole outstanding batch.
   */
  #announce(parentKey: string, child: SubagentRow): void {
    const pending = this.deps.store.pendingSubagentDeliveries(parentKey);
    const yielding = this.deps.loop.clearYieldWait(parentKey);
    const batch = yielding && pending.length > 1 ? pending : [child];
    if (!pending.some((r) => r.child_session_key === child.child_session_key) && yielding) {
      // Already-delivered child re-entering (defensive): keep the batch honest.
      batch.push(child);
    }

    const note = this.#yieldNotes.get(parentKey);
    this.#yieldNotes.delete(parentKey);
    const lines: string[] = [];
    if (batch.length > 1) lines.push(`${batch.length} sub-agents completed:`);
    for (const r of batch) {
      lines.push(
        `Sub-agent "${r.label || r.task_name}" ${r.status === "done" ? "completed" : `ended (${r.status})`}` +
          (r.result_stats ? ` [${r.result_stats}]` : "") + `:\n${r.outcome || "(no result)"}`,
      );
    }
    const text = lines.join("\n\n") + (note ? `\n\n(private note from your previous turn: ${note})` : "");

    for (const r of batch) this.deps.store.markSubagentDelivered(r.child_session_key);

    // Internal framework input: goes through the same steering boundary as any
    // inbound message — the parent's queue policy decides steer vs followup.
    void this.deps.loop
      .run({
        sessionKey: parentKey,
        text,
        source: "subagent",
        internal: true,
        onEvent: (ev) => this.deps.emitChild(parentKey, ev),
      })
      .catch((err) => this.deps.log.error(`announce failed for ${parentKey}: ${(err as Error).message}`));
  }

  activeChildren(parentKey: string): { childSessionKey: string; label: string; task: string; status: string; runId: string }[] {
    return this.deps.store
      .subagentsFor(parentKey, { activeOnly: true })
      .map((r) => ({ childSessionKey: r.child_session_key, label: r.label || r.task_name, task: r.task, status: r.status, runId: r.run_id }));
  }

  recordYieldNote(parentKey: string, note: string): void {
    this.#yieldNotes.set(parentKey, note);
  }

  async send(
    targetKey: string,
    text: string,
    mode: "steer" | "followup" | "notify",
  ): Promise<{ ok: boolean; error?: string; detail?: string }> {
    if (!targetKey.trim()) return { ok: false, error: "sessionKey required" };
    const busy = this.deps.loop.isBusy(targetKey);
    if (mode === "steer" && !busy) {
      return { ok: false, error: "target session has no active run — use mode followup (their rule: steering an idle target is refused)" };
    }
    const wrapped =
      mode === "notify"
        ? `(context from another session — no reply required, keep for your next turn)\n${text}`
        : text;
    void this.deps.loop
      .run({ sessionKey: targetKey, text: wrapped, queueMode: mode === "steer" || mode === "notify" ? "steer" : "followup", internal: true, source: "subagent", onEvent: (ev) => this.deps.emitChild(targetKey, ev) })
      .catch((err) => this.deps.log.error(`session_send failed: ${(err as Error).message}`));
    return { ok: true, detail: mode === "steer" ? "steered into the active run" : mode === "notify" ? "queued as context for the next turn" : "queued as a followup turn" };
  }

  cancel(childSessionKey: string): boolean {
    return this.deps.loop.abort(childSessionKey);
  }

  /** Chat/UI list rows for a parent session. */
  list(parentKey: string, limit = 20): SubagentRow[] {
    return this.deps.store.subagentsFor(parentKey, { limit });
  }
}
