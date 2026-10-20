import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Thinking: (1) a level the user can select, (2) a live preview, (3) saved and
// reloaded without loss — and reviewing it must never waste model tokens
// (reasoning rows are display-only and never re-enter the prompt).

const SC = join(process.cwd(), "dist", "sc.js");

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

function startMockProvider(port, { thinking = "Let me reason about this." } = {}) {
  const bodies = [];
  const server = createServer((req, res) => {
    if ((req.url ?? "").endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thinking } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: " more thought" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "The answer." } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, bodies })));
}

const wsClient = async (url) => {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const frames = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.pred(frame)) { waiters.splice(i, 1); w.resolve(frame); }
    }
  });
  return {
    ws,
    frames,
    send(obj) { ws.send(JSON.stringify(obj)); },
    request(method, params = {}) {
      const id = `r${Math.random().toString(36).slice(2)}`;
      this.send({ type: "req", id, method, params });
      return this.wait((f) => f.type === "res" && f.id === id);
    },
    wait(pred, ms = 10000, after = 0) {
      const existing = frames.slice(after).find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ws frame; saw: ${JSON.stringify(frames.slice(-6))}`)),
          ms,
        );
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
};

test("llm: reasoning deltas stream out and reasoning_effort rides the request", async () => {
  const { LlmClient } = await import("../dist/lib.js");
  const port = await freePort();
  const { server, bodies } = await startMockProvider(port);
  try {
    const providers = {
      mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["m1"] },
      other: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["z"] },
    };
    const llm = new LlmClient(providers, { model: "mock/m1", fallbacks: [] });

    // a real effort level rides the request as reasoning_effort
    let events = [];
    for await (const e of llm.stream({ messages: [{ role: "user", content: "hi" }], reasoning: "high" })) {
      events.push(e);
    }
    assert.equal(bodies.at(-1)["reasoning_effort"], "high", "level is sent to the provider");
    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, ["reasoning", "reasoning", "text", "done"], `order preserved: ${kinds}`);
    assert.match(events[0].text, /Let me reason/);
    assert.equal(events[2].text, "The answer.");

    // inherit / off / unset all omit the field (custom endpoints reject an off)
    for (const reasoning of ["inherit", "off", undefined]) {
      for await (const _ of llm.stream({ messages: [{ role: "user", content: "hi" }], reasoning })) {
        /* drain */
      }
      assert.ok(!("reasoning_effort" in bodies.at(-1)), `no reasoning_effort for ${reasoning}`);
    }
  } finally {
    server.close();
  }
});

test("loop: thinking persists per step, previews live, and never re-enters the prompt", async (t) => {
  const { AgentLoop, Store, createLogger, emptyConfig } = await import("../dist/lib.js");
  const dir = mkdtempSync(join(TEST_TMP, "sc-think-"));
  const config = emptyConfig();
  config.agents.defaults.reasoningEffort = "high";
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());

  const seenPrompts = [];
  const seenEffort = [];
  const llm = {
    async *stream(opts) {
      seenPrompts.push(opts.messages.map((m) => m.role));
      seenEffort.push(opts.reasoning);
      if (opts.messages.some((m) => m.role === "tool")) {
        yield { type: "reasoning", text: "After the tool: commit." };
        yield { type: "text", text: "done" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield { type: "reasoning", text: "First I should read the file." };
      yield {
        type: "tool_calls",
        calls: [{ id: "c1", name: "ok_tool", args: "{}" }],
      };
      yield { type: "done", finishReason: "tool_calls" };
    },
  };
  const loop = new AgentLoop({
    config,
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools: [{ name: "ok_tool", description: "ok", needsApproval: false, run: async () => "file body" }],
  });

  const events = [];
  await loop.run({ sessionKey: "main:think", text: "read it", onEvent: (e) => events.push(e) });

  // live preview: reasoning events reach the surface as they arrive
  const liveReasoning = events.filter((e) => e.type === "reasoning").map((e) => e.text).join("");
  assert.match(liveReasoning, /First I should read/);
  assert.match(liveReasoning, /After the tool/);

  // nothing lost: every segment is saved at its step boundary
  const session = store.getSessionByKey("main:think");
  const rows = store.recentMessages(session.id, 20).map((r) => [r.role, r.content.slice(0, 24)]);
  assert.deepEqual(
    rows.map((r) => r[0]),
    ["user", "reasoning", "tool", "reasoning", "assistant"],
    `segments sit next to the step they preceded: ${JSON.stringify(rows)}`,
  );
  assert.match(rows[1][1], /First I should/);
  assert.match(rows[3][1], /After the tool/);

  // review must not waste: prompts carry no reasoning rows (only the system
  // prompt, the user turn, and real assistant/tool context)
  assert.deepEqual(seenPrompts[0], ["system", "user"], `first prompt clean: ${seenPrompts[0]}`);
  assert.deepEqual(seenPrompts[1], ["system", "user", "assistant", "tool"], `second prompt clean: ${seenPrompts[1]}`);

  // CROSS-TURN hygiene: a later run must not send persisted reasoning or
  // error rows as fake assistant turns (they used to fall through to the
  // assistant branch of buildMessages).
  await loop.run({ sessionKey: "main:think", text: "again please", onEvent: (e) => events.push(e) });
  assert.deepEqual(
    seenPrompts[2],
    ["system", "user", "assistant", "user"],
    `later-turn prompt has only real turns: ${seenPrompts[2]}`,
  );
  assert.deepEqual(
    seenPrompts[3],
    ["system", "user", "assistant", "user", "assistant", "tool"],
    `later tool round stays clean: ${seenPrompts[3]}`,
  );

  // the configured effort rides the provider request (2 runs × 2 llm calls)
  assert.deepEqual(seenEffort, ["high", "high", "high", "high"], `reasoning level resolved per call: ${seenEffort}`);
});

test("gateway: session thinking level persists across refresh and reasoning saves", async (t) => {
  const mockPort = await freePort();
  const { server: mock, bodies } = await startMockProvider(mockPort, { thinking: "Plan the route." });
  t.after(() => mock.close());

  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-thinkgw-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, "init"], { env });
    p.on("close", resolve);
  });
  const set = (path, value) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, "config", "set", path, String(value)], { env });
      p.on("close", resolve);
    });
  await set("gateway.port", String(port));
  await set("providers.mock", JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", models: ["m1"] }));
  await set("agents.defaults.model", "mock/m1");

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await fetch(`http://127.0.0.1:${port}/health`); up = true; } catch { /* retry */ }
  }
  assert.ok(up, "gateway up");

  const ws = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.ws.close());
  ws.send({ type: "connect", params: { token: "" } });
  await ws.wait((f) => f.type === "hello-ok");

  // status advertises the ladder + defaults the picker renders
  const status = await ws.request("status");
  assert.ok(status.payload.thinkingLevels.includes("high"), `levels exposed: ${JSON.stringify(status.payload.thinkingLevels)}`);
  assert.equal(status.payload.thinkingDefault, "inherit");

  // selecting a level patches the session immediately and it sticks
  const patch = await ws.request("sessions.patch", { sessionKey: "main:main", thinking: "high" });
  assert.equal(patch.ok, true);
  assert.equal(patch.payload.thinking, "high");
  let list = await ws.request("sessions.list", { limit: 10 });
  const row = (list.payload.sessions ?? []).find((s) => s.key === "main:main");
  assert.equal(row.thinking, "high", "session override survives in the session row");

  // a turn with the saved level: effort rides the request, thinking saves
  await ws.request("chat.send", { sessionKey: "main:main", text: "plan something", isMainSession: true, key: "t1" });
  await ws.wait((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final");
  assert.equal(bodies.at(-1)["reasoning_effort"], "high", "saved level sent to the provider");

  const hist = await ws.request("chat.history", { sessionKey: "main:main", limit: 20 });
  const roles = hist.payload.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "reasoning", "assistant"], `thinking saved: ${roles}`);
  assert.match(hist.payload.messages[1].content, /Plan the route/);

  // a fresh connection (refresh) still sees the level and the saved thinking
  const ws2 = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws2.ws.close());
  ws2.send({ type: "connect", params: { token: "" } });
  await ws2.wait((f) => f.type === "hello-ok");
  list = await ws2.request("sessions.list", { limit: 10 });
  assert.equal((list.payload.sessions ?? []).find((s) => s.key === "main:main").thinking, "high", "level survives refresh");
  const hist2 = await ws2.request("chat.history", { sessionKey: "main:main", limit: 20 });
  assert.equal(hist2.payload.messages.filter((m) => m.role === "reasoning").length, 1, "thinking survives refresh");

  // clearing the override returns to inherit (null)
  const clear = await ws.request("sessions.patch", { sessionKey: "main:main", thinking: null });
  assert.equal(clear.payload.thinking, null, "override cleared");

  // per-message override still works when the session is inherited
  const mark2 = ws.frames.length;
  await ws.request("chat.send", { sessionKey: "main:main", text: "one more", reasoning: "low", isMainSession: true, key: "t2" });
  await ws.wait((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final", 10000, mark2);
  assert.equal(bodies.at(-1)["reasoning_effort"], "low", "per-message override rides the request");

  // patching a fresh key works before its first message (fresh-session picker)
  const fresh = await ws.request("sessions.patch", { sessionKey: "main:later", thinking: "medium" });
  assert.equal(fresh.ok, true, "picker works on a session with no messages yet");
  assert.equal(fresh.payload.thinking, "medium");
});

