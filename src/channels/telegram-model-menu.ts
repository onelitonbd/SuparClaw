// Telegram's `/model` card (Task 54): two levels of buttons, no typing.
//
// The operator's spec, verbatim:
//
//   "jokhon ami /model lekhbo eta current model dekhabe ar sathe option
//    dekhabe options hobe provider er joto gulo Provider system e thakbe taderke
//    dekhabe okhane erpor provider e click korle sei provider er selected model
//    gulo show korbe sekhan theke select korte parbe besi hole page akare asbe.
//    sob bubble ui use korbe"
//
// So: level 1 is the providers that exist in the provider system, level 2 is the
// models selected for the provider (Settings → Models is where "selected" is
// decided), more than a page is paged, and every answer is a button.
//
// Everything here is pure: it takes the config and returns text plus an inline
// keyboard. No Telegram client, no network, no state. That is deliberate — the
// card is the one part of this feature that must be right for every config
// shape (no providers, one provider with no models, 30 models), and a pure
// function can be tested against all of them.
//
// Callbacks carry indices and a fingerprint, never a model id: Bot API caps
// callback data at 64 bytes and model refs are longer than that. The
// fingerprint is what makes an index safe — if the list shifted (a model was
// added or removed between drawing the card and tapping it) the tap is refused
// instead of pinning a different model than the one on the button.

import { modelProfile, modelProfiles, type SuparClawConfig } from "../config/schema.js";
import { PICKER_PAGE, type Card, type KeyboardRow } from "./telegram-pickers.js";

/**
 * Rows per page. One number for every picker in Telegram (Task 54b) — the
 * session, repository and branch lists the operator asked for are ten a page,
 * and a model list that paged differently would be a second rule to remember.
 */
export const MODEL_PAGE_SIZE = PICKER_PAGE;
export type { Card, KeyboardRow };
/** Telegram rejects a button label over 64 chars; leave slack for the ✓ prefix. */
const LABEL_MAX = 56;

export interface ModelChoice {
  /** What gets stored in `sessions.model` (a profile id, or a bare ref). */
  id: string;
  /** Human label: the profile's label, else its wire ref, else the id. */
  label: string;
  /** The provider this choice belongs to (the first segment of its ref). */
  provider: string;
}

/**
 * A short, stable fingerprint of a string, in base 36.
 *
 * djb2 — good enough to catch "the list moved" (which is what this is for),
 * cheap enough to run on every tap, and deterministic across processes so a
 * picker drawn before a restart still resolves afterwards.
 */
export function modelFingerprint(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(-5);
}

