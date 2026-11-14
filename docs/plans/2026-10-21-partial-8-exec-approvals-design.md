# Partial #8 — Tools: exec approvals (modes, policies, allowlist, safe bins)

Gap (sheet): *OpenClaw has "advanced modes/policies/elevated" for exec approvals; SuparClaw has "approve once + 10-min hard cap".*

## Their system (vendored docs/tools/exec-approvals*.md + elevated.md + live research 2026-10-21)

- **Policy surface**: `tools.exec.mode` = `deny | allowlist | ask | auto | full`. `auto` adds an LLM reviewer for eligible misses (needs a second model — excluded here, see OUT).
- **Durable approvals ledger** in a host-local SQLite row (`exec_approvals_config`): per-agent `allowlist` entries `{pattern, argPattern, id, source, lastUsedAt, lastResolvedPath}` plus `allow-always` generated grants bound to **exact argv (hashed) + cwd** ("Always Allow Here" semantics).
- **Allowlist matching**: resolved-binary path globs OR bare command-name globs (PATH-invoked only — `./rg` never matches a bare `rg`); `argPattern` = ECMAScript regex over argv (excl. argv[0]); shell chains need **every top-level segment** to match; redirections unsupported in allowlist mode; command substitution rejected.
- **Safe bins**: stdin-only defaults `cut uniq head tail tr wc` run in allowlist mode without entries — positional/path-like args rejected, per-bin denied-flag tables, unknown long/short flags rejected, literals forced via no-shell dispatch, trusted binary dirs `/bin` `/usr/bin` only, PATH never auto-trusted.
- **`strictInlineEval`**: `node -e`, `python -c`, `perl -e`, `ruby -e`… always require a human (defense in depth); never minted into allow-always.
- **askFallback** (default `deny`) resolves a required prompt when no approval surface is reachable. **Elevated** = their sandbox escape hatch; their `full` level skips approvals only when policy is already fully permissive.
- Approval flow: broadcast `exec.approval.requested`, resolve with allow-once / **allow-always** / deny; CLI `openclaw approvals get|resolve|allowlist`, presets `yolo|cautious|deny-all`.

## What ships (our scale — single agent, phone daemon)

1. **`tools.exec` policy knobs** (schema): `mode: deny|allowlist|ask|full` (default `ask`); legacy bool `approvals` kept: `false` ⇒ `full` when `mode` unset (old behavior preserved bit-for-bit). `askFallback: deny|allowlist|full` (default `deny`) — used **only** when no approval surface is connected (browser/TUI). `strictInlineEval` bool (default false, their default) + `safeBins`, `safeBinTrustedDirs` overrides.
2. **Durable ledger in our SQLite `meta` row `exec_approvals`** (`{version:1, agents:{main:{allowlist:[…]}}}`) — same trust-scope pattern as OpenClaw, same store our cron CLI already writes cross-process. Entries: manual `{id, pattern, argPattern?, lastUsedAt, lastResolvedPath}`; generated `allow-always` `{source:"allow-always", pattern:<resolved bin path>, argvHash:sha256(argv·␟), cwd, addedAt}`. Generated entries match only identical argv **and** cwd (their 2026.8 cwd binding).
3. **`src/agent/exec-policy.ts` — the evaluator** (pure, zero-dep): quote-aware chain splitter (top-level `&& || ; |`), argv tokenizer, minimal glob (`* ? **`), PATH resolution, per-bin safe-bin profiles with their denied-flag tables (`tail -f/-F`, `wc --files0-from`, etc.), wrapper unwrap for `env/flock/nice/nohup/stdbuf/timeout/busybox`. Verdict = `allow|deny|ask` + spawn route. Ask-triggering constructs: pipes (single-segment direct-spawn only), redirections, subshells, `$()`/backticks → never auto-allowed, still askable by a human. Deny-triggering: `mode=deny`; `mode=allowlist` misses; interpreter-inline eval under `strictInlineEval` is **ask-or-deny, never auto-allow and never minted**.
4. **No-shell execution route**: single-segment commands satisfied by allowlist/safe-bin run via direct `execFile(argv)` (no shell ⇒ no globbing/expansion — the *only* way safe bins stay stdin-only). Human-approved once and `mode=ask` misses keep the current `bash -lc` route. Both keep the 600 s safety cap (rule 9), workspace cwd, env.
5. **Approval UX — three decisions**: existing WS `chat.approval` learns `{decision:"once"|"always"|"deny"}` (booleans still accepted = once/deny). Web card: Allow once / **Allow always** / Deny (+ policy-denied strip when nothing to approve). TUI: `y`=once, `a`=always, `n`/Esc=deny; new `/exec` slash: `/exec` shows effective mode, `/exec mode <m>` sets an operator **session override** (stored per session like `/model`); gateway session override rounds out parity but TUI+RPC remain the operator surfaces.
6. **No-surface fallback (rule-9 compliant)**: the old 90 s approval timeout is **deleted** — approval waits are unbounded, resolvable or abort-cancellable; when zero surfaces are connected (server clients + local TUI), `askFallback` resolves immediately (`deny` default; `allowlist` re-checks; `full` runs). This also covers cron turns, which otherwise would have hung a serialized run queue behind an unanswered prompt.
7. **`sc approvals` CLI**: `get [--json]`, `mode <m>` (config file, hot-reloads live — task-25 fix), `list [--json]`, `allow <pattern> [--arg-regex re]`, `revoke <id>`, `preset cautious|deny-all|yolo` (mode+askFallback pairing, their names). Ledger writes go through `Store` (cron-add precedent); gateway RPC `approvals.get|setMode|entry.add|entry.revoke` backs the UI.
8. **Settings UI — "Exec & approvals" card**: mode pills, askFallback select, strictInlineEval toggle, entries ledger (live search + compact `.list/.row` rows per rule 8; manual vs always-always badges; revoke). Card shows verdict plumbing state (e.g. "2 entries · last used …").
9. **Doctor `exec` block**: effective mode + entry count; `allowlist` mode with empty ledger → warn; `strictInlineEval` off reminder interpeter-allowlisted; approvals-bool legacy note; exec disabled/mode deny divergence.

