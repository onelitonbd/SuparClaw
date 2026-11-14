/**
 * P3 (row Missing!#19) — `sc sessions cleanup`.
 *
 * Ownership contract (their "Cleanup maintenance" rules):
 *  - a reachable gateway owns the run (delegated over WS like their default);
 *  - a dry-run preview works offline at any time, even while a gateway runs;
 *  - destructive OFFLINE cleanup requires exclusive ownership: if a live
 *    gateway/service pid owns the state, we name the owner and refuse
 *    (exit 1) — use `sc service stop` first, or --dry-run, or --store;
 *  - `--store <path>` is the explicit offline-repair assertion (their flag).
 */
import { Store } from "../state/db.js";
import type { MaintenanceReport } from "../state/maintenance.js";
import { defaultDiskBytes, runSessionMaintenance, settingsFromConfig } from "../state/maintenance.js";

export interface CleanupArgs {
  dryRun: boolean;
  enforce: boolean;
  activeKeys: string[];
  store: string | null;
  json: boolean;
  token: string | null;
  error?: string;
}

export function parseCleanupArgs(args: string[]): CleanupArgs {
  const out: CleanupArgs = { dryRun: false, enforce: false, activeKeys: [], store: null, json: false, token: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--enforce") out.enforce = true;
    else if (a === "--json") out.json = true;
    else if (a === "--active-key" && args[i + 1]) out.activeKeys.push(args[++i]!);
    else if (a === "--store" && args[i + 1]) out.store = args[++i]!;
    else if (a === "--token" && args[i + 1]) out.token = args[++i]!;
    else return { ...out, error: `unknown or incomplete flag: ${a}` };
  }
  return out;
}

/** Text table (their dry-run table: Action / Key / Age / Flags) + summary. */
export function formatCleanupReport(report: MaintenanceReport): string {
  const lines: string[] = [];
  if (report.errors.length > 0) for (const e of report.errors) lines.push(`config: ${e}`);
  lines.push("Action              Key                                              Age     Detail");
  for (const a of report.actions.slice(0, 60)) {
    const age = a.ageMs >= 86_400_000 ? `${Math.round(a.ageMs / 86_400_000)}d` : `${Math.max(0, Math.round(a.ageMs / 3_600_000))}h`;
    lines.push(
      `${a.action.padEnd(19)} ${a.key.slice(0, 48).padEnd(48)} ${age.padStart(6)}  ${a.detail ?? ""}`.trimEnd(),
    );
  }
  if (report.actions.length > 60) lines.push(`… plus ${report.actions.length - 60} more`);
  const changed = report.archivedAge + report.archivedCap + report.deletedCapArchives;
  lines.push(
    `mode=${report.mode}${report.applied ? " (applied)" : " (not applied)"}` +
    ` · unarchived ${report.beforeCount} → ${report.afterCount}` +
    ` · archived ${report.archivedAge + report.archivedCap} (age ${report.archivedAge}, cap ${report.archivedCap})` +
    (report.kept ? ` · ${report.kept} protected` : "") +
    (report.deletedCapArchives ? ` · evicted ${report.deletedCapArchives} cap archives (~${report.freedBytes} bytes)` : "") +
    (report.diskBytes !== null ? ` · disk ${report.diskBytes}${report.overBudget ? " — OVER BUDGET" : " (within budget)"}` : ""),
  );
  if (report.dryRun) lines.push("dry-run — nothing was applied");
  if (changed === 0 && !report.overBudget) lines.push("nothing to prune — store is within policy");
  return lines.join("\n");
}

export interface OwnerStatus {
  running: boolean;
  pid: number | null;
}

export interface CleanupDeps {
  /** WS delegation attempt; returns the report or null when no gateway answers. */
  delegate?: (opts: { dryRun: boolean; enforce: boolean; token: string | null }) => Promise<MaintenanceReport | null>;
  owner?: () => OwnerStatus;
  openStore?: (path: string) => Store;
  defaultDbPath?: () => string;
  loadMaintenanceConfig?: () => {
    mode: string; pruneAfter: string; maxEntries: number;
    preserveRecent: string; maxDiskBytes: string; highWaterBytes: string;
  };
}

export async function cmdSessionsCleanup(args: string[], deps: CleanupDeps = {}): Promise<number> {
  const parsed = parseCleanupArgs(args);
  if (parsed.error) {
    console.error(`${parsed.error}\nusage: sc sessions cleanup [--dry-run] [--enforce] [--active-key <key>] [--store <path>] [--json]`);
    return 2;
  }
  const print = (report: MaintenanceReport): number => {
    console.log(parsed.json ? JSON.stringify(report, null, 2) : formatCleanupReport(report));
    return 0;
  };

  // 1) Explicit offline store selection (their --store): the caller asserts
  //    ownership; destructive local runs are allowed (that flag IS the
  //    offline repair path).
  if (parsed.store) {
    const store = (deps.openStore ?? ((p) => Store.open(p)))(parsed.store);
    try {
      const cfg = deps.loadMaintenanceConfig?.() ?? {
        mode: "enforce", pruneAfter: "30d", maxEntries: 5000,
        preserveRecent: "", maxDiskBytes: "10gb", highWaterBytes: "",
      };
      const report = runSessionMaintenance(store, settingsFromConfig(cfg), {
        dryRun: parsed.dryRun,
        enforce: parsed.enforce,
        activeKeys: parsed.activeKeys,
        diskBytes: defaultDiskBytes(parsed.store),
      });
      return print(report);
    } finally {
      store.close();
    }
  }

  // 2) A reachable gateway runs it (their delegated path; the runtime's busy
  //    sessions are protected there — a local process cannot know them).
  if (deps.delegate) {
    const delegated = await deps
      .delegate({ dryRun: parsed.dryRun, enforce: parsed.enforce, token: parsed.token })
      .catch(() => null);
    if (delegated) return print(delegated);
  }

  // 3) Offline. A DRY-RUN is always safe (their: previews remain available
  //    while the gateway runs). A destructive run requires exclusive
  //    ownership — a live gateway holds the state, so we name it and refuse.
  const owner = deps.owner?.() ?? { running: false, pid: null };
  if (!parsed.dryRun && owner.running) {
    console.error(
      `refusing destructive local cleanup: the gateway holds the state${owner.pid ? ` (pid ${owner.pid})` : ""}.\n` +
      `stop it first (sc service stop), delegate by starting a reachable gateway, or use --dry-run / --store <path>.`,
    );
    return 1;
  }
  const dbFile = (deps.defaultDbPath ?? (() => { throw new Error("no default db path"); }))();
  const store = (deps.openStore ?? ((p) => Store.open(p)))(dbFile);
  try {
    const cfg = deps.loadMaintenanceConfig?.() ?? {
      mode: "enforce", pruneAfter: "30d", maxEntries: 5000,
      preserveRecent: "", maxDiskBytes: "10gb", highWaterBytes: "",
    };
    const report = runSessionMaintenance(store, settingsFromConfig(cfg), {
      dryRun: parsed.dryRun,
      enforce: parsed.enforce,
      activeKeys: parsed.activeKeys,
      diskBytes: defaultDiskBytes(dbFile),
    });
    return print(report);
  } finally {
    store.close();
  }
}
