// Full Google Workspace OAuth scope union, REST transport, and side-effect guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  GoogleWorkspaceApi,
  GOOGLE_ACCOUNT_SCOPES,
  GMAIL_SCOPES,
  GOOGLE_WORKSPACE_SCOPES,
  buildRegistry,
  emptyConfig,
  workspaceMutationRequested,
  workspaceDeleteRequested,
  workspaceShareRequested,
  workspacePublicShareRequested,
  workspaceInviteRequested,
} = await import("../dist/lib.js");

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

test("Google account scope union preserves Gmail and adds full Drive plus Calendar", () => {
  assert.deepEqual([...GOOGLE_ACCOUNT_SCOPES], [...GMAIL_SCOPES, ...GOOGLE_WORKSPACE_SCOPES]);
  assert.ok(GOOGLE_WORKSPACE_SCOPES.includes("https://www.googleapis.com/auth/drive"));
  assert.ok(!GOOGLE_WORKSPACE_SCOPES.includes("https://www.googleapis.com/auth/drive.file"));
});

test("Google Workspace REST client retries once with a refreshed token and constrains host/path", async () => {
  const seen = [];
  const api = new GoogleWorkspaceApi(async (force) => force ? "fresh-token" : "old-token", async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    if (seen.length === 1) return json({ error: { message: "expired" } }, 401);
    return json({ documentId: "doc-1", title: "Notes" });
  });
  const result = await api.request("docs", "documents/doc-1", {
    method: "POST",
    query: { fields: "documentId,title" },
    body: { requests: [{ insertText: { location: { index: 1 }, text: "Hi" } }] },
  });
  assert.deepEqual(result, { documentId: "doc-1", title: "Notes" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url.origin, "https://docs.googleapis.com");
  assert.equal(seen[1].url.searchParams.get("fields"), "documentId,title");
  assert.equal(new Headers(seen[0].init.headers).get("authorization"), "Bearer old-token");
  assert.equal(new Headers(seen[1].init.headers).get("authorization"), "Bearer fresh-token");
  assert.match(seen[1].init.body, /insertText/);
  await assert.rejects(api.request("docs", "../../attacker.example/path"), /relative API path/);
  await assert.rejects(api.request("drive", "files/%2e%2e%2fattacker"), /relative API path/);
});

test("Workspace intent classifiers distinguish mutations, deletion, sharing, public sharing, and invitations", () => {
  assert.equal(workspaceMutationRequested("Update the spreadsheet cells"), true);
  assert.equal(workspaceMutationRequested("Do not delete or change anything yet"), false);
  assert.equal(workspaceDeleteRequested("Delete the old calendar event"), true);
  assert.equal(workspaceDeleteRequested("Trash this Drive file"), true);
  assert.equal(workspaceDeleteRequested("Do not delete the old event"), false);
  assert.equal(workspaceShareRequested("Share the document with my team"), true);
  assert.equal(workspacePublicShareRequested("Share this document publicly via a link"), true);
  assert.equal(workspacePublicShareRequested("Transfer ownership of the Drive file"), true);
  assert.equal(workspaceInviteRequested("Invite Alex to the meeting"), true);
});

