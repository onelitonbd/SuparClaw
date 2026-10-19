import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, ensureDirs, webUiRoot, dbPath } from "../util/paths.js";

// Service, the store and the agent runtime load per command, so `sc version`
// and `sc help` never pay for node:sqlite, tools or the model client.
async function openService(configPathOverride?: string) {
  const [{ Service }] = await Promise.all([import("../agent/service.js")]);
  return new Service(configPathOverride);
}

export const VERSION = "0.1.0";

const HELP = `suparclaw ${VERSION} — personal AI gateway that runs on your phone

usage: sc <command> [options]

commands:
  chat, tui            open the terminal UI (default)
  gateway              run the daemon (channels + gateway + cron)
  init                 create workspace files and a gateway token
  status               show health and configuration summary
  doctor               diagnose this device
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
      const { Gateway } = await import("../gateway/server.js");
      return gateway(rest, Gateway);
    }
    case "doctor":
      return (await import("./doctor.js")).doctor();
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
  ensureDirs();
  if (!existsSync(configPath())) {
    const { STARTER_CONFIG } = await import("../config/load.js");
    writeFileSync(configPath(), STARTER_CONFIG, "utf8");
    console.log(`created ${configPath()}`);
  }
  const service = await openService();
  const { created, token } = service.bootstrap();
  for (const file of created) console.log(`created ${file}`);
  if (!created.length) console.log("workspace already initialized");
  console.log(`\ngateway token: ${token.slice(0, 8)}…\n`);
  console.log("next:");
  console.log("  sc doctor                      # check the device");
  console.log('  sc config set agents.defaults.model "openai/gpt-4o-mini"');
  console.log('  sc config set providers.openai.baseUrl "https://api.openai.com/v1"');
  console.log('  sc config set providers.openai.apiKey "sk-..."');
  console.log("  sc chat                        # start here");
  console.log("");
  void service.stop();
  return 0;
}

async function status(): Promise<number> {
  const service = await openService();
  const health = service.health();
  const info = service.status();
  console.log(JSON.stringify({ health, ...info }, null, 2));
  await service.stop();
  return 0;
}

async function gateway(args: string[], GatewayCtor: typeof import("../gateway/server.js").Gateway): Promise<number> {
  const port = flag(args, "--port");
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
    console.error(`gateway failed to start: ${(err as Error).message}`);
    return 1;
  }
  await service.startChannels();
  (await import("./service.js")).writePid();
  const auth = service.config.gateway.auth;
  console.log(`suparclaw gateway listening on ws://${gw.address}/ws`);
  console.log(`web ui:  http://${gw.address.replace("0.0.0.0", "127.0.0.1")}/`);
  console.log(`health:  http://${gw.address.replace("0.0.0.0", "127.0.0.1")}/health`);
  if (auth.mode === "none") {
    console.log("auth:    disabled");
  } else {
    console.log(`token:   ${auth.token}`);
    console.log("         (the browser on this device connects automatically;");
    console.log("          from another machine use: sc tui --url … --token <token>)");
  }
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
