// `sc security audit` — posture review of the live config, in the spirit of
// `openclaw security audit`. OpenClaw's incident history (ClawJacked, CVE-
// 2026-25253, 135k exposed instances) says exactly which checks matter for a
// network-facing personal agent, so we run those here on every install.

import { statSync } from "node:fs";
import { execModeOf, type SuparClawConfig } from "../config/schema.js";
import { configPath } from "../util/paths.js";
import { readConfigFile } from "../config/load.js";

export interface Finding {
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

export interface AuditInput {
  config: SuparClawConfig;
  /** Permission bits of config.json5 (0o600 etc.), or undefined when missing. */
  configMode?: number;
}

/** Pure posture checks — exported so tests can drive every branch. */
export function auditConfig(input: AuditInput): Finding[] {
  const { config, configMode } = input;
  const findings: Finding[] = [];
  const gw = config.gateway;
  const token = gw.auth.token;

  // ---- network exposure -------------------------------------------------
  if (gw.bind === "loopback") {
    findings.push({ name: "gateway bind", status: "ok", detail: "loopback only (this device)" });
  } else if (gw.auth.mode === "token" && token) {
    findings.push({
      name: "gateway bind",
      status: "warn",
      detail: "LAN — other devices on this wifi can reach the gateway (token required)",
    });
  } else {
    findings.push({
      name: "gateway bind",
      status: "fail",
      detail: "LAN bind with no usable token — any device on the network controls the agent",
      fix: 'sc config set gateway.auth.mode "token"  # then: sc init',
    });
  }

  // ---- gateway auth -----------------------------------------------------
  if (gw.auth.mode === "none") {
    findings.push({
      name: "gateway auth",
      status: "warn",
      detail: "disabled — any local client can connect and drive the agent",
      fix: 'sc config set gateway.auth.mode "token"',
    });
  } else if (!token) {
    findings.push({
      name: "gateway auth",
      status: "fail",
      detail: "token mode but no token set (fail-closed: only this device's own UI can connect)",
      fix: "sc init   # generates a gateway token",
    });
  } else if (token.length < 16) {
    findings.push({
      name: "gateway auth",
      status: "warn",
      detail: "gateway token is short — rotate it",
      fix: "sc token --rotate",
    });
  } else {
    findings.push({ name: "gateway auth", status: "ok", detail: `token set (${token.length} chars)` });
  }

  findings.push({
    name: "loopback bypass",
    status: "ok",
    detail: gw.auth.loopbackBypass
      ? "on — this device's own browser/native clients skip the token (origin-checked)"
      : "off — every client must present the token",
  });

  // ---- transport trust --------------------------------------------------
  const foreignOrigins = (gw.allowedOrigins ?? []).filter((o) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(o));
  if (foreignOrigins.length > 0) {
    findings.push({
      name: "ws origin policy",
      status: "warn",
      detail: `cross-origin web UIs allowed: ${foreignOrigins.join(", ")}`,
    });
  } else {
    findings.push({
      name: "ws origin policy",
      status: "ok",
      detail: "Host allowlist + same-origin WS upgrades (CSWSH/DNS-rebinding defended)",
    });
  }
  if ((gw.allowedHosts ?? []).length > 0) {
    findings.push({
      name: "host allowlist",
      status: "warn",
      detail: `extra hosts accepted: ${gw.allowedHosts.join(", ")}`,
    });
  }

  // ---- tools ------------------------------------------------------------
  // Judge the effective mode, not the legacy approvals bool: mode=full with
  // approvals=true used to be reported as gated, which was simply false.
  const execMode = execModeOf(config.tools.exec);
  if (!config.tools.exec.enabled) {
    findings.push({ name: "exec tool", status: "ok", detail: "disabled" });
  } else if (execMode === "deny") {
    findings.push({ name: "exec tool", status: "ok", detail: "enabled but refusing every command (mode=deny)" });
  } else if (execMode === "allowlist") {
    findings.push({ name: "exec tool", status: "ok", detail: "enabled — allowlisted commands and safe bins only" });
  } else if (execMode === "ask") {
    findings.push({
      name: "exec tool",
      status: "warn",
      detail: "enabled — every command asks for approval first (mode=ask)",
    });
  } else {
    // mode=full is now the shipped default, so it is a posture note, not a
    // broken install: a healthy `sc init` must keep auditing clean. Someone who
    // also flipped the legacy switch off has deliberately removed the gate, and
    // that stays a finding.
    const legacyOff = config.tools.exec.approvals === false;
    findings.push({
      name: "exec tool",
      status: legacyOff ? "fail" : "warn",
      detail: legacyOff
        ? "enabled in mode=full with approvals:false — every command, including from scheduled jobs, runs without asking"
        : "enabled in mode=full — every command runs without asking (the default; gate it with sc approvals mode ask)",
      fix: "sc approvals mode ask",
    });
  }

  // ---- channels ---------------------------------------------------------
  const tg = config.channels.telegram;
  if (tg.enabled) {
    if (tg.dmPolicy === "open") {
      findings.push({
        name: "telegram DMs",
        status: "warn",
        detail: "open — anyone who finds the bot can talk to your agent",
        fix: 'sc config set channels.telegram.dmPolicy "pairing"',
      });
    } else {
      findings.push({ name: "telegram DMs", status: "ok", detail: `${tg.dmPolicy} policy` });
    }
    if (tg.groupPolicy === "open" && !tg.mentionGated) {
      findings.push({
        name: "telegram groups",
        status: "warn",
        detail: "open groups without mention gating — the bot answers everything",
      });
    }
  }

  // ---- secrets on disk --------------------------------------------------
  if (configMode === undefined) {
    findings.push({ name: "config file", status: "warn", detail: "config.json5 not found yet" });
  } else if ((configMode & 0o077) !== 0) {
    findings.push({
      name: "config file",
      status: "warn",
      detail: "config.json5 holds API keys but is readable by other users",
      fix: `chmod 600 ${configPath()}`,
    });
  } else {
    findings.push({ name: "config file", status: "ok", detail: "permissions 600-ish (owner only)" });
  }

  // ---- injection surface ------------------------------------------------
  const web = config.tools.web;
  if (web.fetch || web.search) {
    findings.push({
      name: "web tools",
      status: "ok",
      detail: "enabled — fetched pages are untrusted input (prompt injection possible)",
    });
  }

  return findings;
}

export async function securityCmd(args: string[]): Promise<number> {
  const what = args[0] ?? "audit";
  if (what !== "audit") {
    console.error(`unknown security subcommand: ${what} (try: sc security audit)`);
    return 1;
  }

  const load = readConfigFile();
  let configMode: number | undefined;
  try {
    configMode = statSync(load.path).mode;
  } catch {
    configMode = undefined;
  }

  const findings = auditConfig({ config: load.config, configMode });
  console.log(`${C.bold("suparclaw security audit")} ${C.dim(load.path)}\n`);
  for (const f of findings) {
    const mark = f.status === "ok" ? C.ok : f.status === "warn" ? C.warn : C.fail;
    console.log(`  ${mark} ${f.name.padEnd(18)} ${f.detail}`);
    if (f.fix) console.log(`      ${C.dim("fix:")} ${f.fix}`);
  }
  const fails = findings.filter((f) => f.status === "fail").length;
  const warns = findings.filter((f) => f.status === "warn").length;
  console.log(
    `\n  ${fails === 0 ? C.ok : C.fail} ${fails} failing · ${warns} warning${warns === 1 ? "" : "s"}`,
  );
  return fails > 0 ? 1 : 0;
}
