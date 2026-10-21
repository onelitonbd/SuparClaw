// P1 A6 — OpenAI-compatible HTTP surface for the gateway.
//
// Upstream contract researched in docs/openclaw/gateway/openai-http-api.md:
// POST /v1/chat/completions + GET /v1/models{,/<id>} behind
// `gateway.http.endpoints.chatCompletions.enabled` (off by default), Bearer
// auth = the gateway token (operator-grade: full agent access — they flag the
// surface for private ingress only, and so do we), agent-first model ids
// ("openclaw" / "openclaw/default"), stateless per request unless a caller
// pins a session via `user` (stable hashed key) or `x-openclaw-session-key`
// (reserved namespaces rejected). `/v1/embeddings`, `/v1/responses`, scopes
// and trusted-proxy mode are deliberately OUT (501 with guidance) at our
// scale: single agent, one gateway process.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import type { SuparClawConfig } from "../config/schema.js";
import type { ChatPayload } from "../agent/service.js";
import { readBody, tokenMatches, RESERVED } from "./webhooks.js";

export interface OpenAiService {
  config: SuparClawConfig;
  send(payload: ChatPayload): Promise<void>;
  log: { info(msg: string): void; warn(msg: string): void };
}

const BODY_CAP = 1024 * 1024; // chat histories are bigger than hook payloads
const MODEL_IDS = ["openclaw", "openclaw/default"] as const;

const errBody = (message: string, type = "invalid_request_error", code: string | null = null) =>
  JSON.stringify({ error: { message, type, param: null, code } });

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** GET /v1/models list payload — agent targets, not provider models (single agent). */
const modelsList = (created: number) => ({
  object: "list",
  data: MODEL_IDS.map((id) => ({ id, object: "model", created, owned_by: "suparclaw" })),
});

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Last user message text; multipart contents join their text parts. */
function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (typeof m !== "object" || m === null) continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user") continue;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((p) => (typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return null; // user message exists but carries no text (e.g. images only)
  }
  return null;
}

