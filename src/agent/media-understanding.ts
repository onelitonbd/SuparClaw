/**
 * P3 (row Missing!#22) — media understanding engine (their nodes/media-
 * understanding + nodes/audio contract, ported):
 *
 *  - ordered media facts in, per-capability selection (default: FIRST
 *    matching attachment only), capability model list with provider and CLI
 *    entries, failure → next entry, all-fail → `failed` and the attachment
 *    stays eligible for normal native delivery — errors NEVER block the
 *    reply (their standing rule)
 *  - image: provider entry = content-part prompt to a vision-capable chat
 *    endpoint; success → Body gains an `[Image] <description>` block and
 *    the caption survives as `User text:` inside it
 *  - audio: provider entry = OpenAI-compatible /audio/transcriptions; CLI
 *    entries run templated commands ({{AttachmentPath}} etc); success →
 *    `[Audio] <transcript>` block + transcript surfaced separately; empty
 *    transcript = silence → omitted, not failed (their batch rule)
 *  - pdf: extraction fallback (util/pdf-text) — the agent-facing `pdf` tool
 *    contract; CLIs via capability "pdf" entries
 *  - auto-detection when no explicit models: configured-provider auth beats
 *    local CLIs (their audio rule); the active reply provider goes first
 *
 * Everything here is dependency-injected so tests never touch a network or
 * spawn a process.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { extractPdfFile } from "../util/pdf-text.js";

export type MediaCapability = "image" | "audio" | "pdf";

export interface MediaFact {
  kind: MediaCapability | "video" | "other";
  path: string;
  url?: string;
  contentType?: string;
  name?: string;
}

export interface MediaModelEntry {
  /** provider (default) | cli (their two entry kinds). */
  type?: "provider" | "cli";
  provider?: string;
  model?: string;
  command?: string;
  args?: string[];
  prompt?: string;
  maxChars?: number;
  maxBytes?: number;
  timeoutSeconds?: number;
  language?: string;
  capabilities: MediaCapability[];
}

export interface CapabilityControl {
  enabled?: boolean;
  preferredModel?: string;
  prompt?: string;
  maxChars?: number;
  maxBytes?: number;
  timeoutSeconds?: number;
  language?: string;
  attachments?: { mode?: "first" | "all"; maxAttachments?: number };
  echoTranscript?: boolean;
  echoFormat?: string;
}

export interface ToolsMediaConfig {
  concurrency: number;
  models: MediaModelEntry[];
  image: CapabilityControl;
  audio: CapabilityControl;
  pdf: CapabilityControl;
}

export interface MediaOutcome {
  fact: MediaFact;
  capability: MediaCapability;
  status: "completed" | "omitted" | "failed";
  text?: string;
  /** What failed across the tried entries (aggregate, their warning shape). */
  error?: string;
}

export interface MediaEngineDeps {
  /** provider image entry: (dataUri, prompt, model?, timeoutMs) → text. */
  describeImage: (dataUri: string, prompt: string, model: string | undefined, timeoutMs: number) => Promise<string>;
  /** provider audio entry: OpenAI-compatible transcription. */
  transcribeAudio: (file: { path: string; mime: string; model: string; providerAuth: { baseUrl: string; apiKey: string }; language?: string; timeoutMs: number }) => Promise<string>;
  /** CLI entry execution (capture stdout on exit 0, throw otherwise). */
  runCli: (command: string, args: string[], timeoutMs: number) => Promise<string>;
  /** pdf extraction (defaults to util/pdf-text). */
  extractPdf?: typeof extractPdfFile;
  /** Active reply provider, for auto-detection. */
  replyProvider?: { baseUrl: string; apiKey: string; model: string };
  /** Everything configured usable for provider auto-detection (id+auth). */
  providerAuths?: { id: string; baseUrl: string; apiKey: string }[];
  /** PATH probing for audio CLI auto-detect. */
  hasCommand?: (cmd: string) => boolean;
}

const KIB = 1024;

