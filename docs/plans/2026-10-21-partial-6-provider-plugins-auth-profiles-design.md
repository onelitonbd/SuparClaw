# Partial #6 — Provider configuration: provider plugins + OAuth/auth profiles

Gap (sheet): *OpenClaw has "provider plugins + OAuth/auth profiles"; SuparClaw has "base URL + key, live model fetch".*
Target: their auth architecture recreated at our scale — zero new runtime deps, single agent, phone-first.

## Their system (vendored + live research)

- **Provider plugins** declare credential flows (`models auth login --provider <id>` is one entry point for every plugin, including builtin `openai-codex`), model catalog discovery, and per-provider auth methods (`api-key | token | device-code | oauth`).
- **Auth profile store**: SQLite `auth_profile_store` + `auth_profile_state`: per-profile material, `expires` (validated), cooldown/failure counters, last-good, per-provider explicit order (`auth.order.<provider>`, store override > config).
- **Profile binding**: a provider's `apiKey` value that names an existing *compatible* profile (provider + base-url realm) is a binding, resolved at request time — literal keys keep working.
- **Reason codes** (stable): `missing_credential`, `expired`, `invalid_expires`, `excluded_by_auth_order`, `ineligible_profile`, `unresolved_ref`, `no_model`.
- **OAuth**: PKCE browser + RFC 8628 device code (canonical: `openclaw models auth login --provider openai --device-code`); token-sink semantics; `paste-api-key`/`paste-token` headless paths; `models账号/accounts` (personal) — out for us.
- **UI**: Settings → Models → *Connect provider* without making a model reply.

## What ships

### 1. `auth_profiles` table (store)
`id` TEXT PK (`provider:slug`), `provider`, `type` ∈ {api_key, token, oauth}, `material` (never leaves the store in responses — masked tail only), `expires` INTEGER ms (validation per their rules → `invalid_expires`/`expired`), `label`, `created/last_used/last_ok`, `fail_count`, `cooldown_until`. Plus `auth_profile_order` store override (wins over config order, like theirs).

### 2. Provider plugins — declarative descriptors (`src/agent/provider-plugins.ts`)
`{id, label, baseUrl, env, authMethods: ['api-key'] | ['api-key','device-code'] | ['token'] , oauth?: {deviceCodeUrl, tokenUrl, clientId, scope}, docsUrl, modelsHeader?, recommended}`. Built-ins: **openai** (api-key + **device-code** via auth.openai.com public Codex client), anthropic, google, openrouter, groq, xai, deepseek, mistral, kimi, z.ai; custom config providers keep working; `sc models plugins` lists them.

### 3. Resolution integration (runtime, no behavior regressions)
- `resolveModel()` profiles-binding: `providers.<name>.apiKey` that matches a stored compatible profile resolves its material; `${name}.authProfiles: [...]` lists bind multiple profiles with their order (explicit `auth.order.<name>` first, store override above config).
- Eligibility at pick time: expired/invalid_expires/cooled profiles skipped with the stable reason code in errors; literal keys unchanged.
- Health feedback: provider 401/403 → `fail_count++`, `cooldown_until = min(now + 5m*2^(fails-1), 60m)`; success resets + `last_ok`. Instant 7× retries (user rule 10) untouched — cooldown applies *between run attempts*, never inside the retry ladder.
- Secret hygiene: material never redacted *into* logs; redact.ts learns profile tails; store file chmod 0600.

### 4. OAuth device flow (`src/agent/oauth-device.ts`)
RFC 8628 client, injectable fetch: device-code request → poll token (honors `interval`, `slow_down`, `authorization_pending`, `access_denied`/`expired_token` give clean failures; device flow has no browser callback — their headless path exactly). PKCE-less per device-code. Exchange result → oauth profile with `expires` from `expires_in`.

### 5. CLI — mirror theirs (schema: `models auth …`)
`login [--provider] [--method api-key|device-code] [--profile-id] [--set-default] [--force]` · `paste-api-key --provider` / `paste-token --provider` (hidden prompt) · `list [--provider] [--json]` (status + reason codes) · `order get|set|clear --provider <ids...>` · `remove <id>` · `probe [--provider] [--json]` (their `models status --probe` analog: profile catalog check with reason codes). `sc models plugins`.

### 6. Web UI (provider-first drill-down stays — user rule 7)
Per provider card: **Connect** (method picker when both offered: paste-key field; device-code → shows verification URL + user code, polls via RPC, saves profile + optional set-default). Profiles chips: id, type badge, expiry/cooldown badges, up-down ordering, remove. Gateway RPC: `models.plugins`, `models.auth.list`, `models.auth.addKey`, `models.auth.beginDeviceCode`, `models.auth.pollDeviceCode`, `models.auth.remove`, `models.auth.order`, `models.auth.probe`.

### 7. Doctor
`sc doctor` gains an auth block: expired/invalid-expires profiles, no-credential providers named by the default model ref, order entries pointing at removed profiles — each with the fix command, matching their doctor-auth.

## Explicitly OUT (documented, like our architecture doc)

Multi-agent agent-local stores · macOS Keychain/external-CLI CSS discovery · SecretRef zoo · personal `models accounts` · browser-callback OAuth web server (device-code covers headless; browser any-device) · setup-replacement inactive-credential staging (`auth activate` — single-agent single-step login makes the dance unnecessary; decline ⇒ don't save).

## Tests (test/auth.test.mjs + CLI)

Profile store CRUD + expiry validation (invalid_expires/expired/missing) · binding: apiKey-names-profile resolves + incompatible realm stays literal + expired binding surfaces reason · multi-profile order (store override > config; excluded_by_auth_order) · cooldown/last-good transitions on 401/success · device-code flow: code request, poll pending→slow_down→success, denied/expired errors, expiry→profile.expires · CLI: login api-key via flag/prompt, list json codes, order set/clear persists + wins, probe with mock provider (ok/expired/excluded) · gateway RPC round-trip (login-with-key + removal) · legacy behavior regression: literal keys resolve identically (existing model tests stay green, 156→).

## Constraints honored

Provider list ≥10 already; provider-first drill-down UI preserved; instant retries untouched; models chosen only by choosing; no new deps; demo verify with paste-key profile against the mock gateway afterward.
