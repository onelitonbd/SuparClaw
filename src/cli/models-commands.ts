// `sc models` — models inventory PLUS the auth surface (their `models auth *`
// and provider-plugin contract, at our scale):
//
//   sc models [--refresh] [--json]        inventory (existing behavior)
//   sc models plugins                     provider plugins + declared auth methods
//   sc models auth login --provider <id> [--method api-key|device-code]
//                            [--profile-id <id>] [--api-key K] [--set-default] [--force]
//   sc models auth paste-api-key|paste-token --provider <id> [--profile-id <id>]
//   sc models auth list [--provider <id>] [--json]
//   sc models auth order get|set|clear --provider <id> [--json] [ids...]
//   sc models auth remove <profileId>
//   sc models auth probe [--provider <id>] [--json]

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ConfigService } from "../config/load.js";
import { createLogger } from "../util/log.js";
import { configPath, dbPath } from "../util/paths.js";
import { Store } from "../state/db.js";
import { pluginById, pluginSummaries } from "../agent/provider-plugins.js";
import {
  profileCheck,
  profileId,
  profileStatus,
  resolveAuthProfileOrder,
  type AuthReason,
} from "../agent/auth.js";
import { deviceLogin } from "../agent/oauth-device.js";
import { fetchModels } from "../config/providers.js";

const openConfig = () => new ConfigService(createLogger({ level: "error" }), configPath());
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const reasonText: Record<AuthReason, string> = {
  missing_credential: "No inline credential or SecretRef is configured.",
  expired: "The credential's expires timestamp is in the past.",
  invalid_expires: "The credential's expires value is invalid.",
  excluded_by_auth_order: "Excluded by auth.order for this provider.",
  ineligible_profile: "Profile is incompatible with the provider configuration.",
  cooldown: "Cooling down after recent auth failures.",
};

/** Hidden paste prompt (their paste-api-key headless path shape). */
async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    // Fully headless: read one line from stdin without any echo concerns.
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // @ts-expect-error readline private hook — standard hidden-input pattern
  rl._writeToOutput = () => undefined;
  try {
    const answer = await rl.question(question);
    stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Bind a provider config entry to a stored profile (their apiKey-names-profile rule). */
function bindProvider(cfg: ConfigService, provider: string, baseUrl: string, pid: string): void {
  const providers = cfg.current.providers ?? {};
  if (!providers[provider]) cfg.setPath(`providers.${provider}`, {});
  const current = cfg.current.providers[provider];
  if (!current?.baseUrl && baseUrl) cfg.setPath(`providers.${provider}.baseUrl`, baseUrl);
  cfg.setPath(`providers.${provider}.apiKey`, pid);
}

/** After a login: fetch the catalog so the Models tab/picker can offer choices. */
async function refreshCatalog(cfg: ConfigService, provider: string, key: string): Promise<string[]> {
  const base = String(cfg.current.providers[provider]?.baseUrl ?? "");
  if (!base) return [];
  const found = await fetchModels(base, key);
  if (!found.error && found.models.length) cfg.setPath(`providers.${provider}.models`, found.models.slice(0, 200));
  return found.models;
}

export async function modelsCmd(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "plugins") return modelsPlugins(rest);
  if (sub === "auth") return modelsAuth(rest);
  if (sub === "local") return modelsLocal(rest);
  return (await import("./provider.js")).modelsCmd(args);
}

