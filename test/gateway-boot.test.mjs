import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boot-level wiring: start the real `sc gateway` and prove every subsystem is
// actually connected — readiness report at startup, live `sc status` probe,
// event fan-out to observers, config hot reload, cron reconcile + single
// job-run record. Each check here is a regression test for a wiring bug found
// in the audit: dead watchForChanges, #clients only after chat.send, double
// recordJobRun, and no cross-process job reconcile.

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

const CHUNKS = ["Hello ", "from ", "the ", "mock ", "provider."];

function startMockProvider(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
        const tick = () => {
          if (i < CHUNKS.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: CHUNKS[i] } }] })}\n\n`);
            i += 1;
            setTimeout(tick, 8);
          } else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } })}\n\ndata: [DONE]\n\n`);
            res.end();
          }
        };
        tick();
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
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
    wait(pred, ms = 6000) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ws frame; saw: ${JSON.stringify(frames.slice(-12))}`)),
          ms,
        );
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
};

test("gateway boot wires every subsystem — report, fan-out, hot reload, cron", async (t) => {
  const port = await freePort();
  const mockPort = await freePort();
  const mock = await startMockProvider(mockPort);
  t.after(() => mock.close());

  const home = mkdtempSync(join(TEST_TMP, "sc-boot-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (c) => { out += c; stdout += c; });
      p.stderr.on("data", (c) => { out += c; stderr += c; });
      p.on("close", (code) => resolve({ code, out, stdout, stderr }));
    });

  assert.equal((await run(["init"])).code, 0, "sc init succeeds");
  await run(["config", "set", "gateway.port", String(port)]);
  await run(["config", "set", "agents.defaults.model", "mock/m1"]);
  await run([
    "config", "set", "providers.mock",
    JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", models: ["m1", "m2"] }),
  ]);

  // ── boot the real daemon ────────────────────────────────────────────────
  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let gwLog = "";
  gw.stdout.on("data", (c) => (gwLog += c));
  gw.stderr.on("data", (c) => (gwLog += c));

  let healthy = null;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); break; } catch { /* retry */ }
  }
  assert.ok(healthy, `gateway never became healthy:\n${gwLog}`);
  assert.equal(healthy.ok, true);

  // ── 1. startup readiness report ─────────────────────────────────────────
  assert.match(gwLog, /subsystems/, "startup prints the readiness report");
  for (const name of ["config", "store", "model", "tools", "skills", "workspace", "cron", "telegram"]) {
    assert.ok(gwLog.includes(name), `readiness report covers ${name}`);
  }
  assert.match(gwLog, /✓|▲|✗/, "readiness report uses check marks");
  assert.match(gwLog, /all systems connected|ready, with/, "readiness report ends with a verdict");

  // readiness is also machine-readable on the live daemon
  const live = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
  const names = (live.checks ?? []).map((c) => c.name);
  for (const name of ["config", "store", "model", "tools", "skills", "workspace", "cron", "telegram"]) {
    assert.ok(names.includes(name), `/api/status checks cover ${name}`);
  }
  assert.equal((live.checks ?? []).filter((c) => c.status === "fail").length, 0, `no failed checks: ${JSON.stringify(live.checks)}`);

  // ── 2. sc status probes the RUNNING gateway (not an offline copy) ───────
  const statusOut = await run(["status"]);
  const statusJson = JSON.parse(statusOut.stdout);
  assert.equal(statusJson.live, true, "sc status reports the live daemon");
  assert.ok(Array.isArray(statusJson.checks), "sc status carries the readiness checks");

  // ── 3. observers receive broadcasts (regression: #clients only in chat.send)
  const observer = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => observer.ws.close());
  observer.send({ type: "connect", params: { token: "" } });
  await observer.wait((f) => f.type === "hello-ok");

  const talker = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => talker.ws.close());
  talker.send({ type: "connect", params: { token: "" } });
  await talker.wait((f) => f.type === "hello-ok");

  await talker.request("chat.send", { sessionKey: "main:main", text: "hello", key: `boot-${Date.now()}` });
  const reply = await talker.wait((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final");
  assert.match(String(reply.payload.event.text ?? ""), /Hello from the mock provider/);

  const observed = await observer.wait(
    (f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final",
    8000,
  );
  assert.match(String(observed.payload.event.text ?? ""), /Hello from the mock provider/,
    "a connect-only observer receives chat replies");
  // single stream: exactly one final for the run, and no legacy duplicate frames
  const finals = talker.frames.filter((f) => f.type === "event" && f.event === "chat" && f.payload?.event?.type === "final");
  assert.equal(finals.length, 1, "exactly one final event per run (no duplicate bubbles)");
  const legacy = talker.frames.filter((f) => f.type === "event" && ["chat.delta", "chat.reply", "chat.tool"].includes(f.event));
  assert.equal(legacy.length, 0, `no legacy chat.* frames on the wire: ${JSON.stringify(legacy)}`);

  // ── 4. config hot reload reaches the running daemon (regression: dead watch)
  const set = await run(["config", "set", "agents.defaults.model", "mock/m2"]);
  assert.equal(set.code, 0, `sc config set succeeds: ${set.out}`);
  let model = "mock/m1";
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    model = s.model;
    if (model === "mock/m2") break;
  }
  assert.equal(model, "mock/m2", "config file change is hot-applied by the running gateway");

  // ── 5. cron: cross-process add reconciles + one run row per fire ────────
  //       (regression: dead reconcile, double recordJobRun)
  const added = await run(["cron", "add", "bootpulse", "* * * * * *", "say hi"]);
  assert.equal(added.code, 0, `sc cron add succeeds: ${added.out}`);

  // force reconcile the cheap way clients do (cron.list), then check armed count
  await observer.request("cron.list");
  let cronJobs = 0;
  for (let i = 0; i < 20; i++) {
    const s = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    cronJobs = s.cron?.jobs ?? 0;
    if (cronJobs >= 1) break;
    await new Promise((r) => setTimeout(r, 250));
    await observer.request("cron.list");
  }
  assert.ok(cronJobs >= 1, "job added by another process gets armed after reconcile");

  // wait for at least one fire, then verify job_runs has exactly one row per
  // fire (with the reply text) — no empty duplicate rows
  const jobsFrame = await observer.request("cron.list");
  const jobId = String(jobsFrame.payload.jobs?.[0]?.id ?? "bootpulse");
  let runs = [];
  for (let i = 0; i < 40; i++) {
    const f = await observer.request("cron.list");
    runs = (f.payload.runs ?? []).filter((r) => r.job_id === jobId);
    if (runs.length >= 1) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(runs.length >= 1, `cron job fired at least once: ${JSON.stringify(runs)}`);
  const empties = runs.filter((r) => String(r.result ?? "") === "");
  assert.equal(empties.length, 0,
    `every job run row carries the reply text (no double record): ${JSON.stringify(runs)}`);
  assert.ok(runs.every((r) => /Hello from the mock provider/.test(String(r.result ?? ""))),
    `run rows carry the actual reply: ${JSON.stringify(runs)}`);
});
