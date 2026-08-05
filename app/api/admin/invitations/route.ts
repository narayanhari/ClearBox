import { NextRequest, NextResponse } from "next/server";
import { currentUser, type CurrentUser } from "@/app/lib/auth";
import { MAX_BETA_MEMBERS, normalizeBetaEmail } from "@/app/lib/beta-policy";
import {
  apiFailure,
  PublicHttpError,
  requireActionRequest,
  requireReadRequest,
} from "@/app/lib/http";
import { getDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

interface InvitationRow {
  email: string;
  role: "admin" | "member";
  status: "invited" | "active" | "revoked";
  invitedAt: number;
  acceptedAt: number | null;
}

async function requireAdmin(request: NextRequest): Promise<CurrentUser> {
  const user = await currentUser(request);
  if (!user) throw new PublicHttpError(401, "Connect an invited Gmail account first.");
  if (user.role !== "admin") throw new PublicHttpError(403, "Admin access is required.");
  return user;
}

async function requestedEmail(request: NextRequest): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 2_048) {
    throw new PublicHttpError(413, "Invitation request is too large.");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new PublicHttpError(400, "Enter a valid Gmail address.");
  }
  const email = normalizeBetaEmail(
    payload && typeof payload === "object" ? (payload as { email?: unknown }).email : undefined,
  );
  if (!email) throw new PublicHttpError(400, "Enter a valid Gmail address.");
  return email;
}

export async function GET(request: NextRequest) {
  try {
    requireReadRequest(request);
    await requireAdmin(request);
    const database = await getDatabase();
    const result = await database
      .prepare(
        `SELECT email, role, status, invited_at AS invitedAt, accepted_at AS acceptedAt
         FROM beta_members
         ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, invited_at DESC`,
      )
      .all<InvitationRow>();
    return NextResponse.json({ members: result.results, maxMembers: MAX_BETA_MEMBERS });
  } catch (error) {
    return apiFailure("List beta invitations failed", error, "Could not load beta invitations.");
  }
}

export async function POST(request: NextRequest) {
  try {
    requireActionRequest(request);
    const admin = await requireAdmin(request);
    const email = await requestedEmail(request);
    const database = await getDatabase();
    const [membership, linkedAccount, memberCount] = await Promise.all([
      database
        .prepare("SELECT role, status FROM beta_members WHERE email = ?")
        .bind(email)
        .first<{ role: string; status: string }>(),
      database
        .prepare("SELECT id, owner_user_id FROM users WHERE email = ?")
        .bind(email)
        .first<{ id: string; owner_user_id: string | null }>(),
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM beta_members
           WHERE role = 'member' AND status IN ('invited', 'active')`,
        )
        .first<{ count: number }>(),
    ]);

    if (membership?.role === "admin") {
      throw new PublicHttpError(409, "The beta administrator already has access.");
    }
    if (membership?.status === "invited" || membership?.status === "active") {
      throw new PublicHttpError(409, "That Gmail address already has beta access.");
    }
    if (linkedAccount && linkedAccount.owner_user_id !== linkedAccount.id) {
      throw new PublicHttpError(
        409,
        "That Gmail address is already linked inside another beta workspace.",
      );
    }
    if ((memberCount?.count ?? 0) >= MAX_BETA_MEMBERS) {
      throw new PublicHttpError(409, `This beta is limited to ${MAX_BETA_MEMBERS} members.`);
    }

    const now = Date.now();
    await database
      .prepare(
        `INSERT INTO beta_members (
          email, role, status, invited_by, invited_at, accepted_at, updated_at
        ) VALUES (?, 'member', 'invited', ?, ?, NULL, ?)
        ON CONFLICT(email) DO UPDATE SET
          role = 'member', status = 'invited', invited_by = excluded.invited_by,
          invited_at = excluded.invited_at, accepted_at = NULL, updated_at = excluded.updated_at`,
      )
      .bind(email, admin.id, now, now)
      .run();
    return NextResponse.json({ email, status: "invited" }, { status: 201 });
  } catch (error) {
    return apiFailure("Create beta invitation failed", error, "Could not create the invitation.");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    requireActionRequest(request);
    await requireAdmin(request);
    const email = await requestedEmail(request);
    const database = await getDatabase();
    const membership = await database
      .prepare("SELECT role, status FROM beta_members WHERE email = ?")
      .bind(email)
      .first<{ role: string; status: string }>();
    if (!membership) throw new PublicHttpError(404, "That beta invitation was not found.");
    if (membership.role === "admin") {
      throw new PublicHttpError(403, "The beta administrator cannot be revoked here.");
    }
    const now = Date.now();
    const owner = await database
      .prepare("SELECT id FROM users WHERE email = ? AND owner_user_id = id")
      .bind(email)
      .first<{ id: string }>();
    const statements = [
      database
        .prepare("UPDATE beta_members SET status = 'revoked', updated_at = ? WHERE email = ?")
        .bind(now, email),
    ];
    if (owner) {
      statements.push(
        database.prepare("DELETE FROM cleanup_jobs WHERE user_id = ?").bind(owner.id),
        database
          .prepare("DELETE FROM sync_chunks WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = ?)")
          .bind(owner.id),
        database
          .prepare("DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = ?)")
          .bind(owner.id),
        database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
        database.prepare("DELETE FROM users WHERE owner_user_id = ?").bind(owner.id),
      );
    }
    await database.batch(statements);
    return NextResponse.json({ email, status: "revoked" });
  } catch (error) {
    return apiFailure("Revoke beta invitation failed", error, "Could not revoke beta access.");
  }
}