// `sc models local` — their implicit local-services discovery:
// scans loopback for Ollama/LM Studio/vLLM/SGLang/llama.cpp, prints what it
// found, and --add writes the provider entry (api flavor + merged models).
async function modelsLocal(args: string[]): Promise<number> {
  const cfg = openConfig();
  const { scanLocalServices, addLocalService, LOCAL_SERVICES } = await import("../agent/local-services.js");
  const results = await scanLocalServices();

  const positional = args.find((a) => !a.startsWith("--") && a !== "--json");
  const addFlag = flag(args, "--add") ?? positional;
  if (addFlag) {
    const targets = addFlag === "all" ? results.filter((r) => r.running) : results.filter((r) => r.id === addFlag.toLowerCase());
    if (targets.length === 0) {
      console.error(`no running local service named "${addFlag}" — scanned: ${results.map((r) => `${r.id}:${r.running ? "up" : "down"}`).join(" ")}`);
      return 1;
    }
    for (const t of targets) {
      const res = addLocalService(cfg, t.id, t);
      console.log(res.message);
      if (!res.ok) return 1;
    }
    const first = targets[0]!;
    if (args.includes("--set-default") && first.models.length) {
      cfg.setPath("agents.defaults.model", `${first.id}/${first.models[0]}`);
      console.log(`default model → ${first.id}/${first.models[0]}`);
    } else if (first.models.length) {
      console.log(`pick a model with: sc config set agents.defaults.model ${first.id}/<model>  (or in Settings → Models)`);
    }
    return 0;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ services: results }, null, 2));
    return 0;
  }
  for (const r of results) {
    const head = `${r.id.padEnd(10)} ${r.running ? "running" : (r.error ?? "not running")}`;
    console.log(head.padEnd(40) + (r.running && r.models.length ? `${r.models.length} model(s) · ` : "") + (r.running ? r.note : ""));
    for (const m of r.models.slice(0, 8)) console.log(`${"".padEnd(40)} - ${m}${r.hints[m]?.contextWindow ? ` (ctx ${Math.round(r.hints[m].contextWindow! / 1000)}k)` : ""}`);
  }
  const running = results.filter((r) => r.running);
  const found = running.length > 0;
  console.log(found ? `\nadd with: sc models local --add ${running[0]!.id}   (any of: ${running.map((r) => r.id).join(", ")})` : `\nno local services detected — install Ollama (port ${LOCAL_SERVICES[0]!.port}) or LM Studio (${LOCAL_SERVICES[1]!.port}) and re-run`);
  return 0;
}

async function modelsPlugins(args: string[]): Promise<number> {
  const plugins = pluginSummaries();
  if (args.includes("--json")) {
    console.log(JSON.stringify(plugins, null, 2));
    return 0;
  }
  for (const p of plugins) {
    const methods = p.authMethods.map((m) => (p.hasOAuth && m === "device-code" ? `${m} (OAuth)` : m)).join(", ");
    console.log(`${p.id.padEnd(12)} ${p.label}`);
    console.log(`${"".padEnd(12)} auth: ${methods}${p.env ? ` · env ${p.env}` : ""}${p.recommended ? ` · default ${p.recommended}` : ""}`);
  }
  console.log(`\ncustom providers keep working via "sc provider add"; profiles bind through providers.<name>.apiKey`);
  return 0;
}

