// Binding a session to a repository (Task 35), and to one of its branches
// (Task 36).
//
// One repo per session, fixed once work exists. The binding lives in the
// session row (kind/repo/base/branch/workspace) so the web bar, the TUI footer,
// the Telegram draft and the agent's prompt all read the same facts.
//
// `branch` is the branch being *continued*; `base` is the pull-request target
// (the repository's default branch). They are equal when the user chose to work
// straight on the default branch, which is a normal thing to do — publishing
// still goes through a session branch, decided in `RepoManager.publish`.

import type { Store } from "../state/db.js";
import type { GithubCreds } from "./github.js";
import type { RepoManager, PrepareProgress } from "./manager.js";

export interface RepoBinding {
  kind: "code";
  repo: string;
  base: string;
  branch: string;
  workspace: string;
}

export type BindResult =
  | { ok: true; binding: RepoBinding }
  | { ok: false; error: string };

export interface BindOptions {
  store: Store;
  manager: RepoManager;
  sessionKey: string;
  repo: string;
  /** Pull-request target; defaults to the repository's default branch. */
  base?: string;
  /** The branch to continue; defaults to the base. */
  branch?: string;
  creds?: GithubCreds | null;
  onProgress?: (p: PrepareProgress) => void;
  /** Rebinding is allowed only while the session has no repo yet. */
  allowRebind?: boolean;
}

/**
 * Prepare the worktree and write the binding.
 *
 * Refuses to rebind a session that already has a repository: its history now
 * refers to files in that worktree, and silently pointing it somewhere else
 * would make yesterday's answers wrong.
 */
export async function bindSessionRepo(opts: BindOptions): Promise<BindResult> {
  const existing = opts.store.getSessionRepo(opts.sessionKey);
  if (existing && !opts.allowRebind) {
    if (existing.repo === opts.repo) return { ok: true, binding: { ...existing, kind: "code" } };
    return {
      ok: false,
      error: `This session is working in ${existing.repo}. Start a new session for another repository.`,
    };
  }
  try {
    const prepared = await opts.manager.prepare({
      repo: opts.repo,
      sessionKey: opts.sessionKey,
      base: opts.base,
      branch: opts.branch,
      creds: opts.creds,
      onProgress: opts.onProgress,
    });
    opts.store.setSessionRepo(opts.sessionKey, {
      kind: "code",
      repo: opts.repo,
      base: prepared.base,
      branch: prepared.branch,
      workspace: prepared.workspace,
    });
    return { ok: true, binding: { kind: "code", repo: opts.repo, base: prepared.base, branch: prepared.branch, workspace: prepared.workspace } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** A plain chat is the absence of a binding — clear it explicitly. */
export function unbindSessionRepo(store: Store, sessionKey: string): void {
  store.setSessionRepo(sessionKey, null);
}

/**
 * The prompt block for a repo session.
 *
 * Two short sections: where you are and how to work here. The repo's own AGENTS.md arrives via
 * the workspace loader, so it is not repeated here.
 */
export function repoPromptBlock(opts: {
  repo: string;
  base: string;
  branch: string;
  workspace: string;
  files?: number;
}): string {
  const onBase = opts.branch === opts.base;
  return [
    "## Repository",
    `${opts.repo} · branch ${opts.branch}${onBase ? " (the default branch)" : ` (from ${opts.base})`}` +
      `${opts.files ? ` · ${opts.files.toLocaleString("en-US")} files` : ""}`,
    `Workspace: ${opts.workspace}`,
    "",
    "## How to work here",
    "Read a file before editing it. Reproduce a bug before fixing it.",
    "Run the project's checks before saying something works. Say what you verified and what you did not.",
    "You may keep editing and running things for as long as the work needs.",
    `Work on the branch you are given (${opts.branch}). Do not switch branches or create one; that is the user's choice.`,
    "",
    "## Publishing",
    "github_publish commits the session branch, pushes it, and opens a pull request. Never force-push or push to the default branch.",
  ].join("\n");
}
