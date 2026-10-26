# Brand — the SuparClaw logo set

![The set](logo-set.png)

The mark is a crab pincer traced from the reference the owner picked; the
wordmark is **real font outlines**, so every SVG renders identically with no font
installed. Colours are the UI's own tokens (`ui/styles.css`):

| token | value | used for |
|---|---|---|
| warm surface | `#F4F3EF` | canvas |
| ink | `#17171A` | wordmark, badge |
| accent | `#2B50F0` | the joint dot, the `///` |
| dark surface | `#0E0E11` | reverse lockup |
| dark accent | `#8EA0FF` | dot on dark |

## Files

| file | what it is | use it for |
|---|---|---|
| `svg/01-lockup-inter-black.svg` | badge + Inter 900 | the main lockup: README header, CLI, docs |
| `svg/02-lockup-instrument.svg` | badge + Instrument Sans 400 | headers that sit next to the app UI |
| `svg/09-lockup-archivo.svg` | badge + Archivo 900 | posters, social, print — wider and sturdier |
| `svg/05-lockup-dark.svg` | reverse on `#0E0E11` | dark theme, OG image |
| `svg/06-lockup-mono.svg` | one colour, dot included | stamps, embossing, single-colour print |
| `svg/03-lockup-stacked.svg` | stacked + mono tagline | splash, store art |
| `svg/04-wordmark-slashes.svg` | wordmark + `///` | type-first hero, launch art |
| `svg/07-app-icon.svg` | the badge alone, 512 px | favicon, PWA, home screen |
| `svg/08-app-icon-plate.svg` | icon on the brand surface | social preview |

`mark/claw.path` is the traced outline (one path, `fill-rule="evenodd"`, 1024-box)
that every file embeds.

## Regenerating

```bash
npm i @fontsource/inter @fontsource/archivo      # the heavy faces (OFL)
npm i --no-save @resvg/resvg-js                  # only for PNG previews
node brand/tools/compose.mjs                     # writes brand/svg/*.svg
node brand/tools/render.mjs brand/svg/07-app-icon.svg /tmp/icon.png 512
```

`Instrument Sans` and `JetBrains Mono` come from `ui/fonts/`, so those always
resolve. Everything is measured from the font metrics — no hand-placed text — so
changing the word, weight or tracking means editing one line in
`brand/tools/compose.mjs` and re-running it.

`tools/trace_claw.py` regenerates `mark/claw.path` from
`ref/claw-mark-source.png` if the mark itself ever changes.
