import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

export const APP = "suparclaw";
export const DEFAULT_PORT = 18790;

/** $SUPARCLAW_HOME > $HOME (Termux-native, no XDG surprises). */
export function homeDir(): string {
  const explicit = process.env.SUPARCLAW_HOME?.trim();
  return explicit ? resolve(explicit) : homedir();
}

export function stateDir(): string {
  return join(homeDir(), `.${APP}`);
}
export function configPath(): string {
  return process.env.SUPARCLAW_CONFIG?.trim() || join(stateDir(), "config.json5");
}
export function dbPath(): string {
  return join(stateDir(), "state.sqlite");
}
export function workspaceDir(): string {
  return join(stateDir(), "workspace");
}
export function skillsDir(): string {
  return join(stateDir(), "skills");
}
/**
 * Tools the agent wrote for itself (Task 58).
 *
 * State, not workspace: a self-tool is a capability of the daemon, so it must
 * work in every session — including a code session whose workspace is a git
 * worktree somewhere else entirely.
 */
export function toolsDir(): string {
  return join(stateDir(), "tools");
}
export function logsDir(): string {
  return join(stateDir(), "logs");
}
export function pidPath(): string {
  return join(stateDir(), "gateway.pid");
}

export function ensureDirs(): void {
  // Attachments live under workspace/media (Task 30); there is no separate
  // top-level media dir — it only ever held an empty folder.
  for (const dir of [stateDir(), workspaceDir(), skillsDir(), toolsDir(), logsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function expandHome(p: string): string {
  if (p === "~") return homeDir();
  return p.startsWith("~/") ? join(homeDir(), p.slice(2)) : p;
}

/** True when running inside Termux (native or proot). */
export function isTermux(): boolean {
  return Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX ?? "").includes("com.termux");
}

/** Termux runs under PRoot often; both are slow, but we label them apart for diagnosis. */
export function isProot(): boolean {
  return isTermux() && process.env.PROOT_L2S_DIR !== undefined && process.env.PROOT_L2S_DIR !== "";
}

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Walk upwards from this module looking for a sibling directory of the bundle.
 * Code splitting moves modules into dist/chunks/, so a fixed "../x" guess is wrong.
 */
export function findBundledDir(name: string, marker: string, maxUp = 5): string {
  let dir = moduleDir();
  for (let i = 0; i < maxUp; i++) {
    const candidate = join(dir, name);
    if (existsSync(join(candidate, marker))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(moduleDir(), name);
}

export function webUiRoot(): string {
  return findBundledDir("ui", "index.html");
}

export function prefixDir(): string {
  return process.env.PREFIX ?? "";
}
/** Read a UTF-8 text file, or null when it is missing/unreadable. */
export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
