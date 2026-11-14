// Task 53 — retiring `channels.telegram.streaming` / `.toolProgress` must not
// break a config file that already has them, and the Channels page must not be
// able to bring them back.
//
// `validate()` rejects unknown keys, so leaving the two out of CONFIG_SCHEMA is
// not enough on its own: an existing config would refuse to load with a
// complaint about a setting that no longer does anything. `parseConfig` deletes
// them from the raw object before validating. This file pins both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  parseConfig,
  emptyConfig,
  CONFIG_SCHEMA,
  ConfigService,
  createLogger,
  readConfigFile,
  writeConfigFile,
  redactSecrets,
} = await import("../dist/lib.js");

const log = createLogger({ level: "error" });

function withConfigFile(t, text) {
  const home = mkdtempSync(join(tmpdir(), "sc-cfg-mig-"));
  const path = join(home, "config.json5");
  writeFileSync(path, text);
  t.after(() => {});
  return path;
}

const OLD_CONFIG = `{
  gateway: { port: 18790 },
  channels: {
    telegram: {
      enabled: true,
      token: "123:abc",
      streaming: "progress",
      toolProgress: "verbose",
      batchMs: 300,
      typing: { mode: "instant" },
    },
  },
}`;

test("an old config naming streaming/toolProgress still loads, keys stripped", (t) => {
  const path = withConfigFile(t, OLD_CONFIG);
  const load = readConfigFile(path);
  assert.deepEqual(load.errors, [], "no complaint about a retired key");
  const tg = load.config.channels.telegram;
  assert.equal(tg.enabled, true);
  assert.equal(tg.batchMs, 300);
  assert.equal(tg.typing.mode, "instant", "the neighbouring settings are untouched");
  assert.ok(!("streaming" in tg), "retired key is gone from the live config");
  assert.ok(!("toolProgress" in tg));
});

test("the retired keys are really out of the schema, not just unused", () => {
  const tg = CONFIG_SCHEMA.fields.channels.fields.telegram.fields;
  assert.ok(!("streaming" in tg), "no streaming leaf");
  assert.ok(!("toolProgress" in tg), "no toolProgress leaf");
  // And nothing else in the editor can reach them by accident.
  const paths = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node.fields ?? {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && v.t === "object" && v.fields) walk(v, p);
      else paths.push(p);
    }
  };
  walk(CONFIG_SCHEMA, "");
  assert.ok(!paths.includes("channels.telegram.streaming"));
  assert.ok(!paths.includes("channels.telegram.toolProgress"));
});

test("parseConfig strips them even when they carry a bogus value", () => {
  // A hand-edited file can hold anything; the value never reaches validate().
  const r = parseConfig({
    channels: { telegram: { streaming: 42, toolProgress: ["nope"], enabled: true } },
  });
  assert.deepEqual(r.errors, []);
  assert.ok(!("streaming" in r.config.channels.telegram));
  assert.ok(!("toolProgress" in r.config.channels.telegram));
});

test("a genuine typo next door is still rejected — the strip is not a blanket amnesty", () => {
  const r = parseConfig({
    channels: { telegram: { streaming: "progress", streamng: "progress" } },
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /streamng/, "the misspelt key is reported");
  assert.doesNotMatch(r.errors[0], /channels\.telegram\.streaming\b/);
});

test("Channels-page Save cannot reintroduce the retired keys", (t) => {
  // This is the exact sequence the page performs: read the served config,
  // clone the telegram block, overwrite what the visible controls bind, write
  // the whole block back with config.set. The served config has already been
  // through parseConfig, so the clone cannot carry a stale key.
  const path = withConfigFile(t, OLD_CONFIG);
  const svc = new ConfigService(log, path);
  assert.deepEqual(svc.errors, []);

  const served = svc.current;
  const block = structuredClone(served.channels.telegram);
  assert.ok(!("streaming" in block), "nothing to reintroduce from the read");
  block["enabled"] = true;
  block["batchMs"] = 450;

  const res = svc.setPath("channels.telegram", block);
  assert.equal(res.ok, true, `Save accepted: ${res.errors.join("; ")}`);

  const onDisk = readFileSync(path, "utf8");
  assert.doesNotMatch(onDisk, /streaming/, "the file is clean after a save");
  assert.doesNotMatch(onDisk, /toolProgress/);
  assert.match(onDisk, /450/, "and the edit did land");

  const reloaded = readConfigFile(path);
  assert.deepEqual(reloaded.errors, []);
  assert.equal(reloaded.config.channels.telegram.batchMs, 450);
});

test("a stale key pushed back through config.set is dropped, not written back", (t) => {
  // Defence in depth for an old UI tab still opened before the upgrade: it posts
  // a block that includes `streaming`. config.set runs the whole root through
  // parseConfig, so the key is dropped on the way in and the file stays clean —
  // no error to scare the operator, no zombie setting in the file.
  const path = withConfigFile(t, `{ channels: { telegram: { enabled: true, batchMs: 300 } } }`);
  const svc = new ConfigService(log, path);
  const block = { enabled: true, batchMs: 300, streaming: "progress" };
  const res = svc.setPath("channels.telegram", block);
  assert.equal(res.ok, true, `accepted, sanitised: ${res.errors.join("; ")}`);
  assert.ok(!("streaming" in svc.current.channels.telegram), "not live in memory either");
  const onDisk = readFileSync(path, "utf8");
  assert.doesNotMatch(onDisk, /streaming/, "the write did not carry it to the file");
});

test("example config the loader writes never mentions the retired keys", (t) => {
  const home = mkdtempSync(join(tmpdir(), "sc-cfg-ex-"));
  const path = join(home, "config.json5");
  writeConfigFile(emptyConfig(), path);
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /streaming/);
  assert.doesNotMatch(text, /toolProgress/);
  const redacted = redactSecrets(parseConfig({}).config);
  assert.ok(!("streaming" in redacted.channels.telegram));
});
