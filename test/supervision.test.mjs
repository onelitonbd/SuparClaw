import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Daemon lifecycle (parity with OpenClaw's supervision): `sc gateway` runs a
// supervisor that respawns the gateway instantly on crash; an orphaned child
// frees its port; the gateway exposes service.status/logs/restart like
// OpenClaw's gateway.restart.request.

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

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const waitFor = async (pred, what, tries = 120, gap = 250) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const healthy = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

const readPid = (home) => {
  const file = join(home, ".suparclaw", "gateway.pid");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
};

const startGateway = async (t, home, port, extraArgs = []) => {
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = async (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });
  await run(["config", "set", "gateway.port", String(port)]);
  const gw = spawn(process.execPath, [SC, "gateway", ...extraArgs], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  gw.stdout.on("data", (c) => (log += c));
  gw.stderr.on("data", (c) => (log += c));
  t.after(() => { try { gw.kill("SIGKILL"); } catch { /* gone */ } });
  await waitFor(() => healthy(port), `gateway healthy:\n${log}`, 160);
  return { gw, getLog: () => log };
};

test("supervisor restarts a crashed gateway instantly and stops cleanly", async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-super-"));
  await startGateway(t, home, port);

  const rec = await waitFor(() => readPid(home), "pid file written");
  assert.ok(rec.pid > 0, `child pid in ${JSON.stringify(rec)}`);
  assert.ok(rec.supervisor > 0, `supervisor pid recorded: ${JSON.stringify(rec)}`);
  assert.ok(alive(rec.pid) && alive(rec.supervisor), "both processes alive");

  // Crash the child with SIGKILL — the supervisor must respawn it instantly.
  process.kill(rec.pid, "SIGKILL");
  const respawned = await waitFor(() => {
    const now = readPid(home);
    return now && now.pid !== rec.pid && now.supervisor === rec.supervisor ? now : null;
  }, "fresh child pid after crash", 120);
  assert.ok(await waitFor(() => healthy(port), "gateway healthy again after crash", 120));
  assert.ok(alive(respawned.pid), `new child ${respawned.pid} runs`);

  // Intentional stop: SIGTERM the supervisor — BOTH go down, port frees, no respawn.
  process.kill(rec.supervisor, "SIGTERM");
  await waitFor(() => (!alive(rec.supervisor) && !alive(respawned.pid)) || !alive(rec.supervisor), "supervisor stopped", 60);
  await waitFor(async () => !(await healthy(port)), "port freed after stop", 60);
});

test("an orphaned child exits via its supervisor lifeline", async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-orphan-"));
  const { gw } = await startGateway(t, home, port);

  const rec = await waitFor(() => readPid(home), "pid file written");
  assert.ok(rec.supervisor > 0);

  // Kill the SUPERVISOR dead — no SIGTERM is forwarded. The child must notice
  // the orphaning (ppid becomes 1) and exit on its own, freeing the port.
  process.kill(rec.supervisor, "SIGKILL");
  await waitFor(() => !alive(rec.pid), "orphaned child exits", 80);
  await waitFor(async () => !(await healthy(port)), "port freed", 60);
  void gw;
});

test("service.status, service.logs and service.restart over the gateway", async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(TEST_TMP, "sc-svpc-"));
  await startGateway(t, home, port);

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  t.after(() => { try { ws.close(); } catch { /* closed */ } });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  const call = (method, params = {}) => {
    const id = `t${Math.random().toString(36).slice(2)}`;
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return waitFor(() => frames.find((f) => f.type === "res" && f.id === id) ?? null, `res ${method}`, 80, 100);
  };
  ws.send(JSON.stringify({ type: "connect", params: { token: "" } }));
  await new Promise((r) => setTimeout(r, 200));

  const status = await call("service.status");
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.payload.mode, "supervised");
  assert.equal(status.payload.restartSupported, true);
  assert.equal(status.payload.running, true);
  assert.ok(status.payload.supervisorPid > 0, `supervisorPid: ${JSON.stringify(status.payload)}`);
  assert.ok(status.payload.uptimeMs >= 0);
  assert.equal(typeof status.payload.version, "string");

  const logs = await call("service.logs", { lines: 10 });
  assert.equal(logs.ok, true);
  assert.ok(Array.isArray(logs.payload.lines), `lines: ${JSON.stringify(logs.payload)}`);
  assert.ok(String(logs.payload.path).endsWith(".log"));

  // Restart: the RPC answers, the process SIGTERMs itself, the supervisor
  // respawns it, health returns on a NEW pid.
  const before = readPid(home);
  const restart = await call("service.restart");
  assert.equal(restart.ok, true);
  assert.equal(restart.payload.willComeBack, true);
  const next = await waitFor(() => {
    const now = readPid(home);
    return now && now.pid !== before.pid ? now : null;
  }, "pid rotated after service.restart", 160);
  assert.ok(await waitFor(() => healthy(port), "healthy after service.restart", 160));
  assert.ok(alive(next.pid));

  // Teardown: stop supervisor + child so the port frees for other tests.
  process.kill(next.supervisor, "SIGTERM");
  await waitFor(() => !alive(next.supervisor), "clean teardown", 60);
});

test("sc service status works on any device", async () => {
  const home = mkdtempSync(join(TEST_TMP, "sc-svcstat-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, "service", "status"], { env });
    let s = "";
    p.stdout.on("data", (c) => (s += c));
    p.stderr.on("data", (c) => (s += c));
    p.on("close", (code) => resolve({ code, s }));
  });
  assert.equal(out.code, 0, out.s);
  assert.match(out.s, /manager:/);
  assert.match(out.s, /installed:/);
  assert.match(out.s, /boot start:/);
});
