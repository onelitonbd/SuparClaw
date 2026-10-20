#!/usr/bin/env node
// Single-file bundle build. No native deps, no postinstall work.
import { rm, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  legalComments: "none",
  logLevel: "info",
  outdir: join(root, "dist"),
  chunkNames: "chunks/[name]-[hash]",
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
};

const entries = {
  sc: join(root, "src/main.ts"),
  lib: join(root, "src/lib.ts"),
};

if (watch) {
  for (const [name, entry] of Object.entries(entries)) {
    const ctx = await esbuild.context({ ...common, entryPoints: { [name]: entry } });
    await ctx.watch();
    console.log(`[build] watching ${name}`);
  }
} else {
  const results = await Promise.all(
    Object.entries(entries).map(async ([name, entry]) => {
      const t0 = performance.now();
      const res = await esbuild.build({ ...common, entryPoints: { [name]: entry }, metafile: true });
      const bytes = Object.values(res.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
      console.log(`[build] ${name}: ${(bytes / 1024).toFixed(0)} KB in ${Math.round(performance.now() - t0)}ms`);
      return bytes;
    }),
  );
  console.log(`[build] total ${(results.reduce((a, b) => a + b, 0) / 1024).toFixed(0)} KB`);
}

// --- Control UI: browser bundle + static assets, committed to dist/ui -------
const uiOut = join(root, "dist/ui");
await mkdir(uiOut, { recursive: true });
{
  const t0 = performance.now();
  const res = await esbuild.build({
    entryPoints: { app: join(root, "ui/src/main.ts") },
    bundle: true,
    splitting: false,
    platform: "browser",
    format: "esm",
    target: ["es2022"],
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "none",
    outdir: uiOut,
    entryNames: "[name]",
    logLevel: "warning",
    metafile: true,
  });
  await copyFile(join(root, "ui/index.html"), join(uiOut, "index.html"));
  // Stylesheet = OpenClaw's vendored cascade (assembly order in MANIFEST.txt)
  // + SuparClaw's own overlay, inlined and minified.
  const vendorDir = join(root, "ui/vendor/openclaw");
  const manifest = (await readFile(join(vendorDir, "MANIFEST.txt"), "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const sheets = [
    `/* SuparClaw stylesheet.
       Portions: OpenClaw Control UI styles (MIT, © OpenClaw contributors,
       https://github.com/openclaw/openclaw — see ui/vendor/openclaw/NOTICE.md).
       Assembled from ${manifest.length} vendored sheets + ui/sc-overlay.css. */`,
  ];
  for (const file of manifest) sheets.push(await readFile(join(vendorDir, file), "utf8"));
  sheets.push(await readFile(join(root, "ui/sc-overlay.css"), "utf8"));
  let css = sheets.join("\n");
  css = css.replace(/^[ \t]*@import[^;]*;[ \t]*$/gm, ""); // already inlined above
  const min = await esbuild.transform(css, { loader: "css", minify: !dev });
  await writeFile(join(uiOut, "styles.css"), min.code, "utf8");
  const bytes = Object.values(res.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(
    `[build] ui: js ${(bytes / 1024).toFixed(0)} KB + css ${(Buffer.byteLength(min.code) / 1024).toFixed(0)} KB ` +
      `(${manifest.length} vendored sheets) in ${Math.round(performance.now() - t0)}ms`,
  );
}