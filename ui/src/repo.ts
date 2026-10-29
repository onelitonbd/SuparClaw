// Task 35 — the GitHub add-on's web surface (design: docs/github-addon-ux.md §2).
//
// One module owns all four pieces so they share one state machine instead of
// three half-copies of it:
//   * the repo bar between the rail and the thread (§2.3, nine states)
//   * the new-session sheet: chat or code → repo picker (§2.1, §2.2)
//   * changed files / diff / publish dialogs (§2.4, §2.5)
//   * the connect dialog: `gh` login first, device code as the fallback (§2.6)
//
// Two rules this file exists to keep:
//   * The bar is derived from the *open session*, never from a global "current
//     repo" — in a multi-session app a global indicator is a trap.
//   * No token ever reaches this module: every `github.*` frame is redacted
//     server-side, and nothing here stores credentials.

import { el, icon, modal, toast } from "./dom.js";
import type { Chat } from "./chat.js";
import { gateway } from "./rpc.js";

const CMD_ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 9l2.5 3L8 15"/><path d="M13.5 15H16"/></svg>';
const WARN_ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5v.01"/></svg>';

export type RepoStatus = {
  bound: boolean;
  repo?: string;
  base?: string;
  branch?: string;
  /** Where publish will push — equals `branch` unless it is the base branch. */
  publishBranch?: string;
  workspace?: string;
  clean?: boolean;
  files?: { path: string; added: number; removed: number }[];
  added?: number;
  removed?: number;
  running?: boolean;
};

export type GithubStatus = {
  connected: boolean;
  login: string;
  source: string;
  host: string;
  scopes: string[];
  configured: boolean;
  ghCli: boolean;
  error?: string;
};

type RepoRow = { fullName: string; private: boolean; defaultBranch: string };
type BranchRow = { name: string; default?: boolean; protected?: boolean };
/** What the picker remembers between its two steps. */
type Picked = { repo: string; base: string };

/**
 * The bar's states. Short on purpose (Task 36): the strip answers two questions —
 * *which repository and branch am I in* — and nothing else. File counts, "no
 * changes" and "working…" were noise; the diff is one tap away.
 *
 * A union, so adding a state without copy is a type error, not a blank strip.
 */
type BarState =
  | { kind: "preparing"; pct?: number; label: string }
  | { kind: "failed" }
  | { kind: "ready" }
  | { kind: "publishing" }
  | { kind: "warn"; reason: "stale" | "gone" };

type Handlers = {
  /** Start a normal chat session (main.ts owns the key + switch). */
  chat: () => void;
  /** Start a code session bound to `repo`, continuing `branch`. */
  code: (repo: string, branch?: string) => void;
};

let handlers: Handlers = { chat: () => {}, code: () => {} };
let sessionKey = "main:main";
/**
 * Bumped on every session switch (Task 38). Async answers — `repo.status`,
 * `repo.bind` — capture it and drop themselves if it moved while they were in
 * flight. Without this, switching from a code session to a new chat showed the
 * PREVIOUS session's repository in the new chat's bar: its `repo.status` simply
 * landed late and painted itself.
 */
let sessionEpoch = 0;
let status: RepoStatus = { bound: false };
let bar: BarState = { kind: "ready" };
let lastPr: { number?: number; url: string } | null = null;
let barNode: HTMLElement | null = null;
let github: GithubStatus | null = null;
/** The composer to lock while a clone runs — handed over by main.ts. */
let composer: Chat | null = null;

export function initRepo(next: Handlers & { composer?: Chat }): void {
  handlers = next;
  composer = next.composer ?? composer;
}

/** main.ts calls this on every session switch: the bar follows the session. */
export function setRepoSession(key: string): void {
  if (key === sessionKey) return;
  sessionKey = key;
  sessionEpoch += 1;
  status = { bound: false };
  bar = { kind: "ready" };
  lastPr = null;
  renderBar();
  void refreshRepo();
}

/** Take the bar that index.html already places above the thread. Idempotent. */
export function mountRepoBar(): void {
  if (barNode) return;
  barNode = document.getElementById("repo-bar");
  if (!barNode) return;
  barNode.onclick = () => {
    switch (bar.kind) {
      case "preparing":
      case "publishing":
        return; // a git command in flight cannot be cancelled honestly (§7)
      case "failed":
        return void retryBind();
      case "warn":
        return bar.reason === "stale" ? connectDialog(() => void refreshRepo()) : openSessionSheet();
      default:
        return changesDialog();
    }
  };
}

