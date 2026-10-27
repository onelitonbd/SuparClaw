# SuparClaw — Termux-first architecture spec (OpenClaw-style, mobile-native)

> Build spec drafted 2026-10-19 · Grounded in the OpenClaw 2026.10.5 study (`openclaw-architecture-brief.md`),
> verified OpenClaw installer/package internals, and measurements taken on this very device (aarch64 Android, 8 cores, ~1.6 GB free RAM).

## 1. Vision

Build a faithful architectural clone of OpenClaw — **daemon + Gateway + WebSocket control plane +
agent loop + channels + tools + skills + sessions + cron + hooks** — but designed *from day one* for
**native Termux on Android**:

1. **Installs on stock Termux** (no proot, no glibc, no node-gyp, no sudo).
2. **Feels instant**: light cold start, low per-turn overhead, small footprint, low RAM.

Everything must *operate like OpenClaw's*: one long-lived daemon owns channels and state; clients
attach over WS; messages flow intake → session → agent loop → tools → streamed reply; workspace files
are the agent's persona/memory; skills are markdown loaded on demand.

---

## 2. Why OpenClaw hurts on mobile (verified, not guesses)

### 2.1 Install fails on stock Termux — root causes found in the code

| Cause | Evidence |
|---|---|
| **Node engine gate** | `engines: ">=24.16.0 <25 || >=26.1.0"` + preinstall probe (`scripts/preinstall-package-manager-warning.mjs`). Termux's `nodejs` tracks latest upstream — when it's 25.x or 26.0.x, install/launch is refused outright. |
| **Native module with no Android build** | `@lydell/node-pty` (a hard dependency) ships prebuilds only for `{linux,darwin,win32}-{x64,arm64}` — **no android-arm64**. npm falls back to source build → node-gyp → fails/misbehaves on Termux. |
| **Installer assumes a desktop distro** | `scripts/install.sh`: `apt-get/pacman/dnf` + `sudo`/root, nvm/brew paths. No Termux branch anywhere (only a joke tagline mentions Android). Stock Termux has no sudo → installer dies. |
| **Heavy lifecycle scripts** | npm `postinstall` runs `postinstall-bundled-plugins.mjs`, which walks the installed dist (their code comment: "a real upgrade scan totals ~24k entries today") — slow on phone storage, can be killed, and re-runs on every upgrade. |
| **Optional native deps** | `sqlite-vec` prebuilds also skip android — vector search silently unavailable (tolerated, but feature loss). |

### 2.2 Proot is slow — measured on THIS device (aarch64, 8 cores)

| Measurement | Result |
|---|---|
| Bare `node -e` (cold) | **0.89 s** |
| `openclaw --version` (diagnostic fast path) | **4.86 s** |
| Installed package size | **566 MB** (`dist/` alone = **8,624 chunk files**) |
| Available RAM while running | ~1.6 GB free (4 GB already used) — heavy GC/page pressure |

Why: **PRoot = ptrace syscall interception** — every fs/thread/socket syscall pays a tax, and Node is
syscall-heavy. OpenClaw amplifies it: thousands of module files to open (cold module graph), worker
isolates by default, per-tool CLI subprocess patterns, and a 566 MB footprint on slow phone storage.
On **native Termux the same Node does far less work per syscall** — most of the lag is proot + module
graph weight, not Node itself.

### 2.3 What this means for SuparClaw

- Zero native modules. Zero node-gyp. Zero lifecycle scripts that scan thousands of files.
- A **tiny module graph** (single-digit bundle files) and **no worker/subprocess sprawl**.
- Capability probes instead of hard exclusions where possible (support any Node where `node:sqlite`
  passes a probe), graceful guidance when not.

---

## 3. Design principles

1. **Daemon-first, like OpenClaw.** One process owns channels, sessions, state. Clients attach.
2. **Native-Termux-only assumptions.** `$PREFIX`-aware, `$HOME`-based state, no root, no systemd.
3. **Zero native code.** Core must run on `pkg install nodejs` + `npm i -g` and nothing else.
4. **Boring dependency diet.** Every dep must be pure JS, small, maintained. Fewer deps = fewer
   syscalls, smaller bundle, faster start.
5. **Faithful semantics, lean internals.** Same concepts (gateway/sessions/workspace/skills/queue
   modes/doctor), aggressively simplified implementation.
6. **Measure on the phone.** Every milestone has a latency/memory acceptance criterion.

