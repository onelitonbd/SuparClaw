import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|[0-9]{8,}:[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

export function redact(text: string): string {
  return text.replace(SECRET_RE, "«redacted»");
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: unknown): void;
  error(msg: string, fields?: unknown): void;
  child(scope: string): Logger;
}

function format(level: LogLevel, scope: string, msg: string, fields?: unknown): string {
  const ts = new Date().toISOString().slice(11, 23);
  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}${msg}`;
  if (fields instanceof Error) line += ` :: ${fields.message}`;
  else if (fields !== undefined) {
    try {
      line += ` ${JSON.stringify(fields)}`;
    } catch {
      line += " «unserializable»";
    }
  }
  return redact(line);
}

export function createLogger(opts: { level?: LogLevel; file?: string; scope?: string } = {}): Logger {
  const level = opts.level ?? (process.env.SUPARCLAW_LOG_LEVEL as LogLevel) ?? "info";
  const scope = opts.scope ?? "";
  const file = opts.file;

  const write = (lvl: LogLevel, msg: string, fields?: unknown) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = format(lvl, scope, msg, fields);
    if (lvl === "error" || lvl === "warn") process.stderr.write(line + "\n");
    if (file) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, line + "\n");
      } catch {
        /* logging must never throw */
      }
    }
  };

  const mk = (s: string): Logger => ({
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (child) => mk(s ? `${s}:${child}` : child),
  });
  return mk(scope);
}