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

/** A Bot API command scope — a union, so it slots into grammY's signatures. */
export type CommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "all_group_chats" }
  | { type: "all_chat_administrators" }
  | { type: "chat"; chat_id: number }
  | { type: "chat_administrators"; chat_id: number }
  // Telegram requires a user id here as well; a DM's chat id IS that user's id.
  | { type: "chat_member"; chat_id: number; user_id: number };

export interface ScopeSources {
  /** Chats we have seen: sessions and both pairing lists. */
  chatIds?: (number | string)[];
  /** Paired user ids — only they can have a `chat_member` scope in a DM. */
  userIds?: (number | string)[];
  /** Language codes whose dedicated list should be cleared too. */
  langs?: string[];
}

/** One `(scope, language)` pair — the unit Telegram stores a command list under. */
export interface CommandTarget {
  scope: CommandScope;
  language_code?: string;
}

/**
 * Every place a stale command list can live, from what we actually know.
 *
 * Telegram has no "list all scopes" call, and a chat/member scope OVERRIDES the
 * default one — so replacing `default` alone leaves an old build's commands
 * showing in exactly the chat where they were registered. Every scope we or a
 * previous install could have created is keyed by a chat id we already store,
 * which makes the sweep complete without a way to enumerate.
 *
 * Language-specific lists cannot be enumerated at all, so they are opt-in:
 * `langs` repeats the four wildcard scopes once per code. Per-chat language
 * variants are not worth 3xchatsxlangs calls and nothing we ship creates them.
 */
export function staleCommandScopes(sources: ScopeSources = {}): CommandTarget[] {
  const chatIds = [
    ...new Set(
      (sources.chatIds ?? [])
        .map((id) => Number(String(id).trim()))
        .filter((id) => Number.isFinite(id) && id !== 0),
    ),
  ];
  const userIds = [
    ...new Set(
      (sources.userIds ?? [])
        .map((id) => Number(String(id).trim()))
        .filter((id) => Number.isFinite(id) && id !== 0),
    ),
  ];
  const wildcard: CommandTarget[] = [
    { scope: { type: "default" } },
    { scope: { type: "all_private_chats" } },
    { scope: { type: "all_group_chats" } },
    { scope: { type: "all_chat_administrators" } },
  ];
  const perChat: CommandTarget[] = [
    ...chatIds.map((chat_id) => ({ scope: { type: "chat" as const, chat_id } })),
    ...chatIds.map((chat_id) => ({ scope: { type: "chat_administrators" as const, chat_id } })),
    // `chat_member` needs a user id. In a private chat the chat id IS the user's
    // id, so pairing-list users cover exactly the DMs that could have one.
    ...userIds
      .filter((id) => chatIds.includes(id))
      .map((id) => ({ scope: { type: "chat_member" as const, chat_id: id, user_id: id } })),
  ];
  const langs = [
    ...new Set(
      (sources.langs ?? [])
        .map((l) => l.trim().toLowerCase())
        .filter((l) => /^[a-z]{2}(-[a-z]{2})?$/.test(l)),
    ),
  ];
  return [
    ...wildcard,
    ...perChat,
    ...langs.flatMap((language_code) => wildcard.map((t) => ({ ...t, language_code }))),
  ];
}

/** What a token currently holds vs what this build publishes. */
export function menuDrift(
  current: { command: string; description?: string }[],
  expected: MenuEntry[],
): { missing: string[]; extra: string[]; stale: string[] } {
  const have = new Map(current.map((c) => [c.command, c.description ?? ""]));
  const want = new Map(expected.map((c) => [c.command, c.description]));
  return {
    missing: [...want.keys()].filter((c) => !have.has(c)),
    extra: [...have.keys()].filter((c) => !want.has(c)),
    stale: [...want.keys()].filter((c) => have.has(c) && (have.get(c) ?? "") !== want.get(c)),
  };
}

// ---------------------------------------------------------------------------
// CLI helpers — pure, so `sc telegram commands` can be tested without a CLI
// process, a config file or a network.
// ---------------------------------------------------------------------------

export interface TelegramCommandOpts {
  mode: "show" | "replace" | "purge";
  token?: string;
  langs: string[];
  json: boolean;
}

export function parseTelegramArgs(args: string[]): { sub: string; opts: TelegramCommandOpts } {
  const sub = args.find((a) => !a.startsWith("-")) ?? "status";
  const opts: TelegramCommandOpts = { mode: "show", langs: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--replace") opts.mode = "replace";
    else if (a === "--purge" || a === "--clear") opts.mode = "purge";
    else if (a === "--show" || a === "--status") opts.mode = "show";
    else if (a === "--json") opts.json = true;
    else if (a === "--token") opts.token = args[++i]?.trim();
    else if (a.startsWith("--token=")) opts.token = a.slice("--token=".length).trim();
    else if (a === "--lang") opts.langs.push(...(args[++i] ?? "").split(",").map((l) => l.trim()).filter(Boolean));
    else if (a.startsWith("--lang=")) opts.langs.push(...a.slice("--lang=".length).split(",").map((l) => l.trim()).filter(Boolean));
  }
  return { sub, opts };
}

/** "chat:12345", "all_group_chats", "chat_member:12345:42" */
export function scopeLabel(scope: CommandScope, language?: string): string {
  const base =
    scope.type === "chat" || scope.type === "chat_administrators"
      ? `${scope.type}:${scope.chat_id}`
      : scope.type === "chat_member"
        ? `chat_member:${scope.chat_id}:${scope.user_id}`
        : scope.type;
  return language ? `${base} [${language}]` : base;
}