---

## 4. Architecture (mirrors OpenClaw's shape)

```
                 Telegram (long-poll)   WhatsApp*   WebChat(PWA later)
                        │                   │              │
                        ▼                   ▼              ▼
 ┌──────────────────── SUPARCLAW DAEMON (one process) ────────────────────┐
 │  channels/        adapters: telegram (first), pluggable interface       │
 │  gateway/         WebSocket + HTTP on 127.0.0.1:18790 (loopback)        │
 │                   protocol: connect / req,res / events; token auth      │
 │  router/          message → agent + session (dmScope-like rules)        │
 │  agent/           serialized per-session loop: prompt → model → tools   │
 │                   → streaming → persistence  (+queue modes, compaction) │
 │  llm/             HTTP(S) streaming clients, keep-alive, fallback       │
 │  tools/           fs · exec(approval-gated) · web · memory · time       │
 │  skills/          markdown SKILL.md loader, on-demand injection         │
 │  state/           node:sqlite (WAL) — sessions, messages, runs, jobs     │
 │  cron/ hooks/     scheduler + event hooks (script/markdown)             │
 └──────────────┬──────────────────────────────┬─────────────────────────┘
                ▼                              ▼
         CLI (`sc …`, thin WS client)     Control UI (later: tiny PWA)
```

### 4.1 Gateway & protocol (copy OpenClaw's shape, not its surface area)

- Bind **loopback** default (`127.0.0.1:18790`), token auth (`gateway.auth.mode: "token"`).
- WS framing mirror: `{type:"req",id,method,params}` → `{type:"res",id,ok,payload|error}`;
  events `{type:"event",event,payload,seq}`. First frame must be `connect`.
- Methods (MVP): `health`, `status`, `send` (chat), `agent.wait`, `sessions.list`, `config.get`,
  `config.set`. Events: `chat` (`delta`/`final`/`error`), `agent`, `presence`, `tick`.
- Idempotency keys for `send` (dedupe cache) — copy this from OpenClaw; it prevents double replies
  on mobile network flips.
- HTTP side: static Control UI + `/health`. Canvas/widgets/webhooks: later.

### 4.2 Agent loop (per-session, serialized)

1. Intake → resolve agent + session key (DM default: main session; groups isolated; cron fresh).
2. Queue: `steer` / `followup` (MVP), later `collect` / `interrupt`.
3. Turn admission: one active run per session; `runId` + single-writer fence on transcript writes.
4. Prompt assembly: base prompt + workspace bootstrap (`AGENTS.md`, `SOUL.md`, `USER.md`,
   `MEMORY.md`, `memory/*.md`) + skills snapshot (truncation budgets) + a `## Surfaces` block
   rebuilt every turn (live channel status and the chat ids a scheduled result can reach), so
   the agent never invents a capability gap it does not have.
5. Model call: OpenAI-compatible first (covers most local/remote providers); streaming; retries with
   backoff; model fallback chain; idle watchdog; separate quick `agent.wait` timeout (30s, wait-only).
6. Tools: JSON-schema validated; `before_tool_call`/`after_tool_call` hooks; exec follows
   `tools.exec.mode` (default `full`). The decision is a **policy**, never a person: no tool
   opens an approval prompt, `ask` runs and logs the allowance, `deny` refuses with the reason.
7. Stream events → channel adapter renders (Telegram: typing indicator while a turn runs, then one message per finished answer block — no status draft).
8. Persist transcript + usage; emit `final`. The `/usage` footer is a field on that event and is
   re-rendered from the numbers stored on the assistant row, so a reload or a restart keeps it
   (`chat.regenerate` drops the newest turn before re-running its prompt). `NO_REPLY` = intentional
   silence (copy semantics).
9. Transcript actions follow OpenClaw's chat: every persisted message carries a quiet icon row —
   Copy returns the source Markdown for answers and the exact typed text for prompts; the newest
   answer adds Regenerate; a prompt adds Edit (`chat.rewind` drops that prompt and everything after
   it and returns the text to the composer, never re-sends) and Fork (`chat.fork` copies the
   conversation's prefix before that prompt into a new session, opens it until a send, and seeds
   the composer -- the parent is only read; timestamps and usage move with the rows). Labels live in
   the tooltip and the accessible name, and the glyphs ship with the bundle. Reactions and per-run
   failure details are deliberately not implemented yet (they need reaction storage and a
   run-error record respectively).

