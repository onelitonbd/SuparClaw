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
  m: [-330, 40],
  c: [
    [[-326, -112], [-240, -214], [-118, -254]],   // shoulder, up over the back
    [[-26, -290], [42, -264], [74, -202]],        // back into the upper root
    [[92, -158], [70, -76], [44, -4]],            // right edge, behind the throat
    [[22, 66], [-4, 116], [-48, 156]],            // belly shoulder
    [[-176, 246], [-298, 202], [-330, 40]],       // around the wrist
  ],
};

const ARM = -34;      // the arm hangs below the pincer's axis — the claw's gesture
const ARM_PIVOT = [-330, 40];

const WRIST = { x: -512, y: -136, w: 196, h: 316, r: 40 };
const SLASHES = [-1, 0, 1].map((i) => ({ x: -466, y: -62 + i * 74, w: 116, h: 20 }));

const V = {
  // b1 — thin blade, heavy lobe, wide mouth
  b1: {
    angle: -12,
    palm: PALM,
    upper: { tip: [566, -286], r1: [-40, -216], r2: [-58, -84],
             o1: [286, -424], o2: [40, -330], i1: [250, -178], i2: [418, -214] },
    lower: { tip: [498, 286], r1: [-48, 4], r2: [-80, 168],
             o1: [300, 236], o2: [250, 120], i1: [70, 300], i2: [300, 366] },
  },
  // b2 — blade lifted, mouth deeper
  b2: {
    angle: -16,
    palm: PALM,
    upper: { tip: [596, -302], r1: [-52, -226], r2: [-66, -100],
             o1: [300, -456], o2: [36, -352], i1: [270, -190], i2: [448, -228] },
    lower: { tip: [512, 320], r1: [-44, -18], r2: [-92, 148],
             o1: [312, 268], o2: [262, 148], i1: [62, 320], i2: [300, 392] },
  },
  // b3 — chunkier; the 16 px cut
  b3: {
    angle: -8,
    palm: PALM,
    upper: { tip: [512, -258], r1: [-34, -206], r2: [-52, -84],
             o1: [258, -378], o2: [30, -296], i1: [228, -160], i2: [382, -194] },
    lower: { tip: [466, 266], r1: [-42, 0], r2: [-76, 160],
             o1: [288, 220], o2: [240, 112], i1: [66, 280], i2: [286, 340] },
  },
};

export const PRESETS = Object.fromEntries(
  Object.entries(V).map(([k, v]) => [
    k,
    { ...v, arm: ARM, armPivot: ARM_PIVOT, wrist: WRIST, slashes: SLASHES, pivot: [-80, 0] },
  ]),
);

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

export function clawMark({ variant = "b1", color = "#EDEDF0", cut = "#17171A", wristColor = null } = {}) {
  const preset = PRESETS[variant] ?? PRESETS.b1;
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

export function markSvg({ variant = "b1", size = 512, bg = "#17171A", color = "#EDEDF0" } = {}) {
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
