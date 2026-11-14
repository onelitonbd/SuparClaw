// Task 58 — tools the agent writes for itself.
//
// The ask: *"i want the ai to create tools for itself and load them into its
// context so that it can create a tool if it needs and keep it for later
// uses."* A skill can hold a procedure, but a procedure that has to run the
// same parsing/arithmetic/API dance every time is better as code. Until now the
// agent's only road to new code was `exec` — a fresh process per call, no
// schema, no name, nothing the model could call twice the same way.
//
// A self-tool is:
//
//   ~/.suparclaw/tools/<name>.mjs    the code the model wrote
//   ~/.suparclaw/tools/<name>.json   its manifest: name, description,
//                                    parameters — what the registry needs to
//                                    put the tool in front of the model
//
// Two files on purpose. The manifest is what the registry reads at build time,
// so loading the tool list never executes generated code; the `.mjs` is loaded
// only to run it — and always inside a worker thread, so a tool that throws,
// loops forever or calls `process.exit()` costs one worker and a line in the
// transcript instead of the daemon.
//
// The manifest is derived, never hand-written: `create` imports the module in
// describe mode, reads name/description/parameters off the exported object, and
// refuses to save a tool it could not describe. That is the same rule upstream
// applies at build time ("never execute plugin code to infer missing manifest
// data") adapted to a tool created at runtime: the code runs once, in
// isolation, at creation — not on every boot.
//
// State dir, not workspace: a self-tool is a capability of the daemon. A code
// session works in a git worktree somewhere else, and a tool built there must
// still exist when the session ends.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { JsonSchema, ToolContext, ToolSpec } from "./tools.js";
import type { SuparClawConfig } from "../config/schema.js";
import { validVaultName, type VaultCtl } from "./vault.js";
import { toolsDir } from "../util/paths.js";

/** Tool names must survive being a filename, a callback id and an API name. */
export const SELF_TOOL_NAME = /^[a-z][a-z0-9_]{2,31}$/;

/** A tool's code is a module, not a project. 40 KB is ~1200 lines. */
export const MAX_CODE_BYTES = 40_000;

/** Per-call output cap, same order as the other tools (60k chars). */
const MAX_OUTPUT = 60_000;

export interface SelfToolManifest {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Named vault entries the module is allowed to receive in its worker env. */
  vault: string[];
  /** ISO timestamps — `list` shows them, `update` keeps `created`. */
  created: string;
  updated: string;
  testedAt?: string;
  /** Last failure, kept so `list` can show a tool that has rotted. */
  lastError?: string;
  timeoutMs?: number;
}

export interface SelfToolRecord {
  manifest: SelfToolManifest;
  file: string;
  manifestFile: string;
}

/* ------------------------------------------------------------------ files --- */

export function selfToolFile(name: string): string {
  return join(toolsDir(), `${name}.mjs`);
}

function manifestFile(name: string): string {
  return join(toolsDir(), `${name}.json`);
}