### 4.3 Channels

- Interface: `{ start(), stop(), send(target, payload), typing(target), onMessage(cb) }`.
- **Telegram first** (grammY, pure JS, long-poll, no inbound ports — mobile-friendly).
- Allowlists (`allowFrom`), group mention-gating, per-chat sessions — same knobs as OpenClaw.
- WhatsApp via Baileys is possible later but heavy; keep it out of MVP (lazy dynamic import).

### 4.4 Tools (MVP set)

`fs.read/write/list` (workspace-scoped by default), `exec` (on by default in mode `full`;
`sc approvals mode` gates it), `terminal` (persistent shells, §4.4),
`web.fetch`, `web.search` (DuckDuckGo HTML), `memory.journal` + `memory.search` (SQLite FTS),
`time`, and the automation family `cron_list/add/update/remove` — the same `jobs` rows the
gateway's `cron.*` and `sc cron` write, so the agent can schedule its own work and re-arm it
through the scheduler. Tools run in-process — no subprocess per call (except `exec` itself,
inherently).

`exec` never fails silently. Every non-zero result is labelled with its cause and the
command that ran — `[exit N] cmd` (plus "printed nothing" when it was quiet),
`[cannot run] cmd — <binary / working directory>` for a spawn failure, `[timeout] cmd — killed
after N ms` at the `tools.exec.timeoutMs` cap (30 min, Task 38), `[signal]` for a kill. A model
that sends a nonsense `timeoutMs` gets the configured cap and a note, never an exception: the
value is clamped to 100 ms–1 800 000 ms before `execFile` sees it.

The strict sandbox must not be able to create that symptom either. Its PATH is the trusted
dirs first, then `$PREFIX/bin`, then the parent's PATH **minus** anything under the real HOME —
so Homebrew/nvm/asdf/nix installs still work while dotfiles and user-local bins stay invisible.
`prlimit`/`proot` are used only if they actually start: when a wrapper fails to spawn
(`ENOENT`/`EACCES`/`ENOEXEC`/`EPERM`) the command is retried once without it, and the output says
the jail was not applied. `sc doctor` runs one real command through this exact path and reports
the layer that broke, so "exec fails on everything" comes with a cause.

**Terminals (Task 52).** `exec` is one command in a throwaway process: state dies with it.
The `terminal` tool is the opposite — a **persistent shell the daemon owns**, addressed by id:

```
terminal {action:"run", command:"cd ~/proj && export NODE_ENV=dev && npm run dev", terminal:"t2"}
```

Every later call on `t2` starts in `~/proj`, sees `NODE_ENV`, and can read what the dev server
printed. `create` opens another shell (up to `tools.terminals.max`), `read` shows the tail (also
while a command is still running), `interrupt` sends SIGINT to the command's *descendants* and
keeps the shell alive, `restart` replaces a shell that exited, `clear` empties the scrollback,
`kill` closes it. Terminals die with the daemon; nothing survives a restart, and the UI says so.

The implementation is pipes plus a sentinel, **not a PTY** (src/agent/terminals.ts): after each
command line the shell is told to print `\n__sc:<token>:%d\t%s` with `$?` and `$PWD`. That gives the
exit code, the new working directory and an exact end-of-output marker, while stderr is merged into
stdout once (`exec 2>&1`) so ordering is the terminal's ordering. A PTY was tried and rejected: it
echoes every command, prints an ANSI prompt and would need a full terminal emulator in a phone
panel. Consequences, stated rather than hidden: the panel is **plain text** (ANSI and `\r` redraws
are stripped server-side), full-screen programs (`vim`, `htop`) will not render — they are not what
an agent drives a shell for — and tests are the honest way to see them. Output is held in a ring
(`tools.terminals.scrollbackKb`, default 200 KB) with a monotonic sequence, so the web panel asks
for "everything after N" and never re-renders the whole log.

