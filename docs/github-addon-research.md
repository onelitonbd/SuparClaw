# GitHub add-on — research and design

Status: **research only. No code written.** This document is the plan we agree on
before anything is implemented.

The question it answers: *GitHub is our first add-on — how do we make it easy for
a user to start, how do we make the agent actually work on their repo properly,
and do we need a separate coding chat?*

Short answers, then the reasoning:

| Question | Answer |
|---|---|
| Getting started | One command: `sc github connect` → an 8-character code → approved in the browser. **We already own the protocol engine** (`src/agent/oauth-device.ts` is a complete RFC 8628 device-flow client; GitHub needs no new auth code). |
| Working on a repo | The blocker today is that **the workspace is global** (`src/agent/loop.ts:205`, `workspaceDir()`), so every session edits the same folder. Make it **per session**, then give each session its own **git worktree** from one shared clone. |
| Separate coding chat? | **No separate chat surface. Yes to a new session *kind*.** Same chat, but a repo-bound session with a repo header, a changed-files card and a Publish action, grouped under its project in the sidebar. |

---

## 1. What we have today (and what is missing)

Verified against the codebase, not assumed.

| Piece | State | Where |
|---|---|---|
| Device-flow OAuth (RFC 8628) | **Done** — request codes, poll, `slow_down` +5s, denied/expired | `src/agent/oauth-device.ts:67-126` |
| Secret storage (env / file / exec refs) | **Done** | `src/config/secrets.ts`, `sc secrets refs` |
| `fs_read` / `fs_write` / `fs_edit` / `fs_list` | **Done**, jailed to the workspace | `src/agent/tools.ts:169+`, `safePath()` at `:105` |
| `exec` (shell: `git`, `npm test`, `tsc`) | **Done**, default mode `full` = no prompt, 10-min cap | `src/agent/tools.ts:757`, `src/agent/exec-policy.ts:635` |
| Project instruction files (`AGENTS.md` etc.) | **Done** — loaded from the workspace into the prompt | `src/agent/workspace.ts:64-81` |
| Session `meta` column (free-form per-session state) | **Done** | `src/state/db.ts:183-191` |
| Per-session thinking / archived setters | **Done** (the pattern to copy) | `src/gateway/server.ts:844-857` |
| **Per-session workspace** | **Missing** — one global `this.workspace` | `src/agent/loop.ts:205`, used at `:598`, `:881`, `:1118`, `:1200` |
| **Any git/repo concept** | **Missing** — no clone, branch, PR, or diff anywhere | — |
| **Any add-on/plugin concept** | **Missing** — no loader, no MCP | — |
| Background processes (dev server) | **Missing** — `exec` dies at its timeout | — |

So GitHub is not "connect an API". It is **two missing subsystems** (per-session
workspace, repo lifecycle) plus a thin auth layer that we already have.

---

## 2. Getting started: three ways to authenticate

### Option A — GitHub OAuth app, device flow *(recommended)*

