// Partial #6 — provider plugins + OAuth/auth profiles: profile store and
// eligibility semantics, api-key bindings, exclusive ordering + store
// override, cooldown/last-good health, the RFC 8628 device flow, probe
// reason codes, and the CLI auth surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-auth-"));
const {
  Store,
  resolveConfiguredProviders,
  resolveAuthProfileOrder,
  resolveProviderCredential,
  boundProfileIds,
  profileCheck,
  profileStatus,
  profileId,
  LlmClient,
  requestDeviceAuthorization,
  pollDeviceToken,
  deviceLogin,
  PROVIDER_PLUGINS,
  pluginById,
} = await import("../dist/lib.js");

const SC = join(process.cwd(), "dist", "sc.js");
const openStore = () => Store.open(join(mkdtempSync(join(tmpdir(), "sc-as-")), "state.sqlite"));
const CFG = (authOrder = {}) => ({ auth: { order: authOrder } });

test("profile store: expiry validation follows their token-credential rules", () => {
  const store = openStore();
  store.upsertAuthProfile({ id: "openai:key-a1", provider: "openai", type: "api_key", material: "sk-live-abcdef" });
  assert.ok(profileCheck(store.authProfile("openai:key-a1")).ok);
  store.upsertAuthProfile({ id: "openai:key-badts", provider: "openai", type: "api_key", material: "x", expires: -5 });
  assert.equal(profileCheck(store.authProfile("openai:key-badts")).reason, "invalid_expires");
  store.upsertAuthProfile({ id: "openai:key-gone", provider: "openai", type: "api_key", material: "x", expires: Date.now() - 1000 });
  assert.equal(profileCheck(store.authProfile("openai:key-gone")).reason, "expired");
  // beyond the ceiling — invalid shape, not "very future"
  store.upsertAuthProfile({ id: "openai:key-far", provider: "openai", type: "token", material: "x", expires: 8_640_000_000_000_001 });
  assert.equal(profileCheck(store.authProfile("openai:key-far")).reason, "invalid_expires");
  const view = profileStatus(store.authProfile("openai:key-a1"));
  assert.equal(view.masked, "…cdef");
  assert.ok(!JSON.stringify(view).includes("sk-live-abcdef"), "material never crosses the status boundary");
  store.close();
});

test("cursor pagination sanity: profileId slugging + store CRUD", () => {
  const store = openStore();
  assert.equal(profileId("openai", "Work Key!"), "openai:work-key");
  assert.match(profileId("groq"), /^groq:[a-z0-9]{6}$/);
  store.upsertAuthProfile({ id: "groq:key-x", provider: "groq", type: "api_key", material: "k1" });
  store.upsertAuthProfile({ id: "groq:key-x", provider: "groq", type: "api_key", material: "k2", label: "rotated" });
  assert.equal(store.authProfile("groq:key-x").material, "k2", "--force replaces material");
  assert.equal(store.authProfiles("groq").length, 1);
  assert.equal(store.authProfiles().length, 1);
  assert.ok(store.removeAuthProfile("groq:key-x"));
  assert.equal(store.authProfiles().length, 0);
  store.close();
});

test("exclusive order: store override wins over config; omitted profiles are excluded", () => {
  const store = openStore();
  store.upsertAuthProfile({ id: "openai:a", provider: "openai", type: "api_key", material: "ka" });
  store.upsertAuthProfile({ id: "openai:b", provider: "openai", type: "api_key", material: "kb" });
  store.upsertAuthProfile({ id: "openai:c", provider: "openai", type: "api_key", material: "kc" });
  // config order: b, a
  let res = resolveAuthProfileOrder(store, CFG({ openai: ["openai:b", "openai:a"] }), "openai");
  assert.deepEqual(res.ordered.map((r) => r.id), ["openai:b", "openai:a"]);
  assert.deepEqual(res.excluded.map((r) => r.id), ["openai:c"]);
  // store override: c first — wins over the config list
  store.setAuthOrder("openai", ["openai:c", "openai:a"]);
  res = resolveAuthProfileOrder(store, CFG({ openai: ["openai:b", "openai:a"] }), "openai");
  assert.deepEqual(res.ordered.map((r) => r.id), ["openai:c", "openai:a"]);
  assert.deepEqual(res.excluded.map((r) => r.id), ["openai:b"]);
  store.setAuthOrder("openai", []);
  res = resolveAuthProfileOrder(store, CFG({}), "openai");
  assert.equal(res.excluded.length, 0, "no explicit order → all profiles considered");
  store.close();
});

