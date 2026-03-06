import type { Db } from "mongodb";
import * as nodemailer from "nodemailer";
import {
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
  const inviteUrl = `${baseUrl}/beta-invite?token=${encodeURIComponent(rawToken)}`;

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

  await transport.sendMail({
    from: emailFrom,
    to: email,
    subject,
    text,
  });

  return {
    email,
    expiresAt: expiresAt.toISOString(),
    inviteUrl,
  };
}
