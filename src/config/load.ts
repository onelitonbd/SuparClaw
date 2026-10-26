import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import JSON5 from "json5";
import { configPath } from "../util/paths.js";
import { resolveSecrets } from "./secrets.js";
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
      maxToolIterations: 0,   // 0 = no ceiling on tool rounds per turn
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
    exec: { enabled: true }   // on by default, runs without asking; sc approvals mode ask gates it
  },
  cron: { enabled: true }
}
`;

export interface ConfigLoad {
  config: SuparClawConfig;
  errors: string[];
  path: string;
  existed: boolean;
  /** Env-substitution + SecretRef warnings (P3 #30) — never fatal. */
  warnings: string[];
}

export function readConfigFile(path = configPath()): ConfigLoad {
  if (!existsSync(path)) {
    return { config: emptyConfig(), errors: [], path, existed: false, warnings: [] };
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
      warnings: [],
    };
  }
  // P3 #30: resolve ${ENV} refs + SecretRef objects on the RAW document
  // (a clone — authored refs stay authored on disk) before typed parsing,
  // so activation reads the in-memory snapshot (their model).
  const resolved = resolveSecrets(parsed);
  const { config, errors } = parseConfig(resolved.config);
  return { config, errors, path, existed: true, warnings: resolved.warnings };
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
  #warnings: string[] = [];
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
    this.#warnings = load.warnings;
    for (const e of load.errors) this.log.error(`config: ${e}`);
    for (const w of load.warnings) this.log.warn(`config: ${w}`);
  }

  get warnings(): string[] {
    return this.#warnings;
  }

  get current(): SuparClawConfig {
    return this.#config;
  }
  get errors(): string[] {
    return this.#errors;
  }

  /** Whole-document replace (Settings → Config raw editor, P4 #32): the
   *  value must already be a typed SuparClawConfig (validate at the RPC
   *  boundary). Atomic write + live swap, like set(). */
  replaceAll(value: SuparClawConfig): { ok: boolean; errors: string[] } {
    this.#config = value;
    writeConfigFile(value, this.path);
    return { ok: true, errors: [] };
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

  /** Delete the key at a dotted path (record entries — P4 #36 editors):
   *  removes the leaf then re-validates the whole root through the same
   *  caster as setPath, so a deletion can never write an invalid file. */
  unsetPath(path: string): { ok: boolean; errors: string[] } {
    const root = path.split(".")[0] as keyof SuparClawConfig;
    const clone = structuredClone(this.#config) as unknown as Record<string, unknown>;
    const parts = path.split(".");
    let cursor = clone;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!next || typeof next !== "object") cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    delete cursor[parts[parts.length - 1] as string];
    return this.set(root, clone[root] as SuparClawConfig[typeof root]);
  }

  /** Debounced fs.watch hot reload; invalid edits keep the last good config live. */
  watchForChanges(onChange?: (config: SuparClawConfig) => void): void {
    if (this.#watcher) return;
    try {
      // Watch the parent directory, not the file: writes are atomic via a
      // temp file + rename, and a path-bound watcher dies after the first
      // rename (inode swap). Filter events to our config filename.
      const dir = dirname(this.path);
      const file = basename(this.path);
      this.#watcher = watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== file) return;
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
          this.#warnings = load.warnings;
          for (const w of load.warnings) this.log.warn(`config: ${w}`);
          this.log.info("config reloaded");
          onChange?.(load.config);
        }, 250);
      });
    } catch (err) {
      this.log.warn(`config hot-reload unavailable: ${(err as Error).message}`);
    }
  }

  /** Close the fs watcher (and any pending debounce); idempotent. */
  stopWatching(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer) clearTimeout(this.#timer);
  }
}