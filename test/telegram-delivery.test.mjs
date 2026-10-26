// Task 32 — what a Telegram turn actually posts.
//
// The user's rule: "I don't need to see what tool it is using, what it is
// thinking — I just need the final answer … clean, structured, markdown".
// These drive the real delivery module with a fake bot that records every call.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createTurnDelivery } = await import("../dist/lib.js");

/** A fake grammy bot: records calls, numbers messages, can fail on demand. */
function fakeApi({ failSend = () => false, failEdit = () => false } = {}) {
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
    async editMessageText(chatId, messageId, text, extra) {
      if (failEdit(text, extra)) {
        calls.push({ op: "edit", chatId, messageId, text, extra, failed: true });
        throw new Error("400 Bad Request: can't parse entities");
      }
      calls.push({ op: "edit", chatId, messageId, text, extra });
      return true;
    },
    async deleteMessage(chatId, messageId) {
      calls.push({ op: "delete", chatId, messageId });
      return true;
    },
  };
  return api;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

test("progress (default): tool names never reach the chat", async () => {
  const api = fakeApi();
  const c = clock();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", now: c.now });

  await d.onTool("fs_read");
  await d.reply("**Done** — read 3 files.");

  const texts = api.calls.map((x) => x.text ?? "");
  assert.ok(!texts.some((t) => t.includes("fs_read")), `no tool name in the chat, got: ${JSON.stringify(texts)}`);
  const drafts = api.calls.filter((x) => x.op === "send" && x.message_id === 100);
  assert.equal(drafts.length, 1, "one status draft");
  assert.equal(drafts[0].text, "▌ working…", "the draft starts neutral");
});

test("progress: the draft is a stage, and it is edited in place", async () => {
  const api = fakeApi();
  const c = clock();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", now: c.now });
  await d.onTool("fs_read");
  const firstDraft = api.calls.find((x) => x.op === "send");
  c.tick(2000);
  await d.onTool("exec");
  const edits = api.calls.filter((x) => x.op === "edit");
  assert.ok(edits.length >= 1, "the stage was updated");
  const text = edits.at(-1).text;
  assert.match(text, /Reading files/);
  assert.match(edits.at(-1).messageId === undefined ? text : text, /Running a command/, "stages accumulate into the headline");
  assert.equal(edits.at(-1).messageId, firstDraft.message_id, "same message, edited — not a new one");
  assert.ok(!text.includes("fs_read") && !text.includes("exec"), "stage names, not tool ids");
});

test("progress: the answer is its own formatted message and the draft is deleted", async () => {
  const api = fakeApi();
  const c = clock();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", now: c.now });
  await d.onTool("exec");
  c.tick(3000);
  await d.reply("## Result\n\n- **one**\n- two");

  const deleted = api.calls.find((x) => x.op === "delete");
  assert.ok(deleted, "the status draft is removed");
  assert.equal(deleted.messageId, 100, "…and it is the draft");

  const answer = api.calls.filter((x) => x.op === "send" && x.message_id !== 100).at(-1);
  assert.equal(answer.extra.parse_mode, "HTML", "sent as Telegram HTML, not raw text");
  assert.match(answer.text, /<b>Result<\/b>/);
  assert.match(answer.text, /<b>one<\/b>/);
  assert.ok(!answer.text.includes("##"), "no Markdown sigils survive");
  assert.ok(api.calls.some((x) => x.op === "delete"), "draft cleaned before the answer landed");
});

test("progress: no message is sent for a silent turn", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress" });
  await d.reply("   ");
  assert.equal(api.calls.length, 0, "nothing to say ⇒ nothing posted (no stray … bubble)");
});

test("toolProgress: true brings the raw log back, opt-in only", async () => {
  const api = fakeApi();
  const c = clock();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", toolProgress: true, now: c.now });
  await d.onTool("fs_read");
  c.tick(2000);
  await d.onTool("exec");
  const last = api.calls.filter((x) => x.op === "edit").at(-1);
  assert.match(last.text, /· exec/, "the tool id is there when it was asked for");
});

test("off: no draft, no chatter — the answer still arrives formatted", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7, mode: "off" });
  await d.onDelta("thinking...");
  await d.onTool("fs_read");
  await d.reply("Plain **answer**.");
  assert.equal(api.calls.filter((x) => x.op !== "send").length, 0, "no draft, no edits, no deletes");
  assert.equal(api.calls.length, 1, "exactly one message: the answer");
  assert.equal(api.calls[0].text, "Plain <b>answer</b>.");
});

