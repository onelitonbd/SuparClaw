/**
 * WebChat attachment intake (P3 #28 — their webchat.md "upload files into
 * chat"). Pure validation/decoding, separated from the WS handler and the
 * Service so the limits stay testable without a running gateway.
 *
 * Wire shape (chat.send params):
 *   attachments: [{ name: string, mime: string, data: string }]
 * `data` is a base64 string, optionally wrapped in a `data:<mime>;base64,`
 * URI (what FileReader.readAsDataURL produces in the browser).
 *
 * Their contract pieces we honor at our scale:
 *  - hard caps on count/size, with per-file reasons (their attachment
 *    failures stay visible beside the composer — UI renders rejected names)
 *  - images ride as vision content parts (same path Telegram photos use)
 *  - non-images persist under workspace/media with a `<media:attachment
 *    path=…>` placeholder so the agent can fs_read / pdf-tool them later.
 */

export interface WebAttachmentInput {
  name?: unknown;
  mime?: unknown;
  data?: unknown;
}

export interface ParsedAttachment {
  name: string;
  mime: string;
  buf: Buffer;
}

export interface RejectedAttachment {
  name: string;
  reason: string;
}

export interface WebAttachLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const WEB_ATTACH_LIMITS: WebAttachLimits = {
  // The WS frame cap (25 MB) is deliberately higher than these real caps;
  // application limits live here, not in the transport.
  maxFiles: 4,
  maxFileBytes: 8 * 1048576,
  maxTotalBytes: 12 * 1048576,
};

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(mime.trim());
}

/** Path-safe display/file name — strip directory segments and odd bytes. */
export function sanitizeAttachName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base.replace(/[^\w.\- ()\[\]]+/g, "-").replace(/^\.+/, "").trim();
  return (clean || "file").slice(0, 80);
}

function decodeData(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Accept either a data URI or bare base64.
  const comma = raw.startsWith("data:") ? raw.indexOf(",") : -1;
  const b64 = (comma >= 0 ? raw.slice(comma + 1) : raw).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) return null;
  const buf = Buffer.from(b64, "base64");
  // Round-trip guard against silently truncated/loose decodes.
  return buf.length > 0 ? buf : null;
}

export function parseWebAttachments(
  raw: unknown,
  limits: WebAttachLimits = WEB_ATTACH_LIMITS,
): { ok: ParsedAttachment[]; rejected: RejectedAttachment[] } {
  const ok: ParsedAttachment[] = [];
  const rejected: RejectedAttachment[] = [];
  if (raw === undefined || raw === null) return { ok, rejected };
  const list = Array.isArray(raw) ? (raw as WebAttachmentInput[]) : [];
  if (!Array.isArray(raw)) {
    rejected.push({ name: "attachments", reason: "attachments must be an array" });
    return { ok, rejected };
  }
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i] ?? {};
    const name = sanitizeAttachName(typeof item.name === "string" ? item.name : `file-${i + 1}`);
    if (ok.length + rejected.length >= limits.maxFiles && i >= limits.maxFiles) {
      rejected.push({ name, reason: `too many files (max ${limits.maxFiles})` });
      continue;
    }
    const buf = decodeData(item.data);
    if (!buf) {
      rejected.push({ name, reason: "unreadable file data" });
      continue;
    }
    if (buf.length > limits.maxFileBytes) {
      rejected.push({ name, reason: `larger than ${Math.floor(limits.maxFileBytes / 1048576)} MB` });
      continue;
    }
    if (total + buf.length > limits.maxTotalBytes) {
      rejected.push({ name, reason: `message attachments exceed ${Math.floor(limits.maxTotalBytes / 1048576)} MB total` });
      continue;
    }
    const mime =
      typeof item.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(item.mime.trim())
        ? item.mime.trim().toLowerCase()
        : "application/octet-stream";
    total += buf.length;
    ok.push({ name, mime, buf });
  }
  return { ok, rejected };
}
