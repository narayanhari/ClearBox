# Clearbox personal prototype

Clearbox groups Gmail messages by exact sender address, ranks senders by message count, and lets you move individual or bulk messages to Gmail Trash. Inbox scans index headers and labels only. When you open a sender, the app fetches short Gmail previews for the 10 newest emails without saving those previews locally; full bodies and attachments are never downloaded.

## Included in this prototype

- Responsive sender dashboard with useful demo data before Gmail is connected.
- Google OAuth with PKCE, state validation, an encrypted refresh token, and an HTTP-only session cookie.
- A resumable metadata-only scan of every message currently in Gmail Inbox.
- Multiple Gmail accounts linked under one locally authenticated owner.
- Exact sender grouping across all linked accounts, unread counts, protected-message counts, mailbox filtering, sender search, and sorting.
- A conversation-style sender view with the latest 10 subjects and short, on-demand Gmail previews.
- Single-message and exact-sender bulk cleanup.
- One confirmed bulk cleanup moves every unprotected message from that sender, continuing automatically in recoverable cloud-safe internal batches.
- Starred and important messages excluded from cleanup by default.
- Gmail Trash only—no permanent-delete endpoint is used.
- In-app undo for ten minutes after a cleanup.
- Disconnect that revokes Google access and removes the locally indexed metadata.

## One-time Google setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Gmail API** for that project.
3. Open **Google Auth Platform** and configure the audience as **External** with publishing status **Testing**.
4. Add the owner Gmail and every additional Gmail you want to connect under **Test users**.
5. Under **Data Access**, add the scope `https://www.googleapis.com/auth/gmail.modify`.
6. Create an OAuth client with application type **Web application**.
7. Add this authorized redirect URI exactly:

   ```text
   http://localhost:3000/api/auth/google/callback
   ```

8. Copy `.env.example` to `.env.local` and provide the client ID, client secret, your exact Gmail address in `ALLOWED_GMAIL_ADDRESS`, and the encryption key.

   ```bash
   openssl rand -base64 32
   ```

Google test-mode authorizations that include Gmail access expire after seven days. Reconnect when Google asks for consent again. This is expected for a personal test project in Testing status.

## Run locally

Use Node.js 22 or later.

```bash
pnpm install
pnpm run dev
```

Open `http://localhost:3000` and choose **Connect Gmail**. Connect the exact owner address from `ALLOWED_GMAIL_ADDRESS` first, then use **+ Add Gmail** for additional accounts. Press **Scan entire Inbox** to build the combined sender view.

## Safe testing sequence

1. Explore the demo dashboard before connecting Gmail.
2. Connect the owner Gmail and run the first entire-Inbox scan. Large inboxes progress in small resumable pages.
3. Optionally add another Gmail account, sync it, and test the all-accounts and per-mailbox filters.
4. Open a sender and review the latest 10 email previews without deleting anything.
5. Move one unprotected message to Trash and verify it in the correct Gmail Trash.
6. Test Undo and confirm that Gmail restores the message.
7. Try bulk cleanup first on a sender with only a few non-important messages.

The app never empties Gmail Trash. Gmail remains the source of truth, and messages moved to Trash stay recoverable through Gmail.

## Security guardrails

- Only the exact address configured in `ALLOWED_GMAIL_ADDRESS` can establish the owner session. Additional Gmail accounts can be linked only from that authenticated session.
- Every dashboard, sync, Trash, Undo, and disconnect query verifies linked-account ownership on the server.
- Mailbox-changing API requests require a same-origin action header and reject cross-origin requests.
- Starred and important messages are excluded by the server; clients cannot override that rule.
- Sessions expire after 12 hours and are rotated whenever Gmail is reconnected.
- Refresh tokens are encrypted with AES-256-GCM, while session tokens are stored only as SHA-256 hashes.
- Run `pnpm audit --prod` and require zero known production vulnerabilities before adding Gmail credentials.
- Keep `.env.local` untracked. For hosting, put credentials and the encryption key in the hosting provider's secret store.

## Storage and privacy

The local database contains each linked Gmail address, encrypted refresh token, message IDs, sender, subject, date, and labels needed for the dashboard. It does not store previews, bodies, or attachments. Short preview text is requested from Gmail only when the authenticated owner opens a sender conversation. Selecting the account control and confirming disconnect revokes access for every linked Gmail and removes all locally indexed data.

For a public launch, use a separate production Google Cloud project and complete Google's restricted-scope verification requirements before inviting users. This personal prototype intentionally has one allowlisted owner, who may link multiple Gmail accounts.
