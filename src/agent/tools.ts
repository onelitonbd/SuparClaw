import { readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, statSync, renameSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname, extname, sep } from "node:path";
import { gitHead, gitIsFile, gitCommonDir, type GitHead } from "../util/git-head.js";
import type { SuparClawConfig } from "../config/schema.js";
import type { Store, JobRow } from "../state/db.js";
import type { Logger } from "../util/log.js";
import { todayStamp } from "./workspace.js";
import { searchMemoryFiles, rankTranscriptHits } from "./memory-search.js";
import { discoverSkills, readSkillBody, skillsCatalog, writeSkill, type SkillMeta } from "./skills.js";
import { codeModeEngages, CodeMode, codeModeSurface, type CodeModeConfig, type GuestTool } from "./code-mode.js";
import { describeDelivery, resolveAnnounceTarget, NO_SURFACES, type SurfaceFacts } from "./surfaces.js";
import { describeSettings, type SettingsCtl } from "./self.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

import { explainExecError, type ExecVerdict } from "./exec-policy.js";
import type { WebSearchCache } from "./web-search.js";

export interface ToolContext {
  workspace: string;
  stateDir: string;
  skills: SkillMeta[];
  store: Store;
  log: Logger;
  config: SuparClawConfig;
  approved: boolean;
  /** exec-policy verdict attached to this call (allowlist/direct route info). */
  execVerdict?: ExecVerdict;
  signal?: AbortSignal;
  /** Re-discover skills after a tool writes one (`skill_save`). */
  refreshSkills?: () => void;
  /** Session this tool call belongs to (set by the agent loop). */
  sessionKey?: string;
  /** One-shot text completion bound to the run's client (P3 #22 pdf analysis). */
  llmText?: (messages: { role: "system" | "user"; content: string }[], opts?: { model?: string; timeoutMs?: number }) => Promise<string>;
  /** Set by sessions_yield when this turn should end waiting for children. */
  yieldArmed?: boolean;
  /** Re-arm scheduled jobs after a cron tool changed the store (the service
   *  wires this to its scheduler; without it a new job waits for a restart). */
  cronChanged?: () => void | Promise<void>;
  /** Channel facts for this turn: what a delivery target can actually reach. */
  surfaces?: SurfaceFacts;
  /**
   * Settings surface (Task 26): read/change the live configuration. Undefined on
   * sub-agent runs — a child must not rewrite global settings mid-flight.
   */
  settings?: SettingsCtl;
  /** The model this run is using (profile id). A spawned child inherits it when
   *  neither the tool argument nor agents.defaults.subagents.model names one. */
  model?: string;
  /** The thinking level this run resolved, for the same inheritance rule. */
  thinking?: string;
  /** Sub-agent control surface, wired by the service (spawn/yield/list/send). */
  subagents?: SubagentCtl;
  /**
   * ask_user surface (P2 #8): present on MAIN sessions only (their rule);
   * asking elsewhere must fail honestly, so the tool checks for undefined.
   */
  askUser?: (questions: import("./ask-user.js").AskUserQuestion[]) => Promise<import("./ask-user.js").AskUserResult>;
  /** Task 35: the repository this run is bound to, when it is a code session. */
  repo?: { repo: string; base: string; branch: string; workspace: string } | null;
  /** Task 35: this turn's text asked for a PR (set by the surface, not the model). */
  publishAllowed?: boolean;
  /** Repo operations wired by the service (publish/status/diff). */
  repoCtl?: RepoCtl;
}

/** The repo operations a code session exposes to the agent (Task 35). */
export interface RepoCtl {
  status(sessionKey: string): Promise<{ repo: string; branch: string; base: string; clean: boolean; files: { path: string; added: number; removed: number }[]; added: number; removed: number }>;
  diff(sessionKey: string, path?: string): Promise<string>;
  publish(input: { sessionKey: string; title: string; body?: string; draft?: boolean }): Promise<{ url: string; number: number; branch: string; draft: boolean }>;
}

