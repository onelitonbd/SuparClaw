import { readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { join, resolve, relative, dirname, extname } from "node:path";
import type { SuparClawConfig } from "../config/schema.js";
import type { Store } from "../state/db.js";
import type { Logger } from "../util/log.js";
import { todayStamp } from "./workspace.js";
import { discoverSkills, readSkillBody, skillsCatalog, type SkillMeta } from "./skills.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  workspace: string;
  stateDir: string;
  skills: SkillMeta[];
  store: Store;
  log: Logger;
  config: SuparClawConfig;
  approved: boolean;
  signal?: AbortSignal;
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

export function buildRegistry(config: SuparClawConfig): ToolSpec[] {
  const tools: ToolSpec[] = [];

  if (config.tools.fs) {
    tools.push(
      {
        name: "fs_read",
        description: "Read a UTF-8 text file from the workspace. Paths are workspace-relative.",
        parameters: {
          type: "object",
          properties: { path: str("Workspace-relative file path"), offset: int("1-based first line"), limit: int("Max lines to read (default 400)") },
          required: ["path"],
        },
        async run(args, ctx) {
          const file = safePath(ctx.workspace, String(args["path"]));
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
        description: `Append a note to today's daily memory file (memory/${todayStamp()}.md).`,
        parameters: {
          type: "object",
          properties: { note: str("Markdown note to append") },
          required: ["note"],
        },
        async run(args, ctx) {
          const stamp = todayStamp();
          mkdirSync(join(ctx.workspace, "memory"), { recursive: true });
          appendFileSync(join(ctx.workspace, "memory", `${stamp}.md`), `\n- ${String(args["note"]).replace(/\n/g, " ")}\n`, "utf8");
          return `noted in memory/${stamp}.md`;
        },
      },
      {
        name: "memory_search",
        description: "Search past messages in this session's transcript.",
        parameters: {
          type: "object",
          properties: { query: str("Search terms"), limit: int("Max results (default 8)") },
          required: ["query"],
        },
        async run(args, ctx) {
          const rows = ctx.store.searchMessages(ctx.config.agents.defaults.id, String(args["query"]), Number(args["limit"] ?? 8));
          if (rows.length === 0) return "no matches";
          return rows.map((r) => `[${new Date(r.created_at).toISOString().slice(0, 16)}] ${r.role}: ${r.content.slice(0, 400)}`).join("\n\n");
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

  if (config.tools.web.search) {
    tools.push({
      name: "web_search",
      description: "Search the web (DuckDuckGo HTML endpoint) and return result titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: { query: str("Search query"), limit: int("Max results (default 6)") },
        required: ["query"],
      },
      async run(args, ctx) {
        const q = encodeURIComponent(String(args["query"]));
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
          signal: ctx.signal,
          headers: { "user-agent": "Mozilla/5.0 (Linux; Android) SuparClaw/0.1" },
        });
        if (!res.ok) return `error: HTTP ${res.status}`;
        const html = await res.text();
        const results: string[] = [];
        const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null && results.length < Number(args["limit"] ?? 6)) {
          const title = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
          const snippet = (m[3] ?? "").replace(/<[^>]+>/g, "").trim();
          const href = decodeURIComponent(/uddg=([^&]+)/.exec(m[1] ?? "")?.[1] ?? m[1] ?? "");
          results.push(`${title}\n${href}\n${snippet}`);
        }
        return results.length > 0 ? results.join("\n\n") : "no results";
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
  );

  if (config.tools.exec.enabled) {
    tools.push({
      name: "exec",
      description: "Run a shell command inside the workspace. Requires user approval. Disabled by default.",
      parameters: {
        type: "object",
        properties: { command: str("Command line to run"), timeoutMs: int("Timeout in ms") },
        required: ["command"],
      },
      needsApproval: true,
      async run(args, ctx) {
        if (config.tools.exec.approvals && !ctx.approved) {
          return "error: execution needs approval — ask the user to approve, then retry";
        }
        const { execFile } = await import("node:child_process");
        const timeoutMs = Math.min(Number(args["timeoutMs"] ?? config.tools.exec.timeoutMs), 600_000);
        return await new Promise<string>((resolvePromise) => {
          execFile(
            "/data/data/com.termux/files/usr/bin/bash",
            ["-lc", String(args["command"])],
            { cwd: ctx.workspace, timeout: timeoutMs, maxBuffer: 1_000_000 },
            (err, stdout, stderr) => {
              const parts: string[] = [];
              if (stdout) parts.push(stdout);
              if (stderr) parts.push(`[stderr] ${stderr}`);
              if (err) parts.push(`[exit ${typeof err.code === "number" ? err.code : 1}] ${err.message}`);
              resolvePromise(parts.join("\n").slice(0, 60_000) || "(no output)");
            },
          );
        });
      },
    });
  }

  return tools;
}

export function toolsToSchema(tools: ToolSpec[]): { type: "function"; function: Record<string, unknown> }[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export { skillsCatalog };