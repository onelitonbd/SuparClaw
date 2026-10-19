# OpenClaw surfaces brief — TUI, Web UI, Telegram, Tools, Skills, Agent files

> Companion to `openclaw-architecture-brief.md`. Written 2026-10-19 from the English docs mirror
> (`docs/openclaw/`), the live install on this device (`~/.openclaw/workspace/*.md`), and the GitHub
> source tree. Every claim below is traceable to a file listed in each section.

---

## 1. Terminal UI (TUI)

**Docs:** `web/tui.md` (372 lines) · **Source:** `src/tui/` (180 files) + `packages/terminal-core/` (37 files)
**Built on:** `@earendil-works/pi-tui@1.1.0` (third-party terminal toolkit, a hard dependency)

### 1.1 Two run modes

| Mode | Command | Runtime used |
|---|---|---|
| Gateway mode (default) | `openclaw tui` | Thin WS client → the running Gateway |
| Local mode | `openclaw tui --local` (aliases: `openclaw chat`, `openclaw terminal`) | Embedded runtime in-process |

Remote gateway: `openclaw tui --url ws://host:port --token <token>` (or `--password`).
`--local` cannot be combined with `--url/--token/--password`. Bare `openclaw` picks a target
auto: reachable Gateway → gateway mode; else a configured local model → local mode.

**Why it matters for SuparClaw:** the TUI is a *thin* client. All state lives in the daemon.
That means SuparClaw can ship a much smaller TUI (or even ship only local mode first) and stay
operationally identical.

### 1.2 What you see

- **Header:** connection URL, current agent, current session.
- **Chat log:** user messages, assistant replies, system notices, **tool cards**.
- **Status line:** connecting / running / streaming / idle / error.
- **Footer:** agent · session · model · goal state · think/fast/verbose/trace/reasoning · token counts · deliver.
- **Input:** text editor with autocomplete; Markdown hyperlinks open real destinations;
  terminals with image support show inline image previews.

### 1.3 Agents + sessions model (the key mental model)

- Agents are slugs (`main`, `research`); the Gateway publishes the list.
- Session keys are stored as **`agent:<agentId>:<sessionKey>`**. `/session main` expands to
  `agent:<currentAgent>:main`; `/session agent:other:main` switches agent explicitly.
- Session **scope**: `per-sender` (default) or `global`.
- Bare `global` → the agent's Home (`agent:<id>:main` or the stored global conversation).
- Started without `--session`, the TUI resumes the last selected session.
- Footer always shows current agent + session; goal state (`Pursuing goal`, `Goal blocked`, …) too.

### 1.4 Pickers, questions, secrets

- **Model picker** (Ctrl+L): published models, current selection, recommended models first,
  "All models (N)" for the rest; unavailable entries stay visible with their reason.
- **Agent picker** (Ctrl+G), **Session picker** (Ctrl+P): up to 50 sessions updated in 7 days.
- **Settings** (`/settings`): toggle tool-output expansion and thinking visibility.
- **`ask_user` questions:** the TUI opens a native prompt (multi-step, stepper, timer),
  options by arrow/number, multi-select toggles, "Other…" free text, "Skip".
  Pending questions survive session switches and are restored on reconnect.
- **`secrets` requests:** masked input, bullets, value never enters chat or input history.
  Hosts are read-only here; the Control UI edits them.

### 1.5 Shortcuts and slash commands

Enter send · Shift+Enter / Ctrl+J newline · Esc collapse prompt or abort run ·
Ctrl+C clear (twice to exit) · Ctrl+D exit · Ctrl+L model · Ctrl+G agent · Ctrl+P session ·
Ctrl+O tool output · Ctrl+T thinking (reloads history).

Slash commands (session-scoped overrides): `/think`, `/fast`, `/verbose`, `/trace`, `/reasoning`,
`/usage`, `/goal`, `/queue <steer|followup|collect|interrupt> [debounce] [cap] [drop]`, `/btw`
(side question), `/elevated`, `/activation`, `/new`, `/reset`, `/abort`, `/stop`, `/settings`,
`/auth` (local only), `/browser-setup` (local Chrome relay), `/deliver` is **start-time only**
(`openclaw tui --deliver`; no mid-session toggle).

