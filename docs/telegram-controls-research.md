# Telegram controls: model, session, thinking, coding

**Task 54 — all four capabilities shipped (54a: model, 54b: sessions, thinking, coding).**

The ask, in the operator's words: *"i want to be able to change model from telegram,
go to a different session and select level of thinging and also start a coding
session."*

So four things, all from the phone:

| # | Capability | Exists today? | Real gap |
|---|---|---|---|
| 1 | Change **model** | ✅ **shipped (54a)** — card + per-session pin | was: global, no picker, retargeted every surface |
| 2 | Go to a **different session** | ✅ **shipped (54b)** — `/sessions`, 10/page, AI titles | was: only one-way (`/new` rotates forward) |
| 3 | Choose **thinking level** | ✅ **shipped (54b)** — `/think` buttons | was: text only, no visibility |
| 4 | Start a **coding session** | ✅ **shipped (54b)** — account → repo → branch | was: two steps, no account step |

Three of the four already work if you know the exact command. The task is
**discoverability, the missing half of #2, and the wrong scope of #1** — plus one
real bug that makes all of it unreliable in groups.

**Status:** all four are **built**. 54a: `/model` is a two-level card (providers
→ that provider's selected models, paged, all buttons) backed by a per-session
model pin (`sessions.model`). 54b: `/sessions` enters an earlier conversation,
`/think` is seven buttons over the same column the text form writes, and
`/new` → Code walks account → repositories → branches, ten rows a page. The
sections below are kept as the record of what was considered and why; the shipped
shape is marked *Shipped*.

## 1. What exists right now (with the code that proves it)

### Commands Telegram answers today

`TELEGRAM_COMMANDS` (`src/channels/telegram.ts:234-241`) + the shared catalog
(`src/agent/slash-commands.ts:11-40`) + every eligible skill. The `/` menu is
published with `setMyCommands` on start (`telegram.ts:973+`, built by
`telegram-menu.ts`), so all of these are one tap away in the client.

| Command | Owner | What it does |
|---|---|---|
| `/new` | Telegram | rotates the session tag; keeps the old one (`telegram.ts:747-768`) |
| `/code [owner/name] [branch]` | Telegram + shared | binds a repo, or opens the repo picker (`telegram.ts:770-789`, `service.ts:1717-1740`) |
| `/model [ref]` | Telegram | **writes `agents.defaults.model`** — the global default (`telegram.ts:815-828`) |
| `/provider …`, `/whoami` | Telegram | provider CRUD, identity/session line |
| `/think [level]` | shared | writes the **session's** thinking column (`slash-commands.ts:247-268`) |
| `/models` | shared | read-only listing of providers/profiles (`slash-commands.ts:270-296`) |
| `/status` | shared | model, tools, skills, dreaming, compaction (`slash-commands.ts:127-142`) |
| `/pr`, `/repo`, `/diff` | shared | the code-session surface |
| `/start`, `/help`, `/commands` | Telegram / shared | catalog pointer |

### The three flows that already exist

**New session, chat or code.** `/new` rotates `telegram:sess:<chatId>` in the
`meta` table to a base-36 timestamp, so the key becomes
`telegram:<chatId>:<tag>`; the old transcript is never deleted. The card that
follows offers `💬 Chat` / `⌘ Code` (`n:c` / `n:k`), and `⌘ Code` goes straight
to the repo picker. Tested: `test/telegram-code.test.mjs` ("/new rotates the
session key instead of deleting anything", "/new asks chat-or-code").

**Coding.** Repo picker (`r:<page>:<slot>`, 8 per page, names never ride a
callback) → branch picker (`b:<index>`, default branch first) → `bindRepo()` clones
into a worktree and marks the session `kind=code` (`service.ts:513-539`,
`state/db.ts:556-568`). `/diff` and `/pr` then act on that binding.

**Thinking.** `/think medium` writes `sessions.thinking`; the loop already reads
it second in its chain — per-run → **session** → model profile → global default
(`loop.ts:334-353`). Tested: `test/slash-commands.test.mjs:39-51`.

### What is actually missing

1. **No pickers.** Everything is typed. The one exception is the repo/branch
   keyboard, which proves the machinery (paged inline keyboards, callback ids
   under 64 bytes, no names in callbacks) already works here.
2. **`/model` has the wrong scope.** It writes `agents.defaults.model`, i.e. the
   **default for every surface**: switching to a cheap model on the bus changes
   what the web UI and the TUI use too. The web's own model sheet does the same
   thing (`ui/src/main.ts:1120-1131`), and the TUI is worse off in a different
   way — its `/model` is an in-memory override that disappears when the TUI
   exits (`src/cli/tui-commands.ts:60-80`). There is no persisted per-session
   model anywhere in the product today.
3. **Session navigation is one-way.** `/new` always makes a *new* key; nothing
   lists the old ones or lets you go back. The chat's key is derived from
   `meta["telegram:sess:<chatId>"]` — a rotation tag, not a choice
   (`telegram.ts:963-965`).
4. **A real bug: group chats break the control surface.** `#onCallbackQuery`
   resolves everything from `ctx.from.id` (the *user*) — session key, repo page,
   picked repo, branch page (`telegram.ts:407-508`) — while pickers are stored
   under the chat id (`telegram.ts:879-907`). In a DM the two ids are equal, so
   nothing shows; in a group the two entry points fail differently:
   - `/code` typed in the group stores the picker under **the group** and the tap
     looks it up under **the user** → every tap answers "This picker expired".
   - `⌘ Code` after `/new` does the reverse: it sends the repo list to the *user's
     DM* (`#sendRepoPicker(fromId, …)`) and binds **the user's DM session**, not
     the group's.

   Either way the chat you are looking at is not the session being configured.
   Session switching has to key off the **chat** for everything, and this fix
   belongs in the same change.

---

## 2. Design space

### 2.1 Model — where does the choice live?

| Option | What the user gets | Cost | Risk |
|---|---|---|---|
| **A. Keep global** | `/model` + a picker that writes `agents.defaults.model` | ~1 file, trivial | Changing it on the phone retargets the web/TUI too — a silent cross-surface surprise |
| **B. Per-chat pin (Telegram only)** | a pin in `meta`, passed as `payload.model` on each send | ~2 files | the pin is invisible to the web: that session would run on a different model than the header shows |
| **C. Per-session pin (product-wide)** | `sessions.model`, resolved in the loop: per-run → **session pin** → default | ~5 files + migration | needs a web surface too, or the same lie as B — but then it is honest and the TUI can reuse it |

The loop already supports a per-run model (`input.model`, `loop.ts:783`), so all
three are possible without touching the LLM client.

**Shipped: C.** It is what OpenClaw does (a `/model` pick selects a
session pin; `/model default` clears it, `docs/openclaw/concepts/models.md:116-121`),
it makes `/model` mean "this conversation" everywhere, and it fixes the TUI's
disappearing override for free later. Scope: one `ALTER TABLE sessions ADD COLUMN
model TEXT` (the same PRAGMA-guarded pattern as `thinking`, `db.ts:390`), a store
setter, one resolved value at the top of `run()`, `sessions.patch { model }` for
the web, and the web chip reading the session pin instead of the global default.
Two decisions worth making explicit:

- **Fallbacks:** a pin replaces the *primary*; the configured fallbacks still
  apply (OpenClaw makes user pins strict — ours is the friendlier rule and matches
  what `payload.model` does today).
- **A pin that no longer resolves** (model deleted/disabled): fall back to the
  default and say so once in the chat, rather than failing the turn at 2 a.m.

### 2.2 Sessions — how do you get back?

| Option | What the user gets | Cost |
|---|---|---|
| **A. Forward only** (today) | `/new`; old sessions live in the web UI | 0 |
| **B. Picker of this chat's sessions** | `/sessions` → named list, ✓ on current, tap to switch; `＋ New chat` / `⌘ New code` at the bottom | ~2 files (meta pointer + paging + editing the card) |
| **C. Any session, cross-surface** | B plus every `main:*` session from the web/TUI | B + ownership rules + "this session is also open in the web" warnings |

Sessions are already named automatically from their first message (Task 33) and
the row carries `kind` and `repo` (`db.ts:24-27`), so a list can read
`💬 Deploy script · 2h ago` / `⌘ suparclaw · 5m ago` without any new data.

**Recommendation: B now, C behind a second page** ("🌐 All sessions"). The
mechanism is one pointer — `meta["telegram:active:<chatId>"]` holding the full
key — read by `#sessionKeyFor`, with `/new` still rotating as it does today.
Everything downstream (queue, busy guard, repo binding, media, `/pr`) already
keys off that one function, so a switch moves the whole chat coherently. Refuse
the switch if the target is mid-run (`loop.isBusy`) — same rule as `/pr`.

### 2.3 Thinking — the cheap one

`/think` already writes the right column and the loop already honours it. What is
missing is only the surface: a 7-button keyboard (`auto · off · low · medium ·
high · xhigh · max`, matching the web's `auto` label for `inherit`,
`ui/src/main.ts:497-517`), the card edited to the chosen value after the tap, and
the level shown in `/status`/`/whoami` next to the model. No storage, no
migration, no risk.

### 2.4 Coding — polish, not new plumbing

The flow works end to end. Two usability changes:

- **`/code` on a session that already has history** should offer
  `⌘ New code session` (recommended) vs `Bind this one` — binding mid-conversation
  today silently turns an existing chat into a repo session.
- **The repo picker should be reachable from `/sessions`** ("⌘ New code") so the
  entry point is where people look, not a separate command they have to know.

---

## 3. The shape that shipped

Four commands, each with a keyboard, each self-cleaning (the card is edited to
the chosen value, so no stale buttons and no "status" style messages — the thing
Task 53 removed):

```
/model      [ provider … ]  →  [ model … ]        ← 10 per page, both levels
            [ Use default ]  [ Make default ]
/think      [ Default (medium) ]
            [ Off ][ Low ][ Medium ]
            [ High ][ XHigh ][ Max ]
/sessions   [ ✓ 💬 Deploy script   2h ago ]
            [ ⌘ suparclaw          5m ago ]
            [ 💬 Random chat       1d ago ]
            [ ‹ Prev ][ Next › ]
            [ ＋ New session ]
/new        [ 💬 Chat ]  [ ⌘ Code ]
   ⌘ Code → [ @onelitonbd · gh CLI ]              ← account first
            → [ 🔒 onelitonbd/SuparClaw ] ×10      ← 10/page, ‹ Accounts
            → [ main · default ] ×10               ← 10/page, ‹ Repos
```

Plus: `/status` grew a line (`session: <title> · <key> · thinking: …` above the
model line), and every control keys off the **chat** so groups stop breaking.

Two deviations from the draft, both deliberate: `🌐 All` is gone (the list is
this chat's sessions — switching a Telegram chat onto a web session would make
two surfaces write one transcript with different UI assumptions, and that is a
feature, not a picker), and `＋ New chat` / `⌘ New code` collapsed into one
`＋ New session` button that runs `/new`'s rotation and then asks chat-or-code,
because two buttons that both rotate are two places to keep in sync.

### Shape of the change

| File | Change |
|---|---|
| `src/channels/telegram.ts` | **done (part 1):** the `m:` handlers, `/model` card, chat-keyed callbacks |
| `src/channels/telegram-model-menu.ts` | **done (part 1):** the pure card + tap module |
| `src/state/db.ts` | **done (part 1):** `sessions.model` column (PRAGMA-guarded), `setSessionModel()` |
| `src/agent/loop.ts` | **done (part 1):** one `#modelFor()` — per-run → pin → default |
| `src/gateway/server.ts` | **done (part 1):** `sessions.patch { model }` |
| `src/agent/slash-commands.ts` | **done (part 1):** `/status` prints the pin |
| `src/channels/telegram-pickers.ts` | **done (part 2):** the session, thinking, account, repo and branch cards |
| `src/channels/telegram.ts` (`/think`, `/sessions`, account step) | **done (part 2):** chained cards, the `telegram:active` pointer |
| `src/agent/service.ts` | **done (part 2):** `githubAccounts()`, `{source}` on repos/branches/bind |
| `ui/src/main.ts` | later: the model chip honours the pin |
| `docs`, `README` | **done (part 1):** README Telegram section, spec M3 |

Tests that must exist before this ships (the same standard as T53):

- a tap on any picker resolves against **the chat**, proven with a group-shaped
  update (`from.id !== chat.id`); — `test/telegram-code.test.mjs`
- `/model` pins **that session only** — a second session still runs the default;
  `/model default` clears it; a pin naming a deleted model falls back and warns;
  — `test/session-model.test.mjs`
- `/sessions` lists this chat's sessions with the current one marked, switches,
  refuses a busy target, and leaves the old session intact;
  — `test/session-switch.test.mjs` + the source contracts
- `/think` buttons write the same column the text form writes;
  — `test/telegram-pickers.test.mjs`
- the coding flow still works from both entries (`/code` and `/new` → Code);
  — `test/telegram-code.test.mjs`, `test/github-accounts.test.mjs`
- web chat and TUI see the session pin (no surface lies about the model).
  Partly: `sessions.patch { model }` is exposed, the chip is still a follow-up.

---

## 3b. What shipped, and the three things it deliberately does not do

| Shipped | Where |
|---|---|
| `/model` → provider → model, 10/page, per-session pin, `Use default` / `Make default` | `telegram-model-menu.ts`, `sessions.model` |
| `/sessions` (alias `/session`) → this chat's conversations, AI titles, ages, 10/page, tap to enter | `telegram-pickers.ts`, meta `telegram:active:<chatId>` |
| `/think` (alias `/thinking`) → seven levels, tap to write `sessions.thinking` | `telegram-pickers.ts` |
| `/new` → Chat/Code → **account** → repositories (10/page) → branches (10/page) → bind | `telegram.ts`, `service.githubAccounts()` |
| `/status` names the session, its key and its effort; `/whoami` names the session | `slash-commands.ts` |

Deliberately out of scope, and why:

- **`🌐 All` (sessions from other surfaces).** Two clients writing one
  transcript is a product decision with an authority model behind it, not a
  picker. A Telegram chat switches between *its own* conversations.
- **A topic as a session.** `message_thread_id` is not part of the session key,
  so every topic in a forum group shares one conversation. Making topics
  sessions would change keys everywhere (`surfaces.ts`, cron targets).
- **A Telegram mini-app control panel.** It needs the gateway reachable over
  HTTPS from Telegram's servers; a phone-hosted daemon behind NAT is not.

## 4. Caveats worth knowing before choosing

- **Coding sessions are GitHub sessions.** `bindRepo` clones `owner/name` over
  https with a token (`src/repo/manager.ts:163-241`) and needs GitHub connected
  (`sc github adopt-gh` / `sc github connect`). There is no "bind a local folder"
  path today. On a phone that is probably right — but if the ask includes "code
  in a folder on this device", that is a second feature, not a picker.
- **In a group, the chat is the session**, so `/model` and `/think` would change
  the group's model and effort for every paired member. That is coherent (the
  group has one transcript) but it should be visible in the card
  (`Group: -1001234 · model …`), not a silent change.
- **The `/` menu is capped at 100 entries** (Bot API) and we publish ~30 today;
  `/sessions` fits without trimming anything.
- **Pickers are messages the user asked for.** They are not the status draft
  Task 53 removed: one card per explicit command, edited in place to the chosen
  value, never created by a turn. The answers-only rule is untouched.
- **Session switching changes what `/pr`, `/diff` and media act on**, because they
  all read the same `#sessionKeyFor`. That is the point — but it also means the
  "current session" must be visible without asking (`/status`, and the header of
  every picker card).

## 5. Questions for the operator (all answered)

**Answered by the shipped work:** model scope = this chat (with `Make default`
for the global one); session scope = this chat only (`🌐 All` dropped, see §3);
discovery = one command per control, each with its own card (no `/menu` hub);
thinking chain = session → profile → global, unchanged.

1. **Model scope** — is `/model` on Telegram "this chat", or "everything"
   (today's behaviour)? Recommendation: this chat, with a `Make default` button.
2. **Session scope** — should Telegram see only that chat's sessions, or every
   session in the product (including the ones started in the web UI)?
   Recommendation: this chat first, `🌐 All` second.
3. **Discoverability** — four commands with keyboards (recommended), or one
   `/menu` card that links to all four? A single card is one extra tap to
   everything, but adds a message people have to scroll past.
4. **Thinking on the model profile** — the Models page can already give a model
   its own effort (`Profile.reasoningEffort`). With a session picker, the chain
   becomes session → profile → global. Keep that order? Recommendation: yes —
   an explicit choice at the chat beats a per-model default.

## 6. Task 55 — the approval wall and the lying footer

Two reports came out of one Telegram session: *"the sandbox is blocking all
shell commands … you check your GitHub yourself and paste the list"*, and
*"`/model` says it changed but the answers are the default"*. Neither was a
Telegram problem. Both were the runtime telling the truth about the wrong
thing.

### 6.1 The wall: the loop asked before the policy spoke

`AgentLoop` gated on `spec.needsApproval && deps.requestApproval` **before**
`evaluateExec` was consulted (`loop.ts:1006`). With `tools.exec.mode = "full"`
(the default, "runs without prompts") the policy would have said `allow` — but
it never got the question. The prompt then went to `Service.requestApproval`,
which, with no surface able to answer, fell back to `askFallback: "deny"`
(`schema.ts:730`) and returned a silent decline. The model received
`error: user declined this action`, and a model with no other tool for the job
does the honest-sounding thing: it tells the human to run the shell themselves.

The fix removes the person from the loop, not the policy:

| | before | after |
|---|---|---|
| `mode: full` | prompt → `askFallback` deny → nothing runs | `allow`, runs |
| `mode: ask` | prompt, waits for a tap nobody will make | runs, transcripts `[allowed automatically: …]` |
| `mode: deny` | denied (but reported as "the user declined") | denied, with the policy reason in the tool result |
| Telegram card | posted and awaited | never posted (`onApproval` hook removed, `appr:` answers "no longer used") |
| tool text | "needs approval — ask the user to approve, then retry" | tool descriptions say the opposite |

`needsApproval` survives as a **marker** — it routes the call through
`evaluateExec` (which is how `deny` and `allowlist` still bite) instead of
routing it through a human.

### 6.2 The lie: the footer named the default, and the pin was not strict

The `/usage` footer was built from `payload.model` — the *per-run* override,
which a Telegram turn never sets — instead of from the model the run used. The
pin itself worked (the loop's `#modelFor` reads `sessions.model`; the request
carried the pinned ref), so the chat answered with the pinned model and then
signed the answer with the default's name.

Two changes:

- `final` events now carry `model` (the ref the loop actually resolved),
  and the footer is built from it.
- A **chosen** model — a per-chat pin or a per-run `--model` — no longer rides
  the fallback chain. Silent substitution was the other way this looked like
  "it didn't change": the pinned call failed, the chain answered from the
  default, and nothing said so. A choice now fails visibly, with the reason and
  the one command that undoes it (`/model default`).

The default model keeps its chain. Only a choice is strict.

## 7. Task 56 — the shell died, and there was no other road

The reply that started this: *"killed by the sandbox (SIGABRT) … run `gh auth
status` and `gh repo list` on your phone and paste the output."* Two separate
failures had to line up for the agent to say that.

### 7.1 A SIGABRT before any output is the environment, not the command

`exec` had exactly one strategy: `findShell()` → `<shell> -lc <command>`, then
`explainExecError()` turned whatever happened into a line. On a phone that is
not enough, because the shell can die **before the command starts**:

| cause | what the child does |
|---|---|
| a `.bashrc`/`.profile` that sources something missing | aborts during startup |
| `LD_PRELOAD`/`LD_LIBRARY_PATH` naming a library that moved (Termux after an update sets `libtermux-exec.so`) | Android's linker aborts before `main()` |
| `prlimit`/`proot` present per `existsSync` but not runnable | never reaches the shell |

All three look identical from the daemon's seat: `SIGABRT`, no stdout. The old
code reported that as the command's failure and stopped, so the model concluded
"nothing on this device can run commands" — which is a true statement about the
old code, not about the device.

`exec-fallback.ts` is the ladder: the planned invocation, then the same shell
without its login files, then each POSIX shell that exists (`/system/bin/sh`
first on Android) with `LD_PRELOAD`/`LD_LIBRARY_PATH`/`DYLD_*`/`PYTHON*`
scrubbed. The retry rule is narrow on purpose: **only when the child printed
nothing**, and never after a timeout (retrying a timeout repeats the work). A
command that ran, printed, and failed keeps its own failure.

When a rung other than the first works, the tool says so and tells the model the
environment was the problem — not to ask the human to run anything.

### 7.2 The only road to GitHub was `gh`

There was no GitHub tool. `repo_status`/`github_publish` exist but both need a
*bound repository*, so "show me my repos and tell me what to archive" had no
route except a shell command. Adding `github` (list / whoami / archive /
unarchive / delete) removes the dependency on a working shell *and* on `gh`
being installed. Delete is latched: the model must repeat the exact
`owner/name`, because on a phone there is no second pair of eyes.

With both changes the honest answer to a dead shell is another route, and the
only remaining sentence the agent may use is "this device cannot start a shell
right now — here is the line" plus whatever another tool can do instead.
