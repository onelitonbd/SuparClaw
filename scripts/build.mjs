#!/usr/bin/env node
// Single-file bundle build. No native deps, no postinstall work.
import { rm, mkdir, copyFile, readFile, writeFile, readdir, stat } from "node:fs/promises";
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
  // Stylesheet = the SuparClaw design system + the vendored webfonts.
  // The font faces live in ui/fonts/, but the sheet ships as dist/ui/styles.css,
  // so the URLs have to be re-pointed at dist/ui/fonts/.
  const fontCss = (await readFile(join(root, "ui/fonts/fonts.css"), "utf8"))
    .replace(/url\((['"])\.\/([^'"]+)\1\)/g, "url($1./fonts/$2$1)");
  const appCss = await readFile(join(root, "ui/styles.css"), "utf8");
  const css = `${fontCss}\n${appCss}`;
  const min = await esbuild.transform(css, { loader: "css", minify: !dev });
  await writeFile(join(uiOut, "styles.css"), min.code, "utf8");
  // fonts next to the stylesheet
  const fontOut = join(uiOut, "fonts");
  await mkdir(fontOut, { recursive: true });
  let fontBytes = 0;
  for (const file of await readdir(join(root, "ui/fonts"))) {
    if (!file.endsWith(".woff2")) continue;
    await copyFile(join(root, "ui/fonts", file), join(fontOut, file));
    fontBytes += (await stat(join(root, "ui/fonts", file))).size;
  }
  const bytes = Object.values(res.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(
    `[build] ui: js ${(bytes / 1024).toFixed(0)} KB + css ${(Buffer.byteLength(min.code) / 1024).toFixed(0)} KB ` +
      `+ fonts ${(fontBytes / 1024).toFixed(0)} KB in ${Math.round(performance.now() - t0)}ms`,
  );
}