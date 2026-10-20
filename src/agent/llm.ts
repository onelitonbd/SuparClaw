// OpenAI-compatible streaming client. One keep-alive socket per provider, SSE parsed
// incrementally, tool calls accumulated across deltas, fallbacks tried in order.
import { extname } from "node:path";

export interface ToolCall {
  id: string;
  name: string;
  args: string;
  /**
   * Provider vendor extension, captured verbatim from the wire. Google's
   * OpenAI-compat layer hangs each call's thought_signature here as
   * `extra_content.google.thought_signature` and 400s the next turn when a
   * replayed functionCall part loses it ("Function call is missing a
   * thought_signature in functionCall parts" — ai.google.dev/gemini-api/
   * docs/thought-signatures). It must round-trip unchanged.
   */
  extraContent?: Record<string, unknown>;
}

/** Google's documented stand-in for history that arrived without signatures
 * (imported transcripts, other-provider turns, sessions from before capture
 * existed). The validator skips signature checking for this exact value. */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** The signature Google hangs off one call, or "" when absent. */
export function googleThoughtSignature(call: {
  extraContent?: Record<string, unknown>;
}): string {
  const g = call.extraContent?.["google"];
  const sig = g && typeof g === "object" ? (g as Record<string, unknown>)["thought_signature"] : undefined;
  return typeof sig === "string" ? sig : "";
}

/** First-non-empty merge for vendor-extension objects (structural keys never
 * concatenate — same rule as reasoning_details fragments). */
function mergeExtraContent(into: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(src)) {
    if (value === null || value === undefined) continue;
    const cur = into[key];
    if (
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      mergeExtraContent(cur as Record<string, unknown>, value as Record<string, unknown>);
    } else if (cur === null || cur === undefined || cur === "") {
      into[key] = value;
    }
  }
}

/**
 * Pull the human sentence out of a provider error body. Bodies arrive as
 * JSON blobs ({"error":{"message":...}}, [{"error":{...}}], nested routers)
 * and MultiRouter/Google pretty-print them, so a length cap truncates the
 * JSON mid-string and JSON.parse fails — fall back to pulling the first
 * "message" value out of the debris.
 */
export function providerErrorText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const extract = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    if (typeof obj["message"] === "string" && (obj["message"] as string).trim()) {
      return obj["message"] as string;
    }
    const inner = obj["error"] ?? (Array.isArray(obj["errors"]) ? obj["errors"][0] : undefined);
    return extract(inner);
  };
  try {
    const parsed: unknown = JSON.parse(text);
    const found = Array.isArray(parsed) ? extract(parsed[0]) : extract(parsed);
    if (found && found.trim() && found !== text) return found.trim();
  } catch {
    /* not valid JSON — maybe truncated mid-string; try the regex below */
  }
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"?/.exec(text);
  if (m?.[1]) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  return text;
}

/* ---- wire serialization (strict OpenAI chat format) ---- */

let callSeq = 0;

/**
 * Model-supplied tool-call ids are often empty or reused ("0","0" — Gemini
 * repeats per-turn ids). Strict backends reject duplicate/empty ids across
 * the whole history, so always remap to unique opaque ids.
 */
function normalizeCallIds(calls: ToolCall[]): ToolCall[] {
  return calls.map((c) => ({
    ...c,
    id: `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`,
  }));
}

/**
 * Serialize internal messages to the strict OpenAI wire shape. Google
 * Gemini's OpenAI-compat layer (which routers like MultiRouter sit in front
 * of) rejects the internal tool_calls shape {id,name,args} with a generic
 * 400 INVALID_ARGUMENT ("Function call name is empty") — the wire shape is
 * {id, type:"function", function:{name, arguments}}. Also: tool-call-only
 * assistant messages omit content entirely (null and "" both get 400s from
 * some backends), empty arguments become "{}", and tool messages carry the
 * function name (Gemini enforces it).
 */
/**
 * Merge one streamed reasoning_details fragment into a detail block.
 * Text-ish fields concatenate; structural fields (type/format/id/signature)
 * take the first non-empty value — concatenating `format` is a known bug
 * class (langchainjs #11699).
 */
function mergeReasoningFragment(into: Record<string, unknown>, frag: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frag)) {
    if (value === null || value === undefined) continue;
    if (key === "text" || key === "data" || key === "summary") {
      into[key] = String(into[key] ?? "") + String(value);
    } else if (into[key] === null || into[key] === undefined || into[key] === "") {
      into[key] = value;
    }
  }
}

