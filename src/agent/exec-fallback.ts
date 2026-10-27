// Task 56 — exec that survives its own environment.
//
// The report: *"killed by the sandbox (SIGABRT)"*, followed by the agent asking
// the human to run `gh` and paste the output. A SIGABRT before the command
// prints anything is not the command failing — it is the environment failing:
//
//   - a login shell reading a broken rc file aborts (Termux after an update,
//     a `.bashrc` that sources a missing file, a shell whose `$PREFIX` moved);
//   - `LD_PRELOAD` / `LD_LIBRARY_PATH` pointing at a library that is gone makes
//     Android's linker abort *every* child before `main()` (`termux-exec`);
//   - a wrapper (prlimit/proot) that exists but cannot run.
//
// One strategy — `bash -lc` and hope — turns all three into "nothing works",
// which is how a phone ends up being told to type shell commands by hand. This
// module is the ladder: the same command, tried down a list of progressively
// plainer shells and environments, stopping at the first that produces output.
//
// The retry rule is deliberately narrow: only when **nothing was printed**. A
// command that ran, printed, and then failed is the command's business — retrying
// it could run a side effect twice.
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
  /** The old message shape: "<path> could not be started (EACCES)". */
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
 * The ladder for one command. The first entry is whatever the sandbox planner
 * produced (it may be wrapped); the rest get progressively plainer.
 */
export function execAttempts(input: {
  shell: string;
  command: string;
  planned: { argv: string[]; env: NodeJS.ProcessEnv; wrappers: string[] };
}): ExecAttempt[] {
  const { shell, command, planned } = input;
  const attempts: ExecAttempt[] = [{ label: "the planned shell", argv: planned.argv, env: planned.env }];

  if (planned.wrappers.length > 0) {
    attempts.push({ label: `the login shell without ${planned.wrappers.map(baseName).join("/")}`, argv: [shell, "-lc", command], env: planned.env });
  }
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
  /** The first attempt's outcome — a broken sandbox wrapper is named from here. */
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
    // A wrapper that exists but cannot run is a sandbox story, not a shell one
    // — and it has to say the command was NOT confined, or an audit reads it as
    // if the jail had been applied.
    if (result.first.spawnFailed) {
      return `[sandbox: ${result.first.spawnDetail ?? "the wrapper could not be started"} — retried WITHOUT the jail; this command is not confined]`;
    }
    return (
      `[exec: ${result.reasons[0] ?? result.tried[0]}; ran with ${result.used.label} instead and it worked. ` +
      "The environment was the problem, not your command — do not ask the user to run anything.]"
    );
  }
  return (
    `[exec: every shell failed — ${result.reasons.join("; ")}. ` +
    "This device cannot start a shell for the daemon right now; say exactly that (with this line) instead of " +
    "asking the user to run the command and paste the output. If another tool can do the job, use it.]"
  );
}
