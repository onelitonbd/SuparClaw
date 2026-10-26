// The SuparClaw claw mark — a solid silhouette.
//
// Benchmark: OpenClaw's own mark (brand/ref/openclaw-molty.svg) is a solid claw,
// not a line drawing. A traced outline of a brush stroke can never look designed
// — its width varies by definition — so this mark is built as filled geometry.
//
// The gesture, in the order it matters:
//
//   1. the pincer opens at an angle to the ARM. Collinear claw + arm reads as a
//      leaf, slipper or rocket; this was the single biggest failure of the
//      hand-tuned attempts (five of them).
//   2. two fingers of unequal weight — a thin blade above, a heavy lobe below.
//   3. between them a long mouth that stays open to the outside.
//   4. a mouth apex (throat) set well back, so the V bites into the palm.
//
// The palm, the blade and the lobe are three filled shapes of one colour: no
// strokes, so there is no cap, join or width to drift, and no seam is visible
// where they meet.

const BOX = 1024;
const PAD = 0.06;

const n = (v) => Math.round(v * 100) / 100;
const P = (q) => `${n(q[0])} ${n(q[1])}`;

/* ------------------------------------------------------------ geometry --- */

const bezier = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
};

const rotatePoint = (p, deg, o) => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [o[0] + (p[0] - o[0]) * c - (p[1] - o[1]) * s, o[1] + (p[0] - o[0]) * s + (p[1] - o[1]) * c];
};

const sample = (m, c, steps = 16) => {
  const pts = [m];
  let cur = m;
  for (const seg of c) {
    for (let i = 1; i <= steps; i++) pts.push(bezier(cur, seg[0], seg[1], seg[2], i / steps));
    cur = seg[2];
  }
  return pts;
};

const rectCorners = (r) => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x + r.w, r.y + r.h],
  [r.x, r.y + r.h],
];

const pathData = (m, c) => `M ${P(m)} ` + c.map((s) => `C ${P(s[0])} ${P(s[1])} ${P(s[2])}`).join(" ") + " Z";

/**
 * A finger: wide at a root buried inside the palm, tapering to one sharp tip.
 * `o1/o2` bow the outer edge, `i1/i2` bow the inner edge — the inner edge is what
 * forms the mouth wall, so its bow is what keeps the mouth open.
 */
function finger({ tip, r1, r2, o1, o2, i1, i2 }) {
  const mid = [(r1[0] + r2[0]) / 2, (r1[1] + r2[1]) / 2];
  return `M ${P(tip)} C ${P(o1)} ${P(o2)} ${P(r1)} L ${P(mid)} L ${P(r2)} C ${P(i1)} ${P(i2)} ${P(tip)} Z`;
}

/* -------------------------------------------------------------- presets --- */
//
// Local frame: arm along −x, pincer along +x, wrist pivot near (−330, 0).

const PALM = {
  m: [-330, -46],
  c: [
    [[-322, -156], [-248, -240], [-136, -286]],   // shoulder, up over the back
    [[-26, -322], [86, -306], [150, -262]],       // back into the upper root
    [[188, -228], [178, -120], [150, -14]],       // right edge, convex
    [[120, 76], [60, 130], [-8, 160]],            // belly shoulder
    [[-150, 216], [-284, 186], [-330, 118]],      // belly, back to the wrist
  ],
};

const ARM = -34;      // the arm hangs below the pincer's axis — the claw's gesture
const ARM_PIVOT = [-330, 40];

// the cuff overlaps the palm by ~140 units so the arm is part of the claw, not a
// tag stuck to it
const WRIST = { x: -486, y: -160, w: 300, h: 330, r: 44 };
const SLASHES = [-1, 0, 1].map((i) => ({ x: -452, y: -70 + i * 74, w: 124, h: 21 }));

// The mouth is a CUT, not a gap between two shapes. Every attempt to leave it as
// the space between a palm and a finger produced a hairline seam wherever the two
// edges came close to tangent; a cut in the plate colour cannot leave a seam
// because there is nothing to touch.
const MOUTH = {
  m: [-46, -104],                                   // throat, set back inside the palm
  c: [
    [[150, -186], [340, -252], [600, -292]],        // over the upper finger's underside
    [[820, -318], [1000, -330], [1180, -338]],      // out past the tip
    [[1180, 430], [1180, 420], [1140, 408]],        // around the open end
    [[760, 380], [560, 330], [470, 300]],           // back under the lower tip
    [[260, 190], [80, 60], [-10, -20]],             // under the lower finger's top edge
    [[-40, -52], [-50, -84], [-46, -104]],          // close at the throat
  ],
};

