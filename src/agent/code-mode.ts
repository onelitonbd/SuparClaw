/**
 * P3 (row Missing!#23) — Code Mode sandboxed execution (their tools/code-mode
 * + guest-api contract, ported onto a Node executor):
 *
 *  - model-visible surface collapses to `exec` + `wait` (+ direct-only tools)
 *  - exec evaluates model-written JavaScript in a node:vm worker thread —
 *    SAME caveat as theirs: the Node executor is for trusted cells, not a
 *    security boundary (WSL2/QJS is their hardened tier, not bundled here)
 *  - every catalog-eligible enabled tool is hidden from the direct list and
 *    exposed inside the guest as an async global (NAME(args, extra?));
 *    catalog.search/describe give handle-shaped discovery; bridge calls ride
 *    the normal tool-run path — policy, approvals, hooks all still apply
 *  - JavaScript-only surface: shell-smelling code → invalid_input BEFORE
 *    guest execution (their pre-reject), dynamic import()/require also
 *    rejected with actionable guidance; `command` is their JS alias for code
 *  - outbound network disabled by omission (their default); floor APIs that
 *    proxy internal Gateway surfaces are refused via bridge
 *  - lifecycle: >=2s sync wait inside a 2-minute hard cap; otherwise the run
 *    detaches as {status:"waiting", runId}; `wait` resumes it; parent-turn
 *    abort and the hard cap both produce {status:"cancelled"} variants; error
 *    objects stitch {code:"<code>", error:"<code>", message, ...}
 *  - echo: the cell's source lands in session history as "// Code Mode\n" +
 *    code (their transparency rule)
 */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { ToolSpec } from "./tools.js";

export interface CodeModeConfig {
  /** false | true | "auto" (their activation: auto engages only for preferred models). */
  enabled: boolean | "auto";
  /** their "node"|"quickjs"; this build bundles node only — quickjs requests stop the run (their no-fallback rule). */
  executor: "node" | "quickjs";
  /** wall-clock budget per exec/wait call (their timeoutMs: default 10s, clamp 100–60_000). */
  timeoutMs: number;
  maxCodeChars: number;
  /** stdout cap per cell (their maxOutputBytes≈64Ki clamp, truncated honestly). */
  maxOutputBytes: number;
  /** nested calls in flight before the bridge refuses (their 16 default, 1–128). */
  maxPendingToolCalls: number;
  /** tool names that stay visible alongside exec/wait (their direct-only list). */
  directOnly: string[];
}

export const CODE_MODE_DEFAULTS: CodeModeConfig = {
  enabled: "auto",
  executor: "node",
  timeoutMs: 10000,
  maxCodeChars: 32768,
  maxOutputBytes: 65536,
  maxPendingToolCalls: 16,
  directOnly: [],
};

/** Their shipped "preferred" tiers (catalog flag compat.codeMode) — mirrored here as a static list until provider catalogs grow the metadata. */
const PREFERRED_MODELS = [
  /^openai\/gpt-5\.[56]/, /gpt-5\.[56]/,
  /^anthropic\/claude-(fable|opus)-5/, /claude-opus-5/, /claude-sonnet-5/, /claude-mythos-5/,
  /deepseek-v4-(pro|flash)/,
  /gemini-(4-argon|3-flash-preview|3\.1-pro-preview|3\.1-flash-lite|3\.5-flash|3\.6-flash|3\.7-flash|3\.8-flash)/,
  /^kimi\/k3/, /^(moonshot\/)?kimi-k3/,
  /^minimax\/MiniMax-M3/,
  /^zai\/glm-5\.[123]/,
  /^xiaomi\/mimo-v2\.6/,
];

/**
 * Activation resolution (their order, scaled): global false blocks, true
 * engages for tool-capable runs, "auto" engages only for preferred models.
 * (Per-agent/model overrides belong to their multi-agent surface; ours is
 * single-agent so the global value decides.)
 */
export function codeModeEngages(cfg: CodeModeConfig, model: string | undefined): boolean {
  if (cfg.enabled === false) return false;
  if (cfg.enabled === true) return true;
  const m = (model ?? "").toLowerCase();
  return PREFERRED_MODELS.some((re) => re.test(m));
}