/** Every provider the provider system knows, sorted, never empty-by-accident. */
export function modelProviders(config: SuparClawConfig): string[] {
  const names = new Set<string>();
  for (const name of Object.keys(config.providers ?? {})) names.add(name);
  // A profile can exist for a provider that is not in `providers` (added by
  // hand in config.json5). It still belongs in the picker — it is selectable.
  for (const p of modelProfiles(config)) {
    const slash = (p.ref ?? "").indexOf("/");
    if (slash > 0) names.add((p.ref ?? "").slice(0, slash));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The models *selected* for one provider.
 *
 * "Selected" is the Settings → Models list: enabled profiles whose ref sits on
 * this provider. When a provider has no profiles yet, its declared
 * `providers.<name>.models[]` entries stand in, so a working provider never has
 * an empty page that reads like a bug.
 */
export function providerModels(config: SuparClawConfig, provider: string): ModelChoice[] {
  const prefix = `${provider}/`;
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const p of modelProfiles(config)) {
    if (!p.enabled) continue;
    if (!(p.ref ?? "").startsWith(prefix)) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, label: p.label || p.ref || p.id, provider });
  }
  if (out.length === 0) {
    for (const raw of config.providers?.[provider]?.models ?? []) {
      const id = `${provider}/${raw}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: raw, provider });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** The model this chat would run on right now: its pin, else the default. */
export interface CurrentModel {
  /** The session pin, raw ("" = none). */
  pin: string;
  /** `agents.defaults.model`, raw. */
  def: string;
  /** What the next turn will actually ask for. */
  requested: string;
  /** The wire ref the next turn will send (what the footer will name). */
  ref: string;
  /** One line to print. */
  label: string;
  /** The configured default, resolved to a label (what "default:" should say). */
  defLabel: string;
  /** True when the pin names something the config no longer resolves. */
  stale: boolean;
  /** The provider of the effective model, when it has one. */
  provider: string;
}

export function currentModel(config: SuparClawConfig, pin: string | null | undefined): CurrentModel {
  const pinned = String(pin ?? "").trim();
  const def = String(config.agents?.defaults?.model ?? "").trim();
  const requested = pinned || def;
  const profile = requested ? modelProfile(config, requested) : null;
  const ref = profile?.ref || requested;
  const slash = ref.indexOf("/");
  // A pin is stale when it is not an enabled profile id and is not a
  // `provider/model` ref on a provider we still have. It must never fail a
  // turn, so the loop falls back — this is the same rule, said out loud.
  const isProfile = pinned ? modelProfiles(config).some((p) => p.id === pinned && p.enabled) : false;
  const providerOfPin = slash > 0 ? ref.slice(0, slash) : "";
  const stale = Boolean(pinned) && !isProfile && !(providerOfPin && config.providers?.[providerOfPin]);
  const label = pinned
    ? `${profile?.label || ref || pinned}${stale ? " (no longer configured)" : ""}`
    : `${profile?.label || requested || "(unset)"}`;
  const defLabel = def ? modelProfile(config, def).label || def : "";
  return {
    pin: pinned,
    def,
    defLabel,
    requested,
    ref,
    label,
    stale,
    provider: slash > 0 ? ref.slice(0, slash) : "",
  };
}

const clip = (s: string): string => (s.length <= LABEL_MAX ? s : `${s.slice(0, LABEL_MAX - 1)}…`);

function pageOf<T>(items: T[], page: number): { slice: T[]; start: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / MODEL_PAGE_SIZE));
  const at = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const start = at * MODEL_PAGE_SIZE;
  return { slice: items.slice(start, start + MODEL_PAGE_SIZE), start, pages };
}

export interface CardOptions {
  config: SuparClawConfig;
  /** The session's pin, if any. */
  pin?: string | null;
  page?: number;
}

/** Level 1 — the current model, then one button per provider. */
export function providerCard(opts: CardOptions): Card {
  const { config } = opts;
  const cur = currentModel(config, opts.pin);
  const providers = modelProviders(config);
  const head = cur.pin
    ? `Model — this chat: ${cur.label}\ndefault: ${cur.defLabel || "(unset)"}`
    : `Model — current: ${cur.requested ? cur.label : "(unset)"}\nPick a provider to choose a model for this chat.`;

  if (providers.length === 0) {
    return {
      text: `${head}\n\nNo providers yet — add one on the gateway: sc provider add <name> [url] [key], or Settings → Models.`,
      keyboard: null,
    };
  }

  const { slice, start, pages } = pageOf(providers, opts.page ?? 0);
  const rows: KeyboardRow[][] = slice.map((name, i) => {
    const count = providerModels(config, name).length;
    const mark = cur.provider === name ? "✓ " : "";
    return [{ text: clip(`${mark}${name}${count ? ` · ${count}` : ""}`), callback_data: `m:o:${start + i}` }];
  });
  const nav: KeyboardRow[] = [];
  if (pages > 1 && start > 0) nav.push({ text: "‹ Back", callback_data: `m:p:${Math.max(0, (start / MODEL_PAGE_SIZE) | 0) - 1}` });
  if (pages > 1 && start + slice.length < providers.length) {
    nav.push({ text: "More ›", callback_data: `m:p:${((start / MODEL_PAGE_SIZE) | 0) + 1}` });
  }
  if (nav.length) rows.push(nav);
  const actions: KeyboardRow[] = [];
  if (cur.pin) actions.push({ text: "Use default", callback_data: "m:d" });
  if (cur.pin) actions.push({ text: "Make default", callback_data: "m:g" });
  if (actions.length) rows.push(actions);
  return { text: head, keyboard: rows };
}

/** Level 2 — one provider's selected models, paged. */
export function modelCard(opts: CardOptions & { provider: string }): Card {
  const { config, provider } = opts;
  const cur = currentModel(config, opts.pin);
  const models = providerModels(config, provider);
  // Only name the current model when it lives on this provider — "current:
  // GPT-5.1" under an Anthropic heading reads like a mistake.
  const onThisProvider = cur.provider === provider;
  const head = `${provider} — pick a model${onThisProvider && cur.requested ? `\ncurrent: ${cur.label}` : ""}`;
  if (models.length === 0) {
    return {
      text: `${head}\n\nNo models selected for ${provider} — add them in Settings → Models (or sc models add).`,
      keyboard: [[{ text: "‹ Providers", callback_data: `m:p:0` }]],
    };
  }
  const { slice, start, pages } = pageOf(models, opts.page ?? 0);
  // The ✓ marks what this chat would actually run on — the pin, or the default
  // when nothing is pinned. Comparing ids and refs covers both spellings of the
  // same model (a profile id on one side, `provider/model` on the other).
  const targetRef = cur.requested ? modelProfile(config, cur.requested).ref : "";
  const inUse = (m: ModelChoice): boolean =>
    m.id === cur.requested || Boolean(targetRef) && modelProfile(config, m.id).ref === targetRef;
  const rows: KeyboardRow[][] = slice.map((m, i) => [
    {
      text: clip(`${inUse(m) ? "✓ " : ""}${m.label}`),
      // provider index is stable for the drawn config; the fingerprint makes a
      // shifted list refuse the tap instead of pinning a neighbour.
      callback_data: `m:x:${modelProviders(config).indexOf(provider)}:${start + i}:${modelFingerprint(m.id)}`,
    },
  ]);
  const pIdx = modelProviders(config).indexOf(provider);
  const at = (start / MODEL_PAGE_SIZE) | 0;
  const nav: KeyboardRow[] = [{ text: "‹ Providers", callback_data: "m:p:0" }];
  if (pages > 1 && at > 0) nav.unshift({ text: "‹ Back", callback_data: `m:o:${pIdx}:${at - 1}` });
  if (pages > 1 && start + slice.length < models.length) nav.push({ text: "More ›", callback_data: `m:o:${pIdx}:${at + 1}` });
  rows.push(nav);
  return { text: head, keyboard: rows };
}

/**
 * The card after a choice: what is now true, and the two ways back.
 *
 * Deliberately still a card — "Use default" is one tap away, not a command to
 * remember — but the list is gone, so nothing stale is left to tap.
 */
export function pinnedCard(opts: { config: SuparClawConfig; pin: string | null }): Card {
  const cur = currentModel(opts.config, opts.pin);
  // The wire ref is printed on purpose: it is what the next answer's footer
  // will show, so "it said it changed but didn't" is checkable at a glance
  // instead of a feeling (Task 56).
  const text = cur.pin
    ? cur.stale
      ? `⚠️ Model: ${cur.requested} — pinned to this chat, but it is no longer configured.\nanswers use ${cur.defLabel || "the default"}; /model to pick another`
      : `✅ Model: ${cur.label} — this chat.\nref: ${cur.ref}\ndefault: ${cur.defLabel || "(unset)"}\n/model to change · this chat only`
    : `✅ Model: default${cur.def ? ` (${cur.label})` : ""} — this chat follows the configured default.`;
  const rows: KeyboardRow[][] = [[{ text: "Change", callback_data: "m:p:0" }]];
  if (cur.pin) rows[0]!.push({ text: "Use default", callback_data: "m:d" });
  return { text, keyboard: rows };
}

export type ModelTap =
  | { kind: "providers"; page: number }
  | { kind: "provider"; index: number; page: number }
  | { kind: "model"; provider: string; choice: ModelChoice }
  | { kind: "useDefault" }
  | { kind: "makeDefault" }
  | { kind: "expired" };

/**
 * Read one `m:…` callback against the config as it is *now*.
 *
 * Every branch is bounds-checked and the model branch checks the fingerprint,
 * so a tap drawn against an older config can only ever answer "expired".
 */
export function readModelTap(config: SuparClawConfig, data: string): ModelTap {
  const parts = String(data ?? "").split(":");
  if (parts[0] !== "m") return { kind: "expired" };
  const verb = parts[1] ?? "";
  const num = (raw: string | undefined): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : -1;
  };

  if (verb === "p") {
    const page = num(parts[2] ?? "0");
    return page < 0 ? { kind: "expired" } : { kind: "providers", page };
  }
  if (verb === "d") return { kind: "useDefault" };
  if (verb === "g") return { kind: "makeDefault" };
  if (verb === "o") {
    const index = num(parts[2]);
    const page = num(parts[3] ?? "0");
    const providers = modelProviders(config);
    if (index < 0 || index >= providers.length || page < 0) return { kind: "expired" };
    return { kind: "provider", index, page };
  }
  if (verb === "x") {
    const providerIndex = num(parts[2]);
    const modelIndex = num(parts[3]);
    const fp = parts[4] ?? "";
    const providers = modelProviders(config);
    const provider = providers[providerIndex];
    if (!provider) return { kind: "expired" };
    const choice = providerModels(config, provider)[modelIndex];
    if (!choice) return { kind: "expired" };
    if (!fp || modelFingerprint(choice.id) !== fp) return { kind: "expired" };
    return { kind: "model", provider, choice };
  }
  return { kind: "expired" };
}

/**
 * What a tap does, in one place: the card to paint and the side effect to take.
 *
 * Keeping the effect here (not in the channel) is what makes the whole flow
 * testable without a Bot API: the Telegram branch only paints the returned card
 * and answers the callback. `setPin`/`makeDefault` are injected so this module
 * never touches a store or a config service.
 */
export interface TapEnvironment {
  config: SuparClawConfig;
  /** The pin this chat has right now ("" = the default). */
  pin: string;
  /** Pin (or clear, with null) the model of this chat's session. */
  setPin: (model: string | null) => void;
  /** Promote a model to `agents.defaults.model`. */
  makeDefault: (model: string) => { ok: boolean; error?: string };
}

export type TapEffect =
  | { kind: "card"; card: Card }
  | { kind: "error"; alert: string }
  | { kind: "default"; text: string };

export function applyModelTap(env: TapEnvironment, data: string): TapEffect {
  const tap = readModelTap(env.config, data);
  if (tap.kind === "expired") return { kind: "error", alert: "This picker expired — send /model again" };
  if (tap.kind === "providers") {
    return { kind: "card", card: providerCard({ config: env.config, pin: env.pin, page: tap.page }) };
  }
  if (tap.kind === "provider") {
    const provider = modelProviders(env.config)[tap.index] ?? "";
    return { kind: "card", card: modelCard({ config: env.config, pin: env.pin, provider, page: tap.page }) };
  }
  if (tap.kind === "useDefault") {
    env.setPin(null);
    return { kind: "card", card: pinnedCard({ config: env.config, pin: null }) };
  }
  if (tap.kind === "makeDefault") {
    if (!env.pin) return { kind: "error", alert: "nothing pinned — pick a model first" };
    const saved = env.makeDefault(env.pin);
    if (!saved.ok) return { kind: "error", alert: `could not save: ${saved.error ?? ""}`.slice(0, 180) };
    // Label from the pin (the value just written), not from `config` — the
    // caller's copy may predate the save.
    const label = currentModel(env.config, env.pin).label;
    env.setPin(null);
    return { kind: "default", text: `✅ Default model: ${label} — every chat.\nThis chat follows it now.` };
  }
  // tap.kind === "model"
  env.setPin(tap.choice.id);
  return { kind: "card", card: pinnedCard({ config: env.config, pin: tap.choice.id }) };
}

/**
 * What `/model <text>` means, so the typed form keeps working next to the
 * buttons. Returns the pin to store ("" clears it) or a usage line.
 */
export function readModelArgument(
  config: SuparClawConfig,
  arg: string,
): { action: "pin"; pin: string; label: string } | { action: "clear" } | { action: "help"; text: string } {
  const raw = String(arg ?? "").trim();
  if (!raw) return { action: "help", text: "" };
  const low = raw.toLowerCase();
  if (["default", "reset", "clear", "inherit"].includes(low)) return { action: "clear" };
  if (["help", "?"].includes(low)) return { action: "help", text: "" };
  // A profile id is the canonical pin; a bare `provider/model` stays a ref.
  const byId = modelProfiles(config).find((p) => p.id === raw && p.enabled);
  const pin = byId ? byId.id : raw;
  const label = (byId?.label || modelProfile(config, pin).label || pin).trim();
  return { action: "pin", pin, label };
}
