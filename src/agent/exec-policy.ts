// Exec approval policy — OpenClaw's modes/allowlist/safe-bins at SuparClaw
// scale (docs/plans/2026-10-21-partial-8-exec-approvals-design.md). Pure and
// zero-dep: policy inputs in, verdict out; the service layer does prompting,
// minting, and fallback handling.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { Store } from "../state/db.js";
import type { ExecAskFallback, ExecMode, SuparClawConfig } from "../config/schema.js";
import { execModeOf } from "../config/schema.js";

export type { ExecMode };

// ---------- durable approvals ledger (sqlite meta row, their singleton doc) ----------

export interface AllowlistEntry {
  id: string;
  /** Resolved binary path glob, or bare command-name glob (PATH-invoked only). */
  pattern: string;
  /** ECMAScript regex over argv (excl. argv[0]) joined with spaces; manual entries only. */
  argPattern?: string;
  /** "allow-always" marks operator-minted grants (exact argv + cwd binding). */
  source?: "allow-always";
  /** sha256 of generated-entry argv (excl. argv[0]) joined with ␟. */
  argvHash?: string;
  /** Generated entries only authorize inside the approving directory. */
  cwd?: string;
  addedAt?: number;
  /** Minted grants: the command the operator actually approved. */
  command?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
}

export interface ApprovalsDoc {
  version: 1;
  agents: Record<string, { allowlist: AllowlistEntry[] }>;
}

const DOC_KEY = "exec_approvals";
const AGENT_ID = "main";

export function emptyApprovalsDoc(): ApprovalsDoc {
  return { version: 1, agents: { [AGENT_ID]: { allowlist: [] } } };
}

export function loadApprovalsDoc(store: Store): ApprovalsDoc {
  try {
    const raw = store.getMeta(DOC_KEY);
    if (!raw) return emptyApprovalsDoc();
    const parsed = JSON.parse(raw) as ApprovalsDoc;
    if (parsed?.version !== 1 || typeof parsed.agents !== "object" || !parsed.agents) return emptyApprovalsDoc();
    for (const id of Object.keys(parsed.agents)) {
      const bag = parsed.agents[id];
      if (!bag || !Array.isArray(bag.allowlist)) parsed.agents[id] = { allowlist: [] };
    }
    return parsed;
  } catch {
    return emptyApprovalsDoc();
  }
}

export function saveApprovalsDoc(store: Store, doc: ApprovalsDoc): void {
  store.setMeta(DOC_KEY, JSON.stringify(doc));
}

export function ledgerEntries(doc: ApprovalsDoc): AllowlistEntry[] {
  return doc.agents[AGENT_ID]?.allowlist ?? [];
}

let entryCounter = 0;
export function newEntryId(): string {
  entryCounter = (entryCounter + 1) % 1296; // base36 rounded, cheap entropy add-on
  return `ax-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${entryCounter.toString(36)}`;
}

/** minted by an operator "Allow always" decision: exact argv hash + cwd binding. */
export function mintAlwaysEntry(
  store: Store,
  plan: { argv0: string; argv: string[]; cwd: string; resolvedPath: string; command: string },
  doc = loadApprovalsDoc(store),
): AllowlistEntry {
  const entry: AllowlistEntry = {
    id: newEntryId(),
    pattern: plan.resolvedPath,
    argvHash: hashArgv(plan.argv.slice(1)),
    cwd: plan.cwd,
    source: "allow-always",
    addedAt: Date.now(),
    lastResolvedPath: plan.resolvedPath,
    // Without this the row can only show a path glob and an argv hash, so the
    // operator cannot tell what they once allowed.
    command: plan.command.slice(0, 500),
  };
  const bag = doc.agents[AGENT_ID] ?? (doc.agents[AGENT_ID] = { allowlist: [] });
  bag.allowlist.push(entry);
  saveApprovalsDoc(store, doc);
  return entry;
}

