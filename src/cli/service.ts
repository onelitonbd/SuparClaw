import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logsDir, pidPath, prefixDir, stateDir, readTextSafe } from "../util/paths.js";
import { isTermux } from "../util/paths.js";
import { SUPERVISOR_PID_ENV } from "../gateway/supervise.js";

const SERVICE_NAME = "suparclaw";
const SYSTEMD_UNIT = "suparclaw-gateway.service";
const LAUNCHD_LABEL = "ai.suparclaw.gateway";

export type ServiceManager = "termux-services" | "systemd-user" | "launchd" | null;

function which(cmd: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${cmd}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** The daemon manager this device supports, Termux first. */
export function detectManager(): ServiceManager {
  if (isTermux()) return existsSync(`${prefixDir()}/var/service`) ? "termux-services" : null;
  if (process.platform === "linux" && which("systemctl")) return "systemd-user";
  if (process.platform === "darwin" && which("launchctl")) return "launchd";
  return null;
}

function runitRunScript(): string {
  const bash = `${prefixDir()}/bin/bash`;
  const sc = `${prefixDir()}/bin/sc`;
  return `#!/data/data/com.termux/files/usr/bin/bash
# SuparClaw gateway daemon (termux-services; runit supervises restarts).
exec ${bash} -lc 'exec ${sc} gateway --no-supervise >> ${stateDir()}/logs/service.log 2>&1'
`;
}

function systemdUnit(): string {
  const node = process.execPath;
  const entry = process.argv[1] as string;
  return `[Unit]
Description=SuparClaw gateway daemon
After=network-online.target

[Service]
ExecStart=${node} ${entry} gateway --no-supervise
Restart=always
RestartSec=1
StandardOutput=append:${stateDir()}/logs/service.log
StandardError=append:${stateDir()}/logs/service.log

[Install]
WantedBy=default.target
`;
}

function launchdPlist(): string {
  const node = process.execPath;
  const entry = process.argv[1] as string;
  const log = `${stateDir()}/logs/service.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${entry}</string><string>gateway</string><string>--no-supervise</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

function serviceLogPath(): string {
  return join(logsDir(), "service.log");
}

export interface ServiceStatus {
  installed: boolean;
  manager: ServiceManager;
  path: string;
  pid: number | null;
  supervisor: number | null;
  running: boolean;
  bootEnabled: boolean;
  startedAt: number | null;
}

function runitDir(): string {
  return `${prefixDir()}/var/service/${SERVICE_NAME}`;
}

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

interface PidRecord {
  pid: number;
  port: number | null;
  supervisor: number | null;
  startedAt: number | null;
}

function alive(pid: number | null | undefined): pid is number {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(): PidRecord | null {
  const file = pidPath();
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  if (/^\d+$/.test(raw)) return { pid: Number.parseInt(raw, 10), port: null, supervisor: null, startedAt: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = Number(parsed["pid"]);
    if (!Number.isFinite(pid)) return null;
    const num = (k: string): number | null => (Number.isFinite(Number(parsed[k])) ? Number(parsed[k]) : null);
    return { pid, port: num("port"), supervisor: num("supervisor"), startedAt: num("startedAt") };
  } catch {
    return null;
  }
}

/** Who owns this gateway, and will it come back after a crash/reboot? */
export function serviceStatus(): ServiceStatus {
  const manager = detectManager();
  const path =
    manager === "termux-services" ? join(runitDir(), "run")
    : manager === "systemd-user" ? systemdUnitPath()
    : manager === "launchd" ? launchdPlistPath()
    : "(no service manager found)";
  const installed = manager !== null && existsSync(path);
  let bootEnabled = false;
  if (manager === "systemd-user" && installed) {
    bootEnabled = existsSync(join(homedir(), ".config", "systemd", "user", "default.target.wants", SYSTEMD_UNIT));
  } else if (manager === "launchd") {
    bootEnabled = installed; // RunAtLoad=true is in the plist
  } else if (manager === "termux-services") {
    bootEnabled = installed; // runit runs enabled services when runsvdir starts
  }
  const rec = readPidFile();
  const pid = rec && alive(rec.pid) ? rec.pid : null;
  const supervisor = rec && alive(rec.supervisor) ? rec.supervisor : null;
  return {
    installed,
    manager,
    path,
    pid,
    supervisor,
    running: pid !== null,
    bootEnabled,
    startedAt: pid !== null ? rec?.startedAt ?? null : null,
  };
}

/** Runtime facts the web UI Service card renders (OpenClaw's status --deep, lite). */
export function serviceRuntimeInfo(): Record<string, unknown> {
  const s = serviceStatus();
  const rec = readPidFile();
  const supervised = s.supervisor !== null;
  return {
    manager: s.manager,
    installed: s.installed,
    servicePath: s.path,
    bootEnabled: s.bootEnabled,
    running: s.running,
    pid: s.pid,
    supervisorPid: s.supervisor,
    supervised,
    mode: supervised ? "supervised" : s.installed ? "service" : s.running ? "single" : "stopped",
    port: rec?.port ?? null,
    startedAt: s.running ? s.startedAt : null,
    logPath: serviceLogPath(),
    // A restart request only survives process exit when something respawns us.
    restartSupported: supervised || s.installed,
    supervisorEnv: Number.isFinite(Number(process.env[SUPERVISOR_PID_ENV])) ? Number(process.env[SUPERVISOR_PID_ENV]) : null,
  };
}

/** Last N lines of the daemon log (plus the app log when the service log is empty). */
export function serviceLogTail(lines = 30): { path: string; lines: string[] } {
  const primary = serviceLogPath();
  const fallback = join(logsDir(), "suparclaw.log");
  const pick = [primary, fallback].filter((p) => existsSync(p) && (statSync(p).size ?? 0) > 0)[0] ?? primary;
  const text = readTextSafe(pick) ?? "";
  const all = text.split("\n").filter((l) => l.trim() !== "");
  return { path: pick, lines: all.slice(-Math.max(1, lines)) };
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const x = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${x}s`;
  return `${x}s`;
}

export function installService(): { ok: boolean; message: string } {
  mkdirSync(logsDir(), { recursive: true });
  const manager = detectManager();
  if (manager === "termux-services") {
    const dir = runitDir();
    const path = join(dir, "run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, runitRunScript(), "utf8");
    chmodSync(path, 0o755);
    const boot: string[] = [];
    try { execFileSync("sv-enable", [SERVICE_NAME], { stdio: "pipe" }); boot.push("enabled at boot: sv-enable suparclaw"); } catch { boot.push("enable manually: sv-enable suparclaw"); }
    try { execFileSync("sv", ["up", SERVICE_NAME], { stdio: "pipe" }); boot.push("started: sv up suparclaw"); } catch { boot.push("start manually: sv up suparclaw"); }
    return {
      ok: true,
      message: [`installed ${path} (termux-services; restarts on crash and at boot)`, ...boot, "", "see it: sc service status · logs: sc service logs"].join("\n"),
    };
  }
  if (manager === "systemd-user") {
    const unit = systemdUnitPath();
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unit, systemdUnit(), "utf8");
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "pipe" });
    } catch (err) {
      return { ok: false, message: `wrote ${unit} but systemctl failed: ${(err as Error).message}` };
    }
    return { ok: true, message: `installed ${unit} (systemd --user; Restart=always, starts at login)` };
  }
  if (manager === "launchd") {
    const plist = launchdPlistPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, launchdPlist(), "utf8");
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plist], { stdio: "pipe" });
    } catch {
      try { execFileSync("launchctl", ["load", plist], { stdio: "pipe" }); } catch { /* report below */ }
    }
    return { ok: true, message: `installed ${plist} (launchd; KeepAlive, runs at login)` };
  }
  return {
    ok: false,
    message: [
      "no service manager found on this device.",
      "  Termux:  pkg install termux-services   then re-run: sc service install",
      "  Linux:   systemd user units, macOS: launchd",
      `  meanwhile 'sc gateway' already self-supervises: it restarts on crash.`,
    ].join("\n"),
  };
}

