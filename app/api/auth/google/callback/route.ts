import { NextRequest, NextResponse } from "next/server";
import { createSession, currentUser, sessionCookieName } from "@/app/lib/auth";
import { encryptSecret } from "@/app/lib/crypto";
import {
  getGoogleOAuthConfig,
  revokeGoogleToken,
} from "@/app/lib/gmail";
import { MAX_LINKED_GMAIL_ACCOUNTS, normalizeBetaEmail } from "@/app/lib/beta-policy";
import { getDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

const OAUTH_COOKIES = ["clearbox_oauth_state", "clearbox_oauth_verifier", "clearbox_oauth_redirect"];

function clearOAuthCookies(response: NextResponse): void {
  for (const name of OAUTH_COOKIES) {
    response.cookies.set(name, "", { expires: new Date(0), httpOnly: true, sameSite: "lax", path: "/" });
  }
}

export async function GET(request: NextRequest) {
  const returnUrl = new URL("/", request.url);
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get("clearbox_oauth_state")?.value;
  const verifier = request.cookies.get("clearbox_oauth_verifier")?.value;
  const redirectUri = request.cookies.get("clearbox_oauth_redirect")?.value;

  if (!code || !state || state !== expectedState || !verifier || !redirectUri) {
    returnUrl.searchParams.set("error", "oauth-state");
    return NextResponse.redirect(returnUrl);
  }

  let issuedRefreshToken: string | undefined;
  try {
    const authenticatedOwner = await currentUser(request);
    const { clientId, clientSecret } = getGoogleOAuthConfig();
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const tokenPayload = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!tokenResponse.ok || !tokenPayload.access_token || !tokenPayload.refresh_token) {
      throw new Error("Google did not return the required credentials.");
    }
    issuedRefreshToken = tokenPayload.refresh_token;

    const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${tokenPayload.access_token}` },
    });
    const profile = (await profileResponse.json()) as { emailAddress?: string };
    if (!profileResponse.ok || !profile.emailAddress) throw new Error("Could not read the Gmail profile.");

    const profileAddress = normalizeBetaEmail(profile.emailAddress);
    if (!profileAddress) throw new Error("Google returned an invalid Gmail profile.");
    const database = await getDatabase();
    const now = Date.now();
    const [existing, membership] = await Promise.all([
      database
        .prepare("SELECT id, owner_user_id FROM users WHERE email = ?")
        .bind(profileAddress)
        .first<{ id: string; owner_user_id: string | null }>(),
      database
        .prepare("SELECT role, status FROM beta_members WHERE email = ?")
        .bind(profileAddress)
        .first<{ role: string; status: string }>(),
    ]);

    if (!authenticatedOwner) {
      if (!membership || (membership.status !== "invited" && membership.status !== "active")) {
        await revokeGoogleToken(issuedRefreshToken);
        issuedRefreshToken = undefined;
        returnUrl.searchParams.set("error", "invite-required");
        const response = NextResponse.redirect(returnUrl);
        clearOAuthCookies(response);
        return response;
      }
      if (existing && existing.owner_user_id !== existing.id) {
        await revokeGoogleToken(issuedRefreshToken);
        issuedRefreshToken = undefined;
        returnUrl.searchParams.set("error", "account-already-linked");
        const response = NextResponse.redirect(returnUrl);
        clearOAuthCookies(response);
        return response;
      }
    }

    if (authenticatedOwner && existing && existing.owner_user_id !== authenticatedOwner.id) {
      await revokeGoogleToken(issuedRefreshToken);
      issuedRefreshToken = undefined;
      returnUrl.searchParams.set("error", "account-already-linked");
      const response = NextResponse.redirect(returnUrl);
      clearOAuthCookies(response);
      return response;
    }

    if (
      authenticatedOwner &&
      profileAddress !== authenticatedOwner.email.trim().toLowerCase() &&
      membership
    ) {
      await revokeGoogleToken(issuedRefreshToken);
      issuedRefreshToken = undefined;
      returnUrl.searchParams.set("error", "account-reserved");
      const response = NextResponse.redirect(returnUrl);
      clearOAuthCookies(response);
      return response;
    }

    if (!authenticatedOwner) {
      const activation = await database
        .prepare(
          `UPDATE beta_members
           SET status = 'active', accepted_at = COALESCE(accepted_at, ?), updated_at = ?
           WHERE email = ? AND status IN ('invited', 'active')`,
        )
        .bind(now, now, profileAddress)
        .run();
      if (activation.meta.changes !== 1) {
        await revokeGoogleToken(issuedRefreshToken);
        issuedRefreshToken = undefined;
        returnUrl.searchParams.set("error", "invite-required");
        const response = NextResponse.redirect(returnUrl);
        clearOAuthCookies(response);
        return response;
      }
    }

    const userId = existing?.id ?? crypto.randomUUID();
    const ownerUserId = authenticatedOwner?.id ?? userId;
    const encryptedRefreshToken = await encryptSecret(issuedRefreshToken);
    if (authenticatedOwner && !existing) {
      // Keep the quota check and insert in one D1 statement. Concurrent OAuth
      // callbacks cannot all observe the same pre-insert account count.
      const insertion = await database
        .prepare(
          `INSERT INTO users (
            id, email, owner_user_id, refresh_token_encrypted, history_id, last_synced_at,
            sync_status, sync_page_token, active_sync_run_id, sync_indexed_count,
            created_at, updated_at
          )
          SELECT ?, ?, ?, ?, NULL, NULL, 'idle', NULL, NULL, 0, ?, ?
          WHERE (SELECT COUNT(*) FROM users WHERE owner_user_id = ?) < ?
          ON CONFLICT DO NOTHING`,
        )
        .bind(
          userId,
          profileAddress,
          ownerUserId,
          encryptedRefreshToken,
          now,
          now,
          authenticatedOwner.id,
          MAX_LINKED_GMAIL_ACCOUNTS,
        )
        .run();
      if (insertion.meta.changes !== 1) {
        const collision = await database
          .prepare("SELECT owner_user_id FROM users WHERE email = ?")
          .bind(profileAddress)
          .first<{ owner_user_id: string | null }>();
        await revokeGoogleToken(issuedRefreshToken);
        issuedRefreshToken = undefined;
        if (collision?.owner_user_id === authenticatedOwner.id) {
          returnUrl.searchParams.set("account-added", "1");
        } else {
          returnUrl.searchParams.set("error", collision ? "account-already-linked" : "account-limit");
        }
        const response = NextResponse.redirect(returnUrl);
        clearOAuthCookies(response);
        return response;
      }
    } else {
      await database
        .prepare(
          `INSERT INTO users (
            id, email, owner_user_id, refresh_token_encrypted, history_id, last_synced_at,
            sync_status, sync_page_token, active_sync_run_id, sync_indexed_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, 'idle', NULL, NULL, 0, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            owner_user_id = excluded.owner_user_id,
            refresh_token_encrypted = excluded.refresh_token_encrypted,
            updated_at = excluded.updated_at`,
        )
        .bind(userId, profileAddress, ownerUserId, encryptedRefreshToken, now, now)
        .run();
    }

    // Revocation or self-service disconnect can happen while Google OAuth is in
    // flight. Re-check both active membership and the primary owner row after
    // storing credentials; if either disappeared, remove the entire stale
    // workspace before returning.
    const checkedOwnerId = authenticatedOwner?.id ?? userId;
    let authorizationStillActive: boolean;
    if (authenticatedOwner) {
      // Re-read through the original session cookie. Both administrator
      // revocation and self-service disconnect delete this session, so a stale
      // callback cannot recreate credentials after either action completed.
      const currentOwner = await currentUser(request);
      authorizationStillActive = currentOwner?.id === authenticatedOwner.id;
    } else {
      const activeMembership = await database
        .prepare(
          `SELECT 1 AS allowed
           FROM beta_members b
           JOIN users u ON u.id = ? AND u.owner_user_id = u.id AND u.email = b.email
           WHERE b.email = ? AND b.status = 'active'`,
        )
        .bind(userId, profileAddress)
        .first<{ allowed: number }>();
      authorizationStillActive = Boolean(activeMembership);
    }
    if (!authorizationStillActive) {
      await database.batch([
        database.prepare("DELETE FROM cleanup_jobs WHERE user_id = ?").bind(checkedOwnerId),
        database
          .prepare("DELETE FROM sync_chunks WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = ?)")
          .bind(checkedOwnerId),
        database
          .prepare("DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = ?)")
          .bind(checkedOwnerId),
        database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(checkedOwnerId),
        database.prepare("DELETE FROM users WHERE owner_user_id = ?").bind(checkedOwnerId),
      ]);
      await revokeGoogleToken(issuedRefreshToken);
      issuedRefreshToken = undefined;
      returnUrl.searchParams.set("error", "invite-required");
      const response = NextResponse.redirect(returnUrl);
      clearOAuthCookies(response);
      return response;
    }

    if (authenticatedOwner) {
      returnUrl.searchParams.set(profileAddress === authenticatedOwner.email ? "connected" : "account-added", "1");
      const response = NextResponse.redirect(returnUrl);
      clearOAuthCookies(response);
      return response;
    }

    await database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    const session = await createSession(userId);
    returnUrl.searchParams.set("connected", "1");
    const response = NextResponse.redirect(returnUrl);
    response.cookies.set(sessionCookieName(request), session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      expires: new Date(session.expiresAt),
      path: "/",
    });
    clearOAuthCookies(response);
    return response;
  } catch (error) {
    if (issuedRefreshToken) {
      await revokeGoogleToken(issuedRefreshToken).catch(() => undefined);
    }
    console.error("OAuth callback failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    returnUrl.searchParams.set("error", "oauth-failed");
    const response = NextResponse.redirect(returnUrl);
    clearOAuthCookies(response);
    return response;
  }
}
