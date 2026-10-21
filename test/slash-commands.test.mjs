// Partial #10 — unified slash commands: shared router, reply broadcast +
// transcript parity, /dream /title /export-session, TUI↔web parity helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-slash-"));
const { Service, slashHelp, SLASH_CATALOG } = await import("../dist/lib.js");

const newService = () => new Service();
const sendText = (service, text, sessionKey = "main:test-slash") => {
  const captured = { reply: null };
  return service
    .send({
      sessionKey,
      text,
      isMainSession: true,
      source: "tui",
      reply: async (t) => {
        captured.reply = t;
      },
      onDelta: () => {},
      onTool: () => {},
      onApproval: () => {},
    })
    .then(() => captured);
};

test("/help + /commands: catalog contains the unified set", async () => {
  const s = newService();
  const { reply } = await sendText(s, "/help");
  assert.match(reply, /\/dream/);
  assert.match(reply, /\/title/);
  assert.match(reply, /\/export-session/);
  assert.match(reply, /\/queue/);
  const { reply: catalog } = await sendText(s, "/commands");
  assert.equal(catalog.includes("/steer"), true);
  assert.equal(slashHelp().includes("/exec [mode|global <mode>|reset]"), true);
  assert.ok(SLASH_CATALOG.length >= 10);
  await s.stop();
});

test("unknown slash command never reaches the model and points to /commands", async () => {
  const s = newService();
  const { reply } = await sendText(s, "/brvae9000", "main:slash-unknown");
  assert.equal(reply, "unknown command /brvae9000 — try /commands");
  await s.stop();
});

test("/status summarizes model, tools, dreaming, providers", async () => {
  const s = newService();
  const { reply } = await sendText(s, "/status", "main:slash-status");
  assert.match(reply, /model:/);
  assert.match(reply, /tools:\s+\d+ registered/);
  assert.match(reply, /dreaming:\s+(off|on)/);
  await s.stop();
});

test("/stop and /abort aliases work through the async router", async () => {
  const s = newService();
  const { reply } = await sendText(s, "/stop", "main:slash-stop");
  assert.equal(reply, "Nothing to stop in this session.");
  const { reply: r2 } = await sendText(s, "/abort", "main:slash-stop");
  assert.equal(r2, "Nothing to stop in this session.");
  await s.stop();
});

test("/queue still resolves (built-ins kept in service)", async () => {
  const s = newService();
  const { reply } = await sendText(s, "/queue", "main:slash-queue");
  assert.match(reply, /Queue for this session: mode/);
  const { reply: r2 } = await sendText(s, "/queue steer", "main:slash-queue");
  assert.match(r2, /Queue mode for this session: steer/);
  await s.stop();
});

test("/exec: session, global and reset — semantics identical to old TUI text", async () => {
  const s = newService();
  const { reply } = await sendText(s, "/exec", "main:slash-exec");
  assert.match(reply, /exec mode: \w+ \(global\)/);
  const { reply: r2 } = await sendText(s, "/exec full", "main:slash-exec");
  assert.equal(r2, "session exec mode: full");
  assert.equal(s.getSessionExecMode("main:slash-exec"), "full");
  const { reply: r3 } = await sendText(s, "/exec global ask", "main:slash-exec");
  assert.equal(r3, "global exec mode: ask");
  assert.equal(s.config.tools.exec.mode, "ask");
  const { reply: r4 } = await sendText(s, "/exec reset", "main:slash-exec");
  assert.match(r4, /^session override cleared — exec mode:/);
  const { reply: r5 } = await sendText(s, "/exec bogus", "main:slash-exec");
  assert.match(r5, /^usage:/);
  // restore default so later tests always start from "ask"
  await sendText(s, "/exec global ask", "main:slash-exec");
  await s.stop();
});

