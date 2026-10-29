// P3 (row A19) — `sc uninstall` (their cli/uninstall.md + install/uninstall.md
// at our Termux/Linux scale).
//
// Upstream contract implemented here:
//   - scopes: --service --state --workspace --app --all; default interactive
//     selection PRESELECTS the service only (their multiselect), never data.
//   - --yes skips confirmation; --non-interactive requires --yes (their rule).
//   - --dry-run prints the plan and mutates nothing.
//   - SERVICE TEARDOWN IS THE GATE: if service inspection/stop/removal fails
//     or an unmanaged live gateway refuses the state delete, the state and
//     workspace scopes are NOT touched. (--app reports independently — not
//     applicable on this platform, like their non-macOS output.)
//   - --state preserves workspace directories unless --workspace is selected.
//   - exits nonzero when any requested scope is blocked or fails; success
//     output never claims unconditional completion.
//   - the CLI itself is never uninstalled by us (their "no separate
//     CLI-removal scope") — the exact owner-specific command is printed.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir, workspaceDir, homeDir } from "../util/paths.js";
import { serviceStatus, uninstallService, serviceVerb } from "./service.js";

export interface UninstallArgs {
  service: boolean;
  state: boolean;
  workspace: boolean;
  app: boolean;
  yes: boolean;
  nonInteractive: boolean;
  dryRun: boolean;
  anyScopeFlag: boolean;
}

export interface UninstallResult {
  code: number;
  lines: string[];
  blockedState?: string;
}

const USAGE =
  "usage: sc uninstall [--service] [--state] [--workspace] [--all] [--yes] [--non-interactive] [--dry-run]\n" +
  "  no flags on a terminal = pick scopes interactively (service preselected);\n" +
  "  non-interactive shells need explicit scope flags + --yes";

export function parseUninstallArgs(argv: string[]): UninstallArgs | { error: string } {
  const a: UninstallArgs = { service: false, state: false, workspace: false, app: false, yes: false, nonInteractive: false, dryRun: false, anyScopeFlag: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === "--service") a.service = true;
    else if (f === "--state") a.state = true;
    else if (f === "--workspace") a.workspace = true;
    else if (f === "--app") a.app = true;
    else if (f === "--all") {
      a.service = a.state = a.workspace = a.app = true;
    } else if (f === "--yes" || f === "-y") a.yes = true;
    else if (f === "--non-interactive") a.nonInteractive = true;
    else if (f === "--dry-run" || f === "-n") a.dryRun = true;
    else if (f === "--help" || f === "-h") return { error: "" };
    else return { error: `${USAGE}\nunknown flag: ${f}` };
    if (["--service", "--state", "--workspace", "--app", "--all"].includes(f)) a.anyScopeFlag = true;
  }
  if (a.nonInteractive && !a.yes) return { error: "--non-interactive requires --yes (their pairing rule)" };
  return a;
}

export interface GateContext {
  serviceInstalled: boolean;
  unmanagedRunning: boolean;
  unmanagedPid: number | null;
}

export function readGate(): GateContext {
  const s = serviceStatus();
  return {
    serviceInstalled: s.installed,
    unmanagedRunning: !s.installed && s.running,
    unmanagedPid: !s.installed ? s.pid : null,
  };
}

// ---- dry-run/simulation boundary -------------------------------------------

export interface FsOps {
  exists(path: string): boolean;
  list(path: string): string[];
  remove(path: string): void;
  stopService(): { ok: boolean; message: string };
  uninstallService(): { ok: boolean; message: string };
}

export const REAL_FS: FsOps = {
  exists: (p) => existsSync(p),
  list: (p) => readdirSync(p),
  remove: (p) => rmSync(p, { recursive: true, force: true }),
  stopService: () => serviceVerb("stop"),
  uninstallService: () => uninstallService(),
};

/**
 * The exact plan for the chosen scopes — strings are the operator-facing
 * actions; `blockedData` explains why data scopes are preserved (gate rule).
 */
