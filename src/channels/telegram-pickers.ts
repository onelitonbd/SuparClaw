// Telegram's other pickers (Task 54b): sessions, thinking effort, and the
// coding flow (account → repository → branch).
//
// The operator's spec, verbatim:
//
//   "telegrame session o eki vabe jabe /session lekhle purber session gulo
//    dekhabe proti page e 10 ta session page change kora jabe sekhane ai
//    generated je title ta thek session er seta dekhano hobe ar select e sei
//    session e enter hobe. /thinking o same sop option bubble akare asbe click
//    kore select /new o bubble dekhabe Chat Code select e chat open hobe wr code
//    select korle Bubble akarei Account asbe erpor repo list same 10 each and
//    multiple page style e erpor repo select korle branch same vabe asbe sob
//    bramch each page 10 ta thakbe."
//
// So: every answer is a button, every list is ten to a page, the session row
// shows the AI title, and the coding flow starts by asking *which account*.
//
// Everything here is pure — rows in, text plus an inline keyboard out. No
// Telegram client, no network, no database. The cards are the part of this that
// must be right for every shape (no sessions, one account, 300 repositories), and
// a pure function can be tested against all of them.
//
// Callbacks carry page and slot, never a session key or a repository name: Bot
// API caps callback data at 64 bytes. Sessions are the one list that changes
// while the card is on screen (an answer bumps `last_msg_at`), so a session row
// also carries a short hash of its key — a tap whose slot no longer holds that
// key is refused instead of entering somebody else's conversation.

import { SESSION_THINKING_LEVELS } from "../agent/slash-commands.js";
import type { GithubSource } from "../repo/github.js";

/**
 * Rows per page, for every list in this file.
 *
 * Ten because that is the number the operator asked for, and because a phone
 * keyboard reads better as a count than as a scroll. The model picker uses the
 * same number: two page sizes for four lists is the kind of detail that reads
 * as unfinished.
 */
export const PICKER_PAGE = 10;
/** Telegram rejects a label over 64 chars; leave room for the ✓ prefix. */
const LABEL_MAX = 56;

export interface KeyboardRow {
  text: string;
  callback_data: string;
}

export interface Card {
  text: string;
  /** `null` means "send without a keyboard" (nothing to choose). */
  keyboard: KeyboardRow[][] | null;
}

/** How many pages `total` items make — always at least one, so page 0 exists. */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / PICKER_PAGE));
}

/** Clamp a requested page into range (a stale "Next ›" must not render empty). */
export function clampPage(page: number, total: number): number {
  const n = Number.isFinite(page) ? Math.trunc(page) : 0;
  return Math.min(Math.max(n, 0), pageCount(total) - 1);
}

/** The items of one page. */
export function slicePage<T>(items: T[], page: number): T[] {
  const start = clampPage(page, items.length) * PICKER_PAGE;
  return items.slice(start, start + PICKER_PAGE);
}

/**
 * A short, stable hash for "is this still the thing the button said?".
 *
 * djb2, base 36, four chars — enough to catch a list that moved, small enough
 * that the whole callback stays far inside Telegram's 64-byte cap.
 */
export function shortHash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(-4);
}

