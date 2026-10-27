// Terminals — a shell that stays alive.
//
// Why this exists next to `exec`: exec runs one command per call and dies, so
// nothing survives it. `cd /srv/app && git status` in one call and `git status`
// in the next are two different directories; `export`, `nvm use`, a virtualenv
// activation and a dev server are all impossible. A dedicated terminal keeps
// cwd, exports and a running process across turns, sessions and UI reloads.
//
// Two deliberate choices:
//
//   1. NO PTY. node-pty is a native module and this project ships zero of them.
//      `script(1)` would give a PTY, but then the shell is interactive: it
//      echoes every command, prints an ANSI prompt and wraps lines in \r\n, so
//      each call returns prompt noise. Pipes + a sentinel return exactly what
//      the command printed.
//      The one thing a PTY is genuinely needed for — Ctrl-C — is done directly:
//      SIGINT to the shell's *descendants*, so the running command dies and the
//      shell keeps its cwd and exports. (Signalling the whole process group, the
//      obvious shortcut, kills the shell itself — verified against a real bash.)
//      What is lost: full-screen TUI programs (vim, htop, less paging). That is
//      stated in the tool description rather than left to be discovered.
//
//   2. NO SANDBOX. Terminals run with the daemon's own environment and no
//      prlimit/proot wrapper: full power was the ask. The mitigation is
//      visibility, not confinement — every command is a tool step in the
//      transcript and the panel streams the live scrollback.
//
// Protocol per command, written to the shell's stdin:
//
//     <command>
//     printf '\n__sc:<token>:%d\t%s\n' "$?" "$PWD"
//
// The token is random per command, so output that happens to contain a marker
// cannot end a result early. The sentinel carries the exit code and the cwd
// (free: bash maintains $PWD), which is what the panel shows in its header.

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { Logger } from "../util/log.js";

/* ------------------------------------------------------------ text cleaning --- */

// CSI (`ESC [ … m`), OSC (`ESC ] … BEL|ST`) and the single-char escapes.
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A trailing escape that has not finished arriving yet — hold it, do not print it. */
export function splitIncompleteEscape(text: string): [string, string] {
  const at = text.lastIndexOf("\u001b");
  if (at < 0) return [text, ""];
  const tail = text.slice(at);
  // Complete CSI/OSC/2-char escapes all end in a byte in @-~ … except a bare
  // ESC at the very end. Treat "short tail with no final byte" as incomplete.
  const complete = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/.test(tail);
  return complete || tail.length > 64 ? [text, ""] : [text.slice(0, at), tail];
}

/**
 * Terminal output → text a human and a model can both read.
 *
 * - drops ANSI colour/cursor sequences (the panel has no parser, and a model
 *   reading `\u001b[32m` learns nothing);
 * - `\r\n` becomes `\n`;
 * - a bare `\r` is a redraw: keep only what came after the last one on that
 *   line, which turns a progress bar's hundred redraws into its final state;
 * - a `\b` erases the character before it (`|\b/\b-` spinners), because the
 *   panel cannot render a backspace.
 */
/** One command line, the one our own protocol writes to the shell's stdin. */
const markerLine = (token: string): string => `printf '\\n__sc:%s:%d\\t%s\\n' '${token}' "$?" "$PWD"\n`;

/**
 * A program that reads stdin (`cat`, `sed`, `python -i`) can swallow the
 * sentinel and then echo it back. That is the operator's transcript, not ours:
 * drop the line so nobody ever reads our plumbing. The token is random, so real
 * output that happens to contain `__sc:` is not a realistic concern.
 */
