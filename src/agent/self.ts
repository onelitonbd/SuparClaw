// Self-knowledge (Task 26).
//
// Two gaps this closes:
//
//   1. The prompt said what the agent CAN do (tools, surfaces, skills) but not
//      what it is currently SET TO. Asked "what model are you on?" it could only
//      guess from the conversation.
//   2. Nothing let it change a setting. `exec` + `fs_write` could hand-edit
//      config.json5 — unvalidated, without hot-applying, and reading secrets on
//      the way.
//
// OpenClaw's equivalent is `/config set|unset` in chat (gated by
// `commands.config` and per-channel `configWrites`). At our scale the same job
// is a tool over the config service the Settings UI already uses:
//
//   prompt facts  →  settings tool  →  ConfigService.setPath (validated)
//                 →  service.applyConfig() (live)  →  next turn states it
//
// Safety rules, all intentional:
//   - an EXACT allowlist, because ConfigService.setPath happily creates unknown
//     leaves and the caster can then drop them (a typo would "succeed").
//   - every write is read back before we call it done.
//   - secret paths are refused before they can reach a tool result, which would
//     persist them in the transcript.
//   - operator-only keys (gateway/auth/network) name the Settings page instead
//     of failing vaguely.

import type { ConfigService } from "../config/load.js";
import type { SuparClawConfig } from "../config/schema.js";
import { execModeOf } from "../config/schema.js";
import { canonicalModelRef, validateModelRef } from "../config/providers.js";

export type SettingType = "string" | "number" | "boolean" | "string[]" | "enum";

export interface SettingSpec {
  path: string;
  label: string;
  type: SettingType;
  /** Allowed values for `enum`. */
  values?: string[];
}

/**
 * The chat-changeable settings. Deliberately a leaf allowlist: no prefixes, no
 * wildcards, so an unknown path is a refusal rather than a silent no-op.
 */
export const MUTABLE_SETTINGS: SettingSpec[] = [
  { path: "agents.identity.name", label: "the name you introduce yourself with", type: "string" },
  { path: "agents.identity.emoji", label: "your picked emoji", type: "string" },
  {
    path: "agents.defaults.model",
    label: "the model every chat starts on (a curated profile id or provider/model)",
    type: "string",
  },
  { path: "agents.defaults.fallbacks", label: "models tried in order when the first fails", type: "string[]" },
  {
    path: "agents.defaults.reasoningEffort",
    label: "how hard you think before answering",
    type: "enum",
    values: ["inherit", "off", "low", "medium", "high", "xhigh", "max"],
  },
  {
    path: "agents.defaults.reasoningView",
    label: "whether thinking is shown in the transcript",
    type: "enum",
    values: ["on", "off"],
  },
  {
    path: "agents.defaults.usage",
    label: "the per-reply usage footer",
    type: "enum",
    values: ["off", "tokens", "full", "cost"],
  },
  {
    path: "agents.defaults.queueMode",
    label: "how messages that arrive mid-run are handled",
    type: "enum",
    values: ["steer", "followup"],
  },
  { path: "agents.defaults.maxToolIterations", label: "tool rounds allowed per turn", type: "number" },
  { path: "agents.defaults.contextBudgetChars", label: "prompt character budget", type: "number" },
  { path: "tools.exec.enabled", label: "whether you may run commands", type: "boolean" },
  {
    path: "tools.exec.mode",
    label: "how exec is gated",
    type: "enum",
    values: ["deny", "allowlist", "ask", "full"],
  },
  { path: "tools.exec.approvals", label: "the legacy approvals flag behind the exec mode", type: "boolean" },
  {
    path: "channels.telegram.enabled",
    label: "whether Telegram is on (it still needs a token in Settings → Channels)",
    type: "boolean",
  },
  { path: "cron.enabled", label: "whether scheduled jobs run", type: "boolean" },
  { path: "cron.timezone", label: "the zone schedules are read in", type: "string" },
  { path: "memory.dreaming.enabled", label: "whether the nightly memory curating runs", type: "boolean" },
];

export function settingSpec(path: string): SettingSpec | undefined {
  return MUTABLE_SETTINGS.find((s) => s.path === path);
}

/** Secret-bearing leaves: never readable, never writable, never quoted back. */
export function isSecretPath(path: string): boolean {
  return /(apikey|token|secret|password|authorization|headers)/i.test(path);
}

