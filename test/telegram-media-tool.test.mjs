import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  emptyConfig,
  buildRegistry,
  resolveTelegramMediaFile,
  TELEGRAM_OUTBOUND_MAX_BYTES,
  sendTelegramMedia,
} = await import("../dist/lib.js");

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "suparclaw-tg-out-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "media"));
  return dir;
}

function touch(file, contents = "sample") {
  writeFileSync(file, contents);
}

test("auto mode maps common media to Telegram-native delivery and other files to documents", (t) => {
  const dir = workspace(t);
  for (const name of ["photo.png", "clip.mp4", "track.mp3", "note.ogg", "loop.gif", "report.pdf", "large.png"]) {
    touch(join(dir, "media", name));
  }
  truncateSync(join(dir, "media", "large.png"), 10 * 1024 * 1024 + 1);
  const type = (name) => resolveTelegramMediaFile(dir, `media/${name}`).kind;
  assert.equal(type("photo.png"), "photo");
  assert.equal(type("clip.mp4"), "video");
  assert.equal(type("track.mp3"), "audio");
  assert.equal(type("note.ogg"), "voice");
  assert.equal(type("loop.gif"), "animation");
  assert.equal(type("report.pdf"), "document");
  assert.equal(type("large.png"), "document", "large images remain sendable as a file");
});

test("media path validation rejects traversal, symlinks, non-files, empty files and oversize uploads", (t) => {
  const dir = workspace(t);
  touch(join(dir, "media", "ok.txt"));
  touch(join(dir, "outside.txt"));
  touch(join(dir, "media", "empty.bin"), "");
  touch(join(dir, "media", "too-big.bin"), "x");
  truncateSync(join(dir, "media", "too-big.bin"), TELEGRAM_OUTBOUND_MAX_BYTES + 1);
  symlinkSync(join(dir, "outside.txt"), join(dir, "media", "escape.txt"));
  assert.throws(() => resolveTelegramMediaFile(dir, "../outside.txt"), /parent-directory/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/escape.txt"), /symbolic links/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media"), /regular file/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/empty.bin"), /empty files/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/too-big.bin"), /limited to 50 MB/);
  assert.throws(() => resolveTelegramMediaFile(dir, "/etc/passwd"), /workspace-relative/);
});

test("explicit media methods validate their file format and Telegram constraints", (t) => {
  const dir = workspace(t);
  touch(join(dir, "media", "picture.png"));
  touch(join(dir, "media", "movie.mov"));
  touch(join(dir, "media", "song.wav"));
  touch(join(dir, "media", "text.txt"));
  touch(join(dir, "media", "cover.png"));
  assert.throws(() => resolveTelegramMediaFile(dir, "media/picture.png", "photo", undefined, "x".repeat(1025)), /caption/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/movie.mov", "video"), /mp4/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/song.wav", "audio"), /mp3 or .m4a/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/text.txt", "photo"), /supports .jpg/);
  assert.throws(() => resolveTelegramMediaFile(dir, "media/text.txt", "unknown"), /unsupported media type/);
  assert.equal(resolveTelegramMediaFile(dir, "media/text.txt", "document", "../safe name.txt", "Ready").filename, "safe name.txt");
  const renamed = resolveTelegramMediaFile(dir, "media/cover.png", "auto", "cover");
  assert.equal(renamed.filename, "cover.png");
  assert.equal(renamed.kind, "photo");
  assert.throws(() => resolveTelegramMediaFile(dir, "media/cover.png", "auto", "cover.pdf"), /extension must match/);
});

