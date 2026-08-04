import { NextRequest, NextResponse } from "next/server";
import { currentUser, getConnectedAccounts, type GmailAccount } from "@/app/lib/auth";
import { trashMessages, untrashMessages } from "@/app/lib/gmail";
import { apiFailure, requireActionRequest } from "@/app/lib/http";
import { getDatabase } from "@/db/runtime";

export async function POST(request: NextRequest) {
  try {
    requireActionRequest(request);
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Not connected" }, { status: 401 });
    const { jobId } = (await request.json()) as { jobId?: string };
    if (!jobId) return NextResponse.json({ error: "Cleanup job is required" }, { status: 400 });
    const database = await getDatabase();
    const job = await database
      .prepare(
        `SELECT message_ids_json, created_at FROM cleanup_jobs
         WHERE id = ? AND user_id = ? AND status = 'trashed' AND created_at > ?`,
      )
      .bind(jobId, user.id, Date.now() - 10 * 60 * 1000)
      .first<{ message_ids_json: string; created_at: number }>();
    if (!job) return NextResponse.json({ error: "This cleanup can no longer be undone here." }, { status: 400 });
    const parsed = JSON.parse(job.message_ids_json) as Array<string | { id?: unknown; userId?: unknown }>;
    const references = parsed.map((item) =>
      typeof item === "string" ? { id: item, userId: user.id } : { id: item.id, userId: item.userId },
    );
    if (
      !references.length ||
      references.some((reference) => typeof reference.id !== "string" || typeof reference.userId !== "string")
    ) {
      return NextResponse.json({ error: "This cleanup record is invalid." }, { status: 400 });
    }

    const accounts = await getConnectedAccounts(user);
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const groups = new Map<string, { account: GmailAccount; ids: string[] }>();
    for (const reference of references as Array<{ id: string; userId: string }>) {
      const account = accountById.get(reference.userId);
      if (!account) return NextResponse.json({ error: "A mailbox for this cleanup is no longer connected." }, { status: 409 });
      const group = groups.get(account.id) ?? { account, ids: [] };
      group.ids.push(reference.id);
      groups.set(account.id, group);
    }

    const completed: Array<{ account: GmailAccount; ids: string[] }> = [];
    try {
      for (const group of groups.values()) {
        try {
          await untrashMessages(group.account, group.ids);
          completed.push(group);
        } catch (error) {
          await trashMessages(group.account, group.ids).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      await Promise.all(completed.map((group) => trashMessages(group.account, group.ids).catch(() => undefined)));
      throw error;
    }

    const typedReferences = references as Array<{ id: string; userId: string }>;
    try {
      for (let offset = 0; offset < typedReferences.length; offset += 50) {
        await database.batch(
          typedReferences.slice(offset, offset + 50).map((reference) =>
            database
              .prepare("UPDATE messages SET trashed_at = NULL WHERE id = ? AND user_id = ?")
              .bind(reference.id, reference.userId),
          ),
        );
      }
      await database
        .prepare("UPDATE cleanup_jobs SET status = 'undone', undone_at = ? WHERE id = ? AND user_id = ?")
        .bind(Date.now(), jobId, user.id)
        .run();
    } catch (error) {
      await Promise.all(completed.map((group) => trashMessages(group.account, group.ids).catch(() => undefined)));
      await Promise.all(
        typedReferences.map((reference) =>
          database
            .prepare("UPDATE messages SET trashed_at = ? WHERE id = ? AND user_id = ?")
            .bind(job.created_at, reference.id, reference.userId)
            .run()
            .catch(() => undefined),
        ),
      );
      throw error;
    }
    return NextResponse.json({ ok: true, count: typedReferences.length });
  } catch (error) {
    return apiFailure("Undo failed", error, "Undo failed. Please check Gmail Trash before trying again.");
  }
}
