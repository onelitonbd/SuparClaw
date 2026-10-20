import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, ensureDirs, webUiRoot, dbPath } from "../util/paths.js";
import { brandLine, card, celebrate, checklist, fg, kv, voiceLine } from "./brand.js";

// Service, the store and the agent runtime load per command, so `sc version`
// and `sc help` never pay for node:sqlite, tools or the model client.
async function openService(configPathOverride?: string) {
  const [{ Service }] = await Promise.all([import("../agent/service.js")]);
  return new Service(configPathOverride);
}

export const VERSION = "0.1.0";

const HELP = `${fg.accentBright("///")} ${fg.bold("suparclaw")} ${VERSION} — ${fg.info("your phone is the machine.")}

usage: sc <command> [options]

commands:
  chat, tui            open the terminal UI (default)
  gateway              run the daemon (channels + gateway + cron)
  gateway list         show running gateways with pid, uptime and port
  gateway --restart    stop the running one and take over its port
  setup                guided first-run setup: pick a provider, key and model
  provider <list|add|remove|test>  manage providers
  init                 create workspace files and a gateway token
  status               show health and configuration summary
  doctor               diagnose this device
  security [audit]     review gateway/tool/channel security posture
  stop                    stop a running gateway (pid file)
  config <get|set|path>  read or write config values
  token [--rotate]      show (or regenerate) the gateway token
  pair <list|approve|revoke>  manage Telegram DM access
  cron <list|add|remove>       scheduled prompts
  service <install|status|uninstall>  termux-services integration
  version              print version

options:
  --url <ws://host:port>  connect the TUI to a remote gateway
  --token <token>         gateway token (or $SUPARCLAW_TOKEN)
  --port <n>              override gateway port
`;

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

export async function main(argv: string[]): Promise<number> {
  const [command = "chat", ...rest] = argv;

  // Commands load their own chunk: `sc version` never parses the TUI or the gateway.
  switch (command) {
    case "chat":
    case "tui": {
      const url = flag(rest, "--url");
      const { tuiLocal, tuiRemote } = await import("./tui-commands.js");
      if (url) return tuiRemote(url, flag(rest, "--token") ?? process.env["SUPARCLAW_TOKEN"] ?? "");
      return tuiLocal();
    }
    case "gateway": {
      if (rest[0] === "list") return gatewayList();
      const { Gateway } = await import("../gateway/server.js");
      return gateway(rest, Gateway);
    }
    case "setup":
      return (await import("./provider.js")).setupCmd();
    case "provider":
      return (await import("./provider.js")).providerCmd(rest);
    case "doctor":
      return (await import("./doctor.js")).doctor();
    case "security":
      return (await import("./audit.js")).securityCmd(rest);
    case "init":
      return init();
    case "status":
      return status();
    case "config":
      return configCmd(rest);
    case "pair":
      return pairCmd(rest);
    case "cron":
      return cronCmd(rest);
    case "token":
      return tokenCmd(rest);
    case "service":
      return (await import("./service.js")).serviceCmd(rest);
    case "stop":
      return stopCmd(rest);
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

async function init(): Promise<number> {
  console.log(`\n${brandLine("· " + "your phone is the machine.")}\n`);
  ensureDirs();
  const madeConfig = !existsSync(configPath());
  if (madeConfig) {
    const { STARTER_CONFIG } = await import("../config/load.js");
    writeFileSync(configPath(), STARTER_CONFIG, "utf8");
  }
  const service = await openService();
  const { created, token } = service.bootstrap();
  const files = [
    ...(madeConfig ? ["config.json5"] : []),
    ...created.filter((f) => !(madeConfig && f.startsWith("config.json5"))),
  ];
  console.log(
    card([
      celebrate(`workspace ready ${fg.muted("(~/.suparclaw/workspace)")}`),
      "",
      ...files.map((f) => kv(f.startsWith("config") ? "config" : "workspace", f)),
      kv("gateway token", `${fg.bold(token.slice(0, 8))}${fg.muted("…")} ${fg.muted("(sc token)")}`),
    ]),
  );
  if (files.length === 0) console.log(`  ${fg.muted("workspace already initialized")}`);
  console.log(`\n  ${fg.muted(voiceLine())}\n`);
  console.log(`  ${fg.bold("next steps")}`);
  console.log(`    ${fg.accent("1")}  sc doctor            check this device`);
  console.log(`    ${fg.accent("2")}  sc security audit    lock down the gateway`);
  console.log(`    ${fg.accent("3")}  sc setup             connect a model provider`);
  console.log(`    ${fg.accent("4")}  sc chat              say hello`);
  console.log(`    ${fg.accent("5")}  sc gateway           run the daemon\n`);
  void service.stop();
  return 0;
}

async function status(): Promise<number> {
  // Prefer the RUNNING gateway — that is the thing with moving parts. The
  // offline view below is what you get when no daemon is up (like OpenClaw's
  // doctor vs `status --deep`).
  const candidates: number[] = [];
  const envPort = Number.parseInt(process.env["SUPARCLAW_GATEWAY_PORT"] ?? "", 10);
  if (Number.isFinite(envPort) && envPort > 0) candidates.push(envPort);
  try {
    for (const p of await (await import("./service.js")).listGateways()) {
      if (p.port) candidates.push(p.port);
    }
  } catch {
    /* fall through to the default */
  }
  candidates.push(18790);
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(1200),
      });
      if (res.ok) {
        const live = (await res.json()) as Record<string, unknown>;
        const health = await probeHealth(port);
        console.log(JSON.stringify({ live: true, gatewayPort: port, health, ...live }, null, 2));
        return 0;
      }
    } catch {
      /* try the next candidate */
    }
  }
  const service = await openService();
  const health = service.health();
  const info = service.status();
  console.log(JSON.stringify({ live: false, health, ...info }, null, 2));
  await service.stop();
  return 0;
}