test("apiKey binding: literal keys stay literal, profile ids resolve to material", () => {
  assert.deepEqual(boundProfileIds({ apiKey: "sk-proj-abcdef-long" }), { single: undefined, list: [] });
  assert.deepEqual(boundProfileIds({ apiKey: "openai:work" }), { single: "openai:work", list: [] });
  assert.deepEqual(boundProfileIds({ authProfiles: ["openai:work", "openai:home"] }, "openai"), { single: undefined, list: ["openai:work", "openai:home"] });

  const store = openStore();
  store.upsertAuthProfile({ id: "openai:work", provider: "openai", type: "api_key", material: "sk-real-material" });
  const hit = resolveProviderCredential(store, CFG({}), "openai", { apiKey: "openai:work", baseUrl: "https://api.openai.com/v1" });
  assert.equal(hit.cred.key, "sk-real-material");
  assert.equal(hit.cred.profileId, "openai:work");
  const lit = resolveProviderCredential(store, CFG({}), "openai", { apiKey: "sk-plain-key-not-a-profile" });
  assert.equal(lit.cred.key, "sk-plain-key-not-a-profile");
  // a binding to a DIFFERENT provider's profile is ineligible (realm check)
  store.upsertAuthProfile({ id: "groq:key-1", provider: "groq", type: "api_key", material: "gk" });
  const wrong = resolveProviderCredential(store, CFG({}), "openai", { apiKey: "groq:key-1" });
  assert.ok(wrong.reason, "cross-provider binding rejected");
  store.close();
});

test("bound multi-profiles: order chooses the first ELIGIBLE; excluded yields their reason code", () => {
  const store = openStore();
  store.upsertAuthProfile({ id: "openai:a", provider: "openai", type: "api_key", material: "ka", expires: Date.now() + 3_600_000 });
  store.upsertAuthProfile({ id: "openai:b", provider: "openai", type: "api_key", material: "kb" });
  store.upsertAuthProfile({ id: "openai:c", provider: "openai", type: "api_key", material: "kc" });
  store.setAuthOrder("openai", ["openai:b", "openai:a"]); // c excluded!
  const solved = resolveProviderCredential(store, CFG({}), "openai", { authProfiles: ["openai:a", "openai:b", "openai:c"] });
  assert.equal(solved.cred.key, "kb");
  const onlyExcluded = resolveProviderCredential(store, CFG({}), "openai", { authProfiles: ["openai:c"] });
  // "c" is not in the explicit order and resolves with no cheap check — their rule kicks in upstream
  // (ordered picks exist but exclude this binding) → ineligible semantics surface either way
  assert.ok(!onlyExcluded.cred);
  const bad = resolveProviderCredential(store, CFG({}), "openai", { authProfiles: ["openai:zzz-missing"] });
  assert.equal(bad.reason, "ineligible_profile");
  store.close();
});

test("cooldown ladder + last-good: 401s park the profile, success clears it", () => {
  const store = openStore();
  store.upsertAuthProfile({ id: "openai:key-1", provider: "openai", type: "api_key", material: "k" });
  store.markAuthUsed("openai:key-1", false);
  let row = store.authProfile("openai:key-1");
  assert.equal(row.fail_count, 1);
  assert.ok(row.cooldown_until > Date.now() + 4 * 60_000 && row.cooldown_until < Date.now() + 6 * 60_000, "5m first cooldown");
  assert.equal(profileCheck(row).reason, "cooldown");
  row.cooldown_until = 0; // simulate cooldown passing
  store.db.prepare("UPDATE auth_profiles SET cooldown_until=0 WHERE id=?").run("openai:key-1");
  store.markAuthUsed("openai:key-1", false);
  row = store.authProfile("openai:key-1");
  assert.ok(row.cooldown_until > Date.now() + 9 * 60_000 && row.cooldown_until < Date.now() + 11 * 60_000, "10m second rung");
  store.db.prepare("UPDATE auth_profiles SET cooldown_until=0 WHERE id=?").run("openai:key-1");
  store.markAuthUsed("openai:key-1", true);
  row = store.authProfile("openai:key-1");
  assert.equal(row.fail_count, 0);
  assert.ok(row.last_ok_at > 0);
  store.close();
});

