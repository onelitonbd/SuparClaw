// The blocked-carrier fix proper: Node-core proxied fetch (CONNECT + TLS +
// HTTP/1.1 + SOCKS5) — because Node's built-in fetch REJECTS dispatchers
// from a different undici instance (UND_ERR_INVALID_ARG), so the npm
// ProxyAgent route was dead on arrival.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as netServer, connect as netConnect } from "node:net";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";

/** listen(0) + await, then read the port — never probe-and-close (the freed
 *  port can be instantly reused by the NEXT probe, leaving a server stuck
 *  at EADDRINUSE and once(srv,"listening") hanging forever). */
async function listen0(srv) {
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  return srv.address().port;
}

/** CONNECT proxy that logs its requests and tunnels to 127.0.0.1:<same port>. */
async function spawnProxy(log) {
  const srv = netServer((c) => {
    let buf = Buffer.alloc(0);
    let tunneled = false;
    c.on("data", (d) => {
      if (tunneled) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = buf.subarray(0, i).toString("latin1");
      const m = /^CONNECT ([\w.-]+):(\d+) HTTP\/1\.1\r\n/i.exec(head);
      log.push(head);
      if (!m) { c.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      const out = netConnect({ host: "127.0.0.1", port: Number(m[2]) });
      out.on("connect", () => {
        c.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        tunneled = true;
        c.pipe(out);
        out.pipe(c);
      });
      out.on("error", () => c.destroy());
    });
    c.on("error", () => {});
  });
  const port = await listen0(srv);
  return { port, srv };
}

test("proxied fetch: CONNECT tunnel → HTTP round trip (content-length)", async () => {
  const { makeProxiedFetch } = await import("../dist/lib.js");
  const origin = httpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { username: "e2e_bot", method: req.method } }));
  });
  const originPort = await listen0(origin);
  const log = [];
  const { port, srv } = await spawnProxy(log);
  const f = makeProxiedFetch(`http://127.0.0.1:${port}`);
  const res = await f(`http://127.0.0.1:${originPort}/bot123:tok/getMe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.result.username, "e2e_bot");
  assert.equal(j.result.method, "POST");
  assert.match(log[0] ?? "", new RegExp(`^CONNECT 127\\.0\\.0\\.1\\:${originPort} `));
  origin.close(); srv.close();
});

test("proxied fetch: CONNECT refusal surfaces the proxy's own status", async () => {
  const { makeProxiedFetch } = await import("../dist/lib.js");
  const log = [];
  const srv = netServer((c) => {
    let b = "";
    c.on("data", (d) => {
      b += d.toString("latin1");
      if (b.includes("\r\n\r\n")) { log.push(b); c.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); }
    });
    c.on("error", () => {});
  });
  const port = await listen0(srv);
  const f = makeProxiedFetch(`http://127.0.0.1:${port}`);
  const err = await f("http://127.0.0.1:9/x").then(() => "").catch((e) => String(e.message ?? e));
  assert.match(err, /proxy CONNECT failed: HTTP\/1\.1 502/);
  srv.close();
});

test("proxied fetch: chunked transfer-encoding decodes (raw TCP framing)", async () => {
  const { makeProxiedFetch } = await import("../dist/lib.js");
  // Raw TCP origin: node:http would re-chunk manual bytes; this control the
  // wire-format exactly.
  const origin = netServer((c) => {
    let b = "";
    c.on("data", (d) => {
      b += d.toString("latin1");
      if (b.includes("\r\n\r\n")) {
        c.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
          + "3\r\n{\"a\r\n5\r\n\":42}\r\nA\r\n\nrest=okay\r\n0\r\n\r\n");
      }
    });
    c.on("error", () => {});
  });
  const originPort = await listen0(origin);
  const log = [];
  const { port, srv } = await spawnProxy(log);
  const f = makeProxiedFetch(`http://127.0.0.1:${port}`);
  const res = await f(`http://127.0.0.1:${originPort}/x`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), `{"a":42}\nrest=okay`);
  origin.close(); srv.close();
});

test("detectWorkingProxy: probes candidate ports, wire-visible, null when nothing responds", async () => {
  const { detectWorkingProxy } = await import("../dist/lib.js");
  // Occupy a candidate port with a CONNECT logger that refuses: detection
  // must reach it (proves the probe path) and stay null (not crash).
  const hits = [];
  const srv = netServer((c) => {
    let b = "";
    c.on("data", (d) => {
      b += d.toString("latin1");
      if (b.includes("\r\n\r\n")) { hits.push(b.split("\r\n")[0]); c.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); }
    });
    c.on("error", () => {});
  }).listen(10809, "127.0.0.1");
  await once(srv, "listening");
  try {
    const found = await detectWorkingProxy(4000);
    assert.equal(found, null);
    assert.ok(hits.some((h) => h.startsWith("CONNECT api.telegram.org:443")), "no CONNECT probes landed on the candidate port");
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test("normalizeProxyUrl: bare host:port is accepted; garbage errs with guidance", async () => {
  const { normalizeProxyUrl } = await import("../dist/lib.js");
  assert.equal(normalizeProxyUrl("127.0.0.1:9050"), "http://127.0.0.1:9050");
  assert.equal(normalizeProxyUrl("user:pw@10.0.0.2:8080"), "http://user:pw@10.0.0.2:8080");
  assert.equal(normalizeProxyUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(normalizeProxyUrl("socks://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(normalizeProxyUrl(""), "");
  assert.equal(normalizeProxyUrl("  "), "");
  const err = await Promise.resolve().then(() => normalizeProxyUrl("http://[bad")).then(() => "").catch((e) => String(e.message ?? e));
  assert.match(err, /not a usable proxy address/);
  assert.match(err, /http:\/\/HOST:PORT/);
});

test("wiring: createBot supplies the proxied fetch; no undici runtime dep", () => {
  const tg = readFileSync(new URL("../src/channels/telegram.ts", import.meta.url), "utf8");
  assert.match(tg, /makeProxiedFetch\(url\)/);
  assert.match(tg, /client: \{ fetch: makeProxiedFetch|const client = \{ fetch: makeProxiedFetch/);
  assert.doesNotMatch(tg, /import\("undici"\)/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(!(pkg.dependencies ?? {})["undici"], "undici must not be a runtime dep");
  assert.ok(!(pkg.devDependencies ?? {})["undici"], "undici must not be a devdep either");
  const px = readFileSync(new URL("../src/channels/telegram-proxy.ts", import.meta.url), "utf8");
  assert.match(px, /CONNECT \$\{host\}:\$\{port\} HTTP\/1\.1/);
  assert.match(px, /socks5|SOCKS5/);
  assert.match(px, /chunked/i);
});
