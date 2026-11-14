// sc channels — channel status + one-tap connect (their `openclaw channels`
// parity). The daemon owns the live channel; this command is a thin WS client
// over channels.status / channels.telegram.connect, so the answer is always
// the real runtime state, not what config alone predicts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, stateDir } from "../util/paths.js";
import { readConfigFile } from "../config/load.js";

const fg = {
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

/** Token for local RPCs: env override, config secret, or the token file. */
function localAuthToken(): string {
  if (process.env["SUPARCLAW_TOKEN"]?.trim()) return process.env["SUPARCLAW_TOKEN"].trim();
  try {
    const cfg = readConfigFile(configPath());
    const auth = ((cfg.config as { gateway?: { auth?: Record<string, unknown> } }).gateway?.auth ?? {}) as Record<string, unknown>;
    if (typeof auth["token"] === "string" && auth["token"].trim()) return auth["token"].trim();
  } catch { /* fall through */ }
  try {
    const f = join(stateDir(), "token");
    if (existsSync(f)) return readFileSync(f, "utf8").trim();
  } catch { /* fall through */ }
  return "";
}

async function withGateway<T>(fn: (client: { request: (m: string, p?: Record<string, unknown>) => Promise<unknown> }) => Promise<T>): Promise<T | null> {
  const { GatewayClient } = await import("../gateway/ws-client.js");
  const token = localAuthToken();
  const cfg = readConfigFile(configPath());
  const gw = ((cfg.config as { gateway?: Record<string, unknown> }).gateway ?? {}) as Record<string, unknown>;
  const ports = [Number(gw["port"]) || null, Number(process.env["SUPARCLAW_GATEWAY_PORT"]) || null, 18790]
    .filter((p): p is number => Number.isFinite(p))
    .filter((p, i, arr) => arr.indexOf(p) === i);
  for (const port of ports) {
    try {
      const client = await GatewayClient.connect(`ws://127.0.0.1:${port}/ws`, token);
      try {
        return await fn(client as never);
      } finally {
        client.close();
      }
    } catch { /* try the next port */ }
  }
  return null;
}

export async function cmdChannels(rest: string[]): Promise<number> {
  const sub = rest[0] ?? "status";

  if (sub === "status") {
    const res = await withGateway(async (client) => client.request("channels.status"));
    if (res !== null) {
      const t = (res as { telegram: { enabled: boolean; running: boolean } }).telegram;
      setImmediate(() => process.exit(t.enabled && !t.running ? 1 : 0));
    }
    if (res === null) {
      console.log(fg.red("gateway offline") + fg.dim("  — start it first: sc gateway (or sc service install + start)"));
      return 1;
    }
    const tg = (res as { telegram: { enabled: boolean; hasToken: boolean; running: boolean; username: string; error: string } }).telegram;
    console.log();
    console.log(`  ${fg.bold("telegram")}  ${tg.enabled ? (tg.running ? fg.green("online") : fg.red("offline")) : fg.dim("disabled")}`);
    console.log(`           enabled: ${tg.enabled} · token: ${tg.hasToken ? fg.dim("set") : fg.red("missing")}`);
    if (tg.running && tg.username) console.log(`           bot: @${tg.username}`);
    if (tg.error) console.log(`           ${fg.red(`error: ${tg.error}`)}`);
    console.log();
    if (tg.enabled && !tg.running) {
      console.log(fg.dim(`           retry now: sc channels connect`));
      console.log();
    }
    const code = tg.enabled && !tg.running ? 1 : 0;
    if (code !== 0) process.exitCode = code;
    return code;
  }

  if (sub === "connect") {
    const res = await withGateway(async (client) => client.request("channels.telegram.connect"));
    const had = res !== null;
    if (had) setImmediate(() => process.exit((res as { ok: boolean }).ok ? 0 : 1));
    if (res === null) {
      console.log(fg.red("gateway offline") + fg.dim("  — start it first: sc gateway (or sc service install + start)"));
      return 1;
    }
    const r = res as { ok: boolean; username?: string; error?: string };
    if (r.ok) {
      console.log(fg.green(`telegram connected as @${r.username ?? "?"}`));
      return 0;
    }
    console.log(fg.red(`telegram connect failed: ${r.error ?? "unknown"}`));
    console.log(fg.dim("if api.telegram.org is blocked on your network, set a proxy first:"));
    console.log(fg.dim("  sc config set channels.telegram.proxy http://127.0.0.1:8080   then  sc channels connect"));
    console.log(fg.dim("otherwise paste a fresh @BotFather token — Settings → Channels → Bot token, or"));
    console.log(fg.dim(`  sc config set channels.telegram.token "123456:ABC…"   then  sc channels connect`));
    process.exitCode = 1;
    return 1;
  }

  console.log(fg.dim("usage: sc channels [status] | sc channels connect"));
  return sub === "help" || sub === "--help" ? 0 : 64;
}
