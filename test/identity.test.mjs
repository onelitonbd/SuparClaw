import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Identity is a hard contract (OpenClaw agents.identity parity): the agent
// must never forget it is SuparClaw, and must never claim to be the underlying
// foundation model (Gemini/GPT/Claude/…). The anchor rides in the system
// prompt every turn, from config — regardless of what workspace files exist.

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try {
      mkdirSync(base, { recursive: true });
      return base;
    } catch {
      /* next candidate */
    }
  }
  return process.cwd();
})();

test("identity: the system prompt never forgets who SuparClaw is", async (t) => {
  const { AgentLoop, Store, createLogger, emptyConfig } = await import("../dist/lib.js");

  // Isolate the workspace so identity can ONLY come from the prompt anchor.
  const home = mkdtempSync(join(TEST_TMP, "sc-ident-"));
  process.env.SUPARCLAW_HOME = home;
  const seen = [];
  const fake = {
    async *stream(opts) {
      seen.push(opts.messages);
      yield { type: "text", text: "I'm SuparClaw." };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const store = Store.open(join(home, "state.sqlite"));
  t.after(() => store.close());
  const config = emptyConfig();
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm: fake, tools: [] });

  await loop.run({ sessionKey: "main:ident", text: "who are you?", onEvent: () => {} });
  assert.equal(seen.length, 1);
  const system = seen[0][0];
  assert.equal(system.role, "system", "BASE_PROMPT leads the prompt");
  assert.ok(system.content.includes("SuparClaw"), "name is in every prompt");
  assert.ok(system.content.includes("you are SuparClaw"), "identity answered as itself");
  assert.ok(/NOT the underlying foundation model/.test(system.content), "anti-drift anchor present");
  assert.ok(system.content.includes("Gemini") && system.content.includes("Claude"), "names the models it must never claim to be");
  assert.ok(system.content.includes("Never open like a generic assistant"), "generic-assistant phrasing forbidden");

  // an EMPTY workspace (no IDENTITY.md/SOUL.md at all) cannot erase identity
  const wsFiles = ["IDENTITY.md", "SOUL.md", "AGENTS.md"].map((f) => existsSync(join(home, ".suparclaw", "workspace", f)));
  assert.deepEqual(wsFiles, [false, false, false], "test workspace is empty");
  assert.ok(system.content.includes("SuparClaw"), "identity survives without workspace files");
});

test("identity: config can rename the agent — the anchor follows", async (t) => {
  const { AgentLoop, Store, createLogger, emptyConfig } = await import("../dist/lib.js");
  const home = mkdtempSync(join(TEST_TMP, "sc-ident2-"));
  process.env.SUPARCLAW_HOME = home;
  const seen = [];
  const fake = {
    async *stream(opts) {
      seen.push(opts.messages);
      yield { type: "text", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const store = Store.open(join(home, "state.sqlite"));
  t.after(() => store.close());
  const config = emptyConfig();
  config.agents.identity = { name: "Clawbot", emoji: "🤖", theme: "a terse test bot" };
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  await loop.run({ sessionKey: "main:ident2", text: "hi", onEvent: () => {} });
  const system = seen[0][0].content;
  assert.ok(system.includes("Clawbot"), "configured name wins");
  assert.ok(system.includes("a terse test bot"), "configured theme wins");
});

test("workspace: identity files self-heal and pre-fill SuparClaw", async () => {
  const { writeWorkspaceTemplates } = await import("../dist/lib.js");
  const dir = mkdtempSync(join(TEST_TMP, "sc-ident3-"));
  // an older workspace: only AGENTS.md, no identity files
  writeFileSync(join(dir, "AGENTS.md"), "# my own rules\n", "utf8");

  const written = writeWorkspaceTemplates(dir);
  assert.ok(written.includes("IDENTITY.md"), "IDENTITY.md is created for old workspaces");
  assert.ok(written.includes("SOUL.md"), "SOUL.md is created for old workspaces");
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "# my own rules\n", "existing files are never overwritten");

  const ident = readFileSync(join(dir, "IDENTITY.md"), "utf8");
  assert.ok(ident.includes("SuparClaw"), "IDENTITY.md is pre-filled with the real name");
  assert.ok(ident.includes("🦀"), "signature emoji pre-filled");
  assert.ok(ident.includes("your phone is the machine"), "brand tagline pre-filled");
  const soul = readFileSync(join(dir, "SOUL.md"), "utf8");
  assert.ok(soul.includes("SuparClaw"), "SOUL.md anchors the persona to the name");

  // idempotent: nothing new on a second pass
  assert.deepEqual(writeWorkspaceTemplates(dir), [], "second pass writes nothing");
});
