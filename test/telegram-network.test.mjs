// Telegram connect-path hardening for blocked regions: root-cause diagnostics
// (cause chain + api.telegram.org reachability probe) and the per-channel
// proxy (channels.telegram.proxy + env), instead of grammy's bare
// "Network request failed".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("telegramProxy: config beats env; env is honored when config is empty", async () => {
  const { telegramProxy } = await import("../dist/lib.js");
  const saved = process.env["TELEGRAM_PROXY"];
  delete process.env["TELEGRAM_PROXY"];
  try {
    assert.equal(telegramProxy(""), "");
    assert.equal(telegramProxy("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    process.env["TELEGRAM_PROXY"] = "http://127.0.0.1:9999";
    assert.equal(telegramProxy(""), "http://127.0.0.1:9999");
    assert.equal(telegramProxy("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  } finally {
    if (saved === undefined) delete process.env["TELEGRAM_PROXY"]; else process.env["TELEGRAM_PROXY"] = saved;
  }
});

test("describeError: unfolds grammy's wrapper into the real cause chain", async () => {
  const { describeError } = await import("../dist/lib.js");
  const inner = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), {});
  const outer = Object.assign(new Error("Network request for 'getMe' failed!"), { cause: inner });
  const s = describeError(outer);
  assert.ok(s.includes("Network request for 'getMe' failed!"));
  assert.ok(s.includes("ENOTFOUND api.telegram.org"));
  assert.ok(s.includes("|"));
});

test("probeTelegramApi: reports shape + cause, never throws", async () => {
  const { probeTelegramApi } = await import("../dist/lib.js");
  const r = await probeTelegramApi(1500);
  assert.equal(typeof r.ok, "boolean");
  assert.equal(typeof r.why, "string");
  assert.ok(r.why.length > 0);
});

test("createBot wires the proxy into the Bot's fetch dispatcher", () => {
  const src = readFileSync(new URL("../src/channels/telegram.ts", import.meta.url), "utf8");
  assert.match(src, /async function createBot\(token: string, proxy = ""\)/);
  assert.match(src, /createBot\(cfg\.token, telegramProxy\(/);
  // The proxy URL is validated up front so a placeholder says what's wrong.
  assert.match(src, /is not a valid proxy URL/);
  // undici must be read through the bundle-shape fallback (named OR default
  // export), and grammy must fetch with undici — node-fetch ignores dispatcher.
  assert.match(src, /mod\.ProxyAgent \?\? mod\.default\?\.ProxyAgent/);
  assert.match(src, /mod\.fetch \?\? mod\.default\?\.fetch/);
  assert.match(src, /new Dispatcher\(/);
  assert.match(src, /baseFetchConfig: \{ dispatcher/);
});

test("describeError: grammy's HttpError reason lives in .error, not .cause", async () => {
  const { describeError } = await import("../dist/lib.js");
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {});
  const wrapped = Object.assign(new Error("Network request for 'getMe' failed!"), { error: inner });
  const s = describeError(wrapped);
  assert.ok(s.includes("Network request for 'getMe' failed!"));
  assert.ok(s.includes("ECONNREFUSED"), `the .error reason must survive: ${s}`);
});

test("config schema: channels.telegram.proxy is a settable string", () => {
  const src = readFileSync(new URL("../src/config/schema.ts", import.meta.url), "utf8");
  assert.match(src, /proxy: \{ t: "string", default: "" \}/);
  assert.match(src, /token: string;\n      proxy: string;/);
});

test("service: failures carry the cause chain + unreachable-vs-bad-token diagnosis", () => {
  const src = readFileSync(new URL("../src/agent/service.ts", import.meta.url), "utf8");
  assert.match(src, /this\.#telegramError = describeError\(err\)/);
  assert.match(src, /const probe = await probeTelegramApi\(6000, via\)/);
  assert.match(src, /unreachable from this device/);
  assert.match(src, /Set channels\.telegram\.proxy/);
  // a dead proxy must not be blamed on the carrier or the token
  assert.match(src, /did not carry api\.telegram\.org/);
  assert.match(src, /so the credential itself is the problem/);
});

test("full path: connect with a proxy set fails with a real network error, never a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-proxy-"));
  process.env.SUPARCLAW_HOME = dir;
  mkdirSync(join(dir, ".suparclaw", "workspace"), { recursive: true });
  const { Service } = await import("../dist/lib.js");
  const service = new Service();
  service.configSvc.setPath("channels.telegram.token", "123456:not-a-real-token-AAAAAAAAAAA");
  service.configSvc.setPath("channels.telegram.proxy", "http://127.0.0.1:1"); // nothing listens there
  service.configSvc.setPath("channels.telegram.enabled", true);
  const res = await service.telegramReconnect();
  assert.equal(res.ok, false);
  const err = String(res.error);
  assert.ok(!/Bot export unavailable/.test(err), "bot constructed fine through the proxy wiring");
  // The regression this guards: in the bundled build `new ProxyAgent(...)` was
  // a minified `<mangled> is not a constructor` TypeError because the undici
  // chunk only exposes a default export. A real proxy attempt must instead
  // produce an honest network error (ECONNREFUSED / fetch failure).
  assert.ok(!/constructor/.test(err), `proxy path must not crash with a constructor error: ${err}`);
  assert.ok(!/^undefined|^null/.test(err), "error must be a described message");
  assert.ok(err.length > 10);
  service.store.close();
}, { timeout: 60_000 });

test("full path: an invalid proxy URL fails with a clear message, never a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-proxy-bad-"));
  process.env.SUPARCLAW_HOME = dir;
  mkdirSync(join(dir, ".suparclaw", "workspace"), { recursive: true });
  const { Service } = await import("../dist/lib.js");
  const service = new Service();
  service.configSvc.setPath("channels.telegram.token", "123456:not-a-real-token-AAAAAAAAAAA");
  // The literal "PORT" placeholder a user can copy out of help text.
  service.configSvc.setPath("channels.telegram.proxy", "http://127.0.0.1:PORT");
  service.configSvc.setPath("channels.telegram.enabled", true);
  const res = await service.telegramReconnect();
  assert.equal(res.ok, false);
  const err = String(res.error);
  assert.ok(!/constructor/.test(err), `invalid proxy must not crash: ${err}`);
  assert.match(err, /not a valid proxy URL/);
  assert.match(err, /127\.0\.0\.1:PORT/);
  service.store.close();
}, { timeout: 60_000 });

test("ui + cli: proxy field and guidance are visible where the user looks", () => {
  const ui = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(ui, /id: "ch-proxy"/);
  assert.match(ui, /data-ch-key": "channels\.telegram\.proxy"/);
  assert.match(ui, /blocked by the carrier/);
  assert.match(ui, /TELEGRAM_PROXY/);
  const cli = readFileSync(new URL("../src/cli/channels.ts", import.meta.url), "utf8");
  // Concrete port, never a literal "PORT" placeholder the user can paste into
  // config verbatim and get a broken proxy URL.
  assert.match(cli, /sc config set channels\.telegram\.proxy http:\/\/127\.0\.0\.1:\d{2,5}/);
  assert.ok(!/127\.0\.0\.1:PORT\b/.test(cli), "no copy-pasteable PORT placeholder in help text");
});
