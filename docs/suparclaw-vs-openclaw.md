# SuparClaw vs OpenClaw — competitive gap analysis

Research date: 2026-10-20. Sources: the vendored OpenClaw docs in `docs/openclaw/`
(captured from docs.openclaw.ai), the live openclaw/openclaw repository and release
notes, and WebSocket security guidance (OWASP, CSWSH/DNS-rebinding writeups).

## What OpenClaw is (as of v2026.10.x)

- Formerly Clawdbot → Moltbot → OpenClaw. 300k+ stars, 600+ contributors, MIT.
- A full agent platform: Gateway control plane, 20+ channels (WhatsApp, Telegram,
  Slack, Discord, iMessage, …), native apps, OAuth/auth profiles, plugins, sub-agents,
  swarm, browser control, embeddings-based memory, cloud workers.
- It has also been through the fire: CVE-2026-25253 (CVSS 8.8 RCE), the "ClawJacked"
  WebSocket hijack, and 135k+ Internet-exposed instances found in early 2026. Its
  current security guidance is exactly: loopback bind, token auth, origin checks,
  signed skills, `openclaw security audit`.

## Where SuparClaw competes (keep and deepen)

| Axis | SuparClaw | OpenClaw |
|---|---|---|
| Install footprint | ~1.1 MB, 19 packages | hundreds of MB, thousands of modules |
| Runtime deps | 4 pure-JS (grammy, ws, croner, json5) | 75+ incl. native `node-pty` |
| Startup | milliseconds on device | seconds, even `--version` |
| Target device | Termux on a phone, no PRoot/glibc/node-gyp | desktops/servers first |
| Surface | TUI + Web UI + Telegram + cron | everything, and that is the point |

We cannot and should not out-OpenClaw OpenClaw. The competitive thesis is:
**the same agent-loop semantics and the same hard-won security lessons, at 1/500
the size, running on a phone.**

## Where OpenClaw is ahead — and what we adopt

### 1. Gateway security (adopted — see the "ClawJacked" precedent)

OpenClaw learned the hard way: a WebSocket control plane without origin checks is
hijackable from any web page (CSWSH), and a loopback bind without host checks is
reachable via DNS rebinding. OWASP now recommends validating `Origin` with an
explicit allowlist in the `upgrade` handler (not `verifyClient`), plus a Host
allowlist, plus treating "no Origin" (native clients) as a token-required case.

SuparClaw v0.1 had the same hole: no Origin check + `loopbackBypass` default-on +
`config.get` returning raw API keys on the wire. The rework:

- Host allowlist on every HTTP request and WS upgrade (loopback names + configured
  extras) → defeats DNS rebinding.
- Origin allowlist on WS upgrade: same-origin with the request Host, or a configured
  extra origin. Browser connections with any other Origin are refused outright.
- No-Origin (native) clients: allowed, but must present the gateway token when
  `auth.mode == "token"`, even on loopback, unless `loopbackBypass` is explicitly
  kept on (default stays on for the phone-browser UX — but only for connections
  that are same-origin or native).
- Secrets are never serialized on the wire: `config.get` masks `apiKey`/`token`
  fields; writes go through `config.set` which accepts full values.
- WS message size cap; empty gateway token fails closed.

### 2. Agent-loop writer claims (adopted)

OpenClaw records a durable `activeWriterRunId` per session and fences every
transcript write with `expectedWriterRunId` — a superseded run cannot commit stale
transcripts. SuparClaw v0.1 kept an in-memory `#active` map but deleted entries
without checking ownership, so overlapping runs (steer mode) corrupted busy state
and could interleave writes.

The rework keeps one serialized run per session (per-session promise chain),
fences run completion writes behind the run's own id, and makes steer abort-and-
then-run instead of abort-and-overlap. Same invariant, ~40 lines.

### 3. Retry / failover semantics (adopted)

OpenClaw's policy: retry per request, never duplicate delivered output, partial
streams don't reset budgets, auth/billing errors are terminal, honor `Retry-After`.
SuparClaw v0.1 retried a partially-consumed stream (duplicating streamed text into
the answer) and treated every unexpected exception as retryable.

The rework: a stream that already yielded events is never retried; only
`LlmError.retryable` and transport failures retry; `Retry-After` sets the floor;
jittered backoff; SSE parsing tolerates CRLF. Model *fallbacks* stay (they are
turn-local and cheap), but a user-selected model keeps its exact selection —
mirroring OpenClaw's "system-driven fallback never replaces a manual selection".

### 4. Memory search (adopted, scaled down)

OpenClaw does hybrid embeddings + BM25 + recency decay + MMR. SuparClaw v0.1 shipped
a `memory_search` tool that searched one table with a wrong session id — dead on
arrival.

The rework keeps the zero-dep promise: FTS5 (with LIKE fallback) over **all session
transcripts plus memory files**, results labelled by source and date, recency-first
ordering. No embeddings — documented as `fts-only`, and honest about it. That is a
feature on a phone: no model call, no network, no index daemon.

### 5. Security audit command (adopted)

`openclaw security audit` is a differentiator given how many OpenClaw instances were
found exposed. `sc security audit` checks: bind vs auth, token strength, loopback
bypass, origin policy, exec tool state, Telegram policy, config file permissions.
Cheap to build on the existing `doctor` pattern.

## Deliberately not adopted (and why)

- **20+ channels.** Telegram is the phone-native choice; WhatsApp/Slack/iMessage
  pull in native bridges or heavy SDKs. The channel adapter interface exists; more
  channels are additive later.
- **OAuth / auth profiles / SecretRef zoo.** API keys in config are the right
  complexity level for a personal phone daemon.
- **Embeddings memory, sub-agents, swarm, browser control, cloud workers.** Each is
  a dependency or a trust-boundary expansion. Not now.
- **Hooks/plugins.** Skills (markdown, on-demand) cover 80% of the extension need
  with 0% of the plugin API surface.

## Scorecard after the rework

| Area | v0.1 | after rework |
|---|---|---|
| WS/gateway trust boundary | C | A− |
| Agent-loop concurrency | C | A− |
| LLM transport resilience | C+ | A− |
| Memory/search | F (broken) | B (honest FTS) |
| Security posture tooling | none | `sc security audit` |
| Footprint / startup | A | A (unchanged) |
| Channel breadth | D | D (deliberate) |

The bet: a phone-first personal gateway that is **smaller, faster, and now safer
than OpenClaw's defaults** wins a different audience than OpenClaw — people who
want one daemon on one device, not a platform.