export interface GuestTool {
  /** guest-visible global name (their final/collision-free names). */
  name: string;
  description: string;
  /** compact input hints for the bounded index { param: "type" }. */
  inputs: Record<string, string>;
  required: string[];
  run: (args: unknown, extra?: Record<string, unknown>) => Promise<unknown>;
}

export interface GuestError extends Record<string, unknown> {
  code: string;
  error: string;
  message: string;
}

export interface ExecCellResult {
  runId: string;
  status: "completed" | "error" | "waiting" | "cancelled";
  labels: Record<string, string>;
  value?: unknown;
  output?: string;
  error?: GuestError;
  streamedRange?: unknown;
  streamError?: null;
  children?: [];
}

function invalidInput(message: string): GuestError {
  return { code: "invalid_input", error: "invalid_input", message };
}

const SHELL_SMELLS = [
  /^\s*#!\/(usr\/)?bin\/(?:ba|z|fi)?sh\b/,
  /^\s*(?:sudo\s+)?(?:apt|brew|curl|wget|ssh|scp|git\s+clone|docker|kubectl)\b/m,
  /\n\s*(?:rm -rf|chmod \d|chown )/,
];

function looksLikeShell(code: string): boolean {
  return SHELL_SMELLS.some((re) => re.test(code));
}

// Worker source (eval'd: no extra packaged file). The guest gets exactly the
// declared tool globals + catalog + a stdout-forwarding console — nothing else.
const WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const vm = require("node:vm");

const { code, tools } = workerData;
const pending = new Map();

function bridge(name, args, extra) {
  const callId = "c" + ++bridge.n;
  const p = new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  parentPort.postMessage({ type: "call", callId, name, args: args ?? {}, extra: extra ?? {} });
  return p;
}
bridge.n = 0;

parentPort.on("message", (m) => {
  if (m.type === "resolve") {
    const t = pending.get(m.callId);
    if (t) { pending.delete(m.callId); t.resolve(m.value); }
  } else if (m.type === "reject") {
    const t = pending.get(m.callId);
    if (t) { pending.delete(m.callId); t.reject(Object.assign(new Error(m.error?.message ?? "tool error"), m.error)); }
  }
});

const ctx = {};
for (const name of tools) {
  // dotted names (catalog.search/catalog.describe) nest into objects
  const parts = name.split(".");
  let o = ctx;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = (args, extra) => bridge(name, args, extra);
}
ctx.console = {
  log: (...a) => parentPort.postMessage({ type: "stdout", text: a.map(String).join(" ") + "\n" }),
  warn: (...a) => parentPort.postMessage({ type: "stdout", text: a.map(String).join(" ") + "\n" }),
  error: (...a) => parentPort.postMessage({ type: "stdout", text: a.map(String).join(" ") + "\n" }),
};
ctx.globalThis = ctx;
const sandbox = vm.createContext(ctx, {
  importModuleDynamically: () => {
    const e = new Error("dynamic import() is not available in guest code (invalid_input)");
    e.name = "EvalError";
    throw e;
  },
});