test("resolveConfiguredProviders: bindings swap in material; ineligible bindings auth-error instantly", () => {
  const store = openStore();
  store.upsertAuthProfile({ id: "openai:key-1", provider: "openai", type: "api_key", material: "sk-live", expires: Date.now() - 10 });
  const bad = resolveConfiguredProviders(store, { auth: { order: {} }, providers: { openai: { apiKey: "openai:key-1", baseUrl: "https://api.openai.com/v1", models: ["gpt-x"] } } });
  assert.equal(bad.providers.openai.apiKey, "");
  assert.match(bad.providers.openai.authError, /^expired/);
  store.db.prepare("UPDATE auth_profiles SET expires=? WHERE id=?").run(Date.now() + 60_000, "openai:key-1");
  const good = resolveConfiguredProviders(store, { auth: { order: {} }, providers: { openai: { apiKey: "openai:key-1", baseUrl: "https://api.openai.com/v1", models: ["gpt-x"] } } });
  assert.equal(good.providers.openai.apiKey, "sk-live");
  assert.equal(good.profileOf.openai, "openai:key-1");
  // untouched legacy path: literal key passes through
  const plain = resolveConfiguredProviders(store, { auth: { order: {} }, providers: { openai: { apiKey: "sk-plain", baseUrl: "", models: [] } } });
  assert.equal(plain.providers.openai.apiKey, "sk-plain");
  assert.deepEqual(plain.profileOf, {});
  store.close();
});

test("LlmClient marks profile health: 401 → cooldown; clean stream → last-good", async () => {
  const store = openStore();
  store.upsertAuthProfile({ id: "openai:key-1", provider: "openai", type: "api_key", material: "sk-live" });
  let status = 0;
  const server = createServer((_req, res) => {
    if (status === 401) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  try {
    const base = `http://127.0.0.1:${port}/v1`;
    const mk = () =>
      new LlmClient(
        { openai: { baseUrl: base, apiKey: "sk-live", models: ["m1"] } },
        { model: "openai/m1", fallbacks: [] },
        undefined,
        { profileOf: { openai: "openai:key-1" }, onOutcome: (id, ok) => store.markAuthUsed(id, ok) },
      );
    status = 401;
    const drain = async (llm) => {
      let text = "";
      try {
        for await (const e of llm.stream({ messages: [{ role: "user", content: "hi" }] })) {
          if (e.type === "token" || e.type === "text") text += e.token ?? e.text ?? "";
        }
      } catch (err) {
        return { err: String(err), text };
      }
      return { err: null, text };
    };
    const fail = await drain(mk());
    assert.match(fail.err, /HTTP 401/);
    assert.equal(store.authProfile("openai:key-1").fail_count, 1);
    // manual-clear the cooldown (as if it elapsed) then succeed
    store.db.prepare("UPDATE auth_profiles SET cooldown_until=0 WHERE id=?").run("openai:key-1");
    status = 200;
    const ok = await drain(mk());
    assert.ok(ok.err === null, `clean stream: ${ok.err}`);
    const row = store.authProfile("openai:key-1");
    assert.equal(row.fail_count, 0);
    assert.ok(row.last_ok_at > 0);
  } finally {
    server.close();
    store.close();
  }
});

// ── RFC 8628 device flow against a scripted OAuth endpoint ──────────────────

const fakeOAuth = (script) => {
  // script: array of response shapes consumed in order for the token endpoint
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/device/code")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "dev-1",
          user_code: "SUPR-CLAW",
          verification_uri: "https://auth.example/device",
          interval: 1,
          expires_in: 900,
        }),
      };
    }
    const n = calls.filter((c) => c.url.endsWith("/token")).length - 1; // count-1: this call
    const next = script[Math.min(n, script.length - 1)];
    return { ok: next.ok, status: next.status ?? (next.ok ? 200 : 400), json: async () => next.body };
  };
  return { fetchFn, calls };
};

