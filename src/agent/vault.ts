// Task 59 — named task variables and secrets.
//
// The agent can create names and describe what it needs. Values are entered
// through the authenticated Settings flow; agent management APIs return only
// metadata/status. Values are
// encrypted at rest with scrypt + AES-256-GCM. A user passphrase is required to
// unlock after every daemon restart, and the derived key is kept in memory.
//
// This is intentionally described as context-blind, not as a security boundary:
// Task 57 gives the agent unrestricted Termux exec as the same OS user. Any
// value injected into a command can be deliberately printed/transformed/sent.
// The vault prevents values from being returned by management calls and masks
// exact-value echoes; it cannot stop adversarial same-user code.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { vaultPath } from "../util/paths.js";

const scryptAsync = (passphrase: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, KEY_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
const CIPHER = "aes-256-gcm";
const AAD = Buffer.from("suparclaw:vault:v1", "utf8");
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const MIN_PASSPHRASE = 10;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_ENTRIES = 256;
const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED = new Set([
  "HOME", "PATH", "PWD", "OLDPWD", "SHELL", "TMPDIR", "PREFIX", "TERM",
  "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
]);

export type VaultKind = "variable" | "secret";

export interface VaultEntry {
  name: string;
  kind: VaultKind;
  description: string;
  configured: boolean;
  /** Whether the current daemon has the encrypted contents unlocked. */
  usable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VaultDisk {
  version: 1;
  salt: string;
  entries: Omit<VaultEntry, "usable">[];
  sealed: { iv: string; tag: string; data: string };
}

type Values = Record<string, string>;

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  entries: VaultEntry[];
  error?: string;
}

export interface VaultResolveResult {
  ok: boolean;
  env?: Record<string, string>;
  missing?: string[];
  error?: string;
}

function passphraseProblem(passphrase: string): string | null {
  if ([...passphrase].length < MIN_PASSPHRASE) {
    return `master passphrase must be at least ${MIN_PASSPHRASE} characters`;
  }
  if (Buffer.byteLength(passphrase, "utf8") > 1024) return "master passphrase is too long";
  return null;
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(passphrase, salt);
}

function encrypt(values: Values, key: Buffer): VaultDisk["sealed"] {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(sealed: VaultDisk["sealed"], key: Buffer): Values {
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid vault payload");
  const values: Values = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!NAME_RE.test(name) || typeof value !== "string") throw new Error("invalid vault entry");
    values[name] = value;
  }
  return values;
}

function safeDisk(raw: unknown): VaultDisk {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("vault file is not an object");
  const d = raw as Partial<VaultDisk>;
  if (d.version !== 1 || typeof d.salt !== "string" || Buffer.from(d.salt, "base64").length !== SALT_BYTES || !Array.isArray(d.entries) || !d.sealed) {
    throw new Error("unsupported or malformed vault file");
  }
  if (d.entries.length > MAX_ENTRIES) throw new Error(`vault entry limit exceeded (${MAX_ENTRIES})`);
  const entries: Omit<VaultEntry, "usable">[] = [];
  const names = new Set<string>();
  for (const rawEntry of d.entries) {
    if (!rawEntry || typeof rawEntry !== "object") throw new Error("malformed vault entry metadata");
    const e = rawEntry as Partial<VaultEntry>;
    if (!validVaultName(e.name) || names.has(e.name) || (e.kind !== "variable" && e.kind !== "secret") || typeof e.description !== "string" || e.description.length > 240) {
      throw new Error("malformed vault entry metadata");
    }
    names.add(e.name);
    if (typeof e.configured !== "boolean" || typeof e.createdAt !== "string" || typeof e.updatedAt !== "string") {
      throw new Error("malformed vault entry metadata");
    }
    entries.push({
      name: e.name,
      kind: e.kind,
      description: e.description,
      configured: e.configured,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    });
  }
  const sealed = d.sealed as Partial<VaultDisk["sealed"]>;
  if (
    typeof sealed.iv !== "string" || Buffer.from(sealed.iv, "base64").length !== IV_BYTES ||
    typeof sealed.tag !== "string" || Buffer.from(sealed.tag, "base64").length !== 16 ||
    typeof sealed.data !== "string" || Buffer.from(sealed.data, "base64").length > 100 * 1024 * 1024
  ) {
    throw new Error("malformed encrypted vault payload");
  }
  return { version: 1, salt: d.salt, entries, sealed: { iv: sealed.iv, tag: sealed.tag, data: sealed.data } };
}

