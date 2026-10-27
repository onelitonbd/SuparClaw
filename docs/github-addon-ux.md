# GitHub add-on — UI/UX design for web, TUI and Telegram

Status: **design only. No code.** Companion to `docs/github-addon-research.md`
(which covers auth, workspace, and repo lifecycle). This document answers: what
does the user actually see and do, on each surface, when GitHub is switched on?

---

## 0. Decisions (locked with you)

| # | Decision | Consequence for the design |
|---|---|---|
| 1 | **PRs only when the user asks.** A session may produce several PRs over its life; nothing publishes on its own. | Publishing is always an explicit action; the agent's closing line is a prompt, never an action. |
| 2 | **Public + private** → OAuth scope `repo` + `read:user`. | The picker lists private repos too, with a lock icon; the consent screen says what the scope means. |
| 3 | **One repo per session.** | The repo is a property of the session, fixed at creation (rebind only while it has no work). |
| 4 | **New session asks the kind.** Chat starts instantly; Code asks for the repo first. Same question on all three surfaces. Connect = device flow **and** an existing `gh` login. | `+` opens a two-row sheet; the repo list is the second phase of the same sheet. |

---

## 1. The model: a session *kind*, not a room

A coding session is a **normal session with three extra facts**: a repo, a branch,
and a worktree. Everything else — chat, streaming, tools, approvals, stop,
regenerate, history, export — is unchanged. That is why this is not a separate
app section.

```
session
├── kind: "chat" | "code"
├── repo: "onelitonbd/SuparClaw"        (code only, immutable once work exists)
├── base: "main"                        (the branch it was cut from)
├── branch: "sc/swift-otter"            (ours; never the default)
└── worktree: ~/.suparclaw/worktrees/…  (the workspace for this session)
```

Three consequences the whole design follows from:

1. **Nothing new to learn.** A code session chats exactly like a normal one.
2. **The difference is visible, not modal.** A slim repo bar replaces the guesswork
   of "which folder is this thing in?".
3. **Safety lives in the bar, not in a dialog you see once.** Branch, changes and
   publish are always one glance away.

### Design principles

- **One extra tap, never more.** Chat stays the default path and stays instant.
- **The question is asked once.** Kind is chosen at creation; changing it later is
  an explicit action, not an accidental one.
- **The repo bar is the truth.** Repo, branch, changed files and publish state live
  in one 32 px strip, not scattered.
- **Progress rides the draft we already have.** No new status messages (Task 32).
- **Failure is a sentence and a button**, never a spinner that stops.

---

## 2. Web (Control UI)

Every flow below is reachable in **three actions from a cold start**: `+` → kind →
repo. The chat path stays **one** action, exactly as today.

### 2.1 New session — the question

Both entry points (`+` in the rail, **New chat** in the drawer) open the same
sheet. This is the one place the flow gains a step, so it is keyboard-first:
`Enter` = Chat, `↓ Enter` = Code, `Esc` = cancel.

```
┌──────────────────────────────────────┐
│                 ▬                    │   .sheet (existing component)
│  New session                         │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 💬  Chat                    ⏎  │  │   ← focused row, Enter starts it
│  │     Talk, research, files      │  │
│  ├────────────────────────────────┤  │
│  │ ⌘   Code a repository          │  │
│  │     Pick a repo, work on a     │  │
│  │     branch, open a PR          │  │
│  └────────────────────────────────┘  │
│                                      │
│  GitHub: @onelitonbd  ·  Change      │   ← connection line, only if connected
└──────────────────────────────────────┘
```

Not connected yet? The second row becomes the way in — no dead end:

```
│  │ ⌘   Code a repository          │  │
│  │     Connect GitHub to start    │  │
│  │     → a code in your browser   │  │
```

Tapping it opens the connect dialog (2.6) **as a sheet on top**, and on success
returns to this list with repos loaded.

**Copy decisions**
- "Code a repository", not "Coding session" — it says what will happen.
- The subtitle names the payoff (branch, PR), which is what a first-time user
  cannot infer.

**Accessibility.** The sheet becomes a *required decision*, so it must behave like
a dialog: focus moves into it on open, `Tab` cycles inside it, `Esc` cancels and
returns focus to `+`. The existing `pickModel` sheet only handles `Esc` + scrim
(`ui/src/picker.ts:31`) — a focus trap is new work, and it is required here.

### 2.2 Repo picker (phase 2 of the same sheet)

