// Inbound HTTP webhooks (P1 A4 — their /automation/cron-jobs/webhooks).
//
// Disabled by default. A token-bearing external service wakes the agent or
// submits an agent turn: POST /hooks/wake, POST /hooks/agent, and mapped
// POST /hooks/<name> via config `hooks.mappings`. Auth is a dedicated hook
// token (Bearer or x-openclaw-token), never the gateway token, and never a
// query string — their exact contract.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export interface HookService {
  config: {
    hooks: {
      enabled: boolean;
      token: string;
      path: string;
      allowRequestSessionKey: boolean;
      mappings: Record<string, { action: "wake" | "agent"; text: string; message: string; sessionKey: string }>;
    };
  };
  send(payload: {
    sessionKey: string;
    text: string;
    isMainSession?: boolean;
    source: "webhook";
    queueMode?: "followup";
    model?: string;
    reply: (text: string) => Promise<void> | void;
  }): Promise<void>;
  log: { info(msg: string): void; warn(msg: string): void };
}

const BODY_CAP = 128 * 1024;
const MSG_CAP = 32 * 1024;
const WAKE_CAP = 2000;
const RESERVED = /^(subagent|cron|acp|system):/;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const tokenMatches = (given: string, want: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

/** POST body capped at 128KB; oversized or non-JSON fails closed. */
function readBody(req: IncomingMessage): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const ct = String(req.headers["content-type"] ?? "");
    if (!ct.includes("application/json")) {
      resolve({ ok: false, error: "Content-Type must be application/json" });
      // Drain so keep-alive stays well-behaved.
      req.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_CAP) {
        resolve({ ok: false, error: `payload too large (>${BODY_CAP} bytes)` });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object");
        resolve({ ok: true, data: raw as Record<string, unknown> });
      } catch {
        resolve({ ok: false, error: "malformed JSON body" });
      }
    });
    req.on("error", () => resolve({ ok: false, error: "payload read failed" }));
  });
}

const renderTemplate = (tmpl: string, name: string, payload: Record<string, unknown>): string => {
  let out = tmpl.replace(/\{\{\s*json\s*\}\}/g, JSON.stringify(payload).slice(0, 16 * 1024));
  out = out.replace(/\{\{\s*name\s*\}\}/g, name);
  out = out.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (_, field: string) => {
    const v = payload[field];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  });
  return out.slice(0, MSG_CAP);
};

const rand = () => Math.random().toString(36).slice(2, 9);

