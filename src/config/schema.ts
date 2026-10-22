// Hand-rolled strict config schema: no zod, no silent drift, precise error paths.

type SchemaKind =
  | { t: "string"; min?: number }
  | { t: "text" }
  | { t: "int"; min?: number; max?: number }
  | { t: "number" }
  | { t: "bool" }
  | { t: "any" }
  | { t: "enum"; values: readonly string[] }
  | { t: "array"; of: SchemaNode }
  | { t: "record"; of: SchemaNode }
  | { t: "object"; fields: Record<string, SchemaNode> };

/** Every node may carry a default (filled by applyDefaults) and may be optional. */
export type SchemaNode = SchemaKind & { default?: unknown; optional?: boolean };

type Field = SchemaNode;

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

export function validate(node: SchemaNode, value: unknown, path = "$"): string[] {
  switch (node.t) {
    case "any":
      return [];
    case "string": {
      if (typeof value !== "string") return [`${path}: expected string`];
      if (node.min !== undefined && value.length < node.min) {
        return [`${path}: expected at least ${node.min} character(s)`];
      }
      return [];
    }
    case "text":
      return typeof value === "string" ? [] : [`${path}: expected string`];
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) return [`${path}: expected integer`];
      if (node.min !== undefined && value < node.min) return [`${path}: must be >= ${node.min}`];
      if (node.max !== undefined && value > node.max) return [`${path}: must be <= ${node.max}`];
      return [];
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${path}: expected number`];
    case "bool":
      return typeof value === "boolean" ? [] : [`${path}: expected boolean`];
    case "enum":
      return typeof value === "string" && node.values.includes(value)
        ? []
        : [`${path}: expected one of ${node.values.join(" | ")}`];
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected array`];
      return value.flatMap((v, i) => validate(node.of, v, `${path}[${i}]`));
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path}: expected object`];
      }
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        validate(node.of, v, `${path}.${k}`),
      );
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path}: expected object`];
      }
      const obj = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of Object.keys(obj)) {
        if (!(key in node.fields)) {
          errors.push(`${path}.${key}: unknown key (remove it or check spelling)`);
        }
      }
      for (const [key, spec] of Object.entries(node.fields)) {
        const present = key in obj;
        const field = spec as Field;
        if (!present) {
          if (field.default === undefined && !field.optional && path !== "$") {
            errors.push(`${path}.${key}: missing required key`);
          }
          continue;
        }
        errors.push(...validate(spec, obj[key], `${path}.${key}`));
      }
      return errors;
    }
  }
}

/** Fill defaults for absent keys (non-destructive). */
export function applyDefaults(node: SchemaNode, value: unknown): unknown {
  if (node.t !== "object") return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown> | null) };
  for (const [key, spec] of Object.entries(node.fields)) {
    const field = spec as Field;
    if (!(key in out) || out[key] === undefined) {
      if (field.default !== undefined) {
        out[key] = applyDefaults(spec, structuredClone(field.default));
      }
      continue;
    }
    out[key] = applyDefaults(spec, out[key]);
  }
  return out;
}

