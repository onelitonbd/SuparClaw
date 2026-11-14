// Avatar helpers: the contract that keeps the agent's portrait bounded.
//
// The portrait is stored in `agents.identity.avatar` as a data URL, so the two
// things that can go wrong are (a) an oversized string reaching config.json5 and
// (b) an untrusted string reaching <img src>. These are the guards for both, plus
// the crop maths, tested here because there is no browser on the build machine.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../ui/src/avatar.ts", import.meta.url), "utf8");
const { transform } = await import("esbuild");
const { code } = await transform(source, { loader: "ts", target: "es2022", format: "esm" });
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const {
  checkAvatarFile, cropSquare, isStoredAvatar, fitAvatarBudget, formatBytes,
  AVATAR_MAX_CHARS, AVATAR_MAX_UPLOAD_BYTES, AVATAR_LADDER,
} = mod;

const dataUrl = (mime, body = "A".repeat(64)) => `data:${mime};base64,${body}`;

test("accepts PNG, JPEG and WebP under the size cap", () => {
  assert.equal(checkAvatarFile({ type: "image/png", size: 1024 }), null);
  assert.equal(checkAvatarFile({ type: "image/jpeg", size: 1024 }), null);
  assert.equal(checkAvatarFile({ type: "image/webp", size: AVATAR_MAX_UPLOAD_BYTES }), null);
  assert.equal(checkAvatarFile({ type: "IMAGE/PNG", size: 10 }), null, "mime case is normalised");
});

test("rejects everything else with a sentence that can be shown as-is", () => {
  const gif = checkAvatarFile({ type: "image/gif", size: 100 });
  assert.match(gif, /Animated pictures are not supported/);
  assert.match(checkAvatarFile({ type: "image/heic", size: 100 }), /export it as JPEG/);
  assert.match(checkAvatarFile({ type: "image/svg+xml", size: 100 }), /SVG can carry code/);
  assert.match(checkAvatarFile({ type: "application/pdf", size: 100 }), /Only PNG, JPEG or WebP/);
  assert.match(checkAvatarFile({ type: "", size: 100 }), /no recognised image type/);
  assert.match(checkAvatarFile({ type: "image/png", size: 0 }), /empty/);
  const big = checkAvatarFile({ type: "image/png", size: 12.4 * 1024 * 1024 });
  assert.match(big, /12\.4 MB/);
  assert.match(big, /under 8\.0 MB/);
});