export function addManualEntry(store: Store, pattern: string, argPattern?: string): { ok: boolean; error?: string; entry?: AllowlistEntry } {
  const cleaned = pattern.trim();
  if (!cleaned) return { ok: false, error: "pattern is required" };
  try {
    globMatcher(cleaned);
    if (argPattern) new RegExp(argPattern);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const doc = loadApprovalsDoc(store);
  const all = ledgerEntries(doc);
  if (all.some((e) => !e.source && e.pattern === cleaned && (e.argPattern ?? "") === (argPattern ?? ""))) {
    return { ok: false, error: "entry already exists" };
  }
  const entry: AllowlistEntry = { id: newEntryId(), pattern: cleaned, ...(argPattern ? { argPattern } : {}), addedAt: Date.now() };
  (doc.agents[AGENT_ID] ?? (doc.agents[AGENT_ID] = { allowlist: [] })).allowlist.push(entry);
  saveApprovalsDoc(store, doc);
  return { ok: true, entry };
}

export function revokeEntry(store: Store, id: string): boolean {
  const doc = loadApprovalsDoc(store);
  const bag = doc.agents[AGENT_ID];
  if (!bag) return false;
  const before = bag.allowlist.length;
  bag.allowlist = bag.allowlist.filter((e) => e.id !== id);
  if (bag.allowlist.length === before) return false;
  saveApprovalsDoc(store, doc);
  return true;
}

/**
 * Record that a grant was used. The ledger is the only place an operator can
 * see which rule is doing the work, so "last used" has to be real: it was
 * declared in the type and written by nothing, which made every row say
 * "never used" forever.
 */
export function touchEntries(store: Store, ids: string[], command: string): void {
  const wanted = new Set(ids.filter(Boolean));
  if (wanted.size === 0) return;
  const doc = loadApprovalsDoc(store);
  const bag = doc.agents[AGENT_ID];
  if (!bag) return;
  const at = Date.now();
  let touched = false;
  for (const entry of bag.allowlist) {
    if (!wanted.has(entry.id)) continue;
    entry.lastUsedAt = at;
    entry.lastUsedCommand = command.slice(0, 500);
    touched = true;
  }
  if (touched) saveApprovalsDoc(store, doc);
}

// ---------- shell lexing (quote-aware chain splitter + argv tokenizer) ----------

export type ChainOp = "&&" | "||" | ";" | "|";

export interface ChainParse {
  ok: boolean;
  /** why auto-Allow is not allowed to reason about this text */
  unsupported?: string;
  segments: string[];
  ops: ChainOp[];
}

function isQuote(c: string): boolean {
  return c === "'" || c === '"';
}

/** Split on top-level && || ; | preserving segments. `|` joins cause pipes — flagged separately. */
export function splitChain(command: string): ChainParse {
  const segments: string[] = [];
  const ops: ChainOp[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const n = command[i + 1];
    if (quote) {
      buf += c;
      if (c === "\\" && quote === '"' && n) buf += command[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") {
      buf += c + (n ?? "");
      i++;
      continue;
    }
    if (isQuote(c)) {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "`" || c === "(" || c === ")" || c === "<" || c === ">") {
      return { ok: false, unsupported: `shell construct '${c}' needs a human (substitution/subshell/redirection)`, segments: [], ops: [] };
    }
    if (c === "$" && n === "(") {
      return { ok: false, unsupported: "command substitution $() needs a human", segments: [], ops: [] };
    }
    if (c === "|") {
      flush();
      if (n === "|") {
        ops.push("||");
        i++;
      } else ops.push("|");
      continue;
    }
    if (c === "&") {
      if (n === "&") {
        flush();
        ops.push("&&");
        i++;
        continue;
      }
      // background & / >& redirection — outside the evaluable subset
      return { ok: false, unsupported: "background '&' or redirection needs a human", segments: [], ops: [] };
    }
    if (c === ";" || c === "\n") {
      flush();
      ops.push(";");
      continue;
    }
    buf += c;
  }
  if (quote) return { ok: false, unsupported: "unterminated quote", segments: [], ops: [] };
  flush();
  return { ok: true, segments: segments.filter((s) => s.trim().length > 0), ops };
  function flush() {
    segments.push(buf);
    buf = "";
  }
}

/** Tokenize one segment into argv; null when a control char leaks through. */
export function tokenizeArgv(segment: string): string[] | null {
  const argv: string[] = [];
  let cur = "";
  let quote = "";
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    const n = segment[i + 1];
    if (quote) {
      if (quote === '"' && c === "\\" && n && (n === '"' || n === "\\")) {
        cur += n;
        i++;
      } else if (c === quote) quote = "";
      else cur += c;
      has = true;
      continue;
    }
    if (c === "\\") {
      if (n) {
        cur += n;
        i++;
        has = true;
      }
      continue;
    }
    if (isQuote(c)) {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) argv.push(cur);
      cur = "";
      has = false;
      continue;
    }
    if ("|&<>();`".includes(c)) return null;
    if (c === "$" && n === "(") return null;
    cur += c;
    has = true;
  }
  if (quote) return null;
  if (has || cur) argv.push(cur);
  return argv;
}