**TUI is an internal source surface, not an outbound channel.** A reply is delivered to Telegram only
if the agent uses `tools.message` with an explicit provider target; the TUI never inherits `lastChannel`.

---

## 2. Web UI

Two distinct surfaces: the **Control UI** (full dashboard SPA) and **WebChat** (the chat surface).

### 2.1 Control UI

**Docs:** `web/control-ui.md` + `web/control-ui/*` (9 pages) · **Source:** `ui/src/` = **5,957 files**

- Docs call it "a small **Vite + Lit** single-page app served by the Gateway" at
  `http://<host>:18789/`, optional `gateway.controlUi.basePath`.
- `gateway.controlUi.enabled` hot-applies (stops serving pages while bots keep running).
- The app talks **directly to the Gateway WebSocket on the same port**. No second server, no
  local static server, no embedded browser in the native apps.
- Source reality check: `ui/src/` is *not* small. Page breakdown — `pages/chat` **1,254 files**,
  `lib/sessions` 162, `pages/new-session` 180, `pages/config` 103, `pages/plugins` 81,
  `pages/agents` 72, `pages/usage` 65, `components/solid` 94, `i18n/locales` 74, plus
  `pages/{cron,skills,devices,channels,activity,model-setup,model-providers,custodian,workboard,
  skill-workshop,cloud-workers,debug,profile,sessions,board}` and
  `components/{terminal,browser,desktop,board}`.

**RPC surface it consumes (the real API shape to clone):**

