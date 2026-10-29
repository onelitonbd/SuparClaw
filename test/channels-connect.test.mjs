// Telegram setup path — status + one-tap connect (their "no way to connect"
// gap): channels.status / channels.telegram.connect RPCs, Channels tab card,
// sc channels CLI, and the single-owner hot-apply of channel config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("service: telegram lifecycle is single-owner + reports real state", async () => {
  const src = readFileSync(new URL("../src/agent/service.ts", import.meta.url), "utf8");
  // single owner: watchConfig no longer touches the channel itself
  const watch = src.match(/watchConfig\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(!watch.includes("#startTelegram"), "watchConfig must not own telegram");
  assert.match(src, /#reconcileTelegram\(config\)/);
  assert.ok(src.includes("this.#telegram?.running"));
  // start primes the applied key so the first config.set doesn't bounce
  assert.match(src, /#appliedTgKey = `\$\{tg\.enabled \? "1" : "0"\}\|\$\{tg\.token \?\? ""\}`/);
  // status carries the real error so a wrong token is visible, not silent
  assert.match(src, /channelsStatus\(\)/);
  assert.match(src, /error: tg\.enabled && !running \? this\.#telegramError/);
  // reconnect guards produce actionable messages
  assert.match(src, /telegram\.enabled is off/);
  assert.match(src, /paste a @BotFather token first/);
  assert.ok(src.includes("await this.#telegram?.stop()"));
});

test("telegramReconnect: disabled and empty-token guards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-channels-"));
  process.env.SUPARCLAW_HOME = dir;
  mkdirSync(join(dir, ".suparclaw", "workspace"), { recursive: true });
  const { Service } = await import("../dist/lib.js");
  const service = new Service();
  // disabled → actionable refusal, no start attempt
  let res = await service.telegramReconnect();
  assert.equal(res.ok, false);
  assert.match(String(res.error), /enabled is off/);
  // enabled but no token → tells the user exactly what is missing
  service.configSvc.setPath("channels.telegram.token", "");
  service.configSvc.setPath("channels.telegram.enabled", true);
  res = await service.telegramReconnect();
  assert.equal(res.ok, false);
  assert.match(String(res.error), /token is empty/);
  // status mirrors saved config (still offline — never started)
  const status = service.channelsStatus();
  assert.equal(status.telegram.enabled, true);
  assert.equal(status.telegram.running, false);
  service.store.close();
});

test("gateway RPCs: channels.status + channels.telegram.connect advertised and handled", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.ok(src.includes(`"channels.status"`), "advertised");
  assert.ok(src.includes(`case "channels.status"`), "handler");
  assert.match(src, /send\(okFrame\(id, service\.channelsStatus\(\)\)\)/);
  assert.ok(src.includes(`"channels.telegram.connect"`), "advertised");
  assert.ok(src.includes(`case "channels.telegram.connect"`), "handler");
  assert.match(src, /await service\.telegramReconnect\(\)/);
});

test("cli: sc channels status|connect wired with actionable text", () => {
  const idx = readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
  assert.match(idx, /case "channels":/);
  const src = readFileSync(new URL("../src/cli/channels.ts", import.meta.url), "utf8");
  assert.match(src, /client\.request\("channels\.status"\)/);
  assert.match(src, /client\.request\("channels\.telegram\.connect"\)/);
  assert.match(src, /gateway offline/);
  assert.match(src, /retry now: sc channels connect/);
  assert.match(src, /sc config set channels\.telegram\.token/);
  assert.match(src, /telegram connected as @/);
  assert.match(src, /process\.exit\(1\)|exit\(t\.enabled && !t\.running \? 1 : 0\)/);
});

test("ui: Channels tab shows live status + Connect now + reconnect after save", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /id: "tg-status"/);
  assert.match(src, /gateway\.request\("channels\.status"\)/);
  assert.match(src, /Connected\$\{st\.username/, 'status shows the bot handle');
  assert.match(src, /Offline\$\{st\.error/, 'offline shows the real reason');
  assert.match(src, /id: "tg-connect"/);
  assert.match(src, /gateway\.request\("channels\.telegram\.connect"\)/);
  // Save → the reconcile auto-reconnects when the channel is enabled
  assert.match(src, /telegram reconnects now/);
  assert.match(src, /connectBtn\.click\(\)/);
});

// The Channels form writes its block in ONE config.set, so the block has to be
// validated as a unit: a single out-of-range field must leave the stored
// channel untouched rather than landing a half-saved state.
test("a channels.telegram block is accepted or rejected whole", async () => {
  const { ConfigService, createLogger, resolveRedacted, redactSecrets } = await import("../dist/lib.js");
  const dir = mkdtempSync(join(tmpdir(), "sc-channels-atomic-"));
  const cfg = new ConfigService(createLogger({ level: "error" }), join(dir, "config.json5"));

  const good = {
    enabled: true,
    token: "123456:ABCdef",
    dmPolicy: "pairing",
    batchMs: 300,
    typing: { mode: "instant", intervalSeconds: 6 },
  };
  const first = cfg.setPath("channels.telegram", good);
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = JSON.stringify(cfg.current.channels.telegram);

  const bad = {
    ...good,
    mediaMaxMb: 500, // schema max is 100
    typing: { mode: "instant", intervalSeconds: 0 }, // schema min is 1
  };
  const rejected = cfg.setPath("channels.telegram", bad);
  assert.equal(rejected.ok, false, "the block is rejected");
  assert.match(rejected.errors.join(" "), /intervalSeconds|mediaMaxMb/);
  assert.equal(JSON.stringify(cfg.current.channels.telegram), before, "nothing from the rejected block landed");

  // The one-frame save posts the *redacted* block back (token = sentinel).
  // config.set resolves sentinels against the stored value at the same path,
  // recursively — a whole-object write must not store the mask as the token.
  const sentinelBlock = redactSecrets(cfg.current).channels.telegram;
  assert.match(sentinelBlock.token, /redacted/i);
  const resolved = resolveRedacted(cfg.current.channels.telegram, sentinelBlock);
  assert.equal(resolved.token, "123456:ABCdef", "the sentinel resolves to the stored secret");
  assert.equal(cfg.setPath("channels.telegram", resolved).ok, true);
  assert.equal(cfg.current.channels.telegram.token, "123456:ABCdef");
  assert.equal(cfg.current.channels.telegram.typing.intervalSeconds, 6, "the rest of the block survives the round-trip");
});