// ---------- glob (minimal: ** any path, * within segment, ? one char) ----------

export function globMatcher(pattern: string): (target: string) => boolean {
  const expanded = pattern.startsWith("~") ? homedir() + pattern.slice(1) : pattern;
  let re = "^";
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i]!;
    if (c === "*") {
      if (expanded[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += `[^${escapeRe(sep)}]*`;
      continue;
    }
    if (c === "?") {
      re += `[^${escapeRe(sep)}]`;
      continue;
    }
    re += escapeRe(c);
  }
  re += "$";
  const compiled = new RegExp(re);
  return (target) => compiled.test(target);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hashArgv(args: string[]): string {
  return createHash("sha256").update(args.join("\u001f")).digest("hex");
}

// ---------- binary resolution ----------

export interface ResolveEnv {
  PATH: string;
  trustedDirs: string[];
}

export function resolveBinary(argv0: string, env: ResolveEnv): string | null {
  try {
    if (argv0.includes("/")) {
      const p = realpathSync(argv0);
      return existsSync(p) && statSync(p).isFile() ? p : null;
    }
    for (const dir of env.PATH.split(":")) {
      if (!dir) continue;
      try {
        // realpath throws for the many PATH dirs where the binary is absent —
        // keep walking (a first-dir miss must not forfeit the search)
        const cand = realpathSync(join(dir, argv0));
        if (existsSync(cand) && statSync(cand).isFile()) return cand;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function inTrustedDir(path: string, trustedDirs: string[]): boolean {
  return trustedDirs.some((dir) => {
    const real = canonPath(dir);
    return path === real || path.startsWith(real + sep);
  });
}

function canonPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---------- safe bins (stdin-only fast path; per-bin profiles) ----------

interface SafeProfile {
  /** boolean flags that take no value */
  boolFlags: string[];
  /** flags that consume the next token as a value (or --flag=value) */
  valueFlags: string[];
  /** always denied even when they'd otherwise parse */
  deniedFlags: string[];
  /** accepted values for value flags (regex against the value token) */
  valueRe: RegExp;
  /** how many literal positional operands the bin needs from stdin work */
  minPositional: number;
  maxPositional: number;
}

/** Value tokens for safe-bin flags: field lists, delimiters, digits. No / or ~
 * — a path-shaped value is never a legitimate stdin-bin setting and refusing
 * it keeps whole-file reads out of every quick-allow profile. */
const SAFE_VALUE = /^[\w\s.,:+=@^|\[\]{}()-]{1,64}$/;

const SAFE_PROFILES: Record<string, SafeProfile> = {
  cut: {
    boolFlags: ["-s", "--only-delimited", "-z", "--zero-terminated", "-n"],
    valueFlags: ["-c", "--characters", "-b", "--bytes", "-f", "--fields", "-d", "--delimiter"],
    deniedFlags: [],
    valueRe: SAFE_VALUE,
    minPositional: 0,
    maxPositional: 0,
  },
  uniq: {
    boolFlags: ["-c", "--count", "-d", "--repeated", "-u", "--unique", "-i", "--ignore-case", "-z", "--zero-terminated"],
    valueFlags: ["-s", "--skip-chars", "-f", "--skip-fields", "-w", "--check-chars"],
    deniedFlags: [],
    valueRe: /^\d{1,9}$/,
    minPositional: 0,
    maxPositional: 0,
  },
  head: {
    boolFlags: ["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"],
    valueFlags: ["-n", "--lines", "-c", "--bytes"],
    deniedFlags: [],
    valueRe: /^-?\d{1,9}[kmKMGT]?$/,
    minPositional: 0,
    maxPositional: 0,
  },
  tail: {
    boolFlags: ["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated", "--pid"],
    valueFlags: ["-n", "--lines", "-c", "--bytes", "--pid"],
    deniedFlags: ["-f", "-F", "--follow", "--retry"],
    valueRe: /^[+-]?\d{1,9}[kmKMGT]?$/,
    minPositional: 0,
    maxPositional: 0,
  },
  tr: {
    boolFlags: ["-d", "--delete", "-s", "--squeeze-repeats", "-c", "-C", "--complement", "-t", "--truncate-set1"],
    valueFlags: [],
    deniedFlags: [],
    valueRe: SAFE_VALUE,
    minPositional: 1,
    maxPositional: 2,
  },
  wc: {
    boolFlags: ["-c", "--bytes", "-m", "--chars", "-l", "--lines", "-L", "--max-line-length", "-w", "--words"],
    valueFlags: [],
    deniedFlags: ["--files0-from"],
    valueRe: SAFE_VALUE,
    minPositional: 0,
    maxPositional: 0,
  },
};

/** awk/sed/jq can never be safe bins (their semantics escape stdin-only). */
const NEVER_SAFE = new Set(["awk", "gawk", "mawk", "sed", "jq", "make", "xargs"]);

export interface SafeBinResult {
  safe: boolean;
  reason?: string;
}

/** Validate an argv against a bin's stdin-only profile. Pure argv analysis — no fs checks. */
export function safeBinCheck(name: string, argv: string[], profile: SafeProfile): SafeBinResult {
  if (NEVER_SAFE.has(name)) return { safe: false, reason: `${name} can never be a safe bin` };
  let positional = 0;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!tok.startsWith("-") || tok === "-") {
      // positional operand: must be a literal, never path-like
      if (tok.includes("/") || tok.startsWith("~") || tok.startsWith(".") || tok === "--") {
        return { safe: false, reason: `positional operand '${tok}' looks like a path — safe bins read stdin only` };
      }
      positional++;
      i++;
      continue;
    }
    const eq = tok.indexOf("=");
    const flag = eq > 0 ? tok.slice(0, eq) : tok;
    if (profile.deniedFlags.includes(flag) || profile.deniedFlags.includes(tok)) {
      return { safe: false, reason: `flag '${flag}' is denied for safe ${name}` };
    }
    if (profile.boolFlags.includes(flag)) {
      if (eq > 0) return { safe: false, reason: `flag '${flag}' takes no value` };
      i++;
      continue;
    }
    if (profile.valueFlags.includes(flag)) {
      const value = eq > 0 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined) return { safe: false, reason: `flag '${flag}' needs a value` };
      if (!profile.valueRe.test(value)) return { safe: false, reason: `unsafe value for '${flag}'` };
      i++;
      continue;
    }
    // attached short value (cut -f1, head -n5): letter must be a known value flag
    {
      const attached = /^-([a-zA-Z])(.+)$/.exec(tok);
      if (attached && attached[2] !== undefined && profile.valueFlags.includes(`-${attached[1]}`) && profile.valueRe.test(attached[2])) {
        i++;
        continue;
      }
    }
    // bundled short bool flags (wc -lw): every char must be a known bool short flag
    const isShortBundle = /^-[a-zA-Z]{2,}$/.test(tok) && eq < 0 && [...tok.slice(1)].every((ch) => profile.boolFlags.includes(`-${ch}`));
    if (isShortBundle) {
      i++;
      continue;
    }
    return { safe: false, reason: `unrecognized flag '${tok}' for safe ${name}` };
  }
  if (positional < profile.minPositional) return { safe: false, reason: `safe ${name} needs ${profile.minPositional} literal operand(s)` };
  if (positional > profile.maxPositional) return { safe: false, reason: `safe ${name} got a file operand — stdin only` };
  return { safe: true };
}

function safeProfileFor(bin: string): SafeProfile | null {
  if (NEVER_SAFE.has(bin)) return null;
  return SAFE_PROFILES[bin] ?? null;
}

// ---------- interpreter inline-eval carriers (strictInlineEval) ----------

/** argv0 forms that are carriers even before flag inspection. */
const ALWAYS_CARRIER = new Set(["awk", "gawk", "mawk", "sed", "make", "gmake", "xargs"]);
const SHELL_BINS = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh"]);
const EVAL_FLAG_BINS = /^(node|python\d*(\.\d+)?|ruby|perl|php|lua|luajit|osascript)$/;

export function inlineEvalCarrier(argv0: string, args: string[]): boolean {
  const base = argv0.split("/").pop() ?? argv0;
  if (ALWAYS_CARRIER.has(base)) return true;
  if (SHELL_BINS.has(base) && args.some((a) => a === "-c" || /^-[A-Za-z:]*c[A-Za-z:]*$/.test(a))) return true;
  if ((base === "busybox" || base === "toybox") && args.length > 0 && SHELL_BINS.has(args[0]!)) return true;
  if (base === "find" && args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok")) return true;
  if (EVAL_FLAG_BINS.test(base)) {
    return args.some((a) => {
      if (a === "-e" || a === "-E" || a === "-p" || a === "-r" || a === "--eval" || a === "--print") return true;
      // -c is eval for python/ruby; check-mode elsewhere (node -c) — fail safe, ask
      if (a.startsWith("-c") && (base.startsWith("python") || base === "ruby")) return true;
      // perl -e'…' bundled-flag form
      if (base === "perl" && a.startsWith("-e")) return true;
      return false;
    });
  }
  return false;
}

// ---------- transparent dispatch wrappers (unwrap to inner binary) ----------

const WRAPPERS = new Set(["env", "nice", "nohup", "stdbuf", "timeout"]);

function unwrapWrapper(argv: string[]): string[] | null {
  const base = argv[0]!.split("/").pop() ?? argv[0]!;
  if (!WRAPPERS.has(base)) return argv;
  let skip = 1;
  for (; skip < argv.length; skip++) {
    const tok = argv[skip]!;
    if (base === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // env VAR=v …
    if (tok.startsWith("-")) continue; // wrapper flags (-i, -n 5, --signal=…)
    break;
  }
  if (skip >= argv.length) return null;
  return argv.slice(skip);
}

// ---------- the evaluator ----------

export interface SegmentPlan {
  argv: string[];
  argv0: string;
  resolvedPath: string;
  matched: "generated" | "manual" | "safe-bin" | null;
  matchedEntryId?: string;
  carrierStrict?: boolean;
}

export type ExecDecision = "allow" | "deny" | "ask";

export interface ExecVerdict {
  decision: ExecDecision;
  /** how to spawn when allowed: direct (no shell) vs the classic shell */
  route: "direct" | "shell";
  reason: string;
  mode: ExecMode;
  askFallback: ExecAskFallback;
  /** single-segment plans drive the direct-exec runner; chain plans are native */
  segments: SegmentPlan[];
  ops: ChainOp[];
  /** may an "Allow always" decision mint a ledger entry? */
  mintable: boolean;
  /** command text the UI/prompt should display */
  command: string;
}

export interface EvalInput {
  config: SuparClawConfig;
  doc: ApprovalsDoc;
  command: string;
  cwd: string;
  /** per-session operator override (/exec mode) or undefined */
  sessionMode?: ExecMode;
  /** PATH for resolution; defaults to the process env */
  pathEnv?: string;
}

// ---- Unattended sources (P2 #10) -------------------------------------------

export type UnattendedMode = "deny" | "allowlist" | "all";

export interface UnattendedDecision {
  allowed: boolean;
  audit: string;
}

/**
 * Resolve an ASK verdict for a run with no human in the loop (cron/webhook).
 * deny → always decline; all → always allow; allowlist → allow only when the
 * plan's every segment matched a safe bin through trusted dirs (and rides
 * the direct runner verbatim). The audit line names the decision + reason —
 * their "auto-decisions are always recorded" rule.
 */
export function unattendedDecision(mode: UnattendedMode, verdict: ExecVerdict): UnattendedDecision {
  if (mode === "all") {
    return { allowed: true, audit: `unattended-policy=all → auto-allowed (was ask: ${verdict.reason})` };
  }
  if (mode === "allowlist") {
    const everySafe =
      verdict.segments.length > 0 &&
      verdict.segments.every((s) => s.matched === "safe-bin" && s.resolvedPath) &&
      verdict.route === "direct";
    return everySafe
      ? { allowed: true, audit: `unattended-policy=allowlist → auto-allowed (${verdict.segments.length} safe-bin segment(s))` }
      : { allowed: false, audit: `unattended-policy=allowlist → auto-declined (not all segments are safe bins: ${verdict.reason})` };
  }
  return { allowed: false, audit: `unattended-policy=deny → auto-declined (was ask: ${verdict.reason})` };
}

export function evaluateExec(input: EvalInput): ExecVerdict {
  const { config, command, cwd } = input;
  const exec = config.tools.exec;
  const mode: ExecMode = input.sessionMode ?? execModeOf(exec);
  const askFallback = exec.askFallback ?? "deny";
  const base: Omit<ExecVerdict, "decision" | "reason"> = {
    route: "shell",
    mode,
    askFallback,
    segments: [],
    ops: [],
    mintable: false,
    command,
  };

  if (!exec.enabled) return { ...base, decision: "deny", reason: "exec tool is disabled (tools.exec.enabled=false)" };
  if (mode === "deny") return { ...base, decision: "deny", reason: "host exec policy mode=deny" };
  if (mode === "full") return { ...base, decision: "allow", reason: "mode=full runs without prompts" };

  const chain = splitChain(command);
  if (!chain.ok) {
    const reason = `${chain.unsupported} — not allowlist-evaluable`;
    return { ...base, decision: mode === "allowlist" ? "deny" : "ask", reason };
  }
  if (chain.ops.includes("|")) {
    const reason = "pipes need a human decision in this build — not allowlist-evaluable";
    return { ...base, decision: mode === "allowlist" ? "deny" : "ask", reason };
  }

  const env: ResolveEnv = { PATH: input.pathEnv ?? process.env.PATH ?? "", trustedDirs: exec.safeBinTrustedDirs ?? ["/bin", "/usr/bin"] };
  const entries = ledgerEntries(input.doc);
  const strict = exec.strictInlineEval === true;
  const segments: SegmentPlan[] = [];
  let allMatched = true;

  for (const seg of chain.segments) {
    const argvRaw = tokenizeArgv(seg);
    if (!argvRaw || argvRaw.length === 0) {
      allMatched = false;
      segments.push({ argv: [], argv0: "", resolvedPath: "", matched: null });
      continue;
    }
    const argv = unwrapWrapper(argvRaw) ?? argvRaw;
    const argv0 = argv[0]!;
    const resolved = resolveBinary(argv0, env) ?? "";
    const home = { argv0, args: argv.slice(1) };

    if (strict && inlineEvalCarrier(home.argv0, home.args)) {
      allMatched = false;
      segments.push({ argv, argv0, resolvedPath: resolved, matched: null, carrierStrict: true });
      continue;
    }

    let matched: SegmentPlan["matched"] = null;
    let matchedEntryId: string | undefined;

    // generated (operator-minted) grants first: exact argv hash + cwd + resolution re-check
    for (const e of entries) {
      if (e.source !== "allow-always" || !e.argvHash) continue;
      if (e.cwd !== undefined && e.cwd !== cwd) continue;
      if (resolved && e.lastResolvedPath && resolved !== e.lastResolvedPath) continue;
      if (!globMatcher(e.pattern)(resolved || argv0)) continue;
      if (hashArgv(argv.slice(1)) !== e.argvHash) continue;
      matched = "generated";
      matchedEntryId = e.id;
      break;
    }
    // manual entries
    if (!matched) {
      for (const e of entries) {
        if (e.source) continue;
        const hasSlash = argv0.includes("/");
        if (e.pattern.includes("/")) {
          // path glob — match against the resolved binary path
          if (!resolved || !globMatcher(e.pattern)(resolved)) continue;
        } else {
          // bare name glob — only PATH-invoked commands
          if (hasSlash || !globMatcher(e.pattern)(argv0)) continue;
          if (!resolved) continue;
        }
        if (e.argPattern) {
          let re: RegExp;
          try {
            re = new RegExp(e.argPattern);
          } catch {
            continue; // broken entry never matches
          }
          if (!re.test(argv.slice(1).join(" "))) continue;
        }
        matched = "manual";
        matchedEntryId = e.id;
        break;
      }
    }
    // safe bins (stdin-only): resolved from a trusted dir, profile-validated argv
    if (!matched) {
      const binBase = argv0.split("/").pop() ?? argv0;
      const profile = (exec.safeBins ?? []).includes(binBase) ? safeProfileFor(binBase) : null;
      if (profile && resolved && inTrustedDir(resolved, env.trustedDirs)) {
        if (safeBinCheck(binBase, argv.slice(1), profile).safe) matched = "safe-bin";
      }
    }

    if (!matched) allMatched = false;
    segments.push({ argv, argv0, resolvedPath: resolved, matched, matchedEntryId });
  }

  if (allMatched) {
    return {
      ...base,
      decision: "allow",
      route: "direct",
      reason: `allowlist/safe-bin matched ${segments.length} segment(s)`,
      segments,
      ops: chain.ops,
    };
  }
  const misses = segments.filter((s) => !s.matched).length;
  const reason = strict && segments.some((s) => s.carrierStrict)
    ? "inline-eval carrier requires a human (strictInlineEval) — never auto-allowed"
    : `${misses} segment(s) not on the allowlist`;
  return {
    ...base,
    decision: mode === "allowlist" ? "deny" : "ask",
    reason,
    segments,
    ops: chain.ops,
    // always-grants mint only for a single, fully-resolved, non-carrier segment
    mintable: segments.length === 1 && !segments[0]?.carrierStrict && Boolean(segments[0]?.resolvedPath),
  };
}

// ---------- direct (no-shell) execution of allowlist-matched chains ----------

export interface DirectExecResult {
  output: string;
}

/**
 * Run allowlist/safe-bin-matched segments WITHOUT a shell: && chains stop on
 * non-zero, || chains stop on zero, ; always continues. No glob, no $VARS, no
 * $( ) — tokens are literal argv, which is what keeps safe bins stdin-only.
 * timeoutMs is the same safety cap the shell route uses (rule: exec cap only).
 */
export async function runDirectChain(
  segments: SegmentPlan[],
  ops: ChainOp[],
  opts: { cwd: string; timeoutMs: number; maxBuffer?: number },
): Promise<DirectExecResult> {
  const { execFile } = await import("node:child_process");
  const parts: string[] = [];
  let exit = 0;
  for (let i = 0; i < segments.length; i++) {
    const op = i === 0 ? null : (ops[i - 1] ?? ";");
    if (op === "&&" && exit !== 0) break;
    if (op === "||" && exit === 0) break;
    const seg = segments[i]!;
    const bin = seg.resolvedPath || seg.argv0;
    const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
      execFile(
        bin,
        seg.argv.slice(1),
        { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 1_000_000 },
        (err, out, serr) => {
          resolveRun({
            code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
            stdout: out ?? "",
            stderr: serr ?? "",
          });
        },
      );
    });
    exit = code;
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr] ${stderr}`);
  }
  const finalSeg = segments[segments.length - 1];
  if (exit !== 0) parts.push(`[exit ${exit}]`);
  if (!finalSeg) parts.push("[exit 1] empty command");
  return { output: (parts.join("\n").slice(0, 60_000) || "(no output)").slice(0, 60_000) };
}
