/**
 * `sc backup` core (P3 #29 — their cli/backup.md, scoped to our footprint):
 *
 *  - create: timestamped `.tar.gz` of config + state + workspace, with a
 *    schema-version-1 manifest (their manifest rule) and a consistent
 *    SQLite snapshot taken with `VACUUM INTO` (their online-snapshot +
 *    compacted + sidecars-omitted rules; WAL-committed data included).
 *  - verify: exactly one root manifest, no traversal members (enforced at
 *    parse), size+sha256 match for every manifest file, SQLite
 *    integrity_check on the archived snapshot.
 *  - restore: verifies first (never extracts an unverified archive), refuses
 *    a non-empty target without --force, regular files only.
 *  - guards (theirs): never overwrite an existing archive, reject output
 *    inside the state/workspace trees (self-inclusion), dry-run previews.
 *  - skipped (their infra, not ours): offsite storage locations, git/sqlite
 *    subcommand families, schedules, PostgreSQL capsules, hardlink aliases.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configPath, dbPath, homeDir, stateDir, workspaceDir } from "../util/paths.js";
import { readTarGz, writeTarGz, type TarEntry } from "./tar.js";

export const BACKUP_MANIFEST_VERSION = 1;

export interface BackupFileEntry {
  path: string; // archive path under `payload/`
  size: number;
  sha256: string;
  kind: "config" | "db" | "state" | "workspace";
}

export interface BackupManifest {
  schemaVersion: number;
  app: "suparclaw";
  createdAt: string;
  host: { stateDir: string; config: string | null; workspace: string | null };
  assets: { config: string | null; stateDb: string | null; workspace: boolean };
  files: BackupFileEntry[];
  warnings: string[];
}

export interface BackupResult {
  archivePath: string | null;
  files: number;
  bytes: number;
  warnings: string[];
  dryRun: boolean;
  verified?: boolean;
}

/** Local-timestamp archive name with UTC offset (their filename rule). */
export function backupStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(Math.abs(off) / 60))}-${p(Math.abs(off) % 60)}`
  );
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Recursively collect regular files below `root`, skipping symlinks and
 *  runtime junk (their runtime-root + sidecar rules). Paths come back
 *  relative, forward-slashed, sorted for a deterministic archive. */
function collect(root: string, relPrefix: string, warnings: string[], skip: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // disappeared mid-walk
      }
      if (st.isSymbolicLink()) {
        warnings.push(`skipped symlink: ${relPrefix ? `${relPrefix}/` : ""}${relPath}`);
        continue;
      }
      if (st.isDirectory()) {
        if (skip.has(relPath)) continue;
        walk(abs, relPath);
      } else if (st.isFile()) {
        if (skip.has(relPath)) continue;
        out.push(relPath);
      } else {
        warnings.push(`skipped non-regular file: ${relPath}`);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

/** Consistent SQLite snapshot (their online-backup + VACUUM semantics). */
function snapshotSqlite(scratchDir: string): Buffer | null {
  const db = dbPath();
  if (!existsSync(db)) return null;
  const snap = join(scratchDir, "state-snapshot.sqlite");
  const conn = new DatabaseSync(db);
  try {
    conn.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  } finally {
    conn.close();
  }
  return readFileSync(snap);
}

function inside(child: string, parent: string): boolean {
  const rel = resolve(child).slice(resolve(parent).length);
  return resolve(child) === resolve(parent) || rel.startsWith(sep);
}

export async function createBackup(opts: {
  outputDir?: string;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  dryRun?: boolean;
  verify?: boolean;
}): Promise<BackupResult> {
  const warnings: string[] = [];
  const state = stateDir();
  const workspace = workspaceDir();
  const includeWorkspace = opts.includeWorkspace !== false;
  const stamp = backupStamp();
  const rootName = `${stamp}-suparclaw-backup`;

  // ---- gather payload ----
  const files: { path: string; buf: Buffer; kind: BackupFileEntry["kind"] }[] = [];
  const cfg = configPath();
  const cfgBuf = existsSync(cfg) ? readFileSync(cfg) : null;
  if (cfgBuf) files.push({ path: `payload/config/${basename(cfg)}`, buf: cfgBuf, kind: "config" });

  let stateDbPathInArchive: string | null = null;
  if (!opts.onlyConfig) {
    const scratch = mkdtempSync(join(tmpdir(), "sc-backup-"));
    try {
      const snap = snapshotSqlite(scratch);
      if (snap) {
        stateDbPathInArchive = "payload/state/state.sqlite";
        files.push({ path: stateDbPathInArchive, buf: snap, kind: "db" });
      }
      // Other state files (sidecars, runtime pid and tmp excluded — their rules).
      const skip = new Set(["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "gateway.pid", "tmp", "workspace"]);
      if (existsSync(state)) {
        for (const rel of collect(state, "", warnings, skip)) {
          files.push({ path: `payload/state/${rel}`, buf: readFileSync(join(state, rel)), kind: "state" });
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (includeWorkspace && existsSync(workspace)) {
      for (const rel of collect(workspace, "", warnings, new Set())) {
        files.push({ path: `payload/workspace/${rel}`, buf: readFileSync(join(workspace, rel)), kind: "workspace" });
      }
    }
  }

  const manifest: BackupManifest = {
    schemaVersion: BACKUP_MANIFEST_VERSION,
    app: "suparclaw",
    createdAt: new Date().toISOString(),
    host: {
      stateDir: state,
      config: cfgBuf ? cfg : null,
      workspace: includeWorkspace && !opts.onlyConfig && existsSync(workspace) ? workspace : null,
    },
    assets: {
      config: cfgBuf ? `payload/config/${basename(cfg)}` : null,
      stateDb: stateDbPathInArchive,
      workspace: includeWorkspace && !opts.onlyConfig && existsSync(workspace),
    },
    files: files.map((f) => ({ path: f.path, size: f.buf.length, sha256: sha256(f.buf), kind: f.kind })),
    warnings,
  };

  const bytes = files.reduce((acc, f) => acc + f.buf.length, 0);
  if (opts.dryRun) {
    return { archivePath: null, files: files.length, bytes, warnings, dryRun: true };
  }

  // ---- archive ----
  const entries: TarEntry[] = [
    { name: `${rootName}/manifest.json`, buf: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") },
    ...files.map((f) => ({ name: `${rootName}/${f.path}` as string, buf: f.buf })),
  ];
  const blob = writeTarGz(entries);

  // Default output: cwd — but never inside a backed-up tree (their fallback rule).
  let outDir = opts.outputDir ? resolve(opts.outputDir) : process.cwd();
  if (!opts.outputDir && (inside(outDir, state) || inside(outDir, workspace))) outDir = homeDir();
  // Output may not land inside the source trees (self-inclusion guard).
  if (inside(outDir, state) || inside(outDir, workspace)) {
    throw new Error(`backup output ${outDir} is inside the backed-up state/workspace tree`);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const archivePath = join(outDir, `${rootName}.tar.gz`);
  if (existsSync(archivePath)) throw new Error(`archive already exists: ${archivePath} (existing archives are never overwritten)`);
  writeFileSync(archivePath, blob); // fresh exclusive create via no-overwrite name

  let verified: boolean | undefined;
  if (opts.verify) {
    const v = await verifyBackup(archivePath);
    verified = v.ok;
    if (!v.ok) warnings.push(...v.errors.map((e) => `verify: ${e}`));
  }
  return { archivePath, files: files.length, bytes, warnings, dryRun: false, verified };
}

export interface VerifyResult {
  ok: boolean;
  archive: string;
  files: number;
  bytes: number;
  sqliteOk: boolean | null;
  errors: string[];
  warnings: string[];
}

export async function verifyBackup(archivePath: string): Promise<VerifyResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let entries: ReturnType<typeof readTarGz> = [];
  try {
    entries = readTarGz(readFileSync(archivePath));
  } catch (err) {
    return { ok: false, archive: archivePath, files: 0, bytes: 0, sqliteOk: null, errors: [`unreadable archive: ${(err as Error).message}`], warnings };
  }
  const manifests = entries.filter((e) => /^[^/]+\/manifest\.json$/.test(e.name) && e.buf);
  if (manifests.length !== 1) errors.push(`expected exactly one root manifest.json, found ${manifests.length}`);
  let manifest: BackupManifest | null = null;
  if (manifests.length === 1) {
    try {
      manifest = JSON.parse(manifests[0]!.buf!.toString("utf8")) as BackupManifest;
      if (manifest.schemaVersion !== BACKUP_MANIFEST_VERSION) errors.push(`unsupported manifest schema version ${manifest.schemaVersion}`);
    } catch (err) {
      errors.push(`manifest parse failed: ${(err as Error).message}`);
    }
  }
  const byName = new Map(entries.filter((e) => e.buf).map((e) => [e.name, e.buf!] as const));
  const rootName = manifests[0]?.name.replace(/\/manifest\.json$/, "") ?? "";
  let files = 0;
  let bytes = 0;
  if (manifest) {
    for (const f of manifest.files) {
      const entry = byName.get(`${rootName}/${f.path}`);
      if (!entry) {
        errors.push(`missing payload file: ${f.path}`);
        continue;
      }
      if (entry.length !== f.size) {
        errors.push(`size mismatch: ${f.path} (manifest ${f.size}, archive ${entry.length})`);
        continue;
      }
      if (sha256(entry) !== f.sha256) {
        errors.push(`sha256 mismatch: ${f.path}`);
        continue;
      }
      files++;
      bytes += entry.length;
    }
  }
  // SQLite snapshot integrity (their verify rule)
  let sqliteOk: boolean | null = null;
  if (manifest?.assets.stateDb) {
    const snap = byName.get(`${rootName}/${manifest.assets.stateDb}`);
    if (!snap) {
      errors.push("manifest lists a state snapshot missing from the archive");
    } else {
      const scratch = mkdtempSync(join(tmpdir(), "sc-backup-verify-"));
      try {
        const p = join(scratch, "check.sqlite");
        writeFileSync(p, snap);
        const conn = new DatabaseSync(p, { readOnly: true });
        try {
          const row = conn.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
          sqliteOk = row?.integrity_check === "ok";
          if (!sqliteOk) errors.push(`sqlite integrity_check failed: ${row?.integrity_check ?? "no result"}`);
        } finally {
          conn.close();
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  return { ok: errors.length === 0, archive: archivePath, files, bytes, sqliteOk, errors, warnings };
}

export async function restoreBackup(
  archivePath: string,
  target: string,
  opts: { force?: boolean } = {},
): Promise<{ restored: number; target: string; warnings: string[] }> {
  const verify = await verifyBackup(archivePath);
  if (!verify.ok) {
    throw new Error(`refusing to restore unverified archive: ${verify.errors.join("; ")}`);
  }
  const dest = resolve(target);
  if (existsSync(dest)) {
    const nonEmpty = readdirSync(dest).length > 0;
    if (nonEmpty && !opts.force) {
      throw new Error(`restore target is not empty: ${dest} (pass --force to restore into it anyway)`);
    }
  } else {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readTarGz(readFileSync(archivePath));
  const rootName = entries.find((e) => /^[^/]+\/manifest\.json$/.test(e.name))!.name.replace(/\/manifest\.json$/, "");
  let restored = 0;
  const warnings: string[] = [];
  for (const e of entries) {
    if (!e.buf || !e.name.startsWith(`${rootName}/payload/`)) continue;
    const rel = e.name.slice(`${rootName}/payload/`.length);
    let outRel: string;
    if (rel.startsWith("config/")) outRel = rel.slice("config/".length);
    else if (rel.startsWith("state/")) outRel = rel.slice("state/".length);
    else if (rel.startsWith("workspace/")) outRel = join("workspace", rel.slice("workspace/".length));
    else continue;
    if (outRel.split(/[\\/]/).includes("..")) {
      warnings.push(`skipped unsafe member: ${rel}`);
      continue;
    }
    const out = join(dest, outRel);
    if (existsSync(out) && !opts.force) {
      warnings.push(`kept existing: ${outRel}`);
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, e.buf);
    restored++;
  }
  return { restored, target: dest, warnings };
}

export function listBackups(dir: string): { file: string; size: number; mtime: string }[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => n.endsWith("-suparclaw-backup.tar.gz"))
    .map((n) => {
      const st = statSync(join(root, n));
      return { file: join(root, n), size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
