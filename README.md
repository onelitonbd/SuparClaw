<img src="brand/lockup.png" alt="SuparClaw" width="380">

# SuparClaw

**Your phone is the machine.** 🦀

A personal AI gateway that runs natively on Termux — one daemon, one WebSocket control plane,
channels, tools, skills, sessions, memory files and cron — packaged as a single 600 KB
JavaScript file with **zero native modules**.

Built in the shape of OpenClaw (daemon → gateway → agent loop → tools/skills/sessions), but
designed for a phone: it installs with one `curl`, starts in milliseconds, and never needs
PRoot, glibc, node-gyp or systemd.

## Install (Termux)

```bash
curl -fsSL https://raw.githubusercontent.com/onelitonbd/SuparClaw/main/install.sh | bash

sc init                     # workspace files + gateway token
sc doctor                   # verify this device
sc chat                     # open the terminal UI
```

The installer checks Node (installing it with `pkg` on Termux if needed), fetches
only the runtime files — a ~2 MB sparse checkout, not the repository history —
drops them in `~/.suparclaw-install/current`, and wires an `sc` launcher into
`$PREFIX/bin` (or `~/.local/bin`). It needs Node >= 24.16 and nothing else.

```bash
# install from another branch or tag
curl -fsSL https://raw.githubusercontent.com/onelitonbd/SuparClaw/main/install.sh \
  | bash -s -- --ref <branch|tag>

# a private fork needs a token
SUPARCLAW_GITHUB_TOKEN=ghp_… curl -fsSL …/install.sh | bash -s -- --ref main

# elsewhere / custom location
curl -fsSL …/install.sh | bash -s -- --dir ~/suparclaw
```

`install.sh` records the ref it installed in `current/.suparclaw-ref`, so
`sc update` keeps updating **that** ref; `sc update --ref main` switches back.
In a git checkout — including a code session's linked worktree, where `.git` is
a pointer file rather than a directory — `sc update` follows the branch that
checkout is on; `.suparclaw-ref` is the fallback for an unpacked install.

From source instead (needs a build step):

```bash
npm i -g github:onelitonbd/SuparClaw
sc version
```

Run the daemon in the background:

```bash
sc service install          # writes a termux-services run script
pkg install termux-services
sv-enable suparclaw && sv up suparclaw
termux-wake-lock            # keep it alive while the screen is off
```

## Configure a model

The guided path discovers the provider's live model list and sets the default:

```bash
sc setup                   # pick provider → paste key → choose from its models
sc provider add openrouter --api-key sk-or-…   # discovers and saves the model list
sc models --refresh        # re-fetch model lists from every provider
```

SuparClaw speaks the OpenAI chat-completions API, so any compatible endpoint works:

```bash
sc config set providers.openai.baseUrl "https://api.openai.com/v1"
sc config set providers.openai.apiKey  "sk-..."
sc config set agents.defaults.model "openai/gpt-4o-mini"

# local models on the phone
sc config set providers.local.baseUrl  "http://127.0.0.1:8080/v1"
sc config set agents.defaults.model "local/qwen2.5"
```

