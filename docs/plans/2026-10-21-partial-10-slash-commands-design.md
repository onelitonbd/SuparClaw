# Partial #10 — Unified slash commands (final gap)

Sheet row `Partial!A11` (Skills — "unify TUI + web chat commands; add /dream /title", P3).
Researched against the vendored `docs/openclaw/tools/slash-commands.md` + the
live docs mirror (2026-10-21). Upstream contract kept: the Gateway owns typed
`/<cmd>` text, replies ride the conversation on every channel, and surfaces
may intercept purely client-side commands (`/new`, `/exit` …).

## Before
- TUI-local had its own big `/…` switch; TUI-remote silently dropped most
  commands; web chat/Telegram had none — and shared-router replies (`/queue`,
  `/stop`) were dropped on socket surfaces because the gateway's reply
  callback is intentionally a no-op.

## Locked scope
- Shared routing stays in `service.#commands` (built-ins: /queue /followup
  /steer /stop [-/abort] /subagents) and now delegates the extension set to
  `src/agent/slash-commands.ts`: /help /commands /status /tools /skills
  /exec … /dream [on|off|status|run|log] /title <text> /export-session
  [name] (alias /export).
- Unknown `/<text>` → catalog pointer text (matches Telegram's behavior),
  never fed to the model.
- Command exchanges are recorded in the transcript (user + assistant) and
  broadcast as a normal final/idle chat envelope — web UI + remote TUI
  render them like any reply, and multi-clients stay in sync.
- `/title` reuses the auto-title rename path (+ session.updated event so
  sidebars refresh; manual name also freezes auto-title).
- `/export-session` writes one self-contained HTML card layout into
  `workspace/exports/` with HTML escaping first, then minimal inline md
  (bold/code/links). File names are sanitized (no traversal, no dot-runs).
- `/dream` subs: on/off (config set + re-arm), status (schedule/next/
  last verdict/counters), run (+bare → background sweep), log [full]
  (DREAMS.md tail).
- TUI: local and remote both forward unknown-to-them commands into the
  shared router; only surface-owned cmds stay client-side (quit/exit/
  clear/session/new/model/provider/help).

## Out (deliberate)
- Directives (`/think`, `/verbose`, `/fast`, `/elevated`, `/reasoning`),
  `/model` gateway-side scopes, `/usage` footers, `/mcp` /config /plugins
  chat editors, native Discord/Telegram command *menus*, skill-command
  registration, `/loop`, `/export-trajectory`.

## Verification
- +12 tests (`test/slash-commands.test.mjs`): catalog, unknown-guard,
  status/stop/queue/exec paths, dream toggles+run spy+status, title+
  event, export HTML escaping, transcript purity (recorded+broadcast),
  telegram-surface reply, export path confinement. Suite 221/221.
