import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Retry contract (user-set): no artificial time limits. A failure retries
// INSTANTLY — 7 retries after the first try per model — except an explicit
// provider hint ("Retry-After" / "try again in X") which is honored exactly.
// Every retry reports the error and attempt so the surface can show
// "error ... retrying (N/7)". After the retries are spent the next fallback
// gets its own fresh 7.

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

function startMock(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          req.rawBody = raw;
          handler(req, res, raw);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const sseOk = (res, text = "ok") => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { total_tokens: 3 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

test("llm: retries are instant — 7 retries, then the next fallback", async () => {
  const { LlmClient, parseRetryHint, parseRetryAfter } = await import("../dist/lib.js");

  // Provider A always fails with a bare 500 (no hint): every retry must fire
  // instantly. Provider B answers. Two separate providers = two chain entries.
  let aCalls = 0;
  let bCalls = 0;
  const a = await startMock((req, res) => {
    aCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "boom" } }));
  });
  const b = await startMock((req, res) => {
    bCalls += 1;
    sseOk(res, "saved by fallback");
  });
  a.server.unref?.();
  try {
    const llm = new LlmClient({
      a: { baseUrl: `http://127.0.0.1:${a.port}/v1`, apiKey: "x", models: ["m1"] },
      b: { baseUrl: `http://127.0.0.1:${b.port}/v1`, apiKey: "x", models: ["m2"] },
    }, { model: "a/m1", fallbacks: ["b/m2"] });

    const retries = [];
    const started = Date.now();
    let text = "";
    for await (const ev of llm.stream({
      messages: [{ role: "user", content: "hi" }],
      onRetry: (info) => retries.push(info),
    })) {
      if (ev.type === "text") text += ev.text;
    }
    const elapsed = Date.now() - started;

    assert.equal(aCalls, 8, "1 first try + 7 retries on the failing model");
    assert.equal(bCalls, 1, "then exactly one call on the fallback");
    assert.equal(text, "saved by fallback");
    assert.equal(retries.length, 7, "every retry reports itself");
    assert.deepEqual(retries.map((r) => r.attempt), [1, 2, 3, 4, 5, 6, 7], "attempt numbers 1..7");
    assert.ok(retries.every((r) => r.max === 7 && r.error.includes("boom")), "each retry carries the error and the 7-retry budget");
    assert.ok(elapsed < 2000, `retries were instant (no backoff sleeps) — took ${elapsed}ms`);

    // The hint parsers are the only allowed waits.
    assert.equal(parseRetryAfter("2"), 2000);
    assert.equal(parseRetryHint("Please try again in 30s"), 30_000);
    assert.equal(parseRetryHint("try again in 2 minutes"), 120_000);
    assert.equal(parseRetryHint("quota exceeded"), undefined);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("llm: an explicit provider hint is honored exactly — and nothing else waits", async () => {
  const { LlmClient } = await import("../dist/lib.js");
  let calls = 0;
  let lastAt = 0;
  const gaps = [];
  const mock = await startMock((req, res) => {
    calls += 1;
    const now = Date.now();
    if (lastAt) gaps.push(now - lastAt);
    lastAt = now;
    if (calls < 3) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
      return;
    }
    sseOk(res, "done");
  });
  try {
    const llm = new LlmClient(
      { p: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "x", models: ["m"] } },
      { model: "p/m" },
    );
    for await (const ev of llm.stream({ messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    assert.equal(calls, 3);
    for (const gap of gaps) {
      assert.ok(gap >= 950, `waited the exact provider hint (>=1s), got ${gap}ms`);
      assert.ok(gap < 2500, `no extra padding around the hint, got ${gap}ms`);
    }
  } finally {
    mock.server.close();
  }
});

test("llm: a message hint like 'try again in 1 second' also sets the wait floor", async () => {
  const { LlmClient } = await import("../dist/lib.js");
  let calls = 0;
  let lastAt = 0;
  const gaps = [];
  const mock = await startMock((req, res) => {
    calls += 1;
    const now = Date.now();
    if (lastAt) gaps.push(now - lastAt);
    lastAt = now;
    if (calls < 2) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Please try again in 1 second" } }));
      return;
    }
    sseOk(res, "ok");
  });
  try {
    const llm = new LlmClient(
      { p: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "x", models: ["m"] } },
      { model: "p/m" },
    );
    for await (const ev of llm.stream({ messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    assert.equal(calls, 2);
    assert.ok(gaps[0] >= 950, `message hint honored, got ${gaps[0]}ms`);
  } finally {
    mock.server.close();
  }
});

test("loop: fallbacks may be profile ids; retry events reach the surface", async (t) => {
  const { AgentLoop, LlmClient, Store, createLogger, emptyConfig } = await import("../dist/lib.js");
  const dir = mkdtempSync(join(TEST_TMP, "sc-retry-"));
  const config = emptyConfig();
  config.agents.defaults.model = "primary";
  config.agents.defaults.fallbacks = ["backup"];
  config.models = {
    primary: { ref: "p/one", label: "One", enabled: true, contextWindow: 0, maxTokens: 0, reasoningEffort: "inherit" },
    backup: { ref: "p/two", label: "Two", enabled: true, contextWindow: 0, maxTokens: 0, reasoningEffort: "inherit" },
  };
  const store = Store.open(join(dir, "state.sqlite"));
  t.after(() => store.close());

  const seenModels = [];
  const mock = await startMock((req, res) => {
    const body = JSON.parse(req.rawBody ?? "{}");
    seenModels.push(body.model);
    if (body.model === "one") {
      // Retryable 503 forever: the same model burns its full 1+7 budget...
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "flaky" } }));
      return;
    }
    // ...then the profile-id fallback ("backup" -> "p/two") answers.
    sseOk(res, "hello");
  });
  t.after(() => mock.server.close());

  const llm = new LlmClient(
    { p: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "x", models: ["one", "two"] } },
    { model: "p/one", fallbacks: ["p/two"] },
  );
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm, tools: [] });

  const events = [];
  await loop.run({ sessionKey: "main:retry", text: "hi", onEvent: (e) => events.push(e) });

  // profile ids resolved to wire refs on the fallback chain
  assert.equal(seenModels.filter((m) => m === "one").length, 8, "primary burned 1+7 before giving up");
  assert.equal(seenModels.filter((m) => m === "two").length, 1, "the profile-id fallback resolved to its ref and answered");
  const retries = events.filter((e) => e.type === "retry");
  assert.equal(retries.length, 7, "each retry surfaced an event");
  assert.deepEqual(retries.map((e) => e.attempt), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(retries.every((e) => e.max === 7 && e.error.includes("flaky")), "retry events carry the error + budget");
  const finals = events.filter((e) => e.type === "final");
  assert.equal(finals.length, 1, "the run still completed");
});

test("no time limits: exec keeps only the 10-minute safety cap", async () => {
  const { emptyConfig, buildRegistry } = await import("../dist/lib.js");
  const config = emptyConfig();
  assert.equal(config.tools.exec.timeoutMs, 600000, "exec default is the generous 10-min safety cap");
  assert.ok(config.tools.exec.timeoutMs >= 600000);
  // the exec tool clamps its per-call override to the same cap, nothing less
  config.tools.exec.enabled = true;
  const exec = buildRegistry(config).find((t) => t.name === "exec");
  assert.ok(exec, "exec tool exists");
});
