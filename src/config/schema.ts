// Hand-rolled strict config schema: no zod, no silent drift, precise error paths.

// --- heartbeat (their gateway/heartbeat verbatim prompt) ---
const DEFAULT_HEARTBEAT_PROMPT =
  "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";

type SchemaKind =
  | { t: "string"; min?: number; max?: number }
  | { t: "text" }
  | { t: "int"; min?: number; max?: number }
  | { t: "number" }
  | { t: "bool" }
  | { t: "any" }
  | { t: "enum"; values: readonly string[] }
  | { t: "array"; of: SchemaNode }
  | { t: "record"; of: SchemaNode }
  | { t: "object"; fields: Record<string, SchemaNode> };

/** Every node may carry a default (filled by applyDefaults) and may be optional.
 *
 *  `hidden` is a presentation hint only: the All-settings form skips hidden leaves
 *  (a 32,000-character avatar data URL does not belong in a textbox), while
 *  validate() and applyDefaults() treat the node like any other. */
export type SchemaNode = SchemaKind & { default?: unknown; optional?: boolean; hidden?: boolean };

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
      if (node.max !== undefined && value.length > node.max) {
        return [`${path}: must be at most ${node.max} characters`];
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
            // The agent's portrait, as a bounded data URL (`data:image/png;base64,…`).
            // It lives in the config rather than the state dir so the face travels
            // with `sc config`, backups and restores; the cap keeps config.json5
            // small (32 KB of base64 is ~24 KB of pixels — a full 128 px avatar).
            // `hidden` keeps the All-settings form out of a 32,000-character textbox.
            avatar: { t: "string", default: "", max: 32000, hidden: true },
          },
        },
        defaults: {
          t: "object",
          default: {},
          fields: {
            id: { t: "string", default: "main" },
            model: { t: "string", default: "" },
            fallbacks: { t: "array", of: { t: "string" }, default: [] },
            // The model used for short internal tasks, starting with the name a
            // new session gives itself (OpenClaw's utilityModel, models.md:69).
            // "" = the default model above, so nothing changes until you pick
            // something; a cheap fast model is the point of the setting.
            utilityModel: { t: "string", default: "" },
            // No upper bound on purpose: how many tool rounds a task needs is a
            // property of the task, not a number we can guess. 0 = no ceiling
            // (the default since Task 38 — the old default of 12 stopped real
            // work mid-task). Runaway turns are stopped by content (the loop
            // guard) and by the operator's stop button, never by a count.
            maxToolIterations: { t: "int", min: 0, default: 0 },
            // Legacy fallback only. The history budget is derived from the
            // model's context window (Settings → Models → Tune) — see
            // src/agent/context-budget.ts. This value is used only when no model
            // in the chain declares a window; `hidden` keeps it out of the
            // All-settings form so it cannot look like a live knob.
            contextBudgetChars: { t: "int", min: 2000, default: 200000, hidden: true },
            // Legacy alias — superseded by messages.queue.mode, which is the only
            // live control (Gateway → message queue). Kept so old configs still
            // validate; parseConfig() copies the value across when the new key was
            // never written, and the new key wins when both exist. `hidden` keeps a
            // dead-looking knob out of the All-settings form.
            queueMode: { t: "enum", values: ["steer", "followup"], default: "followup", hidden: true },
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
            // Default reply-usage mode when a session has no /usage override
            // (their usage-tracking default): off hides the footer entirely,
            // tokens appends in/out, full adds model + context + cache,
            // cost adds $ via the per-model pricing card (falls back to
            // tokens when the model has no pricing configured).
            usage: { t: "enum", values: ["off", "tokens", "full", "cost"], default: "tokens" },
        // System-owned heartbeat cadence (P3 #26 — their gateway/heartbeat
        // contract): periodic turns in the main session by default.
        heartbeat: {
          t: "object",
          default: {},
          fields: {
            every: { t: "string", default: "30m" },
            model: { t: "string", default: "" },
            lightContext: { t: "bool", default: false },
            isolatedSession: { t: "bool", default: false },
            target: { t: "enum", values: ["owner", "last", "none"], default: "owner" },
            to: { t: "string", default: "" },
            prompt: { t: "string", default: DEFAULT_HEARTBEAT_PROMPT },
            timeoutSeconds: { t: "int", min: 0, max: 86400, default: 0 },
            activeHours: {
              t: "object",
              default: {},
              fields: {
                start: { t: "string", default: "" },
                end: { t: "string", default: "" },
                timezone: { t: "string", default: "" },
              },
            },
          },
        },
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
    // P3 #19 — their session.maintenance retention controls: age archiving,
    // unarchived-row cap, and a physical disk budget.
    session: {
      t: "object",
      default: {},
      fields: {
        maintenance: {
          t: "object",
          default: {},
          fields: {
            // enforce (default) applies cleanup; warn only reports it.
            mode: { t: "enum", values: ["enforce", "warn"], default: "enforce" },
            // Age cutoff ("30d" default): eligible durable sessions archive
            // in place with identity + history intact. "0"/false disables.
            pruneAfter: { t: "string", default: "30d" },
            // Cap on UNARCHIVED rows (their 5000); archived rows don't count.
            maxEntries: { t: "int", min: 0, default: 5000 },
            // Optional recency shield (e.g. "7d"); "" disables (their unset).
            preserveRecent: { t: "string", default: "" },
            // Physical db (+wal) budget, their 10gb; "0"/"" disables.
            maxDiskBytes: { t: "string", default: "10gb" },
            // Post-budget-cleanup target; "" = 80% of maxDiskBytes.
            highWaterBytes: { t: "string", default: "" },
          },
        },
      },
    },
    // Task 30 — attachments on disk (`<workspace>/media`). 0 keeps them
    // forever, which is the default: silently deleting the only copy of a
    // document someone sent is worse than disk growth, and a transcript that
    // still shows a file would break. Turn it on and the gateway sweeps at
    // startup + hourly; `sc media prune` does the same by hand.
    media: {
      t: "object",
      default: {},
      fields: {
        retentionDays: { t: "int", min: 0, default: 0 },
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
          // Per-model price card in USD per 1M tokens (their providers/models
          // price fields). Empty/zeros → cost footer reports "no pricing" and
          // falls back to pure token counts (their /usage tokens behavior).
          pricing: {
            t: "object",
            default: {},
            fields: {
              input: { t: "number", default: 0 },
              cachedIn: { t: "number", default: 0 },
              output: { t: "number", default: 0 },
            },
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
            // http(s)/socks proxy for api.telegram.org — required where the
            // carrier blocks Telegram (their per-channel proxy field).
            proxy: { t: "string", default: "" },
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
            // Task 32 — what the chat shows while a turn runs (their four modes,
            // messaging.md:71). "progress" (default) keeps ONE editable status
            // draft and sends the final answer as its own message; "partial" and
            // "block" edit the answer into that draft instead; "off" posts no
            // draft at all and keeps tool chatter out of the chat entirely.
            streaming: { t: "enum", values: ["off", "partial", "block", "progress"], default: "progress" },
            // Their streaming.progress.toolProgress (default false): the quiet
            // draft shows the stage, not a rolling log of tool names.
            toolProgress: { t: "bool", default: false },
            batchMs: { t: "int", min: 0, max: 5000, default: 300 },
            // Task 27: the `/` menu lives on the bot token, so a token that ran
            // another build keeps showing that build's commands. We replace it
            // on every start unless the operator curates it in BotFather.
            commandsMenu: { t: "bool", default: true },
            // Typing indicator (P3 #24 — their agents.defaults.typingMode /
            // typingIntervalSeconds life-cycle: DMs+mentions immediate
            // ("instant"), first reasoning/tool under "thinking", first
            // user-visible text/tool under "message", "never" off; the
            // refresh rides a keepalive (their 6s) with a 2-minute TTL).
            typing: {
              t: "object",
              default: {},
              fields: {
                mode: { t: "enum", values: ["instant", "thinking", "message", "never"], default: "instant" },
                intervalSeconds: { t: "int", min: 1, max: 30, default: 6 },
              },
            },
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
        // Tool-use loop detection (P2 #16). enabled:false switches off the
        // rolling detectors; the 3-identical-errors safety breaker is always
        // on (their rule).
        loopDetection: {
          t: "object",
          default: {},
          fields: {
            // Off by default, like upstream (loop-detection.md:79). This is the
            // ROLLING layer — it compares results, so it also fires on repeated
            // *successful* calls (three identical `cron_list` reads killed a
            // working turn). The always-on guard below still stops a tool that
            // fails the same way three times, which is the case that matters.
            enabled: { t: "bool", default: false },
          },
        },
        // P3 #22 — media understanding (their tools.media): capability list of
        // provider/CLI model entries + per-capability controls.
        media: {
          t: "object",
          default: {},
          fields: {
            concurrency: { t: "int", min: 1, default: 2 },
            models: {
              t: "array",
              default: [],
              of: {
                t: "object",
                default: {},
                fields: {
                  type: { t: "enum", values: ["provider", "cli"], default: "provider" },
                  provider: { t: "string", default: "" },
                  model: { t: "string", default: "" },
                  command: { t: "string", default: "" },
                  args: { t: "array", of: { t: "string" }, default: [] },
                  prompt: { t: "string", default: "" },
                  maxChars: { t: "int", min: 0, default: 0 },
                  maxBytes: { t: "int", min: 0, default: 0 },
                  timeoutSeconds: { t: "int", min: 0, default: 0 },
                  language: { t: "string", default: "" },
                  capabilities: { t: "array", of: { t: "string" }, default: [] },
                },
              },
            },
            image: {
              t: "object",
              default: {},
              fields: {
                enabled: { t: "bool", default: true },
                preferredModel: { t: "string", default: "" },
                prompt: { t: "string", default: "" },
                maxChars: { t: "int", min: 0, default: 500 },
                maxBytes: { t: "int", min: 0, default: 10485760 },
                timeoutSeconds: { t: "int", min: 0, default: 60 },
                attachments_all: { t: "bool", default: false },
              },
            },
            audio: {
              t: "object",
              default: {},
              fields: {
                enabled: { t: "bool", default: true },
                preferredModel: { t: "string", default: "" },
                maxBytes: { t: "int", min: 0, default: 20971520 },
                timeoutSeconds: { t: "int", min: 0, default: 60 },
                language: { t: "string", default: "" },
                echoTranscript: { t: "bool", default: false },
                echoFormat: { t: "string", default: "📝 \"{transcript}\"" },
              },
            },
            pdf: {
              t: "object",
              default: {},
              fields: {
                enabled: { t: "bool", default: true },
                maxBytes: { t: "int", min: 0, default: 10485760 },
                maxChars: { t: "int", min: 0, default: 4000 },
                timeoutSeconds: { t: "int", min: 0, default: 60 },
              },
            },
          },
        },
        // P3 #23 — Code Mode sandboxed execution (their tools.codeMode).
        // enabled: false/true/"auto"; "auto" engages only for preferred models.
        codeMode: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "enum", values: ["false", "true", "auto"], default: "auto" },
            executor: { t: "enum", values: ["node", "quickjs"], default: "node" },
            timeoutMs: { t: "int", min: 100, max: 60000, default: 10000 },
            maxCodeChars: { t: "int", min: 1024, default: 32768 },
            maxOutputBytes: { t: "int", min: 1024, max: 10485760, default: 65536 },
            maxPendingToolCalls: { t: "int", min: 1, max: 128, default: 16 },
            directOnly: { t: "array", of: { t: "string" }, default: [] },
          },
        },
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
            // On by default, and approved without a prompt: the operator asked
            // for an agent that can act on its own. `sc approvals mode
            // deny|allowlist|ask|full` or mode in config still overrides it.
            enabled: { t: "bool", default: true },
            // Legacy: approvals:false maps to mode=full (kept working). Ignored
            // while `mode` names a policy.
            approvals: { t: "bool", default: true },
            // deny | allowlist | ask | full — the exec policy mode (default ask).
            // Empty string = follow the legacy approvals bool (⇒ ask/full). Set in config
            // or via `sc approvals mode …`. We need "unset" as a third state, so the
            // enumeration itself is validated wherever it's written.
            // Default "full": no per-call prompt. The mode check in
            // evaluateExec() returns allow before allowlist/inline-eval
            // analysis, so this also covers cron/webhook sessions.
            mode: { t: "text", default: "full" },
            // When zero approval surfaces are connected (cron, idle daemon):
            // where an ask verdict lands (default deny).
            askFallback: { t: "enum", values: ["deny", "allowlist", "full"], default: "deny" },
            // Never auto-allow inline-eval carriers (node -e, bash -c, awk…).
            strictInlineEval: { t: "bool", default: false },
            // stdin-safe bins allowed without prompting (profiles in exec-policy).
            safeBins: { t: "array", of: { t: "string" }, default: ["cut", "uniq", "head", "tail", "tr", "wc"] },
            safeBinTrustedDirs: { t: "array", of: { t: "string" }, default: ["/bin", "/usr/bin"] },
            // No time limits on the agent's work — this is only a safety cap
            // so a hung command cannot block a session forever. 30 minutes
            // (Task 38): `npm install`, a test suite or a build on a phone is
            // routinely longer than the old 10.
            timeoutMs: { t: "int", min: 1000, max: 1800000, default: 1800000 },
            // Execution sandbox (P2 #9; their tools exec sandbox at our
            // scale): "off" runs plain (legacy), "strict" confines the child
            // to a scrubbed env (PATH of trusted dirs, HOME=workspace),
            // prlimit resource caps when the binary exists (2G address
            // space, 256 procs, 1024 fds), and — when sandboxProot is on and
            // a proot binary is found (Termux) — a real filesystem jail
            // (workspace bound rw, / and system dirs read-only).
            sandbox: { t: "enum", values: ["off", "strict"], default: "off" },
            sandboxProot: { t: "bool", default: false },
            // Unattended sources (cron jobs, inbound webhooks) have nobody to
            // ask: how an "ask" exec verdict resolves there (P2 #10; their
            // unattended exec policy at our scale). deny = decline loudly
            // (default), allowlist = auto-allow ONLY when every segment is a
            // safe bin (else the same loud decline), all = auto-allow.
            // Every auto-decision is audited to the log and the transcript.
            unattended: { t: "enum", values: ["deny", "allowlist", "all"], default: "deny" },
          },
        },
      },
    },
    // GitHub add-on (Task 35). Credentials are NOT here on purpose: a token in
    // the config file is a token in every backup and every `sc doctor` dump. The
    // token comes from GITHUB_TOKEN/GH_TOKEN, an existing `gh` login, or the
    // device flow (stored with 0600 in the state dir).
    addons: {
      t: "object",
      default: {},
      fields: {
        github: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: false },
            // Your own GitHub OAuth app's public client id. Device login needs
            // no secret; it does need this id. Empty = use the `gh` login only.
            clientId: { t: "text", default: "" },
            // GitHub Enterprise host; github.com by default.
            host: { t: "text", default: "github.com" },
          },
        },
      },
    },
    cron: {
      t: "object",
      default: {},
      fields: {
        enabled: { t: "bool", default: true },
        // Global schedule zone for jobs without their own --tz (their
        // automation cron-jobs cron.timezone; "local" = host zone).
        timezone: { t: "string", default: "local" },
        // Result delivery defaults (their jobs delivery mode/to/suppressEmpty):
        // per-job columns win; announce posts the final text to `to`,
        // webhook POSTs a JSON payload there, none keeps it store-only.
        delivery: {
          t: "object",
          default: {},
          fields: {
            mode: { t: "enum", values: ["none", "announce", "webhook"], default: "none" },
            to: { t: "string", default: "" },
            suppressEmpty: { t: "bool", default: true },
          },
        },
        // Consecutive-failure notifier (their failure-alerts/notify shape):
        // alert the operator after `threshold` back-to-back job errors, at
        // most once per `cooldownMinutes` per job.
        failureAlerts: {
          t: "object",
          default: {},
          fields: {
            enabled: { t: "bool", default: true },
            threshold: { t: "int", min: 1, max: 50, default: 2 },
            cooldownMinutes: { t: "int", min: 1, max: 10080, default: 60 },
            to: { t: "string", default: "" },
          },
        },
        // SSRF allowlist for webhook delivery and hook targets (their
        // webhookSsrfPolicy.allowedHostnames): entries escape the
        // https+public-address rule (corporate relays/localhost dev sinks).
        webhookAllowHostnames: { t: "array", of: { t: "string" }, default: [] },
      },
    },
    // IMAP email trigger (P3 #25 — their automation/imap plugin, polling
    // lane): per-account INBOX watchers dispatching admitted mail to
    // hook:imap:<account>:<uidvalidity>:<uid> isolated reader runs.
    imap: {
      t: "object",
      default: {},
      fields: {
        enabled: { t: "bool", default: false },
        accounts: {
          t: "record",
          default: {},
          of: {
            t: "object",
            default: {},
            fields: {
              enabled: { t: "bool", default: true },
              host: { t: "string", default: "" },
              port: { t: "int", min: 1, max: 65535, default: 993 },
              secure: { t: "bool", default: true },
              user: { t: "string", default: "" },
              password: { t: "string", default: "" },
              passwordEnv: { t: "string", default: "" },
              mailbox: { t: "string", default: "INBOX" },
              watch: {
                t: "object",
                default: {},
                fields: {
                  mode: { t: "enum", values: ["auto", "interval", "idle"], default: "auto" },
                  pollSeconds: { t: "int", min: 15, max: 86400, default: 60 },
                },
              },
              allowedSenders: { t: "array", of: { t: "string" }, default: [] },
              addressTokens: {
                t: "array",
                default: [],
                of: {
                  t: "object",
                  default: {},
                  fields: {
                    token: { t: "string", default: "" },
                    senders: { t: "array", of: { t: "string" }, default: [] },
                  },
                },
              },
              senderAuth: {
                t: "object",
                default: {},
                fields: {
                  // DEVIATION (their floor defaults to "verified" via bundled
                  // mailauth): without a DMARC verifier, "unverified" is the
                  // only functioning floor — see src/automation/imap.ts.
                  min: { t: "enum", values: ["verified", "asserted", "unverified", "mutable"], default: "unverified" },
                  trustedAuthservIds: { t: "array", of: { t: "string" }, default: [] },
                  acceptTrustedAuthservId: { t: "bool", default: false },
                },
              },
              deliver: { t: "bool", default: false },
              to: { t: "string", default: "" },
              includeBody: { t: "bool", default: true },
              maxBytes: { t: "int", min: 1000, max: 1048576, default: 20000 },
            },
          },
        },
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

/** USD per 1M tokens (their providers/models price card). Zeros ⇒ unknown. */
export interface ModelPricing {
  input: number;
  cachedIn: number;
  output: number;
}

export type UsageMode = "off" | "tokens" | "full" | "cost";

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
    identity: { name: string; emoji: string; theme: string; avatar: string };
    defaults: {
      id: string;
      model: string;
      fallbacks: string[];
      /** Model for short internal tasks (session naming). "" = the default. */
      utilityModel: string;
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
      usage: UsageMode;
      // P3 #26 — system-owned heartbeat cadence (their agents.defaults.heartbeat).
      heartbeat: {
        every: string;
        model: string;
        lightContext: boolean;
        isolatedSession: boolean;
        target: "owner" | "last" | "none";
        to: string;
        prompt: string;
        timeoutSeconds: number;
        activeHours: { start: string; end: string; timezone: string };
      };
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
      pricing: ModelPricing;
    }
  >;
  /** GitHub add-on (Task 35) — never holds a token, only configuration. */
  addons: {
    github: {
      enabled: boolean;
      clientId: string;
      host: string;
    };
  };
  channels: {
    telegram: {
      enabled: boolean;
      token: string;
      proxy: string;
      dmPolicy: "pairing" | "open" | "allowlist";
      allowFrom: string[];
      groupPolicy: "allowlist" | "open" | "off";
      groupAllowFrom: string[];
      mentionGated: boolean;
      mediaMaxMb: number;
      vision: boolean;
      allowBots: boolean;
      botLoopProtection: BotLoopProtectionConfig;
      streaming: "off" | "partial" | "block" | "progress";
      /** Show tool names in the status draft (default false: stage only). */
      toolProgress: boolean;
      batchMs: number;
      /** Replace the bot's stored `/` menu with ours on start (Task 27). */
      commandsMenu: boolean;
      // P3 #24 — typing indicator (their typingMode/typingIntervalSeconds).
      typing: { mode: "instant" | "thinking" | "message" | "never"; intervalSeconds: number };
    };
    defaults: { botLoopProtection: BotLoopProtectionConfig };
  };
  tools: {
    fs: boolean;
    memory: boolean;
    loopDetection: { enabled: boolean };
    // P3 #22 — media understanding (their tools.media).
    media: {
      concurrency: number;
      models: {
        type: "provider" | "cli";
        provider: string;
        model: string;
        command: string;
        args: string[];
        prompt: string;
        maxChars: number;
        maxBytes: number;
        timeoutSeconds: number;
        language: string;
        capabilities: string[];
      }[];
      image: {
        enabled: boolean;
        preferredModel: string;
        prompt: string;
        maxChars: number;
        maxBytes: number;
        timeoutSeconds: number;
        attachments_all: boolean;
      };
      audio: {
        enabled: boolean;
        preferredModel: string;
        maxBytes: number;
        timeoutSeconds: number;
        language: string;
        echoTranscript: boolean;
        echoFormat: string;
      };
      pdf: { enabled: boolean; maxBytes: number; maxChars: number; timeoutSeconds: number };
    };
    // P3 #23 — Code Mode (their tools.codeMode).
    codeMode: {
      enabled: "false" | "true" | "auto";
      executor: "node" | "quickjs";
      timeoutMs: number;
      maxCodeChars: number;
      maxOutputBytes: number;
      maxPendingToolCalls: number;
      directOnly: string[];
    };
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
      sandbox: "off" | "strict";
      sandboxProot: boolean;
      unattended: "deny" | "allowlist" | "all";
    };
  };
  cron: {
    enabled: boolean;
    timezone: string;
    delivery: { mode: "none" | "announce" | "webhook"; to: string; suppressEmpty: boolean };
    failureAlerts: { enabled: boolean; threshold: number; cooldownMinutes: number; to: string };
    webhookAllowHostnames: string[];
  };
  // P3 #25 — IMAP email trigger (their automation/imap).
  imap: {
    enabled: boolean;
    accounts: Record<
      string,
      {
        enabled: boolean;
        host: string;
        port: number;
        secure: boolean;
        user: string;
        password: string;
        passwordEnv: string;
        mailbox: string;
        watch: { mode: "auto" | "interval" | "idle"; pollSeconds: number };
        allowedSenders: string[];
        addressTokens: { token: string; senders: string[] }[];
        senderAuth: { min: "verified" | "asserted" | "unverified" | "mutable"; trustedAuthservIds: string[]; acceptTrustedAuthservId: boolean };
        deliver: boolean;
        to: string;
        includeBody: boolean;
        maxBytes: number;
      }
    >;
  };
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
  /** Attachment retention (Task 30); 0 = keep forever. */
  media: { retentionDays: number };
  // P3 #19: retention controls (their session.maintenance).
  session: {
    maintenance: {
      mode: "enforce" | "warn";
      pruneAfter: string;
      maxEntries: number;
      preserveRecent: string;
      maxDiskBytes: string;
      highWaterBytes: string;
    };
  };
}