| Area | RPCs |
|---|---|
| Chat | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`, `chat.message.get`, `chat.startup` |
| Models | `models.list`, `models.authStatus`, `usage.status`, `sessions.usage` |
| Sessions | `sessions.list`, `sessions.patch`, `sessions.create` (supports `parentSessionKey` + `fork`) |
| Config | `config.get`, `config.set`, `config.patch`, `config.apply`, `config.schema`, `config.schema.lookup` |
| Channels/plugins/skills | `channels.status`, `web.login.*`, `plugins.*`, `skills.*` |
| Automation | `cron.*` |
| Devices/nodes | `device.pair.list`, `device.pair.remove`, `device.pair.approve/reject`, `node.list`, `system.info`, `system-presence` |
| Memory | `doctor.memory.status`, `doctor.memory.dreamDiary`, `wiki.*`, `migrations.memory.plan/apply` |
| Exec | `exec.approvals.*` · Secrets `secrets.store.*` · Voice `talk.*` |

Config writes use a **base-hash guard** so a save never clobbers a concurrent edit; secret values are
never returned after saving; `config.apply` validates then restarts/activates.

### 2.2 WebChat (the chat surface itself)

**Docs:** `web/webchat.md` (191 lines)

- Used by the macOS/iOS native app (SwiftUI, direct WS) *and* the Control UI chat tab.
- **History always comes from the Gateway** — no local file watching; unreachable Gateway ⇒ read-only.
- `chat.send` carries a **dedupe key** (Control UI uses the run id); the Gateway rejects a reused
  key with different mention selections, and identical in-flight retries never create a second run.
- **Submission identity ≠ run id.** Clients reconcile the local pending bubble against the saved
  transcript row, so completion + history reload show exactly one copy.
- **Two data paths:** (1) SQLite transcript rows = durable model/runtime transcript; (2)
  `ReplyPayload` events = live display projection (normalized, block-streamed, media/TTS flags).
  A reply already published in the transcript is not repeated in a later `chat` final.
- History is **bounded**: default page 512 KiB with a 6 MiB hard ceiling; Control UI asks for
  ≤80 messages/256 KiB initially, then ≤1,000 older/1 MiB, following `nextOffset`.
  Oversized rows become fetchable references (`chat.message.get`).
- `windowReset` + `deltaCursor` handle concurrent history changes; stale cursor returns `{kind:"reset"}`.
- Foreground sends include `expectedLeafEntryId` — if another client switched branches, the message is
  parked for review instead of posted onto the new branch.
- Display normalization strips runtime context, delivery directive tags (`[[reply_to_current]]`),
  plain-text tool-call XML, and leaked model control tokens before rendering.
- Assistant text that trims to uppercase `NO_REPLY` is treated as **intentional silence** and hidden.
- `chat.inject` appends an assistant note with **no agent run** (used for command replies,
  aborted partial output, media supplements).
- Extras: TTS "Read aloud" (Gateway-side synthesis), dictation, realtime "Talk"
  (`talk.realtime.mode: "stt-tts"` → Gateway transcribes, the session's agent answers, Gateway speaks).

### 2.3 Resilience pattern (worth cloning)

Disconnects never reset page-local state: catalogs, editors, approval queues, open documents stay in
memory; connection retries use randomized exponential backoff honoring the server's retry delay;
**writes are never replayed** by the reconnect mechanism; sidebar/chat/history load in parallel with
a browser cache that expires after 30 days.

---

## 3. Telegram integration

**Docs:** `channels/telegram.md` + `channels/telegram/*` (10 pages) · **Source:** `extensions/telegram/` (515 files)
**Stack:** `grammy@1.46.0` + `@grammyjs/transformer-throttler@1.2.1`

### 3.1 Runtime model

- Telegram handling runs **inside the gateway process**.
- Replies to a Telegram message go back to Telegram — the model never picks the channel.
- Long polling runs in an **isolated worker**; updates land in a **durable queue** processed in order
  per chat and topic. Webhook mode is optional (needs public ingress — bad on a phone).
- **Single-poller guard** per bot token; persistent `getUpdates` 409 means another poller exists.
  Watchdog restarts the poller after **120 s** without a completed `getUpdates`.
- Startup bounds concurrent `getMe` checks so many accounts don't fan out at once.

### 3.2 Sessions

- Group sessions isolated by group id; **forum topics append `:topic:<threadId>`**.
- DM topic splitting only if `getMe.has_topics_enabled` is true; otherwise flat DM session.
- Replies to the bot count as an implicit mention and start a turn.

### 3.3 Access control

- Default DM policy: **`pairing`** (first DM must be approved). Groups default to **`allowlist`**.
- `allowFrom`, `groupAllowFrom`, `groups.*` (per-chat overrides), per-sender tool policy
  (`direct.<chatId>.tools`), group mention gating (respond only when mentioned, by default).
- Multi-account: `defaultAccount` or `accounts.default` for explicit routing; account-level policies
  inherit the channel root. Every account needs an **agent owner** via top-level `bindings[]`.
- `joinIntro` (default on): one grounded introduction when the bot joins a room.

### 3.4 Live streaming previews

`streaming.mode` = `off | partial | block | progress` (**default `progress`**):

- Sends one editable preview message, then repeated `editMessageText`, finalizing in place.
- `progress` (current default) keeps a quiet **status draft** (headline, commentary, milestones,
  approvals; tool failures hidden) and sends the **final answer as a normal message**.
- `partial` streams the answer text itself into the preview (the pre-2026.8.1 behavior).
- `preview.toolProgress` (default true) folds tool lines into the same preview message;
  `preview.commandText` = `status` (label only) or `raw` (full command).
- Writer-authority rechecked before each queued Telegram request so a replaced turn can't send a stale edit.

### 3.5 Inbound batching (Telegram-specific heuristics)

| Kind | Window |
|---|---|
| Ordinary text | **300 ms** quiet window |
| Non-forwarded message ≥4000 chars | up to **1500 ms** (long-paste continuation) |
| Forwarded burst | **1 s** collection window |
| Photo album | **500 ms** quiet window (holds up to 20 s from first member) |

Batches are isolated by (account, sender, chat, topic) and capped at **12 messages / 50,000 chars /
7.5 s deadline**. Control commands bypass batching. A `0` setting disables ordinary burst batching.

### 3.6 Feature surface

Native commands (`commands.native`, `commands.nativeSkills`), custom commands, inline buttons
(capability-gated), exec approvals rendered inline, photo albums, voice/video notes, locations,
venues, stickers, reactions (`reactionLevel`), media caps (`mediaMaxMb`, fractional allowed),
markdown mode (`off|bullets|code|block` — tables render badly on Telegram), `linkPreview`,
`responsePrefix`, `historyLimit`/`dmHistoryLimit`, error policy + `silentErrorReplies`,
`configWrites`, multi-account, and a **Mini App** (`/controlui`) that opens the Control UI inside Telegram.

### 3.7 Transports

Long polling (default, no inbound port — ideal for a phone behind NAT) vs webhook (needs a public
URL + TLS). **SuparClaw should ship long polling only.**

---

## 4. Tools

**Docs:** `tools.md` (251 lines) + `tools/*` (111 pages) · **75 runtime dependencies** in package.json

### 4.1 Tool vs skill vs plugin

- **Tool** = typed function the model can call. Visible tools are sent to the model as **structured
  function definitions**; only tools surviving profile + allow/deny + provider restrictions + sandbox
  + channel permissions + plugin availability are advertised.
- **Skill** = markdown instructions teaching *how* to use tools (next section).
- **Plugin** = packaged code adding tools, skills, channels, providers, hooks, media, etc.
  (`api.registerTool(...)` + manifest `contracts.tools`; installed from ClawHub/npm/git/dir/archive).

### 4.2 Built-in categories (representative tools)

| Category | Representative tools |
|---|---|
| Runtime | `exec`, `process`, `terminal`, `code_execution` |
| Files | `read`, `write`, `edit`, `apply_patch` |
| Human input | `ask_user`, `secrets` |
| Web | `web_search`, `x_search`, `web_fetch` |
| Browser | `browser` |
| Operator UI | `screen`, `theme` |
| Session progress | `progress_card` |
| Messaging | `message` |
| Sessions/agents | `sessions_*`, `agents_wait`, `subagents`, `agents_list`, `session_status`, goal tools |
| Automation | `cron`, `heartbeat_respond` |
| Gateway/nodes | `gateway`, `nodes` |
| Plugin lifecycle | `plugins` |
| Media | `view_image`, `image_generate`, `music_generate`, `video_generate`, `tts` |
| Large catalogs | `tool_search`, `tool_describe`, `dispatch_action` (experimental) |

### 4.3 Policy mechanics

- **Policy is enforced before the model call** — a removed tool's schema is never sent, so it costs
  no tokens and cannot be hallucinated into use.
- `message` narrows its action list to the channels in the agent's route bindings (union across
  bindings) — schema bytes stay stable regardless of plugin registration order.
- **Exec approvals**: allowlists + ask policy per host (`gateway`/`node`), resolved in Telegram
  inline, the TUI, or the Control UI approvals queue (30-day history).
- **Tool Search / Code Mode**: for very large catalogs, keep schemas out of the prompt entirely and
  let the agent search/despatch. This is the single most token-saving idea in their tool layer.

---

## 5. Skills

**Docs:** `tools/skills.md` (986 lines) + `creating-skills`, `skills-config`, `skill-workshop` · **Source:** `src/skills/` (258 files), bundled `skills/` (72 files, e.g. `skill-creator`, `diagram-maker`, `meme-maker`, `control-ui`, `model-usage`, `himalaya`, `tmux`, `1password`, whisper/whisper-tts)

### 5.1 Format

Each skill = a directory with `SKILL.md`. Minimum frontmatter: `name` + `description`.
Follows the **AgentSkills** spec; YAML parsed first, then a single-line-only fallback;
nested `metadata` blocks are flattened to JSON and re-parsed as JSON5.

```markdown
---
name: image-lab
description: Generate or edit images via a provider-backed image workflow
metadata:
  openclaw:
    requires: { bins: ["ffmpeg"], env: ["IMAGE_API_KEY"], os: ["linux","darwin"] }
---
Use `{baseDir}` to reference the skill folder.
```

Optional keys: `user-invocable` (default true → slash command), `disable-model-invocation`
(instructions kept out of the prompt), `command-dispatch: "tool"` + `command-tool` + `command-arg-mode`
(slash command bypasses the model and calls a tool directly), `homepage`.

### 5.2 Discovery and precedence (highest → lowest)

1. `<workspace>/skills` (per-agent)
2. `<workspace>/.agents/skills` (project agent)
3. `~/.agents/skills` (personal)
4. `<state-dir>/skills` (shared managed)
5. `<state-dir>/agents/<agentId>/agent/workshop-skills`
6. Bundled skills (shipped) · Custodian skills (bundled tier, Custodian agent only)
7. `skills.load.extraDirs` + plugin skills

- `SKILL.md` is discovered **anywhere under a root, up to 6 levels deep**; folder name is
  organization only — identity comes from `name` frontmatter.
- Workspace overriding a bundled skill is a **warning**; other collisions are informational.
- Execution workspaces (worktrees) load their own skills, appended after the agent catalog.

### 5.3 Inventory vs readiness vs visibility

- **Inventory** — discovered in a configured root.
- **Readiness** — runtime can satisfy declared requirements (bins, env, config paths, OS, reachable nodes).
- **Visibility** — ready + eligible + agent allowlist + invocation flags + session snapshot.

A skill can be in inventory but neither ready nor visible → `openclaw skills check` explains why.

### 5.4 Snapshots & refresh

- Skills are **snapshotted when a session starts**; the list is reused until a trigger.
- One background discovery worker scans all file-backed roots; with `skills.load.watch` on,
  fs events trigger rescans; a **30-minute safety rescan** catches missed events; explicit actions
  (install/update/uninstall/edit/config change/gateway start) force an immediate rescan.
- While a scan runs, turns reuse the **last published snapshot** — never block a turn on discovery.
- Unchanged content keeps the same snapshot version and notifies nobody.
- Managed-library skills are versioned **immutable revisions** (hash includes paths, content, sizes,
  exec flags); sessions pin exact revisions; conflict on stale edits; rollback supported.

---

## 6. Agent files (the workspace)

**Sources:** live `~/.openclaw/workspace/` on this device + canonical templates in
`docs/openclaw/reference/templates/` (AGENTS, SOUL, USER, IDENTITY, BOOTSTRAP, BOOT, HEARTBEAT, TOOLS, roles).

### 6.1 The files

| File | Purpose | Loading rule |
|---|---|---|
| `BOOTSTRAP.md` | First-run setup script (create identity, wire workspace) | Followed once, then **deleted** |
| `AGENTS.md` | Workspace conventions, memory rules, red lines, group-chat conduct, automation policy | Every session |
| `SOUL.md` | Personality/tone ("you're not a chatbot, you're becoming someone") | Every session; edits are reported to the user |
| `USER.md` | User model as directives: `<!-- observed: DATE \| status: active -->` + `Prefer…/Never…` | Every session, **4,000-char budget** |
| `IDENTITY.md` | Name / Creature / Vibe / Emoji / Avatar (`- Label: value` lines) | Runtime identity; mirrored to agent config |
| `MEMORY.md` | Durable facts and decisions, curated (not raw logs) | **Main session only** — never groups |
| `memory/YYYY-MM-DD.md` | Daily raw notes | Recent days injected at startup |
| `TOOLS.md` | Local tool/environment notes (camera names, SSH hosts, voices) | Agent workspace section |

### 6.2 How they reach the model

- The runtime injects startup context into the **system prompt under a `# Project Context` section**
  (AGENTS.md, SOUL.md, USER.md, recent daily memory, MEMORY.md in main session). WebChat and TUI
  never copy these into the user message.
- The agent is told: *use runtime-provided startup context first; re-read files only when asked,
  context is missing, or a deeper follow-up is needed* (saves tokens).
- Directives have a lifecycle: mark old entry `superseded` and rewrite the active one — never append
  contradictory active directives.
- Truncated bootstrap content degrades to a short "Bootstrap Context Notice".
- Skills are injected separately, on demand, subject to the snapshot rules in §5.

### 6.3 AGENTS.md contains real operating policy (excerpted, live copy)

- Memory: daily notes raw; `USER.md` stable preferences; `MEMORY.md` curated facts (main session only).
- Read before writing; concrete updates only, never placeholders.
- Periodic maintenance: fold daily notes into USER.md/MEMORY.md, delete outdated entries.
- **Red lines**: no leaking private data; confirm destructive/irreversible actions; inspect existing
  state before changing config/schedulers; prefer `trash` over `rm`.
- **Existing-solutions preflight**: check open-source/plugins/free platforms before building custom;
  recommend paid services only with explicit spend approval.
- **External vs internal**: do freely what was asked; ask first for public/outbound unrequested actions.
- **Group chats**: speak as yourself by default; know when to stay silent; ≤1 reaction per message.
- **Automations - be proactive**: scheduled checks 2–4×/day, reach-out rules, quiet hours
  (23:00–08:00 unless urgent) expressed with **`NO_REPLY`**.

---

## 7. How it all operates, end to end

```
Telegram message ─┐
TUI / WebChat   ─┼─► channel/client adapter
CLI `sc send`   ─┘        │
                          ▼
                 channel envelope (reply metadata, media
                 placeholders, untrusted-content marking)
                          │
                          ▼
        router: agent binding + DM policy (pairing/allowlist) +
                group allowlist + mention gating + per-sender tool policy
                          │
                          ▼
          session key `agent:<id>:<key or chat/topic>` + queue mode
                (steer · followup · collect · interrupt)
                          │
                          ▼
   agent loop (serialized per session): prompt assembly
   (base + # Project Context + skills snapshot + tools schemas)
        → provider stream → tool calls (policy-checked, approvals)
        → hooks (before/after tool call) → compaction at threshold
        → usage accounting → transcript persist
                          │
                          ▼
      live projection (ReplyPayload events) → channel adapter renders
      (Telegram preview edits / TUI tool cards / WebChat blocks)
```

Client-side control of the same daemon: **TUI** and **Control UI** both attach over WS; the CLI is a
WS client too; cron jobs inject turns into sessions; hooks fire around tool calls; nodes (remote
devices) publish tools/skills/terminals over the same protocol.

---

## 8. What this means for SuparClaw

### Clone (semantics are cheap, weight is expensive)

| Surface | SuparClaw plan |
|---|---|
| Daemon + WS protocol | Same shape, subset of methods: `chat.send/history/abort`, `agent.wait`, `sessions.*`, `health` |
| Telegram | grammY long-poll only; same session keys, pairing/allowlist, mention gating, 300 ms batching, `progress` preview mode |
| Skills | Same `SKILL.md` + frontmatter convention, 3-tier precedence (workspace → state → bundled), snapshot at session start + watch |
| Agent files | Identical file set and injection rule (system-prompt `# Project Context`), same 4,000-char USER.md budget |
| Tools | Registry + JSON-schema, policy before model call, exec approval-gated |
| TUI | Thin WS client; local mode optional. Use a minimal TUI renderer (~2–3k lines) instead of a toolkit dep |
| Web UI | **Do not clone 5,957 files.** Serve one small PWA (chat + sessions + config + health) from the gateway on the same port |
| Tool Search | Adopt the idea early — it is the biggest token saver |

### Deliberately skip in v1

Webhooks/TLS ingress, worktrees, swarm/sub-agents, MCP, plugins/marketplace, browsers, media
generation, voice/Talk realtime, nodes/devices, memory "dreaming", GitHub hover cards, 74 locales.

### Perf translation

The TUI and Control UI are *clients*, so making them thin keeps the daemon fast. OpenClaw's cost is
in the daemon's module graph and its 5,957-file web app shipped in the same npm package — SuparClaw
ships the daemon, ships one small web bundle, and lazy-loads the rest.