export function stripProtocol(text: string): string {
  if (!text.includes("__sc:")) return text;
  return text
    .split("\n")
    .filter((line) => !/^\s*printf ['"]\\n__sc:/.test(line) && !/^__sc:[a-z0-9]{6,}:\d+\t/.test(line))
    .join("\n");
}

/**
 * Where a command's marker sits in the buffer, if it has fully arrived.
 *
 * The marker is normally preceded by a newline, but a chunk boundary can land
 * exactly between that newline and `__sc:` — at which point the buffer *starts*
 * with the marker. Both positions must match: missing the second one lost the
 * sentinel and made the terminal answer "still running" forever (an
 * intermittent hang, reproduced in /tmp before this was fixed).
 */
export function findMarker(buffer: string, token: string): { at: number; bodyStart: number; end: number } | null {
  const needle = `__sc:${token}:`;
  const prefixed = buffer.indexOf(`\n${needle}`);
  const at = prefixed >= 0 ? prefixed + 1 : buffer.startsWith(needle) ? 0 : -1;
  if (at < 0) return null;
  const bodyStart = at + needle.length;
  const end = buffer.indexOf("\n", bodyStart);
  if (end < 0) return null;
  return { at, bodyStart, end };
}

/**
 * How much of the buffer is safe to show while a command is running: everything
 * before a marker, and never a marker that is still arriving. A half-written
 * marker must stay hidden, or the panel prints our plumbing.
 */
export function visibleBeforeMarker(buffer: string, token: string): number {
  const needle = `__sc:${token}:`;
  const prefixed = buffer.indexOf(`\n${needle}`);
  if (prefixed >= 0) return prefixed;
  if (buffer.startsWith(needle)) return 0;
  const partial = buffer.lastIndexOf("\n__sc:");
  if (partial >= 0 && buffer.length - partial < 96) return partial;
  // A chunk can also end mid-marker at the very start of the buffer.
  if (!buffer.includes("\n") && /^__(s(c(:[a-z0-9]*)?)?)?$/.test(buffer)) return 0;
  return buffer.length;
}

export function cleanTerminalText(raw: string): string {
  let text = raw.replace(ANSI, "");
  text = text.replace(/\r\n/g, "\n");
  if (text.includes("\r")) {
    text = text
      .split("\n")
      .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
      .join("\n");
  }
  if (text.includes("\b")) {
    // Backspace is destructive: apply it left to right over what is already clean.
    const out: string[] = [];
    for (const ch of text) {
      if (ch === "\b") out.pop();
      else out.push(ch);
    }
    text = out.join("");
  }
  return text;
}

/* ------------------------------------------------------------------ types --- */

export interface TerminalInfo {
  id: string;
  name: string;
  /** Live working directory (the shell reports it with every command). */
  cwd: string;
  /** The shell's own path, for the panel header. */
  shell: string;
  status: "idle" | "running" | "exited";
  /** Last exit code, or null before the first command. */
  lastExit: number | null;
  busy: boolean;
  /** Session that created it (for display; terminals are shared). */
  owner: string;
  createdAt: number;
  /** Bytes currently held in the scrollback ring. */
  bytes: number;
  /** Monotonic output sequence — a UI asks for everything after this. */
  seq: number;
  command: string | null;
  pid: number;
}

export interface TerminalOptions {
  /** Max scrollback held per terminal, in KB. */
  scrollbackKb?: number;
  /** Default max wait for one command, ms. */
  waitMs?: number;
  /** Max number of terminals. */
  max?: number;
  shell?: string;
  log?: Logger;
}

export interface RunResult {
  output: string;
  exitCode: number | null;
  ms: number;
  /** True when waitMs expired before the command finished. */
  running: boolean;
  cwd: string;
  /** Set when the shell itself died while the command ran. */
  shellExited?: boolean;
}

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 1_800_000;
const DEFAULT_SCROLLBACK_KB = 200;
const DEFAULT_MAX_TERMINALS = 8;
const FLUSH_MS = 60;
/** Per-command output kept for the tool result (the ring holds the full tail). */
const MAX_COMMAND_OUTPUT = 256 * 1024;

const capOutput = (text: string): string =>
  text.length > MAX_COMMAND_OUTPUT ? text.slice(text.length - MAX_COMMAND_OUTPUT) : text;

/** A pid's direct children, without forking where the kernel can answer. */
function childPids(pid: number): number[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return raw ? raw.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    try {
      const out = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8", timeout: 2000 });
      return out
        .split("\n")
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  }
}

export function descendants(pid: number): number[] {
  const all: number[] = [];
  const stack = [pid];
  let guard = 0;
  while (stack.length > 0 && guard < 500) {
    guard += 1;
    for (const child of childPids(stack.pop()!)) {
      all.push(child);
      stack.push(child);
    }
  }
  return all;
}

/** The same shell preference order the exec tool uses. */
export function findTerminalShell(preferred?: string): string {
  if (preferred && preferred.trim()) return preferred.trim();
  const prefix = process.env["PREFIX"];
  const candidates = [
    prefix ? `${prefix}/bin/bash` : "",
    "/data/data/com.termux/files/usr/bin/bash",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      readFileSync(c);
      return c;
    } catch {
      /* try the next one */
    }
  }
  return "/bin/sh";
}

/* --------------------------------------------------------------- Terminal --- */

export class Terminal extends EventEmitter {
  readonly id: string;
  name: string;
  readonly shell: string;
  readonly owner: string;
  readonly createdAt = Date.now();
  cwd: string;
  status: "idle" | "running" | "exited" = "idle";
  lastExit: number | null = null;
  command: string | null = null;
  pid = 0;

  #proc: ChildProcessWithoutNullStreams | null = null;
  /** Bytes that may still contain the sentinel — never shown as output. */
  #buffer = "";
  #scroll = "";
  #cap: number;
  #seq = 0;
  #escTail = "";
  /**
   * The command the shell is running right now — deliberately separate from
   * "someone is waiting for it". When `waitMs` expires the caller stops
   * waiting, but the sentinel is still owed: if we forgot the token we would
   * print our own marker into the transcript and never learn the exit code.
   */
  #active: {
    token: string;
    command: string;
    startedAt: number;
    finish: ((r: Omit<RunResult, "cwd">) => void) | null;
    /**
     * Everything this command printed, accumulated as it streams in.
     * The raw buffer is consumed on arrival (the panel sees output live), so
     * by the time the sentinel lands only the last fragment is still there —
     * returning the buffer alone would lose every earlier chunk.
     */
    out: string;
  } | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #flushBuf = "";
  #log?: Logger;
  #stopped = false;

  constructor(opts: {
    id: string;
    name?: string;
    cwd: string;
    owner?: string;
    shell?: string;
    scrollbackKb?: number;
    log?: Logger;
  }) {
    super();
    this.id = opts.id;
    this.name = opts.name?.trim() || opts.id;
    this.cwd = opts.cwd;
    this.owner = opts.owner ?? "";
    this.shell = findTerminalShell(opts.shell);
    this.#cap = Math.max(8, opts.scrollbackKb ?? DEFAULT_SCROLLBACK_KB) * 1024;
    this.#log = opts.log;
    this.#spawn();
  }

  /** Scrollback limit changed (config hot-reload): keep the newest bytes. */
  resizeRing(scrollbackKb: number): void {
    this.#cap = Math.max(8, scrollbackKb) * 1024;
    if (this.#scroll.length > this.#cap) {
      this.#scroll = this.#scroll.slice(this.#scroll.length - this.#cap);
      this.emit("state");
    }
  }

  get seq(): number {
    return this.#seq;
  }

  get bytes(): number {
    return Buffer.byteLength(this.#scroll, "utf8");
  }

  get busy(): boolean {
    return this.#active !== null;
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      shell: this.shell,
      status: this.status,
      lastExit: this.lastExit,
      busy: this.busy,
      owner: this.owner,
      createdAt: this.createdAt,
      bytes: this.bytes,
      seq: this.#seq,
      command: this.command,
      pid: this.pid,
    };
  }

  /** The whole ring (with its sequence). `since` is honoured only for "nothing new". */
  output(since = 0): { text: string; seq: number } {
    if (since > 0 && since >= this.#seq) return { text: "", seq: this.#seq };
    return { text: this.#scroll, seq: this.#seq };
  }

  /** The tail of the scrollback, `lines` deep. */
  tail(lines = 80): string {
    const all = this.#scroll.split("\n");
    return all.slice(Math.max(0, all.length - Math.max(1, lines))).join("\n");
  }

  #spawn(): void {
    const proc = spawn(this.shell, [], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.#proc = proc;
    this.pid = proc.pid ?? 0;
    this.status = "idle";
    const onData = (chunk: Buffer): void => this.#onData(chunk.toString());
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.stdin.on("error", () => {
      /* the shell went away; the exit handler owns the reporting */
    });
    proc.on("error", (err) => {
      this.#log?.error(`terminal ${this.id}: ${err.message}`);
      this.#onExit(null, true);
    });
    proc.on("exit", (code) => this.#onExit(code, false));
    // A terminal shows one stream. Two pipes give no ordering guarantee (a
    // command writing to stderr could land *after* its own exit sentinel), so
    // the shell merges them once, at the start, and every child inherits it.
    if (this.pid) proc.stdin.write("exec 2>&1\n");
  }

  #onExit(code: number | null, spawnFailed: boolean): void {
    const active = this.#active;
    this.status = "exited";
    this.#active = null;
    this.lastExit = code ?? this.lastExit;
    if (active) {
      // Never leave a caller hanging: `exit`, `kill -9 $$`, and a shell that
      // cannot even start all land here.
      active.finish?.({
        output: this.#visibleOutput(),
        exitCode: code,
        ms: Date.now() - active.startedAt,
        running: false,
        shellExited: true,
      });
    }
    if (!this.#stopped) {
      const why = spawnFailed ? "the shell could not be started" : `the shell exited (${code ?? "signal"})`;
      this.#append(`\n[terminal] ${why} — this terminal is done. Create a new one, or restart it.\n`);
      this.emit("state");
    }
  }

  #onData(raw: string): void {
    this.#buffer += raw;
    const active = this.#active;
    if (active) {
      // Both marker positions (after a newline, or at buffer start) — see
      // findMarker for why the second one matters.
      const found = findMarker(this.#buffer, active.token);
      if (found) {
        const { at, bodyStart, end } = found;
        const [codeRaw, cwdRaw] = this.#buffer.slice(bodyStart, end).split("\t");
        const exitCode = Number(codeRaw);
        if (cwdRaw) this.cwd = cwdRaw;
        // Keep the separating newline when the marker sat after other output.
        const before = this.#buffer.slice(0, Math.max(0, at > 0 && this.#buffer[at - 1] === "\n" ? at - 1 : at));
        // Anything after the sentinel belongs to the next command.
        this.#buffer = this.#buffer.slice(end + 1);
        // The tail arrives with the sentinel; the rest already streamed.
        const tail = this.#clean(before);
        if (tail) {
          active.out = capOutput(active.out + tail);
          this.#append(tail);
        }
        const output = active.out;
        this.#active = null;
        this.status = "idle";
        this.lastExit = Number.isFinite(exitCode) ? exitCode : null;
        this.command = null;
        this.emit("state");
        active.finish?.({
          output,
          exitCode: this.lastExit,
          ms: Date.now() - active.startedAt,
          running: false,
        });
        return;
      }
    }
    // No complete sentinel yet: stream what is safe to show, and hold the rest.
    const visible = this.#visiblePrefix();
    this.#buffer = this.#buffer.slice(visible.length);
    const text = this.#clean(visible);
    if (text) {
      if (this.#active) this.#active.out = capOutput(this.#active.out + text);
      this.#append(text);
    }
  }

  /**
   * The part of the buffer that cannot be (or lead into) a sentinel.
   * Holding it back is what keeps a partial marker — or a half-arrived escape
   * sequence — out of the transcript.
   */
  #visiblePrefix(): string {
    const active = this.#active;
    if (active) return this.#buffer.slice(0, visibleBeforeMarker(this.#buffer, active.token));
    return this.#buffer;
  }

  /** ANSI/`\r` cleaning with a split-escape guard across chunks. */
  #clean(chunk: string): string {
    const [complete, tail] = splitIncompleteEscape(this.#escTail + chunk);
    this.#escTail = tail;
    return stripProtocol(cleanTerminalText(complete));
  }

  /** Append cleaned text to the ring, queue a throttled live event, return it. */
  #append(text: string): string {
    if (!text) return "";
    this.#scroll += text;
    if (this.#scroll.length > this.#cap) {
      const cut = this.#scroll.slice(this.#scroll.length - this.#cap);
      const nl = cut.indexOf("\n");
      // trim to a line boundary so the panel never starts mid-word
      this.#scroll = nl >= 0 ? cut.slice(nl + 1) : cut;
    }
    this.#seq += 1;
    this.#flushBuf += text;
    if (this.#flushTimer === null) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        const payload = this.#flushBuf;
        this.#flushBuf = "";
        if (payload) this.emit("output", { text: payload, seq: this.#seq, cwd: this.cwd });
      }, FLUSH_MS);
      this.#flushTimer.unref?.();
    }
    return text;
  }

  #visibleOutput(): string {
    const out = this.#clean(this.#buffer);
    this.#buffer = "";
    this.#append(out);
    return out;
  }

  /**
   * Write a command and wait for its sentinel.
   *
   * `waitMs` expiring is not a failure: the command keeps running and the
   * result says so, so the agent can poll (`terminal read`) or interrupt.
   */
  async run(command: string, waitMs = DEFAULT_WAIT_MS): Promise<RunResult> {
    const cmd = command.replace(/\r\n/g, "\n").trim();
    if (!cmd) return { output: "", exitCode: null, ms: 0, running: false, cwd: this.cwd };
    if (this.status === "exited" || !this.#proc) {
      return {
        output: `[terminal] this terminal's shell is gone (exit ${this.lastExit ?? "?"}) — create a new terminal, or restart this one`,
        exitCode: this.lastExit,
        ms: 0,
        running: false,
        cwd: this.cwd,
        shellExited: true,
      };
    }
    if (this.#active) {
      // A second command while one runs would interleave its output; refuse
      // rather than corrupt both. The caller can interrupt first.
      return {
        output: `[terminal] busy — "${this.command ?? "a command"}" is still running. Use terminal read to see its tail, or terminal interrupt to stop it.`,
        exitCode: null,
        ms: 0,
        running: true,
        cwd: this.cwd,
      };
    }
    const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const startedAt = Date.now();
    const label = cmd.split("\n")[0]!.slice(0, 200);
    this.status = "running";
    this.command = label;
    const done = new Promise<Omit<RunResult, "cwd">>((resolve) => {
      this.#active = { token, command: label, startedAt, finish: resolve, out: "" };
      this.#proc!.stdin.write(cmd + "\n" + markerLine(token));
    });
    this.emit("state");
    const cap = Math.max(1000, Math.min(waitMs, MAX_WAIT_MS));
    const expiry = new Promise<Omit<RunResult, "cwd">>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#active?.token === token) {
          // The caller stops waiting; the command keeps running and its
          // sentinel keeps being consumed (never printed).
          const so_far = this.#active.out;
          this.#active.finish = null;
          resolve({ output: so_far, exitCode: null, ms: Date.now() - startedAt, running: true });
        }
      }, cap);
      timer.unref?.();
      void done.finally(() => clearTimeout(timer));
    });
    const result = await Promise.race([done, expiry]);
    return { ...result, cwd: this.cwd };
  }

  /**
   * Ctrl-C for the running command: SIGINT its descendants, spare the shell.
   *
   * If the command is not a child process at all (a shell builtin loop), there
   * is nothing to signal — the shell itself is the runaway. Then the shell is
   * restarted in place, which keeps the terminal (and its id) usable.
   */
  /**
   * Start a command without waiting for it (the operator typing in the panel).
   * Output arrives as `output` events; the caller gets an immediate verdict.
   */
  send(command: string): { started: boolean; reason?: string } {
    if (this.busy) return { started: false, reason: `"${this.command ?? "a command"}" is still running — interrupt it first` };
    if (!command.trim()) return { started: false, reason: "the command is empty" };
    // The promise settles when the sentinel arrives; nobody is waiting for it.
    void this.run(command, 1000).catch(() => undefined);
    return { started: true };
  }

  async interrupt(): Promise<{ killed: number; restarted: boolean; output: string; resynced?: boolean }> {
    if (!this.#proc || this.status === "exited") return { killed: 0, restarted: false, output: "" };
    const token = this.#active?.token ?? null;
    const victims = descendants(this.pid);
    for (const pid of victims) {
      try {
        process.kill(pid, "SIGINT");
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    const left = descendants(this.pid);
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // A shell builtin loop (`while :; do :; done`) has no child to signal: the
    // shell itself is the runaway, so the only way back is a fresh shell.
    if (!token) return { killed: victims.length, restarted: false, output: "" };
    if (this.#active?.token !== token) return { killed: victims.length, restarted: false, output: "" };
    if (victims.length === 0 && left.length === 0) {
      this.restart();
      return { killed: 0, restarted: true, output: "" };
    }
    // Still busy ⇒ the command swallowed the sentinel (anything that reads
    // stdin does: cat, sed, python -i). Write it again so the shell re-syncs as
    // soon as the command is gone, instead of staying "busy" forever.
    this.#proc.stdin.write(markerLine(token));
    const resynced = await this.#waitIdle(2000);
    if (!resynced) {
      // The shell did not answer even after the kill: it is wedged. A fresh
      // shell is better than a terminal nothing can ever use again.
      this.restart();
      return { killed: victims.length, restarted: true, output: "" };
    }
    return { killed: victims.length, restarted: false, output: "", resynced: true };
  }

  /** Wait until no command is active (the sentinel landed), or give up. */
  #waitIdle(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        if (this.#active === null) return resolve(true);
        if (Date.now() - started >= ms) return resolve(false);
        const t = setTimeout(tick, 25);
        t.unref?.();
      };
      tick();
    });
  }

  /** Kill the shell and everything under it. */
  kill(): void {
    this.#stopped = true;
    const pid = this.pid;
    const active = this.#active;
    this.#active = null;
    if (active) {
      active.finish?.({ output: this.#visibleOutput(), exitCode: null, ms: 0, running: false, shellExited: true });
    }
    if (!pid) return;
    for (const child of descendants(pid)) {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    this.status = "exited";
  }

  clear(): void {
    this.#scroll = "";
    this.#seq += 1;
    this.emit("state");
  }

  /** Start a fresh shell in the same directory (after `exit`, or a runaway). */
  restart(): void {
    this.kill();
    this.#stopped = false;
    this.#buffer = "";
    this.#escTail = "";
    this.lastExit = null;
    this.command = null;
    this.#spawn();
    this.#append(`[terminal] restarted in ${this.cwd}\n`);
    this.emit("state");
  }
}

/* --------------------------------------------------------- TerminalManager --- */

export class TerminalManager {
  readonly log?: Logger;
  #terms = new Map<string, Terminal>();
  #defaults = new Map<string, string>();
  #opts: { max: number; scrollbackKb: number; waitMs: number; shell?: string };
  #seq = 0;
  #sink: ((payload: Record<string, unknown>) => void) | null = null;

  constructor(opts: TerminalOptions = {}) {
    this.log = opts.log;
    this.#opts = {
      max: Math.max(1, opts.max ?? DEFAULT_MAX_TERMINALS),
      scrollbackKb: Math.max(8, opts.scrollbackKb ?? DEFAULT_SCROLLBACK_KB),
      waitMs: Math.min(Math.max(opts.waitMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS),
      shell: opts.shell,
    };
  }

  /**
   * Apply a config change without disturbing open shells: limits are read on
   * every create/run, and shrinking `max` below what is already open never
   * closes a terminal the agent is using — it just refuses new ones.
   */
  configure(next: { max?: number; scrollbackKb?: number; waitMs?: number }): void {
    if (next.max !== undefined) this.#opts.max = Math.max(1, Math.min(32, Math.trunc(next.max)));
    if (next.scrollbackKb !== undefined) {
      this.#opts.scrollbackKb = Math.max(8, Math.min(2048, Math.trunc(next.scrollbackKb)));
      for (const term of this.#terms.values()) term.resizeRing(this.#opts.scrollbackKb);
    }
    if (next.waitMs !== undefined) this.#opts.waitMs = Math.min(Math.max(Math.trunc(next.waitMs), 1000), MAX_WAIT_MS);
  }

  get size(): number {
    return this.#terms.size;
  }

  get defaultWaitMs(): number {
    return this.#opts.waitMs;
  }

  get max(): number {
    return this.#opts.max;
  }

  create(input: { name?: string; cwd?: string; owner?: string; id?: string } = {}): Terminal {
    if (this.#terms.size >= this.#opts.max) {
      throw new Error(
        `terminal limit reached (${this.#opts.max} open) — kill one first: ${[...this.#terms.keys()].join(", ")}`,
      );
    }
    this.#seq += 1;
    const id = (input.id?.trim() || `t${this.#seq}`).replace(/[^\w.:-]/g, "-");
    if (this.#terms.has(id)) throw new Error(`a terminal called "${id}" already exists`);
    const term = new Terminal({
      id,
      name: input.name,
      cwd: input.cwd ?? process.cwd(),
      owner: input.owner,
      shell: this.#opts.shell,
      scrollbackKb: this.#opts.scrollbackKb,
      log: this.log,
    });
    this.#terms.set(id, term);
    term.on("output", (payload: { text: string; seq: number; cwd: string }) =>
      this.#emit({ type: "terminal", kind: "output", id, ...payload }),
    );
    term.on("state", () => this.#emit({ type: "terminal", kind: "state", id, terminal: term.info() }));
    this.#emit({ type: "terminal", kind: "created", id, terminal: term.info() });
    return term;
  }

  get(id: string): Terminal | undefined {
    return this.#terms.get(id);
  }

  require(id: string): Terminal {
    const term = this.#terms.get(id);
    if (!term) {
      const known = this.list().map((t) => t.id);
      throw new Error(`no terminal "${id}" — ${known.length ? `open: ${known.join(", ")}` : "none are open yet"}`);
    }
    return term;
  }

  list(): TerminalInfo[] {
    return [...this.#terms.values()].map((t) => t.info()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The terminal a session uses when nobody names one. */
  defaultFor(sessionKey: string, cwd: string): Terminal {
    const existing = this.#defaults.get(sessionKey);
    if (existing) {
      const term = this.#terms.get(existing);
      if (term && term.status !== "exited") return term;
    }
    const term = this.create({ owner: sessionKey, cwd });
    this.#defaults.set(sessionKey, term.id);
    return term;
  }

  /** Which terminal id a session's default points at, if any. */
  defaultId(sessionKey: string): string | null {
    return this.#defaults.get(sessionKey) ?? null;
  }

  kill(id: string): boolean {
    const term = this.#terms.get(id);
    if (!term) return false;
    term.kill();
    this.#terms.delete(id);
    for (const [key, value] of this.#defaults) if (value === id) this.#defaults.delete(key);
    this.#emit({ type: "terminal", kind: "removed", id });
    return true;
  }

  stop(): void {
    for (const term of this.#terms.values()) term.kill();
    this.#terms.clear();
    this.#defaults.clear();
  }

  #emit(payload: Record<string, unknown>): void {
    if (!this.#sink) return;
    try {
      this.#sink(payload);
    } catch (err) {
      this.log?.warn(`terminal event failed: ${(err as Error).message}`);
    }
  }

  /** The daemon wires this to its event bus; tests read it directly. */
  onEvent(sink: (payload: Record<string, unknown>) => void): void {
    this.#sink = sink;
  }
}

export const TERMINAL_DEFAULTS = {
  waitMs: DEFAULT_WAIT_MS,
  maxWaitMs: MAX_WAIT_MS,
  scrollbackKb: DEFAULT_SCROLLBACK_KB,
  max: DEFAULT_MAX_TERMINALS,
} as const;
