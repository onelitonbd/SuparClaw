// Native Gmail add-on: OAuth/PKCE, Gmail REST semantics, side-effect intent gates,
// and parity across the seven grouped model-facing tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  GmailApi,
  GmailApiError,
  GmailAddonService,
  VaultManager,
  GMAIL_API,
  GMAIL_SCOPES,
  GOOGLE_ACCOUNT_SCOPES,
  beginGmailOAuth,
  refreshGmailAccessToken,
  buildRegistry,
  emptyConfig,
  gmailDraftDeleteRequested,
  gmailMutationRequested,
  gmailSendRequested,
} = await import("../dist/lib.js");

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});
const textPart = (text) => Buffer.from(text, "utf8").toString("base64url");

const oauthFetch = (seen, scopes = GMAIL_SCOPES) => async (input, init = {}) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(init.body);
    seen.tokenForm = form;
    return json({
      access_token: "access-secret-for-test",
      refresh_token: "refresh-secret-for-test",
      expires_in: 3600,
      scope: scopes.join(" "),
      token_type: "Bearer",
    });
  }
  if (url === `${GMAIL_API}/profile`) {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer access-secret-for-test");
    return json({ emailAddress: "owner@example.com", messagesTotal: 8, threadsTotal: 5, historyId: "h1" });
  }
  throw new Error(`unexpected fetch ${url}`);
};

test("OAuth uses desktop PKCE loopback, checks state, grants all Gmail scopes, and never returns tokens in callback HTML", async () => {
  const seen = {};
  const flow = await beginGmailOAuth({ clientId: "desktop-client-id.apps.googleusercontent.com", clientSecret: "desktop-client-secret", fetchFn: oauthFetch(seen), timeoutMs: 20_000 });
  const authorization = new URL(flow.authUrl);
  assert.equal(authorization.origin, "https://accounts.google.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), flow.redirectUri);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("prompt"), "consent");
  assert.equal(authorization.searchParams.get("include_granted_scopes"), null, "installed-app OAuth sends the complete scope set, not an incremental grant");
  assert.deepEqual(authorization.searchParams.get("scope").split(" "), [...GMAIL_SCOPES]);

  const callback = new URL(flow.redirectUri);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("code", "one-time-authorization-code");
  const response = await fetch(callback);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Google account connected/);
  assert.match(html, /owner@example\.com/);
  assert.doesNotMatch(html, /access-secret-for-test|refresh-secret-for-test|one-time-authorization-code/);

  const result = await flow.done;
  assert.equal(result.email, "owner@example.com");
  assert.deepEqual(result.tokens.scopes, [...GMAIL_SCOPES]);
  assert.equal(result.tokens.refreshToken, "refresh-secret-for-test");
  const verifier = seen.tokenForm.get("code_verifier");
  assert.ok(verifier);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), authorization.searchParams.get("code_challenge"));
  assert.equal(seen.tokenForm.get("redirect_uri"), flow.redirectUri);
  assert.equal(seen.tokenForm.get("grant_type"), "authorization_code");
  assert.equal(seen.tokenForm.get("client_secret"), "desktop-client-secret");
  await flow.cancel();
});

test("OAuth includes the optional client secret and surfaces Google's sanitized token error detail", async () => {
  let seenForm;
  const flow = await beginGmailOAuth({
    clientId: "desktop-client-id",
    clientSecret: "desktop-client-secret",
    timeoutMs: 20_000,
    fetchFn: async (_input, init = {}) => {
      seenForm = new URLSearchParams(init.body);
      return json({ error: "invalid_request", error_description: "client_secret is missing." }, 400);
    },
  });
  const result = flow.done.catch((error) => error);
  const authorization = new URL(flow.authUrl);
  const callback = new URL(flow.redirectUri);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("code", "one-time-code");
  const response = await fetch(callback);
  const html = await response.text();
  const error = await result;
  assert.equal(seenForm.get("client_secret"), "desktop-client-secret");
  assert.match(html, /invalid_request: client_secret is missing/);
  assert.match(html, /Add the Desktop OAuth client secret in Google integration settings/);
  assert.match(error.message, /client_secret is missing/);
  assert.doesNotMatch(html, /one-time-code|desktop-client-secret/);
});