/** "just now", "12m ago", "3h ago", "2d ago" — the age of a session row. */
export function relativeAge(now: number, then: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (!then || seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function clip(text: string, max = LABEL_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ── sessions ────────────────────────────────────────────────────────────────

/** The fields of a session this file needs; a `SessionRow` satisfies it. */
export interface SessionLabel {
  key: string;
  name?: string | null;
  last_msg_at?: number;
  kind?: string | null;
  repo?: string | null;
}

/** `telegram:<chatId>` and `telegram:<chatId>:<tag>` belong to that chat. */
export function isSessionOfChat(key: string, chatId: number): boolean {
  const base = `telegram:${chatId}`;
  return key === base || key.startsWith(`${base}:`);
}

/**
 * Which session a chat is looking at.
 *
 * The chat holds a *pointer* (a full session key) to one of its own sessions.
 * It is honoured only while that row exists — a session pruned or archived away
 * must not take the chat's messages with it, and a stale pointer falls back to
 * the `/new` rotation tag exactly as before.
 */
export function resolveActiveSession(
  chatId: number,
  opts: { active?: string | null; tag?: string | null; exists: (key: string) => boolean },
): string {
  const active = (opts.active ?? "").trim();
  if (active && isSessionOfChat(active, chatId) && opts.exists(active)) return active;
  return `telegram:${chatId}${opts.tag ? `:${opts.tag}` : ""}`;
}

/** The AI-generated title, with a fallback that never shows a raw id alone. */
export function sessionTitle(row: Pick<SessionLabel, "key" | "name">): string {
  const name = (row.name ?? "").trim();
  if (name) return name;
  const parts = row.key.split(":");
  const tag = parts.slice(2).join(":");
  return tag ? `Chat ${tag}` : "Main chat";
}

export interface SessionTap {
  kind: "pick" | "page" | "new";
  page: number;
  slot: number;
  hash: string;
}

/** `s:<page>:<slot>:<hash>` · `s:p:<page>` · `s:n` */
export function readSessionTap(data: string): SessionTap | null {
  const parts = data.split(":");
  if (parts[0] !== "s") return null;
  if (parts[1] === "n") return { kind: "new", page: 0, slot: -1, hash: "" };
  if (parts[1] === "p") {
    const page = Number(parts[2] ?? 0);
    return Number.isFinite(page) && page >= 0 ? { kind: "page", page, slot: -1, hash: "" } : null;
  }
  const page = Number(parts[1]);
  const slot = Number(parts[2]);
  if (!Number.isFinite(page) || !Number.isFinite(slot)) return null;
  return { kind: "pick", page, slot, hash: parts[3] ?? "" };
}

/**
 * The `/sessions` card: this chat's conversations, newest first.
 *
 * `active` is the session the chat is looking at; it gets the ✓ and is never
 * re-entered by a tap. Sessions that are running or that a tap would leave are
 * the caller's business — this only draws.
 */
export function sessionsCard(opts: {
  sessions: SessionLabel[];
  active: string;
  page: number;
  now: number;
}): Card {
  const { sessions, active, now } = opts;
  if (sessions.length === 0) {
    return {
      text: "No sessions yet — say anything, or tap below to start one.",
      keyboard: [[{ text: "＋ New session", callback_data: "s:n" }]],
    };
  }
  const page = clampPage(opts.page, sessions.length);
  const rows: KeyboardRow[][] = [];
  slicePage(sessions, page).forEach((row, i) => {
    const mark = row.key === active ? "✓ " : "";
    const glyph = row.kind === "code" ? "⌘ " : "";
    const age = relativeAge(now, Number(row.last_msg_at ?? 0));
    const slot = page * PICKER_PAGE + i;
    rows.push([{ text: clip(`${mark}${glyph}${sessionTitle(row)} · ${age}`), callback_data: `s:${page}:${slot}:${shortHash(row.key)}` }]);
  });
  const nav: KeyboardRow[] = [];
  if (page > 0) nav.push({ text: "‹ Prev", callback_data: `s:p:${page - 1}` });
  if (page < pageCount(sessions.length) - 1) nav.push({ text: "Next ›", callback_data: `s:p:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "＋ New session", callback_data: "s:n" }]);
  const head = `Sessions — page ${page + 1}/${pageCount(sessions.length)} · ${sessions.length} in this chat`;
  return {
    text: `${head}\nTap one to pick up where it left off.`,
    keyboard: rows,
  };
}

/** The card a finished switch paints in place of the list. */
export function switchedCard(opts: { title: string; key: string; model?: string | null; thinking?: string | null }): Card {
  const lines = [`✅ Switched to ${opts.title}`, opts.key];
  if (opts.model) lines.push(`model: ${opts.model}`);
  if (opts.thinking) lines.push(`thinking: ${opts.thinking}`);
  lines.push("The next message goes here. /sessions to pick another.");
  return { text: lines.join("\n"), keyboard: [[{ text: "‹ Sessions", callback_data: "s:p:0" }]] };
}

// ── thinking ────────────────────────────────────────────────────────────────

const LEVEL_LABEL: Record<string, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export interface ThinkingTap {
  kind: "set" | "open";
  level: string | null;
}

/** `t:<level>` to set, `t:d` to go back to the config default, `t:o` to reopen. */
export function readThinkingTap(data: string): ThinkingTap | null {
  const parts = data.split(":");
  if (parts[0] !== "t") return null;
  if (parts[1] === "o") return { kind: "open", level: null };
  if (parts[1] === "d") return { kind: "set", level: null };
  const level = parts[1] ?? "";
  if (!(SESSION_THINKING_LEVELS as readonly string[]).includes(level)) return null;
  return { kind: "set", level };
}

/**
 * `/think` as buttons. `current` is the session's override (null = inherit),
 * `fallback` the value the config would apply — so "Default" can say what it
 * actually means instead of being a mystery button.
 */
export function thinkingCard(opts: { current: string | null; fallback: string; group?: boolean }): Card {
  const current = opts.current && (SESSION_THINKING_LEVELS as readonly string[]).includes(opts.current) ? opts.current : null;
  const scope = opts.group ? "this group" : "this chat";
  const rows: KeyboardRow[][] = [];
  rows.push([{ text: `${current === null ? "✓ " : ""}Default (${opts.fallback})`, callback_data: "t:d" }]);
  const levels = [...SESSION_THINKING_LEVELS];
  for (let i = 0; i < levels.length; i += 3) {
    rows.push(
      levels.slice(i, i + 3).map((level) => ({
        text: `${level === current ? "✓ " : ""}${LEVEL_LABEL[level] ?? level}`,
        callback_data: `t:${level}`,
      })),
    );
  }
  return {
    text: [
      `Thinking effort — ${scope}: ${current ?? `default (${opts.fallback})`}`,
      `Applies from the next turn. “Default” follows the config (${opts.fallback}).`,
    ].join("\n"),
    keyboard: rows,
  };
}

/** The card after a level is chosen — one line, and a way back into the list. */
export function thinkingSetCard(opts: { level: string | null; fallback: string; group?: boolean }): Card {
  const scope = opts.group ? "this group" : "this chat";
  const line = opts.level ? `✅ Thinking: ${LEVEL_LABEL[opts.level] ?? opts.level} — ${scope}.` : `✅ Thinking: default (${opts.fallback}) — ${scope}.`;
  return { text: `${line}\nIt applies from the next turn.`, keyboard: [[{ text: "Change", callback_data: "t:o" }]] };
}

// ── coding: account → repository → branch ───────────────────────────────────

export interface AccountRow {
  source: GithubSource;
  login: string;
  label: string;
}

/** `a:<index into the card's rows>` */
export function readAccountTap(data: string): number | null {
  const parts = data.split(":");
  if (parts[0] !== "a") return null;
  const idx = Number(parts[1]);
  return Number.isFinite(idx) && idx >= 0 ? idx : null;
}

/**
 * "Which account?" — the first question of the coding flow, because the
 * repositories, the branches and the clone itself all depend on it, and this
 * machine can legitimately hold more than one login (`gh`, a stored token, CI).
 */
export function accountCard(opts: { accounts: AccountRow[]; current?: string | null }): Card {
  if (opts.accounts.length === 0) {
    return {
      text: "GitHub is not connected.\nOn the gateway: `sc github adopt-gh` (reuse the gh CLI login) or `sc github connect` (device flow).",
      keyboard: null,
    };
  }
  const rows = opts.accounts.slice(0, PICKER_PAGE).map((a, i) => [
    {
      text: clip(`${a.source === opts.current ? "✓ " : ""}@${a.login} · ${a.label}`),
      // The hash of the source, not the index alone: a list that changed under
      // the card must not bind with a login the user did not pick.
      callback_data: `a:${i}:${shortHash(a.source)}`,
    },
  ]);
  return {
    text: [
      `⌘ Code — which GitHub account?`,
      opts.accounts.length > 1 ? "The list, the branches and the clone all use this login." : "Repositories, branches and the clone all use this login.",
    ].join("\n"),
    keyboard: rows,
  };
}

/** `r:<page>:<slot>` selects, `r:p:<page>` pages, `r:a` goes back to accounts. */
export interface RepoTap {
  kind: "slot" | "page" | "accounts";
  page: number;
  slot: number;
}

export function readRepoTap(data: string): RepoTap | null {
  const parts = data.split(":");
  if (parts[0] !== "r") return null;
  if (parts[1] === "a") return { kind: "accounts", page: 0, slot: -1 };
  if (parts[1] === "p") {
    const page = Number(parts[2] ?? 0);
    return Number.isFinite(page) && page >= 0 ? { kind: "page", page, slot: -1 } : null;
  }
  const page = Number(parts[1]);
  const slot = Number(parts[2]);
  if (!Number.isFinite(page) || !Number.isFinite(slot) || slot < 0) return null;
  return { kind: "slot", page, slot };
}

/**
 * The repository list.
 *
 * `total` is what the picker has actually pulled so far and `done` says whether
 * GitHub has more — so the header can be honest (`page 1/3 · 34`) instead of
 * promising a page count it has not fetched yet (`page 1 · 20+`).
 */
export function repoCard(opts: {
  repos: { fullName: string; private: boolean }[];
  account: AccountRow | null;
  page: number;
  total: number;
  done: boolean;
  filter?: string;
}): Card {
  const who = opts.account ? ` · @${opts.account.login}` : "";
  const back: KeyboardRow = { text: "‹ Accounts", callback_data: "r:a" };
  if (opts.total === 0) {
    return {
      text: opts.filter
        ? `No repositories match “${opts.filter}”${who}.`
        : `No repositories on this account${who}.`,
      keyboard: [[back]],
    };
  }
  const pages = pageCount(opts.total);
  const page = clampPage(opts.page, opts.total);
  const rows = slicePage(opts.repos, page).map((r, i) => [
    { text: clip(`${r.private ? "🔒 " : ""}${r.fullName}`), callback_data: `r:${page}:${page * PICKER_PAGE + i}` },
  ]);
  const nav: KeyboardRow[] = [];
  if (page > 0) nav.push({ text: "‹ Prev", callback_data: `r:p:${page - 1}` });
  if (opts.done ? page < pages - 1 : true) nav.push({ text: "Next ›", callback_data: `r:p:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([back]);
  const count = opts.done ? `${opts.total}` : `${opts.total}+`;
  return {
    text: [
      `Repositories — page ${page + 1}${opts.done ? `/${pages}` : ""} · ${count}${who}`,
      opts.filter ? `filter: ${opts.filter}` : "Tap one — the clone lands in a worktree of its own.",
    ].join("\n"),
    keyboard: rows,
  };
}

export interface BranchTap {
  kind: "slot" | "page" | "repos";
  page: number;
  slot: number;
}

/** `b:<page>:<slot>` selects, `b:p:<page>` pages, `b:r` goes back to repos. */
export function readBranchTap(data: string): BranchTap | null {
  const parts = data.split(":");
  if (parts[0] !== "b") return null;
  if (parts[1] === "r") return { kind: "repos", page: 0, slot: -1 };
  if (parts[1] === "p") {
    const page = Number(parts[2] ?? 0);
    return Number.isFinite(page) && page >= 0 ? { kind: "page", page, slot: -1 } : null;
  }
  const page = Number(parts[1]);
  const slot = Number(parts[2]);
  if (!Number.isFinite(page) || !Number.isFinite(slot) || slot < 0) return null;
  return { kind: "slot", page, slot };
}

/**
 * The branch list — the branch to *continue*, so the default is first and
 * marked. `base` is the repository's default branch, kept even when it fell off
 * the fetched page (see `orderBranches`).
 */
export function branchCard(opts: {
  repo: string;
  branches: { name: string; default?: boolean; protected?: boolean }[];
  page: number;
  total: number;
  done: boolean;
  base?: string;
}): Card {
  const back: KeyboardRow = { text: "‹ Repos", callback_data: "b:r" };
  if (opts.total === 0) {
    return { text: `⌘ ${opts.repo} — no branches yet (a repository with no commits).`, keyboard: [[back]] };
  }
  const pages = pageCount(opts.total);
  const page = clampPage(opts.page, opts.total);
  const rows = slicePage(opts.branches, page).map((b, i) => {
    const mark = b.default ? " · default" : b.protected ? " · protected" : "";
    return [{ text: clip(`${b.name}${mark}`, 60), callback_data: `b:${page}:${page * PICKER_PAGE + i}` }];
  });
  const nav: KeyboardRow[] = [];
  if (page > 0) nav.push({ text: "‹ Prev", callback_data: `b:p:${page - 1}` });
  if (opts.done ? page < pages - 1 : true) nav.push({ text: "Next ›", callback_data: `b:p:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([back]);
  const count = opts.done ? `${opts.total}` : `${opts.total}+`;
  return {
    text: [
      `⌘ ${opts.repo} — which branch?`,
      `page ${page + 1}${opts.done ? `/${pages}` : ""} · ${count} branches — the session continues this branch.`,
    ].join("\n"),
    keyboard: rows,
  };
}

/** Where `/new` lands: the two ways to start a session (unchanged wording). */
export function newSessionCard(opts: { key: string; previous: string }): Card {
  return {
    text: [
      `New session ${opts.key}`,
      `The previous one is kept — ${opts.previous} is still in Sessions.`,
      "",
      "Chat, or code a repository?",
    ].join("\n"),
    keyboard: [
      [
        { text: "💬 Chat", callback_data: "n:c" },
        { text: "⌘ Code", callback_data: "n:k" },
      ],
    ],
  };
}

/** Provider-of-the-page footer used by the repo card's empty state. */
export function unconfiguredGithubCard(error: string): Card {
  return {
    text: `GitHub is not connected — ${error}\n\nOn the gateway: sc github adopt-gh (or sc github connect)`,
    keyboard: null,
  };
}
