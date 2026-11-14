/**
 * P3 (row Missing!#26) — heartbeat automation (their gateway/heartbeat
 * contract, single-agent scale):
 *
 *  - one system-owned cadence (their scheduler-owned monitor); ours reads
 *    live config so config.set edits re-arm without a restart
 *  - every: "30m" default, "0m" disables the recurring cadence; min 1m
 *  - busy drop: a heartbeat tick while the main session has an active turn is
 *    recorded as skipped with reason requests-in-flight and waits for the
 *    next tick (their drop rule — ours has no persisted monitor row)
 *  - target: "owner" (default — first concrete paired allowFrom entry;
 *    no-route skip logged once), "last" (most recent telegram chat), "none"
 *  - lightContext: skips workspace bootstrap files for the turn
 *  - isolatedSession: fresh session per run (no conversation history)
 *  - activeHours: {start, end, timezone?} — local-time window; outside →
 *    skip until next tick; zero-width window always skips (their rule);
 *    timezone defaults to the user's configured timezone, else host tz
 *  - NO_REPLY contract: silent; token-only strict prefix ≥4 chars also quiet
 *    (their hyphen-safe fragment rule, heartbeat-only); legacy HEARTBEAT_OK
 *    recognized at start/end when remainder ≤300 chars (their budget);
 *    HEARTBEAT_OK in the middle is never special
 *  - prompt sent verbatim as the scheduled user message; with lightContext
 *    the prompt text flows through the run harness unchanged... timeout:
 *    min(cadence seconds, 600) unless timeoutSeconds set (their cap)
 */
import type { SuparClawConfig } from "../config/schema.js";

export const DEFAULT_HEARTBEAT_PROMPT =
  "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";

/** "30m" / "1h" / number-seconds → ms; "0m" → 0 (disabled). */
export function parseHeartbeatEvery(raw: string | undefined): number {
  if (!raw) return 30 * 60 * 1000;
  const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(String(raw).trim());
  if (!m) return 30 * 60 * 1000;
  const n = Number(m[1]);
  const mult = m[2] === "h" ? 3600 : m[2] === "s" ? 1 : 60;
  return Math.round(n * mult * 1000);
}

/** legacy HEARTBEAT_OK suppression budget (their fixed 300 chars). */
export const HEARTBEAT_OK_BUDGET = 300;

export type HeartbeatReply =
  | { kind: "silent" }
  | { kind: "deliver"; text: string };

/**
 * Silent replies: NO_REPLY, or a heartbeat-only token-prefix fragment of
 * NO_REPLY (≥4 chars, case-insensitive, "NO_R"…"no_reply" style) — and the
 * legacy HEARTBEAT_OK at start/end when the remainder fits the 300-char
 * budget. Middle-position HEARTBEAT_OK is never treated specially.
 */
export function filterHeartbeatReply(raw: string): HeartbeatReply {
  const text = raw.trim();
  if (text === "" || /^NO_REPLY$/i.test(text)) return { kind: "silent" };
  // heartbeat-only fragment: token-only strict prefix ≥ 4 chars
  if (/^no_r(e(p(l(y)?)?)?)?$/i.test(text.replace(/_/g, "_")) && text.length >= 4 && "no_reply".startsWith(text.toLowerCase())) {
    return { kind: "silent" };
  }
  const stripOk = (s: string): string | null => {
    const t = s.trim();
    const start = /^HEARTBEAT_OK\b[ \t]*/i.exec(t);
    if (start) {
      const rest = t.slice(start[0].length).trim();
      if (rest.length <= HEARTBEAT_OK_BUDGET) return rest;
    }
    const end = /[ \t]*(\n[ \t]*)?HEARTBEAT_OK[.! ]*\s*$/i.exec(t);
    if (end) {
      const rest = t.slice(0, end.index).trim();
      if (rest.length <= HEARTBEAT_OK_BUDGET) return rest;
    }
    return null;
  };
  const stripped = stripOk(text);
  if (stripped !== null) return { kind: "silent" };
  return { kind: "deliver", text };
}

/** Outside heartbeats: stray HEARTBEAT_OK at start/end is stripped (their rule). */
export function stripStrayHeartbeatOk(raw: string): string {
  let t = raw.trim();
  const start = /^HEARTBEAT_OK\b[ \t]*/i.exec(t);
  if (start) t = t.slice(start[0].length).trim();
  const end = /[ \t]*(\n[ \t]*)?HEARTBEAT_OK[.! ]*$/i.exec(t);
  if (end) t = t.slice(0, end.index).trim();
  return t;
}

export interface ActiveHoursConfig {
  start: string; // "HH:MM" local
  end: string; // "HH:MM" local (24:00 allowed)
  timezone?: string;
}

/** Inside the [start, end) local-time window? Zero-width windows never match. */
export function inActiveHours(h: ActiveHoursConfig | undefined, now: Date, hostTimezone?: string): boolean {
  if (!h) return true;
  const tz = h.timezone || hostTimezone || undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const cur = hh * 60 + mm;
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const v = Number(m[1]) * 60 + Number(m[2]);
    return v <= 1440 ? v : null;
  };
  const start = parse(h.start);
  const end = parse(h.end);
  if (start === null || end === null) return true;
  if (start === end) return false; // zero-width → always skipped (their rule)
  if (start < end) return cur >= start && cur < end;
  // wraps midnight: e.g. 22:00–06:00
  return cur >= start || cur < end;
}

export interface HeartbeatTarget {
  kind: "telegram" | "none" | "no-route";
  chatId?: number;
  reason?: string;
}

