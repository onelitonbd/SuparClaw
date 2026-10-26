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
  defaultModelLine,
  formatProviders,
  parseProviderAddArgs,
  removeProvider,
  testProvider,
} from "../config/providers.js";
import { slashHelp, SLASH_CATALOG } from "../agent/slash-commands.js";
import { buildCommandMenu, staleCommandScopes } from "./telegram-menu.js";

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
  { cmd: "/model [provider/model]", summary: "show or set the default model" },
  { cmd: "/provider [list|add|remove|test]", summary: "manage model providers" },
  { cmd: "/whoami", summary: "your Telegram id, this chat and its session" },
  { cmd: "/new", summary: "start a fresh session (the old one is kept)" },
];

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
  return { name: (m[1] as string).toLowerCase(), args: (m[2] ?? "").trim() };
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
    if (!this.#bot) throw new Error("telegram bot not running");
    for (const chunk of splitForTelegram(text)) {
      await this.#bot.api.sendMessage(chatId, chunk);
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
    // ask_user + approval buttons (P2 #8/#17): shared callback-query router.
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
   * later approval cards share one router — only PAIRED users resolve
   * (their approval-surface rule), the card gets edited to the outcome.
   */
  async #onCallbackQuery(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const fromId = ctx.from?.id;
    if (fromId === undefined || !data) return;
    const cfg = this.service.config.channels.telegram;
    if (!this.#paired(fromId)) {
      await ctx.answerCallbackQuery({ text: "Only paired users can decide this", show_alert: true }).catch(() => {});
      return;
    }
    void cfg;
    const parts = data.split(":");
    const kind = parts[0];

    if (kind === "appr") {
      // Exec approval cards (P2 #17): resolveApproval is a no-op the second
      // time (their "later taps are stale") and the card replaces itself with
      // the outcome so nobody double-approves by accident.
      const [, callId, decision] = parts;
      if (!callId || (decision !== "once" && decision !== "always" && decision !== "deny")) return;
      const resolved = this.service.resolveApproval(callId, decision);
      if (!resolved) {
        await ctx.answerCallbackQuery({ text: "Already resolved" }).catch(() => {});
        return;
      }
      const marks: Record<string, string> = { once: "✔ approved once", always: "⚡ always allowed (this directory)", deny: "✖ denied" };
      await ctx.answerCallbackQuery({ text: marks[decision]! }).catch(() => {});
      const original = (ctx.callbackQuery?.message?.text ?? "").split("\n\n✦")[0] ?? "approval";
      await ctx.editMessageText(`${original}\n\n✦ ${marks[decision]}`).catch(() => {});
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
            `paired: ${from !== undefined && this.#paired(from) ? "yes" : `no — sc pair approve ${from ?? "?"}`}`,
          ].join("\n"),
        );
      }

      case "new": {
        // A rotation tag, never a delete: the old transcript stays in Sessions.
        const previous = this.#sessionKeyFor(scope.chatId);
        this.service.store.setMeta(`telegram:sess:${scope.chatId}`, Date.now().toString(36));
        return reply(
          `new session: ${this.#sessionKeyFor(scope.chatId)}\nthe previous one is kept — ${previous} is still in Sessions.`,
        );
      }

      case "model": {
        if (!sub) return reply(defaultModelLine(this.service.config));
        // a bare model id ("kilo/nvidia/x") is stored as "<provider>/<id>"
        const canonical = canonicalModelRef(this.service.config, sub) ?? sub;
        const result = cfgSvc.setPath("agents.defaults.model", canonical);
        if (!result.ok) return reply(`could not set model: ${result.errors.join("; ")}`);
        this.service.applyConfig();
        const names = Object.keys(this.service.config.providers ?? {});
        const hint =
          canonical === sub && names.length && !names.includes(sub.split("/")[0] ?? "")
            ? `\nheads up: "${sub}" does not start with a provider name (${names.join(", ")})`
            : "";
        return reply(`default model: ${canonical}${hint}`);
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

  /** `/new` rotates the tag, so the next message opens a fresh session while
   *  every earlier transcript stays exactly where it is. */
  #sessionKeyFor(chatId: number): string {
    return telegramSessionKey(chatId, this.service.store.getMeta(`telegram:sess:${chatId}`));
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

    const preview = await bot.api.sendMessage(chatId, "…", { link_preview_options: { is_disabled: true } }).catch(() => null);

    let lastEdit = 0;
    let statusLines: string[] = [];

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
      onDelta: async (delta) => {
        typing.onText(delta);
        if (!preview || cfg.streaming === "off") return;
        const now = Date.now();
        if (now - lastEdit < 2000) return;
        lastEdit = now;
        await bot.api
          .editMessageText(chatId, preview.message_id, "▌ working…", { link_preview_options: { is_disabled: true } })
          .catch(() => {});
      },
      onTool: async (event) => {
        typing.onTool();
        if (!preview || cfg.streaming === "off") return;
        statusLines = [...statusLines.slice(-4), `· ${event.name}`];
        await bot.api
          .editMessageText(chatId, preview.message_id, `▌ working…\n${statusLines.join("\n")}`)
          .catch(() => {});
      },
      onApproval: async (event) => {
        // Approval card with buttons (P2 #17): one tap resolves; the card
        // rewrites itself to ✔/⚡/✖; stale taps get "Already resolved".
        const cmd = event.tool === "exec" ? String((event.args as Record<string, unknown>)?.command ?? "") : JSON.stringify(event.args ?? {});
        const body =
          `🛡 ${event.tool} wants approval\n\n${cmd.slice(0, 500)}` +
          (event.exec ? `\n\n${event.exec.reason} · mode ${event.exec.mode}` : "");
        const row: { text: string; callback_data: string }[] = [
          { text: "✔ Approve once", callback_data: `appr:${event.callId}:once` },
          { text: "✖ Deny", callback_data: `appr:${event.callId}:deny` },
        ];
        if (event.exec?.mintable) row.splice(1, 0, { text: "⚡ Always (this dir)", callback_data: `appr:${event.callId}:always` });
        await bot.api
          .sendMessage(chatId, body, { reply_markup: { inline_keyboard: [row] } })
          .catch((err) => this.log.warn(`telegram: approval card failed: ${(err as Error).message}`));
      },
      reply: async (finalText) => {
        typing.stop();
        // P3 #26: heartbeat target:"last" follows this conversation.
        this.service.heartbeat?.rememberOutbound(chatId);
        // P3 #26: outside heartbeats, stray HEARTBEAT_OK at start/end is
        // stripped (their response contract); a pure-OK message is dropped.
        const cleaned = stripStrayHeartbeatOk(finalText);
        if (cleaned.trim() === "") return;
        const chunks = splitForTelegram(cleaned);
        if (!preview) {
          for (const chunk of chunks) await bot.api.sendMessage(chatId, chunk).catch(() => {});
          return;
        }
        await bot.api
          .editMessageText(chatId, preview.message_id, chunks[0] ?? "(empty)", { link_preview_options: { is_disabled: true } })
          .catch(() => {});
        for (const chunk of chunks.slice(1)) {
          await bot.api.sendMessage(chatId, chunk).catch(() => {});
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



/** Telegram rejects messages over 4096 chars — split on paragraph boundaries. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit * 0.5 ? cut : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}