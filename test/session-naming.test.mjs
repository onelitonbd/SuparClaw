// Task 29 — a session names itself.
//
// The prompt here was the user's: "when I start a new session it asks for a
// name… I want a dedicated setting to select an AI so that whatever channel it
// is, it will name the chat by understanding the first 2 exchanges."
//
// So the cases are about behaviour, not source: a real Service, a stubbed model,
// and the transcript it gets asked about. The stub records the model ref of
// every call, which is how "the naming model, not the chat model" is proven.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-naming-"));
const { Service, namingSample, namingDecision, NAMING_TURNS } = await import("../dist/lib.js");

const TITLE_PROMPT = "Give this conversation a short session title.";

/**
 * A model that answers chat turns and title calls differently, and remembers
 * what each looked like. Installed over `service.loop.llm` so the service's own
 * wiring (which model, which prompt, when) is what gets exercised.
 */
function stubModel(service, titles = ["Telegram Rename Talk"], gate = null) {
  const titlesSeen = [];
  let titleIndex = 0;
  const fake = {
    async *stream(opts) {
      const first = String(opts.messages?.[0]?.content ?? "");
      if (first.includes(TITLE_PROMPT)) {
        if (gate) await gate;
        const title = titles[Math.min(titleIndex++, titles.length - 1)];
        titlesSeen.push({ model: opts.model, prompt: first, maxTokens: opts.maxTokens });
        yield { type: "text", text: title };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield { type: "text", text: `reply ${titlesSeen.length + 1}` };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  service.loop.llm = fake;
  return { titles: titlesSeen };
}

/** One turn through the service, the way every channel does it. */
async function say(service, text, sessionKey = "main:naming") {
  await service.send({ sessionKey, text, source: "cli", reply: () => {} });
  // The title call is fire-and-forget from the final event; let it settle.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const nameOf = (service, key) => service.store.getSessionByKey(key)?.name ?? "";

test("the first exchange names the session, the second refines it, the third does nothing", async () => {
  const svc = new Service();
  svc.config.agents.defaults.model = "demo/chat-model";
  svc.config.agents.defaults.utilityModel = "demo/cheap-model";
  svc.config.providers.demo = { baseUrl: "https://example.test/v1", apiKey: "k", models: ["chat-model", "cheap-model"] };
  const stub = stubModel(svc, ["Telegram Rename Talk", "Telegram Bot Rename"]);

  const key = "main:refine";
  await say(svc, "help me rename the telegram bot", key);
  assert.equal(nameOf(svc, key), "Telegram Rename Talk", "named from the first exchange");
  assert.equal(stub.titles.length, 1);

  await say(svc, "call it SuparClaw instead", key);
  assert.equal(nameOf(svc, key), "Telegram Bot Rename", "refined with the second exchange");
  assert.equal(stub.titles.length, 2);

  await say(svc, "and the description too", key);
  assert.equal(stub.titles.length, 2, "two exchanges is where naming stops");
  assert.equal(nameOf(svc, key), "Telegram Bot Rename");

  // The refinement saw BOTH exchanges; the first call saw one.
  assert.match(stub.titles[0].prompt, /help me rename the telegram bot/);
  assert.doesNotMatch(stub.titles[0].prompt, /call it SuparClaw instead/);
  assert.match(stub.titles[1].prompt, /help me rename the telegram bot/);
  assert.match(stub.titles[1].prompt, /call it SuparClaw instead/);
});

test("the name is written by the naming model, not the chat model", async () => {
  const svc = new Service();
  svc.config.agents.defaults.model = "demo/big-chat-model";
  svc.config.agents.defaults.utilityModel = "demo/cheap-naming-model";
  svc.config.providers.demo = { baseUrl: "https://example.test/v1", apiKey: "k", models: ["big-chat-model", "cheap-naming-model"] };
  const stub = stubModel(svc, ["Cheap Name"]);
  await say(svc, "hello there", "main:model");
  assert.equal(nameOf(svc, "main:model"), "Cheap Name");
  assert.equal(stub.titles[0].model, "demo/cheap-naming-model", "the setting decides");
  assert.equal(stub.titles[0].maxTokens, 24, "a title is a short answer");
});

test("with no naming model it falls back to the default chat model", async () => {
  const svc = new Service();
  svc.config.agents.defaults.model = "demo/only-model";
  svc.config.agents.defaults.utilityModel = "";
  svc.config.providers.demo = { baseUrl: "https://example.test/v1", apiKey: "k", models: ["only-model"] };
  const stub = stubModel(svc, ["Default Model Name"]);
  await say(svc, "anything", "main:fallback");
  assert.equal(nameOf(svc, "main:fallback"), "Default Model Name");
  assert.equal(stub.titles[0].model, "demo/only-model");
});

test("a name you typed is never overwritten — not on the second exchange either", async () => {
  const svc = new Service();
  svc.config.agents.defaults.model = "demo/m";
  svc.config.providers.demo = { baseUrl: "https://example.test/v1", apiKey: "k", models: ["m"] };
  stubModel(svc, ["Auto Name"]);

  const key = "main:manual";
  await say(svc, "first message", key);
  assert.equal(nameOf(svc, key), "Auto Name");

  // The human renames it (the same store call /title and the UI use).
  svc.store.renameSession(svc.store.getSessionByKey(key).id, "My Own Name");
  stubModel(svc, ["Should Never Land"]);
  await say(svc, "second message", key);
  assert.equal(nameOf(svc, key), "My Own Name", "the human wins, permanently");
});

test("commands are not conversation: a /usage opener does not become the title", () => {
  const msgs = [
    { role: "user", content: "/usage cost" },
    { role: "assistant", content: "Reply usage for this session: cost." },
    { role: "user", content: "plan my week" },
    { role: "assistant", content: "Let's start with Monday." },
  ];
  const sample = namingSample(msgs, { turns: 2 });
  assert.doesNotMatch(sample, /\/usage/);
  assert.match(sample, /plan my week/);
  assert.match(sample, /Let's start with Monday/);
});

test("the sample is whole exchanges, ordered, and bounded", () => {
  const msgs = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "user", content: `question ${i} ${"x".repeat(400)}` });
    msgs.push({ role: "assistant", content: `answer ${i} ${"y".repeat(400)}` });
  }
  const sample = namingSample(msgs, { turns: NAMING_TURNS, maxChars: 2000 });
  assert.match(sample, /^User: question 0/);
  assert.match(sample, /answer 1/, "the second exchange is included");
  assert.doesNotMatch(sample, /question 2/, "and only two exchanges are");
  assert.ok(sample.length <= 2000, `bounded, got ${sample.length}`);
});

test("the decision table: empty, human-named, refine once, then stop", () => {
  assert.deepEqual(namingDecision({ name: "", autoTitle: null, used: 0, exchanges: 0 }), { generate: false, reason: "empty" });
  assert.deepEqual(namingDecision({ name: "", autoTitle: null, used: 0, exchanges: 1 }), { generate: true, target: 1, refine: false });
  assert.deepEqual(namingDecision({ name: "Mine", autoTitle: null, used: 0, exchanges: 2 }), {
    generate: false,
    reason: "named-by-human",
  });
  assert.deepEqual(namingDecision({ name: "Auto", autoTitle: "Auto", used: 1, exchanges: 2 }), {
    generate: true,
    target: 2,
    refine: true,
  });
  assert.deepEqual(namingDecision({ name: "Auto", autoTitle: "Auto", used: 2, exchanges: 9 }), {
    generate: false,
    reason: "complete",
  });
});

test("a rename that lands while the name is being thought of is the one that stays", async () => {
  const svc = new Service();
  svc.config.agents.defaults.model = "demo/m";
  svc.config.providers.demo = { baseUrl: "https://example.test/v1", apiKey: "k", models: ["m"] };

  // Hold the naming call open, rename during it, then let it answer: the reply
  // that arrives afterwards must not overwrite the name the human typed.
  let release;
  const gate = new Promise((r) => { release = r; });
  stubModel(svc, ["Late Auto Name"], gate);

  const key = "main:race";
  const turn = say(svc, "start planning the launch", key);
  // The row appears with the turn, and the naming call starts on `final`.
  for (let i = 0; i < 100 && !svc.store.getSessionByKey(key); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 30));
  const row = svc.store.getSessionByKey(key);
  assert.ok(row, "the turn created the session");
  svc.store.renameSession(row.id, "Launch Plan");
  release();
  await turn;

  assert.equal(nameOf(svc, key), "Launch Plan", "the human name survives the late answer");
});
