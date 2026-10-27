// Task 53 — what a Telegram turn actually posts.
//
// The operator's rule, twice: "I don't need to see what tool it is using, what
// it is thinking — I just need the answer", and then, after seeing the status
// bubbles: "we dont need them on telegram the tool uses and working and
// thinking … we just need the responses. if the ai gives multiple responses for
// a single quary i want them come instantly all one by one when it tells."
//
// So these drive the real delivery module with a fake bot and assert two things
// over and over: nothing but answers is ever posted, and a block of the answer
// is posted the moment it is finished — never glued into one wall at the end,
// never repeated by the tail.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createTurnDelivery, remainderAfter, isTransientTelegramError } = await import("../dist/lib.js");

/** A fake grammy bot: records calls, numbers messages, can fail on demand. */
function fakeApi({ failSend = () => false } = {}) {
  let nextId = 100;
  const calls = [];
  const api = {
    calls,
    async sendMessage(chatId, text, extra) {
      const id = nextId++;
      if (failSend(text, extra)) {
        calls.push({ op: "send", chatId, text, extra, failed: true });
        throw new Error("400 Bad Request: can't parse entities");
      }
      calls.push({ op: "send", chatId, text, extra, message_id: id });
      return { message_id: id };
    },
  };
  return api;
}

/** A bot whose sends fail a controllable number of times, then work. */
function flakyApi({ failSendTimes = 0, error = new Error("Network request for 'sendMessage' failed! (ETIMEDOUT)") } = {}) {
  let nextId = 500;
  let remaining = failSendTimes;
  const calls = [];
  return {
    calls,
    async sendMessage(chatId, text, extra) {
      if (remaining > 0) {
        remaining -= 1;
        calls.push({ op: "send", text, extra, failed: true });
        throw error;
      }
      const id = nextId++;
      calls.push({ op: "send", text, extra, message_id: id });
      return { message_id: id };
    },
  };
}

const texts = (api) => api.calls.filter((c) => c.op === "send" && !c.failed).map((c) => c.text);

// ---------------------------------------------------------------------------
// The thing the operator asked for: no status bubbles, ever.
// ---------------------------------------------------------------------------

test("a turn posts no status message — not 'working', not a stage, not a tool", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.say("Looking at the files.");
  await d.reply("Here is the **answer**.");
  await d.settled();
  const all = api.calls.map((c) => c.text);
  assert.deepEqual(all, ["Looking at the files.", "Here is the <b>answer</b>."], "exactly the words the model wrote");
  for (const bad of [/working/i, /thinking/i, /reading files/i, /running a command/i, /exec/, /fs_read/]) {
    assert.ok(!all.some((t) => bad.test(t)), `nothing matched ${bad}: ${JSON.stringify(all)}`);
  }
});

test("the delivery surface has no draft machinery left to call", async () => {
  const d = createTurnDelivery({ api: fakeApi(), chatId: 7 });
  // onTool/onDelta are gone: a caller cannot put a stage on screen by accident.
  assert.deepEqual(Object.keys(d).sort(), ["notify", "reply", "say", "settled"]);
});

test("reasoning has no path into the chat", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  // The module never receives thinking: there is no method that takes it.
  await d.reply("Only the answer.");
  await d.settled();
  assert.deepEqual(texts(api), ["Only the answer."]);
});

// ---------------------------------------------------------------------------
// "multiple responses … come instantly all one by one when it tells"
// ---------------------------------------------------------------------------

test("each finished block is posted immediately, as its own message", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  // The loop's `say` fires before the tool runs, so this must hit Telegram now,
  // not at the end of the turn.
  await d.say("Let me look at the config first.");
  assert.deepEqual(texts(api), ["Let me look at the config first."], "the first block is already out while the tool runs");

  await d.say("Found it — the port is taken.");
  assert.equal(texts(api).length, 2, "the second block followed on its own");

  await d.reply("Fixed. Restart the gateway.");
  await d.settled();
  assert.deepEqual(texts(api), [
    "Let me look at the config first.",
    "Found it — the port is taken.",
    "Fixed. Restart the gateway.",
  ], "one message per block, in order, no repetition");
});

test("the final sends only the tail — a prefix already posted is not repeated", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  const block1 = "First, the plan:\n";
  const block2 = "Done — all three steps ran.\n";
  await d.say(block1);
  await d.reply(block1 + block2);
  await d.settled();
  assert.deepEqual(texts(api), ["First, the plan:", "Done — all three steps ran."]);
});

