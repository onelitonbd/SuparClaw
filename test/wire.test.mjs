import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "error: HTTP 400 from MultiRouter: Request contains an invalid argument."
// Google Gemini's OpenAI-compat layer (behind routers like MultiRouter)
// rejects tool rounds unless the wire format is STRICT OpenAI:
//   tool_calls: [{id, type:"function", function:{name, arguments}}]
// Our internal shape {id,name,args} went out verbatim → every tool-using
// turn died on the second request. Also: duplicate/empty call ids and
// parameterless tool schemas are documented Gemini 400s.

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next candidate */ }
  }
  return process.cwd();
})();

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

test("tool rounds serialize to strict OpenAI wire format (the Gemini 400 fix)", async (t) => {
  const { AgentLoop, LlmClient, Store, createLogger, emptyConfig } = await import("../dist/lib.js");

  // Capturing mock: round 1 (no tool results yet) answers with TWO tool calls
  // that carry the hostile quirks real models emit — duplicate id "0" and
  // empty-string arguments. Round 2 asserts the replayed request contract.
  const bodies = [];
  let round = 0;
  const mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      round += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (round === 1) {
        // Gemini-style: distinct ids ("0","1"), NO index fields, one call with
        // empty-string arguments — all documented real-world quirks.
        const calls = [
          { id: "0", function: { name: "echo_tool", arguments: "" } },
          { id: "1", function: { name: "echo_tool", arguments: '{"x":1}' } },
        ];
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "all done" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
      res.end();
    });
  });
  const port = await freePort();
  await new Promise((r) => mock.listen(port, "127.0.0.1", r));
  t.after(() => mock.close());

  const dir = mkdtempSync(join(TEST_TMP, "sc-wire-"));
  const config = emptyConfig();
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const llm = new LlmClient(
    {
      mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["m1"] },
      other: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["z"] },
    },
    { model: "mock/m1", fallbacks: [] },
  );
  const loop = new AgentLoop({
    config,
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: [
      {
        name: "echo_tool",
        description: "echoes",
        parameters: { type: "object", properties: { x: { type: "number" } } },
        needsApproval: false,
        run: async (args) => `echo:${JSON.stringify(args)}`,
      },
      {
        name: "bare_tool",
        description: "parameterless",
        parameters: { type: "object", properties: {} },
        needsApproval: false,
        run: async () => "bare",
      },
    ],
  });

  const events = [];
  await loop.run({ sessionKey: "main:wire", text: "use the tools", onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === "final"), "run completes despite the hostile call ids");

  // ── the second request (the one that used to 400) carries strict wire shape
  assert.equal(bodies.length, 2, `two rounds hit the provider: ${bodies.length}`);
  const replay = bodies[1];
  const assistant = replay.messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(assistant, "replayed assistant message has tool_calls");

  for (const call of assistant.tool_calls) {
    assert.equal(call.type, "function", `tool_call has type:function — ${JSON.stringify(call)}`);
    assert.ok(call.function?.name, "tool_call carries function.name");
    assert.ok(!("name" in call) && !("args" in call), "no internal {name,args} keys on the wire");
    assert.equal(typeof call.function.arguments, "string", "arguments is a string");
    assert.ok(call.function.arguments.trim().length > 0, "empty arguments normalized to {}");
    assert.ok(call.id.length > 0, "call id non-empty");
  }
  assert.equal(assistant.tool_calls[0].function.arguments, "{}", '"" arguments → "{}"');
  assert.equal(assistant.tool_calls[1].function.arguments, '{"x":1}');
  assert.match(assistant.tool_calls[0].id, /^call_/, "model ids remapped to unique opaque ids");
  assert.notEqual(assistant.tool_calls[0].id, assistant.tool_calls[1].id, "remapped ids are unique");
  assert.ok(!("content" in assistant) || typeof assistant.content === "string", "tool-call-only assistant omits null content");

  const toolMsgs = replay.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2, "both tool results replayed");
  for (const [i, msg] of toolMsgs.entries()) {
    assert.equal(msg.name, "echo_tool", "tool message carries the function name (Gemini enforces it)");
    assert.equal(typeof msg.content, "string");
    assert.equal(msg.tool_call_id, assistant.tool_calls[i].id, "tool_call_id matches the remapped call id");
    assert.ok(msg.tool_call_id.length > 0);
  }

  // ── parameterless tools must not emit empty OBJECT schemas (Gemini 400s)
  const bare = bodies[0].tools.find((t) => t.function.name === "bare_tool");
  assert.ok(Object.keys(bare.function.parameters.properties).length > 0, "parameterless schema got a filler property");

  // first request untouched where it should be
  const firstAssistant = bodies[0].messages.find((m) => m.role === "assistant");
  assert.equal(firstAssistant, undefined, "no assistant replay on turn one");
});
