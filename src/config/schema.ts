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
            streaming: { t: "enum", values: ["off", "partial", "progress"], default: "progress" },
            batchMs: { t: "int", min: 0, max: 5000, default: 300 },
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
        web: { t: "object", default: {}, fields: { fetch: { t: "bool", default: true }, search: { t: "bool", default: true } } },
        exec: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: false },
            approvals: { t: "bool", default: true },
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
  },
};

export interface SuparClawConfig {
  gateway: {
    port: number;
    bind: "loopback" | "lan";
    auth: { mode: "token" | "none"; token: string; loopbackBypass: boolean };
    controlUi: { enabled: boolean; basePath: string };
    allowedHosts: string[];
    allowedOrigins: string[];
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
    { baseUrl: string; apiKey: string; headers: Record<string, string>; models: string[]; authProfiles: string[] }
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
      streaming: "off" | "partial" | "progress";
      batchMs: number;
    };
  };
  tools: {
    fs: boolean;
    memory: boolean;
    web: { fetch: boolean; search: boolean };
    exec: { enabled: boolean; approvals: boolean; timeoutMs: number };
  };
  cron: { enabled: boolean; timezone: string };
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
  const errors = validate(CONFIG_SCHEMA, raw ?? {});
  if (errors.length > 0) return { config: emptyConfig(), errors };
  return { config: applyDefaults(CONFIG_SCHEMA, raw ?? {}) as SuparClawConfig, errors: [] };
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