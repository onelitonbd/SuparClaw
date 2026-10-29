# Claw mark — final

The mark the owner picked, with the two fixes he asked for: the upper finger now
curves over a shorter lower one, and the wrist is part of the arm instead of a
tag stuck to it.

| file | what it is |
| --- | --- |
| `claw-final.svg` / `.png` | the mark: dark plate, light claw, three slashes in the wrist |
| `claw-compare.png` | final next to the rejected traced mark, at 300 / 48 / 24 px and in one colour |

Generated from `brand/tools/claw.mjs`; every lockup in `brand/svg/` composes the
same `clawMark()`.

## What changed, and why

**The traced mark is gone.** `brand/mark/claw.path` is a traced *brush-stroke
outline* — 191 cubics following a hand-drawn line whose weight varies along its
length. A stroke that changes width by construction can never read as a drawn
logo, however much the outline is smoothed: the wobble is in the shape, not in the
tracing tolerance.

**The capsule round is gone too.** Round caps, equal finger weights, and a claw
running straight down its own arm produced a spanner.

## The rules the mark follows

Each one is a fix for a specific failure, and each is visible in
`brand/tools/claw.mjs`:

1. **The pincer opens at an angle to the arm** (`arm: -34°` inside the mark's own
   frame). Collinear claw + arm reads as a leaf, a slipper or a rocket.
2. **The upper finger curves over a shorter, heavier lower one.** Two similar
   fingers of equal reach read as a bird's beak; a straight blade with no curve
   reads as a spike.
3. **A mouth, not a notch** — the gap stays open to the outside.
4. **Unequal weight**: thin-ish blade above, heavy lobe below.
5. **No strokes anywhere.** Palm, fingers and wrist are filled shapes of one
   colour, so there is no cap, no join and no stroke width to drift.
6. **The wrist band overlaps the palm** by ~140 units, so the arm reads as part of
   the claw rather than a separate tag.
7. **The brand's `///` is cut into the wrist** as three slashes.

## Regenerating

```bash
npm i --no-save @resvg/resvg-js      # repo root; PNGs only

node brand/tools/claw.mjs            # -> /tmp/claw-claw.svg
node brand/tools/render.mjs /tmp/claw-claw.svg /tmp/claw.png 640
node brand/tools/compose.mjs         # the nine lockups in brand/svg/
```

## Colours

The mark is one colour plus whatever plate it sits on:

- dark: mark `#EDEDF0`, slashes cut to the plate
- light: mark `#17171A`, slashes cut to the plate
- accent: `#2B50F0` — used when the slashes carry the brand (lockups 01–03, 05, 08)