function ensureToolDir(): string {
  const dir = toolsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Why this name is not usable, or `null` when it is.
 *
 * The character class is deliberately narrow: the same string becomes a
 * filename, a tool name on the wire and (for a callback) a 64-byte id.
 */
export function selfToolNameProblem(name: string, opts: { reserved?: Set<string>; taken?: string[] } = {}): string | null {
  if (!SELF_TOOL_NAME.test(name)) {
    return "name must be 3-32 characters: lowercase letters, digits and underscores, starting with a letter (e.g. `word_freq`)";
  }
  if ((opts.reserved ?? new Set()).has(name)) {
    return `"${name}" is a built-in tool — pick a name that is not already in your tool list`;
  }
  if ((opts.taken ?? []).includes(name)) return `"${name}" already exists — use action "update" to change it`;
  return null;
}

/* --------------------------------------------------------------- manifests --- */

function validManifest(value: unknown): value is SelfToolManifest {
  const m = value as SelfToolManifest | null;
  if (!m || typeof m !== "object") return false;
  if (typeof m.name !== "string" || !SELF_TOOL_NAME.test(m.name)) return false;
  if (typeof m.description !== "string" || !m.description.trim()) return false;
  const p = m.parameters as JsonSchema | undefined;
  if (!p || typeof p !== "object" || p.type !== "object" || typeof p.properties !== "object") return false;
  // T58 manifests predate the vault field; treat them as declaring no values.
  if (m.vault !== undefined && (!Array.isArray(m.vault) || m.vault.some((name) => !validVaultName(name)))) return false;
  return true;
}

/**
 * Every saved tool, plus a line for each file that could not be read.
 *
 * A broken manifest must not take the tool list with it: the reason is kept and
 * shown by `list`, so a half-written file is a visible problem instead of a
 * missing capability.
 */
export function listSelfTools(): { tools: SelfToolRecord[]; problems: string[] } {
  const dir = toolsDir();
  const tools: SelfToolRecord[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { tools, problems };
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    return { tools, problems: [`could not read ${dir}: ${(err as Error).message}`] };
  }
  const manifestNames = new Set(entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5)));
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`${entry}: ${(err as Error).message}`);
      continue;
    }
    if (!validManifest(parsed)) {
      problems.push(`${entry}: not a valid manifest (needs name, description and an object \`parameters\`)`);
      continue;
    }
    const manifest: SelfToolManifest = { ...parsed, vault: parsed.vault ?? [] };
    const code = selfToolFile(manifest.name);
    if (!existsSync(code)) {
      problems.push(`${manifest.name}: manifest exists but ${manifest.name}.mjs is missing — recreate it or delete it`);
      continue;
    }
    tools.push({ manifest, file: code, manifestFile: file });
  }
  // A crash between the module and manifest renames can leave code with no
  // contract. Do not silently pretend it was saved; list it as repairable.
  for (const entry of entries) {
    if (entry.endsWith(".mjs") && !entry.startsWith(".") && !manifestNames.has(entry.slice(0, -4))) {
      problems.push(`${entry}: module has no manifest — recreate it with toolsmith or delete it`);
    }
  }
  return { tools, problems };
}

/** Names of every saved tool whose manifest is readable — cheap, no import. */
export function selfToolManifestNames(): string[] {
  return listSelfTools().tools.map((t) => t.manifest.name);
}

export function readSelfTool(name: string): { record?: SelfToolRecord; error?: string } {
  const { tools, problems } = listSelfTools();
  const found = tools.find((t) => t.manifest.name === name);
  if (found) return { record: found };
  const problem = problems.find((p) => p.startsWith(`${name}`));
  return { error: problem ?? `no self-tool named "${name}" — action "list" shows what exists` };
}

function writeManifest(manifest: SelfToolManifest): void {
  ensureToolDir();
  const file = manifestFile(manifest.name);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/* ----------------------------------------------------------------- worker --- */

/**
 * The worker bootstrap.
 *
 * `eval: true` runs this as CommonJS, so `require` is native and the dynamic
 * `import()` of the tool's `.mjs` is the only ES-module hop. Everything the tool
 * does happens in here: a crash, a `process.exit()`, or an infinite loop costs
 * this worker and nothing else (verified: the daemon keeps running, and the
 * timeout terminates the thread).
 *
 * `console.*` is captured rather than written to the daemon's stdout — a tool
 * that logs is debugging itself, and those lines belong in the tool result,
 * where the model can see them and fix the code.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const logs = [];
const render = (v) => {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...parts) => { logs.push(level + ": " + parts.map(render).join(" ")); };
}
(async () => {
  try {
    const mod = await import(workerData.file);
    const tool = mod.default ?? mod.tool;
    if (!tool || typeof tool !== "object") {
      throw new Error("the module must \\\`export default { name, description, parameters, run }\\\`");
    }
    if (workerData.mode === "describe") {
      if (typeof tool.run !== "function") throw new Error("\\\`run\\\` must be a function (it is what the agent calls)");
      parentPort.postMessage({
        ok: true,
        logs,
        meta: { name: tool.name, description: tool.description, parameters: tool.parameters, vault: tool.vault ?? [] },
      });
      return;
    }
    const out = await tool.run(workerData.args ?? {}, workerData.ctx ?? {});
    parentPort.postMessage({ ok: true, logs, output: out === undefined || out === null ? "" : String(out) });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      logs,
      error: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack) : "",
    });
  }
})();
`;

export interface SelfToolCall {
  ok: boolean;
  output?: string;
  error?: string;
  stack?: string;
  logs?: string[];
  meta?: { name?: unknown; description?: unknown; parameters?: unknown; vault?: unknown };
}

/** The self-tool worker does not inherit provider/API secrets from the daemon. */
function selfToolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "PREFIX", "TMPDIR", "TMP", "TEMP", "TERM", "TERMUX_VERSION", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "SHELL", "SUPARCLAW_HOME"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

/** Run one module in its own thread and wait for its single answer. */
export function runSelfToolWorker(
  file: string,
  mode: "describe" | "run",
  args: Record<string, unknown>,
  ctx: { workspace?: string; stateDir?: string; sessionKey?: string },
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<SelfToolCall> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    const finish = (value: SelfToolCall): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `timed out after ${Math.round(timeoutMs / 1000)}s — the tool was stopped; the daemon is unaffected`,
        }),
      Math.max(1000, timeoutMs),
    );
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { file: pathToFileURL(file).href, mode, args, ctx },
        // Pass a minimal, deliberate environment. Provider keys in the daemon's
        // process.env are not inherited; only manifest-declared vault entries
        // are added for a run. This reduces accidental access, not same-user
        // filesystem/process attacks (the module is not a sandbox).
        env: selfToolEnv(extraEnv),
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      resolve({ ok: false, error: `could not start a worker for ${file}: ${(err as Error).message}` });
      return;
    }
    worker.on("message", (message: SelfToolCall) => finish(message));
    worker.on("error", (err) => finish({ ok: false, error: `the tool crashed: ${err.message}`, stack: err.stack }));
    worker.on("exit", (code) => finish({ ok: false, error: `the tool ended the worker (exit ${code}) before answering` }));
  });
}

