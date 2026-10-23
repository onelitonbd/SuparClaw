// Proxied fetch for the Telegram Bot API (their per-channel proxy field).
//
// Why hand-rolled instead of undici's ProxyAgent: Node's global fetch only
// accepts dispatchers created by its OWN internal undici copy — a dispatcher
// built from the bundled npm undici fails instanceof and every request dies
// with UND_ERR_INVALID_ARG before ever touching the proxy. Sockets + TLS
// from node:core have no such identity problem, need no new dependency, and
// behave identically across Node 20-24 (our Termux range).
//
// Supports http(s):// proxies (CONNECT tunneling) and socks5/socks5h://.
// grammy's client.fetch = typeof fetch, so this is a drop-in.

import * as net from "node:net";
import * as tls from "node:tls";
import { Buffer } from "node:buffer";

/**
 * People paste proxies as bare host:port — that is not a valid URL ("Invalid
 * URL / ERR_INVALID_URL" otherwise surfaces confusingly). Normalize:
 *   "127.0.0.1:9050"        → http://127.0.0.1:9050
 *   "user:pass@1.2.3.4:80"  → http://user:pass@1.2.3.4:80
 *   "socks://…"             → socks5://…
 * Full URLs pass through untouched; anything utterly unparsable throws with
 * the usable-form guidance inside the message.
 */
export function normalizeProxyUrl(raw: string): string {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  let candidate = v;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  candidate = candidate.replace(/^socks:\/\//i, "socks5://");
  try {
    new URL(candidate); // validity only — parsed again by callers
    return candidate;
  } catch {
    throw new Error(`channels.telegram.proxy "${v}" is not a usable proxy address — use http://HOST:PORT (bare HOST:PORT works too) or socks5://HOST:PORT`);
  }
}

function httpRequestHead(method: string, path: string, headers: Record<string, string>, bodyLen: number): string {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  if (bodyLen > 0 && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
    lines.push(`Content-Length: ${bodyLen}`);
  }
  lines.push("Connection: close", "", "");
  return lines.join("\r\n");
}

/** Read until the HTTP head terminator; carries leftover frame bytes. */
function readHead(sock: net.Socket, timeoutMs: number): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout reading from proxy/socket")); sock.destroy(); }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf("\r\n\r\n");
      if (i >= 0) {
        cleanup();
        resolve({ head: buf.subarray(0, i).toString("latin1"), rest: buf.subarray(i + 4) });
      }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error("connection closed before a response header")); };
    const cleanup = () => { clearTimeout(timer); sock.off("data", onData); sock.off("error", onErr); sock.off("end", onEnd); };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
  });
}

