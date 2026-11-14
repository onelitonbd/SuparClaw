// SVG → PNG preview with resvg (no ImageMagick delegate, no browser).
//
//   npm i --no-save @resvg/resvg-js     # from the repo root
//   node brand/tools/render.mjs brand/svg/07-app-icon.svg /tmp/icon.png 900
//
// The width argument is optional: omit it (or pass 0) to keep the SVG's own size.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"));
let Resvg;
try {
  ({ Resvg } = require("@resvg/resvg-js"));
} catch {
  throw new Error("resvg is not installed — run: npm i --no-save @resvg/resvg-js");
}

const [input, output, width] = process.argv.slice(2);
const opts = { background: "transparent", font: { loadSystemFonts: false } };
if (width && Number(width) > 0) opts.fitTo = { mode: "width", value: Number(width) };
const r = new Resvg(readFileSync(input, "utf8"), opts);
writeFileSync(output, r.render().asPng());
console.log(`${output} ${r.width}x${r.height}`);
