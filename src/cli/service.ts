import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export function serviceCmd(args: string[]): number {
  const [sub = "status"] = args;
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

export function writePid(): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pidPath(), String(process.pid), "utf8");
}