```
┌──────────────────────────────────────────────┐
│ ‹ Back      Pick a repository                │
│ ┌──────────────────────────────────────────┐ │
│ │ Filter repos…                            │ │
│ └──────────────────────────────────────────┘ │
│ RECENT                                       │
│  ⌘ onelitonbd/SuparClaw      private · 2h    │
│  ⌘ onelitonbd/landing        public · 4d     │
│ YOUR REPOSITORIES                            │
│  ⌘ acme/api                  private         │
│  ⌘ acme/docs                 public          │
│  …                                           │
│ ──────────────────────────────────────────── │
│  ＋ Clone by URL…        ⟳ Refresh           │
└──────────────────────────────────────────────┘
```

- **Recents come from our own store**, not GitHub's order: the repos *this*
  installation has worked in, most recent first. One row, one tap, done.
- **Row anatomy:** `owner/name` (mono), then `private · main`, then last-used.
  Private repos carry a 🔒 so nobody wonders why a repo is missing from someone
  else's view.
- **Filter** is the existing sheet filter (`pickModel` behaviour: type to narrow,
  ↑↓, Enter, Esc).
- **Scale:** first page = 50 repos by pushed date; typing calls the search
  endpoint. An org with 900 repos never sees a 900-row list.
- **`Clone by URL…`** covers repos the token cannot enumerate (someone else's
  public repo, an Enterprise host).
- **Refresh** exists because a brand-new repo on GitHub is not in a 5-minute cache.

Choosing a repo closes the sheet immediately and shows the chat **with the repo bar
in `Cloning…`**, so the user sees work starting rather than a blank screen.

**While the clone runs, the composer is not a lie.** It stays enabled only for
reading the transcript; the input shows a placeholder and refuses to send:

```
│  Message the agent…                    │  ← disabled
│  Preparing the repository — you can type when it's ready   │
```

A message sent into a half-cloned worktree would be answered from an empty repo,
which is worse than a two-second wait. The queued draft is not lost — the text
stays in the box, so the user can hit send the moment it flips to ready.

**Empty and error states of the picker:**

| Situation | What the sheet shows |
|---|---|
| Connected, zero repos | `No repositories yet — create one on GitHub, then Refresh.` |
| API rate-limited / offline | `Couldn't load repositories (rate limit). Retry in 4 min.` + `[Retry]` |
| Repo list stale after a create | `Don't see it? Refresh` (explicit, not automatic, to save the rate budget) |

### 2.3 The repo bar

One strip between the rail and the thread, only in code sessions. 32 px, no
wrapping; on narrow screens the publish button becomes an icon.

```
┌──────────────────────────────────────────────────────────────┐
│ ⌘ onelitonbd/SuparClaw · sc/swift-otter · 3 files +42 −7  [Publish PR] │
└──────────────────────────────────────────────────────────────┘
```

Every state this bar can be in, with its exact copy:

| State | Bar shows | Action |
|---|---|---|
| Preparing | `⌘ onelitonbd/SuparClaw · cloning… 42%` | tap = cancel |
| Failed | `⚠ clone failed — retry` | tap = retry, long-press = details |
| Ready, clean | `⌘ onelitonbd/SuparClaw · sc/swift-otter · no changes` | Publish disabled |
| Work in progress | `⌘ … · sc/… · working…` | — |
| Changed | `⌘ … · sc/… · 3 files +42 −7` | tap = changed-files modal; Publish enabled |
| Pushing | `publishing…` | — |
| PR open | `⌘ … · PR #12 open ↗` | tap = GitHub |
| Stale token | `⚠ GitHub reconnecting…` | tap = connect sheet |
| Repo gone | `⚠ repository unavailable` | tap = unbind / repick |

The bar is **derived from the open session**, so switching chats switches it,
including into a normal chat where it disappears entirely. It is never a global
"current repo" indicator — that would be a trap in a multi-session app.

Design notes:
- The **branch is always visible** — it is the answer to "where is my code?".
- **Publish is disabled, not hidden**, when there is nothing to publish: a control
  that appears and disappears is harder to learn than one that is visibly off.
- The bar is `role="status"` so a screen reader announces the state change without
  interrupting typing.

### 2.4 Changed files (modal, not a page)

Tapping the file count opens the existing `modal()`:

```
┌────────────────────────────────────────────┐
│ Changes in this session                    │
│ sc/swift-otter → main                      │
│                                            │
│  src/config/schema.ts          +8  −2      │
│  ui/src/settings.ts           +21  −4      │
│  test/ui-config-page.test.mjs  +3  −1      │
│                                            │
│ [ View diff ]    [ Publish PR ]   [ Close ]│
└────────────────────────────────────────────┘
```

