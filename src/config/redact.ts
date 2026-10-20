// Secret redaction for the gateway wire protocol.
//
// The Control UI needs to *edit* config (providers, token) but must never *read*
// raw secrets off the socket: config.get masks them, and config.set recognizes
// the mask sentinels and keeps the stored value. A leaked WS frame (or a
// malicious page that got as far as a connect) then carries nothing valuable.
//
// Sentinel format: "__redacted__:••••<last4>" (or "__redacted__:" for short
// values). isRedacted() matches the prefix; the text after it is display-only.

import type { SuparClawConfig } from "./schema.js";

export const REDACTED_PREFIX = "__redacted__:";

export function maskSecret(value: string | undefined): string {
  if (!value) return "";
  return value.length >= 8
    ? `${REDACTED_PREFIX}••••${value.slice(-4)}`
    : `${REDACTED_PREFIX}`;
}

export function isRedacted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(REDACTED_PREFIX);
}

/** Deep-clone a config with every secret field masked. */
export function redactSecrets(config: SuparClawConfig): SuparClawConfig {
  const out = structuredClone(config) as SuparClawConfig & {
    providers: Record<string, { apiKey: string }>;
  };
  out.gateway.auth.token = maskSecret(out.gateway.auth.token);
  out.channels.telegram.token = maskSecret(out.channels.telegram.token);
  for (const provider of Object.values(out.providers)) {
    provider.apiKey = maskSecret(provider.apiKey);
  }
  return out;
}

/**
 * Walk a value destined for `path` and replace any sentinel string with the
 * current stored value at the same position inside `current`.
 */
export function resolveRedacted(current: unknown, next: unknown): unknown {
  if (isRedacted(next)) {
    return typeof current === "string" ? current : "";
  }
  if (Array.isArray(next)) {
    const curArr = Array.isArray(current) ? current : [];
    return next.map((item, i) => resolveRedacted(curArr[i], item));
  }
  if (next && typeof next === "object") {
    const out: Record<string, unknown> = {};
    const cur = (current ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      out[key] = resolveRedacted(cur[key], value);
    }
    return out;
  }
  return next;
}
