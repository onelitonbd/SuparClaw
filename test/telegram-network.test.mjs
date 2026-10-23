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

test("createBot wires the proxy as grammy\'s fetch via raw CONNECT+TLS sockets", () => {
  const src = readFileSync(new URL("../src/channels/telegram.ts", import.meta.url), "utf8");
  assert.match(src, /async function createBot\(token: string, proxy = ""\)/);
  assert.match(src, /createBot\(cfg\.token, telegramProxy\(/);
  // raw node-core proxied fetch, not undici (built-in fetch rejects foreign
  // dispatchers with UND_ERR_INVALID_ARG — dead route).
  assert.match(src, /makeProxiedFetch\(url\)/);
  assert.match(src, /\{ fetch: makeProxiedFetch\(url\) \}/);
  assert.doesNotMatch(src, /import\("undici"\)/);
  assert.doesNotMatch(src, /new ProxyAgent/);
});

test("config schema: channels.telegram.proxy is a settable string", () => {
  const src = readFileSync(new URL("../src/config/schema.ts", import.meta.url), "utf8");
  assert.match(src, /proxy: \{ t: "string", default: "" \}/);
  assert.match(src, /token: string;\n      proxy: string;/);
});

test("service: placeholder traps (copied-from-docs PORT/token examples) refuse politely; blocked-no-proxy verdict names options", () => {
  const src = readFileSync(new URL("../src/agent/service.ts", import.meta.url), "utf8");
  assert.match(src, /:\(PORT\|HOST\|EXAMPLE\)\\\/\?\$\/\.test/);
  assert.match(src, /PORT placeholder from the hint/);
  assert.match(src, /looks like a doc example, not your real @BotFather token/);
  assert.match(src, /detectWorkingProxy\(8000\)/);
  assert.match(src, /auto-detected one on this device/);
  assert.match(src, /no local proxy was detected on the usual ports/);
  assert.match(src, /triedAutoProxy = false/);
});

test("service: failures carry the cause chain + unreachable-vs-bad-token diagnosis", () => {
  const src = readFileSync(new URL("../src/agent/service.ts", import.meta.url), "utf8");
  assert.match(src, /this\.#telegramError = describeError\(err\)/);
  assert.match(src, /const probe = await probeTelegramApi\(2500\)/);
  assert.match(src, /unreachable from this device/);
  assert.ok(src.includes('Check the proxy ('), "proxy-configured failure points at the proxy's own port");
  // reachability is classified properly: reject-token vs broken-proxy vs blip
  assert.match(src, /answers plainly that it rejects this TOKEN/);
  assert.match(src, /proxyProbe\(px, 3000\)/);
  assert.ok(src.includes("your proxy is the broken link"));
  assert.match(src, /Transient carrier blip/);
  assert.match(src, /triedTransientRetry = false/);
  assert.match(src, /automatic retry connected/);
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
  assert.ok(err.length > 10);
  service.store.close();
}, { timeout: 60_000 });

test("ui + cli: proxy field and guidance are visible where the user looks", () => {
  const ui = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(ui, /id: "ch-proxy"/);
  assert.match(ui, /data-ch-key": "channels\.telegram\.proxy"/);
  assert.match(ui, /blocked by the carrier/);
  assert.match(ui, /TELEGRAM_PROXY/);
  const cli = readFileSync(new URL("../src/cli/channels.ts", import.meta.url), "utf8");
  assert.ok(cli.includes("sc config set channels.telegram.proxy http://127.0.0.1:8080"), "cli hint uses a concrete port + replacement note");
});
