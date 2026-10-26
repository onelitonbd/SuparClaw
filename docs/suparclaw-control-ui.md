# Control UI (web)

SuparClaw's web UI is served by the gateway at `http://127.0.0.1:18790/`.
It is a hand-written TypeScript app (no framework) built on the **SuperClaw
Mobile** design system: warm neutral surfaces, one blue accent, 44px touch
targets, Instrument Sans + JetBrains Mono.

## Layout

The app is a single column, phone first — the same shape the design reference
uses (390 × 844) — and grows into a centred column on wider screens.

```
.rail                     60px top bar: sessions, connection, settings, theme
├── .view--chat
│   ├── .scroll > .stack  transcript (messages, tool cards, notices)
│   └── .dock             approval card, jump-to-latest, composer
└── .view--settings       back button, tab strip, cards
```

Overlays (all with a scrim, all dismissable with Esc or a tap outside):

- `#drawer-overlay` — sessions drawer, slides in from the left (316px)
- `#sheet-overlay` — model picker, slides up from the bottom
- `#modal-overlay` — confirmations, token entry, provider forms

New chat asks nothing: it opens an empty `main:<timestamp>` session immediately,
and the session names itself from its first exchange (the second refines it —
see "Naming new chats" in the README). Until a name exists the row and the
`#session-title` header read "New chat" (or "Main chat" for `main:main`), never
the raw key; the key stays on the row's tooltip and accessible name. Every
writer of the header goes through `setHeaderTitle()`, and `refresh()` re-reads
the row so a name that arrives mid-conversation appears without a reload.

### Attachments in the transcript

A message's files are stored as `<media:…>` tags (that is the model's syntax).
`Chat.user()` splits them with `ui/src/media-refs.ts` and draws a chip —
`📎 report.pdf · 512 KB` — instead of the XML, on the live path and on every
reload/replay alike. Clicking a chip fetches `GET /media/<workspace path>` with
the gateway token and downloads the file; the route is confined to
`workspace/media`, refuses symlinks, and answers 404 when the file was pruned
(the chip then says "file removed"). Rejections and omitted files stay visible
as a muted chip, never as a silently missing message.

## Design tokens

`ui/styles.css` holds the whole system. Light is the default; the dark set is
the same file under `html[data-theme-mode='dark']` (the toggle in the rail
persists the choice in `localStorage` under `sc.theme`).

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--bg` | `#F4F3EF` | `#0E0E11` | app background, tool detail panels |
| `--panel` | `#FBFAF8` | `#131316` | top rail, drawer, modal footer |
| `--surface` | `#FFFFFF` | `#19191D` | cards, composer, sheet, toasts |
| `--ink` / `--ink2` / `--ink3` | `#17171A` / `#55555C` / `#6B6B73` | `#EDEDF0` / `#A9A9B2` / `#8F8F99` | text |
| `--line` | `#E3E1DB` | `#2A2A31` | borders, dividers |
| `--hover` | `#ECEAE4` | `#222228` | pressed / hovered rows |
| `--accent` | `#2B50F0` | `#8EA0FF` | user bubble, send button, focus ring |
| `--accsoft` | `#E8ECFF` | `#1F2550` | assistant avatar, active tab |
| `--ok` / `--oksoft` | `#1B7F4F` / `#E2F3EA` | `#4CC38A` / `#14301F` | tool success, connected dot |
| `--warn` / `--warnsoft` / `--warnline` | `#8F5A00` / `#FFF4DC` / `#EBCB8A` | `#E5A93D` / `#2E2410` / `#5A4515` | approvals |
| `--err` / `--errsoft` | `#C23A2B` / `#FBE6E3` | `#F2766A` / `#3A1A17` | tool failure, remove |
| `--shadow` | `0 1px 2px …, 0 12px 32px …` | same, darker | composer, sheet, modal, toasts |

Type: **Instrument Sans** (400/500/600/700) for UI text, **JetBrains Mono**
(400/500) for model names, tool names, durations and code. Both are vendored as
woff2 in `ui/fonts/` (SIL OFL) so the UI keeps its typography with no network.

## Components

