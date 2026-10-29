// What the agent can actually reach.
//
// The reminder that started this: the job was created correctly, announced back
// into the web chat (the surface that asked), and the model explained that as
// "I don't have direct Telegram API access from this device" — a limitation it
// invented because nothing in its context said which channels exist. Delivery
// is the gateway's job, not a tool call, so the prompt has to carry the facts:
// which surfaces are configured, which are live, and which chat ids a scheduled
// result can be sent to. Everything here is pure so the wording is testable.

export interface SurfaceFacts {
  telegram: {
    enabled: boolean;
    hasToken: boolean;
    /** Bot is polling right now — announce would actually send. */
    running: boolean;
    /** Bot username, when running. */
    username: string;
    /** Why it failed to start, when enabled and not running. */
    error: string;
  };
  /** Chat ids the bot has really exchanged messages in, most recent first. */
  telegramChats: string[];
}

export const NO_SURFACES: SurfaceFacts = {
  telegram: { enabled: false, hasToken: false, running: false, username: "", error: "" },
  telegramChats: [],
};

/** Facts for a run with no service wired (tests, bare harnesses): config only. */
export function surfacesFromConfig(channels: { telegram?: { enabled?: boolean; token?: string } }): SurfaceFacts {
  const tg = channels.telegram ?? {};
  return {
    telegram: {
      enabled: Boolean(tg.enabled),
      hasToken: Boolean(String(tg.token ?? "").trim()),
      running: false,
      username: "",
      // Configured but this process cannot know it is live — say "not running",
      // never "no access": the daemon is what would send it.
      error: "",
    },
    telegramChats: [],
  };
}

const chatLabel = (sessionKey: string): string => {
  const k = String(sessionKey ?? "").trim();
  if (!k || k === "main:main" || k === "main") return "the web chat";
  const head = k.split(":")[0] ?? "";
  if (head === "telegram") return "Telegram";
  if (head === "web" || head === "ui") return "the web chat";
  if (head === "tui" || head === "term") return "the terminal UI";
  if (head === "cron") return "a scheduled job's own session";
  if (head === "subagent") return "a sub-agent session";
  return `the ${head || "unknown"} chat`;
};

/**
 * The `## Surfaces` block. Facts only — one line per surface, plus the one
 * sentence that stops the model from describing delivery as a missing
 * capability. Rebuilt every turn, so connecting a channel shows up immediately.
 */
export function surfacesPromptLine(facts: SurfaceFacts, sessionKey: string): string {
  const tg = facts.telegram;
  const lines: string[] = [`## Surfaces`, "", `- This chat: ${chatLabel(sessionKey)} (session \`${sessionKey || "unknown"}\`).`];
  if (!tg.enabled) {
    lines.push(
      "- Telegram: not configured on this device. A scheduled job's result can only be announced back into a chat session (`to=session:<key>`), so say that plainly instead of promising a Telegram message.",
    );
  } else if (!tg.running) {
    lines.push(
      `- Telegram: configured${tg.error ? ` but offline — ${tg.error}` : " but the bot is not running right now"}. Anything sent there would be dropped until it reconnects. Say that; do not describe it as missing API access — the gateway owns the connection, not you.`,
    );
  } else if (facts.telegramChats.length === 0) {
    lines.push(
      `- Telegram: online${tg.username ? ` as @${tg.username}` : ""}, but no chat has messaged the bot yet, so there is no chat id to deliver to. Ask for one message to the bot (or a \`telegram:<chatId>\` target) before promising a Telegram ping.`,
    );
  } else {
    const chats = facts.telegramChats.slice(0, 5).join(", ");
    lines.push(
      `- Telegram: online${tg.username ? ` as @${tg.username}` : ""}. Chats that have messaged the bot: ${chats}. A scheduled job reaches them with \`to=telegram:<chatId>\`, or \`to=telegram\` for the most recent one.`,
    );
  }
  // The closing line has to be true in both directions: when Telegram is live
  // it corrects "no API access"; when it is not, it must not sell a delivery
  // that cannot happen.
  const deliverable = tg.enabled && tg.running && facts.telegramChats.length > 0;
  lines.push(
    deliverable
      ? "- Delivery is done by the gateway at fire time, not by a tool call: you have no standalone send tool, but `cron_add`/`cron_update` with `to=` really does deliver over Telegram. Never claim a channel is unreachable unless this block says it is off."
      : "- Delivery is done by the gateway at fire time, not by a tool call: you have no standalone send tool. Only what this block lists as reachable will actually deliver — say what you cannot do plainly, and never guess at API access you may or may not have.",
  );
  return lines.join("\n");
}

