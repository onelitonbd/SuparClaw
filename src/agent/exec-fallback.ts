// Exec shell startup fallback. It retries only when a shell failed before
// printing anything; command failures and timeouts are never retried, preventing
// duplicate side effects. Loader-variable cleanup is limited to fallback shells.
import { existsSync } from "node:fs";

export interface ExecAttempt {
  /** Named in the transcript, so the operator knows which road worked. */
  label: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}

export interface AttemptOutcome {
  /** What the child wrote on stdout (stderr is kept separately by the runner). */
  stdout: string;
  signal?: string | null;
  exitCode?: number | null;
  /** The binary itself could not be spawned (ENOENT/EACCES/ENOEXEC/EPERM). */
  spawnFailed?: boolean;
  /** A concise detail when Node could not start the shell process. */
  spawnDetail?: string;
  /** We killed it at `tools.exec.timeoutMs` — never retried: that repeats the work. */
  timedOut?: boolean;
}

/**
 * Variables that poison every child when they name something that is not
 * there. `PATH`, `HOME`, `LANG` and `TZ` survive — they are what a command
 * needs to find its own tools.
 */
export const LOADER_ENV = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "PYTHONHOME",
  "PYTHONPATH",
] as const;

export function scrubLoaderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of LOADER_ENV) delete out[key];
  return out;
}

/** The plain shells that exist on this box, phone first (Android has no /bin). */
export function posixShells(): string[] {
  return ["/system/bin/sh", "/bin/sh", "/usr/bin/sh", "/usr/local/bin/sh"].filter((p) => existsSync(p));
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * The retry ladder for one command, from the configured shell to plain POSIX shells.
 */
export function execAttempts(input: {
  shell: string;
  command: string;
  planned: { argv: string[]; env: NodeJS.ProcessEnv };
}): ExecAttempt[] {
  const { shell, command, planned } = input;
  const attempts: ExecAttempt[] = [{ label: "the planned shell", argv: planned.argv, env: planned.env }];

  // `-c` skips every login/rc file: the abort usually happens before `main()`
  // of the *command*, inside the shell's startup.
  attempts.push({ label: `${baseName(shell)} -c (no login files)`, argv: [shell, "-c", command], env: planned.env });

  for (const sh of posixShells()) {
    if (sh === shell) continue;
    attempts.push({ label: `${baseName(sh)} -c (clean env)`, argv: [sh, "-c", command], env: scrubLoaderEnv(planned.env) });
  }

  // Dedupe by argv: the planner may already be the plain shell.
  const seen = new Set<string>();
  return attempts.filter((a) => {
    const key = a.argv.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Is this failure the environment's, or the command's?
 *
 * Retry only when the child never produced stdout. A signal or 126/127 with no
 * output means it died before doing anything; a spawn failure means it never
 * started.
 */
export function shouldRetryAfter(outcome: AttemptOutcome): boolean {
  if (outcome.timedOut) return false;
  if (outcome.spawnFailed) return true;
  if (outcome.stdout.trim() !== "") return false;
  if (outcome.signal) return true;
  return outcome.exitCode === 126 || outcome.exitCode === 127;
}

export interface AttemptRun {
  outcome: AttemptOutcome;
  /** The formatted text the model would see for this attempt. */
  output: string;
}

export interface FallbackResult {
  /** The output of the attempt that finished the job (or the last one tried). */
  output: string;
  /** The first attempt outcome, used to report whether a shell retry was needed. */
  first: AttemptOutcome;
  /** Which attempt produced `output`. */
  used: ExecAttempt;
  /** True when a command produced output at all (not necessarily exit 0). */
  ran: boolean;
  /** Labels attempted, in order. */
  tried: string[];
  /** Why each discarded attempt was discarded. */
  reasons: string[];
}

/** Walk the ladder until an attempt is not retryable. */
export async function runWithFallback(
  attempts: ExecAttempt[],
  run: (attempt: ExecAttempt) => Promise<AttemptRun>,
): Promise<FallbackResult> {
  const tried: string[] = [];
  const reasons: string[] = [];
  let last: { attempt: ExecAttempt; run: AttemptRun } | null = null;
  let firstOutcome: AttemptOutcome | null = null;
  for (const attempt of attempts) {
    const result = await run(attempt);
    firstOutcome ??= result.outcome;
    tried.push(attempt.label);
    last = { attempt, run: result };
    if (!shouldRetryAfter(result.outcome)) break;
    reasons.push(`${attempt.label} → ${describeOutcome(result.outcome)}`);
  }
  const { attempt, run: result } = last!;
  return {
    output: result.output,
    first: firstOutcome!,
    used: attempt,
    ran: !shouldRetryAfter(result.outcome),
    tried,
    reasons,
  };
}

export function describeOutcome(outcome: AttemptOutcome): string {
  if (outcome.timedOut) return "hit the time cap";
  if (outcome.spawnFailed) return outcome.spawnDetail ?? "could not be started";
  if (outcome.signal) return `killed by ${outcome.signal} before printing anything`;
  if (outcome.exitCode === 126 || outcome.exitCode === 127) return `exited ${outcome.exitCode} before printing anything`;
  return "printed nothing";
}

/**
 * One line for the model when the ladder had to move, or when every rung
 * failed. Silence when the first attempt worked — that is the normal case and
 * the model does not need to read about it.
 */
export function fallbackNote(result: FallbackResult, first: ExecAttempt): string {
  if (result.tried.length === 1) {
    return result.ran ? "" : `[exec: the command printed nothing — ${describeOutcome({ stdout: "", exitCode: null })}]`;
  }
  if (result.ran) {
    if (result.first.spawnFailed) {
      return `[exec: the initial shell could not start (${result.first.spawnDetail ?? "unknown startup error"}); command succeeded with ${result.used.label}]`;
    }
    return `[exec: initial shell failed before output (${result.reasons[0] ?? result.tried[0]}); command succeeded with ${result.used.label}]`;
  }
  return `[exec: unable to start the command after trying available shells — ${result.reasons.join("; ")}]`;
}
