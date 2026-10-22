// P3 (row Missing!#27) — heartbeat automation (their gateway/heartbeat contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lib = await import("../dist/lib.js");
const {
  Heartbeat,
  filterHeartbeatReply,
  stripStrayHeartbeatOk,
  parseHeartbeatEvery,
  heartbeatDecision,
  inActiveHours,
  DEFAULT_HEARTBEAT_PROMPT,
} = lib;

const CFG = (over = {}) => ({
  channels: {
    telegram: { token: "tok", allowFrom: ["123456789", "*"], enabled: true },
  },
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        model: "",
        lightContext: false,
        isolatedSession: false,
        target: "owner",
        to: "",
        prompt: DEFAULT_HEARTBEAT_PROMPT,
        timeoutSeconds: 0,
        activeHours: { start: "", end: "", timezone: "" },
        ...over,
      },
    },
  },
  // remaining fields that heartbeat.ts touches — the module only reads
  // these two subtrees, so the rest of the config shape is not required.
});

test("filterHeartbeatReply — NO_REPLY silent; heartbeat-only token-prefix fragments", () => {
  assert.equal(filterHeartbeatReply("NO_REPLY").kind, "silent");
  assert.equal(filterHeartbeatReply("no_reply").kind, "silent");
  assert.equal(filterHeartbeatReply("NO_R").kind, "silent");
  assert.equal(filterHeartbeatReply("no_r").kind, "silent");
  assert.equal(filterHeartbeatReply(" NO_REPLY ").kind, "silent");
  // fragments below 4 chars are not special
  assert.equal(filterHeartbeatReply("NO").kind, "deliver");
  // normal content kept
  const d = filterHeartbeatReply("Disk at 92% \u2014 cleanup needed");
  assert.equal(d.kind, "deliver");
  assert.match(d.text, /Disk at 92%/);
  assert.equal(filterHeartbeatReply("").kind, "silent");
});

test("filterHeartbeatReply — legacy HEARTBEAT_OK at start/end with <300-char remainder is suppressed", () => {
  assert.equal(filterHeartbeatReply("HEARTBEAT_OK").kind, "silent");
  assert.equal(filterHeartbeatReply("HEARTBEAT_OK\nTiny note").kind, "silent");
  const longNote = "x".repeat(310);
  assert.equal(filterHeartbeatReply(`HEARTBEAT_OK ${longNote}`).kind, "deliver", "remainder above 300 chars is NOT suppressed");
  assert.equal(filterHeartbeatReply(`${longNote} HEARTBEAT_OK`).kind, "deliver");
  // middle-position is never special (their rule)
  const mid = filterHeartbeatReply(`Alert! ${"a".repeat(10)} HEARTBEAT_OK ${"b".repeat(10)}`);
  assert.equal(mid.kind, "deliver");
  assert.match(mid.text, /HEARTBEAT_OK/);
  // end-position within budget suppressed
  assert.equal(filterHeartbeatReply("ok\n\nHEARTBEAT_OK").kind, "silent");
});

test("stripStrayHeartbeatOk — outside heartbeats, stray markers at start/end are stripped", () => {
  assert.equal(stripStrayHeartbeatOk("HEARTBEAT_OK something wrong"), "something wrong");
  assert.equal(stripStrayHeartbeatOk("something wrong HEARTBEAT_OK"), "something wrong");
  assert.equal(stripStrayHeartbeatOk("HEARTBEAT_OK").trim(), "");
  // middle preserved
  const t = stripStrayHeartbeatOk("a HEARTBEAT_OK b");
  assert.match(t, /HEARTBEAT_OK/);
});

test("parseHeartbeatEvery — fm/hm/sm suffixes, 0m disables", () => {
  assert.equal(parseHeartbeatEvery("30m"), 30 * 60 * 1000);
  assert.equal(parseHeartbeatEvery("1h"), 3600_000);
  assert.equal(parseHeartbeatEvery("45s"), 45_000);
  assert.equal(parseHeartbeatEvery("0m"), 0);
  assert.equal(parseHeartbeatEvery(""), 30 * 60 * 1000, "default 30m");
  assert.equal(parseHeartbeatEvery(undefined), 30 * 60 * 1000);
  assert.equal(parseHeartbeatEvery("bogus"), 30 * 60 * 1000);
});

