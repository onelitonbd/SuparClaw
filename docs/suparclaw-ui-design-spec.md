# SuparClaw UI design spec — cloning the OpenClaw "skin" (TUI + Web)

> Written 2026-10-19 by reading the **actual source** of `openclaw/openclaw` (MIT), not just docs:
> `ui/src/styles/base.css`, `ui/index.html`, `ui/package.json`, `ui/src/app/theme-*.ts`,
> `src/tui/theme/theme.ts`, `src/tui/components/tool-execution.ts`, and the `@earendil-works/pi-tui` package.
> Every hex value below is copied from their files.

---

## 1. Web UI (Control UI) — the design system

### 1.1 Stack (verified in `ui/package.json`)

Vite + **Lit** + **SolidJS** (signals/web, used for some panels) · CodeMirror 6 for the composer ·
markdown-it (+ emoji, cjk-friendly) · highlight.js · DOMPurify · @tanstack/virtual-core (virtual lists) ·
@zag-js (menus) · noVNC + ghostty-web (browser terminal) · mediabunny (media) · json5.
The web app alone pulls **40+ dependencies** and **5,957 TypeScript files**.

### 1.2 Core tokens — the exact dark palette (signature "lobster red")

From `ui/src/styles/base.css`:

```css
:root {
  /* surfaces */
  --bg: #0e1015;            --bg-accent: #13151b;
  --bg-elevated: #191c24;   --bg-hover: #1f2330;   --bg-muted: #1f2330;
  --card: #161920;          --card-foreground: #f0f0f2;
  --popover: #191c24;       --panel: #0e1015;       --panel-strong: #191c24;
  --chrome: rgba(14,16,21,.96);   --chrome-strong: rgba(14,16,21,.98);

  /* text — --text targets ~10:1 contrast on --bg (their words) */
  --text: #bcbcc0;          --text-strong: #f4f4f5;   --chat-text: #bcbcc0;
  --muted: #8b8b94;         --muted-strong: #898990;

  /* borders + focus */
  --border: #1e2028;        --border-strong: #2e3040;  --border-hover: #3e4050;
  --input: #1e2028;         --ring: #ff5c5c;

  /* accent — punchy signature red */
  --accent: #ff5c5c;        --accent-hover: #ff7070;   --accent-subtle: rgba(255,92,92,.10);
  --accent-glow: rgba(255,92,92,.20);   --accent-foreground: #0e1015;
  --primary: #d13c3c;       --primary-hover: #d13c3c;  --primary-foreground: #ffffff;
  --accent-2: #14b8a6;      /* teal, second accent */
  --selection-bg: #005fcc;  --selection-fg: #ffffff;
  --link: color-mix(in srgb, var(--accent-hover) 85%, var(--text));

  /* status-ish */
  --exec-highlight: #f97316; --moon-highlight: #fef3c7; --inbox-attention: #e5243b;
  --lobster-icon-body: #ff6d5a; --lobster-icon-shade: #c2372b;
}
```

They ship the **WCAG audit inline** — e.g. `--accent` on bg = 6.3:1 (AA ✓), `--primary-foreground`
on `#d13c3c` = 4.75:1. Clone this discipline; it's the reason the UI looks "clean" rather than harsh.

### 1.3 Scale tokens