async function stopCmd(args: string[]): Promise<number> {
  const { stopService } = await import("./service.js");
  const arg = args[0]?.trim();
  const pid = arg ? Number.parseInt(arg, 10) : undefined;
  if (arg && !Number.isFinite(pid)) {
    console.error(`'${arg}' is not a pid — see: sc gateway list`);
    return 1;
  }
  const result = await stopService(pid);
  console.log(result.message);
  return result.ok ? 0 : 1;
}

async function gatewayList(): Promise<number> {
  const { listGateways, formatUptime } = await import("./service.js");
  const procs = await listGateways();
  if (procs.length === 0) {
    console.log("no SuparClaw gateway is running");
    return 0;
  }
  console.log("PID      UPTIME     PORT    STATUS      COMMAND");
  for (const p of procs) {
    const up = p.uptimeSec === null ? "?" : formatUptime(p.uptimeSec);
    const port = p.port ? String(p.port) : "-";
    const status = p.healthy ? "healthy" : p.port ? "unresponsive" : "unknown";
    console.log(`${String(p.pid).padEnd(9)}${up.padEnd(11)}${port.padEnd(8)}${status.padEnd(12)}${p.cmd}`);
  }
  console.log("\nstop one with: sc stop <pid>");
  return 0;
}

/** Is something healthy answering on our port? */
async function probeHealth(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function waitForPort(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await probeHealth(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function gateway(args: string[], GatewayCtor: typeof import("../gateway/server.js").Gateway): Promise<number> {
  const port = flag(args, "--port");
  const restart = args.includes("--restart");
  const targetPort = port ? Number.parseInt(port, 10) : 18790;
  const existing = await probeHealth(targetPort);

  if (existing && !restart) {
    console.error(`a SuparClaw gateway is already running on port ${targetPort}`);
    console.error("  stop it:   sc stop");
    console.error("  or restart: sc gateway --restart");
    console.error(`  it has been up ${Math.round(Number(existing["uptimeMs"] ?? 0) / 1000)}s`);
    return 1;
  }
  if (existing && restart) {
    console.log("stopping the running gateway…");
    const result = await (await import("./service.js")).stopService();
    console.log(`  ${result.message}`);
    if (!(await waitForPort(targetPort, 6000))) {
      console.error("the old daemon is still holding the port — try: pkill -f 'sc.js gateway'");
      return 1;
    }
  }

  const service = await openService();
  if (port) {
    const result = service.configSvc.setPath("gateway.port", Number.parseInt(port, 10));
    if (!result.ok) {
      console.error(`invalid port: ${result.errors[0]}`);
      return 1;
    }
  }
  service.bootstrap();
  const gw = new GatewayCtor(service, service.log, webUiRoot());
  try {
    await gw.start();
  } catch (err) {
    const message = (err as Error).message;
    if (/EADDRINUSE/.test(message)) {
      console.error(`port ${service.config.gateway.port} is already in use by another process.`);
      console.error("  find it:  lsof -i :${service.config.gateway.port}   (pkg install lsof)");
      console.error("  or stop ours: sc stop");
    } else {
      console.error(`gateway failed to start: ${message}`);
    }
    return 1;
  }
  await service.startChannels();
  (await import("./service.js")).writePid(service.config.gateway.port);
  const auth = service.config.gateway.auth;
  const uiHost = gw.address.replace("0.0.0.0", "127.0.0.1");
  console.log(`\n${brandLine("gateway")}`);
  console.log(`  ${fg.muted("ws")}       ws://${gw.address}/ws`);
  console.log(`  ${fg.muted("web ui")}   http://${uiHost}/`);
  console.log(`  ${fg.muted("health")}   http://${uiHost}/health`);
  if (auth.mode === "none") {
    console.log(`  ${fg.muted("auth")}     ${fg.warn("disabled")}`);
  } else {
    console.log(`  ${fg.muted("token")}    ${fg.bold(auth.token.slice(0, 8))}${fg.muted("…")} ${fg.muted("(sc token)")}`);
    console.log(`           ${fg.muted("this device's browser connects automatically;")}`);
    console.log(`           ${fg.muted("remote: sc tui --url ws://host:port --token <token>")}`);
  }
  console.log("");
  console.log(checklist(service.readiness()));
  console.log("");
  console.log("press ctrl+c to stop");

  const shutdown = async () => {
    console.log("\nstopping…");
    await gw.stop();
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {}); // run until signalled
  return 0;
}

async function configCmd(args: string[]): Promise<number> {
  const [sub = "get", ...rest] = args;
  const service = await openService();
  const path = rest[0];
  switch (sub) {
    case "path":
      console.log(configPath());
      return 0;
    case "get": {
      if (!path) {
        console.log(JSON.stringify(service.config, null, 2));
      } else {
        console.log(JSON.stringify(service.configSvc.get(path), null, 2));
      }
      return 0;
    }
    case "set": {
      if (!path || rest.length < 2) {
        console.error("usage: sc config set <dotted.path> <value>");
        return 1;
      }
      const raw = rest.slice(1).join(" ");
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        /* keep string */
      }
      const result = service.configSvc.setPath(path, value);
      if (!result.ok) {
        console.error("invalid config:");
        for (const e of result.errors) console.error(`  ${e}`);
        return 1;
      }
      console.log(`${path} = ${JSON.stringify(value)}`);
      return 0;
    }
    default:
      console.error(`unknown config subcommand: ${sub}`);
      return 1;
  }
}

async function tokenCmd(args: string[]): Promise<number> {
  const service = await openService();
  const auth = service.config.gateway.auth;
  if (args[0] === "--rotate") {
    const next = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const result = service.configSvc.setPath("gateway.auth.token", next);
    if (!result.ok) {
      console.error(result.errors.join("\n"));
      return 1;
    }
    console.log("new gateway token (restart sc gateway to use it):");
    console.log(next);
    return 0;
  }
  if (auth.mode === "none") {
    console.log("auth is disabled (gateway.auth.mode = none) — no token needed");
  } else if (!auth.token) {
    console.log("no token yet — run: sc init");
    return 1;
  } else {
    console.log(auth.token);
  }
  return 0;
}

async function pairCmd(args: string[]): Promise<number> {
  const [sub = "list", id] = args;
  const service = await openService();
  const current = service.config.channels.telegram.allowFrom;
  switch (sub) {
    case "list":
      console.log(current.length > 0 ? current.join("\n") : "(no paired ids)");
      return 0;
    case "approve": {
      if (!id) {
        console.error("usage: sc pair approve <telegram-user-id>");
        return 1;
      }
      if (current.includes(id)) {
        console.log(`${id} already allowed`);
        return 0;
      }
      service.configSvc.setPath("channels.telegram.allowFrom", [...current, id]);
      console.log(`approved ${id}`);
      return 0;
    }
    case "revoke": {
      if (!id) {
        console.error("usage: sc pair revoke <telegram-user-id>");
        return 1;
      }
      service.configSvc.setPath("channels.telegram.allowFrom", current.filter((x) => x !== id));
      console.log(`revoked ${id}`);
      return 0;
    }
    default:
      console.error(`unknown pair subcommand: ${sub}`);
      return 1;
  }
}

async function cronCmd(args: string[]): Promise<number> {
  const [sub = "list", ...rest] = args;
  const { Store } = await import("../state/db.js");
  const store = Store.open(dbPath());
  switch (sub) {
    case "list": {
      const jobs = store.listJobs();
      if (jobs.length === 0) {
        console.log("(no jobs) — add with: sc cron add <name> <schedule> <prompt>");
        return 0;
      }
      for (const job of jobs) {
        const next = await safeNext(job.schedule);
        console.log(`${job.id}  ${job.name}  [${job.schedule}]  next ${next}  ${job.enabled ? "" : "(paused)"}`);
        console.log(`   → ${job.prompt.slice(0, 90)}`);
      }
      return 0;
    }
    case "add": {
      const [name, schedule, ...promptParts] = rest;
      if (!name || !schedule || promptParts.length === 0) {
        console.error("usage: sc cron add <name> <cron-expression> <prompt>");
        return 1;
      }
      try {
        const { Cron } = await import("croner");
        new Cron(schedule, { paused: true });
      } catch (err) {
        console.error(`invalid schedule: ${(err as Error).message}`);
        return 1;
      }
      const id = name.replace(/\W+/g, "-").toLowerCase();
      store.upsertJob({
        id,
        name,
        schedule,
        prompt: promptParts.join(" "),
        session_key: `cron:${id}`,
        enabled: 1,
      });
      console.log(`added ${id} (${schedule})`);
      console.log(`next ${await safeNext(schedule)}`);
      return 0;
    }
    case "remove": {
      const id = rest[0];
      if (!id) {
        console.error("usage: sc cron remove <id>");
        return 1;
      }
      const existed = store.getJob(id) !== undefined;
      store.deleteJob(id);
      console.log(existed ? `removed ${id}` : `no such job: ${id}`);
      return 0;
    }
    default:
      console.error(`unknown cron subcommand: ${sub}`);
      return 1;
  }
}

async function safeNext(schedule: string): Promise<string> {
  try {
    const { Cron } = await import("croner");
    return new Cron(schedule, { paused: true }).nextRun()?.toISOString() ?? "?";
  } catch {
    return "?";
  }
}

export { tuiLocal, tuiRemote } from "./tui-commands.js";
