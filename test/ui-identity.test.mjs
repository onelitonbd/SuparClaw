// Settings → Defaults → Identity: a picker for the icon, any picture for the face.
//
// This is a RENDER test: it boots ui/src/settings.ts in linkedom with a stubbed
// gateway and drives the real controls, because the contract here is behavioural —
//   • the icon is a two-option picker (🦀 Crab, 🦞 Claw), not a free-text emoji box,
//   • #identity-emoji survives only as the hidden value store (scripts read it),
//   • a stored icon outside the presets is shown and explained, never rewritten,
//   • a portrait is a bounded data URL that renders in the tile and the preview,
//   • junk in the config never reaches an <img src> and is never re-persisted.
//
// The upload path runs with a stubbed FileReader/Image/canvas: the real crop needs
// a browser, but the wiring (file in, portrait out, refusal keeps the old one) is
// exactly what has to hold.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next candidate */ }
  }
  return ROOT;
})();

const PORTRAIT = "data:image/png;base64," + "A".repeat(400);
const JUNK = "javascript:alert(1)";

const configWith = (identity) => ({
  path: "/root/.suparclaw/config.json",
  config: {
    agents: {
      identity,
      defaults: {
        model: "google/gemini-3.1-flash-lite",
        fallbacks: [],
        maxToolIterations: 12,
        contextBudgetChars: 60000,
        queueMode: "followup",
        maxConcurrent: 0,
        reasoningEffort: "inherit",
        reasoningView: "on",
        usage: "tokens",
        subagents: { maxConcurrent: 8, model: "", maxDepth: 1, thinking: "", delegationMode: "inherit" },
      },
    },
  },
});

globalThis.__GW_CONFIG = configWith({ name: "SuparClaw", emoji: "🦀", theme: "a warm, sharp companion" });

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-identity-"));
const rpcStub = join(outDir, "rpc-stub.mjs");
writeFileSync(rpcStub, `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    if (method === "config.get") return globalThis.__GW_CONFIG;
    if (method === "models.list") return {
      models: ["google/gemini-3.1-flash-lite"],
      configured: [{ id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", ref: "google", enabled: true }],
      details: {}, auth: [],
    };
    if (method === "config.set") return {};
    return { tools: [], skills: [], plugins: [] };
  },
};
`);

const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/settings.ts"), join(ROOT, "ui/src/model-name.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
  plugins: [{ name: "stub-rpc", setup(b) { b.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: rpcStub })); } }],
});