`View diff` opens the same modal with one file's unified diff in a `<pre>` (the
markdown renderer already draws code blocks). No editor, no tree: this is a
review surface, not an IDE. Adding a file tree is what would justify a separate
tab later — not this.

### 2.5 Publish (only ever on request)

The button and the tool share one dialog. It is the only place a push can happen.

```
┌──────────────────────────────────────────────┐
│ Publish to onelitonbd/SuparClaw              │
│                                              │
│  Branch   sc/swift-otter → main              │
│  Changes  3 files, +32 −7                    │
│                                              │
│  Title   [ Fix the settings count          ] │
│  Body    [ (optional)                      ] │
│                                              │
│  ☑ Draft pull request                        │
│  ⚠ 1 file looks like it may contain a        │
│    secret (.env.local) — review first        │
│                                              │
│  [ Preview diff ]            [ Publish ]     │
└──────────────────────────────────────────────┘
```

- **Default: draft PR.** Turning it into ready-for-review is one click on GitHub;
  undoing an unwanted review request is not.
- The **secret warning blocks nothing** but requires a second tap ("Publish
  anyway") — a speed bump, not a wall.
- After success the sheet becomes a confirmation with the PR link, and the repo
  bar becomes `PR #12 open ↗`.
- **Several PRs are allowed** across a session: after the first, the bar shows
  `PR #12` and Publish starts a *new* branch from the published one. The rule the
  agent follows: it may publish again only when asked again.

### 2.6 Connect GitHub (shared by Settings and the new-session flow)

One dialog, both routes, `gh` first when it exists:

```
┌──────────────────────────────────────────────┐
│ Connect GitHub                               │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ ✓ Use this machine's gh login          │  │   ← only when `gh auth token` works
│  │   @onelitonbd · verified                │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ── or ──                                    │
│                                              │
│  Continue with GitHub                        │
│  We'll show a code to enter on github.com.   │
│  Repos are read, branches are pushed only    │
│  when you ask.                               │
│                                              │
│                              [ Continue ]    │
└──────────────────────────────────────────────┘
```

Device-flow step (the code is the whole interaction, so it gets the space):

```
│  Enter this code on GitHub                    │
│                                              │
│        ┌────────────────────┐                │
│        │   W D J B – M J H T │  [ Copy ]     │
│        └────────────────────┘                │
│                                              │
│  [ Open github.com/login/device ↗ ]          │
│  Waiting for approval…          (14:32 left) │
│  ▓▓▓▓▓▓▓▓▓▓░░░░░░░░                          │
```

States: waiting → connected (`✓ Connected as @login`, auto-advance to the repo
list) → denied (`You cancelled — nothing was connected.`) → expired (`The code
expired. Generate a new one.` with a button) → `device_flow_disabled`
(`This OAuth app has device login turned off — use a personal access token
instead.` with a PAT field). Every terminal state has exactly one next action.

**Where it lives afterwards:** Settings → **Add-ons → GitHub** — connection card
(avatar, `@login`, granted scopes, repo count, "Disconnect"), with the same dialog
behind "Reconnect".

### 2.7 Empty state of a code session

The first screen decides whether the user trusts this feature. It must prove the
agent knows what it is standing in.

```
        ⌘ onelitonbd/SuparClaw
        main · 1,284 files · TypeScript

        AGENTS.md found — the agent will follow it.
        (or:  No AGENTS.md — [ create one from this repo ] )

        Try:
        · where is the settings count computed?
        · fix the failing test in test/ui-config-page.test.mjs
        · add a --json flag to sc media status
```

The `AGENTS.md` line is the single highest-value detail in this design: it tells
the user their own repo instructions are being read, and offers the one action
(create one) that most improves the agent's work.

### 2.8 What the agent is told (the part that makes it *good* at the repo)

The surfaces are the easy half. A code session also changes the prompt — three
short blocks, no more:

```
## Repository
onelitonbd/SuparClaw · branch sc/swift-otter (from main) · 1,284 files
Workspace: /home/…/worktrees/suparclaw/swift-otter

## How to work here
Read a file before editing it. Reproduce a bug before fixing it.
Run the project's checks (`npm test`, `npm run build`) before saying it works.
Say what you verified and what you did not.

## Publishing
Publish only when the user asks in this turn. Never force-push.
Never push to `main`. One PR per request; ask before starting another.
```

Plus the repo's own `AGENTS.md` (or `CLAUDE.md`, `.cursorrules`,
`.github/copilot-instructions.md`) via the existing workspace loader
(`src/agent/workspace.ts:64`) — which is why 2.7 shows whether it was found.