export const CONFIG_SCHEMA: SchemaNode = {
  t: "object",
  fields: {
    gateway: {
      t: "object",
      default: {},
      fields: {
        port: { t: "int", min: 1, max: 65535, default: 18790 },
        bind: { t: "enum", values: ["loopback", "lan"], default: "loopback" },
        auth: {
          t: "object",
          default: {},
          fields: {
            mode: { t: "enum", values: ["token", "none"], default: "token" },
            token: { t: "string", default: "" },
            // The Control UI in the phone's own browser connects over loopback.
            // Allowing that without a token keeps the phone flow usable; turn it
            // off on shared machines.
            loopbackBypass: { t: "bool", default: true },
          },
        },
        controlUi: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: true },
            basePath: { t: "string", default: "" },
          },
        },
        // Transport trust policy (see src/gateway/trust.ts). Hosts listed here
        // bypass the built-in loopback/private allowlist; origins listed here
        // may open the WebSocket cross-origin (e.g. a reverse-proxied UI).
        allowedHosts: { t: "array", of: { t: "string" }, default: [] },
        allowedOrigins: { t: "array", of: { t: "string" }, default: [] },
        // OpenAI-compatible HTTP surface (P1 A6, upstream config path
        // gateway.http.endpoints.*). Operator-grade: Bearer = the gateway
        // token. Off by default — it grants full agent access over plain HTTP.
        http: {
          t: "object",
          default: {},
          fields: {
            endpoints: {
              t: "object",
              default: {},
              fields: {
                chatCompletions: {
                  t: "object",
                  default: {},
                  fields: { enabled: { t: "bool", default: false } },
                },
              },
            },
          },
        },
      },
    },
    agents: {
      t: "object",
      default: {},
      fields: {
        // Who the agent is. Injected into every prompt as a hard identity
        // anchor (OpenClaw's agents.identity parity): the model must never
        // forget its name or claim to be the underlying foundation model.
        identity: {
          t: "object",
          default: {},
          fields: {
            name: { t: "string", default: "SuparClaw" },
            emoji: { t: "string", default: "🦀" },
            theme: {
              t: "string",
              default: "a warm, sharp, resourceful personal AI companion that lives on the user's own device",
            },
          },
        },
        defaults: {
          t: "object",
          default: {},
          fields: {
            id: { t: "string", default: "main" },
            model: { t: "string", default: "" },
            fallbacks: { t: "array", of: { t: "string" }, default: [] },
            maxToolIterations: { t: "int", min: 1, max: 40, default: 12 },
            contextBudgetChars: { t: "int", min: 2000, default: 60000 },
            // Legacy alias — superseded by messages.queue.mode. Kept so old
            // configs still validate; the new section wins when both exist.
            queueMode: { t: "enum", values: ["steer", "followup"], default: "followup" },
            // Global lane caps (OpenClaw command-queue parity). 0 = auto:
            // max(8, cpu parallelism * 4), their default main-lane formula.
            maxConcurrent: { t: "int", min: 0, default: 0 },
            subagents: {
              t: "object",
              default: {},
              fields: {
                // Per-spawning-session child budget + background-lane budget.
                maxConcurrent: { t: "int", min: 1, default: 8 },
                // Model/thinking overrides for children (empty = inherit caller).
                model: { t: "string", default: "" },
                thinking: { t: "string", default: "" },
                // 1 = children cannot spawn children. Raise for orchestrators.
                maxDepth: { t: "int", min: 1, max: 4, default: 1 },
                // Prompt guidance only: inherit → prefer in :main, suggest elsewhere.
                delegationMode: { t: "enum", values: ["inherit", "prefer", "suggest"], default: "inherit" },
              },
            },
            // Thinking effort sent to the provider (reasoning_effort).
            // "inherit" = don't send the field at all (the provider/model keeps
            // its own default); "off" omits it too on custom routes (many
            // OpenAI-compatible endpoints reject an explicit off).
            reasoningEffort: {
              t: "enum",
              values: ["inherit", "off", "low", "medium", "high", "xhigh", "max"],
              default: "inherit",
            },
            // Whether thinking blocks are visible in the UI. The blocks are
            // always persisted either way — "off" only hides them from view.
            reasoningView: { t: "enum", values: ["on", "off"], default: "on" },
          },
        },
      },
    },
    // Inbound message queueing (OpenClaw command-queue parity): what new input
    // does while a session already has an active run. Per-session /queue
    // overrides and byChannel win over the session default here.
    messages: {
      t: "object",
      default: {},
      fields: {
        queue: {
          t: "object",
          default: {},
          fields: {
            // steer (default): inject into the live turn at tool boundaries.
            // followup: run after the active turn, per message.
            // collect: merge compatible queued messages into one turn after
            // the quiet window. interrupt: abort active work, run the newest.
            mode: { t: "enum", values: ["steer", "followup", "collect", "interrupt"], default: "steer" },
            cap: { t: "int", min: 1, default: 20 },
            drop: { t: "enum", values: ["summarize", "old", "new"], default: "summarize" },
            debounceMs: { t: "int", min: 0, default: 500 },
            byChannel: { t: "record", of: { t: "enum", values: ["steer", "followup", "collect", "interrupt"] }, default: {} },
          },
        },
      },
    },
    memory: {
      t: "object",
      default: {},
      fields: {
        dreaming: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: true },
            // Standard 5-field cron, run by the gateway daemon (their 0 3 default).
            schedule: { t: "string", default: "0 3 * * *" },
          },
        },
      },
    },
    providers: {
      t: "record",
      default: {},
      of: {
        t: "object",
        fields: {
          baseUrl: { t: "string", default: "" },
          // May hold a literal key OR the id of a compatible stored auth
          // profile (profile binding — resolved at request time).
          apiKey: { t: "string", default: "" },
          headers: { t: "record", of: { t: "string" }, default: {} },
          models: { t: "array", of: { t: "string" }, default: [] },
          // Multiple stored profiles bound to this provider (ordered).
          authProfiles: { t: "array", of: { t: "string" }, default: [] },
          // Wire protocol: OpenAI-compat by default; "ollama" = native
          // /api/chat (their warning: the /v1 compat mode breaks tools).
          api: { t: "enum", values: ["openai-completions", "ollama"], default: "openai-completions" },
        },
      },
    },
    // Auth configuration — explicit per-provider profile order. A store-side
    // override (sc models auth order set) wins over this config.
    auth: {
      t: "object",
      default: {},
      fields: {
        order: { t: "record", of: { t: "array", of: { t: "string" }, default: [] }, default: {} },
      },
    },
    // Curated model profiles — the Settings "Models" tab. Unlike OpenClaw
    // (every provider model shows up), nothing appears in the picker until the
    // user adds it here. The record key is the local id; the same wire ref may
    // be configured several times with different tuning ("use it multiple
    // times"). `enabled` is the accept switch: only accepted profiles appear
    // in the model picker.
    models: {
      t: "record",
      default: {},
      of: {
        t: "object",
        fields: {
          // Wire ref sent to the provider ("provider/model" or a bare model id).
          ref: { t: "string", default: "" },
          // Display name; falls back to the ref when empty.
          label: { t: "string", default: "" },
          // Accept switch — accepted models appear in the model picker.
          enabled: { t: "bool", default: true },
          // Native context window in tokens (0 = unknown).
          contextWindow: { t: "int", min: 0, default: 0 },
          // Output cap sent as max_tokens (0 = provider default).
          maxTokens: { t: "int", min: 0, default: 0 },
          // Optional sampling temperature; absent = provider default.
          temperature: { t: "number", optional: true },
          // Per-model thinking default; "inherit" defers to session/global.
          reasoningEffort: {
            t: "enum",
            values: ["inherit", "off", "low", "medium", "high", "xhigh", "max"],
            default: "inherit",
          },
        },
      },
    },
    channels: {
      t: "object",
      default: {},
      fields: {
        telegram: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: false },
            token: { t: "string", default: "" },
            dmPolicy: { t: "enum", values: ["pairing", "open", "allowlist"], default: "pairing" },
            allowFrom: { t: "array", of: { t: "string" }, default: [] },
            groupPolicy: { t: "enum", values: ["allowlist", "open", "off"], default: "allowlist" },
            groupAllowFrom: { t: "array", of: { t: "string" }, default: [] },
            mentionGated: { t: "bool", default: true },
          // Inbound media (P1 A5): photos are fetched for the vision turn,
          // everything else lands in <workspace>/media as a placeholder the
          // agent can fs_read on request. Cap = whole MB (their fractional
          // mediaMaxMb, rounded up for our int fields).
          mediaMaxMb: { t: "int", min: 1, max: 100, default: 20 },
            // false → save photos to media/ like documents, never attach images
            // to model turns (their text-only surface for vision-blind setups).
            vision: { t: "bool", default: true },
            // Bot-loop protection (P2 #17): refuse messages AUTHORED by bots
            // by default (their allowBots:false for Telegram), then bound
            // allowed bot pairs with the shared sliding-window guard below.
            allowBots: { t: "bool", default: false },
            botLoopProtection: {
              t: "object",
              default: {},
              fields: {
                enabled: { t: "bool", default: true },
                maxEventsPerWindow: { t: "int", min: 1, max: 1000, default: 20 },
                windowSeconds: { t: "int", min: 5, max: 3600, default: 60 },
                cooldownSeconds: { t: "int", min: 5, max: 86400, default: 60 },
              },
            },
            streaming: { t: "enum", values: ["off", "partial", "progress"], default: "progress" },
            batchMs: { t: "int", min: 0, max: 5000, default: 300 },
          },
        },
        // Shared channel defaults (their channels.defaults.* block); per-channel
        // keys override these key-by-key, then built-in defaults.
        defaults: {
          t: "object",
          default: {},
          fields: {
            botLoopProtection: {
              t: "object",
              default: {},
              fields: {
                enabled: { t: "bool", default: true },
                maxEventsPerWindow: { t: "int", min: 1, max: 1000, default: 20 },
                windowSeconds: { t: "int", min: 5, max: 3600, default: 60 },
                cooldownSeconds: { t: "int", min: 5, max: 86400, default: 60 },
              },
            },
          },
        },
      },
    },
    tools: {
      t: "object",
      default: {},
      fields: {
        fs: { t: "bool", default: true },
        memory: { t: "bool", default: true },
        web: {
          t: "object",
          default: {},
          fields: {
            fetch: { t: "bool", default: true },
            // web_search provider-managed backends (partial #9). Legacy bool:
            // search:false ⇒ enabled:false; search:true ⇒ enabled:true + auto-detect.
            search: {
              t: "object",
              default: {},
              fields: {
                enabled: { t: "bool", default: true },
                // "" = auto-detect (first ready provider by fixed order).
                provider: { t: "text", default: "" },
                maxResults: { t: "int", min: 1, max: 10, default: 5 },
                // 0 = bypass cache reads + writes entirely.
                cacheTtlMinutes: { t: "int", min: 0, max: 1440, default: 15 },
                brave: {
                  t: "object",
                  default: {},
                  fields: {
                    apiKey: { t: "text", default: "" },
                    baseUrl: { t: "text", default: "https://api.search.brave.com" },
                  },
                },
                perplexity: {
                  t: "object",
                  default: {},
                  fields: {
                    apiKey: { t: "text", default: "" },
                    baseUrl: { t: "text", default: "https://api.perplexity.ai" },
                  },
                },
                tavily: {
                  t: "object",
                  default: {},
                  fields: {
                    apiKey: { t: "text", default: "" },
                    baseUrl: { t: "text", default: "https://api.tavily.com" },
                  },
                },
                kimi: {
                  t: "object",
                  default: {},
                  fields: {
                    apiKey: { t: "text", default: "" },
                    // Empty ⇒ inherit models.providers.moonshot.baseUrl (region stays consistent).
                    baseUrl: { t: "text", default: "" },
                  },
                },
                // Key-free. Explicit opt-in only: never auto-selected.
                duckduckgo: { t: "object", default: {}, fields: { baseUrl: { t: "text", default: "https://html.duckduckgo.com" } } },
                // Key-free but self-hosted: usable only when a baseUrl is configured.
                searxng: { t: "object", default: {}, fields: { baseUrl: { t: "text", default: "" } } },
              },
            },
          },
        },
        exec: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: false },
            // Legacy: approvals:false maps to mode=full (kept working).
            approvals: { t: "bool", default: true },
            // deny | allowlist | ask | full — the exec policy mode (default ask).
            // Empty string = follow the legacy approvals bool (⇒ ask/full). Set in config
            // or via `sc approvals mode …`. We need "unset" as a third state, so the
            // enumeration itself is validated wherever it's written.
            mode: { t: "text", default: "" },
            // When zero approval surfaces are connected (cron, idle daemon):
            // where an ask verdict lands (default deny).
            askFallback: { t: "enum", values: ["deny", "allowlist", "full"], default: "deny" },
            // Never auto-allow inline-eval carriers (node -e, bash -c, awk…).
            strictInlineEval: { t: "bool", default: false },
            // stdin-safe bins allowed without prompting (profiles in exec-policy).
            safeBins: { t: "array", of: { t: "string" }, default: ["cut", "uniq", "head", "tail", "tr", "wc"] },
            safeBinTrustedDirs: { t: "array", of: { t: "string" }, default: ["/bin", "/usr/bin"] },
            // No time limits on the agent's work — this is only a safety cap
            // so a hung command cannot block a session forever (10 minutes).
            timeoutMs: { t: "int", min: 1000, max: 600000, default: 600000 },
          },
        },
      },
    },
    cron: {
      t: "object",
      default: {},
      fields: {
        enabled: { t: "bool", default: true },
        timezone: { t: "string", default: "local" },
      },
    },
    // Inbound HTTP webhooks (P1 A4) — a dedicated hook token, not the
    // gateway token; POST-only; disabled until enabled+token are both set.
    hooks: {
      t: "object",
      default: {},
      fields: {
        enabled: { t: "bool", default: false },
        token: { t: "string", default: "" },
        path: { t: "string", default: "/hooks" },
        allowRequestSessionKey: { t: "bool", default: false },
        mappings: {
          t: "record",
          default: {},
          of: {
            t: "object",
            fields: {
              action: { t: "enum", values: ["wake", "agent"], default: "agent" },
              text: { t: "string", default: "" },
              message: { t: "string", default: "" },
              sessionKey: { t: "string", default: "" },
            },
          },
        },
      },
    },
  },
};

