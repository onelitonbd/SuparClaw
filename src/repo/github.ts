// GitHub add-on — credentials, identity, repo list, pull requests (Task 35).
//
// Three ways in, in this order (docs/github-addon-research.md §2):
//   1. `GITHUB_TOKEN` / `GH_TOKEN` in the environment — CI and power users;
//   2. an existing `gh auth token` login — zero setup for anyone who codes;
//   3. a token we obtained ourselves (device flow) and stored with 0600.
//
// Two rules this module exists to enforce:
//   * the token is never written into a config file, a remote URL or `.git/config`
//     — it reaches `git` as a per-invocation header (see manager.ts) and never
//     appears in an error string we return (`redact`);
//   * nothing here throws a raw HTTP body at the user: failures carry what
//     happened and what to do next.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deviceLogin } from "../agent/oauth-device.js";
import { stateDir } from "../util/paths.js";

export interface GithubCreds {
  token: string;
  login: string;
  source: "env" | "gh" | "token";
  host: string;
  scopes?: string[];
  savedAt?: number;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: number;
  description?: string;
}

/** Where a self-obtained token is kept. Never inside the config file. */
export function githubCredsPath(): string {
  return join(stateDir(), "github.json");
}

/** Strip anything token-shaped from a string we are about to show or log. */
export function redact(text: string, token?: string): string {
  let out = text;
  if (token && token.length > 8) out = out.split(token).join("***");
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***")
    .replace(/(https?:\/\/)([^@\s/]+)@/g, "$1***@");
}

export function readStoredGithub(): GithubCreds | null {
  const path = githubCredsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GithubCreds>;
    if (typeof raw.token !== "string" || raw.token.length < 8) return null;
    return {
      token: raw.token,
      login: typeof raw.login === "string" ? raw.login : "",
      source: "token",
      host: typeof raw.host === "string" && raw.host ? raw.host : "github.com",
      scopes: Array.isArray(raw.scopes) ? raw.scopes.map(String) : [],
      savedAt: Number(raw.savedAt ?? 0),
    };
  } catch {
    return null;
  }
}

export function saveGithubCreds(creds: Omit<GithubCreds, "source">): GithubCreds {
  const path = githubCredsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ token: creds.token, login: creds.login, host: creds.host, scopes: creds.scopes ?? [], savedAt: Date.now() }, null, 2),
    { mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that ignore modes */
  }
  return { ...creds, source: "token" };
}

export function clearGithubCreds(): boolean {
  const path = githubCredsPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** `gh auth token`, when the CLI is installed and logged in. Never throws. */
export function ghCliToken(): string | null {
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    const token = out.trim();
    return token.length > 8 ? token : null;
  } catch {
    return null;
  }
}

/** `gh` missing entirely (so the UI can say "install gh" instead of "failed"). */
export function ghCliAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the token without touching the network.
 * `env` first so CI can override a stale stored login, `gh` second so a
 * developer's existing login just works, the stored token last.
 */
export function resolveGithubCreds(opts: { host?: string } = {}): GithubCreds | null {
  const host = opts.host || "github.com";
  const env = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "";
  if (env.trim().length > 8) return { token: env.trim(), login: "", source: "env", host };
  const gh = ghCliToken();
  if (gh) return { token: gh, login: "", source: "gh", host };
  const stored = readStoredGithub();
  return stored ? { ...stored, host } : null;
}

/** API base for a host: github.com is api.github.com, GHES is /api/v3. */
export function githubApiBase(host = "github.com"): string {
  return host === "github.com" || host === "" ? "https://api.github.com" : `https://${host}/api/v3`;
}

type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface GithubRequestOptions {
  host?: string;
  method?: string;
  body?: unknown;
  token: string;
  fetchFn?: FetchLike;
}

