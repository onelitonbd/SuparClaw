import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const SC = join(process.cwd(), "dist", "sc.js"); const TOKEN = "workspace-http-test-token";
const TMP = (() => { for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) { try { mkdirSync(base, { recursive: true }); return base; } catch {} } return process.cwd(); })();
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const run = (args, env) => new Promise((resolve) => { const p = spawn(process.execPath, [SC, ...args], { env: { ...process.env, ...env } }); let output = ""; p.stdout.on("data", (c) => output += c); p.stderr.on("data", (c) => output += c); p.on("close", (code) => resolve({ code, output })); });
test("workspace HTTP route authenticates and confines session-scoped file access", async (t) => {
  const port = await freePort(); const home = mkdtempSync(join(TMP, "sc-workspace-http-")); const env = { SUPARCLAW_HOME: home };
  assert.equal((await run(["init"], env)).code, 0);
  for (const [key, value] of [["gateway.port", String(port)], ["gateway.auth.mode", "token"], ["gateway.auth.token", TOKEN], ["gateway.auth.loopbackBypass", "false"]]) {
    const result = await run(["config", "set", key, value], env); assert.equal(result.code, 0, result.output);
  }
  const workspace = join(home, ".suparclaw", "workspace"); mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "hello from the active session workspace"); writeFileSync(join(workspace, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); writeFileSync(join(workspace, ".git", "config"), "hidden");
  const gw = spawn(process.execPath, [SC, "gateway"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); t.after(() => gw.kill("SIGKILL"));
  let up = false; for (let i = 0; i < 240 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); try { await fetch(`http://127.0.0.1:${port}/health`); up = true; } catch {} }
  assert.ok(up, "gateway came up");
  const url = (path, sessionKey = "main:main") => `http://127.0.0.1:${port}/workspace-file?${new URLSearchParams({ sessionKey, path })}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(url("README.md")).then((r) => r.status)), 401);
  const text = await fetch(url("README.md"), { headers: auth }); assert.equal(text.status, 200); assert.equal(await text.text(), "hello from the active session workspace");
  assert.match(text.headers.get("content-disposition"), /^attachment;/); assert.equal(text.headers.get("x-content-type-options"), "nosniff"); assert.equal(text.headers.get("content-security-policy"), "sandbox");
  const image = await fetch(url("pixel.png"), { headers: auth }); assert.equal(image.headers.get("content-type"), "image/png"); assert.match(image.headers.get("content-disposition"), /^inline;/);
  assert.equal((await fetch(url("../../.suparclaw/config.json5"), { headers: auth })).status, 403);
  assert.equal((await fetch(url(".git/config"), { headers: auth })).status, 403);
  assert.equal((await fetch(url("README.md", "unknown:session"), { headers: auth })).status, 404);
});
