// Service-owned Gmail state: encrypted refresh token in the existing vault,
// non-secret account metadata in state/, and short-lived access tokens in RAM.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateDir } from "../util/paths.js";
import type { VaultManager } from "../agent/vault.js";
import {
  beginGmailOAuth,
  GmailApi,
  GOOGLE_ACCOUNT_SCOPES,
  refreshGmailAccessToken,
  type GmailOAuthFlow,
  type GmailOAuthResult,
  type GmailTokenSet,
} from "./gmail.js";

const TOKEN_ENTRY = "SUPARCLAW_GMAIL_REFRESH_TOKEN";
const CLIENT_SECRET_ENTRY = "SUPARCLAW_GMAIL_OAUTH_CLIENT_SECRET";
const META_FILE = "gmail-account.json";

interface GmailMetadata {
  version: 1;
  email: string;
  scopes: string[];
  connectedAt: string;
}

function readMetadata(): GmailMetadata | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir(), META_FILE), "utf8")) as Partial<GmailMetadata>;
    if (raw.version !== 1 || typeof raw.email !== "string" || !Array.isArray(raw.scopes) || typeof raw.connectedAt !== "string") return null;
    return { version: 1, email: raw.email, scopes: raw.scopes.map(String), connectedAt: raw.connectedAt };
  } catch { return null; }
}

