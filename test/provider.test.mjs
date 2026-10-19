import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchModels, PRESETS } from "../dist/lib.js";

const serve = (t, handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((r) => server.close(r)));
      resolve(server.address().port);
    });
  });

test("presets cover the common cases and every one has a base url except custom", () => {
  const names = PRESETS.map((p) => p.name);
  for (const want of ["openai", "openrouter", "groq", "ollama", "lmstudio", "custom"]) {
    assert.ok(names.includes(want), `preset ${want} exists`);
  }
  for (const p of PRESETS) {
    if (p.name === "custom") continue;
    assert.match(p.baseUrl, /^https?:\/\//, `${p.name} has a usable base url`);
  }
});

test("fetchModels reads an OpenAI-style model list and sends the key", async (t) => {
  let sawAuth = null;
  const port = await serve(t, (req, res) => {
    sawAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { object: "skip-me" }] }));
  });

  const res = await fetchModels(`http://127.0.0.1:${port}/v1/`, "sk-test");
  assert.deepEqual(res.models, ["a", "b"], "entries without an id are dropped");
  assert.equal(res.error, undefined);
  assert.equal(sawAuth, "Bearer sk-test", "the key is sent as a bearer token");

  // trailing slashes are normalised so /v1/ does not become /v1//models
  const noKey = await fetchModels(`http://127.0.0.1:${port}/v1///`, "");
  assert.deepEqual(noKey.models, ["a", "b"]);
});

test("fetchModels reports HTTP failures instead of throwing", async (t) => {
  const port = await serve(t, (req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"bad key"}');
  });
  const res = await fetchModels(`http://127.0.0.1:${port}/v1`, "wrong");
  assert.deepEqual(res.models, []);
  assert.match(res.error ?? "", /401/);
});

test("fetchModels survives an unreachable provider", async () => {
  // Bind and immediately release a port so nothing is listening on it.
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });

  const res = await fetchModels(`http://127.0.0.1:${port}/v1`, "x");
  assert.deepEqual(res.models, []);
  assert.ok(res.error, "an error is reported for a dead endpoint");
});
