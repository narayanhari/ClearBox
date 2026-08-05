import { getEnvironment } from "@/db/runtime";
import { normalizeBetaEmail } from "./beta-policy";

export function getBetaAdminEmail(): string {
  const environment = getEnvironment();
  const email = normalizeBetaEmail(
    environment.BETA_ADMIN_EMAIL ?? environment.ALLOWED_GMAIL_ADDRESS,
  );
  if (!email) {
    throw new Error("BETA_ADMIN_EMAIL is not configured correctly.");
  }
  return email;
}

export function isBetaAccessConfigured(): boolean {
  try {
    getBetaAdminEmail();
    return true;
  } catch {
    return false;
  }
}
