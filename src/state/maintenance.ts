/**
 * P3 (row Missing!#19) — session pruning / archive, SuparClaw port of their
 * `session.maintenance` engine (docs/openclaw/cli/sessions.md "Cleanup
 * maintenance" + gateway/config-agents/sessions.md):
 *
 *  - ordering: pruneAfter age cleanup → maxEntries cap → disk budget
 *  - pruneAfter ARCHIVES durable sessions in place (`archive-age` /
 *    archiveReason "age-retention"): ids and all message generations
 *    preserved, archived rows stop consuming the entry cap
 *  - maxEntries caps UNARCHIVED rows (default 5000); overflow archives the
 *    oldest eligible rows (`archive-cap` / capacity); protected rows report
 *    as `keep` and the store may legitimately stay above the cap
 *  - protections: sessions with live work (activeKeys) and everything inside
 *    preserveRecent are never archived
 *  - maxDiskBytes budget (default 10gb): over-budget in enforce mode evicts
 *    oldest `archive-cap` rows first; age-retention archives and live rows
 *    stay protected (their eviction order)
 *  - mode warn reports every action without writing; --enforce applies it
 */
import { statSync } from "node:fs";
import type { Store, SessionRow } from "./db.js";
import { parseByteSize, parseDurationMs } from "../util/units.js";

/** Raw config shape (config.session.maintenance in the schema). */
export interface SessionMaintenanceConfig {
  mode: string;
  pruneAfter: string;
  maxEntries: number;
  preserveRecent: string;
  maxDiskBytes: string;
  highWaterBytes: string;
}

export interface MaintenanceSettings {
  mode: "enforce" | "warn";
  pruneAfterMs: number | null;
  maxEntries: number;
  preserveRecentMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
  /** Config values that failed to parse (surfaced, never silently dropped). */
  errors: string[];
}

export function settingsFromConfig(cfg: SessionMaintenanceConfig): MaintenanceSettings {
  const errors: string[] = [];
  const pruneAfterRaw = String(cfg.pruneAfter ?? "30d");
  let pruneAfterMs = parseDurationMs(pruneAfterRaw);
  if (pruneAfterMs === null && pruneAfterRaw.trim() && pruneAfterRaw.trim() !== "0" && pruneAfterRaw.trim() !== "false") {
    errors.push(`session.maintenance.pruneAfter: unparseable duration "${pruneAfterRaw}" (using 30d)`);
    pruneAfterMs = 30 * 86_400_000;
  }
  let preserveRecentMs: number | null = null;
  if (cfg.preserveRecent && String(cfg.preserveRecent).trim()) {
    preserveRecentMs = parseDurationMs(String(cfg.preserveRecent));
    if (preserveRecentMs === null) errors.push(`session.maintenance.preserveRecent: unparseable duration "${cfg.preserveRecent}" (protection disabled)`);
  }
  let maxDiskBytes = parseByteSize(String(cfg.maxDiskBytes ?? "10gb"));
  if (maxDiskBytes === null && String(cfg.maxDiskBytes ?? "").trim() && !["0", "false"].includes(String(cfg.maxDiskBytes).trim())) {
    errors.push(`session.maintenance.maxDiskBytes: unparseable size "${cfg.maxDiskBytes}" (budget disabled)`);
  }
  let highWaterBytes: number | null = null;
  if (cfg.highWaterBytes && String(cfg.highWaterBytes).trim()) {
    highWaterBytes = parseByteSize(String(cfg.highWaterBytes));
    if (highWaterBytes === null) errors.push(`session.maintenance.highWaterBytes: unparseable size "${cfg.highWaterBytes}" (using 80% of budget)`);
  }
  if (maxDiskBytes !== null && highWaterBytes === null) highWaterBytes = Math.floor(maxDiskBytes * 0.8);
  const modeRaw = String(cfg.mode ?? "enforce");
  return {
    mode: modeRaw === "warn" ? "warn" : "enforce",
    pruneAfterMs,
    maxEntries: Number.isFinite(cfg.maxEntries) && cfg.maxEntries > 0 ? Math.floor(cfg.maxEntries) : Number.POSITIVE_INFINITY,
    preserveRecentMs,
    maxDiskBytes,
    highWaterBytes,
    errors,
  };
}

export type MaintenanceActionKind = "archive-age" | "archive-cap" | "keep" | "delete-cap-archive";

export interface MaintenanceAction {
  action: MaintenanceActionKind;
  key: string;
  ageMs: number;
  /** keep: what protects the row; delete-cap-archive: freed-estimate bytes. */
  detail?: string;
}

export interface MaintenanceReport {
  mode: "enforce" | "warn";
  /** True when writes were applied (enforce and not a dry-run). */
  applied: boolean;
  dryRun: boolean;
  /** Unarchived rows before / after (archived rows do not consume the cap). */
  beforeCount: number;
  afterCount: number;
  archivedAge: number;
  archivedCap: number;
  kept: number;
  deletedCapArchives: number;
  freedBytes: number;
  diskBytes: number | null;
  highWaterBytes: number | null;
  overBudget: boolean;
  actions: MaintenanceAction[];
  errors: string[];
}

