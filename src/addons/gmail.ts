// Native Gmail add-on primitives: OAuth for a local CLI/Termux gateway and the
// Gmail REST API. No token is written to config, returned by status, or logged.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
] as const;
// Full Drive access is deliberately requested: drive.file would only cover
// files individually opened/created by this app and cannot honor full-access approval.
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
] as const;
export const GOOGLE_ACCOUNT_SCOPES = [...GMAIL_SCOPES, ...GOOGLE_WORKSPACE_SCOPES] as const;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_TIMEOUT_MS = 10 * 60_000;
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export interface GmailTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}

export interface GmailOAuthResult {
  tokens: GmailTokenSet;
  email: string;
}

export interface GmailOAuthFlow {
  authUrl: string;
  redirectUri: string;
  done: Promise<GmailOAuthResult>;
  cancel(): Promise<void>;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  messageId: string;
}

export interface GmailAttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessageText {
  id: string;
  threadId: string;
  headers: Record<string, string>;
  labels: string[];
  snippet: string;
  text: string;
  attachments: GmailAttachmentInfo[];
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: { textColor?: string; backgroundColor?: string };
}

export interface GmailDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: boolean;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename: string; mimeType?: string; data: Buffer }[];
}

export interface GmailRequestOptions {
  fetchFn?: typeof fetch;
  /** One safe refresh/retry is permitted after an explicit HTTP 401 only. */
  refreshAccessToken?: () => Promise<string>;
}

function safeText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "";
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sameState(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function sendHtml(res: import("node:http").ServerResponse, status: number, title: string, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(title)}</title><main style="font:16px system-ui;max-width:36rem;margin:12vh auto;padding:1.5rem"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p><p>You can close this tab and return to SuparClaw.</p></main>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(body);
}

async function parseOAuthJson(res: Response): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = await res.json(); } catch { data = {}; }
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

/**
 * Start Google's installed-app Authorization Code + PKCE flow on loopback.
 * This is intentionally not the Google device-code flow: Google does not allow
 * Gmail API scopes in its limited-input-device grant.
 */
