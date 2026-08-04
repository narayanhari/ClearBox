import { NextRequest, NextResponse } from "next/server";
import { createSession, currentUser, sessionCookieName } from "@/app/lib/auth";
import { encryptSecret } from "@/app/lib/crypto";
import {
  getAllowedGmailAddress,
  getGoogleOAuthConfig,
  revokeGoogleToken,
} from "@/app/lib/gmail";
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

    const profileAddress = profile.emailAddress.trim().toLowerCase();
    if (!authenticatedOwner && profileAddress !== getAllowedGmailAddress()) {
      await revokeGoogleToken(issuedRefreshToken);
      issuedRefreshToken = undefined;
      returnUrl.searchParams.set("error", "account-not-allowed");
      const response = NextResponse.redirect(returnUrl);
      clearOAuthCookies(response);
      return response;
    }

    const database = await getDatabase();
    const now = Date.now();
    const existing = await database
      .prepare("SELECT id, owner_user_id FROM users WHERE email = ?")
      .bind(profileAddress)
      .first<{ id: string; owner_user_id: string | null }>();
    if (authenticatedOwner && existing && existing.owner_user_id !== authenticatedOwner.id) {
      await revokeGoogleToken(issuedRefreshToken);
      issuedRefreshToken = undefined;
      returnUrl.searchParams.set("error", "account-already-linked");
      const response = NextResponse.redirect(returnUrl);
      clearOAuthCookies(response);
      return response;
    }

    const userId = existing?.id ?? crypto.randomUUID();
    const ownerUserId = authenticatedOwner?.id ?? userId;
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
      .bind(userId, profileAddress, ownerUserId, await encryptSecret(issuedRefreshToken), now, now)
      .run();

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