test("formatBytes reads like a person wrote it", () => {
  assert.equal(formatBytes(900), "1 KB");
  assert.equal(formatBytes(44 * 1024), "44 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(12.4 * 1024 * 1024), "12.4 MB");
  assert.equal(formatBytes(-4), "0 KB");
});

test("cropSquare takes the centre square of any aspect ratio", () => {
  assert.deepEqual(cropSquare(1000, 400), { sx: 300, sy: 0, side: 400 }, "wide: crop the sides");
  assert.deepEqual(cropSquare(400, 1000), { sx: 0, sy: 300, side: 400 }, "tall: crop top and bottom");
  assert.deepEqual(cropSquare(300, 300), { sx: 0, sy: 0, side: 300 }, "square: untouched");
  assert.deepEqual(cropSquare(1, 1), { sx: 0, sy: 0, side: 1 }, "small: kept, upscaled later");
  assert.equal(cropSquare(1024, 768).side, 768, "never overflows the short edge");
  assert.equal(cropSquare(1001, 400).sx, 300, "odd surplus floors rather than rounding out");
  assert.deepEqual(cropSquare(0, 0), { sx: 0, sy: 0, side: 0 }, "empty image yields nothing");
});

test("isStoredAvatar only trusts our own bounded data URLs", () => {
  assert.equal(isStoredAvatar(dataUrl("image/png")), true);
  assert.equal(isStoredAvatar(dataUrl("image/jpeg")), true);
  assert.equal(isStoredAvatar(dataUrl("image/webp")), true);
  assert.equal(isStoredAvatar(dataUrl("image/svg+xml")), false, "SVG stays out of <img src>");
  assert.equal(isStoredAvatar("javascript:alert(1)"), false);
  assert.equal(isStoredAvatar("data:image/png;base64,"), false, "a bare prefix is not a picture");
  assert.equal(isStoredAvatar("https://evil.test/a.png"), false);
  assert.equal(isStoredAvatar(""), false);
  assert.equal(isStoredAvatar(undefined), false);
  assert.equal(isStoredAvatar(42), false);
  assert.equal(isStoredAvatar(dataUrl("image/png", "A".repeat(AVATAR_MAX_CHARS))), false, "over the cap");
});

test("fitAvatarBudget takes the first encoding that fits and never exceeds the cap", () => {
  const tried = [];
  const fits = fitAvatarBudget((a) => {
    tried.push(`${a.mime}@${a.px}`);
    return dataUrl(a.mime, "A".repeat(1000));
  });
  assert.equal(tried.length, 1, "a small picture never walks the ladder");
  assert.match(fits, /^data:image\/png;base64,/);
  assert.ok(fits.length <= AVATAR_MAX_CHARS);
});

test("fitAvatarBudget walks the ladder when PNG is too heavy, ending on JPEG", () => {
  const tried = [];
  const out = fitAvatarBudget((a) => {
    tried.push(`${a.mime}@${a.px}`);
    // PNG is always "too heavy"; JPEG always fits.
    const body = a.mime === "image/jpeg" ? "A".repeat(2000) : "A".repeat(AVATAR_MAX_CHARS);
    return dataUrl(a.mime, body);
  });
  assert.deepEqual(tried, ["image/png@128", "image/png@96", "image/jpeg@128"]);
  assert.match(out, /^data:image\/jpeg;base64,/);
});

test("fitAvatarBudget skips an encoder that throws or returns junk, and fails loudly", () => {
  const out = fitAvatarBudget((a) => {
    if (a.mime === "image/png") throw new Error("canvas exploded");
    return a.px === 96 ? "data:," : dataUrl("image/jpeg", "A".repeat(500));
  });
  assert.match(out, /^data:image\/jpeg;base64,/, "the throw and the junk both got skipped");
  assert.throws(() => fitAvatarBudget(() => "data:,"), /too detailed to shrink/);
});

test("the schema enforces the same cap and fills an empty portrait by default", async () => {
  const { CONFIG_SCHEMA, validate, applyDefaults, parseConfig } = await import("../dist/lib.js");
  const identity = CONFIG_SCHEMA.fields.agents.fields.identity;
  const avatar = identity.fields.avatar;
  assert.equal(avatar.max, 32000);
  assert.equal(avatar.hidden, true, "the All-settings form must skip it");
  assert.deepEqual(validate(avatar, dataUrl("image/png")), [], "a real portrait validates");

  const tooLong = dataUrl("image/png", "A".repeat(40000));
  assert.match(String(validate(avatar, tooLong)), /at most 32000 characters/);
  assert.notEqual(parseConfig({ agents: { identity: { avatar: tooLong } } }).errors.length, 0, "parseConfig rejects it");

  const filled = applyDefaults(CONFIG_SCHEMA, {});
  assert.equal(filled.agents.identity.avatar, "", "old configs keep loading with no portrait");
  assert.equal(filled.agents.identity.emoji, "🦀", "the icon is untouched by the change");
});

test("the ladder and the schema agree on the stored cap", () => {
  const schema = readFileSync(new URL("../src/config/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /avatar: \{ t: "string", default: "", max: 32000, hidden: true \}/);
  assert.equal(AVATAR_MAX_CHARS, 32000, "one number, two files");
  assert.ok(AVATAR_LADDER.every((a) => a.px >= 96 && a.px <= 128));
});