function writeMetadata(meta: GmailMetadata): void {
  const file = join(stateDir(), META_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export interface GmailAddonStatus {
  configured: boolean;
  clientSecretConfigured: boolean;
  enabled: boolean;
  connected: boolean;
  usable: boolean;
  account: string;
  scopes: string[];
  connectedAt: string;
  connecting: boolean;
  vaultInitialized: boolean;
  vaultUnlocked: boolean;
  error?: string;
}

export interface GmailConnectStarted {
  flow: string;
  authUrl: string;
  redirectUri: string;
  expiresIn: number;
}

/** Lifecycle and credential broker for the Gmail API, shared by RPC/CLI/tools. */
export class GmailAddonService {
  #pending: { id: string; flow: GmailOAuthFlow; done: Promise<GmailOAuthResult> } | null = null;
  #lastError = "";
  #cached: GmailTokenSet | null = null;

  constructor(
    private readonly vault: VaultManager,
    private readonly clientId: () => string,
    private readonly enabled: () => boolean,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  #oauthClientSecret(): string | undefined {
    const resolved = this.vault.resolveForUse([CLIENT_SECRET_ENTRY]);
    const value = resolved.ok ? resolved.env?.[CLIENT_SECRET_ENTRY]?.trim() : "";
    return value || undefined;
  }

  status(): GmailAddonStatus {
    const meta = readMetadata();
    const entries = this.vault.list();
    const entry = entries.find((e) => e.name === TOKEN_ENTRY);
    const clientSecret = entries.find((e) => e.name === CLIENT_SECRET_ENTRY);
    const connected = Boolean(meta && entry?.configured);
    const usable = connected && this.vault.unlocked;
    return {
      configured: Boolean(this.clientId().trim()),
      clientSecretConfigured: Boolean(clientSecret?.configured),
      enabled: this.enabled(),
      connected,
      usable,
      account: connected ? meta!.email : "",
      scopes: connected ? meta!.scopes : [],
      connectedAt: connected ? meta!.connectedAt : "",
      connecting: Boolean(this.#pending),
      vaultInitialized: this.vault.initialized,
      vaultUnlocked: this.vault.unlocked,
      ...(this.#lastError ? { error: this.#lastError } : {}),
      ...(connected && !usable ? { error: "unlock the encrypted vault in Settings to use Gmail" } : {}),
    };
  }

  async startConnect(): Promise<GmailConnectStarted> {
    const clientId = this.clientId().trim();
    if (!clientId) throw new Error("set addons.gmail.clientId to a Google Desktop OAuth client ID first");
    if (!this.vault.initialized) throw new Error("initialize the encrypted vault in Settings before connecting Gmail");
    if (!this.vault.unlocked) throw new Error("unlock the encrypted vault in Settings before connecting Gmail");
    const found = this.vault.list().find((e) => e.name === TOKEN_ENTRY);
    if (!found) {
      const defined = this.vault.define({ name: TOKEN_ENTRY, kind: "secret", description: "SuparClaw Gmail OAuth refresh token; used only by the Gmail add-on." });
      if (!defined.ok) throw new Error(defined.error ?? "could not prepare encrypted Gmail credential storage");
    }
    if (this.#pending) await this.cancelConnect(this.#pending.id);
    this.#lastError = "";
    const flow = await beginGmailOAuth({ clientId, clientSecret: this.#oauthClientSecret(), scopes: GOOGLE_ACCOUNT_SCOPES, fetchFn: this.fetchFn });
    const id = randomUUID();
    const done = flow.done.then(async (result) => {
      const saved = await this.vault.setValue(TOKEN_ENTRY, result.tokens.refreshToken ?? "");
      if (!saved.ok) throw new Error(saved.error ?? "could not store Gmail refresh token in the encrypted vault");
      writeMetadata({ version: 1, email: result.email, scopes: result.tokens.scopes, connectedAt: new Date().toISOString() });
      this.#cached = result.tokens;
      this.#lastError = "";
      return result;
    }).catch((err) => {
      this.#lastError = (err as Error).message;
      throw err;
    }).finally(() => {
      if (this.#pending?.id === id) this.#pending = null;
    });
    // UI clients poll `status`; this attached handler prevents an abandoned
    // browser tab from leaving a rejected Promise unhandled in the daemon.
    void done.catch(() => {});
    this.#pending = { id, flow, done };
    return { flow: id, authUrl: flow.authUrl, redirectUri: flow.redirectUri, expiresIn: 600 };
  }

  async waitConnect(flowId: string): Promise<{ email: string; scopes: string[] }> {
    const pending = this.#pending;
    if (!pending || pending.id !== flowId) throw new Error("Gmail sign-in flow expired or was replaced; start again");
    const result = await pending.done;
    return { email: result.email, scopes: result.tokens.scopes };
  }

  async cancelConnect(flowId?: string): Promise<boolean> {
    const pending = this.#pending;
    if (!pending || (flowId && pending.id !== flowId)) return false;
    this.#pending = null;
    await pending.flow.cancel();
    this.#lastError = "";
    return true;
  }

  async close(): Promise<void> {
    await this.cancelConnect();
    this.#cached = null;
  }

  async disconnect(): Promise<boolean> {
    await this.cancelConnect();
    this.#cached = null;
    const entry = this.vault.list().find((e) => e.name === TOKEN_ENTRY);
    if (entry?.configured && !this.vault.unlocked) throw new Error("unlock the encrypted vault in Settings before disconnecting Gmail");
    if (entry) {
      const removed = this.vault.remove(TOKEN_ENTRY, TOKEN_ENTRY);
      if (!removed.ok) throw new Error(removed.error ?? "could not remove Gmail credential from the vault");
    }
    const file = join(stateDir(), META_FILE);
    if (existsSync(file)) {
      const { rmSync } = await import("node:fs");
      rmSync(file, { force: true });
    }
    return Boolean(entry);
  }

  async api(): Promise<GmailApi> {
    if (!this.enabled()) throw new Error("Gmail add-on is disabled; enable addons.gmail.enabled in Settings");
    if (!this.vault.unlocked) throw new Error("encrypted vault is locked; unlock it in Settings to use Gmail");
    const token = await this.#accessToken();
    return new GmailApi(token, { refreshAccessToken: async () => {
      this.#cached = null;
      return this.#accessToken();
    } });
  }

  /** Shared short-lived token broker for Workspace APIs; refresh tokens remain vault-only. */
  async workspaceAccessToken(forceRefresh = false): Promise<string> {
    if (!this.vault.unlocked) throw new Error("encrypted vault is locked; unlock it in Settings to use Google Workspace");
    if (forceRefresh) this.#cached = null;
    return this.#accessToken();
  }

  async #accessToken(): Promise<string> {
    if (this.#cached && this.#cached.expiresAt > Date.now() + 60_000) return this.#cached.accessToken;
    const resolved = this.vault.resolveForUse([TOKEN_ENTRY]);
    if (!resolved.ok || !resolved.env?.[TOKEN_ENTRY]) throw new Error(resolved.error ?? "Google account is not connected; connect it in Settings or run sc gmail connect");
    const refreshToken = resolved.env[TOKEN_ENTRY]!;
    const token = await refreshGmailAccessToken({ clientId: this.clientId(), clientSecret: this.#oauthClientSecret(), refreshToken, fetchFn: this.fetchFn });
    this.#cached = token;
    return token.accessToken;
  }
}
