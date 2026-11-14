// Media references (Task 30).
//
// The gateway writes the files a message came with into the prompt as one tag
// per file:
//
//   <media:attachment path="media/20261026…-report.pdf" name="report.pdf" mime="application/pdf" size="524288">
//   <media:photo path="media/telegram/123/…-0-photo.jpg" name="photo.jpg" mime="image/jpeg">
//   <media:document omitted="larger than 20 MB">
//   <media:sticker 🦀>
//
// That is the right shape for the model (it can read the path and call a tool)
// and the wrong shape for a human: the transcript stored the text, so a reload
// showed the XML in the user's own bubble. This module is the one place that
// knows the syntax — `parseMediaRefs` splits a message into "what the human
// typed" and "the files it carried", and both the Control UI and the daemon's
// cleanup use it, so they can never disagree about what a message references.

export interface MediaRef {
  /** Tag kind: attachment (web) | photo | document | voice | audio | video | sticker. */
  kind: string;
  /** Workspace-relative file path (`media/…`); "" when the file was not kept. */
  path: string;
  /** Original file name, when the tag carries one. */
  name: string;
  mime: string;
  /** Byte size, when known. */
  size?: number;
  /** Why the file is not here — a tag note, not an error to shout about. */
  omitted?: string;
  /** Bare words inside the tag that are not attributes (a sticker's emoji). */
  label?: string;
}

const KINDS = new Set(["attachment", "photo", "document", "voice", "audio", "video", "sticker"]);

/** `<media:kind attr="v" attr="v" rest-of-tag>` — attributes never contain `>`. */
const TAG = /<media:([a-z][a-z0-9_-]*)((?:"[^"]*"|[^>"])*)>/gi;
const ATTR = /([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/g;

/** A path we will render/act on: inside the workspace media tree, no traversal. */
export function isSafeMediaPath(path: string): boolean {
  if (!path.startsWith("media/")) return false;
  if (path.includes("\0") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

function parseTag(kind: string, rest: string): MediaRef | null {
  const attrs: Record<string, string> = {};
  for (const m of rest.matchAll(ATTR)) attrs[m[1]!.toLowerCase()] = m[2]!;
  const leftovers = rest.replace(ATTR, "").trim();
  const path = (attrs["path"] ?? "").trim();
  const omitted = (attrs["omitted"] ?? "").trim();
  // Keep a tag only when it describes something we can show: a real file, a
  // deliberate omission, or a sticker. Anything else is text the user typed.
  if (kind !== "sticker" && !path && !omitted) return null;
  if (path && !isSafeMediaPath(path)) return null;
  const size = Number(attrs["size"]);
  return {
    kind,
    path,
    name: (attrs["name"] ?? "").trim() || (path ? path.split("/").pop() ?? "" : ""),
    mime: (attrs["mime"] ?? "").trim(),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    ...(omitted ? { omitted } : {}),
    ...(leftovers ? { label: leftovers } : {}),
  };
}

/**
 * Split a stored message into its prose and the files it carried.
 *
 * The prose is what the user typed: tags are removed, and the whitespace they
 * leave behind is tidied (a message that was only a file becomes "" and the UI
 * draws the chip alone).
 */
export function parseMediaRefs(text: string): { text: string; refs: MediaRef[] } {
  const refs: MediaRef[] = [];
  const raw = String(text ?? "");
  const prose = raw.replace(TAG, (whole: string, kind: string, rest: string) => {
    if (!KINDS.has(kind.toLowerCase())) return whole;
    const ref = parseTag(kind.toLowerCase(), rest ?? "");
    if (!ref) return whole;
    refs.push(ref);
    return "";
  });
  if (refs.length === 0) return { text: raw, refs };
  const cleaned = prose
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return { text: cleaned, refs };
}

/** The prose only — for a composer, a copy button, or a plain-text surface. */
export function stripMediaRefs(text: string): string {
  return parseMediaRefs(text).text;
}

/** Human size for a chip: 12 KB, 3.4 MB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
}
