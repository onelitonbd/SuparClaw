# Native Gmail add-on

SuparClaw's built-in Gmail integration exposes the 29 Gmail operations through seven shared agent tools. It works through the local Gateway, so the same account and tools are available in web chat, Telegram, and TUI.

## Personal Termux setup

1. In Google Cloud Console, create a project, enable the **Gmail API**, and configure the OAuth consent screen for an external app. The shared Google sign-in can also request Docs, Sheets, Calendar, and full Drive scopes; see [Google Workspace setup](google-workspace-addon.md).
2. Create an OAuth client with type **Desktop app**. Do not create a web, Android, or device-code client: Gmail scopes use the installed-app Authorization Code + PKCE flow and a temporary loopback callback.
3. For personal use, set the consent screen to **Production** and use only your own Google account. Google may display an “unverified app” warning; review the requested scopes before continuing. Production-but-unverified is not public-release approval. Public distribution needs a separate Google verification/security review, particularly because Gmail scopes are sensitive or restricted.
4. In SuparClaw **Settings → Integrations → Gmail**, enter the Desktop OAuth client ID, enable Gmail tools, and save. If Google's token endpoint reports `client_secret is missing`, enter the Desktop OAuth client's generated secret in the optional secret field and save again. That secret is stored only in the encrypted vault, not config or logs. The vault must be initialized and unlocked.
5. Tap **Connect Google account** and approve access in the browser. The browser and Gateway must be on the same phone because the callback is a temporary `127.0.0.1` listener. Alternatively, with the Gateway running and the vault unlocked, use `sc gmail connect`; open the printed URL on that phone.

One Gmail account is connected per local installation. Reconnecting replaces that account; disconnect before handing the device or installation to someone else.

## CLI

```sh
sc gmail status
sc gmail connect
sc gmail disconnect
```

`connect` and `disconnect` use the running Gateway so the daemon's unlocked vault receives the credential. `status` also works without a running Gateway and never prints tokens. Start the Gateway and unlock the vault before connecting.

## Tools and safety

- `gmail_account`: profile, send-as aliases, credential validation.
- `gmail_search`: paginated message and thread search with Gmail query syntax.
- `gmail_read`: message/thread content, MIME, and attachments (text/PDF is extracted; other files go to the session workspace; attachments are capped at 18 MB total).
- `gmail_drafts`: list, read, create, partially update, and permanently delete drafts.
- `gmail_send`: send a message or existing draft only after an explicit send request in the current turn.
- `gmail_labels`: list/read/create/update/delete labels and modify message/thread/batch label sets.
- `gmail_trash`: move messages/threads to Trash, restore them, and batch-trash up to 100 messages.

Sending, mailbox mutations, and draft deletion have separate current-turn intent gates. Message/thread deletion means moving to Trash, not permanent deletion. Draft deletion is permanent and requires an exact draft ID. A send that fails ambiguously is not retried automatically; check Gmail's Sent folder before trying again.

The OAuth refresh token is stored only as an encrypted-vault value. The OAuth client ID and non-secret account/scopes metadata are stored in configuration/state. Tokens are not returned in RPC responses, tool output, or logs. Gmail message contents and downloaded attachment text are intentionally passed to the agent when requested; treat email content as untrusted input.

Requested scopes:

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.settings.basic`

The local account owns and controls Google API access. SuparClaw does not proxy mailbox access for other users.
