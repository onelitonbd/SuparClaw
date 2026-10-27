// Task 52 — the operator's window into the agent's terminals.
//
// The shells live in the daemon (src/agent/terminals.ts). This panel is a pure
// viewer plus a prompt: it never keeps state the daemon does not have, so a
// browser reload re-reads the real scrollback instead of an illusion. One
// transport in, one event handler out — no direct socket, no globals — which is
// what makes it testable in linkedom without a gateway.

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  status: "idle" | "running" | "exited";
  lastExit: number | null;
  busy: boolean;
  owner: string;
  createdAt: number;
  bytes: number;
  seq: number;
  command: string | null;
  pid: number;
}

export interface TerminalTransport {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface TerminalPanelDeps {
  transport: TerminalTransport;
  /** The session whose default terminal a bare `run` would use. */
  sessionKey: () => string;
  /** Same toast the rest of the shell uses; optional so tests stay quiet. */
  toast?: (text: string, tone?: "ok" | "err" | "info") => void;
}

/** Client-side cap per terminal — the daemon keeps 200 KB, we keep this. */
const MAX_TEXT = 200 * 1024;
/** A terminal nobody has read yet gets its scrollback on first view. */
type View = {
  info: TerminalInfo | null;
  text: string;
  loaded: boolean;
  empty: boolean;
  /**
   * Deltas that arrived before the scrollback read returned. Some of them are
   * already inside that read (the daemon snapshots the ring when it answers),
   * so each carries its sequence and only the newer ones are kept — otherwise
   * the first view of a busy terminal shows the same lines twice.
   */
  pending?: { seq: number; text: string }[];
};

const $new = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

export class TerminalPanel {
  #root: HTMLElement;
  #deps: TerminalPanelDeps;
  #views = new Map<string, View>();
  #active: string | null = null;
  /** Terminal ids with a scrollback read in flight (never fetch the same one twice). */
  #loading = new Set<string>();
  #open = false;
  #busyTick: ReturnType<typeof setInterval> | null = null;

  /** Rail dot: how many shells exist and how many are running something. */
  onStatus: ((s: { open: number; busy: number }) => void) | null = null;

  // Built once; the same nodes are reused so scroll position and focus survive.
  #tabs: HTMLElement;
  #meta: HTMLElement;
  #out: HTMLElement;
  #input: HTMLInputElement;
  #form: HTMLFormElement;
  #empty: HTMLElement;
  #body: HTMLElement;
  #title: HTMLElement;

  constructor(root: HTMLElement, deps: TerminalPanelDeps) {
    this.#root = root;
    this.#deps = deps;

    const head = $new("div", "term__head");
    head.id = "term-head";
    const mark = $new("span", "term__mark");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>';
    this.#title = $new("span", "term__title");
    this.#title.textContent = "Terminals";
    this.#tabs = $new("div", "term__tabs");
    this.#tabs.id = "term-tabs";
    this.#tabs.setAttribute("role", "tablist");
    this.#tabs.setAttribute("aria-label", "Open terminals");

    const actions = $new("div", "term__actions");
    // `label` is unused in markup (the button is icon-only, like the rest of the
    // chrome) but kept so every call site states what the icon means.
    const mk = (id: string, label: string, svg: string, title: string): HTMLButtonElement => {
      const b = $new("button", "ibtn term__btn");
      b.type = "button";
      b.id = id;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.innerHTML = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;
      return b;
    };
    const add = mk("term-new", "New terminal", '<path d="M12 5v14M5 12h14"/>', "New terminal");
    const intr = mk(
      "term-interrupt",
      "Interrupt",
      '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
      "Interrupt the running command (Ctrl-C)",
    );
    const clear = mk(
      "term-clear",
      "Clear",
      '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
      "Clear the scrollback (the shell stays)",
    );
    const close = mk("term-close", "Close panel", '<path d="M6 6l12 12M18 6L6 18"/>', "Close the panel");
    actions.append(add, intr, clear, close);

    head.append(mark, this.#title, this.#tabs, actions);

    this.#body = $new("div", "term__body");
    this.#meta = $new("div", "term__meta");
    this.#meta.id = "term-meta";
    this.#meta.setAttribute("aria-live", "polite");
    this.#out = $new("pre", "term__out");
    this.#out.id = "term-out";
    this.#out.tabIndex = 0;
    this.#out.setAttribute("aria-label", "Terminal output");

    this.#empty = $new("div", "term__empty");
    this.#empty.id = "term-empty";
    this.#body.append(this.#meta, this.#out, this.#empty);

    this.#form = $new("form", "term__form");
    this.#form.id = "term-form";
    const prompt = $new("span", "term__prompt");
    prompt.textContent = "$";
    prompt.setAttribute("aria-hidden", "true");
    this.#input = $new("input", "term__input");
    this.#input.id = "term-input";
    this.#input.type = "text";
    this.#input.autocomplete = "off";
    this.#input.spellcheck = false;
    this.#input.placeholder = "Run a command in this terminal…";
    this.#input.setAttribute("aria-label", "Command");
    const send = $new("button", "btn pri term__send");
    send.type = "submit";
    send.id = "term-send";
    send.textContent = "Run";
    this.#form.append(prompt, this.#input, send);

    this.#root.append(head, this.#body, this.#form);
    this.#root.id = "terminal-panel";
    this.#root.setAttribute("role", "dialog");
    this.#root.setAttribute("aria-modal", "false");
    this.#root.setAttribute("aria-label", "Terminals");

    add.onclick = () => void this.create();
    intr.onclick = () => void this.interrupt();
    clear.onclick = () => void this.clear();
    close.onclick = () => this.close();
    this.#form.onsubmit = (ev) => {
      ev.preventDefault();
      void this.send();
    };
    // Escape closes — but only here, never while typing in another view.
    this.#root.onkeydown = (ev) => {
      if ((ev as KeyboardEvent).key === "Escape") {
        ev.preventDefault();
        this.close();
      }
    };
    this.#render();
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get activeId(): string | null {
    return this.#active;
  }

