import type { Db } from "mongodb";
import * as nodemailer from "nodemailer";
import {
  buildBetaInviteUrl,
  generateInviteToken,
  getInviteTtlHours,
  hashInviteToken,
} from "./beta-invites";

export interface IssueBetaInviteParams {
  db: Db;
  email: string;
  actorLabel: string;
  baseUrl: string;
  emailServer: string;
  emailFrom: string;
  now?: Date;
}

export interface IssueBetaInviteResult {
  email: string;
  expiresAt: string;
  inviteUrl: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function issueBetaInvite({
  db,
  email,
  actorLabel,
  baseUrl,
  emailServer,
  emailFrom,
  now = new Date(),
}: IssueBetaInviteParams): Promise<IssueBetaInviteResult> {
  const ttlHours = getInviteTtlHours();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const inviteUrl = buildBetaInviteUrl(baseUrl, rawToken);

  await db.collection("beta_invites").updateMany(
    {
      email,
      usedAt: { $exists: false },
      revokedAt: { $exists: false },
    },
    {
      $set: {
        revokedAt: now,
        revokedBy: actorLabel,
        updatedAt: now,
      },
    }
  );

  await db.collection("beta_invites").insertOne({
    email,
    tokenHash,
    createdAt: now,
    updatedAt: now,
    createdBy: actorLabel,
    expiresAt,
  });

  await db.collection("beta_interest_signups").updateOne(
    { email },
    {
      $set: {
        invitedAt: now,
        invitedBy: actorLabel,
        updatedAt: now,
      },
    }
  );

  const transport = nodemailer.createTransport(emailServer as any);
  const subject = "Your OurTextScores beta invite";
  const text = [
    "Your request for OurTextScores beta access has been approved.",
    "",
    "Use this one-time invite link to activate your account access:",
    inviteUrl,
    "",
    `This invite expires on ${expiresAt.toISOString()}.`,
    "",
    "After activation, sign in from:",
    `${baseUrl}/signin`,
    "",
    "Use the same email address you used for this request.",
  ].join("\n");
  const html = [
    "<p>Your request for OurTextScores beta access has been approved.</p>",
    `<p><a href="${escapeHtml(inviteUrl)}">Activate your beta invite</a></p>`,
    `<p>This invite expires on <strong>${escapeHtml(expiresAt.toISOString())}</strong>.</p>`,
    `<p>After activation, sign in from <a href="${escapeHtml(`${baseUrl}/signin`)}">${escapeHtml(`${baseUrl}/signin`)}</a>.</p>`,
    "<p>Use the same email address you used for this request.</p>",
  ].join("");

  await transport.sendMail({
    from: emailFrom,
    to: email,
    subject,
    text,
    html,
  });

  return {
    email,
    expiresAt: expiresAt.toISOString(),
    inviteUrl,
  };
}
