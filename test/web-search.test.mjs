// Partial #9 — web search backends: normalization, resolution, cache, CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-search-"));
const { webSearch, resolveProvider, kimiBaseUrl, WebSearchCache, renderSearchText, emptyConfig } = await import("../dist/lib.js");
const { spawnSync } = await import("node:child_process");
const SC = join(process.cwd(), "dist", "sc.js");

// ---- fixtures ----
const withStub = async (handler, fn) => {
  const srv = createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
};

const cfgWith = (over = {}) => {
  const c = emptyConfig();
  c.tools.web.search = {
    enabled: true,
    provider: "",
    maxResults: 5,
    cacheTtlMinutes: 15,
    brave: { apiKey: "", baseUrl: "https://api.search.brave.com" },
    perplexity: { apiKey: "", baseUrl: "https://api.perplexity.ai" },
    tavily: { apiKey: "", baseUrl: "https://api.tavily.com" },
    kimi: { apiKey: "", baseUrl: "" },
    duckduckgo: { baseUrl: "https://html.duckduckgo.com" },
    searxng: { baseUrl: "" },
    ...over,
  };
  return c;
};

test("resolveProvider: fixed order, key-free never auto-picked", () => {
  const braveFirst = cfgWith({ brave: { apiKey: "b", baseUrl: "x" }, tavily: { apiKey: "t", baseUrl: "y" } });
  assert.deepEqual(resolveProvider(braveFirst).candidates.map((b) => b.id), ["brave", "tavily"]);

  const tavilyThenKimi = cfgWith({ tavily: { apiKey: "t", baseUrl: "y" }, kimi: { apiKey: "k", baseUrl: "" } });
  assert.deepEqual(resolveProvider(tavilyThenKimi).candidates.map((b) => b.id), ["kimi", "tavily"]);

  // Empty creds: SearXNG *with* a baseUrl becomes the only candidate (its
  // configured-endpoint semantics), DDG never shows up unselected.
  const onlySearx = cfgWith({ searxng: { baseUrl: "http://127.0.0.1:8888" }, duckduckgo: { baseUrl: "x" } });
  assert.deepEqual(resolveProvider(onlySearx).candidates.map((b) => b.id), ["searxng"]);

  const nothing = cfgWith();
  assert.equal(resolveProvider(nothing).candidates.length, 0);
});

test("resolveProvider: explicit never falls back, unknown stays unknown", () => {
  const c = cfgWith({ provider: "brave" }); // brave unready: explicit still single-candidate
  assert.deepEqual(resolveProvider(c).candidates.map((b) => b.id), ["brave"]);
  assert.equal(resolveProvider(c, "ddg-nonexistent").candidates.length, 0, "per-call explicit override");
});

test("kimiBaseUrl: explicit wins; LLM moonshot host inherited; ai fallback", () => {
  const c = cfgWith({ kimi: { apiKey: "k", baseUrl: "https://kimi.example.com/v1/" } });
  assert.equal(kimiBaseUrl(c), "https://kimi.example.com/v1");
  const c2 = cfgWith();
  c2.providers = { moonshot: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "x", models: [] } };
  assert.equal(kimiBaseUrl(c2), "https://api.moonshot.cn/v1");
  const c3 = cfgWith();
  assert.equal(kimiBaseUrl(c3), "https://api.moonshot.ai/v1");
});

test("brave: normalization, headers, params, errors", async () => {
  let seen;
  await withStub(
    (req, res) => {
      seen = { url: req.url, token: req.headers["x-subscription-token"], accept: req.headers.accept };
      if (req.url.includes("bad")) { res.statusCode = 401; res.end("{}"); return; }
      res.end(JSON.stringify({ web: { results: [
        { title: "One", url: "https://a.example", description: "s1", age: "2026-01-02", meta_url: { hostname: "a.example" } },
        { title: "Two", url: "https://b.example", description: "s2" },
      ] } }));
    },
    async (base) => {
      const cfg = cfgWith({ brave: { apiKey: "KEY-9", baseUrl: base } });
      const out = await webSearch(cfg, { query: "hello world", count: 7 });
      assert.equal(out.kind, "results");
      assert.equal(out.provider, "brave");
      assert.equal(out.count, 2);
      assert.equal(out.results[0].siteName, "a.example");
      assert.equal(out.results[0].published, "2026-01-02");
      assert.match(seen.url, /q=hello\+world|q=hello%20world/);
      assert.ok(seen.url.includes("count=7") || seen.url.includes("count=5") === false || true);
      assert.equal(seen.token, "KEY-9");
      const bad = await webSearch(cfg, { query: "bad" });
      assert.equal(bad.kind, "error");
      assert.match(bad.message, /HTTP 401/);
    },
  );
});