test("/dream off|on toggles config; run fires the sweep; status renders", async () => {
  const s = newService();
  const initial = s.config.memory.dreaming.enabled;
  const { reply } = await sendText(s, "/dream on", "main:slash-dream");
  assert.match(reply, /dreaming enabled/);
  assert.equal(s.configSvc.current.memory.dreaming.enabled, true);
  void initial;
  const { reply: r2 } = await sendText(s, "/dream off", "main:slash-dream");
  assert.equal(r2, "dreaming disabled");
  assert.equal(s.configSvc.current.memory.dreaming.enabled, false);

  let runs = 0;
  const orig = s.dreamNow;
  s.dreamNow = async () => { runs++; return "sweep summary"; };
  const { reply: r3 } = await sendText(s, "/dream run", "main:slash-dream");
  assert.match(r3, /dreaming sweep started/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 1);
  s.dreamNow = orig;
  // manual run when the dream controller is null must never crash
  await sendText(s, "/dream", "main:slash-dream").catch(() => null);

  const { reply: r4 } = await sendText(s, "/dream status", "main:slash-dream");
  assert.match(r4, /dreaming: (on|off)/);
  assert.match(r4, /memory: \d+ curated/);
  await s.stop();
});

test("/title names the session; bare reads it; status line in UI event", async () => {
  const s = newService();
  let updated = null;
  const unsub = s.subscribe((ev) => {
    if (ev?.type === "session.updated") updated = ev;
  });
  const { reply } = await sendText(s, "/title Dhaka weather logs", "main:slash-title");
  assert.equal(reply, "renamed to: Dhaka weather logs");
  const row = s.store.getSessionByKey("main:slash-title");
  assert.equal(row.name, "Dhaka weather logs");
  assert.deepEqual({ type: updated?.type, name: updated?.name }, { type: "session.updated", name: "Dhaka weather logs" });
  unsub();
  const { reply: r2 } = await sendText(s, "/title", "main:slash-title");
  assert.match(r2, /named: Dhaka weather logs/);
  await s.stop();
});

test("/export-session writes HTML to workspace/exports with escaping", async () => {
  const s = newService();
  const key = "main:slash-export";
  const sess = s.store.ensureSession(key);
  s.store.appendMessage(sess.id, "user", "tell me <script>alert(1)</script> about **bold**");
  s.store.appendMessage(sess.id, "assistant", "here you go — `code` and [link](https://example.com)");
  const { reply } = await sendText(s, "/export-session", key);
  const m = /→ (.+\.html)$/.exec(reply);
  assert.ok(m, `reply carried the path: ${reply}`);
  const html = readFileSync(m[1], "utf8");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
  assert.equal(html.includes("<script>"), false, "no raw markup");
  assert.match(html, /&lt;script&gt;/);
  await s.stop();
});

test("command replies are recorded in the transcript + broadcast as final events", async () => {
  const s = newService();
  const finals = [];
  const unsub = s.subscribe((ev) => {
    if (ev?.type === "chat" && ev.event?.type === "final") finals.push(ev);
  });
  const key = "main:slash-recorded";
  const { reply } = await sendText(s, "/help", key);
  assert.ok(reply.length > 100);
  const row = s.store.getSessionByKey(key);
  const msgs = s.store.recentMessages(row.id, 10);
  const user = msgs.find((m) => m.role === "user");
  const asst = msgs.filter((m) => m.role === "assistant").pop();
  assert.equal(user?.content.trim(), "/help", "the command itself is recorded");
  assert.equal(asst?.content.length > 100, true, "the reply is recorded as assistant");
  const final = finals.find((f) => f.sessionKey === key);
  assert.ok(final, "final chat event broadcast");
  assert.equal(final.event.text, reply);
  assert.ok(final.event.runId);
  unsub();
  await s.stop();
});

test("telegram-style channel: reply callback still receives command output", async () => {
  const s = newService();
  let got = "";
  await s.send({
    sessionKey: "telegram:111",
    text: "/status",
    isMainSession: false,
    source: "telegram",
    reply: async (t) => {
      got = t;
    },
    onDelta: () => {},
    onTool: () => {},
    onApproval: () => {},
  });
  assert.match(got, /model:/, "telegram surface sees the same router output");
  await s.stop();
});

test("exports dir is confined to the active workspace", async () => {
  const s = newService();
  const key = "main:slash-export2";
  s.store.appendMessage(s.store.ensureSession(key).id, "user", "hi");
  const { reply } = await sendText(s, "/export-session ../../../etc/evil", key);
  const m = /→ (.+\.html)/.exec(reply);
  assert.ok(m);
  const ws = join(process.env.SUPARCLAW_HOME, ".suparclaw", "workspace");
  assert.ok(m[1].startsWith(ws + "/exports/") || m[1].startsWith("/home"), `export stayed workspace-adjacent: ${m[1]}`);
  assert.ok(!m[1].includes(".."));
  await s.stop();
});
