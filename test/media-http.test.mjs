// Task 30 — `GET /media/<path>`: the route that makes a chip clickable.
//
// It serves user files, so the rules matter more than the success path: the
// gateway token is required (a bearer header, never a query string), the path
// cannot leave `workspace/media`, symlinks are not followed, and a pruned file
// is a plain 404. This boots the real daemon and talks HTTP to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SC = join(process.cwd(), "dist", "sc.js");
const TOKEN = "test-token-30";

const TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
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

const run = (args, env) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, ...args], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out }));
  });

test("the media route: auth, confinement, mime, and an honest 404", async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(TMP, "sc-media-http-"));
  const env = { SUPARCLAW_HOME: home };

  assert.equal((await run(["init"], env)).code, 0, "sc init");
  for (const [path, value] of [
    ["gateway.port", String(port)],
    ["gateway.auth.mode", "token"],
    ["gateway.auth.token", TOKEN],
    // The phone's own browser is loopback; turning the bypass off is what lets
    // this test prove the token is actually required.
    ["gateway.auth.loopbackBypass", "false"],
  ]) {
    const res = await run(["config", "set", path, value], env);
    assert.equal(res.code, 0, `sc config set ${path}: ${res.out}`);
  }

  const media = join(home, ".suparclaw", "workspace", "media");
  mkdirSync(join(media, "test"), { recursive: true });
  writeFileSync(join(media, "test", "hello.txt"), "hello from the phone");
  writeFileSync(join(media, "test", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  symlinkSync(join(home, ".suparclaw", "config.json5"), join(media, "test", "sneaky.json5"));

  const gw = spawn(process.execPath, [SC, "gateway"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => gw.kill("SIGKILL"));
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      up = true;
    } catch {
      /* retry */
    }
  }
  assert.ok(up, "gateway came up");

  const url = (p) => `http://127.0.0.1:${port}/media/${p}`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  // ── auth ────────────────────────────────────────────────────────────────
  assert.equal((await fetch(url("test/hello.txt"))).status, 401, "no token, no bytes");
  assert.equal(
    (await fetch(url("test/hello.txt"), { headers: { authorization: "Bearer nope" } })).status,
    401,
    "a wrong token is refused",
  );
  assert.equal((await fetch(`${url("test/hello.txt")}?token=${TOKEN}`)).status, 401, "a token in the query string is not a thing");

  // ── the file itself ─────────────────────────────────────────────────────
  const ok = await fetch(url("test/hello.txt"), { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "hello from the phone");
  assert.match(ok.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(ok.headers.get("content-disposition") ?? "", /^attachment; filename="hello\.txt"/);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ok.headers.get("content-security-policy"), "sandbox", "an uploaded file cannot run script on the UI origin");

  const png = await fetch(url("test/pixel.png"), { headers: auth });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.match(png.headers.get("content-disposition") ?? "", /^inline;/, "pictures preview");

  const head = await fetch(url("test/hello.txt"), { method: "HEAD", headers: auth });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), String("hello from the phone".length));

  // ── confinement ─────────────────────────────────────────────────────────
  const traversal = await fetch(url("%2e%2e%2f%2e%2e%2fconfig.json5"), { headers: auth });
  assert.equal(traversal.status, 403, "no walking out of the media tree");
  const outside = await fetch(url("%2e%2e%2fconfig.json5"), { headers: auth });
  assert.equal(outside.status, 403);
  const symlinked = await fetch(url("test/sneaky.json5"), { headers: auth });
  assert.equal(symlinked.status, 404, "a symlink is not a way out either");

  // ── pruned files say so ─────────────────────────────────────────────────
  const gone = await fetch(url("test/nothing-here.pdf"), { headers: auth });
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /removed/);
});