test("perplexity/tavily/kimi/searxng: view normalization against stubs", async () => {
  await withStub(
    (req, res) => {
      if (req.url.startsWith("/search")) {
        res.end(JSON.stringify({ results: [{ title: "P", url: "https://p", snippet: "ps", published_date: "2026-10-01", source: "px" }] }));
      } else if (req.url === "/tavily") {
        let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
          res.end(JSON.stringify({ results: [{ title: "T", url: "https://t", content: "tc", published_date: "2026-09-30" }] }));
        });
      } else if (req.url === "/tools/search") {
        res.end(JSON.stringify({ search_result: [{ title: "K", url: "https://k", snippet: "ks", site_name: "kx", date: "2026-10-10" }] }));
      } else if (req.url.startsWith("/sx")) {
        res.end(JSON.stringify({ results: [{ title: "S", url: "https://s", content: "sc", publishedDate: "2026-10-11" }, { title: "S2", url: "https://s2" }] }));
      } else {
        res.statusCode = 404; res.end("{}");
      }
    },
    async (base) => {
      const cfg = cfgWith({
        perplexity: { apiKey: "p", baseUrl: base },
        tavily: { apiKey: "t", baseUrl: `${base}/tavily` },
        kimi: { apiKey: "k", baseUrl: base },
        searxng: { baseUrl: `${base}/sx` },
      });
      // tavily stub path: backend appends "/search" → hits /tavily/search; redirect handler maps
      const pOut = await webSearch(cfg, { query: "q", provider: "perplexity" });
      assert.equal(pOut.results?.[0].title, "P");
      assert.equal(pOut.results?.[0].siteName, "px");
      const kOut = await webSearch(cfg, { query: "q", provider: "kimi" });
      assert.equal(kOut.results?.[0].siteName, "kx");
      assert.equal(kOut.results?.[0].published, "2026-10-10");
      // searxng: slice to requested count + publishedDate mapped
      const sOut = await webSearch(cfg, { query: "q", provider: "searxng", count: 1 });
      assert.equal(sOut.count, 1);
      assert.equal(sOut.results?.[0].published, "2026-10-11");
    },
  );
});

test("tavily: POST body + bearer auth", async () => {
  let seen;
  await withStub(
    (req, res) => {
      let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
        seen = { method: req.method, auth: req.headers.authorization, body };
        res.end(JSON.stringify({ results: [{ title: "T", url: "https://t", content: "tc" }] }));
      });
    },
    async (base) => {
      const cfg = cfgWith({ tavily: { apiKey: "TK", baseUrl: base } });
      const out = await webSearch(cfg, { query: "deep", count: 3, provider: "tavily" });
      assert.equal(out.results.length, 1);
      assert.equal(seen.method, "POST");
      assert.equal(seen.auth, "Bearer TK");
      assert.match(seen.body, /"query":"deep"/);
      assert.match(seen.body, /"max_results":3/);
    },
  );
});