test("offsets are exact even when a block has trailing whitespace", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  const block1 = "line one\n\n\n";
  const final = block1 + "  line two  \n";
  await d.say(block1);
  await d.reply(final);
  await d.settled();
  assert.deepEqual(texts(api), ["line one", "line two"]);
});

test("a whitespace-only block posts nothing but still advances the ledger", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.say("\n\n");
  assert.equal(api.calls.length, 0, "a blank block is not a message");
  await d.reply("\n\nThe answer.\n");
  await d.settled();
  assert.deepEqual(texts(api), ["The answer."], "and the tail is still right");
});

test("a turn with no tool work is one message (say is never required)", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.reply("Yo Liton 🦀 — what's up?");
  await d.settled();
  assert.deepEqual(texts(api), ["Yo Liton 🦀 — what's up?"]);
});

test("a silent turn posts nothing at all", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.reply("   ");
  await d.settled();
  assert.equal(api.calls.length, 0, "no stray bubble");
});

test("replies are ordered even when the caller does not await them", async () => {
  // Service.send dispatches channel callbacks with `void fn()`; without an
  // internal chain the tail could compute its remainder before the block landed.
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  void d.say("one\n");
  void d.say("two\n");
  void d.reply("one\ntwo\nthree\n");
  await d.settled();
  assert.deepEqual(texts(api), ["one", "two", "three"]);
});

// ---------------------------------------------------------------------------
// The guarantees that predate this task and must survive it.
// ---------------------------------------------------------------------------

test("a rejected HTML send falls back to plain text — the answer is never lost", async () => {
  const api = fakeApi({ failSend: (_text, extra) => extra?.parse_mode === "HTML" });
  const logged = [];
  const d = createTurnDelivery({ api, chatId: 7, log: (m) => logged.push(m) });
  await d.reply("A **bold** answer with a & ampersand");
  await d.settled();
  const plain = api.calls.filter((x) => x.op === "send" && !x.failed);
  assert.equal(plain.length, 1, "exactly one successful message");
  assert.ok(!plain[0].extra?.parse_mode, "sent without parse_mode");
  assert.equal(plain[0].text, "A bold answer with a & ampersand", "tags stripped, entities decoded, nothing lost");
  assert.match(logged.join("\n"), /falling back to plain text/);
});

test("a failed block is not treated as delivered — the final is sent whole", async () => {
  // A gap means "the user did not read this": repeating a line is annoying, a
  // lost answer is a bug.
  // Both the HTML send and its plain-text fallback for the block fail; the final
  // (a different call) goes through. That is the "this block never arrived" case.
  let failsLeft = 2;
  const calls = [];
  const api = {
    async sendMessage(_c, text, extra) {
      if (failsLeft > 0) {
        failsLeft -= 1;
        calls.push({ op: "send", text, failed: true });
        throw new Error("402 Payment Required: chat is gone");
      }
      calls.push({ op: "send", text, extra, message_id: calls.length });
      return { message_id: calls.length };
    },
  };
  const d = createTurnDelivery({ api, chatId: 7, sleep: async () => {} });
  await d.say("block one");
  await d.reply("block one\nblock two");
  await d.settled();
  assert.deepEqual(calls.filter((c) => !c.failed).map((c) => c.text), ["block one\nblock two"], "nothing was skipped");
});

test("a long answer splits; every piece is formatted and stays under the cap", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  const body = Array.from({ length: 40 }, (_, i) => `### Step ${i}\n\n${"detail ".repeat(40)}`).join("\n\n");
  await d.reply(body);
  await d.settled();
  const answers = api.calls.filter((x) => x.op === "send");
  assert.ok(answers.length > 1, `split into ${answers.length} messages`);
  for (const a of answers) {
    assert.ok(a.text.length <= 4096, "under Telegram's limit");
    assert.equal(a.extra.parse_mode, "HTML");
  }
  assert.ok(answers.every((a) => (a.text.match(/<b>/g) ?? []).length === (a.text.match(/<\/b>/g) ?? []).length), "balanced markup");
});

test("a long block from `say` splits the same way and still leaves the right tail", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  const block = `${"block line\n".repeat(600)}`;
  await d.say(block);
  await d.reply(`${block}the end`);
  await d.settled();
  const sent = texts(api);
  assert.ok(sent.length > 1);
  assert.equal(sent.at(-1), "the end", "the tail is not a repeat of the block");
});

