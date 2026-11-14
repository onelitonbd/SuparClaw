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

test("the built bundle carries the same fallback (wherever esbuild puts it)", () => {
  // Asserted across the whole build, not one chunk: the guard and the code that
  // calls it sit in different chunks whenever the import graph moves (adding
  // `sc telegram commands` moved them), and the invariant is about the shipped
  // code, not about esbuild's chunking.
  const dir = new URL("../dist/chunks", import.meta.url).pathname;
  const chunks = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
  assert.ok(chunks.length > 0, "chunks were built");
  const all = [...chunks, readFileSync(new URL("../dist/lib.js", import.meta.url), "utf8")].join("\n");

  assert.match(all, /grammy Bot export unavailable/, "the fallback survived minification");
  assert.ok(chunks.some((c) => c.includes("telegram failed to start")), "the channel's error path is in the build");
  // And the helper still does not destructure Bot from the raw import object —
  // that destructure was the bug (`e is not a constructor`).
  assert.doesNotMatch(all, /\{Bot:\w+\}=await import\("\/mod-/s);
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
