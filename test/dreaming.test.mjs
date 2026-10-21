import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The three session/memory gaps vs OpenClaw, closed: (1) the prompt tells the
// model which channel a message arrived on; (2) dreaming-style consolidation
// turns raw daily notes into curated MEMORY.md with a DREAMS.md diary entry;
// (3) sessions get auto-titles from the opening message, broadcast live.

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

// One mock provider that routes by prompt content: chat replies, the tiny
// title call, and the dreaming sweep (tool round -> final summary).
function startMockProvider(port) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      const text = JSON.stringify(parsed);
      const sse = (chunks) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (text.includes("short session title")) {
        sse([
          { choices: [{ delta: { content: '"Fix Telegram Bot Replies"' } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 9 } },
        ]);
        return;
      }
      if (text.includes("memory consolidation sweep")) {
        const hasToolResult = text.includes('\\"role\\": \\"tool\\"') || text.includes('"role":"tool"') || text.includes('"role": "tool"');
        if (!hasToolResult) {
          const args1 = JSON.stringify({
            path: "MEMORY.md",
            content: "# MEMORY\n\n## Stable\n- Durable Fact: user prefers compact bullet lists.\n",
          });
          const args2 = JSON.stringify({
            path: "DREAMS.md",
            content: "# DREAMS\n\n## Deep Sleep - 2026-01-01\n- promoted: durable fact into MEMORY.md\n",
          });
          sse([
            {
              choices: [{
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "fs_write", arguments: args1 } },
                    { index: 1, id: "call_2", type: "function", function: { name: "fs_write", arguments: args2 } },
                  ],
                },
              }],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 20 } },
          ]);
          return;
        }
        sse([
          { choices: [{ delta: { content: "promoted 1 fact into MEMORY.md" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 12 } },
        ]);
        return;
      }
      sse([
        { choices: [{ delta: { content: "Happy to help with that." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 11 } },
      ]);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, seen })));
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
    wait(pred, ms = 12000) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ws frame; saw: ${JSON.stringify(frames.slice(-10))}`)),
          ms,
        );
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
  };
};

const { channelLabel, dreamPrompt, titlePrompt, cleanTitle } = await import("../dist/lib.js");
const dream = { dreamPrompt, titlePrompt, cleanTitle };

test("channel labels name the surface the message arrived on", () => {
  assert.equal(channelLabel("main:main"), "the web chat (main session)");
  assert.equal(channelLabel("telegram:5551234"), "Telegram (direct message)");
  assert.equal(channelLabel("telegram:-100999:group"), "Telegram (group chat)");
  assert.equal(channelLabel("telegram:-100999:topic:42"), "Telegram (forum topic)");
  assert.equal(channelLabel("system:dream"), "a system/automation task");
  assert.match(channelLabel("tui:main"), /terminal UI/);
});

test("dream prompt and title cleanup follow the OpenClaw rules", () => {
  const prompt = dream.dreamPrompt("2026-10-21");
  assert.match(prompt, /MEMORY\.md/);
  assert.match(prompt, /DREAMS\.md/);
  assert.match(prompt, /Deep Sleep - 2026-10-21/);
  assert.match(prompt, /nothing new/);
  assert.match(prompt, /Skip today's note/);
  assert.match(prompt, /Skip secrets/);
  assert.ok(dream.titlePrompt("hello").includes("2-6 words"));
  assert.equal(dream.cleanTitle('"Fix Telegram Bot Replies"\nmore lines'), "Fix Telegram Bot Replies");
  assert.equal(dream.cleanTitle("Short."), "Short");
  assert.equal(dream.cleanTitle("x"), null);
});

test("sc dream consolidates daily notes into MEMORY.md + DREAMS.md", async (t) => {
  const port = await freePort();
  const mock = await startMockProvider(port);
  t.after(() => mock.server.close());

  const home = mkdtempSync(join(TEST_TMP, "sc-dream-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });

  assert.equal((await run(["init"])).code, 0);
  await run(["config", "set", "agents.defaults.model", "mock/m1"]);
  await run([
    "config", "set", "providers.mock",
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", models: ["m1"] }),
  ]);

  const res = await run(["dream"]);
  assert.equal(res.code, 0, `sc dream exits clean:\n${res.out}`);
  assert.match(res.out, /promoted 1 fact into MEMORY\.md/, "sweep summary is printed");

  const wsDir = join(home, ".suparclaw", "workspace");
  const memory = readFileSync(join(wsDir, "MEMORY.md"), "utf8");
  assert.match(memory, /Durable Fact: user prefers compact bullet lists/, "MEMORY.md got the promoted fact");
  const dreams = readFileSync(join(wsDir, "DREAMS.md"), "utf8");
  assert.match(dreams, /## Deep Sleep - /, "DREAMS.md has a dated diary entry");
});

test("sessions auto-title after the first reply and broadcast the rename", async (t) => {
  const port = await freePort();
  const mockPort = await freePort();
  const mock = await startMockProvider(mockPort);
  t.after(() => mock.server.close());

  const home = mkdtempSync(join(TEST_TMP, "sc-title-"));
  const env = { ...process.env, SUPARCLAW_HOME: home };
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, ...args], { env });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });

  assert.equal((await run(["init"])).code, 0);
  await run(["config", "set", "gateway.port", String(port)]);
  await run(["config", "set", "agents.defaults.model", "mock/m1"]);
  await run([
    "config", "set", "providers.mock",
    JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x", models: ["m1"] }),
  ]);
  await run(["config", "set", "memory.dreaming.enabled", "false"]);

  const gw = spawn(process.execPath, [SC, "gateway"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let gwLog = "";
  gw.stdout.on("data", (c) => (gwLog += c));
  gw.stderr.on("data", (c) => (gwLog += c));

  let healthy = null;
  for (let i = 0; i < 240; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try { healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()); break; } catch { /* retry */ }
  }
  assert.ok(healthy, `gateway never became healthy:\n${gwLog}`);

  // One raw daily note for the sweep (and the count the status reports).
  const workDir = join(home, ".suparclaw", "workspace");
  mkdirSync(join(workDir, "memory"), { recursive: true });
  writeFileSync(join(workDir, "memory", "2026-01-01.md"), "- user prefers compact bullet lists\n");

  const client = await wsClient(`ws://127.0.0.1:${port}/ws`);
  t.after(() => client.ws.close());
  client.send({ type: "connect", params: { token: "" } });

  const res = await client.request("chat.send", {
    sessionKey: "main:main",
    text: "Hey, can you help me fix my Telegram bot replies?",
  });
  assert.equal(res.ok, true, `chat.send ok: ${JSON.stringify(res)}`);

  // Auto-title is non-blocking: wait for the rename broadcast, then confirm
  // the session row carries the name for every UI.
  const renamed = await client.wait((f) => f.type === "event" && f.event === "session.updated");
  assert.equal(renamed.payload.name, "Fix Telegram Bot Replies");
  assert.equal(renamed.payload.sessionKey, "main:main");

  const listed = await client.request("sessions.list", {});
  const rows = listed.payload?.sessions ?? [];
  const row = rows.find((r) => r.key === "main:main");
  assert.ok(row, `main:main in sessions.list: ${JSON.stringify(rows)}`);
  assert.equal(row.name, "Fix Telegram Bot Replies", "auto-title saved on the session row");

  // dream.run: the same sweep the nightly schedule runs, over the gateway.
  const dreamRes = await client.request("dream.run", {});
  assert.match(String(dreamRes.payload?.text ?? ""), /promoted 1 fact into MEMORY\.md/);

  // dream.status: the Dreams-tab facts — dreaming off here, but counts and
  // the last sweep must reflect the dream.run that just finished.
  const statusRes = await client.request("dream.status", {});
  assert.equal(statusRes.ok, true, `dream.status ok: ${JSON.stringify(statusRes)}`);
  assert.equal(statusRes.payload?.enabled, false);
  assert.equal(statusRes.payload?.schedule, "0 4 * * *");
  assert.equal(statusRes.payload?.counts?.diaryEntries, 1, "one Deep Sleep entry");
  assert.ok(statusRes.payload?.counts?.memoryLines > 0, "curated MEMORY.md lines counted");
  assert.equal(statusRes.payload?.counts?.dailyNotes, 1, "the seeded daily note is counted");
  assert.ok(statusRes.payload?.lastDreamAt > 0, "last sweep timestamp from the diary mtime");
  assert.equal(statusRes.payload?.nextRunAt, null, "disabled dreaming schedules nothing");

  // dream.diary: the reader content — diary entry plus the curated file.
  const diaryRes = await client.request("dream.diary", {});
  assert.equal(diaryRes.ok, true, `dream.diary ok: ${JSON.stringify(diaryRes)}`);
  assert.match(String(diaryRes.payload?.dreams ?? ""), /## Deep Sleep - /);
  assert.match(String(diaryRes.payload?.memory ?? ""), /Durable Fact: user prefers compact bullet lists/);
  assert.ok(String(diaryRes.payload?.dreamsPath ?? "").endsWith("DREAMS.md"));
  const wsDir = join(home, ".suparclaw", "workspace");
  assert.ok(existsSync(join(wsDir, "DREAMS.md")), "gateway dream.run wrote the diary");
});