export async function beginGmailOAuth(opts: {
  clientId: string;
  /** Google sometimes requires the Desktop client's generated secret at token exchange. */
  clientSecret?: string;
  scopes?: readonly string[];
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<GmailOAuthFlow> {
  const clientId = opts.clientId.trim();
  if (!clientId || clientId.length > 512 || /[\s\r\n]/.test(clientId)) throw new Error("configure a valid Google Desktop OAuth client ID first");
  const scopes = [...(opts.scopes ?? GMAIL_SCOPES)];
  if (scopes.length === 0 || scopes.some((s) => !s.startsWith("https://www.googleapis.com/auth/"))) throw new Error("invalid Gmail OAuth scope configuration");
  const verifier = randomUrlSafe(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUrlSafe(32);
  const fetchFn = opts.fetchFn ?? fetch;
  let server: Server;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveDone!: (value: GmailOAuthResult) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<GmailOAuthResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // OAuth can fail while a client is still displaying the auth URL. Mark the
  // promise handled internally while preserving rejection for awaiters.
  void done.catch(() => {});
  const close = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const finish = async (error?: Error, value?: GmailOAuthResult): Promise<void> => {
    if (settled) return;
    settled = true;
    await close();
    if (error) rejectDone(error);
    else if (value) resolveDone(value);
    else rejectDone(new Error("Google OAuth ended without a result"));
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/oauth2callback") {
      sendHtml(res, 404, "Not found", "This temporary OAuth callback only accepts the Google sign-in response.");
      return;
    }
    if (!sameState(url.searchParams.get("state") ?? "", state)) {
      sendHtml(res, 400, "Sign-in not verified", "The OAuth state did not match. Return to SuparClaw and start again.");
      return;
    }
    const authError = url.searchParams.get("error");
    if (authError) {
      sendHtml(res, 400, "Gmail connection cancelled", "Google did not grant Gmail access.");
      void finish(new Error(authError === "access_denied" ? "Google access was denied" : `Google OAuth failed (${safeText(authError, 80)})`));
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code || code.length > 4096) {
      sendHtml(res, 400, "Sign-in incomplete", "Google did not return an authorization code. Return to SuparClaw and try again.");
      return;
    }
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    void (async () => {
      try {
        const tokenForm = new URLSearchParams({
          client_id: clientId,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        });
        if (opts.clientSecret?.trim()) tokenForm.set("client_secret", opts.clientSecret.trim());
        const tokenRes = await fetchFn(GOOGLE_TOKEN, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenForm,
          signal: AbortSignal.timeout(20_000),
        });
        const tokenBody = await parseOAuthJson(tokenRes);
        if (!tokenRes.ok || typeof tokenBody["access_token"] !== "string") {
          const error = safeText(tokenBody["error"], 80) || `HTTP ${tokenRes.status}`;
          const detail = safeText(tokenBody["error_description"], 180);
          const reason = detail ? `${error}: ${detail}` : error;
          const secretHint = error === "invalid_request" && /client_secret is missing/i.test(detail)
            ? " Add the Desktop OAuth client secret in Google integration settings, save, then reconnect."
            : "";
          sendHtml(res, 400, "Gmail connection failed", `Google could not complete authorization (${reason}).${secretHint} Return to SuparClaw and try again.`);
          await finish(new Error(`Google token exchange failed (${reason})${secretHint}`));
          return;
        }
        const tokens: GmailTokenSet = {
          accessToken: String(tokenBody["access_token"]),
          ...(typeof tokenBody["refresh_token"] === "string" ? { refreshToken: String(tokenBody["refresh_token"]) } : {}),
          expiresAt: Date.now() + Math.max(0, Number(tokenBody["expires_in"] ?? 0)) * 1000,
          scopes: typeof tokenBody["scope"] === "string" ? tokenBody["scope"].split(/\s+/).filter(Boolean) : scopes,
        };
        if (!tokens.refreshToken) {
          sendHtml(res, 400, "Reconnect Google account", "Google did not return offline access. Reconnect with consent so SuparClaw can refresh access when you are away.");
          await finish(new Error("Google did not return a refresh token; revoke the grant and reconnect with consent"));
          return;
        }
        const missingScopes = scopes.filter((scope) => !tokens.scopes.includes(scope));
        if (missingScopes.length) {
          const missing = missingScopes.map((scope) => scope.split("/").at(-1)).join(", ");
          sendHtml(res, 400, "Google permissions incomplete", `Missing scopes: ${missing}. Check Google Cloud Console → OAuth consent screen → Data access, enable the requested APIs, then reconnect and approve the full access request.`);
          await finish(new Error(`Google did not grant all requested Gmail/Workspace scopes (${missing})`));
          return;
        }
        try {
          const api = new GmailApi(tokens.accessToken, { fetchFn });
          const profile = await api.getProfile();
          sendHtml(res, 200, "Google account connected", `Connected to ${profile.emailAddress}.`);
          await finish(undefined, { tokens, email: profile.emailAddress });
        } catch (err) {
          sendHtml(res, 400, "Gmail connection failed", safeText((err as Error).message, 300) || "Could not verify the Gmail account.");
          await finish(new Error(`could not verify Gmail account: ${safeText((err as Error).message)}`));
        }
      } catch (err) {
        sendHtml(res, 502, "Gmail connection failed", "Could not reach Google. Return to SuparClaw and retry.");
        await finish(new Error(`Google OAuth request failed: ${safeText((err as Error).message, 180)}`));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  if (!port) { await close(); throw new Error("could not start Gmail OAuth callback listener"); }
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const auth = new URL(GOOGLE_AUTH);
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    // Desktop/installed apps do not support incremental authorization. Send the
    // complete scope union on every connect/reauthorize instead.
    prompt: "consent",
  }).toString();
  timer = setTimeout(() => { void finish(new Error("Google authorization timed out; start a new connection")); }, opts.timeoutMs ?? OAUTH_TIMEOUT_MS);
  timer.unref?.();
  return {
    authUrl: auth.toString(),
    redirectUri,
    done,
    cancel: async () => { await finish(new Error("Google authorization cancelled")); },
  };
}

export class GmailApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason = "") {
    super(message);
    this.name = "GmailApiError";
  }
}

type RawMessage = {
  id?: string; threadId?: string; snippet?: string; labelIds?: string[];
  payload?: { mimeType?: string; filename?: string; headers?: GmailHeader[]; body?: { data?: string; attachmentId?: string; size?: number }; parts?: RawMessage["payload"][] };
  internalDate?: string; historyId?: string; sizeEstimate?: number; raw?: string;
};

function headerMap(headers: GmailHeader[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const key = safeText(h.name, 120).toLowerCase();
    if (key && out[key] === undefined) out[key] = safeText(h.value, 4000);
  }
  return out;
}

function decodePart(data: string | undefined): string {
  if (!data) return "";
  try { return Buffer.from(data, "base64url").toString("utf8"); } catch { return ""; }
}

function walkParts(payload: RawMessage["payload"], textParts: string[], htmlParts: string[], attachments: GmailAttachmentInfo[]): void {
  if (!payload) return;
  const filename = safeText(payload.filename, 240);
  const body = payload.body;
  if (filename || body?.attachmentId) {
    if (body?.attachmentId) attachments.push({
      attachmentId: safeText(body.attachmentId, 256),
      filename: filename || "attachment",
      mimeType: safeText(payload.mimeType, 160) || "application/octet-stream",
      size: Math.max(0, Number(body.size ?? 0)),
    });
  } else if (payload.mimeType === "text/plain" && body?.data) {
    textParts.push(decodePart(body.data));
  } else if (payload.mimeType === "text/html" && body?.data) {
    htmlParts.push(decodePart(body.data));
  }
  for (const part of payload.parts ?? []) walkParts(part, textParts, htmlParts, attachments);
}

function normalizeSummary(message: RawMessage): GmailMessageSummary {
  const h = headerMap(message.payload?.headers);
  return {
    id: safeText(message.id, 256),
    threadId: safeText(message.threadId, 256),
    from: h["from"] ?? "",
    to: h["to"] ?? "",
    cc: h["cc"] ?? "",
    subject: h["subject"] ?? "(no subject)",
    date: h["date"] ?? "",
    snippet: safeText(message.snippet, 1200),
    labels: (message.labelIds ?? []).map((x) => safeText(x, 160)),
    messageId: h["message-id"] ?? "",
  };
}

function headerValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("email header values cannot contain newlines");
  return value.trim();
}

