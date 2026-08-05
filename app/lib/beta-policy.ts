export const MAX_BETA_MEMBERS = 25;
export const MAX_LINKED_GMAIL_ACCOUNTS = 5;

export type BetaRole = "admin" | "member";
export type BetaStatus = "invited" | "active" | "revoked";

export function normalizeBetaEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\u0000-\u001f\u007f]/.test(email)
  ) {
    return null;
  }
  return email;
}

export function isBetaRole(value: unknown): value is BetaRole {
  return value === "admin" || value === "member";
}