/** One API call. Returns parsed JSON or throws a sentence a human can act on. */
export async function githubRequest<T = unknown>(path: string, opts: GithubRequestOptions): Promise<T> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  const url = path.startsWith("http") ? path : `${githubApiBase(opts.host)}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "suparclaw",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (err) {
    throw new Error(`GitHub is unreachable (${redact((err as Error).message, opts.token)})`);
  }
  const text = await res.text();
  if (res.ok) {
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }
  const hint =
    res.status === 401
      ? "the token is invalid or expired — reconnect GitHub"
      : res.status === 403
        ? "GitHub refused this (rate limit or missing scope)"
        : res.status === 404
          ? "not found, or this token cannot see it"
          : res.status === 422
            ? "GitHub rejected the payload"
            : `HTTP ${res.status}`;
  let detail = "";
  try {
    const body = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
    detail = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join(" · ");
  } catch {
    detail = text.slice(0, 200);
  }
  throw new Error(`GitHub: ${hint}${detail ? ` — ${redact(detail, opts.token)}` : ""}`);
}

export interface GithubIdentity {
  login: string;
  name?: string;
  avatarUrl?: string;
  scopes: string[];
}

/** Who the token belongs to. Scopes come from the response header when present. */
export async function githubIdentity(token: string, opts: { host?: string; fetchFn?: FetchLike } = {}): Promise<GithubIdentity> {
  const me = await githubRequest<{ login?: string; name?: string; avatar_url?: string }>("/user", { token, host: opts.host, fetchFn: opts.fetchFn });
  const full = await githubRequestRaw("/user", { token, host: opts.host, fetchFn: opts.fetchFn });
  const scopes = (full.headers?.["x-oauth-scopes"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { login: String(me.login ?? ""), name: me.name, avatarUrl: me.avatar_url, scopes };
}

async function githubRequestRaw(path: string, opts: GithubRequestOptions): Promise<{ headers: Record<string, string>; status: number }> {
  const fetchFn = (opts.fetchFn ?? (fetch as unknown as FetchLike)) as unknown as (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; headers?: { get?(k: string): string | null } }>;
  try {
    const res = await fetchFn(`${githubApiBase(opts.host)}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json", "User-Agent": "suparclaw" },
    });
    const scopes = res.headers?.get?.("x-oauth-scopes") ?? "";
    return { headers: { "x-oauth-scopes": scopes }, status: res.status };
  } catch {
    return { headers: {}, status: 0 };
  }
}

/** Repositories the token can see, newest push first. Private included. */
export async function githubListRepos(
  token: string,
  opts: { host?: string; filter?: string; page?: number; perPage?: number; fetchFn?: FetchLike } = {},
): Promise<GithubRepo[]> {
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const filter = (opts.filter ?? "").trim();
  const path = filter
    ? `/search/repositories?q=${encodeURIComponent(`${filter} in:name`)}&sort=updated&per_page=${perPage}&page=${page}`
    : `/user/repos?sort=pushed&direction=desc&per_page=${perPage}&page=${page}`;
  const raw = await githubRequest<{ items?: unknown[] } | unknown[]>(path, { token, host: opts.host, fetchFn: opts.fetchFn });
  const rows = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? []);
  return rows
    .map((r) => r as { full_name?: string; private?: boolean; default_branch?: string; pushed_at?: string; description?: string })
    .filter((r) => typeof r.full_name === "string")
    .map((r) => ({
      fullName: String(r.full_name),
      private: r.private === true,
      defaultBranch: String(r.default_branch ?? "main"),
      pushedAt: Date.parse(String(r.pushed_at ?? "")) || 0,
      description: r.description,
    }));
}

export interface CreatePrOptions {
  token: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  host?: string;
  fetchFn?: FetchLike;
}

/** Open a pull request. The only place anything is published via the API. */
export async function githubCreatePull(
  opts: CreatePrOptions,
): Promise<{ number: number; url: string; draft: boolean }> {
  const res = await githubRequest<{ number?: number; html_url?: string; draft?: boolean }>(`/repos/${opts.repo}/pulls`, {
    token: opts.token,
    host: opts.host,
    fetchFn: opts.fetchFn,
    method: "POST",
    body: { title: opts.title, head: opts.head, base: opts.base, body: opts.body ?? "", draft: opts.draft !== false },
  });
  return { number: Number(res.number ?? 0), url: String(res.html_url ?? ""), draft: res.draft === true };
}

export interface ConnectResult {
  creds: GithubCreds;
  identity: GithubIdentity;
}

/**
 * Connect via GitHub's device flow (RFC 8628 — the same engine our model
 * providers use). `onCode` fires before polling so any surface can show the
 * code immediately.
 */
export async function connectGithub(opts: {
  clientId: string;
  host?: string;
  scope?: string;
  onCode?: (info: { userCode: string; verificationUri: string; expiresIn: number; interval: number }) => void;
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ConnectResult> {
  const host = opts.host || "github.com";
  if (!opts.clientId.trim()) {
    throw new Error(
      "No GitHub OAuth client id is configured. Either log in with the `gh` CLI (which needs no setup), " +
        "or set addons.github.clientId to your own GitHub OAuth app's id.",
    );
  }
  const token = await deviceLogin({
    descriptor: {
      deviceCodeUrl: `https://${host}/login/device/code`,
      tokenUrl: `https://${host}/login/oauth/access_token`,
      clientId: opts.clientId,
      scope: opts.scope ?? "repo read:user",
    },
    fetchFn: opts.fetchFn as never,
    sleep: opts.sleep,
    onCode: (auth) =>
      opts.onCode?.({ userCode: auth.user_code, verificationUri: auth.verification_uri, expiresIn: auth.expires_in, interval: auth.interval }),
  });
  const identity = await githubIdentity(token.access_token, { host, fetchFn: opts.fetchFn });
  const creds = saveGithubCreds({ token: token.access_token, login: identity.login, host, scopes: identity.scopes });
  return { creds, identity };
}