async function modelsAuth(args: string[]): Promise<number> {
  const [sub = "list", ...rest] = args;
  const cfg = openConfig();
  const store = Store.open(dbPath());
  try {
    switch (sub) {
      case "login": {
        const provider = flag(rest, "--provider") ?? rest[0];
        if (!provider) {
          console.error("usage: sc models auth login --provider <id> [--method api-key|device-code] [--profile-id <id>] [--api-key K] [--set-default] [--force]");
          return 1;
        }
        const descriptor = pluginById(provider);
        const id = provider.toLowerCase();
        if (!descriptor) {
          console.error(`unknown provider plugin "${provider}" — sc models plugins lists what ships; custom providers use paste-api-key with any matching plugin or sc provider add`);
          return 1;
        }
        const method = (flag(rest, "--method") ?? descriptor.authMethods[0]) as string;
        if (!descriptor.authMethods.includes(method as never)) {
          console.error(`provider ${id} has no "${method}" method — available: ${descriptor.authMethods.join(", ")}`);
          return 1;
        }
        const explicitId = flag(rest, "--profile-id");
        const pid = explicitId ?? profileId(id, method === "device-code" ? "oauth" : "key");
        if (!rest.includes("--force") && store.authProfile(pid)) {
          console.error(`profile ${pid} already exists — pass --force to replace it`);
          return 1;
        }
        let expires = 0;
        let keyMaterial = "";
        if (method === "device-code") {
          if (!descriptor.oauth) throw new Error("descriptor missing oauth endpoints");
          console.log(`starting ${id} device-code login…`);
          const token = await deviceLogin({
            descriptor: descriptor.oauth,
            onCode: (a) => {
              console.log(`\n  1. open  ${a.verification_uri}`);
              console.log(`  2. enter code  ${a.user_code}  (expires in ${Math.round(a.expires_in / 60)} min)\n`);
              console.log("waiting for approval…");
            },
            onProgress: (attempt, interval) => stdout.write(`\rpolling … attempt ${attempt} (every ${interval}s)   `),
          });
          stdout.write("\n");
          keyMaterial = token.access_token;
          expires = token.expiresAt;
          store.upsertAuthProfile({ id: pid, provider: id, type: "oauth", material: keyMaterial, expires, label: `${id} device-code login` });
        } else {
          const k = flag(rest, "--api-key") ?? (await promptSecret(`paste ${id} ${method === "token" ? "setup token" : "api key"}: `));
          if (!k) {
            console.error("empty credential — aborted");
            return 1;
          }
          keyMaterial = k;
          store.upsertAuthProfile({
            id: pid,
            provider: id,
            type: method === "token" ? "token" : "api_key",
            material: k,
            label: `${id} ${method}`,
          });
        }
        bindProvider(cfg, id, descriptor.baseUrl, pid);
        const models = await refreshCatalog(cfg, id, keyMaterial);
        console.log(`saved profile ${pid} · bound to providers.${id}.apiKey${models.length ? ` · ${models.length} models discovered` : " (model catalog fetch failed — try sc models --refresh later)"}`);
        if (rest.includes("--set-default")) {
          const ref = `${id}/${models[0] ?? descriptor.recommended ?? "model"}`;
          cfg.setPath("agents.defaults.model", ref);
          console.log(`default model → ${ref}`);
        }
        if (descriptor.env && process.env[descriptor.env]) {
          console.log(`note: ${descriptor.env} is also in your environment — the stored profile wins (token-sink rule)`);
        }
        return 0;
      }

      case "paste-api-key":
      case "paste-token": {
        const provider = flag(rest, "--provider") ?? rest[0];
        if (!provider) {
          console.error(`usage: sc models auth ${sub} --provider <id> [--profile-id <id>]`);
          return 1;
        }
        const id = provider.toLowerCase();
        const descriptor = pluginById(id);
        const k = flag(rest, "--api-key") ?? flag(rest, "--token") ?? (await promptSecret(`paste ${id} ${sub === "paste-token" ? "token" : "api key"}: `));
        if (!k) {
          console.error("empty credential — aborted");
          return 1;
        }
        const pid = flag(rest, "--profile-id") ?? profileId(id, sub === "paste-token" ? "token" : "key");
        store.upsertAuthProfile({ id: pid, provider: id, type: sub === "paste-token" ? "token" : "api_key", material: k });
        bindProvider(cfg, id, descriptor?.baseUrl ?? String(cfg.current.providers[id]?.baseUrl ?? ""), pid);
        console.log(`saved profile ${pid} · bound (no live check — probe with: sc models auth probe --provider ${id})`);
        return 0;
      }

      case "list": {
        const provider = flag(rest, "--provider");
        const rows = (provider ? store.authProfiles(provider.toLowerCase()) : store.authProfiles()).map((r) => profileStatus(r));
        if (rest.includes("--json")) {
          console.log(JSON.stringify({ profiles: rows }, null, 2));
          return 0;
        }
        if (rows.length === 0) {
          console.log("(no auth profiles) — sc models auth login --provider <id>");
          return 0;
        }
        for (const p of rows) {
          const status = p.ok ? "ok" : `${p.reason}`;
          console.log(`${p.id.padEnd(24)} ${p.type.padEnd(8)} ${p.masked.padEnd(8)} ${status}${p.ok ? ` · expires ${p.expiresIn}` : ` — ${reasonText[p.reason!]}`}${p.failCount ? ` · fails ${p.failCount}` : ""}`);
        }
        return 0;
      }

      case "order": {
        const [action = "get", ...orderArgs] = rest;
        const provider = (flag(orderArgs, "--provider") ?? orderArgs[0])?.toLowerCase();
        if (!provider) {
          console.error("usage: sc models auth order <get|set|clear> --provider <id> [profileIds...]");
          return 1;
        }
        if (action === "get") {
          const stored = store.authOrder(provider);
          const fromConfig = (cfg.current.auth?.order?.[provider] as string[] | undefined) ?? [];
          if (orderArgs.includes("--json")) {
            console.log(JSON.stringify({ provider, order: stored.length ? stored : fromConfig, source: stored.length ? "store" : "config" }, null, 2));
            return 0;
          }
          const eff = resolveAuthProfileOrder(store, cfg.current, provider);
          console.log(`${provider}: ${(stored.length ? stored : fromConfig).length ? (stored.length ? stored : fromConfig).join(", ") : "(no explicit order)"} [${stored.length ? "store override" : "config"}]`);
          if (eff.excluded.length) console.log(`excluded by order: ${eff.excluded.map((r) => r.id).join(", ")}`);
          return 0;
        }
        if (action === "set") {
          const ids = orderArgs.filter((a) => !a.startsWith("--") && a !== provider);
          if (ids.length === 0) {
            console.error("pass at least one profile id: sc models auth order set --provider <id> <profileIds...>");
            return 1;
          }
          for (const p of ids) {
            const row = store.authProfile(p);
            if (!row || row.provider !== provider) {
              console.error(`no ${provider} profile "${p}" — set only existing profiles`);
              return 1;
            }
          }
          store.setAuthOrder(provider, ids);
          console.log(`${provider}: store override → ${ids.join(", ")} (wins over auth.order config)`);
          return 0;
        }
        if (action === "clear") {
          store.setAuthOrder(provider, []);
          console.log(`${provider}: store override cleared${cfg.current.auth?.order?.[provider] ? " (auth.order config/order still applies)" : ""}`);
          return 0;
        }
        console.error(`unknown order action "${action}" — get|set|clear`);
        return 1;
      }

      case "remove": {
        const pid = rest[0];
        if (!pid) {
          console.error("usage: sc models auth remove <profileId>");
          return 1;
        }
        if (!store.removeAuthProfile(pid)) {
          console.error(`no profile "${pid}"`);
          return 1;
        }
        // Never leave a config binding pointing at a missing profile (their
        // missing-profile error instead of a provider 401).
        let unbound = "";
        for (const [name, p] of Object.entries(cfg.current.providers ?? {})) {
          if (p.apiKey === pid) {
            cfg.setPath(`providers.${name}.apiKey`, "");
            unbound = ` · unbound providers.${name}.apiKey`;
          }
          if ((p.authProfiles ?? []).includes(pid)) {
            cfg.setPath(`providers.${name}.authProfiles`, (p.authProfiles ?? []).filter((x: string) => x !== pid));
          }
        }
        console.log(`removed ${pid}${unbound}`);
        return 0;
      }

      case "probe": {
        const provider = flag(rest, "--provider")?.toLowerCase();
        const results: Record<string, unknown>[] = [];
        for (const row of store.authProfiles(provider)) {
          const check = profileCheck(row);
          const { ordered, excluded } = resolveAuthProfileOrder(store, cfg.current, row.provider);
          const reason = excluded.includes(row) ? ("excluded_by_auth_order" as const) : check.ok ? undefined : check.reason;
          const entry: Record<string, unknown> = { profile: row.id, provider: row.provider, status: reason ? (reason === "missing_credential" ? "auth" : reason === "excluded_by_auth_order" ? "excluded" : "auth") : "pending", reasonCode: reason };
          if (!reason && check.ok) {
            const base = String(cfg.current.providers[row.provider]?.baseUrl ?? "");
            const found = base ? await fetchModels(base, row.material) : { models: [], error: "provider not configured" };
            entry["status"] = found.error ? "unknown" : "ok";
            entry["reasonCode"] = reason ?? null;
            entry["models"] = found.models.length;
            if (found.error) entry["detail"] = found.error;
          }
          if (reason) entry["detail"] = reasonText[reason];
          if (!ordered.some((r) => r.id === row.id) && !excluded.some((r) => r.id === row.id) && !entry["detail"]) entry["detail"] = "profile not in resolved order";
          results.push(entry);
        }
        if (rest.includes("--json")) {
          console.log(JSON.stringify({ probe: results }, null, 2));
          return 0;
        }
        if (results.length === 0) {
          console.log("(no auth profiles to probe)");
          return 0;
        }
        for (const r of results) {
          console.log(`${String(r["profile"]).padEnd(24)} ${r["status"]}${r["reasonCode"] ? ` [${r["reasonCode"]}]` : ""}${r["models"] !== undefined ? ` · ${r["models"]} models` : ""}${r["detail"] ? ` — ${r["detail"]}` : ""}`);
        }
        return 0;
      }

      default:
        console.error(`unknown models auth subcommand "${sub}" — login|paste-api-key|paste-token|list|order|remove|probe`);
        return 1;
    }
  } finally {
    store.close();
  }
}
