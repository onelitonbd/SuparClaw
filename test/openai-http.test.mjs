// P1 A6 — OpenAI-compatible HTTP endpoint: flag, auth, contracts, session pinning, SSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

const { handleOpenAiRequest } = await import("../dist/lib.js");

function reqRes({ method = "POST", url = "/v1/chat/completions", headers = {}, body = undefined } = {}) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:18790", ...headers };
  const resp = {
    status: 0,
    body: "",
    headers: {},
    writeHead(code, h) {
      this.status = code;
      this.headers = h ?? {};
      return this;
    },
    write(d) {
      this.body += typeof d === "string" ? d : d.toString("utf8");
      return true;
    },
    end(d) {
      if (d) this.body += typeof d === "string" ? d : d.toString("utf8");
    },
  };
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  });
  return { req, resp };
}

const TOKEN = "gw-token-0001";
const fakeService = (over = {}) => {
  const sent = [];
  const svc = {
    config: {
      gateway: { auth: { token: TOKEN }, http: { endpoints: { chatCompletions: { enabled: true } } } },
      ...over,
    },
    sent,
    async send(payload) {
      sent.push(payload);
      for (const d of over.deltas ?? []) await payload.onDelta?.(d);
      await payload.onFinal?.("the answer", { input: 7, output: 3 });
      await payload.reply("the answer");
    },
    log: { info() {}, warn() {} },
  };
  return svc;
};

const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const call = async (svc, opts) => {
  const { req, resp } = reqRes(opts);
  const claimed = await handleOpenAiRequest(svc, req, resp);
  const out = { claimed, status: resp.status, raw: resp.body, headers: resp.headers };
  out.json = out.raw && resp.headers["content-type"]?.includes("json") ? JSON.parse(out.raw) : null;
  return out;
};

test("non-/v1 paths are not claimed", async () => {
  const r = await call(fakeService(), { url: "/api/status" });
  assert.equal(r.claimed, false);
});

test("disabled → 404 with enable guidance; enabled w/o gateway token → 503", async () => {
  const off = await call(fakeService({ gateway: { auth: { token: TOKEN }, http: { endpoints: { chatCompletions: { enabled: false } } } } }));
  assert.equal(off.status, 404);
  assert.match(off.json.error.message, /chatCompletions\.enabled/);
  const noTok = await call(fakeService({ gateway: { auth: { token: "" }, http: { endpoints: { chatCompletions: { enabled: true } } } } }));
  assert.equal(noTok.status, 503);
  assert.match(noTok.json.error.message, /gateway\.auth\.token/);
});

test("auth: bad bearer 401 (OpenAI error shape); good bearer passes", async () => {
  const bad = await call(fakeService(), { headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: {} });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.type, "authentication_error");
  const ok = await call(fakeService(), { method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
});

test("GET /v1/models + /v1/models/<id> list agent targets, not provider models", async () => {
  const svc = fakeService();
  const list = await call(svc, { method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.map((m) => m.id), ["openclaw", "openclaw/default"]);
  const detail = await call(svc, { method: "GET", url: "/v1/models/openclaw%2Fdefault", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.id, "openclaw/default");
  const missing = await call(svc, { method: "GET", url: "/v1/models/gpt-4o", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(missing.status, 404);
  const post = await call(svc, { method: "POST", url: "/v1/models", headers: AUTH });
  assert.equal(post.status, 405);
});

test("/v1/embeddings and /v1/responses answer 501 (deliberately out)", async () => {
  for (const p of ["/v1/embeddings", "/v1/responses"]) {
    const r = await call(fakeService(), { url: p, headers: AUTH, body: {} });
    assert.equal(r.status, 501, p);
  }
});

test("chat completion: last user text runs, full chat.completion JSON w/ usage", async () => {
  const svc = fakeService();
  const r = await call(svc, {
    headers: AUTH,
    body: { model: "openclaw", messages: [{ role: "system", content: "s" }, { role: "user", content: "hello agent" }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.object, "chat.completion");
  assert.match(r.json.id, /^chatcmpl-openclaw-/);
  assert.equal(r.json.choices[0].message.content, "the answer");
  assert.equal(r.json.choices[0].finish_reason, "stop");
  assert.deepEqual(r.json.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.equal(svc.sent.length, 1);
  assert.equal(svc.sent[0].text, "hello agent");
  assert.match(svc.sent[0].sessionKey, /^http:openai-/); // stateless per request
});

test("session pinning: user → stable hashed key; header key honored; reserved ns rejected", async () => {
  const svc = fakeService();
  const a = await call(svc, { headers: AUTH, body: { messages: [{ role: "user", content: "x" }], user: "alice@corp" } });
  const b = await call(svc, { headers: AUTH, body: { messages: [{ role: "user", content: "y" }], user: "alice@corp" } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(svc.sent[0].sessionKey, svc.sent[1].sessionKey, "same user ⇒ same session");
  assert.match(svc.sent[0].sessionKey, /^http:openai:[0-9a-f]{16}$/);
  const hdr = await call(svc, { headers: { ...AUTH, "x-openclaw-session-key": "ops:live-debug" }, body: { messages: [{ role: "user", content: "z" }] } });
  assert.equal(hdr.status, 200);
  assert.equal(svc.sent[2].sessionKey, "ops:live-debug");
  const reserved = await call(svc, { headers: { ...AUTH, "x-openclaw-session-key": "cron:daily" }, body: { messages: [{ role: "user", content: "z" }] } });
  assert.equal(reserved.status, 400);
  assert.match(reserved.json.error.message, /reserved namespace/);
});

test("validation: no user message → 400; unknown model → 400; wrong agent id → 400", async () => {
  const svc = fakeService();
  const noUser = await call(svc, { headers: AUTH, body: { messages: [{ role: "assistant", content: "a" }] } });
  assert.equal(noUser.status, 400);
  const badModel = await call(svc, { headers: AUTH, body: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] } });
  assert.equal(badModel.status, 400);
  assert.match(badModel.json.error.message, /\/v1\/models/);
  const badAgent = await call(svc, { headers: AUTH, body: { model: "openclaw/ghost", messages: [{ role: "user", content: "hi" }] } });
  assert.equal(badAgent.status, 400);
  assert.match(badAgent.json.error.message, /single agent/);
});

test("stream: true → SSE chat.completion.chunk deltas terminating in [DONE]", async () => {
  const svc = fakeService({ deltas: ["ans", "wer"] });
  const r = await call(svc, { headers: AUTH, body: { stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/event-stream/);
  assert.match(r.raw, /"object":"chat.completion.chunk"/);
  assert.match(r.raw, /"delta":\{"content":"ans"\}/);
  assert.match(r.raw, /"finish_reason":"stop"/);
  assert.ok(r.raw.trim().endsWith("data: [DONE]"));
});
