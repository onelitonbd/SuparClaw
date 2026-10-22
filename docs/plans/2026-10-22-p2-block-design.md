# P2 block — locked design (sheet `Missing!A7:A18`, ids #6–#17)

12 rows, 11 commits, ~5.5–7h. Researched against vendored `docs/openclaw/`
(usage-tracking, loop-detection, ask-user, exec + exec-approvals, cli/sandbox,
cli/sessions, cli/logs, cli/update, cron-jobs/{index,delivery,schedules},
channels/bot-loop-protection, concepts/usage-tracking) and the live
docs.openclaw.ai (loop-detection PR #167628 three-identical-errors is current;
ask_user schema 1–3 questions, options 2–4, Other always, Skip everywhere,
timeout 900s clamp 30–3600 — TIMEOUT DROPPED per our no-time-limits rule:
questions stay pending until answered/skipped/cancelled).

## A18 — Bot-loop protection (telegram)
Upstream: `channels.defaults.botLoopProtection{enabled:true,
maxEventsPerWindow:20, windowSeconds:60, cooldownSeconds:60}` + per-channel
overrides + `allowBots` admission flag.
Ours: schema `channels.telegram.allowBots:false` (ignore bot-authored
messages), `channels.defaults.botLoopProtection{enabled,maxEvents,
windowSeconds,cooldownSeconds}` + `channels.telegram.botLoopProtection`
override layer (merged key-by-key). `src/channels/bot-guard.ts`: pair key
(senderBotId↔ourBotId, chatId) sliding-window event budget → cooldown
suppression + log line. Human messages untouched; self-messages stay filtered.

## A8 — Tool-loop detection
Upstream PR #167628: ALWAYS break after 3 consecutive identical tool ERRORS
(same tool+args+error), independent of flags, recovery-guidance run error;
`tools.loopDetection.enabled:false` gates rolling detector; post-compaction
guard on unless enabled===false.
Ours (loop.ts): signature = `${name}:${args}:${output.slice(0,200)}` — errors
track a streak (always-on, ends run with guidance error, streak resets on any
changed/successful call); when `tools.loopDetection.enabled:true`, ANY
identical (tool,args,result) triple inside a 10-call rolling window also
breaks the run; post-compaction guard arms after our overflow-compaction
retry using the same triple rule (same flag, enabled unless explicitly false).

## A7 — Usage & cost
Sheet: store in runs + per-reply footer + sc usage. Ours: runs table gains
`model` (idempotent ALTER; finishRun(model,usage) attribution). `/usage
off|tokens|full|cost` per-session pref (store meta `usage:<sessionKey>`);
final replies append a one-line footer `⏱ 12.4k in · 3.1k out (x/y model)`
when pref != off; `full` adds cost estimate when a price exists.
`agents.defaults.pricing` record model→{input,output} per 1M tokens (empty by
default, tokens-only display). `/usage cost` = today/7d/30d/session totals +
priced estimate. `sc usage [--days N] [--model m]` store-backed CLI summary.
OUT: provider admin-API quota endpoints, dashboard charts.

## A16+A15 — Cron timezone + delivery
A16 (sheet asks the cron.timezone key to be honored): croner already vendored
— pass `{ timezone: cfg.cron.timezone !== "local" ? cfg.cron.timezone : undefined }`;
per-job `tz` column override (`sc cron add --tz`). `sc cron ls` shows tz.
A15: jobs gain `delivery_mode none|announce|webhook`, `delivery_to`
(chat session key incl. telegram:<chat>, or URL for webhook),
`delivery_suppress_empty:1` default. Scheduler fire → build result; announce →
service.deliverExternal(sessionKey,text) → telegram channel sink when bound
(falls back to main-session transcript + WS event); webhook → POST JSON
`{job,runAtMs,status,text,error}` with strict SSRF guard (loopback/private/
link-local refused unless host ∈ `cron.webhookAllowHostnames[]`, one exact-
host exemption list — dangerousAllowPrivate NOT implemented, strict only);
none → job_runs row only. Empty text suppresses announce+webhook (recorded
`empty`). Failure alerts: `cron.failureAlerts{enabled:true, threshold:2,
cooldownMinutes:60, to:"telegram:<chat>"}` — error streak ≥ threshold DMs the
target with job name + error; first successful run clears streak; per-job
cooldown map. OUT: Inspect links (no public origin), retries of ambiguous
sends, task reconciliation phases.

