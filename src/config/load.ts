import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import JSON5 from "json5";
import { configPath } from "../util/paths.js";
import { emptyConfig, parseConfig, type SuparClawConfig } from "./schema.js";
import type { Logger } from "../util/log.js";

export const STARTER_CONFIG = `// SuparClaw config (JSON5: comments allowed)
{
  gateway: {
    port: 18790,
    bind: "loopback",        // "loopback" = this phone only; "lan" = also reachable on wifi
    auth: { mode: "token", token: "" },   // empty token is auto-generated on first run
    controlUi: { enabled: true },
    // allowedHosts: ["ui.example.com"],   // extra Host headers (reverse proxies)
    // allowedOrigins: ["https://ui.example.com"],  // cross-origin web UIs
  },
  agents: {
    defaults: {
      id: "main",
      model: "",              // e.g. "openai/gpt-4o-mini" or "local/qwen2.5"
      maxToolIterations: 12,
      queueMode: "followup"   // "steer" injects mid-turn, "followup" waits
    }
  },
  providers: {
    // openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-...", models: ["gpt-4o-mini"] },
    // local:   { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "none" }
  },
  channels: {
    telegram: {
      enabled: false,
      token: "",
      dmPolicy: "pairing",     // first DM needs approval: sc pair <code>
      streaming: "progress"    // status draft + final answer (Telegram-friendly)
    }
  },
  tools: {
    fs: true,
    memory: true,
    web: { fetch: true, search: true },
    exec: { enabled: false, approvals: true }   // opt-in; needs approval per call
  },
  cron: { enabled: true }
}
`;

export interface ConfigLoad {
  config: SuparClawConfig;
  errors: string[];
  path: string;
  existed: boolean;
}

export function readConfigFile(path = configPath()): ConfigLoad {
  if (!existsSync(path)) {
    return { config: emptyConfig(), errors: [], path, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON5.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: emptyConfig(),
      errors: [`${path}: ${(err as Error).message}`],
      path,
      existed: true,
    };
  }
  const { config, errors } = parseConfig(parsed);
  return { config, errors, path, existed: true };
}

/** Atomic write with a single-level .bak ring. */
export function writeConfigFile(value: unknown, path = configPath()): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON5.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export class ConfigService {
  #config: SuparClawConfig;
  #errors: string[] = [];
  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  readonly path: string;

  constructor(
    private readonly log: Logger,
    path = configPath(),
  ) {
    this.path = path;
    const load = readConfigFile(path);
    this.#config = load.config;
    this.#errors = load.errors;
    for (const e of load.errors) this.log.error(`config: ${e}`);
  }

  get current(): SuparClawConfig {
    return this.#config;
  }
  get errors(): string[] {
    return this.#errors;
  }

  set<K extends keyof SuparClawConfig>(key: K, value: SuparClawConfig[K]): { ok: boolean; errors: string[] } {
    const next = { ...this.#config, [key]: value } as SuparClawConfig;
    const { config, errors } = parseConfig(next);
    if (errors.length > 0) return { ok: false, errors };
    this.#config = config;
    writeConfigFile(config, this.path);
    return { ok: true, errors: [] };
  }

  /** Value at a dotted path, e.g. get("gateway.port"). */
  get(path: string): unknown {
    return path.split(".").reduce<unknown>((acc, part) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
      return undefined;
    }, this.#config);
  }

  setPath(path: string, value: unknown): { ok: boolean; errors: string[] } {
    const root = path.split(".")[0] as keyof SuparClawConfig;
    const clone = structuredClone(this.#config) as unknown as Record<string, unknown>;
    let cursor = clone;
    const parts = path.split(".");
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!next || typeof next !== "object") cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1] as string] = value;
    return this.set(root, clone[root] as SuparClawConfig[typeof root]);
  }

  /** Debounced fs.watch hot reload; invalid edits keep the last good config live. */
  watchForChanges(onChange?: (config: SuparClawConfig) => void): void {
    if (this.#watcher) return;
    try {
      this.#watcher = watch(this.path, () => {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          const load = readConfigFile(this.path);
          if (load.errors.length > 0) {
            this.#errors = load.errors;
            this.log.error(`config reload rejected: ${load.errors[0]}`);
            return;
          }
          this.#config = load.config;
          this.#errors = [];
          this.log.info("config reloaded");
          onChange?.(load.config);
        }, 250);
      });
    } catch (err) {
      this.log.warn(`config hot-reload unavailable: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer) clearTimeout(this.#timer);
  }
}