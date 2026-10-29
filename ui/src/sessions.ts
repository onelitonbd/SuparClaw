// The chat sidebar's list: grouping, rows and search hits.
//
// Pure DOM builders — no gateway calls and no module state — so the same markup
// can be rendered in a test and in the app. `main.ts` owns the wiring: it
// decides what a click does and which row is current, this file decides what a
// row looks like.

import { el, fmtTime } from "./dom.js";

export interface SessionRow {
  key: string;
  last_msg_at?: number;
  title?: string;
  name?: string | null;
  archived?: number;
  /** Task 35: a code session names its repository, so the sidebar can say so. */
  repo?: string | null;
  branch?: string | null;
}

export interface SessionGroup {
  label: string;
  rows: SessionRow[];
}

const ARCHIVED = "Archived";
const DAY = 86_400_000;

/** Midnight of the day `ms` falls in, in the viewer's own timezone. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Which bucket a row belongs to. Archived wins over age: a session that was
 *  put away is not "yesterday's work" any more. */
export function bucketOf(row: SessionRow, now = Date.now()): string {
  if (Number(row.archived ?? 0) === 1) return ARCHIVED;
  const at = Number(row.last_msg_at ?? 0);
  // No timestamp: the session exists now (it is usually the one on screen), so
  // it belongs at the top rather than in a "no date" bucket nobody scans for.
  if (!at || at > now) return "Today";
  const today = dayStart(now);
  if (at >= today) return "Today";
  if (at >= today - DAY) return "Yesterday";
  if (at >= today - 7 * DAY) return "Previous 7 days";
  return "Older";
}

/** Rows in reading order, one bucket per label, archived last, no duplicates. */
export function groupSessions(rows: SessionRow[], now = Date.now()): SessionGroup[] {
  const order = ["Today", "Yesterday", "Previous 7 days", "Older", ARCHIVED];
  const seen = new Set<string>();
  const buckets = new Map<string, SessionRow[]>();
  for (const row of rows) {
    if (!row?.key || seen.has(row.key)) continue;
    seen.add(row.key);
    const label = bucketOf(row, now);
    const list = buckets.get(label) ?? [];
    list.push(row);
    buckets.set(label, list);
  }
  return order
    .filter((label) => (buckets.get(label)?.length ?? 0) > 0)
    .map((label) => ({ label, rows: buckets.get(label) ?? [] }));
}

/**
 * What a row is called: a rename wins, then the auto-title, then a readable
 * placeholder — a chat that has not been named yet should not introduce itself
 * as `main:m3x9q` (it names itself from its first exchange; see naming.ts).
 */
export function rowTitle(row: SessionRow): string {
  return String(row.name || row.title || placeholderTitle(row.key));
}

/** The name an unnamed session shows: the main chat is still "Main". */
export function placeholderTitle(key: string): string {
  return key === "main:main" ? "Main chat" : "New chat";
}

/** The second line: when it last spoke. The key is on the row's tooltip and in
 *  its accessible name — printing `main:x` under every title doubles the meta
 *  line for information nobody reads twice. */
export function rowMeta(row: SessionRow): string {
  return row.last_msg_at ? fmtTime(Number(row.last_msg_at)) : "no messages";
}

export interface RowHandlers {
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}

/** One session row: a container with two separate controls inside it.
 *
 *  The row used to be a `<button>` with the kebab `<button>` nested in it —
 *  interactive content inside interactive content, two tab stops announced as
 *  one. The navigation button and the menu button are siblings now. */
export function sessionRow(row: SessionRow, h: RowHandlers): HTMLElement {
  const archived = Number(row.archived ?? 0) === 1;
  const open = el("button", {
    class: "session__open",
    type: "button",
    title: row.key,
    "aria-label": `${rowTitle(row)} (${row.key})`,
    ...(h.active ? { "aria-current": "page" } : {}),
  }, [
    el("span", { class: "session__text" }, [
      el("span", { class: "session__title" }, [rowTitle(row)]),
      el("span", { class: "session__meta" }, [
        // A repo chip, not a second meta line: the row's height must not change
        // between a chat and a code session (the list is a list, not a tree).
        ...(row.repo
          ? [el("span", { class: "session__repo mono", title: `${row.repo}${row.branch ? ` · ${row.branch}` : ""}` }, [row.repo]), " · "]
          : []),
        rowMeta(row),
      ]),
    ]),
  ]);
  open.onclick = () => h.onOpen();
  const kebab = el("button", {
    class: "session__kebab",
    type: "button",
    "aria-label": `Menu for ${row.key}`,
    title: "Rename, export, archive, delete",
  }, ["⋯"]);
  kebab.onclick = (e) => {
    e.stopPropagation();
    const ev = e as MouseEvent;
    h.onMenu(ev.clientX, ev.clientY);
  };
  const node = el("div", {
    class: `session${h.active ? " is-active" : ""}${archived ? " session--archived" : ""}`,
    "data-key": row.key,
  }, [
    open,
    ...(h.busy ? [el("span", { class: "dot dot--live", "aria-label": "working", title: "Working" })] : []),
    kebab,
  ]);
  node.oncontextmenu = (e) => {
    e.preventDefault();
    h.onMenu(e.clientX, e.clientY);
  };
  return node;
}