/** Bot-pair sliding-window guard config (P2 #17) — same shape at channels.defaults and per-channel overrides. */
export interface BotLoopProtectionConfig {
  enabled: boolean;
  maxEventsPerWindow: number;
  windowSeconds: number;
  cooldownSeconds: number;
}

export interface SuparClawConfig {
  gateway: {
    port: number;
    bind: "loopback" | "lan";
    auth: { mode: "token" | "none"; token: string; loopbackBypass: boolean };
    controlUi: { enabled: boolean; basePath: string };
    allowedHosts: string[];
    allowedOrigins: string[];
    http: { endpoints: { chatCompletions: { enabled: boolean } } };
  };
  agents: {
    identity: { name: string; emoji: string; theme: string };
    defaults: {
      id: string;
      model: string;
      fallbacks: string[];
      maxToolIterations: number;
      contextBudgetChars: number;
      queueMode: "steer" | "followup";
      maxConcurrent: number;
      subagents: {
        maxConcurrent: number;
        model: string;
        thinking: string;
        maxDepth: number;
        delegationMode: "inherit" | "prefer" | "suggest";
      };
      reasoningEffort: "inherit" | "off" | "low" | "medium" | "high" | "xhigh" | "max";
      reasoningView: "on" | "off";
    };
  };
  providers: Record<
    string,
    {
      baseUrl: string;
      apiKey: string;
      headers: Record<string, string>;
      models: string[];
      authProfiles: string[];
      api: "openai-completions" | "ollama";
    }
  >;
  auth: { order: Record<string, string[]> };
  models: Record<
    string,
    {
      ref: string;
      label: string;
      enabled: boolean;
      contextWindow: number;
      maxTokens: number;
      temperature?: number;
      reasoningEffort: "inherit" | "off" | "low" | "medium" | "high" | "xhigh" | "max";
    }
  >;
  channels: {
    telegram: {
      enabled: boolean;
      token: string;
      dmPolicy: "pairing" | "open" | "allowlist";
      allowFrom: string[];
      groupPolicy: "allowlist" | "open" | "off";
      groupAllowFrom: string[];
      mentionGated: boolean;
      mediaMaxMb: number;
      vision: boolean;
      allowBots: boolean;
      botLoopProtection: BotLoopProtectionConfig;
      streaming: "off" | "partial" | "progress";
      batchMs: number;
    };
    defaults: { botLoopProtection: BotLoopProtectionConfig };
  };
  tools: {
    fs: boolean;
    memory: boolean;
    web: {
      fetch: boolean;
      search: {
        enabled: boolean;
        provider: string;
        maxResults: number;
        cacheTtlMinutes: number;
        brave: { apiKey: string; baseUrl: string };
        perplexity: { apiKey: string; baseUrl: string };
        tavily: { apiKey: string; baseUrl: string };
        kimi: { apiKey: string; baseUrl: string };
        duckduckgo: { baseUrl: string };
        searxng: { baseUrl: string };
      };
    };
    exec: {
      enabled: boolean;
      approvals: boolean;
      mode?: string;
      askFallback: "deny" | "allowlist" | "full";
      strictInlineEval: boolean;
      safeBins: string[];
      safeBinTrustedDirs: string[];
      timeoutMs: number;
    };
  };
  cron: { enabled: boolean; timezone: string };
  hooks: {
    enabled: boolean;
    token: string;
    path: string;
    allowRequestSessionKey: boolean;
    mappings: Record<string, { action: "wake" | "agent"; text: string; message: string; sessionKey: string }>;
  };
  messages: {
    queue: {
      mode: "steer" | "followup" | "collect" | "interrupt";
      cap: number;
      drop: "summarize" | "old" | "new";
      debounceMs: number;
      byChannel: Record<string, "steer" | "followup" | "collect" | "interrupt">;
    };
  };
  memory: { dreaming: { enabled: boolean; schedule: string } };
}

