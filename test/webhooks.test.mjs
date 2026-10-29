// P1 A4 — inbound HTTP webhooks: auth, contracts, routing, mapped templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

const { handleHooksRequest } = await import("../dist/lib.js");

/** Minimal req/res doubles (no sockets). */
function reqRes({ method = "POST", url = "/hooks/wake", headers = {}, body = undefined } = {}) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:18790", ...headers };
  const deliver = () => {
    if (body === undefined) {
      req.emit("end");
    } else {
      const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      req.emit("data", b);
      req.emit("end");
    }
  };
  const resp = {
    status: 0,
    body: "",
    headers: {},
    writeHead(code, h) {
      this.status = code;
      this.headers = h ?? {};
      return this;
    },
    end(d) {
      this.body = d ?? "";
      process.nextTick(deliver);
      // end after body delivered; request emitted earlier — reorder: emit first
    },
  };
  // Emit body BEFORE end() would be called by handleHooksRequest; use async emit.
  setImmediate(deliver);
  return { req, resp };
}

const fakeService = (over = {}) => {
  const sent = [];
  const svc = {
    config: {
      hooks: {
        enabled: true,
        token: "hook-secret-0001",
        path: "/hooks",
        allowRequestSessionKey: false,
        mappings: {},
        ...over.hooks,
      },
    },
    sent,
    async send(payload) {
      sent.push(payload);
    },
    log: { info() {}, warn() {} },
  };
  return svc;
};

const call = async (svc, opts) => {
  const { req, resp } = reqRes(opts);
  const claimed = await handleHooksRequest(svc, req, resp);
  return { claimed, status: resp.status, json: resp.body ? JSON.parse(resp.body) : null, headers: resp.headers };
};

test("unrelated paths are not claimed; wire/health untouched", async () => {
  const svc = fakeService();
  const r = await call(svc, { url: "/api/status" });
  assert.equal(r.claimed, false);
});

test("disabled → 404 with setup guidance", async () => {
  const svc = fakeService({ hooks: { enabled: false } });
  const r = await call(svc, { headers: { "content-type": "application/json" }, body: { text: "hi" } });
  assert.equal(r.claimed, true);
  assert.equal(r.status, 404);
  assert.match(r.json.error, /hooks disabled/);
});

test("enabled but no token → 503 (closed door, loud)", async () => {
  const svc = fakeService({ hooks: { token: "" } });
  const r = await call(svc, { headers: { "content-type": "application/json" }, body: { text: "hi" } });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /hooks\.token/);
});

test("bad bearer, query token, and x-openclaw-token paths", async () => {
  const svc = fakeService();
  const bad = await call(svc, { headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: { text: "hi" } });
  assert.equal(bad.status, 401);
  const query = await call(svc, { url: "/hooks/wake?token=hook-secret-0001", headers: { "content-type": "application/json" }, body: { text: "hi" } });
  assert.equal(query.status, 401, "query-string token never authenticates");
  const xt = await call(svc, { headers: { "content-type": "application/json", "x-openclaw-token": "hook-secret-0001" }, body: { text: "job done" } });
  assert.equal(xt.status, 200);
  const good = await call(svc, { headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { text: "job done" } });
  assert.equal(good.status, 200);
});

test("POST-only contract + JSON content-type + size cap", async () => {
  const svc = fakeService();
  const get = await call(svc, { method: "GET", headers: { authorization: "Bearer hook-secret-0001" } });
  assert.equal(get.status, 405);
  const noCt = await call(svc, { headers: { authorization: "Bearer hook-secret-0001" }, body: { text: "x" } });
  assert.equal(noCt.status, 400);
  assert.match(noCt.json.error, /application\/json/);
  const big = { headers: { authorization: "Bearer hook-secret-0001", "content-type": "application/json" }, body: { text: "x".repeat(200 * 1024) } };
  const over = await call(svc, big);
  assert.equal(over.status, 413);
});

test("wake queues onto the main session as a trusted notification", async () => {
  const svc = fakeService();
  const r = await call(svc, { headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { text: "sample import completed" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.eventOutcome, "queued");
  assert.equal(svc.sent.length, 1);
  assert.equal(svc.sent[0].sessionKey, "main:main");
  assert.match(svc.sent[0].text, /^\[hook wake\] sample import completed$/);
  assert.equal(svc.sent[0].source, "webhook");
  await new Promise((r2) => setTimeout(r2, 20)); // let the floating send finish
});

test("wake: empty text 400; oversize 400; mode next-heartbeat noted", async () => {
  const svc = fakeService();
  const empty = await call(svc, { headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { text: "   " } });
  assert.equal(empty.status, 400);
  const big = await call(svc, { headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { text: "y".repeat(2500) } });
  assert.equal(big.status, 400);
  const nhb = await call(svc, { headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { text: "later", mode: "next-heartbeat" } });
  assert.equal(nhb.status, 200);
  assert.match(nhb.json.note ?? "", /no heartbeat engine/);
});

test("agent: default isolated key; allowed custom key; reserved namespace rejects", async () => {
  const svc = fakeService({ hooks: { allowRequestSessionKey: true } });
  const r = await call(svc, { url: "/hooks/agent", headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { message: "compile report" } });
  assert.equal(r.status, 200);
  assert.match(r.json.sessionKey, /^hook:agent:/);
  assert.equal(svc.sent.at(-1).source, "webhook");
  const custom = await call(svc, { url: "/hooks/agent", headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { message: "go", sessionKey: "hook:email:msg-7" } });
  assert.equal(custom.status, 200);
  assert.equal(custom.json.sessionKey, "hook:email:msg-7");
  const reserved = await call(svc, { url: "/hooks/agent", headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { message: "go", sessionKey: "cron:x" } });
  assert.equal(reserved.status, 400);
  const noAllow = fakeService();
  const denied = await call(noAllow, { url: "/hooks/agent", headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" }, body: { message: "go", sessionKey: "hook:ok" } });
  assert.equal(denied.status, 400);
});

test("mapped hooks: field/json templates fan into wake or agent actions", async () => {
  const svc = fakeService({
    hooks: {
      allowRequestSessionKey: true,
      mappings: {
        deploy: { action: "wake", text: "deploy {{status}} for {{service}}", message: "", sessionKey: "" },
        summarize: { action: "agent", text: "", message: "summarize: {{json}}", sessionKey: "hook:mapped:sum" },
      },
    },
  });
  const deploy = await call(svc, {
    url: "/hooks/deploy",
    headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" },
    body: { status: "green", service: "suparclaw" },
  });
  assert.equal(deploy.status, 200);
  assert.equal(svc.sent.at(-1).text, "[hook deploy] deploy green for suparclaw");
  const sum = await call(svc, {
    url: "/hooks/summarize",
    headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" },
    body: { week: 42 },
  });
  assert.equal(sum.status, 200);
  assert.match(svc.sent.at(-1).text, /^summarize: \{"week":42\}$/);
  assert.equal(svc.sent.at(-1).sessionKey, "hook:mapped:sum");
  const unknown = await call(svc, {
    url: "/hooks/nope",
    headers: { "content-type": "application/json", authorization: "Bearer hook-secret-0001" },
    body: {},
  });
  assert.equal(unknown.status, 404);
  await new Promise((r2) => setTimeout(r2, 20));
});
