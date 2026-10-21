// Auth profiles — OpenClaw's credential semantics at our single-agent scale:
// typed credentials with expiry validation, explicit per-provider order
// (store override > config), per-profile cooldown/last-good health, and the
// "apiKey names a stored profile" binding that keeps literal keys working.

import type { Store, AuthProfileRow } from "../state/db.js";
import type { SuparClawConfig } from "../config/schema.js";

/** Their stable reason codes (auth-credential-semantics.md) — keep these exact. */
export type AuthReason =
  | "missing_credential"
  | "expired"
  | "invalid_expires"
  | "excluded_by_auth_order"
  | "ineligible_profile"
  | "cooldown";

const MAX_EXPIRES_MS = 8_640_000_000_000_000; // their ceiling (max JS Date)

export interface ProfileCheck {
  ok: boolean;
  reason?: AuthReason;
}

/** Eligibility per their token-credential rules (expires validity + freshness). */
export function profileCheck(row: AuthProfileRow, now = Date.now()): ProfileCheck {
  if (!row.material) return { ok: false, reason: "missing_credential" };
  if (row.expires) {
    if (!Number.isFinite(row.expires) || row.expires <= 0 || row.expires > MAX_EXPIRES_MS) {
      return { ok: false, reason: "invalid_expires" };
    }
    if (row.expires <= now) return { ok: false, reason: "expired" };
  }
  if (row.cooldown_until > now) return { ok: false, reason: "cooldown" };
  return { ok: true };
}

/**
 * Resolved order for a provider: the explicit store override wins over
 * `auth.order.<provider>` config; either list is *exclusive* — a stored
 * profile omitted from it is reported excluded_by_auth_order, never silently
 * tried. No explicit order → all of that provider's profiles, healthy first.
 */
export function resolveAuthProfileOrder(
  store: Store,
  config: SuparClawConfig,
  provider: string,
): { ordered: AuthProfileRow[]; excluded: AuthProfileRow[] } {
  const all = store.authProfiles(provider);
  const explicit = store.authOrder(provider).length
    ? store.authOrder(provider)
    : ((config.auth?.order?.[provider] as string[] | undefined) ?? []);
  if (explicit.length) {
    const order = new Map(all.map((r) => [r.id, r]));
    const ordered = explicit.filter((id) => order.has(id)).map((id) => order.get(id)!);
    const excluded = all.filter((r) => !explicit.includes(r.id));
    return { ordered, excluded };
  }
  // Idle order: never-used profiles behind recently-good ones (their last-good hint).
  const ordered = [...all].sort((a, b) => (b.last_ok_at - b.last_used_at) - (a.last_ok_at - a.last_used_at) || b.last_ok_at - a.last_ok_at);
  return { ordered, excluded: [] };
}

/**
 * The apiKey-binding rule: a provider's apiKey value that matches a stored
 * compatible profile id is a binding (provider + baseUrl realm checked);
 * anything else stays a literal key. `authProfiles: [...]` binds many.
 */
export function boundProfileIds(cfg: Record<string, unknown>, name: string): { single?: string; list: string[] } {
  const list = Array.isArray(cfg["authProfiles"]) ? cfg["authProfiles"].filter((x): x is string => typeof x === "string" && x.includes(":")) : [];
  const key = typeof cfg["apiKey"] === "string" ? cfg["apiKey"].trim() : "";
  const single = key && /^[a-z0-9][a-z0-9-]*:[^/].+$/i.test(key) && key.length < 128 ? key : undefined;
  return { single, list };
}

export interface ResolvedCredential {
  key: string;
  profileId?: string;
}

/**
 * Request-time credential for a provider. Returns the first eligible bound
 * profile; when bindings exist but none is eligible, the error carries their
 * reason code for surfaces to display instead of a bare 401.
 */
