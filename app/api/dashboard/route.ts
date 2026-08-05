import { NextRequest, NextResponse } from "next/server";
import { currentUser, getConnectedAccounts } from "@/app/lib/auth";
import { demoSenders } from "@/app/lib/demo";
import { isGoogleConfigured } from "@/app/lib/gmail";
import { getDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const configured = isGoogleConfigured();
  const user = await currentUser(request);
  if (!user) {
    const total = demoSenders.reduce((sum, sender) => sum + sender.count, 0);
    const unread = demoSenders.reduce((sum, sender) => sum + sender.unread, 0);
    return NextResponse.json({
      connected: false,
      configured,
      mode: "demo",
      user: null,
      stats: { total, unread, senders: demoSenders.length, protected: 19 },
      senders: demoSenders,
      accounts: [],
      lastSyncedAt: null,
      syncStatus: "idle",
      syncScope: "Entire Inbox",
    });
  }

  const database = await getDatabase();
  const accounts = await getConnectedAccounts(user);
  const accountEmail = request.nextUrl.searchParams.get("account")?.trim().toLowerCase() ?? "";
  if (accountEmail && !accounts.some((account) => account.email.toLowerCase() === accountEmail)) {
    return NextResponse.json({ error: "That Gmail account is not connected." }, { status: 404 });
  }
  const accountClause = accountEmail ? " AND a.email = ?" : "";
  const bindings = accountEmail ? [user.id, accountEmail] : [user.id];
  const senders = await database
    .prepare(
      `SELECT
        m.sender_email AS email,
        MAX(m.sender_name) AS name,
        COUNT(*) AS count,
        SUM(CASE WHEN m.is_unread = 1 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN m.is_starred = 1 OR m.is_important = 1 THEN 1 ELSE 0 END) AS protectedCount,
        MAX(m.received_at) AS latestAt,
        COUNT(DISTINCT m.user_id) AS accountCount
      FROM messages m
      JOIN users a ON a.id = m.user_id
      WHERE a.owner_user_id = ? AND m.trashed_at IS NULL${accountClause}
      GROUP BY m.sender_email
      ORDER BY count DESC, latestAt DESC`,
    )
    .bind(...bindings)
    .all<{
      email: string;
      name: string;
      count: number;
      unread: number;
      protectedCount: number;
      latestAt: number;
      accountCount: number;
    }>();
  const stats = await database
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT m.sender_email) AS senders,
        SUM(CASE WHEN m.is_unread = 1 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN m.is_starred = 1 OR m.is_important = 1 THEN 1 ELSE 0 END) AS protected
      FROM messages m
      JOIN users a ON a.id = m.user_id
      WHERE a.owner_user_id = ? AND m.trashed_at IS NULL${accountClause}`,
    )
    .bind(...bindings)
    .first<{ total: number; senders: number; unread: number | null; protected: number | null }>();

  const visibleAccounts = accountEmail
    ? accounts.filter((account) => account.email.toLowerCase() === accountEmail)
    : accounts;
  const lastSyncedAt = visibleAccounts.reduce<number | null>(
    (latest, account) => Math.max(latest ?? 0, account.lastSyncedAt ?? 0) || null,
    null,
  );
  const syncStatus = visibleAccounts.some((account) => account.syncStatus === "syncing")
    ? "syncing"
    : visibleAccounts.some((account) => account.syncStatus === "pending")
      ? "pending"
      : visibleAccounts.some((account) => account.syncStatus === "error")
        ? "error"
        : "idle";

  return NextResponse.json({
    connected: true,
    configured,
    mode: "live",
    user: { email: user.email, role: user.role },
    stats: {
      total: stats?.total ?? 0,
      senders: stats?.senders ?? 0,
      unread: stats?.unread ?? 0,
      protected: stats?.protected ?? 0,
    },
    senders: senders.results,
    accounts: accounts.map((account) => ({
      email: account.email,
      lastSyncedAt: account.lastSyncedAt,
      syncStatus: account.syncStatus,
      syncIndexedCount: account.syncIndexedCount,
    })),
    lastSyncedAt,
    syncStatus,
    syncScope: "Entire Inbox",
  });
}