test("partial: the answer still streams into the draft (old behaviour kept)", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7, mode: "partial" });
  await d.onTool("exec");
  await d.reply("**hi**");
  const edits = api.calls.filter((x) => x.op === "edit");
  assert.equal(edits.at(-1).messageId, 100, "edited in place");
  assert.equal(edits.at(-1).text, "<b>hi</b>");
  assert.equal(api.calls.filter((x) => x.op === "delete").length, 0, "nothing deleted in preview mode");
});

test("a rejected HTML send falls back to plain text — the answer is never lost", async () => {
  // Telegram 400s on markup it cannot parse; that must not swallow the message.
  const api = fakeApi({ failSend: (_text, extra) => extra?.parse_mode === "HTML" });
  const logged = [];
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", log: (m) => logged.push(m) });
  await d.reply("A **bold** answer with a & ampersand");
  const plain = api.calls.filter((x) => x.op === "send" && !x.failed);
  assert.equal(plain.length, 1, "exactly one successful message");
  assert.ok(!plain[0].extra?.parse_mode, "sent without parse_mode");
  assert.equal(plain[0].text, "A bold answer with a & ampersand", "tags stripped, entities decoded, nothing lost");
  assert.match(logged.join("\n"), /falling back to plain text/);
});

test("a rejected HTML edit falls back too", async () => {
  const api = fakeApi({ failEdit: (_t, extra) => extra?.parse_mode === "HTML" });
  const d = createTurnDelivery({ api, chatId: 7, mode: "partial" });
  await d.reply("**bold**");
  const plainEdit = api.calls.filter((x) => x.op === "edit" && !x.failed);
  assert.equal(plainEdit.length, 1);
  assert.equal(plainEdit[0].text, "bold");
});

test("a long answer splits; every piece is formatted and stays under the cap", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress" });
  const body = Array.from({ length: 40 }, (_, i) => `### Step ${i}\n\n${"detail ".repeat(40)}`).join("\n\n");
  await d.reply(body);
  const answers = api.calls.filter((x) => x.op === "send");
  assert.ok(answers.length > 1, `split into ${answers.length} messages`);
  for (const a of answers) {
    assert.ok(a.text.length <= 4096, "under Telegram's limit");
    assert.equal(a.extra.parse_mode, "HTML");
  }
  assert.ok(answers.every((a) => (a.text.match(/<b>/g) ?? []).length === (a.text.match(/<\/b>/g) ?? []).length), "balanced markup");
});

test("reasoning has no path into the chat", async () => {
  // There is no listener for it: the module's surface is exactly these three.
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress" });
  assert.deepEqual(Object.keys(d).sort(), ["onDelta", "onTool", "reply"]);
});

test("the turn's answer is never mixed into the status draft in progress mode", async () => {
  const api = fakeApi();
  const c = clock();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", now: c.now });
  await d.onDelta("Partial answer text that should not be shown yet");
  const draftEdits = api.calls.filter((x) => x.op === "edit");
  assert.ok(draftEdits.every((e) => !e.text.includes("Partial answer")), "the draft holds a stage, never half an answer");
});

// ---------------------------------------------------------------------------
// "The answer was in the web UI but never reached Telegram" — the delivery
// failures behind it. The web gets the answer from the run's `final` event and
// the transcript row; Telegram only gets it if a send succeeds. One transient
// failure used to cost the whole answer, silently.
// ---------------------------------------------------------------------------

const { isTransientTelegramError } = await import("../dist/lib.js");

/** A bot whose sends fail a controllable number of times, then work. */
function flakyApi({ failSendTimes = 0, error = new Error("Network request for 'sendMessage' failed! (ETIMEDOUT)"), failEdit = false } = {}) {
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
    async editMessageText(chatId, messageId, text, extra) {
      if (failEdit) throw new Error("400 Bad Request: message can't be edited");
      calls.push({ op: "edit", messageId, text, extra });
      return true;
    },
    async deleteMessage(chatId, messageId) {
      calls.push({ op: "delete", messageId });
      return true;
    },
  };
}

test("a transient send failure is retried — the answer still arrives", async () => {
  const api = flakyApi({ failSendTimes: 1 }); // first answer send fails, retry works
  const slept = [];
  const d = createTurnDelivery({ api, chatId: 7, mode: "off", sleep: async (ms) => slept.push(ms) });
  await d.reply("The **answer**.");
  const delivered = api.calls.filter((c) => c.op === "send" && !c.failed);
  assert.equal(delivered.length, 1, "exactly one delivered message");
  assert.equal(delivered[0].text, "The <b>answer</b>.");
  assert.deepEqual(slept, [400], "waited once before retrying");
});

