// Runtime regression — `telegram failed to start: e is not a constructor`:
// esbuild's code splitting compiles grammy's CJS entry to a chunk whose ONLY
// export is default, so destructuring { Bot } from the dynamic import was
// undefined. Also covers the imap fetch .catch that returned undefined and
// slipped past the `=== null` branch, and a typecheck-clean gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("telegram createBot resolves Bot from named OR default export (bundle-shape proof)", () => {
  const src = readFileSync(new URL("../src/channels/telegram.ts", import.meta.url), "utf8");
  assert.match(src, /mod\.Bot \?\? mod\.default\?\.Bot/);
  assert.match(src, /typeof Bot !== "function"/);
  assert.match(src, /grammy Bot export unavailable/);
  assert.match(src, /typeof import\("grammy"\)/); // typing keeps the class generics
});

test("built dist chunk carries the same fallback (the chunk that produced 'e is not a constructor')", () => {
  const chunks = readdirSync(new URL("../dist/chunks", import.meta.url).pathname)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(new URL("../dist/chunks", import.meta.url).pathname, f), "utf8"));
  const service = chunks.find((c) => c.includes("telegram failed to start"));
  assert.ok(service, "service chunk found");
  assert.match(String(service), /grammy Bot export unavailable/);
  // the chunk's helper no longer destructures Bot from the raw import object
  assert.doesNotMatch(String(service), /\{Bot:\w+\}=await import\("\.\/mod-/s);
});

test("imap fetch failure returns null (never undefined past the null branch)", () => {
  const src = readFileSync(new URL("../src/automation/imap.ts", import.meta.url), "utf8");
  assert.match(src, /catch\(\(e: Error\): null => \{/);
  assert.match(src, /if \(!mail\) \{/);
});

test("tsc --noEmit stays clean (typecheck debt must not creep back)", () => {
  const out = execSync("npx tsc --noEmit 2>&1 || true", { cwd: new URL("..", import.meta.url).pathname, timeout: 120_000 }).toString();
  assert.equal(out.trim(), "", `typecheck must be clean:\n${out.slice(0, 600)}`);
});
