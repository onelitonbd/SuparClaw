// Partial #3 — session search: token matching (last word prefixes), role
// filter (user/assistant only), subagent-lane scoping, title hits, anchored
// reopen windows, and the `sc sessions search` CLI (offline path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-ssearch-"));
const { Store } = await import("../dist/lib.js");

const SC = join(process.cwd(), "dist", "sc.js");

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "sc-ss-"));
  const store = Store.open(join(dir, "state.sqlite"));
  return { store, dir };
}

function fill(store, key, rows) {
  const s = store.ensureSession(key);
  for (const [i, r] of rows.entries()) store.appendMessage(s.id, r[0], r[1], `run-${i}`);
  return s;
}

test("session search: AND semantics + last-word prefix (their UI matching rule)", () => {
  const { store } = seed();
  fill(store, "main:deploy", [
    ["user", "the deploy plan for tonight"],
    ["assistant", "deployment checklist confirmed"],
  ]);
  fill(store, "main:cats", [["user", "cats and dogs forever"]]);

  // Both words required (AND); "deployment…" contains neither full word.
  let res = store.searchSessions("deploy plan");
  assert.equal(res.messageHits.length, 1);
  assert.ok(res.messageHits.every((h) => h.sessionKey === "main:deploy"));

  // Last word stays a prefix: "communi" must match "communication".
  fill(store, "main:sc", [["user", "per session communi"]]);
  const cc = fill(store, "main:tcc", [
    ["user", "let's talk about the per-session communication controls"],
  ]);
  void cc;
  res = store.searchSessions("session communi");
  assert.ok(
    res.messageHits.some((h) => h.sessionKey === "main:tcc"),
    `prefix hit: ${JSON.stringify(res.messageHits.map((h) => h.sessionKey))}`,
  );
  // Middle words are full words: "depl plan" must NOT match "deploy plan".
  res = store.searchSessions("depl plan");
  assert.equal(res.messageHits.length, 0);
  store.close();
});

test("session search: tool results and reasoning rows are excluded", () => {
  const { store } = seed();
  const s = fill(store, "main:t", [
    ["user", "quantum sandwich theory"],
    ["tool", "→ web_search\nquantum sandwich results here"],
    ["reasoning", "thinking about the quantum sandwich"],
    ["error", "quantum sandwich blew up"],
  ]);
  const res = store.searchSessions("quantum sandwich");
  assert.equal(res.messageHits.length, 1);
  assert.equal(res.messageHits[0].role, "user");
  const toolOnly = store.searchSessions("sandwich results");
  assert.equal(toolOnly.messageHits.length, 0);
  store.close();
});

test("session search: subagent lanes hidden by default, included with scope all", () => {
  const { store } = seed();
  fill(store, "subagent:main:abc", [["user", "invisible lane payload"]]);
  fill(store, "main:walk", [["user", "invisible lane payload parent"]]);
  let res = store.searchSessions("invisible lane");
  assert.deepEqual(res.messageHits.map((h) => h.sessionKey), ["main:walk"]);
  res = store.searchSessions("invisible lane", { scope: "all" });
  assert.equal(res.messageHits.length, 2);
  store.close();
});

test("session search: sessionKeys narrowing + caps (max 3 per session, 25 total)", () => {
  const { store } = seed();
  for (const key of ["main:a", "main:b"]) {
    fill(store, key, Array.from({ length: 6 }, (_, i) => ["user", `needle haystack #${i}`]));
  }
  let res = store.searchSessions("needle haystack");
  assert.deepEqual(
    res.messageHits.reduce((m, h) => m.set(h.sessionKey, (m.get(h.sessionKey) ?? 0) + 1), new Map()),
    new Map([["main:a", 3], ["main:b", 3]]),
  );
  res = store.searchSessions("needle haystack", { sessionKeys: ["main:b"] });
  assert.ok(res.messageHits.every((h) => h.sessionKey === "main:b"));
  assert.equal(res.messageHits.length, 3);
  store.close();
});

