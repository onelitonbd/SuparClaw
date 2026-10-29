// Task 22 — the agent knows its surfaces.
//
// The reminder was armed correctly, announced back into the web chat (the
// surface that asked), and the model explained that with "I don't have direct
// Telegram API access from this device" — a limitation it invented, because
// nothing in its context said which channels exist. These cases pin the facts
// that go into the prompt, the delivery-target resolver behind cron_add, and
// the honest delivery line the reply quotes instead of guessing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every await import lives up here: a top-level await below the test() calls
// makes the runner snapshot the list before the last cases register, and they
// silently never run under `node --test`.
process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-surfaces-home-"));
const {
  AgentLoop,
  Service,
  buildRegistry,
  Store,
  createLogger,
  emptyConfig,
  surfacesPromptLine,
  resolveAnnounceTarget,
  describeDelivery,
  surfacesFromConfig,
  NO_SURFACES,
} = await import("../dist/lib.js");

const TG_ON = {
  telegram: { enabled: true, hasToken: true, running: true, username: "suparbot", error: "" },
  telegramChats: ["123456789"],
};

const TG_OFFLINE = {
  telegram: { enabled: true, hasToken: true, running: false, username: "", error: "401 Unauthorized" },
  telegramChats: ["123456789"],
};

test("prompt: Telegram online states the bot, the real chat ids, and the tool that reaches them", () => {
  const line = surfacesPromptLine({ ...TG_ON, telegramChats: ["111", "222"] }, "main:main");
  assert.match(line, /^## Surfaces/);
  assert.match(line, /This chat: the web chat \(session `main:main`\)/);
  assert.match(line, /Telegram: online as @suparbot\. Chats that have messaged the bot: 111, 222\./);
  assert.match(line, /to=telegram:<chatId>/, "the exact parameter is spelled out");
  assert.match(line, /`to=telegram` for the most recent one/);
  assert.match(line, /Delivery is done by the gateway at fire time, not by a tool call/);
  assert.match(line, /Never claim a channel is unreachable unless this block says it is off/);
  assert.match(line, /really does deliver over Telegram/, "the closing line corrects the false-limitation answer");
});

test("prompt: offline, unconfigured and no-chat-yet each say the true reason", () => {
  const offline = surfacesPromptLine(TG_OFFLINE, "main:main");
  assert.match(offline, /Telegram: configured but offline — 401 Unauthorized/);
  assert.match(offline, /do not describe it as missing API access/, "the lie this task fixes");

  const off = surfacesPromptLine(surfacesFromConfig({}), "main:main");
  assert.match(off, /Telegram: not configured on this device/);
  assert.match(off, /say that plainly instead of promising a Telegram message/);
  assert.match(off, /Only what this block lists as reachable will actually deliver/, "and it does not sell a delivery that cannot happen");
  assert.doesNotMatch(off, /online/);

  const cold = surfacesPromptLine({ telegram: TG_ON.telegram, telegramChats: [] }, "main:main");
  assert.match(cold, /online as @suparbot, but no chat has messaged the bot yet/);
  assert.match(cold, /Ask for one message to the bot/);
});

test("prompt: the surface a Telegram turn came from is named as Telegram", () => {
  const line = surfacesPromptLine(TG_ON, "telegram:123456789");
  assert.match(line, /This chat: Telegram \(session `telegram:123456789`\)/);
});

test("resolve: no target keeps the surface that asked", () => {
  const web = resolveAnnounceTarget("", "main:main", TG_ON);
  assert.equal(web.target, "session:main:main");
  assert.match(web.note, /Telegram is online as @suparbot — pass to=telegram to send it to chat 123456789 instead/);

  const dm = resolveAnnounceTarget("", "telegram:123456789", TG_ON);
  assert.equal(dm.target, "telegram:123456789");
  assert.match(dm.note, /via @suparbot on Telegram/);

  // no other surface, nothing to add
  const quiet = resolveAnnounceTarget("", "main:main", NO_SURFACES);
  assert.equal(quiet.target, "session:main:main");
  assert.equal(quiet.note, undefined);
});

test('resolve: "telegram" means the operator chat, and refuses when it cannot deliver', () => {
  assert.equal(resolveAnnounceTarget("telegram", "main:main", TG_ON).target, "telegram:123456789");
  assert.equal(resolveAnnounceTarget(" TG ", "main:main", TG_ON).target, "telegram:123456789");

  const offline = resolveAnnounceTarget("telegram", "main:main", TG_OFFLINE);
  assert.equal(offline.target, "");
  assert.match(offline.error, /configured but not running \(401 Unauthorized\) — announced results would be dropped/);

  const unconfigured = resolveAnnounceTarget("telegram", "main:main", NO_SURFACES);
  assert.match(unconfigured.error, /not configured — connect it in Settings → Channels/);

  const cold = resolveAnnounceTarget("telegram", "main:main", { telegram: TG_ON.telegram, telegramChats: [] });
  assert.match(cold.error, /no Telegram chat has messaged the bot yet/);
  assert.match(cold.error, /pass to=telegram:<chatId>/);
});

test("resolve: explicit ids, bare numbers and session keys pass through with their note", () => {
  assert.equal(resolveAnnounceTarget("telegram:555", "main:main", TG_ON).target, "telegram:555");
  assert.equal(resolveAnnounceTarget("555", "main:main", TG_ON).target, "telegram:555");
  const sess = resolveAnnounceTarget("session:telegram:9", "main:main", TG_ON);
  assert.equal(sess.target, "session:telegram:9");
  assert.equal(sess.error, undefined, "a session target is always legal");

  const bad = resolveAnnounceTarget("carrier pigeon", "main:main", TG_ON);
  assert.equal(bad.target, "");
  assert.match(bad.error, /unsupported delivery target "carrier pigeon"/);
  assert.match(bad.error, /telegram, telegram:<chatId>, session:<key>/);

  // a telegram target while the channel is down is stated, not silently dropped
  assert.match(resolveAnnounceTarget("telegram:555", "main:main", TG_OFFLINE).note, /Telegram is offline \(401 Unauthorized\), so this target will not deliver/);
});

test("describeDelivery: the stored job's line names the live channel", () => {
  const on = { delivery_mode: "announce", delivery_to: "telegram:123456789" };
  assert.equal(describeDelivery(on, TG_ON), "announce → telegram:123456789 via @suparbot on Telegram");
  assert.match(describeDelivery(on, TG_OFFLINE), /Telegram is offline \(401 Unauthorized\)/);
  assert.equal(describeDelivery({ delivery_mode: null, delivery_to: null }, TG_ON), "cron.delivery default");
  assert.equal(describeDelivery({ delivery_mode: "none", delivery_to: null }, TG_ON), "none");
  assert.equal(describeDelivery({ delivery_mode: "webhook", delivery_to: "https://x.test/h" }, TG_ON), "webhook → https://x.test/h");
});

test("wiring: the prompt block and the live provider are in the loop, not an afterthought", () => {
  const loop = readFileSync(new URL("../src/agent/loop.ts", import.meta.url), "utf8");
  assert.match(loop, /surfacesPromptLine\(surfaces, sessionKey\)/, "the block rides the system prompt");
  assert.match(loop, /#surfaceFacts\(\): SurfaceFacts/, "facts are rebuilt per turn");
  assert.match(loop, /surfaces: this\.#surfaceFacts\(\),/, "and handed to the tools");

  const service = readFileSync(new URL("../src/agent/service.ts", import.meta.url), "utf8");
  assert.match(service, /chatSurfaces\(\): SurfaceFacts/);
  assert.match(service, /surfaces: \(\) => this\.chatSurfaces\(\)/);
  assert.match(service, /\^telegram:\(\\d\+\)/, "chat ids come from real sessions");
  assert.match(service, /config\.channels\.telegram\.allowFrom/, "with the allowlist as fallback");
});

// ---- the facts really reach the model ------------------------------------
// A prompt block nobody renders is worse than none: these runs capture the
// exact system message the fake LLM receives.

function runOnce(surfaces) {
  const dir = mkdtempSync(join(tmpdir(), "sc-surfaces-"));
  const store = Store.open(join(dir, "state.sqlite"));
  let system = "";
  const fake = {
    async *stream(opts) {
      const sys = opts.messages.find((m) => m.role === "system");
      if (sys) system = String(sys.content);
      yield { type: "text", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({
    config: emptyConfig(),
    store,
    log: createLogger({ level: "error" }),
    llm: fake,
    tools: [],
    surfaces: surfaces ? () => surfaces : undefined,
  });
  return loop
    .run({ sessionKey: "main:main", text: "remind me at 8", onEvent: () => {} })
    .then(() => {
      store.close();
      return system;
    });
}

test("model: an online Telegram is in the system prompt with its chat id", async () => {
  const system = await runOnce(TG_ON);
  assert.match(system, /## Surfaces/);
  assert.match(system, /Telegram: online as @suparbot\. Chats that have messaged the bot: 123456789\./);
  assert.match(system, /to=telegram:<chatId>/, "the model is told the exact argument");
  assert.match(system, /Never claim a channel is unreachable/);
});

test("model: an offline channel is described as offline, not as missing access", async () => {
  const system = await runOnce(TG_OFFLINE);
  assert.match(system, /Telegram: configured but offline — 401 Unauthorized/);
  assert.doesNotMatch(system, /online as @/);
});

test("model: with no provider wired the block still tells the truth (config only)", async () => {
  const system = await runOnce(undefined);
  assert.match(system, /## Surfaces/);
  assert.match(system, /Telegram: not configured on this device/);
});

test("service: chat ids come from real sessions, with the pairing allowlist as fallback", async () => {
  const svc = new Service();
  try {
    const a = svc.store.ensureSession("telegram:999");
    svc.store.appendMessage(a.id, "user", "hello");
    // last_msg_at is millisecond-stamped: let the clock move so "most recent"
    // is a fact and not a tie broken by row order.
    await new Promise((r) => setTimeout(r, 5));
    const g = svc.store.ensureSession("telegram:888:group");
    svc.store.appendMessage(g.id, "user", "group hello");
    svc.config.channels.telegram.allowFrom.push("777");

    const facts = svc.chatSurfaces();
    assert.equal(facts.telegramChats[0], "888", "the most recently active chat leads");
    assert.ok(facts.telegramChats.includes("999"), "a DM chat id is found from its session key");
    assert.ok(facts.telegramChats.includes("777"), "the pairing allowlist is the fallback");
    assert.equal(new Set(facts.telegramChats).size, facts.telegramChats.length, "no duplicates");
    assert.equal(facts.telegram.enabled, false, "telegram is off in this config");
  } finally {
    await svc.stop();
  }
});

test("loop: a model that asks for Telegram gets the chat id in the tool result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-surfaces-loop-"));
  const store = Store.open(join(dir, "state.sqlite"));
  const config = emptyConfig();
  let secondRound = [];
  let round = 0;
  const fake = {
    async *stream(opts) {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              id: "call-1",
              name: "cron_add",
              args: JSON.stringify({
                name: "Math for Toha",
                schedule: "0 8 * * *",
                tz: "Asia/Dhaka",
                prompt: "Send the math questions and the vabsomprosaron material.",
                to: "telegram",
              }),
            },
          ],
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      secondRound = opts.messages;
      yield { type: "text", text: "scheduled" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({
    config,
    store,
    log: createLogger({ level: "error" }),
    llm: fake,
    tools: buildRegistry(config),
    surfaces: () => TG_ON,
  });
  await loop.run({ sessionKey: "main:main", text: "remind me on telegram at 8", onEvent: () => {} });

  const toolMsg = secondRound.find((m) => m.role === "tool");
  assert.ok(toolMsg, "the tool result came back to the model");
  assert.match(String(toolMsg.content), /delivery: announce → telegram:123456789 via @suparbot on Telegram/);
  assert.match(String(toolMsg.content), /next \d{4}-\d{2}-\d{2}T02:00:00\.000Z/, "8am Dhaka, not a UTC guess");

  const system = String(secondRound.find((m) => m.role === "system")?.content ?? "");
  assert.match(system, /Chats that have messaged the bot: 123456789/, "and the prompt carried the surface inventory");
  assert.equal(store.getJob("math-for-toha").delivery_to, "telegram:123456789");
  store.close();
});
