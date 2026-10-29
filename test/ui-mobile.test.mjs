// Task 26 (audit 2) — mobile chrome.
//
// No browser exists in this sandbox, so the checks are the properties that
// actually decide whether the app is usable on a phone: the viewport meta,
// notch/home-indicator padding, touch-target sizing, the overlay breakpoint for
// the settings rail, and the absence of viewport-width arithmetic that causes
// horizontal scroll. These are the class of bug that survives a desktop check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, "ui/index.html"), "utf8");
const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");

/** The declarations of one rule. Matches the selector as a whole, so
 *  `.settings .usage-table` cannot accidentally return `.usage-tablewrap`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*\\{`).exec(css);
  assert.ok(m, `${selector} exists`);
  const open = m.index + m[0].length - 1;
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

test("the viewport covers the notch and shrinks for the keyboard", () => {
  const meta = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
  assert.match(meta, /width=device-width/);
  assert.match(meta, /initial-scale=1/);
  assert.match(meta, /viewport-fit=cover/, "without it the safe-area env() values are always 0");
  assert.match(meta, /interactive-widget=resizes-content/, "Android keyboard must not cover the composer");
});

test("top and bottom chrome respect the safe areas", () => {
  assert.match(rule(".rail"), /env\(safe-area-inset-top\)/, "the rail sits under the notch otherwise");
  assert.match(rule(".dock"), /env\(safe-area-inset-bottom\)/, "the composer sits under the home indicator otherwise");
  assert.match(rule(".drawer"), /env\(safe-area-inset-(top|bottom)\)/, "the sessions drawer spans the screen");
  assert.match(rule(".settings__topbar"), /env\(safe-area-inset-top\)/, "the settings app bar too");
});

test("the app is a fixed viewport, not a scrolling page", () => {
  const app = rule(".app");
  assert.match(app, /height:\s*100dvh/, "dvh adapts to the mobile URL bar");
  assert.match(app, /overflow:\s*hidden/);
  assert.deepEqual(css.match(/100vw/g) ?? [], [], "100vw includes the scrollbar and causes horizontal drift");
});

test("typing does not zoom the page on iOS", () => {
  assert.match(rule(".composer textarea"), /font-size:\s*16px/);
  assert.match(rule(".inp"), /font-size:\s*16px/);
});

test("touch targets grow on coarse pointers", () => {
  // The message actions (Copy/Edit/Fork) and the jump-to-latest button.
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(coarse, /\.msg__act\s*\{[^}]*width:\s*36px[^}]*height:\s*36px/s, "icon actions stay tappable");
  assert.match(coarse, /\.jump\s*\{[^}]*width:\s*var\(--tap\)[^}]*height:\s*var\(--tap\)/s, "jump button is 44px");
  assert.match(coarse, /\.msg__actions\s*\{\s*opacity:\s*1;?\s*\}/, "actions cannot hide behind hover on touch");
});

test("the settings rail becomes an overlay below the app breakpoint", () => {
  const at = css.indexOf("@media (max-width: 880px)");
  assert.ok(at > 0, "the 880px breakpoint exists");
  const block = css.slice(at, css.indexOf("@media", at + 10));
  assert.match(block, /\.settings__sidebar\s*\{[^}]*position:\s*fixed/s, "the rail leaves the column flow");
  assert.match(block, /\.settings__sidebar\s*\{[^}]*width:\s*min\(84vw,\s*320px\)/s, "and never eats the screen");
  assert.match(block, /\.settings__nav-item\s*\{[^}]*min-height:\s*44px/s, "nav rows stay tappable");
});

test("wide tables scroll inside their own card", () => {
  assert.match(rule(".settings .usage-tablewrap"), /overflow-x:\s*auto/);
  assert.match(rule(".settings .usage-table"), /min-width:\s*540px/);
});

test("the chat transcript can never push the page sideways", () => {
  const scroll = rule(".scroll");
  assert.match(scroll, /overflow-x:\s*hidden/, "long code/URLs clip inside the scroller");
  const thread = css.slice(css.indexOf(".msg__body pre"), css.indexOf(".msg__body pre") + 400);
  assert.match(thread, /overflow-x:\s*auto/, "code blocks scroll themselves instead");
});
