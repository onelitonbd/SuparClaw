// P2 #14 — cron result delivery + failure alerts.
//
// Upstream contract (docs/openclaw/automation/cron-jobs/delivery.md +
// how-it-works.md): a finished job's result travels by its delivery mode —
// "none" keeps it store-only, "announce" posts the final text into a named
// destination session/channel, "webhook" POSTs a JSON payload to a URL under
// a STRICT SSRF policy (public https only; private/loopback/link-local hosts
// and http require an explicit allowlist entry — their
// webhookSsrfPolicy.allowedHostnames rule). Empty results are suppressed by
// default (their "don't announce empties"). Consecutive failures, once past
// the alert threshold, notify the operator at most once per cooldown window.
import { lookup as dnsLookup } from "node:dns/promises";
import type { JobRow } from "../state/db.js";
import type { SuparClawConfig } from "../config/schema.js";

export interface ResolvedDelivery {
  mode: "none" | "announce" | "webhook";
  to: string;
  suppressEmpty: boolean;
}

/** Per-job columns → cron.delivery block → built-in "none" (their precedence). */
export function resolveDelivery(job: JobRow, cron: SuparClawConfig["cron"]): ResolvedDelivery {
  const mode = (job.delivery_mode as ResolvedDelivery["mode"] | null) ?? cron.delivery.mode ?? "none";
  return {
    mode: ["none", "announce", "webhook"].includes(mode) ? mode : "none",
    to: (job.delivery_to ?? cron.delivery.to) || "",
    suppressEmpty: (job.delivery_suppress_empty ?? 1) !== 0 && cron.delivery.suppressEmpty !== false ? true : false,
  };
}

/** Empty-summary suppression: whitespace-only results are not delivered. */
export function isEmptySummary(text: string): boolean {
  return text.trim().length === 0 || text === "(no response)";
}

export interface WebhookPayload {
  jobId: string;
  jobName: string;
  sessionKey: string;
  status: "done";
  text: string;
  finishedAt: number;
}

export function webhookPayload(job: JobRow, text: string): WebhookPayload {
  return {
    jobId: job.id,
    jobName: job.name,
    sessionKey: job.session_key,
    status: "done",
    text,
    finishedAt: Date.now(),
  };
}

// ---- SSRF guard (their webhookSsrfPolicy strictness) -----------------------

function isPrivateAddress(addr: string): boolean {
  if (addr.includes(":")) {
    // IPv6: loopback, link-local, unique-local, v4-mapped forms.
    const low = addr.toLowerCase();
    if (low === "::" || low === "::1") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127) return true; // private / loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true;
  return false;
}

/**
 * Assert a webhook target passes the strict SSRF policy:
 *   - unless allowlisted: https only, hostname required, no credentials
 *   - unless allowlisted: every resolved address must be public
 * Allowlist entries are exact, case-insensitive hostnames (their
 * allowedHostnames shows the same trade for private relays).
 * `lookup` is injectable for tests; returns numeric addresses.
 */
export async function assertWebhookUrl(
  url: string,
  allowedHostnames: string[],
  lookup: (hostname: string) => Promise<{ address: string; family: number }[]> = async (h) => {
    const results = await dnsLookup(h, { all: true });
    return results;
  },
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid webhook URL: ${url}`);
  }
  if (!u.hostname) throw new Error("webhook URL has no hostname");
  const allowed = allowedHostnames.some((h) => h.toLowerCase() === u.hostname.toLowerCase());
  if (allowed) return u;
  if (u.protocol !== "https:") throw new Error("webhook URL must use https (allowlist the hostname in cron.webhookAllowHostnames for http targets)");
  if (u.username || u.password) throw new Error("webhook URL must not embed credentials");
  const addresses = await lookup(u.hostname);
  if (addresses.length === 0) throw new Error(`webhook hostname does not resolve: ${u.hostname}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`webhook target ${u.hostname} resolves to a private address (${address}) — blocked by the SSRF policy (allowlist the hostname in cron.webhookAllowHostnames to override)`);
    }
  }
  return u;
}

/** POST the payload; returns the response status for logging. */
export async function postWebhook(url: URL, payload: WebhookPayload, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.status;
}

// ---- failure alerts ---------------------------------------------------------

/** Consecutive trailing errors a job has accrued (0 = last run healthy). */
export function errorStreak(runs: { job_id: string; status: string }[], jobId: string): number {
  let streak = 0;
  for (const r of runs) {
    if (r.job_id !== jobId) continue;
    if (r.status === "error") streak += 1;
    else break;
  }
  return streak;
}

/** Their threshold + cooldown semantics as a pure decision. */
export function shouldAlert(streak: number, threshold: number, lastAlertAt: number | undefined, cooldownMinutes: number, now = Date.now()): boolean {
  if (streak < threshold) return false;
  if (lastAlertAt !== undefined && now - lastAlertAt < cooldownMinutes * 60_000) return false;
  return true;
}
