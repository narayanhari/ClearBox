import { NextRequest, NextResponse } from "next/server";
import { currentUser, getConnectedAccount } from "@/app/lib/auth";
import { syncMailboxPage } from "@/app/lib/gmail";
import { apiFailure, requireActionRequest } from "@/app/lib/http";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    requireActionRequest(request);
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Connect Gmail before synchronizing." }, { status: 401 });
    const payload = (await request.json().catch(() => ({}))) as { accountEmail?: unknown };
    if (typeof payload.accountEmail !== "string") {
      return NextResponse.json({ error: "Choose a Gmail account to synchronize." }, { status: 400 });
    }
    const account = await getConnectedAccount(user, payload.accountEmail);
    if (!account) return NextResponse.json({ error: "That Gmail account is not connected." }, { status: 404 });
    const result = await syncMailboxPage(account);
    return NextResponse.json({ ok: true, accountEmail: account.email, ...result });
  } catch (error) {
    return apiFailure("Gmail sync failed", error, "Synchronization failed. No Gmail messages were changed.");
  }
}