export function uninstallService(): { ok: boolean; message: string } {
  const manager = detectManager();
  let removed = false;
  if (manager === "termux-services" && existsSync(runitDir())) {
    try { execFileSync("sv", ["down", SERVICE_NAME], { stdio: "pipe" }); } catch { /* not running */ }
    rmSync(runitDir(), { recursive: true, force: true });
    removed = true;
  }
  if (manager === "systemd-user" && existsSync(systemdUnitPath())) {
    try { execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "pipe" }); } catch { /* warm */ }
    rmSync(systemdUnitPath(), { force: true });
    try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" }); } catch { /* best effort */ }
    removed = true;
  }
  if (manager === "launchd" && existsSync(launchdPlistPath())) {
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], { stdio: "pipe" }); } catch { /* not loaded */ }
    rmSync(launchdPlistPath(), { force: true });
    removed = true;
  }
  if (existsSync(pidPath())) rmSync(pidPath(), { force: true });
  return { ok: removed, message: removed ? "service removed (config, state and workspace kept)" : "no service installed" };
}

/** sv/systemctl/launchctl verb, or null when unmanaged. Exported for `sc uninstall` (P3). */
export function serviceVerb(verb: "start" | "stop" | "restart"): { ok: boolean; message: string } {
  const manager = detectManager();
  try {
    if (manager === "termux-services") {
      const svVerb = verb === "stop" ? "down" : verb === "start" ? "up" : "restart";
      execFileSync("sv", [svVerb, SERVICE_NAME], { stdio: "pipe" });
      return { ok: true, message: `sv ${svVerb} ${SERVICE_NAME}` };
    }
    if (manager === "systemd-user") {
      execFileSync("systemctl", ["--user", verb, SYSTEMD_UNIT], { stdio: "pipe" });
      return { ok: true, message: `systemctl --user ${verb} ${SYSTEMD_UNIT}` };
    }
    if (manager === "launchd") {
      if (verb === "restart") execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
      else if (verb === "start") execFileSync("launchctl", ["kickstart", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
      else execFileSync("launchctl", ["kill", "SIGTERM", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
      return { ok: true, message: `launchctl ${verb} ${LAUNCHD_LABEL}` };
    }
  } catch (err) {
    return { ok: false, message: `${verb} failed: ${(err as Error).message}` };
  }
  return { ok: false, message: "no service manager found — is the service installed? (sc service install)" };
}

function recentErrors(n: number): string[] {
  const { lines } = serviceLogTail(120);
  const hits = lines.filter((l) => /ERROR|WARN|crash loop/.test(l));
  return hits.slice(-n);
}

function printStatus(): void {
  const s = serviceStatus();
  const rec = readPidFile();
  console.log(`manager:    ${s.manager ?? "none (sc gateway still self-supervises)"}`);
  console.log(`installed:  ${s.installed}${s.installed ? ` (${s.path})` : ""}`);
  console.log(`boot start: ${s.bootEnabled ? "enabled" : "disabled"}`);
  console.log(`running:    ${s.running}${s.pid ? ` pid ${s.pid}` : ""}${s.supervisor ? ` · supervisor ${s.supervisor} (restarts on crash)` : ""}`);
  if (s.running && s.startedAt) console.log(`uptime:     ${formatUptime(Math.max(0, Math.round((Date.now() - s.startedAt) / 1000)))}`);
  if (rec?.port) console.log(`port:       ${rec.port} (log: ${serviceLogPath()})`);
  const errs = recentErrors(3);
  if (errs.length > 0) {
    console.log(`recent log warnings (last 3):`);
    for (const e of errs) console.log(`  ${e.slice(0, 200)}`);
  }
  if (!s.running && !s.installed) console.log(`\nstart one: sc gateway (self-supervising) · or install: sc service install`);
}

export async function serviceCmd(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  if (sub === "list") {
    const procs = await listGateways();
    if (procs.length === 0) {
      console.log("no SuparClaw gateway is running");
      return 0;
    }
    console.log("PID      UPTIME     PORT    STATUS   COMMAND");
    for (const p of procs) {
      const up = p.uptimeSec === null ? "?" : formatUptime(p.uptimeSec);
      const port = p.port ? String(p.port) : "-";
      const status = p.healthy ? "healthy" : p.port ? "unresponsive" : "unknown";
      console.log(`${String(p.pid).padEnd(9)}${up.padEnd(11)}${port.padEnd(8)}${status.padEnd(9)}${p.cmd}`);
    }
    console.log("\nstop one with: sc stop <pid>");
    return 0;
  }
  switch (sub) {
    case "install": {
      const result = installService();
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case "uninstall":
      console.log(uninstallService().message);
      return 0;
    case "start":
    case "restart": {
      const out = serviceVerb(sub);
      console.log(out.message);
      if (!out.ok) {
        console.log(sub === "start" ? `start one now: sc gateway  (self-supervises: restarts on crash)` : `alternative: sc restart`);
        return 1;
      }
      return 0;
    }
    case "stop": {
      const managed = serviceVerb("stop");
      if (managed.ok) {
        console.log(managed.message);
        return 0;
      }
      const out = await stopService();
      console.log(out.message);
      return out.ok ? 0 : 1;
    }
    case "logs": {
      const follow = rest.includes("-f") || rest.includes("--follow");
      const nFlag = rest.findIndex((a) => a === "-n" || a === "--lines");
      const n = nFlag >= 0 ? Number(rest[nFlag + 1]) || 60 : 60;
      const { path, lines } = serviceLogTail(n);
      console.log(`# ${path}\n`);
      for (const l of lines) console.log(l);
      if (!follow) return 0;
      let size = existsSync(path) ? statSync(path).size : 0;
      console.log("\n# following — ctrl+c to stop");
      watchFile(path, { interval: 400 }, () => {
        try {
          const now = statSync(path).size;
          if (now < size) size = 0; // rotated/truncated
          if (now === size) return;
          const text = readTextSafe(path) ?? "";
          const chunk = text.slice(size);
          size = now;
          for (const l of chunk.split("\n")) if (l) console.log(l);
        } catch { /* transient read race */ }
      });
      await new Promise(() => {}); // follow until ctrl+c
      return 0;
    }
    case "status":
    default:
      printStatus();
      return 0;
  }
}

export interface GatewayProc {
  pid: number;
  uptimeSec: number | null;
  port: number | null;
  healthy: boolean;
  managed: boolean;
  cmd: string;
}

function procUptimeSec(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]); // field 22 overall
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptime)) return null;
    return Math.max(0, Math.round(uptime - startTicks / 100)); // USER_HZ = 100
  } catch {
    return null;
  }
}

