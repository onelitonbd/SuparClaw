// The chat sidebar: grouping, rows and search hits.
//
// What was wrong: the drawer was a 316px overlay on every screen (a scrim over
// the thread you were reading), a row was one <button> with the kebab <button>
// nested inside it, the kebab was a 20px hit target, every refresh re-ran a
// `.5s` enter animation on all rows, the active row had no `aria-current`, the
// session key was never printed, the only way to delete was `window.confirm`,
// and Escape did nothing unless the search field had focus.
//
// The builders are pure, so this file renders them directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();
const root = parseHTML("<!doctype html><html><body></body></html>");
globalThis.document = root.document;
globalThis.window = root.window;
globalThis.HTMLElement = root.HTMLElement;
globalThis.Event = root.window.Event;

const outDir = mkdtempSync(join(tmpdir(), "sc-ui-sidebar-"));
await (await import("esbuild")).build({
  entryPoints: [join(ROOT, "ui/src/sessions.ts")],
  bundle: true, format: "esm", outdir: outDir, outExtension: { ".js": ".mjs" }, platform: "neutral",
});
const { bucketOf, groupSessions, rowTitle, rowMeta, placeholderTitle, sessionRow, sessionHit, searchView } =
  await import(pathToFileURL(join(outDir, "sessions.mjs")).href);

const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const fire = (n, type) => n.dispatchEvent(new root.window.Event(type, { bubbles: true }));
const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime(); // 26 Oct 2026, 12:00 local
const HOUR = 3_600_000;
const DAY = 86_400_000;
const rows = () => [
  { key: "main:today", name: "Today's work", last_msg_at: NOW - HOUR },
  { key: "main:yday", title: "Yesterday's work", last_msg_at: NOW - DAY },
  { key: "main:week", last_msg_at: NOW - 3 * DAY },
  { key: "main:old", last_msg_at: NOW - 30 * DAY },
  { key: "main:arch", name: "Put away", last_msg_at: NOW - HOUR, archived: 1 },
  { key: "main:archold", last_msg_at: NOW - 40 * DAY, archived: 1 },
  { key: "main:today", name: "duplicate", last_msg_at: NOW - HOUR },
  { key: "main:fresh" },
];

test("rows fall into Today / Yesterday / Previous 7 days / Older / Archived, archived last", () => {
  assert.equal(bucketOf(rows()[0], NOW), "Today");
  assert.equal(bucketOf(rows()[1], NOW), "Yesterday");
  assert.equal(bucketOf(rows()[2], NOW), "Previous 7 days");
  assert.equal(bucketOf(rows()[3], NOW), "Older");
  assert.equal(bucketOf(rows()[4], NOW), "Archived", "archived wins over age");
  assert.equal(bucketOf({ key: "main:x" }, NOW), "Today", "no timestamp still exists now");

  const groups = groupSessions(rows(), NOW);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday", "Previous 7 days", "Older", "Archived"]);
  assert.deepEqual(groups.map((g) => g.rows.length), [2, 1, 1, 1, 2]);
  assert.equal(groups[0].rows.filter((r) => r.key === "main:today").length, 1, "de-duplicated by key");
  assert.equal(groups[0].rows.find((r) => r.key === "main:today").name, "Today's work", "first row wins");
  assert.equal(groups.at(-1).label, "Archived", "archived is always the last group");
  assert.equal(groupSessions([], NOW).length, 0);
});

test("a row names itself and its key, without nesting one button in another", () => {
  const calls = { open: 0, menu: 0 };
  const row = sessionRow(rows()[0], {
    active: true, busy: false,
    onOpen: () => calls.open++, onMenu: () => calls.menu++,
  });
  assert.match(row.className, /\bis-active\b/);
  assert.equal(row.getAttribute("data-key"), "main:today");
  const open = row.querySelector(".session__open");
  assert.equal(open.getAttribute("aria-current"), "page", "the current row is marked for assistive tech");
  assert.equal(open.getAttribute("type"), "button");
  assert.equal(row.querySelectorAll("button button").length, 0, "no interactive content inside a button");
  assert.equal(row.querySelectorAll("button").length, 2, "open + kebab");
  assert.equal(text(row.querySelector(".session__title")), "Today's work");
  assert.equal(open.getAttribute("title"), "main:today", "the key is one hover away");
  assert.equal(open.getAttribute("aria-label"), "Today's work (main:today)", "and in the accessible name");
  assert.ok(!text(row.querySelector(".session__meta")).includes("main:today"), "but not in the meta line");
  assert.equal(row.querySelector(".dot--live"), null, "no busy dot when idle");
  const kebab = row.querySelector(".session__kebab");
  assert.equal(kebab.getAttribute("aria-label"), "Menu for main:today");

  fire(open, "click");
  assert.equal(calls.open, 1);
  assert.equal(calls.menu, 0, "opening the session does not open the menu");
  fire(kebab, "click");
  assert.equal(calls.menu, 1);
  assert.equal(calls.open, 1, "the kebab does not also switch session");
});

