import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Service } from "../agent/service.js";
import { resolveModel } from "../agent/llm.js";
import { isProot, isTermux, stateDir, workspaceDir, logsDir, prefixDir, DEFAULT_PORT } from "../util/paths.js";
import { bundledSkillsRoot } from "../agent/skills.js";
import { discoverSkills } from "../agent/skills.js";
import { configPath } from "../util/paths.js";
import { STARTER_CONFIG, writeConfigFile } from "../config/load.js";
import { readConfigFile } from "../config/load.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

type Check = DoctorCheck;

const C = {
  ok: "\x1b[32m✔\x1b[39m",
  warn: "\x1b[33m▲\x1b[39m",
  fail: "\x1b[31m✖\x1b[39m",
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

/** Structured checks (P4 #41, System tab): the same probes the CLI prints,
 *  without the printing. insideGateway skips the free-port probe — from the
 *  running daemon the port is ours, so "in use" would be a false alarm. */
export async function runDoctorChecks(opts: { insideGateway?: boolean } = {}): Promise<Check[]> {
  const insideGateway = opts.insideGateway === true;
  const checks: Check[] = [];

  // Node
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    major >= 24
      ? { name: "node", status: "ok", detail: `v${process.versions.node}` }
      : {
          name: "node",
          status: "fail",
          detail: `v${process.versions.node} (need >= 24.16)`,
          fix: "pkg install nodejs@24   # Termux",
        },
  );

  // sqlite
  try {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("select sqlite_version() as v").get() as { v: string };
    db.exec("create table t(x)");
    db.prepare("insert into t values ('probe')").run();
    const back = db.prepare("select x from t").get() as { x: string };
    // The probe that matters: node:sqlite must round-trip an embedded NUL byte.
    const withNul = "a" + String.fromCharCode(0) + "b";
    db.prepare("delete from t").run();
    db.prepare("insert into t values (?)").run(withNul);
    const nulRow = db.prepare("select x from t").get() as { x: string };
    db.close();
    const ok = back.x === "probe" && nulRow.x === withNul;
    checks.push(
      ok
        ? { name: "sqlite (node:sqlite)", status: "ok", detail: `sqlite ${row.v}, NUL round-trip ok` }
        : {
            name: "sqlite (node:sqlite)",
            status: "fail",
            detail: "embedded SQLite mangles NUL bytes (known bad node build)",
            fix: "pkg install nodejs   # needs a build with the node:sqlite NUL fix (>=24.16)",
          },
    );
    let fts = "ok";
    try {
      const db2 = new DatabaseSync(":memory:");
      db2.exec("create virtual table f using fts5(x)");
      db2.close();
    } catch {
      fts = "warn";
    }
    checks.push({
      name: "sqlite FTS5",
      status: fts === "ok" ? "ok" : "warn",
      detail: fts === "ok" ? "available" : "not compiled in — memory_search falls back to LIKE",
    });
  } catch (err) {
    checks.push({
      name: "sqlite (node:sqlite)",
      status: "fail",
      detail: (err as Error).message,
      fix: "pkg install nodejs   # node:sqlite is built into Node",
    });
  }

  // platform
  const termux = isTermux();
  checks.push({
    name: "platform",
    status: isProot() ? "warn" : "ok",
    detail: `${process.platform}/${process.arch}${termux ? ` · Termux${isProot() ? " (proot — expect slower startup)" : " native"}` : ""}`,
    ...(isProot() ? { fix: "native Termux avoids PRoot's per-syscall overhead" } : {}),
  });

  // compile cache
  checks.push({
    name: "compile cache",
    status: "ok",
    detail: "enabled at startup (node:module enableCompileCache)",
  });

  // config
  const cfgPath = configPath();
  const load = readConfigFile(cfgPath);
  if (!load.existed) {
    checks.push({
      name: "config",
      status: "warn",
      detail: `missing: ${cfgPath}`,
      fix: "sc init",
    });
  } else if (load.errors.length > 0) {
    checks.push({
      name: "config",
      status: "fail",
      detail: load.errors[0] ?? "invalid",
      fix: `fix ${cfgPath} (or restore ${cfgPath}.bak)`,
    });
  } else {
    checks.push({ name: "config", status: "ok", detail: cfgPath });
  }

  // auth profiles (Partial #6 — their doctor-auth analog): stored credentials
  // with expiry/cooldown problems, and providers whose default model is bound
  // to an ineligible profile.
  {
    const { Store } = await import("../state/db.js");
    const { dbPath } = await import("../util/paths.js");
    const { profileCheck, resolveAuthProfileOrder, boundProfileIds } = await import("../agent/auth.js");
    try {
      const aStore = Store.open(dbPath());
      try {
        for (const row of aStore.authProfiles()) {
          const check = profileCheck(row);
          const { excluded } = resolveAuthProfileOrder(aStore, load.config, row.provider);
          if (excluded.includes(row)) {
            checks.push({
              name: "auth",
              status: "warn",
              detail: `profile ${row.id} is excluded from the resolved auth order`,
              fix: `sc models auth order get --provider ${row.provider} (or: sc models auth order clear --provider ${row.provider})`,
            });
          } else if (!check.ok) {
            checks.push({
              name: "auth",
              status: check.reason === "cooldown" ? "warn" : "fail",
              detail: `profile ${row.id}: ${check.reason}`,
              fix: `sc models auth login --provider ${row.provider} --force (--profile-id ${row.id})`,
            });
          }
        }
        if (load.config.agents.defaults.model) {
          const ref = load.config.agents.defaults.model;
          const head = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : Object.keys(load.config.providers)[0];
          const pcfg = head ? load.config.providers[head] : undefined;
          if (pcfg) {
            const { single, list } = boundProfileIds(pcfg as unknown as Record<string, unknown>, head ?? "");
            const ids = list.length ? list : single ? [single] : [];
            for (const pid of ids) {
              const row = aStore.authProfile(pid);
              if (!row) {
                checks.push({
                  name: "auth",
                  status: "fail",
                  detail: `providers.${head}.apiKey binds missing profile ${pid} — the default model has no credential`,
                  fix: `sc models auth login --provider ${head} --profile-id ${pid}`,
                });
              }
            }
          }
        }
        if (checks.every((c) => c.name !== "auth")) {
          checks.push({ name: "auth", status: "ok", detail: `${aStore.authProfiles().length} profile(s) healthy` });
        }
      } finally {
        aStore.close();
      }
    } catch {
      checks.push({ name: "auth", status: "warn", detail: "auth store unreadable — profiles skipped" });
    }
  }

  // local services (Partial #7 — their local autodetect): what is running vs
  // what's configured, including the "configured but daemon is down" case.
  {
    try {
      const { scanLocalServices } = await import("../agent/local-services.js");
      const results = await scanLocalServices();
      const up = results.filter((r) => r.running);
      const cfgNames = Object.keys(load.config.providers ?? {});
      const broken = results.filter((r) => !r.running && cfgNames.includes(r.id));
      if (broken.length) {
        checks.push({
          name: "local",
          status: "warn",
          detail: `${broken.map((r) => r.id).join(", ")} configured but not running (${broken[0]?.error ?? "down"})`,
          fix: `start the service, or fix providers.${broken[0]?.id}.baseUrl — replies against it currently fail fast with the provider error`,
        });
      } else if (up.length) {
        const unconfigured = up.filter((r) => !cfgNames.includes(r.id));
        checks.push({
          name: "local",
          status: "ok",
          detail: `${up.map((r) => `${r.id} (${r.models.length})`).join(", ")} running` + (unconfigured.length ? ` · unconfigured: ${unconfigured.map((r) => r.id).join(", ")}` : ""),
          fix: unconfigured.length ? `sc models local --add ${unconfigured[0]?.id}` : undefined,
        });
      } else {
        checks.push({ name: "local", status: "ok", detail: "no local services running (sc models local scans after installing one)" });
      }
    } catch {
      checks.push({ name: "local", status: "warn", detail: "local scan failed" });
    }
  }

  // exec approvals (Partial #8): effective policy, ledger health, common
  // misconfigurations. Read-only — one line surfaces the whole trust surface.
  {
    const { execModeOf } = await import("../config/schema.js");
    const { ledgerEntries, loadApprovalsDoc } = await import("../agent/exec-policy.js");
    const { Store } = await import("../state/db.js");
    const exec = load.config.tools.exec;
    let entries = 0;
    try {
      const { dbPath } = await import("../util/paths.js");
      entries = ledgerEntries(loadApprovalsDoc(Store.open(dbPath()))).length;
    } catch {
      /* ledger unreadable → report 0, the mode line still carries the policy */
    }
    const mode = execModeOf(exec);
    if (!exec.enabled && mode !== "deny") {
      checks.push({
        name: "exec",
        status: "warn",
        detail: `exec tool disabled but mode=${mode} — the disable wins silently`,
        fix: "tools.exec.enabled=false means the tool never registers; set mode=deny as well for a consistent policy posture",
      });
    } else if (exec.enabled && mode === "allowlist" && entries === 0) {
      checks.push({
        name: "exec",
        status: "warn",
        detail: "mode=allowlist with an empty ledger — every command will be denied",
        fix: "sc approvals allow <pattern>, or switch: sc approvals preset cautious",
      });
    } else if (exec.enabled && mode === "full") {
      checks.push({
        name: "exec",
        status: "warn",
        detail: `mode=full — host commands run WITHOUT operator prompts (yolo posture), ${entries} ledger entries`,
        fix: "sc approvals preset cautious to restore prompting",
      });
    } else {
      checks.push({
        name: "exec",
        status: "ok",
        detail: `${exec.enabled ? "enabled" : "disabled"} · mode=${mode} · askFallback=${exec.askFallback ?? "deny"} · ${entries} allowlist entries${exec.strictInlineEval ? " · strict inline eval" : ""}`,
      });
    }
  }

  // web search (Partial #9): enabled/provider readiness, no liveness probing.
  {
    const { WEB_SEARCH_BACKENDS, resolveProvider } = await import("../agent/web-search.js");
    const wsCfg = load.config.tools.web.search;
    if (!wsCfg.enabled) {
      checks.push({ name: "web search", status: "warn", detail: "disabled — the agent cannot search the web", fix: "tools.web.search.enabled=true (or sc config set tools.web.search.enabled true)" });
    } else {
      const explicit = wsCfg.provider.trim();
      const { provider, candidates } = resolveProvider(load.config);
      if (explicit && !provider) {
        checks.push({ name: "web search", status: "warn", detail: `provider "${explicit}" unknown`, fix: `providers: ${WEB_SEARCH_BACKENDS.map((b) => b.id).join(", ")}` });
      } else if (!provider) {
        checks.push({
          name: "web search",
          status: "warn",
          detail: "no provider ready — no API keys and no SearXNG baseUrl configured",
          fix: "export BRAVE_API_KEY=… (or TAVILY/PERPLEXITY/KIMI) or set tools.web.search.searxng.baseUrl",
        });
      } else {
        checks.push({ name: "web search", status: "ok", detail: `provider ${provider.id}${explicit ? " (explicit)" : " (auto)"}${candidates.length > 1 && !explicit ? ` · fallbacks: ${candidates.slice(1).map((b) => b.id).join(", ")}` : ""}` });
      }
    }
  }

  // model
  const model = load.config.agents.defaults.model;
  const providers = Object.keys(load.config.providers);
  if (model && providers.length > 0) {
    // resolve it the way the agent does, so a bare model id still counts
    let detail = `${model} via ${providers.join(", ")}`;
    let status: "ok" | "warn" = "ok";
    try {
      const resolved = resolveModel(model, load.config.providers as Record<string, { baseUrl: string; apiKey: string; models?: string[] }>);
      detail = `${resolved.model} via ${resolved.provider}`;
    } catch (err) {
      status = "warn";
      detail = (err as Error).message;
    }
    checks.push({ name: "model", status, detail });
  } else {
    checks.push({
      name: "model",
      status: model ? "warn" : "fail",
      detail: model ? `no providers configured for ${model}` : "agents.defaults.model is empty",
      fix: 'sc config set agents.defaults.model "openai/gpt-4o-mini"',
    });
  }

  // workspace
  const ws = workspaceDir();
  checks.push(
    existsSync(`${ws}/AGENTS.md`)
      ? { name: "workspace", status: "ok", detail: `${ws} (AGENTS.md present)` }
      : { name: "workspace", status: "warn", detail: `${ws} has no AGENTS.md`, fix: "sc init" },
  );

  // skills
  const skills = discoverSkills({
    roots: [
      { label: "workspace", dir: `${ws}/skills` },
      { label: "state", dir: `${stateDir()}/skills` },
      { label: "bundled", dir: bundledSkillsRoot() },
    ],
  });
  checks.push({
    name: "skills",
    status: "ok",
    detail: `${skills.length} found (${skills.filter((s) => s.eligible).length} ready): ${skills
      .slice(0, 5)
      .map((s) => s.name)
      .join(", ")}`,
  });

  // telegram
  const tg = load.config.channels.telegram;
  checks.push({
    name: "telegram",
    status: tg.enabled && tg.token ? "ok" : "warn",
    detail: tg.enabled ? (tg.token ? "enabled" : "enabled but token missing") : "disabled",
    ...(tg.enabled && !tg.token ? { fix: "sc config set channels.telegram.token <bot-token>" } : {}),
  });

  // port — skipped inside the daemon (the configured port is ours by then)
  if (!insideGateway) {
    const port = load.config.gateway.port ?? DEFAULT_PORT;
    const free = await portFree(port);
    checks.push({
      name: `port ${port}`,
      status: free ? "ok" : "warn",
      detail: free ? "available" : "in use (daemon may already be running)",
      ...(free ? {} : { fix: "sc status" }),
    });
  } else {
    checks.push({ name: "gateway", status: "ok", detail: "serving (this daemon answered the request)" });
  }

  // disk
  try {
    const stats = await import("node:fs").then((fs) => fs.statfsSync(stateDir()));
    const freeMb = (stats.bavail * stats.bsize) / 1024 / 1024;
    checks.push({
      name: "disk",
      status: freeMb > 200 ? "ok" : "warn",
      detail: `${Math.round(freeMb)} MB free at ${stateDir()}`,
    });
  } catch {
    /* statfs unavailable */
  }

  return checks;
}

export async function doctor(): Promise<number> {
  const checks = await runDoctorChecks();
  console.log(C.bold("\n  suparclaw doctor\n"));
  for (const check of checks) {
    const mark = check.status === "ok" ? C.ok : check.status === "warn" ? C.warn : C.fail;
    console.log(`  ${mark} ${check.name.padEnd(22)} ${check.detail}`);
    if (check.fix && check.status !== "ok") console.log(`    ${C.dim(`fix: ${check.fix}`)}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(
    `\n  ${fails === 0 ? C.ok : C.fail} ${fails} failing, ${warns} warning(s)   ${C.dim(logsDir())}\n`,
  );
  return fails === 0 ? 0 : 1;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    setTimeout(() => done(true), 400);
  });
}

export { STARTER_CONFIG, writeConfigFile, readFileSync };