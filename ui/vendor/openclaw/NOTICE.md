# Vendored stylesheets

These 37 CSS files are copied, unmodified, from the OpenClaw Control UI
(<https://github.com/openclaw/openclaw>, `ui/src/styles/**`), MIT License,
Copyright OpenClaw contributors.

SuparClaw ships them because the visual system — tokens, shell layout,
bubbles, tool cards, composer, settings controls — is designed there. Our own
rules live in `ui/sc-overlay.css`, which is appended **after** these files at
build time, and the assembled, minified result is what lands in
`dist/ui/styles.css`.

- `MANIFEST.txt` — assembly order (dependency-resolved; `@import`s are inlined
  and stripped by `scripts/build.mjs`)
- When upgrading: re-copy the files from upstream, keep the manifest in sync,
  and re-check that `ui/sc-overlay.css` still targets the same selectors.

None of these files reference external assets — every icon is an inline
data: URI, and there are no `@font-face` rules.
