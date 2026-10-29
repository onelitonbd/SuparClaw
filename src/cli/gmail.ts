// `sc gmail` — machine-facing control for the built-in Gmail add-on.
// OAuth is started by the live Gateway so the same unlocked encrypted vault
// receives the refresh token; this CLI never handles or prints OAuth tokens.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient } from "../gateway/ws-client.js";
import { configPath, stateDir } from "../util/paths.js";
import { readConfigFile } from "../config/load.js";

const out = (text = ""): void => { process.stdout.write(`${text}\n`); };

function localAuthToken(): string {
  if (process.env["SUPARCLAW_TOKEN"]?.trim()) return process.env["SUPARCLAW_TOKEN"].trim();
  try {
    const cfg = readConfigFile(configPath());
    const gateway = (cfg.config as { gateway?: { auth?: { token?: unknown } } }).gateway;
    if (typeof gateway?.auth?.token === "string" && gateway.auth.token.trim()) return gateway.auth.token.trim();
  } catch { /* use token file */ }
  try {
    const file = join(stateDir(), "token");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch { /* no token */ }
  return "";
}

async function withGateway<T>(fn: (client: GatewayClient) => Promise<T>): Promise<T | null> {
  const cfg = readConfigFile(configPath());
  const gateway = (cfg.config as { gateway?: { port?: number } }).gateway;
  const port = Number(gateway?.port ?? 18790) || 18790;
  let client: GatewayClient;
  try { client = await GatewayClient.connect(`ws://127.0.0.1:${port}/ws`, localAuthToken()); }
  catch { return null; }
  try { return await fn(client); }
  finally { client.close(); }
}

function usage(exitCode = 1): number {
  out("usage: sc gmail <status|connect|disconnect>");
  out("");
  out("  status       account, scopes, vault availability");
  out("  connect      start Google OAuth in the running Gateway; open the printed URL");
  out("  disconnect   forget the Gmail refresh token (vault must be unlocked)");
  return exitCode;
}

export async function cmdGmail(args: string[]): Promise<number> {
  const sub = (args[0] ?? "status").replace(/^--/, "");
  if (sub === "help" || sub === "--help") return usage(0);
  if (sub === "status") {
    let live: any = null;
    try { live = await withGateway((client) => client.request("gmail.status")); } catch { /* read local metadata below */ }
    let status: any = live;
    if (!status) {
      const { Service } = await import("../agent/service.js");
      const service = new Service();
      try { status = service.gmailStatus(); }
      finally { await service.stop(); }
    }
    if (!status) { out("could not read Gmail status"); return 1; }
    out(`configured  ${status.configured ? "yes" : "no — set addons.gmail.clientId"}`);
    out(`enabled     ${status.enabled ? "yes" : "no"}`);
    out(`connected   ${status.connected ? "yes" : "no"}`);
    if (status.connected) out(`account     ${status.account}`);
    out(`vault       ${status.vaultInitialized ? status.vaultUnlocked ? "unlocked" : "locked" : "not initialized"}`);
    out(`usable      ${status.usable ? "yes" : status.connected ? "no — unlock the encrypted vault in Settings" : "no — not connected"}`);
    if (status.scopes?.length) out(`scopes      ${status.scopes.map((s: string) => s.split("/").at(-1)).join(", ")}`);
    if (status.error) out(`note        ${status.error}`);
    return 0;
  }
  if (sub === "connect") {
    let started: { flow: string; authUrl: string } | null;
    try { started = await withGateway((client) => client.request("gmail.connect")) as { flow: string; authUrl: string } | null; }
    catch (err) { out(`could not start Gmail sign-in: ${(err as Error).message}`); return 1; }
    if (!started) {
      out("Gmail connect needs the running Gateway with the encrypted vault unlocked.");
      out("  start `sc gateway`, unlock the vault in Settings, then retry.");
      return 1;
    }
    out("Open this Google authorization URL on the same phone:");
    out(started.authUrl);
    out("");
    out("Waiting for consent… press Ctrl+C to stop waiting (the Gateway flow expires automatically).");
    for (let i = 0; i < 240; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const status = await withGateway((client) => client.request("gmail.status")) as any;
      if (status?.error && !status?.connecting) {
        out(`Gmail connection failed: ${status.error}`);
        return 1;
      }
      if (status?.connected && status?.usable && !status?.connecting) {
        out(`Connected as ${status.account}.`);
        return 0;
      }
    }
    out("Timed out waiting for Gmail authorization.");
    return 1;
  }
  if (sub === "disconnect") {
    let result: { disconnected: boolean } | null;
    try { result = await withGateway((client) => client.request("gmail.disconnect")) as { disconnected: boolean } | null; }
    catch (err) { out(`could not disconnect Gmail: ${(err as Error).message}`); return 1; }
    if (!result) {
      out("Gmail disconnect needs the running Gateway with the encrypted vault unlocked.");
      return 1;
    }
    out(result.disconnected ? "Gmail disconnected; its refresh token was removed from the vault." : "Gmail was already disconnected.");
    return 0;
  }
  return usage();
}