function wrapBase64(data: Buffer): string {
  const encoded = data.toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function makeRawMail(input: GmailDraftInput, allowEmptyRecipients = false): string {
  const to = input.to.map(headerValue).filter(Boolean);
  if (to.length === 0 && !allowEmptyRecipients) throw new Error("at least one recipient is required");
  const headers = [
    ...(to.length ? [`To: ${to.join(", ")}`] : []),
    ...(input.cc?.length ? [`Cc: ${input.cc.map(headerValue).join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.map(headerValue).join(", ")}`] : []),
    `Subject: ${headerValue(input.subject)}`,
    "MIME-Version: 1.0",
    ...(input.inReplyTo ? [`In-Reply-To: ${headerValue(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${headerValue(input.references)}`] : []),
  ];
  const attachments = input.attachments ?? [];
  if (attachments.some((a) => a.data.byteLength > MAX_ATTACHMENT_BYTES)) throw new Error("an attachment is over the 18 MB limit");
  if (attachments.reduce((sum, attachment) => sum + attachment.data.byteLength, 0) > MAX_ATTACHMENT_BYTES) throw new Error("combined attachments exceed the 18 MB total limit");
  if (attachments.length === 0) {
    const mime = input.html ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
    return `${headers.join("\r\n")}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.body.replace(/\r?\n/g, "\r\n")}`;
  }
  const boundary = `sc-${randomUrlSafe(18)}`;
  const parts = [
    `--${boundary}\r\nContent-Type: ${input.html ? "text/html" : "text/plain"}; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.body.replace(/\r?\n/g, "\r\n")}`,
    ...attachments.map((a) => {
      const filename = headerValue(a.filename).replace(/["\\]/g, "_");
      const mime = headerValue(a.mimeType ?? "application/octet-stream").replace(/[^\w.+/-]/g, "");
      return `--${boundary}\r\nContent-Type: ${mime}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(a.data)}`;
    }),
    `--${boundary}--`,
  ];
  return `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.join("\r\n")}`;
}

/** Thin, testable wrapper for the Gmail REST API. */
export class GmailApi {
  constructor(private readonly accessToken: string, private readonly options: GmailRequestOptions = {}) {
    if (!accessToken) throw new Error("Gmail access token is missing");
  }

  async request<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const fetchFn = this.options.fetchFn ?? fetch;
    let res: Response;
    const send = (token: string) => fetchFn(`${GMAIL_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    try {
      res = await send(this.accessToken);
    } catch (err) {
      throw new GmailApiError(`Gmail API is unreachable (${safeText((err as Error).message, 180)})`, 0, "network");
    }
    if (res.status === 401 && this.options.refreshAccessToken) {
      const refreshed = await this.options.refreshAccessToken();
      try { res = await send(refreshed); }
      catch (err) { throw new GmailApiError(`Gmail API is unreachable (${safeText((err as Error).message, 180)})`, 0, "network"); }
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* empty response */ }
    if (!res.ok) {
      const error = body["error"] && typeof body["error"] === "object" ? body["error"] as Record<string, unknown> : {};
      const reason = safeText(error["status"] ?? error["reason"], 100);
      const message = safeText(error["message"], 300) || `HTTP ${res.status}`;
      throw new GmailApiError(`Gmail API request failed (${res.status}${reason ? ` ${reason}` : ""}): ${message}`, res.status, reason);
    }
    return body as T;
  }

  getProfile(): Promise<GmailProfile> { return this.request<GmailProfile>("/profile"); }

  async listSendAsAddresses(): Promise<Record<string, unknown>[]> {
    const out = await this.request<{ sendAs?: Record<string, unknown>[] }>("/settings/sendAs");
    return out.sendAs ?? [];
  }

  async listMessages(opts: { q?: string; pageToken?: string; maxResults?: number; includeSpamTrash?: boolean } = {}): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string; resultSizeEstimate: number }> {
    const query = new URLSearchParams();
    if (opts.q) query.set("q", opts.q);
    if (opts.pageToken) query.set("pageToken", opts.pageToken);
    query.set("maxResults", String(Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 20)))));
    if (opts.includeSpamTrash) query.set("includeSpamTrash", "true");
    const list = await this.request<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(`/messages?${query}`);
    const refs = list.messages ?? [];
    const messages = await mapConcurrent(refs, 10, async (ref) => normalizeSummary(await this.request<RawMessage>(`/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`)));
    return { messages, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}), resultSizeEstimate: Number(list.resultSizeEstimate ?? messages.length) };
  }

  async listThreads(opts: { q?: string; pageToken?: string; maxResults?: number; includeSpamTrash?: boolean } = {}): Promise<{ threads: { id: string; snippet: string; messageCount: number; latest: GmailMessageSummary }[]; nextPageToken?: string; resultSizeEstimate: number }> {
    const query = new URLSearchParams();
    if (opts.q) query.set("q", opts.q);
    if (opts.pageToken) query.set("pageToken", opts.pageToken);
    query.set("maxResults", String(Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 20)))));
    if (opts.includeSpamTrash) query.set("includeSpamTrash", "true");
    const list = await this.request<{ threads?: { id: string; snippet?: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(`/threads?${query}`);
    const threads = await mapConcurrent(list.threads ?? [], 8, async (ref) => {
      const full = await this.request<{ id: string; messages?: RawMessage[] }>(`/threads/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`);
      const messages = full.messages ?? [];
      const latest = messages.at(-1) ?? { id: "", threadId: ref.id, snippet: ref.snippet };
      return { id: ref.id, snippet: safeText(ref.snippet, 1200), messageCount: messages.length, latest: normalizeSummary(latest) };
    });
    return { threads, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}), resultSizeEstimate: Number(list.resultSizeEstimate ?? threads.length) };
  }

  async getMessage(id: string, format: "full" | "metadata" | "raw" | "minimal" = "full"): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/messages/${encodeURIComponent(id)}?format=${format}`);
  }

  async getThread(id: string, format: "full" | "metadata" = "full"): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/threads/${encodeURIComponent(id)}?format=${format}`);
  }

  async getMessageText(id: string): Promise<GmailMessageText> {
    const message = await this.request<RawMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    const headers = headerMap(message.payload?.headers);
    const textParts: string[] = [];
    const htmlParts: string[] = [];
    const attachments: GmailAttachmentInfo[] = [];
    walkParts(message.payload, textParts, htmlParts, attachments);
    const htmlText = htmlParts.join("\n\n").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/p\s*>/gi, "\n\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    return {
      id: safeText(message.id, 256),
      threadId: safeText(message.threadId, 256),
      headers,
      labels: (message.labelIds ?? []).map((x) => safeText(x, 160)),
      snippet: safeText(message.snippet, 1200),
      text: (textParts.join("\n\n") || htmlText).slice(0, 100_000),
      attachments,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
    return this.request<{ data: string; size: number }>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  async listDrafts(opts: { q?: string; pageToken?: string; maxResults?: number } = {}): Promise<{ drafts: { id: string; message: GmailMessageSummary }[]; nextPageToken?: string; resultSizeEstimate: number }> {
    const query = new URLSearchParams();
    if (opts.q) query.set("q", opts.q);
    if (opts.pageToken) query.set("pageToken", opts.pageToken);
    query.set("maxResults", String(Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 20)))));
    const list = await this.request<{ drafts?: { id: string; message?: { id: string; threadId: string } }[]; nextPageToken?: string; resultSizeEstimate?: number }>(`/drafts?${query}`);
    const drafts = await Promise.all((list.drafts ?? []).map(async (d) => {
      const full = await this.request<{ id?: string; message?: RawMessage }>(`/drafts/${encodeURIComponent(d.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`);
      return { id: d.id, message: normalizeSummary(full.message ?? {}) };
    }));
    return { drafts, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}), resultSizeEstimate: Number(list.resultSizeEstimate ?? drafts.length) };
  }

  getDraft(id: string): Promise<Record<string, unknown>> { return this.request(`/drafts/${encodeURIComponent(id)}?format=full`); }

  createDraft(input: GmailDraftInput): Promise<Record<string, unknown>> {
    return this.request("/drafts", { method: "POST", body: { message: { raw: Buffer.from(makeRawMail(input, true), "utf8").toString("base64url"), ...(input.threadId ? { threadId: input.threadId } : {}) } } });
  }

  updateDraft(id: string, input: GmailDraftInput): Promise<Record<string, unknown>> {
    return this.request(`/drafts/${encodeURIComponent(id)}`, { method: "PUT", body: { message: { raw: Buffer.from(makeRawMail(input, true), "utf8").toString("base64url"), ...(input.threadId ? { threadId: input.threadId } : {}) } } });
  }

  /** Patch only supplied draft fields; preserve recipients, content and attachments otherwise. */
  async updateDraftPartial(id: string, patch: Partial<GmailDraftInput>): Promise<Record<string, unknown>> {
    const draft = await this.getDraft(id) as { message?: RawMessage };
    const message = draft.message;
    if (!message?.id) throw new Error("draft has no message ID");
    const old = await this.getMessageText(message.id);
    const split = (value: string | undefined): string[] => value ? value.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map((x) => x.trim()).filter(Boolean) : [];
    let attachments: NonNullable<GmailDraftInput["attachments"]>;
    if (patch.attachments !== undefined) {
      attachments = patch.attachments;
    } else {
      if (old.attachments.length > 5) throw new Error("draft has more than five attachments; supply an explicit replacement list to update it");
      attachments = await Promise.all(old.attachments.map(async (item) => {
        const downloaded = await this.getAttachment(message.id!, item.attachmentId);
        const data = Buffer.from(downloaded.data, "base64url");
        if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`existing attachment ${item.filename} is over the 18 MB update limit`);
        return { filename: item.filename, mimeType: item.mimeType, data };
      }));
    }
    return this.updateDraft(id, {
      to: patch.to ?? split(old.headers["to"]),
      cc: patch.cc ?? split(old.headers["cc"]),
      bcc: patch.bcc ?? split(old.headers["bcc"]),
      subject: patch.subject ?? old.headers["subject"] ?? "",
      body: patch.body ?? old.text,
      html: patch.html ?? false,
      threadId: patch.threadId ?? message.threadId,
      inReplyTo: patch.inReplyTo ?? old.headers["in-reply-to"],
      references: patch.references ?? old.headers["references"],
      attachments,
    });
  }

  deleteDraft(id: string): Promise<Record<string, unknown>> { return this.request(`/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }); }

  sendDraft(id: string): Promise<Record<string, unknown>> { return this.request("/drafts/send", { method: "POST", body: { id } }); }

  sendMessage(input: GmailDraftInput): Promise<Record<string, unknown>> {
    return this.request("/messages/send", { method: "POST", body: { raw: Buffer.from(makeRawMail(input), "utf8").toString("base64url"), ...(input.threadId ? { threadId: input.threadId } : {}) } });
  }

  async listLabels(): Promise<GmailLabel[]> {
    const out = await this.request<{ labels?: GmailLabel[] }>("/labels");
    return out.labels ?? [];
  }
  getLabel(id: string): Promise<GmailLabel> { return this.request(`/labels/${encodeURIComponent(id)}`); }
  createLabel(input: { name: string; messageListVisibility?: string; labelListVisibility?: string; color?: GmailLabel["color"] }): Promise<GmailLabel> {
    return this.request("/labels", { method: "POST", body: input });
  }
  updateLabel(id: string, input: Partial<Pick<GmailLabel, "name" | "messageListVisibility" | "labelListVisibility" | "color">>): Promise<GmailLabel> {
    return this.request(`/labels/${encodeURIComponent(id)}`, { method: "PUT", body: input });
  }
  deleteLabel(id: string): Promise<Record<string, unknown>> { return this.request(`/labels/${encodeURIComponent(id)}`, { method: "DELETE" }); }

  modifyMessageLabels(id: string, add: string[] = [], remove: string[] = []): Promise<Record<string, unknown>> {
    return this.request(`/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: { addLabelIds: add, removeLabelIds: remove } });
  }
  modifyThreadLabels(id: string, add: string[] = [], remove: string[] = []): Promise<Record<string, unknown>> {
    return this.request(`/threads/${encodeURIComponent(id)}/modify`, { method: "POST", body: { addLabelIds: add, removeLabelIds: remove } });
  }
  batchModifyMessages(ids: string[], add: string[] = [], remove: string[] = []): Promise<Record<string, unknown>> {
    if (ids.length < 1 || ids.length > 100) throw new Error("batch label changes need 1–100 message IDs");
    return this.request("/messages/batchModify", { method: "POST", body: { ids, addLabelIds: add, removeLabelIds: remove } });
  }

  /** Gmail delete actions are intentionally reversible: move to Trash only. */
  trashMessage(id: string): Promise<Record<string, unknown>> { return this.modifyMessageLabels(id, ["TRASH"], ["INBOX"]); }
  untrashMessage(id: string): Promise<Record<string, unknown>> { return this.modifyMessageLabels(id, [], ["TRASH"]); }
  trashThread(id: string): Promise<Record<string, unknown>> { return this.modifyThreadLabels(id, ["TRASH"], ["INBOX"]); }
  untrashThread(id: string): Promise<Record<string, unknown>> { return this.modifyThreadLabels(id, [], ["TRASH"]); }
  batchTrashMessages(ids: string[]): Promise<Record<string, unknown>> { return this.batchModifyMessages(ids, ["TRASH"], ["INBOX"]); }
}

/** Refresh a token only when it is expiring; caller owns persisted refresh token. */
export async function refreshGmailAccessToken(opts: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  fetchFn?: typeof fetch;
}): Promise<GmailTokenSet> {
  const form = new URLSearchParams({ client_id: opts.clientId, refresh_token: opts.refreshToken, grant_type: "refresh_token" });
  if (opts.clientSecret?.trim()) form.set("client_secret", opts.clientSecret.trim());
  const res = await (opts.fetchFn ?? fetch)(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await parseOAuthJson(res);
  if (!res.ok || typeof data["access_token"] !== "string") {
    const error = safeText(data["error"], 80) || `HTTP ${res.status}`;
    const detail = safeText(data["error_description"], 180);
    const reason = detail ? `${error}: ${detail}` : error;
    throw new Error(error === "invalid_grant" ? "Google authorization expired or was revoked — reconnect the Google account" : `Google token refresh failed (${reason})`);
  }
  return {
    accessToken: String(data["access_token"]),
    refreshToken: opts.refreshToken,
    expiresAt: Date.now() + Math.max(0, Number(data["expires_in"] ?? 0)) * 1000,
    scopes: typeof data["scope"] === "string" ? data["scope"].split(/\s+/).filter(Boolean) : [],
  };
}

/** Small concurrency limiter used for list-message metadata fetches. */
export async function mapConcurrent<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= values.length) return;
      out[i] = await fn(values[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
