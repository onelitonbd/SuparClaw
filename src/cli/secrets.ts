// `sc secrets` CLI (P3 #30) — audit + explain, proportional to our scale.
//
// Their loop is audit → configure → apply → audit → reload; ours is
// audit → edit config → gateway reload (the file watcher re-resolves refs).
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { configPath } from "../util/paths.js";
import { isSecretRef, resolveSecrets, validateSecretRef, ENV_ID_RE, EXEC_ID_RE, PROVIDER_NAME_RE } from "../config/secrets.js";
import { fg } from "./brand.js";

const USAGE = `usage: sc secrets <subcommand> [options]

subcommands:
  audit [--check] [--json]   scan the active config for plaintext credentials
                             at credential paths, unresolved \${ENV} refs and
                             broken SecretRefs/providers (paths only, never values)
  refs                       print the SecretRef contract + a 1Password recipe

Exit codes (their CI semantics): audit --check → 1 on findings;
unresolved refs are findings and always reported first.

SecretRefs in config.json5 (plaintext still works — refs are additive):

  {
    providers: {
      openrouter: {
        apiKey: "\${OPENROUTER_API_KEY}"            // env substitution
        // or: apiKey: { source: "env", id: "OPENROUTER_API_KEY" }
        // or: apiKey: { source: "file", provider: "main", id: "/openrouter/apiKey" }
        // or: apiKey: { source: "exec", provider: "op", id: "op://Vault/OpenRouter/credential" }
      }
    },
    secrets: {
      providers: {
        main: { source: "file", path: "~/.suparclaw/secrets.json", mode: "json" },
        op:   { source: "exec", command: "/usr/local/bin/op", args: ["read"] }  // 1Password CLI
      }
    }
  }
`;

export interface SecretsAuditResult {
  ok: boolean;
  findings: string[];
  warnings: string[];
  error?: string;
  note?: string;
}

/** The audit core shared by the CLI and the Gateway secrets.audit RPC
 *  (P4 #43 — their Settings → Secrets findings panel): plaintext creds,
 *  unresolved refs, and invalid SecretRef shapes, all as findings. */
export function auditSecretsFile(path: string): SecretsAuditResult {
  if (!existsSync(path)) {
    return { ok: true, findings: [], warnings: [], note: `no config at ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON5.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, findings: [], warnings: [], error: `config parse failed: ${(err as Error).message}` };
  }
  const { findings, warnings } = resolveSecrets(raw);
  const invalid: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (isSecretRef(v)) {
      const bad = validateSecretRef(v);
      if (bad) invalid.push(`invalid SecretRef at ${p}: ${bad}`);
    } else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(raw, "");
  const all = [...findings, ...invalid.filter((f) => !findings.includes(f))];
  return { ok: all.length === 0, findings: all, warnings };
}

export async function cmdSecrets(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const asJson = rest.includes("--json");
  switch (sub) {
    case "refs":
    case "help":
    case "--help":
    case undefined: {
      console.log(USAGE);
      console.log(`SecretRef validation (their patterns):
  provider  ${PROVIDER_NAME_RE}
  env id    ${ENV_ID_RE}
  file id   absolute JSON pointer, e.g. /providers/openai/apiKey
  exec id   ${EXEC_ID_RE}  (no "." or ".." segments)`);
      return sub === undefined ? 2 : 0;
    }
    case "audit": {
      const path = configPath();
      if (!existsSync(path)) {
        const out = { ok: true, findings: [], note: `no config at ${path}` };
        if (asJson) console.log(JSON.stringify(out, null, 2));
        else console.log(fg.info(`no config at ${path} — nothing to audit`));
        return 0;
      }
      let raw: unknown;
      try {
        raw = JSON5.parse(readFileSync(path, "utf8"));
      } catch (err) {
        const msg = `config parse failed: ${(err as Error).message}`;
        if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
        else console.error(fg.error(`✖ ${msg}`));
        return 2;
      }
      const { findings, warnings } = resolveSecrets(raw);
      // Surface broken refs explicitly (validation errors are findings too).
      const invalid: string[] = [];
      const walk = (v: unknown, p: string): void => {
        if (isSecretRef(v)) {
          const bad = validateSecretRef(v);
          if (bad) invalid.push(`invalid SecretRef at ${p}: ${bad}`);
        } else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${p}[${i}]`));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
      };
      walk(raw, "");
      const all = [...findings, ...invalid.filter((f) => !findings.includes(f))];
      const unresolved = all.filter((f) => f.startsWith("unresolved"));
      if (asJson) {
        console.log(JSON.stringify({ ok: all.length === 0, findings: all, warnings }, null, 2));
      } else if (all.length === 0) {
        console.log(`${fg.success("✔")} no plaintext credentials or unresolved refs in ${path}`);
      } else {
        console.log(fg.warn(`▲ ${all.length} finding(s) in ${path}:`));
        for (const f of all) console.log(`  - ${f}`);
        for (const w of warnings) console.log(fg.muted(`  · ${w}`));
        console.log(fg.muted("  fix: replace the value with ${ENV_VAR} or a SecretRef (see: sc secrets refs)"));
      }
      if (unresolved.length > 0) return 2; // their "unresolved refs return 2"
      return rest.includes("--check") && all.length > 0 ? 1 : 0;
    }
    default:
      console.log(USAGE);
      return 2;
  }
}