/** The repository's own name — `SuparClaw`, never `onelitonbd/SuparClaw`. */
function shortRepo(repo: string): string {
  return repo.split("/").filter(Boolean).pop() || repo;
}

function paint(text: string, opts: { warn?: boolean; pr?: boolean; disabled?: boolean; lock?: boolean; title?: string } = {}): void {
  if (!barNode) return;
  // While the clone runs the session has no workspace, so the composer says so
  // rather than accepting a message the agent could not act on.
  composer?.setRepoLock(Boolean(opts.lock), opts.lock ? text : undefined);
  barNode.hidden = false;
  barNode.innerHTML = "";
  if (opts.title) barNode.setAttribute("title", opts.title);
  else barNode.removeAttribute("title");
  barNode.append(opts.warn ? icon(WARN_ICON, "repo-bar__warn") : icon(CMD_ICON, "repo-bar__icon"));
  barNode.append(el("span", { class: "repo-bar__main mono" }, [text]));
  // One small button. It is disabled — not hidden — when there is nothing to
  // publish: a control that appears and disappears is harder to learn.
  const label = lastPr ? `PR${lastPr.number ? ` #${lastPr.number}` : ""} ↗` : "PR";
  const btn = el("button", {
    class: "repo-bar__btn",
    type: "button",
    "aria-label": lastPr ? `Open pull request${lastPr.number ? ` #${lastPr.number}` : ""}` : "Publish a pull request",
    ...(opts.disabled ? { disabled: "" } : {}),
  }, [label]);
  btn.onclick = (e) => {
    e.stopPropagation();
    if (opts.disabled) return;
    if (lastPr?.url) {
      window.open(lastPr.url, "_blank", "noopener");
      return;
    }
    publishDialog();
  };
  barNode.append(btn);
}

function renderBar(): void {
  if (!barNode) return;
  if (!status.bound) {
    barNode.hidden = true;
    barNode.innerHTML = "";
    return;
  }
  // `Name · branch` and nothing else: no owner, no file counts, no "working".
  const name = shortRepo(status.repo ?? "");
  const branch = status.branch || "…";
  const label = (text: string) => (name ? `${name} · ${text}` : text);
  const full = `${status.repo ?? ""} · ${branch}`;
  switch (bar.kind) {
    case "preparing":
      return paint(label(`cloning${bar.pct !== undefined ? ` ${bar.pct}%` : "…"}`), { lock: true, title: full });
    // A failed clone is the one state the branch cannot describe.
    case "failed":
      return paint(label("clone failed — retry"), { warn: true, disabled: true, lock: false, title: full });
    case "publishing":
      return paint(label("publishing…"), { disabled: true, title: full });
    case "warn":
      return paint(label(branch), { warn: true, title: `${full} — ${bar.reason === "stale" ? "reconnect GitHub" : "repository unavailable"}` });
    case "ready":
      return paint(label(branch), { title: full, disabled: Boolean(status.clean) && !lastPr });
  }
}

/** Derive the bar from a fresh status. The branch is the only thing it says, so
 *  "clean" and "three files changed" look the same — by design. */
function derive(next: RepoStatus): void {
  status = next;
  bar = { kind: "ready" };
  renderBar();
}

export async function refreshRepo(): Promise<void> {
  const key = sessionKey;
  const epoch = sessionEpoch;
  try {
    const next = (await gateway.request("repo.status", { sessionKey: key })) as RepoStatus;
    // The user moved on while this was in flight: the answer describes a
    // session that is no longer on screen.
    if (key !== sessionKey || epoch !== sessionEpoch) return;
    derive(next);
  } catch {
    /* reconnecting: the bar keeps its last honest state rather than blanking */
  }
}

