/**
 * Minimal POSIX ustar read/write over node:zlib (P3 #29 — `sc backup`).
 * No external tar dependency: the archive is ours, so the format envelope is
 * deliberately small — regular files, directories, GNU longname entries.
 * Symlinks and device nodes are rejected on write and refused on extraction
 * (their "never write through a restored link" rule, simplified).
 */
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const LONGNAME = "././@LongLink";

function octal(value: number, width: number): Buffer {
  const s = value.toString(8).padStart(width - 1, "0");
  if (s.length > width - 1) throw new Error(`tar field overflow: ${value}`);
  return Buffer.concat([Buffer.from(s, "ascii"), Buffer.alloc(1)]);
}

function header(name: string, size: number, type: "0" | "5" | "L", mtime: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name.slice(0, 99), 0, "ascii");
  Buffer.from("0000644\0", "ascii").copy(buf, 100); // mode
  Buffer.from("0000000\0", "ascii").copy(buf, 108); // uid
  Buffer.from("0000000\0", "ascii").copy(buf, 116); // gid
  octal(size, 12).copy(buf, 124);
  octal(Math.floor(mtime / 1000), 12).copy(buf, 136);
  buf.write(type, 156, "ascii");
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  buf.fill(0x20, 148, 156); // checksum computed over spaces
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i]!;
  octal(sum, 8).copy(buf, 148); // ustar checksum field: 6 digits, NUL, space
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

export interface TarEntry {
  name: string; // archive path, forward slashes
  buf?: Buffer; // regular file content; undefined for directories
  mtime?: number;
}

export function writeTarGz(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name);
    if (nameBytes > 99) {
      chunks.push(header(LONGNAME, nameBytes + 1, "L", entry.mtime ?? Date.now()));
      chunks.push(pad(Buffer.concat([Buffer.from(entry.name, "utf8"), Buffer.alloc(1)])));
    }
    if (entry.buf === undefined) {
      chunks.push(header(entry.name.endsWith("/") ? entry.name : `${entry.name}/`, 0, "5", entry.mtime ?? Date.now()));
    } else {
      chunks.push(header(entry.name, entry.buf.length, "0", entry.mtime ?? Date.now()));
      chunks.push(pad(entry.buf));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function readOctal(buf: Buffer, off: number, width: number): number {
  const s = buf.subarray(off, off + width).toString("ascii").replace(/\0.*$/s, "").trim();
  return s === "" ? 0 : parseInt(s, 8);
}

/** Refuse traversal/absolute members at PARSE time (verify + restore share it). */
export function readTarGz(blob: Buffer): { name: string; buf?: Buffer; mtime: number }[] {
  const raw = gunzipSync(blob);
  const out: { name: string; buf?: Buffer; mtime: number }[] = [];
  let off = 0;
  let longname: string | null = null;
  while (off + BLOCK <= raw.length) {
    const block = raw.subarray(off, off + BLOCK);
    if (block.every((b) => b === 0)) break; // end marker
    const size = readOctal(block, 124, 12);
    const mtime = readOctal(block, 136, 12) * 1000;
    const type = String.fromCharCode(block[156]!);
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    off += BLOCK;
    const content = raw.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") {
      longname = content.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const finalName = longname ?? name;
    longname = null;
    if (!finalName || finalName.startsWith("/") || /^[A-Za-z]:/.test(finalName) || finalName.split("/").includes("..")) {
      throw new Error(`unsafe archive member: ${finalName || "(empty)"}`);
    }
    if (type === "0") out.push({ name: finalName, buf: Buffer.from(content), mtime });
    else if (type === "5") out.push({ name: finalName.replace(/\/$/, ""), mtime });
    else if (type === "x" || type === "g" || type === "X" || type === "G") continue; // pax metadata — ignore
    else if (type === "2" || type === "1") throw new Error(`unsupported archive member type (link): ${finalName}`);
    // other types: ignore silently (their "other files remain opaque" spirit)
  }
  return out;
}
