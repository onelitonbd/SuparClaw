// P1 A5 — Telegram inbound media: plan/placeholder/download + vision turns & fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_TMP = tmpdir();
const lib = await import("../dist/lib.js");
const { AgentLoop, Store, createLogger, emptyConfig, planInboundMedia, mediaPlaceholder, mediaFileName, downloadInboundMedia, isVisionUnsupportedError } = lib;

const mkStore = (t, name) => {
  const home = mkdtempSync(join(TEST_TMP, name));
  process.env.SUPARCLAW_HOME = home;
  const store = Store.open(join(home, "state.sqlite"));
  t.after(() => store.close());
  return { home, store };
};

test("planInboundMedia: largest photo size, doc/voice/audio/video/sticker classification", () => {
  const msg = {
    photo: [
      { file_id: "small", width: 90 },
      { file_id: "big", width: 1280, file_size: 500_000 },
    ],
    document: { file_id: "doc1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 120_000 },
    voice: { file_id: "v1", mime_type: "audio/ogg" },
    sticker: { emoji: "🔥" },
  };
  const plan = planInboundMedia(msg);
  const kinds = plan.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ["document", "photo", "sticker", "voice"]);
  assert.equal(plan.find((m) => m.kind === "photo").fileId, "big", "largest photo size wins");
  assert.equal(plan.find((m) => m.kind === "document").fileName, "report.pdf");
  assert.equal(plan.find((m) => m.kind === "sticker").fileId, undefined, "stickers never download");
  assert.equal(planInboundMedia({ text: "hi" }).length, 0);
});

test("mediaPlaceholder: sticker emoji, saved path, omitted-with-reason", () => {
  assert.equal(mediaPlaceholder({ media: { kind: "sticker", emoji: "🔥" } }), "<media:sticker 🔥>");
  assert.equal(
    mediaPlaceholder({ media: { kind: "document", fileName: "a.pdf", mime: "application/pdf" }, path: "/w/media/telegram/7/x-a.pdf" }),
    '<media:document path="/w/media/telegram/7/x-a.pdf" name="a.pdf" mime="application/pdf">',
  );
  assert.equal(
    mediaPlaceholder({ media: { kind: "voice" }, note: "25.0 MB exceeds the 20 MB cap" }),
    '<media:voice omitted="25.0 MB exceeds the 20 MB cap">',
  );
});

test("mediaFileName never leaks directory segments or weird glyphs", () => {
  const n = mediaFileName({ kind: "document", fileName: "../../etc/passwd" }, "st");
  assert.ok(!n.includes("/") && !n.includes("\\"), n);
  assert.equal(n, "st-_.._etc_passwd");
  assert.equal(mediaFileName({ kind: "photo" }, "s2"), "s2-photo.jpg");
  assert.equal(mediaFileName({ kind: "voice" }, "s3"), "s3-voice.ogg");
});

const fakeFetch = (body = "IMGDATA", { length, status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k === "content-length" && length !== undefined ? String(length) : null) },
  async arrayBuffer() {
    // Fresh, exact-size buffer (Buffer.from(str).buffer would alias the 8KB pool slab).
    return new TextEncoder().encode(body).buffer;
  },
});

const fileDeps = (workspace, over = {}) => ({
  chatId: 42,
  workspace,
  maxBytes: 20 * 1048576,
  token: "bot-token",
  stamp: "st",
  getFile: async (fileId) => ({ file_path: `photos/${fileId}.jpg` }),
  fetchFn: fakeFetch(),
  ...over,
});

test("downloadInboundMedia: getFile → disk under media/telegram, photo yields data URI", async (t) => {
  const ws = mkdtempSync(join(TEST_TMP, "sc-media-dl-"));
  const saved = await downloadInboundMedia({ kind: "photo", fileId: "f1", mime: "image/jpeg" }, fileDeps(ws));
  assert.ok(saved.path.includes(join("media", "telegram", "42")));
  assert.ok(existsSync(saved.path));
  assert.equal(readFileSync(saved.path, "utf8"), "IMGDATA");
  assert.equal(saved.dataUri, `data:image/jpeg;base64,${Buffer.from("IMGDATA").toString("base64")}`);
  const doc = await downloadInboundMedia({ kind: "document", fileId: "d1", fileName: "x.pdf" }, fileDeps(ws));
  assert.equal(doc.dataUri, undefined, "only photos become vision parts");
  assert.ok(existsSync(doc.path));
});