const page = parseHTML(`<!doctype html><html><body></body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/defaults" };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);

/** Render the Defaults page against a given identity and hand back scoped helpers. */
async function mount(identity) {
  globalThis.__GW_CONFIG = configWith(identity);
  globalThis.__GW_CALLS = [];
  const host = document.createElement("div");
  document.body.append(host);
  const settings = new Settings(host, () => {});
  settings.setHash("#/settings/defaults");
  await settings.render();
  const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
  return {
    host,
    q: (sel) => host.querySelector(sel),
    qa: (sel) => [...host.querySelectorAll(sel)],
    fire,
    writes: () => new Map(globalThis.__GW_CALLS.filter((c) => c.method === "config.set").map((c) => [c.params.path, c.params.value])),
    settle: () => new Promise((r) => setTimeout(r, 30)),
  };
}

const pressed = (card) => card.qa(".def-icon").map((n) => n.getAttribute("aria-pressed"));

test("the icon is a two-preset picker, and the old input lives on only as its store", async () => {
  const card = await mount({ name: "SuparClaw", emoji: "🦀", theme: "a warm, sharp companion" });

  assert.equal(card.qa(".def-icon").length, 2, "exactly two icons are offered");
  assert.deepEqual(card.qa(".def-icon__label").map((n) => n.textContent), ["Crab", "Claw"]);
  assert.deepEqual(card.qa(".def-icon__glyph").map((n) => n.textContent), ["🦀", "🦞"]);
  assert.equal(card.q(".def-icons").getAttribute("role"), "group");
  assert.equal(card.q(".def-icons").getAttribute("aria-label"), "Icon");
  assert.deepEqual(pressed(card), ["true", "false"], "the stored crab is the pressed tile");

  // The contract other scripts rely on: #identity-emoji is still an INPUT carrying
  // the value — it is just not the surface any more.
  const store = card.q("#identity-emoji");
  assert.equal(store.tagName, "INPUT");
  assert.equal(store.getAttribute("type"), "hidden");
  assert.equal(store.value, "🦀");
  assert.equal(card.qa(".def-field--narrow").length, 0, "no narrow emoji field is left behind");
  assert.equal(card.qa("input:not([type=hidden])").filter((n) => n.getAttribute("placeholder") === "🦀").length, 0);

  // Nothing else about the card regressed.
  assert.equal(card.q("#identity-name").tagName, "INPUT");
  assert.equal(card.q("#identity-theme").tagName, "TEXTAREA");
  assert.equal(card.q(".agent-identity select"), null, "the avatar store is an input, never a select");
  assert.equal(card.qa("[style]").length, 0, "no inline styles");
});

test("picking an icon writes the store, repaints the agent, and marks the card dirty", async () => {
  const card = await mount({ name: "SuparClaw", emoji: "🦀", theme: "warm" });
  card.fire(card.qa(".def-icon")[1], "click");

  assert.deepEqual(pressed(card), ["false", "true"]);
  assert.equal(card.q("#identity-emoji").value, "🦞");
  assert.equal(card.q(".def-portrait__glyph").textContent, "🦞", "the tile follows the pick");
  assert.equal(card.q(".def-preview__glyph").textContent, "🦞", "the preview follows the pick");
  assert.equal(card.q(".agent-identity .setfoot__note").textContent, "Unsaved changes");

  // Re-picking what is already pressed is a no-op, not a change.
  card.q(".agent-identity .setfoot__note").textContent = "";
  card.fire(card.qa(".def-icon")[1], "click");
  assert.equal(card.q("#identity-emoji").value, "🦞");
  assert.equal(card.q(".agent-identity .setfoot__note").textContent, "", "no false dirty state");
});

test("Save writes all four identity leaves and clears the note", async () => {
  const card = await mount({ name: "SuparClaw", emoji: "🦀", theme: "warm" });
  card.fire(card.qa(".def-icon")[1], "click");
  card.q("#identity-name").value = "Clawbot";
  card.q("#identity-theme").value = "terse and technical";
  card.fire(card.q("#identity-save"), "click");
  await card.settle();

  const w = card.writes();
  assert.equal(w.get("agents.identity.name"), "Clawbot");
  assert.equal(w.get("agents.identity.emoji"), "🦞");
  assert.equal(w.get("agents.identity.theme"), "terse and technical");
  assert.equal(w.get("agents.identity.avatar"), "", "no portrait yet, and that is written honestly");
  assert.equal(card.q(".agent-identity .setfoot__note").textContent, "");
});

test("a stored icon outside the presets is shown, explained, and never rewritten", async () => {
  const card = await mount({ name: "Clawbot", emoji: "🤖", theme: "a terse test bot" });

  assert.deepEqual(pressed(card), ["false", "false"], "neither preset is claimed");
  assert.equal(card.q(".def-portrait__glyph").textContent, "🤖", "the stored icon is what is shown");
  assert.equal(card.q("#identity-emoji").value, "🤖", "the store keeps it");

  const note = card.q(".def-note");
  assert.ok(!note.hasAttribute("hidden"), "the mismatch must be visible");
  assert.match(note.textContent, /🤖/);
  assert.match(note.textContent, /isn't one of the presets/);

  card.fire(card.q("#identity-save"), "click");
  await card.settle();
  assert.equal(card.writes().get("agents.identity.emoji"), "🤖", "saving without picking keeps it");
});

test("a stored portrait renders in the tile and the preview, and Remove clears it", async () => {
  const card = await mount({ name: "SuparClaw", emoji: "🦀", theme: "warm", avatar: PORTRAIT });

  const tile = card.q(".def-portrait__img");
  assert.ok(tile, "the tile shows the picture");
  assert.equal(tile.getAttribute("src"), PORTRAIT);
  assert.equal(tile.getAttribute("alt"), "");
  assert.equal(card.q(".def-preview__img").getAttribute("src"), PORTRAIT);
  assert.equal(card.q("#identity-avatar").value, PORTRAIT);
  assert.equal(card.q("#identity-avatar").getAttribute("type"), "hidden");
  assert.equal(card.q("#identity-photo-btn").textContent, "Change photo");
  assert.ok(!card.q("#identity-photo-clear").hasAttribute("hidden"), "Remove is offered when there is a photo");
  assert.equal(card.qa(".def-icon").length, 2, "the icon choice stays available beside a picture");

  card.fire(card.q("#identity-save"), "click");
  await card.settle();
  assert.equal(card.writes().get("agents.identity.avatar"), PORTRAIT, "saving keeps the picture");

  card.fire(card.q("#identity-photo-clear"), "click");
  assert.equal(card.q("#identity-avatar").value, "");
  assert.equal(card.q(".def-portrait__img"), null);
  assert.equal(card.q(".def-portrait__glyph").textContent, "🦀", "the icon takes over again");
  assert.equal(card.q("#identity-photo-btn").textContent, "Add photo");
  assert.ok(card.q("#identity-photo-clear").hasAttribute("hidden"));
  assert.match(card.q(".def-photo__status").textContent, /Photo removed/);
  assert.equal(card.q(".agent-identity .setfoot__note").textContent, "Unsaved changes");

  card.fire(card.q("#identity-save"), "click");
  await card.settle();
  assert.equal(card.writes().get("agents.identity.avatar"), "", "the saved leaf is empty again");
});

test("the file input is a hidden picker limited to the three formats", async () => {
  const card = await mount({ name: "SuparClaw", emoji: "🦀", theme: "" });
  const file = card.q("#identity-photo");
  assert.equal(file.getAttribute("type"), "file");
  assert.ok(file.hasAttribute("hidden"));
  const accept = file.getAttribute("accept");
  for (const type of ["image/png", "image/jpeg", "image/webp"]) assert.ok(accept.includes(type), accept);
  assert.doesNotThrow(() => card.fire(card.q("#identity-photo-btn"), "click"));
  assert.doesNotThrow(() => card.fire(file, "change"), "an empty selection is ignored");
  assert.equal(card.q("#identity-avatar").value, "");
});

test("junk in the config never reaches an img, and is never re-persisted", async () => {
  const card = await mount({ name: "x", emoji: "🦀", theme: "", avatar: JUNK });
  assert.equal(card.q(".def-portrait__img"), null);
  assert.equal(card.q(".def-preview__img"), null);
  assert.equal(card.q(".def-portrait__glyph").textContent, "🦀");

  card.fire(card.q("#identity-save"), "click");
  await card.settle();
  assert.equal(card.writes().get("agents.identity.avatar"), "");
});

test("upload path: a picture becomes the portrait, a refused file changes nothing", async () => {
  const card = await mount({ name: "SuparClaw", emoji: "🦀", theme: "" });
  const realCreate = page.document.createElement.bind(page.document);
  const encoded = "data:image/png;base64," + "B".repeat(500);
  const ctx = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    fillStyle: "#000",
    clearRect() {},
    fillRect() {},
    drawImage() {},
  };
  const prevReader = globalThis.FileReader;
  const prevImage = globalThis.Image;
  globalThis.FileReader = class {
    readAsDataURL() { this.result = "data:image/png;base64,SOURCE"; setTimeout(() => this.onload?.(), 0); }
  };
  globalThis.Image = class {
    set src(v) { this._src = v; setTimeout(() => { this.naturalWidth = 800; this.naturalHeight = 600; this.onload?.(); }, 0); }
    get src() { return this._src; }
  };
  page.document.createElement = (tag) => {
    if (String(tag).toLowerCase() === "canvas") {
      return { width: 0, height: 0, getContext: () => ctx, toDataURL: (mime) => `data:${mime};base64,` + "B".repeat(500) };
    }
    return realCreate(tag);
  };

  const file = card.q("#identity-photo");
  const pick = (f) => {
    Object.defineProperty(file, "files", { value: [f], configurable: true });
    card.fire(file, "change");
  };

  try {
    pick({ name: "me.png", type: "image/png", size: 4096 });
    await card.settle();
    assert.equal(card.q("#identity-avatar").value, encoded);
    assert.equal(card.q(".def-portrait__img").getAttribute("src"), encoded);
    assert.equal(card.q(".def-preview__img").getAttribute("src"), encoded);
    assert.match(card.q(".def-photo__status").textContent, /Photo ready/);
    assert.equal(card.q("#identity-photo-btn").textContent, "Change photo");
    assert.equal(card.q("#identity-photo-btn").disabled, false);
    assert.equal(file.value, "", "the input resets so the same file can be picked again");
    assert.equal(card.q(".agent-identity .setfoot__note").textContent, "Unsaved changes");

    // A refused format explains itself and leaves the picture alone.
    pick({ name: "loop.gif", type: "image/gif", size: 4096 });
    await card.settle();
    assert.equal(card.q("#identity-avatar").value, encoded);
    assert.equal(card.q(".def-portrait__img").getAttribute("src"), encoded);
    assert.match(card.q(".def-photo__status").textContent, /Animated pictures are not supported/);
    assert.equal(card.q("#identity-photo-btn").disabled, false, "the button always comes back");
  } finally {
    page.document.createElement = realCreate;
    if (prevReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = prevReader;
    if (prevImage === undefined) delete globalThis.Image; else globalThis.Image = prevImage;
  }
});