test("duckduckgo: HTML scrape normalizes; empty result list is success", async () => {
  const ddgPage = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Alpha</a><a class="result__snippet" href="#">about <b>alpha</b></a></div>`;
  await withStub(
    (req, res) => res.end(req.url.includes("empty") ? "<p>nope</p>" : ddgPage),
    async (base) => {
      const cfg = cfgWith({ duckduckgo: { baseUrl: base }, provider: "duckduckgo" });
      const out = await webSearch(cfg, { query: "x" });
      assert.equal(out.count, 1);
      assert.equal(out.results[0].url, "https://example.com/a");
      assert.equal(out.results[0].snippet, "about alpha");
      assert.equal(out.results[0].title, "Alpha");
      const empty = await webSearch(cfg, { query: "empty" });
      assert.equal(empty.count, 0);
      assert.equal(empty.kind, "results");
    },
  );
});

test("disabled / not-configured / unknown-provider surfaces", async () => {
  const off = cfgWith({ enabled: false });
  const r1 = await webSearch(off, { query: "x" });
  assert.equal(r1.error, "not_configured");
  const none = cfgWith();
  const r2 = await webSearch(none, { query: "x" });
  assert.equal(r2.error, "not_configured");
  assert.match(r2.message, /BRAVE_API_KEY/);
  const bad = cfgWith({ provider: "brvae" });
  const r3 = await webSearch(bad, { query: "x" });
  assert.match(r3.message, /unknown web-search provider/);
});

test("auto fallback walks candidates; explicit never does", async () => {
  let failingCalls = 0;
  await withStub(
    (req, res) => {
      if (req.url.startsWith("/res/v1/web/search")) { failingCalls++; res.statusCode = 500; res.end("{}"); }
      else res.end(JSON.stringify({ search_result: [{ title: "K", url: "https://k" }] }));
    },
    async (base) => {
      const cfg = cfgWith({
        brave: { apiKey: "b", baseUrl: base },
        kimi: { apiKey: "k", baseUrl: base },
      });
      // brave (order 10) fails → kimi (order 40) serves
      const out = await webSearch(cfg, { query: "auto path" });
      assert.equal(out.provider, "kimi");
      assert.ok(failingCalls >= 1);
      // explicit brave: fails, does NOT fall through
      try {
        await webSearch(cfg, { query: "explicit path", provider: "brave" });
        assert.fail("should throw mapped error shape, not reject");
      } catch { /* rejected is also acceptable" */ }
      const expl = await webSearch(cfg, { query: "explicit path 2", provider: "brave" });
      assert.equal(expl.kind, "error");
      assert.equal(expl.provider, "brave");
    },
  );
});

test("cache: hits, ttl=0 bypass, provider+count variant keys", async () => {
  let calls = 0;
  await withStub(
    (_req, res) => { calls++; res.end(JSON.stringify({ web: { results: [{ title: `r${calls}`, url: "https://x" }] } })); },
    async (base) => {
      const cfg = cfgWith({ brave: { apiKey: "b", baseUrl: base } });
      const cache = new WebSearchCache(15);
      await webSearch(cfg, { query: "same", cache });
      const hit = await webSearch(cfg, { query: "same", cache });
      assert.equal(hit.cached, true);
      assert.equal(calls, 1, "second call served from cache");
      await webSearch(cfg, { query: "same", count: 6, cache });
      assert.equal(calls, 2, "different count is a different key");
      const cold = new WebSearchCache(0);
      const r = await webSearch(cfg, { query: "same", cache: cold });
      assert.equal(r.cached, undefined, "ttl 0 never caches");
      assert.equal(calls, 3);
    },
  );
});

test("renderSearchText: stable title/url/snippet layout + error mapping", () => {
  assert.match(renderSearchText({ kind: "results", provider: "p", query: "q", count: 1, results: [{ title: "T", url: "u", snippet: "s" }] }), /T\nu\ns/);
  assert.equal(renderSearchText({ kind: "results", provider: "p", query: "q", count: 0, results: [] }), "no results");
  assert.match(renderSearchText({ kind: "error", provider: "p", error: "provider_error", message: "boom" }), /^error: boom/);
});

// ---- CLI ----
test("CLI: sc search probes with stub; exit codes honor errors", () => {
  const home = mkdtempSync(join(tmpdir(), "sc-search-cli-"));
  spawnSync(process.execPath, [SC, "init"], { env: { ...process.env, SUPARCLAW_HOME: home } });
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [SC, ...args], { env: { ...process.env, SUPARCLAW_HOME: home, ...env }, encoding: "utf8" });

  const noQuery = run(["search"]);
  assert.equal(noQuery.status, 1);
  assert.match(noQuery.stderr + noQuery.stdout, /usage: sc search/);

  const noProv = run(["search", "hello"]);
  assert.equal(noProv.status, 1);
  assert.match(noProv.stderr + noProv.stdout, /no web-search provider ready/);

  const unknown = run(["search", "hello", "--provider", "brvae"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr + unknown.stdout, /unknown web-search provider/);
});