This is the difference between "has `fs_edit`" and "can be trusted with the repo",
and it costs one template string, not a feature.

### 2.9 Sidebar

**No re-grouping.** Date buckets stay (`bucketOf`, `ui/src/sessions.ts:36`, six
tests). Instead:

- a **repo chip** on every code row: `⌘ SuparClaw`, dim, before the timestamp;

```
│ All · SuparClaw · website │            ← filter chips, scroll on mobile
│                                          │
│ TODAY                                    │
│  ✓ Fix the settings count   ⌘ SuparClaw  14:02 │
│  Chat about the deploy                   13:40 │
│ YESTERDAY                                │
│  ✓ add --json to media      ⌘ SuparClaw  —     │
```

- a **filter row** above the list once any code session exists:

```
│ All · SuparClaw · website │     ← chips, horizontally scrollable on mobile
```

Tapping a repo chip filters to that repo; `All` restores. This gives repo-scoped
views without breaking recency — the thing people actually navigate by.

### 2.10 Binding a repo to a chat that already exists

The common real case: the user starts chatting, *then* decides it is a coding
task. Forcing a new session would throw away the context that just formed, so a
normal chat can adopt a repo — once.

- **Where:** the rail's session menu (`session-btn`) gains **"Work in a
  repository…"**, shown only when the session has no repo.
- **Flow:** the same picker (2.2) → the chat reloads its context against the
  worktree and the bar appears.
- **Guard:** allowed only while the session has **no repo yet**. Rebinding a live
  code session to another repo is refused with a sentence, not a disabled control:
  `This session is working in onelitonbd/SuparClaw. Start a new session for
  another repository.` Silent rebinding would mean history that refers to files
  that are no longer there.
- **Cost:** the earlier turns' file references point at the old workspace. The
  agent is told this in one line (`This session adopted the repository after N
  turns; earlier file paths may not resolve.`), so it re-reads instead of guessing.

### 2.11 Mobile (a first-class target, not a shrink)

- The sheet is already full-width at the bottom; rows are 48 px (`--tap`), which
  is the existing touch contract.
- The repo bar collapses to: `⌘ SuparClaw · 3 files` + `[↥]` publish icon.
- The repo picker's filter input is focused on open *only on non-touch*; on touch
  it stays behind a tap, because a keyboard covering the list is worse than one
  extra tap.
- Publish dialog becomes a full-height sheet; the title field is the only input.

---

## 3. TUI

The TUI already owns a filtered overlay picker and a metadata footer. Nothing new
is invented — the same question, in the same voice.

### 3.1 New session: `ctrl-g`

`ctrl-g` is parsed (`src/tui/keys.ts:19`) and unbound; `ctrl-n` is not in the key
union, so binding it would mean touching the parser for no benefit.

```
 $ ctrl-g
 ┌ new session ────────────────────────────┐
 │ filter: ▏                               │
 │ ❯ chat — talk, research, files          │
 │   code — pick a repository              │
 │ ↑↓ select · ⏎ pick · esc cancel         │
 └─────────────────────────────────────────┘
```

Choosing `code` opens the **same overlay** with the repo list (recents first,
filter works, 12 rows max as today):

```
 ┌ repository ─────────────────────────────┐
 │ filter: ▏                               │
 │ ❯ onelitonbd/SuparClaw   private · 2h   │
 │   onelitonbd/landing     public · 4d    │
 │   acme/api               private        │
 │ ↑↓ select · ⏎ pick · esc cancel         │
 └─────────────────────────────────────────┘
```

Not connected: the `code` row reads `code — connect GitHub first…` and picking it
prints the device code as a system line with the URL, then keeps polling:

```
 ● GitHub: open https://github.com/login/device and enter WDJB-MJHT
 ✔ connected as @onelitonbd — 37 repositories
```

### 3.2 In a code session

- **Footer** gains two fields (it is already pipe-joined, `app.ts:145`):
  `repo onelitonbd/SuparClaw | branch sc/swift-otter | 3 files`
- **Clone progress** is a system line updated in place, then a single
  `✔ ready · 1,284 files · main`.
- **`ctrl-o`** (today: expand tools) keeps working; the changed files are also
  available as `/diff`, which prints the same list as text.

### 3.3 Commands (shared router — identical on web and Telegram)

