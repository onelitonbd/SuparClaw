import { existsSync } from "node:fs";

/** Execution failure formatting and tool-result status helpers. */
export interface ExecFailureContext {
  cwd: string;
  timeoutMs: number;
  /** The command as the operator/model wrote it. */
  cmdline: string;
  /** Did the child print anything at all (stdout or stderr)? */
  hadOutput: boolean;
}

/** The shape Node's child_process callbacks hand back on failure. */
interface ChildError {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  path?: string;
  message?: string;
}

/**
 * One line per failure, always naming the command. `null` means "not a failure
 * we can describe better than the caller already did" (i.e. plain success).
 */
export function explainExecError(err: ChildError | null | undefined, ctx: ExecFailureContext): string | null {
  if (!err) return null;
  const cmd = ctx.cmdline;
  // Node reports a missing cwd as ENOENT *on the binary*, which reads as "the
  // shell is gone" — check the directory first so the cause is never mislabelled.
  if (!existsSync(ctx.cwd)) {
    return `[cannot run] ${cmd} — the working directory ${ctx.cwd} does not exist (deleted, moved, or the session's workspace is stale)`;
  }
  if (err.killed && err.signal) {
    return `[timeout] ${cmd} — killed after ${ctx.timeoutMs} ms (the cap is tools.exec.timeoutMs; raise it or split the work)`;
  }
  if (typeof err.code === "string" && err.code) {
    switch (err.code) {
      case "ENOENT":
        return `[cannot run] ${cmd} — ${err.path ? `${err.path} was not found` : "the program was not found"} (check PATH: the child sees the daemon's PATH, which may differ from an interactive shell's)`;
      case "EACCES":
        return `[cannot run] ${cmd} — ${err.path ?? "the program"} is not executable (permission denied)`;
      case "ENOEXEC":
        return `[cannot run] ${cmd} — ${err.path ?? "the program"} is not an executable program (bad interpreter line?)`;
      case "ERR_CHILD_PROCESS_STDIO_MAXBUFFER":
        return `[output too large] ${cmd} — the child wrote more than the 16 MB buffer; send it to a file and read the part you need`;
      default:
        return `[cannot run] ${cmd} — ${err.code}${err.message ? `: ${err.message}` : ""}`;
    }
  }
  if (err.signal) return `[signal] ${cmd} — killed by ${err.signal}`;
  if (typeof err.code === "number") {
    const code = err.code;
    return ctx.hadOutput
      ? `[exit ${code}] ${cmd}`
      : `[exit ${code}] ${cmd} — the command printed nothing`;
  }
  return `[cannot run] ${cmd} — ${err.message || "unknown failure"}`;
}

/**
 * The loop's red-pill test: declined calls start with `error:`, failed commands
 * carry a tag from explainExecError. One place, so the transcript and the model
 * cannot disagree about whether a call failed.
 */
const FAILURE_TAG = /(?:^|\n)\[(?:exit [1-9]\d*|cannot run|timeout|signal|output too large)\]/;

export function isToolFailure(output: string): boolean {
  return output.startsWith("error") || FAILURE_TAG.test(output);
}
