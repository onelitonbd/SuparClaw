// P4 (Missing!#35) — cron job editor UI: create/edit/delete + enable toggle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("gateway wires cron.upsert + cron.remove with the CLI's validation contract", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"cron\.upsert",/);
  assert.match(src, /"cron\.remove",/);
  assert.match(src, /case "cron\.upsert":/);
  // same validation as `sc cron add` (#14): required fields, croner parse,
  // delivery-mode enum, webhook needs a target
  assert.match(src, /name, schedule and prompt are required/);
  assert.match(src, /new Cron\(schedule, \{ paused: true, timezone: tz \?\? undefined \}\)/);
  assert.match(src, /deliveryMode must be none \| announce \| webhook/);
  assert.match(src, /deliveryMode webhook needs deliveryTo <url>/);
  assert.match(src, /bad_schedule/);
  // id derivation matches the CLI; session key + suppression defaults preserved
  assert.ok(src.includes('name.replace(/\\W+/g, "-").toLowerCase()'), "id derivation matches the CLI");
  assert.match(src, /session_key: existing\?\.session_key \?\? `cron:\$\{jobId\}`/);
  // scheduler re-arms immediately after a write, edits keep the id
  const upserts = src.match(/cronReconcile\(\);/g) ?? [];
  assert.ok(upserts.length >= 2, "upsert + remove both reconcile");
  assert.match(src, /service\.store\.upsertJob\(/);
  assert.match(src, /service\.store\.deleteJob\(jobId\)/);
  // enable/disable python-through: enabled param honored over stored default
  assert.match(src, /params\["enabled"\] === "boolean" \? \(params\["enabled"\] \? 1 : 0\) : Number\(existing\?\.enabled \?\? 1\)/);
});

test("automations tab renders the cron editor: rows, toggle, edit, delete, new-job dialog", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /gateway\.request\("cron\.list"\)/);
  assert.match(src, /class: "row cron-job"/);
  assert.match(src, /id: `cron-toggle-\$\{j\.id\}`/);
  assert.match(src, /id: `cron-edit-\$\{j\.id\}`/);
  assert.match(src, /id: `cron-del-\$\{j\.id\}`/);
  assert.match(src, /id: "cron-new"/);
  // toggle writes enabled through cron.upsert (same validated path)
  assert.match(src, /await gateway\.request\("cron\.upsert", \{ id: String\(j\.id\).*enabled: !enabled \}\)/s);
  // delete confirmation (their destructive-action rule) → cron.remove
  assert.match(src, /window\.confirm\(`Delete cron job/);
  assert.match(src, /gateway\.request\("cron\.remove", \{ id: String\(j\.id\) \}\)/);
  // dialog: every JobRow field is editable
  assert.match(src, /#cronJobDialog\(job: any \| null, config: any\)/);
  assert.match(src, /"Name"/);
  assert.match(src, /"Schedule \(cron\)"/);
  assert.match(src, /"Prompt"/);
  assert.match(src, /"Timezone \(IANA, optional\)"/);
  assert.match(src, /default \(cron\.delivery\)/);
  assert.match(src, /Delivery target \(optional\)/);
  assert.match(src, /Suppress empty results/);
  assert.match(src, /"Enabled"/);
  // create vs edit label; edits keep the id in the payload
  assert.match(src, /job \? `Edit job: /);
  assert.match(src, /\.\.\.\(job\?\.id \? \{ id: String\(job\.id\) \} : \{\}\)/);
  // last-run status surfaced per job (their jobs page shows recent runs)
  assert.match(src, /lastRunByJob/);
  const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.cron-job__toggle/);
  assert.match(css, /\.cron-job__meta/);
});