/** Which Settings page owns an operator-only key. */
function operatorHint(path: string): string {
  if (path.startsWith("gateway.auth") || path.startsWith("gateway.allowed")) return "Settings → Gateway";
  if (path.startsWith("gateway.")) return "Settings → Gateway";
  if (path.startsWith("providers.") || path.startsWith("models.")) return "Settings → Models";
  if (path.startsWith("channels.")) return "Settings → Channels";
  if (path.startsWith("imap.") || path.startsWith("hooks.")) return "Settings → Config";
  if (path.startsWith("tools.web") || path.startsWith("tools.media")) return "Settings → Tools";
  return "Settings";
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Turn a tool argument into the type the config expects, or explain why not. */
export function coerceSetting(spec: SettingSpec, value: unknown): CoerceResult {
  if (spec.type === "enum") {
    const v = typeof value === "string" ? value.trim() : value;
    if (typeof v !== "string" || !(spec.values ?? []).includes(v)) {
      return { ok: false, error: `${spec.path} must be one of ${(spec.values ?? []).join(", ")}` };
    }
    return { ok: true, value: v };
  }
  if (spec.type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "false") return { ok: true, value: value === "true" };
    return { ok: false, error: `${spec.path} must be true or false` };
  }
  if (spec.type === "number") {
    const n =
      typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `${spec.path} must be a number` };
    return { ok: true, value: n };
  }
  if (spec.type === "string[]") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, error: `${spec.path} must be a list of strings` };
    }
    return { ok: true, value: value.map((v) => v.trim()).filter((v) => v.length > 0) };
  }
  if (typeof value !== "string") return { ok: false, error: `${spec.path} must be a string` };
  return { ok: true, value: value.trim() };
}

/**
 * A model reference keeps the Settings UI's rules: a curated profile id is
 * written as-is (the loop resolves it), anything else is canonicalized and
 * validated against the configured providers.
 */
function normalizeModelRef(
  config: SuparClawConfig,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "a model cannot be empty — use a profile id or \"provider/model\"" };
  }
  if (config.models?.[trimmed]) return { ok: true, value: trimmed };
  const ref = canonicalModelRef(config, trimmed) ?? trimmed;
  const invalid = validateModelRef(config, ref);
  if (invalid) return { ok: false, error: invalid };
  return { ok: true, value: ref };
}

export type SettingRead = { ok: true; value: unknown } | { ok: false; error: string };

/** The control surface handed to the `settings` tool and to tests. */
export interface SettingsCtl {
  /** Where the live configuration is stored (shown in the prompt). */
  path: string;
  specs(): SettingSpec[];
  get(path: string): SettingRead;
  set(path: string, value: unknown): SettingRead;
}

export interface ConfigLike {
  readonly path: string;
  readonly current: SuparClawConfig;
  get(path: string): unknown;
  setPath(path: string, value: unknown): { ok: boolean; errors: string[] };
}

/**
 * Build the tool's control surface over the same ConfigService the Settings UI
 * writes through. `apply` is the service's live reload (model, channels, cron).
 */
export function settingsCtlFrom(config: ConfigLike, apply: () => void): SettingsCtl {
  const writable = MUTABLE_SETTINGS.map((s) => s.path).join(", ");

  const get = (path: string): SettingRead => {
    const key = path.trim();
    if (!key) return { ok: false, error: "path is required" };
    if (isSecretPath(key)) return { ok: false, error: `"${key}" is operator-only (secrets)` };
    const value = config.get(key);
    if (value === undefined) {
      return { ok: false, error: `"${key}" is not set in this configuration — ${operatorHint(key)}` };
    }
    return { ok: true, value };
  };

  const set = (path: string, raw: unknown): SettingRead => {
    const key = path.trim();
    if (!key) return { ok: false, error: "path is required" };
    if (isSecretPath(key)) return { ok: false, error: `"${key}" is operator-only (secrets)` };
    const spec = settingSpec(key);
    if (!spec) {
      return {
        ok: false,
        error: `"${key}" is not changeable from chat — use ${operatorHint(key)}. Writable: ${writable}`,
      };
    }
    const coerced = coerceSetting(spec, raw);
    if (!coerced.ok) return coerced;

    let value = coerced.value;
    if (key === "agents.defaults.model") {
      const norm = normalizeModelRef(config.current, String(value));
      if (!norm.ok) return norm;
      value = norm.value;
    } else if (key === "agents.defaults.fallbacks") {
      const list: string[] = [];
      for (const entry of value as string[]) {
        const norm = normalizeModelRef(config.current, entry);
        if (!norm.ok) return norm;
        list.push(norm.value);
      }
      value = list;
    }

    const res = config.setPath(key, value);
    if (!res.ok) return { ok: false, error: res.errors.join("; ") || "the configuration rejected that value" };

    // Read-back: setPath can create an intermediate object for a path the
    // schema does not know, and the caster may drop it. Never report a write
    // that did not stick.
    const kept = config.get(key);
    if (JSON.stringify(kept) !== JSON.stringify(value)) {
      return { ok: false, error: `the configuration did not keep ${key} — nothing was applied` };
    }
    apply();
    return { ok: true, value };
  };

  return { path: config.path, specs: () => MUTABLE_SETTINGS, get, set };
}

