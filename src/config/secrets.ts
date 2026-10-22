/**
 * Secret stores: env refs + SecretRef providers (P3 #30 — their
 * gateway/config-secrets-env.md, scoped to our footprint).
 *
 * What we port:
 *  - `${VAR}` / `${VAR:-fallback}` / `$${literal}` substitution in any config
 *    string, uppercase names only; missing vars stay visibly unresolved with
 *    a warning (their env-substitution semantics, incl. the literal rules
 *    for other shell operators).
 *  - SecretRef: `{ source: "env" | "file" | "exec", provider?, id }` with
 *    THEIR validation patterns for provider/id (env name, JSON pointer,
 *    exec selector incl. the dot-segment refusal).
 *  - Providers: `env` (default), `file` (json + singleValue modes), `exec`
 *    (absolute command, minimal env + passEnv, timeout). 1Password is an
 *    exec provider: `{ command: "/usr/local/bin/op", args: ["read"] }` with
 *    ids like `op://Vault/Item/credential`.
 *  - Resolution at activation (config load/reload) into in-memory values;
 *    plaintext stays supported (their "additive" rule). Authored refs/fallbacks
 *    never round-trip through write-back — we resolve a CLONE pre-parse.
 *  - `sc secrets audit` findings (plaintext at credential paths, unresolved
 *    refs) instead of their egress-proxy/store/planner stack.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface SecretRef {
  source: "env" | "file" | "exec";
  provider?: string;
  id: string;
}

interface FileProviderCfg {
  source: "file";
  path: string;
  mode?: "json" | "singleValue";
  timeoutMs?: number;
}
interface ExecProviderCfg {
  source: "exec";
  command: string;
  args?: string[];
  passEnv?: string[];
  timeoutMs?: number;
}
interface EnvProviderCfg {
  source: "env";
}
type ProviderCfg = EnvProviderCfg | FileProviderCfg | ExecProviderCfg;

interface SecretsConfigBlock {
  providers: Record<string, ProviderCfg>;
  defaults: Partial<Record<"env" | "file" | "exec", string>>;
}

// THEIR validation patterns (gateway/config-secrets-env.md#secretref).
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const ENV_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
export const EXEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const ENV_NAME_RE = /[A-Z_][A-Z0-9_]*/;

export function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const allowed = ["id", "provider", "source"];
  if (!keys.every((k) => allowed.includes(k))) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["source"] === "env" || v["source"] === "file" || v["source"] === "exec") &&
    typeof v["id"] === "string" &&
    (v["provider"] === undefined || typeof v["provider"] === "string")
  );
}

export function validateSecretRef(ref: SecretRef, opts: { singleValue?: boolean } = {}): string | null {
  if (ref.provider !== undefined && !PROVIDER_NAME_RE.test(ref.provider)) return `provider name invalid: ${ref.provider}`;
  switch (ref.source) {
    case "env":
      return ENV_ID_RE.test(ref.id) ? null : `env id must match ${ENV_ID_RE}: ${ref.id}`;
    case "file":
      // singleValue mode (their note): the id must be exactly "value".
      if (opts.singleValue) return ref.id === "value" ? null : `singleValue mode requires id "value", got ${ref.id}`;
      return ref.id.startsWith("/") ? null : `file id must be an absolute JSON pointer: ${ref.id}`;
    case "exec": {
      if (!EXEC_ID_RE.test(ref.id)) return `exec id invalid: ${ref.id}`;
      const segments = ref.id.split("/");
      if (segments.includes(".") || segments.includes("..")) return `exec id must not contain dot path segments: ${ref.id}`;
      return null;
    }
  }
}

/**
 * Env-var substitution in one string (their semantics):
 *  - `$${...}` escapes to a literal `${...}` and reads nothing
 *  - `${NAME}` → env value; missing/empty stays `${NAME}` + warning
 *  - `${NAME:-fallback}` → fallback when unset OR empty (always resolves)
 *  - any other operator (`:=`, `:?`, …) stays literal, untouched
 *  - lowercase names like `${home}` are not refs at all
 */
