import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";

export type TelegramMediaKind = "auto" | "photo" | "video" | "audio" | "voice" | "animation" | "document";
export type TelegramUploadKind = Exclude<TelegramMediaKind, "auto">;

export interface TelegramMediaUpload {
  /** Absolute path validated by the agent tool to remain inside the workspace. */
  path: string;
  filename: string;
  kind: TelegramUploadKind;
  caption?: string;
}

export type TelegramMediaSender = (file: TelegramMediaUpload) => Promise<{ messageId?: number }>;

export interface ResolvedTelegramMediaFile extends TelegramMediaUpload {
  size: number;
}

export const TELEGRAM_OUTBOUND_MAX_BYTES = 50_000_000;
const TELEGRAM_PHOTO_MAX_BYTES = 10_000_000;

/** Resolve an agent-supplied workspace-relative file and select a Bot API method. */
export function resolveTelegramMediaFile(
  workspace: string,
  requestedPath: string,
  kind: TelegramMediaKind = "auto",
  requestedFilename?: string,
  caption?: string,
): ResolvedTelegramMediaFile {
  if (!["auto", "photo", "video", "audio", "voice", "animation", "document"].includes(kind)) {
    throw new Error(`unsupported media type: ${String(kind)}`);
  }
  const path = requestedPath.trim();
  if (!path) throw new Error("path is required");
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new Error("path must be a workspace-relative path using forward slashes");
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("path must not contain empty, dot, or parent-directory segments");
  }

  const root = realpathSync(workspace);
  const candidate = resolve(root, ...parts);
  const lexicalRelative = relative(root, candidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || resolve(candidate) !== candidate) {
    throw new Error("path escapes the session workspace");
  }

  const fileStat = lstatSync(candidate);
  if (fileStat.isSymbolicLink()) throw new Error("symbolic links cannot be sent; copy the file into the workspace first");
  if (!fileStat.isFile()) throw new Error("path must name a regular file");
  const realFile = realpathSync(candidate);
  const realRelative = relative(root, realFile);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || resolve(realFile) !== realFile) {
    throw new Error("file resolves outside the session workspace");
  }
  const size = statSync(realFile).size;
  if (size === 0) throw new Error("empty files cannot be sent");
  if (size > TELEGRAM_OUTBOUND_MAX_BYTES) {
    throw new Error(`file is ${(size / 1024 / 1024).toFixed(1)} MB; Telegram bot uploads are limited to 50 MB`);
  }

  const sourceName = basename(path);
  const sourceExt = extname(sourceName).toLowerCase();
  let fileBase = basename(requestedFilename?.trim() || sourceName).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 240);
  const displayExt = extname(fileBase).toLowerCase();
  if (sourceExt && displayExt && displayExt !== sourceExt) {
    throw new Error(`filename extension must match the source file (${sourceExt})`);
  }
  if (sourceExt && !displayExt) fileBase += sourceExt;
  const filename = fileBase;
  if (!filename || filename === "." || filename === "..") throw new Error("filename is invalid");
  const note = caption?.trim();
  if (note && note.length > 1024) throw new Error("caption must be at most 1024 characters");

  const ext = sourceExt;
  const selected: TelegramUploadKind = kind === "auto" ? inferKind(ext, size) : kind;
  validateKind(selected, ext, size);
  return { path: realFile, filename, kind: selected, ...(note ? { caption: note } : {}), size };
}

function inferKind(ext: string, size: number): TelegramUploadKind {
  if ([".jpg", ".jpeg", ".png"].includes(ext) && size <= TELEGRAM_PHOTO_MAX_BYTES) return "photo";
  if (ext === ".gif") return "animation";
  if (ext === ".mp4") return "video";
  if ([".mp3", ".m4a"].includes(ext)) return "audio";
  if ([".ogg", ".opus"].includes(ext)) return "voice";
  return "document";
}

function validateKind(kind: TelegramUploadKind, ext: string, size: number): void {
  if (kind === "photo") {
    if (![".jpg", ".jpeg", ".png"].includes(ext)) throw new Error("photo delivery supports .jpg, .jpeg, or .png; choose document for other image formats");
    if (size > TELEGRAM_PHOTO_MAX_BYTES) throw new Error("Telegram photo uploads are limited to 10 MB; choose document to send this file as an attachment");
  } else if (kind === "video" && ext !== ".mp4") {
    throw new Error("Telegram video delivery requires an .mp4 file; choose document for other video formats");
  } else if (kind === "audio" && ![".mp3", ".m4a"].includes(ext)) {
    throw new Error("Telegram audio delivery supports .mp3 or .m4a; choose document for other audio formats");
  } else if (kind === "voice" && ![".ogg", ".opus", ".mp3"].includes(ext)) {
    throw new Error("Telegram voice delivery supports .ogg, .opus, or .mp3 audio");
  } else if (kind === "animation" && ![".gif", ".mp4"].includes(ext)) {
    throw new Error("Telegram animation delivery supports .gif or .mp4; choose video or document otherwise");
  }
}
