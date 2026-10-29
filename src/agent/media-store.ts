// The attachment store on disk (Task 30).
//
// Every file a message carries lives under `<workspace>/media` — web uploads
// directly there, Telegram media under `media/telegram/<chatId>/`. Nothing used
// to look at that tree again: no size report, no cleanup, and deleting a chat
// left its uploads behind forever. This module is the only thing that walks it,
// so the CLI, the gateway's scheduled sweep, the doctor and the delete-a-chat
// path all agree on what is there and what is safe to remove.

import { existsSync, lstatSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface MediaFile {
  /** Workspace-relative, forward slashes (`media/telegram/123/x.jpg`). */
  path: string;
  size: number;
  /** Last-modified time in ms. */
  mtime: number;
}

export interface MediaStats {
  files: number;
  bytes: number;
  /** Age in days of the oldest / newest file; null when the tree is empty. */
  oldestDays: number | null;
  newestDays: number | null;
}

export const MEDIA_ROOT = "media";

export function mediaRoot(workspace: string): string {
  return join(workspace, MEDIA_ROOT);
}

/**
 * Every regular file under `media/`, sorted oldest first.
 *
 * Symlinks are skipped rather than followed: a link planted in the tree must
 * never make a prune or a download reach outside it.
 */
export function listMedia(workspace: string): MediaFile[] {
  const root = mediaRoot(workspace);
  if (!existsSync(root)) return [];
  const out: MediaFile[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPath = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(full);
        out.push({ path: relPath, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  walk(root, MEDIA_ROOT);
  return out.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
}

export function mediaStats(workspace: string, now = Date.now()): MediaStats {
  const files = listMedia(workspace);
  if (files.length === 0) return { files: 0, bytes: 0, oldestDays: null, newestDays: null };
  const day = 86_400_000;
  const oldest = Math.min(...files.map((f) => f.mtime));
  const newest = Math.max(...files.map((f) => f.mtime));
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    oldestDays: Math.max(0, Math.floor((now - oldest) / day)),
    newestDays: Math.max(0, Math.floor((now - newest) / day)),
  };
}

/**
 * Resolve a workspace-relative media path to an absolute one, or null when it
 * would leave the media root. This is the single gate used by the download
 * route, prune and delete-a-chat — traversal is refused in one place.
 */
export function resolveMediaPath(workspace: string, relPath: string): string | null {
  if (!relPath || relPath.includes("\0") || relPath.includes("\\")) return null;
  const parts = relPath.split("/");
  if (parts[0] !== MEDIA_ROOT) return null;
  if (!parts.every((p) => p !== "" && p !== "." && p !== "..")) return null;
  const root = mediaRoot(workspace);
  const full = resolve(workspace, relPath);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export interface PruneResult {
  removed: MediaFile[];
  freedBytes: number;
  kept: number;
  /** Files that were candidates but no longer existed when we got there. */
  missing: number;
}

function removeFiles(workspace: string, files: MediaFile[], dryRun: boolean): PruneResult {
  const result: PruneResult = { removed: [], freedBytes: 0, kept: 0, missing: 0 };
  for (const file of files) {
    const full = resolveMediaPath(workspace, file.path);
    if (!full) {
      result.kept += 1;
      continue;
    }
    if (!existsSync(full)) {
      result.missing += 1;
      continue;
    }
    if (!dryRun) {
      try {
        unlinkSync(full);
      } catch {
        result.kept += 1;
        continue;
      }
    }
    result.removed.push(file);
    result.freedBytes += file.size;
  }
  return result;
}

/**
 * Delete files older than `maxAgeDays` (0 disables). `dryRun` reports exactly
 * what would go without touching anything — the CLI defaults to that being a
 * flag, the scheduled sweep never sets it.
 */
export function pruneMedia(
  workspace: string,
  opts: { maxAgeDays: number; dryRun?: boolean; now?: number },
): PruneResult {
  const now = opts.now ?? Date.now();
  if (!opts.maxAgeDays || opts.maxAgeDays <= 0) {
    return { removed: [], freedBytes: 0, kept: listMedia(workspace).length, missing: 0 };
  }
  const cutoff = now - opts.maxAgeDays * 86_400_000;
  const stale = listMedia(workspace).filter((f) => f.mtime <= cutoff);
  return removeFiles(workspace, stale, opts.dryRun === true);
}

/**
 * Delete files no message references any more (`isReferenced` asks the store).
 * This is what makes "the chat is gone" mean "its uploads are gone" without
 * ever removing a file a fork still points at.
 */
export function pruneOrphans(
  workspace: string,
  opts: { isReferenced: (relPath: string) => boolean; dryRun?: boolean },
): PruneResult {
  const orphans = listMedia(workspace).filter((f) => !opts.isReferenced(f.path));
  return removeFiles(workspace, orphans, opts.dryRun === true);
}

/** Delete specific files (used by delete-a-chat). Never leaves the root. */
export function deleteFiles(workspace: string, relPaths: string[], dryRun = false): PruneResult {
  const result: PruneResult = { removed: [], freedBytes: 0, kept: 0, missing: 0 };
  const seen = new Set<string>();
  for (const relPath of relPaths) {
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    const full = resolveMediaPath(workspace, relPath);
    if (!full) {
      result.kept += 1;
      continue;
    }
    if (!existsSync(full)) {
      result.missing += 1;
      continue;
    }
    let size = 0;
    try {
      const st = lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) {
        result.kept += 1;
        continue;
      }
      size = st.size;
      if (!dryRun) unlinkSync(full);
    } catch {
      result.kept += 1;
      continue;
    }
    result.removed.push({ path: relPath, size, mtime: Date.now() });
    result.freedBytes += size;
  }
  return result;
}

/**
 * True when `relPath` resolves to a real file inside the media root, following
 * no symlink out of it. The HTTP route asks this before serving bytes.
 */
export function mediaFileOnDisk(workspace: string, relPath: string): string | null {
  const full = resolveMediaPath(workspace, relPath);
  if (!full) return null;
  try {
    if (!lstatSync(full).isFile()) return null;
    const real = realpathSync(full);
    const realRoot = realpathSync(mediaRoot(workspace));
    if (!real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null;
  }
}