| Command | Behaviour |
|---|---|
| `/code [owner/name]` | with an argument: bind that repo to the current session and prepare it. Without: open the repo picker (TUI/web) or the inline list (Telegram). |
| `/repo` | the bar as text: repo, branch, base, changed files, PRs opened. |
| `/diff [path]` | changed files, or one file's diff. |
| `/pr` | the publish prompt (`y` / `n` / `draft`), never automatic. |
| `/connect github` | the same connect flow outside a session (TUI); on the CLI, `sc github connect` prefers the local `gh` login and falls back to the device code. |

These belong in `SLASH_CATALOG` so `/help`, the Telegram menu and the TUI all
learn them from one place — the codebase's existing rule that the list, the help
text and the menu cannot drift apart.

---

## 4. Telegram

The chat has no sidebar and a 64-byte `callback_data` budget, so the design is
explicit: **short indices in buttons, real names in text.**

### 4.1 `/new` asks the kind (only when GitHub is connected)

```
/new
│ New session
│ ┌───────────┬──────────────┐
│ │ 💬 Chat   │ ⌘ Code        │   callback: n:c  /  n:k
│ └───────────┴──────────────┘
```

- `Chat` → exactly today's behaviour (rotate the session tag), one message edited
  to `✔ New chat started`.
- `Code` → the repo list (4.2).
- **Not connected** → `/new` behaves as today (instant), because a question whose
  only useful answer is unavailable is a dead end.
- **Unpublished work** → if the current code session has uncommitted changes,
  `/new` asks first: `You have unpublished changes in this session.`
  `[Publish PR] [Start new chat anyway]`. Rotating the session silently would look
  like the work was thrown away.

### 4.2 Repo list

```
│ Pick a repository
│
│ ⌘ onelitonbd/SuparClaw   private · 2h
│ ┌──────────────────────────────┬──────────────────────┐
│ │ SuparClaw                    │ landing              │
│ ├──────────────────────────────┼──────────────────────┤
│ │ acme/api                     │ acme/docs            │
│ └──────────────────────────────┴──────────────────────┘
│            [‹] 1/5 [›]        [⟳]
```

- **Callback data:** `r:<page>:<slot>` — 8 bytes, well inside the 64-byte cap. The
  page's repo names live in a per-chat cache (the same `#pending`/meta pattern the
  channel already uses), so nothing long rides a button.
- **6–8 per page, two columns**, recents first; pagination because no keyboard
  may exceed 100 buttons.
- **`/code owner/name`** always works and skips the list — the power path.
- Tapping a repo edits the message to `⌘ onelitonbd/SuparClaw · cloning… 42%`
  (edited in place, the Task 32 draft behaviour) then `✔ ready · 1,284 files · main`.
  The user is never left wondering whether the tap registered.

### 4.3 Inside a code session

Every reply that changes files ends with **one line**, appended by the channel (not
by the model), so it cannot be forgotten or hallucinated:

```
3 files changed · /diff to review · /pr to publish
```

- `/diff` → file list (truncated to 15 rows + "…and N more"), `/diff path` → the
  diff in a `<pre>` block.
- `/pr` → a confirmation with buttons: `[ Draft PR ] [ Open PR ] [ Cancel ]`,
  callback `pr:d` / `pr:o` / `pr:c`. Publishing from chat **always** shows this
  card; there is no one-tap publish.
- The publish result is a message with the PR link and a **second** button
  `[ Open PR #12 ↗ ]`.

### 4.4 What never appears on Telegram

Everything that is not an answer: reasoning, stage lines ("Thinking", "Working",
"Reading files"), tool names and tool output. Task 53 removed the status draft
and the `streaming` / `toolProgress` settings outright, so there is no longer a
knob that can put this back — the chat posts answers only, one message per
finished block, as the model writes them. A repo session on Telegram should read
like a colleague reporting back, not a CI log.

---

## 5. Plumbing the three surfaces share

### 5.1 Session fields

`src/state/db.ts` migrations (the `archived` pattern at `:418`):

```sql
ALTER TABLE sessions ADD COLUMN kind   TEXT;   -- 'chat' | 'code'
ALTER TABLE sessions ADD COLUMN repo   TEXT;   -- 'owner/name'
ALTER TABLE sessions ADD COLUMN base   TEXT;   -- 'main'
ALTER TABLE sessions ADD COLUMN branch TEXT;   -- 'sc/swift-otter'
ALTER TABLE sessions ADD COLUMN workspace TEXT; -- absolute worktree path
```

`sessions.list` already returns `SELECT *`, so the sidebar, the TUI footer and the
repo bar get these with **no RPC change**. `chat.history` gains a `session` object
(kind/repo/branch/workspace) so a cold page load draws the bar before the sidebar
refresh lands.

