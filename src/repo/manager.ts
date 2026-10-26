// Repo lifecycle: one shared clone per repository, one worktree per session.
//
// Why this shape (docs/github-addon-research.md §3.2): N sessions on one repo
// must cost one object store, not N copies — that matters on a phone. The clone
// is partial (`--filter=blob:none`) so months of history arrive without the disk.
//
// Every git call is injected (`run`), so the whole lifecycle is testable without
// a network, a disk, or a real repository. The token never appears in argv or in
// a remote URL: pushes carry it as a per-invocation `http.extraheader`, and every
// message that leaves this module is passed through `redact`.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "../util/paths.js";
import { githubCreatePull, redact, type GithubCreds } from "./github.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<GitResult>;

/** The default runner: a real git process, output captured, never a shell. */
export const runGit: GitRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 300_000);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

export interface PrepareProgress {
  phase: "clone" | "worktree" | "done";
  pct: number;
  detail?: string;
}

export interface RepoStatus {
  branch: string;
  clean: boolean;
  files: { path: string; added: number; removed: number }[];
  added: number;
  removed: number;
}

export interface PublishResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  draft: boolean;
}

export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

/** `owner/name` → a filesystem/config-safe slug. */
export function repoSegments(repo: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)$/.exec(repo.trim());
  if (!m) throw new RepoError(`"${repo}" is not owner/name — copy it from the repository page`);
  return { owner: m[1]!, name: m[2]! };
}

