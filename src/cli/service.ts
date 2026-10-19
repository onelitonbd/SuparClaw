import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidPath, prefixDir, stateDir } from "../util/paths.js";
import { isTermux } from "../util/paths.js";

const SERVICE_NAME = "suparclaw";

function runScript(): string {
  const bash = `${prefixDir()}/bin/bash`;
  const sc = `${prefixDir()}/bin/sc`;
  return `#!/data/data/com.termux/files/usr/bin/bash
# SuparClaw gateway daemon (termux-services)
exec ${bash} -lc 'exec ${sc} gateway >> ${stateDir()}/logs/service.log 2>&1'
`;
}

export interface ServiceStatus {
  installed: boolean;
  path: string;
  pid: number | null;
  running: boolean;
}

export function serviceStatus(): ServiceStatus {
  const dir = `${prefixDir()}/var/service/${SERVICE_NAME}`;
  const path = join(dir, "run");
  let pid: number | null = null;
  if (existsSync(pidPath())) {
    const parsed = Number.parseInt(readFileSync(pidPath(), "utf8").trim(), 10);
    if (Number.isFinite(parsed)) {
      try {
        process.kill(parsed, 0);
        pid = parsed;
      } catch {
        pid = null;
      }
    }
  }
  return { installed: existsSync(path), path, pid, running: pid !== null };
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
  if (!isTermux()) {
    return { ok: false, message: "termux-services only applies inside Termux; run `sc gateway` manually elsewhere" };
  }
  const dir = `${prefixDir()}/var/service/${SERVICE_NAME}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run");
  writeFileSync(path, runScript(), "utf8");
  chmodSync(path, 0o755);
  return {
    ok: true,
    message: [
      `installed ${path}`,
      "",
      "next:",
      "  pkg install termux-services",
      `  sv-enable ${SERVICE_NAME}`,
      "  sv up suparclaw          # or: termux-services run suparclaw",
      "  termux-wake-lock         # keep the gateway alive while idle",
    ].join("\n"),
  };
}

export function uninstallService(): { ok: boolean; message: string } {
  const dir = `${prefixDir()}/var/service/${SERVICE_NAME}`;
  let removed = false;
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed = true;
  }
  if (existsSync(pidPath())) rmSync(pidPath(), { force: true });
  return { ok: removed, message: removed ? `removed ${dir}` : "no service installed" };
}

export async function serviceCmd(args: string[]): Promise<number> {
  const [sub = "status"] = args;
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
    case "status": {
      const status = serviceStatus();
      console.log(`installed: ${status.installed} (${status.path})`);
      console.log(`running:   ${status.running}${status.pid ? ` pid ${status.pid}` : ""}`);
      return 0;
    }
    default:
      console.error(`unknown service subcommand: ${sub}`);
      return 1;
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

function readPidFile(): { pid: number; port: number | null } | null {
  const file = pidPath();
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  if (/^\d+$/.test(raw)) return { pid: Number.parseInt(raw, 10), port: null }; // legacy format
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown };
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid)) return null;
    return { pid, port: Number.isFinite(Number(parsed.port)) ? Number(parsed.port) : null };
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
    const port = mine?.pid === pid ? mine?.port ?? null : null;
    out.push({
      pid,
      uptimeSec: procUptimeSec(pid),
      port,
      healthy: port ? await portHealthy(port) : false,
      managed: mine?.pid === pid,
      cmd,
    });
  }
  return out;
}

/** Stop a running daemon. Without a pid it uses the pid file. */
export async function stopService(pidArg?: number): Promise<{ ok: boolean; message: string }> {
  const fromFile = readPidFile();
  const pid = pidArg ?? fromFile?.pid;
  if (pid === undefined || !Number.isFinite(pid)) {
    return { ok: false, message: "no gateway.pid — nothing to stop. See: sc gateway list" };
  }
  if (pid === process.pid) return { ok: false, message: "refusing to stop the current process" };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    if (fromFile?.pid === pid) rmSync(pidPath(), { force: true });
    return { ok: false, message: `process ${pid} is not running (stale pid file removed)` };
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch {
      if (fromFile?.pid === pid) rmSync(pidPath(), { force: true });
      return { ok: true, message: `stopped gateway (pid ${pid})` };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    if (fromFile?.pid === pid) rmSync(pidPath(), { force: true });
    return { ok: true, message: `gateway (pid ${pid}) ignored SIGTERM — killed` };
  } catch {
    return { ok: false, message: `could not stop pid ${pid}` };
  }
}

export function writePid(port: number): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pidPath(), JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }), "utf8");
}