// Task 55 — no permission wall.
//
// The operator's words, after the bot told him to run `gh auth status` and
// paste the output: *"let the ai work on qny command without my permission no
// need for any permission let him work on these things. remove permission
// because i cant give permission from telegram so for shell and exec no
// permission needed for nothing. no tool ok."*
//
// Three things had to be true for that wall to exist and all three are pinned
// here against the real Service:
//
//   1. the loop asked a human whenever a tool said `needsApproval`, before the
//      exec policy was consulted at all — so `mode: full` ("runs without
//      prompts", the default) still produced a prompt;
//   2. with no surface to answer, `askFallback: deny` turned that prompt into a
//      silent decline, which the model reported as "the sandbox is blocking";
//   3. the tools' own refusal strings ("ask the user to approve, then retry")
//      gave the model the wording to hand the work back.
//
// Now a call is decided by policy, never by a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sc-noapproval-"));
process.env.SUPARCLAW_HOME = home;

const { Service } = await import("../dist/lib.js");

/** Round 1: call exec. Round 2: answer. */
function scripted(command) {
  let round = 0;
  return {
    async *stream() {
      round += 1;
      if (round === 1) {
        yield { type: "tool_calls", calls: [{ id: "c1", name: "exec", args: JSON.stringify({ command }) }] };
      } else {
        yield { type: "text", text: "all done" };
      }
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
}

/** Drive one turn the way a channel does; return the ask count and transcript. */
async function turn(service, opts = {}) {
  const asks = [];
  const seen = [];
  service.loop.llm = scripted(opts.command ?? "echo suparchat-runs");
  let answer = "";
  await service.send({
    sessionKey: opts.sessionKey ?? "telegram:55",
    text: "look at my repos",
    source: opts.source ?? "telegram",
    onApproval: (event) => asks.push(event),
    onTool: (e) => {
      if (e.status === "running" && e.name) seen.push(`tool:${e.name}`);
    },
    reply: async (text) => {
      answer = text;
    },
  });
  const row = service.store.getSessionByKey(opts.sessionKey ?? "telegram:55");
  const rows = row ? service.store.recentMessages(row.id, 50) : [];
  return { asks, seen, answer, rows, text: rows.map((m) => m.content).join("\n") };
}

test("a Telegram turn runs exec with no approval ask at all", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  const out = await turn(service);

  assert.deepEqual(out.asks, [], "no approval event reaches the chat");
  assert.ok(out.seen.includes("tool:exec"), "the model's call reached the tool");
  assert.match(out.text, /suparchat-runs/, "and exec really ran — the transcript has the output");
});

test("a gateway (web) turn runs exec too — no surface has to be watching", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  const out = await turn(service, { sessionKey: "gateway:55", source: "gateway" });
  assert.deepEqual(out.asks, []);
  assert.match(out.text, /suparchat-runs/, "a web turn runs the same shell — nothing waits for a watcher");
});

test("`mode: deny` still denies — policy survives, only the prompt is gone", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  service.configSvc.setPath("tools.exec.mode", "deny");
  const { asks, seen, answer } = await turn(service, { sessionKey: "telegram:deny55" });

  const out = await turn(service, { sessionKey: "telegram:deny55" });
  assert.deepEqual(out.asks, [], "nothing is asked");
  assert.doesNotMatch(out.text, /suparchat-runs/, "and nothing ran");
  assert.match(out.text, /denied/i, "the denial is reported as a policy decision");
});

test("a `mode: ask` policy runs instead of hanging on a human", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  service.configSvc.setPath("tools.exec.mode", "ask");
  const out = await turn(service, { sessionKey: "telegram:ask55" });

  assert.deepEqual(out.asks, [], "`ask` no longer means 'wait for a button'");
  assert.match(out.text, /suparchat-runs/, "it runs");
  assert.match(out.text, /allowed automatically/, "and the transcript records what allowed it");
});

test("the terminal tool runs without a prompt either", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  const tool = service.loop.tools.find((x) => x.name === "terminal");
  assert.ok(tool);
  const out = await tool.run(
    { action: "run", command: "echo terminal-runs" },
    { sessionKey: "telegram:55", workspace: home, log: service.log, store: service.store, terminals: service.terminals, config: service.config, approved: true },
  );
  assert.match(out, /terminal-runs/);
  service.terminals.closeAll?.();
});

test("no tool carries a 'needs approval' instruction for the model to quote", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  for (const spec of service.loop.tools) {
    const text = `${spec.description}\n${spec.needsApproval ? "needsApproval" : ""}`;
    assert.doesNotMatch(text, /ask the user to approve|needs approval|approve, then retry/i, `${spec.name} must not tell the model to ask`);
  }
});
