// The mark is generated in ONE place (brand/tools/claw.mjs) and copied into the
// product by hand. This file is the lock: every copy must still be the output of
// the generator, and every image the app links to must exist at the right size.
//
// Why it matters: the logo lives in four representations — inline `currentColor`
// glyphs in the UI, an SVG favicon, PNG icons for the home screen, and the SVGs
// the docs point at. A mark edit that reaches only one of them is exactly the
// kind of drift nobody notices until a release ships with two logos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clawGlyph, clawMark } from "../brand/tools/claw.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Whitespace-insensitive so the copies can be pretty-printed or minified: tag
 * boundaries are compared with no gap at all, attribute gaps as one space.
 */
const norm = (s) => s.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
/** The `<g>…</g>` inside a glyph — what actually has to match. */
const body = (svg) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

/** CLAW_ART as it is written in src/cli/brand.ts (the terminal rendering of the mark). */
const CLAW_ART = (() => {
  const ts = read("src/cli/brand.ts");
  const rows = [...ts.matchAll(/^\s{2}"([▀▄█ ]+)",$/gm)].map((m) => m[1]);
  assert.equal(rows.length, 9, "CLAW_ART is 9 rows");
  return rows;
})();

/** The palm path of the current mark — the silhouette everything else hangs off. */
const PALM = norm(
  clawMark({ slashes: false }).match(/<path d="(M -330 -46[^"]*)"/)[1],
);

