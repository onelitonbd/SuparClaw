import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findBundledDir } from "../util/paths.js";

// ---------------------------------------------------------------------------
// Skills: markdown instruction packs with YAML frontmatter, discovered from
// ordered roots, gated by environment, snapshotted per session.
// ---------------------------------------------------------------------------

export interface SkillRequirements {
  bins?: string[];
  env?: string[];
  os?: string[];
}

export interface SkillMeta {
  name: string;
  description: string;
  readWhen: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  requires: SkillRequirements;
  root: string;
  dir: string;
  path: string;
  eligible: boolean;
  reason?: string;
}

type Line = { indent: number; text: string };

/**
 * Minimal YAML-subset parser: scalars, inline lists, JSON objects and nested
 * indented blocks (enough for `metadata.openclaw.requires.bins`).
 */
export function parseFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text };
  const raw = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(end + 4).replace(/^\n/, "");

  const lines: Line[] = raw
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));

  const [value] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  return { meta: (value && typeof value === "object" ? value : {}) as Record<string, unknown>, body };
}

function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  if (start >= lines.length) return [{}, start];
  const first = lines[start] as Line;
  if (first.text.startsWith("- ")) {
    const items: string[] = [];
    let i = start;
    while (i < lines.length && (lines[i] as Line).indent >= indent && (lines[i] as Line).text.startsWith("- ")) {
      items.push(unquote((lines[i] as Line).text.slice(2)));
      i++;
    }
    return [items, i];
  }

  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent < indent) break;
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.text);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1] as string;
    const inline = (kv[2] ?? "").trim();
    if (inline.length > 0) {
      map[key] = parseScalar(inline);
      i++;
      continue;
    }
    const next = lines[i + 1];
    if (next && (next.indent > line.indent || (next.indent === line.indent && next.text.startsWith("- ")))) {
      const [child, after] = parseBlock(lines, i + 1, next.indent);
      map[key] = child;
      i = after;
    } else {
      map[key] = "";
      i++;
    }
  }
  return [map, i];
}

function parseScalar(value: string): unknown {
  if (value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value.startsWith("[")) {
    const inner = value.replace(/^\[|\]$/g, "");
    if (inner.trim() === "") return [];
    return inner
      .split(",")
      .map((v) => unquote(v.trim()))
      .filter(Boolean);
  }
  return unquote(value);
}

function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, "");
}

function whichAll(bins: string[]): Set<string> {
  const found = new Set<string>();
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    for (const bin of bins) {
      if (existsSync(join(dir, bin))) found.add(bin);
    }
  }
  return found;
}

function checkRequirements(req: SkillRequirements): { ok: boolean; reason?: string } {
  if (req.os?.length) {
    const ok = req.os.includes(`${process.platform}-${process.arch}`) || req.os.includes(process.platform);
    if (!ok) return { ok: false, reason: `os ${req.os.join("/")} required, running ${process.platform}` };
  }
  if (req.env?.length) {
    const missing = req.env.filter((k) => !process.env[k]);
    if (missing.length > 0) return { ok: false, reason: `missing env ${missing.join(", ")}` };
  }
  if (req.bins?.length) {
    const missing = req.bins.filter((b) => !whichAll([b]).has(b));
    if (missing.length > 0) return { ok: false, reason: `missing binary ${missing.join(", ")}` };
  }
  return { ok: true };
}

function walkForSkills(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 500) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (existsSync(join(full, "SKILL.md"))) {
      out.push(full);
      continue; // grouped layouts stop below a skill dir
    }
    walkForSkills(full, depth + 1, out);
  }
  return out;
}

export function bundledSkillsRoot(): string {
  // dist/sc.js or dist/chunks/*.js -> repo root -> skills/
  return findBundledDir("skills", "help/SKILL.md");
}

export interface DiscoverOptions {
  roots: { label: string; dir: string }[];
  env?: Record<string, string | undefined>;
}