(async () => {
  let script;
  try {
    script = new vm.Script("(async () => {\n" + code + "\n})()", { filename: "exec-cell.js" });
  } catch (err) {
    parentPort.postMessage({ type: "done", ok: false, error: String(err && err.message || err), name: err && err.name });
    return; // keeps the worker alive until parent terminates
  }
  try {
    const value = await script.runInContext(sandbox, { timeout: 60_000 });
    parentPort.postMessage({ type: "done", ok: true, value: value === undefined ? null : value });
  } catch (err) {
    parentPort.postMessage({ type: "done", ok: false, error: String(err && err.message || err), name: err && err.name });
  }
})();
`;

interface LiveCell {
  runId: string;
  labels: Record<string, string>;
  worker: Worker;
  stdout: string;
  /** the final result once the cell truly ends; null while still live. */
  final: ExecCellResult | null;
  onFinal: ((r: ExecCellResult) => void)[];
  /** host-side bridge calls still in flight (their nested-call suspension). */
  bridgeInflight: number;
  /** "done" arrived while bridges were open → cell is waiting on bridges. */
  earlyDetach: boolean;
  settledValue?: unknown;
  timer: NodeJS.Timeout;
  ended: boolean;
}

export class CodeMode {
  private live = new Map<string, LiveCell>();

  constructor(
    private readonly getTools: () => Map<string, GuestTool>,
    private readonly cfg: () => CodeModeConfig,
  ) {}

  catalogSearch(query: string): unknown {
    const q = query.trim().toLowerCase();
    const tools = [...this.getTools().values()];
    const hits = tools.filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    return {
      results: hits.slice(0, 20).map((t) => ({
        id: `handle:${t.name}`,
        kind: "tool",
        description: t.description.slice(0, 120),
        inputs: t.inputs,
        describe: `catalog.describe(${JSON.stringify(t.name)})`,
      })),
      shown: Math.min(20, hits.length),
      totalMatches: hits.length,
      exactNameMatches: 0,
      displayedNames: hits.slice(0, 20).map((t) => t.name),
    };
  }

  catalogDescribe(name: string): unknown {
    const t = this.getTools().get(name);
    if (!t) return { error: "not_found", name };
    return { kind: "tool", description: t.description, inputs: t.inputs, required: t.required, details: [] };
  }

  async execCell(code: string, title: string, signal?: AbortSignal): Promise<ExecCellResult> {
    const cfg = this.cfg();
    const runId = randomUUID();
    const labels = title ? { title } : {};
    if (cfg.executor === "quickjs") {
      // their no-fallback rule: an engaged run STOPS rather than silently
      // falling back to broad direct tools or another executor
      return { runId, status: "error", labels, error: { code: "executor_unavailable", error: "executor_unavailable", message: "quickjs executor is not bundled in this build (their no-fallback rule: the run stops instead of broad tool exposure)" } };
    }
    if (!code.trim()) {
      return { runId, status: "error", labels, error: invalidInput("empty code — exec evaluates JavaScript; `command` is their alias for code, not a shell string") };
    }
    if (code.length > cfg.maxCodeChars) {
      return { runId, status: "error", labels, error: invalidInput(`code is ${code.length} chars; cap is ${cfg.maxCodeChars} (their oversized-cell path)`) };
    }
    if (looksLikeShell(code)) {
      return { runId, status: "error", labels, error: invalidInput("this looks like a shell command — the guest surface is JavaScript; call a tool global instead (their pre-guest reject)") };
    }
    const hostTools = this.getTools();
    const guestNames = [...hostTools.keys(), "catalog.search", "catalog.describe"];
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { code, tools: guestNames } });
    const cell: LiveCell = {
      runId, labels, worker, stdout: "",
      final: null,
      onFinal: [],
      bridgeInflight: 0,
      earlyDetach: false,
      timer: null as unknown as NodeJS.Timeout,
      ended: false,
    };
    this.live.set(runId, cell);

    const completed = (r: ExecCellResult) => {
      if (cell.ended) return;
      cell.ended = true;
      if (cell.timer) clearTimeout(cell.timer);
      this.live.delete(runId);
      worker.terminate().catch(() => {});
      cell.final = r;
      for (const f of cell.onFinal) f(r);
      cell.onFinal.length = 0;
    };

    worker.on("message", (m: { type: string; callId?: string; name?: string; args?: unknown; extra?: Record<string, unknown>; ok?: boolean; value?: unknown; error?: string; text?: string }) => {
      if (cell.ended) return;
      if (m.type === "stdout") {
        if (cell.stdout.length < cfg.maxOutputBytes) {
          cell.stdout = (cell.stdout + String(m.text ?? "")).slice(0, cfg.maxOutputBytes); // their maxOutputBytes cap
        }
        return;
      }
      if (m.type === "call") {
        let run: (() => Promise<unknown>) | null = null;
        if (m.name === "catalog") {
          worker.postMessage({ type: "reject", callId: m.callId, error: { code: "invalid_input", error: "invalid_input", message: "catalog is catalog.search(...) / catalog.describe(...) — their catalog has no bare call" } });
          return;
        }
        if (m.name === "catalog.search" || m.name === "_codemode_search") {
          run = () => Promise.resolve(this.catalogSearch(String((m.args as Record<string, unknown>)?.query ?? "")));
        } else if (m.name === "catalog.describe") {
          run = () => Promise.resolve(this.catalogDescribe(String((m.args as Record<string, unknown>)?.name ?? "")));
        } else {
          const g = hostTools.get(m.name ?? "");
          if (g) run = () => g.run(m.args, m.extra);
        }
        if (!run) {
          worker.postMessage({ type: "reject", callId: m.callId, error: { code: "not_found", error: "not_found", message: `unknown guest global ${m.name} — use catalog.search(...) (their discovery rule)` } });
          return;
        }
        if (cell.bridgeInflight >= cfg.maxPendingToolCalls) {
          worker.postMessage({ type: "reject", callId: m.callId, error: { code: "too_many_pending", error: "too_many_pending", message: `${cfg.maxPendingToolCalls} tool calls already pending (their maxPendingToolCalls cap)` } });
          return;
        }
        cell.bridgeInflight += 1;
        run()
          .then((value) => { if (!cell.ended) worker.postMessage({ type: "resolve", callId: m.callId, value }); })
          .catch((err: Error & { code?: string }) => {
            if (!cell.ended) worker.postMessage({ type: "reject", callId: m.callId, error: { code: err.code ?? "tool_error", error: err.code ?? "tool_error", message: err.message } });
          })
          .finally(() => {
            cell.bridgeInflight -= 1;
            // last bridge drained after the cell already reported "done" → publish final
            if (cell.bridgeInflight === 0 && cell.settledValue !== undefined && !cell.ended) {
              completed({ runId, status: "completed", labels, value: cell.settledValue, output: cell.stdout || undefined, streamError: null });
            }
          });
        return;
      }
      if (m.type === "done") {
        if (m.ok) {
          cell.settledValue = m.value ?? null;
          // nested bridges may still be in flight → the outer caller detaches
          // as {status:"waiting"} (their suspended-run semantics)
          if (cell.bridgeInflight > 0) {
            cell.earlyDetach = true;
            return;
          }
          completed({ runId, status: "completed", labels, value: cell.settledValue ?? { valueFromCompletion: true }, output: cell.stdout || undefined, streamError: null });
        } else {
          completed({
            runId, status: "error", labels,
            error: {
              code: m.error === "EvalError" ? "invalid_input" : "exec_error",
              error: m.error === "EvalError" ? "invalid_input" : "exec_error",
              message: String(m.error ?? "cell failed"),
              stdout: cell.stdout || undefined,
            },
          });
        }
        return;
      }
    });
    worker.on("error", (err) => {
      completed({ runId, status: "error", labels, error: { code: "exec_error", error: "exec_error", message: err.message, stdout: cell.stdout || undefined } });
    });
    worker.on("exit", (code2) => {
      if (cell.ended) return;
      if (cell.settledValue !== undefined || cell.earlyDetach) {
        completed({ runId, status: "completed", labels, value: cell.settledValue ?? { valueFromCompletion: true }, output: cell.stdout || undefined, streamError: null });
      } else {
        completed({ runId, status: "error", labels, error: { code: "exec_error", error: "exec_error", message: `worker exited without a result (code ${code2})`, stdout: cell.stdout || undefined } });
      }
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        void this.end(runId, {
          runId, status: "cancelled", labels,
          error: { code: "cancelled", error: "cancelled", message: "aborted by the parent turn (their cancellation path)", stdout: cell.stdout || undefined },
        });
      }, { once: true });
    }

    // their wall-clock budget (default 10s, clamped 100–60_000). Bridges still
    // open when it lapses → waiting (a later wait resumes with a fresh budget);
    // guest computation that exhausts it fails with code "timeout" (theirs).
    const out = await this.awaitBudget(cell, cfg.timeoutMs);
    if (out === "tick") {
      if (cell.earlyDetach) {
        cell.earlyDetach = false; // consumed: the waiter wakes only on the true final
        return { runId, status: "waiting", labels, streamedRange: undefined, streamError: null };
      }
      if (cell.bridgeInflight > 0) {
        return { runId, status: "waiting", labels, streamedRange: undefined, streamError: null };
      }
      return this.end(runId, {
        runId, status: "error", labels,
        error: { code: "timeout", error: "timeout", message: `guest computation exhausted the ${cfg.timeoutMs}ms call budget (their timeout path)`, stdout: cell.stdout || undefined },
      });
    }
    if (out === "early") {
      cell.earlyDetach = false; // consumed (their wait resumes with a fresh budget)
      return { runId, status: "waiting", labels, streamedRange: undefined, streamError: null };
    }
    return out;
  }

  private awaitBudget(cell: LiveCell, budgetMs: number): Promise<ExecCellResult | "tick" | "early"> {
    return new Promise((res) => {
      const t = setTimeout(() => res("tick"), budgetMs);
      const watch = () => {
        if (cell.final) { clearTimeout(t); res(cell.final); return; }
        if (cell.earlyDetach) { clearTimeout(t); res("early"); return; }
        setImmediate(watch);
      };
      cell.onFinal.push((r) => { clearTimeout(t); res(r); });
      watch();
    });
  }

  /** their wait surface: resume with a FRESH wall-clock budget (default/cap values come from config). */
  async wait(runId: string, timeoutMsOverride?: number): Promise<ExecCellResult> {
    const cfg = this.cfg();
    const cell = this.live.get(runId);
    if (!cell) {
      return { runId, status: "error", labels: {}, error: { code: "path_limited", error: "path_limited", message: `no live code-mode cell for runId=${runId}` } };
    }
    if (cell.final) return cell.final;
    const budget = Math.min(Math.max(timeoutMsOverride ?? cfg.timeoutMs, 100), 60000);
    const out = await this.awaitBudget(cell, budget);
    if (out === "tick" || out === "early") {
      return this.live.has(runId)
        ? { runId, status: "waiting", labels: cell.labels, streamedRange: undefined, streamError: null }
        : { runId, status: "error", labels: {}, error: { code: "path_limited", error: "path_limited", message: `cell ${runId} ended without a final result` } };
    }
    return out;
  }

  async cancel(runId: string, err?: { code: string; message: string }): Promise<ExecCellResult> {
    const c = err ?? { code: "cancelled", message: "cancelled" };
    const result: ExecCellResult = { runId, status: "cancelled", labels: {}, error: { code: c.code, error: c.code, message: c.message } };
    return this.end(runId, result);
  }

  private async end(runId: string, result: ExecCellResult): Promise<ExecCellResult> {
    const cell = this.live.get(runId);
    if (!cell || cell.ended) return result;
    cell.ended = true;
    if (cell.timer) clearTimeout(cell.timer);
    this.live.delete(runId);
    await cell.worker.terminate().catch(() => {});
    cell.final = result;
    for (const f of cell.onFinal) f(result);
    cell.onFinal.length = 0;
    return result;
  }
}

/**
 * Registry integration: swap the model-visible surface for exec + wait +
 * direct-only, with the hidden tool set exposed to the guest engine.
 */
export function codeModeSurface(engine: CodeMode): ToolSpec[] {
  // Tool results in this runtime are strings persisted into session history;
  // the result JSON therefore also carries `source` — their "source lands in
  // session history as // Code Mode\n + code" transparency rule folds into it.
  const render = (result: ExecCellResult, code?: string): string =>
    JSON.stringify(code !== undefined ? { ...result, source: `// Code Mode\n${code.slice(0, 4000)}` } : result, null, 2);
  return [
    {
      name: "exec",
      description:
        "Evaluate JavaScript in the code-mode executor (their exec). Tools are exposed as async globals in the guest; use catalog.search(...) to find them. `command` is an alias for `code`, and is still JavaScript — not a shell string.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Human label for the cell (their titles field)" },
          code: { type: "string", description: "JavaScript source" },
          command: { type: "string", description: "alias for code (their command alias)" },
        },
        required: [],
      },
      async run(args, ctx) {
        const a = args as { title?: string; code?: string; command?: string };
        const code = String(a.code ?? a.command ?? "");
        const result = await engine.execCell(code, String(a.title ?? ""), ctx.signal);
        return render(result, code);
      },
    },
    {
      name: "wait",
      description:
        "Resume a waiting code-mode cell by runId (their wait). Call this only when the exec result has status 'waiting'. Resumes with a fresh call budget.",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string", description: "runId from a waiting exec result" },
          timeoutMs: { type: "integer", description: "wall-clock budget for this wait call (100–60000; default = tools.codeMode.timeoutMs)" },
        },
        required: ["runId"],
      },
      async run(args) {
        const a = args as { runId?: string; timeoutMs?: number };
        const result = await engine.wait(String(a.runId ?? ""), a.timeoutMs);
        return render(result);
      },
    },
  ];
}