Borrowed from upstream (`docs/openclaw/concepts/user-model.md`, "GitHub
connections"): the operator connects with **device authorization**, and the
Gateway keeps the credentials out of browser responses and agent context.

What the user sees:

```
$ sc github connect
  Open https://github.com/login/device and enter: WDJB-MJHT
  (expires in 15 minutes)
  Waiting… ✔ Connected as @onelitonbd
```

What it costs us technically: **almost nothing.** GitHub's device flow is the same
RFC 8628 our model providers already use, ported verbatim:

| Step | Endpoint | Parameters |
|---|---|---|
| Request codes | `POST https://github.com/login/device/code` | `client_id`, `scope` |
| Poll | `POST https://github.com/login/oauth/access_token` | `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` |

Two facts that matter, both confirmed in GitHub's docs:

- **No client secret is needed for the device flow** — only the public
  `client_id` of an OAuth App. We register the app once and ship the id.
- The app must have **device flow enabled** in its settings, or every request
  fails with `device_flow_disabled`.

`src/agent/oauth-device.ts` already implements exactly this shape, including
`slow_down` (+5 s) and `authorization_pending`, so the work is wiring, not
protocol.

**Scopes** — request the minimum that makes the feature work:

| Scope | Why | Note |
|---|---|---|
| `repo` | clone, push branch, open PR on private repos | broad: every repo the user can access |
| `public_repo` | same, public only | the low-trust option |
| `read:user` | show "Connected as @login" | identity check after every connect |
| `workflow` | only if agent edits `.github/workflows/*` | without it, **pushes touching workflows are rejected** |

Start with `repo read:user`; treat `workflow` as an explicit upgrade the UI
offers when a push fails because of it.

**Token lifetime.** An OAuth app can be configured for expiring tokens (8 h) with
a refresh token (6 months). If we ask for `offline_access`, we get expiry even
without the global setting. Recommendation: **use expiring tokens + refresh**, and
refresh on `401`, because a phone gets lost more easily than a laptop.

### Option B — reuse an existing `gh` login

If `gh` is installed and authenticated (`gh auth token` prints a token), accept it.
Upstream explicitly supports this ("An existing `gh` login in the Gateway's
runtime environment is supported"). It is the single easiest path for a developer
who already codes — zero clicks. But it cannot be the *primary* path: `gh` is an
extra install on Termux, and we cannot verify which account it belongs to without
an API call anyway.

### Option C — paste a personal access token

Last resort, for people who refuse OAuth or run GitHub Enterprise. Fine-grained
PAT with Contents: write + Pull requests: write on the chosen repo. Stored through
the existing SecretRef system, never in plaintext config:

```json5
{ secrets: { providers: { main: { source: "file", path: "~/.suparclaw/secrets.json", mode: "json" } } } }
```

### Where the token lives, and where it must never live

**Never in `.git/config` and never in a remote URL.** `git remote -v` prints the
remote, the remote is copied into every worktree, and the agent can read files —
a token in the URL is a token the model can accidentally paste into a reply.

Use a per-invocation credential instead:

```bash
git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64)" push …
```

or a `sc git-credential` helper. The token reaches the one command that needs it
and is never persisted. (This is the same reasoning upstream gives for keeping
credentials out of agent context.)

---

## 3. How the agent works on a repo properly

### 3.1 The blocker: one workspace for everything

```ts
// src/agent/loop.ts:205
this.workspace = workspaceDir();          // ~/.suparclaw/workspace — global
```

Every session, sub-agent, cron job and tool call resolves `ctx.workspace` from
that one value. Two consequences:

- the agent cannot be pointed at a repo without moving *every* session;
- two chats about two repos would fight over one checkout.

**Change:** resolve the workspace per run.

```ts
const workspace = this.workspaceFor(session);   // session.meta.workspace ?? this.workspace
```

and thread it through the four call sites (`:598` sub-agent ctx, `:881` tool ctx,
`:1118` prompt context, `:1200` exec cwd). The `meta` column already exists
(`src/state/db.ts:183`), and `sessions.patch` (`src/gateway/server.ts:844`) is the
established shape for writing per-session state — add `workspace` and `repo` the
same way `thinking` and `archived` were added.

Skills discovery (`loop.ts:231`) also reads the workspace; per-session repos get
their own `.sc/skills` for free once this lands.

### 3.2 Layout on disk

```
~/.suparclaw/
  repo-cache/<host>/<owner>/<name>.git     one shared clone (objects only)
  worktrees/<repo-slug>/<session-slug>/    one checkout per session
```

One **shared clone** plus N **worktrees** means: N sessions on the same repo cost
one object store, not N copies. That matters on a phone.

Clone strategy for Termux/Android, in order of preference:

1. `git clone --filter=blob:none --no-checkout` — partial clone, fetches blobs on
   demand. Months of history without the disk cost.
2. `--depth=1` when the user picks "just the latest" — faster, but `git log`
   becomes useless, so it is a choice, not the default.

Then per session:

```bash
git -C <cache> worktree add -b sc/<session-slug> <worktree-path> origin/<default-branch>
```

**Branch naming** `sc/<slug>` guarantees the agent never commits to the user's
default branch by accident, and makes "which branch did this chat use" obvious in
the sidebar.

### 3.3 Doing the clone ourselves, not via the model

The model must not be the one running `git clone`. Reasons: it can take minutes
(and `exec` is capped at 10 min, `src/config/schema.ts:725`), it needs progress
reporting, it must not spray the token into the transcript, and it must be
cancellable. So: **`sc repo add` / the UI does the clone**, with a progress event,
and the agent starts work only when the worktree is ready — the same ordering
upstream uses for managed worktrees ("completion waits for preparation").

### 3.4 Making the agent *good* at the repo

Tools are half the job. The other half is context and discipline, and we already
have the mechanism — `loadWorkspaceContext()` (`src/agent/workspace.ts:64`) reads
`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md` from the workspace. When the
workspace **is** the repo, the repo's own `AGENTS.md` (or `CLAUDE.md`,
`.cursorrules`, `.github/copilot-instructions.md`) comes along for free. We should:

- read the alias chain (`AGENTS.md` → `CLAUDE.md` → `.cursorrules` →
  `.github/copilot-instructions.md`) so existing repos work untouched;
- on first connect, **offer to write an `AGENTS.md`** from a template filled with
  the repo's real commands (`npm test`, `npm run build`, `tsc --noEmit`), because
  that file is what turns "has the tools" into "can develop";
- add one paragraph to the system prompt for repo sessions: read before editing,
  reproduce before fixing, run the checks, never claim a fix without evidence.

### 3.5 Publish flow (the safe half of autonomy)

The agent may edit and run, but **publishing is a separate, explicit step**:

1. `git status` + `git diff --stat` after each turn → a changed-files card in chat;
2. "Publish PR" (button, or the agent's `github_publish` tool with approval):
   stage → commit (message from the turn) → push branch → open PR (draft by default);
3. never force-push, never push to the default branch, never rewrite published
   history — upstream is explicit that the broker "never rewrites published
   history", and their troubleshooting page exists because agents try.

Guardrails to build in from day one, not later:

- refuse to publish when the diff contains likely secrets (`.env`, `*.pem`,
  long base64/token-shaped strings) unless the user confirms;
- refuse to delete a worktree with uncommitted changes without `--force`, and
  offer "publish the branch first" instead (upstream snapshots before removal);
- one publishing session per branch at a time, so two chats cannot race a push.

---

## 4. Do we need a separate coding chat?

**Recommendation: no separate chat surface. Yes to a separate session kind and
entry point.**

Reasons:

1. **The chat UI already carries everything coding needs** — tool events,
   approvals, artifacts, history, stop/regenerate. A second chat surface means
   two histories, two copies of every slash command, two places for the same bug.
   This project has spent a lot of effort making one surface good; splitting it
   undoes that.
2. **What makes coding feel different is context, not the message stream.** A repo
   session differs by: which folder it lives in, which branch, which files
   changed, and where it publishes. Those are a header, a card and a button — not
   a new app.
3. **The entry point is the part that should be different.** "New chat" and "work
   on this repo" are genuinely different flows (the second needs a repo picker and
   a clone). So: a **New session → Repository** item in the existing `+` menu, the
   same thing from Telegram (`/code <owner/name>`), and `sc code` in the CLI.

What actually changes in the UI:

| Surface | Addition |
|---|---|
| Chat header | repo chip `owner/name`, branch `sc/…`, a "change repo" action |
| After each turn | changed-files card (`3 files, +42 −7`) with a diff link |
| Composer | "Publish PR" appears only when a repo session has uncommitted work |
| Sidebar | sessions grouped under their repository, not only by date |
| Empty state | "Pick a repository" list for a new repo session |

**When a separate section *would* be justified:** a real diff viewer / file tree /
terminal panel is a different surface from a chat pane. If we build that later, it
becomes a tab next to Chat — but that is a second product surface, and it should
be justified by the editor, not by the GitHub integration.

---

## 5. The add-on framework (so #2 is cheaper than #1)

Resist building a plugin system now. Build the *shape*, then generalise when the
second add-on exists. The minimum GitHub needs, which any future add-on shares:

| Concern | Contract |
|---|---|
| Config | `addons.github.{ enabled, repo, ... }` in the schema, one block |
| Credentials | store via existing SecretRef providers; **never** in the config file |
| Connect | `sc <addon> connect` reusing the device-flow engine; UI mirrors it |
| Capabilities | a small registry: `{ id, tools: ToolSpec[], prompt: string }` contributed to the loop |
| Health | `sc doctor` line: connected as, scopes, token expiry |
| Teardown | `sc <addon> disconnect` removes the token and any cached state |

GitHub's contribution to that registry is deliberately small: **three tools**
(`github_repo` for status/branches/PRs, `github_publish`, `github_pr_read`) plus
one prompt paragraph. Everything else is the workspace work in §3, which is not
GitHub-specific — it is what makes *any* repo-facing add-on possible.

---

## 6. Phased plan

### P0 — connect and let the agent work locally *(the real MVP)*
- OAuth app registered, `client_id` shipped; device flow wired through
  `deviceLogin()`; token stored via SecretRef; `sc github status/disconnect`
- per-session workspace (`loop.ts` resolution + `sessions.patch` fields)
- `sc repo add <owner/name>` → cached clone + worktree, progress events
- repo sessions get the repo as workspace; `AGENTS.md` alias chain read
- **Acceptance:** `sc github connect` → `sc repo add` → the agent reads a file,
  edits it, runs the repo's tests, and reports — with no token visible in any
  transcript, `.git/config`, or reply.

### P1 — publish
- `github_publish` tool + "Publish PR" action, draft by default
- changed-files card, secrets guard, no-force-push / no-default-branch rules
- **Acceptance:** a turn's work becomes a draft PR from the chat, and a second
  click cannot double-publish.

### P2 — make it comfortable
- repo picker in the UI (list from the API, not typed by hand)
- CI status on the PR row; read failing checks back into the chat
- issues → "fix this issue" sessions
- multi-repo sessions (only if it turns out to be needed)

### Not in scope, but required for full parity with a coding agent
- **background processes** — a dev server cannot outlive `exec`'s timeout today,
  so "run the app and show me" is impossible until we add process management;
- **portals/preview** — exposing a dev server to the browser;
- **browser/screenshot tools** — for visual verification.

Worth saying plainly: without background processes, the GitHub add-on gives us
*edit + test + PR*, not *develop a web app end to end*. That gap is a separate
piece of work and should not be smuggled into this one.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Token leaks into `.git/config`, logs, or a reply | per-invocation `http.extraheader`; redact in `sc doctor`; a test that greps the repo dir for the token after a session |
| `repo` scope is broad | offer `public_repo`; show the granted scopes in `sc github status`; prefer a GitHub App later (per-repo, short-lived tokens) |
| Phone storage | partial clone + one object store per repo + `sc repo gc`; show size in `sc repo list` |
| Long clone on mobile data | our own clone path with progress + cancel; never the model's `exec` |
| Two sessions on one branch | one worktree per session by construction; publish lock per branch |
| Agent force-pushes / rewrites history | blocked in `github_publish`; the tool refuses and explains |
| Agent commits secrets | pre-publish scan, explicit confirmation required |
| `rm -rf` inside the repo | `exec` sandbox is **off** by default (`schema.ts:732`); recommend `strict` + `sandboxProot` for repo sessions |
| OAuth app token expiry surprises | expiring tokens + refresh on 401, with a clear "reconnect" message |

---

## 8. Open questions for you

1. **Trust level** — should the agent open PRs on its own, or always wait for a
   click? (My recommendation: always wait; it is one tap and removes the whole
   failure class.)
2. **Scope appetite** — `repo` (all your repos) is needed for private-repo push.
   Fine, or should we start `public_repo` only?
3. **One repo per session, or a session that can touch several?** (Recommendation:
   one. It keeps the workspace, the branch and the PR unambiguous.)
4. **Which repo first** — do you want to try this on SuparClaw itself, so the agent
   can be given the same kind of task we have been doing here?

---

## Appendix — the exact calls

```
# Connect
POST https://github.com/login/device/code
  client_id=<public id>&scope=repo%20read:user

POST https://github.com/login/oauth/access_token
  client_id=<public id>
  device_code=<from step 1>
  grant_type=urn:ietf:params:oauth:grant-type:device_code
→ { access_token, token_type, scope, refresh_token?, expires_in? }

# Who am I (run after every connect — the account can change mid-flow)
GET https://api.github.com/user            Authorization: Bearer <token>
GET https://api.github.com/user/repos      (picker list, paginated)

# Repo work
git clone --filter=blob:none --no-checkout https://github.com/<owner>/<name> <cache>
git -C <cache> worktree add -b sc/<slug> <worktree> origin/<default>

# Publish
git -C <worktree> add -A
git -C <worktree> commit -m "<message>"
git -C <worktree> -c http.extraheader=… push -u origin sc/<slug>
POST https://api.github.com/repos/<owner>/<name>/pulls   { title, head: "sc/<slug>", base, draft: true }
```
