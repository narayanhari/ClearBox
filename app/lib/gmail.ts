import type { CurrentUser, GmailAccount } from "./auth";
import { decryptSecret } from "./crypto";
import { getDatabase, getEnvironment } from "@/db/runtime";
import { PublicHttpError } from "./http";

const GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
// Leave room beneath the Workers Free limit of 50 external subrequests:
// one OAuth refresh, one Gmail list request, and up to 45 message reads.
const SYNC_PAGE_SIZE = 45;
const GMAIL_MUTATION_CONCURRENCY = 6;

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

interface GmailMessageResponse {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}

export interface IndexedMessage {
  id: string;
  threadId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  receivedAt: number;
  isUnread: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
  historyId?: string;
}

export interface GmailMessagePreview {
  id: string;
  preview: string;
}

function googleConfig(): { clientId: string; clientSecret: string } {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getEnvironment();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured yet.");
  }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
}

export function isGoogleConfigured(): boolean {
  const environment = getEnvironment();
  return Boolean(
    environment.GOOGLE_CLIENT_ID &&
      environment.GOOGLE_CLIENT_SECRET &&
      environment.APP_ENCRYPTION_KEY &&
      environment.ALLOWED_GMAIL_ADDRESS,
  );
}

export function getAllowedGmailAddress(): string {
  const address = getEnvironment().ALLOWED_GMAIL_ADDRESS?.trim().toLowerCase();
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error("ALLOWED_GMAIL_ADDRESS is not configured correctly.");
  }
  return address;
}

export function getGoogleOAuthConfig(): { clientId: string; clientSecret: string } {
  return googleConfig();
}

export async function refreshAccessToken(refreshTokenEncrypted: string): Promise<string> {
  const { clientId, clientSecret } = googleConfig();
  const refreshToken = await decryptSecret(refreshTokenEncrypted);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json()) as { access_token?: string };
  if (!response.ok || !payload.access_token) {
    throw new PublicHttpError(401, "Gmail authorization has expired. Please reconnect.");
  }
  return payload.access_token;
}

