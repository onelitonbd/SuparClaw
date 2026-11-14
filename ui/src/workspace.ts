// Read-only workspace browser, scoped to the currently selected chat session.
export interface WorkspaceTransport {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  token: string;
}
export interface WorkspaceEntry { name: string; path: string; kind: "file" | "directory"; size: number; modifiedAt: number }
export interface WorkspaceMatch { path: string; name: string; size: number; modifiedAt: number }
interface Listing { path: string; entries: WorkspaceEntry[] }
interface Preview { path: string; name: string; size: number; modifiedAt: number; mime: string; kind: "text" | "image" | "download"; text?: string }
export interface WorkspacePanelDeps { transport: WorkspaceTransport; sessionKey: () => string; onMention: (path: string) => void }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};
const fmtSize = (n: number): string => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export class WorkspacePanel {
  #deps: WorkspacePanelDeps;
  #root: HTMLElement;
  #search: HTMLInputElement;
  #headPath: HTMLElement;
  #crumbs: HTMLElement;
  #list: HTMLElement;
  #preview: HTMLElement;
  #path = "";
  #query = "";
  #opened = false;
  #selectedPath: string | null = null;
  #objectUrl: string | null = null;
  #loadGeneration = 0;
  #previewGeneration = 0;
  #searchTimer: ReturnType<typeof setTimeout> | null = null;
  #returnFocus: HTMLElement | null = null;

  constructor(host: HTMLElement, deps: WorkspacePanelDeps) {
    this.#deps = deps;
    this.#root = el("div", "workspace-overlay");
    this.#root.hidden = true;
    this.#root.setAttribute("aria-hidden", "true");
    const scrim = el("button", "workspace-overlay__scrim");
    scrim.type = "button";
    scrim.setAttribute("aria-label", "Close workspace browser");
    const panel = el("section", "workspace-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Workspace files");
    const header = el("header", "workspace-head");
    const titles = el("div", "workspace-head__titles");
    const title = el("h2", "workspace-head__title");
    title.textContent = "Workspace";
    this.#headPath = el("p", "workspace-head__path");
    titles.append(title, this.#headPath);
    const close = el("button", "ibtn workspace-head__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close workspace browser");
    close.innerHTML = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    header.append(titles, close);

    const searchWrap = el("label", "workspace-search");
    searchWrap.innerHTML = '<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/></svg>';
    this.#search = el("input");
    this.#search.type = "search";
    this.#search.placeholder = "Search files and folders…";
    this.#search.setAttribute("aria-label", "Search workspace files");
    searchWrap.append(this.#search);

    const content = el("div", "workspace-content");
    const listPane = el("div", "workspace-list-pane");
    this.#crumbs = el("nav", "workspace-crumbs");
    this.#crumbs.setAttribute("aria-label", "Workspace path");
    this.#list = el("div", "workspace-list");
    listPane.append(this.#crumbs, this.#list);
    const previewPane = el("div", "workspace-preview-pane");
    this.#preview = el("div", "workspace-preview");
    this.#emptyPreview();
    previewPane.append(this.#preview);
    content.append(listPane, previewPane);
    panel.append(header, searchWrap, content);
    this.#root.append(scrim, panel);
    host.append(this.#root);

    close.onclick = () => this.close();
    scrim.onclick = () => this.close();
    this.#search.addEventListener("input", () => {
      this.#query = this.#search.value.trim();
      if (this.#searchTimer) clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => void this.#renderList(), 160);
    });
    this.#root.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-workspace-back]")) this.#showList();
    });
    document.addEventListener("keydown", (event) => {
      if (!this.#opened) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); }
      if (event.key === "Tab") this.#trapFocus(event);
    });
  }

  get isOpen(): boolean { return this.#opened; }
  async open(returnFocus?: HTMLElement): Promise<void> {
    this.#returnFocus = returnFocus ?? document.activeElement as HTMLElement;
    this.#opened = true;
    this.#root.classList.remove("workspace-overlay--preview");
    this.#root.hidden = false;
    this.#root.setAttribute("aria-hidden", "false");
    document.body.classList.add("workspace-open");
    this.#search.value = this.#query;
    this.#renderCrumbs();
    await this.#renderList();
    this.#search.focus();
  }
  close(restoreFocus = true): void {
    this.#opened = false;
    this.#root.hidden = true;
    this.#root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("workspace-open");
    this.#previewGeneration++;
    this.#revokePreviewUrl();
    if (restoreFocus) this.#returnFocus?.focus();
  }
  async sessionChanged(): Promise<void> {
    this.#path = "";
    this.#query = "";
    this.#selectedPath = null;
    this.#search.value = "";
    this.#previewGeneration++;
    this.#revokePreviewUrl();
    this.#showList();
    this.#emptyPreview();
    this.#renderCrumbs();
    if (this.#opened) await this.#renderList();
  }
  async search(query: string): Promise<WorkspaceMatch[]> {
    const result = await this.#deps.transport.request<{ results: WorkspaceMatch[] }>("workspace.search", { sessionKey: this.#deps.sessionKey(), query });
    return result.results ?? [];
  }

  #emptyPreview(): void {
    const note = el("div", "workspace-state");
    note.textContent = "Select a file to preview. Mention paths in chat without attaching file contents.";
    this.#preview.replaceChildren(note);
  }
  #trapFocus(event: KeyboardEvent): void {
    const nodes = Array.from(this.#root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
      .filter((node) => !node.closest("[hidden]") && (typeof window.getComputedStyle !== "function" || window.getComputedStyle(node).display !== "none"));
    if (!nodes.length) return;
    const first = nodes[0]!; const last = nodes[nodes.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  #navigate(path: string): void {
    this.#path = path;
    this.#selectedPath = null;
    this.#previewGeneration++;
    this.#revokePreviewUrl();
    this.#showList();
    this.#emptyPreview();
    void this.#renderList();
  }
  #renderCrumbs(): void {
    this.#crumbs.replaceChildren();
    const paths = this.#path ? this.#path.split("/") : [];
    const add = (label: string, path: string, current: boolean): void => {
      if (this.#crumbs.childElementCount) {
        const sep = el("span", "workspace-crumbs__sep"); sep.textContent = "/"; sep.setAttribute("aria-hidden", "true"); this.#crumbs.append(sep);
      }
      if (current) {
        const node = el("span", "workspace-crumbs__current"); node.textContent = label; node.setAttribute("aria-current", "location"); this.#crumbs.append(node);
      } else {
        const button = el("button", "workspace-crumbs__button"); button.type = "button"; button.textContent = label; button.onclick = () => this.#navigate(path); this.#crumbs.append(button);
      }
    };
    add("Workspace", "", paths.length === 0);
    let current = "";
    paths.forEach((part, i) => { current = current ? `${current}/${part}` : part; add(part, current, i === paths.length - 1); });
    this.#headPath.textContent = this.#path ? `${this.#deps.sessionKey()} / ${this.#path}` : `${this.#deps.sessionKey()} · Active workspace`;
  }

  async #renderList(): Promise<void> {
    const generation = ++this.#loadGeneration;
    this.#renderCrumbs();
    const loading = el("div", "workspace-state"); loading.textContent = "Loading workspace…"; this.#list.replaceChildren(loading);
    try {
      if (this.#query) {
        const matches = await this.search(this.#query);
        if (generation !== this.#loadGeneration) return;
        this.#list.replaceChildren();
        if (!matches.length) { const empty = el("div", "workspace-state"); empty.textContent = "No matching files. Try a shorter name or path."; this.#list.append(empty); return; }
        const label = el("div", "workspace-list__eyebrow"); label.textContent = "FILES IN THIS SESSION"; this.#list.append(label);
        for (const match of matches) this.#list.append(this.#fileRow({ ...match, kind: "file" }));
        return;
      }
      const result = await this.#deps.transport.request<Listing>("workspace.list", { sessionKey: this.#deps.sessionKey(), path: this.#path });
      if (generation !== this.#loadGeneration) return;
      this.#list.replaceChildren();
      if (this.#path) {
        const up = el("button", "workspace-row workspace-row--up"); up.type = "button";
        up.innerHTML = '<span class="workspace-row__icon" aria-hidden="true">↰</span><span class="workspace-row__body"><span class="workspace-row__name">Parent folder</span><span class="workspace-row__path">Go up one level</span></span>';
        up.onclick = () => this.#navigate(this.#path.split("/").slice(0, -1).join("/")); this.#list.append(up);
      }
      if (!result.entries.length) { const empty = el("div", "workspace-state"); empty.textContent = "This folder is empty."; this.#list.append(empty); return; }
      for (const entry of result.entries) this.#list.append(entry.kind === "directory" ? this.#folderRow(entry) : this.#fileRow(entry));
    } catch (error) {
      if (generation !== this.#loadGeneration) return;
      const state = el("div", "workspace-state workspace-state--error"); state.textContent = error instanceof Error ? error.message : "Could not read this workspace."; this.#list.replaceChildren(state);
    }
  }
  #folderRow(entry: WorkspaceEntry): HTMLButtonElement {
    const row = el("button", "workspace-row"); row.type = "button"; row.setAttribute("aria-label", `Open folder ${entry.name}`);
    const icon = el("span", "workspace-row__icon"); icon.textContent = "▰"; icon.setAttribute("aria-hidden", "true");
    const body = el("span", "workspace-row__body"); const name = el("span", "workspace-row__name"); name.textContent = entry.name;
    const meta = el("span", "workspace-row__path"); meta.textContent = "Folder"; body.append(name, meta);
    const arrow = el("span", "workspace-row__arrow"); arrow.textContent = "›"; row.append(icon, body, arrow);
    row.onclick = () => this.#navigate(entry.path); return row;
  }
  #fileRow(entry: WorkspaceEntry | WorkspaceMatch): HTMLButtonElement {
    const row = el("button", "workspace-row"); row.type = "button"; row.setAttribute("aria-label", `Preview ${entry.path}`);
    row.classList.toggle("is-selected", entry.path === this.#selectedPath);
    const icon = el("span", "workspace-row__icon workspace-row__icon--file"); icon.textContent = "▤"; icon.setAttribute("aria-hidden", "true");
    const body = el("span", "workspace-row__body"); const name = el("span", "workspace-row__name"); name.textContent = entry.name;
    const path = el("span", "workspace-row__path"); path.textContent = entry.path; body.append(name, path);
    const meta = el("span", "workspace-row__meta"); meta.textContent = fmtSize(entry.size); row.append(icon, body, meta);
    row.onclick = () => void this.#openFile(entry.path); return row;
  }
  async #openFile(path: string): Promise<void> {
    this.#selectedPath = path;
    const generation = ++this.#previewGeneration;
    void this.#renderList();
    const loading = el("div", "workspace-state"); loading.textContent = "Loading preview…"; this.#preview.replaceChildren(loading);
    this.#revokePreviewUrl();
    try {
      const preview = await this.#deps.transport.request<Preview>("workspace.read", { sessionKey: this.#deps.sessionKey(), path });
      if (generation !== this.#previewGeneration || !this.#opened) return;
      this.#renderPreview(preview, generation);
    } catch (error) {
      if (generation !== this.#previewGeneration || !this.#opened) return;
      const state = el("div", "workspace-state workspace-state--error"); state.textContent = error instanceof Error ? error.message : "Could not preview this file.";
      this.#preview.replaceChildren(state); this.#showPreview();
    }
  }
  #renderPreview(preview: Preview, generation: number): void {
    this.#revokePreviewUrl();
    const head = el("div", "workspace-preview__head");
    const back = el("button", "workspace-preview__back"); back.type = "button"; back.dataset["workspaceBack"] = "true"; back.textContent = "‹ Files";
    const title = el("div", "workspace-preview__title"); const name = el("h3"); name.textContent = preview.name; const path = el("p"); path.textContent = preview.path; title.append(name, path);
    const actions = el("div", "workspace-preview__actions");
    const download = el("button", "btn sm workspace-preview__download"); download.type = "button"; download.textContent = "Download"; download.onclick = () => void this.#download(preview);
    const mention = el("button", "btn sm pri workspace-preview__mention"); mention.type = "button"; mention.textContent = "Use in message"; mention.title = "Insert this workspace path into the chat composer";
    mention.onclick = () => { this.#deps.onMention(preview.path); this.close(false); };
    actions.append(download, mention); head.append(back, title, actions);
    const meta = el("div", "workspace-preview__meta"); meta.textContent = `${fmtSize(preview.size)} · Modified ${new Date(preview.modifiedAt).toLocaleString()}`;
    const body = el("div", "workspace-preview__body");
    if (preview.kind === "text") { const pre = el("pre", "workspace-code"); pre.textContent = preview.text ?? ""; body.append(pre); }
    else if (preview.kind === "image") { const state = el("div", "workspace-state"); state.textContent = "Loading image…"; body.append(state); void this.#loadImage(preview, body, generation); }
    else { const empty = el("div", "workspace-preview__unsupported"); empty.innerHTML = '<span class="workspace-preview__file-icon" aria-hidden="true">▤</span><strong>No inline preview</strong><span>This file type can be downloaded and opened with its associated app.</span>'; body.append(empty); }
    this.#preview.replaceChildren(head, meta, body); this.#showPreview();
  }
  async #loadImage(preview: Preview, body: HTMLElement, generation: number): Promise<void> {
    try {
      const blob = await this.#fetchFile(preview.path); const url = URL.createObjectURL(blob);
      if (generation !== this.#previewGeneration || !this.#opened) { URL.revokeObjectURL(url); return; }
      this.#objectUrl = url; const image = el("img", "workspace-image"); image.alt = preview.name; image.src = url; body.replaceChildren(image);
    } catch (error) {
      if (generation !== this.#previewGeneration || !this.#opened) return;
      body.replaceChildren(); const state = el("div", "workspace-state workspace-state--error"); state.textContent = error instanceof Error ? error.message : "Could not load image."; body.append(state);
    }
  }
  async #download(preview: Preview): Promise<void> {
    try {
      const blob = await this.#fetchFile(preview.path); const url = URL.createObjectURL(blob); const link = el("a");
      link.href = url; link.download = preview.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { const state = el("div", "workspace-state workspace-state--error"); state.textContent = error instanceof Error ? error.message : "Download failed."; this.#preview.append(state); }
  }
  async #fetchFile(path: string): Promise<Blob> {
    const query = new URLSearchParams({ sessionKey: this.#deps.sessionKey(), path });
    const headers: Record<string, string> = {};
    if (this.#deps.transport.token) headers["Authorization"] = `Bearer ${this.#deps.transport.token}`;
    const response = await fetch(`/workspace-file?${query}`, { headers });
    if (!response.ok) throw new Error(response.status === 401 ? "Gateway authorization is required." : "Workspace file is no longer available.");
    return response.blob();
  }
  #showPreview(): void { this.#root.classList.add("workspace-overlay--preview"); }
  #showList(): void { this.#root.classList.remove("workspace-overlay--preview"); }
  #revokePreviewUrl(): void { if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl); this.#objectUrl = null; }
}
