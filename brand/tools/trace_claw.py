#!/usr/bin/env python3
"""Trace a black line-art icon into ONE filled SVG path (evenodd, holes kept).

Input:  a pure black-on-white PNG (the generated mark source).
Output: JSON { viewBox, d, dot:{cx,cy,r}|null }

Why trace: the mark has to be a real vector for favicons and print, and a
hand-drawn keyframe approximation of these curves looked nothing like it.
"""
import json
import re
import sys

import numpy as np
from PIL import Image
from skimage import measure

SRC = sys.argv[1] if len(sys.argv) > 1 else "ref/claw-mark-source.png"
SIZE = 1024
PAD = 0.06           # 6% breathing room inside the box
SIMPLIFY = 2.6       # px at the working resolution
SMOOTH = 0.34        # Catmull-Rom tension

im = Image.open(SRC).convert("L")
w, h = im.size
# Work at 2x so a 1.8px simplification is still sub-pixel in the source.
F = 4
big = im.resize((w * F, h * F), Image.LANCZOS)
a = np.asarray(big).astype(float) / 255.0
ink = a < 0.5

pad = np.zeros((ink.shape[0] + 2, ink.shape[1] + 2))
pad[1:-1, 1:-1] = ink
contours = measure.find_contours(pad, 0.5)
if not contours:
    raise SystemExit("nothing to trace")


def simplify(c, tol):
    pts = np.column_stack([c[:, 1], c[:, 0]])  # x, y
    return measure.approximate_polygon(pts, tol)


def bezier(pts):
    p = [tuple(map(float, q)) for q in pts]
    if len(p) < 4:
        return ""
    if np.allclose(p[0], p[-1]):
        p = p[:-1]
    n = len(p)
    out = [f"M {p[0][0]:.1f} {p[0][1]:.1f}"]
    for i in range(n):
        p0, p1 = p[(i - 1) % n], p[i]
        p2, p3 = p[(i + 1) % n], p[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) * SMOOTH / 3, p1[1] + (p2[1] - p0[1]) * SMOOTH / 3)
        c2 = (p2[0] - (p3[0] - p1[0]) * SMOOTH / 3, p2[1] - (p3[1] - p1[1]) * SMOOTH / 3)
        out.append(f"C {c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}")
    out.append("Z")
    return " ".join(out)


def area(c):
    pts = np.column_stack([c[:, 1], c[:, 0]])
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


kept = [c for c in contours if area(c) > 160]
pieces = [bezier(simplify(c, SIMPLIFY)) for c in kept]
d = " ".join(p for p in pieces if p)

nums = [float(v) for v in re.findall(r"-?\d+\.?\d*", d)]
xs, ys = nums[0::2], nums[1::2]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
span = max(maxx - minx, maxy - miny)
inner = SIZE * (1 - 2 * PAD)
s = inner / span
ox = (SIZE - (maxx - minx) * s) / 2 - minx * s
oy = (SIZE - (maxy - miny) * s) / 2 - miny * s

# Rewrite the path in final coordinates so consumers need no transform.
def remap(m):
    return m.group(0)


tokens = re.findall(r"[A-Za-z]|-?\d+\.?\d*", d)
out, is_x = [], True
for t in tokens:
    if t.isalpha():
        out.append(t)
        is_x = True
        continue
    v = float(t)
    out.append(f"{v * s + (ox if is_x else oy):.2f}")
    is_x = not is_x

final = " ".join(out).replace("M ", "M").replace("C ", "C").replace("Z ", "Z ")

json.dump({"viewBox": SIZE, "d": final}, sys.stdout)