export function resolveProviderCredential(
  store: Store,
  config: SuparClawConfig,
  name: string,
  providerCfg: Record<string, unknown>,
): { cred?: ResolvedCredential; reason?: AuthReason; profileId?: string } {
  const { single, list } = boundProfileIds(providerCfg, name);
  const ids = list.length ? list : single ? [single] : [];
  if (ids.length === 0) {
    const literal = typeof providerCfg["apiKey"] === "string" ? providerCfg["apiKey"].trim() : "";
    return literal ? { cred: { key: literal } } : { reason: "missing_credential" };
  }
  const { ordered, excluded } = resolveAuthProfileOrder(store, config, name);
  const bound = ids.map((id) => store.authProfile(id)).filter((r): r is AuthProfileRow => Boolean(r));
  if (bound.length === 0) return { reason: "ineligible_profile", profileId: ids[0] };
  // Names changed to bindings: profile realm must match the provider + its baseUrl.
  const baseUrl = String(providerCfg["baseUrl"] ?? "");
  const realmOk = (r: AuthProfileRow) => r.provider === name || (baseUrl && r.id.startsWith(`${name}:`));
  let saw: AuthReason | undefined;
  for (const row of ordered.filter((r) => ids.includes(r.id) && realmOk(r))) {
    const check = profileCheck(row);
    if (check.ok) return { cred: { key: row.material, profileId: row.id } };
    saw = check.reason;
  }
  // Profiles bound but excluded by the explicit order — their exact code.
  if (ordered.length === 0 && excluded.length > 0) return { reason: "excluded_by_auth_order", profileId: ids[0] };
  return { reason: saw ?? "ineligible_profile", profileId: ids[0] };
}

/** Health marking after an attempt (their cooldown/last-good semantics). */
export function markAuthOutcome(store: Store, profileId: string | undefined, ok: boolean): void {
  if (profileId) store.markAuthUsed(profileId, ok);
}

export interface ProfileStatus {
  id: string;
  provider: string;
  type: string;
  label: string;
  masked: string;
  expires: number;
  expiresIn: string;
  ok: boolean;
  reason?: AuthReason;
  failCount: number;
  cooldownUntil: number;
  lastUsedAt: number;
  lastOkAt: number;
}

/** UI/CLI-safe projection: material NEVER crosses this boundary. */
export function profileStatus(row: AuthProfileRow, now = Date.now()): ProfileStatus {
  const check = profileCheck(row, now);
  const tail = row.material.slice(-4);
  const ms = row.expires ? row.expires - now : 0;
  return {
    id: row.id,
    provider: row.provider,
    type: row.type,
    label: row.label,
    masked: `…${tail}`,
    expires: row.expires,
    expiresIn: row.expires ? (ms <= 0 ? "expired" : `${Math.max(1, Math.round(ms / 3_600_000))}h left`) : "never",
    ok: check.ok,
    reason: check.reason,
    failCount: row.fail_count,
    cooldownUntil: row.cooldown_until,
    lastUsedAt: row.last_used_at,
    lastOkAt: row.last_ok_at,
  };
}

/**
 * Build the effective providers map for a request: profile bindings resolve
 * to fresh material (and remember which profile backed each provider), while
 * an ineligible binding turns the provider into a reason-coded auth error
 * (their contract: never send a doomed call, carry the reason forward).
 */
export function resolveConfiguredProviders(
  store: Store | null,
  config: SuparClawConfig,
): { providers: Record<string, import("./llm.js").ProviderConfig>; profileOf: Record<string, string> } {
  const cfgProviders = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, import("./llm.js").ProviderConfig> = {};
  const profileOf: Record<string, string> = {};
  for (const [name, raw] of Object.entries(cfgProviders)) {
    const base = {
      baseUrl: String(raw["baseUrl"] ?? ""),
      apiKey: typeof raw["apiKey"] === "string" ? raw["apiKey"] : "",
      headers: (raw["headers"] ?? {}) as Record<string, string>,
      models: (raw["models"] ?? []) as string[],
      ...(raw["api"] === "ollama" ? { api: "ollama" as const } : {}),
    };
    if (!store || (boundProfileIds(raw, name).list.length + (boundProfileIds(raw, name).single ? 1 : 0)) === 0) {
      out[name] = base;
      continue;
    }
    const resolved = resolveProviderCredential(store, config, name, raw);
    if (resolved.cred) {
      out[name] = { ...base, apiKey: resolved.cred.key };
      if (resolved.cred.profileId) profileOf[name] = resolved.cred.profileId;
    } else {
      out[name] = {
        ...base,
        apiKey: "",
        authError: `${resolved.reason}: profile ${resolved.profileId ?? idsHint(name)} for ${name} — run \`sc models auth login --provider ${name}\` or \`sc models auth order get --provider ${name}\``,
      };
    }
  }
  return { providers: out, profileOf };
}

const idsHint = (name: string) => `${name}:<profile>`;

/** New profile id: provider:slug with a readable, collision-safe slug. */
export function profileId(provider: string, hint?: string): string {
  const slug = (hint ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug ? `${provider}:${slug}` : `${provider}:${Math.random().toString(36).slice(2, 8)}`;
}