export function planUninstall(scopes: Pick<UninstallArgs, "service" | "state" | "workspace" | "app">, gate: GateContext, dirs: { state: string; workspace: string }): {
  actions: string[];
  dataScopes: ("state" | "workspace")[];
  blockedData: string | null;
} {
  const actions: string[] = [];
  const dataScopes: ("state" | "workspace")[] = [];
  let blockedData: string | null = null;
  if (scopes.service) {
    actions.push(gate.serviceInstalled ? "stop + uninstall the SuparClaw service (termux runit / systemd-user / launchd)" : "nothing to do — no service installed (inspection still reported)");
  }
  if ((scopes.state || scopes.workspace) && gate.unmanagedRunning) {
    blockedData = `an unmanaged gateway is still running (pid ${gate.unmanagedPid}) — their exclusive-ownership rule refuses state deletion; stop it first (sc service stop, or kill ${gate.unmanagedPid}) and re-run`;
  }
  if (scopes.state) dataScopes.push("state");
  if (scopes.workspace) dataScopes.push("workspace");
  if (scopes.state && !blockedData) {
    actions.push(scopes.workspace ? `remove EVERYTHING under ${dirs.state} (config, db, logs, media, skills, workspace)` : `remove ${dirs.state} contents EXCEPT ${dirs.workspace} (their workspace-preservation rule)`);
  }
  if (scopes.workspace && !blockedData && !scopes.state) actions.push(`remove ${dirs.workspace} only`);
  if (scopes.app) actions.push("app scope: not applicable on this platform (no macOS app; reported, exit stays 0 like their non-macOS rule)");
  return { actions, dataScopes, blockedData };
}

/** State-scope deletion honoring their workspace-preservation rule. */
export function deleteStateContents(dir: string, keepWorkspace: string, fs: Pick<FsOps, "exists" | "remove" | "list"> = REAL_FS): string[] {
  const removed: string[] = [];
  const wsPrefix = join(keepWorkspace.endsWith("/") ? keepWorkspace.slice(0, -1) : keepWorkspace);
  for (const entry of fs.list(dir)) {
    const full = join(dir, entry);
    // Never touch the workspace root itself or anything beneath it.
    if (full === wsPrefix || full.startsWith(wsPrefix + "/")) continue;
    if (!fs.exists(full)) continue;
    fs.remove(full);
    removed.push(full);
  }
  return removed;
}

/** Best-known CLI-removal hint (their table: inspect owner, then remove). */
export function cliRemovalHint(appHome: string): string {
  return [
    "the CLI itself is untouched (their rule: no CLI scope inside uninstall).",
    "remove it with the owner that installed it, then verify: command -v sc",
    "  npm global (install.sh default):  npm rm -g suparclaw",
    "  git checkout:                     inspect your launcher, then remove your own checkout",
    `a script may still resolve sc afterward — inspect it BEFORE removing (foreign/shared prefixes stay), state was under ${appHome}`,
  ].join("\n");
}

// ---- interactive scope pick (their multiselect, service preselected) --------

async function pickScopes(): Promise<Pick<UninstallArgs, "service" | "state" | "workspace"> | null> {
  try {
    const { createInterface } = await import("node:readline");
    const { createReadStream, createWriteStream } = await import("node:fs");
    const input = createReadStream("/dev/tty");
    const output = createWriteStream("/dev/tty");
    const rl = createInterface({ input, output });
    try {
      const menu =
        "remove what? (their multiselect; service is preselected; data scopes need explicit pick)\n" +
        "  1 — the SuparClaw service only (default)\n" +
        "  2 — service + state (config, history, cron; workspace kept)\n" +
        "  3 — service + state + workspace (everything)\n" +
        "  0 — abort\n" +
        "choice [1]: ";
      const answer = await new Promise<string>((resolve) => rl.question(menu, resolve));
      const pick = answer.trim() || "1";
      if (pick === "0") return null;
      if (pick === "1") return { service: true, state: false, workspace: false };
      if (pick === "2") return { service: true, state: true, workspace: false };
      if (pick === "3") return { service: true, state: true, workspace: true };
      return { service: true, state: false, workspace: false };
    } finally {
      rl.close();
      input.destroy();
      output.destroy();
    }
  } catch {
    return null; // no tty: caller prints the usage-style requirement
  }
}

async function confirm(scopesDesc: string): Promise<boolean> {
  try {
    const { createInterface } = await import("node:readline");
    const { createReadStream, createWriteStream } = await import("node:fs");
    const input = createReadStream("/dev/tty");
    const output = createWriteStream("/dev/tty");
    const rl = createInterface({ input, output });
    try {
      const answer = await new Promise<string>((resolve) => rl.question(`${scopesDesc}\nProceed? [y/N] `, resolve));
      return answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
      input.destroy();
      output.destroy();
    }
  } catch {
    return false;
  }
}

/**
 * `sc uninstall` — see module header for the upstream contract. Real fs by
 * default; tests inject `fs` + gate + pick/confirm seams.
 */