/**
 * Accumulates one response's streamed reasoning_details into replayable
 * blocks: fragments merge per `index` (or per non-empty `id`), a fragment
 * whose non-empty id differs from its block's starts a new block, and
 * index-less/id-less fragments stand alone. Gemini 3 rejects tool rounds
 * whose signed thinking is missing or split ("missing a thought_signature
 * in functionCall parts" — cline #7551), so blocks must be whole and the
 * signatures kept.
 */
class ReasoningAccumulator {
  #byIndex = new Map<number, Record<string, unknown>>();
  #loose: Record<string, unknown>[] = [];

  add(frags: unknown): void {
    if (!Array.isArray(frags)) return;
    for (const raw of frags) {
      if (!raw || typeof raw !== "object") continue;
      const frag = raw as Record<string, unknown>;
      const fragId = typeof frag["id"] === "string" ? (frag["id"] as string) : "";
      const index = typeof frag["index"] === "number" ? (frag["index"] as number) : undefined;
      let target: Record<string, unknown> | undefined;
      if (index !== undefined) {
        const cand = this.#byIndex.get(index);
        const candId = cand && typeof cand["id"] === "string" ? (cand["id"] as string) : "";
        if (cand && (!fragId || !candId || fragId === candId)) target = cand;
      } else if (fragId) {
        target = [...this.#byIndex.values(), ...this.#loose].find((d) => d["id"] === fragId);
      }
      if (!target) {
        target = {};
        if (index !== undefined) this.#byIndex.set(index, target);
        else this.#loose.push(target);
      }
      mergeReasoningFragment(target, frag);
    }
  }

  blocks(): Record<string, unknown>[] {
    return [...this.#byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => block)
      .concat(this.#loose)
      .filter((block) => Object.keys(block).length > 0);
  }
}

function wireMessages(messages: ChatMessage[], opts?: { signToolCalls?: boolean }): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant" };
      if (m.tool_calls?.length) {
        out["tool_calls"] = m.tool_calls.map((c) => {
          const call: Record<string, unknown> = {
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args.trim() ? c.args : "{}" },
          };
          // Echo the vendor extension verbatim (Google's thought_signature
          // lives here; losing it 400s the next turn).
          if (c.extraContent && Object.keys(c.extraContent).length > 0) {
            call["extra_content"] = c.extraContent;
          }
          return call;
        });
        // Gemini's validator demands a signature on every functionCall part
        // of the current turn. Calls that genuinely carry none (history from
        // another model, sessions predating capture) get Google's documented
        // stand-in so tool loops survive instead of 400ing. Real signatures
        // always win. Non-Google models see byte-identical bodies.
        if (opts?.signToolCalls) {
          for (const call of out["tool_calls"] as Record<string, unknown>[]) {
            const extra = call["extra_content"] as Record<string, unknown> | undefined;
            const google = (extra?.["google"] ?? {}) as Record<string, unknown>;
            if (typeof google["thought_signature"] === "string" && google["thought_signature"]) continue;
            call["extra_content"] = { ...extra, google: { ...google, thought_signature: SKIP_THOUGHT_SIGNATURE } };
          }
        }
        if (m.content) out["content"] = m.content;
        // Signed thinking must ride back with the tool calls (Gemini 3
        // rejects "functionCall parts" without a thought_signature).
        if (m.reasoning_details?.length) out["reasoning_details"] = m.reasoning_details;
        else if (m.reasoning_content) out["reasoning_content"] = m.reasoning_content;
        if (m.thinking_signature) out["thinking_signature"] = m.thinking_signature;
        if (m.thought_signature) out["thought_signature"] = m.thought_signature;
        if (m.extraContent) out["extra_content"] = m.extraContent;
      } else {
        out["content"] = m.content ?? "";
        if (m.extraContent) out["extra_content"] = m.extraContent;
      }
      return out;
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id, name: m.name, content: m.content };
    }
    return m;
  });
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      /** OpenRouter-style signed reasoning, replayed verbatim with tool calls. */
      reasoning_details?: Record<string, unknown>[];
      /** Plain-text fallback when no details exist (OpenRouter alias). */
      reasoning_content?: string;
      /** Message-level Gemini signature aliases (some proxies use these). */
      thinking_signature?: string;
      thought_signature?: string;
      /** Message-level vendor extension (a text turn's signature lands here). */
      extraContent?: Record<string, unknown>;
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_calls";
      calls: ToolCall[];
      /** Merged signed reasoning blocks to replay with these calls. */
      reasoningDetails?: Record<string, unknown>[];
      /** Message-level signature aliases (thinking_signature/thought_signature). */
      messageSignatures?: Record<string, string>;
      /** Message-level vendor extension (extra_content) captured with this turn. */
      messageExtraContent?: Record<string, unknown>;
    }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "done"; finishReason: string };

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  models?: string[];
}