export function substituteEnvText(text: string, env: NodeJS.ProcessEnv, warnings?: string[]): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // Escape wins: $${...} → literal ${...}, reads nothing (their rule).
    if (text[i] === "$" && text[i + 1] === "$" && text[i + 2] === "{") {
      const end = text.indexOf("}", i + 3);
      if (end > i) {
        out += `\${${text.slice(i + 3, end)}}`;
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "$" && text[i + 1] === "{") {
      // Balanced-brace body so nested ${...} is seen as a unit.
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        if (depth > 0) j++;
      }
      if (depth === 0) {
        const body = text.slice(i + 2, j);
        // Valid ref: NAME, or NAME:-fallback where the fallback is literal
        // text without $ or { (their fallback rules).
        const m = new RegExp(`^(${ENV_NAME_RE.source})(:-([^{}$]*))?$`).exec(body);
        if (m) {
          const name = m[1]!;
          const hasFallback = m[2] !== undefined;
          const fallback = m[3] ?? "";
          const value = env[name];
          if (value !== undefined && value !== "") out += value;
          else if (hasFallback) out += fallback;
          else {
            out += `\${${body}}`;
            warnings?.push(`env var ${name} is not set; leaving \${${name}} unresolved`);
          }
        } else {
          // Not a valid reference (e.g. nested ${A:-${B}}): the expression as
          // a whole stays literal, inner refs still substitute (their rule).
          out += `\${${substituteEnvText(body, env, warnings)}}`;
        }
        i = j + 1;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function secretsConfigBlock(raw: Record<string, unknown>): SecretsConfigBlock {
  const secrets = (raw["secrets"] ?? {}) as Record<string, unknown>;
  const providers = (secrets["providers"] ?? {}) as Record<string, ProviderCfg>;
  const defaults = (secrets["defaults"] ?? {}) as Partial<Record<"env" | "file" | "exec", string>>;
  return { providers, defaults };
}

function providerFor(block: SecretsConfigBlock, ref: SecretRef): ProviderCfg | { source: "env" } | null {
  if (ref.provider) return block.providers[ref.provider] ?? null;
  const named = block.defaults[ref.source];
  if (named && block.providers[named]) return block.providers[named]!;
  // Implicit: bare `source: "env"` works with no provider entry (their default).
  if (ref.source === "env") return { source: "env" };
  // Any single provider of the requested source is a sensible default.
  const candidates = Object.values(block.providers).filter((p) => p.source === ref.source);
  return candidates.length === 1 ? candidates[0]! : null;
}

function jsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function resolveWithProvider(
  provider: ProviderCfg,
  ref: SecretRef,
  env: NodeJS.ProcessEnv,
): { value?: string; error?: string } {
  switch (provider.source) {
    case "env": {
      const value = env[ref.id];
      return value ? { value } : { error: `env var ${ref.id} is not set` };
    }
    case "file": {
      const path = provider.path.startsWith("~/") ? `${env.HOME ?? ""}/${provider.path.slice(2)}` : provider.path;
      if (!existsSync(path)) return { error: `secret file missing: ${path}` };
      try {
        if ((provider.mode ?? "json") === "singleValue") {
          if (ref.id !== "value") return { error: `singleValue mode requires id "value", got ${ref.id}` };
          return { value: readFileSync(path, "utf8").trim() };
        }
        const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
        const value = jsonPointer(doc, ref.id);
        return typeof value === "string" && value !== "" ? { value } : { error: `no string at ${ref.id} in ${path}` };
      } catch (err) {
        return { error: `secret file read failed: ${(err as Error).message}` };
      }
    }
    case "exec": {
      if (!isAbsolute(provider.command)) return { error: `exec provider command must be absolute: ${provider.command}` };
      if (!existsSync(provider.command)) return { error: `exec provider command missing: ${provider.command}` };
      const pass = new Set(provider.passEnv ?? []);
      const childEnv: Record<string, string> = {};
      // Minimal PATH by default so relative helpers inside resolvers still work.
      if (env.PATH) childEnv.PATH = env.PATH;
      for (const key of Object.keys(env)) if (pass.has(key) && env[key]) childEnv[key] = env[key]!;
      try {
        const out = execFileSync(provider.command, [...(provider.args ?? []), ref.id], {
          env: childEnv,
          timeout: provider.timeoutMs ?? 5000,
          maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const value = out.toString("utf8").trim();
        return value ? { value } : { error: `exec provider returned empty for ${ref.id}` };
      } catch (err) {
        return { error: `exec provider failed for ${ref.id}: ${(err as Error).message}` };
      }
    }
  }
}

export interface SecretsResolution {
  /** Deep-cloned config with env substitutions + resolved refs applied. */
  config: unknown;
  warnings: string[];
  /** Audit findings: plaintext at credential-looking paths, unresolved refs. */
  findings: string[];
}

const CREDENTIAL_KEY_RE = /(api[_-]?key|token|password|secret|credential)/i;
const PLACEHOLDER_RE = /^\$\{[A-Z_][A-Z0-9_]*(?::-.*)?\}$/;

/** Walk + resolve. `raw` is the freshly parsed JSON5 config (never mutated). */
export function resolveSecrets(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SecretsResolution {
  const warnings: string[] = [];
  const findings: string[] = [];
  const block = secretsConfigBlock((raw ?? {}) as Record<string, unknown>);

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const out = substituteEnvText(value, env, warnings);
      if (PLACEHOLDER_RE.test(out) && CREDENTIAL_KEY_RE.test(path.split(".").pop() ?? "")) {
        findings.push(`unresolved env ref at ${path}: ${out}`);
      }
      return out;
    }
    if (isSecretRef(value)) {
      const ref = value;
      const provider = providerFor(block, ref) ?? undefined;
      const singleValue = provider?.source === "file" && (provider.mode ?? "json") === "singleValue";
      const invalid = validateSecretRef(ref, { singleValue });
      if (invalid) {
        findings.push(`invalid SecretRef at ${path}: ${invalid}`);
        return value;
      }
      if (!provider) {
        findings.push(`no provider configured for SecretRef at ${path} (${ref.source}${ref.provider ? `:${ref.provider}` : ""})`);
        return value;
      }
      const r = resolveWithProvider(provider, ref, env);
      if (r.error) {
        findings.push(`unresolved SecretRef at ${path}: ${r.error}`);
        return value; // leave the ref in place — visible, never a fake value
      }
      return r.value;
    }
    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${k}` : k;
        out[k] = walk(v, childPath);
        // Plaintext at credential-looking paths: report the PATH, never the
        // value. env.vars.* and secrets.* are documented plaintext homes
        // (their env.vars note), so audit stays quiet there.
        if (
          typeof v === "string" &&
          v !== "" &&
          CREDENTIAL_KEY_RE.test(k) &&
          !PLACEHOLDER_RE.test(v) &&
          !childPath.startsWith("env.vars.") &&
          !childPath.startsWith("secrets.")
        ) {
          findings.push(`plaintext credential at ${childPath} — consider a SecretRef or \${ENV_VAR}`);
        }
      }
      return out;
    }
    return value;
  };

  const top = walk(raw ?? {}, "");
  return { config: top, warnings, findings };
}