```css
/* type — one global zoom knob */
--control-ui-text-scale: 1;
--control-ui-text-xs: calc(11px * var(--control-ui-text-scale));
--control-ui-text-sm: calc(12px * ...);   /* sidebar titles, meta */
--control-ui-text-md: calc(14px * ...);   /* chat body */
--control-ui-text-lg: calc(16px * ...);
--control-ui-input-text-size: max(16px, calc(14px * ...)); /* stops iOS zoom-on-focus */

--font-body: "Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--font-display/--font-chat: var(--font-body);
--font-shortcut: system-ui, ... "Segoe UI Symbol";   /* key glyphs */
body { font: 400 14px/1.55 var(--font-body); }

/* spacing */
--space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
--space-5: 20px; --space-6: 24px; --space-7: 32px; --space-8: 40px;

/* radii */
--radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-xl: 20px; --radius-full: 9999px;

/* elevation */
--shadow-sm: 0 1px 2px  rgba(0,0,0,.25);
--shadow-md: 0 4px 16px rgba(0,0,0,.30);
--shadow-lg: 0 12px 32px rgba(0,0,0,.40);
--shadow-xl: 0 24px 48px rgba(0,0,0,.50);

/* rail chrome geometry (48px header, 6px resize handle) */
--rail-header-height: 48px; --rail-header-padding-start: 12px; --rail-header-action-size: 28px;
--rail-header-title-weight: 600; --resize-handle-size: 6px; --resize-handle-line-size: 1px;

/* chat */
--chat-thread-max-width: 48rem;         /* the reading column */
--chat-composer-surface / --chat-stack-header-height: 40px;
```

### 1.4 Light family

`:root[data-theme-mode="light"]` is a **"warm paper" palette — terracotta accent on ivory**
(bg `#faf9f7`), and its shadows are warmed: `0 4px 12px rgba(60,42,24,.07)`. That warm-paper/terracotta
pair is what makes their light mode feel like paper rather than a generic white theme.

### 1.5 Theme catalog

12 palettes, each dark + light, each with SVG **and** WebP background artwork:
`absolutely · beacon · crt · dash · knot · manuscript · miami · phosphor · rose · tide · custom · claw (default)`.
The **CRT** theme overrides bubble geometry to near-square corners; others share the rounded
transcript shape. Themes are selected via `data-theme` / `data-theme-mode` attributes.

### 1.6 Layout blueprint (what to reproduce)

```
┌──────────────────────────────────────────────────────────────────────┐
│ rail header 48px: agent switcher · + new session · search · settings │  ← --rail-header-*
├───────────────┬──────────────────────────────────┬───────────────────┤
│ SESSION SIDEBAR│        CHAT COLUMN (48rem)      │  OPTIONAL PANELS  │
│  (Active/      │  header: title · model · status │  Terminal         │
│   Snoozed/     │          · Details panel       │  Browser          │
│   Archived)    │                                  │  Desktop          │
│                │  user bubble      (right, tint) │  Approvals queue  │
│  ● running     │  assistant text   (left, plain) │                   │
│  ● idle        │  tool card        (collapsible) │                   │
│  ○ unread dot  │  system events    (collapsed)   │                   │
│                │                                  │                   │
│                │  ── composer ──────────────────  │                   │
│                │  queue strip · progress · mic   │                   │
├───────────────┴──────────────────────────────────┴───────────────────┤
│ connection indicator (bottom-left) · version · theme picker           │
└──────────────────────────────────────────────────────────────────────┘
```

Design details worth copying verbatim: unread dot on session rows, `details`-panel grouping
(Environment / Context / Changes), collapsed **system events** row, **Worked for 2m 3s · 2 failed**
collapsible summary above an answer, one editable **progress card** while the agent works, queued
messages shown above the composer, tool activity collapsed into counts
("13 commands · 6 reads · 9 edits").

### 1.7 The weight problem (why we don't copy the app)

| File group | Bytes |
|---|---|
| All `ui/src/styles/**` CSS | **1,556,461** across 133 files |
| `layout.css` | 114,846 |
| `components.css` | 98,816 |
| `chat/composer.css` | 92,951 |
| `chat/layout.css` | 74,611 |
| `chat/grouped.css` | 59,367 |

Their look is achieved with **1.5 MB of CSS**. SuparClaw keeps the *tokens* (a ~250-line file) and
writes ~8 screens against them. Same pixels, ~2% of the CSS.

---

## 2. TUI — the design system

### 2.1 Renderer

`@earendil-works/pi-tui@1.1.0` — "Terminal User Interface library with **differential rendering**":
only changed lines are repainted. Components used: `Box · Text · VStack · HStack · Spacer · Editor ·
Input · SelectList · SettingsList · ScrollView · Markdown · Image · Loader · CancellableLoader ·
TruncatedText · MouseRegion` + Kitty-keyboard, OSC-8 hyperlinks, fuzzy find, LaTeX rendering.