async function gmailFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GMAIL_ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new PublicHttpError(401, "Gmail authorization has expired. Please reconnect.");
    }
    if (response.status === 429) {
      throw new PublicHttpError(503, "Gmail is temporarily rate-limiting requests. Please try again shortly.");
    }
    throw new PublicHttpError(502, "Gmail could not complete the request. Please try again.");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function header(message: GmailMessageResponse, name: string): string {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function parseSender(value: string): { name: string; email: string } {
  const angleAddress = value.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const bareAddress = value.match(/([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const email = (angleAddress?.[1] ?? bareAddress?.[1] ?? value).trim().toLowerCase();
  const name = value
    .replace(/<[^>]+>/g, "")
    .replace(email, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  return { name: name || email.split("@")[0] || "Unknown sender", email };
}

function indexMessage(message: GmailMessageResponse): IndexedMessage | null {
  const sender = parseSender(header(message, "From"));
  if (!sender.email.includes("@")) return null;
  const labels = message.labelIds ?? [];
  const receivedAt = Number(message.internalDate) || Date.parse(header(message, "Date")) || Date.now();
  return {
    id: message.id,
    threadId: message.threadId,
    senderEmail: sender.email,
    senderName: sender.name,
    subject: header(message, "Subject") || "(No subject)",
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    isImportant: labels.includes("IMPORTANT"),
    labels,
    historyId: message.historyId,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export interface SyncPageResult {
  indexedThisPage: number;
  indexedTotal: number;
  complete: boolean;
}

export async function syncMailboxPage(account: GmailAccount): Promise<SyncPageResult> {
  const database = await getDatabase();
  const now = Date.now();
  const lock = await database
    .prepare(
      `UPDATE users SET sync_status = 'syncing', updated_at = ?
       WHERE id = ? AND (sync_status != 'syncing' OR updated_at < ?)`,
    )
    .bind(now, account.id, now - 10 * 60 * 1000)
    .run();
  if (lock.meta.changes === 0) {
    throw new PublicHttpError(409, "A mailbox scan is already in progress.");
  }

  const syncRunId = account.activeSyncRunId ?? crypto.randomUUID();
  const indexedBefore = account.activeSyncRunId ? account.syncIndexedCount : 0;

  try {
    const accessToken = await refreshAccessToken(account.refreshTokenEncrypted);
    const params = new URLSearchParams({ maxResults: SYNC_PAGE_SIZE.toString() });
    params.append("labelIds", "INBOX");
    if (account.syncPageToken) params.set("pageToken", account.syncPageToken);
    const page = await gmailFetch<GmailListResponse>(accessToken, `/messages?${params.toString()}`);
    const ids = page.messages ?? [];

    const rawMessages = await mapWithConcurrency(ids, GMAIL_MUTATION_CONCURRENCY, ({ id }) => {
      const params = new URLSearchParams({ format: "metadata" });
      for (const field of ["From", "Subject", "Date"]) params.append("metadataHeaders", field);
      return gmailFetch<GmailMessageResponse>(accessToken, `/messages/${encodeURIComponent(id)}?${params.toString()}`);
    });
    const indexed = rawMessages.map(indexMessage).filter((message): message is IndexedMessage => Boolean(message));

    for (let offset = 0; offset < indexed.length; offset += 50) {
      const batch = indexed.slice(offset, offset + 50).map((message) =>
        database
          .prepare(
            `INSERT INTO messages (
              id, user_id, thread_id, sender_email, sender_name, subject, received_at,
              is_unread, is_starred, is_important, labels_json, sync_run_id, trashed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(user_id, id) DO UPDATE SET
              thread_id = excluded.thread_id,
              sender_email = excluded.sender_email,
              sender_name = excluded.sender_name,
              subject = excluded.subject,
              received_at = excluded.received_at,
              is_unread = excluded.is_unread,
              is_starred = excluded.is_starred,
              is_important = excluded.is_important,
              labels_json = excluded.labels_json,
              sync_run_id = excluded.sync_run_id,
              trashed_at = NULL`,
          )
          .bind(
            message.id,
            account.id,
            message.threadId,
            message.senderEmail,
            message.senderName,
            message.subject,
            message.receivedAt,
            message.isUnread ? 1 : 0,
            message.isStarred ? 1 : 0,
            message.isImportant ? 1 : 0,
            JSON.stringify(message.labels),
            syncRunId,
          ),
      );
      await database.batch(batch);
    }

    const indexedTotal = indexedBefore + indexed.length;
    if (page.nextPageToken) {
      await database
        .prepare(
          `UPDATE users
           SET sync_status = 'pending', sync_page_token = ?, active_sync_run_id = ?,
               sync_indexed_count = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(page.nextPageToken, syncRunId, indexedTotal, Date.now(), account.id)
        .run();
      return { indexedThisPage: indexed.length, indexedTotal, complete: false };
    }

    await database
      .prepare("DELETE FROM messages WHERE user_id = ? AND sync_run_id != ?")
      .bind(account.id, syncRunId)
      .run();
    const newestHistoryId = rawMessages.find((message) => message.historyId)?.historyId ?? null;
    await database
      .prepare(
        `UPDATE users
         SET history_id = COALESCE(?, history_id), last_synced_at = ?, sync_status = 'idle',
             sync_page_token = NULL, active_sync_run_id = NULL, sync_indexed_count = 0,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(newestHistoryId, Date.now(), Date.now(), account.id)
      .run();
    return { indexedThisPage: indexed.length, indexedTotal, complete: true };
  } catch (error) {
    await database
      .prepare("UPDATE users SET sync_status = 'error', updated_at = ? WHERE id = ?")
      .bind(Date.now(), account.id)
      .run();
    throw error;
  }
}

export async function getMessagePreviews(
  account: GmailAccount,
  messageIds: string[],
): Promise<GmailMessagePreview[]> {
  const accessToken = await refreshAccessToken(account.refreshTokenEncrypted);
  return mapWithConcurrency(messageIds.slice(0, 10), 5, async (id) => {
    const params = new URLSearchParams({
      format: "metadata",
      fields: "id,snippet",
    });
    const message = await gmailFetch<GmailMessageResponse>(
      accessToken,
      `/messages/${encodeURIComponent(id)}?${params.toString()}`,
    );
    return {
      id: message.id,
      preview: message.snippet?.trim() || "No preview text is available for this email.",
    };
  });
}

export async function trashMessages(user: CurrentUser, messageIds: string[]): Promise<string[]> {
  const accessToken = await refreshAccessToken(user.refreshTokenEncrypted);
  await mapWithConcurrency(messageIds, GMAIL_MUTATION_CONCURRENCY, (id) =>
    gmailFetch<GmailMessageResponse>(accessToken, `/messages/${encodeURIComponent(id)}/trash`, {
      method: "POST",
    }),
  );
  return messageIds;
}

export async function untrashMessages(user: CurrentUser, messageIds: string[]): Promise<void> {
  const accessToken = await refreshAccessToken(user.refreshTokenEncrypted);
  await mapWithConcurrency(messageIds, GMAIL_MUTATION_CONCURRENCY, (id) =>
    gmailFetch<GmailMessageResponse>(accessToken, `/messages/${encodeURIComponent(id)}/untrash`, {
      method: "POST",
    }),
  );
}

export async function revokeGoogleToken(token: string): Promise<void> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok && response.status !== 400) {
    throw new PublicHttpError(502, "Google access could not be revoked. Please try disconnecting again.");
  }
}

export async function revokeGoogleAccess(refreshTokenEncrypted: string): Promise<void> {
  await revokeGoogleToken(await decryptSecret(refreshTokenEncrypted));
}
