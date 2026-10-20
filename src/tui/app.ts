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
  status = "idle";
  approvals: Approval[] = [];
  busy = false;
  expandedTools = false;
  showThinking = false;
  tokenHint = "";
  toolCount = 0;
  skillCount = 0;
  deliver = false;

  #screen = new Screen();
  #editor = new Editor();
  #overlay: Overlay | null = null;
  #dirty = true;
  #running = true;
  #resolveDone: (() => void) | null = null;
  #lastCtrlC = 0;
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

  /** Replace the streaming bubble with the final text (never append it twice). */
  completeAssistant(text: string): void {
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "assistant" && last.streaming) {
      last.text = text;
      last.streaming = false;
    } else {
      this.items.push({ kind: "assistant", text });
    }
    this.markDirty();
  }

  setStatus(status: string): void {
    this.status = status;
    this.markDirty();
  }

  markDirty(): void {
    this.#dirty = true;
  }

  /** Stop the render loop, aborting any in-flight run first (deps.quit is invoked separately). */
  quit(): void {
    if (this.busy) {
      this.busy = false;
      this.deps.onAbort();
    }
    this.#running = false;
    this.#resolveDone?.();
  }

  #compose(): string[] {
    const cols = this.#screen.cols;
    const rows = this.#screen.rows;
    const head = this.deps.header();
    const rule = () => theme.border("─".repeat(cols));
    const out: string[] = [];

    // 1) header — same shape as OpenClaw: "<surface> - <target> - agent X - session Y <state>"
    const state = this.busy ? this.status : this.status;
    out.push(
      theme.header("suparclaw") +
        theme.dim(" - ") +
        theme.accentSoft(head.target) +
        theme.dim(" - agent ") +
        theme.text(head.agent) +
        theme.dim(" - session ") +
        theme.text(head.session) +
        " " +
        (this.busy ? theme.accent(state) : this.status === "error" ? theme.error(state) : theme.dim(state)),
    );

    // 2) footer — dim, pipe-joined metadata (OpenClaw's formatTuiFooter)
    const footer = [
      `agent ${head.agent}`,
      `session ${head.session}`,
      head.model && head.model !== "(unset)" ? head.model : "unknown",
      `tools:${this.toolCount}`,
      `skills:${this.skillCount}`,
      `deliver:${this.deliver ? "on" : "off"}`,
      `tokens:${this.tokenHint || "?"}`,
    ].join(" | ");
    out.push(theme.dim(` ${footer}`));

    // 3) rules + body (transcript, or the picker overlay when one is open)
    out.push(rule());
    const body: string[] = this.#overlay ? this.#overlayLines(cols) : [];
    if (!this.#overlay) {
      for (const item of this.items) body.push(...this.#renderItem(item, cols));
    }

    const editorLineCount = this.#editor.lines.length;
    const statusLines = this.busy || this.status !== "idle" ? 1 : 0;
    const budget = Math.max(1, rows - (out.length + statusLines + 1 + editorLineCount));
    const visibleBody = body.length > budget ? body.slice(body.length - budget) : body;
    if (body.length === 0 && !this.#overlay) {
      out.push(theme.dim("  no messages yet — ask something to begin"));
      out.push("");
    } else {
      out.push(...visibleBody);
    }

    // 4) pin the composer to the bottom
    const pad = Math.max(0, rows - (out.length + statusLines + 1 + editorLineCount));
    for (let i = 0; i < pad; i++) out.push("");

    // 5) status line (only while working, like OpenClaw's loader row)
    if (this.busy) out.push(theme.accent(` ${state}`));
    else if (this.status !== "idle") out.push(theme.dim(` ${state}`));

    // 6) composer
    out.push(rule());
    const editor = this.#editor.render(cols);
    const hint = this.#editor.isEmpty && !this.#overlay ? theme.dim(HINTS) : "";
    if (hint && editor.lines[0] !== undefined) {
      const room = Math.max(1, cols - width(HINTS) - 4);
      editor.lines[0] = `> ${this.#editor.lines[0]?.slice(2, 2 + room) ?? ""}` + " ".repeat(Math.max(1, cols - 2 - room - width(HINTS))) + hint;
    }
    out.push(...editor.lines);

    return out;
  }

  #renderItem(item: Item, cols: number): string[] {
    switch (item.kind) {
      case "user": {
        const out: string[] = [];
        for (const line of item.text.split("\n")) out.push(theme.userBg(theme.userText(` ${line} `)));
        out.push("");
        return out;
      }
      case "assistant": {
        const lines = renderMarkdown(item.text, cols);
        if (item.streaming && lines.length > 0) {
          const last = lines[lines.length - 1] as string;
          lines[lines.length - 1] = last + theme.accent("\u258c");
        }
        lines.push("");
        return lines;
      }
      case "tool": {
        const glyph =
          item.status === "running" ? theme.accent("\u25d0") : item.status === "error" ? theme.error("\u2717") : theme.dim("\u2713");
        const tint = (text: string) =>
          item.status === "running"
            ? theme.toolPendingBg(text)
            : item.status === "error"
              ? theme.toolErrorBg(text)
              : theme.dim(text);
        const out = [tint(` ${glyph} ${item.name}`)];
        if (this.expandedTools && item.detail) {
          for (const line of item.detail.split("\n").slice(0, 10)) {
            out.push(`   ${theme.dim(line.slice(0, cols - 5))}`);
          }
        }
        return out;
      }
      case "system":
        return item.text ? [theme.system(item.text), ""] : [];
    }
  }

  #overlayLines(cols: number): string[] {
    const overlay = this.#overlay;
    if (!overlay) return [];
    const out: string[] = [
      theme.header(` ${overlay.title} `),
      theme.dim(` filter: ${overlay.filter}_`),
    ];
    const matches = this.#matches();
    matches.slice(0, 12).forEach((option, i) => {
      out.push(`${theme.accent(i === 0 ? "\u276f " : "   ")}${theme.text(option)}`);
    });
    if (matches.length === 0) out.push(theme.dim("  no matches"));
    out.push(theme.dim(" \u2191\u2193 select \u00b7 \u23ce pick \u00b7 esc cancel"));
    return out;
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
      if (key.name === "escape" || (key.name === "ctrl-c")) {
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
    if (this.approvals.length > 0 && (key.name === "char" && (key.ch === "n" || key.ch === "N") || key.name === "escape" || key.name === "ctrl-c")) {
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
      case "ctrl-c": {
        // Esc/modal keys close first, then a live run stops, then — on a
        // double press — the TUI itself closes.
        const now = Date.now();
        const double = now - this.#lastCtrlC < 700;
        this.#lastCtrlC = now;
        if (this.busy) {
          this.busy = false;
          this.deps.onAbort();
          this.setStatus("stopped");
          this.push({ kind: "system", text: "stopped — ctrl+c again to exit" });
          return;
        }
        if (!this.#editor.isEmpty) {
          this.#editor.clear();
          return;
        }
        if (double) {
          this.quit();
          return;
        }
        const last = this.items[this.items.length - 1];
        const hint = "ctrl+c again to exit · esc stops a running reply";
        if (!(last && last.kind === "system" && last.text === hint)) {
          this.push({ kind: "system", text: hint });
        }
        return;
      }
      case "ctrl-d":
        this.quit();
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

const HINTS = "\u23ce send \u00b7 ^L model \u00b7 ^P session \u00b7 ^O tools \u00b7 ^D quit";

export const tuiHelp = [
  "Commands: /help /status /model <id> [--save] /provider <list|add|remove|test> /tools /skills /session <key> /new /clear /abort /quit",
  "Keys: ⏎ send · ⇧⏎ newline · ^L model · ^P session · ^O tool output · ^T thinking · ^C stop · ^C^C quit",
].join("\n");

export const terminalWidth = width;
export const tuiPalette = palette;