import { createHash, randomBytes } from "crypto";

export function generateApprovalToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getApprovalTtlHours(): number {
  const parsed = Number.parseInt(String(process.env.BETA_REQUEST_APPROVAL_TTL_HOURS || "72"), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 72;
  return parsed;
}