export function discoverSkills(opts: DiscoverOptions): SkillMeta[] {
  const found = new Map<string, SkillMeta>();
  // Highest precedence first: first writer wins.
  for (const root of opts.roots) {
    if (!existsSync(root.dir)) continue;
    for (const dir of walkForSkills(root.dir)) {
      const file = join(dir, "SKILL.md");
      let parsed: { meta: Record<string, unknown>; body: string };
      try {
        parsed = parseFrontmatter(readFileSync(file, "utf8"));
      } catch (err) {
        continue;
      }
      const m = parsed.meta;
      const name = typeof m["name"] === "string" ? (m["name"] as string) : dir.split("/").pop() ?? dir;
      if (found.has(name)) continue;
      const rawMeta = (m["metadata"] ?? {}) as Record<string, unknown>;
      const openclaw = (rawMeta["openclaw"] ?? {}) as { requires?: SkillRequirements };
      const readWhenRaw = m["read_when"] ?? m["readWhen"];
      const readWhen = Array.isArray(readWhenRaw)
        ? readWhenRaw.map(String)
        : typeof readWhenRaw === "string"
          ? [readWhenRaw]
          : [];
      const req: SkillRequirements = {
        ...(openclaw.requires ?? {}),
        ...(typeof (rawMeta["requires"] as SkillRequirements) === "object"
          ? (rawMeta["requires"] as SkillRequirements)
          : {}),
      };
      const check = checkRequirements(req);
      found.set(name, {
        name,
        description: typeof m["description"] === "string" ? (m["description"] as string) : "",
        readWhen,
        userInvocable: m["user-invocable"] !== false,
        disableModelInvocation: m["disable-model-invocation"] === true,
        requires: req,
        root: root.label,
        dir,
        path: file,
        eligible: check.ok,
        reason: check.reason,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillBody(skill: SkillMeta): string {
  try {
    const { body } = parseFrontmatter(readFileSync(skill.path, "utf8"));
    return body.trim();
  } catch {
    return "";
  }
}

/**
 * Normalize a skill name to the portable slug form: 1-64 lowercase letters,
 * numbers, or hyphens (Agent Skills / ClawHub convention).
 */
export function skillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface WriteSkillResult {
  ok: boolean;
  name: string;
  path?: string;
  error?: string;
}

/**
 * Write a skill into `<workspace>/skills/<name>/SKILL.md` with frontmatter —
 * the shared save path for the Settings "+" button and the `skill_save` tool.
 * Returns the normalized slug on success.
 */
export function writeSkill(
  workspace: string,
  name: string,
  description: string,
  body: string,
): WriteSkillResult {
  const slug = skillSlug(name);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    return {
      ok: false,
      name,
      error: "name must be 1-64 lowercase letters, numbers, or hyphens",
    };
  }
  const desc = description.replace(/\s+/g, " ").trim();
  const text = body.replace(/^\n+/, "").replace(/\s+$/, "");
  const dir = join(workspace, "skills", slug);
  const file = join(dir, "SKILL.md");
  const fm = ["---", `name: ${slug}`, `description: ${desc || slug}`, "---", ""].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${fm}${text}\n`, "utf8");
  return { ok: true, name: slug, path: file };
}

/** Prompt-injected catalog: name + when to use, body stays out until matched. */
export function skillsCatalog(skills: SkillMeta[]): string {
  const visible = skills.filter((s) => s.eligible && !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = visible.map((s) => {
    const when = s.readWhen.length > 0 ? ` — use when: ${s.readWhen.join("; ")}` : "";
    return `- **${s.name}**: ${s.description}${when}`;
  });
  return `## Available skills\n\nCall \`skill_read\` with the skill name when a task matches one.\n\n${lines.join("\n")}`;
}

/** Heuristic on-demand match: explicit slash command, name mention, or read_when keyword hit. */
export function matchSkills(skills: SkillMeta[], text: string): SkillMeta[] {
  const lower = text.toLowerCase();
  const hits: { skill: SkillMeta; score: number }[] = [];
  for (const skill of skills) {
    if (!skill.eligible || skill.disableModelInvocation) continue;
    let score = 0;
    if (new RegExp(`(^|\\s)/${skill.name}(\\s|$)`).test(lower)) score += 10;
    if (lower.includes(skill.name.toLowerCase())) score += 3;
    for (const hint of skill.readWhen) {
      const kw = hint.toLowerCase().split(/\s+/).filter((w) => w.length > 3)[0];
      if (kw && lower.includes(kw)) score += 2;
    }
    if (score > 0) hits.push({ skill, score });
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((h) => h.skill);
}