test("inactive, busy, archived and unnamed rows", () => {
  const inactive = sessionRow(rows()[1], { active: false, busy: true, onOpen() {}, onMenu() {} });
  assert.equal(inactive.getAttribute("aria-current"), null);
  assert.equal(inactive.querySelector(".session__open").getAttribute("aria-current"), null);
  assert.ok(inactive.querySelector(".dot--live"), "the working session has a dot");
  assert.ok(!inactive.className.includes("session--archived"), "an active row is not marked archived");

  const archived = sessionRow(rows()[4], { active: false, busy: false, onOpen() {}, onMenu() {} });
  assert.match(archived.className, /session--archived/, "an archived row is marked in the list");
  assert.ok(!text(archived.querySelector(".session__meta")).includes("archived"), "the group already says archived");

  // Task 29: an unnamed chat no longer introduces itself by its key — new chats
  // name themselves from their first exchange, and until then they read as what
  // they are. (`main:main` is the chat that always exists, so it says "Main".)
  const bare = sessionRow({ key: "main:main" }, { active: false, busy: false, onOpen() {}, onMenu() {} });
  assert.equal(text(bare.querySelector(".session__title")), "Main chat", "no key in the title");
  assert.equal(text(bare.querySelector(".session__meta")), "no messages");
  assert.match(bare.getAttribute("aria-label") ?? bare.querySelector(".session__open").getAttribute("aria-label") ?? "", /main:main/, "the key is still announced");

  const fresh = sessionRow({ key: "main:m3x9q" }, { active: false, busy: false, onOpen() {}, onMenu() {} });
  assert.equal(text(fresh.querySelector(".session__title")), "New chat");

  assert.equal(rowTitle({ key: "main:a", name: "Named", title: "Auto" }), "Named", "rename wins");
  assert.equal(rowTitle({ key: "main:a", title: "Auto" }), "Auto");
  assert.equal(rowTitle({ key: "main:a" }), "New chat", "and an unnamed row has a readable fallback");
  assert.equal(placeholderTitle("main:main"), "Main chat");
  assert.equal(rowMeta({ key: "main:a", last_msg_at: 0 }), "no messages");
});

test("search: one header with real counts, the same rows, and a way out", () => {
  const opened = [];
  const cleared = [];
  const handlers = {
    openSession: (k) => opened.push([k]),
    openHit: (k, id) => opened.push([k, id]),
    clear: () => cleared.push(1),
  };
  const hits = {
    titleHits: [
      { sessionKey: "main:a", title: "Alpha", lastMsgAt: NOW - HOUR },
      { sessionKey: "main:b", lastMsgAt: NOW - 2 * HOUR },
    ],
    messageHits: [
      { sessionKey: "main:c", title: "Gamma", role: "user", createdAt: NOW - HOUR, snippet: "the «needle» is here", messageId: 42 },
    ],
  };
  const nodes = searchView("needle", hits, handlers);
  assert.equal(text(nodes[0].firstChild), "2 sessions · 1 message", "counts, in words");
  assert.equal(nodes[0].querySelectorAll("button").length, 1, "only the clear control in the header");
  fire(nodes[0].querySelector(".srccap__clear"), "click");
  assert.equal(cleared.length, 1);

  const rowsOut = nodes.slice(1);
  assert.equal(rowsOut.length, 3, "two session hits and one message hit");
  assert.equal(text(rowsOut[0].querySelector(".session__title")), "Alpha");
  assert.equal(text(rowsOut[1].querySelector(".session__title")), "main:b", "a hit without a title shows its key");

  const hit = rowsOut[2];
  assert.match(hit.className, /session--hit/);
  assert.match(text(hit.querySelector(".session__meta")), /^user · .* · main:c$/);
  assert.equal(hit.querySelectorAll("mark").length, 1, "the server's « » marks become <mark>");
  assert.equal(text(hit.querySelector("mark")), "needle");
  fire(hit.querySelector(".session__open"), "click");
  assert.deepEqual(opened, [["main:c", 42]], "a message hit reopens at the message");
  fire(rowsOut[0].querySelector(".session__open"), "click");
  assert.deepEqual(opened.at(-1), ["main:a"]);
});