/** The sub-agent operations the session family of tools can invoke. */
export interface SubagentCtl {
  spawn(
    parentKey: string,
    opts: {
      task: string;
      label?: string;
      taskName?: string;
      model?: string;
      thinking?: string;
      context?: "isolated" | "fork";
      /** What the requesting run uses; the last fallback before the config defaults. */
      callerModel?: string;
      callerThinking?: string;
    },
  ): Promise<
    | { accepted: true; childSessionKey: string; runId: string; taskName: string; context: string; resolvedModel?: string }
    | { accepted: false; error: string }
  >;
  /** Children still running for a parent. */
  activeChildren(parentKey: string): { childSessionKey: string; label: string; task: string; status: string; runId: string }[];
  /** Send input to another session (steer into it or queue a followup). */
  send(targetKey: string, text: string, mode: "steer" | "followup" | "notify"): Promise<{ ok: boolean; error?: string; detail?: string }>;
  /** Abort a child's active run (and queued work) by session key. */
  cancel(childSessionKey: string): boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  needsApproval?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

/** Workspace-scoped path resolution: refuses to escape the workspace. */
export function safePath(workspace: string, p: string): string {
  const abs = resolve(workspace, p.replace(/^~\//, ""));
  const rel = relative(workspace, abs);
  if (rel.startsWith("..") || rel.startsWith("/") || resolve(abs) !== abs) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

const MAX_READ = 60_000;

/* ---------------- reading through a `.git` that is a file (Task 39) -------------
 * Every code session works in a linked git worktree, where `.git` is a one-line
 * file (`gitdir: …`). "Which branch am I on?" is then a read of `.git/HEAD`,
 * which used to answer `ENOTDIR: not a directory` — a Node error the model can
 * do nothing with. The pointer is followed for *checkout metadata only*: HEAD,
 * refs/** and packed-refs. `config` (it can hold credentials), `hooks/`,
 * `objects/` and `logs/` stay out of the sandbox.
 */

/** The git root a workspace-relative path is talking about, when its path
 *  crosses a `.git` that is a file. `null` for ordinary paths and for a clone
 *  whose `.git` is a real directory (that reads normally). */
function gitFileRoot(workspace: string, file: string): { root: string; sub: string; head: GitHead } | null {
  const segs = relative(workspace, file).split(sep);
  const at = segs.indexOf(".git");
  if (at < 0) return null;
  const root = join(workspace, ...segs.slice(0, at));
  if (!gitIsFile(root)) return null;
  const sub = segs.slice(at + 1).join("/");
  const head = gitHead(root);
  return head ? { root, sub, head } : null;
}

/** What a `.git` pointer file can and cannot answer, with the branch already
 *  filled in so the model gets its answer in the same breath. */
function gitPointerNotice(head: GitHead): string {
  const branch = head.ref ?? `detached at ${head.sha ?? "an unknown commit"}`;
  return [
    `.git is a file here — this is a linked git worktree (gitdir: ${head.gitDir}).`,
    `The checkout is on ${branch}.`,
    "Readable through it: .git/HEAD, .git/refs/**, .git/packed-refs. Everything else in .git (config, hooks, objects, logs) is outside the workspace sandbox.",
  ].join("\n");
}

/** Read one of the allowed metadata files, or explain why not. `null` means
 *  "not a git-metadata path — carry on with a normal read". */
function readGitMetadata(workspace: string, file: string): string | null {
  const hit = gitFileRoot(workspace, file);
  if (!hit) return null;
  const { sub, head } = hit;
  if (!sub) return gitPointerNotice(head);
  const common = gitCommonDir(head.gitDir);
  const inGit = (dir: string, name: string): string | null => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return null;
    }
  };
  if (sub === "HEAD") return `${head.text}\n`;
  if (sub === "packed-refs") return inGit(common, "packed-refs") ?? inGit(head.gitDir, "packed-refs") ?? "(no packed refs — every ref is a loose file)";
  if (sub.startsWith("refs/")) {
    const text = inGit(head.gitDir, sub) ?? inGit(common, sub);
    return text ?? `error: no such ref: ${sub.replace(/^refs\/heads\//, "").replace(/^refs\//, "")}`;
  }
  return `error: ${gitPointerNotice(head)}`;
}

// ---- cron tool helpers -----------------------------------------------------

/** Same id derivation as `sc cron add` and the gateway's cron.upsert. */
const cronIdOf = (name: string): string => name.replace(/\W+/g, "-").toLowerCase();

/** croner parse + next run. Throws on an invalid expression or timezone. */
async function cronNext(schedule: string, tz: string | null): Promise<Date | null> {
  const { Cron } = await import("croner");
  return new Cron(schedule, { paused: true, timezone: tz ?? undefined }).nextRun() ?? null;
}

/** "schedule: … (zone) · next … · enabled" — the line every cron reply carries. */
function cronWhen(job: Pick<JobRow, "schedule" | "tz" | "enabled">, next: Date | null, bad = false): string {
  const zone = job.tz ? ` (${job.tz})` : " (cron.timezone)";
  const when = bad ? "invalid schedule" : next ? `next ${next.toISOString()}` : "no next run";
  return `schedule: ${job.schedule}${zone} · ${when} · ${job.enabled ? "enabled" : "paused"}`;
}

/** "announce → telegram:123 via @bot" | "cron.delivery default". */
function cronDelivery(job: Pick<JobRow, "delivery_mode" | "delivery_to">, ctx: ToolContext): string {
  if (!job.delivery_mode) return "cron.delivery default";
  if (!job.delivery_to) return job.delivery_mode;
  return describeDelivery(job, factsOf(ctx));
}

/** Channel facts for this turn (config-only when no service is wired). */
const factsOf = (ctx: ToolContext): SurfaceFacts => ctx.surfaces ?? NO_SURFACES;

/** Resolve a requested target against the live surfaces; "" means "this chat". */
function targetOf(ctx: ToolContext, to: string, mode: string | null): { target: string; note?: string; error?: string } {
  if (mode !== "announce") return { target: to };
  return resolveAnnounceTarget(to, ctx.sessionKey ?? "", factsOf(ctx));
}

/** The 30-minute cap (Task 38) and the floor below which a timeout is a typo. */
export const EXEC_TIMEOUT_MAX_MS = 1_800_000;
export const EXEC_TIMEOUT_MIN_MS = 100;

/**
 * Turn whatever the model put in `timeoutMs` into a number `execFile` accepts.
 *
 * `Number("5s")` is NaN and Node's execFile throws ERR_OUT_OF_RANGE on NaN —
 * synchronously, before any child exists — so one bad argument used to make
 * every exec call fail with a stack trace instead of a command result. Junk
 * now falls back to the configured cap; anything else is clamped, and the note
 * tells the model what actually applied.
 */
export function resolveExecTimeout(
  requested: unknown,
  configured: unknown,
): { ms: number; note: string | null } {
  const configuredMs =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? Math.min(Math.round(configured), EXEC_TIMEOUT_MAX_MS)
      : EXEC_TIMEOUT_MAX_MS;
  const raw =
    typeof requested === "number"
      ? requested
      : typeof requested === "string" && requested.trim() !== ""
        ? Number(requested)
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      ms: configuredMs,
      note:
        requested === undefined || requested === null
          ? null
          : `[timeout: ${JSON.stringify(requested)} is not a positive number of milliseconds — using ${configuredMs} ms]`,
    };
  }
  const ms = Math.min(Math.max(Math.round(raw), EXEC_TIMEOUT_MIN_MS), EXEC_TIMEOUT_MAX_MS);
  return {
    ms,
    note:
      ms === Math.round(raw)
        ? null
        : raw > EXEC_TIMEOUT_MAX_MS
          ? `[timeout: ${Math.round(raw)} ms requested — capped at ${EXEC_TIMEOUT_MAX_MS} ms]`
          : `[timeout: ${Math.round(raw)} ms requested — raised to the ${EXEC_TIMEOUT_MIN_MS} ms floor]`,
  };
}

