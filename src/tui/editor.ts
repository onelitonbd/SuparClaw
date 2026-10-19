import { theme } from "./theme.js";
import { width } from "../util/ansi.js";

/** Multi-line composer with history. Enter = send, Shift+Enter/Ctrl+J = newline. */
export class Editor {
  lines: string[] = [""];
  y = 0;
  x = 0;
  history: string[] = [];
  histIndex = -1;
  private draft = "";

  get text(): string {
    return this.lines.join("\n").replace(/\s+$/, "");
  }

  get isEmpty(): boolean {
    return this.lines.join("").trim().length === 0;
  }

  clear(): void {
    this.lines = [""];
    this.y = 0;
    this.x = 0;
  }

  commit(): string {
    const text = this.text;
    if (text.length > 0) {
      this.history = [text, ...this.history.filter((h) => h !== text)].slice(0, 100);
    }
    this.histIndex = -1;
    this.clear();
    return text;
  }

  insert(ch: string): void {
    const line = this.lines[this.y] as string;
    this.lines[this.y] = line.slice(0, this.x) + ch + line.slice(this.x);
    this.x += ch.length;
  }

  newline(): void {
    const line = this.lines[this.y] as string;
    const head = line.slice(0, this.x);
    const tail = line.slice(this.x);
    this.lines.splice(this.y, 1, head, tail);
    this.y += 1;
    this.x = 0;
  }

  backspace(): void {
    if (this.x > 0) {
      const line = this.lines[this.y] as string;
      this.lines[this.y] = line.slice(0, this.x - 1) + line.slice(this.x);
      this.x -= 1;
      return;
    }
    if (this.y > 0) {
      const prev = this.lines[this.y - 1] as string;
      this.x = prev.length;
      this.lines.splice(this.y - 1, 2, prev + (this.lines[this.y] as string));
      this.y -= 1;
    }
  }

  delete(): void {
    const line = this.lines[this.y] as string;
    if (this.x < line.length) {
      this.lines[this.y] = line.slice(0, this.x) + line.slice(this.x + 1);
      return;
    }
    if (this.y < this.lines.length - 1) {
      this.lines.splice(this.y, 2, line + (this.lines[this.y + 1] as string));
    }
  }

  left(): void {
    if (this.x > 0) this.x -= 1;
    else if (this.y > 0) {
      this.y -= 1;
      this.x = (this.lines[this.y] as string).length;
    }
  }

  right(): void {
    const line = this.lines[this.y] as string;
    if (this.x < line.length) this.x += 1;
    else if (this.y < this.lines.length - 1) {
      this.y += 1;
      this.x = 0;
    }
  }

  up(): void {
    if (this.y === 0) {
      this.#historyPrev();
      return;
    }
    this.y -= 1;
    this.x = Math.min(this.x, (this.lines[this.y] as string).length);
  }

  down(): void {
    if (this.y === this.lines.length - 1) {
      this.#historyNext();
      return;
    }
    this.y += 1;
    this.x = Math.min(this.x, (this.lines[this.y] as string).length);
  }

  home(): void {
    this.x = 0;
  }

  end(): void {
    this.x = (this.lines[this.y] as string).length;
  }

  clearLine(): void {
    this.lines[this.y] = "";
    this.x = 0;
  }

  #historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIndex === -1) this.draft = this.text;
    this.histIndex = Math.min(this.histIndex + 1, this.history.length - 1);
    this.lines = [(this.history[this.histIndex] as string)].flatMap((l) => l.split("\n"));
    this.y = this.lines.length - 1;
    this.x = (this.lines[this.y] as string).length;
  }

  #historyNext(): void {
    if (this.histIndex <= -1) return;
    this.histIndex -= 1;
    if (this.histIndex === -1) {
      this.lines = this.draft.split("\n");
      this.draft = "";
    } else {
      this.lines = [(this.history[this.histIndex] as string)].flatMap((l) => l.split("\n"));
    }
    this.y = this.lines.length - 1;
    this.x = (this.lines[this.y] as string).length;
  }

  /** Boxed composer: top rule, "> " prefixed lines, bottom rule. */
  render(cols: number): { lines: string[]; cursor: { row: number; col: number } } {
    const inner = Math.max(10, cols - 4);
    const out: string[] = [theme.border(`╭${"─".repeat(inner)}╮`)];
    for (const line of this.lines) {
      const visible = width(line) > inner ? line.slice(0, inner) : line;
      out.push(`${theme.border("│")} ${theme.text(visible)}${" ".repeat(Math.max(0, inner - width(visible)))} ${theme.border("│")}`);
    }
    out.push(theme.border(`╰${"─".repeat(inner)}╯`));
    return { lines: out, cursor: { row: this.y + 1, col: this.x + 2 } };
  }
}