export interface ResolvedModel {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Retry-After: seconds or an HTTP-date, floored for the next attempt (capped at 60s). */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const ms = Number(header) * 1000;
  if (Number.isFinite(ms) && ms >= 0) return Math.min(60_000, ms);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
  return undefined;
}

export function resolveModel(
  modelRef: string,
  providers: Record<string, ProviderConfig>,
): ResolvedModel {
  const ref = modelRef.trim();
  const available = Object.keys(providers);
  const slash = ref.indexOf("/");
  const head = slash > 0 ? ref.slice(0, slash) : "";
  const tail = slash > 0 ? ref.slice(slash + 1) : ref;

  // 1. the normal form: "<provider>/<model>"
  const direct = head ? providers[head] : undefined;
  if (direct) {
    return build(head, direct, tail || direct.models?.[0] || "");
  }

  // 2. a bare model id that exactly one provider offers. Model ids often
  //    contain slashes ("kilo/nvidia/nemotron-3"), so a bare id is ambiguous
  //    unless we look it up instead of splitting on the first slash.
  const exact = available.filter((name) => (providers[name]?.models ?? []).includes(ref));
  if (exact.length === 1) {
    return build(exact[0] as string, providers[exact[0] as string] as ProviderConfig, ref);
  }
  if (exact.length > 1) {
    throw new LlmError(
      `model "${ref}" is offered by several providers (${exact.join(", ")}) — use "<provider>/<model>"`,
    );
  }

  // 3. "<something>/<model>" where <model> is the tail of a provider's id
  for (const name of available) {
    const models = providers[name]?.models ?? [];
    const hit = models.find((m) => m.endsWith(`/${tail}`));
    if (hit) return build(name, providers[name] as ProviderConfig, hit);
  }

  // 4. one provider configured: the whole ref is that provider's model id
  if (available.length === 1) {
    return build(available[0] as string, providers[available[0] as string] as ProviderConfig, ref);
  }

  const hint = available.length > 0 ? ` — configured providers: ${available.join(", ")}` : " — no providers configured";
  throw new LlmError(
    `model "${ref}" does not match any configured provider${hint}. Use "<provider>/<model>", e.g. "${available[0] ? `${available[0]}/` : ""}<model>"`,
  );
}

function build(
  provider: string,
  cfg: ProviderConfig,
  model: string,
): ResolvedModel {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    provider,
    model,
    baseUrl,
    apiKey: cfg.apiKey,
    headers: cfg.headers ?? {},
  };
}