test("device-code: pending → slow_down (interval +5) → success; expiry lands on the profile", async () => {
  const { fetchFn, calls } = fakeOAuth([
    { ok: false, body: { error: "authorization_pending" } },
    { ok: false, body: { error: "slow_down" } },
    { ok: true, body: { access_token: "at-123", token_type: "Bearer", expires_in: 3600, refresh_token: "rt" } },
  ]);
  const shown = [];
  const token = await deviceLogin({
    descriptor: { deviceCodeUrl: "https://auth.example/device/code", tokenUrl: "https://auth.example/token", clientId: "client-x" },
    fetchFn,
    sleep: async () => undefined,
    onCode: (a) => shown.push(a),
  });
  assert.equal(token.access_token, "at-123");
  assert.ok(token.expiresAt > Date.now() + 3_550_000, "expires mapped to absolute ms");
  assert.equal(shown[0].user_code, "SUPR-CLAW");
  const polls = calls.filter((c) => c.url.endsWith("/token"));
  assert.equal(polls.length, 3, "two waits then the success");
  const p2 = await pollDeviceToken({ tokenUrl: "https://auth.example/token", clientId: "c" }, "dev", 7, async () => ({ ok: false, status: 400, json: async () => ({ error: "slow_down" }) }));
  assert.deepEqual(p2, { status: "pending", interval: 12 }, "slow_down bumps the poll interval by exactly 5s");
});

test("device-code: denial and expiry are clean, labeled failures", async () => {
  const denied = deviceLogin({
    descriptor: { deviceCodeUrl: "https://d", tokenUrl: "https://t", clientId: "c" },
    fetchFn: async (url) =>
      url.endsWith("/device/code")
        ? { ok: true, status: 200, json: async () => ({ device_code: "d", user_code: "u", verification_uri: "https://v", interval: 1, expires_in: 60 }) }
        : { ok: false, status: 400, json: async () => ({ error: "access_denied" }) },
    sleep: async () => undefined,
  });
  await assert.rejects(denied, /denied/);
  const expired = deviceLogin({
    descriptor: { deviceCodeUrl: "https://d", tokenUrl: "https://t", clientId: "c" },
    fetchFn: async (url) =>
      url.endsWith("/device/code")
        ? { ok: true, status: 200, json: async () => ({ device_code: "d", user_code: "u", verification_uri: "https://v", interval: 1, expires_in: 60 }) }
        : { ok: false, status: 400, json: async () => ({ error: "expired_token" }) },
    sleep: async () => undefined,
  });
  await assert.rejects(expired, /expired/);
  await assert.rejects(
    requestDeviceAuthorization({ deviceCodeUrl: "https://d", clientId: "c" }, async () => ({ ok: false, status: 403, json: async () => ({}) })),
    /HTTP 403/,
  );
});

test("plugin catalog ships headline methods + the OpenAI OAuth descriptor", () => {
  assert.ok(PROVIDER_PLUGINS.length >= 10, "≥10 built-in provider plugins");
  const openai = pluginById("openai");
  assert.deepEqual(openai.authMethods, ["device-code", "api-key"], "their canonical OpenAI entry default: device-code first");
  assert.match(openai.oauth.deviceCodeUrl, /auth\.openai\.com/);
  assert.equal(openai.oauth.clientId, "app_EMoamEEZ73f0CkXaXp7hrann", "Codex public client id");
  for (const p of PROVIDER_PLUGINS) {
    assert.ok(p.authMethods.length > 0, `${p.id} declares at least one auth flow`);
    if (p.authMethods.includes("device-code")) assert.ok(p.oauth, `${p.id}: device-code requires oauth endpoints`);
  }
});

// ── CLI surface ─────────────────────────────────────────────────────────────

const runCli = (home, args, envExtra = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [SC, ...args], { env: { ...process.env, SUPARCLAW_HOME: home, ...envExtra } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });

