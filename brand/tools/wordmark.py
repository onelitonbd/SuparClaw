#!/usr/bin/env python3
"""Turn a font file into an SVG path for a word — real outlines, no font at render time.

Usage:
  wordmark.py <font.woff2|ttf> <text> <unitsPerEm-out> <tracking-em> [weight]

Prints JSON: {"d": "<path d>", "width": <advance in px>, "cap": ..., "xheight": ...}
Coordinates are y-down with the baseline at y=0, so a caller can translate.
"""
import json
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

path, text, size, tracking = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
font = TTFont(path)
upm = font["head"].unitsPerEm
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font["hmtx"]

scale = size / upm
pen_x = 0.0
parts = []
advances = []
for ch in text:
    name = cmap.get(ord(ch))
    if name is None:
        raise SystemExit(f"missing glyph {ch!r}")
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(pen)
    d = pen.getCommands()
    if d:
        parts.append((pen_x, d))
    adv = hmtx[name][0]
    advances.append(adv)
    pen_x += adv + (tracking * upm)

total = (pen_x - tracking * upm) * scale

def tx(x):
    return round(x * scale, 3)

out = " ".join(f'<path transform="translate({tx(x)} 0)" d="{d}"/>' for x, d in parts)  # placeholder
# Build one flat path with a matrix per glyph instead (keeps one <path> per glyph for editing).
combined = []
for x, d in parts:
    # font units: the caller scales the whole group (mixing px and units here
    # silently multiplied every advance by the scale once more)
    combined.append({"x": round(x, 3), "d": d})

os2 = font["OS/2"]
print(json.dumps({
    "scale": scale,
    "width": round(total, 3),
    "capHeight": round(os2.sCapHeight * scale, 3),
    "xHeight": round(os2.sxHeight * scale, 3),
    "ascender": round(font["hhea"].ascent * scale, 3),
    "descender": round(font["hhea"].descent * scale, 3),
    "glyphs": combined,
}))