| Class | What it is |
| --- | --- |
| `.ibtn` | 44×44 icon button, 12px radius |
| `.btn` / `.btn.pri` / `.btn.danger` | 44px button; `.pri` filled with the accent |
| `.inp` | 44px input, 16px text (no iOS zoom) |
| `.card` | 16px padding, 14px radius, hairline border |
| `.chip` | suggestion chip in the empty state |
| `.bubble` | user message, accent filled, `18px 18px 4px 18px` |
| `.msg--assistant` | assistant turn: `.msg__head` (avatar, name, status) + `.msg__body` |
| `.tool` | tool card: `.tool__row` (status icon, name, summary, duration) + `.tool__body` |
| `.composer` | message box with model button, token hint, send/stop |
| `.approval` | approval card above the composer (warn palette) |
| `.sheet` / `.drawer` / `.modal` | bottom sheet, sessions drawer, dialog |
| `.toast` | transient message with a status dot |

Animations mirror the reference: `fadeUp`, `fadeIn`, `fadeDown`, `pop`,
`slideR`, `slideU`, `toastDown`, plus the `spin`, `blink`, `dot` and `pulse`
loops. `prefers-reduced-motion: reduce` turns all of them off.

## Source layout

```
ui/
  index.html          markup
  styles.css          the design system
  fonts/              Instrument Sans + JetBrains Mono (woff2 + @font-face)
  src/
    main.ts           rail, drawer, routing, event wiring
    chat.ts           transcript, streaming, tool cards, approvals
    settings.ts       Model / Providers / Gateway / Runtime tabs
    picker.ts         model sheet
    markdown.ts       safe markdown → HTML
    dom.ts            element helpers, modal, toasts
    rpc.ts            gateway WebSocket client
scripts/build.mjs     bundles the app, minifies the stylesheet, copies fonts
```

The build concatenates `ui/fonts/fonts.css` with `ui/styles.css`, minifies
with esbuild and writes `dist/ui/styles.css`; the woff2 files are copied to
`dist/ui/fonts/`. The gateway serves them with `font/woff2`.

## Mobile layout rules

The app is one fixed viewport (`100dvh`), never a scrolling page, so the
platform chrome has to be handled explicitly:

- `index.html` sets `viewport-fit=cover` and `interactive-widget=resizes-content`
  — the keyboard resizes the viewport instead of pushing the composer off it.
- `.rail` (top) and `.settings__topbar` add `env(safe-area-inset-top)` to their
  height and padding; `.dock` (composer) adds `env(safe-area-inset-bottom)` to
  its bottom padding; `.drawer` pads both. A notched phone therefore never
  slides a control under the notch or the home indicator.
- Text inputs are ≥16 px so iOS does not zoom on focus; touch targets grow
  under `@media (pointer: coarse)`.
- Below 880 px the settings rail and the chat drawer become overlays
  (`min(84vw, 320px)`) instead of columns.
- Wide tables live inside a scrolling wrapper (`.settings .usage-tablewrap`),
  never inside the page body.

`test/ui-mobile.test.mjs` pins each of these against `index.html` and the
stylesheet.

## The gateway's method list

The gateway answers `hello-ok` with `methods: string[]` — every RPC it can
handle. `ui/src/rpc.ts` keeps that list and logs a one-time
`[gateway] this server does not advertise <method>` warning if the app asks
for something the running server does not have (an old build, a stale
`dist/ui`, a removed handler). `test/ui-backend-contract.test.mjs` enforces
the three-way contract: every method the UI calls is both advertised and
handled, and nothing is advertised twice.

## Adding a feature

1. Use the tokens — never hard-code a colour.
2. Reuse the component classes above; the design already has a slot for most
   things.
3. Rebuild: `npm run build`. `dist/ui` is committed, so the phone picks the
   change up on the next `sc gateway` start (or reinstall).

## History

The first version of this UI was built on OpenClaw's own Control UI
stylesheets (vendored under `ui/vendor/openclaw`, MIT). That approach was
replaced by the SuperClaw Mobile design system in `bf4f550` — the vendored
sheets are gone, and the stylesheet went from 665 KB to 19 KB.