test("downloadInboundMedia: declared-size and served-size caps short-circuit", async (t) => {
  const ws = mkdtempSync(join(TEST_TMP, "sc-media-cap-"));
  const declared = await downloadInboundMedia({ kind: "photo", fileId: "f1", size: 30 * 1048576 }, fileDeps(ws));
  assert.match(declared.note, /exceeds the 20 MB cap/);
  assert.equal(declared.path, undefined);
  const served = await downloadInboundMedia(
    { kind: "photo", fileId: "f1" },
    fileDeps(ws, { fetchFn: fakeFetch("x".repeat(1024), { length: 30 * 1048576 }) }),
  );
  assert.match(served.note, /exceeds the 20 MB cap/);
  const bad = await downloadInboundMedia({ kind: "photo", fileId: "f1" }, fileDeps(ws, { getFile: async () => ({}) }));
  assert.match(bad.note, /no safe file path/);
  const traversal = await downloadInboundMedia({ kind: "photo", fileId: "f1" }, fileDeps(ws, { getFile: async () => ({ file_path: "../secret" }) }));
  assert.match(traversal.note, /no safe file path/, "file_path never escapes the bot file root");
});

test("isVisionUnsupportedError matches provider rejections only", () => {
  for (const m of [
    "400 Invalid type for message content part 'image_url'",
    "this model does not support images",
    "400 multimodal content is not supported for this endpoint",
    "422 unknown variant `image_url`",
    "not a text model",
  ]) {
    assert.ok(isVisionUnsupportedError(new Error(m)), m);
  }
  assert.ok(!isVisionUnsupportedError(new Error("401 invalid api key")));
  assert.ok(!isVisionUnsupportedError(new Error("500 internal error")));
  assert.ok(!isVisionUnsupportedError(new Error("rate limit hit")));
});

test("loop: attachments become an OpenAI content-part array on the user turn", async (t) => {
  const { store } = mkStore(t, "sc-media-turn-");
  const seen = [];
  const fake = {
    async *stream(opts) {
      seen.push(opts.messages);
      yield { type: "text", text: "I see a cat" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  const dataUri = "data:image/jpeg;base64,QUJD";
  let final = "";
  await loop.run({
    sessionKey: "telegram:7",
    text: "<media:photo path=\"/w/p.jpg\">\nwhat is this?",
    attachments: [{ kind: "image", dataUri, name: "photo.jpg" }],
    onEvent: (e) => { if (e.type === "final") final = e.text; },
  });
  assert.equal(final, "I see a cat");
  const user = seen[0][seen[0].length - 1];
  assert.equal(user.role, "user");
  assert.ok(Array.isArray(user.content), "content parts, not a string");
  assert.equal(user.content[0].type, "text");
  assert.equal(user.content[1].type, "image_url");
  assert.equal(user.content[1].image_url.url, dataUri);
});

test("loop: image-rejecting provider retries the turn text-only with the note", async (t) => {
  const { store } = mkStore(t, "sc-media-fallback-");
  const seen = [];
  let calls = 0;
  const fake = {
    async *stream(opts) {
      calls++;
      seen.push(opts.messages);
      const last = opts.messages[opts.messages.length - 1];
      if (Array.isArray(last.content)) {
        throw Object.assign(new Error("400 this model does not support images"), { status: 400 });
      }
      yield { type: "text", text: "describe what you can from the path" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  let final = "";
  await loop.run({
    sessionKey: "telegram:8",
    text: "<media:photo path=\"/w/p.jpg\">",
    attachments: [{ kind: "image", dataUri: "data:image/jpeg;base64,QUJD", name: "p.jpg" }],
    onEvent: (e) => { if (e.type === "final") final = e.text; },
  });
  assert.equal(calls, 2, "exactly one fallback retry");
  const retryUser = seen[1][seen[1].length - 1];
  assert.equal(typeof retryUser.content, "string", "text-only retry");
  assert.match(retryUser.content, /\[image omitted - provider text-only\]/);
  assert.equal(final, "describe what you can from the path");
});