test("refresh sends the optional client secret and preserves safe Google error details", async () => {
  let form;
  await refreshGmailAccessToken({
    clientId: "desktop-client-id",
    clientSecret: "desktop-client-secret",
    refreshToken: "refresh-token",
    fetchFn: async (_input, init = {}) => {
      form = new URLSearchParams(init.body);
      return json({ access_token: "access-token", expires_in: 3600, scope: GMAIL_SCOPES.join(" ") });
    },
  });
  assert.equal(form.get("client_secret"), "desktop-client-secret");
  assert.equal(form.get("refresh_token"), "refresh-token");

  await assert.rejects(refreshGmailAccessToken({
    clientId: "desktop-client-id",
    clientSecret: "desktop-client-secret",
    refreshToken: "refresh-token",
    fetchFn: async () => json({ error: "invalid_request", error_description: "client_secret is missing." }, 400),
  }), /invalid_request: client_secret is missing/);
});

test("OAuth rejects a mismatched state and can be cancelled cleanly", async () => {
  const flow = await beginGmailOAuth({ clientId: "desktop-client-id", fetchFn: async () => { throw new Error("must not exchange an invalid state"); }, timeoutMs: 20_000 });
  const authorization = new URL(flow.authUrl);
  const callback = new URL(flow.redirectUri);
  callback.searchParams.set("state", "wrong-state");
  callback.searchParams.set("code", "ignored");
  const response = await fetch(callback);
  assert.equal(response.status, 400);
  await flow.cancel();
  await assert.rejects(flow.done, /cancelled/);
});

test("OAuth refuses a consent response that omitted requested scopes or offline refresh access", async () => {
  const noScopes = await beginGmailOAuth({
    clientId: "desktop-client-id",
    timeoutMs: 20_000,
    fetchFn: async (input) => String(input) === "https://oauth2.googleapis.com/token"
      ? json({ access_token: "access", refresh_token: "refresh", expires_in: 300, scope: GMAIL_SCOPES[0] })
      : json({}),
  });
  const noScopesDone = noScopes.done.catch((error) => error);
  const auth1 = new URL(noScopes.authUrl);
  const callback1 = new URL(noScopes.redirectUri);
  callback1.searchParams.set("state", auth1.searchParams.get("state"));
  callback1.searchParams.set("code", "code");
  assert.equal((await fetch(callback1)).status, 400);
  assert.match((await noScopesDone).message, /did not grant all requested Gmail\/Workspace scopes/);

  const noRefresh = await beginGmailOAuth({
    clientId: "desktop-client-id",
    timeoutMs: 20_000,
    fetchFn: async (input) => String(input) === "https://oauth2.googleapis.com/token"
      ? json({ access_token: "access", expires_in: 300, scope: GMAIL_SCOPES.join(" ") })
      : json({}),
  });
  const noRefreshDone = noRefresh.done.catch((error) => error);
  const auth2 = new URL(noRefresh.authUrl);
  const callback2 = new URL(noRefresh.redirectUri);
  callback2.searchParams.set("state", auth2.searchParams.get("state"));
  callback2.searchParams.set("code", "code");
  assert.equal((await fetch(callback2)).status, 400);
  assert.match((await noRefreshDone).message, /did not return a refresh token/);
});

test("Gmail service reads the OAuth client secret from the encrypted vault for connect", async () => {
  const previousHome = process.env.SUPARCLAW_HOME;
  const home = mkdtempSync(join(tmpdir(), "sc-gmail-oauth-secret-"));
  process.env.SUPARCLAW_HOME = home;
  const vault = new VaultManager();
  let service;
  try {
    assert.equal((await vault.initialize("gmail oauth secret test passphrase")).ok, true);
    assert.equal(vault.define({ name: "SUPARCLAW_GMAIL_OAUTH_CLIENT_SECRET", kind: "secret", description: "OAuth client secret for Gmail" }).ok, true);
    assert.equal((await vault.setValue("SUPARCLAW_GMAIL_OAUTH_CLIENT_SECRET", "desktop-client-secret-never-plaintext")).ok, true);
    const seen = {};
    service = new GmailAddonService(vault, () => "desktop-client-id", () => true, oauthFetch(seen, GOOGLE_ACCOUNT_SCOPES));
    assert.equal(service.status().clientSecretConfigured, true);
    const started = await service.startConnect();
    const completion = service.waitConnect(started.flow);
    const authorization = new URL(started.authUrl);
    assert.deepEqual(authorization.searchParams.get("scope").split(" "), [...GOOGLE_ACCOUNT_SCOPES]);
    const callback = new URL(started.redirectUri);
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    callback.searchParams.set("code", "one-time-code");
    assert.match(await (await fetch(callback)).text(), /Google account connected/);
    assert.deepEqual(await completion, { email: "owner@example.com", scopes: [...GOOGLE_ACCOUNT_SCOPES] });
    assert.equal(seen.tokenForm.get("client_secret"), "desktop-client-secret-never-plaintext");
    const vaultFile = readFileSync(join(home, ".suparclaw", "vault.json"), "utf8");
    assert.equal(vaultFile.includes("desktop-client-secret-never-plaintext"), false);
    assert.equal(vaultFile.includes("refresh-secret-for-test"), false);
    assert.equal(service.status().connected, true);
    await service.disconnect();
    assert.equal(service.status().clientSecretConfigured, true, "disconnect keeps OAuth client configuration in the vault");
  } finally {
    await service?.close();
    vault.close();
    if (previousHome === undefined) delete process.env.SUPARCLAW_HOME;
    else process.env.SUPARCLAW_HOME = previousHome;
  }
});