test("telegram_send_media uploads only through the active Telegram sender", async (t) => {
  const dir = workspace(t);
  touch(join(dir, "media", "ready.txt"), "ready");
  const tool = buildRegistry(emptyConfig()).find((item) => item.name === "telegram_send_media");
  assert.ok(tool, "tool is registered for per-turn surface filtering");
  const unavailable = await tool.run({ path: "media/ready.txt" }, { workspace: dir });
  assert.match(unavailable, /only during a live Telegram chat/);
  let sent;
  const result = await tool.run({ path: "media/ready.txt", caption: "Done" }, {
    workspace: dir,
    telegramMedia: async (file) => { sent = file; return { messageId: 42 }; },
  });
  assert.match(result, /Sent ready.txt .* as document/);
  assert.equal(sent.filename, "ready.txt");
  assert.equal(sent.caption, "Done");
  assert.equal(sent.path, join(dir, "media", "ready.txt"));
  assert.match(await tool.run({ path: "../outside.txt" }, {
    workspace: dir,
    telegramMedia: async () => assert.fail("invalid path must not upload"),
  }), /error: could not send Telegram media/);
});

test("media dispatcher selects the correct Bot API method and carries captions", async () => {
  const calls = [];
  const api = Object.fromEntries(["Photo", "Video", "Audio", "Voice", "Animation", "Document"].map((name) => [
    `send${name}`,
    async (chatId, file, extra) => { calls.push({ method: name, chatId, file, extra }); return { message_id: calls.length }; },
  ]));
  const kinds = ["photo", "video", "audio", "voice", "animation", "document"];
  for (const kind of kinds) {
    await sendTelegramMedia(api, 123, { path: "/workspace/x", filename: "x", kind, caption: "caption" }, "input-file", 77);
  }
  assert.deepEqual(calls.map((call) => call.method), ["Photo", "Video", "Audio", "Voice", "Animation", "Document"]);
  assert.ok(calls.every((call) => call.chatId === 123 && call.file === "input-file" && call.extra.caption === "caption" && call.extra.message_thread_id === 77));
});

test("the sending tool is exposed only to turns with a live Telegram sender", async (t) => {
  const { AgentLoop, Store, createLogger } = await import("../dist/lib.js");
  const home = mkdtempSync(join(tmpdir(), "suparclaw-tg-tool-loop-"));
  const previousHome = process.env.SUPARCLAW_HOME;
  process.env.SUPARCLAW_HOME = home;
  const store = Store.open(join(home, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.SUPARCLAW_HOME;
    else process.env.SUPARCLAW_HOME = previousHome;
  });
  const dir = join(home, ".suparclaw", "workspace");
  mkdirSync(join(dir, "media"), { recursive: true });
  touch(join(dir, "media", "sent.txt"), "ok");
  let sent = 0;
  const schemas = [];
  let round = 0;
  const llm = {
    async *stream(opts) {
      schemas.push((opts.tools ?? []).map((tool) => tool.function?.name));
      round += 1;
      if (round === 1) {
        yield { type: "tool_calls", calls: [{ id: "send-1", name: "telegram_send_media", args: JSON.stringify({ path: "media/sent.txt" }) }] };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text", text: "Finished." };
        yield { type: "done", finishReason: "stop" };
      }
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm, tools: buildRegistry(emptyConfig()) });
  await loop.run({
    sessionKey: "telegram:123",
    text: "send that file",
    source: "telegram",
    telegramMedia: async () => { sent += 1; return { messageId: 1 }; },
    onEvent: () => {},
  });
  assert.equal(sent, 1, JSON.stringify({ schemas, calls: (await import("../dist/lib.js")).Store ? store.recentMessages(store.getSessionByKey("telegram:123").id, 30).map((m) => m.content) : [] }));
  assert.ok(schemas[0].includes("telegram_send_media"));

  round = 0;
  schemas.length = 0;
  await loop.run({
    sessionKey: "main:web",
    text: "send that file",
    source: "gateway",
    telegramMedia: async () => { sent += 100; return { messageId: 2 }; },
    onEvent: () => {},
  });
  assert.equal(sent, 1, "a non-Telegram turn cannot use the bound callback");
  assert.ok(!schemas[0].includes("telegram_send_media"));
});
