/** P3 #19 — duration/byte-size parsing shared by session maintenance config. */

// Duration units → milliseconds. Accepts their spellings: ms, s, m, min,
// h, hr, d, day, w, week (singular/plural, case-insensitive).
const DURATION_UNITS: [RegExp, number][] = [
  [/^ms|milliseconds?$/i, 1],
  [/^s$|^sec(ond)?s?$/i, 1_000],
  [/^m$|^min(ute)?s?$/i, 60_000],
  [/^h$|^hours?$/i, 3_600_000],
  [/^d$|^days?$/i, 86_400_000],
  [/^w$|^weeks?$/i, 604_800_000],
];

/**
 * Parse a human duration ("30d", "12h", "90m", "45s", "1500ms") or a bare
 * number (milliseconds). Empty / "0" / false / unset return null
 * (disabled semantics — their preserveRecent/resetArchiveRetention contract
 * where false or 0 opts out).
 */
export function parseDurationMs(input: string | number | false | null | undefined): number | null {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  const text = input.trim();
  if (!text || text === "0" || text === "false") return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "ms").trim();
  for (const [re, mult] of DURATION_UNITS) if (re.test(unit)) return Math.round(value * mult);
  return null;
}

// Byte units → bytes (1024-based, what a disk budget measures).
const BYTE_UNITS: [RegExp, number][] = [
  [/^b$|^bytes?$/i, 1],
  [/^k(b?)$|^kib$/i, 1024],
  [/^m(b?)$|^mib$/i, 1024 ** 2],
  [/^g(b?)$|^gib$/i, 1024 ** 3],
  [/^t(b?)$|^tib$/i, 1024 ** 4],
];

/**
 * Parse a byte size ("10gb", "512mb", "1g", "10 GB") or a bare number
 * (bytes). Empty / "0" / false / unset return null — their maxDiskBytes
 * "Set false, 0, or \"0\" to disable the budget entirely" contract.
 */
export function parseByteSize(input: string | number | false | null | undefined): number | null {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  const text = input.trim();
  if (!text || text === "0" || text === "false") return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "").trim();
  if (!unit) return Math.round(value);
  for (const [re, mult] of BYTE_UNITS) if (re.test(unit)) return Math.round(value * mult);
  return null;
}
