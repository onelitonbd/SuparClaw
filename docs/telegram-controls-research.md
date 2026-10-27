# Telegram controls: model, session, thinking, coding

**Task 54 candidate — research only, no implementation yet.**

The ask, in the operator's words: *"i want to be able to change model from telegram,
go to a different session and select level of thinging and also start a coding
session."*

So four things, all from the phone:

| # | Capability | Exists today? | Real gap |
|---|---|---|---|
| 1 | Change **model** | `/model <ref>` — **yes**, but global | no picker, and it silently changes every other surface |
| 2 | Go to a **different session** | only one-way (`/new` rotates forward) | no way to see or return to an earlier session |
| 3 | Choose **thinking level** | `/think <level>` — **yes** | no buttons, no visibility, awkward wording |
| 4 | Start a **coding session** | `/new` → `⌘ Code` → repo → branch | two steps, buried, and it binds *this* session |

Three of the four already work if you know the exact command. The task is
**discoverability, the missing half of #2, and the wrong scope of #1** — plus one
real bug that makes all of it unreliable in groups.

---

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

**Recommendation: C.** It is what OpenClaw does (a `/model` pick selects a
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

## 3. Recommended shape (one task, if approved)

Four commands, each with a keyboard, each self-cleaning (the card is edited to
the chosen value, so no stale buttons and no "status" style messages — the thing
Task 53 removed):

```
/model      [ opus-4 · sonnet-4 · gemini-3 · … ]   ← 8 per page, provider groups
            [ Use default ]  [ Make default ]
/think      [ auto ][ off ][ low ][ medium ]
            [ high ][ xhigh ][ max ]
/sessions   [ ✓ 💬 Deploy script   2h ago ]
            [   ⌘ suparclaw      5m ago ]
            [   💬 Random chat   1d ago ]
            [ ＋ New chat ]  [ ⌘ New code ]  [ 🌐 All ]
/code       (unchanged picker; adds "new vs bind this one")
```

Plus: `/status` grows one line (`model: X (pinned) · thinking: high · session:
Deploy script`), and every control keys off the **chat** so groups stop breaking.

### Shape of the change

| File | Change |
|---|---|
| `src/channels/telegram.ts` | 3 new keyboards + handlers (`m:`, `t:`, `s:`), `#sessionKeyFor` reads the active pointer, callback ids off `ctx.chat.id`, `/model` and `/think` rewritten around the pickers |
| `src/state/db.ts` | `sessions.model` column (PRAGMA-guarded), `setSessionModel()` |
| `src/agent/loop.ts` | resolve the model once: `input.model ?? session.model ?? ""` (3 call sites today), sub-agents inherit it |
| `src/gateway/server.ts` | `sessions.patch { model }`; `sessions.list` already returns the column |
| `src/agent/slash-commands.ts` | `/status` line; `/think` keeps its text form and points at the buttons |
| `ui/src/main.ts` | model chip honours the session pin (so the two surfaces agree) |
| `docs`, `README` | the Telegram section of the README, architecture spec M3 |

Tests that must exist before this ships (the same standard as T53):

- a tap on any picker resolves against **the chat**, proven with a group-shaped
  update (`from.id !== chat.id`);
- `/model` pins **that session only** — a second session still runs the default;
  `/model default` clears it; a pin naming a deleted model falls back and warns;
- `/sessions` lists this chat's sessions with the current one marked, switches,
  refuses a busy target, and leaves the old session intact;
- `/think` buttons write the same column the text form writes;
- the coding flow still works from both entries (`/code` and `⌘ New code`), and
  `⌘ New code` creates a *new* session instead of converting the current one;
- web chat and TUI see the session pin (no surface lies about the model).

---

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

## 5. Questions for the operator

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
