# SuparClaw

A personal AI gateway that runs natively on Termux — one daemon, one WebSocket control plane,
channels, tools, skills, sessions, memory files and cron — packaged as a single 600 KB
JavaScript file with **zero native modules**.

Built in the shape of OpenClaw (daemon → gateway → agent loop → tools/skills/sessions), but
designed for a phone: it installs with `npm i -g`, starts in milliseconds, and never needs
PRoot, glibc, node-gyp or systemd.

## Install (Termux)

```bash
pkg install nodejs          # Node >= 24.16
npm i -g suparclaw          # or: npm i -g github:onelitonbd/SuparClaw

sc init                     # workspace files + gateway token
sc doctor                   # verify this device
sc chat                     # open the terminal UI
```

Run the daemon in the background:

```bash
sc service install          # writes a termux-services run script
pkg install termux-services
sv-enable suparclaw && sv up suparclaw
termux-wake-lock            # keep it alive while the screen is off
```

## Configure a model

SuparClaw speaks the OpenAI chat-completions API, so any compatible endpoint works:

```bash
sc config set agents.defaults.model "openai/gpt-4o-mini"
sc config set providers.openai.baseUrl "https://api.openai.com/v1"
sc config set providers.openai.apiKey  "sk-..."

# local models on the phone
sc config set agents.defaults.model "local/qwen2.5"
sc config set providers.local.baseUrl  "http://127.0.0.1:8080/v1"
```

## Commands

| Command | What it does |
|---|---|
| `sc chat` / `sc tui` | terminal UI (embedded runtime, no sockets) |
| `sc tui --url ws://host:port --token …` | terminal UI against a remote daemon |
| `sc gateway` | run the daemon: gateway, channels, cron |
| `sc doctor` | node / sqlite / FTS5 / config / port / disk / skills checks |
| `sc status` | health + effective config summary |
| `sc config get\|set\|path` | read and write `~/.suparclaw/config.json5` |
| `sc pair approve <id>` | allow a Telegram user to DM the bot |
| `sc cron add\|list\|remove` | scheduled prompts |
| `sc service install\|status\|uninstall` | termux-services integration |

Web UI: `http://127.0.0.1:18790/` while `sc gateway` runs (dark/light, same design tokens
as OpenClaw's Control UI).

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

## Measured on a proot Android box (aarch64, 8 cores)

| | SuparClaw | OpenClaw |
|---|---|---|
| install footprint | 1.1 MB, 19 packages | 566 MB, thousands of modules |
| `sc version` (proot) | **1.12 s** | `openclaw --version` 1.6–4.9 s |
| runtime deps | grammy, ws, croner, json5 (all pure JS) | 75 deps incl. native `node-pty`, optional `sqlite-vec` |
| TUI renderer | pure JS, ~250 lines | `@earendil-works/pi-tui` + native addons (no android-arm64 build) |

Bare `node -e ''` on this box costs 0.66 s, so SuparClaw's own startup work is ~0.39 s here and
far less on native Termux.

## Development

```bash
npm install
npm run build        # dist/sc.js + code-split chunks
npm run typecheck
npm test             # 19 tests: config, skills, store, tools, TUI rendering
```

Layout: `src/agent` (loop, llm, tools, skills, workspace), `src/gateway` (http+ws protocol),
`src/channels` (telegram), `src/cron`, `src/tui` (theme, markdown, differential renderer,
editor), `src/cli`, `src/state` (node:sqlite), `src/config` (strict JSON5 schema).

## Design notes

- `docs/suparclaw-architecture-spec.md` — architecture, budgets, milestones
- `docs/suparclaw-ui-design-spec.md` — the TUI/Web design system we clone and why
- `docs/openclaw-surfaces-brief.md`, `docs/openclaw-architecture-brief.md` — the research

## License

MIT. Design tokens and the terminal palette follow OpenClaw (MIT, Copyright OpenClaw
contributors); see `ui/index.html` and `src/tui/theme.ts` headers.