/* ---------------------------------------------------------------- describe --- */

interface Described {
  ok: boolean;
  error?: string;
  stack?: string;
  manifest?: { name: string; description: string; parameters: JsonSchema; vault: string[] };
}

/**
 * Import the module once, in a worker, and read its contract off the exported
 * object. This is the only moment generated code runs unasked — which is why it
 * is also the moment a broken tool is refused instead of saved.
 */
async function describeCode(code: string, timeoutMs: number): Promise<Described> {
  const dir = ensureToolDir();
  const staged = join(dir, `.staging-${process.pid}-${Date.now().toString(36)}.mjs`);
  writeFileSync(staged, code, { encoding: "utf8", mode: 0o600 });
  try {
    const result = await runSelfToolWorker(staged, "describe", {}, {}, timeoutMs);
    if (!result.ok) return { ok: false, error: result.error ?? "the tool could not be loaded", stack: result.stack };
    const meta = result.meta ?? {};
    return { ok: true, manifest: validateShape(meta) };
  } finally {
    try {
      rmSync(staged, { force: true });
    } catch {
      /* the file is in a temp dir we own; a leftover is not worth a failure */
    }
  }
}

/** Shape rules the registry and every provider will hold the manifest to. */
function validateShape(meta: { name?: unknown; description?: unknown; parameters?: unknown; vault?: unknown }): { name: string; description: string; parameters: JsonSchema; vault: string[] } {
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!name) throw new Error("the module's `name` must be a non-empty string");
  if (!SELF_TOOL_NAME.test(name)) {
    throw new Error(`the module's name "${name}" is not usable: 3-32 characters, lowercase letters, digits and underscores, starting with a letter`);
  }
  const description = typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
  if (!description) throw new Error("the module's `description` must say what the tool does and when to use it");
  if (description.length > 400) throw new Error(`the description is ${description.length} characters — keep it under 400`);
  const p = meta.parameters as JsonSchema | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("`parameters` must be a JSON Schema object");
  if (p.type !== "object") throw new Error('`parameters.type` must be "object"');
  if (!p.properties || typeof p.properties !== "object" || Array.isArray(p.properties)) {
    throw new Error("`parameters.properties` must be an object (use {} for a tool that takes no arguments)");
  }
  const required = p.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => typeof r !== "string")) {
      throw new Error("`parameters.required` must be an array of property names");
    }
    for (const key of required) {
      if (!(key in p.properties)) throw new Error(`\`parameters.required\` names "${key}", which is not in \`properties\``);
    }
  }
  const vaultRaw = meta.vault === undefined ? [] : meta.vault;
  if (!Array.isArray(vaultRaw) || vaultRaw.some((item) => !validVaultName(item))) {
    throw new Error("optional `vault` must be an array of declared uppercase vault entry names");
  }
  const vault = [...new Set(vaultRaw as string[])];
  return { name, description, parameters: { type: "object", properties: p.properties as Record<string, unknown>, ...(required ? { required } : {}) }, vault };
}

