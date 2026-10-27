// Task 54 — `/model` on Telegram: two levels of bubbles.
//
// The operator's spec, verbatim:
//
//   "jokhon ami /model lekhbo eta current model dekhabe ar sathe option dekhabe
//    options hobe provider er joto gulo Provider system e thakbe taderke
//    dekhabe okhane erpor provider e click korle sei provider er selected model
//    gulo show korbe sekhan theke select korte parbe besi hole page akare asbe.
//    sob bubble ui use korbe"
//
// This file tests the card itself (pure functions): what it says, which buttons
// it offers, how paging behaves, and what a tap means — including the taps that
// must be refused. The effect of a tap (writing the pin) is tested next door in
// session-model.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  MODEL_PAGE_SIZE,
  providerCard,
  modelCard,
  pinnedCard,
  providerModels,
  modelProviders,
  modelFingerprint,
  currentModel,
  readModelTap,
  readModelArgument,
  applyModelTap,
  emptyConfig,
} = await import("../dist/lib.js");

/** Two providers, four selected models, one profile carrying tuning. */
function config() {
  const cfg = emptyConfig();
  cfg.providers = {
    anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "k", models: ["claude-sonnet-4-5", "claude-opus-4-1"] },
    openai: { baseUrl: "https://api.openai.com", apiKey: "k", models: ["gpt-5-1"] },
    kilo: { baseUrl: "https://kilo.example", apiKey: "", models: [] },
  };
  cfg.models = {
    "claude-sonnet": { ref: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", enabled: true },
    "claude-opus": { ref: "anthropic/claude-opus-4-1", label: "Claude Opus 4.1", enabled: true },
    "gpt-51": { ref: "openai/gpt-5-1", label: "GPT-5.1", enabled: true },
    "claude-off": { ref: "anthropic/claude-haiku-4", label: "Claude Haiku 4", enabled: false },
  };
  cfg.agents.defaults.model = "gpt-51";
  return cfg;
}

const labels = (card) => (card.keyboard ?? []).flat().map((b) => b.text);
const datas = (card) => (card.keyboard ?? []).flat().map((b) => b.callback_data);

test("every provider in the provider system gets a button, and only those", () => {
  const cfg = config();
  assert.deepEqual(modelProviders(cfg), ["anthropic", "kilo", "openai"]);

  const card = providerCard({ config: cfg });
  assert.match(card.text, /Model — current: GPT-5\.1/, "the card leads with what is running now");
  assert.deepEqual(
    labels(card).filter((t) => !t.startsWith("‹") && !t.startsWith("More")),
    ["anthropic · 2", "kilo", "✓ openai · 1"],
    "one button per provider, with how many models each one has selected",
  );
  // kilo declares no models and owns no profile: it is still reachable.
  assert.ok(datas(card).includes("m:o:1"));
  for (const d of datas(card)) assert.ok(d.length <= 64, `callback ${d} fits Telegram's 64-byte cap`);
});

test("a provider tap lists that provider's selected models, and nothing else", () => {
  const cfg = config();
  const card = modelCard({ config: cfg, provider: "anthropic" });
  assert.match(card.text, /^anthropic — pick a model/);
  assert.deepEqual(
    labels(card).filter((t) => !t.startsWith("‹")),
    ["Claude Opus 4.1", "Claude Sonnet 4.5"],
    "only enabled profiles on anthropic; the disabled one is not offered",
  );
  // Nothing from another provider leaks in.
  assert.ok(!labels(card).some((t) => /GPT/.test(t)));
  assert.ok(datas(card).includes("m:p:0"), "there is always a way back to the providers");
});

test("the current model is marked at both levels", () => {
  const cfg = config();
  // GPT-5.1 is the default, so its provider carries the ✓ and its row does too.
  const providers = providerCard({ config: cfg });
  assert.ok(labels(providers).some((t) => t.startsWith("✓ openai")));
  const models = modelCard({ config: cfg, provider: "openai" });
  assert.ok(labels(models).some((t) => t.startsWith("✓ GPT-5.1")));

  // A pin moves the ✓ without touching the default.
  const pinned = providerCard({ config: cfg, pin: "claude-opus" });
  assert.match(pinned.text, /this chat: Claude Opus 4\.1/);
  assert.match(pinned.text, /default: GPT-5\.1/);
  assert.ok(labels(pinned).some((t) => t.startsWith("✓ anthropic")));
});

test("more than a page is pages, with a way forward and back", () => {
  const cfg = emptyConfig();
  cfg.providers = { big: { baseUrl: "", apiKey: "", models: [] } };
  cfg.models = {};
  for (let i = 0; i < 20; i++) {
    cfg.models[`m${i}`] = { ref: `big/model-${String(i).padStart(2, "0")}`, label: `Model ${String(i).padStart(2, "0")}`, enabled: true };
  }
  const first = modelCard({ config: cfg, provider: "big", page: 0 });
  assert.equal(labels(first).filter((t) => /^Model /.test(t)).length, MODEL_PAGE_SIZE, "eight rows a page");
  assert.ok(datas(first).includes("m:o:0:1"), "More › points at the next page");

  const last = modelCard({ config: cfg, provider: "big", page: 2 });
  assert.equal(labels(last).filter((t) => /^Model /.test(t)).length, 4, "20 models = 8 + 8 + 4");
  assert.ok(datas(last).includes("m:o:0:1"), "Back › returns a page");
  assert.ok(!datas(last).some((d) => d === "m:o:0:3"), "and stops at the last page");

  // A page number past the end clamps instead of rendering an empty card.
  const past = modelCard({ config: cfg, provider: "big", page: 99 });
  assert.ok(labels(past).some((t) => /^Model /));
});

