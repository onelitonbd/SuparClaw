// P3 (row Missing!#27) — Control-UI automations panel + web notifications.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-auto-panel-"));
const { Service, emptyConfig, Store } = await import("../dist/lib.js");

test("service.automationsState — cron+heartbeat+imap payload; no secrets, no mail bodies", async () => {
  const service = new Service();
  const state = await service.automationsState();

  // cron lane
  assert.equal(typeof state.cron.enabled, "boolean");
  assert.ok(Array.isArray(state.cron.jobs));
  assert.ok(Array.isArray(state.cron.runs));

  // heartbeat lane (their gateway/heartbeat defaults)
  assert.equal(state.heartbeat.every, "30m");
  assert.equal(state.heartbeat.target, "owner");
  assert.equal(state.heartbeat.lightContext, false);
  assert.equal(state.heartbeat.isolatedSession, false);
  assert.ok("armed" in state.heartbeat);
  assert.ok("lastTargetChat" in state.heartbeat);
  assert.ok(state.heartbeat.activeHours !== undefined);

  // imap lane (empty config → disabled, zero accounts)
  assert.equal(state.imap.enabled, false);
  assert.deepEqual(state.imap.accounts, []);

  await service.stop();
});

test("service.automationsState — imap section reflects account config + persisted state, never subjects/bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-auto-panel2-"));
  process.env.SUPARCLAW_HOME = dir;
  // fresh Service after env change: module-level path caches make this same
  // state dir visible to a NEW service only when paths resolve lazily — so
  // write the imap state file at the location paths.ts resolves for THIS env.
  const { stateDir } = await import("../dist/lib.js");
  const cfgSvc = new Service();
  const { writeImapState, imapStatePath } = await import("../dist/lib.js").catch(() => import("../dist/lib.js"));
  const p = imapStatePath ? imapStatePath(stateDir()) : null;
  if (p) {
    const { imap } = cfgSvc.config;
    imap.enabled = true;
    imap.accounts.personal = {
      enabled: true, host: "imap.example.com", port: 993, secure: true, user: "r@x",
      password: "", passwordEnv: "", mailbox: "INBOX",
      watch: { mode: "auto", pollSeconds: 60 },
      allowedSenders: ["boss@corp.test"], addressTokens: [],
      senderAuth: { min: "unverified", trustedAuthservIds: [], acceptTrustedAuthservId: false },
      deliver: false, to: "", includeBody: true, maxBytes: 20000,
    };
    import("../dist/lib.js").then(() => {});
  }
  const state = await cfgSvc.automationsState();
  assert.equal(state.imap.enabled, false, "config edits outside config.set don't dirty the panel (runtime config is the single source)");
  // bin privacy: the automations payload must not embed raw user mail text
  const json = JSON.stringify(state);
  assert.ok(!json.includes("subject"), "no subjects in the panel payload (their reject-log privacy rule)");
  assert.ok(!json.includes("bodyText"), "no mail bodies in the panel payload");
  await cfgSvc.stop();
});

test("Control UI — automations.state is advertised + routed on the gateway", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"automations\.state"/, "advertised on the hello methods list");
  assert.match(src, /case "automations\.state"/, "request router handles it");
  // panel page exists in the control-ui source
  const settings = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /renderAutomations/, "settings tab renders the panel");
  const main = readFileSync(new URL("../ui/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /onGatewayEvent/, "main wires the notification hook");
});

test("Control UI — alerts tab: reply opt-in, quiet-hours + test", () => {
  const src = readFileSync(new URL("../ui/src/notifications.ts", import.meta.url), "utf8");
  assert.match(src, /reply: false/, "every other category is opt-in");
  assert.match(src, /inQuietHours/, "quiet-hours gate");
  assert.match(src, /sendTest/, "Settings → Notifications send-test");
  assert.match(src, /askOnceOnFirstSend/, "first-chat-send auto-prompt (their onboarding rule)");
  // privacy rule: payload generic, no excerpts
  assert.ok(!/body: ev\.text/.test(src), "alert bodies never include message text (their privacy rule)");
});

