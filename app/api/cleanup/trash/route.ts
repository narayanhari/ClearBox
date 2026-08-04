import { NextRequest, NextResponse } from "next/server";
import { currentUser, getConnectedAccounts, type GmailAccount } from "@/app/lib/auth";
import { trashMessages, untrashMessages } from "@/app/lib/gmail";
import { apiFailure, requireActionRequest } from "@/app/lib/http";
import { getDatabase } from "@/db/runtime";

interface TrashRequest {
  senderEmail?: string;
  messageId?: string;
  accountEmail?: string;
}

interface MessageReference {
  id: string;
  userId: string;
}

const CLEANUP_REQUEST_BATCH_SIZE = 20;

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    requireActionRequest(request);
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Connect Gmail before cleaning up." }, { status: 401 });
    const body = (await request.json()) as TrashRequest;
    const database = await getDatabase();
    const accounts = await getConnectedAccounts(user);
    const requestedAccount = body.accountEmail?.trim().toLowerCase();
    if (requestedAccount && !accounts.some((account) => account.email.toLowerCase() === requestedAccount)) {
      return NextResponse.json({ error: "That Gmail account is not connected." }, { status: 404 });
    }
    let query: D1PreparedStatement;
    if (body.messageId) {
      if (!requestedAccount) {
        return NextResponse.json({ error: "Choose the Gmail account for this message." }, { status: 400 });
      }
      query = database
        .prepare(
          `SELECT m.id, m.user_id, m.sender_email
           FROM messages m
           JOIN users a ON a.id = m.user_id
           WHERE a.owner_user_id = ? AND a.email = ? AND m.id = ? AND m.trashed_at IS NULL
           AND m.is_starred = 0 AND m.is_important = 0
           LIMIT 1`,
        )
        .bind(user.id, requestedAccount, body.messageId);
    } else if (body.senderEmail) {
      const accountClause = requestedAccount ? " AND a.email = ?" : "";
      query = database
        .prepare(
          `SELECT m.id, m.user_id, m.sender_email
           FROM messages m
           JOIN users a ON a.id = m.user_id
           WHERE a.owner_user_id = ? AND m.sender_email = ? AND m.trashed_at IS NULL
           AND m.is_starred = 0 AND m.is_important = 0${accountClause}
           ORDER BY m.received_at DESC
           LIMIT ${CLEANUP_REQUEST_BATCH_SIZE + 1}`,
        )
        .bind(
          ...[user.id, body.senderEmail.trim().toLowerCase(), ...(requestedAccount ? [requestedAccount] : [])],
        );
    } else {
      return NextResponse.json({ error: "Choose a sender or message." }, { status: 400 });
    }

    const candidates = await query.all<{ id: string; user_id: string; sender_email: string }>();
    if (!candidates.results.length) {
      return NextResponse.json({ error: "No unprotected messages were found." }, { status: 400 });
    }
    const limited = !body.messageId && candidates.results.length > CLEANUP_REQUEST_BATCH_SIZE;
    const rows = candidates.results.slice(0, CLEANUP_REQUEST_BATCH_SIZE);

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const groups = new Map<string, { account: GmailAccount; ids: string[] }>();
    for (const row of rows) {
      const account = accountById.get(row.user_id);
      if (!account) return NextResponse.json({ error: "Mailbox ownership changed. Refresh and retry." }, { status: 409 });
      const group = groups.get(account.id) ?? { account, ids: [] };
      group.ids.push(row.id);
      groups.set(account.id, group);
    }

    const completed: Array<{ account: GmailAccount; ids: string[] }> = [];
    try {
      for (const group of groups.values()) {
        try {
          await trashMessages(group.account, group.ids);
          completed.push(group);
        } catch (error) {
          await untrashMessages(group.account, group.ids).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      await Promise.all(completed.map((group) => untrashMessages(group.account, group.ids).catch(() => undefined)));
      throw error;
    }

    const now = Date.now();
    const jobId = crypto.randomUUID();
    const references: MessageReference[] = rows.map((row) => ({ id: row.id, userId: row.user_id }));
    try {
      for (let offset = 0; offset < references.length; offset += 50) {
        await database.batch(
          references.slice(offset, offset + 50).map((reference) =>
            database
              .prepare("UPDATE messages SET trashed_at = ? WHERE id = ? AND user_id = ?")
              .bind(now, reference.id, reference.userId),
          ),
        );
      }
      await database
        .prepare(
          `INSERT INTO cleanup_jobs (id, user_id, sender_email, message_ids_json, status, created_at, undone_at)
           VALUES (?, ?, ?, ?, 'trashed', ?, NULL)`,
        )
        .bind(jobId, user.id, rows[0].sender_email, JSON.stringify(references), now)
        .run();
    } catch (error) {
      await Promise.all(
        references.map((reference) =>
          database
            .prepare("UPDATE messages SET trashed_at = NULL WHERE id = ? AND user_id = ?")
            .bind(reference.id, reference.userId)
            .run()
            .catch(() => undefined),
        ),
      );
      await database
        .prepare("DELETE FROM cleanup_jobs WHERE id = ? AND user_id = ?")
        .bind(jobId, user.id)
        .run()
        .catch(() => undefined);
      await Promise.all(completed.map((group) => untrashMessages(group.account, group.ids).catch(() => undefined)));
      throw error;
    }
    return NextResponse.json({
      ok: true,
      jobId,
      count: references.length,
      limited,
    });
  } catch (error) {
    return apiFailure("Trash operation failed", error, "Cleanup failed. No messages were changed.");
  }
}
