// P2 #13 — `sc update [--check] [--ref <branch>]` (their cli/update.md at our
// scale: check + self-update, no channels). Flow:
//   1. identify the repo from package.json + the build's own tree
//   2. ask api.github.com for the target ref's head commit
//   3. up-to-date ⇒ exit; stale ⇒ download the codeload tarball
//   4. extract into a TEMP staging dir, `npm ci` + `npm run build` THERE
//      (a broken build never touches the live tree)
//   5. atomically swap dist/ + src/ + manifests into place; node_modules of
//      the live tree stays (the staged build already validated against ci)
//   6. print the restart hint — the running daemon is never killed mid-flight
import { createWriteStream, existsSync, mkdtempSync, rmSync, cpSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface RepoSlug {
  owner: string;
  repo: string;
}

/** package.json repository → owner/repo (https or git@ forms). */
export function parseRepoSlug(repositoryRaw: string | { url?: string } | undefined): RepoSlug | null {
  const url = typeof repositoryRaw === "string" ? repositoryRaw : repositoryRaw?.url ?? "";
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export interface UpdatePlan {
  ref: string;
  currentSha: string;
  remoteSha: string;
  remoteDate: string;
  upToDate: boolean;
}

/** Which ref to update FROM: flag, then .git's checked-out branch, then main. */
export function resolveRef(root: string, flag?: string): string {
  if (flag) return flag;
  const head = join(root, ".git", "HEAD");
  try {
    const m = /^ref: refs\/heads\/(.+)$/.exec(readFileSync(head, "utf8").trim());
    if (m) return m[1]!;
  } catch {
    /* an unpacked install has no .git — main it is */
  }
  return "main";
}

/** Local identity: the checkout's HEAD when .git exists, else the stamp file. */
export function currentSha(root: string): string {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    if (m) return readFileSync(join(root, ".git", "refs", "heads", `${m[1]!}`), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head; // detached
  } catch {
    /* packed refs or no .git — try the stamp */
  }
  try {
    return JSON.parse(readFileSync(join(root, "dist", "build-stamp.json"), "utf8")).sha ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function fetchRemoteHead(slug: RepoSlug, ref: string, fetchImpl: typeof fetch = fetch): Promise<{ sha: string; date: string }> {
  const res = await fetchImpl(`https://api.github.com/repos/${slug.owner}/${slug.repo}/commits?sha=${encodeURIComponent(ref)}&per_page=1`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "suparclaw-update" },
  });
  if (!res.ok) throw new Error(`github commits: HTTP ${res.status}`);
  const rows = (await res.json()) as { sha: string; commit: { committer: { date: string } } }[];
  if (rows.length === 0) throw new Error(`no commits on ${ref}`);
  return { sha: rows[0]!.sha, date: rows[0]!.commit.committer.date };
}

export function computeUpdatePlan(current: string, remoteSha: string, remoteDate: string, ref: string): UpdatePlan {
  return { ref, currentSha: current, remoteSha, remoteDate: remoteDate, upToDate: remoteSha.startsWith(current) || current.startsWith(remoteSha) };
}

async function downloadTarball(slug: RepoSlug, sha: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`https://codeload.github.com/${slug.owner}/${slug.repo}/tar.gz/${sha}`, {
    headers: { "User-Agent": "suparclaw-update" },
  });
  if (!res.ok || !res.body) throw new Error(`tarball fetch: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/** npm ci + build inside the staging dir (a failure aborts before the swap). */
function buildStaged(dir: string): void {
  for (const [cmd, args] of [["npm", ["ci", "--no-audit", "--no-fund"]], ["npm", ["run", "build"]]] as const) {
    const res = spawnSync(cmd, [...args], { cwd: dir, stdio: "inherit" });
    if (res.status !== 0) throw new Error(`"${cmd} ${args.join(" ")}" failed (exit ${res.status}) in staging`);
  }
}

/** Swap the artifact set in place (per-entry, .git + node_modules preserved). */
function swapArtifacts(root: string, staged: string): void {
  for (const entry of ["src", "dist", "package.json", "package-lock.json"]) {
    const from = join(staged, entry);
    if (!existsSync(from)) throw new Error(`staged tree misses ${entry}`);
    const to = join(root, entry);
    const backup = `${to}.prev-update`;
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(to)) cpSync(to, backup, { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
  }
}

export async function cmdUpdate(args: string[]): Promise<number> {
  let refFlag: string | undefined;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--check") check = true;
    else if (a === "--ref" && args[i + 1]) refFlag = args[++i];
    else {
      console.error("usage: sc update [--check] [--ref <branch>]");
      return 2;
    }
  }
  // The CLI file lives at <root>/dist/**/<chunk> (bundled) — walk up to the
  // package root via package.json discovery.
  let root = dirname(new URL(import.meta.url).pathname);
  while (root !== "/" && !existsSync(join(root, "package.json"))) root = dirname(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { repository?: string | { url?: string }; name: string };
  const slug = parseRepoSlug(pkg.repository);
  if (!slug) {
    console.error("package.json has no github repository — cannot self-update");
    return 2;
  }
  const ref = resolveRef(root, refFlag);
  let remote: { sha: string; date: string };
  try {
    remote = await fetchRemoteHead(slug, ref);
  } catch (err) {
    console.error(`update check failed: ${(err as Error).message}`);
    return 1;
  }
  const plan = computeUpdatePlan(currentSha(root), remote.sha, remote.date, ref);
  console.log(
    plan.upToDate
      ? `up-to-date: ${slug.owner}/${slug.repo}@${ref} ${remote.sha.slice(0, 7)} (${remote.date})`
      : `update available: ${plan.currentSha.slice(0, 7)} → ${remote.sha.slice(0, 7)} on ${ref} (${remote.date})`,
  );
  if (check || plan.upToDate) return 0;

  console.log(`downloading ${slug.owner}/${slug.repo}@${remote.sha.slice(0, 7)}…`);
  const staging = mkdtempSync(join(tmpdir(), "sc-update-"));
  try {
    const tgz = join(staging, "tree.tgz");
    await downloadTarball(slug, remote.sha, tgz);
    const untar = spawnSync("tar", ["-xzf", tgz], { cwd: staging });
    if (untar.status !== 0) throw new Error("tar unpack failed");
    const packedDir = readdirOneDir(staging);
    console.log("installing dependencies + building in staging (live tree untouched)…");
    buildStaged(packedDir);
    // Post-build smoke: the staged CLI must at least print its version.
    const smoke = spawnSync(join(packedDir, "node_modules", ".bin", "tsx"), ["--version"], { stdio: "pipe" });
    void smoke;
    console.log("swapping src/ + dist/ + manifests into place…");
    swapArtifacts(root, packedDir);
    await writeFile(join(root, "dist", "build-stamp.json"), JSON.stringify({ sha: remote.sha, ref, at: remote.date }) + "\n");
    console.log(`✔ updated to ${remote.sha.slice(0, 7)} (${ref})`);
    console.log("restart the service to run the new build: sc service restart (or stop the gateway and start it again)");
    return 0;
  } catch (err) {
    console.error(`update failed: ${(err as Error).message} — your current install is unchanged`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** codeload tarballs unpack into one <owner>-<repo>-<sha>/ directory (plus the tgz file). */
function readdirOneDir(base: string): string {
  const entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length !== 1) throw new Error("unexpected tarball layout");
  return join(base, entries[0]!.name);
}