test("a tap is resolved against the config as it is now, never against memory", () => {
  const cfg = config();
  const card = modelCard({ config: cfg, provider: "anthropic" });
  const pick = datas(card).find((d) => d.startsWith("m:x:"));

  const tap = readModelTap(cfg, pick);
  assert.equal(tap.kind, "model");
  assert.equal(tap.choice.id, "claude-opus", "the row that was drawn is the row that is pinned");
  assert.equal(tap.provider, "anthropic");

  // The same card after the model was removed: the index now points at a
  // different model, and the fingerprint catches it.
  const changed = config();
  delete changed.models["claude-opus"];
  assert.equal(readModelTap(changed, pick).kind, "expired", "a shifted list cannot pin a neighbour");

  // A tampered fingerprint is refused too.
  const tampered = pick.replace(/:([^:]+)$/, ":zzzzz");
  assert.equal(readModelTap(cfg, tampered).kind, "expired");

  // Out of range, wrong verb, garbage.
  assert.equal(readModelTap(cfg, "m:x:9:0:abc").kind, "expired");
  assert.equal(readModelTap(cfg, "m:nope").kind, "expired");
  assert.equal(readModelTap(cfg, "r:0:1").kind, "expired", "another picker's namespace is not ours");
});

test("the provider and paging verbs resolve, and know their own bounds", () => {
  const cfg = config();
  assert.deepEqual(readModelTap(cfg, "m:o:1"), { kind: "provider", index: 1, page: 0 });
  assert.deepEqual(readModelTap(cfg, "m:o:0:2"), { kind: "provider", index: 0, page: 2 });
  assert.deepEqual(readModelTap(cfg, "m:p:3"), { kind: "providers", page: 3 });
  assert.deepEqual(readModelTap(cfg, "m:d"), { kind: "useDefault" });
  assert.deepEqual(readModelTap(cfg, "m:g"), { kind: "makeDefault" });
  assert.equal(readModelTap(cfg, "m:o:9").kind, "expired", "no such provider");
  assert.equal(readModelTap(cfg, "m:o:-1").kind, "expired");
});

test("a provider with no models says so instead of showing an empty card", () => {
  const cfg = config();
  const card = modelCard({ config: cfg, provider: "kilo" });
  assert.match(card.text, /No models selected for kilo/);
  assert.match(card.text, /Settings → Models/);
  assert.deepEqual(labels(card), ["‹ Providers"], "the only sensible action is going back");
});

test("no providers at all is a sentence, not a dead button", () => {
  const cfg = emptyConfig();
  cfg.providers = {};
  cfg.models = {};
  const card = providerCard({ config: cfg });
  assert.match(card.text, /No providers yet/);
  assert.match(card.text, /sc provider add/);
  assert.equal(card.keyboard, null);
});

test("the confirmation card keeps a way back, and only offers 'default' when there is a pin", () => {
  const cfg = config();
  const pinned = pinnedCard({ config: cfg, pin: "claude-sonnet" });
  assert.match(pinned.text, /✅ Model: Claude Sonnet 4\.5 — this chat\./);
  assert.match(pinned.text, /default: GPT-5\.1/);
  assert.deepEqual(labels(pinned), ["Change", "Use default"]);

  const cleared = pinnedCard({ config: cfg, pin: null });
  assert.match(cleared.text, /default/);
  assert.deepEqual(labels(cleared), ["Change"], "nothing to reset when nothing is pinned");
});

test("the typed form pins the same things the buttons do", () => {
  const cfg = config();
  assert.deepEqual(readModelArgument(cfg, "claude-opus"), { action: "pin", pin: "claude-opus", label: "Claude Opus 4.1" });
  // A bare provider ref stays a ref (it may name a model no profile lists).
  const ref = readModelArgument(cfg, "openai/gpt-5-nano");
  assert.equal(ref.action, "pin");
  assert.equal(ref.pin, "openai/gpt-5-nano");
  for (const word of ["default", "reset", "clear", "inherit", "DEFAULT"]) {
    assert.deepEqual(readModelArgument(cfg, word), { action: "clear" });
  }
  assert.equal(readModelArgument(cfg, "help").action, "help");
  assert.equal(readModelArgument(cfg, "  ").action, "help");
});