test("a 429 honours Telegram's retry_after", async () => {
  const err = Object.assign(new Error("429: Too Many Requests"), { error_code: 429, parameters: { retry_after: 3 } });
  const api = flakyApi({ failSendTimes: 1, error: err });
  const slept = [];
  const d = createTurnDelivery({ api, chatId: 7, mode: "off", sleep: async (ms) => slept.push(ms) });
  await d.reply("hello");
  assert.deepEqual(slept, [3000], "waited the 3s Telegram asked for");
  assert.equal(api.calls.filter((c) => c.op === "send" && !c.failed).length, 1);
});

test("a markup rejection is not retried three times — it falls back immediately", async () => {
  const api = fakeApi({ failSend: (_t, extra) => extra?.parse_mode === "HTML" });
  const slept = [];
  const d = createTurnDelivery({ api, chatId: 7, mode: "off", sleep: async (ms) => slept.push(ms) });
  await d.reply("**bold**");
  assert.deepEqual(slept, [], "a 400 will fail the same way — no pointless waiting");
  assert.equal(api.calls.filter((c) => c.op === "send" && !c.failed).length, 1, "delivered as plain text");
});

test("progress: a failed answer leaves the draft visible, turned into a notice", async () => {
  // Exactly the report: tools ran, the answer existed, Telegram would not take
  // it. The chat must not end up empty, and must not keep saying "working…".
  // The draft send works (it is small, and it happened first); every later send
  // fails, which is what a connection dropping mid-turn looks like.
  const draft = { message_id: 900, text: "▌ working…" };
  let draftSent = false;
  const calls = [];
  const api = {
    async sendMessage(_c, text, extra) {
      if (!draftSent) {
        draftSent = true;
        calls.push({ op: "send", text, extra, message_id: draft.message_id });
        return { message_id: draft.message_id };
      }
      calls.push({ op: "send", text, extra, failed: true });
      throw new Error("Network request for 'sendMessage' failed! (ETIMEDOUT)");
    },
    async editMessageText(_c, id, text) { calls.push({ op: "edit", messageId: id, text }); draft.text = text; return true; },
    async deleteMessage() { calls.push({ op: "delete" }); return true; },
  };
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", sleep: async () => {} });
  const unref = api; // keep the shape readable below
  await d.onTool("exec");
  await d.reply("Here is the **answer**.");

  assert.equal(calls.filter((c) => c.op === "delete").length, 0, "the draft is NOT deleted when the answer failed");
  const notice = calls.filter((c) => c.op === "edit").at(-1);
  assert.ok(notice, "the draft was rewritten");
  assert.match(notice.text, /could not be delivered/);
  assert.match(notice.text, /web chat/, "and says where the answer is");
  assert.ok(!/working…/.test(notice.text), "no endless spinner");
});

test("progress: the draft is deleted only after the answer is confirmed sent", async () => {
  const order = [];
  const api = {
    async sendMessage(_c, text) { order.push(text.includes("<b>") ? "answer" : "draft"); return { message_id: order.length }; },
    async editMessageText() { order.push("edit"); return true; },
    async deleteMessage() { order.push("delete"); return true; },
  };
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress" });
  await d.onTool("exec");
  order.length = 0;
  await d.reply("**Answer**");
  assert.deepEqual(order, ["answer", "delete"], "answer first, cleanup second");
});

test("preview: a failed edit still delivers the answer as its own message", async () => {
  const api = flakyApi({ failSendTimes: 0, failEdit: true });
  const d = createTurnDelivery({ api, chatId: 7, mode: "partial", sleep: async () => {} });
  await d.onTool("exec");
  await d.reply("**Answer**");
  const delivered = api.calls.filter((c) => c.op === "send" && !c.failed && c.text.includes("Answer"));
  assert.equal(delivered.length, 1, "the answer was not lost with the failed edit");
  assert.equal(delivered[0].text, "<b>Answer</b>");
});

test("a silent turn removes a draft it had already shown", async () => {
  const api = fakeApi();
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress" });
  await d.onTool("exec");
  await d.reply("   ");
  assert.equal(api.calls.filter((c) => c.op === "delete").length, 1, "no draft left spinning after an empty answer");
});

test("transient vs permanent errors are classified", () => {
  const t = (m, extra = {}) => isTransientTelegramError(Object.assign(new Error(m), extra));
  assert.equal(t("Network request for 'sendMessage' failed!"), true);
  assert.equal(t("fetch failed"), true);
  assert.equal(t("connect ETIMEDOUT 149.154.167.220:443"), true);
  assert.equal(t("429: Too Many Requests"), true);
  assert.equal(t("Bad Gateway", { error_code: 502 }), true);
  assert.equal(t("400 Bad Request: can't parse entities"), false);
  assert.equal(t("400 Bad Request: message is too long"), false);
  assert.equal(t("403 Forbidden: bot was blocked by the user"), false);
});