test("a transient send failure is retried — the answer still arrives", async () => {
  const api = flakyApi({ failSendTimes: 1 });
  const slept = [];
  const d = createTurnDelivery({ api, chatId: 7, sleep: async (ms) => slept.push(ms) });
  await d.reply("The **answer**.");
  await d.settled();
  const delivered = api.calls.filter((c) => c.op === "send" && !c.failed);
  assert.equal(delivered.length, 1, "exactly one delivered message");
  assert.equal(delivered[0].text, "The <b>answer</b>.");
  assert.deepEqual(slept, [400], "waited once before retrying");
});

test("a 429 honours Telegram's retry_after", async () => {
  const err = Object.assign(new Error("429: Too Many Requests"), { error_code: 429, parameters: { retry_after: 3 } });
  const api = flakyApi({ failSendTimes: 1, error: err });
  const slept = [];
  const d = createTurnDelivery({ api, chatId: 7, sleep: async (ms) => slept.push(ms) });
  await d.reply("hello");
  await d.settled();
  assert.deepEqual(slept, [3000], "waited the 3s Telegram asked for");
  assert.equal(api.calls.filter((c) => c.op === "send" && !c.failed).length, 1);
});

test("a markup rejection is not retried three times — it falls back immediately", async () => {
  const api = fakeApi({ failSend: (_t, extra) => extra?.parse_mode === "HTML" });
  const slept = [];
  const d = createTurnDelivery({ api, chatId: 7, sleep: async (ms) => slept.push(ms) });
  await d.reply("**bold**");
  await d.settled();
  assert.deepEqual(slept, [], "a 400 will fail the same way — no pointless waiting");
  assert.equal(api.calls.filter((x) => x.op === "send" && !x.failed).length, 1, "delivered as plain text");
});

test("an answer Telegram refuses outright becomes a notice, never silence", async () => {
  // The answer cannot be sent in any form (markup rejected, and the plain-text
  // fallback is refused too), but a plain notice still gets through.
  const calls = [];
  const api = {
    async sendMessage(_c, text, extra) {
      if (extra?.parse_mode || /boot/.test(text)) {
        calls.push({ op: "send", text, failed: true });
        throw new Error("400 Bad Request: can't parse entities");
      }
      calls.push({ op: "send", text, message_id: calls.length });
      return { message_id: calls.length };
    },
  };
  const d = createTurnDelivery({ api, chatId: 7, sleep: async () => {}, retries: 0 });
  await d.reply("**boot**");
  await d.settled();
  assert.ok(calls.some((c) => /could not be delivered/.test(c.text ?? "")), `a notice was posted: ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------
// notify(): a signpost is not the answer and must not touch the ledger.
// ---------------------------------------------------------------------------

test("notify posts a line verbatim and leaves the answer ledger alone", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.say("Working on it.");
  await d.notify("3 files changed (+12 −4) · /diff to review");
  await d.reply("Working on it.All done.");
  await d.settled();
  assert.deepEqual(texts(api), ["Working on it.", "3 files changed (+12 −4) · /diff to review", "All done."]);
});

test("notify with nothing to say posts nothing", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.notify("   ");
  await d.settled();
  assert.equal(api.calls.length, 0);
});

// ---------------------------------------------------------------------------

test("remainderAfter is exact, and refuses to guess", () => {
  assert.equal(remainderAfter("a\nb", "a\n"), "b");
  assert.equal(remainderAfter("a\nb", "a\nb"), "");
  assert.equal(remainderAfter("a\nb", "zzz"), "a\nb", "not a prefix ⇒ the whole final");
  assert.equal(remainderAfter("a\nb", "a\n", true), "a\nb", "a gap ⇒ the whole final");
  assert.equal(remainderAfter("  only  ", ""), "only");
  assert.equal(remainderAfter("(no response)", "something else entirely"), "(no response)");
});

test("an empty ledger sends the whole answer", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7 });
  await d.reply("Whole answer.");
  await d.settled();
  assert.deepEqual(texts(api), ["Whole answer."]);
});

test("transient vs permanent errors are classified", () => {
  const t = (m, extra = {}) => isTransientTelegramError(Object.assign(new Error(m), extra));
  assert.equal(t("Network request for 'sendMessage' failed!"), true);
  assert.equal(t("fetch failed"), true);
  assert.equal(t("connect ETIMEDOUT 149.154.167.220:443"), true);
  assert.equal(t("429: Too Many Requests", { error_code: 429 }), true);
  assert.equal(t("500 Internal Server Error", { error_code: 500 }), true);
  assert.equal(t("400 Bad Request: can't parse entities", { error_code: 400 }), false);
  assert.equal(t("403 Forbidden: bot was blocked by the user", { error_code: 403 }), false);
});
