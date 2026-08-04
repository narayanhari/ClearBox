import type { CurrentUser, GmailAccount } from "./auth";
import { decryptSecret } from "./crypto";
import { getDatabase, getEnvironment } from "@/db/runtime";
import { PublicHttpError } from "./http";
import {
  createGmailMetadataBatch,
  GMAIL_BATCH_RESPONSE_LIMIT_BYTES,
  GMAIL_METADATA_BATCH_SIZE,
  parseGmailBatchResponse,
} from "./gmail-batch";

const GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_BATCH_ROOT = "https://gmail.googleapis.com/batch";
// One OAuth refresh, one list request, and five metadata batch requests keeps
// a 250-message page well below the Workers Free external-subrequest ceiling.
const SYNC_PAGE_SIZE = 250;
const GMAIL_READ_BATCH_CONCURRENCY = 3;
const GMAIL_BATCH_MAX_ATTEMPTS = 3;
const GMAIL_MUTATION_CONCURRENCY = 6;
const MAX_FROM_HEADER_LENGTH = 1_000;
const MAX_SUBJECT_LENGTH = 2_000;
const MAX_DATE_HEADER_LENGTH = 256;

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

function boundedHeader(message: GmailMessageResponse, name: string, limit: number): string {
  return header(message, name).slice(0, limit);
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
  const sender = parseSender(boundedHeader(message, "From", MAX_FROM_HEADER_LENGTH));
  if (!sender.email.includes("@")) return null;
  const labels = message.labelIds ?? [];
  const internalDate = Number(message.internalDate);
  const parsedDate = Date.parse(boundedHeader(message, "Date", MAX_DATE_HEADER_LENGTH));
  const receivedAt = Number.isFinite(internalDate) && internalDate > 0
    ? internalDate
    : Number.isFinite(parsedDate)
      ? parsedDate
      : Date.now();
  return {
    id: message.id,
    threadId: message.threadId,
    senderEmail: sender.email,
    senderName: sender.name,
    subject: boundedHeader(message, "Subject", MAX_SUBJECT_LENGTH) || "(No subject)",
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    isImportant: labels.includes("IMPORTANT"),
    labels,
    historyId: message.historyId,
  };
}

function isGmailMessageResponse(value: unknown, expectedId: string): value is GmailMessageResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as GmailMessageResponse;
  if (message.id !== expectedId || typeof message.threadId !== "string") return false;
  if (message.labelIds !== undefined) {
    if (!Array.isArray(message.labelIds) || !message.labelIds.every((label) => typeof label === "string")) {
      return false;
    }
  }
  if (message.historyId !== undefined && typeof message.historyId !== "string") return false;
  if (message.internalDate !== undefined && typeof message.internalDate !== "string") return false;
  if (message.payload !== undefined) {
    if (!message.payload || typeof message.payload !== "object") return false;
    if (message.payload.headers !== undefined) {
      if (
        !Array.isArray(message.payload.headers) ||
        !message.payload.headers.every(
          (item) => item && typeof item.name === "string" && typeof item.value === "string",
        )
      ) return false;
    }
  }
  return true;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > GMAIL_BATCH_RESPONSE_LIMIT_BYTES) {
    throw new PublicHttpError(502, "Gmail returned an unexpectedly large response.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GMAIL_BATCH_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new PublicHttpError(502, "Gmail returned an unexpectedly large response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchGmailMetadataBatch(
  accessToken: string,
  messageIds: string[],
): Promise<GmailMessageResponse[]> {
  let pending = [...messageIds];
  const completed = new Map<string, GmailMessageResponse>();

  for (let attempt = 0; attempt < GMAIL_BATCH_MAX_ATTEMPTS && pending.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1) + Math.random() * 250));
    }

    const batch = createGmailMetadataBatch(pending);
    let response: Response;
    try {
      response = await fetch(GMAIL_BATCH_ROOT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": batch.contentType,
          accept: "multipart/mixed",
        },
        body: batch.body,
      });
    } catch {
      if (attempt + 1 < GMAIL_BATCH_MAX_ATTEMPTS) continue;
      throw new PublicHttpError(503, "Gmail is temporarily unavailable. Retrying shortly may help.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new PublicHttpError(401, "Gmail authorization has expired. Please reconnect.");
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt + 1 < GMAIL_BATCH_MAX_ATTEMPTS) continue;
      throw new PublicHttpError(503, "Gmail is temporarily rate-limiting requests. Retrying shortly may help.");
    }
    if (!response.ok) {
      throw new PublicHttpError(502, "Gmail could not complete the request. Please try again.");
    }

    let parts;
    try {
      parts = parseGmailBatchResponse(
        response.headers.get("content-type") ?? "",
        await boundedResponseText(response),
        batch.parts.map((part) => part.contentId),
      );
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      throw new PublicHttpError(502, "Gmail returned an invalid batch response.");
    }

    const retry: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const messageId = batch.parts[index].messageId;
      if (part.status === 401 || part.status === 403) {
        throw new PublicHttpError(401, "Gmail authorization has expired. Please reconnect.");
      }
      if (part.status === 429 || part.status >= 500) {
        retry.push(messageId);
        continue;
      }
      if (part.status < 200 || part.status >= 300) {
        throw new PublicHttpError(502, "Gmail could not read a message during synchronization.");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(part.body);
      } catch {
        throw new PublicHttpError(502, "Gmail returned invalid message metadata.");
      }
      if (!isGmailMessageResponse(payload, messageId)) {
        throw new PublicHttpError(502, "Gmail returned unexpected message metadata.");
      }
      completed.set(messageId, payload);
    }
    pending = retry;
  }

  if (pending.length) {
    throw new PublicHttpError(503, "Gmail is temporarily rate-limiting requests. Retrying shortly may help.");
  }
  return messageIds.map((messageId) => {
    const message = completed.get(messageId);
    if (!message) throw new PublicHttpError(502, "Gmail batch response was incomplete.");
    return message;
  });
}

async function fetchGmailMetadata(accessToken: string, messageIds: string[]): Promise<GmailMessageResponse[]> {
  const batches: string[][] = [];
  for (let offset = 0; offset < messageIds.length; offset += GMAIL_METADATA_BATCH_SIZE) {
    batches.push(messageIds.slice(offset, offset + GMAIL_METADATA_BATCH_SIZE));
  }
  const results = await mapWithConcurrency(batches, GMAIL_READ_BATCH_CONCURRENCY, (batch) =>
    fetchGmailMetadataBatch(accessToken, batch),
  );
  return results.flat();
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

    const rawMessages = await fetchGmailMetadata(accessToken, ids.map(({ id }) => id));
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