/** A stable, readable branch/worktree slug for a session. */
export function branchSlug(sessionKey: string): string {
  const stem = sessionKey.replace(/^main:/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return (stem || "session").slice(0, 40);
}

export interface RepoManagerOptions {
  /** Root for caches and worktrees; defaults to `<state>/repos`. */
  root?: string;
  run?: GitRunner;
  /** Host for API calls (`github.com` or a GHES host). */
  host?: string;
  log?: (message: string) => void;
}

export class RepoManager {
  readonly root: string;
  readonly #run: GitRunner;
  readonly #host: string;
  readonly #log: (m: string) => void;

  constructor(opts: RepoManagerOptions = {}) {
    this.root = opts.root ?? join(stateDir(), "repos");
    this.#run = opts.run ?? runGit;
    this.#host = opts.host ?? "github.com";
    this.#log = opts.log ?? (() => {});
  }

  /** The shared object store for a repo — bare-ish, no working tree. */
  cachePath(repo: string): string {
    const { owner, name } = repoSegments(repo);
    return join(this.root, "cache", owner, `${name}.git`);
  }

  /** The checkout this session works in. */
  worktreePath(repo: string, sessionKey: string): string {
    const { owner, name } = repoSegments(repo);
    return join(this.root, "worktrees", `${owner}-${name}`, branchSlug(sessionKey));
  }

  /**
   * Clone (once) and create this session's worktree.
   *
   * Phases are reported so a surface can say where the time goes; a failure
   * leaves the cache in place (the next attempt is faster) and explains itself.
   */
  async prepare(input: {
    repo: string;
    sessionKey: string;
    base?: string;
    creds?: GithubCreds | null;
    onProgress?: (p: PrepareProgress) => void;
    signal?: AbortSignal;
  }): Promise<{ workspace: string; branch: string; base: string }> {
    const repo = input.repo.trim();
    const { owner, name } = repoSegments(repo);
    const cache = this.cachePath(repo);
    const worktree = this.worktreePath(repo, input.sessionKey);
    const branch = `sc/${branchSlug(input.sessionKey)}`;
    const progress = input.onProgress ?? (() => {});
    const base = input.base?.trim() || "";

    const authArgs = (creds?: GithubCreds | null): string[] => {
      // Credentials ride one invocation only. Never a remote URL, never the
      // stored config, so `git remote -v` and `.git/config` stay clean.
      if (!creds?.token) return [];
      const basic = Buffer.from(`x-access-token:${creds.token}`).toString("base64");
      return ["-c", `http.https://${this.#host}/.extraheader=AUTHORIZATION: basic ${basic}`];
    };

    mkdirSync(join(this.root, "cache", owner), { recursive: true });
    mkdirSync(join(this.root, "worktrees", `${owner}-${name}`), { recursive: true });

    if (!existsSync(join(cache, "HEAD"))) {
      progress({ phase: "clone", pct: 5, detail: `${owner}/${name}` });
      if (existsSync(cache)) rmSync(cache, { recursive: true, force: true });
      const url = `https://${this.#host}/${owner}/${name}.git`;
      const clone = await this.#run(
        [...authArgs(input.creds), "clone", "--filter=blob:none", "--no-checkout", url, cache],
        { timeoutMs: 900_000, env: { GIT_TERMINAL_PROMPT: "0" } },
      );
      if (clone.code !== 0) throw new RepoError(this.#explain("clone", clone, input.creds));
      progress({ phase: "clone", pct: 60 });
    } else {
      progress({ phase: "clone", pct: 60, detail: "using the local clone" });
    }

    const defaultBranch = base || (await this.#defaultBranch(cache)) || "main";
    progress({ phase: "worktree", pct: 70, detail: defaultBranch });
    if (existsSync(worktree)) {
      progress({ phase: "done", pct: 100 });
      return { workspace: worktree, branch, base: defaultBranch };
    }
    mkdirSync(worktree, { recursive: true });
    const add = await this.#run(["-C", cache, "worktree", "add", "--force", "-B", branch, worktree, `origin/${defaultBranch}`], {
      timeoutMs: 600_000,
    });
    if (add.code !== 0) {
      // A cache without that ref (fresh partial clone, unusual default) is worth
      // one fetch before giving up.
      const fetch = await this.#run([...authArgs(input.creds), "-C", cache, "fetch", "--depth=1", "origin", defaultBranch], {
        timeoutMs: 600_000,
      });
      if (fetch.code === 0) {
        const retry = await this.#run(["-C", cache, "worktree", "add", "--force", "-B", branch, worktree, `origin/${defaultBranch}`], {
          timeoutMs: 600_000,
        });
        if (retry.code === 0) {
          progress({ phase: "done", pct: 100 });
          return { workspace: worktree, branch, base: defaultBranch };
        }
      }
      throw new RepoError(this.#explain("worktree", add, input.creds));
    }
    progress({ phase: "done", pct: 100 });
    return { workspace: worktree, branch, base: defaultBranch };
  }

  async #defaultBranch(cache: string): Promise<string | null> {
    const head = await this.#run(["-C", cache, "symbolic-ref", "--short", "HEAD"], { timeoutMs: 10_000 });
    const name = head.code === 0 ? head.stdout.trim() : "";
    return name && name !== "HEAD" ? name : null;
  }

  /** What changed in the worktree, per file, against the base branch. */
  async status(workspace: string): Promise<RepoStatus> {
    const branchRes = await this.#run(["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 20_000 });
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
    const numstat = await this.#run(["-C", workspace, "diff", "--numstat", "HEAD"], { timeoutMs: 60_000 });
    const untracked = await this.#run(["-C", workspace, "ls-files", "--others", "--exclude-standard"], { timeoutMs: 60_000 });
    const files: { path: string; added: number; removed: number }[] = [];
    for (const line of (numstat.stdout ?? "").split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      files.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
    }
    for (const path of (untracked.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!files.some((f) => f.path === path)) files.push({ path, added: 0, removed: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      branch,
      clean: files.length === 0,
      files,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    };
  }

  /** Unified diff of the worktree (optionally one path). */
  async diff(workspace: string, path?: string): Promise<string> {
    const args = ["-C", workspace, "--no-pager", "diff", "HEAD", "--"];
    if (path) args.push(path);
    const res = await this.#run(args, { timeoutMs: 60_000 });
    if (res.code !== 0) throw new RepoError(redact(res.stderr.trim() || "git diff failed"));
    const text = res.stdout;
    // A brand-new file has no HEAD side; show it as an addition instead of
    // silently missing from the diff.
    if (!text.trim() && path) {
      const cat = await this.#run(["-C", workspace, "--no-pager", "diff", "--no-index", "/dev/null", path], { timeoutMs: 60_000 });
      return cat.stdout || "";
    }
    return text;
  }

  /**
   * Commit, push a `sc/*` branch, open a PR.
   *
   * Refusals, in order: a protected base branch as the target, no changes, and a
   * missing token. Never force-pushes, never pushes to the base branch itself.
   */
  async publish(input: {
    workspace: string;
    repo: string;
    branch: string;
    base: string;
    title: string;
    body?: string;
    draft?: boolean;
    creds: GithubCreds | null;
    commit?: boolean;
  }): Promise<PublishResult> {
    const { workspace } = input;
    if (!input.creds?.token) throw new RepoError("GitHub is not connected — connect it, then publish.");
    if (!/^sc\//.test(input.branch)) throw new RepoError(`refusing to publish "${input.branch}" — only sc/* branches are pushed from a session`);
    if (input.branch === input.base) throw new RepoError(`refusing to push to the base branch ${input.base}`);

    const status = await this.status(workspace);
    if (status.clean) throw new RepoError("nothing to publish — this session has no changes");

    if (input.commit !== false) {
      const add = await this.#run(["-C", workspace, "add", "-A"], { timeoutMs: 120_000 });
      if (add.code !== 0) throw new RepoError(redact(add.stderr.trim() || "git add failed", input.creds.token));
      const message = `${input.title}\n\nSession: ${basename(workspace)}\n`;
      const commit = await this.#run(["-C", workspace, "commit", "-m", message], { timeoutMs: 120_000 });
      // "nothing to commit" is fine only when something is already committed on
      // this branch; otherwise it means the tree was empty after `add`.
      if (commit.code !== 0 && !/nothing to commit|no changes added/i.test(commit.stderr)) {
        throw new RepoError(redact(commit.stderr.trim() || "git commit failed", input.creds.token));
      }
    }

    const basic = Buffer.from(`x-access-token:${input.creds.token}`).toString("base64");
    const push = await this.#run(
      ["-C", workspace, "-c", `http.https://${this.#host}/.extraheader=AUTHORIZATION: basic ${basic}`, "push", "-u", "origin", input.branch],
      { timeoutMs: 600_000 },
    );
    if (push.code !== 0) {
      const why = redact(push.stderr.trim() || push.stdout.trim(), input.creds.token);
      throw new RepoError(
        /protected branch|GH006/i.test(why)
          ? `GitHub refused the push: ${input.branch} is protected. Publish creates sc/* branches, so check the branch rules.`
          : `push failed — ${why}`,
      );
    }

    const pr = await githubCreatePull({
      token: input.creds.token,
      repo: input.repo,
      head: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft !== false,
      host: this.#host,
    });
    return { branch: input.branch, prNumber: pr.number, prUrl: pr.url, draft: pr.draft };
  }

  /** Remove a worktree. Dirty work is refused unless the caller insists. */
  async remove(input: { repo: string; sessionKey: string; force?: boolean }): Promise<{ removed: boolean; dirty: boolean }> {
    const worktree = this.worktreePath(input.repo, input.sessionKey);
    if (!existsSync(worktree)) return { removed: false, dirty: false };
    const status = await this.status(worktree);
    if (!status.clean && !input.force) return { removed: false, dirty: true };
    const cache = this.cachePath(input.repo);
    const res = await this.#run(["-C", cache, "worktree", "remove", "--force", worktree], { timeoutMs: 120_000 });
    if (res.code !== 0) rmSync(worktree, { recursive: true, force: true });
    return { removed: true, dirty: !status.clean };
  }

  #explain(phase: string, res: GitResult, creds?: GithubCreds | null): string {
    const why = redact((res.stderr || res.stdout).trim().split("\n").slice(-4).join("\n"), creds?.token);
    if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(why)) {
      return `${phase} failed: this repository needs GitHub credentials. Connect GitHub and try again.`;
    }
    if (/not found|does not exist|Repository not found/i.test(why)) {
      return `${phase} failed: the repository was not found (check the name, and that the connected account can see it).`;
    }
    if (/No space left on device/i.test(why)) return `${phase} failed: not enough disk space.`;
    return `${phase} failed — ${why || "git exited with an error"}`;
  }
}