interface StreamOptions {
  messages: ChatMessage[];
  tools?: { type: "function"; function: Record<string, unknown> }[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Per-run override; falls back to agents.defaults.model. */
  model?: string;
  /**
   * Thinking effort for this request ("inherit"/"off"/"low"/…/"max"). Sent as
   * OpenAI-compatible `reasoning_effort` when it names a real level; "inherit"
   * and "off" omit the field (custom endpoints reject an explicit off).
   */
  reasoning?: string;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LlmClient {
  #providers: Record<string, ProviderConfig>;
  #defaults: { model: string; fallbacks: string[] };

  constructor(
    providers: Record<string, ProviderConfig>,
    defaults: { model: string; fallbacks: string[] },
    private readonly onRetry?: (info: { model: string; attempt: number; error: string }) => void,
  ) {
    this.#providers = providers;
    this.#defaults = defaults;
  }

  /** Hot-swap providers/defaults after a config change (e.g. saved from the Control UI). */
  setConfig(
    providers: Record<string, ProviderConfig>,
    defaults: { model: string; fallbacks: string[] },
  ): void {
    this.#providers = providers;
    this.#defaults = defaults;
  }

  listModels(): string[] {
    const out: string[] = [];
    for (const [name, cfg] of Object.entries(this.#providers)) {
      for (const m of cfg.models ?? []) out.push(`${name}/${m}`);
    }
    if (out.length === 0 && this.#defaults.model) out.push(this.#defaults.model);
    return out;
  }

  /**
   * Stream one completion, walking the fallback chain on retryable failures.
   *
   * Retry contract (mirrors OpenClaw's policy): a request that has already
   * delivered events to the consumer is never retried — retrying would stitch
   * two answers together. Failures with no output yet retry with jittered
   * backoff (honoring Retry-After), then fall through to the next model.
   * Auth/billing errors and unexpected exceptions are terminal.
   */
  async *stream(opts: StreamOptions): AsyncGenerator<StreamEvent> {
    const chain = [
      ...new Set([opts.model ?? this.#defaults.model, ...this.#defaults.fallbacks].filter(Boolean)),
    ];
    if (chain.length === 0) throw new LlmError("no model configured — set agents.defaults.model and a provider");
    let lastError: Error | null = null;
    for (const modelRef of chain) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let yielded = false;
        try {
          for await (const event of this.#streamOnce(modelRef, opts)) {
            yielded = true;
            yield event;
          }
          return;
        } catch (err) {
          const e = err as Error;
          lastError = e;
          if (e.name === "AbortError" || opts.signal?.aborted) throw e;
          if (!(e instanceof LlmError)) throw e; // programming errors are terminal
          if (yielded) throw e; // partial output reached the consumer — never stitch
          if (!e.retryable) break; // auth/4xx on this model: try the next fallback
          if (attempt >= 2) break; // exhausted retries on this model
          this.onRetry?.({ model: modelRef, attempt: attempt + 1, error: e.message });
          const backoff = Math.min(4000, 250 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
          await sleep(Math.max(backoff, e.retryAfterMs ?? 0));
        }
      }
    }
    throw lastError ?? new LlmError("model call failed");
  }

  async *#streamOnce(modelRef: string, opts: StreamOptions): AsyncGenerator<StreamEvent> {
    const resolved = resolveModel(modelRef, this.#providers);
    // Gemini/Vertex tool rounds need their functionCall parts signed (real
    // signature or Google's documented stand-in); other backends must see
    // unchanged bodies.
    const signToolCalls = /gemini|vertex/i.test(`${modelRef} ${resolved.model}`);
    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: wireMessages(opts.messages, { signToolCalls }),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.tools?.length) body["tools"] = opts.tools;
    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
    if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;
    const effort = opts.reasoning;
    if (effort && effort !== "inherit" && effort !== "off") body["reasoning_effort"] = effort;

    let res: Response;
    try {
      res = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(resolved.apiKey ? { authorization: `Bearer ${resolved.apiKey}` } : {}),
          ...resolved.headers,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new LlmError(`network: ${(err as Error).message}`, undefined, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(
        `HTTP ${res.status} from ${resolved.provider}: ${providerErrorText(text).slice(0, 500) || res.statusText}`,
        res.status,
        RETRYABLE_STATUS.has(res.status),
        RETRYABLE_STATUS.has(res.status) ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
      );
    }
    if (!res.body) throw new LlmError("provider returned an empty stream", undefined, true);

    const calls = new Map<number, ToolCall>();
    const callIds = new Map<string, number>();
    let lastSlot = 0;
    const reasoning = new ReasoningAccumulator();
    const messageSignatures: Record<string, string> = {};
    const messageExtraContent: Record<string, unknown> = {};
    const captureSignatures = (src: Record<string, unknown>): void => {
      for (const key of ["thinking_signature", "thought_signature"]) {
        const value = src[key];
        if (typeof value === "string" && value.length > 0) messageSignatures[key] = value;
      }
    };
    const captureExtra = (src: Record<string, unknown>): void => {
      const extra = src["extra_content"];
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        mergeExtraContent(messageExtraContent, extra as Record<string, unknown>);
      }
    };
    let finishReason = "stop";
    let usage: Record<string, number> | null = null;

    try {
      for await (const chunk of iterateSse(res.body)) {
        if (chunk === "[DONE]") break;
        let payload: {
          choices?: { delta?: Record<string, unknown>; finish_reason?: string }[];
          usage?: Record<string, number>;
        };
        try {
          payload = JSON.parse(chunk);
        } catch {
          continue;
        }
        if (payload.usage) usage = payload.usage;
        const choice = payload.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        reasoning.add(delta["reasoning_details"]);
        captureSignatures(delta);
        captureExtra(delta);
        const message = (choice as { message?: Record<string, unknown> }).message;
        if (message) {
          reasoning.add(message["reasoning_details"]);
          captureSignatures(message);
          captureExtra(message);
        }
        // Thinking deltas, whatever the vendor calls them: DeepSeek/Nvidia NIM
        // send `reasoning_content`, OpenAI-style backends `reasoning`, some
        // stacks `thinking`. They arrive before/around the answer text.
        const thinking = delta["reasoning_content"] ?? delta["reasoning"] ?? delta["thinking"];
        if (typeof thinking === "string" && thinking.length > 0) {
          yield { type: "reasoning", text: thinking };
        }
        const content = delta["content"];
        if (typeof content === "string" && content.length > 0) {
          yield { type: "text", text: content };
        }
        const deltaCalls = delta["tool_calls"];
        if (Array.isArray(deltaCalls)) {
          // Key by id when present (Gemini's OpenAI-compat omits `index`, so
          // index-keyed accumulation would merge parallel calls into one).
          // Fragments without id fall back to their index, then to the most
          // recent call.
          for (const raw of deltaCalls as {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
            extra_content?: Record<string, unknown>;
            thought_signature?: string;
            thoughtSignature?: string;
          }[]) {
            let slot: number | undefined;
            if (raw.id) {
              const known = callIds.get(raw.id);
              if (known !== undefined) {
                slot = known;
              } else {
                const at = raw.index !== undefined ? calls.get(raw.index) : undefined;
                // A new id claims a fresh slot — or adopts the id-less first
                // fragment already parked at raw.index.
                slot = at && !at.id ? raw.index : Math.max(-1, ...calls.keys()) + 1;
              }
            } else {
              slot = raw.index ?? lastSlot;
            }
            const existing = calls.get(slot) ?? { id: "", name: "", args: "" };
            if (raw.id && !existing.id) {
              existing.id = raw.id;
              callIds.set(raw.id, slot);
            }
            if (raw.function?.name) existing.name += raw.function.name;
            if (raw.function?.arguments) existing.args += raw.function.arguments;
            // Keep the per-call vendor extension (Google's thought_signature
            // rides here, sometimes on later chunks with no id — match by slot).
            const extra = raw.extra_content;
            if (extra && typeof extra === "object" && !Array.isArray(extra)) {
              existing.extraContent ??= {};
              mergeExtraContent(existing.extraContent, extra);
            }
            // Some proxies hoist the signature to a top-level tool_call key;
            // give it the canonical home so replay finds it in one place.
            const hoisted = raw.thought_signature ?? raw.thoughtSignature;
            if (typeof hoisted === "string" && hoisted.length > 0) {
              existing.extraContent ??= {};
              const google = (existing.extraContent["google"] ??= {});
              if (google && typeof google === "object" && !(google as Record<string, unknown>)["thought_signature"]) {
                (google as Record<string, unknown>)["thought_signature"] = hoisted;
              }
            }
            calls.set(slot, existing);
            lastSlot = slot;
          }
        }
      }
    } catch (err) {
      // A dropped socket mid-stream is transport, not a bug: classify it as a
      // retryable LlmError (the retry policy in stream() decides what happens
      // once output has been delivered).
      if ((err as Error).name === "AbortError") throw err;
      throw new LlmError(`stream interrupted: ${(err as Error).message}`, undefined, true);
    }

    const finished = [...calls.values()].filter((c) => c.name.length > 0);
    if (finished.length > 0) {
      yield {
        type: "tool_calls",
        calls: normalizeCallIds(finished),
        reasoningDetails: reasoning.blocks(),
        messageSignatures,
        messageExtraContent,
      };
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "done", finishReason };
  }
}

async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Event separator is \n\n; tolerate CRLF servers (\r\n\r\n / \n\r\n).
    let sep: RegExpExecArray | null;
    while ((sep = /\n\n|\n\r\n|\r\n\r\n/.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index + sep[0].length);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.trim().startsWith("data:"))
        .map((line) => line.trim().slice(5).trim())
        .join("\n");
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseToolArgs(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { _parseError: `invalid JSON arguments: ${args.slice(0, 200)}` };
  }
}

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return extname(u.pathname) === "" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}