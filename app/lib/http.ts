import { NextResponse } from "next/server";

export const ACTION_HEADER = "x-clearbox-action";

export class PublicHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PublicHttpError";
    this.status = status;
  }
}

export function requireActionRequest(request: Request): void {
  if (request.headers.get(ACTION_HEADER) !== "1") {
    throw new PublicHttpError(403, "Request rejected.");
  }

  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new PublicHttpError(403, "Request rejected.");
  }

  let receivedOrigin: string;
  try {
    receivedOrigin = new URL(origin).origin;
  } catch {
    throw new PublicHttpError(403, "Request rejected.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (receivedOrigin !== expectedOrigin || (fetchSite && fetchSite !== "same-origin")) {
    throw new PublicHttpError(403, "Request rejected.");
  }
}

export function requireReadRequest(request: Request): void {
  if (request.headers.get(ACTION_HEADER) !== "1") {
    throw new PublicHttpError(403, "Request rejected.");
  }

  const expectedOrigin = new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new PublicHttpError(403, "Request rejected.");
  }

  const suppliedOrigins = [request.headers.get("origin"), request.headers.get("referer")].filter(
    (value): value is string => Boolean(value),
  );
  let hasMatchingOrigin = false;
  for (const value of suppliedOrigins) {
    try {
      if (new URL(value).origin !== expectedOrigin) {
        throw new PublicHttpError(403, "Request rejected.");
      }
      hasMatchingOrigin = true;
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      throw new PublicHttpError(403, "Request rejected.");
    }
  }

  if (fetchSite !== "same-origin" && !hasMatchingOrigin) {
    throw new PublicHttpError(403, "Request rejected.");
  }
}

export function apiFailure(context: string, error: unknown, fallback: string): NextResponse {
  if (error instanceof PublicHttpError) {
    const details = { status: error.status, errorType: error.name };
    if (error.status >= 500) console.error(context, details);
    else if (error.status === 409 || error.status === 429) console.warn(context, details);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(context, {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json({ error: fallback }, { status: 500 });
}