test("inActiveHours — overnight window + zero-width always skipped (their rule)", () => {
  const mk = (hh, mmd) => new Date(Date.UTC(2026, 9, 22, hh, mmd));
  const dayh = { start: "09:00", end: "22:00", timezone: "UTC" };
  assert.equal(inActiveHours(dayh, mk(10, 0), "local"), true);
  assert.equal(inActiveHours(dayh, mk(8, 59), "local"), false);
  assert.equal(inActiveHours(dayh, mk(22, 0), "local"), false, "end is exclusive");
  assert.equal(inActiveHours({ start: "08:00", end: "08:00", timezone: "UTC" }, mk(12, 0)), false, "zero-width always skips");
  // overnight wrap
  const night = { start: "22:00", end: "06:00", timezone: "UTC" };
  assert.equal(inActiveHours(night, mk(23, 0)), true);
  assert.equal(inActiveHours(night, mk(5, 30)), true);
  assert.equal(inActiveHours(night, mk(12, 0)), false);
  // unrestricted default
  assert.equal(inActiveHours({ start: "", end: "", timezone: "" }, mk(12, 0)), true);
});

test("heartbeatDecision — disabled cadence, busy-drop requests-in-flight, outside hours", () => {
  const now = new Date(Date.UTC(2026, 9, 22, 12, 0));
  assert.deepEqual(heartbeatDecision(CFG({ every: "0m" }), false, now), { run: false, reason: "disabled-cadence" });
  assert.deepEqual(heartbeatDecision(CFG(), true, now), { run: false, reason: "requests-in-flight" });
  assert.deepEqual(
    heartbeatDecision(CFG({ activeHours: { start: "00:00", end: "01:00", timezone: "UTC" } }), false, now),
    { run: false, reason: "outside-active-hours" },
  );
  assert.deepEqual(heartbeatDecision(CFG(), false, now), { run: true });
});

test("Heartbeat tick — owner DM delivery + last-following", async () => {
  const delivered = [];
  const turns = [];
  const mk = (over, extra = {}) => new Heartbeat({
    config: () => CFG(over),
    busy: () => false,
    sendTurn: async (args) => { turns.push(args); return "Disk at 92% — cleanup needed"; },
    deliver: async (chatId, text) => delivered.push([chatId, text]),
    log: () => {},
    hostTimezone: "UTC",
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0)),
    ...extra,
  });
  const hb = mk({});
  const r = await hb.tick();
  assert.equal(r.ran, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0], 123456789, "first concrete allowFrom entry (their owner resolution)");
  // target:"last" follows rememberOutbound instead of the allowlist
  const hb2 = mk({ target: "last" });
  hb2.rememberOutbound(424242);
  await hb2.tick();
  assert.equal(delivered[1][0], 424242);
  // target:"none" == internal-only; the turn still RUNS (their rule)
  const hb3 = mk({ target: "none" });
  const r3 = await hb3.tick();
  assert.equal(r3.ran, true);
  assert.equal(r3.delivered, false);
  assert.equal(delivered.length, 2);
});

test("Heartbeat tick — NO_REPLY silent, no delivery", async () => {
  const delivered = [];
  const hb = new Heartbeat({
    config: () => CFG({}),
    busy: () => false,
    sendTurn: async () => "NO_REPLY",
    deliver: async (c, t) => delivered.push([c, t]),
    log: () => {},
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0)),
  });
  const r = await hb.tick();
  assert.equal(r.ran, true);
  assert.equal(delivered.length, 0);
});

