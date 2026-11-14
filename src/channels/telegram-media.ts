// P1 A5 — Telegram inbound media pipeline.
//
// Upstream contract researched in docs/openclaw/channels/telegram/media.md:
// getFile download → local path, photos flow to vision as image parts, voice
// transcripts are treated as untrusted content, static WEBP stickers become a
// <media:sticker> placeholder, a mediaMaxMb cap bounds downloads, and albums
// arrive as grouped sends (we handle each image individually — correlation is
// a later nicety, not a correctness gap).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

export type MediaKind = "photo" | "voice" | "document" | "video" | "audio" | "sticker";

export interface InboundMedia {
  kind: MediaKind;
  /** Telegram file_id — missing for stickers, which need no download. */
  fileId?: string;
  fileName?: string;
  mime?: string;
  /** Declared bytes from Telegram (checked against the cap before download). */
  size?: number;
  emoji?: string;
}

export interface SavedMedia {
  media: InboundMedia;
  /** Absolute path under <workspace>/media/telegram/<chatId>/. */
  path?: string;
  /** base64 data URI for photos destined for the vision turn. */
  dataUri?: string;
  /** Why the file was skipped (oversize/download failed). */
  note?: string;
}

interface TgFileStub {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  width?: number;
  height?: number;
  emoji?: string;
}

/** grammy Message → media plan. Photos pick the LARGEST declared size (their rule). */
export function planInboundMedia(msg: Record<string, unknown>): InboundMedia[] {
  const out: InboundMedia[] = [];
  const photo = msg["photo"] as TgFileStub[] | undefined;
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = [...photo].sort((a, b) => (a.file_size ?? a.width ?? 0) - (b.file_size ?? b.width ?? 0)).pop()!;
    out.push({ kind: "photo", fileId: largest.file_id, mime: "image/jpeg", size: largest.file_size });
  }
  const doc = msg["document"] as TgFileStub | undefined;
  if (doc?.file_id) {
    out.push({ kind: "document", fileId: doc.file_id, fileName: doc.file_name, mime: doc.mime_type, size: doc.file_size });
  }
  const voice = msg["voice"] as TgFileStub | undefined;
  if (voice?.file_id) out.push({ kind: "voice", fileId: voice.file_id, mime: voice.mime_type ?? "audio/ogg", size: voice.file_size });
  const audio = msg["audio"] as TgFileStub | undefined;
  if (audio?.file_id) {
    out.push({ kind: "audio", fileId: audio.file_id, fileName: audio.file_name, mime: audio.mime_type, size: audio.file_size });
  }
  const video = msg["video"] as TgFileStub | undefined;
  if (video?.file_id) out.push({ kind: "video", fileId: video.file_id, mime: video.mime_type, size: video.file_size });
  const sticker = msg["sticker"] as TgFileStub | undefined;
  if (sticker) out.push({ kind: "sticker", emoji: sticker.emoji ?? "" });
  return out;
}

/** Their static-WEBP placeholder rule, extended: every saved file is fs_read-able. */
export function mediaPlaceholder(saved: SavedMedia): string {
  const { media } = saved;
  if (media.kind === "sticker") return `<media:sticker${media.emoji ? ` ${media.emoji}` : ""}>`;
  if (saved.note) return `<media:${media.kind} omitted="${saved.note}">`;
  return `<media:${media.kind} path="${saved.path ?? ""}"${media.fileName ? ` name="${media.fileName}"` : ""}${media.mime ? ` mime="${media.mime}"` : ""}>`;
}

/** Path-safe media filename: `<stamp>-<kind><ext>` (no directory segments, ever). */
export function mediaFileName(m: InboundMedia, stamp: string): string {
  const base = sanitize(m.fileName ?? "") || m.kind;
  const ext = BASE_EXTS[m.kind] ?? extname(base) ?? "";
  return `${stamp}-${base.replace(new RegExp(`${escapeRe(extname(base))}$`), "")}${extname(base) || ext}`;
}

const BASE_EXTS: Record<MediaKind, string> = {
  photo: ".jpg",
  voice: ".ogg",
  audio: ".mp3",
  video: ".mp4",
  document: "",
  sticker: ".webp",
};

const sanitize = (s: string) =>
  s
    .replace(/[/\\]/g, "_")
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** getFile → HTTPS download → disk, bounded by maxBytes; photos also yield a data URI. */
export async function downloadInboundMedia(
  m: InboundMedia,
  deps: {
    chatId: number;
    workspace: string;
    maxBytes: number;
    getFile: (fileId: string) => Promise<{ file_path?: string }>;
    token: string;
    stamp?: string;
    fetchFn?: typeof fetch;
  },
): Promise<SavedMedia> {
  if (m.kind === "sticker") return { media: m };
  if (!m.fileId) return { media: m, note: "no file id" };
  if (m.size !== undefined && m.size > deps.maxBytes) {
    return { media: m, note: `${(m.size / 1048576).toFixed(1)} MB exceeds the ${(deps.maxBytes / 1048576).toFixed(0)} MB cap` };
  }
  try {
    const meta = await deps.getFile(m.fileId);
    const filePath = meta.file_path;
    if (!filePath || filePath.includes("..")) return { media: m, note: "no safe file path" };
    const fetchFn = deps.fetchFn ?? fetch;
    // No self-imposed time limits (rule: abort-signal-only); Telegram's edge
    // closes pathological hangs at its own layer.
    const res = await fetchFn(`https://api.telegram.org/file/bot${deps.token}/${filePath}`);
    if (!res.ok) return { media: m, note: `download failed (HTTP ${res.status})` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > deps.maxBytes) {
      return { media: m, note: `${(len / 1048576).toFixed(1)} MB exceeds the ${(deps.maxBytes / 1048576).toFixed(0)} MB cap` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > deps.maxBytes) {
      return { media: m, note: `${(buf.length / 1048576).toFixed(1)} MB exceeds the ${(deps.maxBytes / 1048576).toFixed(0)} MB cap` };
    }
    const dir = join(deps.workspace, "media", "telegram", String(deps.chatId));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, mediaFileName(m, deps.stamp ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`));
    writeFileSync(path, buf);
    const dataUri = m.kind === "photo" ? `data:${m.mime ?? "image/jpeg"};base64,${buf.toString("base64")}` : undefined;
    return { media: m, path, dataUri };
  } catch (err) {
    return { media: m, note: `download failed (${(err as Error).message.slice(0, 120)})` };
  }
}

/**
 * Provider rejects multimodal/input arrays → the loop retries the turn once
 * text-only (their text-only fallback rule). Lives with the other wire-error
 * knowledge in agent/llm; re-exported for media-side callers and tests.
 */
export { isVisionUnsupportedError } from "../agent/llm.js";