### 5.2 RPC

| Method | Input | Returns / events |
|---|---|---|
| `sessions.create` | `{ kind, repo?, base? }` | the new `sessionKey`; starts preparation |
| `github.status` | — | `{ connected, login, scopes, repos, expiresAt }` |
| `github.connect.start` | `{ via: "gh" \| "device" }` | `{ userCode, verificationUri, interval, expiresIn }` |
| `github.connect.poll` | — | `{ state: "pending"\|"ok"\|"denied"\|"expired", login? }` |
| `github.repos` | `{ filter?, page? }` | `[{ fullName, private, defaultBranch, pushedAt }]` |
| `repo.status` | `{ sessionKey }` | `{ state, branch, files, added, removed, pr? }` |
| `repo.diff` | `{ sessionKey, path? }` | unified diff text |
| `repo.publish` | `{ sessionKey, title, body, draft }` | `{ prUrl, number }` |

Events on the existing chat stream: `repo:progress { pct, phase }`,
`repo:ready { files }`, `repo:changed { files, added, removed }`,
`repo:published { url, number }`. The web bar, the TUI system line and the
Telegram draft all render the same four events — one implementation, three skins.

### 5.3 Component reuse (no new UI primitives)

| Need | Reuse | File |
|---|---|---|
| Kind + repo picker | bottom sheet (`pickModel` pattern) | `ui/src/picker.ts`, `ui/index.html:190` |
| Publish / changed files / connect | `modal()` | `ui/src/dom.ts:75` |
| Repo chip, file counts | `.chip` styling | `ui/styles.css:320` |
| TUI pickers | `#pick` overlay | `src/tui/app.ts:460` |
| Telegram buttons | existing inline-keyboard + callback handlers | `src/channels/telegram.ts:401` |
| Answer delivery | `createTurnDelivery` (`say` blocks now; no status draft) | `src/channels/telegram-delivery.ts` |
| Session fields | `sessions.patch` + column migrations | `src/gateway/server.ts:844`, `src/state/db.ts:418` |

---

## 6. Code review notes (what this design must not break)

| # | Finding | Effect on the design |
|---|---|---|
| 1 | `+` is a single click today (`main.ts:949`) and `ui-smoke` asserts the element ids | The sheet is additive; `new-session` / `new-chat-btn` keep their ids and just open the sheet. |
| 2 | Six sidebar tests pin date bucketing (`test/ui-sidebar.test.mjs`) | Repo **chip + filter**, no re-grouping (2.9). |
| 3 | `chat.history` returns no session fields (`server.ts:407`) | Add `session` to the response rather than relying on sidebar timing. |
| 4 | Telegram `callback_data` ≤ 64 bytes | Index-based callbacks + per-chat cache (4.2). |
| 5 | `/new` rotates a meta tag (`telegram.ts:243`) | Store `{tag, repo}` together, or switching sessions loses the repo. |
| 6 | `ctrl-g` parsed but unbound; `ctrl-n` absent from the union (`keys.ts`) | Bind `ctrl-g` for new session. |
| 7 | TUI footer is already pipe-joined (`app.ts:145`) | Two fields appended, no layout rework. |
| 8 | `exec` cwd = workspace (`tools.ts:785`), sandbox off by default (`schema.ts:732`) | Repo sessions default to `sandbox: strict`; the design states it in the empty state, not in a modal nobody reads. |
| 9 | `AGENTS.md` capped at 8 000 chars (`workspace.ts:64`) | Empty state shows whether it was found; a truncated file is reported in `/repo`. |
| 10 | Global workspace (`loop.ts:205`) | Prerequisite from the research doc; no surface can ship before it. |
| 11 | `exclusive: source === "telegram"` (`service.ts:1612`) | Cloning must be a background job, not a turn, or a Telegram chat blocks for minutes. |
| 12 | Session deletion cleans media (`deleteSessionWithMedia`) | Extend it: a worktree with unpushed work asks "publish first?" before removal. |

---

## 7. Failure UX (every dead end has a door)