export function parseConfig(raw: unknown): { config: SuparClawConfig; errors: string[] } {
  // Legacy shape: tools.web.search was a bool; partial #9 turned it into the
  // provider block. Map it before validation (their doctor --fix auto-migration,
  // at load time so no config write is forced).
  const r = (raw ?? {}) as { tools?: { web?: { search?: unknown } } };
  if (typeof r.tools?.web?.search === "boolean") {
    (r as { tools: { web: { search: unknown } } }).tools.web.search = { enabled: r.tools.web.search };
  }
  const errors = validate(CONFIG_SCHEMA, raw ?? {});
  if (errors.length > 0) return { config: emptyConfig(), errors };
  return { config: applyDefaults(CONFIG_SCHEMA, raw ?? {}) as SuparClawConfig, errors: [] };
}

export type ExecMode = "deny" | "allowlist" | "ask" | "full";
export type ExecAskFallback = "deny" | "allowlist" | "full";

/** Effective exec mode: explicit mode wins; legacy approvals:false ⇒ full. */
export function execModeOf(exec: { approvals?: boolean; mode?: string }): ExecMode {
  const mode = exec.mode && exec.mode.trim() ? exec.mode.trim() : null;
  if (mode === "deny" || mode === "allowlist" || mode === "ask" || mode === "full") return mode;
  return exec.approvals === false ? "full" : "ask";
}

