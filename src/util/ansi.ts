// Terminal text helpers: width-aware truncate/wrap, ANSI stripping, control sanitizing.

const ESC_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// C0 controls except tab/newline, plus CSI/OSC sequences and stray ESC.
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ESC_RE, "").replace(CONTROL_RE, "");
}

/** Kill anything that could move the cursor, clear the screen, or hide input. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(ESC_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\r\n?/g, "\n");
}

/** Approximate terminal cell width (CJK + emoji = 2, combining marks = 0). */
export function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Visible width of a string, ignoring ANSI escapes. */
export function width(text: string): number {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** UTF-16-safe truncation to `limit` display cells, appending an ellipsis when cut. */
export function truncateToWidth(text: string, limit: number, ellipsis = "…"): string {
  if (limit <= 0) return "";
  if (width(text) <= limit) return text;
  const ell = width(ellipsis);
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > Math.max(0, limit - ell)) break;
    out += ch;
    w += cw;
  }
  return out.replace(/\s+$/, "") + ellipsis;
}

/** Pad to `cells` display columns (truncating when too long). */
export function padToWidth(text: string, cells: number): string {
  const t = truncateToWidth(text, cells);
  return t + " ".repeat(Math.max(0, cells - width(t)));
}

/** Word-wrap to `cols` cells; preserves explicit newlines. */
export function wrapText(text: string, cols: number): string[] {
  if (cols <= 0) return [];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of rawLine.split(/(\s+)/)) {
      if (word.length === 0) continue;
      const ww = width(word);
      if (lineW + ww > cols && line.trim().length > 0) {
        out.push(line.replace(/\s+$/, ""));
        line = "";
        lineW = 0;
      }
      if (ww > cols) {
        // Hard-split a long token (URLs, base64).
        let chunk = "";
        let chunkW = 0;
        for (const ch of word) {
          const cw = charWidth(ch.codePointAt(0) ?? 0);
          if (chunkW + cw > cols) {
            out.push(chunk);
            chunk = "";
            chunkW = 0;
          }
          chunk += ch;
          chunkW += cw;
        }
        line = chunk;
        lineW = chunkW;
        continue;
      }
      line += word;
      lineW += ww;
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}