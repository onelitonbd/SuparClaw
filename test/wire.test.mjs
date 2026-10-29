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
        // empty-string arguments — plus signed reasoning_details fragments
        // split across chunks (the thought_signature class, cline #7551).
        const calls = [
          {
            id: "0",
            function: { name: "echo_tool", arguments: "" },
            // Google's OpenAI-compat hangs the per-call thought_signature in
            // the extra_content vendor extension — it must round-trip verbatim.
            extra_content: { google: { thought_signature: "sig-A" } },
          },
          { id: "1", function: { name: "echo_tool", arguments: '{"x":1}' } },
        ];
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                thinking_signature: "sig-message-level",
                reasoning_details: [
                  { type: "reasoning.text", text: "First half ", id: "r1", format: "google-gemini-v1", index: 0, signature: null },
                ],
                tool_calls: [calls[0]],
              },
            }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                reasoning_details: [
                  { type: "reasoning.text", text: "second half.", index: 0, signature: "sig-block-1" },
                ],
                tool_calls: [calls[1]],
              },
            }],
          })}\n\n`,
        );
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
        run: async (args) => `echo:${JSON.stringify(args)}`,
      },
      {
        name: "bare_tool",
        description: "parameterless",
        parameters: { type: "object", properties: {} },
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

  // ── signed thinking rides back with the tool calls (thought_signature fix)
  const details = assistant.reasoning_details;
  assert.ok(Array.isArray(details) && details.length === 1, `fragments merged into one block: ${JSON.stringify(details)}`);
  assert.equal(details[0].text, "First half second half.", "fragment text concatenated in order");
  assert.equal(details[0].format, "google-gemini-v1", "structural fields NOT concatenated (langchain #11699)");
  assert.equal(details[0].signature, "sig-block-1", "block signature preserved for replay");
  assert.equal(details[0].id, "r1");
  assert.equal(assistant.thinking_signature, "sig-message-level", "message-level signature alias replayed");
  assert.equal(typeof assistant.reasoning_content, "undefined", "no duplicate plaintext when signed blocks exist");

  // ── per-call thought_signature round-trips via extra_content (the Gemini
  // "Function call is missing a thought_signature in functionCall parts" 400)
  assert.equal(
    assistant.tool_calls[0].extra_content?.google?.thought_signature,
    "sig-A",
    "extra_content.google.thought_signature echoed verbatim on the same call",
  );
  assert.equal(
    assistant.tool_calls[1].extra_content,
    undefined,
    "non-Gemini model: a call without a signature gets NO synthetic extra_content",
  );
});

test("plain thinking without signed blocks replays as reasoning_content fallback", async (t) => {
  const { AgentLoop, LlmClient, Store, createLogger, emptyConfig } = await import("../dist/lib.js");
  const bodies = [];
  let round = 0;
  const mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      round += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (round === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking hard" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "t1", function: { name: "echo_tool", arguments: "{}" } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
      res.end();
    });
  });
  const port = await freePort();
  await new Promise((r) => mock.listen(port, "127.0.0.1", r));
  t.after(() => mock.close());
  const dir = mkdtempSync(join(TEST_TMP, "sc-wire2-"));
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const llm = new LlmClient(
    { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["m1"] }, other: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["z"] } },
    { model: "mock/m1", fallbacks: [] },
  );
  const loop = new AgentLoop({
    config: emptyConfig(),
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: [{ name: "echo_tool", description: "e", parameters: { type: "object", properties: { x: { type: "string" } } }, run: async () => "ok" }],
  });
  await loop.run({ sessionKey: "main:wire2", text: "go", onEvent: () => {} });
  const assistant = bodies[1].messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistant.reasoning_content, "thinking hard", "plaintext thinking replayed as the documented alias");
  assert.equal(assistant.reasoning_details, undefined, "no invented signed blocks");
});

test("gemini rounds keep per-call extra_content and sign unsigned calls with the documented stand-in", async (t) => {
  const { AgentLoop, LlmClient, Store, createLogger, emptyConfig, SKIP_THOUGHT_SIGNATURE } = await import("../dist/lib.js");
  assert.equal(SKIP_THOUGHT_SIGNATURE, "skip_thought_signature_validator", "Google's documented stand-in value");

  // Round 1 emits two PARALLEL calls: the first carries Google's per-call
  // thought_signature (extra_content.google.thought_signature), the second
  // arrives bare — plus a message-level extra_content on the delta. Gemini's
  // validator demands a signature on every functionCall part of the current
  // turn; bare calls must pick up the documented skip value, signed calls
  // must keep theirs untouched.
  const bodies = [];
  let round = 0;
  const mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      round += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (round === 1) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                extra_content: { google: { thought_signature: "msg-sig" } },
                tool_calls: [
                  {
                    id: "0",
                    function: { name: "echo_tool", arguments: '{"a":1}' },
                    extra_content: { google: { thought_signature: "sig-A" } },
                  },
                  { id: "1", function: { name: "echo_tool", arguments: '{"b":2}' } },
                ],
              },
            }],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
      res.end();
    });
  });
  const port = await freePort();
  await new Promise((r) => mock.listen(port, "127.0.0.1", r));
  t.after(() => mock.close());

  const dir = mkdtempSync(join(TEST_TMP, "sc-wire3-"));
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const llm = new LlmClient(
    { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["gemini-3-flash-preview"] }, other: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["z"] } },
    { model: "mock/gemini-3-flash-preview", fallbacks: [] },
  );
  const loop = new AgentLoop({
    config: emptyConfig(),
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: [{ name: "echo_tool", description: "e", parameters: { type: "object", properties: { x: { type: "string" } } }, run: async () => "ok" }],
  });
  await loop.run({ sessionKey: "main:wire3", text: "go", onEvent: () => {} });

  assert.equal(bodies.length, 2, "two rounds hit the provider");
  const assistant = bodies[1].messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(assistant, "replayed assistant message has tool_calls");
  assert.equal(
    assistant.tool_calls[0].extra_content.google.thought_signature,
    "sig-A",
    "real signature echoed verbatim — never replaced by the stand-in",
  );
  assert.equal(
    assistant.tool_calls[1].extra_content.google.thought_signature,
    SKIP_THOUGHT_SIGNATURE,
    "unsigned call of a Gemini round gets Google's documented stand-in",
  );
  assert.equal(
    assistant.extra_content.google.thought_signature,
    "msg-sig",
    "message-level extra_content rides back with the tool round",
  );
});

test("provider 400 bodies become the human message — not a JSON wall, not 300-char truncation", async (t) => {
  const { AgentLoop, LlmClient, Store, createLogger, emptyConfig, providerErrorText } = await import("../dist/lib.js");

  // The exact MultiRouter/Google error the user hit: a pretty-printed JSON
  // ARRAY body whose full text exceeds the old 300-char cap. The old code
  // sliced mid-JSON → prettyError's JSON.parse failed → the raw wall rendered.
  const message =
    "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:fs_read` , position 31. please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.";
  const google400 = JSON.stringify([{ error: { code: 400, message, status: "INVALID_ARGUMENT" } }], null, 2);
  assert.ok(google400.length > 300, "the pretty blob is longer than the old cap");

  // unit: full blob, nested objects, and truncated debris all extract cleanly
  assert.equal(providerErrorText(google400), message, "array blob unwraps to the message");
  assert.equal(providerErrorText('{"error":{"message":"inner boom"}}'), "inner boom", "object blob unwraps");
  const truncated = google400.slice(0, 260); // mid-string cut, invalid JSON
  const fromDebris = providerErrorText(truncated);
  assert.ok(fromDebris.startsWith("Function call is missing a thought_signature"), `debris yields the message start: ${fromDebris.slice(0, 60)}`);
  assert.ok(!fromDebris.includes('{"error"'), "debris does not leak the JSON wall");
  assert.equal(providerErrorText("plain failure"), "plain failure", "plain text passes through");

  // end-to-end: the LlmError surfaced on the run carries the human message
  const mock = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(google400);
    });
  });
  const port = await freePort();
  await new Promise((r) => mock.listen(port, "127.0.0.1", r));
  t.after(() => mock.close());

  const dir = mkdtempSync(join(TEST_TMP, "sc-wire4-"));
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const llm = new LlmClient(
    { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["m1"] } },
    { model: "mock/m1", fallbacks: [] },
  );
  const loop = new AgentLoop({
    config: emptyConfig(),
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: [],
  });
  const events = [];
  await loop.run({ sessionKey: "main:wire4", text: "go", onEvent: (e) => events.push(e) });
  const failure = events.find((e) => e.type === "error");
  assert.ok(failure, "the run surfaces the failure");
  assert.ok(failure.message.includes("HTTP 400 from mock"), `HTTP prefix kept: ${failure.message.slice(0, 40)}`);
  assert.ok(failure.message.includes("Function call is missing a thought_signature"), "human message extracted");
  assert.ok(failure.message.includes("position 31"), "the full message survives — no 300-char truncation");
  assert.ok(failure.message.includes("for more details"), "tail of the message survives");
  assert.ok(!failure.message.includes("[{"), "no JSON wall in the surfaced error");
});
