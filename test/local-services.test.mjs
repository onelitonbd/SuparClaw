// Partial #7 — local models: Ollama autodetect + local services. Covers the
// probe parsers (stub endpoints on injected ports), closed-port scan behavior,
// merge-add semantics, the native /api/chat transport end-to-end, and CLI/scans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-local-"));
const {
  LOCAL_SERVICES,
  probeLocalService,
  scanLocalServices,
  addLocalService,
  LlmClient,
} = await import("../dist/lib.js");

const SC = join(process.cwd(), "dist", "sc.js");

const startStub = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

test("ollama probe: /api/tags models + /api/show context hints, loopback only", async () => {
  const { server, port } = await startStub((req, res) => {
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "llama3.2:latest" }] }));
      return;
    }
    if (req.url === "/api/show") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { model } = JSON.parse(body);
        res.end(JSON.stringify({
          model_info: model === "qwen3:8b" ? { "qwen3.context_length": 40960 } : {},
          parameters: model === "llama3.2:latest" ? "stop <|end|>\nnum_ctx 131072" : "",
        }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const svc = { id: "ollama", label: "Ollama", port, api: "ollama", baseUrl: `http://127.0.0.1:${port}`, probePath: "/api/tags", hostNote: "" };
    const r = await probeLocalService(svc);
    assert.equal(r.running, true);
    assert.deepEqual(r.models.sort(), ["llama3.2:latest", "qwen3:8b"]);
    assert.equal(r.hints["qwen3:8b"].contextWindow, 40960);
    assert.equal(r.hints["llama3.2:latest"].contextWindow, 131072, "num_ctx Modelfile fallback");
  } finally {
    server.close();
  }
});