test("Heartbeat tick — no-route skip logs once; prompt goes verbatim; lightContext + isolatedSession flags flow through", async () => {
  const logs = [];
  const turns = [];
  const hb = new Heartbeat({
    config: () => ({
      channels: { telegram: { token: "", allowFrom: [], enabled: false } },
      agents: { defaults: { heartbeat: { ...CFG({ lightContext: true, isolatedSession: true }).agents.defaults.heartbeat } } },
    }),
    busy: () => false,
    sendTurn: async (args) => { turns.push(args); return "something"; },
    deliver: async () => {},
    log: (s) => logs.push(s),
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0)),
  });
  const r = await hb.tick();
  assert.equal(r.reason, "no-route", "no resolvable owner → ambient poll skips without a model call");
  assert.equal(turns.length, 0);
  assert.ok(logs.filter((l) => /no-route/.test(l)).length <= 1, "logged once");
  // isolated + lightContext live in the sendTurn contract — smoke via a runnable instance
  const hb2 = new Heartbeat({
    config: () => CFG({ lightContext: true, isolatedSession: true, every: "1h" }),
    busy: () => false,
    sendTurn: async (args) => { turns.push(args); return "NO_REPLY"; },
    deliver: async () => {},
    log: () => {},
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0)),
  });
  await hb2.tick();
  assert.equal(turns[0].lightContext, true);
  assert.equal(turns[0].isolatedSession, true);
  assert.match(turns[0].sessionKey, /^heartbeat:/, "isolated session key");
  assert.equal(turns[0].prompt, DEFAULT_HEARTBEAT_PROMPT, "verbatim prompt (their contract)");
  assert.equal(turns[0].timeoutSeconds, 600, "cadence-capped timeout (their 600s cap: 1h → 600s)");
});

test("Heartbeat tick — timeoutSeconds override wins over cadence cap", async () => {
  const got = [];
  const hb = new Heartbeat({
    config: () => CFG({ timeoutSeconds: 45, every: "30m" }),
    busy: () => false,
    sendTurn: async (a) => { got.push(a.timeoutSeconds); return "NO_REPLY"; },
    deliver: async () => {},
    log: () => {},
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0)),
  });
  await hb.tick();
  assert.equal(got[0], 45, "heartbeat.timeoutSeconds override (their per-cadence override)");
});

test("Heartbeat start/stop — recurring cadence; 0m disabled", async () => {
  const logs = [];
  const hb = new Heartbeat({
    config: () => CFG({ every: "30m" }),
    busy: () => true,
    sendTurn: async () => "NO_REPLY",
    deliver: async () => {},
    log: (s) => logs.push(s),
  });
  hb.start();
  assert.equal(hb.stats().armed, true);
  hb.stop();
  assert.equal(hb.stats().armed, false);
  const hb2 = new Heartbeat({
    config: () => CFG({ every: "0m" }),
    busy: () => false,
    sendTurn: async () => "NO_REPLY",
    deliver: async () => {},
    log: (s) => logs.push(s),
  });
  hb2.start();
  assert.equal(hb2.stats().armed, false, "0m disables recurring cadence (their doc)");
  assert.ok(logs.some((l) => /disabled/.test(l)));
});

test("schema — agents.defaults.heartbeat defaults to 30m + verbatim prompt + owner target", () => {
  const { emptyConfig } = lib;
  const cfg = emptyConfig();
  assert.equal(cfg.agents.defaults.heartbeat.every, "30m");
  assert.equal(cfg.agents.defaults.heartbeat.target, "owner");
  assert.equal(cfg.agents.defaults.heartbeat.lightContext, false);
  assert.equal(cfg.agents.defaults.heartbeat.isolatedSession, false);
  assert.equal(cfg.agents.defaults.heartbeat.prompt, DEFAULT_HEARTBEAT_PROMPT);
  assert.equal(cfg.agents.defaults.heartbeat.activeHours.start, "");
  assert.equal(cfg.agents.defaults.heartbeat.activeHours.end, "");
});

test("workspace lightContext — bootstrap files skipped entirely", async () => {
  const ws = mkdtempSync(join(tmpdir(), "sc-hb-ws-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(ws, "AGENTS.md"), "operating rules here");
  writeFileSync(join(ws, "SOUL.md"), "personality here");
  const { loadWorkspaceContext } = lib;
  const heavy = loadWorkspaceContext(ws, { isMainSession: true });
  assert.equal(heavy.included.length, 2);
  const light = loadWorkspaceContext(ws, { isMainSession: true, lightContext: true });
  assert.equal(light.included.length, 0, "lightContext → no workspace files (their doc)");
  assert.equal(light.text, "");
});