/* ------------------------------------------------------------ create/update --- */

export interface SaveResult {
  ok: boolean;
  name: string;
  manifest?: SelfToolManifest;
  error?: string;
  stack?: string;
}

function checkEnabled(config: SuparClawConfig): string | null {
  if (!config.tools.selfTools.enabled) {
    return "error: self-tools are switched off (tools.selfTools.enabled=false) — say so; do not try to work around it";
  }
  return null;
}

export async function saveSelfTool(opts: {
  name: string;
  code: string;
  config: SuparClawConfig;
  reserved?: Set<string>;
  /** update = the tool must already exist; create = it must not. */
  mode: "create" | "update";
}): Promise<SaveResult> {
  const { name, code, config, mode } = opts;
  const refused = checkEnabled(config);
  if (refused) return { ok: false, name, error: refused };
  if (typeof code !== "string" || !code.trim()) return { ok: false, name, error: "error: `code` is required — the full module source" };
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return { ok: false, name, error: `error: the code is larger than ${MAX_CODE_BYTES} bytes — split the work into a smaller tool` };
  }

  const { tools, problems } = listSelfTools();
  const taken = tools.map((t) => t.manifest.name);
  const nameProblem = selfToolNameProblem(name, { reserved: opts.reserved, taken: mode === "create" ? taken : [] });
  if (nameProblem) return { ok: false, name, error: `error: ${nameProblem}` };
  if (mode === "update" && !taken.includes(name)) {
    return { ok: false, name, error: `error: no self-tool named "${name}" — use action "create"` };
  }
  if (mode === "create" && tools.length >= config.tools.selfTools.maxTools) {
    return {
      ok: false,
      name,
      error: `error: ${tools.length} self-tools is the cap (tools.selfTools.maxTools=${config.tools.selfTools.maxTools}) — delete one you no longer use, or raise the cap`,
    };
  }
  // A half-written file from an earlier crash must not block the same name
  // forever; `list` already reported it.
  void problems;

  const timeoutMs = config.tools.selfTools.timeoutMs;
  let described: Described;
  try {
    described = await describeCode(code, timeoutMs);
  } catch (err) {
    return { ok: false, name, error: `error: ${(err as Error).message}` };
  }
  if (!described.ok || !described.manifest) {
    return { ok: false, name, error: `error: the tool does not load — ${described.error}`, stack: described.stack };
  }
  if (described.manifest.name !== name) {
    return {
      ok: false,
      name,
      error: `error: the module exports name "${described.manifest.name}" but you asked for "${name}" — they must match, or the file and the tool list disagree`,
    };
  }

  const now = new Date().toISOString();
  const previous = tools.find((t) => t.manifest.name === name)?.manifest;
  const manifest: SelfToolManifest = {
    name,
    description: described.manifest.description,
    parameters: described.manifest.parameters,
    vault: described.manifest.vault,
    created: previous?.created ?? now,
    updated: now,
    ...(previous?.testedAt ? { testedAt: previous.testedAt } : {}),
    ...(previous?.lastError ? { lastError: previous.lastError } : {}),
  };
  const dir = ensureToolDir();
  const file = selfToolFile(name);
  const tmp = join(dir, `.${name}.mjs.tmp-${process.pid}`);
  writeFileSync(tmp, code, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  writeManifest(manifest);
  return { ok: true, name, manifest };
}

export function deleteSelfTool(name: string): { ok: boolean; error?: string } {
  const { record, error } = readSelfTool(name);
  if (!record) return { ok: false, error: error ?? `no self-tool named "${name}"` };
  rmSync(record.file, { force: true });
  rmSync(record.manifestFile, { force: true });
  return { ok: true };
}

/* -------------------------------------------------------------------- run --- */

export interface RunOutcome {
  ok: boolean;
  output: string;
}