export async function cmdUninstall(
  argv: string[],
  deps: {
    fs?: FsOps;
    gate?: GateContext;
    pickScopesFn?: () => Promise<Pick<UninstallArgs, "service" | "state" | "workspace"> | null>;
    confirmFn?: (desc: string) => Promise<boolean>;
    dirs?: { state: string; workspace: string; home: string };
  } = {},
): Promise<number> {
  const parsed = parseUninstallArgs(argv);
  if ("error" in parsed) {
    if (parsed.error) console.error(parsed.error);
    else console.log(USAGE); // --help
    return parsed.error ? 2 : 0;
  }
  const fs = deps.fs ?? REAL_FS;
  const dirs = deps.dirs ?? { state: stateDir(), workspace: workspaceDir(), home: homeDir() };
  const gate = deps.gate ?? readGate();

  // Scope resolution: flags > interactive pick > usage error (their defaults).
  let scopes: Pick<UninstallArgs, "service" | "state" | "workspace">;
  if (parsed.anyScopeFlag) {
    scopes = { service: parsed.service, state: parsed.state, workspace: parsed.workspace };
  } else if (parsed.nonInteractive) {
    console.error("no scope flags given (non-interactive) — pass e.g. --service --yes --non-interactive");
    return 2;
  } else {
    const picked = await (deps.pickScopesFn?.() ?? pickScopes());
    if (!picked) {
      if (process.stdout.isTTY || deps.pickScopesFn) {
        console.log("aborted — nothing was removed");
        return 1;
      }
      console.error(USAGE);
      return 2;
    }
    scopes = picked;
  }

  const plan = planUninstall({ ...scopes, app: parsed.app }, gate, dirs);
  const lines: string[] = [];
  const emit = (s: string): void => {
    lines.push(s);
    console.log(s);
  };

  emit(`scopes: ${[scopes.service && "service", scopes.state && "state", scopes.workspace && "workspace", parsed.app && "app"].filter(Boolean).join(", ") || "(none)"}`);
  for (const a of plan.actions) emit(`  • ${a}`);
  if (plan.blockedData) emit(`  ✖ blocked: ${plan.blockedData}`);
  if (parsed.dryRun) {
    emit("dry-run — nothing was removed");
    return plan.blockedData ? 1 : 0;
  }

  // Confirmation (their prompt unless --yes).
  if (!parsed.yes) {
    const ok = await (deps.confirmFn?.(plan.actions.join("\n")) ?? confirm(plan.actions.join("\n")));
    if (!ok) {
      emit("aborted — nothing was removed");
      return 1;
    }
  }

  // Execution with their safety gate + partial-failure reporting.
  let failed = false;
  let serviceSafe = true; // gate for data scopes
  if (scopes.service) {
    if (!gate.serviceInstalled) {
      emit("  · no service installed — inspection clean, nothing to remove");
    } else {
      const stop = fs.stopService();
      emit(stop.ok ? `  ✓ service stopped (${stop.message})` : `  · stop: ${stop.message}`);
      const un = fs.uninstallService();
      if (un.ok) emit(`  ✓ ${un.message}`);
      else {
        emit(`  ✖ service removal failed: ${un.message}`);
        failed = true;
        serviceSafe = false; // their gate: state/workspace must not be touched
      }
    }
  }
  if (plan.blockedData) {
    emit(`  ✖ data scopes skipped: ${plan.blockedData}`);
    failed = true;
  } else if (!serviceSafe) {
    emit("  ✖ data scopes skipped: service teardown failed (their gate rule)");
    failed = true;
  } else {
    if (scopes.workspace && fs.exists(dirs.workspace)) {
      fs.remove(dirs.workspace);
      emit(`  ✓ workspace removed (${dirs.workspace})`);
    }
    if (scopes.state) {
      if (!fs.exists(dirs.state)) {
        emit(`  · state dir already gone (${dirs.state})`);
      } else if (scopes.workspace) {
        fs.remove(dirs.state);
        emit(`  ✓ state removed (${dirs.state})`);
      } else {
        const removed = deleteStateContents(dirs.state, dirs.workspace, fs);
        emit(removed.length > 0 ? `  ✓ state removed, workspace kept (${removed.length} entries under ${dirs.state})` : "  · nothing to remove under state (workspace only)");
      }
    }
  }
  if (parsed.app) emit("  · app scope: not applicable on this platform");

  if (scopes.state || scopes.workspace) emit(cliRemovalHint(dirs.state));
  else emit("config, state and workspace kept — remove them too with --state/--workspace when that's the intent");
  return failed ? 1 : 0;
}
