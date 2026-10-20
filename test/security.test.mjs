import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The security + resilience rework: gateway trust policy, secret redaction,
// LLM retry semantics, agent-loop run fencing, memory_search, posture audit.

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return process.cwd();
})();
const scratch = (prefix) => mkdtempSync(join(TEST_TMP, prefix));

const {
  hostAllowed,
  originAllowed,
  hostnameOf,
  redactSecrets,
  resolveRedacted,
  isRedacted,
  maskSecret,
  parseRetryAfter,
  LlmClient,
  Store,
  buildRegistry,
  parseConfig,
  emptyConfig,
  AgentLoop,
  auditConfig,
  createLogger,
} = await import("../dist/lib.js");

const policy = (over = {}) => ({ bind: "loopback", allowedHosts: [], allowedOrigins: [], ...over });

test("trust: host allowlist defeats DNS rebinding and public names", () => {
  assert.equal(hostnameOf("127.0.0.1:18790"), "127.0.0.1");
  assert.equal(hostnameOf("[::1]:18790"), "::1");
  assert.equal(hostnameOf("http://localhost:18790"), "localhost");

  const p = policy();
  assert.ok(hostAllowed("127.0.0.1:18790", p));
  assert.ok(hostAllowed("localhost:18790", p));
  assert.ok(hostAllowed("[::1]:18790", p));
  assert.ok(hostAllowed("phone.localhost:18790", p));
  assert.ok(!hostAllowed("evil.com:18790", p), "rebound attacker host is refused");
  assert.ok(!hostAllowed("", p), "missing host is refused");

  const lan = policy({ bind: "lan" });
  assert.ok(hostAllowed("192.168.1.5:18790", lan), "phone UI over wifi");
  assert.ok(hostAllowed("100.64.1.2:18790", lan), "tailscale CGNAT range");
  assert.ok(hostAllowed("phone.local:18790", lan), "mDNS names");
  assert.ok(!hostAllowed("evil.com:18790", lan), "public names still refused");

  const extras = policy({ allowedHosts: ["ui.example.com"] });
  assert.ok(hostAllowed("ui.example.com:8443", extras));
});

test("trust: origin policy allows same-origin and native, refuses hostile pages", () => {
  const p = policy();
  const host = "127.0.0.1:18790";
  assert.ok(originAllowed(undefined, host, p), "native clients (no Origin)");
  assert.ok(originAllowed("", host, p));
  assert.ok(originAllowed("http://127.0.0.1:18790", host, p), "the control UI itself");
  assert.ok(!originAllowed("http://127.0.0.1:9999", host, p), "another local port is cross-origin");
  assert.ok(!originAllowed("https://evil.com", host, p), "CSWSH blocked");
  assert.ok(!originAllowed("null", host, p), "sandboxed frames blocked");
  assert.ok(!originAllowed("file://", host, p));
  const proxied = policy({ allowedOrigins: ["https://ui.example.com"] });
  assert.ok(originAllowed("https://ui.example.com", host, proxied));
});

test("redact: secrets never travel, sentinels write back to stored values", () => {
  const config = emptyConfig();
  config.gateway.auth.token = "tok-abcdef1234";
  config.channels.telegram.token = "842:tg-secret";
  config.providers = {
    openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-1234567890", headers: {}, models: ["gpt-4o"] },
  };
  const redacted = redactSecrets(config);
  assert.ok(isRedacted(redacted.gateway.auth.token));
  assert.ok(!JSON.stringify(redacted).includes("sk-1234567890"), "raw key absent from wire form");
  assert.ok(!JSON.stringify(redacted).includes("tg-secret"));
  assert.match(redacted.providers.openai.apiKey, /7890$/, "last 4 kept for display");

  // the UI echoes the sentinel back; the stored value must survive the round-trip
  const resolved = resolveRedacted(config.providers, redacted.providers);
  assert.equal(resolved.openai.apiKey, "sk-1234567890");
  const resolvedToken = resolveRedacted(config.gateway.auth.token, redacted.gateway.auth.token);
  assert.equal(resolvedToken, "tok-abcdef1234");
  // a genuinely new value passes through
  assert.equal(resolveRedacted("old", "sk-new"), "sk-new");
  assert.equal(maskSecret("short"), "__redacted__:");
});

test("llm: retry never duplicates delivered output", async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 5); // die mid-stream after output
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;

  const llm = new LlmClient(
    { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "", models: ["m"] } },
    { model: "mock/m", fallbacks: ["mock/m"] },
  );
  let text = "";
  await assert.rejects(
    (async () => {
      for await (const ev of llm.stream({ messages: [] })) {
        if (ev.type === "text") text += ev.text;
      }
    })(),
    /stream interrupted/,
  );
  assert.equal(text, "Hello ", "delivered output appears exactly once");
  assert.equal(hits, 1, "a stream with delivered output is never re-requested");
});

test("llm: retryable failures before output retry, 4xx advances to fallback", async (t) => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/v1/chat/completions") {
      const n = hits.filter((u) => u === "/v1/chat/completions").length;
      if (n === 1) {
        res.writeHead(500, { "content-type": "text/plain", "retry-after": "0" });
        res.end("boom");
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" } }] })}\n\ndata: [DONE]\n\n`);
      }
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;

  // primary answers 500 once then succeeds — same model is retried (no output yet)
  const llm = new LlmClient(
    { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "", models: ["m"] } },
    { model: "mock/m", fallbacks: [] },
  );
  let text = "";
  for await (const ev of llm.stream({ messages: [] })) {
    if (ev.type === "text") text += ev.text;
  }
  assert.equal(text, "recovered");
  assert.equal(hits.filter((u) => u === "/v1/chat/completions").length, 2);

  // non-retryable 401 on the primary advances to the fallback model immediately
  const bad = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("no key");
  });
  await new Promise((r) => bad.listen(0, "127.0.0.1", r));
  t.after(() => bad.close());
  const badPort = bad.address().port;
  const llm2 = new LlmClient(
    {
      bad: { baseUrl: `http://127.0.0.1:${badPort}/v1`, apiKey: "", models: ["m"] },
      mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "", models: ["m"] },
    },
    { model: "bad/m", fallbacks: ["mock/m"] },
  );
  let text2 = "";
  for await (const ev of llm2.stream({ messages: [] })) {
    if (ev.type === "text") text2 += ev.text;
  }
  assert.equal(text2, "recovered", "fallback model answers after a terminal primary failure");
});