/** Returns true when the request was claimed (answer sent). */
export async function handleHooksRequest(service: HookService, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const base = (service.config.hooks.path || "/hooks").replace(/\/+$/, "") || "/hooks";
  if (url !== base && !url.startsWith(base + "/")) return false;

  if (!service.config.hooks.enabled) {
    json(res, 404, { error: "hooks disabled — set hooks.enabled (and hooks.token) in config" });
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ error: "method not allowed — hooks accept POST only" }));
    return true;
  }
  if (!service.config.hooks.token) {
    json(res, 503, { error: "hooks.token is not configured — hooks stay closed until it is" });
    return true;
  }
  // Bearer or x-openclaw-token only. Query tokens are (their rule) rejected.
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
  const xTok = String(req.headers["x-openclaw-token"] ?? "");
  if (!tokenMatches(bearer, service.config.hooks.token) && !tokenMatches(xTok, service.config.hooks.token)) {
    json(res, 401, { error: "invalid or missing hook token (Bearer or x-openclaw-token header)" });
    return true;
  }

  const body = await readBody(req);
  if (!body.ok) {
    json(res, body.error.includes("too large") ? 413 : 400, { error: body.error });
    return true;
  }
  const p = body.data;
  const sub = url.slice(base.length + 1);

  const runWake = async (text: string, mode: string, note?: string): Promise<void> => {
    const sessionKey = "main:main";
    void service.send({
      sessionKey,
      text,
      isMainSession: true,
      source: "webhook",
      queueMode: "followup",
      reply: () => {},
    }).catch((err) => service.log.warn(`hook wake run failed: ${(err as Error).message}`));
    service.log.info(`hook wake queued (${text.length} chars)`);
    json(res, 200, { ok: true, mode: mode === "next-heartbeat" ? "now" : "now", eventOutcome: "queued", sessionKey, ...(note ? { note } : {}) });
  };

  const runAgent = async (message: string, sessionKey: string, model?: string): Promise<void> => {
    void service
      .send({ sessionKey, text: message, isMainSession: sessionKey.startsWith("main:"), source: "webhook", model, reply: () => {} })
      .catch((err) => service.log.warn(`hook agent run failed: ${(err as Error).message}`));
    service.log.info(`hook agent run queued in ${sessionKey} (${message.length} chars)`);
    json(res, 200, { ok: true, runId: sessionKey, sessionKey });
  };

  const sessionKeyAllowed = (sk: string): boolean =>
    service.config.hooks.allowRequestSessionKey && typeof sk === "string" && sk.trim().length > 0 && !RESERVED.test(sk.trim());

  if (sub === "wake") {
    const text = String(p["text"] ?? "").trim();
    if (!text) return json(res, 400, { error: "text is required (nonempty)" }), true;
    if (text.length > WAKE_CAP) return json(res, 400, { error: `text exceeds ${WAKE_CAP} chars — route big content through /hooks/agent` }), true;
    const sessionKey = String(p["sessionKey"] ?? "").trim();
    void sessionKeyAllowed; // wakes always land on the main session at our scale
    const mode = String(p["mode"] ?? "now");
    const note = mode === "next-heartbeat" ? "no heartbeat engine — delivered now" : undefined;
    // Wake text is scoped as a trusted system notification, never a model-spoken truth.
    await runWake(`[hook wake] ${text}`, mode, note);
    return true;
  }

  if (sub === "agent") {
    const message = String(p["message"] ?? "").trim();
    if (!message) return json(res, 400, { error: "message is required (nonempty)" }), true;
    if (message.length > MSG_CAP) return json(res, 400, { error: `message exceeds ${MSG_CAP} chars` }), true;
    const wantKey = String(p["sessionKey"] ?? "").trim();
    if (wantKey && !sessionKeyAllowed(wantKey)) {
      return json(res, 400, { error: "sessionKey requires hooks.allowRequestSessionKey and a non-reserved namespace" }), true;
    }
    const sessionKey = wantKey || `hook:agent:${Date.now().toString(36)}-${rand()}`;
    const model = typeof p["model"] === "string" && p["model"] ? (p["model"] as string) : undefined;
    await runAgent(message, sessionKey, model);
    return true;
  }

  // Mapped custom hook. First mapping wins; unknown → 404 (their contract).
  const mapping = service.config.hooks.mappings?.[sub];
  if (!mapping) {
    json(res, 404, { error: `no hook mapping for ${sub}` });
    return true;
  }
  if (mapping.action === "wake") {
    const text = renderTemplate(String(mapping.text || "{{json}}"), sub, p).trim();
    if (!text) return json(res, 400, { error: "wake mapping rendered empty text" }), true;
    await runWake(`[hook ${sub}] ${text}`.slice(0, WAKE_CAP + 40), String(p["mode"] ?? "now"));
    return true;
  }
  const message = renderTemplate(String(mapping.message || "{{json}}"), sub, p).trim();
  if (!message) return json(res, 400, { error: "agent mapping rendered empty message" }), true;
  const wantKey = String(mapping.sessionKey || p["sessionKey"] || "").trim();
  const sessionKey = wantKey && sessionKeyAllowed(wantKey) ? wantKey : `hook:agent:${Date.now().toString(36)}-${rand()}`;
  await runAgent(message, sessionKey, typeof p["model"] === "string" ? (p["model"] as string) : undefined);
  return true;
}

/** Cheap fingerprint for logs (never logs the token itself). */
export const hookTokenFingerprint = (token: string): string =>
  token ? createHash("sha256").update(token).digest("hex").slice(0, 12) : "(unset)";
