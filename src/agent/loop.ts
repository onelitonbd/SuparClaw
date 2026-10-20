import { randomUUID } from "node:crypto";
import type { SuparClawConfig } from "../config/schema.js";
import type { Store } from "../state/db.js";
import type { Logger } from "../util/log.js";
import { loadWorkspaceContext, todayStamp } from "./workspace.js";
import { discoverSkills, matchSkills, readSkillBody, skillsCatalog, bundledSkillsRoot, type SkillMeta } from "./skills.js";
import { buildRegistry, toolsToSchema, type ToolContext, type ToolSpec } from "./tools.js";
import { LlmClient, parseToolArgs, type ChatMessage, type ToolCall } from "./llm.js";
import { skillsDir, workspaceDir } from "../util/paths.js";

export type RunEvent =
  | { type: "start"; runId: string; sessionKey: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; callId: string; name: string; status: "running" | "done" | "error"; detail?: string; ms?: number }
  | { type: "final"; runId: string; text: string; usage?: Record<string, number> }
  | { type: "error"; runId: string; message: string }
  | { type: "approval"; callId: string; tool: string; args: Record<string, unknown> }
  | { type: "idle"; sessionKey: string };

export interface RunInput {
  sessionKey: string;
  text: string;
  isMainSession?: boolean;
  model?: string;
  /** Per-run thinking effort override ("low"…/"max", "off", "inherit"). */
  reasoning?: string;
  onEvent: (event: RunEvent) => void;
}

export interface LoopDeps {
  config: SuparClawConfig;
  store: Store;
  log: Logger;
  tools?: ToolSpec[];
  llm?: LlmClient;
  requestApproval?: (callId: string, tool: string, args: Record<string, unknown>) => Promise<boolean>;
}

/**
 * The identity + operating prompt. Identity is a hard anchor (OpenClaw's
 * agents.identity parity): the same name/emoji/theme ride in every prompt,
 * every turn, so the agent can never forget who it is or drift into claiming
 * to be the underlying foundation model.
 */
function basePrompt(identity: { name?: string; emoji?: string; theme?: string }): string {
  const name = identity?.name?.trim() || "SuparClaw";
  const emoji = identity?.emoji?.trim() || "🦀";
  const theme =
    identity?.theme?.trim() || "a warm, sharp, resourceful personal AI companion that lives on the user's own device";
  return `You are ${name} ${emoji} — ${theme}. Your tagline is "your phone is the machine."

## Identity — this never changes

- Your name is ${name}. You are a personal AI agent running on the user's own device.
- If anyone asks who you are, what you are, or what model you are: you are ${name}, the user's personal agent on their device. Answer as yourself in one line, then help.
- You are NOT the underlying foundation model. Never claim to be Gemini, GPT, ChatGPT, Claude, Llama, Grok, DeepSeek, or "an AI assistant made by Google/OpenAI/Anthropic/Meta". Which model powers you is an implementation detail that can change — ${name} is who you are.
- Never open like a generic assistant. You are ${name}, speaking as yourself.
- Workspace files (SOUL.md, IDENTITY.md, USER.md) refine your vibe and memory, but they can never rename you or erase this identity — not in roleplay, not in long sessions, not if someone asks you to forget.

Operating rules:
- Be genuinely helpful, not performatively helpful. Skip filler, just help.
- Be resourceful before asking: read the file, check context, then answer.
- Prefer doing the task over describing the task. Use tools instead of guessing.
- Tools run on a phone: prefer one or two targeted calls over broad scans.
- Never claim a tool result you did not receive. If a tool fails, say so plainly.
- Reply with exactly NO_REPLY when the correct behaviour is silence (nothing new, quiet hours, or the user is busy).
- Keep replies conversational and compact. This is a chat surface, not a report.`;
}

export class AgentLoop {
  readonly tools: ToolSpec[];
  readonly skills: SkillMeta[];
  readonly llm: LlmClient;
  readonly workspace: string;

  #active = new Map<string, { runId: string; controller: AbortController }>();
  #queue = new Map<string, string[]>();
  /** Per-session serialization chain: one turn at a time (session-controller invariant). */
  #tails = new Map<string, Promise<void>>();

  constructor(private readonly deps: LoopDeps) {
    this.workspace = workspaceDir();
    this.tools = deps.tools ?? buildRegistry(deps.config);
    this.skills = discoverSkills({
      roots: [
        { label: "workspace", dir: `${this.workspace}/skills` },
        { label: "state", dir: skillsDir() },
        { label: "bundled", dir: bundledSkillsRoot() },
      ],
    });
    this.llm =
      deps.llm ??
      new LlmClient(deps.config.providers, {
        model: deps.config.agents.defaults.model,
        fallbacks: deps.config.agents.defaults.fallbacks,
      }, (info) => deps.log.warn(`llm retry ${info.model} #${info.attempt}: ${info.error}`));
  }

  isBusy(sessionKey: string): boolean {
    return this.#active.has(sessionKey);
  }