| Failure | Web | TUI | Telegram |
|---|---|---|---|
| Not connected | Code row → connect sheet | `code — connect first…` → code line | `/new` stays instant; `/code` explains + `/connect` |
| Token expired mid-work | bar `⚠ reconnect` → sheet | system line + `/repo connect` | `⚠ reconnecting…`, buttons after |
| `gh` login gone | connect sheet falls back to device | same | n/a |
| Repo renamed/deleted | bar `⚠ unavailable` → repick | same | `⚠ repository unavailable — /code to pick another` |
| Clone failed | `⚠ retry` on the bar | `/repo retry` | message + `[Retry]` button |
| Huge repo (> 2 GB) | warning with size + "continue anyway" | same as text | same as buttons |
| No write access | publish modal explains, offers "open PR from a fork?" later | `/pr` explains | `[Fork & PR]` greyed with reason |
| Disk full | bar shows the required size | system line | message |
| Push rejected (protected branch) | modal: "branch `main` is protected — publishing to `sc/…` instead" | same | same |

---

## 8. Guarding "only when asked"

Three independent layers, because a prompt alone is not a guarantee:

1. **Prompt**: repo sessions get one paragraph — *publish only when the user asks
   in this turn; never force-push; never push to the default branch.*
2. **Tool contract**: `github_publish` refuses unless the current turn contains an
   explicit publish request recorded by the service (a per-run flag set when the
   user's message matched a publish intent, or when the UI action called it).
3. **Surface**: every publish path is a deliberate control — the bar's button, the
   `/pr` confirmation, the `[Draft PR]` card. There is no ambient publish.

And the closing line after a change-making turn is informational:
`3 files changed · say "open a PR" when you're ready.`

---

## 9. Phasing

| Phase | Ships | Design sections |
|---|---|---|
| **P0** | connect (gh + device), new-session question, repo picker, repo bar, clone progress, empty state | 2.1, 2.2, 2.3, 2.6, 2.7, 3.1, 3.2, 4.1, 4.2 |
| **P1** | changed files, diff, `/pr` + publish modal + Telegram card | 2.4, 2.5, 4.3 |
| **P2** | sidebar filter, recents, multi-PR per session, CI status on the PR row | 2.9, 4.3 |

Each phase is independently useful: P0 already gives "pick a repo and let the
agent work in it", which is the whole point.

---

## 10. Acceptance tests (per surface, before any of this ships)

**Web** — `test/ui-new-session.test.mjs`
- `+` opens the sheet; Enter starts a chat with **one** action (the previous
  behaviour) and no repo fields.
- Choosing Code while disconnected shows the connect row, not an empty list.
- Picking a repo creates a session whose row carries `kind=code`, `repo`, `branch`.
- The repo bar renders each of the nine states in 2.3 from a fixed event sequence.
- Publish is disabled when `files = 0`, and the dialog cannot be submitted twice.

**TUI** — `test/tui-code.test.mjs`
- `ctrl-g` → `chat` creates a session with no repo and says so in one line.
- `ctrl-g` → `code` → repo prints the clone system line then `✔ ready`.
- Footer contains `repo …` only in code sessions.
- `/pr` requires confirmation and prints the URL, never publishes on `/pr` alone.

**Telegram** — `test/telegram-code.test.mjs`
- `/new` with GitHub connected answers with two buttons; `Chat` rotates the tag
  exactly as today.
- `/code` renders a paged keyboard whose `callback_data` is **≤ 64 bytes** for
  every button (assert the length, not just the shape).
- Tapping a repo edits one message through `cloning…` → `ready` (no second bubble).
- `/pr` shows the confirm card; only the button publishes.
- The closing "3 files changed" line is appended once per turn, never twice.

**Shared** — `test/repo-guard.test.mjs`
- `github_publish` refuses when the turn has no publish request, and names the rule.
- A protected default branch is never the push target.

---

## 11. Open questions

1. **Session naming** — a code session's title today would come from the auto-namer
   (`Task 29`). Should the repo name prefix it (`SuparClaw · fix settings count`)?
   My recommendation: yes, because the sidebar then answers "which project" without
   reading the chip.
2. **New-session default** — after a user picks Code twice in a row, should the
   sheet remember and pre-focus Code? Recommendation: remember the *kind*, never
   the repo (a wrong repo is a much worse mistake than an extra tap).
3. **Repo per session is fixed** — confirm that starting a *second* repo always
   means a new session (recommended), rather than rebinding the current one.

---

## 12. As built (differences from this design)

Implemented in one commit; the six test files named in §10 exist with the
development names `repo-github`, `repo-manager`, `repo-session`, `repo-loop`,
`ui-repo` and `telegram-code` (the `repo-loop` file is the extra one that drives a
real `AgentLoop`, so the prompt block and the publish gate are proven together).

Four deviations, each deliberate:

1. **Settings → Integrations → GitHub exists** (§2.6 asked for it after onboarding).
   It is one card: account, host, granted scopes, credential source, Connect /
   Reconnect / Disconnect. The schema's `addons.github.{enabled,clientId,host}`
   still renders in All settings, so a headless install can configure the client id
   without the browser.
2. **One PR per session, not several.** `publish()` pushes `sc/<slug>`; a second
   publish in the same session would reuse that branch, so the "several PRs are
   allowed" line stays aspirational until branch-per-publish lands (P2). Nothing
   force-pushes: a divergent second push fails loudly instead of rewriting history.
   *(Superseded in part by §13: a session that continues a feature branch pushes
   that branch, so its second publish is a normal update to the same PR.)*
3. **The picker's recents come from `sessions.list`**, not from a new store table —
   the session rows already carry `repo`. Rows show `owner/name` and
   `private · branch`; the "last used" stamp from §2.2 was dropped (the grouping
   already says it, and the row is one line).
4. **Telegram rotates on `/new`, not on the button tap.** `n:c` / `n:k` are the
   card's ids exactly as designed, but the tag rotation stays in `/new` itself
   (unchanged since Task 27, and pinned by a test). The buttons confirm the session
   the card was drawn for; `/code` alone binds the current one.

Also as built, not drawn: the composer lock while cloning (§2.1) is a banner plus a
disabled input, and the sidebar chip (§2.9) trims to ~11 characters with the full
`owner/name · branch` on hover.

---

## 13. Revision — you pick the branch (Task 36)

Four corrections to §2, all from using the shipped add-on.

### 13.1 The branch is part of the choice, not something we invent

The additive design created `sc/<slug>` at checkout time. That was wrong in the
way that matters: it decided *where the work goes* on the user's behalf, and it
made a code session a parallel universe instead of a continuation of the branch
the user is already on.

Now checkout asks. `prepare({branch})` checks out **that** branch; the default
branch is checkout-time's default answer, not a mandate. Three surfaces ask the
same question in the same order:

| Surface | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| Web | chat or code | repository (filter, recents) | branch (`● Default · main` first) |
| TUI (`ctrl-g`) | chat or code | repository | branch |
| Telegram (`/new` → Code, `/code`) | — | repository page | branch keyboard (`★` = default, 🔒 = protected) |

`/code owner/name [branch]` and `sc github code owner/name [branch]` skip the
pickers for people who already know. `sc github branches owner/name [--base b]`
lists what the pickers would show, default first.

### 13.2 Publishing keeps the safety rule, with one branch of logic

| Working branch | Push target | PR head → base |
|---|---|---|
| `feature/x` (≠ base) | `feature/x` | `feature/x → main` |
| `main` (== base) | `sc/<slug>` at the same commit | `sc/<slug> → main` |

One function decides it — `publishBranchFor()` in `manager.ts` — and two readers
share it: `publish()` and the `repo.status` RPC. The publish sheet therefore
names the branch *before* the button is pressed (`sc/probe → main`, plus "This
session continues main, so the commits go to sc/probe. main is never pushed
to."). Non-fast-forward, protected-branch and unsafe-name refusals are unchanged:
nothing is ever force-pushed.

### 13.3 The bar lost its sentences

`⌘ SuparClaw · main  [PR]`. Icon, repository **name** (never `owner/name` — that
stays in the tooltip), the branch, one small button. Five states instead of nine:

- `preparing` → `cloning 42%` (composer locked, because there is no workspace yet)
- `failed` → `clone failed — retry` (tap retries; composer unlocked)
- `ready` → the bare branch name
- `publishing` → `publishing…`
- `warn` → the branch in warning colour (stale token / repository gone)

No file counts, no "no changes", no "working…" — the thread already shows a turn
running, and the diff is one tap away. The PR button is always present, disabled
rather than hidden when there is nothing to publish, and becomes `PR #12 ↗` once
a PR exists.

### 13.4 Dialogs on a phone

A floating card 96px from the top is a desktop shape. ≤640px every `.modal` is a
bottom sheet: full width, `top: auto; bottom: 0`, one rounded edge, `88dvh`
(not `vh` — the address bar is not part of the viewport), `env(safe-area-inset-bottom)`
on the foot so the home indicator never covers the actions, a body that shrinks
and scrolls under a fixed foot, and one action per row (two half-width buttons
wrapped their own labels). Long paths wrap (`overflow-wrap: anywhere`) instead of
widening the dialog, and the diff switches from `white-space: pre` to `pre-wrap`
so a phone reads it top-to-bottom. Sheet rows ellipsis a long repository name.