test("Gmail service keeps refresh tokens encrypted in the vault and clears metadata on disconnect", async () => {
  const previousHome = process.env.SUPARCLAW_HOME;
  const home = mkdtempSync(join(tmpdir(), "sc-gmail-vault-"));
  process.env.SUPARCLAW_HOME = home;
  const vault = new VaultManager();
  try {
    assert.equal((await vault.initialize("gmail test passphrase long enough")).ok, true);
    assert.equal(vault.define({ name: "SUPARCLAW_GMAIL_REFRESH_TOKEN", kind: "secret", description: "test Gmail credential" }).ok, true);
    assert.equal((await vault.setValue("SUPARCLAW_GMAIL_REFRESH_TOKEN", "refresh-token-never-plaintext")).ok, true);
    const state = join(home, ".suparclaw");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "gmail-account.json"), JSON.stringify({ version: 1, email: "owner@example.com", scopes: [...GMAIL_SCOPES], connectedAt: "2026-10-28T00:00:00.000Z" }), { mode: 0o600 });
    const service = new GmailAddonService(vault, () => "desktop-client-id", () => true);
    const ready = service.status();
    assert.equal(ready.connected, true);
    assert.equal(ready.usable, true);
    assert.equal(ready.account, "owner@example.com");
    assert.equal(ready.vaultUnlocked, true);
    assert.equal(readFileSync(join(state, "vault.json"), "utf8").includes("refresh-token-never-plaintext"), false);

    vault.lock();
    assert.equal(service.status().usable, false);
    assert.match(service.status().error, /unlock the encrypted vault/);
    await assert.rejects(service.disconnect(), /unlock the encrypted vault/);
    assert.equal((await vault.unlock("gmail test passphrase long enough")).ok, true);
    assert.equal(await service.disconnect(), true);
    assert.equal(service.status().connected, false);
    assert.equal(existsSync(join(state, "gmail-account.json")), false);
    assert.equal(vault.list().some((entry) => entry.name === "SUPARCLAW_GMAIL_REFRESH_TOKEN"), false);
    await service.close();
  } finally {
    vault.close();
    if (previousHome === undefined) delete process.env.SUPARCLAW_HOME;
    else process.env.SUPARCLAW_HOME = previousHome;
  }
});

test("Gmail API refreshes once after HTTP 401, but never retries an ambiguous network send", async () => {
  const calls = [];
  let refreshed = 0;
  const api = new GmailApi("expired-access", {
    refreshAccessToken: async () => { refreshed++; return "fresh-access"; },
    fetchFn: async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init.headers).get("authorization") });
      return calls.length === 1 ? json({ error: { message: "expired" } }, 401) : json({ emailAddress: "owner@example.com" });
    },
  });
  assert.equal((await api.getProfile()).emailAddress, "owner@example.com");
  assert.equal(refreshed, 1);
  assert.deepEqual(calls.map((x) => x.authorization), ["Bearer expired-access", "Bearer fresh-access"]);

  let attempts = 0;
  const uncertain = new GmailApi("token", { fetchFn: async () => { attempts++; throw new Error("socket closed after request write"); } });
  await assert.rejects(uncertain.sendMessage({ to: ["a@example.com"], subject: "Hi", body: "Hello" }), (error) => error instanceof GmailApiError && error.status === 0);
  assert.equal(attempts, 1, "send is never automatically retried after an ambiguous network failure");
});