function withLogs(text: string, logs: string[] | undefined): string {
  if (!logs || logs.length === 0) return text;
  const body = logs.join("\n").slice(0, 4000);
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n[console]\n${body}`;
}

/**
 * Call one self-tool. The only entry point used by both the registry (a normal
 * tool call) and `toolsmith test/run` (the same execution, from the tool that
 * made it) — so "it worked in the test" and "it works" cannot mean two things.
 */
export async function runSelfTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { workspace?: string; stateDir?: string; sessionKey?: string },
  config: SuparClawConfig,
  override?: { timeoutMs?: number },
  vault?: VaultCtl,
): Promise<RunOutcome> {
  const refused = checkEnabled(config);
  if (refused) return { ok: false, output: refused };
  const { record, error } = readSelfTool(name);
  if (!record) return { ok: false, output: `error: ${error}` };
  const timeoutMs = Math.min(override?.timeoutMs ?? record.manifest.timeoutMs ?? config.tools.selfTools.timeoutMs, 300_000);
  const resolved = record.manifest.vault.length
    ? vault?.resolveForUse(record.manifest.vault)
    : { ok: true as const, env: {} };
  if (!resolved?.ok) {
    return { ok: false, output: resolved?.missing?.length
      ? `error: ${name} needs configured vault entries: ${resolved.missing.join(", ")} — the user enters them in Settings → System → Secrets`
      : `error: ${resolved?.error ?? "vault service is not available"}` };
  }
  const result = await runSelfToolWorker(record.file, "run", args, ctx, timeoutMs, resolved.env ?? {});
  if (!result.ok) {
    const stack = result.stack ? `\n${result.stack.split("\n").slice(0, 6).join("\n")}` : "";
    const safeLogs = result.logs?.map((line) => vault?.redact(line) ?? line);
    const failed = withLogs(`error: ${name} failed — ${result.error ?? "no answer from the tool"}${stack}`, safeLogs);
    const safeFailure = vault?.redact(failed) ?? failed;
    return { ok: false, output: safeFailure.slice(0, MAX_OUTPUT) };
  }
  const rawText = result.output ?? "";
  const text = (vault?.redact(rawText) ?? rawText).slice(0, MAX_OUTPUT) || "(no output)";
  const safeLogs = result.logs?.map((line) => vault?.redact(line) ?? line);
  const output = withLogs(text, safeLogs);
  const redacted = vault?.redact(output) ?? output;
  return { ok: true, output: redacted.slice(0, MAX_OUTPUT) };
}

/* ------------------------------------------------------------------ specs --- */

/**
 * The registry's view: one `ToolSpec` per saved manifest.
 *
 * The manifest is the contract, so building the tool list costs a few small
 * JSON reads and never imports generated code. `reserved` keeps a made tool
 * from shadowing a built-in (two functions with one name is an invalid request
 * to every provider).
 */
export function selfToolSpecs(config: SuparClawConfig, reserved: Set<string> = new Set()): ToolSpec[] {
  if (!config.tools.selfTools.enabled) return [];
  const { tools } = listSelfTools();
  const specs: ToolSpec[] = [];
  const seen = new Set(reserved);
  for (const { manifest } of tools) {
    if (seen.has(manifest.name)) continue;
    seen.add(manifest.name);
    specs.push({
      name: manifest.name,
      selfAuthored: true,
      description: manifest.vault.length
        ? `${manifest.description} Uses vault entries: ${manifest.vault.join(", ")}. Their values are never shown in the tool list.`
        : manifest.description,
      parameters: manifest.parameters,
      async run(args, ctx: ToolContext) {
        const outcome = await runSelfTool(
          manifest.name,
          args,
          { workspace: ctx.workspace, stateDir: ctx.stateDir, sessionKey: ctx.sessionKey },
          ctx.config,
          undefined,
          ctx.vault,
        );
        return outcome.output;
      },
    });
  }
  return specs;
}

/* ------------------------------------------------------------------ test --- */

/**
 * Run the tool for real, then re-read its contract from the file.
 *
 * The second half matters: the manifest is what the model's tool list says, and
 * the code is what runs. If someone edits the `.mjs` (the model itself, via
 * `update`, or a person with an editor), those can drift. `test` re-derives the
 * manifest from the code that just ran, so the description the model reads is
 * the description of the thing that answered.
 */
export async function testSelfTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { workspace?: string; stateDir?: string; sessionKey?: string },
  config: SuparClawConfig,
  override?: { timeoutMs?: number },
  vault?: VaultCtl,
): Promise<{ ok: boolean; output: string }> {
  const { record, error } = readSelfTool(name);
  if (!record) return { ok: false, output: `error: ${error}` };

  const started = Date.now();
  const outcome = await runSelfTool(name, args, ctx, config, override, vault);
  const ms = Date.now() - started;

  const timeoutMs = override?.timeoutMs ?? record.manifest.timeoutMs ?? config.tools.selfTools.timeoutMs;
  let described: Described;
  try {
    described = await describeCode(readFileSync(record.file, "utf8"), Math.min(timeoutMs, 30_000));
  } catch (err) {
    described = { ok: false, error: (err as Error).message };
  }

  const now = new Date().toISOString();
  const next: SelfToolManifest = { ...record.manifest, testedAt: now };
  const describeProblem = !described.ok || !described.manifest
    ? (described.error ?? "the tool no longer loads")
    : described.manifest.name !== name
      ? `the module now exports name "${described.manifest.name}" — the file and the tool list disagree`
      : "";
  if (describeProblem) {
    next.lastError = describeProblem;
  } else if (described.manifest) {
    next.description = described.manifest.description;
    next.parameters = described.manifest.parameters;
    next.vault = described.manifest.vault;
  }
  // A run that failed is the headline: `list` must show the tool that rotted,
  // not the one that "was tested". Keep the first line — the manifest is a
  // one-line summary, the transcript has the rest.
  if (!outcome.ok) {
    next.lastError = (outcome.output.replace(/^error:\s*/, "").split("\n")[0] ?? "").slice(0, 300);
  } else if (!describeProblem) {
    delete next.lastError;
  }
  writeManifest(next);

  const drift = described.ok && described.manifest?.name === name ? "" : `\n[manifest not refreshed: ${next.lastError}]`;
  return {
    ok: outcome.ok,
    output: `${outcome.output}\n\n[test] ${name} ${outcome.ok ? "ran" : "FAILED"} in ${ms} ms${drift}`,
  };
}

/* -------------------------------------------------------------- toolsmith --- */

function parseArgsInput(raw: unknown, json: unknown): { ok: boolean; args: Record<string, unknown>; error?: string } {
  if (typeof json === "string" && json.trim()) {
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, args: {}, error: "`json` must be a JSON object of arguments" };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch (err) {
      return { ok: false, args: {}, error: `\`json\` is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ok: true, args: raw as Record<string, unknown> };
  return { ok: true, args: {} };
}

function formatList(config: SuparClawConfig): string {
  const { tools, problems } = listSelfTools();
  const cap = config.tools.selfTools.maxTools;
  const lines: string[] = [];
  lines.push(`self-tools (${tools.length}/${cap})${tools.length === 0 ? " — none yet" : ""}`);
  for (const { manifest } of tools) {
    const tested = manifest.lastError
      ? `last run FAILED: ${manifest.lastError.split("\n")[0]?.slice(0, 120)}`
      : manifest.testedAt
        ? `tested ${manifest.testedAt.slice(0, 16).replace("T", " ")}`
        : "never tested — run `test` before you rely on it";
    const fields = Object.keys(manifest.parameters.properties ?? {}).join(", ") || "no arguments";
    lines.push(`- ${manifest.name} (${fields})${manifest.vault.length ? ` · vault: ${manifest.vault.join(", ")}` : ""} · ${manifest.description} · ${tested}`);
  }
  if (problems.length > 0) {
    lines.push("", "files that could not be loaded:");
    for (const p of problems) lines.push(`- ${p}`);
  }
  if (tools.length > 0) lines.push("", `stored in ${toolsDir()}`);
  return lines.join("\n");
}

export function toolsmithSpec(config: SuparClawConfig, reserved: () => Set<string>): ToolSpec {
  return {
    name: "toolsmith",
    selfAuthored: true,
    description:
      "Write a tool for YOURSELF, test it, and keep it. Use this when the same piece of real work will happen " +
      "again and code does it better than prose: parsing a file, arithmetic, an API shape, a format conversion, " +
      "a check you keep repeating. A created tool joins your own tool list immediately, so you can call it " +
      "like any other tool in the same turn — and `run`/`test` calls it directly. " +
      "The module you write is ESM: `export default { name, description, parameters, run, vault? }` where `run(args, ctx)` " +
      "may use `vault: [\"SERVICE_API_KEY\"]` to request named values; the user enters those only in Settings. " +
      "returns a string and may be async. `parameters` is a JSON Schema object (`{ type: \"object\", properties: {...} }`). " +
      "The description you give it is what future-you reads in the tool list, so write when to use it there. " +
      "Actions: create (name + code), update (name + code), test (name + args — runs it and re-records its manifest), " +
      "run (name + args — runs it without touching the manifest), list, show (name — the source), delete (name). " +
      "The skill `self-tools` has the full method; read it with skill_read before writing a non-trivial tool.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "test", "run", "list", "show", "delete"],
          description: "create/update save code; test/run execute; list/show/delete manage.",
        },
        name: { type: "string", description: "Tool name: 3-32 chars, lowercase letters, digits, underscores." },
        code: {
          type: "string",
          description: "The full module source (create/update). Must export default { name, description, parameters, run }.",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool's run() (test/run).",
          additionalProperties: true,
        },
        json: { type: "string", description: "Same as args, as a JSON object string (if your surface struggles with nested objects)." },
        timeoutMs: { type: "integer", description: "test/run timeout in ms (default tools.selfTools.timeoutMs, max 300000)." },
      },
      required: ["action"],
    },
    async run(args, ctx) {
      const action = String(args["action"] ?? "").trim().toLowerCase();
      const name = String(args["name"] ?? "").trim();
      const toolCtx = { workspace: ctx.workspace, stateDir: ctx.stateDir, sessionKey: ctx.sessionKey };
      const parsed = parseArgsInput(args["args"], args["json"]);
      if (!parsed.ok) return `error: ${parsed.error}`;
      const override = Number.isFinite(Number(args["timeoutMs"])) && Number(args["timeoutMs"]) > 0
        ? { timeoutMs: Math.min(Number(args["timeoutMs"]), 300_000) }
        : undefined;

      switch (action) {
        case "list":
          return formatList(config);

        case "show": {
          if (!name) return "error: name is required";
          const { record, error } = readSelfTool(name);
          if (!record) return `error: ${error}`;
          const m = record.manifest;
          const schema = JSON.stringify(m.parameters, null, 2);
          return [
            `${m.name} — ${m.description}`,
            `created ${m.created.slice(0, 16).replace("T", " ")} · updated ${m.updated.slice(0, 16).replace("T", " ")}` +
              (m.testedAt ? ` · tested ${m.testedAt.slice(0, 16).replace("T", " ")}` : " · never tested"),
            `file ${record.file}`,
            "parameters: " + schema,
            "",
            readFileSync(record.file, "utf8"),
          ].join("\n");
        }

        case "create":
        case "update": {
          if (!name) return "error: name is required";
          const code = typeof args["code"] === "string" ? args["code"] : "";
          const saved = await saveSelfTool({ name, code, config, reserved: reserved(), mode: action });
          if (!saved.ok) return [saved.error, saved.stack ? `\n${saved.stack.split("\n").slice(0, 6).join("\n")}` : ""].join("");
          ctx.refreshTools?.();
          const fields = Object.keys(saved.manifest?.parameters.properties ?? {});
          return [
            `${action === "create" ? "Created" : "Updated"} self-tool ${name}.`,
            `description: ${saved.manifest?.description}`,
            `arguments: ${fields.length > 0 ? fields.join(", ") : "(none)"}`,
            `vault entries: ${saved.manifest?.vault.length ? saved.manifest.vault.join(", ") : "none"}`,
            `file: ${selfToolFile(name)}`,
            "",
            "Next: call it once with realistic arguments — `toolsmith test` with `args` — and read what comes back. " +
              "It is in your own tool list from now on: call it by name in this turn, or in any later one.",
          ].join("\n");
        }

        case "test": {
          if (!name) return "error: name is required";
          const result = await testSelfTool(name, parsed.args, toolCtx, config, override, ctx.vault);
          return result.output;
        }

        case "run": {
          if (!name) return "error: name is required";
          const result = await runSelfTool(name, parsed.args, toolCtx, config, override, ctx.vault);
          return result.output;
        }

        case "delete": {
          if (!name) return "error: name is required";
          const removed = deleteSelfTool(name);
          if (!removed.ok) return `error: ${removed.error}`;
          ctx.refreshTools?.();
          return `Deleted ${name}. It is gone from the live tool list before the next model call.`;
        }

        default:
          return `error: unknown action "${action}" — use create, update, test, run, list, show or delete`;
      }
    },
  };
}