/** One line per writable setting, for `settings list` and the prompt. */
export function describeSettings(): string {
  return MUTABLE_SETTINGS.map((s) => {
    const type = s.type === "enum" ? `one of ${(s.values ?? []).join(", ")}` : s.type;
    return `${s.path} — ${s.label} (${type})`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// The prompt block
// ---------------------------------------------------------------------------

export interface SelfFacts {
  /** Wire reference or profile id, as people say it. */
  model: string;
  /** Set when `model` is a curated profile. */
  profile?: string;
  fallbacks: string[];
  reasoning: string;
  usage: string;
  queue: string;
  execMode: string;
  approvals: boolean;
  sandbox: string;
  maxIterations: number;
  contextBudget: number;
  skills: number;
  cronEnabled: boolean;
  timezone: string;
  dreaming: boolean;
  workspace: string;
  configPath: string;
}

export interface SelfRuntime {
  /** This session's /usage mode. */
  usage?: string;
  /** This session's effective queue mode. */
  queue?: string;
  /** This session's exec override, when it has one. */
  execMode?: string;
}

export interface SelfOptions {
  sessionKey: string;
  workspace: string;
  configPath: string;
  skills?: number;
  runtime?: SelfRuntime;
}

/** Build the facts from live config + this session's overrides. */
export function selfFactsFrom(config: SuparClawConfig, opts: SelfOptions): SelfFacts {
  const d = config.agents.defaults;
  const profile = d.model && config.models?.[d.model] ? config.models[d.model] : undefined;
  return {
    model: profile ? profile.ref || d.model : d.model,
    ...(profile ? { profile: d.model } : {}),
    fallbacks: [...(d.fallbacks ?? [])],
    reasoning: d.reasoningEffort,
    usage: opts.runtime?.usage ?? d.usage,
    queue: opts.runtime?.queue ?? d.queueMode,
    execMode: opts.runtime?.execMode ?? execModeOf(config.tools.exec),
    approvals: Boolean(config.tools.exec.approvals),
    sandbox: config.tools.exec.sandbox,
    maxIterations: d.maxToolIterations,
    contextBudget: d.contextBudgetChars,
    skills: opts.skills ?? 0,
    cronEnabled: Boolean(config.cron.enabled),
    timezone: config.cron.timezone,
    dreaming: Boolean(config.memory?.dreaming?.enabled),
    workspace: opts.workspace,
    configPath: opts.configPath,
  };
}

const onOff = (v: boolean): string => (v ? "on" : "off");

/**
 * The system-prompt block. Facts, never defaults: every line is read from the
 * live config (and this session's overrides) on the turn that uses it.
 */
export function selfPromptLine(facts: SelfFacts): string {
  const model = facts.model ? `\`${facts.model}\`` : "(unset)";
  const profile = facts.profile ? ` (profile \`${facts.profile}\`)` : "";
  const fallbacks = facts.fallbacks.length > 0 ? facts.fallbacks.map((f) => `\`${f}\``).join(", ") : "none";
  const budget = facts.contextBudget.toLocaleString("en-US");
  return [
    "## Your configuration",
    "",
    "Live settings for this session — facts, not defaults. Quote them instead of guessing.",
    `- Model: ${model}${profile} · fallbacks: ${fallbacks}`,
    `- Reasoning: \`${facts.reasoning}\` · reply usage footer: \`${facts.usage}\` · queue: \`${facts.queue}\``,
    `- Exec: mode \`${facts.execMode}\` · approvals: ${onOff(facts.approvals)} · sandbox: \`${facts.sandbox}\``,
    `- Limits: ${facts.maxIterations} tool iterations · context budget ${budget} chars · skills: ${facts.skills} enabled`,
    `- Cron: ${onOff(facts.cronEnabled)}, timezone \`${facts.timezone}\` · dreaming: ${onOff(facts.dreaming)}`,
    `- Workspace: \`${facts.workspace}\` · config: \`${facts.configPath}\``,
    "",
    "When the user asks you to change a setting, call the `settings` tool (list → get → set);",
    "a successful change applies immediately and this block is rebuilt next turn.",
    `Writable from chat: ${MUTABLE_SETTINGS.map((s) => s.path).join(", ")}.`,
    "Operator-only: API keys and provider credentials, the gateway port/bind and auth token, and the",
    "control-UI endpoints — name the Settings page that owns them (Settings → Models, Settings →",
    "Gateway, Settings → Channels) and stop there.",
  ].join("\n");
}
