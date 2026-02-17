import { createHash, randomBytes } from "crypto";

export interface BetaInviteStatus {
  value: "none" | "pending" | "used" | "revoked" | "expired";
  label: string;
}

export function normalizeEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getInviteTtlHours(): number {
  const parsed = Number.parseInt(String(process.env.BETA_INVITE_TTL_HOURS || "168"), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 168;
  return parsed;
}

export function resolveInviteBaseUrl(request: Request): string {
  const envBase = String(process.env.BETA_INVITE_BASE_URL || process.env.NEXTAUTH_URL || "").trim();
  if (envBase) {
    return envBase.replace(/\/+$/, "");
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (forwardedHost) {
    const proto = (forwardedProto || "https").split(",")[0].trim();
    return `${proto}://${forwardedHost.trim()}`;
  }

  return new URL(request.url).origin;
}

export function getInviteStatus(invite: any, now: Date): BetaInviteStatus {
  if (!invite) return { value: "none", label: "No invite sent" };
  if (invite.usedAt) return { value: "used", label: "Invite accepted" };
  if (invite.revokedAt) return { value: "revoked", label: "Invite revoked" };

  const expiresAt = invite.expiresAt ? new Date(invite.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return { value: "expired", label: "Invite expired" };
  }

  return { value: "pending", label: "Invite pending" };
}