test("openai-compat probe: /v1/models + context_length, failures stay offline-fast", async () => {
  const { server, port } = await startStub((req, res) => {
    if (String(req.url).endsWith("/models")) {
      res.end(JSON.stringify({ data: [{ id: "my-model", context_length: 8192 }, { id: "mini" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    for (const base of ["vllm", "lmstudio", "sglang", "llamacpp"]) {
      const r = await probeLocalService({ id: base, label: base, port, api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, probePath: "/models", hostNote: "" });
      assert.equal(r.running, true, `${base} detected`);
      assert.deepEqual(r.models, ["my-model", "mini"]);
      assert.equal(r.hints["my-model"].contextWindow, 8192);
    }
  } finally {
    server.close();
  }
  const dead = await probeLocalService({ id: "ollama", label: "O", port: 1, api: "ollama", baseUrl: "http://127.0.0.1:1", probePath: "/api/tags", hostNote: "" });
  assert.equal(dead.running, false);
  assert.ok(dead.error);
});

test("scanLocalServices returns quickly with results for every registered service", async () => {
  const t0 = Date.now();
  const results = await scanLocalServices();
  const elapsed = Date.now() - t0;
  assert.equal(results.length, LOCAL_SERVICES.length);
  assert.ok(elapsed < 5000, `scan should never hang (${elapsed}ms)`);
  for (const r of results) {
    assert.equal(typeof r.running, "boolean");
    assert.ok(r.note.length > 0);
    if (r.running) assert.ok(Array.isArray(r.models), `${r.id} running ⇒ model list probe`);
  }
});

test("addLocalService: writes native api baseUrl + merged models; configured models preserved", () => {
  // Fake ConfigService surface (no disk) — the function's contract is cfg-shaped.
  const state = { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", apiKey: "", models: ["pin:1b"] } } };
  const cfg = {
    current: state,
    setPath: (path, value) => {
      const parts = path.split(".");
      let node = state;
      for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ??= {});
      node[parts.at(-1)] = value;
      return { ok: true };
    },
  };
  const scan = { id: "ollama", running: true, models: ["qwen3:8b", "llama3.2:latest"], api: "ollama", baseUrl: "http://127.0.0.1:11434" };
  const out = addLocalService(cfg, "ollama", scan);
  assert.equal(out.ok, true);
  assert.equal(state.providers.ollama.api, "ollama", "native wire protocol declared");
  assert.equal(state.providers.ollama.baseUrl, "http://127.0.0.1:11434", "no /v1 (their warning)");
  assert.deepEqual(state.providers.ollama.models, ["pin:1b", "qwen3:8b", "llama3.2:latest"], "merge, not replace");
  assert.equal(state.providers.ollama.apiKey, "ollama-local", "sentinel credential seeded");
  const notRunning = addLocalService(cfg, "vllm", { id: "vllm", running: false, models: [], error: "down" });
  assert.equal(notRunning.ok, false);
  assert.equal(addLocalService(cfg, "no-such", {}).ok, false);
});

// ── native /api/chat transport end-to-end over a stub daemon ────────────────

const ollamaStub = (script) =>
  startStub((req, res) => {
    if (req.url === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        script.lastBody = parsed;
        if (script.unavailable) {
          res.writeHead(script.unavailable, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "model not found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const chunk of script.lines(parsed)) res.write(JSON.stringify(chunk) + "\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });

test("ollama native transport: tokens, thinking, complete tool call, eval counts, think flag", async () => {
  const script = {
    lastBody: null,
    lines: (parsed) => [
      { message: { role: "assistant", thinking: parsed.think ? "let me check " : "" }, done: false },
      { message: { role: "assistant", content: "Calling the tool. " }, done: false },
      { message: { role: "assistant", tool_calls: [{ function: { name: "time_now", arguments: { tz: "Asia/Dhaka" } } }] }, done: false },
      { done: true, done_reason: "tool_calls", prompt_eval_count: 64, eval_count: 21 },
    ],
  };
  const { server, port } = await ollamaStub(script);
  try {
    const llm = new LlmClient(
      { ollama: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "", models: ["qwen3:8b"], api: "ollama" } },
      { model: "ollama/qwen3:8b", fallbacks: [] },
    );
    const events = [];
    for await (const e of llm.stream({
      messages: [{ role: "user", content: "what time is it" }],
      tools: [{ type: "function", function: { name: "time_now", description: "", parameters: {} } }],
    })) events.push(e);
    const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    const thought = events.filter((e) => e.type === "reasoning").map((e) => e.text).join("");
    const calls = events.find((e) => e.type === "tool_calls");
    assert.equal(text, "Calling the tool. ");
    assert.match(thought, /let me check/);
    assert.equal(calls.calls[0].name, "time_now");
    assert.match(calls.calls[0].id, /^call_/, "ids minted downstream");
    assert.deepEqual(JSON.parse(calls.calls[0].args), { tz: "Asia/Dhaka" }, "object args rehydrated to JSON");
    const usage = events.find((e) => e.type === "usage");
    assert.deepEqual(usage.usage, { prompt_tokens: 64, completion_tokens: 21, total_tokens: 85 });
    assert.equal(events.find((e) => e.type === "done").finishReason, "tool_calls");
    assert.equal(script.lastBody.think, true, "thinking enabled by default");
    assert.equal(script.lastBody.model, "qwen3:8b");
    assert.equal(script.lastBody.stream, true);
    assert.ok(Array.isArray(script.lastBody.tools), "tools passed in native shape");

    // reasoning: off silences the think flag (their thinking-control rule)
    for await (const _ of llm.stream({ messages: [{ role: "user", content: "hi" }], reasoning: "off" })) void _;
    assert.equal(script.lastBody.think, false);

    // assistant history with tool_calls goes back with OBJECT arguments
    for await (const _ of llm.stream({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_x", name: "time_now", args: '{"tz":"UTC"}' }] },
        { role: "tool", tool_call_id: "call_x", name: "time_now", content: "12:00" },
      ],
    })) void _;
    const hist = script.lastBody.messages[1];
    assert.deepEqual(hist.tool_calls[0].function.arguments, { tz: "UTC" });
    assert.equal(script.lastBody.messages[2].role, "tool");
    assert.equal(script.lastBody.messages[2].name, "time_now");
    assert.equal(script.lastBody.messages[2].tool_call_id, undefined, "ollama wire drops call ids");
  } finally {
    server.close();
  }
});

test("ollama transport errors: 404 model-not-found is terminal for the model; 5xx retries with profile health", async () => {
  const script = { lastBody: null, unavailable: 404, lines: () => [] };
  const { server, port } = await ollamaStub(script);
  try {
    const llm = new LlmClient(
      { ollama: { baseUrl: `http://127.0.0.1:${port}`, models: ["missing:1b"], api: "ollama" } },
      { model: "ollama/missing:1b", fallbacks: [] },
    );
    await assert.rejects(async () => {
      for await (const _ of llm.stream({ messages: [{ role: "user", content: "hi" }] })) void _;
    }, /HTTP 404/);
  } finally {
    server.close();
  }
  // 500 + profile hooks: 7 instant retries, then failure health
  const { server: s2, port: p2 } = await startStub((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(500).end("boom");
    });
  });
  try {
    const { Store } = await import("../dist/lib.js");
    const st = Store.open(join(mkdtempSync(join(tmpdir(), "sc-os-")), "state.sqlite"));
    st.upsertAuthProfile({ id: "ollama:local", provider: "ollama", type: "api_key", material: "sk" });
    const llm2 = new LlmClient(
      { ollama: { baseUrl: `http://127.0.0.1:${p2}`, apiKey: "sk", models: ["m"], api: "ollama" } },
      { model: "ollama/m", fallbacks: [] },
      undefined,
      { profileOf: { ollama: "ollama:local" }, onOutcome: (id, ok) => st.markAuthUsed(id, ok) },
    );
    await assert.rejects(async () => {
      for await (const _ of llm2.stream({ messages: [{ role: "user", content: "hi" }] })) void _;
    }, /HTTP 500/);
    assert.ok(st.authProfile("ollama:local").last_used_at > 0, "attempts touched the profile");
    st.close();
  } finally {
    s2.close();
  }
});

test("CLI: sc models local --json returns the full registry offline; preset + enum guards", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-lcli-"));
  const run = (args) =>
    new Promise((r) => {
      const p = spawn(process.execPath, [SC, ...args], { env: { ...process.env, SUPARCLAW_HOME: home } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => r({ code, out }));
    });
  await run(["init"]);
  const scan = await run(["models", "local", "--json"]);
  const body = JSON.parse(scan.out.slice(scan.out.indexOf("{"), scan.out.lastIndexOf("}") + 1));
  assert.equal(body.services.length, 5);
  const ids = body.services.map((s) => s.id).sort();
  assert.deepEqual(ids, ["llamacpp", "lmstudio", "ollama", "sglang", "vllm"]);
  const ollama = body.services.find((s) => s.id === "ollama");
  assert.match(ollama.note, /native/);

  // --add on a not-running service errors. Which service is offline is
  // environment-dependent (a real Ollama may be up on the dev box).
  const dead = await run(["models", "local", "--json"]);
  const deadSvc = JSON.parse(dead.out.slice(dead.out.indexOf("{"), dead.out.lastIndexOf("}") + 1))
    .services.find((s) => !s.running);
  if (deadSvc) {
    const addDead = await run(["models", "local", "--add", deadSvc.id]);
    assert.equal(addDead.code, 1);
    assert.match(addDead.out, /not running/);
  }

  const badApi = await run(["config", "set", "providers.x.api", "no-such-api"]);
  assert.match(badApi.out, /invalid|must be one of|unknown/i);
  // preset add carries the native api flavor
  const added = await run(["provider", "add", "ollama", "--models", "qwen3:8b"]);
  assert.match(added.out, /saved/);
  const api = await run(["config", "get", "providers.ollama.api"]);
  assert.match(api.out, /"ollama"/);
  const url = await run(["config", "get", "providers.ollama.baseUrl"]);
  assert.match(url.out, /11434/);
  assert.doesNotMatch(url.out, /11434\/v1/, "native host, no /v1");
});

// Regression: config writes are atomic (temp file + rename), which swaps the
// inode; a path-bound fs.watch silently dies after the first rename, so
// `sc config set` edits never reached the live gateway. The watcher must
// observe the parent directory filtered by filename, and repeated atomic
// writes must ALL fire the onChange callback.
test("config hot-reload survives atomic rename writes (directory watch)", async () => {
  const { ConfigService, createLogger } = await import("../dist/lib.js");
  const home = mkdtempSync(join(tmpdir(), "sc-watch-"));
  const cfgPath = join(home, "config.json5");
  const svc = new ConfigService(createLogger({ level: "error" }), cfgPath);
  const seen = [];
  svc.watchForChanges((config) => seen.push(config.agents.defaults.model));
  await new Promise((r) => setTimeout(r, 150)); // let the watcher bind
  svc.setPath("agents.defaults.model", "demo/d1");
  await new Promise((r) => setTimeout(r, 700)); // past the 250ms debounce
  assert.ok(seen.includes("demo/d1"), "first atomic write fired onChange");
  svc.setPath("agents.defaults.model", "ollama/qwen3:8b");
  await new Promise((r) => setTimeout(r, 700));
  svc.stopWatching();
  assert.equal(seen.at(-1), "ollama/qwen3:8b", "second atomic write fired too");
});