/** Resolve the delivery target (their owner→allowFrom / last / none ladder). */
export function resolveHeartbeatTarget(
  config: SuparClawConfig,
  lastChatId: number | null,
): HeartbeatTarget {
  const target = config.agents.defaults.heartbeat.target;
  if (target === "none") return { kind: "none" };
  if (target === "last" && lastChatId !== null && lastChatId > 0) {
    return { kind: "telegram", chatId: lastChatId };
  }
  // owner (default): first CONCRETE paired entry from telegram allowFrom —
  // no wildcard resolution (their "wildcard allowlists do not identify an owner")
  const allow = config.channels.telegram.allowFrom.map((s) => s.trim()).filter((s) => /^[1-9]\d{4,}$/.test(s));
  if (config.channels.telegram.token && allow.length > 0) {
    return { kind: "telegram", chatId: Number(allow[0]) };
  }
  return { kind: "no-route", reason: "no-resolvable-owner", };
}

export interface HeartbeatDecision {
  run: boolean;
  reason?: "disabled-cadence" | "outside-active-hours" | "requests-in-flight" | "no-route";
}

/** Should the tick run? Their drop/skip reasons preserved as reasons. */
export function heartbeatDecision(
  config: SuparClawConfig,
  busy: boolean,
  now: Date,
  hostTimezone?: string,
): HeartbeatDecision {
  const every = parseHeartbeatEvery(config.agents.defaults.heartbeat.every);
  if (every <= 0) return { run: false, reason: "disabled-cadence" };
  if (!inActiveHours(config.agents.defaults.heartbeat.activeHours, now, hostTimezone)) {
    return { run: false, reason: "outside-active-hours" };
  }
  if (busy) return { run: false, reason: "requests-in-flight" };
  return { run: true };
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastTargetChat: number | null = null;
  private noRouteLogged = false;

  constructor(
    private deps: {
      config: () => SuparClawConfig;
      busy: () => boolean;
      sendTurn: (opts: {
        sessionKey: string;
        prompt: string;
        lightContext: boolean;
        isolatedSession: boolean;
        timeoutSeconds: number;
      }) => Promise<string>;
      deliver: (chatId: number, text: string) => Promise<void>;
      deliverFailure?: (text: string) => Promise<void>;
      lastOutbound?: () => number | null;
      log: (s: string) => void;
      hostTimezone?: string;
      now?: () => Date;
    },
  ) {}

  /** Remember where telegram traffic last went (used by target:"last"). */
  rememberOutbound(chatId: number): void {
    this.lastTargetChat = chatId;
  }

  /** Arm the recurring cadence from live config (re-arm on config set). */
  start(): void {
    this.stop();
    const cfg = this.deps.config();
    const every = Math.max(parseHeartbeatEvery(cfg.agents.defaults.heartbeat.every), 60_000);
    if (parseHeartbeatEvery(cfg.agents.defaults.heartbeat.every) <= 0) {
      this.deps.log("heartbeat: recurring cadence disabled (every: 0m)");
      return;
    }
    this.timer = setInterval(() => void this.tick().catch(() => {}), every);
    this.timer.unref?.();
    this.deps.log(`heartbeat: armed every ${every / 1000}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One cadence tick (public for tests). */
  async tick(): Promise<{ ran: boolean; reason?: string; delivered?: boolean }> {
    const cfg = this.deps.config();
    const now = (this.deps.now ?? (() => new Date()))();
    const heart = cfg.agents.defaults.heartbeat;
    const dc = heartbeatDecision(cfg, this.deps.busy(), now, this.deps.hostTimezone);
    if (!dc.run) {
      this.deps.log(`heartbeat: skipped reason=${dc.reason}`);
      return { ran: false, reason: dc.reason };
    }
    const target = resolveHeartbeatTarget(cfg, this.deps.lastOutbound?.() ?? this.lastTargetChat);
    if (target.kind === "no-route") {
      if (!this.noRouteLogged) {
        this.deps.log(`heartbeat: skipped reason=no-route (their ambient-poll no-route rule)`);
        this.noRouteLogged = true;
      }
      return { ran: false, reason: "no-route" };
    }
    if (target.kind === "telegram") this.noRouteLogged = false;
    let sessionKey = "main";
    if (heart.isolatedSession) sessionKey = `heartbeat:${now.getTime()}`;
    const every = parseHeartbeatEvery(heart.every);
    const timeoutSeconds = heart.timeoutSeconds > 0 ? heart.timeoutSeconds : Math.min(Math.floor(every / 1000), 600);
    const reply = await this.deps.sendTurn({
      sessionKey,
      prompt: heart.prompt || DEFAULT_HEARTBEAT_PROMPT,
      lightContext: heart.lightContext,
      isolatedSession: heart.isolatedSession,
      timeoutSeconds,
    });
    const filtered = filterHeartbeatReply(reply);
    if (filtered.kind === "silent") return { ran: true, delivered: false };
    if (target.kind === "none") return { ran: true, delivered: false };
    if (target.kind === "telegram") {
      try {
        await this.deps.deliver(target.chatId!, filtered.text);
        this.lastTargetChat = target.chatId!;
      } catch (e) {
        this.deps.log(`heartbeat: delivery failed (${(e as Error).message})`);
        await this.deps.deliverFailure?.(filtered.text).catch(() => {});
      }
    }
    return { ran: true, delivered: true };
  }

  stats(): { lastTargetChat: number | null; armed: boolean } {
    return { lastTargetChat: this.lastTargetChat, armed: this.timer !== null };
  }
}
