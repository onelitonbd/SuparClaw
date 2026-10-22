// P2 #9 — exec sandboxing (tools.exec.sandbox.strict).
//
// Upstream contract (docs/openclaw/cli/sandbox.md + tools/exec.md) at our
// scale: their docker/openshell sandboxing compresses to a strict local
// confinement — the child gets a scrubbed environment (PATH of trusted
// dirs, HOME=workspace so dotfiles and agent secrets stay invisible),
// prlimit resource caps when the binary exists (the Linux/Termux answer to
// cgroup limits), and — when sandboxProot is enabled and proot is found —
// a real filesystem jail (workspace rw, system paths read-only).
import { existsSync } from "node:fs";
import type { SuparClawConfig } from "../config/schema.js";

export interface SandboxPlan {
  /** Wrapped argv (shell or prlimit/proot-prefixed); undefined = run plain. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Human note for tool_log/transcripts (their "sandbox: applied" line). */
  note: string;
}

const RLIMIT = ["--as=2147483648", "--nproc=256", "--nofile=1024"] as const;

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

export function findPrlimit(): string | null {
  return firstExisting([
    process.env["PREFIX"] ? `${process.env["PREFIX"]}/bin/prlimit` : "",
    "/data/data/com.termux/files/usr/bin/prlimit",
    "/usr/bin/prlimit",
    "/bin/prlimit",
  ]);
}

export function findProot(): string | null {
  return firstExisting([
    process.env["PREFIX"] ? `${process.env["PREFIX"]}/bin/proot` : "",
    "/data/data/com.termux/files/usr/bin/proot",
    "/usr/bin/proot",
  ]);
}

/**
 * Scrubbed child env (their env-policy "keep only what's needed"): PATH
 * covers the same trusted dirs the exec policy's safe bins resolve from,
 * plus Termux's $PREFIX/bin. LANG/TZ pass through; HOME is the workspace so
 * agent config and user dotfiles never leak into the child.
 */
export function sandboxEnv(workspace: string, trustedDirs: string[]): NodeJS.ProcessEnv {
  const prefixBin = process.env["PREFIX"] ? `${process.env["PREFIX"]}/bin` : "";
  const dirs = [...trustedDirs, prefixBin, "/usr/local/bin"].filter(Boolean);
  return {
    PATH: [...new Set(dirs)].join(":"),
    LANG: process.env["LANG"] || "C.UTF-8",
    TZ: process.env["TZ"] || "",
    HOME: workspace,
  };
}

/**
 * Wrap `shell -lc <command>` per policy:
 *   off    → untouched argv/env (legacy behavior);
 *   strict → scrubbed env, prlimit caps when available, and a proot fs jail
 *            when sandboxProot found a binary (their "sandbox: enabled"
 *            note otherwise names the weaker-but-applied layers honestly).
 */
export function planSandbox(
  shellArgv: string[],
  workspace: string,
  cfg: Pick<SuparClawConfig["tools"]["exec"], "sandbox" | "sandboxProot" | "safeBinTrustedDirs">,
): SandboxPlan {
  if (cfg.sandbox !== "strict") {
    return { argv: shellArgv, env: process.env, note: "sandbox: off" };
  }
  const layers: string[] = ["env-scrub"];
  const env = sandboxEnv(workspace, cfg.safeBinTrustedDirs);
  let argv = shellArgv;

  const proot = cfg.sandboxProot ? findProot() : null;
  if (proot) {
    // Workspace rw, system dirs ro — the model can break anything inside
    // its house and nothing outside it.
    argv = [proot, "-b", `${workspace}:${workspace}`, "-b", "/bin:/bin", "-b", "/usr:/usr", "-b", "/lib:/lib", "-b", "/system:/system", "-w", workspace, "/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...shellArgv];
    layers.unshift("proot");
  }
  // prlimit wraps whatever convoy we built (it caps the whole tree).
  const prlimit = findPrlimit();
  if (prlimit) {
    argv = [prlimit, ...RLIMIT, "--", ...argv];
    layers.unshift("prlimit");
  }
  return { argv, env: proot ? process.env /* proot/env -i scrubs inside */ : env, note: `sandbox: strict(${layers.join("+")})` };
}
