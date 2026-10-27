import type { Context } from "grammy";
import type { Service } from "../agent/service.js";
import type { Logger } from "../util/log.js";
import { workspaceDir } from "../util/paths.js";
import { downloadInboundMedia, mediaPlaceholder, planInboundMedia, type InboundMedia } from "./telegram-media.js";
import { BotLoopGuard } from "./bot-guard.js";
import { renderQuestionText } from "../agent/ask-user.js";
import { createTyping, type TypingHandle } from "../agent/typing.js";
import { stripStrayHeartbeatOk } from "../automation/heartbeat.js";
import {
  addProvider,
  canonicalModelRef,
  formatProviders,
  parseProviderAddArgs,
  removeProvider,
  testProvider,
} from "../config/providers.js";
import { slashHelp, SLASH_CATALOG } from "../agent/slash-commands.js";
import { execModeOf, modelProfile } from "../config/schema.js";
import { BUILD_STAMP } from "../util/build-stamp.js";
import { buildCommandMenu, staleCommandScopes } from "./telegram-menu.js";
import { splitForTelegram, stripHtmlTags, telegramChunks } from "./telegram-format.js";
import { createTurnDelivery, isTransientTelegramError } from "./telegram-delivery.js";
import { applyModelTap, currentModel, providerCard, readModelArgument, type Card } from "./telegram-model-menu.js";
import {
  PICKER_PAGE,
  accountCard,
  branchCard,
  isSessionOfChat,
  newSessionCard,
  readAccountTap,
  readBranchTap,
  readRepoTap,
  readSessionTap,
  readThinkingTap,
  relativeAge,
  repoCard,
  resolveActiveSession,
  sessionTitle,
  sessionsCard,
  shortHash,
  switchedCard,
  thinkingCard,
  thinkingSetCard,
  unconfiguredGithubCard,
  type AccountRow,
} from "./telegram-pickers.js";

// Telegram channel: grammY long polling, per-chat batching, one editable status
// draft per turn, DM pairing + group allowlists + mention gating.

/** grammY is only needed when the Telegram channel is enabled.
 *
 *  Resolve `Bot` from the named export OR the module default: esbuild's code
 *  splitting compiles grammy's CJS entry to a chunk whose only export is the
 *  default namespace object, so `const { Bot } = await import("grammy")` is
 *  undefined in the production bundle ("e is not a constructor") even though
 *  tsx/dev resolves it named. */
async function createBot(token: string, proxy = "") {
  const mod = (await import("grammy")) as typeof import("grammy") & { default?: { Bot?: typeof import("grammy").Bot } };
  const Bot = mod.Bot ?? mod.default?.Bot;
  if (typeof Bot !== "function") throw new Error("grammy Bot export unavailable (bundle shape mismatch)");
  // Where api.telegram.org is blocked, the Bot's own fetch goes through a
  // HTTP(S)/SOCKS proxy (undici ProxyAgent as the fetch dispatcher).
  const url = proxy.trim();
  if (!url) return new Bot(token);
  const { dispatcher, fetch } = await proxyBits(url);
  type BotConfig = ConstructorParameters<typeof import("grammy").Bot>[1];
  const client = { fetch: fetch as unknown as typeof fetch, baseFetchConfig: { dispatcher } } as unknown as NonNullable<BotConfig>["client"];
  return new Bot(token, { client });
}

/** undici pieces the proxy path needs, resolved from the named export OR the
 *  module default: esbuild's code splitting compiles undici's CJS entry to a
 *  chunk whose only export is the default namespace object, so
 *  `const { ProxyAgent } = await import("undici")` is undefined in the
 *  production bundle ("<mangled> is not a constructor") even though tsx/dev
 *  resolves it named. Same trap as grammy's `Bot` above. */
async function undiciParts(): Promise<{
  ProxyAgent?: new (url: string) => unknown;
  Socks5ProxyAgent?: new (url: string) => unknown;
  fetch?: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
}> {
  const mod = (await import("undici")) as unknown as {
    ProxyAgent?: new (url: string) => unknown;
    Socks5ProxyAgent?: new (url: string) => unknown;
    fetch?: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
    default?: {
      ProxyAgent?: new (url: string) => unknown;
      Socks5ProxyAgent?: new (url: string) => unknown;
      fetch?: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  return {
    ProxyAgent: mod.ProxyAgent ?? mod.default?.ProxyAgent,
    Socks5ProxyAgent: mod.Socks5ProxyAgent ?? mod.default?.Socks5ProxyAgent,
    fetch: mod.fetch ?? mod.default?.fetch,
  };
}

/**
 * Hand undici's fetch an init object whose `signal` is a NATIVE AbortSignal.
 *
 * grammY creates its AbortController from the `abort-controller` polyfill
 * (`out/shim.node.js`), whose AbortSignal is not node's own. node-fetch v2
 * accepts it (it duck-checks `constructor.name`, which `keepNames` preserves),
 * but undici's fetch does a strict `instanceof` check and throws
 * `RequestInit: Expected signal ... to be an instance of AbortSignal`.
 * Bridging preserves grammY's timeout/abort semantics for the proxied path.
 */
function withNativeSignal(init: Record<string, unknown> | undefined, dispatcher: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(init ?? {}), dispatcher };
  const src = init?.["signal"] as { aborted?: boolean; addEventListener?: (t: string, fn: () => void, o?: { once?: boolean }) => void } | undefined;
  if (!src || typeof src !== "object") return base;
  if (src instanceof AbortSignal) return base; // already native
  const ctl = new AbortController();
  if (src.aborted) ctl.abort();
  else if (typeof src.addEventListener === "function") src.addEventListener("abort", () => ctl.abort(), { once: true });
  base["signal"] = ctl.signal;
  return base;
}

/**
 * Validate a proxy URL and build its undici dispatcher, plus a fetch bound to
 * it. Grammy must call THAT fetch, not its default node-fetch: node-fetch v2
 * silently ignores `dispatcher`, which would make the whole proxy setting a
 * no-op (the bot then fails exactly as it did without one).
 *
 * Throws a message naming the config key instead of a minified constructor
 * crash — a placeholder like "http://127.0.0.1:PORT" must say what's wrong.
 */
async function proxyBits(proxy: string): Promise<{ dispatcher: unknown; fetch: (input: unknown, init?: Record<string, unknown>) => Promise<unknown> }> {
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new Error(`channels.telegram.proxy is not a valid proxy URL: "${proxy}" — use e.g. http://127.0.0.1:8080, or clear it for a direct connection`);
  }
  if (!/^(https?|socks)/.test(parsed.protocol)) {
    throw new Error(`channels.telegram.proxy: unsupported scheme "${parsed.protocol}" (use http://, https:// or socks5://): "${proxy}"`);
  }
  const undici = await undiciParts();
  const socks = /^socks/i.test(parsed.protocol);
  const Dispatcher = socks ? undici.Socks5ProxyAgent : undici.ProxyAgent;
  if (typeof Dispatcher !== "function") throw new Error("undici ProxyAgent export unavailable (bundle shape mismatch)");
  if (typeof undici.fetch !== "function") throw new Error("undici fetch export unavailable (bundle shape mismatch)");
  const fetchImpl = undici.fetch;
  // socks:// and socks5h:// mean socks5:// to undici's agent.
  const dispatcher = socks
    ? new Dispatcher(proxy.replace(/^socks(5h)?:/i, "socks5:"))
    : new Dispatcher(proxy);
  return {
    dispatcher,
    fetch: (input, init) => fetchImpl(input, withNativeSignal(init, dispatcher)),
  };
}

/**
 * One Bot API call over plain fetch, honouring the channel's proxy rules.
 *
 * `sc telegram commands` needs this because the command list lives on Telegram's
 * servers: we must read and repair it without starting a channel, and it has to
 * work the same on a carrier that blocks api.telegram.org. Returns the parsed
 * response and never throws — callers report `ok: false` with the reason.
 */