### 2.2 Exact TUI palette (`src/tui/theme/theme.ts`)

| Token | Dark | Light | Used for |
|---|---|---|---|
| `text` | `#E8E3D5` | `#1E1E1E` | assistant body (warm paper white) |
| `dim` | `#7B7F87` | `#5B6472` | hints, scroll info |
| `accent` | `#F6C453` | `#B45309` | **bold headers**, selection |
| `accentSoft` | `#F2A65A` | `#C2410C` | list bullets, selected values |
| `border` | `#3C414B` | `#5B6472` | editor border, rules |
| `userBg` | `#2B2F36` | `#F3F0E8` | **user bubble background** |
| `userText` | `#F3EEE0` | `#1E1E1E` | user bubble text |
| `systemText` | `#9BA3B2` | `#4B5563` | system notices |
| `toolPendingBg` | `#1F2A2F` | `#EFF6FF` | running tool card |
| `toolSuccessBg` | `#1E2D23` | `#ECFDF5` | finished tool card |
| `toolErrorBg` | `#2F1F1F` | `#FEF2F2` | failed tool card |
| `toolTitle` | `#F6C453` | `#B45309` | tool card title |
| `toolOutput` | `#E1DACB` | `#374151` | tool output text |
| `quote` / `quoteBorder` | `#8CC8FF` / `#3B4D6B` | `#1D4ED8` / `#2563EB` | blockquotes |
| `code` / `codeBorder` | `#F0C987` / `#343A45` | `#92400E` | code (no syntax highlighting on base path) |
| `link` | `#7DD3A5` | `#047857` | markdown links |
| `error` / `success` | `#F97066` / `#7DD3A5` | `#DC2626` / `#047857` | status |

Two design decisions to keep:
1. **Markdown theme mapping**: headings = bold amber (the same `header` fn), links green, code amber,
   quote blue, hr = border, list bullet = accentSoft. One palette drives both plain text and Markdown.
2. **Automatic light/dark detection**: read `OPENCLAW_THEME`, else parse `COLORFGBG`, decode the xterm
   cube level, compute relative luminance, and pick whichever of `#E8E3D5` / `#1E1E1E` has higher
   contrast ratio. ~40 lines, and it makes the TUI feel native in any terminal theme.

### 2.3 Tool card design (`src/tui/components/tool-execution.ts`)

- Title line in `toolTitle` (amber) + curated arg summary (or sanitized JSON).
- Output rendered as Markdown in `toolOutput`, **capped at 12 lines / 12×256 chars** unless expanded.
- Truncation is **UTF-16 safe** and width-aware (`truncateToWidth`), with `…` as the last row.
- Background per state: pending `#1F2A2F`, success `#1E2D23`, error `#2F1F1F` — a colored chip around
  the whole card, which is how you read state at a glance without reading text.
- Sanitization strips terminal control sequences and binary before render.
- Ctrl+O toggles expansion; images inside tool output render inline where the terminal supports it.

### 2.4 Screen layout

```
┌──────────────────────────────────────────────────────────────┐
│ agent · session · model                     ← bold #F6C453   │  header
├──────────────────────────────────────────────────────────────┤
│  user bubble (full-width block, bg #2B2F36, text #F3EEE0)    │
│  assistant reply (plain #E8E3D5, Markdown-mapped)            │
│  ┌ tool card: title #F6C453 on bg #1E2D23 ──────────────┐    │
│  │ output #E1DACB, ≤12 lines, Ctrl+O expands            │    │
│  └──────────────────────────────────────────────────────┘    │
│  system notice (#9BA3B2)                                     │
├──────────────────────────────────────────────────────────────┤
│ status: running · streaming · idle · error · queued   tokens   │  status line
├──────────────────────────────────────────────────────────────┤
│ ▸ message…                                          border #3C414B │  editor
└──────────────────────────────────────────────────────────────┘
   pickers (model/agent/session) overlay in place; ⏎ send  ^J newline
```

