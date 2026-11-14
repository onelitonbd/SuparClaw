// Where a checkout's git directory really is, and what its HEAD says.
//
// A clone keeps `.git` as a directory. **A linked worktree — which is what every
// SuparClaw code session works in (`repos/worktrees/<owner>-<repo>/<slug>`) —
// keeps `.git` as a one-line file**: `gitdir: …/worktrees/<name>`. Reading
// `<worktree>/.git/HEAD` therefore fails with ENOTDIR, and worse, the updater's
// old `try { … } catch {}` turned that into a silent "main" (Task 39).
//
// Nothing here shells out to git: the System tab asks for the ref on every
// refresh, and a subprocess would add a failure mode for no gain.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface GitHead {
  /** The directory that holds this checkout's HEAD (worktrees: `.git/worktrees/<n>`). */
  gitDir: string;
  /** The ref namespace a branch ref lives under, i.e. HEAD's own text. */
  text: string;
  /** Branch shorthand (`sc/feature`) when HEAD is on a branch; null when detached. */
  ref: string | null;
  /** Commit HEAD resolves to, when a ref file or packed-refs is readable. */
  sha: string | null;
}

const SHA = /^[0-9a-f]{40}$/;

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when this checkout's `.git` is the worktree/submodule pointer file. */
export function gitIsFile(root: string): boolean {
  try {
    return statSync(join(root, ".git")).isFile();
  } catch {
    return false;
  }
}

/** The real git directory behind a checkout, or null when there is no `.git`. */
export function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  if (isDir(dot)) return dot;
  const text = readSafe(dot);
  if (text === null) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const target = m[1]!.trim();
  return isAbsolute(target) ? target : resolve(root, target);
}

/** A worktree's branch refs live in the common dir (`commondir` points at it). */
export function gitCommonDir(gitDir: string): string {
  const text = readSafe(join(gitDir, "commondir"));
  if (!text) return gitDir;
  const target = text.trim();
  if (!target) return gitDir;
  return isAbsolute(target) ? target : resolve(gitDir, target);
}

function refFromFile(dir: string, name: string): string | null {
  const text = readSafe(join(dir, name));
  if (text === null) return null;
  const value = text.trim();
  return SHA.test(value) ? value : null;
}

function refFromPacked(dir: string, name: string): string | null {
  const text = readSafe(join(dir, "packed-refs"));
  if (!text) return null;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, ref] = line.split(" ");
    if (ref === name && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/** A ref's commit: the loose file first (that is what a fresh commit writes),
 *  then packed-refs, in the git dir and then in the shared common dir. */
export function gitRefSha(root: string, name: string): string | null {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  const common = gitCommonDir(gitDir);
  return refFromFile(gitDir, name) ?? refFromFile(common, name) ?? refFromPacked(gitDir, name) ?? refFromPacked(common, name);
}

/**
 * HEAD of a checkout, whichever shape `.git` has.
 *
 * `text` is exactly what `<root>/.git/HEAD` holds in a clone — `ref:
 * refs/heads/x` or a bare commit id — so a caller can hand it back verbatim
 * instead of inventing a format.
 */
export function gitHead(root: string): GitHead | null {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  const text = readSafe(join(gitDir, "HEAD"));
  if (text === null) return null;
  const line = text.replace(/\s+$/, "");
  const m = /^ref:\s*(refs\/heads\/.+)$/.exec(line);
  if (!m) {
    return { gitDir, text: line, ref: null, sha: SHA.test(line) ? line : null };
  }
  const name = m[1]!;
  return { gitDir, text: line, ref: name.slice("refs/heads/".length), sha: gitRefSha(root, name) };
}
