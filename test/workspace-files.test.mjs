import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const moduleDir = mkdtempSync(join(tmpdir(), "sc-workspace-files-test-"));
await build({ entryPoints: [join(process.cwd(), "src/agent/workspace-files.ts")], bundle: true, format: "esm", platform: "node", outfile: join(moduleDir, "workspace-files.mjs") });
const { listWorkspace, previewWorkspaceFile, searchWorkspace, workspaceFileOnDisk } = await import(pathToFileURL(join(moduleDir, "workspace-files.mjs")).href);
test.after(() => rmSync(moduleDir, { recursive: true, force: true }));
let root; let outside;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suparclaw-workspace-")); outside = mkdtempSync(join(tmpdir(), "suparclaw-outside-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, ".git")); mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "README.md"), "# Workspace\nHello from a session.\n");
  writeFileSync(join(root, "src", "worker.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, ".git", "config"), "hidden"); writeFileSync(join(root, "node_modules", "package.json"), "{}");
  writeFileSync(join(outside, "secret.txt"), "outside"); symlinkSync(join(outside, "secret.txt"), join(root, "outside-link.txt"));
});
test.afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
test("lists ordinary workspace files but omits system directories and symlinks", () => {
  assert.deepEqual(listWorkspace(root).entries.map((x) => x.name), ["src", "README.md"]);
  assert.equal(listWorkspace(root, "src").entries[0].path, "src/worker.ts");
});
test("search returns relative files and skips .git, node_modules and symlinks", () => {
  assert.deepEqual(searchWorkspace(root, "worker").map((x) => x.path), ["src/worker.ts"]);
  assert.deepEqual(searchWorkspace(root, "secret"), []);
});
test("previews text and only marks safe image formats inline", () => {
  assert.match(previewWorkspaceFile(root, "README.md").text, /Hello from a session/);
  writeFileSync(join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(previewWorkspaceFile(root, "photo.png").kind, "image");
  assert.equal(workspaceFileOnDisk(root, "photo.png").inline, true);
  assert.equal(workspaceFileOnDisk(root, "README.md").inline, false);
});
test("rejects traversal, absolute paths, .git internals and symlinks", () => {
  for (const path of ["../secret.txt", "/etc/passwd", ".git/config", "src/../../README.md", "outside-link.txt"]) {
    assert.throws(() => previewWorkspaceFile(root, path));
    assert.throws(() => workspaceFileOnDisk(root, path));
  }
});