// ---------------------------------------------------------------------------
// The other half of the report: the surface that DIDN'T get the answer while
// the web UI did. The service broadcasts the final event (web reads it) before
// it calls the channel's reply, and used to fire that reply with no catch — a
// throw became an unhandled rejection and the chat went quiet.
// ---------------------------------------------------------------------------

const { Service } = await import("../dist/lib.js");

test("a channel reply that throws is logged, not swallowed as an unhandled rejection", async () => {
  const svc = new Service();
  const saved = svc.loop.run.bind(svc.loop);
  const logged = [];
  const originalError = svc.log.error.bind(svc.log);
  svc.log.error = (...args) => {
    logged.push(args.join(" "));
    originalError?.(...args);
  };
  try {
    // A run that produces exactly one final event, like a real turn.
    svc.loop.run = async ({ onEvent }) => {
      onEvent({ type: "final", runId: "r1", text: "Hi there", usage: { total_tokens: 3 } });
    };
    const seen = [];
    const onEvent = (evt) => { if (evt.type === "chat") seen.push(evt.event.type); };
    svc.events.on("event", onEvent);
    try {
      await svc.send({
        sessionKey: "main:reply-throw",
        text: "hello",
        isMainSession: true,
        source: "telegram",
        reply: async () => {
          throw new Error("Network request for 'sendMessage' failed! (ETIMEDOUT)");
        },
      });
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      svc.events.off("event", onEvent);
    }
    assert.ok(seen.includes("final"), "the web surface still received the answer");
    assert.match(logged.join("\n"), /telegram reply delivery failed/, "the failed channel delivery is on the record");
    assert.match(logged.join("\n"), /sendMessage/, "with the real cause");
  } finally {
    svc.loop.run = saved;
    await svc.stop();
  }
});

test("bookkeeping that fails cannot swallow the final event", async () => {
  // `finishRun` sits between the transcript row and the `final` event. When it
  // threw, the answer was persisted (so the web UI showed it after a refresh)
  // and no surface was ever told — the chat stayed on the last tool line.
  const { AgentLoop, Store, emptyConfig, createLogger } = await import("../dist/lib.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sc-final-event-"));
  const store = Store.open(join(dir, "state.sqlite"));
  store.finishRun = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  const config = emptyConfig();
  const llm = {
    async *stream() {
      yield { type: "text", text: "The answer the user is waiting for." };
      yield { type: "usage", usage: { total_tokens: 2 } };
    },
  };
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm });
  const events = [];
  try {
    await loop.run({ sessionKey: "main:finish-fail", text: "hi", onEvent: (e) => events.push(e) });
  } finally {
    store.close();
  }
  const final = events.find((e) => e.type === "final");
  assert.ok(final, "the surfaces were told, despite the failed bookkeeping");
  assert.equal(final.text, "The answer the user is waiting for.");
  assert.ok(!events.some((e) => e.type === "error"), "a bookkeeping failure is not reported as a lost turn");
});

test("a half-delivered long answer says so instead of ending mid-sentence", async () => {
  // First chunk lands, the send of the second fails permanently.
  let sent = 0;
  const calls = [];
  const api = {
    async sendMessage(_c, text, extra) {
      if (text.includes("Part five")) throw new Error("400 Bad Request: message is too long");
      sent += 1;
      calls.push({ op: "send", text, extra });
      return { message_id: 900 + sent };
    },
    async editMessageText(_c, id, text) { calls.push({ op: "edit", text }); return true; },
    async deleteMessage() { calls.push({ op: "delete" }); return true; },
  };
  const d = createTurnDelivery({ api, chatId: 7, mode: "progress", sleep: async () => {} });
  const body = ["Part one", "Part two", "Part three", "Part four", "Part five", "Part six"]
    .map((p) => `${p}\n\n${"filler ".repeat(700)}`) // each too big to share a message
    .join("\n\n");
  await d.reply(body);
  const delivered = calls.filter((c) => c.op === "send" || c.op === "edit").map((c) => c.text);
  assert.ok(delivered.some((t) => /Part one/.test(t)), "the start of the answer arrived");
  assert.ok(delivered.some((t) => /Part of this reply could not be delivered/.test(t)), "and the truncation is flagged");
  assert.ok(delivered.some((t) => /full answer is in the web chat/.test(t)));
});
