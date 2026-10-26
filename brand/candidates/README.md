# Claw mark — round 3

Solid silhouettes, rebuilt from filled geometry. Three weights to choose from.

| file | preset | what it is |
| --- | --- | --- |
| `claw-1.svg` / `.png` | `b1` | the default: long hooked upper finger, medium lower one |
| `claw-2.svg` / `.png` | `b2` | heavier palm, mouth set higher, wrist larger |
| `claw-3.svg` / `.png` | `b3` | chunky, shorter reach — survives 24 px |
| `claw-compare.png` | — | all three next to the old traced mark, at 300 / 48 / 24 px and in one colour |

## Why the two earlier marks are gone

**The traced mark** (`brand/mark/claw.path`, "NOW" in the sheet) is a traced
*brush-stroke outline*: 191 cubics following a hand-drawn line whose weight varies
along its length. A stroke that changes width by construction can never look like
a drawn logo, no matter how much the outline is smoothed — the wobble is in the
shape, not in the tracing tolerance.

**The capsule mark** (round 2) was rejected as a spanner: round caps, equal finger
weights, and a claw that ran straight down its own arm.

## The rules this round follows

Everything below is encoded in `brand/tools/claw.mjs`, so a future edit that breaks
one of them is visible in the diff:

1. **The pincer opens at an angle to the arm.** A claw collinear with its own arm
   reads as a leaf, a slipper or a rocket. The wrist is rotated `arm: -34°` inside
   the mark's own frame.
2. **The upper finger hooks over a shorter lower one.** Two similar fingers of
   equal reach read as a bird's beak; the hook is what makes it a pincer.
3. **The fingers carry unequal weight** — a thin blade above, a heavy lobe below.
4. **A mouth, not a notch** — the gap stays open to the outside.
5. **No strokes anywhere.** Palm, fingers and wrist are filled shapes of one
   colour, so there is no cap, no join, and no stroke width to drift.
6. **The three wrist slashes are the brand's `///`**, cut out of the wrist band.

## Regenerating

```bash
npm i --no-save @resvg/resvg-js      # repo root; only needed for the PNGs

node brand/tools/claw.mjs            # writes /tmp/claw-b{1,2,3}.svg
for v in b1 b2 b3; do
  node brand/tools/render.mjs /tmp/claw-$v.svg /tmp/claw-$v.png 640
done
```

`claw.mjs` is the source of truth; the SVGs here are generated. Edit the `V`
presets (tip / root / control points, all in a 1024-unit space with the arm along
−x) rather than the SVG files.

## Colours

The mark is one colour plus the plate it sits on:

- dark: mark `#EDEDF0` on plate `#17171A`
- light: mark `#17171A` on plate `#F4F3EF`
- accent: `#2B50F0`

`cut` (the slash colour) must be the plate colour, otherwise the slashes show as
foreign blocks on an inverted plate.
