// Compose SuparClaw logos: the traced claw mark + a heavy grotesque wordmark.
//
//   node tools/compose.mjs
//
// Every wordmark is real font outlines (see tools/wordmark.py) — the SVGs need
// no font installed to render. The mark is a traced path (tools/trace_claw.py)
// so it matches the reference the user picked instead of approximating it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "svg");
mkdirSync(OUT, { recursive: true });

const C = {
  bg: "#F4F3EF",      // ui/styles.css --bg
  ink: "#17171A",     // --ink
  ink3: "#6B6B73",    // --ink3
  accent: "#2B50F0",  // --accent
  dark: "#0E0E11",    // dark --bg
  darkInk: "#EDEDF0", // dark --ink
  darkMuted: "#8F8F99",
  periwinkle: "#8EA0FF", // dark --accent
};

/* ------------------------------------------------------------------- fonts */

// Instrument Sans + JetBrains Mono ship with the app (`ui/fonts`), so those two
// always resolve. The heavier faces are OFL but not vendored: fetch them with
//   npm i @fontsource/inter @fontsource/archivo
// or drop the .woff2 files into brand/fonts/.
const FONT_DIRS = [
  join(ROOT, "fonts"),
  join(ROOT, "..", "node_modules", "@fontsource", "inter", "files"),
  join(ROOT, "..", "node_modules", "@fontsource", "archivo", "files"),
];

function findFont(file) {
  for (const dir of FONT_DIRS) {
    const p = join(dir, file);
    if (existsSync(p)) return p;
  }
  throw new Error(`missing font ${file} — run: npm i @fontsource/inter @fontsource/archivo (or put it in brand/fonts/)`);
}

const FONTS = {
  inter900: () => findFont("inter-latin-900-normal.woff2"),
  inter800: () => findFont("inter-latin-800-normal.woff2"),
  archivo900: () => findFont("archivo-latin-900-normal.woff2"),
  instrument: () => join(ROOT, "..", "ui", "fonts", "instrument-sans-latin.woff2"),
  mono: () => join(ROOT, "..", "ui", "fonts", "jetbrains-mono-latin.woff2"),
};

const cache = new Map();
function wordmark(font, text, size, tracking) {
  const key = `${font}|${text}|${size}|${tracking}`;
  if (!cache.has(key)) {
    const raw = execFileSync("python3", [join(HERE, "wordmark.py"), FONTS[font](), text, String(size), String(tracking)], { encoding: "utf8" });
    cache.set(key, JSON.parse(raw));
  }
  return cache.get(key);
}

/** One <g> per wordmark, baseline at y=0, origin at x=0. */
function textGroup(data, fill, { x = 0, y = 0 } = {}) {
  const paths = data.glyphs.map((g) => `<path transform="translate(${g.x} 0)" d="${g.d}"/>`).join("");
  // font units are y-up, SVG is y-down
  return `<g transform="translate(${x} ${y}) scale(${data.scale} ${-data.scale})" fill="${fill}">${paths}</g>`;
}

/* -------------------------------------------------------------------- mark */

const CLAW = readFileSync(join(ROOT, "mark", "claw.path"), "utf8");

