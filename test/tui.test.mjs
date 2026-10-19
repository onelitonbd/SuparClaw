import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  renderMarkdown,
  renderInline,
  detectLightMode,
  Editor,
  parseKeys,
  width,
  truncateToWidth,
  wrapText,
  sanitize,
  Screen,
  splitForTelegram,
} from "../dist/lib.js";

test("markdown renders headings, bullets, quotes and code", () => {
  const lines = renderMarkdown("# Title\n\n- one\n- two\n\n> quoted\n\n```\ncode\n```", 60);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Title"));
  assert.ok(joined.includes("•"));
  assert.ok(joined.includes("│"));
  assert.ok(joined.includes("code"));
  // every line must fit the terminal width
  for (const line of lines) assert.ok(width(line) <= 60, `line too wide: ${line}`);
});

test("inline markdown maps emphasis, code and links", () => {
  assert.ok(renderInline("**bold**").includes("bold"));
  assert.ok(renderInline("`code`").includes("code"));
  assert.ok(renderInline("[docs](https://x.dev)").includes("https://x.dev"));
});

test("light mode detection honours COLORFGBG and override", () => {
  assert.equal(detectLightMode({ SUPARCLAW_THEME: "light" }), true);
  assert.equal(detectLightMode({ SUPARCLAW_THEME: "dark" }), false);
  // xterm index 15 = white background, 0 = black background
  assert.equal(detectLightMode({ COLORFGBG: "0;15" }), true);
  assert.equal(detectLightMode({ COLORFGBG: "15;0" }), false);
});

test("width helpers handle CJK, ANSI and truncation", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("\x1b[31mabc\x1b[39m"), 3);
  assert.equal(width("你好"), 4);
  const cut = truncateToWidth("hello world", 8);
  assert.equal(width(cut), 8);
  assert.ok(cut.endsWith("…"));
});

test("wrapText never exceeds the column budget", () => {
  const wrapped = wrapText("the quick brown fox jumps over the lazy dog", 12);
  for (const line of wrapped) assert.ok(width(line) <= 12);
});

test("sanitize strips terminal control sequences", () => {
  const dirty = "safe\x1b[2J\x1b[31mred\x07\x00";
  const clean = sanitize(dirty);
  assert.equal(clean, "safered");
});

test("editor supports multiline editing and history", () => {
  const ed = new Editor();
  for (const ch of "hello") ed.insert(ch);
  assert.equal(ed.text, "hello");
  ed.newline();
  ed.insert("w");
  assert.equal(ed.x, 1);
  assert.equal(ed.lines.length, 2);
  ed.backspace();
  assert.equal(ed.text, "hello");
  const committed = ed.commit();
  assert.equal(committed, "hello");
  assert.equal(ed.isEmpty, true);
});

test("key parser maps control keys and escapes", () => {
  assert.equal(parseKeys("\r")[0].name, "enter");
  assert.equal(parseKeys("\x03")[0].name, "ctrl-c");
  assert.equal(parseKeys("\x1b[A")[0].name, "up");
  assert.equal(parseKeys("\x1b[3~")[0].name, "delete");
  assert.equal(parseKeys("a")[0].ch, "a");
});

test("screen only repaints changed rows", () => {
  let written = "";
  const fake = new Writable({
    write(chunk, _enc, cb) {
      written += chunk.toString();
      cb();
    },
  });
  fake.rows = 10;
  fake.columns = 40;
  const screen = new Screen(fake);
  screen.enter();
  written = "";
  screen.draw(["a", "b", "c"]);
  written = "";
  screen.draw(["a", "b", "c"]);
  assert.equal(written.length, 0, "identical frame must not write anything");
  written = "";
  screen.draw(["a", "x", "c"]);
  assert.ok(written.length > 0 && written.length < 27, "single row change is cheaper than a full frame");
});

test("telegram chunking respects the 4096 limit", () => {
  const long = "x".repeat(9000);
  const chunks = splitForTelegram(long);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 4000);
});