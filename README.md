# Clearbox invite-only beta

Clearbox groups Gmail messages by exact sender address, ranks senders by message count, and lets you move individual or bulk messages to Gmail Trash. Inbox scans index headers and labels only. When you open a sender, the app fetches short Gmail previews for the 10 newest emails without saving those previews locally; full bodies and attachments are never downloaded.

## Included in this beta

- Responsive sender dashboard with useful demo data before Gmail is connected.
- Google OAuth with PKCE, state validation, an encrypted refresh token, and an HTTP-only session cookie.
- A resumable metadata-only scan of every message currently in Gmail Inbox.
- Free-tier-safe sync pages that process one 20-message Gmail metadata batch per Worker invocation, automatically retry transient failures, and recover abandoned scan locks after one minute.
- Multiple Gmail accounts linked under one locally authenticated owner.
- Email-verified invitations, administrator/member roles, immediate session revocation, and isolated workspaces for up to 25 beta members.
- Exact sender grouping across all linked accounts, unread counts, protected-message counts, mailbox filtering, sender search, and sorting.
- A conversation-style sender view with the latest 10 subjects and short, on-demand Gmail previews.
- Single-message and exact-sender bulk cleanup.
- One confirmed bulk cleanup moves every unprotected message from that sender, continuing automatically in recoverable cloud-safe internal batches.
- Starred and important messages excluded from cleanup by default.
- Gmail Trash only—no permanent-delete endpoint is used.
- In-app undo for ten minutes after a cleanup.
- Disconnect that always removes local tokens and indexed metadata, asks Google to revoke access, and warns when Google permissions need manual removal.

## One-time Google setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Gmail API** for that project.
3. Open **Google Auth Platform** and configure the audience as **External** with publishing status **Testing**.
4. Add the beta administrator under **Test users**. Add each invited address there before they connect Clearbox.
5. Under **Data Access**, add the scope `https://www.googleapis.com/auth/gmail.modify`.
6. Create an OAuth client with application type **Web application**.
7. Add this authorized redirect URI exactly:

   ```text
   http://localhost:3000/api/auth/google/callback
   https://clearbox.narayanhari.in/api/auth/google/callback
   ```

   For the hosted beta, use `https://clearbox.narayanhari.in` as the application home page and `https://clearbox.narayanhari.in/privacy` as the privacy policy URL in Google Auth Platform.

8. Copy `.env.example` to `.env.local` and provide the client ID, client secret, your exact Gmail address in `BETA_ADMIN_EMAIL`, and the encryption key.

   ```bash
   openssl rand -base64 32
   ```

Google projects in Testing are limited to 100 listed test users, and their authorizations expire after seven days. Clearbox deliberately uses a smaller 25-member beta cap. Members should reconnect when Google asks for consent again.

## Run locally

Use Node.js 22 or later.

```bash
pnpm install
pnpm run dev
```

Open `http://localhost:3000` and choose **Join with invited Gmail**. Connect the exact administrator address from `BETA_ADMIN_EMAIL` first. Open **Setup** to invite members, and add the same addresses to Google OAuth **Test users**. Each member can link up to five Gmail accounts they control and then scan the combined Inbox.

## Invite a beta member

1. Sign in as the beta administrator.
2. Open **Setup**, enter the member's exact Gmail address, and choose **Invite**.
3. Add that same address under Google Auth Platform → Audience → **Test users**.
4. Send the member `https://clearbox.narayanhari.in`. They create their isolated workspace by signing in with the invited address.
5. Use **Revoke** in Setup to invalidate that member's sessions and remove their linked tokens and indexed Clearbox data. Re-inviting a revoked address is supported.

An app invitation does not send email and does not modify Google Cloud automatically. The administrator shares the beta URL directly with invited people.

## Safe testing sequence

1. Explore the demo dashboard before connecting Gmail.
2. Connect the owner Gmail and run the first entire-Inbox scan. Large inboxes progress in small resumable pages.
3. Optionally add another Gmail account, sync it, and test the all-accounts and per-mailbox filters.
4. Open a sender and review the latest 10 email previews without deleting anything.
5. Move one unprotected message to Trash and verify it in the correct Gmail Trash.
6. Test Undo and confirm that Gmail restores the message.
7. Try bulk cleanup first on a sender with only a few non-important messages.

The app never empties Gmail Trash. Gmail remains the source of truth, and messages moved to Trash stay recoverable through Gmail.

On the Cloudflare Workers Free plan, Clearbox intentionally uses small sequential sync pages to stay within the 10 ms CPU allowance. A full scan therefore makes more short `/api/sync` requests than the local build. Short-lived Google access tokens are reused inside warm Worker isolates to avoid an OAuth refresh on every page. Messages moved or deleted between Gmail's list and metadata responses are skipped safely instead of aborting the scan. Cloudflare HTML error pages are never parsed as JSON, and a forcibly interrupted page is retried after its short lock expires.

## Security guardrails

- Only a Google-verified address with an active `beta_members` record can establish a session. The configured `BETA_ADMIN_EMAIL` is bootstrapped as the administrator.
- Invitation creation, listing, and revocation require an active administrator session plus same-origin request validation.
- Every Gmail account, indexed message, preview request, cleanup job, and disconnect operation remains scoped to its owning beta workspace.
- An address invited for its own workspace cannot be captured as another member's secondary Gmail account.
- Each workspace is limited to five linked Gmail accounts and the deployment is capped at 25 invited/active members.
- Every dashboard, sync, Trash, Undo, and disconnect query verifies linked-account ownership on the server.
- Mailbox-changing API requests require a same-origin action header and reject cross-origin requests.
- Starred and important messages are excluded by the server; clients cannot override that rule.
- Sessions expire after 12 hours and are rotated whenever Gmail is reconnected.
- Refresh tokens are encrypted with AES-256-GCM, while session tokens are stored only as SHA-256 hashes.
- Run `pnpm audit --prod` and require zero known production vulnerabilities before adding Gmail credentials.
- Keep `.env.local` untracked. For hosting, put credentials and the encryption key in the hosting provider's secret store.

## Storage and privacy

The database contains beta membership status, each linked Gmail address, encrypted refresh token, message IDs, sender, subject, date, and labels needed for the dashboard. It does not store previews, bodies, or attachments. Short preview text is requested from Gmail only when the authenticated member opens a sender conversation. Selecting the account control and confirming disconnect always removes the workspace's stored tokens and indexed data. Clearbox also asks Google to revoke every linked grant and warns the member when Google Account permissions need manual removal.

Before a public launch, use a separate production Google Cloud project, publish privacy and data-deletion policies, and complete Google's verification requirements for the requested Gmail scope. Until then, keep membership invite-only and add every member to Google OAuth test users.
