// Task 32 — Markdown → Telegram HTML, and splitting without breaking markup.
//
// Telegram renders a small HTML subset and rejects malformed markup outright,
// so the conversion is conservative on purpose: escape first, emit only
// documented tags, and degrade to plain text instead of ever losing a message.

import { test } from "node:test";
import assert from "node:assert/strict";

const { telegramHtml, telegramChunks, splitMarkdown, escapeTelegramHtml: escapeHtml } = await import("../dist/lib.js");

test("inline Markdown becomes the Telegram subset", () => {
  assert.equal(telegramHtml("**bold** and *italic* and ~~gone~~"), "<b>bold</b> and <i>italic</i> and <s>gone</s>");
  assert.equal(telegramHtml("snake_case_names stay"), "snake_case_names stay", "a bare underscore is not italics");
  assert.equal(telegramHtml("`a_b_c` and `x < y`"), "<code>a_b_c</code> and <code>x &lt; y</code>");
  assert.equal(telegramHtml("***both***"), "<b><i>both</i></b>");
  assert.equal(telegramHtml("[docs](https://example.com/a_b)"), '<a href="https://example.com/a_b">docs</a>');
});

test("nothing the model writes can inject a tag", () => {
  assert.equal(telegramHtml("if a < b and b > c && d"), "if a &lt; b and b &gt; c &amp;&amp; d");
  assert.equal(telegramHtml("<b>not bold</b>"), "&lt;b&gt;not bold&lt;/b&gt;");
  // Escapes survive inside a link's text and its URL.
  assert.equal(telegramHtml("[a & b](https://x.com/?a=1&b=2)"), '<a href="https://x.com/?a=1&amp;b=2">a &amp; b</a>');
  // Only schemes Telegram will actually open become links; anything else keeps
  // its text and loses the markup.
  assert.equal(telegramHtml("[click](ftp://example.com)"), "click");
  assert.ok(!telegramHtml("[click](javascript:void)").includes("<a "), "no javascript: link is emitted");
});

test("blocks: headings bold, quotes quoted, rules ruled, fences pre", () => {
  assert.equal(telegramHtml("## Summary\n\ntext"), "<b>Summary</b>\n\ntext");
  assert.equal(telegramHtml("> quoted **here**"), "<blockquote>quoted <b>here</b></blockquote>");
  assert.equal(telegramHtml("---"), "──────────");
  assert.equal(telegramHtml("```js\nconst a = 1 < 2;\n```"), "<pre><code>const a = 1 &lt; 2;</code></pre>");
  // An unterminated fence is still code — never a hole in the markup.
  assert.equal(telegramHtml("```\nstill code"), "<pre><code>still code</code></pre>");
});

test("a list keeps its bullets and its emphasis", () => {
  assert.equal(telegramHtml("- **one**\n- two"), "- <b>one</b>\n- two");
});

test("a table becomes an aligned monospace block, not a wall of pipes", () => {
  const html = telegramHtml("| Tool | Calls |\n|---|---|\n| fs_read | 3 |\n| exec | 12 |");
  assert.match(html, /^<pre>/, "a table becomes pre");
  assert.ok(!html.includes("| Tool | Calls |"), "the pipes are gone");
  const body = html.replace(/<\/?pre>/g, "");
  const rows = body.split("\n");
  assert.equal(rows.length, 4, "header + rule + two rows");
  assert.match(rows[2], /^\s*fs_read\s+│\s+3\s*$/, `aligned row, got ${JSON.stringify(rows[2])}`);
  assert.match(rows[3], /exec/);
});

test("headings and tables win over the inline rule that would eat them", () => {
  assert.equal(telegramHtml("| a | b |\n|---|---|\n| 1 | 2 |").includes("──────────"), false, "separator is not a rule");
  assert.equal(telegramHtml("### Title"), "<b>Title</b>");
});

test("long text splits on paragraph boundaries and every part converts", () => {
  const para = "word ".repeat(200).trim(); // ~1000 chars
  const text = Array.from({ length: 9 }, (_, i) => `## Part ${i + 1}\n\n${para}`).join("\n\n");
  const chunks = splitMarkdown(text);
  assert.ok(chunks.length >= 3, `split into ${chunks.length} parts`);
  for (const c of chunks) assert.ok(c.length <= 3800, `chunk of ${c.length} fits the source limit`);
  assert.ok(chunks.every((c) => !c.startsWith("\n")), "no chunk begins with a blank line");
  // Nothing is lost: concatenating the parts recovers every heading.
  const joined = chunks.join("\n\n");
  for (let i = 1; i <= 9; i++) assert.ok(joined.includes(`## Part ${i}`), `Part ${i} survived`);
});

test("each ready-to-send chunk is valid markup under the parsed cap", () => {
  const text = Array.from({ length: 12 }, (_, i) => `**Section ${i}**\n\n${"x ".repeat(300)}`).join("\n\n");
  const chunks = telegramChunks(text);
  assert.ok(chunks.length > 1, "it split");
  for (const c of chunks) {
    assert.ok(c.length <= 4096, `chunk of ${c.length} under Telegram's cap`);
    // Every opened tag is closed in the same message — Telegram 400s otherwise.
    const open = (c.match(/<b>/g) ?? []).length;
    const close = (c.match(/<\/b>/g) ?? []).length;
    assert.equal(open, close, `balanced <b> in ${c.slice(0, 40)}…`);
  }
});

test("a fence crossing a split is closed and reopened, never left broken", () => {
  const code = Array.from({ length: 400 }, (_, i) => `line ${i} of the log with some padding text`).join("\n");
  const chunks = telegramChunks(`Before\n\n\`\`\`\n${code}\n\`\`\`\n\nAfter`);
  assert.ok(chunks.length > 1, "the block was split");
  for (const c of chunks) {
    const open = (c.match(/<pre>/g) ?? []).length;
    const close = (c.match(/<\/pre>/g) ?? []).length;
    assert.equal(open, close, "every <pre> is closed inside its own message");
  }
  assert.ok(chunks.join("").includes("line 0 of the log"), "no content lost at the seam");
});

test("dense escaping that outgrows the cap degrades to plain text, not truncation", () => {
  const text = "<&>".repeat(2000); // 6000 chars, triples when escaped
  const chunks = telegramChunks(text);
  const total = chunks.join("");
  assert.equal(total.replace(/&lt;|&gt;|&amp;/g, (m) => (m === "&lt;" ? "<" : m === "&gt;" ? ">" : "&")).length >= 6000 - 2, true, "no characters dropped");
  for (const c of chunks) assert.ok(c.length <= 4096);
  assert.ok(!chunks.some((c) => c.includes("&lt;")), "fell back to plain text rather than emitting oversized escaped markup");
});

test("escaping is the documented three characters only", () => {
  assert.equal(escapeHtml(`a&b<c>d"e'f`), `a&amp;b&lt;c&gt;d"e'f`);
});