test("draft patch preserves omitted recipients, message body, thread, and attachments; incomplete drafts remain valid", async () => {
  const requests = [];
  const attachment = Buffer.from("old attachment");
  const api = new GmailApi("test-token", { fetchFn: async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname + url.search, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (url.pathname.endsWith("/drafts/d1") && init.method === "PUT") return json({ id: "d1" });
    if (url.pathname.endsWith("/drafts/d1")) return json({ id: "d1", message: { id: "m1", threadId: "t1" } });
    if (url.pathname.endsWith("/messages/m1")) return json({
      id: "m1", threadId: "t1", labelIds: ["DRAFT"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "To", value: "Alice Example <alice@example.com>, Bob <bob@example.com>" },
          { name: "Subject", value: "Old subject" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: textPart("old body") } },
          { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "att-1", size: attachment.length } },
        ],
      },
    });
    if (url.pathname.endsWith("/attachments/att-1")) return json({ data: attachment.toString("base64url"), size: attachment.length });
    if (url.pathname.endsWith("/drafts/d1") && init.method === "PUT") return json({ id: "d1" });
    if (url.pathname.endsWith("/drafts") && init.method === "POST") return json({ id: "incomplete" });
    throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}${url.search}`);
  } });
  await api.updateDraftPartial("d1", { subject: "Updated subject" });
  const update = requests.find((x) => x.method === "PUT");
  assert.ok(update);
  const raw = Buffer.from(update.body.message.raw, "base64url").toString("utf8");
  assert.match(raw, /To: Alice Example <alice@example\.com>, Bob <bob@example\.com>/);
  assert.match(raw, /Subject: Updated subject/);
  assert.match(raw, /old body/);
  assert.match(raw, /filename="notes\.txt"/);
  assert.ok(raw.includes(attachment.toString("base64")));
  assert.equal(update.body.message.threadId, "t1");

  await api.createDraft({ to: [], subject: "Incomplete", body: "I will finish this later" });
  assert.throws(() => api.sendMessage({ to: [], subject: "No recipient", body: "" }), /at least one recipient/);
});

test("Gmail label updates use the API's PUT method and draft CRUD paths/verbs are correct", async () => {
  const calls = [];
  const api = new GmailApi("test-token", { fetchFn: async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), method: init.method ?? "GET" });
    return json({ id: "ok" });
  } });
  await api.createLabel({ name: "Receipts" });
  await api.updateLabel("Label_1", { name: "Receipts 2026" });
  await api.deleteLabel("Label_1");
  await api.createDraft({ to: [], subject: "Incomplete", body: "Draft" });
  await api.updateDraft("draft-1", { to: ["a@example.com"], subject: "Updated", body: "Body" });
  await api.deleteDraft("draft-1");
  const basePath = new URL(GMAIL_API).pathname;
  assert.deepEqual(calls.map(({ url, method }) => [url.pathname.replace(basePath, ""), method]), [
    ["/labels", "POST"], ["/labels/Label_1", "PUT"], ["/labels/Label_1", "DELETE"],
    ["/drafts", "POST"], ["/drafts/draft-1", "PUT"], ["/drafts/draft-1", "DELETE"],
  ]);
});

test("mailbox mutation gates require current-turn mailbox intent and reject negated actions", () => {
  assert.equal(gmailSendRequested("Please send this email to Ana"), true);
  assert.equal(gmailSendRequested("Send draft d-123"), true);
  assert.equal(gmailSendRequested("Send me a map link"), false);
  assert.equal(gmailSendRequested("Do not send the email yet"), false);
  assert.equal(gmailMutationRequested("Archive this thread"), true);
  assert.equal(gmailMutationRequested("Create a label called Receipts"), true);
  assert.equal(gmailMutationRequested("Delete the temporary file"), false);
  assert.equal(gmailMutationRequested("Do not trash that email"), false);
  assert.equal(gmailDraftDeleteRequested("Permanently delete draft d-1"), true);
  assert.equal(gmailDraftDeleteRequested("Do not delete the draft"), false);
});

function fakeGmailApi(calls) {
  const result = (name, value = {}) => async (...args) => { calls.push([name, ...args]); return value; };
  return {
    getProfile: result("getProfile", { emailAddress: "owner@example.com", messagesTotal: 2, threadsTotal: 1 }),
    listSendAsAddresses: result("listSendAsAddresses", [{ sendAsEmail: "alias@example.com" }]),
    listMessages: result("listMessages", { messages: [], resultSizeEstimate: 0 }),
    listThreads: result("listThreads", { threads: [], resultSizeEstimate: 0 }),
    getMessageText: result("getMessageText", { id: "m1", threadId: "t1", headers: {}, labels: [], snippet: "", text: "hello", attachments: [{ attachmentId: "a1", filename: "note.txt", mimeType: "text/plain", size: 10 }] }),
    getMessage: result("getMessage", { id: "m1", raw: "c2VjcmV0" }),
    getAttachment: result("getAttachment", { data: Buffer.from("attachment text").toString("base64url"), size: 15 }),
    getThread: result("getThread", { id: "t1", messages: [] }),
    listDrafts: result("listDrafts", { drafts: [], resultSizeEstimate: 0 }),
    getDraft: result("getDraft", { id: "d1", message: { id: "m1", threadId: "t1" } }),
    createDraft: result("createDraft", { id: "d2" }),
    updateDraftPartial: result("updateDraftPartial", { id: "d1" }),
    deleteDraft: result("deleteDraft"),
    sendDraft: result("sendDraft", { id: "m2", threadId: "t2" }),
    sendMessage: result("sendMessage", { id: "m3", threadId: "t3" }),
    listLabels: result("listLabels", []),
    getLabel: result("getLabel", { id: "Label_1", name: "Receipts" }),
    createLabel: result("createLabel", { id: "Label_2", name: "New" }),
    updateLabel: result("updateLabel", { id: "Label_1", name: "Updated" }),
    deleteLabel: result("deleteLabel"),
    modifyMessageLabels: result("modifyMessageLabels", { id: "m1" }),
    batchModifyMessages: result("batchModifyMessages", {}),
    modifyThreadLabels: result("modifyThreadLabels", { id: "t1" }),
    trashMessage: result("trashMessage"),
    untrashMessage: result("untrashMessage"),
    trashThread: result("trashThread"),
    untrashThread: result("untrashThread"),
    batchTrashMessages: result("batchTrashMessages"),
  };
}

test("seven grouped Gmail tools cover the complete account/search/read/draft/send/label/trash surface", async () => {
  const config = emptyConfig();
  config.addons.gmail.enabled = true;
  const allTools = buildRegistry(config);
  const expectedNames = ["gmail_account", "gmail_search", "gmail_read", "gmail_drafts", "gmail_send", "gmail_labels", "gmail_trash"];
  const gmailTools = allTools.filter((tool) => tool.name.startsWith("gmail_"));
  assert.deepEqual(gmailTools.map((tool) => tool.name), expectedNames);
  const byName = Object.fromEntries(gmailTools.map((tool) => [tool.name, tool]));
  const calls = [];
  const api = fakeGmailApi(calls);
  const ctx = {
    config,
    workspace: mkdtempSync(join(tmpdir(), "sc-gmail-tools-")),
    gmailCtl: { api: async () => api },
    gmailSendAllowed: true,
    gmailMutateAllowed: true,
    gmailDeleteDraftAllowed: true,
  };
  const invoke = async (tool, args) => byName[tool].run(args, ctx);

  await invoke("gmail_account", { action: "profile" });
  await invoke("gmail_account", { action: "aliases" });
  await invoke("gmail_account", { action: "validate" });
  await invoke("gmail_search", { kind: "messages", query: "is:unread" });
  await invoke("gmail_search", { kind: "threads", query: "from:ana@example.com" });
  await invoke("gmail_read", { action: "message", id: "m1" });
  await invoke("gmail_read", { action: "thread", id: "t1" });
  await invoke("gmail_read", { action: "mime", id: "m1" });
  await invoke("gmail_read", { action: "mime", id: "m1", format: "raw" });
  assert.match(await invoke("gmail_read", { action: "attachment", id: "m1", attachmentId: "a1" }), /attachment text/);
  await invoke("gmail_drafts", { action: "list" });
  await invoke("gmail_drafts", { action: "get", id: "d1" });
  await invoke("gmail_drafts", { action: "create", to: ["a@example.com"], subject: "Hi", body: "Draft" });
  await invoke("gmail_drafts", { action: "update", id: "d1", subject: "Updated" });
  assert.match(await invoke("gmail_drafts", { action: "delete", id: "d1", confirm: "d1" }), /permanently deleted/);
  await invoke("gmail_send", { action: "send_draft", draftId: "d1" });
  await invoke("gmail_send", { action: "send", to: ["a@example.com"], subject: "Hi", body: "Sent" });
  await invoke("gmail_labels", { action: "list" });
  await invoke("gmail_labels", { action: "get", id: "Label_1" });
  await invoke("gmail_labels", { action: "create", name: "Receipts" });
  await invoke("gmail_labels", { action: "update", id: "Label_1", name: "Receipts 2026" });
  await invoke("gmail_labels", { action: "delete", id: "Label_1", confirm: "Label_1" });
  await invoke("gmail_labels", { action: "message", id: "m1", add: ["STARRED"] });
  await invoke("gmail_labels", { action: "thread", id: "t1", remove: ["UNREAD"] });
  await invoke("gmail_labels", { action: "batch", ids: ["m1", "m2"], add: ["Label_1"] });
  await invoke("gmail_trash", { action: "message", id: "m1", confirm: "m1" });
  await invoke("gmail_trash", { action: "untrash_message", id: "m1" });
  await invoke("gmail_trash", { action: "thread", id: "t1", confirm: "t1" });
  await invoke("gmail_trash", { action: "untrash_thread", id: "t1" });
  await invoke("gmail_trash", { action: "batch", ids: ["m1", "m2"], confirm: "m1,m2" });

  const called = new Set(calls.map(([name]) => name));
  for (const name of [
    "getProfile", "listSendAsAddresses", "listMessages", "listThreads", "getMessageText", "getMessage", "getAttachment", "getThread",
    "listDrafts", "getDraft", "createDraft", "updateDraftPartial", "deleteDraft", "sendDraft", "sendMessage",
    "listLabels", "getLabel", "createLabel", "updateLabel", "deleteLabel", "modifyMessageLabels", "batchModifyMessages", "modifyThreadLabels",
    "trashMessage", "untrashMessage", "trashThread", "untrashThread", "batchTrashMessages",
  ]) assert.ok(called.has(name), `missing Gmail operation ${name}`);
});

test("Gmail attachments cannot escape the session workspace through a symlink", async () => {
  const config = emptyConfig();
  config.addons.gmail.enabled = true;
  const byName = Object.fromEntries(buildRegistry(config).filter((tool) => tool.name.startsWith("gmail_")).map((tool) => [tool.name, tool]));
  const workspace = mkdtempSync(join(tmpdir(), "sc-gmail-attachment-"));
  const outside = join(tmpdir(), `sc-gmail-outside-${process.pid}.txt`);
  writeFileSync(outside, "private outside-workspace data");
  symlinkSync(outside, join(workspace, "outside.txt"));
  const calls = [];
  const ctx = { config, workspace, gmailCtl: { api: async () => fakeGmailApi(calls) }, gmailSendAllowed: true };
  const result = await byName.gmail_send.run({ action: "send", to: ["a@example.com"], subject: "Hi", body: "See attached", attachments: [{ path: "outside.txt" }] }, ctx);
  assert.match(result, /attachment path escapes workspace through a symlink/);
  assert.deepEqual(calls, []);
});

test("Gmail send, trash, and draft delete tools refuse without current-turn intent or exact confirmation", async () => {
  const config = emptyConfig();
  config.addons.gmail.enabled = true;
  const byName = Object.fromEntries(buildRegistry(config).filter((tool) => tool.name.startsWith("gmail_")).map((tool) => [tool.name, tool]));
  const calls = [];
  const ctx = { config, workspace: process.cwd(), gmailCtl: { api: async () => fakeGmailApi(calls) } };
  assert.match(await byName.gmail_send.run({ action: "send", to: ["a@example.com"], subject: "Hi", body: "Hello" }, ctx), /explicit send request/);
  assert.match(await byName.gmail_trash.run({ action: "message", id: "m1", confirm: "m1" }, ctx), /explicit mailbox-management request/);
  assert.match(await byName.gmail_drafts.run({ action: "delete", id: "d1", confirm: "d1" }, ctx), /explicit delete request/);
  assert.deepEqual(calls, []);

  const allowed = { ...ctx, gmailMutateAllowed: true };
  assert.match(await byName.gmail_trash.run({ action: "message", id: "m1", confirm: "wrong" }, allowed), /repeat confirm/);
  assert.deepEqual(calls, []);

  const uncertain = { ...ctx, gmailSendAllowed: true, gmailCtl: { api: async () => ({
    ...fakeGmailApi(calls),
    async sendMessage() { calls.push(["sendMessage-uncertain"]); throw new GmailApiError("socket closed after request write", 0); },
  }) } };
  const delivery = await byName.gmail_send.run({ action: "send", to: ["a@example.com"], subject: "Hi", body: "Hello" }, uncertain);
  assert.match(delivery, /delivery outcome is unknown.*Sent folder.*do not resend blindly/);
  assert.deepEqual(calls, [["sendMessage-uncertain"]]);
});
