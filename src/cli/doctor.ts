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

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

const C = {
  ok: "\x1b[32m✔\x1b[39m",
  warn: "\x1b[33m▲\x1b[39m",
  fail: "\x1b[31m✖\x1b[39m",
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

export async function doctor(): Promise<number> {
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

  // port
  const port = load.config.gateway.port ?? DEFAULT_PORT;
  const free = await portFree(port);
  checks.push({
    name: `port ${port}`,
    status: free ? "ok" : "warn",
    detail: free ? "available" : "in use (daemon may already be running)",
    ...(free ? {} : { fix: "sc status" }),
  });

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