test("a stale pin is shown, flagged, and never silently substituted", () => {
  const cfg = config();
  const cur = currentModel(cfg, "claude-deleted");
  assert.equal(cur.pin, "claude-deleted");
  assert.equal(cur.stale, true);
  assert.match(cur.label, /no longer configured/);
  // ... while a hand-typed ref on a live provider is not stale.
  assert.equal(currentModel(cfg, "openai/gpt-5-nano").stale, false);
  // An enabled profile is not stale, and neither is no pin at all.
  assert.equal(currentModel(cfg, "claude-opus").stale, false);
  assert.equal(currentModel(cfg, null).stale, false);
});

test("a long model id is still a legal button (label clipped, callback tiny)", () => {
  const cfg = emptyConfig();
  cfg.providers = { p: { baseUrl: "", apiKey: "", models: [] } };
  cfg.models = {
    long: {
      ref: "p/" + "x".repeat(120),
      label: "A model with a name so long that it would overflow a Telegram button on any phone known to man",
      enabled: true,
    },
  };
  const card = modelCard({ config: cfg, provider: "p" });
  const button = (card.keyboard ?? []).flat().find((b) => b.callback_data.startsWith("m:x:"));
  assert.ok(button);
  assert.ok(button.text.length <= 64, "Telegram rejects a longer label");
  assert.ok(button.callback_data.length <= 64);
  assert.equal(readModelTap(cfg, button.callback_data).kind, "model");
});

test("the fingerprint is stable across processes and configs", () => {
  // It is a pure function of the id — that is what lets a card survive a restart.
  assert.equal(modelFingerprint("claude-opus"), modelFingerprint("claude-opus"));
  assert.notEqual(modelFingerprint("claude-opus"), modelFingerprint("claude-sonnet"));
  assert.ok(modelFingerprint("x").length <= 5);
});

/** A tap environment that records what the cards would have done. */
function env(cfg, pin = "") {
  const state = { pin, persisted: pin || null, madeDefault: "", saved: true };
  return {
    state,
    env: {
      config: cfg,
      get pin() {
        return state.pin;
      },
      setPin(model) {
        state.pin = model ?? "";
        state.persisted = model;
      },
      makeDefault(model) {
        state.madeDefault = model;
        if (!state.saved) return { ok: false, error: "no token for that provider" };
        return { ok: true };
      },
    },
  };
}

test("tapping a model pins it, and the card says what is now true", () => {
  const cfg = config();
  const { env: e, state } = env(cfg);
  const card = modelCard({ config: cfg, provider: "anthropic" });
  const pick = datas(card).find((d) => d.startsWith("m:x:"));

  const effect = applyModelTap(e, pick);
  assert.equal(effect.kind, "card");
  assert.equal(state.persisted, "claude-opus", "the choice is written to the session");
  assert.match(effect.card.text, /✅ Model: Claude Opus 4\.1 — this chat\./);
  assert.deepEqual(effect.card.keyboard.flat().map((b) => b.text), ["Change", "Use default"]);
});

test("'Use default' clears the pin; 'Make default' moves the pin to the config", () => {
  const cfg = config();
  const pinned = env(cfg, "claude-opus");

  const cleared = applyModelTap(pinned.env, "m:d");
  assert.equal(cleared.kind, "card");
  assert.equal(pinned.state.persisted, null, "the pin is gone");
  assert.match(cleared.card.text, /follows the configured default/);

  const again = env(cfg, "claude-opus");
  const promoted = applyModelTap(again.env, "m:g");
  assert.equal(promoted.kind, "default");
  assert.equal(again.state.madeDefault, "claude-opus", "the pinned model becomes agents.defaults.model");
  assert.equal(again.state.persisted, null, "and the pin is cleared — it would be redundant");
  assert.match(promoted.text, /Default model: Claude Opus 4\.1 — every chat/);

  // Nothing pinned: there is nothing to promote, and that is said out loud.
  const empty = applyModelTap(env(cfg).env, "m:g");
  assert.equal(empty.kind, "error");
  assert.match(empty.alert, /nothing pinned/);

  // A refused save is reported, not swallowed.
  const refused = env(cfg, "claude-opus");
  refused.state.saved = false;
  const failed = applyModelTap(refused.env, "m:g");
  assert.equal(failed.kind, "error");
  assert.match(failed.alert, /could not save/);
  assert.equal(refused.state.persisted, "claude-opus", "the pin survives a failed promotion");
});

test("paging and provider taps paint cards instead of changing anything", () => {
  const cfg = config();
  const { env: e, state } = env(cfg, "claude-opus");

  const providers = applyModelTap(e, "m:p:0");
  assert.equal(providers.kind, "card");
  assert.match(providers.card.text, /Model — this chat: Claude Opus 4\.1/);

  const opened = applyModelTap(e, "m:o:0");
  assert.equal(opened.kind, "card");
  assert.match(opened.card.text, /^anthropic — pick a model/);
  assert.equal(state.persisted, "claude-opus", "browsing never changes the pin");
});

test("a stale tap is an alert, never a silent no-op", () => {
  const cfg = config();
  const { env: e, state } = env(cfg);
  const effect = applyModelTap(e, "m:x:9:9:abc");
  assert.equal(effect.kind, "error");
  assert.match(effect.alert, /expired/);
  assert.equal(state.persisted, null);
});
