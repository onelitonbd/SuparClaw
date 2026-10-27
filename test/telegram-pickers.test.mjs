// Task 54b — the Telegram pickers: sessions, thinking effort, and the coding
// flow (account → repositories → branches).
//
// Everything asserted here is *rendered output*: the operator asked for buttons,
// ten a page, with the AI title on the session row. A card that says the right
// thing in a comment and the wrong thing on the phone is the failure this file
// exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";

const lib = await import("../dist/lib.js");
const {
  PICKER_PAGE,
  accountCard,
  branchCard,
  clampPage,
  isSessionOfChat,
  newSessionCard,
  pageCount,
  readAccountTap,
  readBranchTap,
  readRepoTap,
  readSessionTap,
  readThinkingTap,
  relativeAge,
  repoCard,
  resolveActiveSession,
  sessionTitle,
  sessionsCard,
  shortHash,
  slicePage,
  switchedCard,
  thinkingCard,
  thinkingSetCard,
  unconfiguredGithubCard,
} = lib;

const labels = (card) => (card.keyboard ?? []).flat().map((b) => b.text);
const datas = (card) => (card.keyboard ?? []).flat().map((b) => b.callback_data);

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ago = (ms) => NOW - ms;

function session(key, name, msAgo, kind = "chat") {
  return { key, name, last_msg_at: ago(msAgo), kind };
}

// ── paging ─────────────────────────────────────────────────────────────────