/** Repo lifecycle events ride the chat stream (§5). */
export function handleRepoEvent(e: Record<string, unknown>): void {
  const phase = String(e["phase"] ?? "");
  if (!status.bound) return;
  if (phase === "clone" || phase === "worktree") {
    if (typeof e["branch"] === "string" && e["branch"]) status.branch = e["branch"] as string;
    bar = {
      kind: "preparing",
      pct: typeof e["pct"] === "number" ? (e["pct"] as number) : undefined,
      label: phase === "clone" ? "cloning" : "preparing worktree",
    };
    renderBar();
    return;
  }
  if (phase === "done") {
    void refreshRepo();
    return;
  }
  if (phase === "published") {
    lastPr = { number: typeof e["number"] === "number" ? (e["number"] as number) : undefined, url: String(e["url"] ?? "") };
    bar = { kind: "ready" };
    renderBar();
    return;
  }
  if (phase === "failed") {
    bar = { kind: "failed" };
    renderBar();
  }
}

/** A turn ended: in a code session the diff probably changed. */
export function noteTurnEnded(): void {
  if (status.bound) void refreshRepo();
}

/** The connect state is cached, but never trusted for long: `openSessionSheet`
 *  re-reads it every time the sheet opens. */
async function loadGithubStatus(): Promise<GithubStatus | null> {
  try {
    github = (await gateway.request("github.status", {})) as GithubStatus;
  } catch {
    /* offline: the sheet offers the connect route anyway */
  }
  return github;
}

/* ---------------- the new-session sheet (§2.1, §2.2) ---------------- */
//
// Three steps, each one question: chat or code → which repository → which
// branch. The branch is new in Task 36 and it is the point of the flow: the
// session *continues* that branch, it does not invent one.

type Phase = "choose" | "repos" | "branches";

