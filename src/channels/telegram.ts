import type { Context } from "grammy";
import type { Service } from "../agent/service.js";
import type { Logger } from "../util/log.js";
import {
  addProvider,
  canonicalModelRef,
  defaultModelLine,
  formatProviders,
  parseProviderAddArgs,
  removeProvider,
  testProvider,
} from "../config/providers.js";

// Telegram channel: grammY long polling, per-chat batching, one editable status
// draft per turn, DM pairing + group allowlists + mention gating.

/** grammY is only needed when the Telegram channel is enabled. */
async function createBot(token: string) {
  const { Bot } = await import("grammy");
  return new Bot(token);
}

type GrammyBot = Awaited<ReturnType<typeof createBot>>;

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
  timer: NodeJS.Timeout;
  firstAt: number;
}

export class TelegramChannel {
  #bot: GrammyBot | null = null;
  #pending = new Map<string, PendingMessage>();
  #username = "";
  running = false;

  constructor(
    private readonly service: Service,
    private readonly log: Logger,
  ) {}

  get username(): string {
    return this.#username;
  }

  async start(): Promise<void> {
    const cfg = this.service.config.channels.telegram;
    if (!cfg.token) throw new Error("telegram.token is empty");

    const bot = await createBot(cfg.token);
    this.#bot = bot;

    bot.on("message", (ctx) => {
      void this.#onMessage(ctx).catch((err) => this.log.error(`telegram message failed: ${(err as Error).message}`));
    });

    const me = await bot.api.getMe();
    this.#username = me.username;
    this.running = true;
    this.log.info(`telegram online as @${me.username}`);

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

    if (!text.trim()) return;

    const command = parseCommand(text);
    if (command) {
      await this.#onCommand(ctx, command);
      return;
    }

    const key = `${chatId}`;
    const topicId = (msg as { message_thread_id?: number }).message_thread_id;
    const sessionKey = `telegram:${chatId}${topicId ? `:topic:${topicId}` : isGroup ? `:group` : ""}`;

    const existing = this.#pending.get(key);
    if (existing) {
      existing.texts.push(text);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.#flush(key), cfg.batchMs);
      return;
    }
    const entry: PendingMessage = { texts: [text], firstAt: Date.now(), timer: setTimeout(() => void this.#flush(key), cfg.batchMs) };
    this.#pending.set(key, entry);
  }

  /** Bot commands: status, model and full provider management. */
  async #onCommand(ctx: Context, cmd: BotCommand): Promise<void> {
    const reply = async (body: string): Promise<void> => {
      await ctx
        .reply(body.slice(0, 4000), { link_preview_options: { is_disabled: true } })
        .catch((err: unknown) => this.log.warn(`telegram reply failed: ${(err as Error).message}`));
    };

    const cfgSvc = this.service.configSvc;
    const [sub = "", ...rest] = cmd.args.split(/\s+/).filter(Boolean);

    switch (cmd.name) {
      case "start":
      case "help":
        return reply([
          "SuparClaw commands",
          "",
          "/status — model, providers, tools",
          "/model — current default model",
          "/model <provider>/<model> — switch the default model",
          "/provider — list providers",
          "/provider add <name> [url|key] [key] [models,a,b]",
          "/provider test <name> · /provider remove <name>",
          "",
          "Anything else is sent to the agent.",
        ].join("\n"));

      case "status": {
        const config = this.service.config;
        return reply([
          defaultModelLine(config),
          `providers: ${Object.keys(config.providers ?? {}).join(", ") || "none"}`,
          `tools: ${this.service.loop.tools.length} · skills: ${this.service.loop.skills.length}`,
          `cron: ${config.cron.enabled ? "on" : "off"}`,
        ].join("\n"));
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
        return reply(`unknown command /${cmd.name} — try /help`);
    }
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

    const text = pending.texts.join("\n\n").slice(0, 8000);
    const chatId = Number(key);

    const preview = await bot.api.sendMessage(chatId, "…", { link_preview_options: { is_disabled: true } }).catch(() => null);

    let lastEdit = 0;
    let statusLines: string[] = [];
    const cfg = this.service.config.channels.telegram;

    await this.service.send({
      sessionKey: key.startsWith("telegram:") ? key : `telegram:${key}`,
      text,
      isMainSession: false,
      source: "telegram",
      onDelta: async () => {
        if (!preview || cfg.streaming === "off") return;
        const now = Date.now();
        if (now - lastEdit < 2000) return;
        lastEdit = now;
        await bot.api
          .editMessageText(chatId, preview.message_id, "▌ working…", { link_preview_options: { is_disabled: true } })
          .catch(() => {});
      },
      onTool: async (event) => {
        if (!preview || cfg.streaming === "off") return;
        statusLines = [...statusLines.slice(-4), `· ${event.name}`];
        await bot.api
          .editMessageText(chatId, preview.message_id, `▌ working…\n${statusLines.join("\n")}`)
          .catch(() => {});
      },
      reply: async (finalText) => {
        const chunks = splitForTelegram(finalText);
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