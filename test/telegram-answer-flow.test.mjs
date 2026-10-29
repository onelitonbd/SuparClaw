// Task 53 — the whole path, not the pieces: Service → delivery → Telegram API.
//
// The promise is a chat transcript that reads like a colleague:
//
//   user:  add a timeout to the fetch
//   bot:   Let me look at the client first.
//   bot:   Found it — `fetch` has no signal. Added one, 30s.
//
// Two messages, in that order, the first one arriving while the tool is still
// running. This drives the real `Service.send` with a scripted model and the
// real `createTurnDelivery` against a fake Bot API, so the glue (the `say`
// event → `onSay` → `say()` chain) is exercised rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sc-ansflow-"));
process.env.SUPARCLAW_HOME = home;

const { Service, createLogger, createTurnDelivery } = await import("../dist/lib.js");

/** Rounds: speak + call a tool, then speak again. */
function scripted() {
  let round = 0;
  return {
    async *stream() {
      round += 1;
      if (round === 1) {
        yield { type: "text", text: "Let me look at the client first.\n" };
        // A real, side-effect-free tool: `time_now` reads the clock.
        yield { type: "tool_calls", calls: [{ id: "c1", name: "time_now", args: "{}" }] };
      } else {
        yield { type: "text", text: "Found it — `fetch` has no signal.\nAdded one, 30s." };
      }
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
}

test("a two-block answer posts as two messages, the first before the turn ends", async () => {
  const svc = new Service();
  try {
    svc.loop.llm = scripted(); // the loop's client: public field, swapped for a script

    const order = [];
    const sent = [];
    const api = {
      async sendMessage(_chatId, text) {
        order.push(`send:${text.split("\n")[0]}`);
        sent.push(text);
        return { message_id: sent.length };
      },
    };
    const delivery = createTurnDelivery({ api, chatId: 42, sleep: async () => {}, retries: 0 });

    await svc.send({
      sessionKey: "main:ansflow",
      text: "add a timeout to the fetch",
      source: "telegram",
      onDelta: () => order.push("delta"),
      onSay: (text) => {
        order.push("say-cb");
        return delivery.say(text);
      },
      onTool: (e) => order.push(`tool:${e.tool ?? e.name ?? "?"}`),
      reply: async (text) => {
        await delivery.reply(text);
        order.push("turn-ended");
      },
    });
    await delivery.settled();

    // Telegram gets rendered HTML; the words are what matter, byte for byte.
    assert.equal(sent.length, 2, "two messages: the block, then the remainder of the final");
    assert.equal(sent[0], "Let me look at the client first.");
    assert.equal(
      sent[1].replace(/<[^>]+>/g, ""),
      "Found it — fetch has no signal.\nAdded one, 30s.",
      "no duplication and no loss — the remainder is exactly the unspoken part",
    );
    assert.match(sent[1], /<code>fetch<\/code>/, "and it still carries its formatting");

    // What the user experiences: the block message, then the rest. The
    // typing indicator is not a message, so it may tick around it.
    const firstSend = order.findIndex((o) => o.startsWith("send:") && o.includes("Let me look"));
    const secondSend = order.findIndex((o) => o.startsWith("send:") && o.includes("Found it"));
    const sayCb = order.indexOf("say-cb");
    const toolTick = order.findIndex((o) => o.startsWith("tool:"));
    assert.ok(toolTick >= 0, "the tool round is visible to the channel (it drives the typing indicator)");
    assert.ok(sayCb >= 0 && sayCb < toolTick, "the block is handed over before the tool round is announced");
    const end = order.indexOf("turn-ended");
    assert.ok(firstSend >= 0 && firstSend < secondSend, "the block lands before the rest of the answer");
    assert.ok(secondSend < end, "and the turn ends after the answer is out");
    assert.equal(order.filter((o) => o.startsWith("send:")).length, 2, "exactly two bubbles");
  } finally {
    await svc.stop();
  }
});

test("a turn with no tool calls posts exactly one message — the answer", async () => {
  const svc = new Service();
  try {
    svc.loop.llm = {
      async *stream() {
        yield { type: "text", text: "Short answer." };
        yield { type: "done", finishReason: "stop" };
      },
      setConfig() {},
    };
    const sent = [];
    const api = {
      async sendMessage(_c, text) {
        sent.push(text);
        return { message_id: sent.length };
      },
    };
    let saidCount = 0;
    const delivery = createTurnDelivery({ api, chatId: 42, sleep: async () => {}, retries: 0 });
    await svc.send({
      sessionKey: "main:ansflow2",
      text: "hi",
      source: "telegram",
      onSay: async (t) => {
        saidCount += 1;
        await delivery.say(t);
      },
      reply: async (text) => delivery.reply(text),
    });
    await delivery.settled();
    assert.equal(saidCount, 0, "no tool round, no block");
    assert.deepEqual(sent, ["Short answer."]);
  } finally {
    await svc.stop();
  }
});

test("the web chat is untouched: no onSay means no extra bubble, the whole answer still streams", async () => {
  const svc = new Service();
  try {
    svc.loop.llm = scripted();
    const deltas = [];
    let final = "";
    // The gateway's own callback set: onDelta + onFinal, no onSay, and a reply
    // that records the transcript row the web UI reads.
    await svc.send({
      sessionKey: "main:ansflow3",
      text: "add a timeout to the fetch",
      source: "gateway",
      onDelta: (d) => deltas.push(d),
      onFinal: (t) => {
        final = t;
      },
      reply: () => {},
    });
    const streamed = deltas.join("");
    assert.match(final, /Let me look at the client first\./);
    assert.match(final, /Added one, 30s\./);
    assert.equal(streamed.trim(), final.trim(), "one bubble's worth of text, not two blocks");
  } finally {
    await svc.stop();
  }
});
