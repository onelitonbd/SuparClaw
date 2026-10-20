// OpenAI-compatible streaming client. One keep-alive socket per provider, SSE parsed
// incrementally, tool calls accumulated across deltas, fallbacks tried in order.
import { extname } from "node:path";

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
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
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "LlmError";
  }
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

  /** Stream one completion, walking the fallback chain on retryable failures. */
  async *stream(opts: StreamOptions): AsyncGenerator<StreamEvent> {
    const chain = [opts.model ?? this.#defaults.model, ...this.#defaults.fallbacks].filter(Boolean);
    if (chain.length === 0) throw new LlmError("no model configured — set agents.defaults.model and a provider");
    let lastError: Error | null = null;
    for (const modelRef of chain) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          yield* this.#streamOnce(modelRef, opts);
          return;
        } catch (err) {
          const e = err as LlmError;
          lastError = e;
          const retryable = e.retryable || e instanceof LlmError === false;
          this.onRetry?.({ model: modelRef, attempt: attempt + 1, error: e.message });
          if (!retryable || opts.signal?.aborted) break;
          await sleep(Math.min(4000, 250 * 2 ** attempt));
        }
      }
    }
    throw lastError ?? new LlmError("model call failed");
  }

  async *#streamOnce(modelRef: string, opts: StreamOptions): AsyncGenerator<StreamEvent> {
    const resolved = resolveModel(modelRef, this.#providers);
    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.tools?.length) body["tools"] = opts.tools;
    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
    if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;

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
        `HTTP ${res.status} from ${resolved.provider}: ${text.slice(0, 300) || res.statusText}`,
        res.status,
        RETRYABLE_STATUS.has(res.status),
      );
    }
    if (!res.body) throw new LlmError("provider returned an empty stream", undefined, true);

    const calls = new Map<number, ToolCall>();
    let finishReason = "stop";
    let usage: Record<string, number> | null = null;

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
      const content = delta["content"];
      if (typeof content === "string" && content.length > 0) {
        yield { type: "text", text: content };
      }
      const deltaCalls = delta["tool_calls"];
      if (Array.isArray(deltaCalls)) {
        for (const raw of deltaCalls as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[]) {
          const index = raw.index ?? 0;
          const existing = calls.get(index) ?? { id: "", name: "", args: "" };
          if (raw.id) existing.id = raw.id;
          if (raw.function?.name) existing.name += raw.function.name;
          if (raw.function?.arguments) existing.args += raw.function.arguments;
          calls.set(index, existing);
        }
      }
    }

    const finished = [...calls.values()].filter((c) => c.name.length > 0);
    if (finished.length > 0) yield { type: "tool_calls", calls: finished };
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
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
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