export async function handleOpenAiRequest(service: OpenAiService, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0] ?? "";
  if (url !== "/v1/models" && !url.startsWith("/v1/models/") && url !== "/v1/chat/completions" && url !== "/v1/embeddings" && url !== "/v1/responses") return false;

  // Feature off behaves like the rest of our disabled surfaces: 404 + how to turn it on.
  if (!service.config.gateway.http?.endpoints?.chatCompletions?.enabled) {
    sendJson(res, 404, errBody("openai-compatible endpoints disabled — set gateway.http.endpoints.chatCompletions.enabled = true", "invalid_request_error", "disabled"));
    return true;
  }
  // Operator door needs an operator key; without a gateway token every request is open, so refuse loudly.
  const want = service.config.gateway.auth?.token ?? "";
  if (!want) {
    sendJson(res, 503, errBody("gateway.auth.token is not set — openai-compatible endpoints require one (operator-grade surface)", "invalid_request_error", "no_gateway_token"));
    return true;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim() ?? "";
  if (!tokenMatches(bearer, want)) {
    sendJson(res, 401, errBody("invalid bearer token — use the gateway token", "authentication_error", "invalid_api_key"));
    return true;
  }
  // Deliberately out of scope at our scale (vendored docs: separate flags/features).
  if (url === "/v1/embeddings" || url === "/v1/responses") {
    sendJson(res, 501, errBody(`${url} is not implemented — only /v1/chat/completions and /v1/models (see gateway.http.endpoints)`));
    return true;
  }
  if (url === "/v1/models" || url.startsWith("/v1/models/")) {
    if (req.method !== "GET") {
      sendJson(res, 405, errBody("method not allowed", "invalid_request_error", "method_not_allowed"));
      return true;
    }
    const created = Math.floor(Date.now() / 1000);
    if (url === "/v1/models") {
      sendJson(res, 200, JSON.stringify(modelsList(created)));
      return true;
    }
    const id = decodeURIComponent(url.slice("/v1/models/".length));
    const hit = (MODEL_IDS as readonly string[]).includes(id);
    if (!hit) {
      sendJson(res, 404, errBody(`unknown model '${id}' — available: ${MODEL_IDS.join(", ")}`, "invalid_request_error", "model_not_found"));
      return true;
    }
    sendJson(res, 200, JSON.stringify({ id, object: "model", created, owned_by: "suparclaw" }));
    return true;
  }

  // POST /v1/chat/completions
  if (req.method !== "POST") {
    sendJson(res, 405, errBody("method not allowed", "invalid_request_error", "method_not_allowed"));
    return true;
  }
  const body = await readBody(req, BODY_CAP);
  if (!body.ok) {
    sendJson(res, 400, errBody(body.error));
    return true;
  }
  const data = body.data;
  const text = lastUserText(data.messages);
  if (!text) {
    sendJson(res, 400, errBody("messages must contain a user message with text", "invalid_request_error", "missing_user_message"));
    return true;
  }
  // Agent-first model contract: our single agent answers to any of its ids.
  const modelReq = typeof data.model === "string" && data.model.trim() ? data.model.trim() : "openclaw";
  const agentMatch = /^(?:openclaw|agent):\/\/|^agent:|^openclaw\//.exec(modelReq);
  if (agentMatch) {
    const id = modelReq.replace(/^agent:/, "").replace(/^openclaw\//, "");
    if (id !== "default") {
      sendJson(res, 400, errBody(`unknown agent '${id}' — this gateway runs a single agent (see /v1/models)`));
      return true;
    }
  } else if (modelReq !== "openclaw" && modelReq !== "openclaw/default") {
    sendJson(res, 400, errBody(`unknown model '${modelReq}' — use ${MODEL_IDS.join(" or ")} (see /v1/models)`));
    return true;
  }
  // Session pinning: explicit header wins (reserved namespaces never from HTTP),
  // then OpenAI's `user`, else a fresh single-shot session per request.
  const headerKey = String(req.headers["x-openclaw-session-key"] ?? "").trim();
  let sessionKey: string;
  if (headerKey) {
    if (RESERVED.test(headerKey)) {
      sendJson(res, 400, errBody(`session key '${headerKey}' uses a reserved namespace (subagent:|cron:|acp:|system:)`));
      return true;
    }
    sessionKey = headerKey;
  } else if (typeof data.user === "string" && data.user.trim()) {
    sessionKey = `http:openai:${sha16(data.user.trim())}`;
  } else {
    sessionKey = `http:openai-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }
  const modelOverride = String(req.headers["x-openclaw-model"] ?? "").trim();
  const stream = data.stream === true;
  const created = Math.floor(Date.now() / 1000);
  const runId = `chatcmpl-openclaw-${Date.now().toString(36)}`;
  const respondModel = modelReq === "openclaw" || modelReq === "openclaw/default" ? modelReq : modelReq;

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: runId, object: "chat.completion.chunk", created, model: respondModel, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant" }));
    let usage: Record<string, number> | undefined;
    try {
      await service.send({
        sessionKey,
        text,
        source: "gateway",
        model: modelOverride || undefined,
        reply: () => {},
        onDelta: (d) => {
          res.write(chunk({ content: d }));
        },
        onFinal: (_t, u) => {
          usage = u;
        },
      });
      const tail: Record<string, unknown> = { id: runId, object: "chat.completion.chunk", created, model: respondModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      const u = normalizeUsage(usage);
      if (u) tail.usage = u;
      res.write(`data: ${JSON.stringify(tail)}\n\n`);
      res.write("data: [DONE]\n\n");
    } catch (e) {
      service.log.warn(`openai stream failed: ${(e as Error).message}`);
      res.write(`data: ${errBody(`run failed: ${(e as Error).message}`, "server_error")}\n\n`);
    }
    res.end();
    return true;
  }

  let finalText = "";
  let usage: Record<string, number> | undefined;
  try {
    await service.send({
      sessionKey,
      text,
      source: "gateway",
      model: modelOverride || undefined,
      reply: (t) => {
        finalText = t;
      },
      onFinal: (t, u) => {
        finalText = t;
        usage = u;
      },
    });
  } catch (e) {
    sendJson(res, 500, errBody(`run failed: ${(e as Error).message}`, "server_error"));
    return true;
  }
  const out: Record<string, unknown> = {
    id: runId,
    object: "chat.completion",
    created,
    model: respondModel,
    choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
  };
  const u = normalizeUsage(usage);
  if (u) out.usage = u;
  sendJson(res, 200, JSON.stringify(out));
  return true;
}

/** Provider usage arrives engine-shaped ({input,output,...}); emit the OpenAI triplet. */
function normalizeUsage(usage?: Record<string, number>): Record<string, number> | null {
  if (!usage || typeof usage !== "object") return null;
  const pick = (...keys: string[]) => keys.map((k) => usage[k]).find((v) => typeof v === "number" && Number.isFinite(v));
  const prompt = pick("prompt_tokens", "input_tokens", "input", "prompt");
  const completion = pick("completion_tokens", "output_tokens", "output", "completion");
  if (prompt === undefined && completion === undefined) return null;
  return { prompt_tokens: prompt ?? 0, completion_tokens: completion ?? 0, total_tokens: (prompt ?? 0) + (completion ?? 0) };
}