test("Workspace tools expose all four services and require current-turn intent plus exact sensitive confirmations", async () => {
  const config = emptyConfig();
  config.addons.googleWorkspace.enabled = true;
  const tools = Object.fromEntries(buildRegistry(config).filter((tool) => tool.name.startsWith("google_")).map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ["google_calendar", "google_docs", "google_drive", "google_sheets"]);
  const calls = [];
  const api = {
    async request(service, path, options = {}) { calls.push({ service, path, ...options }); return { service, path, ok: true }; },
    async uploadDriveContent(input) { calls.push({ upload: input }); return { id: "new-file" }; },
    async downloadDriveFile(id) { calls.push({ download: id }); return { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" }; },
  };
  const ctx = {
    config,
    workspace: mkdtempSync(join(tmpdir(), "sc-google-workspace-")),
    googleWorkspaceCtl: { api: async () => api },
  };
  const invoke = (name, args, extra = {}) => tools[name].run(args, { ...ctx, ...extra });

  assert.match(await invoke("google_docs", { path: "documents/doc-1:batchUpdate", method: "POST", body: { requests: [{ insertText: {} }] } }), /requires an explicit create\/edit\/update\/share request/);
  assert.equal(calls.length, 0);
  assert.match(await invoke("google_calendar", { path: "freeBusy", method: "POST", body: { timeMin: "2026-10-28T00:00:00Z", timeMax: "2026-10-29T00:00:00Z", items: [] } }), /"ok": true/);
  assert.equal(calls.at(-1).path, "freeBusy", "freeBusy POST is read-only and does not need a mutation gate");

  assert.match(await invoke("google_drive", { path: "files/file-1", method: "DELETE", confirm: "file-1" }, { googleWorkspaceMutationAllowed: true }), /explicit delete\/clear request/);
  assert.match(await invoke("google_drive", { path: "files/file-1", method: "DELETE", confirm: "wrong" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceDeleteAllowed: true }), /exact target or action/);
  assert.match(await invoke("google_drive", { path: "files/file-1", method: "DELETE", confirm: "file-1" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceDeleteAllowed: true }), /"ok": true/);
  assert.match(await invoke("google_drive", { action: "trash", fileId: "file-2" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceDeleteAllowed: true }), /exact file ID/);
  assert.match(await invoke("google_drive", { action: "trash", fileId: "file-2", confirm: "file-2" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceDeleteAllowed: true }), /"ok": true/);

  const anyone = { type: "anyone", role: "reader" };
  assert.match(await invoke("google_drive", { path: "files/file-1/permissions", method: "POST", body: anyone, confirm: "public sharing" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceShareAllowed: true }), /requires explicit user intent/);
  assert.match(await invoke("google_drive", { path: "files/file-1/permissions", method: "POST", body: anyone, confirm: "public sharing" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceShareAllowed: true, googleWorkspacePublicShareAllowed: true }), /"ok": true/);

  const event = { summary: "Planning", attendees: [{ email: "alex@example.com" }] };
  assert.match(await invoke("google_calendar", { path: "calendars/primary/events", method: "POST", body: event, confirm: "send invites" }, { googleWorkspaceMutationAllowed: true }), /Calendar invites require explicit invite/);
  assert.match(await invoke("google_calendar", { path: "calendars/primary/events", method: "POST", body: event, confirm: "send invites" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceInviteAllowed: true }), /"ok": true/);
  assert.match(await invoke("google_calendar", { path: "calendars/primary/events/event-4", method: "PATCH", body: { status: "cancelled" }, confirm: "wrong" }, { googleWorkspaceMutationAllowed: true, googleWorkspaceDeleteAllowed: true }), /exact target or action/);
  assert.match(await invoke("google_calendar", { path: "calendars/primary/events/watch", method: "POST", body: { id: "channel-1", type: "web_hook", address: "http://127.0.0.1:8080/watch" } }, { googleWorkspaceMutationAllowed: true }), /publicly reachable HTTPS callback/);
  assert.match(await invoke("google_drive", { action: "upload", name: "brief.txt", content: "hello" }), /explicit create\/upload request/);
  assert.equal(calls.filter((call) => call.upload).length, 0);
});

test("Drive download writes only a filename under workspace and does not overwrite existing files", async () => {
  const config = emptyConfig();
  config.addons.googleWorkspace.enabled = true;
  const tools = Object.fromEntries(buildRegistry(config).filter((tool) => tool.name.startsWith("google_")).map((tool) => [tool.name, tool]));
  const workspace = mkdtempSync(join(tmpdir(), "sc-google-download-"));
  const ctx = { config, workspace, googleWorkspaceCtl: { api: async () => ({ downloadDriveFile: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" }) }) } };
  assert.match(await tools.google_drive.run({ action: "download", fileId: "file-1", outputName: "../outside.txt" }, ctx), /outputName must be a filename/);
  assert.match(await tools.google_drive.run({ action: "download", fileId: "file-1", outputName: "file.bin" }, ctx), /Saved 3 bytes/);
  assert.match(await tools.google_drive.run({ action: "download", fileId: "file-1", outputName: "file.bin" }, ctx), /EEXIST|already exists/);
});
