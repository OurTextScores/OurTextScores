import { NextResponse } from "next/server";
import * as nodemailer from "nodemailer";
import clientPromise from "../../../lib/mongo";
import { AdminAuthError, requireAdminEmail } from "../../../lib/admin-auth";
import {
  generateInviteToken,
  getInviteTtlHours,
  hashInviteToken,
  isValidEmail,
  normalizeEmail,
  resolveInviteBaseUrl
} from "../../../lib/beta-invites";

function clean(input: unknown): string {
  return String(input ?? "").trim();
}

export async function POST(request: Request) {
  try {
    const adminEmail = await requireAdminEmail();

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const email = normalizeEmail(clean(body?.email));
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }

    const emailServer = process.env.EMAIL_SERVER;
    if (!emailServer) {
      return NextResponse.json({ error: "EMAIL_SERVER is not configured" }, { status: 503 });
    }
    const emailFrom = process.env.EMAIL_FROM || "OurTextScores <noreply@ourtextscores.com>";

    const now = new Date();
    const ttlHours = getInviteTtlHours();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

    const rawToken = generateInviteToken();
    const tokenHash = hashInviteToken(rawToken);
    const baseUrl = resolveInviteBaseUrl(request);
    const inviteUrl = `${baseUrl}/beta-invite?token=${encodeURIComponent(rawToken)}`;

    const client = await clientPromise;
    const db = client.db();

    await db.collection("beta_invites").updateMany(
      {
        email,
        usedAt: { $exists: false },
        revokedAt: { $exists: false }
      },
      {
        $set: {
          revokedAt: now,
          revokedBy: adminEmail,
          updatedAt: now
        }
      }
    );

    await db.collection("beta_invites").insertOne({
      email,
      tokenHash,
      createdAt: now,
      updatedAt: now,
      createdBy: adminEmail,
      expiresAt
    });

    await db.collection("beta_interest_signups").updateOne(
      { email },
      {
        $set: {
          invitedAt: now,
          invitedBy: adminEmail,
          updatedAt: now
        }
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
      "Use the same email address you used for this request."
    ].join("\n");

    await transport.sendMail({
      from: emailFrom,
      to: email,
      subject,
      text
    });

    return NextResponse.json({
      ok: true,
      email,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error: any) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      { error: `Failed to send invite: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const adminEmail = await requireAdminEmail();

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const email = normalizeEmail(clean(body?.email));
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }

    const now = new Date();
    const client = await clientPromise;
    const db = client.db();

    const result = await db.collection("beta_invites").updateMany(
      {
        email,
        usedAt: { $exists: false },
        revokedAt: { $exists: false }
      },
      {
        $set: {
          revokedAt: now,
          revokedBy: adminEmail,
          updatedAt: now
        }
      }
    );

    await db.collection("beta_interest_signups").updateOne(
      { email },
      {
        $set: {
          updatedAt: now
        },
        $unset: {
          invitedAt: "",
          invitedBy: ""
        }
      }
    );

    return NextResponse.json({
      ok: true,
      email,
      revokedCount: result.modifiedCount
    });
  } catch (error: any) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      { error: `Failed to revoke invite: ${String(error?.message || error)}` },
      { status: 500 }
    );
  }
}