async function connectHttpProxy(px: URL, host: string, port: number, signal?: AbortSignal | null): Promise<net.Socket> {
  const sock = net.connect({ host: px.hostname, port: Number(px.port) || 8080 });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  if (signal) signal.addEventListener("abort", () => sock.destroy(signal.reason as Error), { once: true });
  const auth = px.username || px.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString("base64")}\r\n`
    : "";
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const { head } = await readHead(sock, 10_000);
  const statusLine = head.split("\r\n")[0] ?? "";
  if (!/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
    sock.destroy();
    throw new Error(`proxy CONNECT failed: ${statusLine} (proxy at ${px.host} refused; check the port/username)`);
  }
  return sock;
}

async function connectSocks5(px: URL, host: string, port: number, signal?: AbortSignal | null): Promise<net.Socket> {
  const sock = net.connect({ host: px.hostname, port: Number(px.port) || 1080 });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  if (signal) signal.addEventListener("abort", () => sock.destroy(signal.reason as Error), { once: true });
  const hasAuth = Boolean(px.username);
  sock.write(Buffer.from([5, hasAuth ? 2 : 1, ...(hasAuth ? [0, 2] : [0])]));
  const greeting = await readHead(sock, 10_000).catch(() => null);
  // SOCKS greeting is 2 bytes, not HTTP — readHead fails; do a raw 2-byte read instead.
  void greeting;
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socks5 greeting timeout")), 10_000);
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => { chunks.push(c); const total = Buffer.concat(chunks); if (total.length >= 2) { clearTimeout(timer); sock.off("data", onData); resolve(total.subarray(0, 2)); } };
    sock.on("data", onData);
    sock.once("error", reject);
  });
  if (buf[0] !== 5) throw new Error("not a SOCKS5 proxy");
  if (hasAuth && buf[1] === 2) {
    const u = Buffer.from(decodeURIComponent(px.username), "utf8");
    const p = Buffer.from(decodeURIComponent(px.password), "utf8");
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const r = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socks5 auth timeout")), 10_000);
      const chunks: Buffer[] = [];
      const onData = (c: Buffer) => { chunks.push(c); const total = Buffer.concat(chunks); if (total.length >= 2) { clearTimeout(timer); sock.off("data", onData); resolve(total.subarray(0, 2)); } };
      sock.on("data", onData);
      sock.once("error", reject);
    });
    if (r[1] !== 0) throw new Error("socks5 username/password rejected");
  }
  const hostBuf = Buffer.from(host, "utf8");
  const req = Buffer.concat([
    Buffer.from([5, 1, 0, 3, hostBuf.length]), hostBuf,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
  sock.write(req);
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socks5 connect timeout")), 10_000);
    let total = Buffer.alloc(0);
    const need = (b: Buffer) => (b.length >= 4 ? ((b[3] ?? 0xff) === 1 ? 10 : b.length >= 5 ? 6 + (b[4] ?? 0) : 512) : 512);
    const onData = (c: Buffer) => { total = Buffer.concat([total, c]); if (total.length >= need(total) && total.length >= 6) { clearTimeout(timer); sock.off("data", onData); resolve(total); } };
    sock.on("data", onData);
    sock.once("error", reject);
  });
  if (reply[1] !== 0) throw new Error(`socks5 CONNECT failed (code ${reply[1]})`);
  return sock;
}

/** Content-length AND chunked body readers (api.telegram.org uses both). */
async function readBody(sock: net.Socket, head: string, rest: Buffer, signal?: AbortSignal | null): Promise<Buffer> {
  const headers: Record<string, string> = {};
  for (const line of head.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const take = async (n: number, doom: Buffer): Promise<Buffer> => {
    let b = doom;
    while (b.length < n) {
      const c: Buffer = await new Promise((resolve, reject) => {
        sock.once("data", resolve);
        sock.once("error", reject);
        sock.once("end", () => reject(new Error("body ended early")));
      });
      b = Buffer.concat([b, c]);
    }
    return b;
  };
  if (headers["content-length"] !== undefined) {
    const n = Number(headers["content-length"]);
    const full = await take(n, rest);
    return full.subarray(0, n);
  }
  if (/chunked/i.test(headers["transfer-encoding"] ?? "")) {
    let b = rest;
    const out: Buffer[] = [];
    for (;;) {
      while (!b.includes("\r\n")) {
        const c: Buffer = await new Promise((resolve, reject) => { sock.once("data", resolve); sock.once("error", reject); sock.once("end", () => reject(new Error("chunk size ended early"))); });
        b = Buffer.concat([b, c]);
      }
      const nl = b.indexOf(10);
      void nl;
      const crlf = b.indexOf("\r\n");
      const sizeStr = (b.subarray(0, crlf).toString("latin1").split(";")[0] ?? "0").trim();
      const size = parseInt(sizeStr, 16);
      if (Number.isNaN(size)) throw new Error(`bad chunk size: ${sizeStr}`);
      const need2 = crlf + 2 + size + 2;
      while (b.length < need2) {
        const c: Buffer = await new Promise((resolve, reject) => { sock.once("data", resolve); sock.once("error", reject); sock.once("end", () => reject(new Error("chunk body ended early"))); });
        b = Buffer.concat([b, c]);
      }
      out.push(b.subarray(crlf + 2, crlf + 2 + size));
      b = b.subarray(need2);
      if (size === 0) break;
    }
    return Buffer.concat(out);
  }
  // No explicit framing: read until close.
  const out: Buffer[] = [rest];
  sock.on("data", (c) => out.push(c));
  await new Promise<void>((resolve) => { sock.once("end", solve); sock.once("close", solve); function solve() { resolve(); } });
  void signal;
  return Buffer.concat(out);
}

/** body → Buffer for JSON strings, Buffers, FormData (transcoded), URLs. */
async function bodyBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "object" && body !== null) {
    // FormData/etc: transcode through a synthetic Response (works on all bots).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = new Response(body as any);
    return Buffer.from(await r.arrayBuffer());
  }
  return Buffer.from(String(body), "utf8");
}

/**
 * A fetch(1)-compatible implementation whose sockets all pass through a
 * HTTP(S) CONNECT proxy or SOCKS5 — Node-core only.
 */
export function makeProxiedFetch(proxyUrl: string): typeof fetch {
  const px = new URL(normalizeProxyUrl(proxyUrl));
  const kind = px.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks5", "socks5h"].includes(kind)) {
    throw new Error(`unsupported proxy scheme ${px.protocol} — use http:// (or socks5://)`);
  }
  return (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input)
      : input instanceof URL ? input
      : new URL((input as Request).url);
    const isHttps = url.protocol === "https:";
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const signal = init?.signal ?? null;

    let sock: net.Socket = kind === "http" || kind === "https"
      ? await connectHttpProxy(px, url.hostname, port, signal)
      : await connectSocks5(px, url.hostname, port, signal);
    if (isHttps) {
      sock = tls.connect({ socket: sock, servername: url.hostname }) as tls.TLSSocket;
      await new Promise<void>((resolve, reject) => {
        (sock as tls.TLSSocket).once("secureConnect", () => resolve());
        sock.once("error", reject);
      });
      if (signal) signal.addEventListener("abort", () => (sock as tls.TLSSocket).destroy(signal.reason as Error), { once: true });
    }

    const headersIn = init?.headers;
    const headers: Record<string, string> = {};
    if (headersIn) {
      if (headersIn instanceof Headers) headersIn.forEach((v, k) => { headers[k] = v; });
      else if (Array.isArray(headersIn)) for (const [k, v] of headersIn) headers[String(k)] = String(v);
      else for (const [k, v] of Object.entries(headersIn as Record<string, string>)) headers[k] = String(v);
    }
    const body = await bodyBuffer(init?.body ?? (input as Request).body);
    const method = String(init?.method ?? (input as Request).method ?? "GET").toUpperCase();
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "host")) headers["Host"] = port === (isHttps ? 443 : 80) ? url.hostname : `${url.hostname}:${port}`;

    sock.write(httpRequestHead(method, `${url.pathname}${url.search}`, headers, body.length));
    if (body.length > 0) sock.write(body);

    const { head, rest } = await readHead(sock, 30_000);
    const statusLine = head.split("\r\n")[0] ?? "";
    const status = Number(statusLine.split(" ")[1] ?? 0) || 0;
    const respHeaders = new Headers();
    for (const line of head.split("\r\n").slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) respHeaders.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const buf = await readBody(sock, head, rest, signal);
    sock.destroy();
    // DOM BodyInit vs Node Buffer/Uint8Array variance — identical bytes,
    // the bridged type is unavoidable on Node's TS lib version.
    return new Response(buf as unknown as BodyInit, { status: status || 502, headers: respHeaders });
  }) as typeof fetch;
}
