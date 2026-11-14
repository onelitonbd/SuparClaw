import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: number;
}
export interface WorkspaceListing { path: string; entries: WorkspaceEntry[] }
export interface WorkspaceSearchResult { path: string; name: string; size: number; modifiedAt: number }
export interface WorkspacePreview {
  path: string; name: string; size: number; modifiedAt: number; mime: string;
  kind: "text" | "image" | "download"; text?: string; truncated?: boolean;
}

const HIDDEN_DIRS = new Set([".git", "node_modules"]);
const MAX_SEARCH_VISITS = 12_000;
const MAX_SEARCH_DEPTH = 12;
const MAX_SEARCH_RESULTS = 60;
const MAX_PREVIEW_BYTES = 384 * 1024;
const TEXT_NAMES = new Set([".env", ".gitignore", ".gitattributes", ".editorconfig", ".dockerignore", ".npmrc", ".nvmrc", "dockerfile", "makefile"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".mdx", ".rst", ".adoc", ".log", ".csv", ".tsv",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".conf", ".env",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".html", ".htm", ".css", ".scss", ".less",
  ".xml", ".svg", ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sql", ".graphql", ".proto", ".lock",
]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8", ".html": "text/plain; charset=utf-8",
  ".htm": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8",
};

function segmentsFor(raw: string): string[] {
  if (typeof raw !== "string" || raw.length > 2048 || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    throw new Error("invalid workspace path");
  }
  const trimmed = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (!trimmed || trimmed === ".") return [];
  const segments = trimmed.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) throw new Error("invalid workspace path");
  if (segments.some((part) => HIDDEN_DIRS.has(part))) throw new Error("this workspace path is not available");
  return segments;
}

function resolveWorkspacePath(workspace: string, raw: string): { root: string; full: string; path: string } {
  const root = realpathSync(workspace);
  const segments = segmentsFor(raw);
  let full = root;
  for (const segment of segments) {
    full = join(full, segment);
    if (lstatSync(full).isSymbolicLink()) throw new Error("symbolic links are not available in the workspace browser");
  }
  const actual = realpathSync(full);
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("workspace path is outside the active workspace");
  return { root, full: actual, path: segments.join("/") };
}

function toEntry(parent: string, name: string, full: string): WorkspaceEntry | null {
  if (HIDDEN_DIRS.has(name)) return null;
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) return null;
    return { name, path: parent ? `${parent}/${name}` : name, kind: st.isDirectory() ? "directory" : "file", size: st.isFile() ? st.size : 0, modifiedAt: st.mtimeMs };
  } catch { return null; }
}

export function listWorkspace(workspace: string, rawPath = ""): WorkspaceListing {
  const resolved = resolveWorkspacePath(workspace, rawPath);
  if (!statSync(resolved.full).isDirectory()) throw new Error("this workspace path is not a folder");
  const entries = readdirSync(resolved.full, { withFileTypes: true })
    .map((dirent) => toEntry(resolved.path, dirent.name, join(resolved.full, dirent.name)))
    .filter((entry): entry is WorkspaceEntry => entry !== null)
    .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
  return { path: resolved.path, entries };
}

export function searchWorkspace(workspace: string, rawQuery: string): WorkspaceSearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase().slice(0, 160);
  if (!query) return [];
  const root = realpathSync(workspace);
  const results: WorkspaceSearchResult[] = [];
  const stack: { full: string; rel: string; depth: number }[] = [{ full: root, rel: "", depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SEARCH_VISITS && results.length < MAX_SEARCH_RESULTS) {
    const current = stack.pop()!;
    let children;
    try { children = readdirSync(current.full, { withFileTypes: true }); } catch { continue; }
    for (const item of children) {
      if (++visited >= MAX_SEARCH_VISITS) break;
      if (HIDDEN_DIRS.has(item.name) || item.isSymbolicLink()) continue;
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name;
      const full = join(current.full, item.name);
      if (item.isDirectory()) {
        if (current.depth < MAX_SEARCH_DEPTH) stack.push({ full, rel, depth: current.depth + 1 });
      } else if (item.isFile() && rel.toLocaleLowerCase().includes(query)) {
        try {
          const st = lstatSync(full);
          if (!st.isSymbolicLink()) results.push({ path: rel, name: item.name, size: st.size, modifiedAt: st.mtimeMs });
        } catch { /* file may disappear during search */ }
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export function previewWorkspaceFile(workspace: string, rawPath: string): WorkspacePreview {
  const resolved = resolveWorkspacePath(workspace, rawPath);
  const st = statSync(resolved.full);
  if (!st.isFile()) throw new Error("this workspace path is not a file");
  const name = resolved.full.split(/[\\/]/).pop() ?? "file";
  const ext = extname(name).toLowerCase();
  if (IMAGE_MIME[ext]) return { path: resolved.path, name, size: st.size, modifiedAt: st.mtimeMs, mime: IMAGE_MIME[ext]!, kind: "image" };
  if ((!TEXT_EXTENSIONS.has(ext) && !TEXT_NAMES.has(name.toLowerCase())) || st.size > MAX_PREVIEW_BYTES) {
    return { path: resolved.path, name, size: st.size, modifiedAt: st.mtimeMs, mime: "application/octet-stream", kind: "download" };
  }
  const bytes = readFileSync(resolved.full);
  if (bytes.includes(0)) return { path: resolved.path, name, size: st.size, modifiedAt: st.mtimeMs, mime: "application/octet-stream", kind: "download" };
  return { path: resolved.path, name, size: st.size, modifiedAt: st.mtimeMs,
    mime: TEXT_MIME[ext] ?? "text/plain; charset=utf-8", kind: "text", text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated: false };
}

export function workspaceFileOnDisk(workspace: string, rawPath: string): { full: string; name: string; size: number; mime: string; inline: boolean } {
  const resolved = resolveWorkspacePath(workspace, rawPath);
  const st = statSync(resolved.full);
  if (!st.isFile()) throw new Error("this workspace path is not a file");
  const name = resolved.full.split(/[\\/]/).pop() ?? "file";
  const ext = extname(name).toLowerCase();
  return { full: resolved.full, name, size: st.size, mime: IMAGE_MIME[ext] ?? TEXT_MIME[ext] ?? "application/octet-stream", inline: Boolean(IMAGE_MIME[ext]) };
}