test("llm: Retry-After parsing", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("garbage"), undefined);
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms !== undefined && ms > 3000 && ms <= 5000);
});

test("loop: overlapping runs never interleave and busy state stays honest", async () => {
  const dir = scratch("sc-fence-");
  const store = Store.open(join(dir, "state.sqlite"));
  const { config } = parseConfig({});
  config.agents.defaults.model = "x/y";
  config.agents.defaults.queueMode = "steer";

  let call = 0;
  let release2 = () => {};
  const gate2 = new Promise((r) => { release2 = r; });
  const fakeLlm = {
    setConfig() {},
    listModels() { return []; },
    async *stream({ signal }) {
      call += 1;
      if (call === 1) {
        // run 1: block until steered/aborted
        await new Promise((_, rej) => {
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        });
      }
      // run 2 stays active until the test releases it, so busy state is observable
      await gate2;
      yield { type: "text", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };

  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm: fakeLlm });
  const seen = [];
  const onEvent = (e) => seen.push(e.type);
  const p1 = loop.run({ sessionKey: "s1", text: "one", onEvent }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(loop.isBusy("s1"));

  const p2 = loop.run({ sessionKey: "s1", text: "two", onEvent });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(loop.isBusy("s1"), "the successor owns the slot while running (was: false — the race)");
  release2();
  await Promise.all([p1, p2]);

  // exactly one idle, and it comes at the very end (superseded runs stay quiet)
  assert.equal(seen.filter((t) => t === "idle").length, 1, `events: ${seen.join(",")}`);
  assert.equal(seen[seen.length - 1], "idle");
  assert.equal(loop.isBusy("s1"), false);
  store.close();
});

test("memory_search: finds memory files and cross-session transcripts", async () => {
  const dir = scratch("sc-memsearch-");
  const store = Store.open(join(dir, "state.sqlite"));
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, "memory"), { recursive: true });
  writeFileSync(join(workspace, "MEMORY.md"), "# Memory\n\n- the wifi password is hunter2\n");
  writeFileSync(join(workspace, "memory", "2026-10-20.md"), "\n- flight LX-1234 lands at 21:40\n");

  const a = store.ensureSession("main:main");
  const b = store.ensureSession("telegram:42");
  store.appendMessage(a.id, "user", "remember the plant watering schedule", "r1");
  store.appendMessage(b.id, "assistant", "the plant watering schedule is Tuesdays", "r2");

  const { config } = parseConfig({});
  const registry = buildRegistry(config);
  const search = registry.find((t) => t.name === "memory_search");
  assert.ok(search, "memory_search is registered");
  const ctx = {
    workspace,
    stateDir: dir,
    skills: [],
    store,
    log: createLogger({ level: "error" }),
    config,
    approved: true,
  };

  const notes = await search.run({ query: "wifi password" }, ctx);
  assert.match(notes, /MEMORY\.md/, "curated memory hit");
  const flight = await search.run({ query: "LX-1234" }, ctx);
  assert.match(flight, /2026-10-20/, "daily note hit is dated");
  const both = await search.run({ query: "plant watering" }, ctx);
  assert.match(both, /telegram:42/, "hits come from every session, labelled");
  assert.match(both, /main:main/);
  assert.equal(await search.run({ query: "nothing-here-at-all" }, ctx), "no matches");
  store.close();
});

test("audit: posture findings flag the dangerous combinations", () => {
  const base = emptyConfig();
  base.gateway.auth.token = "a".repeat(32); // a healthy install: sc init has run

  const good = auditConfig({ config: base, configMode: 0o600 });
  assert.equal(good.filter((f) => f.status === "fail").length, 0);
  assert.ok(good.some((f) => f.name === "ws origin policy" && f.status === "ok"));

  const openLan = emptyConfig();
  openLan.gateway.bind = "lan";
  openLan.gateway.auth.mode = "none";
  const f1 = auditConfig({ config: openLan });
  assert.ok(f1.some((f) => f.name === "gateway bind" && f.status === "fail"), "LAN + no auth fails");

  const noToken = emptyConfig();
  noToken.gateway.auth.mode = "token";
  noToken.gateway.auth.token = "";
  const f2 = auditConfig({ config: noToken });
  assert.ok(f2.some((f) => f.name === "gateway auth" && f.status === "fail"), "empty token fails closed");

  const openExec = emptyConfig();
  openExec.tools.exec.enabled = true;
  openExec.tools.exec.approvals = false;
  const f3 = auditConfig({ config: openExec });
  assert.ok(f3.some((f) => f.name === "exec tool" && f.status === "fail"), "exec without approvals fails");

  const openDm = emptyConfig();
  openDm.channels.telegram.enabled = true;
  openDm.channels.telegram.dmPolicy = "open";
  const f4 = auditConfig({ config: openDm });
  assert.ok(f4.some((f) => f.name === "telegram DMs" && f.status === "warn"));
});
