// Self-supervising gateway — OpenClaw's host-lifecycle/guardian idea, adapted
// to one Termux process tree. `sc gateway` normally runs this PARENT: it spawns
// the real gateway as a child (`sc gateway --child`) and respawns it INSTANTLY
// after any unexpected exit, forever. "Never give up" is the point of the
// daemon. Intentional stops (SIGINT/SIGTERM to the parent) propagate to the
// child and do not respawn. A crash-loop guard logs a warning and holds once
// after fast repeated crashes so a broken config cannot burn the CPU — it then
// keeps going (OpenClaw's crash-loop breaker hint, at our scale).

import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { logsDir } from "../util/paths.js";

export const CHILD_FLAG = "--child";
export const NO_SUPERVISE_FLAG = "--no-supervise";
export const SUPERVISOR_PID_ENV = "SUPARCLAW_SUPERVISOR_PID";

export function isChildRun(args: string[]): boolean {
  return args.includes(CHILD_FLAG);
}

export function supervisionDisabled(args: string[]): boolean {
  return args.includes(NO_SUPERVISE_FLAG) || process.env.SUPARCLAW_NO_SUPERVISE === "1";
}

function logLine(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 19)} INFO  [supervisor] ${line}`;
  console.log(stamped);
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(join(logsDir(), "service.log"), stamped + "\n");
  } catch {
    /* log dir unavailable - stdout still has it */
  }
}

/**
 * Supervisor loop. Resolves only when the child exited after an intentional
 * stop was requested. Otherwise it respawns the child for as long as it runs.
 */
export async function superviseGateway(args: string[]): Promise<number> {
  // --restart is a one-shot takeover (handled by the caller); it must not
  // linger into respawns or the fresh child would try to stop itself.
  const childCliArgs = args.filter((a) => a !== "--restart" && a !== CHILD_FLAG && a !== NO_SUPERVISE_FLAG);
  const entry = process.argv[1] as string;

  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  let fastCrashes = 0;

  return await new Promise<number>((resolve) => {
    const spawnChild = (): void => {
      const spawnedAt = Date.now();
      const c = spawn(process.execPath, [entry, "gateway", CHILD_FLAG, ...childCliArgs], {
        stdio: "inherit",
        env: { ...process.env, [SUPERVISOR_PID_ENV]: String(process.pid) },
      });
      child = c;
      c.on("error", (err) => {
        child = null;
        if (stopping) return;
        logLine(`could not spawn the gateway: ${err.message} — retrying`);
        setTimeout(spawnChild, 1000);
      });
      c.on("exit", (code, signal) => {
        child = null;
        if (stopping) {
          resolve(code ?? 0);
          return;
        }
        restarts += 1;
        const ranMs = Date.now() - spawnedAt;
        if (ranMs < 3000) fastCrashes += 1;
        else fastCrashes = 0;
        const why = signal ? `signal ${signal}` : `code ${code ?? 0}`;
        logLine(`gateway exited (${why}) after ${(ranMs / 1000).toFixed(1)}s — restarting now (restart #${restarts})`);
        if (fastCrashes > 0 && fastCrashes % 5 === 0) {
          // Lightning rod for a broken setup: warn + one hold, then continue.
          logLine(`crash loop: ${fastCrashes} consecutive fast exits — holding 3s once, then continuing. Check: sc logs / sc doctor`);
          setTimeout(spawnChild, 3000);
        } else {
          spawnChild();
        }
      });
    };

    const requestStop = (sig: "SIGINT" | "SIGTERM"): void => {
      if (stopping) return;
      stopping = true;
      if (child) child.kill(sig);
      else resolve(0);
    };
    process.on("SIGINT", () => {
      console.log("\nstopping the daemon (supervisor)…");
      requestStop("SIGINT");
    });
    process.on("SIGTERM", () => {
      requestStop("SIGTERM");
    });

    logLine(`supervising the gateway (pid ${process.pid}) — it restarts on crash; ctrl+c stops everything`);
    spawnChild();
  });
}

/**
 * Child-side lifeline: when the supervisor dies without forwarding (SIGKILL),
 * the child would be orphaned and keep the port. Poll the parent pid and exit
 * gracefully as soon as it is gone. Polls parent existence, not time budgets.
 */
export function watchSupervisor(onGone: () => Promise<void>): void {
  const pid = Number(process.env[SUPERVISOR_PID_ENV] ?? 0);
  if (!Number.isFinite(pid) || pid <= 1) return;
  const timer = setInterval(() => {
    if (process.ppid === 1) {
      clearInterval(timer);
      void onGone();
    }
  }, 750);
  timer.unref();
}