/** PNG intrinsic size, read from the IHDR chunk (no image library needed). */
function pngSize(file) {
  const buf = readFileSync(join(ROOT, file));
  assert.equal(buf.toString("ascii", 1, 4), "PNG", `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("the chat empty state carries the generated claw, not a placeholder glyph", () => {
  const src = read("ui/src/chat.ts");
  assert.ok(
    norm(src).includes(norm(body(clawGlyph({ size: 34 })))),
    "ui/src/chat.ts no longer embeds the mark — regenerate it with clawGlyph({ size: 34 })",
  );
  // the old heartbeat glyph must not come back
  assert.ok(!src.includes("M3 12h5l3-8 3 16 3-8h4"), "the placeholder heartbeat glyph is back");
});

test("the Settings app bar carries the claw", () => {
  const html = read("ui/interior/settings.html");
  assert.ok(
    norm(html).includes(norm(body(clawGlyph({ size: 20 })))),
    "ui/interior/settings.html no longer embeds the mark — regenerate with clawGlyph({ size: 20 })",
  );
  assert.ok(!html.includes("M12 3.5l2.1 5.4 5.4 2.1"), "the placeholder star is back in the app bar");
});

test("the sessions panel carries the claw", () => {
  const html = read("ui/index.html");
  assert.ok(
    norm(html).includes(norm(body(clawGlyph({ size: 21 })))),
    "ui/index.html no longer embeds the mark — regenerate with clawGlyph({ size: 21 })",
  );
  assert.match(html, /<span class="drawer__mark" aria-hidden="true">/);
});

test("the favicon is the mark on the badge", () => {
  const svg = read("ui/favicon.svg");
  assert.match(svg, /viewBox="0 0 64 64"/);
  // the palm path of the current mark, whitespace-normalised
  const palm = clawMark({ color: "#EDEDF0", slashes: false }).match(/<path d="(M -?[\d.]+ -?[\d.]+[^"]*)"/)[1];
  assert.ok(norm(svg).includes(norm(palm)), "ui/favicon.svg is not built from the current mark");
});

test("every icon the app links to exists, is the right shape, and is the mark", () => {
  const html = read("ui/index.html");
  for (const href of ["./favicon.svg", "./apple-touch-icon.png", "./manifest.webmanifest"]) {
    assert.ok(html.includes(`href="${href}"`), `index.html does not link ${href}`);
    assert.ok(existsSync(join(ROOT, "ui", href.replace("./", ""))), `${href} is missing`);
  }
  assert.deepEqual(pngSize("ui/apple-touch-icon.png"), { width: 180, height: 180 });
  assert.deepEqual(pngSize("ui/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngSize("ui/icon-512.png"), { width: 512, height: 512 });

  // the home-screen icons are rendered from the app-icon SVG, so it must be the mark:
  // the palm path, drawn in the on-dark colour, over the plate.
  const icon = read("brand/svg/07-app-icon.svg");
  assert.ok(norm(icon).includes(PALM), "brand/svg/07-app-icon.svg is not built from the current mark");
  assert.ok(icon.includes('fill="#EDEDF0"'), "the app icon lost the on-dark mark colour");
});

test("the manifest is valid, installable and points at icons that exist", () => {
  const raw = read("ui/manifest.webmanifest");
  const m = JSON.parse(raw);
  assert.equal(m.name, "SuparClaw");
  assert.equal(m.short_name, "SuparClaw");
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "./");
  assert.ok(m.icons.length >= 2);
  for (const icon of m.icons) {
    const rel = join("ui", icon.src.replace("./", ""));
    assert.ok(existsSync(join(ROOT, rel)), `manifest icon ${icon.src} is missing`);
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(rel), { width: w, height: h }, `${icon.src} does not match its declared size`);
  }
  assert.ok(m.icons.some((i) => i.purpose === "maskable"), "no maskable icon: Android will letterbox it");
});

test("the share card is the lockup, at the size the meta tags promise", () => {
  const html = read("ui/index.html");
  assert.match(html, /<meta property="og:image" content="\.\/og-image\.png" \/>/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.deepEqual(pngSize("ui/og-image.png"), { width: 1200, height: 630 });
});

// 04 is the `///` wordmark: deliberate mark-less lockup, the slashes carry it.
const MARKLESS = new Set(["04-wordmark-slashes.svg"]);

test("all nine lockups are built from the current mark", () => {
  for (const file of ["brand/lockup.png", "brand/logo-set.png"]) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
  }
  const dir = join(ROOT, "brand/svg");
  const lockups = readdirSync(dir).filter((f) => f.endsWith(".svg"));
  assert.equal(lockups.length, 9, "the lockup set changed size — regenerate logo-set.png too");
  for (const f of lockups) {
    if (MARKLESS.has(f)) continue;
    const svg = read(join("brand/svg", f));
    assert.ok(norm(svg).includes(PALM), `brand/svg/${f} does not contain the current mark's palm`);
  }
  // and the one mark-less lockup really is mark-less, not silently broken
  const slash = read("brand/svg/04-wordmark-slashes.svg");
  assert.ok(!slash.includes("M -330 -46"), "04 grew a mark — regenerate the set");
  assert.match(slash, /SUPARCLAW|SuparClaw/);
});

// --------------------------------------------------------------------------
// Terminal surfaces: the CLI banner and the installer. The mark is a raster
// reduction of the geometry, so it lives as a literal in two places — the test
// that matters is that those two copies can never drift apart, and that both
// use the product palette rather than the old violet.
// --------------------------------------------------------------------------

const hexToAnsi = (hex) => {
  const v = hex.replace("#", "");
  return `38;2;${parseInt(v.slice(0, 2), 16)};${parseInt(v.slice(2, 4), 16)};${parseInt(v.slice(4, 6), 16)}`;
};

test("the CLI banner is the mark, the wordmark and the tagline", () => {
  const ts = read("src/cli/brand.ts");
  const art = CLAW_ART;
  for (const row of art) {
    assert.ok(row.length <= 30, `a row is wider than 30 columns: ${JSON.stringify(row)}`);
    assert.match(row, /^[▀▄█ ]+$/, "the art is made of half blocks only");
  }
  assert.ok(art.join("").includes("█"), "the art has no full block — it is not a silhouette");
  assert.ok(art.join("").includes("▀") || art.join("").includes("▄"));

  // banner() stacks: art, a blank line, the wordmark (+ subtitle), the tagline
  const body = ts.slice(ts.indexOf("export function banner"));
  assert.match(body, /CLAW_ART\.map/);
  assert.match(body, /BRAND\.name/);
  assert.match(body, /BRAND\.tagline/);
  assert.match(body, /suffix \?/);
});

test("the installer prints the same mark as `sc`", () => {
  const sh = read("install.sh");
  const block = sh.match(/<<'CLAW'\n([\s\S]*?)\nCLAW/);
  assert.ok(block, "install.sh no longer has a CLAW heredoc");
  const art = block[1].split("\n");
  assert.equal(art.length, 9, "the installer art is 9 rows");
  for (const row of art) {
    assert.match(row, /^[▀▄█ ]+$/, "the installer art is made of half blocks only");
    assert.ok(row.length <= 30, "the installer art is wider than 30 columns");
  }
  // and it is the CLI's art, row for row
  const ts = read("src/cli/brand.ts");
  for (const row of art) {
    assert.ok(ts.includes(`"${row}"`), `the installer row ${JSON.stringify(row)} is not in the CLI art`);
  }
});

test("terminal colours come from the stylesheet, not a separate theme", () => {
  const css = read("ui/styles.css");
  // the dark block is the second :root — find the custom properties in it
  const dark = css.slice(css.indexOf("#0E0E11"));
  const prop = (name) => {
    const m = dark.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `ui/styles.css has no --${name} in the dark palette`);
    return m[1];
  };
  const ts = read("src/cli/brand.ts");
  const entry = (name) => {
    const m = ts.match(new RegExp(`${name}:\\s*"(38;2;[\\d;]+)"`));
    assert.ok(m, `PALETTE.${name} is missing`);
    return m[1];
  };
  assert.equal(entry("accent"), hexToAnsi(prop("accent")), "the CLI accent drifted from --accent (dark)");
  assert.equal(entry("accentBright"), hexToAnsi(prop("ink")), "the CLI's bright tone drifted from --ink (dark)");
  assert.equal(entry("muted"), hexToAnsi(prop("ink3")), "the CLI's muted tone drifted from --ink3 (dark)");

  const sh = read("install.sh");
  assert.ok(sh.includes(hexToAnsi(prop("accent")).replace("38;2;", "\\033[38;2;") + "m"), "install.sh accent drifted");
  // no violet left anywhere: the old terminal theme is gone
  for (const file of ["src/cli/brand.ts", "install.sh"]) {
    assert.ok(!read(file).includes("167;139;250"), `${file} still carries the old violet`);
  }
});

