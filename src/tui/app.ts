import { theme, palette } from "./theme.js";
import { renderMarkdown } from "./markdown.js";
import { Screen } from "./renderer.js";
import { Editor } from "./editor.js";
import { parseKeys, type KeyEvent } from "./keys.js";
import { width } from "../util/ansi.js";

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; name: string; status: "running" | "done" | "error"; detail?: string }
  | { kind: "system"; text: string };

export type Approval = { callId: string; tool: string; args: Record<string, unknown> };

export interface TuiDeps {
  header(): { agent: string; session: string; model: string; target: string };
  onSubmit(text: string): void;
  onAbort(): void;
  onApproval(callId: string, ok: boolean): void;
  onCommand(name: string, args: string): Promise<string | null>;
  listSessions(): Promise<string[]>;
  pickSession(key: string): void;
  history(): Promise<{ role: string; content: string }[]>;
  models(): Promise<string[]>;
  setModel(model: string): Promise<string | null>;
  quit(): void;
}

interface Overlay {
  title: string;
  options: string[];
  filter: string;
  onPick: (option: string) => void;
}

export class TuiApp {
  items: Item[] = [];
  status = "ready";
  approvals: Approval[] = [];
  busy = false;
  expandedTools = false;
  showThinking = false;
  tokenHint = "";

  #screen = new Screen();
  #editor = new Editor();
  #overlay: Overlay | null = null;
  #dirty = true;
  #running = true;
  #resolveDone: (() => void) | null = null;
  #stdin: NodeJS.ReadStream;

  constructor(
    private readonly deps: TuiDeps,
    stdin: NodeJS.ReadStream = process.stdin,
  ) {
    this.#stdin = stdin;
  }

  push(item: Item): void {
    const last = this.items[this.items.length - 1];
    if (item.kind === "assistant") {
      if (last && last.kind === "assistant" && last.streaming) {
        last.text += item.text;
        last.streaming = item.streaming ?? true;
      } else {
        this.items.push(item);
      }
    } else if (item.kind === "tool") {
      if (last && last.kind === "tool" && last.status === "running") {
        last.status = item.status;
        last.detail = item.detail;
      } else {
        this.items.push(item);
      }
    } else {
      this.items.push(item);
    }
    if (this.items.length > 400) this.items.splice(0, this.items.length - 400);
    this.markDirty();
  }

  setStatus(status: string): void {
    this.status = status;
    this.markDirty();
  }

  markDirty(): void {
    this.#dirty = true;
  }

  /** Stop the render loop (deps.quit is invoked separately by the caller if needed). */
  quit(): void {
    this.#running = false;
    this.#resolveDone?.();
  }

  #compose(): string[] {
    const cols = this.#screen.cols;
    const head = this.deps.header();
    const out: string[] = [];

    // Header
    out.push(
      theme.header(" suparclaw ") +
        theme.dim(" · ") +
        theme.accentSoft(head.agent) +
        theme.dim(" · ") +
        theme.text(head.session) +
        theme.dim(" · ") +
        theme.text(head.model) +
        theme.dim(" · ") +
        theme.dim(head.target),
    );
    out.push(theme.border("─".repeat(cols)));

    // Transcript
    for (const item of this.items) {
      out.push(...this.#renderItem(item, cols));
    }

    // Pending approvals
    for (const approval of this.approvals) {
      out.push("");
      out.push(theme.toolPendingBg(` ⚠ approve: ${approval.tool}(${JSON.stringify(approval.args).slice(0, cols - 24)}) [y/n] `));
    }

    // Status line + footer hints
    out.push(theme.border("─".repeat(cols)));
    const dot = this.busy ? theme.accent("●") : this.status === "error" ? theme.error("●") : theme.success("●");
    out.push(
      `${dot} ${theme.dim(this.status)}${this.tokenHint ? theme.dim(`  ${this.tokenHint}`) : ""}`,
    );
    out.push(
      theme.dim(
        " ⏎ send · ⇧⏎ newline · ^L model · ^P session · ^O tools · ^T thinking · ^C clear · ^D quit",
      ),
    );

    const editor = this.#editor.render(cols);
    out.push(...editor.lines);

    if (this.#overlay) {
      out.push("");
      out.push(theme.header(` ${this.#overlay.title} `));
      out.push(theme.dim(` filter: ${this.#overlay.filter}_`));
      const matches = this.#matches();
      matches.slice(0, 12).forEach((option, i) => {
        out.push(`${theme.accent(i === 0 ? " ❯ " : "   ")}${theme.text(option)}`);
      });
      if (matches.length === 0) out.push(theme.dim("  no matches"));
      out.push(theme.dim(" ↑↓ select · ⏎ pick · esc cancel"));
    }

    return out;
  }

