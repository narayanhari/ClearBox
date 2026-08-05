import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("ships the complete Clearbox dashboard instead of starter UI", async () => {
  const [layout, page, dashboard, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MailDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /Clearbox — See your inbox by sender/i);
  assert.match(page, /<MailDashboard \/>/i);
  assert.match(dashboard, /Your inbox, finally in perspective/i);
  assert.match(dashboard, /Connect Gmail/i);
  assert.match(dashboard, /Trash only, never permanent/i);
  assert.doesNotMatch(`${layout}\n${page}\n${dashboard}\n${packageJson}`, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps cleanup recoverable and excludes permanent-delete access", async () => {
  const [gmail, oauthStart, cleanup, envExample, schema] = await Promise.all([
    readFile(new URL("../app/lib/gmail.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/google/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cleanup/trash/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(oauthStart, /gmail\.modify/);
  assert.match(gmail, /\/trash/);
  assert.match(gmail, /\/untrash/);
  assert.doesNotMatch(gmail, /batchDelete|messages\.delete|mail\.google\.com/);
  assert.match(cleanup, /m\.is_starred = 0 AND m\.is_important = 0/);
  assert.doesNotMatch(cleanup, /includeProtected/);
  assert.match(cleanup, /CLEANUP_REQUEST_BATCH_SIZE = 20/);
  assert.match(cleanup, /LIMIT \$\{CLEANUP_REQUEST_BATCH_SIZE \+ 1\}/);
  assert.match(envExample, /APP_ENCRYPTION_KEY/);
  assert.match(envExample, /BETA_ADMIN_EMAIL/);
  assert.match(gmail, /ON CONFLICT\(user_id, id\)/);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.userId, table\.id\]/);
  await access(new URL("../public/og.png", import.meta.url));
});

test("continues bulk cleanup until every eligible sender message is moved", async () => {
  const dashboard = await readFile(new URL("../app/MailDashboard.tsx", import.meta.url), "utf8");

  assert.match(dashboard, /while \(hasMore\)/);
  assert.match(dashboard, /hasMore = Boolean\(payload\.limited\)/);
  assert.match(dashboard, /Move all.*to Trash/);
  assert.match(dashboard, /jobIds: completedJobIds/);
  assert.doesNotMatch(dashboard, /Run again for the remainder|remainingAfterBatch/);
});

test("keeps Gmail work inside Cloudflare free-tier request ceilings", async () => {
  const [gmail, gmailBatch, cleanup] = await Promise.all([
    readFile(new URL("../app/lib/gmail.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/gmail-batch.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cleanup/trash/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(gmail, /SYNC_PAGE_SIZE = GMAIL_METADATA_BATCH_SIZE/);
  assert.match(gmail, /GMAIL_READ_BATCH_CONCURRENCY = 1/);
  assert.match(gmail, /SYNC_LOCK_LEASE_MS = 60_000/);
  assert.match(gmail, /MAX_ACCESS_TOKEN_CACHE_ENTRIES = 150/);
  assert.match(gmail, /accessTokenCache/);
  assert.match(gmail, /GMAIL_MUTATION_CONCURRENCY = 6/);
  assert.match(gmailBatch, /GMAIL_METADATA_BATCH_SIZE = 20/);
  assert.match(gmailBatch, /payload\/headers/);
  assert.match(cleanup, /CLEANUP_REQUEST_BATCH_SIZE = 20/);
});

test("enforces browser and request security controls", async () => {
  const [http, config, worker, callback, dashboard, packageJson] = await Promise.all([
    readFile(new URL("../app/lib/http.ts", import.meta.url), "utf8"),
    readFile(new URL("../security-headers.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/google/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MailDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(http, /x-clearbox-action/);
  assert.match(http, /receivedOrigin !== expectedOrigin/);
  assert.match(http, /sec-fetch-site/);
  assert.match(dashboard, /x-clearbox-action/);
  assert.match(callback, /SELECT role, status FROM beta_members WHERE email = \?/);
  assert.match(callback, /status !== "invited" && membership\.status !== "active"/);
  assert.match(callback, /DELETE FROM sessions WHERE user_id/);
  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(worker, /Cache-Control.*no-store/);
  assert.match(worker, /secureResponse/);

  const dependencies = JSON.parse(packageJson);
  assert.equal(dependencies.dependencies.next, "16.2.12");
});

test("enforces invite-only beta membership and administrator-only invitation controls", async () => {
  const [auth, callback, invitations, disconnect, runtime, schema, dashboard, privacy, deletion] = await Promise.all([
    readFile(new URL("../app/lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/google/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/invitations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/disconnect/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MailDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data-deletion/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /JOIN beta_members b ON b\.email = u\.email/);
  assert.match(auth, /b\.status = 'active' AND u\.owner_user_id = u\.id/);
  assert.match(callback, /invite-required/);
  assert.match(callback, /account-reserved/);
  assert.match(callback, /MAX_LINKED_GMAIL_ACCOUNTS/);
  assert.match(callback, /activation\.meta\.changes !== 1/);
  assert.match(callback, /WHERE \(SELECT COUNT\(\*\) FROM users WHERE owner_user_id = \?\) < \?/);
  assert.match(callback, /JOIN users u ON u\.id = \? AND u\.owner_user_id = u\.id AND u\.email = b\.email/);
  assert.match(callback, /const currentOwner = await currentUser\(request\)/);
  assert.match(callback, /DELETE FROM users WHERE owner_user_id = \?/);
  assert.match(invitations, /requireReadRequest\(request\)/);
  assert.match(invitations, /requireActionRequest\(request\)/);
  assert.match(invitations, /user\.role !== "admin"/);
  assert.match(invitations, /MAX_BETA_MEMBERS/);
  assert.match(invitations, /DELETE FROM sessions/);
  assert.match(invitations, /DELETE FROM messages WHERE user_id IN/);
  assert.match(invitations, /DELETE FROM users WHERE owner_user_id/);
  assert.doesNotMatch(invitations, /beta access is already revoked/i);
  assert.match(disconnect, /Promise\.allSettled/);
  assert.match(disconnect, /googleAccessRevoked/);
  assert.match(disconnect, /DELETE FROM users WHERE owner_user_id/);
  assert.ok(disconnect.indexOf("await database.batch") < disconnect.indexOf("const revocations"));
  assert.match(runtime, /INSERT INTO beta_members/);
  assert.match(runtime, /role = 'admin', status = 'active'/);
  assert.match(runtime, /WHERE role = 'admin' AND email != \?/);
  assert.match(runtime, /UPDATE beta_members SET status = 'revoked'.*WHERE role = 'admin'/s);
  assert.match(runtime, /DELETE FROM users WHERE owner_user_id = \?/);
  assert.match(schema, /export const betaMembers/);
  assert.match(dashboard, /Invite beta members/);
  assert.match(dashboard, /Google OAuth test users/);
  assert.match(dashboard, /payload\.googleAccessRevoked/);
  assert.match(dashboard, /Google did not confirm every token revocation/);
  assert.doesNotMatch(dashboard, /params\.get\("disconnected"\)/);
  assert.match(privacy, /does not sell Gmail data/);
  assert.match(privacy, /full message bodies or attachments/);
  assert.match(deletion, /removes your sessions, encrypted refresh tokens/);
});

test("scans the entire Inbox and scopes multiple accounts to one owner", async () => {
  const [gmail, auth, sync, dashboard, senders, trash, schema] = await Promise.all([
    readFile(new URL("../app/lib/gmail.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/senders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cleanup/trash/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(gmail, /labelIds.*INBOX/);
  assert.match(gmail, /createGmailMetadataBatch/);
  assert.match(gmail, /parseGmailBatchResponse/);
  assert.match(gmail, /sync_page_token/);
  assert.doesNotMatch(gmail, /newer_than|cappedAt/);
  assert.match(sync, /getConnectedAccount/);
  assert.match(auth, /owner_user_id = \?/);
  assert.match(dashboard, /a\.owner_user_id = \?/);
  assert.match(dashboard, /COUNT\(DISTINCT m\.user_id\) AS accountCount/);
  assert.match(senders, /a\.email AS accountEmail/);
  assert.match(trash, /a\.owner_user_id = \?/);
  assert.match(schema, /ownerUserId: text\("owner_user_id"\)/);
});

test("shows progressive results and retries temporary Gmail throttling", async () => {
  const dashboard = await readFile(new URL("../app/MailDashboard.tsx", import.meta.url), "utf8");

  assert.match(dashboard, /response\.status === 503/);
  assert.match(dashboard, /SYNC_STATUS_RETRY_LIMIT = 6/);
  assert.match(dashboard, /SYNC_LOCK_RETRY_LIMIT = 15/);
  assert.match(dashboard, /PROGRESSIVE_DASHBOARD_PAGE_INTERVAL = 25/);
  assert.match(dashboard, /readApiJson/);
  assert.match(dashboard, /pageCount === 1/);
  assert.match(dashboard, /await loadDashboard\(\)/);
});

test("loads only ten on-demand sender previews without persisting them", async () => {
  const [gmail, senders, dashboard, schema] = await Promise.all([
    readFile(new URL("../app/lib/gmail.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/senders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MailDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(gmail, /getMessagePreviews/);
  assert.match(gmail, /fields: "id,snippet"/);
  assert.match(senders, /LIMIT 10/);
  assert.match(senders, /requireReadRequest\(request\)/);
  assert.match(dashboard, /Latest 10 emails/);
  assert.match(dashboard, /not saved locally/);
  assert.doesNotMatch(schema, /snippet|preview/i);
});

test("accepts protected same-origin reads without weakening write validation", async () => {
  const [http, senders] = await Promise.all([
    readFile(new URL("../app/lib/http.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/senders/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(http, /export function requireReadRequest/);
  assert.match(http, /fetchSite !== "same-origin"/);
  assert.match(http, /new URL\(value\)\.origin !== expectedOrigin/);
  assert.match(senders, /requireReadRequest\(request\)/);
  assert.doesNotMatch(senders, /requireActionRequest\(request\)/);
  assert.match(http, /export function requireActionRequest/);
  assert.match(http, /if \(!origin\)/);
});
