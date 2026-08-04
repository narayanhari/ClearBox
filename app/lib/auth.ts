import { getDatabase, getEnvironment } from "@/db/runtime";
import { randomToken, sha256 } from "./encoding";

export const SESSION_COOKIE = "clearbox_session";
export const SECURE_SESSION_COOKIE = "__Host-clearbox_session";

export function sessionCookieName(request: Request): string {
  return new URL(request.url).protocol === "https:" ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

export interface CurrentUser {
  id: string;
  email: string;
  ownerUserId: string;
  refreshTokenEncrypted: string;
  lastSyncedAt: number | null;
  syncStatus: string;
}

export interface GmailAccount extends CurrentUser {
  syncPageToken: string | null;
  activeSyncRunId: string | null;
  syncIndexedCount: number;
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function currentUser(request: Request): Promise<CurrentUser | null> {
  const sessionToken = cookieValue(request, sessionCookieName(request));
  if (!sessionToken) return null;

  const database = await getDatabase();
  const sessionHash = await sha256(sessionToken);
  const now = Date.now();
  const row = await database
    .prepare(
      `SELECT u.id, u.email, u.owner_user_id, u.refresh_token_encrypted,
              u.last_synced_at, u.sync_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .bind(sessionHash, now)
    .first<{
      id: string;
      email: string;
      owner_user_id: string | null;
      refresh_token_encrypted: string;
      last_synced_at: number | null;
      sync_status: string;
    }>();

  const allowedAddress = getEnvironment().ALLOWED_GMAIL_ADDRESS?.trim().toLowerCase();
  if (
    !row ||
    !allowedAddress ||
    row.email.trim().toLowerCase() !== allowedAddress ||
    row.owner_user_id !== row.id
  ) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    ownerUserId: row.id,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    lastSyncedAt: row.last_synced_at,
    syncStatus: row.sync_status,
  };
}

export async function getConnectedAccounts(owner: CurrentUser): Promise<GmailAccount[]> {
  const database = await getDatabase();
  const result = await database
    .prepare(
      `SELECT id, email, owner_user_id, refresh_token_encrypted, last_synced_at,
              sync_status, sync_page_token, active_sync_run_id, sync_indexed_count
       FROM users
       WHERE owner_user_id = ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, email COLLATE NOCASE`,
    )
    .bind(owner.id, owner.id)
    .all<{
      id: string;
      email: string;
      owner_user_id: string;
      refresh_token_encrypted: string;
      last_synced_at: number | null;
      sync_status: string;
      sync_page_token: string | null;
      active_sync_run_id: string | null;
      sync_indexed_count: number;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    email: row.email,
    ownerUserId: row.owner_user_id,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    lastSyncedAt: row.last_synced_at,
    syncStatus: row.sync_status,
    syncPageToken: row.sync_page_token,
    activeSyncRunId: row.active_sync_run_id,
    syncIndexedCount: row.sync_indexed_count,
  }));
}

export async function getConnectedAccount(
  owner: CurrentUser,
  email: string,
): Promise<GmailAccount | null> {
  const normalized = email.trim().toLowerCase();
  const accounts = await getConnectedAccounts(owner);
  return accounts.find((account) => account.email.trim().toLowerCase() === normalized) ?? null;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
  const database = await getDatabase();
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + 12 * 60 * 60 * 1000;
  await database.batch([
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    database
      .prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), userId, expiresAt, now),
  ]);
  return { token, expiresAt };
}

export function getCookie(request: Request, name: string): string | null {
  return cookieValue(request, name);
}