/** Termux bash first, then ordinary shells — exec must work off-phone too. */
function findShell(): string {
  const candidates = [
    process.env["PREFIX"] ? `${process.env["PREFIX"]}/bin/bash` : "",
    "/data/data/com.termux/files/usr/bin/bash",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return "/bin/sh";
}

// Shared across registry rebuilds (config hot-reload) so the query cache survives.
let searchCache: WebSearchCache | null = null;
let searchCacheTtl = -1;

export function buildRegistry(config: SuparClawConfig): ToolSpec[] {
  const tools: ToolSpec[] = [];

  if (config.tools.fs) {
    tools.push(
      {
        name: "fs_read",
        description: "Read a UTF-8 text file from the workspace. Paths are workspace-relative. `.git/HEAD` works here even though a code session's `.git` is a file (a linked worktree) — it is the quickest way to see the current branch.",
        parameters: {
          type: "object",
          properties: { path: str("Workspace-relative file path"), offset: int("1-based first line"), limit: int("Max lines to read (default 400)") },
          required: ["path"],
        },
        async run(args, ctx) {
          const file = safePath(ctx.workspace, String(args["path"]));
          // `.git/HEAD` in a worktree (Task 39), or a refusal that says why.
          const git = readGitMetadata(ctx.workspace, file);
          if (git !== null) return git;
          let text = readFileSync(file, "utf8");
          const offset = Number(args["offset"] ?? 1);
          const limit = Number(args["limit"] ?? 400);
          if (offset > 1 || limit !== 400) {
            text = text.split("\n").slice(offset - 1, offset - 1 + limit).join("\n");
          }
          if (text.length > MAX_READ) {
            text = text.slice(0, MAX_READ) + `\n\n[truncated at ${MAX_READ} chars — use offset/limit to continue]`;
          }
          return text;
        },
      },
      {
        name: "fs_write",
        description: "Create or overwrite a workspace file. Creates parent directories.",
        parameters: {
          type: "object",
          properties: { path: str("Workspace-relative file path"), content: str("Full file content") },
          required: ["path", "content"],
        },
        async run(args, ctx) {
          const file = safePath(ctx.workspace, String(args["path"]));
          if (gitFileRoot(ctx.workspace, file)) return "error: git owns .git — change the checkout with git, not by writing into its metadata";
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, String(args["content"]), "utf8");
          return `wrote ${args["path"]} (${String(args["content"]).length} chars)`;
        },
      },
      {
        name: "fs_edit",
        description: "Replace an exact string in a workspace file. Fails if the string is not found or ambiguous.",
        parameters: {
          type: "object",
          properties: { path: str("Workspace-relative file path"), old: str("Exact text to replace"), new: str("Replacement text") },
          required: ["path", "old", "new"],
        },
        async run(args, ctx) {
          const file = safePath(ctx.workspace, String(args["path"]));
          if (gitFileRoot(ctx.workspace, file)) return "error: git owns .git — change the checkout with git, not by editing its metadata";
          const old = String(args["old"]);
          const next = String(args["new"]);
          const text = readFileSync(file, "utf8");
          const first = text.indexOf(old);
          if (first === -1) return "error: old string not found";
          if (text.indexOf(old, first + 1) !== -1) return "error: old string appears more than once — add more context";
          writeFileSync(file + ".tmp", text.slice(0, first) + next + text.slice(first + old.length), "utf8");
          renameSync(file + ".tmp", file);
          return `edited ${args["path"]}`;
        },
      },
      {
        name: "fs_list",
        description: "List files in the workspace.",
        parameters: {
          type: "object",
          properties: { path: str("Workspace-relative directory (default '.')"), depth: int("Recursion depth, default 2") },
        },
        async run(args, ctx) {
          const root = safePath(ctx.workspace, String(args["path"] ?? "."));
          // A `.git` pointer file (worktree) has nothing to list — say what it is.
          const asGit = gitFileRoot(ctx.workspace, root);
          if (asGit && !asGit.sub) return gitPointerNotice(asGit.head);
          const depth = Number(args["depth"] ?? 2);
          const out: string[] = [];
          const walk = (dir: string, level: number) => {
            if (level > depth) return;
            let entries: string[] = [];
            try {
              entries = readdirSync(dir);
            } catch {
              return;
            }
            for (const e of entries) {
              if (e.startsWith(".")) continue;
              const full = join(dir, e);
              let dirent: ReturnType<typeof statSync> | null = null;
              try {
                dirent = statSync(full);
              } catch {
                continue;
              }
              if (dirent.isDirectory()) {
                out.push(`${relative(ctx.workspace, full)}/`);
                walk(full, level + 1);
              } else {
                out.push(`${relative(ctx.workspace, full)} (${dirent.size}b)`);
              }
            }
          };
          walk(root, 0);
          return out.length > 0 ? out.join("\n") : "(empty)";
        },
      },
    );
  }

  if (config.tools.memory) {
    tools.push(
      {
        name: "memory_append",
        description: `Append a note to today's daily memory file (memory/${todayStamp()}.md). Optional write-time importance 1-10 (their annotation format) is scored once here and later multiplies search relevance.`,
        parameters: {
          type: "object",
          properties: {
            note: str("Markdown note to append"),
            importance: int("Optional 1-10 write-time importance (durable facts ~9, trivia ~2)"),
          },
          required: ["note"],
        },
        async run(args, ctx) {
          const stamp = todayStamp();
          mkdirSync(join(ctx.workspace, "memory"), { recursive: true });
          const note = String(args["note"]).replace(/\n/g, " ");
          // Write-time importance is theirs: 1-10 integer or neutral-absent.
          // Garbage input degrades to neutral instead of failing the save.
          const rawImp = args["importance"];
          const parsed = rawImp === undefined ? Number.NaN : Math.trunc(Number(rawImp));
          const imp = Number.isFinite(parsed) && parsed >= 1 ? Math.min(10, parsed) : null;
          const tag = imp === null ? "" : ` <!-- importance: ${imp} -->`;
          appendFileSync(join(ctx.workspace, "memory", `${stamp}.md`), `\n- ${note}${tag}\n`, "utf8");
          return `noted in memory/${stamp}.md`;
        },
      },
      {
        name: "memory_search",
        description:
          "Search memory notes (MEMORY.md, USER.md, memory/*.md) and past transcripts across all sessions. Results are ranked by the fixed OpenClaw-style stack: keyword relevance (every query term first, then any-term) × recency decay (30-day half-life, dated daily notes only; MEMORY.md/USER.md are evergreen) × write-time importance (<!-- importance: 1-10 --> annotations), then MMR diversity ordering. Returns scored, dated, source-labelled snippets.",
        parameters: {
          type: "object",
          properties: {
            query: str("Search terms"),
            maxResults: int("Max results (default 6, cap 25). Aliases accepted: max_results, limit."),
          },
          required: ["query"],
        },
        async run(args, ctx) {
          const q = String(args["query"] ?? "").trim();
          if (!q) return "error: empty query";
          // Their alias contract: maxResults > max_results > limit; only the
          // selected value is validated — an invalid higher-priority value is
          // an error, never a silent fall-through to a valid alias.
          const pick = args["maxResults"] ?? args["max_results"] ?? args["limit"];
          let maxResults = 6;
          if (pick !== undefined) {
            const n = Number(pick);
            if (!Number.isFinite(n) || n < 1) return "error: maxResults must be a positive integer";
            maxResults = Math.min(Math.floor(n), 25);
          }

          const memHits = searchMemoryFiles(ctx.workspace, q, { maxResults });
          const rows = ctx.store.searchMessagesAll(q, 50);
          const hits = rankTranscriptHits(
            rows.filter((r) => r.role === "user" || r.role === "assistant"),
            q,
            memHits,
            { maxResults },
          );
          if (hits.length === 0) return "no matches";
          // Recall log: drives the dreaming deep phase's relevance/diversity
          // signals (their recall-trace input). Sources in candidate form.
          ctx.store.recordMemoryRecall(
            q,
            hits.map((h) => (h.source.startsWith("session · ") ? `session:${h.source.split(" · ")[1]}` : h.source)),
          );
          return hits
            .map((h) => `[${h.score.toFixed(2)}${h.date ? ` · ${h.date}` : ""} · ${h.source}] ${h.snippet}`)
            .join("\n\n");
        },
      },
    );
  }

  if (config.tools.web.fetch) {
    tools.push({
      name: "web_fetch",
      description: "Fetch a URL and return readable text (tags/scripts stripped, truncated).",
      parameters: {
        type: "object",
        properties: { url: str("Absolute http(s) URL"), maxChars: int("Max characters to return (default 12000)") },
        required: ["url"],
      },
      async run(args, ctx) {
        const url = String(args["url"]);
        if (!/^https?:\/\//i.test(url)) return "error: only http(s) URLs are allowed";
        const res = await fetch(url, {
          signal: ctx.signal,
          headers: { "user-agent": "SuparClaw/0.1 (+fetch)", accept: "text/html,text/plain,*/*" },
          redirect: "follow",
        });
        if (!res.ok) return `error: HTTP ${res.status}`;
        const raw = (await res.text()).slice(0, 400_000);
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
        const max = Number(args["maxChars"] ?? 12000);
        return text.length > max ? text.slice(0, max) + "\n\n[truncated]" : text;
      },
    });
  }

  if (config.tools.web.search.enabled) {
    tools.push({
      name: "web_search",
      description: "Search the web with the configured provider and return result titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: str("Search query"),
          count: int("Results to return (1-10, default 5)"),
          provider: str("Force a provider for this call (auto-detected otherwise)"),
        },
        required: ["query"],
      },
      async run(args, ctx) {
        const { webSearch, renderSearchText, WebSearchCache } = await import("./web-search.js");
        // One cache per config-service lifetime — tool specs rebuild on reload,
        // so stash it where rebuilds share it.
        if (!searchCache || searchCacheTtl !== config.tools.web.search.cacheTtlMinutes) {
          searchCache = new WebSearchCache(config.tools.web.search.cacheTtlMinutes);
          searchCacheTtl = config.tools.web.search.cacheTtlMinutes;
        }
        const out = await webSearch(config, {
          query: String(args["query"]),
          count: args["count"] != null ? Number(args["count"]) : undefined,
          provider: typeof args["provider"] === "string" && args["provider"].trim() ? String(args["provider"]).trim() : undefined,
          cache: searchCache,
          signal: ctx.signal,
        });
        return renderSearchText(out);
      },
    });
  }

  if (config.tools.media.pdf.enabled !== false) {
    // P3 #22 — their `pdf` tool; extraction lane (our providers are text
    // endpoints, so we ride their non-native fallback entirely). CLI entries
    // with capability "pdf" (tools.media.models) take over for encrypted /
    // font-encoded files — their CLI-entry contract.
    tools.push({
      name: "pdf",
      description:
        "Analyze one or more PDF documents and return text. Uses built-in text extraction; " +
        "pass a prompt to steer the analysis. Page filters work only through configured CLI entries.",
      parameters: {
        type: "object",
        properties: {
          pdf: str("One PDF path or URL"),
          pdfs: { type: "array", items: { type: "string" }, description: "Multiple PDF paths or URLs, up to 10 total" },
          prompt: str("Analysis prompt (default: Analyze this PDF document.)"),
          pages: str("Page filter like 1-5 or 1,3,7-9 (built-in extractor: unsupported)"),
          model: str("Optional model override in provider/model form"),
          maxBytesMb: int("Per-PDF size cap in MB"),
        },
        required: [],
      },
      async run(args, ctx) {
        const { analyzePdfs } = await import("./pdf-tool.js");
        return analyzePdfs(args as Record<string, unknown>, ctx);
      },
    });
  }

  tools.push({
    name: "time_now",
    description: "Current local date and time.",
    parameters: { type: "object", properties: {} },
    async run() {
      const now = new Date();
      return `${now.toISOString()} · local ${now.toString()}`;
    },
  });

  tools.push(
    {
      name: "skill_list",
      description: "List installed skills with their descriptions and when to use them.",
      parameters: { type: "object", properties: {} },
      async run(_args, ctx) {
        const visible = ctx.skills.filter((s) => !s.disableModelInvocation);
        if (visible.length === 0) return "no skills installed";
        return visible
          .map((s) => `${s.eligible ? "" : "(unavailable) "}${s.name}: ${s.description}${s.readWhen.length ? ` [use when: ${s.readWhen.join("; ")}]` : ""}`)
          .join("\n");
      },
    },
    {
      name: "skill_read",
      description: "Load a skill's full instructions by name. Call this before following a skill's workflow.",
      parameters: {
        type: "object",
        properties: { name: str("Skill name") },
        required: ["name"],
      },
      async run(args, ctx) {
        const skill = ctx.skills.find((s) => s.name === String(args["name"]));
        if (!skill) return `error: no skill named ${args["name"]}`;
        if (!skill.eligible) return `error: skill ${skill.name} is unavailable (${skill.reason})`;
        return `# Skill: ${skill.name}\n\n${readSkillBody(skill)}`;
      },
    },
    {
      name: "skill_save",
      description:
        "Save instructions as a new skill for later reuse. Use whenever the user wants to capture a workflow, procedure, or reference so it can be triggered in future sessions — e.g. \"save that as a skill\", \"remember how to do this\", or when you have worked out a repeatable process worth keeping.",
      parameters: {
        type: "object",
        properties: {
          name: str("Skill name — 1-64 lowercase letters, numbers, or hyphens"),
          description: str("One line: what the skill does AND when to use it (this is how it triggers later)"),
          content: str("The skill instructions in Markdown"),
        },
        required: ["name", "description", "content"],
      },
      async run(args, ctx) {
        const result = writeSkill(
          ctx.workspace,
          String(args["name"] ?? ""),
          String(args["description"] ?? ""),
          String(args["content"] ?? ""),
        );
        if (!result.ok) return `error: ${result.error}`;
        ctx.refreshSkills?.();
        return `saved skill "${result.name}" to skills/${result.name}/SKILL.md — it is available now (skill_read "${result.name}") and in future sessions`;
      },
    },
  );

  // ---- automation (cron) ---------------------------------------------------
  // The scheduler lives outside the loop (gateway cron.* + `sc cron`), so until
  // these existed the agent's only honest answer to "remind me at 8" was "I
  // cannot schedule that" — and the task landed in a daily note instead. Same
  // rows, same croner validation, same id derivation as the CLI — plus
  // ctx.cronChanged so a job created in chat arms immediately, not at the next
  // restart.
  tools.push(
    {
      name: "cron_list",
      description:
        "List the scheduled jobs: id, name, schedule, timezone, delivery target, next run and the last run. Call this before changing or deleting anything — the ids here are what cron_update and cron_remove take.",
      parameters: { type: "object", properties: {} },
      async run(_args, ctx) {
        const jobs = ctx.store.listJobs();
        if (jobs.length === 0) return "no scheduled jobs yet — create one with cron_add";
        const runs = ctx.store.lastJobRuns(50);
        const blocks: string[] = [];
        for (const job of jobs) {
          let next: Date | null = null;
          let bad = false;
          try {
            next = await cronNext(job.schedule, job.tz || null);
          } catch {
            bad = true;
          }
          const last = runs.find((r) => r.job_id === job.id);
          blocks.push(
            [
              `${job.id} — ${job.name}`,
              `  ${cronWhen(job, next, bad)}`,
              `  delivery: ${cronDelivery(job, ctx)} · session ${job.session_key}`,
              last
                ? `  last run: ${new Date(last.started_at).toISOString()} · ${last.status}`
                : "  last run: never",
              `  prompt: ${job.prompt.replace(/\s+/g, " ").slice(0, 240)}`,
            ].join("\n"),
          );
        }
        return `${jobs.length} scheduled job${jobs.length === 1 ? "" : "s"}\n\n${blocks.join("\n\n")}`;
      },
    },
    {
      name: "cron_add",
      description:
        "Schedule a job that wakes you at a cron time and runs a prompt. Use this for any reminder, recurring check or \"every day at X\" request — scheduling is yours, so never answer that you cannot set one. " +
        "The job runs in its own fresh session: write the prompt as a self-contained instruction, naming the people, files and exactly what to send. " +
        "schedule is a five-field cron expression interpreted in tz (an IANA zone such as Asia/Dhaka), or an ISO datetime like 2026-10-27T08:00:00 for a one-shot. " +
        "Always pass tz when the user gives a wall-clock time. " +
        "With no delivery argument the result is announced back to the chat you are in, unless the operator configured a global cron.delivery.mode; pass delivery=\"none\" for a silent run. " +
        "The ## Surfaces block in your prompt lists which channels are live and the chat ids they reach: to=\"telegram\" delivers to the operator's Telegram chat, to=telegram:<chatId> to a specific one. The reply tells you where the result will actually go — quote that, never claim a channel is unreachable when Surfaces says it is online.",
      parameters: {
        type: "object",
        properties: {
          name: str("Short human name; also the job id (letters, numbers, dashes)"),
          schedule: str("Five-field cron expression in tz, or an ISO datetime for a one-shot"),
          prompt: str("Self-contained instruction the job runs — it sees nothing from this conversation"),
          tz: str("IANA timezone for the schedule, e.g. Asia/Dhaka (default: cron.timezone / host zone)"),
          delivery: {
            type: "string",
            enum: ["none", "announce", "webhook"],
            description: "Where the finished result goes; default announces it back to this chat",
          },
          to: str(
            "Target for announce: \"telegram\" (the operator's Telegram chat, resolved from the Surfaces block), telegram:<chatId>, or session:<key>. https://… only for webhook.",
          ),
        },
        required: ["name", "schedule", "prompt"],
      },
      async run(args, ctx) {
        const name = String(args["name"] ?? "").trim();
        const schedule = String(args["schedule"] ?? "").trim();
        const prompt = String(args["prompt"] ?? "").trim();
        if (!name || !schedule || !prompt) return "error: name, schedule and prompt are required";
        const id = cronIdOf(name);
        if (!id.replace(/-/g, "")) return "error: name needs at least one letter or number";
        if (ctx.store.getJob(id)) {
          return `error: a job with id "${id}" already exists — call cron_update to change it, or pick a different name`;
        }
        const tz = args["tz"] ? String(args["tz"]).trim() : null;
        const asked = args["delivery"] ? String(args["delivery"]) : "";
        if (asked && !["none", "announce", "webhook"].includes(asked)) {
          return "error: delivery must be none | announce | webhook";
        }
        let to = args["to"] ? String(args["to"]).trim() : "";
        if (asked === "webhook" && !to) return "error: delivery webhook needs to=<url>";
        let next: Date | null = null;
        try {
          next = await cronNext(schedule, tz);
        } catch (err) {
          return `error: invalid schedule or timezone: ${(err as Error).message}`;
        }
        // Delivery: an explicit choice wins; otherwise inherit the operator's
        // global default; and when that default delivers nothing, announce back
        // to this chat — a reminder filed in a transcript nobody opens is the
        // failure this whole task is about. The target is then resolved against
        // the live surfaces, so "telegram" means a real chat id and an
        // impossible target is an error instead of a promise.
        let mode: string | null = asked || null;
        if (!mode && ctx.config.cron.delivery.mode === "none") mode = "announce";
        let note: string | undefined;
        if (mode === "announce") {
          const resolved = targetOf(ctx, to, mode);
          if (resolved.error) return `error: ${resolved.error}`;
          to = resolved.target;
          note = resolved.note;
        }
        const row = ctx.store.upsertJob({
          id,
          name,
          schedule,
          prompt,
          session_key: `cron:${id}`,
          enabled: 1,
          tz,
          delivery_mode: mode,
          delivery_to: to || null,
          delivery_suppress_empty: 1,
        });
        await ctx.cronChanged?.();
        ctx.log?.info(`cron: agent created job ${row.id} (${row.schedule}${tz ? `, ${tz}` : ""})`);
        const lines = [
          `created cron job ${row.id}`,
          `  ${cronWhen(row, next)}`,
          `  delivery: ${cronDelivery(row, ctx)}${note ? ` (${note})` : ""}`,
          `  session: ${row.session_key} — every run starts fresh, so this prompt is all it will see`,
          `  prompt: ${prompt.replace(/\s+/g, " ")}`,
        ];
        if (!ctx.config.cron.enabled) {
          lines.push("warning: cron is disabled in config (cron.enabled=false) — the job is saved but will not fire until it is enabled");
        }
        return lines.join("\n");
      },
    },
    {
      name: "cron_update",
      description:
        "Change a scheduled job — rename it, retime it, rewrite its prompt, retarget its delivery, or pause/resume it. Only the fields you pass change, and the id stays the same so the job's session and transcript keep working. Pass tz=\"\" to fall back to the configured cron.timezone.",
      parameters: {
        type: "object",
        properties: {
          id: str("Job id from cron_list"),
          name: str("New display name"),
          schedule: str("New five-field cron expression or ISO datetime"),
          prompt: str("New self-contained instruction"),
          tz: str("New IANA timezone; empty string clears it back to cron.timezone"),
          delivery: {
            type: "string",
            enum: ["none", "announce", "webhook"],
            description: "New delivery mode",
          },
          to: str("New target: \"telegram\", telegram:<chatId>, session:<key> (https://… for webhook)"),
          enabled: { type: "boolean", description: "false pauses the job, true resumes it" },
        },
        required: ["id"],
      },
      async run(args, ctx) {
        const id = String(args["id"] ?? "").trim();
        if (!id) return "error: id is required — call cron_list for the ids";
        const existing = ctx.store.getJob(id);
        if (!existing) return `error: no job with id "${id}" — call cron_list for the ids`;
        const name = args["name"] === undefined ? existing.name : String(args["name"]).trim();
        if (!name) return "error: name cannot be empty";
        const schedule = args["schedule"] === undefined ? existing.schedule : String(args["schedule"]).trim();
        const prompt = args["prompt"] === undefined ? existing.prompt : String(args["prompt"]).trim();
        if (!schedule || !prompt) return "error: schedule and prompt cannot be empty";
        // A cleared zone is "" (falsy everywhere it is read); upsertJob cannot
        // write null over an existing value, which is why this is not `null`.
        const tz = args["tz"] === undefined ? existing.tz : String(args["tz"]).trim() || "";
        const asked = args["delivery"] === undefined ? undefined : String(args["delivery"]);
        if (asked !== undefined && asked && !["none", "announce", "webhook"].includes(asked)) {
          return "error: delivery must be none | announce | webhook";
        }
        const mode = asked === undefined ? existing.delivery_mode : asked || null;
        let to = args["to"] === undefined ? existing.delivery_to : String(args["to"]).trim() || null;
        if (mode === "webhook" && !to) return "error: delivery webhook needs to=<url>";
        // Retargeting to "telegram" has to mean a real chat id, and an offline
        // channel is an error here rather than a job that silently drops.
        if (mode === "announce" && args["to"] !== undefined) {
          const resolved = resolveAnnounceTarget(String(to ?? ""), ctx.sessionKey ?? "", factsOf(ctx));
          if (resolved.error) return `error: ${resolved.error}`;
          to = resolved.target || null;
        }
        const enabled =
          args["enabled"] === undefined ? existing.enabled : args["enabled"] ? 1 : 0;
        let next: Date | null = null;
        try {
          next = await cronNext(schedule, tz || null);
        } catch (err) {
          return `error: invalid schedule or timezone: ${(err as Error).message}`;
        }
        const row = ctx.store.upsertJob({
          id: existing.id,
          name,
          schedule,
          prompt,
          session_key: existing.session_key,
          enabled,
          tz,
          delivery_mode: mode,
          delivery_to: to,
          delivery_suppress_empty: existing.delivery_suppress_empty,
        });
        await ctx.cronChanged?.();
        ctx.log?.info(`cron: agent updated job ${row.id}`);
        const changed: string[] = [];
        if (name !== existing.name) changed.push(`name → ${name}`);
        if (schedule !== existing.schedule) changed.push(`schedule → ${schedule}`);
        if (prompt !== existing.prompt) changed.push("prompt");
        if ((tz || "") !== (existing.tz || "")) changed.push(`tz → ${tz || "cron.timezone"}`);
        if ((mode || "") !== (existing.delivery_mode || "")) changed.push(`delivery → ${mode ?? "default"}`);
        if ((to || "") !== (existing.delivery_to || "")) changed.push(`to → ${to ?? "none"}`);
        if (enabled !== existing.enabled) changed.push(enabled ? "resumed" : "paused");
        return [
          `updated ${row.id}${changed.length ? ` — ${changed.join(", ")}` : " — nothing changed"}`,
          `  ${cronWhen(row, next)}`,
          `  delivery: ${cronDelivery(row, ctx)}`,
        ].join("\n");
      },
    },
    {
      name: "cron_remove",
      description:
        "Delete a scheduled job for good. Its previous runs stay in the job's session transcript; the schedule itself is gone. Get the id from cron_list.",
      parameters: {
        type: "object",
        properties: { id: str("Job id from cron_list") },
        required: ["id"],
      },
      async run(args, ctx) {
        const id = String(args["id"] ?? "").trim();
        if (!id) return "error: id is required — call cron_list for the ids";
        const existing = ctx.store.getJob(id);
        if (!existing) return `error: no job with id "${id}" — call cron_list for the ids`;
        ctx.store.deleteJob(id);
        await ctx.cronChanged?.();
        ctx.log?.info(`cron: agent removed job ${id}`);
        return `removed "${existing.name}" (${id}) — its previous runs stay in the transcript of ${existing.session_key}`;
      },
    },
  );

  if (config.tools.exec.enabled) {
    tools.push({
      name: "exec",
      description:
        "Run a shell command. On by default and approved automatically in the default policy; if the operator set an approval mode, a declined call comes back as an error — report it, never pretend it ran.",
      parameters: {
        type: "object",
        properties: { command: str("Command line to run"), timeoutMs: int("Timeout in ms") },
        required: ["command"],
      },
      needsApproval: true,
        async run(args, ctx) {
          if (!ctx.approved) {
            return "error: execution needs approval — ask the user to approve, then retry";
          }
          const command = String(args["command"] ?? "").trim();
          if (!command) return "error: the command is empty — give exec a command line to run";
          const { execFile } = await import("node:child_process");
          // Task 38: 30 minutes for every command, and a per-call request can
          // not exceed it. `npm install`/a test suite on a phone is not "hung".
          // A junk request must never poison the call: Number("5s") is NaN and
          // execFile throws ERR_OUT_OF_RANGE synchronously, which used to make
          // *every* command fail until the model stopped sending it.
          const { ms: timeoutMs, note: timeoutNote } = resolveExecTimeout(args["timeoutMs"], config.tools.exec.timeoutMs);
          // Sandbox plan (P2 #9): off = legacy argv env; strict = env scrub +
          // prlimit caps (+ proot jail on Termux when enabled). The note is
          // prepended to output so audits see what actually ran.
          const { planSandbox } = await import("./exec-sandbox.js");
          const plan = planSandbox([findShell(), "-lc", command], ctx.workspace, config.tools.exec);
          const note =
            (config.tools.exec.sandbox === "strict" ? `[${plan.note}]\n` : "") +
            (timeoutNote ? `${timeoutNote}\n` : "");
          // Allowlist/safe-bin verdicts run argv-direct — the policy matched
          // literal tokens, so no shell may re-interpret them (globs, $PATH
          // lookups, re-quoting all stay off). Full/shell verdicts keep the
          // login shell exactly as before.
          try {
            if (ctx.execVerdict?.route === "direct") {
              const { runDirectChain } = await import("./exec-policy.js");
              const result = await runDirectChain(ctx.execVerdict.segments, ctx.execVerdict.ops, {
                cwd: ctx.workspace,
                timeoutMs,
              });
              const body = result.output.slice(0, 60_000);
              return note + (body || "(no output)");
            }
            return await new Promise<string>((resolvePromise) => {
              const [bin, ...rest] = plan.argv;
              execFile(
                bin!,
                rest,
                // 16 MB: the model reads the first 60k characters either way, but a
                // chatty command must be truncated for it, not failed outright with
                // "stdout maxBuffer length exceeded" (Task 38).
                { cwd: ctx.workspace, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: plan.env },
                (err, stdout, stderr) => {
                  const parts: string[] = [];
                  if (stdout) parts.push(stdout);
                  if (stderr) parts.push(`[stderr] ${stderr}`);
                  // Same wording as the direct route: one command, one kind of
                  // answer, whichever runner executed it.
                  const failure = explainExecError(err, {
                    cwd: ctx.workspace,
                    timeoutMs,
                    cmdline: command,
                    hadOutput: parts.length > 0,
                  });
                  if (failure) parts.push(failure);
                  const body = parts.join("\n").slice(0, 60_000);
                  resolvePromise(note + (body || "(no output)"));
                },
              );
            });
          } catch (err) {
            // Never let exec throw into the loop: an unexplained rejection reads
            // to the model as "the tool is broken". Say what happened instead.
            return `error: exec could not start: ${(err as Error).message}`;
          }
      },
    });
  }

  // ----- ask_user (P2 #8; their tools/ask-user.md) -----
  tools.push({
    name: "ask_user",
    description:
      "Ask the operator up to 3 questions (2–4 options each) and wait for their answer. " +
      "Use ONLY when a decision genuinely blocks progress and cannot be inferred from the transcript, " +
      "files, or sensible defaults — every ask interrupts the operator's flow. " +
      "Never ask for secrets or credentials. Other (free text) and Skip are always offered implicitly — " +
      "do not add them as options. Main session only.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1–3 questions, each with 2–4 options",
          items: {
            type: "object",
            properties: {
              id: str("Stable id (optional, q1/q2/q3 otherwise)"),
              question: str("The question text"),
              options: { type: "array", items: str("One option label"), description: "2–4 options" },
              multi: { type: "boolean", description: "Allow multiple selections" },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    async run(args, ctx) {
      const { normalizeAskUserArgs } = await import("./ask-user.js");
      const { questions, error } = normalizeAskUserArgs(args);
      if (error) return `error: ${error}`;
      if (!ctx.askUser) {
        return "error: ask_user is only available in the main session — make a reasonable decision on your own instead";
      }
      const result = await ctx.askUser(questions);
      return JSON.stringify(result);
    },
  });

  // ----- session family (OpenClaw sessions_spawn / sessions_yield / subagents) -----
  tools.push(
    {
      name: "sessions_spawn",
      description:
        "Spawn a background sub-agent to work a task in its own session. Returns immediately; the completion is announced back to you as a later turn. Use for research, coding, reviews and other slow or tool-heavy work you should not block the conversation on.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "What the sub-agent should do, fully briefed." },
          taskName: {
            type: "string",
            description: "Stable handle [a-z][a-z0-9_-]{0,63} to target this child later (list/cancel).",
          },
          label: { type: "string", description: "Short title for the work (shown in lists)." },
          model: { type: "string", description: "Optional model override for the child." },
          thinking: { type: "string", description: "Optional thinking-level override for the child." },
          context: {
            type: "string",
            enum: ["isolated", "fork"],
            description: "isolated (default): fresh transcript. fork: copy your current conversation into the child first — use sparingly.",
          },
        },
        required: ["task"],
      },
      async run(args, ctx) {
        if (!ctx.subagents || !ctx.sessionKey) return "error: sub-agent support is not available in this runtime";
        const res = await ctx.subagents.spawn(ctx.sessionKey, {
          task: String(args["task"] ?? ""),
          label: args["label"] ? String(args["label"]) : undefined,
          taskName: args["taskName"] ? String(args["taskName"]) : undefined,
          model: args["model"] ? String(args["model"]) : undefined,
          thinking: args["thinking"] ? String(args["thinking"]) : undefined,
          context: args["context"] === "fork" ? "fork" : "isolated",
          // Last resort only: spawn() prefers the explicit argument, then the
          // configured subagents.* value, then what the caller is running on.
          callerModel: ctx.model,
          callerThinking: ctx.thinking,
        });
        if (!res.accepted) return `error: ${res.error}`;
        return (
          `Sub-agent accepted.\nchildSessionKey: ${res.childSessionKey}\nrunId: ${res.runId}\n` +
          `taskName: ${res.taskName}\ncontext: ${res.context}` +
          (res.resolvedModel ? `\nmodel: ${res.resolvedModel}` : "") +
          `\nIt returns to you with \"… completed\" as a later message; meanwhile keep working or end your turn.`
        );
      },
    },
    {
      name: "sessions_yield",
      description:
        "End your turn and wait for your running sub-agents; their completions arrive as your next message. Use ONLY when your next step depends on results from children you already spawned.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Private note to yourself for when the turn resumes." },
        },
      },
      async run(args, ctx) {
        if (!ctx.subagents || !ctx.sessionKey) return "error: sub-agent support is not available in this runtime";
        const active = ctx.subagents.activeChildren(ctx.sessionKey);
        if (active.length === 0) {
          return "nothing_pending: no sub-agents are running for this session — just answer normally.";
        }
        ctx.yieldArmed = true;
        const privateNote = args["message"] ? ` Note saved for the resuming turn: ${String(args["message"])}` : "";
        return `yielded: waiting for ${active.length} sub-agent(s): ${active.map((c) => c.label || c.childSessionKey).join(", ")}.${privateNote}`;
      },
    },
    {
      name: "subagents",
      description:
        "List your background sub-agents (running and recent) with status and run ids, or cancel one by taskName/session key/run id.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "cancel"], description: "list (default) or cancel." },
          target: { type: "string", description: "taskName, child session key, or run id to cancel." },
        },
      },
      async run(args, ctx) {
        if (!ctx.sessionKey) return "error: missing session context";
        const store = ctx.store;
        const action = String(args["action"] ?? "list");
        if (action === "cancel") {
          const target = String(args["target"] ?? "").trim();
          if (!target) return "error: target required (taskName, session key, or run id)";
          const rows = store.subagentsFor(ctx.sessionKey, { limit: 50 });
          const row =
            rows.find((r) => r.task_name === target) ??
            rows.find((r) => r.child_session_key === target) ??
            rows.find((r) => r.run_id === target);
          if (!row) return `error: no sub-agent matching \"${target}\" in this session`;
          if (row.status !== "running") return `Already finished (status: ${row.status}).`;
          if (!ctx.subagents) return "error: cancellation is not available in this runtime";
          const stopped = ctx.subagents.cancel(row.child_session_key);
          return stopped
            ? `Cancelled ${row.task_name || row.label || row.child_session_key}; its completion will announce as aborted.`
            : `error: could not abort ${row.child_session_key} (already settling?)`;
        }
        const rows = store.subagentsFor(ctx.sessionKey, { limit: 20 });
        if (rows.length === 0) return "No sub-agents for this session.";
        return rows
          .map((r) => {
            const state = r.status === "running" ? "running" : `${r.status}`;
            const line = `- ${r.task_name || r.label || r.child_session_key} — ${state}` + (r.result_stats ? ` (${r.result_stats})` : "");
            return line;
          })
          .join("\n");
      },
    },
    {
      name: "session_send",
      description:
        "Send guidance into another session: steer injects into its live turn at the next boundary, followup queues a separate turn, notify leaves context for its next turn.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Target session key." },
          text: { type: "string", description: "Message content." },
          mode: { type: "string", enum: ["steer", "followup", "notify"], description: "Delivery mode (default: followup)." },
        },
        required: ["sessionKey", "text"],
      },
      async run(args, ctx) {
        if (!ctx.subagents) return "error: sub-agent support is not available in this runtime";
        const res = await ctx.subagents.send(
          String(args["sessionKey"] ?? ""),
          String(args["text"] ?? ""),
          (args["mode"] as "steer" | "followup" | "notify") || "followup",
        );
        return res.ok ? `ok: ${res.detail ?? "delivered"}` : `error: ${res.error ?? "delivery failed"}`;
      },
    },
  );

  // ── Task 26 — the agent knows its own settings and can change them.
  // The prompt block (`## Your configuration`) states the current values; this
  // tool is the write half. An exact allowlist + read-back, because the config
  // caster can silently drop a key that setPath created by typo.
  tools.push({
    name: "settings",
    description:
      "Read or change your own configuration (the Settings pages) when the user asks — default model, " +
      "fallbacks, reasoning, reply usage footer, queue mode, exec policy, cron timezone, identity. " +
      "Actions: list (what is writable), get (one path), set (path + value; applies live). " +
      "API keys, provider credentials and the gateway's port/bind/auth are operator-only and are refused " +
      "with the Settings page that owns them.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "set"], description: "list = writable paths, get = read one, set = change one." },
        path: { type: "string", description: "Dotted config path, e.g. agents.defaults.model or agents.defaults.usage." },
        value: { description: "New value for set: string, number, boolean, or a list of strings." },
      },
      required: ["action"],
    },
    async run(args, ctx) {
      const ctl = ctx.settings;
      if (!ctl) return "error: settings can only be changed from the main session";
      const action = String(args["action"] ?? "list").trim().toLowerCase();
      if (action === "list") {
        return `Writable settings (config: ${ctl.path}):\n${describeSettings()}`;
      }
      const path = String(args["path"] ?? "").trim();
      if (!path) return "error: path is required for get and set";
      if (action === "get") {
        const read = ctl.get(path);
        return read.ok ? `${path} = ${JSON.stringify(read.value)}` : `error: ${read.error}`;
      }
      if (action === "set") {
        if (!("value" in args)) return "error: value is required for set";
        const write = ctl.set(path, args["value"]);
        return write.ok
          ? `ok: ${path} = ${JSON.stringify(write.value)} (applied live — the next turn uses it)`
          : `error: ${write.error}`;
      }
      return `error: unknown action "${action}" — use list, get or set`;
    },
  });

  // ── P3 #23 — Code Mode surface swap (their tools.codeMode, mode:"only"):
  // when engaged, the model sees exec+wait(+direct-only); every other tool is
  // hidden from the direct list and exposed inside the guest as an async
  // global bridged through the normal run path (policy/approvals still apply).
  {
    const raw = config.tools.codeMode;
    const cmc: CodeModeConfig = {
      enabled: raw.enabled === "true" ? true : raw.enabled === "auto" ? "auto" : false,
      executor: raw.executor,
      timeoutMs: raw.timeoutMs,
      maxCodeChars: raw.maxCodeChars,
      maxOutputBytes: raw.maxOutputBytes,
      maxPendingToolCalls: raw.maxPendingToolCalls,
      directOnly: raw.directOnly ?? [],
    };
    if (codeModeEngages(cmc, config.agents?.defaults?.model)) {
      const hidden = tools.filter((t) => t.name !== "exec" && t.name !== "wait");
      let callCtx: ToolContext | null = null;
      const engine = new CodeMode(
        () => {
          const m = new Map<string, GuestTool>();
          for (const t of hidden) {
            const params = (t.parameters ?? { properties: {} }) as {
              properties?: Record<string, Record<string, unknown>>;
              required?: string[];
            };
            m.set(t.name, {
              name: t.name,
              description: t.description,
              inputs: Object.fromEntries(
                Object.entries(params.properties ?? {}).map(([k, v]) => [k, String((v as Record<string, unknown>)["type"] ?? "any")]),
              ),
              required: params.required ?? [],
              run: async (args) => {
                if (!callCtx) throw Object.assign(new Error("guest call outside a live exec cell"), { code: "exec_error" });
                return t.run(args as Record<string, unknown>, callCtx);
              },
            });
          }
          return m;
        },
        () => cmc,
      );
      const surface = codeModeSurface(engine);
      const execTool = surface.find((t) => t.name === "exec");
      if (execTool) {
        const origRun = execTool.run;
        execTool.run = async (args, ctx) => {
          callCtx = ctx;
          try {
            return await origRun(args, ctx);
          } finally {
            callCtx = null;
          }
        };
      }
      // their session-history transparency: the cell's source lands as
      // "// Code Mode\n" + code on the tool-call record (their rule)
      return [...surface, ...hidden.filter((t) => cmc.directOnly.includes(t.name))];
    }
  }

  // Task 35 — repo tools. Present in every registry (they refuse with a sentence
  // outside a code session), so the model can discover them without the schema
  // changing mid-conversation when a repo is bound.
  tools.push(
    {
      name: "repo_status",
      description:
        "What this code session has changed: the bound repository, branch, and the per-file line counts. Use it before summarising work or publishing.",
      parameters: { type: "object", properties: {} },
      async run(_args, ctx) {
        if (!ctx.repo || !ctx.repoCtl) return "error: this session is not bound to a repository";
        const st = await ctx.repoCtl.status(ctx.sessionKey ?? "");
        if (st.clean) return `${st.repo} · ${st.branch} (from ${st.base}) · no changes`;
        const files = st.files.map((f) => `  ${f.path}  +${f.added} −${f.removed}`).join("\n");
        return `${st.repo} · ${st.branch} (from ${st.base}) · ${st.files.length} file(s), +${st.added} −${st.removed}\n${files}`;
      },
    },
    {
      name: "github_publish",
      description:
        "Commit this session's work, push its sc/* branch, and open a pull request. Only when the user asked for a PR in this turn — it refuses otherwise.",
      parameters: {
        type: "object",
        properties: {
          title: str("PR title (a short sentence)"),
          body: str("PR description (optional)"),
          draft: { type: "boolean", description: "Open as a draft (default true)" },
        },
        required: ["title"],
      },
      async run(args, ctx) {
        if (!ctx.repo || !ctx.repoCtl) return "error: this session is not bound to a repository";
        if (ctx.publishAllowed !== true) {
          return (
            "error: the user did not ask for a pull request in this turn. Do not publish — " +
            "summarise what changed and say you can open a PR when they ask."
          );
        }
        const title = String(args["title"] ?? "").trim();
        if (!title) return "error: a title is required";
        try {
          const res = await ctx.repoCtl.publish({
            sessionKey: ctx.sessionKey ?? "",
            title,
            body: args["body"] === undefined ? undefined : String(args["body"]),
            draft: args["draft"] !== false,
          });
          return `${res.draft ? "Draft pull request" : "Pull request"} #${res.number} opened: ${res.url}\nbranch ${res.branch}`;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    },
  );

  return tools;
}

export function toolsToSchema(tools: ToolSpec[]): { type: "function"; function: Record<string, unknown> }[] {
  return tools.map((t) => {
    const parameters = (t.parameters ?? { type: "object", properties: {} }) as unknown as Record<string, unknown>;
    const props = (parameters["properties"] ?? {}) as Record<string, unknown>;
    // Gemini's OpenAI-compat rejects OBJECT schemas with empty properties
    // ("should be non-empty for OBJECT type") — parameterless tools get a
    // harmless optional filler property. Callers ignore unknown args.
    const safeParams =
      Object.keys(props).length === 0
        ? { ...parameters, properties: { note: { type: "string", description: "(no arguments)" } } }
        : parameters;
    return {
      type: "function",
      function: { name: t.name, description: t.description, parameters: safeParams },
    };
  });
}

export { skillsCatalog };