test("the art generator is part of the repo, so the art can be rebuilt", () => {
  const gen = read("brand/tools/ascii.mjs");
  assert.match(gen, /export function clawArt/);
  assert.match(gen, /from "\.\/claw\.mjs"/);
  // and it is the only place that rasterises the mark for terminals
  assert.ok(!read("src/cli/brand.ts").includes("Resvg"));
});

test("`sc init` opens with the claw — end to end, in a real terminal-less run", () => {
  const home = mkdtempSync(join(tmpdir(), "sc-brand-"));
  try {
    const out = execFileSync("node", [join(ROOT, "dist/sc.js"), "init"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = out.split("\n");
    const start = lines.findIndex((l) => l.trim().startsWith("▄▄"));
    assert.ok(start > 0, "sc init does not print the claw art");
    const art = lines.slice(start, start + 9);
    assert.deepEqual(art, CLAW_ART.map((l) => `  ${l}`), "the art printed by sc init is not CLAW_ART");
    assert.ok(out.includes("suparclaw"), "the wordmark is missing from sc init");
    assert.ok(out.includes("your phone is the machine."), "the tagline is missing from sc init");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The build copies UI files by name. That is how the favicon shipped in T48
// without ever reaching a browser: ui/index.html linked it, dist/ui/ did not
// have it, and nobody saw a 404 because no test looked. This is that test.
test("every asset the built UI references is actually served", () => {
  const pages = ["dist/ui/index.html"];
  for (const page of pages) {
    const html = read(page);
    const base = dirname(join(ROOT, page));
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 5, `${page} has no references?`);
    for (const ref of refs) {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) continue;
      const target = join(base, ref.replace(/^\.\//, ""));
      assert.ok(existsSync(target), `${page} references ${ref}, which the build does not serve`);
    }
  }
  // the manifest's icons are relative to the page, not to the manifest
  const m = JSON.parse(read("dist/ui/manifest.webmanifest"));
  for (const icon of m.icons) {
    assert.ok(existsSync(join(ROOT, "dist/ui", icon.src.replace("./", ""))), `manifest icon ${icon.src} is not served`);
  }
});