export function parseConfig(raw: unknown): { config: SuparClawConfig; errors: string[] } {
  // Legacy shape: tools.web.search was a bool; partial #9 turned it into the
  // provider block. Map it before validation (their doctor --fix auto-migration,
  // at load time so no config write is forced).
  const r = (raw ?? {}) as { tools?: { web?: { search?: unknown } } };
  if (typeof r.tools?.web?.search === "boolean") {
    (r as { tools: { web: { search: unknown } } }).tools.web.search = { enabled: r.tools.web.search };
  }
  // Migration: agents.defaults.queueMode ("steer" | "followup") was superseded by
  // messages.queue.mode (four values), which is the one the loop reads. Carry an
  // old value across when the new key was never written — otherwise removing the
  // control from Settings would silently change what an old config does. When both
  // are present the new section wins, exactly as its comment claims.
  const legacyQueue = (r as { agents?: { defaults?: { queueMode?: unknown } } }).agents?.defaults?.queueMode;
  if (legacyQueue !== undefined) {
    if (legacyQueue === "steer" || legacyQueue === "followup") {
      const withQueue = r as { messages?: { queue?: { mode?: unknown } } };
      if (withQueue.messages?.queue?.mode === undefined) {
        withQueue.messages = {
          ...(withQueue.messages ?? {}),
          queue: { ...(withQueue.messages?.queue ?? {}), mode: legacyQueue },
        };
      }
    }
    // Drop the leaf either way: it is `hidden` now, so nothing in Settings can
    // show it and a stale or misspelled value must not fail the whole load with
    // an error about a setting the UI no longer offers.
    const defaults = (r as { agents?: { defaults?: Record<string, unknown> } }).agents?.defaults;
    if (defaults) delete defaults["queueMode"];
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
  pricing?: ModelPricing;
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
    pricing: m.pricing,
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