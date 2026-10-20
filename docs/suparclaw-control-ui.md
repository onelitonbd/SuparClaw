# Control UI (web)

SuparClaw's web UI is served by the gateway at `http://127.0.0.1:18790/`.
It is a hand-written TypeScript app (no framework) that renders into OpenClaw's
own design system, so the SuparClaw web UI and the OpenClaw Control UI look and
behave the same.

## How it is put together

```
ui/
  index.html          shell markup (OpenClaw anatomy)
  sc-overlay.css      SuparClaw-only rules, appended after the vendored sheets
  vendor/openclaw/    37 stylesheets copied from OpenClaw (MIT) + MANIFEST.txt
  src/
    main.ts           shell, sidebar, drawer, routing, event wiring
    chat.ts           transcript groups, streaming, tool cards, approvals
    settings.ts       model / providers / gateway / runtime
    picker.ts         model chooser
    markdown.ts       safe markdown → HTML
    rpc.ts            gateway WebSocket client
scripts/build.mjs     bundles the app and assembles + minifies the stylesheet
```

`scripts/build.mjs` concatenates the vendored sheets in `MANIFEST.txt` order
(dependencies first), inlines their `@import`s, appends `ui/sc-overlay.css`,
minifies the result with esbuild and writes `dist/ui/styles.css`. The phone
never runs a build step: `dist/` is committed and the installer copies it.

## The visual system

OpenClaw is MIT licensed, so its Control UI stylesheets are vendored verbatim
(`ui/vendor/openclaw/NOTICE.md` keeps the attribution). The parts we use:

| Sheet | What it styles |
| --- | --- |
| `styles_base.css` | design tokens, resets, markdown base |
| `styles_theme-backgrounds.css` | palette hooks (artwork is disabled in our overlay) |
| `styles_layout.css`, `styles_layout.mobile.css` | shell grid, sidebar, drawer, settings mode |
| `styles_components.css` | buttons, pills, toasts, avatars, chips |
| `styles_chat_*.css` | transcript, bubbles, tool cards, composer, code blocks |
| `styles_settings*.css` | settings rows, inputs, sections |
| `components_solid_overlay.css`, `components_solid_modal-dialog.css` | menus and dialogs |

SuparClaw's own rules live in `ui/sc-overlay.css` and are always last, so they
win over the vendored cascade. They cover what OpenClaw does not have: the
session chip, the connection pill, the stats block, the jump-to-latest pill,
the streaming caret, the empty state, the model picker rows and the settings
rows.

## DOM anatomy

The markup follows OpenClaw's class names so their CSS applies unchanged.

```
#app.shell.shell--chat
├── header.topbar                  narrow viewports only
├── .shell-nav
│   ├── aside.sidebar              sessions, stats, theme + settings buttons
│   └── section.settings-sidebar   shown in settings mode
├── button.shell-nav-backdrop      mobile drawer scrim
└── main.content.content--chat
    ├── .chat.chat--bubbles
    │   ├── header.chat-pane__header
    │   ├── .chat-thread > .chat-thread-inner
    │   │   └── .chat-group(.user|.assistant|.tool).chat-group--with-footer
    │   │       ├── .chat-avatar
    │   │       ├── .chat-group-messages > .chat-bubble > .chat-text
    │   │       └── .chat-group-footer > .chat-group-footer__meta / -actions
    │   └── footer.chat-footer
    │       └── .agent-chat__input > .agent-chat__composer-shell
    │           ├── .agent-chat__composer-status     approvals, token hint
    │           └── .agent-chat__composer-footer     model, send, stop
    └── section#settings-view
```

Tool calls are rendered as a bubble shell with a disclosure:

```
.chat-bubble.chat-bubble--tool-shell
├── .chat-tools-inline > button.chat-inline-disclosure[aria-expanded]
│   └── .chat-tool-msg-summary (__icon, __label, __preview)
└── .chat-tool-msg-body                 (opened by the disclosure)
```

Dialogs are a native `<dialog class="oc-modal-dialog">` — the browser gives us
focus trapping, Esc handling and the `::backdrop` for free. Toasts are
`.app-toast` nodes appended to `#toasts`.

## Responsive behaviour

`main.ts` mirrors the viewport onto the shell: below 900px the shell gets
`shell--mobile-nav shell--nav-collapsed`, the topbar appears and the sidebar
becomes an overlay drawer (`.shell--nav-drawer-open` + `.shell-nav-backdrop`).
The settings route adds `shell--settings`, which swaps the sidebar for the
settings sidebar and widens the navigation column to 288px.

## Adding a feature

1. Emit OpenClaw's class names where they exist — the vendored CSS already
   styles them.
2. Add anything new to `ui/sc-overlay.css` (never edit `ui/vendor/openclaw/`).
3. Rebuild: `npm run build`. `dist/ui` is committed, so the phone picks the
   change up on the next `sc gateway` start (or reinstall).

## Theme

`data-theme="claw"` selects the palette, `data-theme-mode="dark|light"` flips
between the two token sets, and the toggle in the sidebar footer persists the
choice in `localStorage` under `sc.theme`.