async function portHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Every SuparClaw gateway process on this device, newest state first. */
export async function listGateways(): Promise<GatewayProc[]> {
  const mine = readPidFile();
  const out: GatewayProc[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === process.pid) continue;
    let cmd = "";
    let argv: string[] = [];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      cmd = argv.join(" ");
    } catch {
      continue;
    }
    // Only a real "node …/sc.js gateway" invocation, never a shell that mentions it.
    const bin = argv[1] ?? "";
    if (!/\/(sc|sc\.js)$/.test(bin) || argv[2] !== "gateway") continue;
    if (argv[3] === "--child") continue; // the supervisor row already stands for it
    // The pid file records the CHILD's pid and the supervisor's; a supervised
    // gateway is listed under its supervisor row, which must therefore also
    // inherit the port — otherwise every managed gateway shows port:null and
    // `sc status` reports a perfectly healthy daemon as offline.
    const port = mine && (mine.pid === pid || mine.supervisor === pid) ? mine.port : null;
    out.push({
      pid,
      uptimeSec: procUptimeSec(pid),
      port,
      healthy: port ? await portHealthy(port) : false,
      managed: mine?.pid === pid || mine?.supervisor === pid,
      cmd,
    });
  }
  return out;
}

/** Stop a running daemon: supervisor first (so it cannot respawn), then the child. */
export async function stopService(pidArg?: number): Promise<{ ok: boolean; message: string }> {
  const fromFile = readPidFile();
  const pid = pidArg ?? fromFile?.pid;
  if (pid === undefined || !Number.isFinite(pid)) {
    return { ok: false, message: "no gateway.pid — nothing to stop. See: sc service list" };
  }
  if (pid === process.pid) return { ok: false, message: "refusing to stop the current process" };

  const supervisor = fromFile?.supervisor && alive(fromFile.supervisor) ? fromFile.supervisor : null;
  const targets = [...new Set([...(supervisor ? [supervisor] : []), pid])];
  for (const t of targets) {
    try { process.kill(t, "SIGTERM"); } catch { /* already gone */ }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (targets.every((t) => !alive(t))) {
      if (fromFile?.pid === pid) rmSync(pidPath(), { force: true });
      return { ok: true, message: `stopped gateway (pid ${pid}${supervisor ? `, supervisor ${supervisor}` : ""})` };
    }
  }
  for (const t of targets) {
    try { process.kill(t, "SIGKILL"); } catch { /* already gone */ }
  }
  if (fromFile?.pid === pid) rmSync(pidPath(), { force: true });
  return { ok: true, message: `gateway (pid ${pid}) ignored SIGTERM — killed (with supervisor if present)` };
}

export function writePid(port: number): void {
  mkdirSync(stateDir(), { recursive: true });
  const sup = Number(process.env[SUPERVISOR_PID_ENV] ?? "");
  writeFileSync(
    pidPath(),
    JSON.stringify({
      pid: process.pid,
      port,
      startedAt: Date.now(),
      supervisor: Number.isFinite(sup) && sup > 1 ? sup : null,
    }),
    "utf8",
  );
}
