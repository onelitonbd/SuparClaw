// RFC 8628 device-authorization flow — the headless OAuth path (their
// `--method device-code`): the provider shows a verification URL + user code,
// the user approves in any browser, and we poll the token endpoint until
// granted. Fetch is injectable so the whole flow is unit-testable offline.

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  /** Minimum seconds between token polls (RFC default 5). */
  interval: number;
  /** Seconds the user code stays valid. */
  expires_in: number;
}

export interface TokenSuccess {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export type DeviceFlowPollResult =
  | { status: "pending"; interval: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "ok"; token: TokenSuccess };

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly oauthError?: string,
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const post = async (fetchFn: FetchLike, url: string, params: Record<string, string | undefined>): Promise<unknown> => {
  const body = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join("&");
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await res
    .json()
    .catch(() => ({}))
    .then((j) => j as Record<string, unknown>);
  return { ok: res.ok, status: res.status, ...text };
};

/** STEP 1: request the user code + device code from the provider. */
export async function requestDeviceAuthorization(
  urls: { deviceCodeUrl: string; clientId: string; scope?: string },
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<DeviceAuthorization> {
  const res = (await post(fetchFn, urls.deviceCodeUrl, {
    client_id: urls.clientId,
    scope: urls.scope,
  })) as Record<string, unknown> & { ok: boolean; status: number };
  if (!res.ok || typeof res.device_code !== "string" || typeof res.user_code !== "string") {
    const err = typeof res.error === "string" ? ` (${res.error})` : "";
    throw new DeviceFlowError(`device authorization rejected: HTTP ${res.status}${err}`, res.status, res.error as string);
  }
  return {
    device_code: res.device_code,
    user_code: res.user_code,
    verification_uri: String(res.verification_uri ?? res.verification_url ?? ""),
    verification_uri_complete: res.verification_uri_complete as string | undefined,
    interval: typeof res.interval === "number" && res.interval > 0 ? res.interval : 5,
    expires_in: typeof res.expires_in === "number" && res.expires_in > 0 ? res.expires_in : 900,
  };
}

/** STEP 2 (one poll): RFC error semantics — pending, slow_down (+5s), denied, expired. */
export async function pollDeviceToken(
  urls: { tokenUrl: string; clientId: string },
  deviceCode: string,
  currentInterval: number,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<DeviceFlowPollResult> {
  const res = (await post(fetchFn, urls.tokenUrl, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: urls.clientId,
  })) as Record<string, unknown> & { ok: boolean; status: number };
  if (res.ok && typeof res.access_token === "string") {
    return {
      status: "ok",
      token: {
        access_token: res.access_token,
        token_type: String(res.token_type ?? "Bearer"),
        refresh_token: res.refresh_token as string | undefined,
        expires_in: res.expires_in as number | undefined,
        scope: res.scope as string | undefined,
        id_token: res.id_token as string | undefined,
      },
    };
  }
  const err = String(res.error ?? "");
  if (err === "authorization_pending") return { status: "pending", interval: currentInterval };
  if (err === "slow_down") return { status: "pending", interval: currentInterval + 5 };
  if (err === "access_denied") return { status: "denied" };
  if (err === "expired_token") return { status: "expired" };
  throw new DeviceFlowError(`token poll failed: HTTP ${res.status} ${err || res.error_description || ""}`.trim(), res.status, err);
}

/**
 * Full login: request codes, then poll until success/denial/expiry.
 * onCode fires once so the caller (CLI, Control UI) can show the code before
 * polling starts; onProgress fires per pending poll for spinners.
 */
export async function deviceLogin(opts: {
  descriptor: { deviceCodeUrl: string; tokenUrl: string; clientId: string; scope?: string };
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onCode?: (auth: DeviceAuthorization) => void;
  onProgress?: (attempt: number, interval: number) => void;
}): Promise<TokenSuccess & { expiresAt: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const auth = await requestDeviceAuthorization(opts.descriptor, opts.fetchFn);
  opts.onCode?.(auth);
  const deadline = Date.now() + auth.expires_in * 1000;
  let interval = auth.interval;
  for (let attempt = 1; ; attempt += 1) {
    await sleep(interval * 1000);
    const r = await pollDeviceToken(opts.descriptor, auth.device_code, interval, opts.fetchFn);
    if (r.status === "ok") {
      return { ...r.token, expiresAt: r.token.expires_in ? Date.now() + r.token.expires_in * 1000 : 0 };
    }
    if (r.status === "denied") throw new DeviceFlowError("login denied — the authorization was declined", 400, "access_denied");
    if (r.status === "expired") throw new DeviceFlowError("login expired — run the login again for a fresh code", 400, "expired_token");
    interval = r.interval;
    if (Date.now() > deadline) throw new DeviceFlowError("login expired — the user code timed out", 400, "expired_token");
    opts.onProgress?.(attempt, interval);
  }
}