export const CAPABILITY_DEFAULTS: Record<MediaCapability, { maxBytes: number; maxChars: number | null; timeoutSeconds: number }> = {
  image: { maxBytes: 10 * KIB * KIB, maxChars: 500, timeoutSeconds: 60 },
  audio: { maxBytes: 20 * KIB * KIB, maxChars: null, timeoutSeconds: 60 },
  pdf: { maxBytes: 10 * KIB * KIB, maxChars: 4000, timeoutSeconds: 60 },
};

const IMAGE_PROMPT = "Describe the image in <= 500 chars.";
const AUDIO_CLI_CANDIDATES = ["whisper-cli", "whisper"]; // their local fallback list (CPU-first, simplified)

/** Per-capability resolved controls (entry overrides win at call time). */
function controlsFor(cfg: ToolsMediaConfig, cap: MediaCapability): Required<Pick<CapabilityControl, "maxBytes" | "timeoutSeconds">> & { maxChars: number | null; prompt?: string; language?: string; preferredModel?: string; echoTranscript?: boolean; echoFormat?: string } {
  const c = cfg[cap] ?? {};
  const d = CAPABILITY_DEFAULTS[cap];
  return {
    maxBytes: c.maxBytes && c.maxBytes > 0 ? c.maxBytes : d.maxBytes,
    maxChars: c.maxChars && c.maxChars > 0 ? c.maxChars : d.maxChars,
    timeoutSeconds: c.timeoutSeconds && c.timeoutSeconds > 0 ? c.timeoutSeconds : d.timeoutSeconds,
    prompt: c.prompt,
    language: c.language,
    preferredModel: c.preferredModel,
    echoTranscript: c.echoTranscript,
    echoFormat: c.echoFormat,
  };
}

function isEnabled(cfg: ToolsMediaConfig, cap: MediaCapability): boolean {
  return cfg[cap]?.enabled !== false;
}

/** Select attachments per capability (their default: first only). */
export function selectAttachments(facts: MediaFact[], cfg: ToolsMediaConfig): MediaFact[] {
  const out: MediaFact[] = [];
  for (const [cap, control] of [["image", cfg.image], ["audio", cfg.audio], ["pdf", cfg.pdf]] as const) {
    if (control?.enabled === false) continue;
    const mine = facts.filter((f) => f.kind === cap);
    const mode = control?.attachments?.mode ?? "first";
    const max = control?.attachments?.maxAttachments ?? 1;
    out.push(...(mode === "all" ? mine.slice(0, Math.max(1, max)) : mine.slice(0, 1)));
  }
  return out;
}

/** Their entry-validation: provider needs provider+model-ish, CLI needs nonblank command + nonempty args. */
function entryValid(entry: MediaModelEntry): string | null {
  if (entry.type === "cli") {
    if (!entry.command?.trim()) return "cli entry missing command";
    if (!Array.isArray(entry.args) || entry.args.length === 0) return "cli entry missing args";
    return null;
  }
  if (entry.provider && !entry.provider.trim()) return "provider entry has empty provider id";
  return null;
}

function matchesPreference(entry: MediaModelEntry, pref: string): boolean {
  if (entry.type === "cli") return `cli:${entry.command}` === pref;
  return entry.provider === pref || entry.model === pref || `${entry.provider}/${entry.model}` === pref || `provider:${entry.provider}` === pref;
}

/**
 * Resolve the per-capability ladder: explicit capability-tagged models first
 * (preferredModel pulls one to the front — their preferredModel), then
 * auto-detection (provider auth beats local CLI).
 */
