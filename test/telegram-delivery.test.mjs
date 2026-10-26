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