export function validVaultName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name) && !RESERVED.has(name);
}

function descriptionText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Encrypt, persist atomically, and set mode 0600 on every write. */
function persist(disk: VaultDisk): void {
  const file = vaultPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(disk, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/**
 * User-managed named values. The public methods never return a value.
 * `resolveForUse` and `redact` are runtime-only interfaces wired to execution
 * tools; the agent-facing `vault` tool only receives `list/define/remove`.
 */
export class VaultManager {
  #disk: VaultDisk | null = null;
  #key: Buffer | null = null;
  #values: Values = {};
  #initializing = false;

  constructor() {
    this.#loadMetadata();
  }

  get initialized(): boolean {
    return this.#disk !== null;
  }

  get unlocked(): boolean {
    return this.#key !== null;
  }

  #loadMetadata(): void {
    const file = vaultPath();
    if (!existsSync(file)) {
      this.#disk = null;
      return;
    }
    try {
      this.#disk = safeDisk(JSON.parse(readFileSync(file, "utf8")));
      chmodSync(file, 0o600);
    } catch {
      this.#disk = null;
    }
  }

  #metadata(): Omit<VaultEntry, "usable">[] {
    return this.#disk?.entries ?? [];
  }

  #writeWithValues(values: Values, entries = this.#metadata(), disk = this.#disk): void {
    if (!disk || !this.#key) throw new Error("vault is locked");
    const normalized = entries.map((e) => ({ ...e }));
    const sealed = encrypt(values, this.#key);
    const next: VaultDisk = { version: 1, salt: disk.salt, entries: normalized, sealed };
    persist(next);
    this.#disk = next;
    this.#values = { ...values };
  }

  status(): VaultStatus {
    if (!this.#disk) {
      const exists = existsSync(vaultPath());
      return {
        initialized: false,
        unlocked: false,
        entries: [],
        ...(exists ? { error: "vault file could not be read; values were not loaded" } : {}),
      };
    }
    return {
      initialized: true,
      unlocked: this.unlocked,
      entries: this.#disk.entries.map((e) => ({ ...e, usable: this.unlocked && e.configured })),
    };
  }

  list(): VaultEntry[] {
    return this.status().entries;
  }

  async initialize(passphrase: string): Promise<{ ok: boolean; error?: string }> {
    if (this.#disk || existsSync(vaultPath())) return { ok: false, error: "vault is already initialized" };
    if (this.#initializing) return { ok: false, error: "vault initialization is already in progress" };
    const problem = passphraseProblem(passphrase);
    if (problem) return { ok: false, error: problem };
    this.#initializing = true;
    let key: Buffer | null = null;
    try {
      const salt = randomBytes(SALT_BYTES);
      key = await deriveKey(passphrase, salt);
      // Another manager instance may have initialized the file while scrypt
      // ran; never silently replace its passphrase/ciphertext.
      if (existsSync(vaultPath())) return { ok: false, error: "vault is already initialized" };
      const empty: VaultDisk = { version: 1, salt: salt.toString("base64"), entries: [], sealed: encrypt({}, key) };
      persist(empty);
      this.#disk = empty;
      this.#key = key;
      this.#values = {};
      key = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `could not initialize vault: ${(err as Error).message}` };
    } finally {
      key?.fill(0);
      this.#initializing = false;
    }
  }

  async unlock(passphrase: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.#disk) {
      this.#loadMetadata();
      if (!this.#disk) return { ok: false, error: "vault is not initialized" };
    }
    const problem = passphraseProblem(passphrase);
    if (problem) return { ok: false, error: problem };
    const key = await deriveKey(passphrase, Buffer.from(this.#disk.salt, "base64"));
    try {
      const values = decrypt(this.#disk.sealed, key);
      const metadataNames = new Set(this.#disk.entries.map((e) => e.name));
      if (Object.keys(values).some((name) => !metadataNames.has(name))) throw new Error("unregistered value");
      this.lock();
      this.#key = key;
      this.#values = values;
      return { ok: true };
    } catch {
      key.fill(0);
      return { ok: false, error: "passphrase incorrect or vault data is damaged" };
    }
  }

  lock(): void {
    this.#key?.fill(0);
    this.#key = null;
    this.#values = {};
  }

  define(args: { name: string; kind: VaultKind; description: string }): { ok: boolean; entry?: VaultEntry; error?: string } {
    const name = args.name.trim();
    if (!validVaultName(name)) return { ok: false, error: "name must be an unused uppercase environment name, e.g. SERVICE_API_KEY; PATH/HOME/NODE_OPTIONS cannot be used" };
    if (args.kind !== "variable" && args.kind !== "secret") return { ok: false, error: "kind must be variable or secret" };
    const description = descriptionText(args.description);
    if (!description) return { ok: false, error: "description is required so the user knows what to enter" };
    if (this.#metadata().some((e) => e.name === name)) return { ok: false, error: `"${name}" already exists` };
    if (this.#metadata().length >= MAX_ENTRIES) return { ok: false, error: `vault entry limit reached (${MAX_ENTRIES})` };
    const now = new Date().toISOString();
    const entry = { name, kind: args.kind, description, configured: false, createdAt: now, updatedAt: now };
    if (!this.#disk) {
      // Metadata can be defined before the user initializes/unlocks the vault.
      // The first initialized encrypted payload will include empty values for
      // every defined entry.
      return { ok: false, error: "initialize the vault in Settings first, then define the entry" };
    }
    const entries = [...this.#disk.entries, entry];
    if (!this.unlocked) {
      const prior = this.#disk;
      this.#disk = { ...prior, entries };
      try {
        persist(this.#disk);
      } catch (err) {
        this.#disk = prior;
        return { ok: false, error: `could not save vault metadata: ${(err as Error).message}` };
      }
      return { ok: true, entry: { ...entry, usable: false } };
    }
    try {
      this.#writeWithValues(this.#values, entries);
      return { ok: true, entry: { ...entry, usable: false } };
    } catch (err) {
      return { ok: false, error: `could not save vault metadata: ${(err as Error).message}` };
    }
  }

  async setValue(name: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.#metadata().find((e) => e.name === name);
    if (!entry) return { ok: false, error: `no vault entry "${name}"` };
    if (!this.unlocked || !this.#key) return { ok: false, error: "unlock the vault in Settings before saving a value" };
    if (typeof value !== "string" || value.length === 0) return { ok: false, error: "value cannot be empty" };
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return { ok: false, error: "value is too large (64 KB max)" };
    const values = { ...this.#values, [name]: value };
    const entries = this.#metadata().map((e) => e.name === name ? { ...e, configured: true, updatedAt: new Date().toISOString() } : e);
    try {
      this.#writeWithValues(values, entries);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `could not save value for ${name}: ${(err as Error).message}` };
    }
  }

  remove(name: string, confirm: string): { ok: boolean; error?: string } {
    if (confirm !== name) return { ok: false, error: `repeat confirm: "${name}" to remove this vault entry` };
    const entry = this.#metadata().find((e) => e.name === name);
    if (!entry) return { ok: false, error: `no vault entry "${name}"` };
    if (entry.configured && !this.unlocked) return { ok: false, error: "unlock the vault in Settings before deleting a configured value" };
    const entries = this.#metadata().filter((e) => e.name !== name);
    const values = { ...this.#values };
    delete values[name];
    if (!this.#disk) return { ok: false, error: "vault is not initialized" };
    if (this.unlocked) {
      try {
        this.#writeWithValues(values, entries);
      } catch (err) {
        return { ok: false, error: `could not remove ${name}: ${(err as Error).message}` };
      }
    } else {
      const prior = this.#disk;
      this.#disk = { ...prior, entries };
      try {
        persist(this.#disk);
      } catch (err) {
        this.#disk = prior;
        return { ok: false, error: `could not remove ${name}: ${(err as Error).message}` };
      }
    }
    return { ok: true };
  }

  /** Runtime-only: return selected environment variables, never a list of all values. */
  resolveForUse(names: string[]): VaultResolveResult {
    const wanted = [...new Set(names)];
    if (wanted.length === 0) return { ok: true, env: {} };
    if (!this.unlocked) return { ok: false, error: "vault is locked — unlock it in Settings before using these entries" };
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of wanted) {
      const entry = this.#metadata().find((e) => e.name === name);
      if (!entry || !entry.configured || this.#values[name] === undefined) missing.push(name);
      else env[name] = this.#values[name]!;
    }
    return missing.length ? { ok: false, missing } : { ok: true, env };
  }

  /** Best-effort exact-value echo masking, before anything reaches the model. */
  redact(text: string): string {
    let out = text;
    const replacements = this.#metadata()
      .filter((e) => e.configured && this.#values[e.name])
      .map((e) => ({ name: e.name, value: this.#values[e.name]! }))
      .sort((a, b) => b.value.length - a.value.length);
    for (const { name, value } of replacements) {
      out = out.split(value).join(`[redacted:${name}]`);
    }
    return out;
  }

  reset(confirm: string): { ok: boolean; error?: string } {
    if (confirm !== "RESET VAULT") return { ok: false, error: 'type "RESET VAULT" to delete the encrypted vault and all its metadata' };
    this.lock();
    try {
      if (existsSync(vaultPath())) {
        rmSync(vaultPath(), { force: true });
      }
      this.#disk = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `could not reset vault: ${(err as Error).message}` };
    }
  }

  close(): void {
    this.lock();
  }
}

/** Interface wired to tools; no public getter for value material. */
export interface VaultCtl {
  list(): VaultEntry[];
  define(args: { name: string; kind: VaultKind; description: string }): { ok: boolean; entry?: VaultEntry; error?: string };
  remove(name: string, confirm: string): { ok: boolean; error?: string };
  resolveForUse(names: string[]): VaultResolveResult;
  redact(text: string): string;
}

/** Agent-facing manager tool: metadata only, never accepts a value. */
export function vaultToolSpec(): import("./tools.js").ToolSpec {
  return {
    name: "vault",
    dynamic: true,
    description:
      "Set up named task variables/secrets without seeing their values. You can list names/status, define a missing name and explain what the user should enter in Settings → System → Secrets, or remove an entry. NEVER ask the user to paste a value into chat, a tool argument, a command or source code. The user-only Settings input is the only write path for values. Use the entry name as the environment variable reference for `exec`/self-tools. Values are injected only when explicitly requested.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "define", "delete"], description: "list status, define metadata only, or delete." },
        name: { type: "string", description: "Uppercase env-style name, e.g. SERVICE_API_KEY." },
        kind: { type: "string", enum: ["variable", "secret"], description: "Whether the value is a normal variable or credential." },
        description: { type: "string", description: "What the user should enter and what it is for. Never put the value here." },
      },
      required: ["action"],
    },
    async run(args, ctx) {
      const vault = ctx.vault;
      if (!vault) return "error: vault service is not available";
      const action = String(args["action"] ?? "").toLowerCase();
      const name = String(args["name"] ?? "").trim();
      if (action === "list") {
        const entries = vault.list();
        if (entries.length === 0) return "vault is empty — define a name, then the user enters its value in Settings → System → Secrets";
        const status = entries.map((e) => `- ${e.name} · ${e.configured ? "configured" : "missing"} · ${e.description}`).join("\n");
        return `Vault metadata only — values are never returned.\n${status}`;
      }
      if (action === "define") {
        if (!name) return "error: name is required";
        const kind = String(args["kind"] ?? "secret") as VaultKind;
        const description = String(args["description"] ?? "");
        const result = vault.define({ name, kind, description });
        if (!result.ok) return `error: ${result.error}`;
        return `Defined ${name} (${kind}). Ask the user to enter its value at Settings → System → Secrets. The value is not accepted in chat and will not appear in your context.`;
      }
      if (action === "delete") {
        if (!name) return "error: name is required";
        const result = vault.remove(name, name);
        return result.ok ? `Removed ${name}; the vault returned no value.` : `error: ${result.error}`;
      }
      return `error: unknown action "${action}" — use list, define or delete`;
    },
  };
}
