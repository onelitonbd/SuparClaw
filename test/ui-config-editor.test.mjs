// P4 (Missing!#31 + #32) — Channels settings tab + schema-driven config editor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-uiconf-"));
const { resolveRedactedDeep, redactSecrets, emptyConfig, ConfigService, parseConfig } = await import("../dist/lib.js");

test("config.schema RPC advertised + routed; config.replace validates before writing", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"config\.schema",/);
  assert.match(src, /"config\.replace",/);
  assert.match(src, /case "config\.schema":/);
  assert.match(src, /send\(okFrame\(id, \{ schema: CONFIG_SCHEMA \}\)\)/);
  assert.match(src, /case "config\.replace":/);
  assert.match(src, /resolveRedactedDeep\(authored, service\.config\)/);
  assert.match(src, /parseConfig\(resolved\)/);
  assert.match(src, /errFrame\(id, "bad_config"/); // rejected BEFORE write
  assert.match(src, /service\.applyConfig\(\)/);
});

test("resolveRedactedDeep — sentinels keep stored values at any depth; authored values pass through", () => {
  const stored = {
    gateway: { auth: { token: "real-token-1234" }, port: 18790 },
    providers: { openrouter: { apiKey: "sk-old-secret", models: ["a", "b"] } },
  };
  const authored = {
    gateway: { auth: { token: "__redacted__:••••1234" }, port: 19000 },
    providers: { openrouter: { apiKey: "sk-new-secret", models: ["c"] } },
  };
  const out = resolveRedactedDeep(authored, stored);
  assert.equal(out.gateway.auth.token, "real-token-1234"); // sentinel preserved the stored secret
  assert.equal(out.gateway.port, 19000); // authored wins elsewhere
  assert.equal(out.providers.openrouter.apiKey, "sk-new-secret");
  assert.deepEqual(out.providers.openrouter.models, ["c"]);
  // redactSecrets masks what resolveRedactedDeep preserves (round trip stays masked on the wire)
  const masked = redactSecrets({ ...emptyConfig(), providers: stored.providers });
  assert.match(masked.providers.openrouter.apiKey, /^__redacted__:/);
});

test("ConfigService.replaceAll + setPath — channels.telegram.* round-trips through validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-uiconf-svc-"));
  process.env.SUPARCLAW_HOME = dir;
  const { createLogger } = await import("../dist/lib.js");
  const cfgPath = join(dir, "config.json5");
  writeFileSync(cfgPath, "{ channels: { telegram: { enabled: false } } }\n");
  const log = createLogger({ sink: () => {} });
  const svc = new ConfigService(log, cfgPath);

  // setPath: the exact paths the Channels tab saves
  const r1 = svc.setPath("channels.telegram.enabled", true);
  assert.equal(r1.ok, true);
  const r2 = svc.setPath("channels.telegram.typing.mode", "thinking");
  assert.equal(r2.ok, true);
  const r3 = svc.setPath("channels.telegram.allowFrom", ["12345678", "@owner"]);
  assert.equal(r3.ok, true);
  const r4 = svc.setPath("channels.telegram.botLoopProtection.windowSeconds", 90);
  assert.equal(r4.ok, true);

  // file holds authored values and re-parses
  const disk = readFileSync(cfgPath, "utf8");
  assert.match(disk, /thinking/);
  const { config, errors } = parseConfig(JSON.parse(JSON.stringify(svc.get ? svc.get("channels") : {})));
  assert.ok(Array.isArray(errors));
  assert.equal(svc.get("channels.telegram.typing.mode"), "thinking");
  assert.deepEqual(svc.get("channels.telegram.allowFrom"), ["12345678", "@owner"]);

  // replaceAll: whole-doc replace as the raw editor does
  const next = structuredClone(svc.current);
  next.gateway.port = 18791;
  const rep = svc.replaceAll(next);
  assert.equal(rep.ok, true);
  assert.equal(svc.get("gateway.port"), 18791);
  assert.match(readFileSync(cfgPath, "utf8"), /18791/);

  // invalid entire doc is rejected by parseConfig before replaceAll (RPC behavior)
  assert.ok(parseConfig({ gateway: { port: 70000 } }).errors.length > 0);
});

test("ui: Channels tab renders every telegram section incl. token sentinel + secrets hint", () => {
  const ui = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(ui, /"channels"/); // TabId
  assert.match(ui, /\{ id: "channels", label: "Channels", group: "Integrations" \}/);
  assert.match(ui, /#renderChannels\(config\.channels/);
  for (const path of [
    "channels.telegram.enabled",
    "channels.telegram.dmPolicy",
    "channels.telegram.allowFrom",
    "channels.telegram.groupPolicy",
    "channels.telegram.groupAllowFrom",
    "channels.telegram.mentionGated",
    "channels.telegram.allowBots",
    "channels.telegram.streaming",
    "channels.telegram.batchMs",
    "channels.telegram.typing.mode",
    "channels.telegram.typing.intervalSeconds",
    "channels.telegram.mediaMaxMb",
    "channels.telegram.vision",
    "channels.telegram.botLoopProtection.enabled",
    "channels.telegram.botLoopProtection.maxEventsPerWindow",
    "channels.telegram.botLoopProtection.windowSeconds",
    "channels.telegram.botLoopProtection.cooldownSeconds",
  ]) {
    assert.ok(ui.includes(`"${path}"`), `missing binding for ${path}`);
  }
  assert.match(ui, /channels\.telegram\.token/); // saved only when typed
  assert.match(ui, /sc secrets refs/); // points at env/SecretRef storage (P3 #30)
  assert.match(ui, /leave blank to keep current token/);
});

test("ui: All-settings tab — form from config.schema, raw JSON5 editor, redaction-aware save", () => {
  const ui = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(ui, /\{ id: "config", label: "All settings", group: "Advanced" \}/);
  assert.match(ui, /gateway\.request\("config\.schema"/);
  assert.match(ui, /gateway\.request\("config\.replace", \{ text: rawArea\.value \}\)/);
  assert.match(ui, /data-cfg-path/);
  assert.match(ui, /data-cfg-kind/);
  assert.match(ui, /data-cfg-redacted/); // redacted fields skip empty saves
  assert.match(ui, /Settings not applied/); // their rejection banner
  assert.match(ui, /id: `cfg-\$\{path\}`/); // per-leaf inputs bound by dotted path
  assert.match(ui, /JSON\.stringify\(cur/); // record/array leaves edit as JSON
  assert.match(ui, /cfg-filter/); // search filter across sections
  const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.cfg-banner/);
  assert.match(css, /\.cfg-group/);
});