test("ui: thinking preview streams, replays from storage, and hides without loss", async () => {
  const { build } = await import("esbuild");
  const { parseHTML } = await import("linkedom");
  const outDir = mkdtempSync(join(TEST_TMP, "sc-thinkui-"));
  await build({
    entryPoints: [join(process.cwd(), "ui/src/chat.ts")],
    bundle: true,
    format: "esm",
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    platform: "neutral",
  });
  const { Chat } = await import(`file://${join(outDir, "chat.mjs")}`);

  const dom = parseHTML(readFileSync(join(process.cwd(), "ui/index.html"), "utf8"));
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.CSS = { escape: (s) => s };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const chat = new Chat(dom.document.body, { send: () => {}, abort: () => {}, approve: () => {} });

  // live preview streams into a collapsible block inside the running bubble
  chat.assistantStart();
  chat.reasoningDelta("Step one: ");
  chat.reasoningDelta("inspect the config.");
  chat.delta("Here is the answer.");
  await new Promise((r) => setTimeout(r, 30));
  const thought = dom.document.querySelector("#stack .thought");
  assert.ok(thought, "live thinking block exists");
  assert.match(thought.textContent ?? "", /Step one: inspect the config\./, "fragments accumulate");
  assert.equal(thought.querySelector(".thought__row")?.getAttribute("aria-expanded"), "true", "expands while streaming");

  // reload: saved segments come back as reviewable blocks (nothing lost)
  chat.finish("Here is the answer.");
  const n = chat.replaceThread([
    { role: "user", content: "q" },
    { role: "reasoning", content: "Saved thinking: check the docs first." },
    { role: "assistant", content: "a" },
    { role: "reasoning", content: "Second segment after the tool." },
    { role: "tool", content: "→ fs_read · 6ms\noutput" },
    { role: "assistant", content: "final a" },
  ]);
  assert.equal(n, 6, "every row including reasoning reloads");
  const blocks = dom.document.querySelectorAll("#stack .thought");
  assert.equal(blocks.length, 2, "both saved segments present");
  assert.match(blocks[0].textContent ?? "", /check the docs first/);
  assert.equal(blocks[0].querySelector(".thought__row")?.getAttribute("aria-expanded"), "false", "replays collapsed for review");
  assert.match(blocks[1].textContent ?? "", /Second segment/);

  // View → Reasoning off hides the blocks — nothing is discarded
  chat.setThinkingView("off");
  assert.ok(dom.document.getElementById("stack").className.includes("stack--no-thought"), "hidden via view toggle");
  assert.equal(dom.document.querySelectorAll("#stack .thought").length, 2, "still in the DOM — not lost");
  chat.setThinkingView("on");
  assert.ok(!dom.document.getElementById("stack").className.includes("stack--no-thought"));
});