export async function botApiCall<T = unknown>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  proxy = "",
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  if (!/^\d+:[\w-]+$/.test(String(token ?? "").trim())) {
    return { ok: false, error: "that does not look like a bot token (expected <digits>:<secret>)" };
  }
  try {
    type FetchFn = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
    const doFetch: FetchFn = proxy ? ((await proxyBits(proxy)).fetch as FetchFn) : ((fetch as unknown) as FetchFn);
    // Self-hosted Bot API servers (and offline tests) point this elsewhere.
    const base = String(process.env["SUPARCLAW_TELEGRAM_API"] ?? "https://api.telegram.org").replace(/\/$/, "");
    const res = (await doFetch(`${base}/bot${String(token).trim()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    })) as { json: () => Promise<{ ok?: boolean; result?: T; description?: string }> };
    const body = await res.json();
    if (!body.ok) return { ok: false, error: body.description ?? `${method} failed` };
    return { ok: true, result: body.result as T };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** The proxy a channel uses: explicit config first, then the standard env. */
export function telegramProxy(cfgProxy: string | undefined): string {
  const explicit = String(cfgProxy ?? "").trim();
  if (explicit) return explicit;
  for (const key of ["TELEGRAM_PROXY", "telegram_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return "";
}

/**
 * Is api.telegram.org reachable from this device at all? This is what tells
 * "your carrier blocks Telegram — set channels.telegram.proxy" apart from
 * "network is fine, so the credential is wrong" (their connected-flavored
 * diagnosis instead of grammy's bare "Network request failed").
 *
 * When a proxy is configured the probe goes THROUGH it: a proxy that is dead
 * must be reported as a proxy problem, not blamed on the carrier or the token.
 * The default budget is generous (6s) — api.telegram.org is regularly >2.5s
 * from slow mobile links, and a probe that times out reads as "blocked".
 */
export async function probeTelegramApi(timeoutMs = 6000, proxy = ""): Promise<{ ok: boolean; why: string }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(500, timeoutMs));
    try {
      const via = String(proxy ?? "").trim();
      if (via) {
        const { fetch: viaFetch } = await proxyBits(via);
        await viaFetch("https://api.telegram.org/", { signal: ctl.signal });
        return { ok: true, why: "reachable via proxy" };
      }
      await fetch("https://api.telegram.org/", { signal: ctl.signal });
      return { ok: true, why: "reachable" };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, why: describeError(err) };
  }
}

/** Flatten an error + its .cause chain — grammy's wrapper hides the real one.
 *  Grammy's `HttpError` stores the reason in `.error` (NOT `.cause`), and
 *  node-fetch/undici put theirs in `.cause`; `.code` carries ECONNRESET-style
 *  codes. Walk all three or the user only ever sees "Network request failed!". */
export function describeError(err: unknown): string {
  const seen: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const msg = cur instanceof Error ? String(cur.message || cur.name) : String(cur);
    if (!seen.includes(msg)) seen.push(msg);
    const box = cur as { cause?: unknown; code?: unknown; error?: unknown };
    cur = box.cause ?? box.error ?? box.code;
  }
  return seen.join(" | ") || String(err);
}

type GrammyBot = Awaited<ReturnType<typeof createBot>>;

/**
 * Commands only Telegram answers (`#onCommand`). Everything else is handed to
 * the shared router, so this list must stay in sync with that switch — the
 * partition test fails if a name appears in both.
 */
export const TELEGRAM_COMMANDS: { cmd: string; summary: string }[] = [
  { cmd: "/start", summary: "what this bot is, and every command" },
  { cmd: "/new", summary: "start a fresh session — chat, or code a repository" },
  { cmd: "/sessions", summary: "switch to an earlier conversation in this chat" },
  { cmd: "/model", summary: "pick the model for this chat — provider, then model (one tap)" },
  { cmd: "/provider [list|add|remove|test]", summary: "manage model providers" },
  { cmd: "/whoami", summary: "your Telegram id, this chat and its session" },
];

/**
 * Names the operator types that we answer with a shorter one.
 *
 * `/session` and `/thinking` are what people actually reach for; normalising
 * here means one switch to keep in sync rather than an alias branch in every
 * handler, and `/thinking high` still lands on `/think high`.
 */
export const COMMAND_ALIASES: Record<string, string> = { session: "sessions", thinking: "think" };

/** Session key for a chat: the base key, plus `/new`'s rotation tag if set. */
export function telegramSessionKey(chatId: number, tag?: string | null): string {
  return `telegram:${chatId}${tag ? `:${tag}` : ""}`;
}

export interface BotCommand {
  name: string;
  args: string;
}

/**
 * `/name args…`, tolerating a `@botname` suffix so group mentions work.
 * Returns null for ordinary messages.
 */
export function parseCommand(text: string): BotCommand | null {
  const m = /^\/([A-Za-z][\w]*)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = (m[1] as string).toLowerCase();
  return { name: COMMAND_ALIASES[name] ?? name, args: (m[2] ?? "").trim() };
}

interface PendingMessage {
  texts: string[];
  /** Inbound media queued with these texts (P1 A5); placeholders fill on flush. */
  media: InboundMedia[];
  /** Public API for tests: DM chats ride the main-session ask_user surface. */
  isMain?: boolean;
  timer: NodeJS.Timeout;
  firstAt: number;
  /** P3 #24 typing scoping: group vs DM, explicit-mention, forum topic. */
  isGroup?: boolean;
  mentioned?: boolean;
  topicId?: number;
}

export class TelegramChannel {
  #bot: GrammyBot | null = null;
  /**
   * chatId → the repository list the `r:` buttons index.
   *
   * GitHub returns 100 rows a page and we show 10, so the picker accumulates
   * API pages on demand: `items` is everything fetched so far, `done` says
   * whether GitHub has more, and the header can therefore be honest about the
   * page count instead of promising one it has not seen.
   */
  #repoLists = new Map<
    number,
    {
      items: { fullName: string; private: boolean; defaultBranch: string }[];
      done: boolean;
      /** Next GitHub page to pull (1-based). */
      apiPage: number;
      account: AccountRow;
    }
  >();
  /** chatId → the repo picked on the way to the branch keyboard (Task 36). */
  #pickedRepo = new Map<number, { repo: string; base: string; account: AccountRow }>();
  /** chatId → the accounts behind the `a:` buttons (the card that drew them). */
  #accountPages = new Map<number, AccountRow[]>();
  /** chatId → the branch list behind the `b:` buttons. */
  #branchLists = new Map<number, { items: { name: string; default?: boolean; protected?: boolean }[]; done: boolean; apiPage: number }>();
  #pending = new Map<string, PendingMessage>();
  #username = "";
  #botId = 0;
  /** Bot-to-bot pair guard (P2 #17). */
  #botGuard = new BotLoopGuard();
  running = false;

  constructor(
    private readonly service: Service,
    private readonly log: Logger,
  ) {}

  get username(): string {
    return this.#username;
  }

  /**
   * Proactive outbound text (P2 cron delivery/alerts + later approval cards):
   * chunked by the usual rule; hard errors propagate for the caller to log.
   */
  async sendText(chatId: number, text: string): Promise<void> {
    const bot = this.#bot;
    if (!bot) throw new Error("telegram bot not running");
    // Same rule as a turn's answer: a transient failure is retried, a markup
    // rejection falls back to plain text, and a message is never dropped just
    // because one call failed.
    const send = async (body: string, extra: Record<string, unknown>): Promise<boolean> => {
      for (let i = 0; ; i++) {
        try {
          await bot.api.sendMessage(chatId, body, extra);
          return true;
        } catch (err) {
          const retry = i < 2 && isTransientTelegramError(err);
          if (!retry) {
            this.log.warn(`telegram: sendText failed — ${(err as Error).message}`);
            return false;
          }
          await new Promise<void>((r) => setTimeout(r, i === 0 ? 400 : 1500));
        }
      }
    };
    for (const chunk of telegramChunks(text)) {
      const ok = await send(chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      if (!ok) {
        this.log.warn("telegram: HTML send rejected — falling back to plain text");
        await send(stripHtmlTags(chunk), {});
      }
    }
  }

  /**
   * Final-answer delivery: Markdown → Telegram HTML, chunked, with a plain-text
   * fallback so a formatting rejection never swallows the answer.
   */
  async #sendFormatted(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const bot = this.#bot;
    if (!bot) return;
    for (const chunk of telegramChunks(text)) {
      const ok = await bot.api
        .sendMessage(chatId, chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra })
        .catch(() => null);
      if (!ok) {
        this.log.warn("telegram: HTML reply rejected — falling back to plain text");
        await bot.api.sendMessage(chatId, stripHtmlTags(chunk), extra).catch(() => {});
      }
    }
  }

  async start(): Promise<void> {
    const cfg = this.service.config.channels.telegram;
    if (!cfg.token) throw new Error("telegram.token is empty");

    const bot = await createBot(cfg.token, telegramProxy((cfg as { proxy?: string }).proxy));
    this.#bot = bot;

    bot.on("message", (ctx) => {
      void this.#onMessage(ctx).catch((err) => this.log.error(`telegram message failed: ${(err as Error).message}`));
    });
    // ask_user and picker buttons (P2 #8, Tasks 54/55): one callback router.
    bot.on("callback_query:data", (ctx) => {
      void this.#onCallbackQuery(ctx).catch((err) => this.log.error(`telegram callback failed: ${(err as Error).message}`));
    });

    const me = await bot.api.getMe();
    this.#username = me.username;
    this.#botId = me.id;
    this.running = true;
    this.log.info(`telegram online as @${me.username}`);
    await this.#registerCommandMenu(bot);

    // Long polling: no inbound port needed, ideal behind mobile NAT.
    void bot
      .start({
        drop_pending_updates: false,
        onStart: (info) => this.log.info(`telegram polling @${info.username}`),
      })
      .catch((err: Error) => {
        this.running = false;
        this.log.error(`telegram polling stopped: ${err.message}`);
      });
  }

  async stop(): Promise<void> {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    try {
      await this.#bot?.stop();
    } catch {
      /* ignore */
    }
    this.running = false;
  }

  #paired(userId: number): boolean {
    const cfg = this.service.config.channels.telegram;
    return cfg.allowFrom.includes(String(userId));
  }

  /**
   * Button taps: `qu:<setId>:<qid>:<n|other|skip>` (ask_user, P2 #8) and
   * pickers share one router — only PAIRED users may tap, and the card is
   * edited in place to the outcome (Task 55: no approval cards remain).
   */
  async #onCallbackQuery(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const fromId = ctx.from?.id;
    // Task 54: a control acts on the CHAT, not on the person who tapped. In a
    // DM the two ids are equal, which is why this was invisible for so long; in
    // a group every picker used to read a bucket keyed by the user and answered
    // "This picker expired" (or bound the user's DM session instead).
    const chatId = ctx.chat?.id ?? fromId;
    if (chatId === undefined || fromId === undefined || !data) return;
    const cfg = this.service.config.channels.telegram;
    if (!this.#paired(fromId)) {
      await ctx.answerCallbackQuery({ text: "Only paired users can decide this", show_alert: true }).catch(() => {});
      return;
    }
    void cfg;
    const parts = data.split(":");
    const kind = parts[0];

    // `appr:` used to resolve an exec card. Task 55 removed the cards (and the
    // wait behind them), so a stale one in an old chat must not resurrect a
    // decision: answer that it is obsolete instead of resolving anything.
    if (kind === "appr") {
      await ctx.answerCallbackQuery({ text: "Approvals are no longer used — the agent just runs" }).catch(() => {});
      return;
    }

    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

    if (kind === "s") {
      // Sessions: `s:<page>:<slot>:<hash>` enters, `s:p:<page>` pages, `s:n` is
      // the same rotation `/new` runs.
      const tap = readSessionTap(data);
      if (!tap) return;
      if (tap.kind === "new") {
        await ctx.answerCallbackQuery({ text: "new session" }).catch(() => {});
        await this.#startNew(chatId, ctx);
        return;
      }
      if (tap.kind === "page") {
        await ctx.answerCallbackQuery({ text: "…" }).catch(() => {});
        await this.#sendSessionsCard(chatId, tap.page, ctx);
        return;
      }
      const active = this.#sessionKeyFor(chatId);
      const target = this.#chatSessions(chatId)[tap.slot];
      if (!target || shortHash(target.key) !== tap.hash) {
        await ctx.answerCallbackQuery({ text: "This picker expired — send /sessions again", show_alert: true }).catch(() => {});
        return;
      }
      if (target.key === active) {
        await ctx.answerCallbackQuery({ text: "You are already here" }).catch(() => {});
        return;
      }
      // Switching away mid-turn would deliver the running answer to a
      // transcript the user is no longer looking at.
      if (this.service.loop.isBusy(active)) {
        await ctx.answerCallbackQuery({ text: "Still working — /stop first, then switch", show_alert: true }).catch(() => {});
        return;
      }
      const card = await this.#enterSession(chatId, target.key);
      await ctx.answerCallbackQuery({ text: "switched" }).catch(() => {});
      await this.#editCard(ctx, card);
      return;
    }

    if (kind === "t") {
      // Thinking effort: seven answers, one column, the same writer the text
      // form uses.
      const tap = readThinkingTap(data);
      if (!tap) return;
      if (tap.kind === "open") {
        await ctx.answerCallbackQuery({ text: "…" }).catch(() => {});
        await this.#sendThinkingCard(chatId, isGroup, ctx);
        return;
      }
      this.service.store.setSessionThinking(this.#sessionKeyFor(chatId), tap.level);
      await ctx.answerCallbackQuery({ text: tap.level ? `thinking ${tap.level}` : "thinking default" }).catch(() => {});
      await this.#editCard(
        ctx,
        thinkingSetCard({ level: tap.level, fallback: this.service.config.agents.defaults.reasoningEffort, group: isGroup }),
      );
      return;
    }

    if (kind === "a") {
      // Account: `a:<index>:<hash of the source>`, so a list that changed under
      // the card cannot bind with a login the user did not pick.
      const idx = readAccountTap(data);
      if (idx === null) return;
      const account = this.#accountPages.get(chatId)?.[idx];
      if (!account || parts[2] !== shortHash(account.source)) {
        await ctx.answerCallbackQuery({ text: "This picker expired — send /code again", show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: `@${account.login}`.slice(0, 180) }).catch(() => {});
      this.#repoLists.set(chatId, { items: [], done: false, apiPage: 1, account });
      await this.#sendRepos(chatId, 0, ctx);
      return;
    }

    if (kind === "n") {
      // Chat or code. `n:c` starts the chat that `/new` already rotated to;
      // `n:k` asks which GitHub account before anything is listed or cloned.
      const choice = parts[1];
      if (choice !== "c" && choice !== "k") return;
      const key = this.#sessionKeyFor(chatId);
      await ctx.answerCallbackQuery({ text: choice === "c" ? "chat" : "which account?" }).catch(() => {});
      if (choice === "c") {
        await ctx.editMessageText(`💬 Chat session ${key} — say anything to begin.`).catch(() => {});
        return;
      }
      await this.#sendAccounts(chatId, ctx);
      return;
    }

    if (kind === "r") {
      // Repositories: `r:<page>:<slot>` selects, `r:p:<page>` pages, `r:a` is
      // the way back to the account list. The slot indexes the list held for
      // this chat, so a callback stays tiny and never carries `owner/name`.
      const tap = readRepoTap(data);
      if (!tap) return;
      if (tap.kind === "accounts") {
        await ctx.answerCallbackQuery({ text: "…" }).catch(() => {});
        await this.#sendAccounts(chatId, ctx);
        return;
      }
      if (tap.kind === "page") {
        await ctx.answerCallbackQuery({ text: "…" }).catch(() => {});
        await this.#sendRepos(chatId, tap.page, ctx);
        return;
      }
      const list = this.#repoLists.get(chatId);
      const repo = list?.items[tap.slot];
      if (!list || !repo) {
        await ctx.answerCallbackQuery({ text: "This picker expired — send /code again", show_alert: true }).catch(() => {});
        return;
      }
      // Task 36: one more question — which branch to continue — before anything
      // is cloned, so the worktree is checked out on the right branch first time.
      this.#pickedRepo.set(chatId, { repo: repo.fullName, base: repo.defaultBranch, account: list.account });
      this.#branchLists.set(chatId, { items: [], done: false, apiPage: 1 });
      await ctx.answerCallbackQuery({ text: repo.fullName.slice(0, 180) }).catch(() => {});
      await this.#sendBranches(chatId, 0, ctx);
      return;
    }

    if (kind === "b") {
      // Branches: `b:<page>:<slot>` binds, `b:p:<page>` pages, `b:r` goes back.
      const tap = readBranchTap(data);
      if (!tap) return;
      const pick = this.#pickedRepo.get(chatId);
      if (!pick) {
        await ctx.answerCallbackQuery({ text: "Pick a repository first — /code", show_alert: true }).catch(() => {});
        return;
      }
      if (tap.kind === "repos") {
        await ctx.answerCallbackQuery({ text: "…" }).catch(() => {});
        await this.#sendRepos(chatId, 0, ctx);
        return;
      }
      if (tap.kind === "page") {
        await ctx.answerCallbackQuery({ text: "…" }).catch(() => {});
        await this.#sendBranches(chatId, tap.page, ctx);
        return;
      }
      const branch = this.#branchLists.get(chatId)?.items[tap.slot];
      if (!branch) {
        await ctx.answerCallbackQuery({ text: "This picker expired — send /code again", show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: branch.name.slice(0, 180) }).catch(() => {});
      const key = this.#sessionKeyFor(chatId);
      const bound = await this.service.bindRepo({
        sessionKey: key,
        repo: pick.repo,
        base: pick.base,
        branch: branch.name,
        // The login the list came from — never a different one than the user saw.
        source: pick.account.source,
      });
      this.#pickedRepo.delete(chatId);
      this.#branchLists.delete(chatId);
      this.#repoLists.delete(chatId);
      await ctx
        .editMessageText(bound.ok ? `${this.#boundLine(bound)}\nAsk for a change, then /diff to review and /pr to publish.` : bound.error)
        .catch(() => {});
      return;
    }

    if (kind === "p") {
      // The publish card's three answers. Draft is the default; "open" is a
      // separate tap, and cancel says plainly that nothing happened.
      const choice = parts[1];
      if (choice !== "d" && choice !== "o" && choice !== "x") return;
      const key = this.#sessionKeyFor(chatId);
      if (choice === "x") {
        await ctx.answerCallbackQuery({ text: "nothing published" }).catch(() => {});
        await ctx.editMessageText("Publish cancelled — nothing left this machine.").catch(() => {});
        return;
      }
      const binding = this.service.store.getSessionRepo(key);
      if (!binding) {
        await ctx.answerCallbackQuery({ text: "no repository in this session" }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: choice === "d" ? "opening a draft…" : "opening…" }).catch(() => {});
      try {
        const res = await this.service.repos.publish({
          workspace: binding.workspace,
          repo: binding.repo,
          base: binding.base,
          branch: binding.branch,
          creds: this.service.githubCreds(),
          title: `Changes from ${key.replace(/^telegram:/, "")}`,
          draft: choice === "d",
          sessionKey: key,
        });
        await ctx
          .editMessageText(
            `${res.draft ? "Draft pull request" : "Pull request"} #${res.prNumber} opened\n${res.prUrl}\nbranch ${res.branch}`,
            { link_preview_options: { is_disabled: false } },
          )
          .catch(() => {});
      } catch (err) {
        await ctx.editMessageText(`could not publish — ${(err as Error).message}`).catch(() => {});
      }
      return;
    }

    if (kind === "m") {
      // `/model`: providers, then that provider's selected models, then pin.
      // The decision lives in telegram-model-menu.ts (pure, tested); this branch
      // performs the effect and paints the returned card in place.
      const key = this.#sessionKeyFor(chatId);
      const effect = applyModelTap(
        {
          config: this.service.config,
          pin: this.#pinFor(chatId),
          setPin: (model) => this.service.store.setSessionModel(key, model),
          makeDefault: (model) => {
            const saved = this.service.configSvc.setPath("agents.defaults.model", model);
            if (saved.ok) this.service.applyConfig();
            return { ok: saved.ok, error: saved.errors.join("; ") };
          },
        },
        data,
      );
      if (effect.kind === "error") {
        await ctx.answerCallbackQuery({ text: effect.alert.slice(0, 180), show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: "✓" }).catch(() => {});
      if (effect.kind === "default") {
        await ctx.editMessageText(effect.text).catch(() => {});
        return;
      }
      await this.#editCard(ctx, effect.card);
      return;
    }

    if (kind === "qu") {
      // ask_user answer buttons.
      const [, setId, qid, choice] = parts;
      if (!setId || !qid || !choice) return;
      const set = this.service.pendingQuestionForId(setId);
      if (!set) {
        await ctx.answerCallbackQuery({ text: "Already resolved" }).catch(() => {});
        return;
      }
      const q = set.questions.find((qq) => qq.id === qid);
      if (!q) return;
      if (choice === "other") {
        this.service.questionNeedsOther(setId, qid);
        await ctx.answerCallbackQuery({ text: "Reply with your own words" }).catch(() => {});
        await ctx.editMessageText(`❓ ${q.question}\n\n✏️ Reply with your own words (next message is the answer for this question).`).catch(() => {});
        return;
      }
      if (choice === "skip") {
        this.service.answerQuestionPart(setId, qid, [], { skip: true });
        await ctx.answerCallbackQuery({ text: "Skipped" }).catch(() => {});
        await ctx.editMessageText(`❓ ${q.question}\n\n⏭ skipped`).catch(() => {});
        return;
      }
      const idx = Number(choice);
      const value = q.options[idx];
      if (value === undefined) return;
      this.service.answerQuestionPart(setId, qid, [value]);
      await ctx.answerCallbackQuery({ text: value.slice(0, 180) }).catch(() => {});
      await ctx.editMessageText(`❓ ${q.question}\n\n✔ ${value}`).catch(() => {});
      return;
    }
  }

  #groupAllowed(chatId: number): boolean {
    const cfg = this.service.config.channels.telegram;
    return cfg.groupPolicy === "open" || cfg.groupAllowFrom.includes(String(chatId));
  }

  async #onMessage(ctx: Context): Promise<void> {
    const cfg = this.service.config.channels.telegram;
    const msg = ctx.message;
    if (!msg) return;

    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    if (chatId === undefined || fromId === undefined) return;

    // Bot-loop protection (P2 #17): messages AUTHORED by other bots are
    // refused by default (allowBots:false); admitted bot pairs are bounded by
    // a sliding-window budget with a cooldown once the budget bursts. Our own
    // messages are already filtered by Telegram (is_bot echo never re-arrives
    // as a user message); human messages never touch this path.
    if (ctx.from?.is_bot === true && fromId !== this.#botId) {
      if (!cfg.allowBots) return;
      const shared = this.service.config.channels.defaults.botLoopProtection;
      const local = cfg.botLoopProtection;
      const merged = {
        enabled: local.enabled ?? shared.enabled,
        maxEventsPerWindow: local.maxEventsPerWindow ?? shared.maxEventsPerWindow,
        windowSeconds: local.windowSeconds ?? shared.windowSeconds,
        cooldownSeconds: local.cooldownSeconds ?? shared.cooldownSeconds,
      };
      if (!this.#botGuard.admit(String(fromId), String(this.#botId), String(chatId), merged)) {
        const remaining = this.#botGuard.cooldownRemaining(String(fromId), String(this.#botId), String(chatId));
        this.log.warn(
          remaining > 0
            ? `telegram: bot-pair budget exceeded for ${fromId} — suppressing for ${remaining}s`
            : `telegram: bot-authored message from ${fromId} suppressed (cooldown)`,
        );
        return;
      }
    }

    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    const text = msg.text ?? msg.caption ?? "";
    const mentioned = this.#username.length > 0 && text.includes(`@${this.#username}`);
    const replyToBot = msg.reply_to_message
      ? await this.#isFromBot(ctx, msg.reply_to_message.from?.id)
      : false;

    if (isGroup) {
      if (cfg.groupPolicy === "off" || !this.#groupAllowed(chatId)) return;
      if (cfg.mentionGated && !mentioned && !replyToBot) return;
      if (!mentioned && replyToBot) {
        // strip the bot mention noise from the body
      }
    } else {
      if (cfg.dmPolicy === "allowlist" && !this.#paired(fromId)) {
        await ctx.reply(
          `Not allowed yet. Ask the owner to run:\n\n  sc pair approve ${fromId}`,
        );
        return;
      }
      if (cfg.dmPolicy === "pairing" && !this.#paired(fromId)) {
        await ctx.reply(
          `Pairing required for this account.\n\nOwner command:\n  sc pair approve ${fromId}\n\nYour Telegram id: ${fromId}`,
        );
        return;
      }
    }

    // Inbound media (P1 A5): captions double as the message text; media-only
    // messages must still reach the agent (a photo with no caption is a turn).
    const media = planInboundMedia(msg as unknown as Record<string, unknown>);
    if (!text.trim() && media.length === 0) return;

    const command = parseCommand(text);
    if (command && media.length === 0) {
      const handled = await this.#onCommand(ctx, command, { chatId, isGroup });
      // Not ours → keep going: the shared router answers it below with the same
      // session, typing indicator and reply pipeline as any other message.
      if (handled) return;
    }

    const key = `${chatId}`;
    const topicId = (msg as { message_thread_id?: number }).message_thread_id;
    // Session keying lives in #sessionKeyFor (rotation-aware); batching is per chat.

    const isCommand = command !== null;
    const existing = this.#pending.get(key);
    if (existing) {
      if (text.trim()) existing.texts.push(text);
      existing.media.push(...media);
      clearTimeout(existing.timer);
      if (isCommand) {
        void this.#flush(key);
        return;
      }
      existing.timer = setTimeout(() => void this.#flush(key), cfg.batchMs);
      return;
    }
    const entry: PendingMessage = {
      texts: text.trim() ? [text] : [],
      media: [...media],
      // ask_user (P2 #8): a DM with the owner IS the operator's main surface
      // (their "telegram is a supported main-session surface"); groups are not.
      isMain: !isGroup,
      isGroup,
      mentioned,
      topicId,
      firstAt: Date.now(),
      timer: setTimeout(() => void this.#flush(key), cfg.batchMs),
    };
    this.#pending.set(key, entry);
    if (isCommand) {
      // A command is a standalone message: no reason to sit in the batch window.
      clearTimeout(entry.timer);
      void this.#flush(key);
    }
  }

  /**
   * Commands this surface owns. Everything else returns false and falls back to
   * the ordinary message path, where `Service.#commands` answers it — the same
   * router the TUI and the web chat use. Returning false instead of replying
   * "unknown command" is what makes /stop, /usage, /compact, /title, /dream and
   * the rest reachable from Telegram at all (Task 27).
   */
  async #onCommand(
    ctx: Context,
    cmd: BotCommand,
    scope: { chatId: number; isGroup: boolean },
  ): Promise<boolean> {
    const reply = async (body: string): Promise<boolean> => {
      await ctx
        .reply(body.slice(0, 4000), { link_preview_options: { is_disabled: true } })
        .catch((err: unknown) => this.log.warn(`telegram reply failed: ${(err as Error).message}`));
      return true;
    };

    const cfgSvc = this.service.configSvc;
    const [sub = "", ...rest] = cmd.args.split(/\s+/).filter(Boolean);

    switch (cmd.name) {
      case "start":
        return reply(
          [
            "SuparClaw is online.",
            "",
            slashHelp(),
            "",
            "Anything that is not a command is sent to the agent.",
          ].join("\n"),
        );

      case "whoami": {
        const from = ctx.from?.id;
        return reply(
          [
            `you:    ${from ?? "?"}${ctx.from?.username ? ` (@${ctx.from.username})` : ""}`,
            `chat:   ${scope.chatId}${scope.isGroup ? " (group)" : " (dm)"}`,
            `session: ${this.#sessionKeyFor(scope.chatId)}`,
            // What is actually answering, and which build is doing it. Two
            // questions that used to be unanswerable from a phone (Task 56):
            // "did the model change?" and "did the update land?".
            `model:  ${(() => {
              const cur = currentModel(this.service.config, this.#pinFor(scope.chatId));
              return cur.pin ? `${cur.label} — this chat\n        ref: ${cur.ref}` : `default — ${cur.label}`;
            })()}`,
            `exec:   ${execModeOf(this.service.config.tools.exec)} — nothing asks for permission`,
            `build:  ${BUILD_STAMP}`,
            `paired: ${from !== undefined && this.#paired(from) ? "yes" : `no — sc pair approve ${from ?? "?"}`}`,
          ].join("\n"),
        );
      }

      case "new":
        return this.#startNew(scope.chatId);

      case "sessions": {
        // Task 54b: the chat can look at any of its own conversations. The
        // pointer lives in meta, so this is a switch, not a copy. The card
        // opens on the page that holds the current one — a ✓ on page 4 is a ✓
        // nobody sees.
        const active = this.#sessionKeyFor(scope.chatId);
        const at = this.#chatSessions(scope.chatId).findIndex((row) => row.key === active);
        await this.#sendSessionsCard(scope.chatId, at > 0 ? Math.floor(at / PICKER_PAGE) : 0);
        return true;
      }

      case "think": {
        // No argument: the levels as buttons. With one: `false`, so `/think
        // high` reaches the shared router and the text form stays the single
        // implementation for every surface.
        if (sub) return false;
        await this.#sendThinkingCard(scope.chatId, scope.isGroup);
        return true;
      }

      case "code": {
        // `/code owner/name` binds now; `/code` alone shows the picker. The
        // session key is stable across the picker, so the binding lands on the
        // conversation the user is looking at.
        const target = sub;
        if (target) {
          if (!target.includes("/")) return reply("usage: /code owner/name [branch]");
          if (this.service.loop.isBusy(this.#sessionKeyFor(scope.chatId))) {
            return reply("a run is active — /code again when it settles");
          }
          const bound = await this.service.bindRepo({
            sessionKey: this.#sessionKeyFor(scope.chatId),
            repo: target,
            // Task 36: `[branch]` is the branch to continue, not one to create.
            branch: rest[0],
          });
          return reply(bound.ok ? this.#boundLine(bound) : bound.error);
        }
        // Task 54b: the coding flow now starts by asking *which account*, since
        // the repositories, the branches and the clone all depend on it.
        return this.#startCode(scope.chatId);
      }

      case "pr": {
        // Publishing is never implied: this card is the whole gate on Telegram,
        // and the draft option is the default-shaped choice.
        const key = this.#sessionKeyFor(scope.chatId);
        const binding = this.service.store.getSessionRepo(key);
        if (!binding) return reply("this chat is not working in a repository — /code first");
        const st = await this.service.repos.status(binding.workspace);
        if (st.clean) return reply("nothing to publish — no changes in this session");
        await this.#requireBot().api
          .sendMessage(scope.chatId, `Publish ${st.files.length} file(s) (+${st.added} −${st.removed}) from ${binding.branch}?`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Draft PR", callback_data: "p:d" },
                  { text: "Open PR", callback_data: "p:o" },
                  { text: "Cancel", callback_data: "p:x" },
                ],
              ],
            },
          })
          .catch((err: unknown) => this.log.warn(`telegram: publish card failed: ${(err as Error).message}`));
        return true;
      }

      case "model": {
        // Task 54: the picker is the interface — provider, then model, all
        // buttons. Typing still works (`/model <ref>`) because it is in people's
        // fingers and in the docs, and `/model default` undoes a pin.
        const key = this.#sessionKeyFor(scope.chatId);
        if (!sub) return this.#sendModelCard(scope.chatId);
        const read = readModelArgument(this.service.config, sub);
        if (read.action === "help") {
          return reply(
            "usage: /model — pick a provider, then a model\n" +
              "       /model <provider/model> — pin it by name\n" +
              "       /model default — follow the configured default again",
          );
        }
        if (read.action === "clear") {
          this.service.store.setSessionModel(key, null);
          const cur = currentModel(this.service.config, null);
          return reply(`model: default${cur.defLabel ? ` (${cur.defLabel})` : ""} — this chat follows it`);
        }
        // A bare model id ("kilo/nvidia/x") is stored as "<provider>/<id>".
        const canonical = canonicalModelRef(this.service.config, read.pin) ?? read.pin;
        this.service.store.setSessionModel(key, canonical);
        const names = Object.keys(this.service.config.providers ?? {});
        const hint =
          canonical === sub && names.length && !names.includes(sub.split("/")[0] ?? "")
            ? `\nheads up: "${sub}" does not start with a provider name (${names.join(", ")})`
            : "";
        return reply(`model for this chat: ${read.label}\nthis chat only — /model default to go back · /model for the list${hint}`);
      }

      case "provider": {
        switch (sub) {
          case "":
          case "list":
            return reply(formatProviders(this.service.config));
          case "add": {
            const opts = parseProviderAddArgs(cmd.args.split(/\s+/).filter(Boolean).slice(1));
            if (!opts.name) {
              return reply("usage: /provider add <name> [baseUrl|apiKey] [apiKey] [models,a,b]");
            }
            const added = await addProvider(cfgSvc, opts.name, opts);
            if (added.ok) this.service.applyConfig();
            return reply(added.message);
          }
          case "remove": {
            if (!rest[0]) return reply("usage: /provider remove <name>");
            const removed = removeProvider(cfgSvc, rest[0]);
            if (removed.ok) this.service.applyConfig();
            return reply(removed.message);
          }
          case "test": {
            if (!rest[0]) return reply("usage: /provider test <name>");
            const tested = await testProvider(this.service.config, rest[0]);
            return reply(tested.message);
          }
          default:
            return reply(`unknown /provider ${sub} — try: list, add, remove, test`);
        }
      }

      default:
        // Not ours: `#onMessage` lets it through to the shared router.
        return false;
    }
  }

  /** The bot handle, or a thrown error a command can turn into a sentence. */
  #requireBot(): GrammyBot {
    if (!this.#bot) throw new Error("telegram is not running");
    return this.#bot;
  }

  /**
   * One page of the repo picker (Task 35). `callback_data` is `r:<page>:<slot>`
   * — 8 bytes at most, and never `owner/name`: a long org path plus a private
   * repo would blow past Telegram's 64-byte cap, and the failure is silent.
   * The slot indexes a list we hold per chat, so a gateway restart expires the
   * buttons rather than binding the wrong repository.
   */
  /** Send a card (a command asked for it, so there is no message to edit). */
  async #postCard(chatId: number, card: Card): Promise<void> {
    const api = this.#requireBot().api;
    const body = card.text.slice(0, 4000);
    const sent = card.keyboard
      ? api.sendMessage(chatId, body, { reply_markup: { inline_keyboard: card.keyboard }, link_preview_options: { is_disabled: true } })
      : api.sendMessage(chatId, body, { link_preview_options: { is_disabled: true } });
    await sent.catch((err: unknown) => this.log.warn(`telegram: card failed: ${(err as Error).message}`));
  }

  /**
   * `/new` — rotate to a fresh session, then ask chat-or-code.
   *
   * The rotation is the only thing that creates sessions (unchanged since Task
   * 27), which is why the sessions card's `＋ New session` button calls this and
   * not its own copy. The model pin is carried over: it is a choice about the
   * chat, not about one transcript.
   */
  async #startNew(chatId: number, ctx?: Context): Promise<boolean> {
    const previous = this.#sessionKeyFor(chatId);
    const carried = this.#pinFor(chatId);
    this.service.store.setMeta(`telegram:sess:${chatId}`, Date.now().toString(36));
    // The pointer would otherwise keep the chat in the session it was looking
    // at, and `/new` would appear to do nothing.
    this.service.store.setMeta(`telegram:active:${chatId}`, "");
    const key = this.#sessionKeyFor(chatId);
    if (carried) this.service.store.setSessionModel(key, carried);
    const card = newSessionCard({ key, previous });
    // A tap has a message to edit (one bubble for the whole flow); the command
    // has none, so it posts.
    if (ctx) await this.#editCard(ctx, card);
    else await this.#postCard(chatId, card);
    return true;
  }

  /** `/sessions` and its pages: every conversation this chat has had. */
  async #sendSessionsCard(chatId: number, page: number, ctx?: Context): Promise<void> {
    const active = this.#sessionKeyFor(chatId);
    const card = sessionsCard({ sessions: this.#chatSessions(chatId), active, page, now: Date.now() });
    if (ctx) await this.#editCard(ctx, card);
    else await this.#postCard(chatId, card);
  }

  /** `/think` (alias `/thinking`) with no argument: the levels as buttons. */
  async #sendThinkingCard(chatId: number, isGroup: boolean, ctx?: Context): Promise<void> {
    const key = this.#sessionKeyFor(chatId);
    const row = this.service.store.getSessionByKey(key);
    const card = thinkingCard({
      current: (row?.thinking as string | null | undefined) ?? null,
      fallback: this.service.config.agents.defaults.reasoningEffort,
      group: isGroup,
    });
    if (ctx) await this.#editCard(ctx, card);
    else await this.#postCard(chatId, card);
  }

  /**
   * Enter a session: write the pointer, and say which one — with the model and
   * the effort that session will actually use, so the answer is not a surprise.
   */
  async #enterSession(chatId: number, key: string): Promise<Card> {
    this.service.store.setMeta(`telegram:active:${chatId}`, key);
    const row = this.service.store.getSessionByKey(key);
    const pin = String(row?.model ?? "").trim();
    const label = (value: string): string => (value ? modelProfile(this.service.config, value).label || value : "");
    const model = pin ? `${label(pin)} (this session)` : `${label(this.service.config.agents.defaults.model) || "(unset)"} (default)`;
    const effort = String(row?.thinking ?? "").trim();
    return switchedCard({ title: sessionTitle({ key, name: row?.name ?? null }), key, model, thinking: effort || "inherit" });
  }

  // ── coding: account → repositories → branches ───────────────────────────

  /** First question of the coding flow: which login? */
  async #sendAccounts(chatId: number, ctx?: Context): Promise<void> {
    let accounts: AccountRow[] = [];
    try {
      accounts = await this.service.githubAccounts();
    } catch (err) {
      await this.#postCard(chatId, unconfiguredGithubCard((err as Error).message));
      return;
    }
    if (accounts.length === 0) {
      await this.#postCard(chatId, unconfiguredGithubCard("no usable login was found"));
      return;
    }
    this.#accountPages.set(chatId, accounts);
    const card = accountCard({ accounts, current: this.#pickedRepo.get(chatId)?.account.source ?? null });
    if (ctx) await this.#editCard(ctx, card);
    else await this.#postCard(chatId, card);
  }

  /** Start the flow, from `/code` or from the Chat/Code card. */
  async #startCode(chatId: number): Promise<boolean> {
    await this.#sendAccounts(chatId);
    return true;
  }

  /** Pull GitHub pages until `need` rows are in hand (or GitHub runs out). */
  async #ensureRepos(chatId: number, need: number): Promise<string | null> {
    const list = this.#repoLists.get(chatId);
    if (!list) return "This picker expired — send /code again";
    while (!list.done && list.items.length < need) {
      try {
        const rows = await this.service.githubRepos({ page: list.apiPage, perPage: 100, source: list.account.source });
        const seen = new Set(list.items.map((r) => r.fullName));
        for (const row of rows) if (!seen.has(row.fullName)) list.items.push({ fullName: row.fullName, private: row.private, defaultBranch: row.defaultBranch });
        list.apiPage += 1;
        if (rows.length < 100) list.done = true;
      } catch (err) {
        return `could not list repositories — ${(err as Error).message}`;
      }
    }
    return null;
  }

  /** The repository page, ten at a time. */
  async #sendRepos(chatId: number, page: number, ctx?: Context): Promise<void> {
    const list = this.#repoLists.get(chatId);
    if (!list) {
      if (ctx) await ctx.answerCallbackQuery({ text: "This picker expired — send /code again", show_alert: true }).catch(() => {});
      return;
    }
    const problem = await this.#ensureRepos(chatId, (page + 1) * PICKER_PAGE);
    if (problem) {
      await this.#postCard(chatId, { text: problem, keyboard: [[{ text: "‹ Accounts", callback_data: "r:a" }]] });
      return;
    }
    const card = repoCard({
      repos: list.items,
      account: list.account,
      page,
      total: list.items.length,
      done: list.done,
    });
    if (ctx) await this.#editCard(ctx, card);
    else await this.#postCard(chatId, card);
  }

  /** Pull branch pages until `need` rows are in hand (or GitHub runs out). */
  async #ensureBranches(chatId: number, need: number): Promise<string | null> {
    const list = this.#branchLists.get(chatId);
    const pick = this.#pickedRepo.get(chatId);
    if (!list || !pick) return "This picker expired — send /code again";
    while (!list.done && list.items.length < need) {
      try {
        const rows = await this.service.githubBranches({
          repo: pick.repo,
          base: pick.base,
          page: list.apiPage,
          perPage: 100,
          source: pick.account.source,
        });
        const seen = new Set(list.items.map((b) => b.name));
        for (const row of rows) if (!seen.has(row.name)) list.items.push(row);
        list.apiPage += 1;
        if (rows.length < 100) list.done = true;
      } catch (err) {
        return `could not list branches — ${(err as Error).message}`;
      }
    }
    return null;
  }

  /** The branch page — the branch the session will *continue*. */
  async #sendBranches(chatId: number, page: number, ctx?: Context): Promise<void> {
    const pick = this.#pickedRepo.get(chatId);
    if (!pick) {
      if (ctx) await ctx.answerCallbackQuery({ text: "Pick a repository first — /code", show_alert: true }).catch(() => {});
      return;
    }
    const problem = await this.#ensureBranches(chatId, (page + 1) * PICKER_PAGE);
    if (problem) {
      await this.#postCard(chatId, { text: problem, keyboard: [[{ text: "‹ Repos", callback_data: "b:r" }]] });
      return;
    }
    const list = this.#branchLists.get(chatId)!;
    const card = branchCard({ repo: pick.repo, branches: list.items, page, total: list.items.length, done: list.done, base: pick.base });
    if (ctx) await this.#editCard(ctx, card);
    else await this.#postCard(chatId, card);
  }

  /** The one sentence every surface says after a bind. */
  #boundLine(bound: { repo: string; branch: string; base: string }): string {
    return bound.branch === bound.base
      ? `⌘ working in ${bound.repo} · ${bound.branch} (the default branch)`
      : `⌘ working in ${bound.repo} · ${bound.branch} (from ${bound.base})`;
  }

  /**
   * Which session this chat is in.
   *
   * Two mechanisms, in priority order: the **pointer** `/sessions` writes (an
   * absolute key, honoured only while that row still exists and belongs to this
   * chat) and the **rotation tag** `/new` writes. One resolver, because `/diff`,
   * `/pr`, `/status`, media and the repo binding all ask this question — a
   * switch implemented at the message site would leave them on the old session.
   */
  #sessionKeyFor(chatId: number): string {
    const active = this.service.store.getMeta(`telegram:active:${chatId}`);
    return resolveActiveSession(chatId, {
      active,
      tag: this.service.store.getMeta(`telegram:sess:${chatId}`),
      exists: (key) => Boolean(this.service.store.getSessionByKey(key)),
    });
  }

  /** This chat's sessions, newest first — the card and a tap must agree. */
  #chatSessions(chatId: number): ReturnType<Service["store"]["listSessions"]> {
    return this.service.store
      .listSessions(500)
      .filter((row: { key: string }) => isSessionOfChat(row.key, chatId))
      .sort((a: { last_msg_at?: number | null }, b: { last_msg_at?: number | null }) => Number(b.last_msg_at ?? 0) - Number(a.last_msg_at ?? 0));
  }

  /** Task 54: the model pinned to this chat's session ("" = the default). */
  #pinFor(chatId: number): string {
    return String(this.service.store.getSessionByKey(this.#sessionKeyFor(chatId))?.model ?? "");
  }

  /** Paint a picker card in place — one message, no new bubbles per tap. */
  async #editCard(ctx: Context, card: Card): Promise<void> {
    await ctx
      .editMessageText(card.text, card.keyboard ? { reply_markup: { inline_keyboard: card.keyboard } } : {})
      .catch(() => {});
  }

  /** `/model` with no argument: the provider list, as buttons. */
  async #sendModelCard(chatId: number, page = 0): Promise<boolean> {
    const card = providerCard({ config: this.service.config, pin: this.#pinFor(chatId), page });
    await this.#requireBot().api
      .sendMessage(chatId, card.text, card.keyboard ? { reply_markup: { inline_keyboard: card.keyboard } } : {})
      .catch((err: unknown) => this.log.warn(`telegram: model card failed — ${(err as Error).message}`));
    return true;
  }

  /**
   * Claim the `/` menu. That list lives on the bot token (Bot API), so a token
   * that ran another build keeps showing that build's commands until something
   * replaces it — including entries this build cannot answer. Delete the three
   * scopes we may have inherited, then publish the catalog we actually serve.
   */
  async #registerCommandMenu(bot: GrammyBot): Promise<void> {
    if ((this.service.config.channels.telegram as { commandsMenu?: boolean }).commandsMenu === false) return;
    const menu = buildCommandMenu({
      catalog: SLASH_CATALOG,
      local: TELEGRAM_COMMANDS,
      skills: this.service.loop.skills,
    });
    try {
      // Not just `default`: a chat/member scope overrides it, so an old build's
      // commands can survive in exactly the chat where they were registered.
      const targets = staleCommandScopes({
        chatIds: this.#knownChatIds(),
        userIds: this.service.config.channels.telegram.allowFrom ?? [],
      });
      type DeleteArgs = Parameters<typeof bot.api.deleteMyCommands>[0];
      for (const { scope, language_code } of targets) {
        // grammY types language_code as a literal union; ours is a runtime string.
        const args = (language_code ? { scope, language_code } : { scope }) as DeleteArgs;
        await bot.api.deleteMyCommands(args).catch(() => {});
      }
      await bot.api.setMyCommands(
        menu.map((m) => ({ command: m.command, description: m.description })),
        { scope: { type: "default" } },
      );
      this.log.info(
        `telegram: registered ${menu.length} command(s); cleared ${targets.length} scope(s) a previous build could have left`,
      );
    } catch (err) {
      this.log.warn(`telegram: could not register the / menu: ${(err as Error).message}`);
    }
  }

  /** Chat ids this device has ever seen — sessions first, then both pairing lists. */
  #knownChatIds(): string[] {
    const ids = new Set<string>();
    try {
      for (const row of this.service.store.listSessions(500, { includeArchived: true })) {
        const m = /^telegram:(\d+)/.exec(String((row as { key?: string }).key ?? ""));
        if (m?.[1]) ids.add(m[1]);
      }
    } catch {
      /* the store may not have a sessions table yet on a fresh install */
    }
    const cfg = this.service.config.channels.telegram;
    for (const id of [...(cfg.allowFrom ?? []), ...(cfg.groupAllowFrom ?? [])]) {
      if (/^-?\d+$/.test(String(id).trim())) ids.add(String(id).trim());
    }
    return [...ids];
  }

  async #isFromBot(ctx: Context, fromId: number | undefined): Promise<boolean> {
    if (fromId === undefined) return false;
    try {
      const me = await ctx.api.getMe();
      return fromId === me.id;
    } catch {
      return false;
    }
  }

  async #flush(key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    const bot = this.#bot;
    if (!bot) return;

    const chatId = Number(key);
    const cfg = this.service.config.channels.telegram;

    // Inbound media pipeline (P1 A5): download via getFile into
    // <workspace>/media/telegram/<chatId>/ (unsanitized names never reach the
    // fs), then fold placeholders into the turn text. Photos additionally
    // become vision attachments when channels.telegram.vision is on.
    const saved: Awaited<ReturnType<typeof downloadInboundMedia>>[] = [];
    if (pending.media.length > 0) {
      const stamp = `${Date.now().toString(36)}`;
      for (const [i, m] of pending.media.slice(0, 10).entries()) {
        saved.push(
          await downloadInboundMedia(m, {
            chatId,
            workspace: workspaceDir(),
            maxBytes: Math.max(1, cfg.mediaMaxMb) * 1048576,
            token: cfg.token,
            stamp: `${stamp}-${i}`,
            getFile: (fileId) => bot.api.getFile(fileId).then((f) => ({ file_path: f.file_path })),
          }),
        );
      }
      if (pending.media.length > 10) this.log.warn(`telegram: dropped ${pending.media.length - 10} media item(s) over the 10/turn cap`);
    }
    // Media understanding (P3 #22): describe images / transcribe voice and
    // audio BEFORE the reply pipeline runs, so routing and the agent work
    // off text (their pipeline). Failures keep the placeholder text AND the
    // native-vision delivery for images — understanding errors never block.
    const consumed = new Set<number>();
    let understandingBody = "";
    {
      const tmc = this.service.config.tools.media;
      const anyEnabled = tmc.image.enabled || tmc.audio.enabled || tmc.pdf.enabled;
      if (anyEnabled && saved.length > 0) {
        const { selectAttachments, runUnderstanding, renderMediaBlocks, toolsMediaConfig } = await import("../agent/media-understanding.js");
        const media = toolsMediaConfig(tmc);
        const facts = saved.flatMap((s) => {
          if (!s.path) return [];
          const isPdf = s.media.kind === "document" && /(\.pdf$|^application\/pdf$)/i.test(`${s.media.fileName ?? ""} ${s.media.mime ?? ""}`);
          const kind: import("../agent/media-understanding.js").MediaFact["kind"] = s.media.kind === "photo" ? "image" : s.media.kind === "voice" || s.media.kind === "audio" ? "audio" : isPdf ? "pdf" : s.media.kind === "video" ? "video" : "other";
          const fact: import("../agent/media-understanding.js").MediaFact = { kind, path: s.path, contentType: s.media.mime, name: s.media.fileName };
          return [{ fact, savedIndex: saved.indexOf(s), kind }];
        });
        const deps = this.service.mediaUnderstandingDeps();
        const selected = selectAttachments(facts.map((f) => f.fact), media);
        const outcomes = [];
        for (const fact of selected) {
          const idx = facts.findIndex((f) => f.fact === fact);
          const outcome = await runUnderstanding(fact, media, deps, idx);
          outcomes.push(outcome);
          if (outcome.status === "completed") {
            consumed.add(facts[idx]!.savedIndex);
            // Their echo: transcribed audio mirrors back before the agent runs.
            if (outcome.capability === "audio" && media.audio.echoTranscript) {
              const fmt = (media.audio.echoFormat || '📝 "{transcript}"').replace("{transcript}", outcome.text ?? "");
              await bot.api.sendMessage(chatId, fmt).catch((e) => this.log.warn(`telegram: transcript echo failed: ${(e as Error).message}`));
            }
          } else if (outcome.status === "failed") {
            this.log.warn(`telegram: media understanding failed for ${facts[idx]!.fact.name ?? facts[idx]!.fact.kind}: ${outcome.error ?? "unknown"}`);
          }
        }
        if (outcomes.some((o) => o.status === "completed")) {
          // Blocks land first; captions still ride the normal text lane below
          // (no duplication — their `User text:` preservation in our shape).
          understandingBody = renderMediaBlocks(outcomes.filter((o) => o.status === "completed"), "");
        }
      }
    }
    const placeholders = saved
      .filter((_, i) => !consumed.has(i))
      .map((s) => mediaPlaceholder(s))
      .join("\n");
    const attachments = cfg.vision
      ? saved
          .filter((s, i) => s.dataUri !== undefined && !consumed.has(i)) // understood images are text-only now (their rule)
          .map((s) => ({ kind: "image" as const, dataUri: s.dataUri!, name: s.media.fileName ?? "photo.jpg" }))
      : [];
    const text = [understandingBody, pending.texts.join("\n\n"), placeholders]
      .filter((s) => s.trim().length > 0)
      .join("\n")
      .slice(0, 8000);

    // Typing indicator lifecycle (P3 #24 — their typingMode semantics):
    // DMs and explicit mentions start immediately ("instant"); group chats
    // without a mention start on the first user-visible activity; "thinking"
    // starts on the first reasoning-ish/tool signal; "message" on the first
    // non-silent text/tool; "never" disables. Refresh rides a keepalive
    // interval (their 6s) with a 2-minute TTL safety stop.
    const typing = this.#typingFor(chatId, pending.topicId, pending.isGroup === true, pending.mentioned === true);

    // Task 52/53 — outbound delivery is a pure module (telegram-delivery.ts) so
    // the "answers only, as they are written" contract is testable without a
    // bot. No mode: there is no status message left to configure.
    const delivery = createTurnDelivery({
      api: bot.api as unknown as import("./telegram-delivery.js").DeliveryApi,
      chatId,
      log: (m: string) => this.log.warn(m),
    });

    await this.service.send({
      sessionKey: this.#sessionKeyFor(chatId),
      text,
      isMainSession: pending.isMain === true,
      source: "telegram",
      attachments,
      onQuestion: async (event) => {
        // ask_user cards (P2 #8): single-select rides an inline keyboard
        // (option buttons + Other + Skip); multi-select falls back to the
        // numbered text renderer (their docs' surface distinction).
        const buildKeyboard = (q: { id: string; question: string; options: string[]; multi: boolean }): { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } => {
          if (q.multi) return { text: renderQuestionText(q, event.questions.indexOf(q) + 1, event.questions.length) };
          const rows = q.options.map((opt, i) => [{ text: opt, callback_data: `qu:${event.id}:${q.id}:${i}` }]);
          rows.push([{ text: "✏️ Other…", callback_data: `qu:${event.id}:${q.id}:other` }, { text: "⏭ Skip", callback_data: `qu:${event.id}:${q.id}:skip` }]);
          return { text: `❓ ${q.question}`, reply_markup: { inline_keyboard: rows } };
        };
        for (const q of event.questions) {
          const b = buildKeyboard(q);
          await bot.api.sendMessage(chatId, b.text, b.reply_markup ? { reply_markup: b.reply_markup } : {}).catch((err) => this.log.warn(`telegram: question send failed: ${(err as Error).message}`));
        }
      },
      // Deltas only feed the typing indicator now: the chat shows answers, not
      // the answer being typed. `onSay` carries a finished block.
      onDelta: async (delta) => {
        typing.onText(delta);
      },
      onSay: async (text) => {
        await delivery.say(text);
      },
      onTool: async () => {
        typing.onTool();
      },
      // Task 55 — no approval card, ever. The operator's rule: "let the ai work
      // on any command without my permission … i cant give permission from
      // telegram". A card here is a wall: the turn does not continue until it is
      // tapped, and a swipe away from it looks exactly like the agent refusing
      // to run anything at all.
      reply: async (finalText) => {
        typing.stop();
        // P3 #26: heartbeat target:"last" follows this conversation.
        this.service.heartbeat?.rememberOutbound(chatId);
        // P3 #26: outside heartbeats, stray HEARTBEAT_OK at start/end is
        // stripped (their response contract); a pure-OK message is dropped.
        const cleaned = stripStrayHeartbeatOk(finalText);
        // A turn with nothing left to say still has to settle the ledger (every
        // block may already have been posted by `onSay`).
        await delivery.reply(cleaned);
        // Task 35: in a code session the answer is not the whole story — say
        // what changed and name the two commands that act on it. One line, no
        // keyboard: the turn is done, this is a signpost, not a question.
        const binding = this.service.store.getSessionRepo(this.#sessionKeyFor(chatId));
        if (!binding) return;
        try {
          const st = await this.service.repos.status(binding.workspace);
          if (st.clean) return;
          // A signpost, not the answer: `notify` never touches the answer ledger.
          await delivery.notify(
            `${st.files.length} file(s) changed (+${st.added} −${st.removed}) · /diff to review · /pr to publish`,
          );
        } catch {
          /* the code session's bookkeeping must never cost the answer */
        }
      },
    });
    typing.stop(); // belt-and-braces: send() settled (turn end, error, abort)
  }

  /**
   * P3 #24 — typing lifecycle across modes (see `createTyping` for the pure
   * contract). Immediate start rules and keepalive cadence live there; here
   * we only bind the Telegram sendChatAction call (per-chat + topic scoping).
   */
  #typingFor(chatId: number, topicId: number | undefined, isGroup: boolean, mentioned: boolean): TypingHandle {
    const cfg = this.service.config.channels.telegram.typing;
    const bot = this.#bot;
    return createTyping(
      { mode: cfg?.mode ?? "instant", intervalSeconds: cfg?.intervalSeconds ?? 6, isGroup, mentioned },
      async () => {
        if (!bot) return;
        await bot.api
          .sendChatAction(chatId, "typing", topicId ? { message_thread_id: topicId } : {})
          .catch((e: unknown) => this.log.warn(`telegram: sendChatAction failed: ${(e as Error).message}`));
      },
    );
  }
}



/** Re-exported for callers on the old surface (the splitter lives in telegram-format). */
export { splitForTelegram } from "./telegram-format.js";
