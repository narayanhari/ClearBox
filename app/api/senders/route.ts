import { NextRequest, NextResponse } from "next/server";
import { currentUser, getConnectedAccounts } from "@/app/lib/auth";
import { demoMessages, demoSenders } from "@/app/lib/demo";
import { getMessagePreviews } from "@/app/lib/gmail";
import { apiFailure, requireReadRequest } from "@/app/lib/http";
import { getDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireReadRequest(request);
  } catch (error) {
    return apiFailure("Sender preview request rejected", error, "Could not load sender previews.");
  }

  const senderEmail = request.nextUrl.searchParams.get("sender")?.trim().toLowerCase();
  if (!senderEmail) return NextResponse.json({ error: "Sender is required" }, { status: 400 });
  const user = await currentUser(request);
  if (!user) {
    const sender = demoSenders.find((item) => item.email === senderEmail) ?? demoSenders[0];
    return NextResponse.json({ sender, messages: demoMessages, mode: "demo" });
  }

  const database = await getDatabase();
  const accounts = await getConnectedAccounts(user);
  const accountEmail = request.nextUrl.searchParams.get("account")?.trim().toLowerCase() ?? "";
  if (accountEmail && !accounts.some((account) => account.email.toLowerCase() === accountEmail)) {
    return NextResponse.json({ error: "That Gmail account is not connected." }, { status: 404 });
  }
  const accountClause = accountEmail ? " AND a.email = ?" : "";
  const bindings = accountEmail ? [user.id, senderEmail, accountEmail] : [user.id, senderEmail];
  const sender = await database
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
      WHERE a.owner_user_id = ? AND m.sender_email = ? AND m.trashed_at IS NULL${accountClause}
      GROUP BY m.sender_email`,
    )
    .bind(...bindings)
    .first();
  const messages = await database
    .prepare(
      `SELECT
        m.id, m.subject, m.received_at AS receivedAt, m.is_unread AS isUnread,
        m.is_starred AS isStarred, m.is_important AS isImportant,
        m.user_id AS userId, a.email AS accountEmail
      FROM messages m
      JOIN users a ON a.id = m.user_id
      WHERE a.owner_user_id = ? AND m.sender_email = ? AND m.trashed_at IS NULL${accountClause}
      ORDER BY m.received_at DESC
      LIMIT 10`,
    )
    .bind(...bindings)
    .all<{
      id: string;
      subject: string;
      receivedAt: number;
      isUnread: number;
      isStarred: number;
      isImportant: number;
      userId: string;
      accountEmail: string;
    }>();

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const groupedIds = new Map<string, string[]>();
  for (const message of messages.results) {
    const ids = groupedIds.get(message.userId) ?? [];
    ids.push(message.id);
    groupedIds.set(message.userId, ids);
  }

  let previewEntries: Array<Array<readonly [string, string]>>;
  try {
    previewEntries = await Promise.all(
      [...groupedIds.entries()].map(async ([accountId, ids]) => {
        const account = accountById.get(accountId);
        if (!account) return [];
        const previews = await getMessagePreviews(account, ids);
        return previews.map((preview) => [`${accountId}:${preview.id}`, preview.preview] as const);
      }),
    );
  } catch (error) {
    return apiFailure("Gmail sender previews failed", error, "Could not load Gmail previews. Please try again.");
  }
  const previews = new Map(previewEntries.flat());
  const recentMessages = messages.results.map(({ userId, ...message }) => ({
    ...message,
    preview: previews.get(`${userId}:${message.id}`) ?? "No preview text is available for this email.",
  }));

  return NextResponse.json({ sender, messages: recentMessages, mode: "live" });
}
