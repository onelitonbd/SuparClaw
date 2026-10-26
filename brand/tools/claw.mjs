// The SuparClaw claw mark — built from capsules, not from drawn curves.
//
// Why this file exists: the first mark was traced from a raster reference, so
// every edge carried that picture's hand-drawn wobble. Curves placed by hand have
// the same problem — a bezier or arc is only as even as the person's numbers.
//
// So the mark is assembled from parts whose edges cannot be uneven:
//
//   • every finger is a *capsule* — a straight spine stroked at one width with
//     round caps, so its sides are exactly parallel and its tip is exactly a
//     semicircle;
//   • a finger tapers by stacking a wide short capsule into a thin long one: the
//     silhouette narrows while every end stays a true arc;
//   • the palm is an ellipse and the cuff a rounded rectangle;
//   • the mouth is simply the gap between the two fingers — nothing is drawn and
//     then cut out, so the V can never leave a seam.
//
// Three proportions are kept here so they can be compared side by side; see
// `brand/candidates/`.

const BOX = 1024;
const PAD = 0.055;
const n = (v) => Math.round(v * 100) / 100;
const D = Math.PI / 180;

/* ------------------------------------------------------------- presets --- */

export const PRESETS = {
  // balanced: 40° mouth, even palm-to-finger ratio
  a: {
    palm: { rx: 124, ry: 158, rot: -8 },
    cuff: { w: 112, h: 112, r: 28 },
    rivet: 30,
    fingers: [
      { base: [70, -58], angle: -40, length: 400, width: 100, tip: 44 },
      { base: [70, 58], angle: 40, length: 400, width: 100, tip: 44 },
    ],
  },
  // wide mouth: fingers leave from further forward, so the V reads first
  b: {
    palm: { rx: 124, ry: 158, rot: -8 },
    cuff: { w: 112, h: 112, r: 28 },
    rivet: 30,
    fingers: [
      { base: [84, -40], angle: -30, length: 420, width: 104, tip: 48 },
      { base: [84, 40], angle: 30, length: 420, width: 104, tip: 48 },
    ],
  },
  // sharp: 48° mouth, shorter palms, the most aggressive of the three
  c: {
    palm: { rx: 120, ry: 152, rot: -8 },
    cuff: { w: 108, h: 108, r: 26 },
    rivet: 28,
    fingers: [
      { base: [76, -70], angle: -48, length: 390, width: 96, tip: 40 },
      { base: [76, 70], angle: 48, length: 390, width: 96, tip: 40 },
    ],
  },
};

/** Where the palm sits, given the cuff: the two never overlap. */
function palmCentre(p) {
  return { x: 10, y: 0 };
}

/* -------------------------------------------------------------- drawing -- */

const capsule = (a, b, width) =>
  `<path d="M ${n(a[0])} ${n(a[1])} L ${n(b[0])} ${n(b[1])}" stroke-width="${n(width)}" stroke-linecap="round"/>`;

/** One tapered finger: a wide base capsule feeding a thin tip capsule. */
function finger({ base, angle, length, width, tip }) {
  const dx = Math.cos(angle * D);
  const dy = Math.sin(angle * D);
  const mid = [base[0] + dx * length * 0.6, base[1] + dy * length * 0.6];
  const end = [base[0] + dx * length, base[1] + dy * length];
  // the tip capsule starts slightly behind the joint so the two overlap cleanly
  const join = [mid[0] - dx * 18, mid[1] - dy * 18];
  return capsule(base, mid, width) + capsule(join, end, tip);
}

/* ----------------------------------------------------------------- fit --- */

function extents(preset) {
  const pts = [];
  const pc = palmCentre(preset);
  for (const f of preset.fingers) {
    const dx = Math.cos(f.angle * D);
    const dy = Math.sin(f.angle * D);
    const end = [f.base[0] + dx * f.length, f.base[1] + dy * f.length];
    // generous: half the base width covers both the body and the round cap
    const r = f.width / 2;
    pts.push([f.base[0] - r, f.base[1] - r], [f.base[0] + r, f.base[1] + r]);
    pts.push([end[0] - r, end[1] - r], [end[0] + r, end[1] + r]);
  }
  pts.push(
    [pc.x - preset.palm.rx, pc.y - preset.palm.ry],
    [pc.x + preset.palm.rx, pc.y + preset.palm.ry],
    [pc.x - preset.palm.rx - preset.cuff.w - 10, pc.y - preset.cuff.h / 2],
    [pc.x + preset.palm.rx, pc.y + preset.cuff.h / 2],
  );
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

/* --------------------------------------------------------------- output -- */

/**
 * The mark as a group fitted into a 1024 box.
 * `variant` picks a proportion preset; `color`/`dot` are the two brand colours.
 */
export function clawMark({ variant = "a", color = "#EDEDF0", dot = "#2B50F0" } = {}) {
  const preset = PRESETS[variant] ?? PRESETS.a;
  const pc = palmCentre(preset);
  const e = extents(preset);
  const span = Math.max(e.maxX - e.minX, e.maxY - e.minY);
  const scale = (BOX * (1 - 2 * PAD)) / span;
  const tx = BOX / 2 - ((e.minX + e.maxX) / 2) * scale;
  const ty = BOX / 2 - ((e.minY + e.maxY) / 2) * scale;

  const cuffX = pc.x - preset.palm.rx - preset.cuff.w + 8;
  const cuffY = pc.y - preset.cuff.h / 2;

  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(5)})">
    <g fill="${color}" stroke="${color}" stroke-linejoin="round">
      <rect x="${n(cuffX)}" y="${n(cuffY)}" width="${preset.cuff.w}" height="${preset.cuff.h}" rx="${preset.cuff.r}" stroke="none"/>
      <g fill="none">${preset.fingers.map(finger).join("")}</g>
      <ellipse cx="${pc.x}" cy="${pc.y}" rx="${preset.palm.rx}" ry="${preset.palm.ry}" transform="rotate(${preset.palm.rot} ${pc.x} ${pc.y})" stroke="none"/>
    </g>
${dot ? `    <circle cx="${n(cuffX + 26)}" cy="${pc.y}" r="${preset.rivet}" fill="${dot}"/>\n` : ""}  </g>`;
}

/** A complete, standalone SVG for one variant. */
export function markSvg(variant, { size = 512, bg = "#17171A", color = "#EDEDF0", dot = "#2B50F0" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024" role="img" aria-label="SuparClaw claw mark">
${bg ? `  <rect width="1024" height="1024" fill="${bg}"/>\n` : ""}  ${clawMark({ variant, color, dot })}
</svg>
`;
}

export const CLAW = { BOX, PAD, PRESETS };

if (process.argv[1] && process.argv[1].endsWith("claw.mjs")) {
  const { writeFileSync } = await import("node:fs");
  for (const v of Object.keys(PRESETS)) {
    writeFileSync(`/tmp/claw-${v}.svg`, markSvg(v));
  }
  console.log("wrote /tmp/claw-a.svg /tmp/claw-b.svg /tmp/claw-c.svg");
}