## OUT (documented, not papered)

`auto` LLM reviewer (needs a second model + trust budget) · node-host/companion approvals (no nodes) · standing automation grants with minted operator rows (askFallback covers cron) · content-hash file binding of script operands (we re-check resolved **path** at launch instead) · MCP tool grants (no MCP) · `autoAllowSkills` bins (implicit trust; manual entries only) · chat-channel approval forwarding (`/approve` over Telegram/Slack) · pipes/redirection auto-allow & matching spans/highlighting · multi-agent ledgers (shape kept; only `main` minted) · grant expiry days (entries live until revoked).

## Trust-model notes (senior-security review)

- The ledger *tightens* agent behavior; only operators (TUI/CLI/UI with the gateway token) can mint. The agent can never mint or edit entries — minting happens service-side on an operator `always` decision.
- Generated entries are cwd-bound and exact-argv — an agent cannot generalize `rm ./build/x` into `rm -rf`.
- Direct-exec route removes shell injection classes (no glob, no `$VARS`, no `$( )`) for allowlisted traffic; the shell route requires an explicit per-command human decision.
- `PATH` poisoning: bare-name entries resolve fresh at match time and we re-check `lastResolvedPath` on minted entries; direct route executes the resolved realpath.
- Unbounded approval wait (rule 9) cannot stall cron/host: zero surfaces ⇒ immediate askFallback resolution, and abort resolves the waiter as denied.

## Tests (`test/exec-policy.test.mjs` + CLI)

Splitter matrix (quotes/escapes/`&&||;|`/subs/redir/`$()`/backticks) · tokenizer · glob · PATH resolve incl. trusted-dirs · mode×verdict matrix (deny/allowlist/ask/full; session override) · legacy `approvals:false⇒full` mapping · safe-bin grid (allowed bool flags, denied flags — `tail -f`, `wc --files0-from`; grep needs `-e`; positional path reject; unknown long/short reject; trusted-dir enforcement; literal-token direct spawn proof: `wc *` in allowlist mode does **not** expand) · chain rule (one bad segment ⇒ ask) · allow-always mint: exact argv+cwd hit, cwd miss ⇒ ask, revoke ⇒ ask, inline-eval never minted when strict · no-surface askFallback deny · CLI get/mode/list/allow/revoke/preset round-trip · RPC shape · all prior suites stay green.