export interface TargetResult {
  /** Resolved target, or "" when nothing can be resolved. */
  target: string;
  /** The request cannot be honoured — surface this as an `error:` string. */
  error?: string;
  /** One clause for the reply: what this target is and whether it will work. */
  note?: string;
}

const telegramNote = (facts: SurfaceFacts): string | undefined => {
  const tg = facts.telegram;
  if (!tg.enabled) return "Telegram is not configured, so this target will not deliver";
  if (!tg.running) return `Telegram is offline${tg.error ? ` (${tg.error})` : ""}, so this target will not deliver until it reconnects`;
  return tg.username ? `via @${tg.username} on Telegram` : "on Telegram";
};

const sessionNote = (facts: SurfaceFacts, sessionKey: string): string | undefined => {
  const tg = facts.telegram;
  if (!tg.running || facts.telegramChats.length === 0) return undefined;
  const chat = facts.telegramChats[0]!;
  const here = /^telegram:(\d+)/.exec(sessionKey)?.[1];
  if (here === chat) return undefined;
  return `Telegram is online${tg.username ? ` as @${tg.username}` : ""} — pass to=telegram to send it to chat ${chat} instead`;
};

/**
 * Resolve a delivery target.
 *
 * "" → the surface that asked (unchanged: a reminder asked for here comes back
 * here). "telegram" → the operator's most recent Telegram chat, as an explicit
 * request that fails loudly when there is nothing to send to.
 */
export function resolveAnnounceTarget(to: string, sessionKey: string, facts: SurfaceFacts): TargetResult {
  const asked = String(to ?? "")
    .trim()
    .toLowerCase();
  const tg = facts.telegram;
  const known = facts.telegramChats[0] ?? "";

  if (!asked) {
    const dm = /^telegram:(\d+)/.exec(sessionKey);
    if (dm) return { target: `telegram:${dm[1]}`, note: telegramNote(facts) };
    return sessionKey
      ? { target: `session:${sessionKey}`, note: sessionNote(facts, sessionKey) }
      : { target: "" };
  }

  if (asked === "telegram" || asked === "tg") {
    if (!tg.enabled) {
      return { target: "", error: "Telegram is not configured — connect it in Settings → Channels first, or use to=session:<key>" };
    }
    if (!tg.running) {
      return {
        target: "",
        error: `Telegram is configured but not running${tg.error ? ` (${tg.error})` : ""} — announced results would be dropped; fix the channel first`,
      };
    }
    if (!known) {
      return {
        target: "",
        error: "no Telegram chat has messaged the bot yet, so there is no chat id to send to — message the bot once, or pass to=telegram:<chatId>",
      };
    }
    return { target: `telegram:${known}`, note: telegramNote(facts) };
  }

  const explicit = /^(?:telegram|tg):(\d+)$/.exec(asked);
  if (explicit) return { target: `telegram:${explicit[1]}`, note: telegramNote(facts) };
  if (/^\d+$/.test(asked)) return { target: `telegram:${asked}`, note: telegramNote(facts) };
  if (asked.startsWith("session:")) {
    const key = asked.slice("session:".length);
    if (!key) return { target: "", error: "session: needs a session key" };
    return { target: `session:${key}`, note: sessionNote(facts, key) };
  }
  return {
    target: "",
    error: `unsupported delivery target "${to}" — use telegram, telegram:<chatId>, session:<key>, or a https:// URL for webhook`,
  };
}

/** Delivery line for a stored job: `announce → telegram:1 via @bot`. */
export function describeDelivery(
  job: { delivery_mode?: string | null; delivery_to?: string | null },
  facts: SurfaceFacts,
): string {
  if (!job.delivery_mode) return "cron.delivery default";
  const mode = job.delivery_mode;
  const to = job.delivery_to ?? "";
  if (mode === "announce" && /^(?:telegram:|tg:)?\d+$/.test(to)) {
    const note = telegramNote(facts);
    return `announce → telegram:${to.replace(/^(?:telegram:|tg:)/, "")}${note ? ` ${note}` : ""}`;
  }
  if (mode === "announce" && to.startsWith("session:")) {
    const note = sessionNote(facts, to.slice("session:".length));
    return `announce → ${to}${note ? ` (${note})` : ""}`;
  }
  return to ? `${mode} → ${to}` : mode;
}