Model references are validated on write — `sc config set agents.defaults.model`
rejects a reference that does not resolve against the configured providers
(exactly like OpenClaw's `config set`).

### Naming new chats

A chat names itself from what it is about: the first reply in any channel
(web, Telegram, TUI, cron) triggers one small model call over the transcript so
far, and the name is refined once at the second exchange. After that it stops —
and a name you type always wins, the same way OpenClaw treats a manual rename.

By default the naming call runs on the chat model. To use a cheaper one:

```bash
sc config set agents.defaults.utilityModel "openrouter/google/gemini-2.5-flash"
sc config set agents.defaults.utilityModel ""    # back to the default model
```

Settings → Defaults → **Session naming** is the same knob. An empty value is not
an error — it means "same as the default model"; a non-empty one is validated
against the configured providers exactly like `agents.defaults.model`.

## Attachments

Anything you attach in the Control UI or send to the Telegram bot is written to
disk on this device, under `<state>/workspace/media/` — web uploads directly
there, Telegram media under `media/telegram/<chatId>/`. On Termux that is
`/data/data/com.termux/files/home/.suparclaw/workspace/media/`.

What the model sees depends on the type:

| Type | Reaches the model |
|---|---|
| image (png/jpg/webp/gif) | the bytes, inline for that one turn (base64 content parts) |
| everything else (pdf, audio, video, docs) | only a path in the prompt; the agent calls `pdf` / `fs_read` / `exec` to look at it |

A text-only model is not a failure: the image turn is retried once without it
(`[image omitted - provider text-only]`), and PDFs never need vision — the `pdf`
tool extracts text locally. Telegram additionally runs media understanding
(describe / transcribe / extract) before the reply; web uploads do not.

Limits: 4 files per message, 8 MB each, 12 MB total on the web; 10 files,
`channels.telegram.mediaMaxMb` (20 MB default) on Telegram.

Files are kept forever by default. Clicking a file chip in a transcript
downloads the original through the gateway (token-guarded); if a file has been
removed the chip says so. To make the daemon clean up after itself:

```bash
sc config set media.retentionDays 30     # 0 = keep forever (default)
sc media status                          # files, size, oldest
sc media prune --days 30 --dry-run       # what an age prune would delete
sc media prune --orphans                 # files no message references
```

Deleting a chat (`sc sessions delete`, or Delete in the session menu) deletes the
attachments that only that chat referenced; files a fork still points at stay.

## Commands

| Command | What it does |
|---|---|
| `sc chat` / `sc tui` | terminal UI (embedded runtime, no sockets) |
| `sc tui --url ws://host:port --token …` | terminal UI against a remote daemon |
| `sc gateway` | run the daemon: gateway, channels, cron — prints a readiness checklist proving every subsystem is connected |
| `sc setup` | guided provider setup — fetches the provider's model list and sets a default |
| `sc provider add\|list\|remove\|test` | manage providers (add discovers models from `…/models`) |
| `sc models [--refresh]` | model inventory — live fetch from providers with `--refresh` |
| `sc doctor` | node / sqlite / FTS5 / config / port / disk / skills checks |
| `sc security audit` | security posture: bind, auth, origins, exec, channels, file perms |
| `sc status` | subsystem readiness + effective config — probes the **running** gateway when one is up (`live: true`), offline view otherwise |
| `sc config get\|set\|path` | read and write `~/.suparclaw/config.json5` |
| `sc pair approve <id>` | allow a Telegram user to DM the bot |
| `sc cron add\|list\|remove` | scheduled prompts (the agent schedules too: `cron_add`, `cron_list`, `cron_update`, `cron_remove` — each turn's prompt lists which channels are live and the chat ids a result can be delivered to) |
| `sc service install\|status\|uninstall` | termux-services integration |

Web UI: `http://127.0.0.1:18790/` while `sc gateway` runs (dark/light, same design tokens
as OpenClaw's Control UI).

### What a Telegram turn looks like

**Answers only.** The chat never shows what the turn is *doing* — no "Thinking",
no "Working", no stage line, no tool rows, no draft that gets edited in place.
There is nothing to configure here: the status message is not off by default, it
no longer exists.

A turn posts **the answer**, rendered from the model's Markdown into Telegram's
HTML (bold, italics, code, quotes, links; headings become bold and GFM tables
become an aligned monospace block, because Telegram has no table).

**Several answers, delivered as they are written.** A single question can make
the model speak more than once: it says where it is going, runs a tool, then
says what it found. Each of those finished blocks is posted **the moment the
model finishes it** — in order, as its own message, before the turn ends —
instead of the chat staying silent for a minute and then dumping one wall of
text. The final answer posts only the part that has not been said yet, so
nothing is duplicated and nothing is dropped; if the pieces do not line up
exactly (a provider that rewrites earlier text), the whole answer is posted
rather than a guess. Whitespace-only blocks post nothing.

A turn that says nothing posts nothing — no stray `…` bubble. Approvals,
`ask_user` prompts and media are unaffected: they are decisions and files, not
status.

**An answer is never lost to the network.** A turn's answer is persisted and
broadcast to the web chat whether or not the Telegram send succeeds. Transient
failures (a drop, a 429, a 5xx) are retried with Telegram's own `retry_after`;
rejected markup falls back to plain text; and if every attempt fails a visible
notice says the answer is in the web chat — the chat never just stops. An answer
part that cannot be delivered makes the final message carry the whole text, so
a failed block is never silently skipped.

Upgrading from a version that had `channels.telegram.streaming` /
`channels.telegram.toolProgress`: old config files still load — the values are
dropped on read rather than reported as unknown keys, and the settings pages no
longer offer them.

### Chat commands (TUI, web chat, Telegram)

One router answers `/…` on every surface (`src/agent/slash-commands.ts` + `#commands` in
`service.ts`), so `/stop`, `/usage`, `/queue`, `/compact`, `/title`, `/dream`, `/think`,
`/models`, `/context`, `/skills`, `/tools`, `/exec`, `/subagents`, `/export-session` and
`/skill` behave the same wherever they are typed. `/help` and `/commands` print that same
catalog — the list, the help text and the menu cannot drift apart.

Telegram additionally owns `/model`, `/provider`, `/whoami` and `/new`; anything else falls
through to the shared router (it used to answer "unknown command" instead).

**The `/` menu is stored on the bot token, not in this app.** A token that ran another build
keeps showing that build's command list until something replaces it. Telegram stores that list
per **scope**, and a chat scope OVERRIDES the default one — so clearing `default` alone leaves
an old build's commands visible in exactly the chat where they were registered:

| Scope | Who sees it |
|---|---|
| `default` | everyone without a more specific scope — including what BotFather set |
| `all_private_chats`, `all_group_chats` | every DM / every group |
| `all_chat_administrators` | admins everywhere |
| `chat`, `chat_administrators`, `chat_member` (per chat id) | that one chat |

On every start the gateway clears the four wildcard scopes **and** the three chat-scoped ones
for every chat id this device knows (sessions plus both pairing lists), then publishes the
catalog above from `buildCommandMenu()` — 100 entries is the Bot API cap, ours is ~31 including
one command per bundled skill.

The same sweep is available by hand, without a running gateway, because the list lives on
Telegram's servers:

```
sc telegram commands                 # what this token holds now, and how it differs from ours
sc telegram commands --replace       # clear the stale scopes, publish ours
sc telegram commands --purge         # clear them and publish nothing (BotFather owns the menu)
sc telegram commands --token <t>     # any bot — including the ones you created and retired
sc telegram commands --lang bn       # also clear a language-specific list (opt-in)
sc telegram commands --json          # machine-readable; exits 1 when the token is not ours yet
```

Two limits worth knowing. A language-specific list cannot be enumerated by the Bot API at all,
so `--lang` exists for the codes you remember. And a chat scope for a chat this device has never
seen cannot be targeted — start the bot in that chat once and it becomes a known id. Set
`channels.telegram.commandsMenu: false` to keep a menu you curate in BotFather instead.

## How it works

```
Telegram ─┐
TUI ──────┼─► channel/client adapter ─► envelope ─► router (pairing, allowlists,
Web UI ───┘                                               mention gating)
                                   │
                                   ▼
                     session key + queue mode (followup | steer)
                                   │
                                   ▼
        agent loop: system prompt (# Project Context + skills + tools)
                 → streaming model call → tool calls → hooks → persistence
                                   │
                                   ▼
                 live projection → channel renders → SQLite transcript
```

Everything the model knows about you lives in `~/.suparclaw/workspace/`, injected into one
system-prompt section:

| File | Purpose |
|---|---|
| `AGENTS.md` | operating rules, red lines, memory policy |
| `SOUL.md` | personality |
| `USER.md` | dated preference directives (main session) |
| `IDENTITY.md` | name / creature / vibe / emoji |
| `MEMORY.md` | curated durable facts (main session only) |
| `memory/YYYY-MM-DD.md` | daily raw notes |
| `TOOLS.md` | local environment notes |

Skills are markdown packs (`SKILL.md` + frontmatter) discovered from
`workspace/skills` → `~/.suparclaw/skills` → bundled. Only name + "use when" reach the prompt;
the body loads on demand through the `skill_read` tool.

The agent also knows its own configuration. Every turn rebuilds a `## Your configuration`
prompt block from the live config plus this session's overrides — model and fallbacks,
reasoning, `/usage` footer mode, queue mode, exec policy, limits, cron, dreaming, workspace
and config path — so "what model are you on?" or "switch the usage footer to cost" is
answered from facts, not defaults. The `settings` tool (list / get / set) is the write half:
it accepts a fixed allowlist of 17 paths, coerces and validates each value (model refs are
canonicalised against configured providers), writes through the same `ConfigService.setPath`
path the Settings pages use, reads the file back, then applies live. API keys, provider
credentials and the gateway's port/bind/auth are refused by name with the Settings page that
owns them. Only the main session may change settings.

## Measured on a proot Android box (aarch64, 8 cores)

| | SuparClaw | OpenClaw |
|---|---|---|
| install footprint | 1.1 MB, 19 packages | 566 MB, thousands of modules |
| `sc version` (proot) | **1.12 s** | `openclaw --version` 1.6–4.9 s |
| runtime deps | grammy, ws, croner, json5 (all pure JS) | 75 deps incl. native `node-pty`, optional `sqlite-vec` |
| TUI renderer | pure JS, ~250 lines | `@earendil-works/pi-tui` + native addons (no android-arm64 build) |

Bare `node -e ''` on this box costs 0.66 s, so SuparClaw's own startup work is ~0.39 s here and
far less on native Termux.

## When a turn stops early

Two things can stop a running turn, and both now say so in the chat instead of
going quiet:

- **A tool that fails the same way three times in a row** (same tool, same
  arguments, same error). This guard is always on — retrying a broken call is
  never going to work — and it costs nothing to leave alone: any change in the
  arguments or the result resets it, so normal retries and polling never trip it.
- **The tool-round budget** for one turn (`agents.defaults.maxToolIterations`,
  default 12, no upper limit). When it runs out the assistant says so and
  "continue" picks the work back up.

Either way the turn ends with an explanation and a way forward, not with
silence. A stricter layer — which also counts *successful* repeat calls, useful
for small models that spin on the same read — is opt-in:

```bash
sc config set tools.loopDetection.enabled true
```

It is off by default because it cannot tell a loop from ordinary work that
happens to call the same thing repeatedly (three `cron_list` reads while
answering, for instance). Turning it off also disables the post-compaction
retry guard, matching upstream.

## Security

The gateway is a control plane that holds your API keys and can run tools — it is
built like one (see `docs/suparclaw-vs-openclaw.md` for the lessons behind this):

- **Host allowlist** on every HTTP request and WS upgrade (loopback names,
  private IPs on LAN binds, `gateway.allowedHosts` for proxies) — defeats DNS
  rebinding.
- **Origin allowlist** on the WS upgrade — same-origin or
  `gateway.allowedOrigins`; hostile pages cannot open `ws://127.0.0.1:…` (CSWSH).
- **Token auth is fail-closed** — an empty token never authorizes anyone; this
  device's own browser is exempt only on loopback (`auth.loopbackBypass`).
- **Secrets never travel on the wire** — `config.get` returns sentinels
  (`__redacted__:…`), `config.set` maps them back to the stored values.
- **exec is on by default, approved without a prompt** — an agent that has to ask before
  every command cannot act on its own. Tighten it with `sc approvals mode ask` (prompt
  per command) or `allowlist` (safe bins only); `sc security audit` reports the mode.
- **`terminal` is the same power with memory** — a persistent shell (or several) the agent
  drives and you watch live in the web UI; same approval mode as exec, no sandbox by design.
  `tools.terminals.max` / `scrollbackKb` / `waitMs` bound the resources, not the permissions.

Run `sc security audit` after any config change.

## Development

```bash
npm install
npm run build        # dist/sc.js + code-split chunks
npm run typecheck
npm test             # config, skills, store, tools, TUI, gateway contract, security
```

Layout: `src/agent` (loop, llm, tools, skills, workspace), `src/gateway` (http+ws protocol),
`src/channels` (telegram), `src/cron`, `src/tui` (theme, markdown, differential renderer,
editor), `src/cli`, `src/state` (node:sqlite), `src/config` (strict JSON5 schema).

## Design notes

- `docs/suparclaw-vs-openclaw.md` — gap analysis vs OpenClaw and what we adopt/refuse
- `docs/suparclaw-architecture-spec.md` — architecture, budgets, milestones
- `docs/suparclaw-ui-design-spec.md` — the TUI/Web design system we clone and why
- `docs/openclaw-surfaces-brief.md`, `docs/openclaw-architecture-brief.md` — the research

## License

MIT. Design tokens and the terminal palette follow OpenClaw (MIT, Copyright OpenClaw
contributors); see `ui/index.html` and `src/tui/theme.ts` headers.