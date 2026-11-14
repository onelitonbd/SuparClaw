// The agent's face.
//
// The portrait is stored as one bounded data URL inside `agents.identity.avatar`,
// so it travels with the config (backups, `sc config`, a new device) instead of
// living in a state-dir file the gateway would have to serve. That makes *size*
// the contract: the browser must never hand the config a 4 MB photo.
//
// Everything here except prepareAvatar() is pure and DOM-free, so the crop maths
// and the encode ladder are testable on a machine with no canvas.

/** Formats we accept. No GIF: a still is required, and an animation would be
 *  silently flattened — a worse outcome than saying no up front. */
export const AVATAR_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export const AVATAR_ACCEPT = AVATAR_MIME.join(",");
/** Cap on the file the user picks, before we decode anything. */
export const AVATAR_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Decode guard: a phone photo can be 48 MP, and drawImage on that is a stall. */
export const AVATAR_MAX_DIMENSION = 6000;
/** Cap on the stored string. 32,000 base64 characters ≈ 24 KB of pixels, which
 *  is a full 128 px PNG — the schema enforces the same number. */
export const AVATAR_MAX_CHARS = 32_000;
/** Rendered size of the tile; the source is never smaller than this. */
export const AVATAR_TARGET_PX = 128;

export interface AvatarAttempt {
  px: number;
  mime: "image/png" | "image/jpeg";
  /** JPEG only; PNG ignores it. */
  quality?: number;
}

/** Quality ladder, best-looking first. The first attempt that fits the budget
 *  wins; PNG before JPEG so transparency survives whenever it can. */
export const AVATAR_LADDER: readonly AvatarAttempt[] = [
  { px: AVATAR_TARGET_PX, mime: "image/png" },
  { px: 96, mime: "image/png" },
  { px: AVATAR_TARGET_PX, mime: "image/jpeg", quality: 0.82 },
  { px: 96, mime: "image/jpeg", quality: 0.7 },
];

const FULL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** "12.4 MB", "860 KB" — the number the rejection sentence needs. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Why this file cannot be used, or `null` when it can. Returns a sentence, not a
 * code: the caller shows it verbatim next to the button.
 */
export function checkAvatarFile(file: { type: string; size: number; name?: string }): string | null {
  const type = String(file.type || "").toLowerCase();
  if (!type) return "That file has no recognised image type — use a PNG, JPEG or WebP.";
  if (!(AVATAR_MIME as readonly string[]).includes(type)) {
    if (type === "image/gif") return "Animated pictures are not supported here — pick a PNG, JPEG or WebP still.";
    if (type === "image/heic" || type === "image/heif") return "HEIC photos are not readable in the browser — export it as JPEG first.";
    if (type === "image/svg+xml") return "SVG can carry code, so it is not accepted — use a PNG, JPEG or WebP.";
    return "Only PNG, JPEG or WebP pictures can be used as the agent's face.";
  }
  if (file.size <= 0) return "That file is empty.";
  if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
    return `That picture is ${formatBytes(file.size)} — pick one under ${formatBytes(AVATAR_MAX_UPLOAD_BYTES)}.`;
  }
  return null;
}

/** Centred square crop of a w×h picture. Upscales small images rather than
 *  padding them: `side` is always min(w, h), never 0 for a real image. */
export function cropSquare(w: number, h: number): { sx: number; sy: number; side: number } {
  const width = Math.max(0, Math.floor(w));
  const height = Math.max(0, Math.floor(h));
  const side = Math.min(width, height);
  return {
    sx: Math.floor((width - side) / 2),
    sy: Math.floor((height - side) / 2),
    side,
  };
}

/**
 * Render-time whitelist. Anything that is not one of our own bounded data URLs is
 * treated as absent, so a hand-edited `javascript:` or `data:image/svg+xml` in the
 * config can never reach an `<img src>`.
 */
export function isStoredAvatar(value: unknown, maxChars: number = AVATAR_MAX_CHARS): value is string {
  if (typeof value !== "string") return false;
  if (value.length > maxChars) return false;
  // FULL_RE demands a non-empty base64 body, so a bare prefix is already out.
  return FULL_RE.test(value);
}

/**
 * Walk the ladder until an encoding fits. `encode` draws and serializes one
 * attempt — injected so this stays canvas-free and testable.
 */
export function fitAvatarBudget(
  encode: (attempt: AvatarAttempt) => string,
  maxChars: number = AVATAR_MAX_CHARS,
): string {
  for (const attempt of AVATAR_LADDER) {
    let out = "";
    try {
      out = encode(attempt);
    } catch {
      continue;
    }
    // isStoredAvatar also rejects canvas's "data:," failure and a mismatched mime.
    if (isStoredAvatar(out, maxChars)) return out;
  }
  throw new Error("That picture is too detailed to shrink — try a simpler photo.");
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (result) resolve(result);
      else reject(new Error("That file could not be read."));
    };
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file is not a picture this browser can decode."));
    img.src = src;
  });
}

/**
 * File in, bounded square data URL out. The only function here that needs a
 * browser, and it is only reached from a click handler.
 */
export async function prepareAvatar(file: File): Promise<string> {
  const reason = checkAvatarFile(file);
  if (reason) throw new Error(reason);

  const source = await readAsDataUrl(file);
  const img = await loadImage(source);
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (!w || !h) throw new Error("That picture has no usable size.");
  if (Math.max(w, h) > AVATAR_MAX_DIMENSION) {
    throw new Error(`That picture is ${w}×${h} — resize it under ${AVATAR_MAX_DIMENSION} px first.`);
  }

  const { sx, sy, side } = cropSquare(w, h);
  if (!side) throw new Error("That picture has no usable size.");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot prepare a picture — try another one.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  return fitAvatarBudget(({ px, mime, quality }) => {
    canvas.width = px;
    canvas.height = px;
    ctx.clearRect(0, 0, px, px);
    if (mime === "image/jpeg") {
      // JPEG has no alpha: flatten instead of letting transparency go black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, px, px);
    }
    ctx.drawImage(img, sx, sy, side, side, 0, 0, px, px);
    return canvas.toDataURL(mime, quality);
  });
}