---

## 3. Hidden Termux blocker in the skin layer

`@earendil-works/pi-tui` ships **native addons**, with prebuilds only for:

```
linux-x64, linux-arm64 (x11), darwin-arm64, darwin-x64, win32-arm64, win32-x64
```

**No android-arm64.** So even if the daemon installed, the TUI path drags a native module that cannot
load on stock Termux (the same class of failure as `@lydell/node-pty`). Their core rendering is
TypeScript, so SuparClaw must ship its own pure-JS renderer — which is good, because a differential
renderer is a small, well-understood piece of code.

Two more mobile notes: `Instrument Sans` is a **webfont** (network or bundled bytes), and each theme
carries SVG + WebP background artwork — all decorative weight that a phone pays for in RAM and APK size.

---

## 4. SuparClaw skin plan — same-to-same look, ~2% of the weight

### 4.1 Web UI

| Piece | Plan |
|---|---|
| Tokens | Reuse their `base.css` token block verbatim (MIT — keep the copyright notice) as `ui/tokens.css` (~250 lines) |
| Themes | Ship **dark (default) + light warm-paper** only; drop 10 palettes and all artwork (keep 1 tiny SVG if we want a subtle backdrop) |
| Screens | Chat (thread + tool cards + composer + queue strip), Sessions sidebar, Settings/config, Channels, Health/Logs — 5 screens, not 25 |
| Editor | Plain `<textarea>` with slash-command autocomplete first; CodeMirror only if needed (it is ~300 KB) |
| Lists | Native scroll, no `@tanstack/virtual-core` until a session really needs it |
| Target | ≤ 150 KB CSS, ≤ 250 KB JS gzipped, Lighthouse-clean, one `theme-color` meta, mobile layout included (`layout.mobile.css` idea kept) |

Fidelity checklist (match these exactly): `--bg #0e1015` shell, `--accent #ff5c5c`, 48rem thread column,
14px/1.55 chat text, 16px inputs, 6/10/14/20 radii, 4–40px spacing, unread dots, collapsible tool
activity with counts, "Worked for …" summary, progress card, queued messages above the composer,
connection indicator bottom-left, reduced-motion support.

### 4.2 TUI

| Piece | Plan | Size |
|---|---|---|
| `tui/theme.ts` | their palette + light/dark luminance detection + Markdown mapping | ~120 lines |
| `tui/renderer.ts` | pure-JS differential renderer: render frame → lines → diff vs previous → write only changed spans (pi-tui's technique) | ~250 lines |
| `tui/components/` | chat-log, tool-card (12-line cap, UTF-16-safe truncate), editor, select-list, question-prompt, status/footer | ~900 lines |
| Keybindings | identical: Enter, ^J, Esc, ^C, ^D, ^L, ^G, ^P, ^O, ^T | — |
| Extras | OSC-8 hyperlinks (their `osc8-hyperlinks.ts` approach), Kitty keyboard if available, inline images when the terminal supports it | ~150 lines |

Result: **~1,400 lines, zero native code, identical look and keys** — versus their 180 files plus a
native addon that cannot load on Termux.

### 4.3 Licensing

OpenClaw is MIT. Reusing the token values, palette, and layout geometry is permitted if the copyright
notice travels with the files — which we keep in `ui/THIRD_PARTY-NOTICES.md` and a header comment in
`tokens.css` / `theme.ts`.

---

## 5. Design-parity acceptance test

1. Side-by-side screenshot: SuparClaw Control UI vs OpenClaw dark/light — surfaces, accents, bubbles,
   spacing, and type must be indistinguishable at a glance.
2. TUI recording: same header/footer/status/tool-card structure in the same colors; a diff of the
   rendered ANSI frames should differ only in text content.
3. Both surfaces stay under the performance budget in
   `suparclaw-architecture-spec.md` §6 (cold start < 400 ms daemon, web bundle < 400 KB total).