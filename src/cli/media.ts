// `sc media` — what the attachments on this device are costing you (Task 30).
//
//   sc media status                 files, size, oldest, retention setting
//   sc media prune [--days N]       delete files older than N days
//   sc media prune --orphans        delete files no message references
//   sc media prune --dry-run        show what would go, touch nothing
//
// The same code the gateway's hourly sweep uses, so the manual command and the
// scheduled one can never disagree about what "older than N days" means.

import type { Store } from "../state/db.js";
import { listMedia, mediaStats, pruneMedia, pruneOrphans, type PruneResult } from "../agent/media-store.js";

export interface MediaCmdDeps {
  workspace: string;
  /** Present when a state db exists; `--orphans` and nothing else needs it. */
  store: Store | null;
  retentionDays: number;
}

const fmtMb = (bytes: number): string => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

function report(result: PruneResult, dryRun: boolean): void {
  const verb = dryRun ? "would remove" : "removed";
  console.log(`  ${verb} ${result.removed.length} file(s), ${fmtMb(result.freedBytes)}`);
  if (result.kept > 0) console.log(`  kept ${result.kept} (unreadable or outside the media tree)`);
  if (result.missing > 0) console.log(`  ${result.missing} already gone`);
  for (const file of result.removed.slice(0, 20)) console.log(`    ${file.path}  ${fmtMb(file.size)}`);
  if (result.removed.length > 20) console.log(`    … and ${result.removed.length - 20} more`);
}

export async function mediaCmd(args: string[], deps: MediaCmdDeps): Promise<number> {
  const sub = args[0] ?? "status";
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string): boolean => args.includes(`--${name}`);

  if (sub === "status" || sub === "list" || sub === "ls") {
    const stats = mediaStats(deps.workspace);
    if (stats.files === 0) {
      console.log("  no attachments yet");
    } else {
      console.log(`  ${stats.files} file(s), ${fmtMb(stats.bytes)}`);
      console.log(`  oldest: ${stats.oldestDays}d · newest: ${stats.newestDays}d`);
    }
    console.log(
      deps.retentionDays > 0
        ? `  retention: delete after ${deps.retentionDays} day(s) (media.retentionDays)`
        : "  retention: keep forever (media.retentionDays = 0)",
    );
    const biggest = listMedia(deps.workspace).sort((a, b) => b.size - a.size).slice(0, 5);
    if (biggest.length > 0 && has("verbose")) {
      console.log("  largest:");
      for (const file of biggest) console.log(`    ${fmtMb(file.size).padStart(8)}  ${file.path}`);
    }
    return 0;
  }

  if (sub === "prune" || sub === "clean") {
    const dryRun = has("dry-run");
    const days = Number(flag("days") ?? deps.retentionDays) || 0;
    const orphans = has("orphans");

    if (orphans) {
      if (!deps.store) {
        console.error("  --orphans needs a state database (start the gateway once, or pass a real SUPARCLAW_HOME)");
        return 2;
      }
      const store = deps.store;
      const res = pruneOrphans(deps.workspace, { isReferenced: (p) => store.anyMessageMentions(p), dryRun });
      console.log(`${dryRun ? "orphan files (dry run)" : "orphan files"}:`);
      report(res, dryRun);
      return 0;
    }

    if (days <= 0) {
      console.log("  nothing to do — media.retentionDays is 0 (keep forever). Pass --days N to prune by age.");
      return 0;
    }
    const res = pruneMedia(deps.workspace, { maxAgeDays: days, dryRun });
    console.log(`${dryRun ? "files older than" : "files older than"} ${days}d${dryRun ? " (dry run)" : ""}:`);
    report(res, dryRun);
    return 0;
  }

  console.error("usage: sc media status [--verbose]");
  console.error("       sc media prune [--days N] [--dry-run]");
  console.error("       sc media prune --orphans [--dry-run]");
  return 2;
}
