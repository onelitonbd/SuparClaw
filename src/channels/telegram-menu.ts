// Telegram's `/` menu — one source of truth, the catalog the routers answer.
//
// The menu is stored ON THE BOT TOKEN (Bot API setMyCommands), not in this
// process. That is why a token previously used by another build still shows
// that build's list: we never claimed it, so nothing replaced it. Every entry
// published here must be answerable by `Service.#commands`, the Telegram-local
// switch, or a skill — a menu entry for a command we cannot run is the bug this
// module exists to prevent.
import type { SkillMeta } from "../agent/skills.js";

export interface MenuEntry {
  /** Telegram command name: [a-z0-9_], 1-32 chars, no slash. */
  command: string;
  description: string;
}

/**
 * Telegram's rules, applied to our spelling: `/export-session` → `export_session`.
 * The catalog spells syntax (`/usage [off|tokens|full|cost]`), and only the
 * first token is the name — today `usage__off_tokens_full_cost`, which no user
 * can tap.
 */
export function menuName(raw: string): string {
  const head = raw.trim().split(/\s+/)[0] ?? "";
  return head
    .replace(/^\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

const MAX_DESCRIPTION = 256;
/** Bot API: at most 100 commands per scope. */
export const MENU_LIMIT = 100;

function describe(summary: string): string {
  const clean = summary.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_DESCRIPTION) return clean;
  return `${clean.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

export interface MenuSources {
  /** Commands the shared router answers (`SLASH_CATALOG`). */
  catalog: { cmd: string; summary: string }[];
  /** Commands only this surface answers (`/model`, `/provider`, …). */
  local: { cmd: string; summary: string }[];
  skills: Pick<SkillMeta, "name" | "description" | "eligible" | "userInvocable">[];
  limit?: number;
}

/**
 * Build the menu: catalog, then surface-local, then one entry per skill.
 * First spelling wins on a collision, so a skill can never shadow a built-in
 * (that is also why `/skill` is published alongside them).
 */
export function buildCommandMenu(sources: MenuSources): MenuEntry[] {
  const limit = sources.limit ?? MENU_LIMIT;
  const out: MenuEntry[] = [];
  const seen = new Set<string>();

  const add = (raw: string, summary: string): void => {
    if (out.length >= limit) return;
    const command = menuName(raw);
    if (!command || seen.has(command)) return;
    seen.add(command);
    out.push({ command, description: describe(summary) });
  };

  for (const entry of sources.catalog) add(entry.cmd, entry.summary);
  for (const entry of sources.local) add(entry.cmd, entry.summary);
  for (const skill of sources.skills) {
    // Same rule as OpenClaw: a skill that opts out of user invocation is not a
    // command, however runnable it is for the model.
    if (skill.eligible === false || skill.userInvocable === false) continue;
    add(skill.name, `Run the ${skill.name} skill${skill.description ? ` — ${skill.description}` : ""}`);
  }
  return out;
}
