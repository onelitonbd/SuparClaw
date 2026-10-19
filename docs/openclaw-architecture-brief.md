# OpenClaw — Architecture & System Structure Brief

> Research date: 2026-10-19 · Version studied: **2026.10.5** (`1b58cb9`) · License: **MIT**
> Sources: the scraped docs mirror (`docs/openclaw/`), the live installation on this Termux machine
> (`/root/.openclaw/` + installed npm package), and the source tree of
> [openclaw/openclaw](https://github.com/openclaw/openclaw) (60,005 files, TypeScript monorepo).

---

## 0. One-paragraph summary

OpenClaw is **not an app — it's a daemon**. A single long-lived **Gateway** process runs on your
machine, connects out to messaging channels (Telegram, WhatsApp, Discord, …) via plugins, owns *all*
state in SQLite databases and plain files under `~/.openclaw/`, and drives an **embedded agent
runtime** (LLM loop + tools + sessions + memory). Every UI — CLI, browser Control UI, desktop/mobile
apps — is just a **WebSocket client** of that Gateway. Nothing central is hosted; the whole product is
one Node.js bundle that runs anywhere Node 24.16+/26.1+ runs — including Termux/Android (proven live on
this machine).

---

## 1. Process & component model

```
        ┌─────────────── channels (outbound connections) ───────────────┐
        │  Telegram (grammY) · WhatsApp (Baileys WS) · Discord · Slack  │
        │  Signal · iMessage · Matrix · IRC · SMS · A2A · plugins…      │
        └───────────────────────────┬───────────────────────────────────┘
                                    ▼
      ┌─────────────────────  GATEWAY (one process, node) ─────────────────────┐
      │  · WebSocket API      ws://127.0.0.1:18789  (typed: req/res + events)  │
      │  · HTTP surface       Control UI, canvas widgets, webhooks             │
      │  · Router             message → agent → session selection              │
      │  · Scheduler          cron/automations, heartbeat, device pairing      │
      │  · Agent runtime      embedded runner + harnesses (openclaw, codex)    │
      │  · Workers            worker pools (compute / readers / SQLite broker) │
      │  · Plugin host        184 extensions: channels, providers, tools       │
      │  · State owner        the ONLY writer to every OpenClaw database       │
      └───────┬─────────────────┬──────────────────┬─────────────────┬─────────┘
              ▼                 ▼                  ▼                 ▼
           CLI client       Control UI        Desktop apps      Nodes (role:"node")
        (`openclaw …`)    (browser, SPA)     (macOS, Android)   macOS/iOS/Android phones
```

Key rules:

- **Exactly one Gateway per host** (there is a state-dir lock; a second one is refused).
- Clients and node devices connect over the same WS server. First frame *must* be `connect`;
  devices get **pairing + device tokens**; loopback connects auto-approve.
- Wire protocol: JSON frames `{type:"req",id,method,params}` → `{type:"res",id,ok,payload|error}`,
  plus push events (`agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`, `tick`…).
  Schemas are defined with **TypeBox → JSON Schema → Swift codegen** for the Apple apps.
- **Nodes** are phones/desktops that attach with `role:"node"` and expose device commands
  (`camera.*`, `screen.record`, `location.get`, …). The official Android app is a *companion node* —
  it does **not** host the Gateway ("Android does not host the Gateway" is the official line; running
  the Gateway *inside* Termux on Android is possible anyway, as this machine proves).

### Agent runtime (inside the Gateway)

- Built-in runtime id `openclaw` (legacy alias `pi`); plugin harnesses can add others (e.g. `codex`).
- Runtime selection: `agentRuntime.id` config (model entry > provider entry; unset → `auto`).
- Code areas: `src/agents/embedded-agent-runner/` (the attempt loop), `packages/agent-core/`
  (reusable loop, messages, compaction, session contracts), `src/llm/` (provider transport),
  `src/agents/harness/` (harness registry).
- **Workers**: `@openclaw/worker-runtime` pools for code execution, compaction planning, file tools,
  transcript reads. SQLite brokers writes through up to 2 writer isolates; readers capped at 2.

### Extensions (plugins) — the "everything is a plugin" layer

184 extension packages under `extensions/` in the repo. They provide:

- **Channels**: telegram, whatsapp, discord, slack, matrix, msteams, signal, imessage, line, feishu,
  mattermost, irc, sms, nostr, twitch, nextcloud-talk, zalo, googlechat, a2a, buzz, clickclack, …
- **Model providers**: openai, anthropic, google, xai, groq, mistral, deepseek, ollama, lmstudio,
  llama-cpp, openrouter, litellm, bedrock, vertex, qwen, kimi, minimax, together, fireworks, …
- **Tools/features**: browser, codex, memory-core, memory-wiki, voice-call, workboard, canvas,
  duckduckgo/brave/exa/tavily (search), cua-computer, github, onepassword, policy, …
- Plugins use documented `openclaw/plugin-sdk/*` entrypoints (never `src/**` internals) and can
  extend resources via `package.json` `openclaw` manifest: `extensions/`, `skills/`, `prompts/`, `themes/`.

---

## 2. Message → reply flow (the agent loop)

Per-session, serialized, restartable:

1. **Intake** — channel account receives message → routed to an **agent + session** by
   `channels`/`bindings` config (DM scope: `main` | `per-peer` | `per-channel-peer` | …;
   groups isolated per room; cron gets fresh sessions).
2. **Turn admission** — the session controller serializes turns per physical session; the channel's
   queue mode decides what happens to messages arriving mid-turn: **steer / followup / collect /
   interrupt**. A durable `activeWriterRunId` claim fences all transcript writes (a superseded run
   can never commit stale data).
3. **Context assembly** — bootstrap files from the **workspace** (`AGENTS.md`, `SOUL.md`, `USER.md`,
   `IDENTITY.md`, `MEMORY.md`, `memory/*.md`) + skills snapshot + system prompt + per-run overrides,
   truncated to limits (`bootstrapMaxChars` 20k default).
4. **Model call** — provider/model resolution with auth profiles, **fallback chain**, retries,
   auto-**compaction** (summarization) when context overflows; per-attempt timeout budget
   (default 48h elapsed!, idle watchdog 120s cloud / 300s self-hosted).
5. **Tool execution** — schema-validated args; before/after hooks (`before_tool_call` etc.);
   exec approvals for shell; results sanitized for size; messaging-tool sends tracked.
6. **Streaming** — events `assistant` (deltas), `tool` (start/update/end), `lifecycle`
   (`start` → `finishing` → `end`/`error`); block/reasoning streaming options.
7. **Reply shaping** — final payload assembled; `NO_REPLY` = intentional silence; empty final is a
   recorded failure, not silence; duplicate confirmations suppressed.
8. **Persistence** — transcript + session metadata + usage written via the SQLite writer queue;
   audit ledger gets metadata-only projections.

Hooks: internal **HOOK.md** scripts (command/lifecycle events like `command:new`, `agent:bootstrap`)
+ plugin hooks (`api.on('before_prompt_build')`, …). Cron/webhooks drive the same loop via
`agent` RPC (`agent.wait` waits for terminal outcome; runIds, replay of terminal results).

---

## 3. Storage & configuration (filesystem-level)

### 3.1 Live `~/.openclaw/` layout (observed on this machine, v2026.10.5)

```
~/.openclaw/
├── openclaw.json                 # THE config (JSON5, strict schema)
├── openclaw.json.bak[.1..n]      # backup ring on every write
├── openclaw.json.last-good       # trusted copy after each successful boot
├── config-journal-fingerprint.key
├── state/
│   └── openclaw.sqlite(.wal,-shm)   # shared/control-plane DB (device pairing, cron,
│                                     # config machine state, leases, migrations…)
├── agents/
│   └── <agentId>/
│       └── agent/
│           └── openclaw-agent.sqlite   # per-agent DB: auth profiles, sessions,
│                                       # transcripts, memory index, routing state
├── workspace/                    # the agent's home (default; git-repo encouraged)
│   ├── AGENTS.md                 # operating instructions (loaded every session)
│   ├── SOUL.md                   # persona & tone
│   ├── USER.md                   # directive-based user model (4k char budget)
│   ├── IDENTITY.md               # name/vibe/emoji
│   ├── BOOTSTRAP.md              # one-time first-run ritual
│   └── memory/YYYY-MM-DD.md      # daily memory logs (+ optional MEMORY.md, skills/)
├── credentials/                  # channel/provider state, OAuth import data
├── skills/                       # managed (installed) skills
├── plugin-skills/                # skills shipped by plugins
├── media/  cache/  locks/  tmp/  npm/  migration/  sandboxes/
```

Key point: **the workspace is memory; `~/.openclaw/` is keys+state.** They are intentionally separate.

### 3.2 Config rules (important for a clone)

- `~/.openclaw/openclaw.json` — **JSON5**, **strict schema**: unknown keys / wrong types ⇒ Gateway
  *refuses to start*; `$schema` is the only free root key. Hot-reloads on change; auto-migration on
  startup; `openclaw doctor --fix` repairs; clobber protection + `.rejected.<ts>` saves.
- Two-bucket rule: root keys = infrastructure/cross-agent defaults (`gateway`, `channels`, `models`,
  `tools`, `hooks`, `channels.telegram.…`); `agents.defaults` = agent-loop behavior
  (`workspace`, `model`, `thinkingDefault`, `timeoutSeconds`…); `agents.entries.<id>` overrides.
- Env override precedence example (home dir): `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` >
  **Termux `PREFIX` home fallback** > `os.homedir()`.
- Profiles: `OPENCLAW_PROFILE` ⇒ `~/.openclaw-<profile>/`; state dir override `OPENCLAW_STATE_DIR`;
  workspace override `OPENCLAW_WORKSPACE_DIR`.

### 3.3 Databases

- **SQLite is the default engine** via Node's built-in `node:sqlite` (`DatabaseSync`) — *no native
  module, no better-sqlite3, no compile step*. WAL mode. Two roles:
  **shared state DB** (control plane) + **one DB per agent** (sessions/transcripts/auth/memory index).
- Migrations are forward-only, versioned; older builds refuse newer schemas. Integrity "seal" files
  carry validation facts across clean restarts. PostgreSQL backend is experimental.
- Backups: archive + per-database snapshots to local/external/object storage (`openclaw backup …`).

---

## 4. Repository structure (monorepo, ~60k files)

| Area | Files | What lives there |
|---|---|---|
| `src/` | 27,883 | **the product.** `agents/` 5.2k (runner, subagents, sessions, harness), `gateway/` 5k (WS server, talk, agent commands), `infra/` 3k, `config/` 1.8k, `plugins/` 1.6k, `commands/` 1.5k, `cli/` 1.4k, `auto-reply/` 1.1k, `state/` 803, `plugin-sdk/` 765, `cron/`, `channels/`, `daemon/`, `secrets/`, `node-host/`, `sessions/`, `acp/`, `tui/` |
| `packages/` | 1,493 | 25 shared packages: `gateway-protocol`, `gateway-client`, `agent-core`, `plugin-sdk`, `ai`, `llm-core`, `memory-host-sdk`, `worker-runtime`, `acp-core`, `model-catalog-core`, `media-core`, `net-policy`, `tool-call-repair`, `mermaid-renderer`, … |
| `extensions/` | 12,884 | 184 plugin packages (channels, providers, tools — see §1) |
| `apps/` | 3,575 | `android` (1,182, Kotlin companion node), `macos` (810), `ios` (786), `shared`, `linux`, `swabble` |
| `ui/` | 6,346 | Control UI — Vite/React SPA served by the Gateway |
| `crates/` | 32 | Rust: `openclaw-node-host`, `openclaw-gateway-client` (native node host) |
| `skills/` | 134 | 40+ bundled skills (`skill-creator`, `tmux`, `1password`, `diagram-maker`, `gh-issues`, `model-usage`, `sherpa-onnx-tts`, …) |
| `docs/` | 1,567 | the docs site (what we mirrored) |
| `qa/`, `test/`, `scripts/` | 641 / 2,463 / 1,964 | QA suites, tests, build/release/native scripts |
| `config/`, `security/`, `patches/`, `deploy/` | — | schemas, security policy, patch-package files, deploy recipes |

Build: TypeScript + esbuild bundling; pnpm workspace; ships to npm as a **single bundled ESM app**.

---

## 5. Distribution & runtime engineering (the Termux-relevant part)

The npm package (`openclaw@2026.10.5`) is a **bundle**, not a source tree:

- Entry: `openclaw.mjs` (launcher) → flat `dist/` with **8,624 chunks**; ~**566 MB installed**.
- Launcher shims (worth studying for any clone):
  - `node-version.mjs` — hard floor **Node ≥24.16 <25 or ≥26.1**; on old runtimes only
    "diagnostic" commands run. Catches the trap that npm install "succeeds" on unsupported Node.
  - `node-sqlite.mjs` — **feature-probes Node's built-in SQLite**: in-memory round-trip of
    TEXT/BLOB/JSON with embedded NULs, and requires a **WAL-reset-safe SQLite version**
    (3.51.3+ / 3.50.7+ / 3.44.6+ patched lines). Fails with actionable messages.
  - `node-host-launcher.mjs`, `node-runtime-env.mjs`, `node-runtime-recovery.mjs` (respawn/recovery),
    `node-compile-cache.mjs`, `worker-heap-flag.mjs` — process robustness on constrained hosts.
  - Bun is probed too (Bun ≥1.4 ships `node:sqlite`).
- **No native compile for core storage** (node:sqlite). Optional `sqlite-vec` (vector search) and
  esbuild binaries — esbuild ships **android-arm64** builds. Optional deps: 79.
- Runtime deps of note: `grammy` (Telegram), WhatsApp via Baileys-style WS, `express 5` (HTTP),
  `croner`, `@modelcontextprotocol/sdk`, `@lydell/node-pty`, `photon-node` (images), `chromium-devtools-mcp`.

### Termux / Android status (from docs + this machine)

- This very machine: **aarch64 Android (PRoot distro), Node 24.18.0, openclaw 2026.10.5 installed and
  running** with a live config (agents `jarvia`, telegram channel enabled, custom `multir` provider
  at `localhost:8080`). So the full Gateway + agent + Telegram stack demonstrably runs under Termux.
- Docs explicitly honor Termux: home-path fallback via `PREFIX`; upstreamed **Termux:Widget auth
  scripts** (`scripts/termux-quick-auth.sh`); release fix "honor … Termux home paths in memory-host
  file lookups"; systemd **or Termux** install steps for ops scripts.
- Official Android app ≠ Gateway host (companion node only). Running the Gateway on the phone itself
  is unofficial-but-real (this box).
- Instant messaging channels are outbound WS clients (Telegram long-poll / WhatsApp WS) — no inbound
  ports needed on mobile. Gateway binds **loopback by default** (18789); remote access via Tailscale
  or SSH tunnel.

---

## 6. Implications for SuparClaw (Termux-first clone)

**Keep (proven patterns worth copying):**

1. **One gateway daemon** that owns channels + state; UIs attach as WS clients. Cheap to run, single
   source of truth, trivial supervision. Perfect for one phone.
2. **SQLite-per-purpose with `node:sqlite`** — file-based state, WAL, forward migrations, no native
   builds. Mobile-friendly (single file, backup = copy, low memory).
3. **Workspace-file persona model** (AGENTS.md/SOUL.md/USER.md + `memory/*.md`) — plain text, git-able,
   no DB needed for identity. Great for context assembly and user trust.
4. **JSON5 config + strict schema + `doctor --fix` + `.bak` ring** — one file to configure, safe writes.
5. **Channel = plugin** abstraction (start with grammY/Telegram; WhatsApp via Baileys next).
6. **Session controller**: per-session serialization + queue modes + writer-claim fencing; transcripts
   in SQLite; compaction + model fallback + per-attempt timeouts.
7. **Typed WS protocol** (TypeBox → JSON Schema) so future clients (web UI) codegen cleanly.

**Simplify for an MVP:** gateway + Telegram + embedded loop + SQLite sessions + minimal web UI;
skip nodes/media/voice/multi-agent/sandboxing initially. Single agent, one workspace.

**Mobile-specific engineering notes:**

- No systemd: supervise with `termux-services`/boot script + `termux-wake-lock`; consider battery
  optimization exemptions; reconnect logic on network flips (channels hold long-lived connections).
- Stay native-free: `node:sqlite` + pure-JS deps (esbuild-bundled). Avoid node-gyp entirely.
- Respect the Node floor (24.16+/26.1+) and probe SQLite capabilities at startup (copy the idea).
- Termux paths: honor `$PREFIX`/`$HOME` fallbacks; keep state in `~` (app-private storage), watch
  Android's 4GB app data limits if you mirror everything (`dist`+deps = ~566 MB for OpenClaw).
- The Android official app is a *client*, not a host — for SuparClaw, the phone is the **server**;
  treat any UI (PWA/Termux widget) as a client of your gateway.

**License**: MIT (repo). Forking and code reuse are permitted — keep the copyright notice if you do.

---

## 7. Read more (in this repo's mirror `docs/openclaw/`)

| Topic | Page |
|---|---|
| Runtime code layout & boundaries | `agent-runtime-architecture.md` |
| Gateway components, WS protocol, pairing | `concepts/architecture.md`, `gateway/protocol.md` |
| The agent loop in full detail | `concepts/agent-loop.md`, `concepts/agent-runtimes.md` |
| Sessions & routing | `concepts/session.md`, `concepts/session-controller.md`, `concepts/main-session.md` |
| Workspace files | `concepts/agent-workspace.md`, `concepts/soul.md`, `concepts/user-model.md` |
| Config system | `gateway/configuration.md`, `gateway/configuration-reference.md` |
| Databases | `reference/database-schemas.md` (+ subpages) |
| Storage locations & backups | `concepts/storage-locations.md`, `install/backups.md` |
| Plugins & SDK | `plugins/architecture.md`, `plugins/building-plugins.md`, `plugins/sdk-*.md` |
| Automation | `automation/cron-jobs.md`, `automation/hooks.md`, `automation/standing-orders.md` |
| Android node app | `platforms/android.md` |
| Install & Node requirements | `install/node.md`, `install/index.md` |
| Termux touches | `help/environment.md`, `help/scripts.md`, `gateway/authentication.md` |
