// Native Google Workspace REST client. OAuth credentials stay in GmailAddonService's
// encrypted-vault broker; this module only receives short-lived bearer tokens.
import { randomBytes } from "node:crypto";

export type GoogleWorkspaceService = "docs" | "sheets" | "calendar" | "drive";
export type GoogleHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const API_ROOT: Record<GoogleWorkspaceService, string> = {
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
};

export class GoogleWorkspaceApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason = "") {
    super(message);
    this.name = "GoogleWorkspaceApiError";
  }
}

export interface GoogleWorkspaceRequest {
  method?: GoogleHttpMethod;
  query?: Record<string, unknown>;
  body?: unknown;
  responseType?: "json" | "text" | "bytes";
}

/** Thin, testable REST client. Paths are constrained to the selected Google API host. */
export class GoogleWorkspaceApi {
  constructor(
    private readonly accessToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request<T = unknown>(service: GoogleWorkspaceService, path: string, opts: GoogleWorkspaceRequest = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const cleanPath = path.replace(/^\/+/, "");
    if (!cleanPath || cleanPath.split("/").some((part) => part === "..") || /%(?:2e|2f|5c)/i.test(cleanPath) || cleanPath.includes("#") || cleanPath.includes("?")) {
      throw new Error("Google API path must be a relative API path; pass query parameters separately");
    }
    const url = new URL(`${API_ROOT[service]}/${cleanPath}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else if (typeof value === "object") url.searchParams.set(key, JSON.stringify(value));
      else url.searchParams.set(key, String(value));
    }
    if (url.origin !== new URL(API_ROOT[service]).origin || !url.pathname.startsWith(new URL(API_ROOT[service]).pathname)) {
      throw new Error("Google API request escaped its service endpoint");
    }
    const makeRequest = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.accessToken(forceRefresh);
      const headers = new Headers({ Authorization: `Bearer ${token}` });
      let body: BodyInit | undefined;
      if (opts.body !== undefined) {
        headers.set("Content-Type", "application/json; charset=utf-8");
        body = JSON.stringify(opts.body);
      }
      return this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    };
    let response = await makeRequest(false);
    if (response.status === 401) response = await makeRequest(true);
    if (!response.ok) throw await apiError(response);
    if (response.status === 204) return undefined as T;
    if (opts.responseType === "bytes") {
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > 25 * 1024 * 1024) throw new Error("Google Workspace download exceeds the 25 MiB per-file limit");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Google Workspace download exceeds the 25 MiB per-file limit");
      return bytes as T;
    }
    if (opts.responseType === "text") return await response.text() as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; }
    catch { return text as T; }
  }

  async uploadDriveContent(input: {
    name: string;
    mimeType: string;
    content: string | Uint8Array;
    folderId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    const boundary = `suparclaw_${randomBytes(18).toString("hex")}`;
    const metadata: Record<string, unknown> = { name: input.name, mimeType: input.mimeType, ...(input.metadata ?? {}) };
    if (input.folderId) metadata["parents"] = [input.folderId];
    const raw = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
    const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${input.mimeType || "application/octet-stream"}\r\n\r\n`);
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
    const bytes = new Uint8Array(prefix.length + raw.length + suffix.length);
    bytes.set(prefix, 0); bytes.set(raw, prefix.length); bytes.set(suffix, prefix.length + raw.length);
    const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("fields", "id,name,mimeType,webViewLink,parents,size,createdTime,modifiedTime");
    const send = async (refresh: boolean) => this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken(refresh)}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (!response.ok) throw await apiError(response);
    return response.json();
  }

  async downloadDriveFile(fileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = new URL(`${API_ROOT.drive}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    const send = async (refresh: boolean) => this.fetchFn(url, {
      headers: { Authorization: `Bearer ${await this.accessToken(refresh)}` },
      signal: AbortSignal.timeout(60_000),
    });
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (!response.ok) throw await apiError(response);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 25 * 1024 * 1024) throw new Error("Drive download exceeds the 25 MiB per-file limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Drive download exceeds the 25 MiB per-file limit");
    return { bytes, mimeType: response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

async function apiError(response: Response): Promise<GoogleWorkspaceApiError> {
  let message = `Google API request failed (${response.status})`;
  let reason = "";
  try {
    const data = await response.clone().json() as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
    message = data.error?.message || message;
    reason = data.error?.errors?.[0]?.reason || data.error?.status || "";
  } catch { /* keep safe status-only message */ }
  return new GoogleWorkspaceApiError(message.slice(0, 1000), response.status, reason);
}

/** Native connector uses the same Google account and encrypted OAuth grant as Gmail. */
export class GoogleWorkspaceAddonService {
  constructor(
    private readonly enabled: () => boolean,
    private readonly accessToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  status(): { enabled: boolean; available: boolean; authScopes: string[]; setup: string } {
    return {
      enabled: this.enabled(),
      available: true,
      authScopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/calendar"],
      setup: "Use Gmail → Connect Google account to grant the shared Gmail + Workspace OAuth scopes.",
    };
  }

  async api(): Promise<GoogleWorkspaceApi> {
    if (!this.enabled()) throw new Error("Google Workspace add-on is disabled; enable addons.googleWorkspace.enabled in Settings");
    return new GoogleWorkspaceApi((forceRefresh) => this.accessToken(forceRefresh), this.fetchFn);
  }
}