export function emptyConfig(): SuparClawConfig {
  return applyDefaults(CONFIG_SCHEMA, {}) as SuparClawConfig;
}

// ---------------------------------------------------------------------------
// Model profiles — curated entries from config.models (Settings → Models).
// ---------------------------------------------------------------------------

export interface ModelProfile {
  /** Local id (record key) — what sessions and the picker reference. */
  id: string;
  /** Wire ref sent to the provider. */
  ref: string;
  label: string;
  enabled: boolean;
  /** Native context window in tokens (0 = unknown). */
  contextWindow: number;
  /** Output cap for max_tokens (undefined = provider default). */
  maxTokens?: number;
  /** Sampling temperature (undefined = provider default). */
  temperature?: number;
  reasoningEffort: "inherit" | "off" | "low" | "medium" | "high" | "xhigh" | "max";
}

/** Configured profiles as a list; the record key is the profile id. */
export function modelProfiles(config: SuparClawConfig): ModelProfile[] {
  return Object.entries(config.models ?? {}).map(([id, m]) => ({
    id,
    ref: m.ref,
    label: m.label || m.ref || id,
    enabled: m.enabled !== false,
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ? m.maxTokens : undefined,
    temperature: typeof m.temperature === "number" ? m.temperature : undefined,
    reasoningEffort: m.reasoningEffort ?? "inherit",
  }));
}

/**
 * Resolve a requested model ("gemini-deep" profile id, or a bare
 * "provider/model" ref) to a full profile. Precedence: exact profile id, then
 * a lone accepted profile on that ref, then a synthesized passthrough profile
 * so unconfigured refs keep working exactly as before.
 */
export function modelProfile(config: SuparClawConfig, requested: string): ModelProfile {
  const all = modelProfiles(config);
  const req = requested.trim();
  if (!req) {
    // No explicit request — resolve the configured default through the same
    // rules (it may itself name a profile id).
    const def = (config.agents.defaults.model ?? "").trim();
    if (def) return modelProfile(config, def);
    return {
      id: "",
      ref: "",
      label: "",
      enabled: true,
      contextWindow: 0,
      reasoningEffort: "inherit",
    };
  }
  const byId = all.find((m) => m.id === req);
  if (byId) return byId;
  const byRef = all.filter((m) => m.ref === req && m.enabled);
  if (byRef.length === 1) return byRef[0] as ModelProfile;
  return {
    id: req,
    ref: req,
    label: req,
    enabled: true,
    contextWindow: 0,
    reasoningEffort: "inherit",
  };
}