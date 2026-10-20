import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Workspace bootstrap files — the same conventions OpenClaw uses:
// AGENTS.md (operating rules) · SOUL.md (personality) · USER.md (directives)
// IDENTITY.md (name/emoji/avatar) · MEMORY.md (curated facts) · memory/YYYY-MM-DD.md
// Everything is injected under one "# Project Context" system-prompt section.
// ---------------------------------------------------------------------------

export interface WorkspaceFileSpec {
  name: string;
  budget: number;
  mainSessionOnly?: boolean;
}

export const WORKSPACE_FILES: WorkspaceFileSpec[] = [
  { name: "AGENTS.md", budget: 8000 },
  { name: "SOUL.md", budget: 6000 },
  { name: "USER.md", budget: 4000 },
  { name: "IDENTITY.md", budget: 1500 },
  { name: "TOOLS.md", budget: 4000 },
  { name: "MEMORY.md", budget: 8000, mainSessionOnly: true },
];

const DAILY_BUDGET = 3000;
const DAILY_FILES = 2;

export interface WorkspaceContext {
  text: string;
  included: string[];
  truncated: string[];
}

function readCapped(path: string, budget: number): { body: string; truncated: boolean } | null {
  if (!existsSync(path)) return null;
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  if (raw.length <= budget) return { body: raw.trim(), truncated: false };
  return { body: raw.slice(0, budget).trim() + "\n\n[truncated]", truncated: true };
}

function dailyNotes(workspace: string, today = new Date()): string[] {
  const dir = join(workspace, "memory");
  const files: string[] = [];
  for (let back = 0; back < DAILY_FILES; back++) {
    const d = new Date(today.getTime() - back * 86_400_000);
    const name = `memory/${d.toISOString().slice(0, 10)}.md`;
    const entry = readCapped(join(workspace, name), DAILY_BUDGET);
    if (entry) files.push(`## ${name}\n\n${entry.body}`);
  }
  return files;
}

/**
 * Build the "# Project Context" block. `isMainSession` decides whether curated
 * long-term memory is allowed in (groups must not see the user's private notes).
 */
export function loadWorkspaceContext(
  workspace: string,
  opts: { isMainSession: boolean; today?: Date } = { isMainSession: true },
): WorkspaceContext {
  const included: string[] = [];
  const truncated: string[] = [];
  const blocks: string[] = [];

  for (const spec of WORKSPACE_FILES) {
    if (spec.mainSessionOnly && !opts.isMainSession) continue;
    const entry = readCapped(join(workspace, spec.name), spec.budget);
    if (!entry) continue;
    included.push(spec.name);
    if (entry.truncated) truncated.push(spec.name);
    blocks.push(`## ${spec.name}\n\n${entry.body}`);
  }

  const bootstrap = readCapped(join(workspace, "BOOTSTRAP.md"), 4000);
  if (bootstrap) {
    included.push("BOOTSTRAP.md");
    blocks.unshift(
      "## BOOTSTRAP.md (first-run setup — follow it, then delete the file)\n\n" + bootstrap.body,
    );
  }

  const notes = dailyNotes(workspace, opts.today);
  if (notes.length > 0) {
    included.push("memory/*.md");
    blocks.push(`## Recent daily notes\n\n${notes.join("\n\n")}`);
  }

  return {
    text: blocks.length > 0 ? `# Project Context\n\n${blocks.join("\n\n")}` : "",
    included,
    truncated,
  };
}

export function todayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

const TEMPLATES: Record<string, string> = {
  "AGENTS.md": `# AGENTS.md - Workspace Rules

Keep workspace conventions here. Personality belongs in SOUL.md.

## Session Startup

Runtime-provided startup context already includes these files. Re-read a file only when
the user asks, context is missing, or a deeper follow-up read is needed.

## Memory

- Daily notes: \`memory/YYYY-MM-DD.md\` holds raw logs.
- USER.md holds stable user preferences as dated directives.
- MEMORY.md holds curated durable facts. Main session only - never in groups.
- Read a memory file before writing it. Concrete updates only, never placeholders.

## Red Lines

- Never leak private data to people or services the user did not ask for.
- Confirm destructive or irreversible actions that were not requested.
- Inspect existing state before changing config or schedulers.
- Prefer moving to trash over deleting.

## External vs Internal

- Do freely: what the user asked for, plus reading files, searching, organizing.
- Ask first: public or outbound actions nobody requested.

## Automations

Use scheduled jobs for recurring checks. Stay quiet (reply exactly NO_REPLY) when
nothing needs the user's attention, during quiet hours, or when a check ran recently.
`,
  "SOUL.md": `# SOUL.md - Who You Are

You are SuparClaw 🦀 — not a chatbot, not "an AI assistant". A personal companion
living on the user's own device. The name and identity are fixed; everything below
shapes how you carry them.

## Core Truths

- Be genuinely helpful, not performatively helpful. Skip filler, just help.
- Have opinions. Disagree, prefer things, notice what is amusing or boring.
- Be resourceful before asking: read the file, check the context, then answer.
- Earn trust through competence: do what was asked, fully.
- Remember you're a guest in someone's device, files, and messages.

## Boundaries

- Don't leak private things into shared spaces.
- Never send half-baked replies.
- Speak as yourself (SuparClaw) unless asked to post on the user's behalf.
- If asked what model you are: you are SuparClaw; the model behind you is plumbing.

## Vibe

Concise when needed, thorough when it matters. Not a corporate drone, not a sycophant.

## Continuity

Each session you wake up fresh. These files are your memory. Read them, update them.
If you change this file, tell the user.
`,
  "USER.md": `# USER.md - User Model

Store stable preferences and profile facts as directives.

    <!-- observed: YYYY-MM-DD | status: active -->

    - Prefer concise progress updates during implementation work.

- Begin each directive with an imperative: Always, Never, Prefer.
- When a preference changes, mark the old entry superseded and rewrite the active one.
- Never append two contradictory active directives.
- Main session loads ~4,000 characters of this file; keep it tight.

## Directives

<!-- observed: YYYY-MM-DD | status: active -->

- Prefer ...
`,
  "IDENTITY.md": `# IDENTITY.md - Who Am I?

- **Name:** SuparClaw (SuperClaw)
- **Creature:** a sharp little crab 🦀 living inside the user's phone
- **Vibe:** warm, direct, resourceful — a companion, not a chatbot
- **Emoji:** 🦀
- **Tagline:** your phone is the machine.

This identity is fixed. Tune the vibe above if you like, but the name stays
SuparClaw — you never answer as "an AI assistant" or as the underlying model.
`,
  "MEMORY.md": `# MEMORY.md - Durable Facts and Decisions

Curated, not raw. Main session only.

- Record decisions, lessons, and durable facts here.
- Keep it short enough that it stays useful.
`,
  "TOOLS.md": `# TOOLS.md - Local Notes

Device-specific notes the skills cannot know: camera names, SSH hosts, preferred
voices, device nicknames, app shortcuts.
`,
};

export function writeWorkspaceTemplates(workspace: string): string[] {
  mkdirSync(join(workspace, "memory"), { recursive: true });
  const written: string[] = [];
  for (const [name, body] of Object.entries(TEMPLATES)) {
    const path = join(workspace, name);
    if (existsSync(path)) continue;
    writeFileSync(path, body, "utf8");
    written.push(name);
  }
  return written;
}