/** A message hit's snippet: the server marks matches with « », everything else
 *  stays text so a transcript can never inject markup. */
export function snippetNodes(snippet: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let rest = snippet;
  for (;;) {
    const open = rest.indexOf("«");
    const close = open < 0 ? -1 : rest.indexOf("»", open);
    if (open < 0 || close < 0) { out.push(rest); break; }
    out.push(rest.slice(0, open));
    out.push(el("mark", {}, [rest.slice(open + 1, close)]));
    rest = rest.slice(close + 1);
  }
  return out;
}

export interface SearchResult {
  titleHits?: { sessionKey: string; title?: string; lastMsgAt?: number }[];
  messageHits?: { sessionKey: string; title?: string; role?: string; createdAt?: number; snippet?: string; messageId?: number }[];
}

/** One message hit: the session it belongs to, who spoke, and the line. */
export function sessionHit(
  hit: NonNullable<SearchResult["messageHits"]>[number],
  onOpen: () => void,
): HTMLElement {
  const open = el("button", { class: "session__open", type: "button" }, [
    el("span", { class: "session__text" }, [
      el("span", { class: "session__title" }, [String(hit.title || hit.sessionKey)]),
      el("span", { class: "session__meta" }, [
        `${String(hit.role ?? "message")}${hit.createdAt ? ` · ${fmtTime(Number(hit.createdAt))}` : ""} · ${hit.sessionKey}`,
      ]),
      el("span", { class: "session__snippet" }, snippetNodes(String(hit.snippet ?? ""))),
    ]),
  ]);
  open.onclick = () => onOpen();
  return el("div", { class: "session session--hit", "data-key": hit.sessionKey }, [open]);
}

/** The whole search view: a header with real counts and the rows beneath it,
 *  or the empty state with the way back out. */
export function searchView(
  q: string,
  result: SearchResult,
  handlers: { openSession: (key: string) => void; openHit: (key: string, messageId?: number) => void; clear: () => void },
): Node[] {
  const titleHits = result.titleHits ?? [];
  const messageHits = result.messageHits ?? [];
  const clear = el("button", { class: "srccap__clear", type: "button" }, ["Clear"]);
  clear.onclick = () => handlers.clear();
  const total = titleHits.length + messageHits.length;
  const head = el("div", { class: "srccap" }, [
    el("span", {}, [
      total === 0
        ? `No matches for \u201C${q}\u201D`
        : `${titleHits.length} ${titleHits.length === 1 ? "session" : "sessions"} · ${messageHits.length} ${messageHits.length === 1 ? "message" : "messages"}`,
    ]),
    clear,
  ]);
  const rows: Node[] = titleHits.map((h) => {
    const open = el("button", { class: "session__open", type: "button" }, [
      el("span", { class: "session__text" }, [
        el("span", { class: "session__title" }, [String(h.title || h.sessionKey)]),
        el("span", { class: "session__meta" }, [
          `${h.sessionKey}${h.lastMsgAt ? ` · ${fmtTime(Number(h.lastMsgAt))}` : ""}`,
        ]),
      ]),
    ]);
    open.onclick = () => handlers.openSession(String(h.sessionKey));
    return el("div", { class: "session session--hit", "data-key": h.sessionKey }, [open]);
  });
  for (const h of messageHits) {
    const mid = Number(h.messageId);
    rows.push(sessionHit(h, () => handlers.openHit(String(h.sessionKey), Number.isFinite(mid) ? mid : undefined)));
  }
  if (total === 0) {
    const again = el("button", { class: "btn sm", type: "button" }, ["Clear search"]);
    again.onclick = () => handlers.clear();
    rows.push(el("div", { class: "sidebar__empty" }, [
      el("p", { class: "hint" }, ["Search looks in session names and in what was said."]),
      again,
    ]));
  }
  return [head, ...rows];
}