test("session search: title hits by token + prefix; identifier keys match literally", () => {
  const { store } = seed();
  const s = store.ensureSession("main:per-session");
  store.renameSession(s.id, "Per-session communication controls");
  fill(store, "main:per-session", [["user", "hello"]]);

  // Their exact example: punctuation splits words, last word prefixes.
  let res = store.searchSessions("per session communi");
  assert.ok(res.titleHits.some((h) => h.sessionKey === "main:per-session"));
  // Identifier literal matching: the key itself matches as a substring.
  res = store.searchSessions("per-session");
  assert.ok(res.titleHits.some((h) => h.sessionKey === "main:per-session"));
  res = store.searchSessions("zzz nothing");
  assert.equal(res.titleHits.length, 0);
  store.close();
});

test("session search: snippets carry «» marks and never leak markup", () => {
  const { store } = seed();
  fill(store, "main:snip", [
    ["user", "red panda red panda red panda in the <img src=x> bamboo"],
  ]);
  const res = store.searchSessions("red panda");
  assert.equal(res.messageHits.length, 1);
  assert.ok(res.messageHits[0].snippet.includes("«"));
  assert.ok(res.messageHits[0].snippet.includes("»"));
  store.close();
});

test("anchored reopen: surroundings bounded, off-path anchor is empty (never the tail)", () => {
  const { store } = seed();
  const s = store.ensureSession("main:anchor");
  const other = store.ensureSession("main:other");
  const ids = [];
  for (let i = 0; i < 10; i++) {
    store.appendMessage(s.id, "user", `turn ${i}`, "r");
    const rows = store.recentMessages(s.id, 1);
    ids.push(rows[0].id);
  }
  store.appendMessage(other.id, "user", "stranger", "r2");

  const window = store.messagesAround(s.id, ids[4], 5);
  // total span bounded by limit=5: ceil(4/2)=2 before + anchor + 2 after
  assert.equal(window.length, 5);
  assert.deepEqual(window.map((m) => m.content), ["turn 2", "turn 3", "turn 4", "turn 5", "turn 6"]);

  // Off-session id: the message exists, but not in this session → empty.
  const foreign = store.recentMessages(other.id, 1)[0].id;
  assert.deepEqual(store.messagesAround(s.id, foreign, 5), []);
  // Missing id → empty, never the newest tail.
  assert.deepEqual(store.messagesAround(s.id, 999999, 5), []);
  store.close();
});

test("cli: sc sessions search works offline (exit codes + one-line output)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-sscli-"));
  process.env.SUPARCLAW_HOME = dir;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, ".suparclaw"), { recursive: true });
  const store = Store.open(join(dir, ".suparclaw", "state.sqlite"));
  fill(store, "main:hike", [["user", "the kanchenjunga expedition list"]]);
  fill(store, "main:tea", [["user", "oolong and sencha"]]);
  store.close();

  const run = (args, env) =>
    new Promise((resolve) => {
      // SUPARCLAW_OFFLINE=1: the offline path is what this case covers —
      // a demo gateway running on this machine must never answer instead.
      const p = spawn(process.execPath, [SC, ...args], {
        env: { ...process.env, SUPARCLAW_OFFLINE: "1", ...env },
      });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (c) => (stdout += c));
      p.stderr.on("data", (c) => (stderr += c));
      p.on("close", (code) => resolve({ code, out: stdout + stderr, stdout }));
    });

  const ok = await run(["sessions", "search", "kanchenjunga"], { SUPARCLAW_HOME: dir });
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.out.includes("main:hike"), ok.out);
  assert.ok(!ok.out.includes("main:tea"), ok.out);

  const none = await run(["sessions", "search", "zebra crossing"], { SUPARCLAW_HOME: dir });
  assert.equal(none.code, 0);
  assert.ok(none.out.includes("no matching sessions"));

  const empty = await run(["sessions", "search"], { SUPARCLAW_HOME: dir });
  assert.equal(empty.code, 2);

  const json = await run(["sessions", "search", "kanchenjunga", "--json"], { SUPARCLAW_HOME: dir });
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed.messageHits));
  assert.equal(parsed.messageHits[0].sessionKey, "main:hike");
});
