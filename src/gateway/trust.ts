// Gateway trust policy: which Host headers and browser Origins may reach the
// control plane. Two independent defenses, learned from OpenClaw's "ClawJacked"
// WebSocket hijack and the standard CSWSH/DNS-rebinding writeups:
//
//   1. Host allowlist — defeats DNS rebinding (attacker domain resolves to
//      127.0.0.1; the browser happily sends Host: attacker.com, we refuse it).
//   2. Origin allowlist on the WS upgrade — defeats cross-site WebSocket
//      hijacking (a hostile page opening ws://127.0.0.1:port/). Requests with
//      no Origin come from native clients (TUI, scripts) and pass the transport
//      check; token auth still applies to them.
//
// Policy shape: loopback names always allowed on loopback binds; LAN binds also
// accept private/link-local IP literals, .local and .localhost names (the
// phone-on-wifi case). Anything else (public hostnames, reverse proxies) must
// be listed in gateway.allowedHosts / gateway.allowedOrigins.

export interface TrustPolicy {
  bind: "loopback" | "lan";
  allowedHosts: string[];
  allowedOrigins: string[];
}

/** Strip the port from a Host header (or origin host), IPv6-literal aware. */
export function hostnameOf(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).host;
    } catch {
      return "";
    }
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(1, end) : host;
  }
  const colon = host.lastIndexOf(":");
  // bare IPv6 without brackets (shouldn't appear in Host) keeps its colons
  if (colon > -1 && host.indexOf(":") === colon) host = host.slice(0, colon);
  return host.replace(/\.$/, "");
}

function isLoopbackName(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.endsWith(".localhost")
  );
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale)
  return false;
}

function isPrivateIPv6(host: string): boolean {
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    const first = host.split(":")[0] ?? "";
    // fc00::/7 unique local, fe80::/10 link-local
    if (/^f[cd]/.test(first)) return true;
    if (/^fe[89ab]/.test(first)) return true;
    // v4-mapped loopback / private
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (v4) return isLoopbackName(v4[1] as string) || isPrivateIPv4(v4[1] as string);
  }
  return false;
}

/** Is this Host acceptable at the transport layer? */
export function hostAllowed(hostHeader: string, policy: TrustPolicy): boolean {
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  if (isLoopbackName(host)) return true;
  const extras = policy.allowedHosts.map((h) => hostnameOf(h));
  if (extras.includes(host)) return true;
  if (policy.bind !== "lan") return false;
  // LAN binds serve the phone UI over wifi: accept private IP literals and
  // mDNS/localhost-style names, nothing public.
  return isPrivateIPv4(host) || isPrivateIPv6(host) || host.endsWith(".local");
}

/**
 * Origin policy for the WS upgrade (and any state-changing HTTP):
 * absent Origin = native client, allowed at the transport layer; present
 * Origin must be same-origin with the request Host or explicitly allowed.
 */
export function originAllowed(
  origin: string | undefined,
  hostHeader: string,
  policy: TrustPolicy,
): boolean {
  if (origin === undefined || origin === "") return true;
  if (origin === "null") return false; // sandboxed iframes etc.
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Same-origin means scheme+host+port: compare the full host (port included)
  // so another local app on a different port cannot open our socket.
  const originHost = url.host.toLowerCase().replace(/\.$/, "");
  const reqHost = hostHeader.trim().toLowerCase().replace(/\.$/, "");
  if (originHost && originHost === reqHost) return true;
  for (const extra of policy.allowedOrigins) {
    let extraUrl: URL;
    try {
      extraUrl = new URL(extra);
    } catch {
      continue;
    }
    if (extraUrl.host.toLowerCase() === url.host.toLowerCase()) return true;
  }
  return false;
}
