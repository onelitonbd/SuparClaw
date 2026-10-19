import { test } from "node:test";
import assert from "node:assert/strict";
import { renderUiMarkdown, escapeHtml, fuzzy } from "../dist/lib.js";

test("markdown: headings, lists, code", () => {
  const html = renderUiMarkdown("# Title\n\n- one\n- two\n\n```js\nconst a = 1;\n```");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<pre data-lang="js"><code>const a = 1;<\/code><\/pre>/);
});

test("markdown: inline emphasis and links", () => {
  const html = renderUiMarkdown("**bold** and `code` and [docs](https://example.com/x)");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/x"[^>]*>docs<\/a>/);
});

test("markdown: table", () => {
  const html = renderUiMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th><th>b<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});

test("markdown: user content can never inject markup", () => {
  const html = renderUiMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(escapeHtml("<b>"), "&lt;b&gt;");
});

test("markdown: bare urls become links, javascript: never does", () => {
  const html = renderUiMarkdown("see https://suparclaw.dev now");
  assert.match(html, /<a href="https:\/\/suparclaw.dev"/);
  const bad = renderUiMarkdown("[x](javascript:alert(1))");
  assert.ok(!bad.includes('href="javascript:'), "javascript: URLs never become links");
  assert.ok(!/<a /.test(bad), "no anchor is created for a non-http scheme");
});

test("fuzzy: prefix beats substring beats subsequence", () => {
  assert.ok(fuzzy("gpt", "gpt-4o-mini") > fuzzy("gpt", "mini-gpt-4o"));
  assert.ok(fuzzy("gpt", "mini-gpt-4o") > fuzzy("gpt", "groq/llama"));
  assert.equal(fuzzy("xyz", "gpt-4o-mini"), 0);
  assert.ok(fuzzy("", "anything") > 0);
});
