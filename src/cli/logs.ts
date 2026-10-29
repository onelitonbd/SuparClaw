// P2 #12 — `sc logs` (their cli/logs.md): bounded tail of the service log by
// default, plain substring --search, -f follow, --file to pick the daemon's
// other stream, --json for scripts. Bounded scans only (their history model).
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync, watch } from "node:fs";
import { join } from "node:path";
import { logsDir } from "../util/paths.js";

/** service.log = the unit's redirect; suparclaw.log = the daemon's own file. */
const FILE_CHOICES: Record<string, string> = {
  service: "service.log",
  daemon: "service.log",
  agent: "suparclaw.log",
};

export interface LogLine {
  ts: string | null;
  level: string | null;
  message: string;
  raw: string;
}

/** Best-effort parse of the createLogger format "<HH:MM:SS.mmm> LVL [scope] msg". */
export function parseLogLine(raw: string): LogLine {
  const m = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(DEBUG|INFO |WARN |ERROR)\s+(.*)$/.exec(raw);
  if (!m) return { ts: null, level: null, message: raw, raw };
  return { ts: m[1]!, level: m[2]!.trim(), message: m[3]!, raw };
}

/** Plain substring filter (their search shape; case-insensitive). */
export function filterLogLines(lines: string[], query: string): string[] {
  if (!query) return lines;
  const needle = query.toLowerCase();
  return lines.filter((l) => l.toLowerCase().includes(needle));
}

/** Last N lines without loading unbounded history (their tail model). */
export function readLogTail(path: string, n: number): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-Math.max(1, n));
}

/** New lines appended since a byte offset (the -f delta read). */
export function readLogDelta(path: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(path).size;
  if (size < offset) return { lines: [], offset: 0 }; // rotated or truncated
  if (size === offset) return { lines: [], offset };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.toString("utf8");
    const lines = chunk.split("\n").filter((l) => l.length > 0);
    // Keep the byte-accurate cursor even if the last line is still forming.
    const clean = chunk.endsWith("\n");
    return clean ? { lines, offset: size } : { lines: lines.slice(0, -1), offset: size - (lines.length > 0 ? Buffer.byteLength(chunk.split("\n").pop() ?? "", "utf8") : 0) };
  } finally {
    closeSync(fd);
  }
}

export function listLogFiles(dir = logsDir()): { file: string; size: number }[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ file: f, size: statSync(join(dir, f)).size }));
  } catch {
    return [];
  }
}

const USAGE = "usage: sc logs [-f] [--tail N] [--file service|agent] [--search q] [--json] [--files]";

/**
 * `sc logs` — bounded tail of logsDir()/service.log by default (the running
 * unit's combined stdout/stderr), the daemon's own suparclaw.log via
 * --file agent. Exit codes: 0 ok, 2 usage/no-logfile.
 */
export async function cmdLogs(args: string[]): Promise<number> {
  let follow = false;
  let tailN = 50;
  let fileKey = "service";
  let search = "";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-f" || a === "--follow") follow = true;
    else if ((a === "--tail" || a === "-n") && args[i + 1]) tailN = Math.max(1, Math.min(Number(args[++i]) || 50, 5000));
    else if (a === "--file" && args[i + 1]) fileKey = args[++i]!;
    else if (a === "--search" && args[i + 1]) search = args[++i]!;
    else if (a === "--json") json = true;
    else if (a === "--files") {
      const files = listLogFiles();
      if (json) console.log(JSON.stringify(files));
      else if (files.length === 0) console.log(`(no log files in ${logsDir()} yet)`);
      else for (const f of files) console.log(`${f.file}\t${f.size}b`);
      return 0;
    } else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      return 0;
    } else {
      console.error(USAGE);
      return 2;
    }
  }

  const fileName = FILE_CHOICES[fileKey] ?? (fileKey.endsWith(".log") || fileKey.includes("/") ? fileKey : `${fileKey}.log`);
  const path = join(logsDir(), fileName);
  let lines: string[];
  try {
    lines = readLogTail(path, tailN);
  } catch {
    console.error(`no log file at ${path} yet — start the service first (sc service run | sc gateway)`);
    return 2;
  }
  const print = (raw: string): void => {
    if (json) console.log(JSON.stringify({ file: fileName, ...parseLogLine(raw) }));
    else console.log(raw);
  };
  const shown = filterLogLines(lines, search);
  for (const l of shown) print(l);
  console.error(`— ${path} · tail ${lines.length}${search ? ` · ${shown.length} match "${search}"` : ""}${follow ? " · following…" : ""}`);
  if (!follow) return 0;

  // -f: fs.watch → byte-delta reads (bounded; survives quiet files).
  let { offset } = { offset: statSync(path).size };
  const watcher = watch(path, () => {
    try {
      const delta = readLogDelta(path, offset);
      offset = delta.offset;
      for (const l of filterLogLines(delta.lines, search)) print(l);
    } catch {
      /* file momentarily gone (rotation) — keep watching */
    }
  });
  console.error("(ctrl-c to stop)");
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      watcher.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
