// The user's one-command smoke test: sc channels send "it works" — resolves
// the recipient (explicit id/@handle → first allowFrom → friendly guidance),
// delivers through the live channel (proxy included), and reports the failure
// cause either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resolveTelegramRecipient: explicit wins, then allowFrom, then null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-tgsend-"));
  process.env.SUPARCLAW_HOME = dir;
  mkdirSync(join(dir, ".suparclaw", "workspace"), { recursive: true });
  const { Service } = await import("../dist/lib.js");
  const service = new Service();

  // explicit numeric id / @handle / name
  assert.equal(service.resolveTelegramRecipient("123456789"), 123456789);
  assert.equal(service.resolveTelegramRecipient("-1002481245"), -1002481245);
  assert.equal(service.resolveTelegramRecipient("@nahid_tg"), "@nahid_tg");
  assert.equal(service.resolveTelegramRecipient("nahid_tg"), "nahid_tg");

  // no allowFrom → null (guidance printed)
  assert.equal(service.resolveTelegramRecipient(undefined), null);

  // allowFrom carries the user — first entry is the implicit "me"
  service.configSvc.setPath("channels.telegram.allowFrom", ["999888777", "abc"]);
  assert.equal(service.resolveTelegramRecipient(undefined), 999888777);
  service.configSvc.setPath("channels.telegram.allowFrom", ["nahid_tg"]);
  assert.equal(service.resolveTelegramRecipient(undefined), "@nahid_tg");
  service.store.close();
}, { timeout: 60_000 });

test("telegramSend: guard rails fire before any send attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-tgsend2-"));
  process.env.SUPARCLAW_HOME = dir;
  mkdirSync(join(dir, ".suparclaw", "workspace"), { recursive: true });
  const { Service } = await import("../dist/lib.js");
  const service = new Service();
  // channel disabled
  let res = await service.telegramSend(undefined, "x");
  assert.equal(res.ok, false);
  assert.match(String(res.error), /enabled is off/);
  // enabled but offline
  service.configSvc.setPath("channels.telegram.enabled", true);
  service.configSvc.setPath("channels.telegram.token", "123:test");
  res = await service.telegramSend(undefined, "x");
  assert.equal(res.ok, false);
  assert.match(String(res.error), /telegram is offline|no recipient/);
  service.store.close();
}, { timeout: 60_000 });

test("gateway RPC + CLI wiring", () => {
  const apidoc = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.ok(apidoc.includes(`"channels.telegram.send"`));
  assert.match(apidoc, /case "channels\.telegram\.send"/);
  assert.match(apidoc, /await service\.telegramSend\(/);

  const cli = readFileSync(new URL("../src/cli/channels.ts", import.meta.url), "utf8");
  assert.match(cli, /sub === "send"/);
  assert.match(cli, /startsWith\("@"\)/);          // @handle target detection
  assert.ok(cli.includes('^-?\\d+$'), "numeric id/negative gid target detection");
  assert.match(cli, /channels\.telegram\.send/);
  assert.match(cli, /delivered to/);
  assert.match(cli, /gateway offline/);

  const svc = readFileSync(new URL("../src/agent/service.ts", import.meta.url), "utf8");
  assert.match(svc, /resolveTelegramRecipient/);
  assert.match(svc, /messaged them first: open the bot and press START/);
  assert.match(svc, /telegram is offline/);
});
