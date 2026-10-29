// The claw as terminal art: the same mark, rasterised and reduced to half blocks.
//
//   npm i --no-save @resvg/resvg-js     # from the repo root
//   node brand/tools/ascii.mjs          # prints the art used by src/cli/brand.ts
//
// Why a raster instead of tracing the paths: half blocks are a 1-bit medium at
// 30 columns, and the mark's value is its silhouette — a real render, cropped to
// its ink and averaged down, keeps the shape honest. Tracing by hand does not.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { clawMark } from "./claw.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(ROOT, "package.json"));
let Resvg;
try {
  ({ Resvg } = require("@resvg/resvg-js"));
} catch {
  throw new Error("resvg is not installed — run: npm i --no-save @resvg/resvg-js");
}

/** Minimal PNG reader: 8-bit RGBA, no interlace — what resvg emits. */
function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error("unexpected PNG format (want 8-bit RGBA, non-interlaced)");
      }
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const px = line[x];
      let v;
      switch (filter) {
        case 0: v = px; break;
        case 1: v = px + a; break;
        case 2: v = px + b; break;
        case 3: v = px + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = px + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, data: out };
}

/**
 * Render the mark, crop to its ink, and reduce to `cols` × `cols/2`-ish cells of
 * half blocks. Coverage is averaged per cell; >0.5 becomes a block.
 */
export function clawArt({ cols = 30, threshold = 0.5 } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${clawMark({ color: "#ffffff", slashes: false })}</svg>`;
  const png = new Resvg(svg, { background: "#00000000", font: { loadSystemFonts: false } })
    .render()
    .asPng();
  const { w, h, data } = decodePng(png);

  // crop to ink (alpha > 8)
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;

  // One sample is a square of side `cellW`; a character row stacks two samples
  // (top half + bottom half), so a char row is 2 × cellW tall — 1:1 in a
  // terminal's roughly 1:2 cell. Hence `rows = cols * ch / cw / 2`.
  const cellW = cw / cols;
  const cellH = cellW;
  const rows = Math.max(1, Math.round((ch / cellH) / 2));
  const ox = x0;
  const oy = y0;

  const on = (cx, cy) => {
    const sx0 = Math.floor(ox + cx * cellW);
    const sx1 = Math.floor(ox + (cx + 1) * cellW);
    const sy0 = Math.floor(oy + cy * cellH);
    const sy1 = Math.floor(oy + (cy + 1) * cellH);
    let hit = 0;
    let total = 0;
    for (let y = Math.max(0, sy0); y < Math.min(h, sy1); y++) {
      for (let x = Math.max(0, sx0); x < Math.min(w, sx1); x++) {
        total++;
        if (data[(y * w + x) * 4 + 3] > 8) hit++;
      }
    }
    return total > 0 && hit / total > threshold;
  };

  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const top = on(c, r * 2);
      const bottom = on(c, r * 2 + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(clawArt().map((l) => JSON.stringify(l)).join(",\n"));
}
