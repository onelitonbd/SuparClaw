// P2 #8 — ask_user rules.
import { test } from "node:test";
import assert from "node:assert/strict";

const { normalizeAskUserArgs, matchTextReply, renderQuestionText } = await import("../dist/lib.js");

const Q = (over = {}) => ({ id: "q1", question: "Which env?", options: ["staging", "production"], multi: false, ...over });

test("normalize accepts 1–3 questions with 2–4 options; ids auto-fill", () => {
  const { questions, error } = normalizeAskUserArgs({ questions: [{ question: "Which?", options: ["a", "b"] }] });
  assert.equal(error, undefined);
  assert.deepEqual(questions, [{ id: "q1", question: "Which?", options: ["a", "b"], multi: false }]);
  const three = normalizeAskUserArgs({ questions: [1, 2, 3].map((i) => ({ question: `q${i}?`, options: ["x", "y", "z", "w"] })) });
  assert.equal(three.questions.length, 3);
});

test("normalize rejects their constraint violations", () => {
  assert.match(normalizeAskUserArgs({ questions: [] }).error ?? "", /non-empty/);
  assert.match(normalizeAskUserArgs({}).error ?? "", /non-empty/);
  assert.match(normalizeAskUserArgs({ questions: [1, 2, 3, 4].map((i) => ({ question: `q${i}`, options: ["a", "b"] })) }).error ?? "", /at most 3/);
  assert.match(normalizeAskUserArgs({ questions: [{ question: "q", options: ["only"] }] }).error ?? "", /2–4 options/);
  assert.match(normalizeAskUserArgs({ questions: [{ question: "q", options: ["a", "b", "c", "d", "e"] }] }).error ?? "", /2–4 options/);
  assert.match(normalizeAskUserArgs({ questions: [{ question: "q", options: ["a", "b"], id: "dup" }, { question: "q2", options: ["a", "b"], id: "dup" }] }).error ?? "", /unique/);
});

test("text replies: number for single-select, N,M only when multi", () => {
  const q = Q();
  assert.deepEqual(matchTextReply(q, "2"), { kind: "answer", value: ["production"] });
  assert.equal(matchTextReply(q, "1,2"), null, "multi pick on a single question is no answer");
  const multi = Q({ id: "qm", multi: true, options: ["red", "green", "blue"] });
  assert.deepEqual(matchTextReply(multi, "1,3"), { kind: "answer", value: ["red", "blue"] });
  assert.equal(matchTextReply(multi, "9"), null);
});

test("text replies: labels exact or unambiguous-prefix, skip everywhere", () => {
  const q = Q({ options: ["staging", "production"] });
  assert.deepEqual(matchTextReply(q, "production"), { kind: "answer", value: ["production"] });
  assert.deepEqual(matchTextReply(q, "prod"), { kind: "answer", value: ["production"] });
  assert.deepEqual(matchTextReply(q, "skip"), { kind: "skip" });
  assert.deepEqual(matchTextReply(q, "StAgInG"), { kind: "answer", value: ["staging"] }, "labels are case-insensitive");
});

test("Other forms: explicit marker becomes the custom answer", () => {
  const q = Q();
  assert.deepEqual(matchTextReply(q, "other: on-premise"), { kind: "answer", value: ["on-premise"], custom: true });
  assert.deepEqual(matchTextReply(q, "other"), { kind: "answer", value: [], custom: true }, "bare 'other' waits for the next text");
});

test("strict interception: ordinary chatter is NOT an answer", () => {
  const q = Q();
  assert.equal(matchTextReply(q, "hello there how is it going"), null, "free chat falls through to the pipeline");
  assert.equal(matchTextReply(q, "maybe we should do both"), null);
  assert.equal(matchTextReply(q, ""), null);
});

test("multi label-list answers resolve; a bogus part degrades the whole thing to custom", () => {
  const multi = Q({ multi: true, options: ["api", "web", "cli"] });
  assert.deepEqual(matchTextReply(multi, "api, cli"), { kind: "answer", value: ["api", "cli"] });
  const bad = matchTextReply(multi, "api, rocketship");
  assert.equal(bad.kind, "answer");
  assert.deepEqual(bad.value, ["api, rocketship"]);
  assert.equal(bad.custom, true);
});

test("renderQuestionText: numbered options + Other + Skip + multi hint", () => {
  const txt = renderQuestionText(Q({ multi: true }), 1, 1);
  assert.match(txt, /1 — staging/);
  assert.match(txt, /Other — reply with your own words/);
  assert.match(txt, /Skip — reply "skip" to leave this unanswered/);
  assert.match(txt, /pick multiple/);
});