  #renderItem(item: Item, cols: number): string[] {
    switch (item.kind) {
      case "user": {
        const body = item.text.split("\n");
        const out: string[] = [];
        for (const line of body) {
          const padded = ` ${line} `;
          out.push(theme.userBg(theme.userText(padded)));
        }
        out.push("");
        return out;
      }
      case "assistant": {
        const lines = renderMarkdown(item.text, cols);
        if (item.streaming && lines.length > 0) {
          const last = lines[lines.length - 1] as string;
          lines[lines.length - 1] = last + theme.accent("▌");
        }
        lines.push("");
        return lines;
      }
      case "tool": {
        const glyph = item.status === "running" ? theme.accent("◐") : item.status === "error" ? theme.error("✗") : theme.success("✓");
        const bg =
          item.status === "running"
            ? theme.toolPendingBg
            : item.status === "error"
              ? theme.toolErrorBg
              : theme.toolSuccessBg;
        const head = bg(`${glyph} ${item.name} ${theme.dim(item.status)}`);
        const out = [head];
        if (item.detail && this.expandedTools) {
          for (const line of item.detail.split("\n").slice(0, 12)) {
            out.push(bg(`   ${theme.toolOutput(line.slice(0, cols - 4))}`));
          }
        }
        return out;
      }
      case "system":
        return [theme.system(item.text), ""];
    }
  }

  #matches(): string[] {
    if (!this.#overlay) return [];
    const f = this.#overlay.filter.toLowerCase();
    return this.#overlay.options.filter((o) => o.toLowerCase().includes(f));
  }

  #run(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#screen.draw(this.#compose());
  }

  async start(): Promise<void> {
    this.#screen.enter();
    this.#stdin.setRawMode?.(true);
    this.#stdin.resume();
    this.#stdin.setEncoding("utf8");

    const timer = setInterval(() => this.#run(), 80);

    const onData = (chunk: string) => {
      for (const key of parseKeys(chunk)) void this.handleKey(key);
    };
    this.#stdin.on("data", onData);
    const onExit = () => this.quit();
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
    this.#stdin.on("end", () => this.quit());

    await new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });

    clearInterval(timer);
    this.#stdin.off("data", onData);
    this.#stdin.setRawMode?.(false);
    this.#stdin.pause();
    this.#screen.exit();
  }

  private async handleKey(key: KeyEvent): Promise<void> {
    this.markDirty();

    if (this.#overlay) {
      if (key.name === "escape") {
        this.#overlay = null;
        return;
      }
      if (key.name === "enter") {
        const overlay = this.#overlay;
        const option = this.#matches()[0];
        this.#overlay = null;
        if (option && overlay) overlay.onPick(option);
        return;
      }
      if (key.name === "backspace") {
        this.#overlay.filter = this.#overlay.filter.slice(0, -1);
        return;
      }
      if (key.name === "char" && key.ch) this.#overlay.filter += key.ch;
      return;
    }

    // Approvals first: they are modal.
    if (this.approvals.length > 0 && (key.name === "char" && (key.ch === "y" || key.ch === "Y"))) {
      const pending = this.approvals.shift();
      if (pending) this.deps.onApproval(pending.callId, true);
      return;
    }
    if (this.approvals.length > 0 && (key.name === "char" && (key.ch === "n" || key.ch === "N") || key.name === "escape")) {
      const pending = this.approvals.shift();
      if (pending) this.deps.onApproval(pending.callId, false);
      return;
    }

    switch (key.name) {
      case "enter": {
        const text = this.#editor.commit();
        if (!text.trim()) return;
        if (text.startsWith("/")) {
          const [name = "", ...rest] = text.slice(1).split(/\s+/);
          const message = await this.deps.onCommand(name.toLowerCase(), rest.join(" "));
          if (message) this.push({ kind: "system", text: message });
          return;
        }
        this.push({ kind: "user", text });
        this.busy = true;
        this.setStatus("running…");
        this.deps.onSubmit(text);
        return;
      }
      case "newline":
        this.#editor.newline();
        return;
      case "backspace":
        this.#editor.backspace();
        return;
      case "delete":
        this.#editor.delete();
        return;
      case "left":
        this.#editor.left();
        return;
      case "right":
        this.#editor.right();
        return;
      case "up":
        this.#editor.up();
        return;
      case "down":
        this.#editor.down();
        return;
      case "home":
        this.#editor.home();
        return;
      case "end":
        this.#editor.end();
        return;
      case "escape":
        if (this.busy) {
          this.deps.onAbort();
          this.setStatus("aborting…");
        }
        return;
      case "ctrl-l":
        void this.#pick("model", await this.deps.models(), async (option) => {
          const message = await this.deps.setModel(option);
          if (message) this.push({ kind: "system", text: message });
        });
        return;
      case "ctrl-p":
        void this.#pick("session", await this.deps.listSessions(), (option) => {
          this.deps.pickSession(option);
          void this.loadHistory();
        });
        return;
      case "ctrl-o":
        this.expandedTools = !this.expandedTools;
        return;
      case "ctrl-t":
        this.showThinking = !this.showThinking;
        return;
      case "ctrl-u":
        this.#editor.clearLine();
        return;
      case "ctrl-c":
        if (this.#editor.isEmpty) {
          this.items = [];
          this.markDirty();
        } else {
          this.#editor.clear();
        }
        return;
      case "ctrl-d":
        this.#running = false;
        return;
      case "char":
        if (key.ch) this.#editor.insert(key.ch);
        return;
      default:
        return;
    }
  }

  async #pick(title: string, options: string[], onPick: (option: string) => void): Promise<void> {
    if (options.length === 0) {
      this.push({ kind: "system", text: `no ${title}s available` });
      return;
    }
    this.#overlay = { title, options, filter: "", onPick };
  }

  async loadHistory(): Promise<void> {
    const rows = await this.deps.history();
    this.items = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) =>
        r.role === "user"
          ? ({ kind: "user", text: r.content } as Item)
          : ({ kind: "assistant", text: r.content } as Item),
      );
    this.markDirty();
  }
}

export async function runTui(deps: TuiDeps, stdin: NodeJS.ReadStream = process.stdin): Promise<void> {
  const app = new TuiApp(deps, stdin);
  await app.loadHistory();
  await app.start();
}

export const tuiHelp = [
  "Commands: /help /status /tools /skills /model <id> /session <key> /new /clear /abort /quit",
  "Keys: ⏎ send · ⇧⏎ newline · ^L model · ^P session · ^O tool output · ^T thinking · ^C clear · ^D quit",
].join("\n");

export const terminalWidth = width;
export const tuiPalette = palette;