test("ten a page, and a page number that cannot point past the end", () => {
  assert.equal(PICKER_PAGE, 10, "the operator's number: ten rows a page");
  assert.equal(pageCount(0), 1, "an empty list still has a page");
  assert.equal(pageCount(1), 1);
  assert.equal(pageCount(10), 1);
  assert.equal(pageCount(11), 2);
  assert.equal(pageCount(34), 4);

  const items = Array.from({ length: 34 }, (_, i) => i);
  assert.deepEqual(slicePage(items, 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(slicePage(items, 3), [30, 31, 32, 33]);
  assert.equal(clampPage(99, 34), 3, "a stale Next › cannot render an empty page");
  assert.equal(clampPage(-5, 34), 0);
  assert.equal(clampPage(Number.NaN, 34), 0);
});

test("a session row says how long ago, in words a phone can read", () => {
  assert.equal(relativeAge(NOW, ago(5_000)), "just now");
  assert.equal(relativeAge(NOW, ago(12 * 60_000)), "12m ago");
  assert.equal(relativeAge(NOW, ago(3 * 3_600_000)), "3h ago");
  assert.equal(relativeAge(NOW, ago(2 * 86_400_000)), "2d ago");
  assert.equal(relativeAge(NOW, ago(70 * 86_400_000)), "2mo ago");
  assert.equal(relativeAge(NOW, 0), "just now", "a session with no timestamp is not '56 years ago'");
});

// ── session identity ───────────────────────────────────────────────────────

test("a chat owns its base session and every rotated one, and nothing else", () => {
  assert.ok(isSessionOfChat("telegram:123", 123));
  assert.ok(isSessionOfChat("telegram:123:m3x9", 123));
  assert.ok(!isSessionOfChat("telegram:1234", 123), "a prefix is not a match");
  assert.ok(!isSessionOfChat("telegram:1234:m3x9", 123));
  assert.ok(!isSessionOfChat("web:main", 123));
  assert.ok(isSessionOfChat("telegram:-100123", -100123), "groups are negative ids");
});

test("the pointer is honoured only while it names this chat's live session", () => {
  const exists = (key) => key === "telegram:7:old";
  assert.equal(
    resolveActiveSession(7, { active: "telegram:7:old", tag: "new", exists }),
    "telegram:7:old",
    "an explicit switch wins over the rotation tag",
  );
  assert.equal(
    resolveActiveSession(7, { active: "telegram:7:gone", tag: "new", exists }),
    "telegram:7:new",
    "a pruned session falls back instead of taking the chat's messages with it",
  );
  assert.equal(
    resolveActiveSession(7, { active: "telegram:8:other", tag: null, exists: () => true }),
    "telegram:7",
    "a pointer into somebody else's chat is ignored",
  );
  assert.equal(resolveActiveSession(7, { active: "", tag: "new", exists }), "telegram:7:new");
  assert.equal(resolveActiveSession(7, { active: null, tag: null, exists }), "telegram:7");
});

test("the row shows the AI title, and never a bare id when there is none", () => {
  assert.equal(sessionTitle({ key: "telegram:1", name: "Deploy script" }), "Deploy script");
  assert.equal(sessionTitle({ key: "telegram:1:m3x9", name: "  " }), "Chat m3x9");
  assert.equal(sessionTitle({ key: "telegram:1", name: null }), "Main chat");
});

// ── /sessions ──────────────────────────────────────────────────────────────

test("the sessions card marks the current one, shows titles, and pages by ten", () => {
  const sessions = Array.from({ length: 23 }, (_, i) => session(`telegram:5:s${i}`, `Conversation ${i}`, (i + 1) * 3_600_000, i % 2 ? "code" : "chat"));
  const card = sessionsCard({ sessions, active: "telegram:5:s2", page: 0, now: NOW });

  assert.match(card.text, /^Sessions — page 1\/3 · 23 in this chat/);
  assert.equal(datas(card).filter((d) => /^s:\d+:\d+:/.test(d)).length, 10, "ten rows, ten buttons");
  assert.ok(labels(card).some((t) => t.startsWith("✓ Conversation 2")), "the session the chat is in is marked");
  assert.equal(labels(card).filter((t) => t.startsWith("✓")).length, 1, "and only that one");
  assert.ok(labels(card).some((t) => t.startsWith("⌘ ")), "a code session is marked so the two are not confused");
  assert.ok(labels(card).includes("Next ›"), "more than a page has a way forward");
  assert.ok(!labels(card).includes("‹ Prev"), "page one has nothing behind it");
  assert.ok(labels(card).includes("＋ New session"));

  const last = sessionsCard({ sessions, active: "telegram:5:s2", page: 2, now: NOW });
  assert.match(last.text, /page 3\/3 · 23/);
  assert.equal(datas(last).filter((d) => /^s:\d+:\d+:/.test(d)).length, 3, "23 = 10 + 10 + 3");
  assert.ok(labels(last).includes("‹ Prev"));
  assert.ok(!labels(last).includes("Next ›"), "the last page does not offer a page that does not exist");
});

test("a session tap carries a hash of the key, so a moved list cannot switch you elsewhere", () => {
  const sessions = [session("telegram:5:a", "Alpha", 1000), session("telegram:5:b", "Beta", 2000)];
  const card = sessionsCard({ sessions, active: "telegram:5:a", page: 0, now: NOW });
  const tap = readSessionTap(datas(card).find((d) => d.startsWith("s:0:1:")));
  assert.deepEqual(tap, { kind: "pick", page: 0, slot: 1, hash: shortHash("telegram:5:b") });

  // The list moved: slot 1 is now somebody else. The hash is what refuses it.
  assert.notEqual(shortHash("telegram:5:c"), tap.hash);
  assert.equal(readSessionTap("s:p:2").kind, "page");
  assert.equal(readSessionTap("s:n").kind, "new");
  assert.equal(readSessionTap("s:junk"), null);
  assert.equal(readSessionTap("x:0:0:abc"), null, "another namespace is not a session tap");
});

test("an empty chat gets a way to start, not an error", () => {
  const card = sessionsCard({ sessions: [], active: "telegram:5", page: 0, now: NOW });
  assert.match(card.text, /No sessions yet/);
  assert.deepEqual(datas(card), ["s:n"]);
});

test("the switched card says where you are and what will answer", () => {
  const card = switchedCard({ title: "Deploy script", key: "telegram:5:a", model: "GPT-5.1 (this session)", thinking: "high" });
  assert.match(card.text, /Switched to Deploy script/);
  assert.match(card.text, /telegram:5:a/);
  assert.match(card.text, /GPT-5\.1 \(this session\)/, "the model of the session you entered, not the old one");
  assert.match(card.text, /thinking: high/);
  assert.deepEqual(datas(card), ["s:p:0"], "and a way back to the list");
});

// ── /think ─────────────────────────────────────────────────────────────────

test("every thinking level is a button, and the current one is marked", () => {
  const card = thinkingCard({ current: "high", fallback: "medium" });
  assert.match(card.text, /Thinking effort — this chat: high/);
  const levelButtons = labels(card).filter((t) => !t.startsWith("✅"));
  assert.deepEqual(levelButtons, ["Default (medium)", "Off", "Low", "Medium", "✓ High", "XHigh", "Max"]);
  assert.deepEqual(datas(card), ["t:d", "t:off", "t:low", "t:medium", "t:high", "t:xhigh", "t:max"]);

  const inherit = thinkingCard({ current: null, fallback: "medium" });
  assert.ok(labels(inherit).includes("✓ Default (medium)"));
  assert.ok(!labels(inherit).some((t) => t.startsWith("✓ Off")), "exactly one row is current");

  const group = thinkingCard({ current: "low", fallback: "medium", group: true });
  assert.match(group.text, /this group: low/, "a group's card says the group, because the whole group shares it");
});

test("a thinking tap maps to the column the text form writes", () => {
  assert.deepEqual(readThinkingTap("t:high"), { kind: "set", level: "high" });
  assert.deepEqual(readThinkingTap("t:xhigh"), { kind: "set", level: "xhigh" });
  assert.deepEqual(readThinkingTap("t:d"), { kind: "set", level: null }, "default = clear the override");
  assert.deepEqual(readThinkingTap("t:o"), { kind: "open", level: null });
  assert.equal(readThinkingTap("t:ludicrous"), null, "an unknown level is not silently stored");
  assert.equal(readThinkingTap("t:inherit"), null, "the card never offers a level the command would reject");
  assert.match(thinkingSetCard({ level: null, fallback: "medium" }).text, /Thinking: default \(medium\)/);
  assert.deepEqual(datas(thinkingSetCard({ level: "max", fallback: "medium" })), ["t:o"]);
});

// ── coding: account → repo → branch ────────────────────────────────────────

test("the coding flow starts by naming the account it will clone with", () => {
  const card = accountCard({ accounts: [{ source: "gh", login: "onelitonbd", label: "gh CLI" }] });
  assert.match(card.text, /which GitHub account\?/);
  assert.deepEqual(labels(card), ["@onelitonbd · gh CLI"]);
  assert.deepEqual(datas(card), [`a:0:${shortHash("gh")}`], "the hash is the source, so a shifted list cannot bind with another login");

  const none = accountCard({ accounts: [] });
  assert.equal(none.keyboard, null, "nothing to choose: no dead buttons");
  assert.match(none.text, /sc github adopt-gh/);
  assert.match(unconfiguredGithubCard("boom").text, /boom/);
});

test("repositories are ten a page, private ones marked, with a way back to accounts", () => {
  const repos = Array.from({ length: 34 }, (_, i) => ({ fullName: `onelitonbd/repo-${i}`, private: i % 3 === 0 }));
  const account = { source: "token", login: "onelitonbd", label: "this device" };
  const card = repoCard({ repos, account, page: 0, total: 34, done: true });
  assert.match(card.text, /^Repositories — page 1\/4 · 34 · @onelitonbd/, "34 repos at ten a page is four pages, all of them known");
  assert.equal(datas(card).filter((d) => /^r:0:\d+$/.test(d)).length, 10);
  assert.ok(labels(card).some((t) => t.startsWith("🔒 ")), "a private repo is marked");
  assert.ok(labels(card).includes("‹ Accounts"));
  assert.ok(labels(card).includes("Next ›"));
  assert.ok(datas(card).includes("r:0:9"), "page one ends at slot 9");
  assert.ok(!datas(card).includes("r:0:10"), "and never shows slot 10 twice");

  const second = repoCard({ repos, account, page: 1, total: 34, done: true });
  assert.ok(datas(second).includes("r:1:10"), "page two starts at slot 10");
  assert.ok(labels(second).includes("‹ Prev"));

  const partial = repoCard({ repos: repos.slice(0, 20), account, page: 0, total: 20, done: false });
  assert.match(partial.text, /page 1 · 20\+/, "an unfinished list admits it does not know the count");
  assert.ok(labels(partial).includes("Next ›"), "and still offers the next page");
});

test("an empty or filtered repository list is an answer, not a blank card", () => {
  const account = { source: "gh", login: "onelitonbd", label: "gh CLI" };
  const empty = repoCard({ repos: [], account, page: 0, total: 0, done: true });
  assert.match(empty.text, /No repositories on this account · @onelitonbd/);
  assert.deepEqual(datas(empty), ["r:a"], "the only useful button is the way back");
  assert.match(repoCard({ repos: [], account, page: 0, total: 0, done: true, filter: "zzz" }).text, /No repositories match “zzz”/);
});

test("branches page the same way, default first, and never lose the way back", () => {
  const branches = Array.from({ length: 14 }, (_, i) => ({ name: i === 0 ? "main" : `feat/${i}`, default: i === 0 }));
  const card = branchCard({ repo: "onelitonbd/app", branches, page: 0, total: 14, done: true, base: "main" });
  assert.match(card.text, /^⌘ onelitonbd\/app — which branch\?/);
  assert.equal(datas(card).filter((d) => /^b:0:\d+$/.test(d)).length, 10);
  assert.ok(labels(card).some((t) => t.startsWith("main · default")), "the default branch says so");
  assert.ok(labels(card).includes("‹ Repos"));
  const last = branchCard({ repo: "onelitonbd/app", branches, page: 1, total: 14, done: true, base: "main" });
  assert.equal(datas(last).filter((d) => /^b:1:\d+$/.test(d)).length, 4, "14 = 10 + 4");
  assert.ok(!labels(last).includes("Next ›"));
  assert.equal(branchCard({ repo: "onelitonbd/app", branches: [], page: 0, total: 0, done: true }).keyboard[0][0].text, "‹ Repos");
});

test("the repo and branch taps parse, and the old shapes are not silently accepted", () => {
  assert.deepEqual(readRepoTap("r:0:7"), { kind: "slot", page: 0, slot: 7 });
  assert.deepEqual(readRepoTap("r:p:2"), { kind: "page", page: 2, slot: -1 });
  assert.deepEqual(readRepoTap("r:a"), { kind: "accounts", page: 0, slot: -1 });
  assert.equal(readRepoTap("r:0:-1"), null);
  assert.equal(readRepoTap("r:x:y"), null);

  assert.deepEqual(readBranchTap("b:1:3"), { kind: "slot", page: 1, slot: 3 });
  assert.deepEqual(readBranchTap("b:p:0"), { kind: "page", page: 0, slot: -1 });
  assert.deepEqual(readBranchTap("b:r"), { kind: "repos", page: 0, slot: -1 });
  assert.equal(readBranchTap("b:3"), null, "the Task 36 shape (b:<index>) is gone, not half-supported");

  assert.equal(readAccountTap("a:0"), 0);
  assert.equal(readAccountTap("a:x"), null);
});

test("every rendered callback fits Telegram's 64 bytes", () => {
  const cards = [
    sessionsCard({ sessions: Array.from({ length: 40 }, (_, i) => session(`telegram:-100${i}:tag${i}`, `T${i}`, i * 1000)), active: "", page: 2, now: NOW }),
    thinkingCard({ current: "xhigh", fallback: "medium" }),
    accountCard({ accounts: [
      { source: "env", login: "a-very-long-login-name-that-still-fits", label: "GITHUB_TOKEN" },
      { source: "gh", login: "onelitonbd", label: "gh CLI" },
    ] }),
    repoCard({ repos: [{ fullName: "an-org/with-a-really-long-repository-name-that-goes-on", private: true }], account: null, page: 0, total: 1, done: true }),
    branchCard({ repo: "o/r", branches: [{ name: "feature/a-really-long-branch-name" }], page: 0, total: 1, done: true }),
    newSessionCard({ key: "telegram:1", previous: "telegram:1" }),
  ];
  for (const card of cards) {
    for (const d of datas(card)) {
      assert.ok(Buffer.byteLength(d, "utf8") <= 64, `callback ${d} is ${Buffer.byteLength(d, "utf8")} bytes`);
    }
    for (const t of labels(card)) assert.ok(t.length <= 64, `label ${t} is ${t.length} chars`);
  }
});
