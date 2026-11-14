// Task 52 — the terminal RPCs over a real websocket, against a real daemon.
//
// The web panel is only a view; these frames are the whole contract between it
// and the shells. If this passes, opening the panel shows what the agent's
// shell printed, because the panel is doing exactly what this test does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SC = join(process.cwd(), "dist", "sc.js");

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

test("terminals: create → send → live output → read → interrupt → kill over the socket", async (t) => {
  const { WebSocket } = await import("ws");
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "sc-term-gw-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });

  assert.equal((await run(["init"])).code, 0, "sc init succeeds");
  await run(["config", "set", "gateway.port", String(port)]);

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let gwLog = "";
  gw.stdout.on("data", (c) => (gwLog += c));
  gw.stderr.on("data", (c) => (gwLog += c));

  let healthy = null;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
      break;
    } catch {
      /* retry */
    }
  }
  assert.ok(healthy, `gateway never became healthy:\n${gwLog}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "event") events.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.pred(frame)) {
        waiters.splice(i, 1);
        w.resolve(frame);
      }
    }
  });
  t.after(() => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  });

  const waitFrame = (pred, ms = 30000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for frame\n${gwLog}`)), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  const request = (method, params = {}) => {
    const id = "t" + Math.random().toString(36).slice(2);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return waitFrame((f) => f.type === "res" && f.id === id).then((f) => {
      if (!f.ok) throw new Error(`${method}: ${f.error?.message ?? "failed"}`);
      return f.payload;
    });
  };
  const rejects = async (method, params, re) => {
    const id = "t" + Math.random().toString(36).slice(2);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    const f = await waitFrame((x) => x.type === "res" && x.id === id);
    assert.equal(f.ok, false, `${method} should have failed`);
    assert.match(String(f.error?.message ?? ""), re);
  };

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "connect", params: {} }));
  const hello = await waitFrame((f) => f.type === "hello-ok");
  for (const m of ["terminals.list", "terminals.create", "terminals.send", "terminals.read", "terminals.interrupt", "terminals.kill", "terminals.clear", "terminals.restart"]) {
    assert.ok(hello.payload.methods.includes(m), `${m} is advertised to clients`);
  }

  // Nothing open yet is an answer, not an error.
  const empty = await request("terminals.list");
  assert.deepEqual(empty.terminals, []);
  assert.equal(empty.max, 8);

  const created = await request("terminals.create", { name: "dev server" });
  const id = created.terminal.id;
  assert.match(id, /^t\d+$/);
  assert.equal(created.terminal.name, "dev server");
  assert.equal(created.terminal.status, "idle");
  assert.ok(created.terminal.cwd.length > 0);

  // The operator types; the shell's output arrives as events (that is the panel).
  const sent = await request("terminals.send", { terminal: id, command: "echo from-the-panel; pwd" });
  assert.equal(sent.started, true);
  const out = await waitFrame(
    (f) => f.type === "event" && f.event === "terminal" && f.payload?.kind === "output" && /from-the-panel/.test(JSON.stringify(f.payload)),
  );
  assert.equal(out.payload.id, id);
  assert.equal(typeof out.payload.seq, "number");

  // Reading gives the same text back (the panel's first-open fill).
  const read = await request("terminals.read", { terminal: id });
  assert.match(read.text, /from-the-panel/);
  assert.ok(read.seq > 0);
  // Nothing new since that sequence.
  const none = await request("terminals.read", { terminal: id, since: read.seq });
  assert.equal(none.text, "");

  // A command that outlives the wait answers `running`, and can be interrupted.
  const long = await request("terminals.run", { terminal: id, command: "sleep 45", waitMs: 800 });
  assert.equal(long.running, true);
  const interrupted = await request("terminals.interrupt", { terminal: id });
  assert.equal(interrupted.restarted, false);
  // The shell is still usable afterwards.
  await request("terminals.send", { terminal: id, command: "echo alive-after-signal" });
  await waitFrame(
    (f) => f.type === "event" && f.event === "terminal" && f.payload?.kind === "output" && /alive-after-signal/.test(JSON.stringify(f.payload)),
  );

  await rejects("terminals.send", { terminal: "nope", command: "echo x" }, /no terminal "nope"/);
  await rejects("terminals.kill", { terminal: "nope" }, /no terminal "nope"/);

  const killed = await request("terminals.kill", { terminal: id });
  assert.equal(killed.killed, id);
  const after = await request("terminals.list");
  assert.deepEqual(after.terminals, []);
  assert.ok(
    events.some((f) => f.event === "terminal" && f.payload?.kind === "removed" && f.payload.id === id),
    "the panel is told a shell disappeared",
  );
});