const MARK = {
  angle: -8,
  palm: PALM,
  // the upper finger arcs up and hooks back down to a sharp tip — a straight
  // blade reads as a beak, which is what the rejected cuts looked like
  upper: { tip: [544, -222], r1: [-30, -206], r2: [14, -132],
           o1: [334, -406], o2: [110, -330], i1: [344, -248], i2: [298, -212] },
  // the lower finger is shorter, heavier, and sweeps away below the mouth
  lower: { tip: [466, 266], r1: [-42, 0], r2: [-76, 160],
           o1: [288, 220], o2: [240, 112], i1: [66, 280], i2: [286, 340] },
  arm: ARM,
  armPivot: ARM_PIVOT,
  wrist: WRIST,
  slashes: SLASHES,
  pivot: [-80, 0],
};

export const PRESETS = { claw: MARK };

/* --------------------------------------------------------------- fit ----- */

export function fitMark(preset, box = BOX, pad = PAD) {
  const { palm, upper, lower, angle, pivot, arm, armPivot, wrist, slashes } = preset;
  const pts = [
    ...sample(palm.m, palm.c).map((p) => rotatePoint(p, angle, pivot)),
    ...[palm.m, ...palm.c.map((c) => c[2])].map((p) => rotatePoint(p, angle, pivot)),
  ];
  // fingers are straight lines from r1 to r2 through mid, so tip+r1+r2 suffice
  for (const f of [upper, lower]) {
    for (const p of [f.tip, f.r1, f.r2]) pts.push(rotatePoint(p, angle, pivot));
  }
  for (const p of [...rectCorners(wrist), ...slashes.flatMap(rectCorners)]) {
    pts.push(rotatePoint(rotatePoint(p, arm, armPivot), angle, pivot));
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const scale = (box * (1 - 2 * pad)) / span;
  return { scale, tx: box / 2 - ((minX + maxX) / 2) * scale, ty: box / 2 - ((minY + maxY) / 2) * scale };
}

/* -------------------------------------------------------------- emit ----- */

export function clawMark({ variant = "claw", color = "#EDEDF0", cut = "#17171A", wristColor = null, preset: override = null } = {}) {
  const preset = override ?? PRESETS[variant] ?? PRESETS.claw;
  const { scale, tx, ty } = fitMark(preset);
  const w = preset.wrist;
  const slashes = preset.slashes
    .map((s) => `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="${n(s.h / 2)}"/>`)
    .join("");
  return `<g transform="translate(${n(tx)} ${n(ty)}) scale(${scale.toFixed(5)})">
    <g transform="rotate(${preset.angle} ${preset.pivot[0]} ${preset.pivot[1]})">
      <g transform="rotate(${preset.arm} ${preset.armPivot[0]} ${preset.armPivot[1]})">
        <rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="${w.r}" fill="${wristColor ?? color}"/>
        <g fill="${cut}">${slashes}</g>
      </g>
      <path d="${pathData(preset.palm.m, preset.palm.c)}" fill="${color}"/>
      <path d="${finger(preset.upper)}" fill="${color}"/>
      <path d="${finger(preset.lower)}" fill="${color}"/>
    </g>
  </g>`;
}

export function markSvg({ variant = "claw", size = 512, bg = "#17171A", color = "#EDEDF0" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}" role="img" aria-label="SuparClaw claw mark">
${bg ? `  <rect width="${BOX}" height="${BOX}" fill="${bg}"/>\n` : ""}  ${clawMark({ variant, color, cut: bg ?? "#F4F3EF" })}
</svg>
`;
}

if (process.argv[1] && process.argv[1].endsWith("claw.mjs")) {
  const { writeFileSync } = await import("node:fs");
  for (const v of Object.keys(PRESETS)) writeFileSync(`/tmp/claw-${v}.svg`, markSvg({ variant: v }));
  console.log("wrote", Object.keys(PRESETS).map((v) => `/tmp/claw-${v}.svg`).join(" "));
}