export interface MaintenanceOptions {
  now?: number;
  dryRun?: boolean;
  /** CLI --enforce: apply even when the config mode is warn. */
  enforce?: boolean;
  /** Keys with live in-flight work — never archived (their protected rows). */
  activeKeys?: Iterable<string>;
  /** Byte accounting source for the disk budget; real default measures db+wal. */
  diskBytes?: () => number;
}

/** Real disk accounting: SuparClaw sqlite main file + WAL (their budget shape). */
export function defaultDiskBytes(dbFile: string): () => number {
  return () => {
    let total = 0;
    for (const p of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`]) {
      try {
        total += statSync(p).size;
      } catch {
        /* absent side files are normal */
      }
    }
    return total;
  };
}

export function runSessionMaintenance(
  store: Store,
  settings: MaintenanceSettings,
  opts: MaintenanceOptions = {},
): MaintenanceReport {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const applied = !dryRun && (opts.enforce === true || settings.mode === "enforce");
  const active = new Set(opts.activeKeys ?? []);
  const actions: MaintenanceAction[] = [];
  const errors = [...settings.errors];

  const isArchived = (r: SessionRow) => (r.archived ?? 0) !== 0;
  const ageOf = (r: SessionRow) => Math.max(0, now - (r.last_msg_at || r.created_at));
  const isProtected = (r: SessionRow): string | null => {
    if (active.has(r.key)) return "live run";
    if (settings.preserveRecentMs !== null && ageOf(r) < settings.preserveRecentMs) return "preserveRecent";
    return null;
  };

  const all = store.listAllSessionsForMaintenance(); // oldest activity first
  let unarchived = all.filter((r) => !isArchived(r));
  const beforeCount = unarchived.length;

  const archive = (r: SessionRow, action: "archive-age" | "archive-cap") => {
    actions.push({ action, key: r.key, ageMs: ageOf(r) });
    if (applied) store.archiveSession(r.id, action === "archive-age" ? "age-retention" : "capacity", now);
  };

  // 1) pruneAfter — archive eligible durable sessions in place.
  let archivedAge = 0;
  if (settings.pruneAfterMs !== null) {
    for (const r of unarchived) {
      if (ageOf(r) < settings.pruneAfterMs) continue;
      if (isProtected(r)) continue; // durable pointers stay, archive later
      archive(r, "archive-age");
      archivedAge++;
      r.archived = 1;
    }
    unarchived = all.filter((r) => !isArchived(r));
  }

  // 2) maxEntries — cap unarchived rows; protected rows report keep and the
  //    store may stay above the cap (their overflow semantics).
  let archivedCap = 0;
  let kept = 0;
  let remaining = unarchived.length;
  if (Number.isFinite(settings.maxEntries) && remaining > settings.maxEntries) {
    for (const r of unarchived) {
      if (remaining <= settings.maxEntries) break;
      const protection = isProtected(r);
      if (protection) {
        kept++;
        actions.push({ action: "keep", key: r.key, ageMs: ageOf(r), detail: protection });
        continue;
      }
      archive(r, "archive-cap");
      r.archived = 1;
      archivedCap++;
      remaining--;
    }
  }
  const afterCount = unarchived.length - archivedCap;

  // 3) Disk budget — oldest archive-cap rows evict first; age-retention
  //    archives and live rows stay protected (their order).
  const measure = opts.diskBytes;
  const diskBefore = measure ? measure() : null;
  let overBudget = false;
  let deletedCapArchives = 0;
  let freedBytes = 0;
  if (settings.maxDiskBytes !== null && diskBefore !== null && diskBefore > settings.maxDiskBytes) {
    overBudget = true;
    const target = settings.highWaterBytes ?? Math.floor(settings.maxDiskBytes * 0.8);
    let projected = diskBefore;
    const capArchives = all.filter((r) => isArchived(r) && r.archive_reason === "capacity");
    for (const r of capArchives) {
      if (projected <= target) break;
      const estimate = store.sessionContentBytes(r.id);
      actions.push({ action: "delete-cap-archive", key: r.key, ageMs: ageOf(r), detail: `${estimate} bytes (est.)` });
      deletedCapArchives++;
      projected -= estimate;
      if (applied) store.deleteSession(r.key);
    }
    if (applied && measure) {
      const diskAfter = measure();
      freedBytes = Math.max(0, diskBefore - diskAfter);
    } else {
      freedBytes = Math.max(0, diskBefore - projected); // dry-run/warn estimate
    }
  }

  return {
    mode: settings.mode,
    applied,
    dryRun,
    beforeCount,
    afterCount,
    archivedAge,
    archivedCap,
    kept,
    deletedCapArchives,
    freedBytes,
    diskBytes: diskBefore,
    highWaterBytes: settings.highWaterBytes,
    overBudget,
    actions,
    errors,
  };
}