export function resolveEntries(
  cfg: ToolsMediaConfig,
  cap: MediaCapability,
  deps: MediaEngineDeps,
): { entries: MediaModelEntry[]; invalid: string[] } {
  const invalid: string[] = [];
  const control = cfg[cap] ?? {};
  const explicit = (cfg.models ?? []).filter((m) => m.capabilities.includes(cap));
  const entries: MediaModelEntry[] = [];
  for (const m of explicit) {
    const err = entryValid(m);
    if (err) {
      invalid.push(err);
      continue; // runtime failure recorded, next entry tried (their rule)
    }
    entries.push(m);
  }
  if (control.preferredModel) {
    const i = entries.findIndex((e) => matchesPreference(e, control.preferredModel!));
    if (i > 0) entries.unshift(...entries.splice(i, 1));
  }
  if (entries.length === 0) {
    // ── auto-detection ──
    if (cap === "image") {
      if (deps.replyProvider?.apiKey) entries.push({ type: "provider", model: undefined, capabilities: ["image"], provider: deps.replyProvider.baseUrl });
    } else if (cap === "audio") {
      const auths = (deps.providerAuths ?? []).filter((p) => p.apiKey);
      if (auths.length > 0) {
        const priority = ["groq", "openai", "xai", "deepgram", "google", "elevenlabs", "mistral"];
        const byId = (p: { id: string; baseUrl: string }) => {
          const hay = `${p.id} ${p.baseUrl}`.toLowerCase();
          const i = priority.findIndex((n) => hay.includes(n));
          return i === -1 ? priority.length : i;
        };
        auths.sort((a, b) => byId(a) - byId(b));
        for (const a of auths) entries.push({ type: "provider", provider: a.id, model: cfg.audio?.preferredModel ?? "gpt-4o-mini-transcribe", capabilities: ["audio"] });
      } else if (deps.hasCommand) {
        for (const cmd of AUDIO_CLI_CANDIDATES) {
          if (deps.hasCommand(cmd)) {
            entries.push({
              type: "cli",
              command: cmd,
              args: cmd === "whisper-cli" ? ["-f", "{{AttachmentPath}}", "--output-txt", "", ""] : ["{{AttachmentPath}}", "--output_format", "txt", "--output_dir", "{{OutputDir}}"],
              capabilities: ["audio"],
            });
            break;
          }
        }
      }
    }
    // pdf auto-detection: extraction always available (their fallback lane).
  }
  return { entries, invalid };
}

/** Template substitution (their placeholders; unset → empty argument). */
export function cliArgs(entry: MediaModelEntry, fact: MediaFact, opts: { maxChars: number | null; prompt: string; language?: string; outputDir: string; index: number }): string[] {
  const sub: Record<string, string> = {
    "{{AttachmentPath}}": fact.path,
    "{{AttachmentUrl}}": fact.url ?? "",
    "{{AttachmentContentType}}": fact.contentType ?? "",
    "{{AttachmentDir}}": fact.path.replace(/[/\\][^/\\]*$/, ""),
    "{{AttachmentIndex}}": String(opts.index),
    "{{MaxChars}}": opts.maxChars !== null ? String(opts.maxChars) : "",
    "{{Prompt}}": opts.prompt,
    "{{Language}}": opts.language ?? "",
    "{{OutputDir}}": opts.outputDir,
    "{{OutputBase}}": `${opts.outputDir}/out`,
  };
  return (entry.args ?? []).map((a) => sub[a] ?? a.replace(/\{\{[A-Za-z]+\}\}/g, (m) => sub[m] ?? ""));
}

