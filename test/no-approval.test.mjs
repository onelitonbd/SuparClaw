// Regression coverage for direct tool execution across non-interactive channels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sc-direct-tools-"));
process.env.SUPARCLAW_HOME = home;
const { Service, buildRegistry, emptyConfig } = await import("../dist/lib.js");

function scripted(command) {
  let round = 0;
  return {
    async *stream() {
      round += 1;
      if (round === 1) yield { type: "tool_calls", calls: [{ id: "c1", name: "exec", args: JSON.stringify({ command }) }] };
      else yield { type: "text", text: "all done" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
}

async function turn(service, opts = {}) {
  const seen = [];
  service.loop.llm = scripted(opts.command ?? "echo suparclaw-runs");
  await service.send({
    sessionKey: opts.sessionKey ?? "telegram:55",
    text: "run the command",
    source: opts.source ?? "telegram",
    onTool: (event) => { if (event.status === "running" && event.name) seen.push(`tool:${event.name}`); },
    reply: async () => {},
  });
  const row = service.store.getSessionByKey(opts.sessionKey ?? "telegram:55");
  const rows = row ? service.store.recentMessages(row.id, 50) : [];
  return { seen, text: rows.map((message) => message.content).join("\n") };
}

test("exec runs on a Telegram turn without an approval event or callback", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  const out = await turn(service);
  assert.ok(out.seen.includes("tool:exec"));
  assert.match(out.text, /suparclaw-runs/);
});

test("exec runs on a Gateway turn with no watcher connected", async (t) => {
  const service = new Service();
  t.after(() => service.stop());
  const out = await turn(service, { sessionKey: "gateway:55", source: "gateway" });
  assert.match(out.text, /suparclaw-runs/);
});

test("tool inventory and exec config have no approval-policy metadata", () => {
  const config = emptyConfig();
  assert.deepEqual(Object.keys(config.tools.exec).sort(), ["enabled", "timeoutMs"]);
  for (const tool of buildRegistry(config)) assert.equal("needsApproval" in tool, false, tool.name);
});
