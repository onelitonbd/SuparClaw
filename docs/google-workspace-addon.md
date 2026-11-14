# Google Workspace add-on

SuparClaw exposes native `google_docs`, `google_sheets`, `google_calendar`, and `google_drive` tools to the agent. Each tool routes requests to the corresponding Google REST API and accepts native API paths, parameters, and request bodies. This keeps API coverage broad: Docs and Sheets batch-update requests expose their full formatting/structure operations, while Calendar and Drive resources include events, availability, permissions, comments, revisions, and Shared Drive endpoints.

## Setup

1. In Google Cloud Console, create a project and enable the **Google Docs API**, **Google Sheets API**, **Google Calendar API**, **Google Drive API**, and **Gmail API**.
2. Configure the OAuth consent screen and create an OAuth client of type **Desktop app**. The local Gateway uses Authorization Code + PKCE with a temporary loopback callback; the browser performing approval must be on the same device as the Gateway.
3. In **Settings → Integrations → Google Workspace**, enter the Desktop client ID. If Google reports `client_secret is missing`, save the optional Desktop client secret there; it is stored in the encrypted vault, not in config or logs.
4. Enable the Gmail tools and/or **Docs, Sheets, Calendar, and Drive tools**, save, then tap **Connect Google account**. Desktop OAuth does not support incremental authorization, so reauthorization requests the complete Gmail + Drive + Calendar scope set again, with `prompt=consent`. `drive` covers Docs and Sheets, so expect one Drive permission rather than separate Docs/Sheets prompts.
5. Review and approve the complete scope list in Google. The consent includes the existing Gmail scopes plus full `drive` access and `calendar` access. The Docs and Sheets APIs accept the full Drive scope; the narrower `drive.file` scope would not cover existing Drive files and is intentionally not used.

Full Drive access is a **restricted Google OAuth scope**. Google may require app verification and a security assessment before a public release. For personal use, configure the consent screen for your own account and review the unverified-app warning before proceeding. Personal-use setup is not approval for public distribution.

The refresh token is encrypted in the existing vault. Config stores only the OAuth client ID and enable toggles; account metadata and granted scope names contain no token. Unlock the vault to connect or use the tools.

## Tools

- **`google_docs`** — read document structure/text, search Google Docs in Drive, create documents, and execute native `documents/{documentId}:batchUpdate` requests for text, styles, tables, headers/footers, and tabs.
- **`google_sheets`** — read and update cell values with `spreadsheets/{spreadsheetId}/values/...`; use batch values endpoints for ranges, and `spreadsheets/{spreadsheetId}:batchUpdate` for formatting, named tables, charts, filters, protections, sheets, and other native operations. `query_values` is a convenience for a range read.
- **`google_calendar`** — access calendars/calendar lists, events and instances, free/busy, colors, settings, ACLs, and watch channels. Event-list requests should include `timeMin` and `timeMax` to keep results bounded.
- **`google_drive`** — list/search/get/create/update/copy files; export Google-native content; download binary content into `workspace/google-drive/`; upload up to 18 MiB of text/base64 content; manage permissions, comments/replies, revisions, and Shared Drives. Use the `trash` action instead of permanent deletion when possible.

For API calls, pass `path` relative to the relevant Google API root, `method`, and optional `query` and `body`. For example, read a spreadsheet range with `google_sheets` using `GET spreadsheets/{spreadsheetId}/values/Sheet1!A1:F50`, or edit a document with `POST documents/{documentId}:batchUpdate` and its native `requests` array. Responses are bounded to 32 KiB; narrow fields/ranges or page large results.

## Safety and limitations

- Non-read requests require explicit Workspace change intent in the current user turn.
- Permanent deletes, Drive Trash moves, calendar clearing/cancellation, and delete operations embedded in Docs/Sheets batch requests require an explicit delete/trash request and `confirm` equal to the exact target ID/range. Emptying Drive Trash requires `confirm="empty trash"`. Drive file deletion is permanent; prefer **Trash** and restore.
- Permission/ACL writes require explicit sharing intent. Public/anyone access and ownership transfer require elevated intent plus `confirm="public sharing"` or `confirm="transfer ownership"`.
- Calendar requests that add event attendees or send updates require explicit invite/notification intent plus `confirm="send invites"`. Read-only `freeBusy` POST requests do not require a mutation gate.
- Calendar watch channels need a publicly reachable HTTPS callback. Localhost, private IP, and local-domain addresses are rejected; a Termux-only local setup does not itself provide a public receiver.
- Shared Drive operations work only when the connected account has a qualifying Google Workspace edition. Personal Google accounts cannot create or use Shared Drives.
- Google file contents and returned document data are passed to the agent only when requested. Treat file content as untrusted input, just like email content.