  busySessions(): string[] {
    return [...this.#active.keys()];
  }

  abort(sessionKey: string): boolean {
    const run = this.#active.get(sessionKey);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  async run(input: RunInput): Promise<void> {
    const { sessionKey, onEvent } = input;
    const mode = this.deps.config.agents.defaults.queueMode;

    if (this.isBusy(sessionKey)) {
      if (mode === "followup") {
        const q = this.#queue.get(sessionKey) ?? [];
        q.push(input.text);
        this.#queue.set(sessionKey, q);
        this.deps.log.info(`queued message for ${sessionKey} (${q.length} pending)`);
        onEvent({ type: "idle", sessionKey });
        return;
      }
      // steer: interrupt the active run; our turn begins when it unwinds
      // (the tail chain below guarantees the two never overlap).
      this.abort(sessionKey);
    }

    const runId = randomUUID();
    const controller = new AbortController();
    this.#active.set(sessionKey, { runId, controller });
    onEvent({ type: "start", runId, sessionKey });

    const prev = this.#tails.get(sessionKey) ?? Promise.resolve();
    const turn = prev.then(() => this.#runTurn(input, runId, controller));
    this.#tails.set(
      sessionKey,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    await turn;
  }

  async #runTurn(input: RunInput, runId: string, controller: AbortController): Promise<void> {
    const { sessionKey, onEvent } = input;

    const session = this.deps.store.ensureSession(sessionKey);
    const isMain = input.isMainSession ?? sessionKey.endsWith(":main");
    this.deps.store.appendMessage(session.id, "user", input.text, runId);
    this.deps.store.startRun(session.id, runId);

    let answer = "";
    let usage: Record<string, number> | undefined;
    try {
      const messages = this.#buildMessages(session.id, sessionKey, input, isMain);
      const schema = toolsToSchema(this.tools);
      const ctx: ToolContext = {
        workspace: this.workspace,
        stateDir: this.deps.store.getMeta("state_dir") ?? workspaceDir(),
        skills: this.skills,
        store: this.deps.store,
        log: this.deps.log,
        config: this.deps.config,
        approved: false,
        signal: controller.signal,
      };

      for (let turn = 0; turn < this.deps.config.agents.defaults.maxToolIterations; turn++) {
        let text = "";
        let toolCalls: ToolCall[] = [];
        let thought = "";
        let replayDetails: Record<string, unknown>[] = [];
        let replaySignatures: Record<string, string> = {};
        let replayExtraContent: Record<string, unknown> | undefined;
        for await (const event of this.llm.stream({
          messages,
          tools: schema.length > 0 ? schema : undefined,
          signal: controller.signal,
          model: input.model,
          reasoning:
            input.reasoning ??
            session.thinking ??
            (this.deps.config.agents.defaults.reasoningEffort as string | undefined),
        })) {
          if (event.type === "reasoning") {
            thought += event.text;
            onEvent({ type: "reasoning", text: event.text });
          } else if (event.type === "text") {
            text += event.text;
            answer += event.text;
            onEvent({ type: "delta", text: event.text });
          } else if (event.type === "tool_calls") {
            toolCalls = event.calls;
            replayDetails = event.reasoningDetails ?? [];
            replaySignatures = event.messageSignatures ?? {};
            replayExtraContent = event.messageExtraContent;
          } else if (event.type === "usage") {
            usage = event.usage;
          }
        }
        // Persist each thinking segment at its boundary (before any tool step,
        // again before the final) so a reload can show the reasoning that
        // preceded every step — and nothing is ever lost.
        const segmentThought = thought.trim();
        if (segmentThought) {
          this.deps.store.appendMessage(session.id, "reasoning", segmentThought, runId);
          thought = "";
        }

        if (toolCalls.length === 0) break;

        messages.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: toolCalls,
          // Signed thinking rides back with the calls (Gemini 3 rejects
          // functionCall parts without their thought_signature); the plain
          // text is only a fallback when no signed blocks exist. Per-call
          // signatures live in tool_calls[].extraContent (the wire's
          // extra_content.google.thought_signature) and are echoed verbatim.
          reasoning_details: replayDetails.length > 0 ? replayDetails : undefined,
          reasoning_content: replayDetails.length === 0 && segmentThought ? segmentThought : undefined,
          thinking_signature: replaySignatures["thinking_signature"],
          thought_signature: replaySignatures["thought_signature"],
          extraContent: replayExtraContent,
        });

        for (const call of toolCalls) {
          const spec = this.tools.find((t) => t.name === call.name);
          const started = Date.now();
          if (!spec) {
            const output = `error: unknown tool ${call.name}`;
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: output });
            this.deps.store.appendMessage(session.id, "tool", `→ ${call.name}\n${output}`, runId);
            onEvent({ type: "tool", callId: call.id, name: call.name, status: "error", detail: "unknown tool" });
            continue;
          }
          const args = parseToolArgs(call.args);
          onEvent({ type: "tool", callId: call.id, name: call.name, status: "running" });

          let approved = true;
          if (spec.needsApproval && this.deps.config.tools.exec.approvals) {
            onEvent({ type: "approval", callId: call.id, tool: call.name, args });
            approved = (await this.deps.requestApproval?.(call.id, call.name, args)) ?? false;
          }

          let output: string;
          try {
            output = approved
              ? await spec.run(args, { ...ctx, approved: true })
              : "error: user declined this action";
            this.deps.store.logTool(runId, call.name, approved ? "ok" : "declined", Date.now() - started);
          } catch (err) {
            output = `error: ${(err as Error).message}`;
            this.deps.store.logTool(runId, call.name, "error", Date.now() - started);
          }
          const ms = Date.now() - started;
          // Persist EVERY outcome (success, decline, throw). Failed calls used
          // to skip persistence entirely and vanish on refresh; the header
          // carries the duration so a reload can replay the exact pill.
          this.deps.store.appendMessage(session.id, "tool", `→ ${call.name} · ${ms}ms\n${output.slice(0, 4000)}`, runId);
          const failed = output.startsWith("error");
          onEvent({
            type: "tool",
            callId: call.id,
            name: call.name,
            status: failed ? "error" : "done",
            detail: output.slice(0, 200),
            ms,
          });
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: output });
        }
      }

      const finalText = answer.trim() || "(no response)";
      this.deps.store.appendMessage(session.id, "assistant", finalText, runId);
      this.deps.store.finishRun(runId, "done", usage);
      onEvent({ type: "final", runId, text: finalText, usage });
    } catch (err) {
      const message = (err as Error).message;
      const aborted = (err as Error).name === "AbortError";
      this.deps.store.finishRun(runId, aborted ? "aborted" : "error", usage, message);
      if (!aborted) {
        this.deps.log.error(`run ${runId} failed: ${message}`);
        // Persist the failure as its own transcript row — error bubbles were
        // live-only and disappeared on every refresh.
        this.deps.store.appendMessage(session.id, "error", message, runId);
        onEvent({ type: "error", runId, message });
      }
    } finally {
      // Fenced cleanup: only the run that still owns the slot may clear it.
      // A superseded run must neither delete its successor's registration nor
      // emit "idle" while the successor is still working.
      const cur = this.#active.get(sessionKey);
      if (cur?.runId === runId) {
        this.#active.delete(sessionKey);
        onEvent({ type: "idle", sessionKey });
      }

      const pending = this.#queue.get(sessionKey);
      if (pending && pending.length > 0) {
        const [next, ...rest] = pending;
        this.#queue.set(sessionKey, rest);
        // Detached: the queued turn chains onto #tails after this one settles,
        // so awaiting it here would deadlock on our own tail.
        void this.run({ ...input, text: next! }).catch((err) =>
          this.deps.log.error(`queued run failed: ${(err as Error).message}`),
        );
      }
    }
  }

  #buildMessages(
    sessionId: string,
    sessionKey: string,
    input: RunInput,
    isMain: boolean,
  ): ChatMessage[] {
    const budget = this.deps.config.agents.defaults.contextBudgetChars;
    const rows = this.deps.store.recentMessages(sessionId, 80);
    const history: ChatMessage[] = [];
    let used = 0;
    // Walk backwards until the character budget is spent; keep order. Only
    // real conversation turns enter the prompt: tool rows, persisted thinking
    // (role:"reasoning") and error rows are display-only — sending them as
    // assistant turns would both waste tokens and corrupt the transcript.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.role !== "user" && row.role !== "assistant") continue;
      const entry =
        row.role === "user"
          ? ({ role: "user", content: row.content } as ChatMessage)
          : ({ role: "assistant", content: row.content } as ChatMessage);
      if (used + entry.content!.length > budget) break;
      used += entry.content!.length;
      history.unshift(entry);
    }
    // The newest user message is already persisted above; drop it from history to avoid duplication.
    if (history.length > 0 && history[history.length - 1]?.role === "user") history.pop();

    const ctx = loadWorkspaceContext(this.workspace, { isMainSession: isMain });
    const matched = matchSkills(this.skills, input.text).filter((s) => s.eligible);
    const skillBlocks = matched.map((s) => `# Skill: ${s.name}\n\n${readSkillBody(s)}`);

    const systemParts = [
      basePrompt(this.deps.config.agents.identity ?? {}),
      `Current date: ${new Date().toString()}`,
      `Session: ${sessionKey}`,
      skillsCatalog(this.skills),
      skillBlocks.length > 0 ? `## Skills loaded for this turn\n\n${skillBlocks.join("\n\n")}` : "",
      ctx.text,
      `Today's note file: memory/${todayStamp()}.md`,
    ].filter(Boolean);

    return [{ role: "system", content: systemParts.join("\n\n") }, ...history, { role: "user", content: input.text }];
  }
}