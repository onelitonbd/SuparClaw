// P2 #14 — cron timezones, result delivery, failure alerts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  Store,
  jobTimezone,
  resolveDelivery,
  isEmptySummary,
  assertWebhookUrl,
  errorStreak,
  shouldAlert,
  emptyConfig,
} = await import("../dist/lib.js");

function cronCfg(overrides = {}) {
  const c = emptyConfig().cron;
  return { ...c, ...overrides };
}
function job(overrides = {}) {
  return { id: "j1", delivery_mode: null, delivery_to: null, delivery_suppress_empty: 1, tz: null, ...overrides };
}

// ---- A16: timezone layering ------------------------------------------------

test("per-job tz wins, then cron.timezone, then the host zone", () => {
  assert.equal(jobTimezone({ tz: "Asia/Dhaka" }, "local"), "Asia/Dhaka");
  assert.equal(jobTimezone({ tz: null }, "UTC"), "UTC");
  assert.equal(jobTimezone({ tz: null }, "local"), undefined, "'local' = host zone ⇒ no option passed");
  assert.equal(jobTimezone({ tz: "" }, "Europe/Berlin"), "Europe/Berlin");
});

test("croner itself accepts the per-job timezone and computes next runs in it", async () => {
  const { Cron } = await import("croner");
  const utc = new Cron("0 12 * * *", { paused: true, timezone: "UTC" }).nextRun();
  const dhaka = new Cron("0 12 * * *", { paused: true, timezone: "Asia/Dhaka" }).nextRun();
  assert.equal(utc.getUTCHours(), 12);
  assert.equal(dhaka.getUTCHours(), 6, "Dhaka noon = 06:00 UTC");
});

test("jobs table carries tz + delivery columns end-to-end", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-cron-tz-"));
  const store = Store.open(join(dir, "state.db"));
  store.upsertJob({
    id: "daily", name: "daily", schedule: "0 9 * * *", prompt: "go",
    session_key: "cron:daily", enabled: 1,
    tz: "Asia/Dhaka", delivery_mode: "announce", delivery_to: "telegram:42", delivery_suppress_empty: 1,
  });
  const row = store.getJob("daily");
  assert.equal(row.tz, "Asia/Dhaka");
  assert.equal(row.delivery_mode, "announce");
  assert.equal(row.delivery_to, "telegram:42");
  // Legacy upserts leave the new columns null / suppress-empty on.
  store.upsertJob({ id: "legacy", name: "l", schedule: "* * * * *", prompt: "p", session_key: "cron:legacy", enabled: 1 });
  const legacy = store.getJob("legacy");
  assert.equal(legacy.tz, null);
  assert.equal(legacy.delivery_mode, null);
  assert.equal(legacy.delivery_suppress_empty, 1);
  store.close();
});

// ---- A15: delivery resolution + suppression --------------------------------

test("delivery resolution: per-job columns then cron.delivery defaults", () => {
  const eff = resolveDelivery(job({ delivery_mode: "webhook", delivery_to: "https://h/x" }), cronCfg());
  assert.deepEqual(eff, { mode: "webhook", to: "https://h/x", suppressEmpty: true });
  const viaCfg = resolveDelivery(job(), cronCfg({ delivery: { mode: "announce", to: "telegram:7", suppressEmpty: false } }));
  assert.deepEqual(viaCfg, { mode: "announce", to: "telegram:7", suppressEmpty: false });
  assert.equal(resolveDelivery(job({ delivery_mode: "bruh" }), cronCfg()).mode, "none", "unknown modes fail closed");
});

test("empty results are suppressed; real text is not", () => {
  assert.equal(isEmptySummary(""), true);
  assert.equal(isEmptySummary("   \n"), true);
  assert.equal(isEmptySummary("(no response)"), true);
  assert.equal(isEmptySummary("  ok. "), false);
});

// ---- A15: SSRF guard ---------------------------------------------------------

const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];

test("webhook targets: https public hostnames pass", async () => {
  const u = await assertWebhookUrl("https://relay.example.com/hook", [], publicLookup);
  assert.equal(u.hostname, "relay.example.com");
});

test("http and private-resolving targets are blocked without an allowlist entry", async () => {
  await assert.rejects(assertWebhookUrl("http://relay.example.com/x", [], publicLookup), /https/);
  await assert.rejects(
    assertWebhookUrl("https://internal.corp/x", [], async () => [{ address: "10.0.0.4", family: 4 }]),
    /private address/,
  );
  await assert.rejects(
    assertWebhookUrl("https://v4mapped.example/x", [], async () => [{ address: "::ffff:127.0.0.1", family: 6 }]),
    /private address/,
  );
  await assert.rejects(assertWebhookUrl("https://user:pw@evil.example/x", [], publicLookup), /credentials/);
});

test("cron.webhookAllowHostnames escapes the policy exactly (their SSRF exception)", async () => {
  const u = await assertWebhookUrl("http://192.168.1.5:9000/hook", ["192.168.1.5"], async () => {
    throw new Error("allowlisted targets must not be resolved at all");
  });
  assert.equal(u.port, "9000");
  await assert.rejects(assertWebhookUrl("http://192.168.1.6:9000/hook", ["192.168.1.5"], publicLookup), /https/, "different host does not ride along");
});

// ---- A15: failure alerts ----------------------------------------------------

test("errorStreak counts trailing failures of that job only", () => {
  // Rows are newest-first (lastJobRuns ordering), but "trailing" must be
  // contiguous per job: another job's row between two errors of the same
  // job does NOT count as recovery.
  const flakyTail = [
    { job_id: "a", status: "error" },
    { job_id: "a", status: "error" },
    { job_id: "a", status: "done" },
  ];
  assert.equal(errorStreak(flakyTail, "a"), 2);
  assert.equal(errorStreak([{ job_id: "a", status: "done" }, { job_id: "a", status: "error" }], "a"), 0, "newest outcome is a success");
  assert.equal(errorStreak(flakyTail, "b"), 0, "no rows for b ⇒ healthy");
});

test("shouldAlert: threshold + cooldown", () => {
  const t0 = 1_000_000;
  assert.equal(shouldAlert(2, 2, undefined, 60, t0), true);
  assert.equal(shouldAlert(1, 2, undefined, 60, t0), false);
  assert.equal(shouldAlert(3, 2, t0 - 30 * 60_000, 60, t0), false, "inside cooldown");
  assert.equal(shouldAlert(3, 2, t0 - 61 * 60_000, 60, t0), true, "cooldown passed");
});

test("schema defaults: cron.delivery none + suppress, alerts 2/60, SSRF allowlist empty", () => {
  const c = emptyConfig().cron;
  assert.equal(c.delivery.mode, "none");
  assert.equal(c.delivery.suppressEmpty, true);
  assert.deepEqual(c.failureAlerts, { enabled: true, threshold: 2, cooldownMinutes: 60, to: "" });
  assert.deepEqual(c.webhookAllowHostnames, []);
});