  async toggle(): Promise<void> {
    if (this.#open) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    this.#open = true;
    this.#root.hidden = false;
    this.#root.setAttribute("aria-modal", "false");
    await this.refresh();
    // Poll the list while the panel is open: a terminal the agent kills, or a
    // shell whose status changed while no event reached this socket, still
    // shows the truth within a few seconds.
    if (this.#busyTick === null) {
      this.#busyTick = setInterval(() => void this.refresh(), 4000);
      (this.#busyTick as unknown as { unref?: () => void }).unref?.();
    }
    this.#input.focus();
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
    if (this.#busyTick !== null) {
      clearInterval(this.#busyTick);
      this.#busyTick = null;
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /** Re-read the list from the daemon and show the active (or first) terminal. */
  async refresh(): Promise<void> {
    let list: TerminalInfo[] = [];
    try {
      const res = (await this.#deps.transport.request("terminals.list", {
        sessionKey: this.#deps.sessionKey(),
      })) as { terminals?: TerminalInfo[] } | null;
      list = Array.isArray(res?.terminals) ? res.terminals : [];
    } catch {
      // Gateway offline: keep whatever we already show, and say so.
      this.#meta.textContent = "gateway offline — the terminal list will refresh when it reconnects";
      this.#render();
      return;
    }
    const seen = new Set<string>();
    for (const info of list) {
      seen.add(info.id);
      const view = this.#views.get(info.id);
      if (view) view.info = info;
      else this.#views.set(info.id, { info, text: "", loaded: false, empty: false });
    }
    for (const id of [...this.#views.keys()]) if (!seen.has(id)) this.#views.delete(id);
    if (!this.#active || !this.#views.has(this.#active)) this.#active = list[0]?.id ?? null;
    this.#render();
    this.#report();
    if (this.#active && !this.#views.get(this.#active)?.loaded) await this.#load(this.#active);
  }

  /** Every `terminal` gateway event lands here (see main.ts). */
  handleEvent(payload: Record<string, unknown>): void {
    const kind = String(payload["kind"] ?? "");
    const id = String(payload["id"] ?? "");
    if (!id) return;
    if (kind === "removed") {
      this.#views.delete(id);
      if (this.#active === id) this.#active = this.#views.keys().next().value ?? null;
      this.#render();
      this.#report();
      return;
    }
    if (kind === "created" || kind === "state") {
      const info = payload["terminal"] as TerminalInfo | undefined;
      if (info && info.id === id) {
        const view = this.#views.get(id) ?? { info, text: "", loaded: false, empty: false };
        view.info = info;
        this.#views.set(id, view);
        if (!this.#active) this.#active = id;
        // A shell that restarted drops its old scrollback in the daemon too.
        if (info.status === "idle" && info.seq === 0) {
          view.text = "";
          view.loaded = true;
        }
      }
      this.#render();
      this.#report();
      return;
    }
    if (kind === "output") {
      const text = String(payload["text"] ?? "");
      const view = this.#views.get(id) ?? { info: null, text: "", loaded: false, empty: false };
      this.#views.set(id, view);
      if (!view.loaded) {
        // Output raced ahead of our scrollback read: hold it, ordered, and let
        // the read decide which of these it already contains.
        (view.pending ??= []).push({ seq: Number(payload["seq"] ?? 0) || 0, text });
        if (!this.#active) this.#active = id;
        if (id === this.#active) void this.#load(id);
        return;
      }
      view.text = cap(view.text + text);
      if (id === this.#active) this.#append(text);
      return;
    }
  }

  async create(cwd?: string): Promise<void> {
    try {
      const res = (await this.#deps.transport.request("terminals.create", {
        sessionKey: this.#deps.sessionKey(),
        ...(cwd ? { cwd } : {}),
      })) as { terminal: TerminalInfo };
      const info = res.terminal;
      this.#views.set(info.id, { info, text: "", loaded: true, empty: true });
      this.#active = info.id;
      this.#render();
      this.#report();
      this.#input.focus();
      this.#deps.toast?.(`terminal ${info.id} ready`, "ok");
    } catch (err) {
      this.#deps.toast?.(String((err as Error).message ?? err), "err");
    }
  }

  async send(): Promise<void> {
    const command = this.#input.value.trim();
    if (!command || !this.#active) return;
    const id = this.#active;
    const view = this.#views.get(id);
    this.#input.value = "";
    // The shell is on a pipe, so it echoes nothing: the panel echoes what the
    // operator typed, exactly as a terminal would.
    const echo = `$ ${command}\n`;
    if (view) {
      view.text = cap(view.text + echo);
      view.empty = false;
    }
    if (id === this.#active) this.#append(echo);
    try {
      await this.#deps.transport.request("terminals.send", { terminal: id, command });
    } catch (err) {
      const msg = `[panel] ${String((err as Error).message ?? err)}\n`;
      if (view) view.text = cap(view.text + msg);
      this.#append(msg);
      this.#deps.toast?.(String((err as Error).message ?? err), "err");
    }
  }

  async interrupt(): Promise<void> {
    const id = this.#active;
    if (!id) return;
    try {
      await this.#deps.transport.request("terminals.interrupt", { terminal: id });
      this.#deps.toast?.("interrupted — the shell is still alive", "ok");
      await this.refresh();
    } catch (err) {
      this.#deps.toast?.(String((err as Error).message ?? err), "err");
    }
  }

  async clear(): Promise<void> {
    const id = this.#active;
    if (!id) return;
    try {
      await this.#deps.transport.request("terminals.clear", { terminal: id, clear: true });
      const view = this.#views.get(id);
      if (view) {
        view.text = "";
        view.empty = true;
      }
      this.#render();
    } catch (err) {
      this.#deps.toast?.(String((err as Error).message ?? err), "err");
    }
  }

  async select(id: string): Promise<void> {
    if (!this.#views.has(id)) return;
    this.#active = id;
    this.#render();
    if (!this.#views.get(id)?.loaded) await this.#load(id);
    else this.#renderOut();
  }

  /** Ask the daemon for a terminal's scrollback (first view, or after reload). */
  async #load(id: string): Promise<void> {
    if (this.#loading.has(id)) return;
    this.#loading.add(id);
    try {
      const res = (await this.#deps.transport.request("terminals.read", {
        terminal: id,
        since: 0,
      })) as { text?: string; seq?: number; truncated?: boolean } | null;
      const view = this.#views.get(id);
      if (!view) return;
      const readSeq = Number(res?.seq ?? 0) || 0;
      const pending = view.pending ?? [];
      view.pending = [];
      // Keep only what the daemon had not put in the ring when it answered.
      const extra = pending.filter((p) => p.seq === 0 || p.seq > readSeq).map((p) => p.text).join("");
      view.text = cap(String(res?.text ?? "") + view.text + extra);
      view.loaded = true;
      if (id === this.#active) this.#renderOut();
    } catch {
      const view = this.#views.get(id);
      if (view) view.loaded = true;
    } finally {
      this.#loading.delete(id);
    }
  }

  #report(): void {
    let busy = 0;
    for (const v of this.#views.values()) if (v.info?.busy) busy += 1;
    this.onStatus?.({ open: this.#views.size, busy });
  }

  #render(): void {
    // Tabs are buttons (a phone cannot hover), one per shell.
    this.#tabs.innerHTML = "";
    for (const [id, view] of this.#views) {
      const tab = $new("button", "term__tab");
      tab.type = "button";
      tab.id = `term-tab-${id}`;
      tab.dataset["id"] = id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(id === this.#active));
      if (id === this.#active) tab.classList.add("is-active");
      const dot = $new("span", "term__dot");
      if (view.info?.busy) dot.classList.add("is-busy");
      else if (view.info?.status === "exited") dot.classList.add("is-dead");
      const label = $new("span", "term__tab-name");
      label.textContent = view.info?.name && view.info.name !== id ? `${id} · ${view.info.name}` : id;
      tab.append(dot, label);
      tab.onclick = () => void this.select(id);
      this.#tabs.append(tab);
    }
    const view = this.#active ? this.#views.get(this.#active) : null;
    const info = view?.info ?? null;
    this.#title.textContent = info ? "Terminals" : "Terminals";
    if (!info) {
      this.#meta.textContent = "no terminals open";
      this.#empty.textContent = "";
      const title = $new("div", "term__empty-title");
      title.textContent = "No terminal is open yet";
      const hint = $new("div", "term__empty-hint");
      hint.append("The agent opens one on its first shell command. You can also open one now and type in it yourself.");
      const btn = $new("button", "btn pri");
      btn.type = "button";
      btn.id = "term-empty-new";
      btn.textContent = "Open a terminal";
      btn.onclick = () => void this.create();
      this.#empty.append(title, hint, btn);
      this.#out.textContent = "";
      this.#empty.hidden = false;
      this.#out.hidden = true;
      this.#form.hidden = true;
      return;
    }
    this.#empty.hidden = true;
    this.#out.hidden = false;
    this.#form.hidden = false;
    const state = info.busy ? "running" : info.status === "exited" ? "shell exited" : "idle";
    const bits = [
      `<b>${escapeHtml(info.id)}</b>`,
      escapeHtml(state),
      escapeHtml(info.cwd),
      info.shell ? escapeHtml(info.shell.split("/").pop() ?? info.shell) : "",
    ].filter(Boolean);
    this.#meta.innerHTML = bits.join('<span class="term__sep">·</span>');
    if (info.busy && info.command) {
      const cmd = $new("span", "term__cmd");
      cmd.textContent = info.command;
      this.#meta.append(document.createTextNode(" "), cmd);
    }
    this.#input.placeholder = `Run a command in ${info.id}…`;
    if (info.status === "exited") {
      this.#input.placeholder = `${info.id}: the shell has exited — restart it to type again`;
    }
    this.#renderOut();
  }

  #renderOut(): void {
    const view = this.#active ? this.#views.get(this.#active) : null;
    this.#out.textContent = view?.text ?? "";
    if (view?.empty && !view.text) {
      this.#out.textContent = "";
    }
    this.#out.scrollTop = this.#out.scrollHeight;
  }

  #append(text: string): void {
    if (!text) return;
    const stick = this.#out.scrollHeight - this.#out.scrollTop - this.#out.clientHeight < 32;
    const node = document.createTextNode(text);
    this.#out.append(node);
    // Hard cap in the DOM too: a 20-minute build log must not eat the phone.
    while ((this.#out.textContent?.length ?? 0) > MAX_TEXT) {
      const first = this.#out.firstChild;
      if (!first) break;
      const over = (this.#out.textContent?.length ?? 0) - MAX_TEXT;
      if (first.nodeType === 3) {
        const t = first as Text;
        if (t.data.length > over) {
          t.data = t.data.slice(over);
          break;
        }
        first.remove();
      } else {
        first.remove();
      }
    }
    if (stick) this.#out.scrollTop = this.#out.scrollHeight;
  }
}

const cap = (s: string): string => (s.length > MAX_TEXT ? s.slice(s.length - MAX_TEXT) : s);

/** Escaping for the few strings that become markup (ids, cwd, shell). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Human wording for the rail dot and the panel footer. */
export function terminalSummary(s: { open: number; busy: number } | null): string {
  if (!s || s.open === 0) return "no terminals";
  const base = `${s.open} terminal${s.open === 1 ? "" : "s"}`;
  return s.busy > 0 ? `${base} · ${s.busy} running` : base;
}