async function runEntry(
  entry: MediaModelEntry,
  cap: MediaCapability,
  fact: MediaFact,
  cfg: ToolsMediaConfig,
  deps: MediaEngineDeps,
  index: number,
): Promise<{ text: string } | { error: string }> {
  const control = controlsFor(cfg, cap);
  const maxBytes = entry.maxBytes && entry.maxBytes > 0 ? entry.maxBytes : control.maxBytes;
  const timeoutMs = (entry.timeoutSeconds && entry.timeoutSeconds > 0 ? entry.timeoutSeconds : control.timeoutSeconds) * 1000;
  const maxChars = entry.maxChars && entry.maxChars > 0 ? entry.maxChars : control.maxChars;
  // maxBytes gate (their "exceeds maxBytes → try the next entry").
  try {
    const size = statSync(fact.path).size;
    if (size > maxBytes) return { error: `attachment ${size} bytes exceeds maxBytes ${maxBytes}` };
  } catch (err) {
    return { error: `attachment unreadable: ${(err as Error).message}` };
  }
  try {
    if (entry.type === "cli") {
      const args = cliArgs(entry, fact, {
        maxChars,
        prompt: cfg[cap]?.prompt ?? (entry.prompt ?? (cap === "image" ? IMAGE_PROMPT : "Transcribe the media.")),
        language: entry.language ?? control.language,
        outputDir: await defaultOutputDir(),
        index,
      });
      const out = (await deps.runCli(entry.command!, args, timeoutMs)).trim();
      if (!out) return { error: "cli produced no text" };
      return { text: maxChars !== null ? out.slice(0, maxChars) : out };
    }
    if (cap === "image") {
      const { readFileSync } = await import("node:fs");
      const buf = readFileSync(fact.path);
      const mime = fact.contentType ?? "image/jpeg";
      const text = await deps.describeImage(
        `data:${mime};base64,${buf.toString("base64")}`,
        entry.prompt ?? control.prompt ?? IMAGE_PROMPT,
        entry.model,
        timeoutMs,
      );
      const trimmed = text.trim();
      return trimmed ? { text: maxChars !== null ? trimmed.slice(0, maxChars) : trimmed } : { error: "empty description" };
    }
    if (cap === "audio") {
      const auth = (deps.providerAuths ?? []).find((p) => p.id === entry.provider)
        ?? (deps.replyProvider ? { id: "reply", ...deps.replyProvider } : undefined);
      if (!auth) return { error: `no auth for provider entry "${entry.provider ?? "auto"}"` };
      const text = (
        await deps.transcribeAudio({
          path: fact.path,
          mime: fact.contentType ?? mimeFor(fact.path),
          model: entry.model ?? "gpt-4o-mini-transcribe",
          providerAuth: { baseUrl: auth.baseUrl, apiKey: auth.apiKey },
          language: entry.language ?? control.language,
          timeoutMs,
        })
      ).trim();
      // Silence is OMITTED, never failed (their batch rule).
      if (!text) return { error: "__silence__" };
      return { text };
    }
    if (cap === "pdf") {
      const extractor = deps.extractPdf ?? extractPdfFile;
      const result = await extractor(fact.path, { maxChars: maxChars ?? undefined });
      return result.text ? { text: result.text } : { error: "no extractable text (image-only or font-encoded PDF)" };
    }
    return { error: `unsupported capability ${cap}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function mimeFor(path: string): string {
  const ext = basename(path).toLowerCase().split(".").pop() ?? "";
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", webm: "audio/webm" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

async function defaultOutputDir(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), "sc-media-cli-"));
}

/** Full capability pipeline for one attachment: ladder + fallbacks. */
export async function runUnderstanding(
  fact: MediaFact,
  cfg: ToolsMediaConfig,
  deps: MediaEngineDeps,
  index = 0,
): Promise<MediaOutcome> {
  const cap = fact.kind as MediaCapability;
  if (cap !== "image" && cap !== "audio" && cap !== "pdf") {
    return { fact, capability: "image", status: "failed", error: `no understanding for kind ${fact.kind}` };
  }
  if (!isEnabled(cfg, cap)) return { fact, capability: cap, status: "omitted", error: "capability disabled" };
  const { entries, invalid } = resolveEntries(cfg, cap, deps);
  const errors: string[] = [...invalid];
  for (const entry of entries) {
    const r = await runEntry(entry, cap, fact, cfg, deps, index);
    if ("text" in r) return { fact, capability: cap, status: "completed", text: r.text };
    if (r.error === "__silence__") {
      // quiet audio ends the ladder cleanly (their silence rule)
      return { fact, capability: cap, status: "omitted", error: "no speech detected" };
    }
    errors.push(`[${entry.type === "cli" ? `cli:${entry.command}` : entry.provider ?? "auto"}] ${r.error}`);
  }
  if (entries.length === 0) errors.push("no eligible model entries");
  return { fact, capability: cap, status: "failed", error: errors.join("; ") };
}

/**
 * Their Body application: one block per attachment, caption (user text)
 * preserved inside it, command-parse stays on the caption when present.
 */
export function renderMediaBlocks(outcomes: MediaOutcome[], caption: string): string {
  const blocks: string[] = [];
  for (const o of outcomes) {
    const label = o.capability === "image" ? "[Image]" : o.capability === "audio" ? "[Audio]" : "[PDF]";
    if (o.status === "completed") {
      blocks.push(`${label} ${o.text}`);
    }
  }
  if (blocks.length === 0) return caption;
  const body = blocks.join("\n");
  // "Captions are preserved as User text: inside the block" — with a caption
  // the understanding rides first so command parsing stays on the caption.
  return caption.trim() ? `${body}\nUser text: ${caption.trim()}` : body;
}

/** Real spawn-backed CLI runner. */
export function realRunCli(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const argsFinal = args.filter((a) => a !== ""); // empty substituted args dropped pre-launch
    execFile(command, argsFinal, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || (err as Error).message));
      else resolve(String(stdout));
    });
  });
}

/** Shape the runtime config block (tools.media) into engine controls. */
export function toolsMediaConfig(raw: {
  concurrency: number;
  models: {
    type: "provider" | "cli";
    provider: string;
    model: string;
    command: string;
    args: string[];
    prompt: string;
    maxChars: number;
    maxBytes: number;
    timeoutSeconds: number;
    language: string;
    capabilities: string[];
  }[];
  image: { enabled: boolean; preferredModel: string; prompt: string; maxChars: number; maxBytes: number; timeoutSeconds: number; attachments_all: boolean };
  audio: { enabled: boolean; preferredModel: string; maxBytes: number; timeoutSeconds: number; language: string; echoTranscript: boolean; echoFormat: string };
  pdf: { enabled: boolean; maxBytes: number; maxChars: number; timeoutSeconds: number };
}): ToolsMediaConfig {
  return {
    concurrency: raw.concurrency,
    models: (raw.models ?? []).map((m) => ({
      type: m.type,
      provider: m.provider || undefined,
      model: m.model || undefined,
      command: m.command || undefined,
      args: m.args ?? [],
      prompt: m.prompt || undefined,
      maxChars: m.maxChars || undefined,
      maxBytes: m.maxBytes || undefined,
      timeoutSeconds: m.timeoutSeconds || undefined,
      language: m.language || undefined,
      capabilities: (m.capabilities ?? []).filter((c): c is MediaCapability => c === "image" || c === "audio" || c === "pdf"),
    })),
    image: {
      enabled: raw.image.enabled,
      preferredModel: raw.image.preferredModel || undefined,
      prompt: raw.image.prompt || undefined,
      maxChars: raw.image.maxChars,
      maxBytes: raw.image.maxBytes,
      timeoutSeconds: raw.image.timeoutSeconds,
      attachments: raw.image.attachments_all ? { mode: "all", maxAttachments: 10 } : { mode: "first", maxAttachments: 1 },
    },
    audio: {
      enabled: raw.audio.enabled,
      preferredModel: raw.audio.preferredModel || undefined,
      maxBytes: raw.audio.maxBytes,
      timeoutSeconds: raw.audio.timeoutSeconds,
      language: raw.audio.language || undefined,
      echoTranscript: raw.audio.echoTranscript,
      echoFormat: raw.audio.echoFormat,
    },
    pdf: { enabled: raw.pdf.enabled, maxBytes: raw.pdf.maxBytes, maxChars: raw.pdf.maxChars, timeoutSeconds: raw.pdf.timeoutSeconds },
  };
}

/** OpenAI-compatible /audio/transcriptions (their provider entry). */
export async function realTranscribeAudio(opts: {
  path: string;
  mime: string;
  model: string;
  providerAuth: { baseUrl: string; apiKey: string };
  language?: string;
  timeoutMs: number;
}): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const form = new FormData();
  form.set("model", opts.model);
  if (opts.language) form.set("language", opts.language);
  form.set("response_format", "text");
  form.set("file", new Blob([readFileSync(opts.path)], { type: opts.mime }), basename(opts.path));
  const res = await fetch(`${opts.providerAuth.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.providerAuth.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`transcription HTTP ${res.status}: ${body.slice(0, 200)}`);
  // response_format text returns raw text; JSON shapes ({text}) also accepted.
  try {
    const j = JSON.parse(body) as { text?: string };
    return j.text ?? body.trim();
  } catch {
    return body.trim();
  }
}