`terminal` goes through the **same policy as `exec`** (`needsApproval` marks the call for the
evaluator; it is not a prompt) — `full` runs it, `deny` refuses it, and no surface ever waits. There is no sandbox wrapper on either surface: the shell has
the daemon's permissions and the workspace's cwd — by design (T52: "the ai can go anywhere and do
anything").

The operator **watches the same shells**: `terminals.list|create|run|send|read|interrupt|restart|
kill|clear` are gateway methods, and every output/state/create/remove change is broadcast as one
`terminal` event on the normal event stream. The Control UI's rail button (id `terminal-btn`) opens
a panel that is full-screen on a phone and docked to the right from 900 px up; it shows one tab per
terminal, a dot while a command runs, the live output, and a prompt you can type into yourself.

### 4.5 Skills

- `SKILL.md` markdown with frontmatter (`name`, `summary`, `read_when`) — same convention OpenClaw
  uses. Loaded on demand into context; workspace `skills/` overrides bundled.
- Bundle ~5 starter skills (e.g. `help`, `daily-journal`, `web-digest`, `device-status`).

### 4.6 Memory

- Files: workspace `memory/YYYY-MM-DD.md` (journal) + `MEMORY.md` (curated).
- Index: SQLite **FTS5** if available (probe at startup), else `LIKE` fallback. No embeddings in MVP.

### 4.7 Config

- `~/.suparclaw/config.json5` (JSON5 via tiny pure-JS lib; comments allowed like OpenClaw).
- **Strict validation at boot** (reject unknown keys; clear error + `sc doctor --fix` guidance).
- `.bak` ring + `last-good` on successful boot. Hot reload via `fs.watch` (debounced).
- Env overrides: `SUPARCLAW_HOME` > `$HOME` > Termux `$PREFIX` fallback (copy OpenClaw's precedence).

---

## 5. Storage & filesystem layout

```
~/.suparclaw/
├── config.json5 (+ .bak ring, .last-good)
├── state.sqlite (+ -wal)        # everything: sessions, messages, runs, jobs, auth, FTS
├── workspace/
│   ├── AGENTS.md  SOUL.md  USER.md  IDENTITY.md
│   ├── memory/YYYY-MM-DD.md     # daily journal
│   └── skills/                  # workspace skills
├── logs/ (rotating ring)  media/  backups/
```

DB schema (v1):

```sql
meta(key TEXT PRIMARY KEY, value TEXT);
sessions(id TEXT PK, key TEXT UNIQUE, agent_id TEXT, name TEXT,
         created_at INT, last_msg_at INT, meta JSON);
messages(id INTEGER PK AUTOINCREMENT, session_id TEXT, run_id TEXT,
         role TEXT, content JSON, created_at INT,
         usage TEXT);  -- assistant rows: {usage, model, label} for footer replay
runs(id TEXT PK, session_id TEXT, status TEXT, started_at INT,
     ended_at INT, error TEXT, usage JSON);
jobs(id TEXT PK, kind TEXT, schedule TEXT, payload JSON, enabled INT,
     last_run_at INT);           -- cron
job_runs(id INTEGER PK, job_id TEXT, started_at INT, status TEXT, result TEXT);
auth(provider TEXT, profile_id TEXT, mode TEXT, secret_ref TEXT, meta JSON,
     PRIMARY KEY(provider, profile_id));
tool_log(id INTEGER PK, run_id TEXT, tool TEXT, status TEXT, ms INT, at INT);
fts_messages(content, session_id, message_id);  -- FTS5, if probe passes
schema_migrations(version INT PRIMARY KEY, applied_at INT);
```

SQLite pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, busy_timeout, prepared-statement cache.
Backups: `VACUUM INTO 'backups/state-<date>.sqlite'` (safe while running).

---

## 6. Performance budget & techniques (the core promise)

### Targets (native Termux, mid-range phone)

| Metric | Target | OpenClaw reference (measured here, proot) |
|---|---|---|
| Cold start (`sc --version`) | **< 400 ms** | 4,860 ms |
| Daemon ready → WS healthy | **< 1 s** | seconds–tens of seconds |
| Per-turn overhead (recv → provider request sent) | **< 150 ms** | subprocess/worker-heavy |
| Idle RSS | **< 120 MB** | heavy (workers + 8.6k chunks) |
| Install footprint | **< 30 MB** | 566 MB |
| Install time (npm) | **< 60 s** | minutes + probes |

### Techniques

1. **Single-file esbuild bundle** (`dist/sc.mjs`, format=ESM, platform=node, target=node24,
   tree-shaken, minified). Dynamic `import()` only for opt-in adapters (whatsapp/media) so unused
   code costs nothing at boot.
2. **`module.enableCompileCache()`** at launcher start (built into Node ≥22.8) — instant warm starts.
3. **Capability probes at boot** (copy OpenClaw's idea, cheaper): Node version sanity, `node:sqlite`
   NUL round-trip, WAL-safety; FTS5 availability. Fail with actionable messages, never stack traces.
4. **No workers by default.** Tools run in-process; heavy/unsafe things (code exec, media transcode)
   are opt-in behind flags and only then touch child processes.
5. **Warm connections.** One keep-alive agent per provider; Telegram long-poll held open;
   no polling loops anywhere (single croner timer drives scheduled work).
6. **SQLite hygiene.** Prepared statements, batched transcript writes, WAL + NORMAL sync,
   no per-turn table scans (caches + indexes).
7. **Streaming memory discipline.** Stream model output straight to channel + transcript batch;
   never buffer whole media in RAM (stream to `media/` file).
8. **Dependency diet** (see §7) — each dep justified; no postinstall scripts, no optional native trees.

### Explicitly *not* ported (v1)

Nodes/device commands, voice/meetings, sandboxing (advisory only), embeddings/vector search,
multi-agent rosters, desktop/mobile apps, plugin marketplace, canvas/A2UI.

---

## 7. Repo & module layout

```
suparclaw/
├── package.json          # bin: sc → dist/sc.mjs · runtime deps: grammy, ws, json5, croner
├── tsconfig.json
├── scripts/build.mjs     # esbuild build → dist/sc.mjs (+ version stamp)
├── src/
│   ├── boot.ts           # probes, compile-cache, arg dispatch (gateway | chat | doctor | config | service)
│   ├── gateway/          # server.ts (http+ws), protocol.ts, methods.ts
│   ├── agent/            # loop.ts, prompt.ts, queue.ts, compaction.ts, sessions.ts
│   ├── llm/              # client.ts (openai-compatible), stream.ts, fallback.ts
│   ├── channels/         # channel.ts (interface), telegram.ts, (whatsapp.ts later)
│   ├── tools/            # registry.ts, fs.ts, exec.ts, web.ts, memory.ts, time.ts
│   ├── skills/           # loader.ts
│   ├── state/            # db.ts, pragmas.ts, migrations/
│   ├── config/           # load.ts, schema.ts (hand-rolled strict validator), hot-reload.ts
│   ├── cron/             # scheduler.ts
│   ├── hooks/            # runner.ts
│   └── cli/              # index.ts, doctor.ts, service.ts (Termux!), init.ts
├── skills/               # bundled starter skills (*/SKILL.md)
├── test/                 # node:test — unit + loop tests with a fake provider
└── docs/                 # this spec + user docs (mirror of what we learned)
```

**Runtime dependency diet (proposed, all pure JS):**
`grammy` (Telegram) · `ws` (WS server; zero-dep) · `json5` (config) · `croner` (cron).
Everything else: Node built-ins (`node:sqlite`, `fetch`/undici, `node:http`, `node:test`).
(Optional later: zod for schema if hand-rolling gets painful — keep it tree-shaken.)

Naming parity with OpenClaw deliberately kept where it helps understanding: gateway, sessions,
workspace, skills, doctor, cron, hooks, `agent`/`agent.wait`, `NO_REPLY`, queue modes.

---

## 8. Install & distribution (Termux-first)

- **Primary:** `curl -fsSL …/install.sh | bash` — Termux-aware: detects `$PREFIX`, fetches the
  runtime files only (sparse clone, ~2 MB; the codeload tarball is the fallback), writes the `sc`
  launcher to `$PREFIX/bin`, records the ref in `current/.suparclaw-ref`, runs `sc doctor`.
  `--ref <branch|tag>` installs something other than `main`, and `sc update` then follows it.
- **From source:** `npm i -g github:onelitonbd/SuparClaw` — engine `>=24.16` + runtime probe
  (no <25/≥26.1 hard gate; probe instead). **No preinstall/postinstall side effects beyond a
  version print.** The package is not published to the npm registry, so the bare name would 404.
- **Service:** `sc service install` writes a **termux-services** run script
  (`$PREFIX/var/service/suparclaw/run`) and prints `termux-wake-lock` guidance; `sc service status`.
  No systemd assumptions, ever.
- **Doctor:** `sc doctor` checks Node version, sqlite caps, FTS5, config validity, port availability,
  Telegram token presence, storage permissions — same "diagnose + fix" ethos as OpenClaw.

---

## 9. Milestones

| # | Deliverable | Acceptance criteria |
|---|---|---|
| **M0** | Scaffold + build + `sc doctor` + config load | Single-file bundle builds; `sc --version` < 400 ms target on device; doctor probes pass/fail cleanly |
| **M1** | Gateway daemon (WS protocol, state DB, logs, service) | Daemon survives 24 h on phone; reconnect works; idle RSS < 120 MB |
| **M2** | Agent core + `sc chat` | Streaming reply in terminal; transcript persisted; turn overhead < 150 ms; compaction at threshold |
| **M3** | Telegram channel | DM → reply < provider latency + 150 ms; allowlist + mention gating; steer mid-turn; answers only (no status/tool lines), multi-block answers posted as they are written |
| **M4** | Tools + skills + memory | fs/web/memory/cron tools work; exec on by default (mode full), governed by a policy with no interactive approvals; 5 bundled skills; FTS recall |
| **M5** | Cron + hooks + polish | Scheduled job fires after reboot-era restarts; hot config reload; backup command; all §6 targets met |

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Termux Node version drifts (25.x/26.0) | Probe-based support; document supported `pkg install nodejs` floors; clear upgrade guidance |
| Android doze kills sockets | `termux-wake-lock` + reconnect/backoff; keepalive pings; service install script |
| FTS5 missing in some builds | Startup probe → `LIKE` fallback |
| WhatsApp demands heavy deps | Post-MVP, lazy-loaded adapter; keep core clean |
| Memory pressure on low-RAM phones | Streaming writes, context windows, no buffering; enforce budgets in CI-like device tests |
| Scope creep toward full parity | This spec's "not ported" list is law until M5 |

---

## 11. OpenClaw → SuparClaw mapping (semantics kept, weight dropped)

| OpenClaw | SuparClaw (v1) |
|---|---|
| Gateway daemon, WS 18789, typed protocol | Gateway daemon, WS 18790, same frame shapes, MVP method subset |
| 184 extensions / plugin SDK | 1 channel adapter (Telegram) + tool registry (built-ins only) |
| node:sqlite, two DB roles, worker brokers | node:sqlite single DB, no brokers, in-process access |
| Workspace files (AGENTS/SOUL/USER/IDENTITY/memory) | Same file conventions |
| Skills: markdown, on-demand | Same convention, 5 starter skills |
| Agent loop: queues, fencing, compaction, fallback, hooks | Same semantics, steer/followup only, simpler timeouts |
| Config: JSON5, strict schema, doctor, .bak ring | Same behavior, hand-rolled validator |
| 8,624 dist chunks, 566 MB | 1 bundle file, < 30 MB installed |
| systemd/launchd services | termux-services + wake-lock |

---

## 12. Build progress (updated 2026-10-19)

**M0 ✅ · M1 ✅ · M2 ✅ (code complete) · M3 ◐ (Telegram adapter written, needs a real bot) · M4 ◐ · M5 ◐**

| Milestone | State | Evidence |
|---|---|---|
| M0 scaffold + doctor + config | done | `sc init`, `sc doctor` (11 checks), strict JSON5 schema, 19 tests green |
| M1 gateway daemon | done | http+ws on one port, token auth (bad token → close 4401), `/health`, static Control UI |
| M2 agent core + `sc chat` | done | streaming SSE client, tool loop, SQLite transcripts, pure-JS TUI (local + remote) |
| M3 Telegram | code done | grammY long polling, 300 ms batching, pairing/allowlists, answers-only delivery (no status draft), and the four pickers — `/model` (provider → model), `/sessions` (enter an earlier conversation), `/think` (effort buttons), `/new` → Code (account → repository → branch) — all ten rows a page, all command-requested cards edited in place; needs a bot token to exercise |
| M4 tools + skills + memory | done | 11 built-in tools, 5 bundled skills, workspace files, FTS search |
| M5 cron + hooks | partial | croner scheduler + `sc cron` CLI; hooks not yet implemented |

Measured on this proot box (bare `node -e ''` = 0.66 s):

| Metric | Result |
|---|---|
| `sc version` | **1.12 s** (~0.39 s of actual work) |
| `sc doctor` | 1.68 s |
| Gateway ready → `/health` OK | ~0.2 s after start |
| Install footprint | **1.15 MB**, 19 packages, zero native modules |
| OpenClaw comparison | `openclaw --version` 1.6–4.9 s, install 566 MB |

Code-split build keeps `sc version` from parsing the TUI, gateway, grammY or the model client;
grammY, croner and `ws` are loaded only when their feature is actually used.
