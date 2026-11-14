// P3 (row Missing!#22) — media understanding (image/audio/pdf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const lib = await import("../dist/lib.js");
const {
  selectAttachments,
  resolveEntries,
  cliArgs,
  runUnderstanding,
  renderMediaBlocks,
  toolsMediaConfig,
  extractPdfText,
} = lib;
const { analyzePdfs } = await import("../dist/lib.js").then(() => lib);

const CFG = {
  concurrency: 2,
  models: [],
  image: { enabled: true },
  audio: { enabled: true },
  pdf: { enabled: true },
};

function tmpFile(name, bytes = 120) {
  const dir = mkdtempSync(join(tmpdir(), "sc-media-"));
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

test("selectAttachments default: first matching attachment per capability", () => {
  const facts = [
    { kind: "image", path: "/i1" }, { kind: "image", path: "/i2" },
    { kind: "audio", path: "/a1" }, { kind: "video", path: "/v1" },
  ];
  const picked = selectAttachments(facts, CFG);
  assert.deepEqual(picked.map((f) => f.path).sort(), ["/a1", "/i1"], "one per capability, video untouched (their default)");
  const all = selectAttachments(facts, { ...CFG, image: { enabled: true, attachments: { mode: "all", maxAttachments: 10 } } });
  assert.deepEqual(all.filter((f) => f.kind === "image").map((f) => f.path), ["/i1", "/i2"]);
  const disabled = selectAttachments(facts, { ...CFG, image: { enabled: false } });
  assert.deepEqual(disabled.map((f) => f.kind), ["audio"]);
});

test("resolveEntries: capability-tagged list, invalid CLI entries recorded & skipped (their runtime rule)", () => {
  const cfg = {
    ...CFG,
    models: [
      { type: "provider", provider: "openai", model: "gpt-a", capabilities: ["audio"] },
      { type: "cli", command: "", args: [], capabilities: ["audio"] },
      { type: "cli", command: "transcriber", args: ["{{AttachmentPath}}"], capabilities: ["audio", "image"] },
    ],
  };
  const { entries, invalid } = resolveEntries(cfg, "audio", {});
  assert.equal(entries.length, 2);
  assert.match(invalid.join(";"), /cli entry missing command/);
  // preferredModel pulls ahead (their preferredModel semantics)
  const pref = resolveEntries({ ...cfg, audio: { enabled: true, preferredModel: "cli:transcriber" } }, "audio", {});
  assert.equal(pref.entries[0].command, "transcriber");
});

test("audio auto-detect: provider auth beats local CLIs, vendor priority order", () => {
  const { entries } = resolveEntries(CFG, "audio", {
    providerAuths: [
      { id: "mistral-main", baseUrl: "https://api.mistral.ai/v1", apiKey: "k" },
      { id: "groq-key", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" },
    ],
    hasCommand: () => true,
  });
  assert.equal(entries[0].type, "provider");
  assert.equal(entries[0].provider, "groq-key", "Groq ranks first (their priority list)");
  assert.equal(entries.length, 2, "CLIs never reached — auth wins");
  const cli = resolveEntries(CFG, "audio", { providerAuths: [], hasCommand: (c) => c === "whisper" });
  assert.equal(cli.entries[0].command, "whisper", "local whisper as last resort");
});

test("cliArgs: literal substitution, {{Language}} only audio, unset → empty argument (their rule)", () => {
  const entry = { type: "cli", command: "x", args: ["--in", "{{AttachmentPath}}", "--lang", "{{Language}}", "{{MaxChars}}"] };
  const img = cliArgs(entry, { kind: "image", path: "/tmp/i.png" }, { maxChars: 500, prompt: "p", outputDir: "/out", index: 0 });
  assert.deepEqual(img, ["--in", "/tmp/i.png", "--lang", "", "500"]);
  const aud = cliArgs(entry, { kind: "audio", path: "/tmp/a.ogg" }, { maxChars: null, prompt: "p", language: "bn", outputDir: "/out", index: 1 });
  assert.equal(aud[3], "bn");
});

test("image understanding: provider describe → [Image] block; caption preserved as User text", async () => {
  const path = tmpFile("photo.jpg", 40);
  const out = await runUnderstanding(
    { kind: "image", path, contentType: "image/jpeg" },
    CFG,
    { describeImage: async () => "a small brown dog on stairs", replyProvider: { baseUrl: "https://x", apiKey: "k", model: "m" } },
  );
  assert.equal(out.status, "completed");
  const body = renderMediaBlocks([out], "look at this");
  assert.match(body, /^\[Image\] a small brown dog on stairs/);
  assert.match(body, /User text: look at this/);
});

test("ladder: provider failure falls to the CLI entry; all-fail keeps the attachment eligible (their rule)", async () => {
  const path = tmpFile("photo.png", 40);
  const cfg = {
    ...CFG,
    models: [
      { type: "provider", provider: "p1", capabilities: ["image"] },
      { type: "cli", command: "captioner", args: ["{{AttachmentPath}}"], capabilities: ["image"] },
    ],
  };
  const out = await runUnderstanding({ kind: "image", path }, cfg, {
    describeImage: async () => { throw new Error("provider down"); },
    runCli: async () => "cli caption works",
  });
  assert.equal(out.status, "completed");
  assert.equal(out.text, "cli caption works");
  const dead = await runUnderstanding({ kind: "image", path }, cfg, {
    describeImage: async () => { throw new Error("down"); },
    runCli: async () => { throw new Error("binary missing"); },
  });
  assert.equal(dead.status, "failed");
  assert.match(dead.error, /down; \[cli:captioner\] binary missing/, "aggregate warnings");
});

test("maxBytes gate: oversized media records a per-entry failure and moves on", async () => {
  const path = tmpFile("huge.jpg", 100);
  const out = await runUnderstanding({ kind: "image", path }, { ...CFG, image: { enabled: true, maxBytes: 50 } }, {
    replyProvider: { baseUrl: "https://x", apiKey: "k", model: "m" },
    describeImage: async () => "never called",
  });
  assert.equal(out.status, "failed");
  assert.match(out.error, /exceeds maxBytes/);
});

test("audio silence is OMITTED, not failed (their batch rule)", async () => {
  const path = tmpFile("silence.ogg", 64);
  const out = await runUnderstanding({ kind: "audio", path }, { ...CFG, models: [{ type: "provider", provider: "openai", capabilities: ["audio"] }] }, {
    transcribeAudio: async () => "   ",
    providerAuths: [{ id: "openai", baseUrl: "https://x", apiKey: "k" }],
  });
  assert.equal(out.status, "omitted");
  assert.match(out.error, /no speech/);
});

// ── pdf extraction ───────────────────────────────────────────────────────────

function tinyPdf(content) {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${content}) Tj ET`, "latin1"));
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n",
    `4 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`,
    stream.toString("latin1"),
    "\nendstream endobj\n",
  ];
  return Buffer.from(parts.join(""), "latin1");
}

test("extractPdfText reads flate content streams; encrypted/non-PDF bail honestly", () => {
  const r = extractPdfText(tinyPdf("Hello from a tiny PDF world"));
  assert.match(r.text, /Hello from a tiny PDF world/);
  assert.equal(r.pages, 1);
  assert.equal(r.truncated, false);
  assert.equal(r.text.length <= 4000, true);
  assert.throws(() => extractPdfText(Buffer.from("not a pdf at all")), /not a PDF/);
  assert.throws(() => extractPdfText(Buffer.from("%PDF-1.4\n/Encrypt\n1 0 obj")), /encrypted/);
});

const pdfCtx = (over = {}) => ({
  workspace: mkdtempSync(join(tmpdir(), "sc-pdfws-")),
  log: { warn: () => {} },
  config: { tools: { media: { pdf: { maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60, enabled: true }, models: [] } } },
  ...over,
});

test("analyzePdfs: dedupe+10-cap, extraction + model analysis hop", async () => {
  const ctx = pdfCtx({
    llmText: async (msgs) => `analysis (extractedTextInPrompt=${msgs[0].content.includes("the budget grew by twelve percent")})`,
  });
  writeFileSync(join(ctx.workspace, "a.pdf"), tinyPdf("the budget grew by twelve percent"));
  const out = await analyzePdfs({ pdf: "a.pdf", pdfs: ["a.pdf", "a.pdf"] }, ctx);
  assert.match(out, /^### a\.pdf$/m);
  assert.match(out, /extractedTextInPrompt=true/, "extracted text is inside the analysis prompt");
  assert.equal((out.match(/### /g) ?? []).length, 1, "merged dedupe");
  const too = await analyzePdfs({ pdfs: Array.from({ length: 11 }, (_, i) => `${i}.pdf`) }, ctx);
  assert.match(too, /cap is 10/);
  const missing = await analyzePdfs({}, ctx);
  assert.match(missing, /Provide pdf or pdfs/);
});

test("analyzePdfs: CLI entry takes over when the builtin extractor finds nothing", async () => {
  const cfg = {
    tools: { media: {
      pdf: { maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60, enabled: true },
      models: [{ type: "cli", command: "pdftotext", args: ["{{AttachmentPath}}", "-"], capabilities: ["pdf"] }],
    } },
  };
  const ctx = pdfCtx({ config: cfg });
  writeFileSync(join(ctx.workspace, "scan.pdf"), Buffer.from("%PDF-1.4\n% only images here\n"));
  const out = await analyzePdfs({ pdf: "scan.pdf" }, ctx, async () => "text via pdftotext");
  assert.match(out, /text via pdftotext/);
  const dead = await analyzePdfs({ pdf: "scan.pdf" }, ctx, async () => { throw new Error("no binary"); });
  assert.match(dead, /no extractable text|no cli/i);
});

test("toolsMediaConfig maps runtime config into engine controls", () => {
  const cfg = toolsMediaConfig({
    concurrency: 2,
    models: [{ type: "cli", provider: "", model: "", command: "c", args: ["{{AttachmentPath}}"], prompt: "", maxChars: 0, maxBytes: 0, timeoutSeconds: 0, language: "", capabilities: ["audio", "bogus"] }],
    image: { enabled: true, preferredModel: "", prompt: "", maxChars: 500, maxBytes: 1, timeoutSeconds: 60, attachments_all: true },
    audio: { enabled: false, preferredModel: "", maxBytes: 2, timeoutSeconds: 60, language: "", echoTranscript: true, echoFormat: '📝 "{transcript}"' },
    pdf: { enabled: true, maxBytes: 3, maxChars: 4000, timeoutSeconds: 60 },
  });
  assert.equal(cfg.models[0].provider, undefined);
  assert.deepEqual(cfg.models[0].capabilities, ["audio"], "unknown capabilities dropped");
  assert.equal(cfg.image.attachments.mode, "all");
  assert.equal(cfg.audio.enabled, false);
});