test("no hits is a sentence plus a button, not a caps header", () => {
  const cleared = [];
  const nodes = searchView("zzz", {}, { openSession() {}, openHit() {}, clear: () => cleared.push(1) });
  assert.match(text(nodes[0]), /^No matches for “zzz”/);
  const empty = nodes.find((n) => (n.className ?? "").includes("sidebar__empty"));
  assert.ok(empty, "the empty state has its own block");
  const again = empty.querySelector("button");
  assert.equal(text(again), "Clear search");
  fire(again, "click");
  assert.equal(cleared.length, 1);
});

test("the shell keeps every wiring the old drawer had, minus the native dialog", () => {
  const main = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  const html = readFileSync(join(ROOT, "ui/index.html"), "utf8");
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");

  // module used, not a second copy of the renderers
  assert.match(main, /from "\.\/sessions\.js"/);
  assert.match(main, /groupSessions\(rows\)/);
  assert.match(main, /sessionRow\(s, \{/);
  assert.match(main, /searchView\(q, result, \{/);
  assert.ok(!main.includes("function snippetNodes"), "the snippet parser lives in one place");

  // delete goes through the app's dialog
  assert.ok(!main.includes("window.confirm"), "the shell never calls a native dialog");
  assert.match(main, /title: "Delete session\?"/);
  assert.match(main, /danger: true/);

  // a real column, remembered, with the app's existing breakpoint
  assert.match(main, /localStorage\.getItem\("sc\.sidebar"\)/);
  assert.match(main, /localStorage\.setItem\("sc\.sidebar"/);
  assert.match(main, /matchMedia\("\(min-width: 881px\)"\)/);
  assert.match(main, /function applySidebar\(\)/);
  assert.match(main, /sideQuery\?\.addEventListener\?\.\("change", applySidebar\)/);
  assert.match(main, /if \(!drawerOverlay\.hidden\) \{ closeDrawer\(true\); return; \}/, "Escape closes the sidebar before it stops a turn");
  assert.equal((main.match(/if \(!sideQuery\?\.matches\) closeDrawer\(\);/g) ?? []).length, 2,
    "switching or reopening a session only dismisses the overlay, never the desktop column");
  assert.ok(main.includes('$("drawer").focus()'), "focus moves into the panel on a phone");

  // markup: counts, a real new-chat row, a footer for prune
  for (const id of ["sessions-count", "sessions-foot", "new-session", "sessions-prune", "drawer-close"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html keeps #${id}`);
  }
  assert.match(html, /class="side-new"[^>]*id="new-session"|id="new-session"[^>]*class="side-new"/);
  assert.match(html, /<aside class="drawer" id="drawer"[^>]*tabindex="-1"/);
  assert.match(html, /documentElement\.dataset\.side = localStorage\.getItem\("sc\.sidebar"\) === "closed"/,
    "the first paint knows the remembered choice");
  assert.ok(!html.includes("drawer__sub"), "the sub-row is gone");

  // the column only exists above the breakpoint
  const wide = css.slice(css.indexOf("@media (min-width: 881px)"));
  assert.ok(wide.length > 200, "the wide block exists");
  assert.match(wide, /#drawer-overlay \{/);
  assert.match(wide, /position: static/);
  assert.match(wide, /grid-template-columns: auto minmax\(0, 1fr\)/);
  assert.match(wide, /\.drawer \{[^}]*width: 264px/s);
  assert.match(wide, /\.drawer__close \{ display: none; \}/);
  assert.match(wide, /#chat-view,\s*#settings-view \{[^}]*min-width: 0/s);
  assert.match(wide, /html:not\(\[data-side="closed"\]\) #chat-view:not\(\[hidden\]\) ~ #drawer-overlay\[hidden\] \{ display: flex !important; \}/,
    "the column is visible before app.js runs, but never over Settings");

  // rows: no enter animation, a real menu target, no nested selector leftovers
  const match = css.match(/\n\.session \{\n([\s\S]*?)\n\}/);
  assert.ok(match, "the row block was found");
  assert.ok(!match[1].includes("animation"), "rows do not re-animate on every refresh");
  assert.equal((css.match(/\.session--archived \{/g) ?? []).length, 1, "one archived marker, not two");
  assert.match(css, /\.session__kebab \{[^}]*width: 36px/s);
  assert.match(css, /\.session__kebab \{[^}]*height: 36px/s);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*\.session__kebab \{ width: var\(--tap\); height: var\(--tap\);/);
  assert.ok(!css.includes(".drawer__sub"), "no orphan rule for the removed sub-row");
  assert.ok(!css.includes(".searchrow"), "no orphan rule for the removed search row");
});