export function openSessionSheet(): void {
  const overlay = document.getElementById("new-session-overlay") as HTMLElement | null;
  const list = document.getElementById("new-session-list") as HTMLElement | null;
  const head = document.getElementById("new-session-title") as HTMLElement | null;
  const foot = document.getElementById("new-session-foot") as HTMLElement | null;
  const sheet = document.getElementById("new-session-sheet") as HTMLElement | null;
  const scrim = document.getElementById("new-session-scrim") as HTMLElement | null;
  if (!overlay || !list || !head || !foot || !sheet || !scrim) return;

  let phase: Phase = "choose";
  let at = 0;
  let focusables: HTMLElement[] = [];
  let rows: RepoRow[] = [];
  /**
   * Repos this installation has already worked in, newest first (§2.2). `base`
   * is the default branch recorded on the session that used it (Task 38): a
   * recent repo that is not on the current page of `github.repos` still knows
   * which branch is its default, so the branch step can mark it instead of
   * printing `undefined`.
   */
  let recents: { repo: string; base: string }[] = [];
  let filterText = "";
  let picked: Picked | null = null;
  let branches: BranchRow[] = [];
  let branchFilter = "";
  /** The GitHub login the current `rows`/`recents` were fetched for. */
  let listLogin = "";

  const close = () => {
    overlay.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    (document.getElementById("new-chat-btn") as HTMLElement | null)?.focus();
  };
  const focusAt = (i: number) => {
    if (!focusables.length) return;
    at = Math.max(0, Math.min(focusables.length - 1, i));
    focusables.forEach((n, k) => n.classList.toggle("is-focus", k === at));
    focusables[at]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (phase === "branches") return void drawRepos();
      if (phase === "repos") return drawChoose();
      return close();
    }
    // Focus trap: this sheet is a required decision, so Tab cycles inside it.
    if (e.key === "Tab") {
      e.preventDefault();
      focusAt(at + (e.shiftKey ? -1 : 1));
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(at + (e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      focusables[at]?.click();
    }
  };

  const drawChoose = () => {
    phase = "choose";
    head.textContent = "New session";
    foot.innerHTML = "";
    list.innerHTML = "";
    const chat = el("button", { class: "sheet__row sheet__row--tall", type: "button", id: "new-chat-row" }, [
      el("span", { class: "sheet__ico" }, ["💬"]),
      el("span", { class: "sheet__txt" }, [el("b", {}, ["Chat"]), el("span", { class: "sheet__sub" }, ["Talk, research, files"])]),
      el("span", { class: "sheet__hint mono" }, ["⏎"]),
    ]);
    chat.onclick = () => {
      close();
      handlers.chat();
    };
    const codeRow = el("button", { class: "sheet__row sheet__row--tall", type: "button", id: "new-code-row" }, [
      icon(CMD_ICON, "sheet__ico"),
      el(
        "span",
        { class: "sheet__txt" },
        github?.connected
          ? [el("b", {}, ["Code a repository"]), el("span", { class: "sheet__sub" }, ["Pick a repo and a branch, then open a PR"])]
          : [el("b", {}, ["Code a repository"]), el("span", { class: "sheet__sub" }, ["Connect GitHub to start → a code in your browser"])],
      ),
    ]);
    codeRow.onclick = () => {
      if (!github?.connected) return connectDialog(() => void drawRepos());
      void drawRepos();
    };
    list.append(chat, codeRow);
    if (github?.connected) {
      const change = el("button", { class: "linkbtn", type: "button" }, ["Change"]);
      change.onclick = () => connectDialog(() => void drawRepos());
      foot.append(el("span", { class: "sheet__foot-line" }, [`GitHub: @${github.login}  ·  `]), change);
    }
    focusables = [chat, codeRow];
    at = 0;
    focusAt(0);
  };

  /** Step two: the repository. Choosing one moves to step three. */
  const drawRepos = async () => {
    phase = "repos";
    // Signing into a different account invalidates both lists: the repos and
    // the recents belonged to the previous login (Task 38).
    const login = github?.login ?? "";
    if (listLogin && login && login !== listLogin) {
      rows = [];
      recents = [];
      listLogin = "";
      filterText = "";
    }
    head.textContent = "Pick a repository";
    foot.innerHTML = "";
    list.innerHTML = "";
    const back = el("button", { class: "linkbtn", type: "button" }, ["‹ Back"]);
    back.onclick = () => drawChoose();
    list.append(back);

    const filter = el("input", { class: "inp", type: "search", placeholder: "Filter repos…", "aria-label": "Filter repos" }) as HTMLInputElement;
    filter.value = filterText;
    const note = el("p", { class: "sheet__empty" }, [github?.connected ? "Loading repositories…" : "Connect GitHub to list your repositories."]);
    const rowsHost = el("div", { class: "sheet__rows" });
    list.append(filter, note, rowsHost);

    const cloneUrl = el("button", { class: "linkbtn", type: "button" }, ["＋ Clone by URL…"]);
    cloneUrl.onclick = () => {
      modal({
        title: "Clone by URL",
        fields: [{ name: "repo", label: "Repository", placeholder: "owner/name" }],
        confirmLabel: "Next",
        onConfirm: (v) => {
          const value = (v["repo"] ?? "").trim();
          if (!value.includes("/")) return toast("use owner/name", "err");
          void drawBranches({ repo: value, base: "" });
        },
      });
    };
    const refresh = el("button", { class: "linkbtn", type: "button" }, ["⟳ Refresh"]);
    refresh.onclick = () => void load(true);
    foot.append(cloneUrl, refresh);

    const repoRow = (name: string, sub: string, base: string) => {
      const row = el("button", { class: "sheet__row", type: "button" }, [
        icon(CMD_ICON, "sheet__ico"),
        el("span", { class: "sheet__txt" }, [
          el("span", { class: "mono" }, [name]),
          el("span", { class: "sheet__sub" }, [sub]),
        ]),
      ]);
      row.onclick = () => void drawBranches({ repo: name, base });
      return row;
    };

    const drawRows = () => {
      const q = filterText.trim().toLowerCase();
      rowsHost.innerHTML = "";
      const shown = rows.filter((r) => !q || r.fullName.toLowerCase().includes(q)).slice(0, 60);
      // Recents come from our own sessions, not from GitHub's ordering: the
      // repos this installation actually worked in are the likeliest next pick.
      const recent = recents.filter((r) => !q || r.repo.toLowerCase().includes(q));
      if (recent.length) {
        rowsHost.append(el("div", { class: "sheet__group" }, ["Recent"]));
        for (const r of recent) {
          const known = rows.find((row) => row.fullName === r.repo);
          // The default branch comes from whichever source knows it: the live
          // repo list, or the session that worked here last.
          const base = known?.defaultBranch || r.base || "";
          const kind = known ? (known.private ? "🔒 private" : "public") : "worked here before";
          rowsHost.append(repoRow(r.repo, base ? `${kind} · ${base}` : kind, base));
        }
        if (rows.length) rowsHost.append(el("div", { class: "sheet__group" }, ["Your repositories"]));
      }
      if (rows.length && !shown.length && !recent.length) rowsHost.append(el("div", { class: "sheet__empty" }, ["No repos match"]));
      for (const r of shown) {
        if (recent.some((x) => x.repo === r.fullName)) continue;
        rowsHost.append(repoRow(r.fullName, `${r.private ? "🔒 private" : "public"} · ${r.defaultBranch}`, r.defaultBranch));
      }
      // The filter stays the first focusable so typing never moves the cursor.
      focusables = [back, filter, ...(Array.from(rowsHost.querySelectorAll(".sheet__row")) as HTMLElement[]), cloneUrl, refresh];
      at = Math.min(at, focusables.length - 1);
      focusables.forEach((n, k) => n.classList.toggle("is-focus", k === at));
    };

    const load = async (force = false) => {
      if (!github?.connected) {
        note.textContent = "Connect GitHub to list your repositories.";
        return;
      }
      try {
        const [res, list] = await Promise.all([
          gateway.request("github.repos", { page: 1 }) as Promise<{ repos?: RepoRow[] }>,
          // A failed session list must not hide the repos: recents are a nicety.
          (gateway.request("sessions.list", {}) as Promise<{ sessions?: { repo?: string | null; base?: string | null; last_msg_at?: number }[] }>).catch(() => ({ sessions: [] })),
        ]);
        rows = res.repos ?? [];
        // `sessions.list` is SELECT *: every code session carries the repo, the
        // base and the branch it worked on, so the recents remember the default.
        const seen = new Set<string>();
        recents = [];
        for (const row of list.sessions ?? []) {
          const repo = row.repo ? String(row.repo) : "";
          if (!repo || seen.has(repo)) continue;
          seen.add(repo);
          recents.push({ repo, base: row.base ? String(row.base) : "" });
          if (recents.length === 5) break;
        }
        listLogin = github?.login ?? "";
        note.textContent = rows.length ? "" : "No repositories — an empty account, or a token without the repo scope.";
        if (force) note.textContent = note.textContent || "";
        drawRows();
      } catch (err) {
        note.textContent = (err as Error).message;
      }
    };

    filter.oninput = () => {
      filterText = filter.value;
      drawRows();
    };
    drawRows();
    focusAt(1);
    void load();
  };

  /** Step three: the branch to continue. Default first, because it is the
   *  common answer and it is the one that changes what a publish does. */
  const drawBranches = async (pick: Picked) => {
    phase = "branches";
    // A filter typed for the previous repository must not hide this one's
    // branches (Task 38: it used to carry over and show "No branches match").
    if (picked?.repo !== pick.repo) branchFilter = "";
    picked = pick;
    head.textContent = "Pick a branch";
    foot.innerHTML = "";
    list.innerHTML = "";

    const back = el("button", { class: "linkbtn", type: "button" }, ["‹ Repositories"]);
    back.onclick = () => void drawRepos();
    list.append(back);

    const filter = el("input", { class: "inp", type: "search", placeholder: "Filter branches…", "aria-label": "Filter branches" }) as HTMLInputElement;
    filter.value = branchFilter;
    const note = el("p", { class: "sheet__empty" }, [`Loading branches of ${pick.repo}…`]);
    const rowsHost = el("div", { class: "sheet__rows" });
    list.append(filter, note, rowsHost);

    const drawRows = () => {
      const q = branchFilter.trim().toLowerCase();
      rowsHost.innerHTML = "";
      const shown = branches.filter((b) => !q || b.name.toLowerCase().includes(q));
      if (branches.length && !shown.length) rowsHost.append(el("div", { class: "sheet__empty" }, ["No branches match"]));
      for (const b of shown) {
        const row = el("button", { class: "sheet__row", type: "button" }, [
          icon(CMD_ICON, "sheet__ico"),
          el("span", { class: "sheet__txt" }, [
            el("span", { class: "mono" }, [b.name]),
            el("span", { class: "sheet__sub" }, [
              b.default ? "default branch · you will work on it directly" : "continues this branch",
              ...(b.protected ? [" · protected"] : []),
            ]),
          ]),
        ]);
        row.onclick = () => {
          close();
          handlers.code(pick.repo, b.name);
        };
        rowsHost.append(row);
      }
      focusables = [back, filter, ...(Array.from(rowsHost.querySelectorAll(".sheet__row")) as HTMLElement[])] as HTMLElement[];
      at = Math.min(at, focusables.length - 1);
      focusables.forEach((n, k) => n.classList.toggle("is-focus", k === at));
    };

    filter.oninput = () => {
      branchFilter = filter.value;
      drawRows();
    };
    drawRows();
    focusAt(1);
    try {
      const res = (await gateway.request("github.branches", { repo: pick.repo, ...(pick.base ? { base: pick.base } : {}) })) as { branches?: BranchRow[] };
      branches = res.branches ?? [];
      note.textContent = branches.length ? "" : "No branches yet — an empty repository, or a token without the repo scope.";
      // A filter typed on a previous repository should not hide this one's list.
      drawRows();
    } catch (err) {
      note.textContent = (err as Error).message;
    }
  };

  scrim.onclick = () => (phase === "branches" ? void drawRepos() : phase === "repos" ? drawChoose() : close());
  document.addEventListener("keydown", onKey, true);
  overlay.hidden = false;
  drawChoose();
  void loadGithubStatus().then(() => {
    // The connection line and the second row's copy depend on this; redraw only
    // if the user has not moved on to the repo list yet.
    if (phase === "choose") drawChoose();
  });
}

/* ---------------- connect (§2.6) ---------------- */

export function connectDialog(after?: () => void): void {
  modal({
    title: "Connect GitHub",
    render: (box, close) => {
      const body = el("div", { class: "gh" });
      box.append(body);
      const drawHome = () => {
        body.innerHTML = "";
        body.append(el("p", { class: "gh__muted" }, ["Repos are read. Branches are pushed only when you ask."]));
        if (github?.ghCli && github.connected) {
          const card = el("button", { class: "gh__card", type: "button" }, [
            el("span", { class: "gh__card-dot" }, ["✓"]),
            el("span", { class: "gh__txt" }, [
              el("b", {}, ["Use this machine's gh login"]),
              el("span", { class: "gh__muted mono" }, [`@${github.login} on ${github.host} · verified`]),
            ]),
          ]);
          card.onclick = async () => {
            try {
              const res = (await gateway.request("github.adoptGhCli", {})) as { login?: string };
              toast(`connected as @${res.login ?? "you"}`, "ok");
              close();
              void loadGithubStatus().then(() => after?.());
            } catch (err) {
              toast((err as Error).message, "err");
            }
          };
          body.append(card, el("div", { class: "gh__or" }, ["or"]));
        }
        const btn = el("button", { class: "btn pri", type: "button" }, ["Continue with GitHub"]);
        btn.onclick = () => void startDeviceFlow(body, close, after);
        body.append(
          el("p", { class: "gh__muted" }, ["We'll show a code to enter on github.com. Nothing is pushed until you ask."]),
          el("div", { class: "gh__row" }, [btn]),
        );
      };
      drawHome();
      void loadGithubStatus().then(() => {
        if (body.isConnected) drawHome();
      });
    },
  });
}

async function startDeviceFlow(body: HTMLElement, close: () => void, after?: () => void): Promise<void> {
  let off = () => {};
  const paintCode = (userCode: string, verificationUri: string) => {
    body.innerHTML = "";
    const code = el("div", { class: "gh__code mono" }, [userCode]);
    const copy = el("button", { class: "btn", type: "button" }, ["Copy"]);
    copy.onclick = () => {
      void navigator.clipboard?.writeText(userCode).then(() => toast("code copied", "ok"), () => {});
    };
    const link = el("a", { class: "gh__link", href: verificationUri, target: "_blank", rel: "noopener" }, ["Open github.com/login/device ↗"]);
    const note = el("p", { class: "gh__muted" }, ["Waiting for approval…"]);
    const fill = el("div", { class: "gh__progress-fill" });
    body.append(
      el("h3", { class: "gh__h3" }, ["Enter this code on GitHub"]),
      el("div", { class: "gh__code-row" }, [code, copy]),
      el("div", { class: "gh__row" }, [link]),
      note,
      el("div", { class: "gh__progress" }, [fill]),
    );
    const total = 15 * 60 * 1000;
    const started = Date.now();
    const timer = setInterval(() => {
      const left = Math.max(0, total - (Date.now() - started));
      fill.style.width = `${Math.min(100, ((total - left) / total) * 100)}%`;
      const s = Math.round(left / 1000);
      note.textContent = `Waiting for approval…  (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left)`;
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  };

  let clearTimer = () => {};
  body.innerHTML = "";
  body.append(el("p", { class: "gh__muted" }, ["Starting the device flow…"]));

  // The gateway pushes `github.code` before it starts polling; the request that
  // started it resolves once approved, denied or expired.
  off = gateway.on((event, payload) => {
    if (event !== "github.code") return;
    clearTimer = paintCode(String(payload?.userCode ?? ""), String(payload?.verificationUri ?? "https://github.com/login/device"));
    off();
  });

  try {
    const res = (await gateway.request("github.connect", {})) as { login: string };
    toast(`connected as @${res.login}`, "ok");
    close();
    void loadGithubStatus().then(() => after?.());
  } catch (err) {
    const msg = (err as Error).message;
    body.innerHTML = "";
    const text = /device/i.test(msg)
      ? "This OAuth app has device login turned off — set addons.github.clientId to an app with it enabled."
      : /expired/i.test(msg)
        ? "The code expired. Generate a new one."
        : /denied|cancel/i.test(msg)
          ? "You cancelled — nothing was connected."
          : msg;
    const retry = el("button", { class: "btn pri", type: "button" }, ["Try again"]);
    retry.onclick = () => void startDeviceFlow(body, close, after);
    body.append(el("p", { class: "notice notice--error" }, [text]), el("div", { class: "gh__row" }, [retry]));
  } finally {
    off();
    clearTimer();
  }
}

/* ---------------- bind / retry ---------------- */

/** Bind an existing session (used by retry, and by the TUI-parity path). */
export async function bindRepoSession(key: string, repo: string, opts: { base?: string; branch?: string } = {}): Promise<boolean> {
  sessionKey = key;
  sessionEpoch += 1;
  const epoch = sessionEpoch;
  status = { bound: true, repo, branch: opts.branch ?? "starting…", base: opts.base };
  bar = { kind: "preparing", pct: 0, label: "cloning" };
  renderBar();
  const moved = () => key !== sessionKey || epoch !== sessionEpoch;
  try {
    await gateway.request("repo.bind", { sessionKey: key, repo, ...(opts.base ? { base: opts.base } : {}), ...(opts.branch ? { branch: opts.branch } : {}) });
    // The clone finished for a session that is no longer open: never paint its
    // failure (or its success) into whatever the user is looking at now.
    if (moved()) return true;
    await refreshRepo();
    return true;
  } catch (err) {
    if (moved()) return false;
    bar = { kind: "failed" };
    renderBar();
    toast((err as Error).message, "err");
    return false;
  }
}

async function retryBind(): Promise<void> {
  if (!status.repo) return;
  await bindRepoSession(sessionKey, status.repo, { base: status.base, branch: status.branch });
}

/* ---------------- changes / diff / publish (§2.4, §2.5) ---------------- */

function changesDialog(): void {
  const files = status.files ?? [];
  modal({
    title: "Changes in this session",
    render: (box) => {
      const push = status.publishBranch && status.publishBranch !== status.branch ? status.publishBranch : null;
      box.append(
        el("p", { class: "gh__muted mono" }, [
          push
            ? `on ${status.branch} · publishes to ${push} → ${status.base}`
            : `continuing ${status.branch} · PR target ${status.base}`,
        ]),
      );
      const table = el("div", { class: "gh__files" });
      for (const f of files) {
        const row = el("button", { class: "gh__file", type: "button" }, [
          el("span", { class: "mono" }, [f.path]),
          el("span", { class: "gh__stat mono" }, [`+${f.added}  −${f.removed}`]),
        ]);
        row.onclick = () => void diffDialog(f.path);
        table.append(row);
      }
      box.append(table);
      const diff = el("button", { class: "btn", type: "button" }, ["View diff"]);
      diff.onclick = () => void diffDialog();
      const pub = el("button", { class: "btn pri", type: "button" }, ["Publish PR"]);
      pub.onclick = () => publishDialog();
      box.append(el("div", { class: "gh__row" }, [diff, pub]));
    },
  });
}

async function diffDialog(path?: string): Promise<void> {
  let text = "";
  try {
    const res = (await gateway.request("repo.diff", { sessionKey, ...(path ? { path } : {}) })) as { diff?: string };
    text = String(res.diff ?? "");
  } catch (err) {
    text = (err as Error).message;
  }
  modal({
    title: path ? `Diff · ${path}` : "Diff",
    render: (box) => {
      const pre = el("pre", { class: "gh__diff mono" });
      pre.textContent = text || "No changes to show.";
      box.append(pre);
    },
  });
}

export function publishDialog(): void {
  if (!status.bound || !status.repo) return;
  if (status.clean && !lastPr) {
    toast("Nothing to publish — no changes in this session.", "info");
    return;
  }
  modal({
    title: `Publish to ${status.repo}`,
    render: (box, close) => {
      const title = el("input", { class: "inp", "aria-label": "Pull request title" }) as HTMLInputElement;
      title.value = `Changes from ${sessionKey.replace(/^main:/, "")}`;
      const body = el("textarea", { class: "inp", rows: "3", "aria-label": "Pull request body" }) as HTMLTextAreaElement;
      body.placeholder = "(optional)";
      const draft = el("input", { type: "checkbox", id: "gh-draft" }) as HTMLInputElement;
      draft.checked = true;
      const risky = (status.files ?? []).filter((f) => /(^|\/)\.env|\.pem$|^id_rsa|credential|\.p12$/i.test(f.path));
      let armed = false;
      const go = el("button", { class: "btn pri", type: "button" }, ["Publish"]);
      const preview = el("button", { class: "btn", type: "button" }, ["Preview diff"]);
      preview.onclick = () => void diffDialog();
      go.onclick = async () => {
        if (risky.length && !armed) {
          // A speed bump, not a wall: the first tap becomes "Publish anyway".
          armed = true;
          go.textContent = "Publish anyway";
          toast(`${risky.length} file(s) may contain secrets — review before publishing`, "info");
          return;
        }
        go.disabled = true;
        bar = { kind: "publishing" };
        renderBar();
        try {
          const res = (await gateway.request("repo.publish", {
            sessionKey,
            title: title.value,
            body: body.value,
            draft: draft.checked,
          })) as { prNumber?: number; prUrl: string; draft?: boolean };
          lastPr = { number: res.prNumber, url: res.prUrl };
          close();
          toast(res.draft ? `Draft PR #${res.prNumber} opened` : `PR #${res.prNumber} opened`, "ok");
          void refreshRepo();
        } catch (err) {
          const msg = (err as Error).message;
          bar = /token|401|403|reconnect/i.test(msg) ? { kind: "warn", reason: "stale" } : { kind: "ready" };
          renderBar();
          toast(msg, "err");
        } finally {
          go.disabled = false;
        }
      };

      const push = status.publishBranch || status.branch;
      const onBase = push !== status.branch;
      box.append(
        el("p", { class: "gh__muted mono" }, [`${push} → ${status.base}`]),
        el("p", { class: "gh__muted" }, [
          `${status.files?.length ?? 0} files, +${status.added ?? 0} −${status.removed ?? 0}`,
        ]),
        ...(onBase
          ? [
              el("p", { class: "gh__muted" }, [
                `This session continues ${status.base}, so the commits go to ${push}. ${status.base} is never pushed to.`,
              ]),
            ]
          : []),
        el("div", { class: "modal__field" }, [el("label", { class: "lbl" }, ["Title"]), title]),
        el("div", { class: "modal__field" }, [el("label", { class: "lbl" }, ["Body"]), body]),
        el("label", { class: "gh__check", for: "gh-draft" }, [draft, el("span", {}, [" Draft pull request"])]),
      );
      if (risky.length) {
        box.append(
          el("p", { class: "notice" }, [
            `⚠ ${risky.length} file(s) look like they may contain a secret (${risky
              .map((f) => f.path.split("/").pop())
              .slice(0, 3)
              .join(", ")}) — review first.`,
          ]),
        );
      }
      box.append(el("div", { class: "gh__row" }, [preview, go]));
    },
  });
}
