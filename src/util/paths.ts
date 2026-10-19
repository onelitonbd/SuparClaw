import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

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
export function logsDir(): string {
  return join(stateDir(), "logs");
}
export function mediaDir(): string {
  return join(stateDir(), "media");
}
export function pidPath(): string {
  return join(stateDir(), "gateway.pid");
}

export function ensureDirs(): void {
  for (const dir of [stateDir(), workspaceDir(), skillsDir(), logsDir(), mediaDir()]) {
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

/** dist/sc.mjs -> repo root -> ui/ */
export function webUiRoot(): string {
  try {
    return fileURLToPath(new URL("../ui", import.meta.url));
  } catch {
    return "";
  }
}

export function prefixDir(): string {
  return process.env.PREFIX ?? "";
}