import type { Writable } from "node:stream";
import { width } from "../util/ansi.js";

// Pure-JS differential renderer (same technique as @earendil-works/pi-tui):
// render a frame to lines, compare with the previous frame, rewrite only rows
// that changed. No native dependency, which is what makes it work on Termux.

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CLEAR_EOL = `${ESC}[K`;
const HOME = `${ESC}[H`;

export class Screen {
  #prev: string[] = [];
  #entered = false;
  #out: Writable;
  #rows = 0;
  #cols = 0;

  constructor(out: Writable = process.stdout) {
    this.#out = out;
  }

  get rows(): number {
    return this.#rows;
  }

  get cols(): number {
    return this.#cols;
  }

  enter(): void {
    if (this.#entered) return;
    this.#entered = true;
    this.#out.write(`${ALT_ON}${HIDE_CURSOR}${HOME}${ESC}[2J`);
    this.#resize();
    if (typeof this.#out.on === "function") {
      this.#out.on("resize", () => {
        this.#resize();
        this.#prev = [];
        this.#out.write(`${ESC}[2J${HOME}`);
      });
    }
  }

  exit(): void {
    if (!this.#entered) return;
    this.#entered = false;
    this.#out.write(`${SHOW_CURSOR}${ALT_OFF}`);
  }

  #resize(): void {
    const tty = this.#out as unknown as { rows?: number; columns?: number };
    this.#rows = tty.rows ?? process.stdout.rows ?? 24;
    this.#cols = tty.columns ?? process.stdout.columns ?? 80;
  }

  /** Draw a full frame; only changed rows are repainted. */
  draw(lines: string[]): void {
    if (!this.#entered) return;
    this.#resize();
    const rows = Math.max(1, this.#rows);
    const cols = Math.max(8, this.#cols);

    // Trim overlong lines (never wrap ourselves — the composer already wraps).
    const frame = lines.map((line) => (width(line) > cols ? clipToWidth(line, cols) : line));
    // Scroll: keep the newest rows.
    const visible = frame.length > rows ? frame.slice(frame.length - rows) : frame;

    let out = HOME;
    for (let i = 0; i < rows; i++) {
      const next = visible[i] ?? "";
      const prev = this.#prev[i] ?? "";
      if (prev === next) continue;
      if (i > 0) out += `${ESC}[${i + 1};1H`;
      out += next + CLEAR_EOL;
    }
    // Shrinking the frame: clear leftover rows.
    if (this.#prev.length > visible.length) {
      for (let i = visible.length; i < Math.min(this.#prev.length, rows); i++) {
        out += `${ESC}[${i + 1};1H${CLEAR_EOL}`;
      }
    }
    if (out !== HOME) this.#out.write(out);
    this.#prev = visible;
  }

  /** Force a full repaint (after resize or overlay close). */
  invalidate(): void {
    this.#prev = [];
    if (this.#entered) this.#out.write(`${ESC}[2J${HOME}`);
  }
}

/** Clip while keeping escape sequences (they cost no cells). */
export function clipToWidth(text: string, cols: number): string {
  let out = "";
  let w = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const wch = charWidthLocal(cp);
    if (w + wch > cols) break;
    out += ch;
    w += wch;
    i += ch.length;
  }
  return out;
}

function charWidthLocal(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

/** Centre a title in a rule, e.g. section headers. */
export function rule(cols: number, title = ""): string {
  if (!title) return "─".repeat(cols);
  const left = 3;
  const rest = Math.max(0, cols - left - title.length - 1);
  return `─── ${title} ${"─".repeat(rest)}`;
}