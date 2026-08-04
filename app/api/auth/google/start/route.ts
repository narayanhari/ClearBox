import { NextRequest, NextResponse } from "next/server";
import { getGoogleOAuthConfig, isGoogleConfigured } from "@/app/lib/gmail";
import { randomToken, sha256 } from "@/app/lib/encoding";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isGoogleConfigured()) {
    return NextResponse.redirect(new URL("/?error=missing-config", request.url));
  }

  const { clientId } = getGoogleOAuthConfig();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    scope: "https://www.googleapis.com/auth/gmail.modify",
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
  }).toString();

  const response = NextResponse.redirect(authorizationUrl);
  const secure = new URL(request.url).protocol === "https:";
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure, maxAge: 600, path: "/" };
  response.cookies.set("clearbox_oauth_state", state, cookieOptions);
  response.cookies.set("clearbox_oauth_verifier", verifier, cookieOptions);
  response.cookies.set("clearbox_oauth_redirect", redirectUri, cookieOptions);
  return response;
}
