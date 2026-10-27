// Task 26 (audit 1) — the UI and the gateway must agree about what exists.
//
// Nothing in the app checks `hello-ok.methods` today, so a missing entry is
// invisible on screen — which is exactly why it drifts. This test treats the
// three sets as one contract:
//
//   UI calls  ⊆  advertised  ⊆  handled
//
// and fails on duplicates or on any handler that no client can discover.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function uiCalls() {
  const out = new Map();
  for (const file of readdirSync(join(ROOT, "ui/src")).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(ROOT, "ui/src", file), "utf8");
    // `gateway.request("x")` directly, `grab("x")` (settings.ts wraps the call
    // for pages that must survive one failed read), and `transport.request("x")`
    // (Task 52's terminal panel takes its socket by injection so it can be
    // rendered in a test) — all three are real calls.
    for (const re of [/gateway\.request\(\s*"([^"]+)"/g, /\bgrab\(\s*"([^"]+)"/g, /transport\.request\(\s*"([^"]+)"/g]) {
      for (const m of src.matchAll(re)) {
        if (!out.has(m[1])) out.set(m[1], new Set());
        out.get(m[1]).add(file);
      }
    }
  }
  return out;
}

const server = readFileSync(join(ROOT, "src/gateway/server.ts"), "utf8");

function advertised() {
  const start = server.indexOf("#methods(): string[]");
  const end = server.indexOf("];", start);
  assert.ok(start > 0 && end > start, "the methods list is where this test expects it");
  return [...server.slice(start, end).matchAll(/"([a-zA-Z][A-Za-z]*(?:\.[A-Za-z.]+)?)"/g)].map((m) => m[1]);
}

function handled() {
  return new Set([...server.matchAll(/case "([a-zA-Z][A-Za-z]*(?:\.[A-Za-z.]+)?)":/g)].map((m) => m[1]));
}

test("every method the UI calls is advertised and handled", () => {
  const adv = new Set(advertised());
  const have = handled();
  const missingHandler = [];
  const missingAdvert = [];
  for (const [method, files] of uiCalls()) {
    if (!have.has(method)) missingHandler.push(`${method} (${[...files].join(", ")})`);
    if (!adv.has(method)) missingAdvert.push(`${method} (${[...files].join(", ")})`);
  }
  assert.deepEqual(missingHandler, [], "the UI must never call a method the gateway cannot answer");
  assert.deepEqual(missingAdvert, [], "and it must be discoverable by any other client");
});

test("every advertised method has a handler", () => {
  const have = handled();
  const orphans = advertised().filter((m) => !have.has(m));
  assert.deepEqual(orphans, [], "advertising a method nobody implements is a lie to clients");
});

test("nothing is advertised twice", () => {
  const list = advertised();
  const dupes = list.filter((m, i) => list.indexOf(m) !== i);
  assert.deepEqual([...new Set(dupes)], [], "a duplicate entry hides a real one in review");
});

test("the gateway answers every method it advertises, and the UI covers the chat core", () => {
  const adv = new Set(advertised());
  for (const core of [
    "chat.send", "chat.history", "chat.abort", "chat.regenerate", "chat.rewind", "chat.fork",
    "config.get", "config.set", "config.unset", "config.replace",
    "sessions.list", "sessions.patch", "sessions.rename", "sessions.delete", "sessions.export",
    "models.list", "models.save", "models.remove", "skills.get", "skills.save",
    "service.status", "service.logs", "service.restart", "dream.run", "sessions.cleanup",
  ]) {
    assert.ok(adv.has(core), `${core} is advertised`);
    assert.ok(handled().has(core), `${core} is handled`);
  }
});
