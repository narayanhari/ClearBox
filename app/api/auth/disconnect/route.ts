import { NextRequest, NextResponse } from "next/server";
import {
  currentUser,
  getConnectedAccounts,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
} from "@/app/lib/auth";
import { revokeGoogleAccess } from "@/app/lib/gmail";
import { apiFailure, requireActionRequest } from "@/app/lib/http";
import { getDatabase } from "@/db/runtime";

export async function POST(request: NextRequest) {
  try {
    requireActionRequest(request);
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Not connected" }, { status: 401 });
    const accounts = await getConnectedAccounts(user);
    for (const account of accounts) await revokeGoogleAccess(account.refreshTokenEncrypted);
    const database = await getDatabase();
    await database.batch([
      database.prepare("DELETE FROM cleanup_jobs WHERE user_id = ?").bind(user.id),
      database
        .prepare("DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = ?)")
        .bind(user.id),
      database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      database.prepare("DELETE FROM users WHERE owner_user_id = ?").bind(user.id),
    ]);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", { expires: new Date(0), httpOnly: true, sameSite: "lax", path: "/" });
    response.cookies.set(SECURE_SESSION_COOKIE, "", {
      expires: new Date(0),
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
    });
    return response;
  } catch (error) {
    return apiFailure("Disconnect failed", error, "Disconnect failed. Google access was not removed; please retry.");
  }
}