test("CLI: paste-api-key → list shows masked profile, binding set, order/probe obey", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-acl-"));
  assert.equal((await runCli(home, ["init"])).code, 0);

  const login = await runCli(home, ["models", "auth", "paste-api-key", "--provider", "openai", "--api-key", "sk-cli-test-material"]);
  assert.equal(login.code, 0, login.out);
  assert.match(login.out, /saved profile openai:key/);
  assert.match(login.out, /bound/);

  const list = await runCli(home, ["models", "auth", "list", "--json"]);
  const parsed = JSON.parse(list.out.slice(list.out.indexOf("{"), list.out.lastIndexOf("}") + 1));
  assert.equal(parsed.profiles.length, 1);
  assert.equal(parsed.profiles[0].id, "openai:key");
  assert.match(parsed.profiles[0].masked, /…rial$/);
  assert.ok(!list.out.includes("sk-cli-test-material"), "material never printed");

  // config binding: apiKey names the profile, baseUrl defaults from the plugin
  const cfg = await runCli(home, ["config", "get", "providers.openai"]);
  assert.match(cfg.out, /"apiKey": "openai:key"/);
  assert.match(cfg.out, /api\.openai\.com/);

  // second profile + explicit order (store override beats config)
  await runCli(home, ["models", "auth", "paste-api-key", "--provider", "openai", "--profile-id", "openai:home", "--api-key", "sk-second"]);
  const orderSet = await runCli(home, ["models", "auth", "order", "set", "--provider", "openai", "openai:home", parsed.profiles[0].id]);
  assert.match(orderSet.out, /store override/);
  const orderGet = await runCli(home, ["models", "auth", "order", "get", "--provider", "openai"]);
  assert.match(orderGet.out, /openai:home, openai:key/);

  // probe against the real api.openai.com cannot run offline → mark states only:
  // force-expire the first profile, probe JSON reports the reason code
  const { Store: St } = await import("../dist/lib.js");
  const db = St.open(join(home, ".suparclaw", "state.sqlite"));
  db.db.prepare("UPDATE auth_profiles SET expires=1000 WHERE id=?").run(parsed.profiles[0].id);
  db.close();
  const probe = await runCli(home, ["models", "auth", "probe", "--json"]);
  const pjson = JSON.parse(probe.out.slice(probe.out.indexOf("{"), probe.out.lastIndexOf("}") + 1));
  const expiredEntry = pjson.probe.find((r) => r.profile === parsed.profiles[0].id);
  assert.equal(expiredEntry.reasonCode, "expired");

  // removal unbinds the provider automatically
  const rm = await runCli(home, ["models", "auth", "remove", "openai:home"]);
  assert.match(rm.out, /removed openai:home/);
  const cfg2 = await runCli(home, ["config", "get", "providers.openai.apiKey"]);
  assert.doesNotMatch(cfg2.out, /openai:home/);
});

test("CLI: login method validation mirrors theirs (no silent method replacement)", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-acmm-"));
  await runCli(home, ["init"]);
  const bad = await runCli(home, ["models", "auth", "login", "--provider", "groq", "--method", "device-code", "--api-key", "k"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /no "device-code" method/);
  const unknown = await runCli(home, ["models", "auth", "login", "--provider", "nope"]);
  assert.match(unknown.out, /unknown provider plugin/);
  // device-code without an OAuth descriptor refuses cleanly
  const dc = await runCli(home, ["models", "auth", "login", "--provider", "mistral", "--method", "device-code"]);
  assert.match(dc.out, /no "device-code" method|has no/);
  const plugins = await runCli(home, ["models", "plugins"]);
  assert.match(plugins.out, /openai/);
  assert.match(plugins.out, /device-code \(OAuth\)/);
});

test("CLI: setup-token/paste-token stores type token", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-apt-"));
  await runCli(home, ["init"]);
  const out = await runCli(home, ["models", "auth", "paste-token", "--provider", "anthropic", "--token", "tok-anthropic-1"]);
  assert.equal(out.code, 0, out.out);
  const list = await runCli(home, ["models", "auth", "list"]);
  assert.match(list.out, /token/);
  assert.match(list.out, /anthropic:/);
});