/** The claw, `size` px wide, with its accent joint dot. */
function claw({ size, fill = C.darkInk, dot = C.accent, dotScale = 1, x = 0, y = 0 }) {
  const s = size / 1024;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path fill="${fill}" fill-rule="evenodd" d="${CLAW}"/>
    ${dot ? `<circle cx="352" cy="806" r="${34 * dotScale}" fill="${dot}"/>` : ""}
  </g>`;
}

/** Rounded-square badge holding the mark. */
function badge({ size, r, fill = C.ink, inset = 0.075, x = 0, y = 0, markFill = C.darkInk, dot = C.accent }) {
  const inner = size * (1 - inset * 2);
  return `<g transform="translate(${x} ${y})">
    <rect width="${size}" height="${size}" rx="${r}" fill="${fill}"/>
    ${claw({ size: inner, fill: markFill, dot, x: size * inset, y: size * inset })}
  </g>`;
}

/** The `///` brand mark as real geometry (parallelograms, not glyphs). */
function slashes({ h = 200, w = 30, gap = 38, skew = 0.4, fill = C.accent, x = 0, y = 0 }) {
  const bars = [0, 1, 2].map((i) => {
    const x0 = i * (w + gap);
    return `<path d="M ${x0 + skew * h} 0 L ${x0 + skew * h + w} 0 L ${x0 + w} ${h} L ${x0} ${h} Z"/>`;
  });
  return `<g transform="translate(${x} ${y})" fill="${fill}">${bars.join("")}</g>`;
}

const svg = (w, h, body, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="SuparClaw">
${bg ? `  <rect width="${w}" height="${h}" fill="${bg}"/>\n` : ""}${body}
</svg>
`;

/* -------------------------------------------------------------- variants */

const files = {};

/* 01 — badge + Inter Black: the user's chosen mark, the heavier face */
{
  const bs = 300;
  const word = wordmark("inter900", "suparclaw", 200, -0.032);
  const W = Math.round(96 + bs + 66 + word.width + 96);
  const H = 470;
  const baseline = H / 2 + (word.xHeight / 2) - 4;
  files["01-lockup-inter-black.svg"] = svg(W, H,
    `${badge({ size: bs, r: bs * 0.235, x: 96, y: (H - bs) / 2 })}
${textGroup(word, C.ink, { x: 96 + bs + 66, y: baseline })}`, C.bg);
}

/* 02 — badge + Instrument Sans 400: the product's own face, calm */
{
  const bs = 300;
  const word = wordmark("instrument", "suparclaw", 230, -0.018);
  const W = Math.round(96 + bs + 62 + word.width + 96);
  const H = 470;
  const baseline = H / 2 + word.xHeight / 2 - 3;
  files["02-lockup-instrument.svg"] = svg(W, H,
    `${badge({ size: bs, r: bs * 0.235, x: 96, y: (H - bs) / 2 })}
${textGroup(word, C.ink, { x: 96 + bs + 62, y: baseline })}`, C.bg);
}

/* 03 — stacked: badge over wordmark over mono tagline (splash / store art) */
{
  const bs = 300;
  const word = wordmark("inter900", "suparclaw", 150, -0.032);
  const tag = wordmark("mono", "YOUR PHONE IS THE MACHINE.", 24, 0.18);
  const W = Math.round(Math.max(word.width, tag.width) + 180);
  const H = 760;
  const cx = W / 2;
  files["03-lockup-stacked.svg"] = svg(W, H,
    `${badge({ size: bs, r: bs * 0.235, x: cx - bs / 2, y: 90 })}
${textGroup(word, C.ink, { x: cx - word.width / 2, y: 545 })}
${textGroup(tag, C.ink3, { x: cx - tag.width / 2, y: 620 })}`, C.bg);
}

/* 04 — type-first: heavy wordmark, the brand's /// as its own accent shape */
{
  const word = wordmark("inter900", "suparclaw", 190, -0.036);
  const slashH = word.xHeight * 1.02;
  const SW = { w: 26, gap: 34, skew: 0.4 };
  const slashW = 2 * (SW.w + SW.gap) + SW.w + SW.skew * slashH;
  const W = Math.round(100 + word.width + 44 + slashW + 100);
  const H = 400;
  const base = H / 2 + word.xHeight / 2;
  files["04-wordmark-slashes.svg"] = svg(W, H,
    `${textGroup(word, C.ink, { x: 100, y: base })}
${slashes({ h: slashH, w: SW.w, gap: SW.gap, skew: SW.skew, x: 100 + word.width + 44, y: base - word.xHeight })}`, C.bg);
}

/* 05 — reverse for the dark theme */
{
  const bs = 300;
  const word = wordmark("inter900", "suparclaw", 200, -0.032);
  const W = Math.round(96 + bs + 66 + word.width + 96);
  const H = 470;
  const baseline = H / 2 + word.xHeight / 2 - 4;
  files["05-lockup-dark.svg"] = svg(W, H,
    `${badge({ size: bs, r: bs * 0.235, fill: C.darkInk, markFill: C.dark, dot: C.periwinkle, x: 96, y: (H - bs) / 2 })}
${textGroup(word, C.darkInk, { x: 96 + bs + 66, y: baseline })}`, C.dark);
}

/* 06 — one colour, no accent: stamps, embossing, single-colour print */
{
  const bs = 300;
  const word = wordmark("inter900", "suparclaw", 200, -0.032);
  const W = Math.round(96 + bs + 66 + word.width + 96);
  const H = 470;
  const baseline = H / 2 + word.xHeight / 2 - 4;
  files["06-lockup-mono.svg"] = svg(W, H,
    `${badge({ size: bs, r: bs * 0.235, markFill: C.darkInk, dot: C.darkInk, x: 96, y: (H - bs) / 2 })}
${textGroup(word, C.ink, { x: 96 + bs + 66, y: baseline })}`, C.bg);
}

/* 07 — the app icon alone (favicon / PWA / home screen), edge to edge */
files["07-app-icon.svg"] = svg(512, 512,
  `<rect width="512" height="512" rx="120" fill="${C.ink}"/>
   ${claw({ size: 512 * 0.85, x: 512 * 0.075, y: 512 * 0.075 })}`);

/* 08 — app icon presented on the brand surface */
files["08-app-icon-plate.svg"] = svg(1024, 1024,
  `<rect width="1024" height="1024" fill="${C.bg}"/>
   ${badge({ size: 512, r: 120, x: 256, y: 256 })}`);

/* 09 — Archivo Black: wider and sturdier than Inter, closest to the reference mass */
{
  const bs = 300;
  const word = wordmark("archivo900", "suparclaw", 200, -0.026);
  const W = Math.round(96 + bs + 66 + word.width + 96);
  const H = 470;
  const baseline = H / 2 + word.xHeight / 2 - 4;
  files["09-lockup-archivo.svg"] = svg(W, H,
    `${badge({ size: bs, r: bs * 0.235, x: 96, y: (H - bs) / 2 })}
${textGroup(word, C.ink, { x: 96 + bs + 66, y: baseline })}`, C.bg);
}

for (const [name, content] of Object.entries(files)) writeFileSync(join(OUT, name), content);
console.log(Object.keys(files).join("\n"));
