/**
 * P3 (row Missing!#22) — dependency-light PDF text extraction.
 *
 * Their `pdf` tool falls back to text extraction for every non-native
 * provider; we ride that lane entirely (our provider surface is
 * OpenAI-compatible). This is a deliberately prosaic extractor: scan the raw
 * file for stream objects, flate-inflate when the dictionary asks for it,
 * then read the text-showing operators (Tj / TJ / ' / ") plus their Td TD T*
 * line moves. Encrypted, image-only, or CMap-heavy PDFs degrade to an empty
 * result (callers then try CLI entries like pdftotext — their fallback
 * ladder) instead of throwing.
 */
import { inflateSync } from "node:zlib";

export interface PdfExtractResult {
  text: string;
  /** Best-effort page count from /Type /Page dictionaries. */
  pages: number;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 4000;

/** Decode PDF literal-string escapes (\n \r \t \( \) \\ \ddd octal). */
function decodeLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "b" || n === "f") { /* drop. */ }
    else if (n >= "0" && n <= "7") {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] !== undefined && raw[i + 1]! >= "0" && raw[i + 1]! <= "7") oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += n; // \( \) \\ and line-continuation
  }
  return out;
}

/** Parenthesized literal strings, escapes honored. */
function readLiterals(src: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to && i < src.length; i++) {
    if (src[i] !== "(") continue;
    let depth = 1;
    let j = i + 1;
    let raw = "";
    while (j < src.length && depth > 0) {
      const c = src[j]!;
      if (c === "\\") {
        raw += c + (src[j + 1] ?? "");
        j += 2;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      raw += c;
      j++;
    }
    if (depth === 0) {
      out.push(decodeLiteral(raw));
      i = j - 1;
    }
  }
  return out;
}

/**
 * Pull readable text out of one (possibly decoded) content stream via BT/ET
 * text objects: Tj literals, [ ... ] TJ arrays, Td/TD/T* as line breaks.
 */
export function textFromContentStream(body: string): string {
  const parts: string[] = [];
  const re = /BT|ET|\[(?:[^\[\]]|\([^()]*\))*\]\s*TJ|-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+T[dD*]|\((?:[^()\\]|\\.)*\)\s*Tj/g;
  for (const m of body.matchAll(re)) {
    const tok = m[0];
    if (tok === "ET") {
      parts.push("\n");
      continue;
    }
    if (/T[dD*]$/.test(tok)) {
      parts.push("\n");
      continue;
    }
    if (tok.endsWith("TJ")) {
      const arrEnd = tok.length - 2;
      parts.push(readLiterals(tok, 0, arrEnd).join(""));
      continue;
    }
    if (tok.endsWith("Tj")) {
      parts.push(readLiterals(tok, 0, tok.length - 2).join(""));
    }
  }
  return parts.join("");
}

/** Locate `stream`…`endstream` bodies; inflate when /FlateDecode is set. */
function eachStream(pdf: Buffer, visit: (body: string, dict: string) => void): void {
  const text = pdf.toString("latin1");
  let idx = 0;
  while (true) {
    const s = text.indexOf("stream", idx);
    if (s === -1) return;
    const e = text.indexOf("endstream", s);
    if (e === -1) return;
    const dictStart = Math.max(0, text.lastIndexOf("<<", s));
    const dict = text.slice(dictStart, s);
    if (!/XObject|Metadata|Image|ToUnicode/.test(dict)) {
      let body = text.slice(s + "stream".length, e);
      if (body.startsWith("\r\n")) body = body.slice(2);
      else if (body.startsWith("\n") || body.startsWith("\r")) body = body.slice(1);
      if (body.endsWith("\r\n")) body = body.slice(0, -2);
      else if (body.endsWith("\n") || body.endsWith("\r")) body = body.slice(0, -1);
      if (/\/FlateDecode/.test(dict)) {
        try {
          body = inflateSync(Buffer.from(body, "latin1")).toString("latin1");
        } catch {
          /* broken stream — the next candidate may still decode */
        }
      }
      visit(body, dict);
    }
    idx = e + "endstream".length;
  }
}

export function extractPdfText(buf: Buffer, opts: { maxChars?: number } = {}): PdfExtractResult {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  // %PDF magic; encrypted files bail immediately (their password flag is the
  // CLI-entry lane, not silent corruption).
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) throw new Error("not a PDF");
  if (buf.toString("latin1").includes("/Encrypt")) throw new Error("PDF is encrypted");
  const raw = buf.toString("latin1");
  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length);
  let text = "";
  eachStream(buf, (body) => {
    if (text.length >= maxChars) return;
    const chunk = textFromContentStream(body);
    if (chunk.trim()) text += chunk;
  });
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { text, pages, truncated };
}

/** Extract from a file path (bounded read is the caller's job — maxBytes). */
export async function extractPdfFile(path: string, opts: { maxChars?: number } = {}): Promise<PdfExtractResult> {
  const { readFile } = await import("node:fs/promises");
  return extractPdfText(await readFile(path), opts);
}