## A12/A13/A14 — CLI trio
A12 `sc sessions`: `list [--json|--all]`, `rename <key> "name"`, `delete
<key> [--yes]` (transcript + summary rows), `show <key>`. Store-offline like
`sc cron` (gateway-hot list not required).
A13 `sc logs [-f] [--tail N] [--file service|gateway] [--search re]`: tails
`<state>/logs/service.log` (default) or `suparclaw.log`, plain + `--json`.
A14 `sc update [--check] [--ref X]`: current build stamp = git ref baked at
install (dist/BUILD_INFO or package version + install state marker);
--check → GET api.github.com repos/onelitonbd/SuparClaw/commits/<ref> sha vs
local stamp → report. Full: codeload tarball → extract to tmp → npm ci +
build → atomic swap dist + package files → re-run install.sh service wiring
step (systemd/termux reload handled by existing installer) → "restart the
gateway". No auto-restart. Channels/repair OUT.

## A10/A11 — Exec sandbox & unattended
A10 `tools.exec.sandbox:"off"|"strict"` (default off so nothing regresses —
`doctor` warns): strict = (a) cwd jail: resolved workdir must stay inside the
session workspace (403-style tool error otherwise), (b) env scrub to
`PATH=/usr/local/bin:/usr/bin:/bin` + LANG/TZ/HOME only, (c) `prlimit` when
present: `--as=2GB --nproc=256 --nofile=1024`, (d) Termux `proot` when its
binary exists AND `tools.exec.sandboxProot:true`: bind workspace read-write,
/tmp + system bins read-only. Safe-bin allowlist continues to apply first.
Docker/openshell OUT per scale.
A11 `tools.exec.unattended:"deny" (default)|"allowlist"|"all"`: when run
source ∈ {cron, webhook} and approvals surface is absent, exec approval
auto-resolves per policy instead of hanging: deny → tool error
`[unattended: denied]`; allowlist → auto-approve ONLY safeBins-listed
commands, deny others; all → auto-approve. Every auto-decision → `tool_log`
row + `[unattended exec policy: <decision>]` line in transcript +
`/approvals` audit view (already exists).

## A9 — ask_user tool
Schema: `{questions:[{id,header,question,options[2..4],multiSelect?}] 1..3}`.
Main-session + supported surfaces only (webchat/telegram/CLI-TUI reads text
fallback): loop calls `deps.askUser(questions, ctx)` → service pending map;
WS event `question{askId,questions[0]}` → web UI option card (approve-style
inline card over composer); telegram: single-select single-question → inline
keyboard (choice buttons + 📝 Other + ⏭ Skip); multi/n-select → numbered
plain-text prompt; plain-text reply resolves (number/label/custom, commas for
multi) when a question is pending — intercepted in #onMessage before queueing.
Skip resolves `{skipped:true}`; cancel/abort resolves error. No timeout (rule
9) — pending until answer/skip/abort. `/question` slash reopens (replays the
WS event / re-sends telegram card). Subagents never see the tool (not in
their registry) + provider-schema marks main-only via description. Tool
result = `{answers:{<id>:(label|custom text)，…}}` appended as a tool row;
sensitive-note in description (never credentials).

## A17 — Telegram approval buttons
service.onApproval already exists per payload — telegram payload.onApproval:
send inline keyboard `[✅ Once] [✅ Always] [❌ Deny]` with callback_data
`appr:<callId>:<d>+<chatId>`; `#onCallbackQuery` resolves
`service.resolveApproval(callId, decision)` (only paired users), edits the
message to `✔ approved (once) ✅ by <name>`/✖, answers the callback.
Unknown/stale callId → "this approval already resolved". Web-UI card keeps
working in parallel (resolveApproval is idempotent-false → second surface
gets "already resolved" turned into a harmless notice via events).

## Verification plan
test/bot-guard.test.mjs (~6), tool-loop additions in new
test/tool-loop.test.mjs (~7), test/usage.test.mjs (~7),
test/cron-delivery.test.mjs (~9 incl. tz eval + SSRF), CLI tests spawn `sc`
child procs in test/cli-p2.test.mjs (~8), test/exec-sandbox.test.mjs (~7),
test/ask-user.test.mjs (~8), telegram approvals in test/telegram-approvals
(~6). Per-feature: build + full suite, push, tick the exact row.
